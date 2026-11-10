#!/usr/bin/env node
// Leak rule L9: every 32-byte hex value this repo holds or ever held, tried against every sealed
// field of every model response on chain or committed. A buyer discloses one key for one field,
// the answer (`response_key`), so the rule expects exactly that and nothing else. The client's
// X25519 secret opens every field of its response, the model's reasoning too, which restates
// the facts, so a committed one fails here.
//
// The disclosed answer is public, so L9 also compares it with the verdict: an answer naming a
// predicate the verdict did not reveal fails. Exposures already fixed are listed in fixtures/live/leak-exposed.json (hashes of the keys, not
// the keys) and printed as KNOWN. A listed key at HEAD still fails: only history is forgiven.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { clientKey, fieldKey, openField, openWith, sealTo } from "./lib/e2ee.mjs";

const HEX = /\b[0-9a-f]{64}\b/g;
const git = (...a) => execFileSync("git", a, { encoding: "utf8", maxBuffer: 1 << 30 });
const sha = (s) => createHash("sha256").update(s).digest("hex");

/** Sealed fields of a response body: wire hex long enough to hold eph, nonce and a tag. */
export function sealedFields(body) {
  const m = body?.choices?.[0]?.message ?? {};
  return Object.entries(m).filter(([, v]) => typeof v === "string" && /^[0-9a-f]+$/.test(v) && v.length >= 2 * (32 + 24 + 16)).map(([field, wire]) => ({ field, wire }));
}

/** What a 32-byte value opens in one field, as a client secret or as a field key. */
export function opens(key, wire) {
  const raw = Buffer.from(key, "hex");
  for (const [how, f] of [["client secret", () => openWith(wire, raw)], ["field key", () => openField(wire, raw)]]) {
    try {
      return { how, text: f() };
    } catch {}
  }
  return null;
}

/**
 * responses: [{ source, tx?, body, response_key?, revealed? }]. keys: Map(hex => where).
 * Returns { checked, disclosed, exposures: [{ source, field, how, where, key_sha256 }], extra }.
 */
export function scan(responses, keys) {
  const out = { checked: 0, disclosed: 0, exposures: [], extra: [] };
  const seen = new Set();
  for (const r of responses) {
    for (const { field, wire } of sealedFields(r.body)) {
      if (seen.has(wire)) continue;
      seen.add(wire);
      out.checked++;
      if (r.response_key && field === "content" && opens(r.response_key, wire)) {
        out.disclosed++;
        const a = opens(r.response_key, wire).text.match(/\{[\s\S]*\}/);
        const said = a ? (JSON.parse(a[0]).predicates ?? []) : [];
        const more = r.revealed ? said.filter((p) => !r.revealed.includes(p)) : [];
        if (more.length) out.extra.push({ source: r.source, predicates: more });
      }
      for (const [key, where] of keys) {
        if (key === r.response_key && field === "content") continue;
        const got = opens(key, wire);
        if (got) out.exposures.push({ source: r.source, field, how: got.how, where, key_sha256: sha(key) });
      }
    }
  }
  return out;
}

// Every tx named `verdict` in a committed record, then the ones that carry a model proof.
function verdictTxs() {
  const found = new Map();
  const walk = (o, f) => {
    if (Array.isArray(o)) return o.forEach((x) => walk(x, f));
    if (!o || typeof o !== "object") return;
    if (typeof o.txs?.verdict === "string") found.set(o.txs.verdict, f);
    Object.values(o).forEach((x) => walk(x, f));
  };
  for (const f of git("ls-files", "fixtures/live/*.json").trim().split("\n")) {
    try {
      walk(JSON.parse(readFileSync(f, "utf8")), f);
    } catch {}
  }
  return found;
}

async function txArgs(rpc, hash, sender) {
  const r = (await rpc("tx", { tx_hash: hash, sender_account_id: sender, wait_until: "FINAL" })).result;
  const acts = (r?.transaction?.actions ?? []).flatMap((a) => (a.Delegate ? a.Delegate.delegate_action.actions.map((x) => x.NonDelegateAction ?? x) : [a]));
  const call = acts.find((a) => a.FunctionCall?.method_name === "submit_near_ai_verdict");
  return call ? JSON.parse(Buffer.from(call.FunctionCall.args, "base64").toString()) : null;
}

/** Every 64-hex value at HEAD and in history, each with the first place it was seen. */
function allKeys() {
  const keys = new Map();
  const add = (text, where) => {
    for (const k of text.match(HEX) ?? []) if (!keys.has(k)) keys.set(k, where);
  };
  add(git("grep", "-h", "-I", "-E", "[0-9a-f]{64}", "--", "fixtures", "agents", "docs", "scripts"), "HEAD");
  const head = new Set(keys.keys());
  add(git("log", "--all", "--format=", "-p", "-G", "(secret|_key|seed)[a-z_]*\"?: *\"?[0-9a-f]{64}", "--", "fixtures", "agents", "docs"), "history");
  return { keys, head };
}

export async function l9(rpc, sender) {
  // The rule must be able to fire: a client secret opens both fields, a field key only its own.
  {
    const { pubHex: selfPub, xSecret: selfSecret } = clientKey();
    const a = sealTo("answer", selfPub), b = sealTo("reasoning", selfPub);
    const body = { choices: [{ message: { content: a, reasoning_content: b } }] };
    const k = fieldKey(a, selfSecret);
    const hit = scan([{ source: "probe", body, response_key: k }], new Map([[selfSecret.toString("hex"), "probe"]]));
    const quiet = scan([{ source: "probe", body, response_key: k }], new Map([[k, "probe"]]));
    if (hit.exposures.length !== 2 || quiet.exposures.length) throw new Error("L9 cannot tell a client secret from a field key: rule broken");
  }
  const { keys, head } = allKeys();
  const responses = [];
  const txs = verdictTxs();
  let model = 0;
  for (const [hash] of txs) {
    const a = await txArgs(rpc, hash, sender);
    if (!a?.proof) continue;
    model++;
    responses.push({ source: `tx ${hash.slice(0, 8)}`, body: JSON.parse(a.proof.response), response_key: a.proof.response_key, revealed: a.envelope.predicates });
  }
  const committed = JSON.parse(readFileSync("fixtures/live/near-ai/proof.json", "utf8"));
  responses.push({ source: "fixtures/live/near-ai", body: JSON.parse(committed.response), response_key: committed.response_key });
  const r = scan(responses, keys);
  const frozen = JSON.parse(readFileSync("fixtures/live/leak-exposed.json", "utf8"));
  const known = new Set(frozen.keys.map((k) => k.key_sha256));
  const isHead = (e) => [...head].some((k) => sha(k) === e.key_sha256);
  const fresh = r.exposures.filter((e) => !known.has(e.key_sha256) || isHead(e));
  const over = new Set(frozen.over_disclosed.txs.map((t) => `tx ${t}`));
  const freshExtra = r.extra.filter((x) => !over.has(x.source));
  return { ...r, model, txs: txs.size, keys: keys.size, frozen, fresh, freshExtra };
}

export function report(r) {
  const lines = [`L9 committed keys: ${r.keys} 32-byte values tried on ${r.checked} sealed fields of ${r.model} model txs and 1 committed capture; ${r.disclosed} answer fields open with their disclosed key`];
  for (const e of r.exposures) lines.push(`${r.fresh.includes(e) ? "FAIL " : "KNOWN"}  ${e.source} ${e.field} opened as ${e.how} (${e.where})`);
  for (const x of r.extra) lines.push(`${r.freshExtra.includes(x) ? "FAIL " : "KNOWN"}  ${x.source}: the disclosed answer names ${x.predicates.join(", ")}, more than the verdict reveals`);
  lines.push(r.fresh.length || r.freshExtra.length ? `FAIL  L9: ${r.fresh.length} sealed field(s) open with a value in this repo, ${r.freshExtra.length} answer(s) say more than the verdict` : `PASS  L9: no key at HEAD opens a sealed field beyond its disclosed answer; ${r.exposures.length} field(s) opened by keys since removed, listed in fixtures/live/leak-exposed.json`);
  return lines;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const m = JSON.parse(readFileSync("fixtures/live/testnet-manifest.json", "utf8"));
  const RPC = process.env.NEAR_RPC || "https://test.rpc.fastnear.com";
  const rpc = async (method, params) => {
    for (let i = 0; i < 8; i++) {
      const url = (i % 2 === 1) !== (method === "tx") ? "https://archival-rpc.testnet.fastnear.com" : RPC; // an old tx is only on the archival host
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "l9", method, params }) }).catch(() => null);
      if (!res || res.status === 429 || res.status >= 500) { await new Promise((s) => setTimeout(s, 1000 * (i + 1))); continue; }
      return res.json();
    }
    throw new Error("rpc failed");
  };
  const r = await l9(rpc, m.treasury);
  for (const l of report(r)) console.log(l);
  if (r.fresh.length || r.freshExtra.length) process.exit(1);
}
