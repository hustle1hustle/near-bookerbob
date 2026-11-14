#!/usr/bin/env node
// Pre-registration on chain: before a measured run, the sha256 of its pre-registration file goes
// on NEAR testnet as the memo of a 0.000001 dUSDC transfer, so anyone can see the design was fixed
// before the run (the tx's block time is earlier than the run's first record).
// With the marker line (MARKER below) in the file, the hash covers only the text above it.
//
//   node scripts/prereg-anchor.mjs anchor <file>        sends the tx (the demo treasury's key)
//   node scripts/prereg-anchor.mjs check <file> <tx> [first-run ISO time]   keyless: the tx's memo is this
//     file's sha256, signed by the demo treasury, and (given the time) earlier than the run
//
// The memo reads `bookerbob/prereg/v1 sha256:<hex> <file name>`. dUSDC is a testnet demo token.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { keyFromSeed, rpcClient, send } from "../relayer/near.mjs";

const RPC = process.env.NEAR_RPC ?? "https://rpc.testnet.fastnear.com";
const DUSDC = "bookerbob-dusdc.testnet";
const FROM = "bookerbob-demo.testnet";
const TO = "bookerbob.testnet";
// A file may carry the marker line below: only the part above it is anchored, so the tx hash can
// be written under it afterwards without changing what was anchored.
export const MARKER = "<!-- anchored above this line -->";
export const anchoredPart = (bytes) => { const t = bytes.toString("utf8"); return t.includes(MARKER) ? Buffer.from(t.split(MARKER)[0], "utf8") : bytes; };
export const memoFor = (bytes, name) => `bookerbob/prereg/v1 sha256:${createHash("sha256").update(anchoredPart(bytes)).digest("hex")} ${name}`;

export async function check(client, file, txHash, firstRunAt = null) {
  const memo = memoFor(readFileSync(file), basename(file));
  let r;
  try { r = await client.rpc("tx", { tx_hash: txHash, sender_account_id: FROM, wait_until: "FINAL" }); } catch (e) { return { ok: false, unreachable: true, line: `RPC unreachable (${e.message.slice(0, 60)})` }; }
  if (r.error) return { ok: false, line: `tx ${txHash.slice(0, 8)}.. not found` };
  const t = r.result.transaction;
  const call = t.actions.map((a) => a.FunctionCall).find(Boolean);
  let args = {};
  try { args = call ? JSON.parse(Buffer.from(call.args, "base64").toString()) : {}; } catch { args = {}; }
  const blk = await client.rpc("block", { block_id: r.result.transaction_outcome.block_hash });
  const at = new Date(Number(BigInt(blk.result.header.timestamp_nanosec) / 1_000_000n)).toISOString();
  const before = firstRunAt == null || at < firstRunAt;
  const ok = !r.result.status.Failure && t.signer_id === FROM && t.receiver_id === DUSDC && call?.method_name === "ft_transfer" && args.memo === memo && before;
  return { ok, at, line: `${basename(file)} sha256 ${memo.split("sha256:")[1].slice(0, 12)}.. ${args.memo === memo ? "is" : "is NOT"} the memo of tx ${txHash.slice(0, 8)}.. signed by ${t.signer_id} (block time ${at}${firstRunAt ? `, ${before ? "before" : "NOT before"} the first run at ${firstRunAt}` : ""})` };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, file, txh] = process.argv.slice(2);
  const client = rpcClient(RPC);
  if (cmd === "anchor") {
    const key = keyFromSeed(readFileSync(`${process.env.HOME}/.rep-secrets/bookerbob-testnet/treasury.seed`, "utf8"));
    const memo = memoFor(readFileSync(file), basename(file));
    const o = await send(client, { signer_id: FROM, key, receiver_id: DUSDC, actions: [{ type: "FunctionCall", method_name: "ft_transfer", args: { receiver_id: TO, amount: "1", memo }, gas: 30_000_000_000_000n, deposit: 1n }] });
    console.log(o.ok ? `anchored  ${memo}\ntx ${o.hash}` : `FAIL  ${o.error}`);
    process.exit(o.ok ? 0 : 1);
  } else if (cmd === "check") {
    const c = await check(client, file, txh, process.argv[5] ?? null);
    console.log(`${c.unreachable ? "SKIP" : c.ok ? "PASS" : "FAIL"}  pre-registration: ${c.line}`);
    process.exit(c.unreachable ? 3 : c.ok ? 0 : 1);
  } else {
    console.error("usage: prereg-anchor.mjs anchor <file> | check <file> <tx>");
    process.exit(2);
  }
}
