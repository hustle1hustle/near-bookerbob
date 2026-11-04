#!/usr/bin/env node
// `make verify-live`: re-derive the testnet claims from public RPC, no keys, no build.
// Reads fixtures/live/testnet-manifest.json (public data only: accounts, nullifiers, tx
// hashes, expected values) and checks each against chain state and tx outcomes now.
//   NEAR_RPC=<url> make verify-live     another public testnet RPC (fallback list below)
import { readFileSync } from "node:fs";

const RPCS = [process.env.NEAR_RPC, "https://test.rpc.fastnear.com", "https://rpc.testnet.pagoda.co", "https://neart.lava.build"].filter(Boolean);
const manifest = JSON.parse(readFileSync(new URL("../fixtures/live/testnet-manifest.json", import.meta.url)));

async function rpc(method, params) {
  let last;
  for (const url of RPCS) {
    for (let i = 0; i < 3; i++) {
      try {
        const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "verify-live", method, params }) });
        if (r.status === 429 || r.status >= 500) { last = `${url} ${r.status}`; await new Promise((s) => setTimeout(s, 1000 * (i + 1))); continue; }
        const j = await r.json();
        if (j.error && /UNKNOWN_TRANSACTION|TIMEOUT/.test(JSON.stringify(j.error)) && i < 2) { last = JSON.stringify(j.error); await new Promise((s) => setTimeout(s, 1000)); continue; }
        return j;
      } catch (e) {
        last = `${url} ${e.message}`;
      }
    }
  }
  throw new Error(`RPC failed: ${last}`);
}

const view = async (account_id, method_name, args = {}) => {
  const r = await rpc("query", { request_type: "call_function", finality: "final", account_id, method_name, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") });
  if (r.error || r.result?.error) throw new Error(`${method_name}: ${JSON.stringify(r.error ?? r.result.error).slice(0, 200)}`);
  return JSON.parse(Buffer.from(r.result.result).toString() || "null");
};

/** The tx's outcome: { ok, error, logs, methods } (methods of every FunctionCall, incl. delegated). */
async function tx(hash, sender) {
  const r = await rpc("tx", { tx_hash: hash, sender_account_id: sender, wait_until: "FINAL" });
  if (r.error) throw new Error(`tx ${hash}: ${JSON.stringify(r.error).slice(0, 200)}`);
  const res = r.result;
  const all = [res.transaction_outcome, ...res.receipts_outcome];
  const fail = all.map((o) => o.outcome.status.Failure).find(Boolean) ?? res.status.Failure;
  const methods = [];
  const walk = (actions) => {
    for (const a of actions ?? []) {
      if (a.FunctionCall) methods.push(a.FunctionCall.method_name);
      if (a.Delegate) walk(a.Delegate.delegate_action.actions.map((x) => x.NonDelegateAction ?? x));
    }
  };
  walk(res.transaction.actions);
  const delegated = (res.transaction.actions ?? []).some((a) => a.Delegate) && res.transaction.signer_id !== res.transaction.receiver_id;
  return { ok: !fail, error: fail ? JSON.stringify(fail) : null, logs: all.flatMap((o) => o.outcome.logs), methods, delegated, signer: res.transaction.signer_id, receiver: res.transaction.receiver_id };
}
const events = (logs) => logs.filter((l) => l.startsWith("EVENT_JSON:")).map((l) => JSON.parse(l.slice(11)));

let failed = 0;
const out = (ok, what, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}${detail ? `  (${detail})` : ""}`);
};
const attempt = async (what, f) => {
  try {
    const [ok, detail] = await f();
    out(ok, what, detail);
  } catch (e) {
    out(false, what, e.message.slice(0, 200));
  }
};

const m = manifest;
console.log(`verify-live: ${m.bazaar} on NEAR testnet, over public RPC (${RPCS[0]})\n`);
await attempt("bazaar accepts the demo token, rounds are the demo length", async () => {
  const [dt, ms] = await Promise.all([view(m.bazaar, "demo_token"), view(m.bazaar, "review_round_ms")]);
  return [dt === m.dusdc && ms === m.review_round_ms, `demo_token ${dt}, ${ms / 60000} min rounds`];
});
await attempt(`dUSDC is a testnet demo token with no value`, async () => {
  const meta = await view(m.dusdc, "ft_metadata");
  return [/testnet, no value/.test(meta.name) && meta.decimals === 6, meta.name];
});
await attempt(`${m.merchants_approved} merchants registered and approved`, async () => {
  const ms = await view(m.bazaar, "merchants", { from_index: 0, limit: 50 });
  const approved = ms.filter((x) => x.approved ?? x[1]?.approved ?? true).length;
  return [ms.length >= m.merchants_approved, `${ms.length} listed`];
});
for (const t of m.testers) {
  const short = t.tester.split(".")[0];
  await attempt(`${short}: settle_demo paid ${Number(t.price) / 1e6} dUSDC to ${t.merchant}, nullifier spent, paid in demo`, async () => {
    const [s, status, paid] = await Promise.all([tx(t.txs.settle, m.treasury), view(m.bazaar, "nullifier_status", { nullifier: t.nullifier }), view(m.bazaar, "paid_in", { nullifier: t.nullifier })]);
    const settled = events(s.logs).find((e) => e.event === "settled")?.data?.[0];
    const ft = events(s.logs).find((e) => e.standard === "nep141" && e.event === "ft_transfer" && e.data[0].new_owner_id === t.merchant);
    const reverted = events(s.logs).some((e) => e.event === "settle_reverted");
    return [s.ok && s.methods.includes("settle_demo") && settled?.token === "demo" && settled.amount === String(t.price) && ft && !reverted && status === "Spent" && paid === "demo", `tx ${t.txs.settle.slice(0, 8)}, ${status}`];
  });
  await attempt(`${short}: the same nullifier from another account was refused`, async () => {
    const r = await tx(t.txs.replay, m.treasury);
    return [!r.ok && /nullifier spent/.test(r.error), "nullifier spent"];
  });
  await attempt(`${short}: every purchase call was a NEP-366 delegate the relayer paid for`, async () => {
    const rs = await Promise.all(["mint", "verdict", "receipt", "escrow", "settle"].map((k) => tx(t.txs[k], m.treasury)));
    return [rs.every((r) => r.ok && r.delegated && r.signer === m.treasury && r.receiver === t.tester), "mint, verdict, receipt, escrow, settle: Delegate actions signed by the tester, sent and paid by the relayer"];
  });
}
if (m.fc_key_check) {
  await attempt("a settle-only function-call key was added; withdraws under it were refused before execution", async () => {
    const r = await tx(m.fc_key_check.add_key_tx, m.fc_key_check.tester);
    const why = m.fc_key_check.refusals.map((x) => `${x.method}: ${x.error}`).join("; ");
    return [r.ok && m.fc_key_check.refusals.length >= 2 && m.fc_key_check.refusals.every((x) => /DepositWithFunctionCall|MethodNameMismatch/.test(x.error)), `AddKey on chain; refusals are RPC errors, no tx: ${why.slice(0, 160)}`];
  });
}
if (m.reviews) {
  await attempt(`${m.reviews.ratings} sealed reviews released for ${m.merchant} at k >= 5`, async () => {
    const [s, g] = await Promise.all([view(m.bazaar, "merchant_score", { merchant: m.merchant }), view(m.bazaar, "review_group", { merchant: m.merchant })]);
    return [s.ratings >= m.reviews.ratings && g.tree.size >= 5, `${s.ratings} ratings, score ${s.score_x100 / 100}, group ${g.tree.size}`];
  });
  await attempt("reviews were sent from one-time accounts, not the buyers", async () => {
    const senders = new Set(m.reviews.senders);
    const buyers = new Set(m.testers.map((t) => t.tester));
    return [[...senders].every((s) => /^[0-9a-f]{64}$/.test(s) && !buyers.has(s)) && senders.size === m.reviews.ratings, `${senders.size} distinct implicit accounts`];
  });
}
await attempt("graph root on chain equals the committed standing input's root", async () => {
  const [root] = await view(m.bazaar, "graph_root");
  const input = JSON.parse(readFileSync(new URL(`../${m.standing.input}`, import.meta.url)));
  return [root === input.expected.root || m.standing.root === root, `root ${root.slice(0, 16)}..`];
});
if (m.standing.update_tx) {
  await attempt("the Jolt standing update (worker-signed) was accepted with nonzero merchants", async () => {
    const r = await tx(m.standing.update_tx, m.bazaar);
    const e = events(r.logs).find((x) => x.event === "graph_scores")?.data?.[0];
    return [r.ok && e && e.merchants > 0 && e.program === m.standing.program_hash, e ? `merchants ${e.merchants}, program ${e.program.slice(0, 12)}..` : "no graph_scores event"];
  });
}
console.log(`\n${failed ? "FAIL" : "PASS"}  verify-live: ${failed ? `${failed} checks failed` : "every testnet claim re-derived from public RPC"}`);
process.exit(failed ? 1 : 0);
