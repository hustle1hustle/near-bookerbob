#!/usr/bin/env node
// `make audit NULLIFIER=<hex>`: rebuild one purchase from public data only, and check that four
// independent computations of its price agree. No keys, no fixtures beyond the public manifest.
//
//   1. the verdict on chain: signed by a registered issuer, spent, its receipt (merchant, price)
//   2. price parity: the receipt price equals
//        the contract's own `quote` view (on chain, now),
//        core (`bookerbob quote`, the contract's library),
//        zkcore (the code the Jolt price guest proves; the committed price proof covers it),
//        the merchant SDK (sdk/merchant.mjs, JavaScript),
//      for the merchant's schedule on chain and the verdict's revealed predicates. A sealed
//      verdict reveals none: its price must be one the schedule produces for some subset.
//   3. the settle tx: its `settled` event names this nullifier, merchant and amount, and the
//      dUSDC transfer to the merchant is the amount minus the fee; a replay was refused.
//
//   node scripts/audit.mjs <nullifier> [bazaar]
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { rpcClient } from "../relayer/near.mjs";
import { quote as sdkQuote } from "../sdk/merchant.mjs";

const [nullifier, bazaar = "bookerbob.testnet"] = process.argv.slice(2);
if (!/^[0-9a-f]{64}$/.test(nullifier ?? "")) {
  console.error("usage: make audit NULLIFIER=<64 hex>   (any nullifier in fixtures/live/testnet-manifest.json, or any spent one)");
  process.exit(2);
}
const client = rpcClient(process.env.NEAR_RPC || "https://test.rpc.fastnear.com");
const m = JSON.parse(readFileSync("fixtures/live/testnet-manifest.json", "utf8"));
let failed = 0;
const line = (ok, what, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}${detail ? `  (${detail})` : ""}`);
};
const usd = (u) => (Number(u) / 1e6).toFixed(2);

const v = await client.view(bazaar, "verdict", { nullifier });
if (!v) {
  console.log(`FAIL  no verdict under ${nullifier.slice(0, 12)}.. on ${bazaar}`);
  process.exit(1);
}
const issuers = (await client.view(bazaar, "issuers")).map(([k]) => k);
const status = await client.view(bazaar, "nullifier_status", { nullifier });
const registered = issuers.includes(v.issuer) || (v.issuer.startsWith("near-ai:") && Boolean(await client.view(bazaar, "model_attestation", { signing_key: v.issuer.slice(8) })));
line(registered && status === "Spent" && v.spent, `verdict on ${bazaar}: issued by a registered ${v.issuer.startsWith("near-ai:") ? "NEAR AI model key" : "key"}, spent`, `agent ${v.agent.split(".")[0]}, tier ${v.tier}, ${v.predicates.length ? v.predicates.join(", ") : "sealed: no predicate on chain"}`);
// 1b. A model-issued verdict: the model key, its TDX quote verified on chain, the TEE signature
// re-checked from the submit tx's own args, and the model's eval score.
if (v.issuer.startsWith("near-ai:")) {
  const key = v.issuer.slice(8);
  const att = await client.view(bazaar, "model_attestation", { signing_key: key });
  const verifier = await client.view(bazaar, "quote_verifier", {});
  // The key's own verification: a model registered with scripts/register-model.mjs, or the first one (tools/dcap-spike).
  const { readdirSync, existsSync } = await import("node:fs");
  const regDir = "fixtures/live/near-ai/models";
  const reg = existsSync(regDir) ? readdirSync(regDir).map((d) => `${regDir}/${d}/run.json`).filter(existsSync).map((f) => JSON.parse(readFileSync(f, "utf8"))).find((r) => r.signing_key === key) : null;
  const spike = reg ? { real: { id: reg.verification_id } } : JSON.parse(readFileSync("tools/dcap-spike/run.json", "utf8"));
  const ver = verifier ? await client.view(verifier, "verification", { id: spike.real.id }) : null;
  const rd = ver?.[1]?.split(" ")[1] ?? "";
  line(Boolean(att) && ver?.[0] === "verified" && rd.startsWith(key) && att.tcb_status === ver[1].split(" ")[0], "the model key: registered on the bazaar against its TDX quote, verified on chain", `${att?.model}, ${verifier}, verification ${spike.real.id.slice(0, 12)}.. ${ver?.[0]} ${att?.tcb_status}, report_data starts with the key`);
  const mb = ["run", "passing"].map((f) => `fixtures/live/model-buy/${f}.json`).filter(existsSync).map((f) => JSON.parse(readFileSync(f, "utf8"))).find((x) => x.nullifier === nullifier);
  if (mb) {
    const t = await client.rpc("tx", { tx_hash: mb.txs.verdict, sender_account_id: m.treasury, wait_until: "FINAL" });
    const d = t.result.transaction.actions.find((x) => x.Delegate)?.Delegate?.delegate_action;
    const call = (d?.actions ?? []).map((x) => x.NonDelegateAction ?? x).find((x) => x.FunctionCall?.method_name === "submit_near_ai_verdict");
    const args = JSON.parse(Buffer.from(call.FunctionCall.args, "base64").toString("utf8"));
    const { createHash, createPublicKey, verify } = await import("node:crypto");
    const text = `${att.model}:${args.proof.request_sha256}:${createHash("sha256").update(args.proof.response).digest("hex")}`;
    const pub = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(key, "hex")]), format: "der", type: "spki" });
    const sigOk = verify(null, Buffer.from(text), pub, Buffer.from(args.proof.signature, "hex"));
    line(sigOk && args.envelope.nullifier === nullifier, "the TEE signature in the submit tx covers the model's exact response, under the registered key", `chat ${args.proof.chat_id.slice(0, 12)}.., ${args.envelope.predicates.length} predicates revealed`);
  }
  const v4 = JSON.parse(readFileSync("fixtures/live/eval/rep-eval-v4.json", "utf8"));
  const score = await client.view(bazaar, "eval_score", { subject: `${att?.model}@4000tok/referee-v4`, set_root: v4.set_root });
  console.log(`INFO  the model's REP Eval v4 bucket on chain: ${score} (a merchant's eval gate compares this)`);
}
const r = v.receipt;
line(Boolean(r?.merchant && r?.price), "a referee receipt names the merchant and the price", r ? `${r.merchant.split(".")[0]} at ${usd(r.price)}` : "none");
if (!r) process.exit(1);

// 2. price parity
const mer = await client.view(bazaar, "merchant", { merchant: r.merchant });
const s = mer.schedule;
const listed = m.testers.find((t) => t.nullifier === nullifier);
const cohortK = s.cohort ? (listed?.cohort_k ?? (await client.view(bazaar, "cohort_size", { context: v.context, predicate: s.cohort.predicate }))) : 0;
const cli = (preds, k) => JSON.parse(execFileSync("cargo", ["run", "-q", "-p", "bookerbob-cli", "--", "quote", JSON.stringify(s), preds.join(","), String(k)], { encoding: "utf8" }));
if (v.tier !== "sealed") {
  const onChain = await client.view(bazaar, "quote", { merchant: r.merchant, nullifier });
  const c = cli(v.predicates, cohortK);
  const sdk = sdkQuote(s, v.predicates, () => cohortK).price;
  // The quote view prices with the cohort as it is now; a receipt keeps the price of the k it was
  // bought at (receipt_price_holds_when_the_cohort_grows_later). Compare it only when k is unchanged.
  const kNow = onChain.cohort?.k ?? 0;
  const sameK = !s.cohort || (kNow >= 5) === (cohortK >= 5);
  const prices = { receipt: r.price, ...(sameK ? { contract_quote_view: onChain.price } : {}), core: c.core, zkcore_jolt_guest_code: c.zkcore, sdk: String(sdk) };
  if (!sameK) console.log(`INFO  the contract's quote view now prices at cohort k ${kNow} (${usd(onChain.price)}); this purchase was priced at k ${cohortK}, and its receipt keeps that price`);
  line(new Set(Object.values(prices).map(String)).size === 1, `price parity: the receipt, ${sameK ? "the contract's quote view, " : ""}core, zkcore (the Jolt price guest's code) and the SDK agree`, Object.entries(prices).map(([k, x]) => `${k} ${usd(x)}`).join(", ") + `; cohort k ${cohortK}`);
} else {
  // Sealed: any subset of the schedule's predicates, with no cohort (the referee prices k = 0).
  const ps = s.rules.map((x) => x.predicate);
  const subsets = [...Array(1 << ps.length).keys()].map((mask) => ps.filter((_, i) => mask & (1 << i)));
  const sdkPrices = new Set(subsets.map((sub) => String(sdkQuote(s, sub, () => 0).price)));
  const corePrices = new Set(subsets.map((sub) => cli(sub, 0).core));
  line(sdkPrices.has(r.price) && corePrices.has(r.price), "sealed: the receipt price is one the schedule's code produces for some predicate subset (core and the SDK)", `${usd(r.price)} among ${[...corePrices].map(usd).join(", ")}`);
}

// 3. the settle tx and the replay, from the public manifest's tx hashes
const txs = listed?.txs ?? m.groups?.flatMap((g) => g.members).find((x) => x.nullifier === nullifier)?.txs;
const settleTx = txs?.settle ?? txs?.settle_group;
if (settleTx) {
  const t = await client.rpc("tx", { tx_hash: settleTx, sender_account_id: m.treasury, wait_until: "FINAL" });
  const outs = [t.result.transaction_outcome, ...t.result.receipts_outcome];
  const events = outs.flatMap((o) => o.outcome.logs).filter((l) => l.startsWith("EVENT_JSON:")).map((l) => JSON.parse(l.slice(11)));
  const settled = events.find((e) => e.event === "settled" || e.event === "group_settled")?.data?.[0];
  const transfer = events.find((e) => e.standard === "nep141" && e.event === "ft_transfer" && e.data?.[0]?.new_owner_id === (mer.payout ?? r.merchant))?.data?.[0];
  const fee = BigInt(settled?.fee ?? 0);
  const ok = !outs.some((o) => o.outcome.status.Failure) && settled && (settled.nullifier ?? nullifier) === nullifier && BigInt(transfer?.amount ?? -1) + fee === BigInt(settled.amount ?? settled.price ?? 0);
  line(Boolean(ok), "the settle tx: its event names this purchase and the merchant got the amount minus the fee", `${settleTx.slice(0, 8)}.., paid ${usd(settled?.amount ?? 0)}, merchant ${usd(transfer?.amount ?? 0)}, fee ${usd(fee)}`);
} else console.log("SKIP  the settle tx: this nullifier is not in the public manifest (its views above are still checked)");
if (txs?.replay) {
  const t = await client.rpc("tx", { tx_hash: txs.replay, sender_account_id: m.treasury, wait_until: "FINAL" });
  const fail = [t.result.transaction_outcome, ...t.result.receipts_outcome].map((o) => o.outcome.status.Failure).find(Boolean);
  line(JSON.stringify(fail ?? "").includes("nullifier spent"), "the same verdict sent again was refused: nullifier spent", txs.replay.slice(0, 8) + "..");
}
console.log(`\n${failed ? "FAIL" : "PASS"}  audit ${nullifier.slice(0, 12)}..: rebuilt from public data${failed ? `, ${failed} failed` : ""}`);
process.exit(failed ? 1 : 0);
