#!/usr/bin/env node
// `make cheat`: a merchant inflates its base price so its "discount" lands at the old price,
// and the bazaar refuses it on testnet. The ceiling is each hotel's public rate (JMPR comparison
// prices, fixtures/live/jmpr-lisbon-rates.json), set with `set_price_anchor`.
//
//   node scripts/cheat.mjs anchors   the owner sets h01..h08's anchors from the public rates
//   node scripts/cheat.mjs run       h05 re-registers with an inflated base: refused; at its
//                                    public rate: accepted; writes fixtures/live/cheat/run.json
// Testnet only. The owner and merchant keys are in the near-cli keychain.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { rpcClient } from "../relayer/near.mjs";

const BAZAAR = process.env.BAZAAR_ACCOUNT_ID || "bookerbob.testnet";
if (!BAZAAR.endsWith(".testnet")) throw new Error("testnet only");
const client = rpcClient(process.env.NEAR_RPC || "https://test.rpc.fastnear.com");
const rates = JSON.parse(readFileSync("fixtures/live/jmpr-lisbon-rates.json", "utf8"));
const merchants = JSON.parse(readFileSync("agents/merchants.json", "utf8")).filter((m) => m.category === "hotel-lisbon");
const OUT = "fixtures/live/cheat/run.json";

/** A hotel's public price for the stay, in dUSDC base units, and where it comes from. */
export function publicPrice(hotel, nights) {
  const base = hotel.base_nightly ?? null;
  const nightly = base ?? hotel.elite_nightly;
  const what = base != null ? "public base rate incl. tax" : "public elite rate before tax (no base rate listed)";
  return { max: BigInt(nightly * nights) * 1_000_000n, source: `JMPR ${rates.queried}, ${hotel.name}, ${what}, ${nightly} x ${nights} nights` };
}

/** near-cli signs (keychain); the signed tx is broadcast over RPC, so a refused call still has its hash. */
async function call(signer, method, args, deposit = "0 NEAR") {
  const o = spawnSync("near", ["contract", "call-function", "as-transaction", BAZAAR, method, "json-args", JSON.stringify(args), "prepaid-gas", "50.0 Tgas", "attached-deposit", deposit, "sign-as", signer, "network-config", "testnet", "sign-with-keychain", "display"], { encoding: "utf8" });
  const text = `${o.stdout}${o.stderr}`.replace(/\x1b\[[0-9;]*m/g, "");
  const b64 = text.split("serialized as base64):")[1]?.trim().split(/\s/)[0];
  if (!b64) throw new Error(`could not sign ${method} as ${signer}: ${text.slice(-200)}`);
  const r = await client.rpc("send_tx", { signed_tx_base64: b64, wait_until: "FINAL" });
  const res = r.result;
  const fail = res ? [res.transaction_outcome, ...res.receipts_outcome].map((x) => x.outcome.status.Failure).find(Boolean) ?? res.status.Failure : r.error;
  return { hash: res?.transaction?.hash ?? null, ok: Boolean(res) && !fail, text: JSON.stringify(fail ?? {}) };
}

const hotelOf = (m) => rates.hotels.find((h) => m.persona.startsWith(h.name));

async function anchors() {
  const out = {};
  for (const m of merchants) {
    const h = hotelOf(m);
    if (!h) throw new Error(`${m.account}: no public rate`);
    const { max, source } = publicPrice(h, rates.nights);
    const r = await call(BAZAAR, "set_price_anchor", { merchant: m.account, max_base: String(max), source });
    if (!r.ok) throw new Error(`set_price_anchor ${m.account}: ${r.text.slice(-200)}`);
    const onChain = await client.view(BAZAAR, "merchant", { merchant: m.account });
    out[m.account] = { max_base: String(max), source, tx: r.hash, base: onChain.schedule.base_price, approved: onChain.approved };
    console.log(`   ok ${m.account.split(".")[0]} anchor ${Number(max) / 1e6} (${h.name}); base ${Number(onChain.schedule.base_price) / 1e6}, approved ${onChain.approved}  https://testnet.nearblocks.io/txns/${r.hash}`);
  }
  return out;
}

async function run() {
  const pub = JSON.parse((() => { try { return readFileSync(OUT, "utf8"); } catch { return "{}"; } })());
  pub.anchors = pub.anchors ?? (await anchors());
  const h05 = merchants.find((m) => m.account.startsWith("h05."));
  const cur = await client.view(BAZAAR, "merchant", { merchant: h05.account });
  // The cheat: raise the base so that 15% "off" lands at the public price.
  const inflated = { ...cur.schedule, base_price: String((BigInt(cur.schedule.base_price) * 100n) / 85n) };
  const cheat = await call(h05.account, "register_merchant", { schedule: inflated, category: "hotel-lisbon", payout: null }, "0.02 NEAR");
  const refused = !cheat.ok && /above its public price anchor/.test(cheat.text);
  console.log(`   ${refused ? "refused as expected" : "UNEXPECTED"}: h05 re-registers at base ${Number(inflated.base_price) / 1e6} (public ${Number(pub.anchors[h05.account].max_base) / 1e6})  https://testnet.nearblocks.io/txns/${cheat.hash}`);
  if (!refused) throw new Error(`the inflated base was not refused: ${cheat.text.slice(-300)}`);
  const after = await client.view(BAZAAR, "merchant", { merchant: h05.account });
  pub.cheat = { merchant: h05.account, inflated_base: inflated.base_price, anchor: pub.anchors[h05.account].max_base, tx: cheat.hash, refused, schedule_unchanged: after.schedule.base_price === cur.schedule.base_price, approved_after: after.approved };
  mkdirSync("fixtures/live/cheat", { recursive: true });
  writeFileSync(OUT, JSON.stringify(pub, null, 2) + "\n");
  console.log(`\ncheat: PASS  the inflated base was refused; h05's schedule unchanged (${Number(after.schedule.base_price) / 1e6}), still approved ${after.approved}; ${OUT}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cmd = process.argv[2] ?? "run";
  (cmd === "anchors" ? anchors() : run()).catch((e) => {
    console.error(`cheat: FAIL ${e.message}`);
    process.exit(1);
  });
}
