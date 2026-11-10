#!/usr/bin/env node
// Checks the wasm verifier outside a browser, with the files the page serves:
// the committed native proof must verify, and every changed statement must be refused.
//   node zk/browser/check.mjs [agents/prove]
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dir = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "../../agents/prove");
const never = (name) => () => {
  throw new Error(`verifier called ${name}`);
};
const imports = {
  __wbindgen_placeholder__: { __wbindgen_describe: never("describe") },
  __wbindgen_externref_xform__: { __wbindgen_externref_table_set_null: never("set_null"), __wbindgen_externref_table_grow: never("grow") },
};
const module = await WebAssembly.compile(gunzipSync(readFileSync(join(dir, "verifier.wasm.gz"))));
const pp = readFileSync(join(dir, "verifier.bin"));
const proof = readFileSync(join(dir, "sample-proof.bin"));
const publicText = readFileSync(join(dir, "public.json"), "utf8");

async function verify(statement, proofBytes = proof) {
  const x = (await WebAssembly.instantiate(module, imports)).exports;
  const put = (b) => {
    const p = x.bb_alloc(b.length);
    new Uint8Array(x.memory.buffer, p, b.length).set(b);
    return [p, b.length];
  };
  const args = [...put(pp), ...put(proofBytes), ...put(Buffer.from(JSON.stringify(statement)))];
  const t = performance.now();
  let ok;
  try {
    ok = x.bb_verify(...args) === 1;
  } catch (e) {
    return { ok: false, ms: performance.now() - t, error: `trap: ${e.message}` };
  }
  const ms = performance.now() - t;
  return { ok, ms, error: ok ? null : Buffer.from(new Uint8Array(x.memory.buffer, x.bb_error_ptr(), x.bb_error_len())).toString() };
}

const base = () => JSON.parse(publicText);
const bump = (s, by) => (BigInt(s) + by).toString();
let bad = false;
const honest = await verify(base());
console.log(`${honest.ok ? "PASS" : "FAIL"}  wasm verifier accepts the committed proof (${honest.ms.toFixed(1)} ms, ${proof.length} bytes)`);
bad ||= !honest.ok;
if (!honest.ok) console.log(`      ${honest.error}`);

const cases = [
  ["price + 1", (p) => (p.price = bump(p.price, 1n))],
  ["price - 1", (p) => (p.price = bump(p.price, -1n))],
  ["budget + 1", (p) => (p.budget = bump(p.budget, 1n))],
  ["budget - 1", (p) => (p.budget = bump(p.budget, -1n))],
  ["another merchant", (p) => (p.choice = p.offers[1].merchant)],
  ["one base price + 1", (p) => (p.offers[0].base_price = bump(p.offers[0].base_price, 1n))],
  ["one discount line + 1 bps", (p) => (p.offers[3].rules[0].bps += 1)],
  ["cohort size - 1", (p) => (p.cohort_k -= 1)],
  ["one revealed bit dropped", (p) => p.revealed.pop()],
];
for (const [label, change] of cases) {
  const p = base();
  change(p);
  const r = await verify(p);
  console.log(`${r.ok ? "FAIL  ACCEPTED" : "PASS  refused"}  ${label}${r.ok ? "" : `: ${r.error.slice(0, 90)}`}`);
  bad ||= r.ok;
}
const flipped = Uint8Array.from(proof);
flipped[flipped.length >> 1] ^= 1;
const r = await verify(base(), flipped);
console.log(`${r.ok ? "FAIL  ACCEPTED" : "PASS  refused"}  one bit flipped in the proof${r.ok ? "" : `: ${r.error.slice(0, 90)}`}`);
bad ||= r.ok;
process.exit(bad ? 1 : 0);
