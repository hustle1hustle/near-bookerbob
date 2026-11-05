#!/usr/bin/env node
// The resumable on-chain TDX quote verifier on spike.bookerbob.testnet: start, then step until
// verified, gas per call recorded; then a tampered quote, which must fail at finalize.
//   node tools/dcap-spike/run.mjs        writes tools/dcap-spike/run.json
import { readFileSync, writeFileSync } from "node:fs";
import { keyFromSeed, rpcClient, send } from "../../relayer/near.mjs";

const SPIKE = "spike.bookerbob.testnet";
const c = rpcClient(process.env.NEAR_RPC || "https://test.rpc.fastnear.com");
const report = JSON.parse(readFileSync("fixtures/live/near-ai/report.json", "utf8"));
const col = JSON.parse(readFileSync("fixtures/live/near-ai/collateral.json", "utf8"));
const signer = "bookerbob-demo.testnet";
const key = keyFromSeed(readFileSync(`${process.env.HOME}/.rep-secrets/bookerbob-testnet/treasury.seed`, "utf8"));

async function call(method, args, deposit = 0n) {
  const r = await send(c, { signer_id: signer, key, receiver_id: SPIKE, actions: [{ type: "FunctionCall", method_name: method, args, gas: 300n * 10n ** 12n, deposit }] });
  const t = await c.rpc("tx", { tx_hash: r.hash, sender_account_id: signer, wait_until: "FINAL" });
  const tgas = Math.max(...[t.result.transaction_outcome, ...t.result.receipts_outcome].map((o) => Number(BigInt(o.outcome.gas_burnt) / 10n ** 9n) / 1000));
  return { ok: r.ok, value: r.value, tgas, tx: r.hash, error: r.ok ? null : (r.error.match(/step [a-z_]+: [^"\\]*/) ?? [r.error.slice(0, 160)])[0] };
}

async function run(quoteHex, label) {
  const calls = [];
  const s = await call("start", { quote_hex: quoteHex, collateral_json: JSON.stringify(col.collateral) }, 10n ** 24n / 2n);
  calls.push({ step: "start", ...s });
  console.log(`${label} start: ${s.ok ? "ok" : `FAILED ${s.error}`}, ${s.tgas} Tgas  https://testnet.nearblocks.io/txns/${s.tx}`);
  if (!s.ok) return { calls };
  const id = s.value;
  for (;;) {
    const st = await c.view(SPIKE, "verification", { id });
    if (st[0] === "verified") return { id, calls, verification: st };
    const r = await call("step", { id });
    calls.push({ step: st[0], ...r });
    console.log(`${label} ${st[0]}: ${r.ok ? `ok -> ${r.value}` : `FAILED ${r.error}`}, ${r.tgas} Tgas  https://testnet.nearblocks.io/txns/${r.tx}`);
    if (!r.ok) return { id, calls, failed_at: st[0] };
  }
}

const quote = report.model_attestations[0].intel_quote;
const real = await run(quote, "real quote");
// Tampered: one byte inside the signed TD report (the first 632 bytes).
const b = Buffer.from(quote, "hex");
b[600] ^= 1;
const tampered = await run(b.toString("hex"), "tampered quote");
const out = { spike: SPIKE, model: report.model_attestations[0].model_name ?? null, quote_bytes: quote.length / 2, collateral_checked_at: col.checked_at_secs, real, tampered };
writeFileSync("tools/dcap-spike/run.json", JSON.stringify(out, null, 2) + "\n");
console.log(`\nreal: ${real.verification ? `verified, ${real.verification[1]?.slice(0, 40)}..` : "NOT verified"}; tampered: ${tampered.failed_at ? `failed at ${tampered.failed_at}` : "NOT refused"}`);
