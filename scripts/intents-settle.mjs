#!/usr/bin/env node
// One agent-to-agent settlement on NEAR Intents, mainnet: the buyer agent pays the merchant agent
// 0.1 wNEAR inside intents.near with a "transfer" intent it signs itself (NEP-413), its memo
// naming one testnet purchase. Two implicit accounts, keys in ~/.rep-secrets/bookerbob-mainnet.
// The bazaar contract is not involved and not changed.
//
//   node scripts/intents-settle.mjs plan                  reads balances, signs the intent and runs
//                                                          simulate_intents (a view): sends nothing
//   node scripts/intents-settle.mjs run --mainnet         real money: needs BOOKERBOB_MAINNET_GO=<today>
//   node scripts/intents-settle.mjs check [file]          keyless recheck of the record over public RPC
import { createHash, randomBytes, sign } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { b58encode, keyFromSeed, NEAR, rpcClient, send } from "../relayer/near.mjs";

const RPC = process.env.NEAR_MAINNET_RPC ?? "https://rpc.mainnet.fastnear.com";
const VERIFIER = "intents.near", WRAP = "wrap.near", TOKEN = "nep141:wrap.near";
const AMOUNT = 10n ** 23n; // 0.1 wNEAR
const TGAS = 10n ** 12n;
const OUT = "fixtures/mainnet/intents-settle.json";
const link = (h) => `https://nearblocks.io/txns/${h}`;
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const bstr = (s) => { const b = Buffer.from(s, "utf8"); return Buffer.concat([u32(b.length), b]); };

/** NEP-413: sha256(u32le(2^31 + 413) || borsh(Payload { message, nonce: [u8; 32], recipient, callback_url: None })). */
export function nep413Hash({ message, nonce, recipient }) {
  return createHash("sha256").update(Buffer.concat([u32(2 ** 31 + 413), bstr(message), nonce, bstr(recipient), Buffer.from([0])])).digest();
}

export function signTransfer({ key, signer_id, receiver_id, memo, salt, amount = AMOUNT, ttlMs = 10 * 60_000, now = Date.now() }) {
  const message = JSON.stringify({ signer_id, deadline: new Date(now + ttlMs).toISOString(), intents: [{ intent: "transfer", receiver_id, tokens: { [TOKEN]: amount.toString() }, memo }] });
  const nonce = Buffer.concat([Buffer.from(salt, "hex"), randomBytes(28)]);
  const sig = sign(null, nep413Hash({ message, nonce, recipient: VERIFIER }), key.priv);
  return { standard: "nep413", payload: { message, nonce: nonce.toString("base64"), recipient: VERIFIER }, public_key: `ed25519:${b58encode(Buffer.from(key.pub, "hex"))}`, signature: `ed25519:${b58encode(sig)}` };
}

const dir = join(homedir(), ".rep-secrets", "bookerbob-mainnet");
const keyOf = (n) => keyFromSeed(readFileSync(join(dir, `${n}.seed`), "utf8"));
const bal = async (c, id) => BigInt(await c.view(VERIFIER, "mt_balance_of", { account_id: id, token_id: TOKEN }));

async function main() {
  const [cmd] = process.argv.slice(2);
  const c = rpcClient(RPC);
  if (cmd === "check") {
    const r = JSON.parse(readFileSync(process.argv[3] ?? OUT, "utf8"));
    // Txs older than about two days live only on the archival node; the regular one waits forever.
    const arch = rpcClient(process.env.NEAR_MAINNET_ARCHIVAL_RPC ?? "https://archival-rpc.mainnet.fastnear.com");
    for (const [step, h] of Object.entries(r.txs)) {
      const t = (await arch.rpc("tx", { tx_hash: h, sender_account_id: r.buyer, wait_until: "NONE" })).result;
      const ok = t && !("Failure" in (t.status ?? {}));
      console.log(`${ok ? "PASS" : "FAIL"}  ${step}: ${link(h)}`);
    }
    console.log(`merchant's wNEAR inside intents.near now: ${(await bal(c, r.merchant)).toString()} (the settle moved ${r.amount})`);
    return;
  }
  const buyer = keyOf("buyer"), merchant = keyOf("merchant");
  const B = buyer.pub, M = merchant.pub;
  const memo = process.env.SETTLE_MEMO ?? "bookerbob: settles testnet purchase 9Esa4qikkoje5yJktpxdSoCEWJitm1Mren2LiHWVyRr6";
  const salt = await c.view(VERIFIER, "current_salt", {});
  const acct = await c.rpc("query", { request_type: "view_account", finality: "final", account_id: B }).catch(() => null);
  const nearBal = acct?.result?.amount ? BigInt(acct.result.amount) : 0n;
  console.log(`buyer ${B}: ${Number(nearBal) / 1e24} NEAR, ${(await bal(c, B)).toString()} wNEAR in intents; merchant ${M}: ${(await bal(c, M)).toString()}`);
  const signed = signTransfer({ key: buyer, signer_id: B, receiver_id: M, memo, salt });
  if (cmd === "plan") {
    try { const s = await c.view(VERIFIER, "simulate_intents", { signed: [signed] }); console.log("simulate_intents:", JSON.stringify(s).slice(0, 400)); }
    catch (e) { console.log("simulate_intents refused (expected before the deposit):", String(e.message).slice(0, 300)); }
    return;
  }
  if (cmd !== "run" || !process.argv.includes("--mainnet")) throw new Error("usage: plan | run --mainnet | check");
  const today = new Date().toISOString().slice(0, 10);
  if (process.env.BOOKERBOB_MAINNET_GO !== today) throw new Error(`real money: set BOOKERBOB_MAINNET_GO=${today} when the founder says go`);
  if (nearBal < 3n * 10n ** 23n) throw new Error("fund the buyer with at least 0.3 NEAR first");
  const txs = {};
  const step = async (name, receiver_id, method_name, args, deposit, gas = 30n * TGAS) => {
    const r = await send(c, { signer_id: B, key: buyer, receiver_id, actions: [{ type: "FunctionCall", method_name, args, gas, deposit }] });
    console.log(`${r.ok ? "ok  " : "FAIL"} ${name}  ${link(r.hash)}${r.ok ? "" : `  ${r.error}`}`);
    if (!r.ok) throw new Error(`${name} failed`);
    txs[name] = r.hash;
  };
  await step("storage_deposit", WRAP, "storage_deposit", { account_id: B, registration_only: true }, 1250n * 10n ** 18n);
  await step("near_deposit", WRAP, "near_deposit", {}, 2n * AMOUNT);
  await step("deposit_to_intents", WRAP, "ft_transfer_call", { receiver_id: VERIFIER, amount: AMOUNT.toString(), msg: "" }, 1n, 100n * TGAS);
  const before = { buyer: (await bal(c, B)).toString(), merchant: (await bal(c, M)).toString() };
  const fresh = signTransfer({ key: buyer, signer_id: B, receiver_id: M, memo, salt: await c.view(VERIFIER, "current_salt", {}) });
  await step("execute_intents", VERIFIER, "execute_intents", { signed: [fresh] }, 0n, 100n * TGAS);
  const after = { buyer: (await bal(c, B)).toString(), merchant: (await bal(c, M)).toString() };
  const rec = { note: "One agent-to-agent settlement on NEAR Intents mainnet: the buyer agent's own signed transfer intent moved 0.1 wNEAR to the merchant agent inside intents.near. Two implicit accounts held by REP; the memo names one testnet purchase. Check: node scripts/intents-settle.mjs check", network: "mainnet", verifier: VERIFIER, buyer: B, merchant: M, token: TOKEN, amount: AMOUNT.toString(), memo, intent: JSON.parse(fresh.payload.message), public_key: fresh.public_key, signature: fresh.signature, nonce: fresh.payload.nonce, txs, before, after };
  writeFileSync(OUT, JSON.stringify(rec, null, 2) + "\n");
  console.log(`wrote ${OUT}; merchant ${before.merchant} -> ${after.merchant}`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main().catch((e) => { console.error(`FAIL  ${e.message}`); process.exit(1); });
