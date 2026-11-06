#!/usr/bin/env node
// `make leash`: an owner's signed limits on an agent, refused and honoured on testnet. Needs the
// Nov 10 contract batch. Testnet only.
//
//   node scripts/leash.mjs run       a tester gets a receipt from m01, then under three mandates
//                                    from one owner key: over the limit, refused; a closed blind
//                                    round m01 did not win, refused; inside the limits, settled
//   node scripts/leash.mjs verify    public check of the recorded run, no keys
import { createHash, randomBytes, sign } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

export const OUT = "fixtures/live/leash/run.json";
export const OVER = "over the mandate's limit per purchase";
export const LOSER = "not the winner of the mandate's round";
const MILLI = 10n ** 21n;
const TGAS = 10n ** 12n;
const fc = (method_name, args, deposit = 0n, gas = 100n * TGAS) => ({ type: "FunctionCall", method_name, args, gas, deposit });

/** The bytes the owner signs: core/src/mandate.rs, same string (tested on both sides). */
export const mandateMessage = (m) => `bookerbob/mandate/v1|${JSON.stringify([m.bazaar, m.agent, m.owner_key, m.max_per_purchase, m.max_total, m.expires_at_ms, m.round ?? null, m.nonce])}`;
export const mandateHash = (m) => createHash("sha256").update(mandateMessage(m)).digest("hex");

async function run() {
  const { Demo, config } = await import("./demo-tester.mjs");
  const { keyFromSeed } = await import("../relayer/near.mjs");
  const round = process.env.LEASH_ROUND ?? "builder-1"; // make try's round: closed, m01 did not bid
  const d = new Demo(config(process.env));
  const c = d.c;
  if (!(await d.client.view(c.bazaar, "round", { round_id: String(round) }))) throw new Error(`no round ${round} on ${c.bazaar}: set LEASH_ROUND to a closed round m01 did not win`);
  const owner = keyFromSeed(randomBytes(32).toString("hex"));
  const out = { bazaar: c.bazaar, merchant: c.merchant, owner_key: owner.pub, round: String(round), mandates: [], txs: {} };
  const rec = await d.run({
    beforeSettle: async ({ tester, rec, d }) => {
      const expires_at_ms = Date.now() + 3_600_000;
      const leash = async (nonce, per, total, r) => {
        const m = { bazaar: c.bazaar, agent: tester.id, owner_key: owner.pub, max_per_purchase: String(per), max_total: String(total), expires_at_ms, round: r, nonce };
        const signature = sign(null, Buffer.from(mandateMessage(m)), owner.priv).toString("hex");
        const t = await d.relay("set_mandate", tester, c.bazaar, fc("set_mandate", { mandate: m, signature }, 10n * MILLI));
        out.mandates.push({ ...m, tx: t.hash });
      };
      const settle = () => d.relay("settle_demo", tester, c.bazaar, fc("settle_demo", { nullifier: rec.nullifier, merchant: c.merchant, checkout_ref: `leash-${rec.nullifier.slice(0, 8)}`, amount: String(rec.price) }, 0n, 150n * TGAS));
      const refused = async (name, why) => {
        try {
          await settle();
        } catch (e) {
          if (!String(e.message).includes(why)) throw e;
          out.txs[name] = d.log.at(-1).hash;
          console.log(`   refused on chain: ${why}`);
          return;
        }
        throw new Error(`settled against the mandate: ${why}`);
      };
      const price = BigInt(rec.price);
      await leash(1, price - 1n, 10n * price, null);
      await refused("over_limit", OVER);
      await leash(2, price, 10n * price, String(round));
      await refused("non_winner", LOSER);
      await leash(3, price, price, null);
    },
  });
  Object.assign(out, { tester: rec.tester, nullifier: rec.nullifier, price: String(rec.price), date: rec.date });
  out.txs.settle = rec.txs.settle;
  mkdirSync("fixtures/live/leash", { recursive: true });
  writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
  console.log(`leash: PASS  wrote ${OUT}`);
}

/** Public check. `tx(hash, sender)` returns the raw RPC outcome; `view(account, method, args)`. */
export async function verifyRun(view, tx, out = JSON.parse(readFileSync(OUT, "utf8"))) {
  const outs = (t) => [t.transaction_outcome, ...t.receipts_outcome];
  const fail = (t) => JSON.stringify(outs(t).map((o) => o.outcome.status.Failure).find(Boolean) ?? "");
  const lines = [];
  for (const [name, why] of [["over_limit", OVER], ["non_winner", LOSER]]) {
    lines.push([fail(await tx(out.txs[name], out.tester)).includes(why), `refused on chain: ${why} (${out.txs[name].slice(0, 8)}..)`]);
  }
  const last = out.mandates.at(-1);
  const settle = await tx(out.txs.settle, out.tester);
  const ev = outs(settle).flatMap((o) => o.outcome.logs).filter((l) => l.startsWith("EVENT_JSON:")).map((l) => JSON.parse(l.slice(11))).find((e) => e.event === "settled")?.data?.[0];
  lines.push([fail(settle) === '""' && ev?.mandate === mandateHash(last), `settled ${Number(out.price) / 1e6} under mandate ${mandateHash(last).slice(0, 12)}.., which the settle event names`]);
  const spent = await view(out.bazaar, "mandate_spent", { agent: out.tester });
  lines.push([spent === out.price, `the chain counts ${Number(spent) / 1e6} against that mandate's limit of ${Number(last.max_total) / 1e6}`]);
  return lines;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cmd = process.argv[2];
  if (cmd === "run") await run();
  else if (cmd === "verify") {
    if (!existsSync(OUT)) {
      console.log("leash: not run live yet");
      process.exit(0);
    }
    const { rpcClient } = await import("../relayer/near.mjs");
    const client = rpcClient(process.env.NEAR_RPC || "https://test.rpc.fastnear.com");
    const tx = async (h, s) => (await client.rpc("tx", { tx_hash: h, sender_account_id: s, wait_until: "FINAL" })).result;
    const lines = await verifyRun((a, m, args) => client.view(a, m, args), tx);
    for (const [ok, t] of lines) console.log(`${ok ? "PASS" : "FAIL"}  ${t}`);
    process.exit(lines.every(([ok]) => ok) ? 0 : 1);
  } else {
    console.error("usage: leash.mjs run|verify");
    process.exit(2);
  }
}
