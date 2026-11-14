#!/usr/bin/env node
// The standing page's wasm verifier, run in Node on the files the page serves
// (agents/standing/): the committed proof of the live testnet graph must verify, and each
// changed statement in agents/standing/cases.js must be refused with a verifier error (a trap
// does not count as a refusal). The statement must be the input the on-chain program proved
// (fixtures/zk/standing-live-input.json) and its root the root that proof outputs.
//   node zk/browser/check-standing.mjs
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Pinned: the verifier preprocessing (it carries the guest bytecode the proof is checked against)
// and the guest ELF it was made from. A swapped program fails here even if it outputs the same root.
// Rebuild: zk/browser/build.sh (STANDING=1), byte-identical on rebuild.
export const PINS = {
  "verifier.bin": "8cb059d83c0a5377a6b681677ee0cdf8cae51121685d8163fb224752aa211634",
  "guest.elf": "d1026788a7bb2f5d0db5520951dd6744832a94fdc77b7a7077af97d7631f9a45",
  // The wasm verifier, by the sha256 of its gunzipped bytes.
  "verifier.wasm.gz": "020fe1181ac3b1e7cda4bee507570166ae60db8d153cc29cdb78613883546e99",
};
const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const dir = join(root, "agents/standing");
const { CASES } = await import(join(dir, "cases.js"));
const never = (name) => () => { throw new Error(`verifier called ${name}`); };
// The same unused import stubs as zk/browser/check.mjs (left by a dependency, never called).
const imports = {
  __wbindgen_placeholder__: { __wbindgen_describe: never("describe") },
  __wbindgen_externref_xform__: { __wbindgen_externref_table_set_null: never("set_null"), __wbindgen_externref_table_grow: never("grow") },
};
const module = await WebAssembly.compile(gunzipSync(readFileSync(join(dir, "verifier.wasm.gz"))));
const pp = readFileSync(join(dir, "verifier.bin"));
const proof = readFileSync(join(dir, "proof.bin"));
const text = readFileSync(join(dir, "statement.json"), "utf8");
const hex = (a) => Buffer.from(a).toString("hex");

async function verify(statement, proofBytes = proof) {
  const x = (await WebAssembly.instantiate(module, imports)).exports;
  const put = (b) => { const p = x.bb_alloc(b.length); new Uint8Array(x.memory.buffer, p, b.length).set(b); return [p, b.length]; };
  const args = [...put(pp), ...put(proofBytes), ...put(Buffer.from(JSON.stringify(statement)))];
  const t = performance.now();
  try {
    const ok = x.bb_verify(...args) === 1;
    return { ok, trap: false, ms: performance.now() - t, error: ok ? null : Buffer.from(new Uint8Array(x.memory.buffer, x.bb_error_ptr(), x.bb_error_len())).toString() };
  } catch (e) {
    return { ok: false, trap: true, ms: performance.now() - t, error: `trap: ${e.message}` };
  }
}

let bad = false;
const say = (ok, t) => { console.log(`${ok ? "PASS" : "FAIL"}  ${t}`); bad ||= !ok; };
const { createHash } = await import("node:crypto");
for (const [f, want] of Object.entries(PINS)) {
  const bytes = readFileSync(join(dir, f));
  const got = createHash("sha256").update(f.endsWith(".gz") ? gunzipSync(bytes) : bytes).digest("hex");
  say(got === want, `pinned ${f}: sha256 ${got.slice(0, 12)}..${got === want ? "" : ` (pinned ${want.slice(0, 12)}..)`}`);
}
const st = JSON.parse(text);
const input = JSON.parse(readFileSync(join(root, "fixtures/zk/standing-live-input.json"), "utf8"));
const onchainOut = JSON.parse(readFileSync(join(root, "zk/out/standing-live/result.json"), "utf8")).output;
say(JSON.stringify(st.events) === JSON.stringify(input.events.map(hex)) && st.root === input.expected.root && st.scores_hash === input.expected.scores_hash, "the statement is the input the on-chain program's proof (zk/out/standing-live) covers");
say(st.root === hex(onchainOut[0]) && st.scores_hash === hex(onchainOut[1]), `its root ${st.root.slice(0, 12)}.. and standing hash are that proof's output`);
const honest = await verify(st);
say(honest.ok, `wasm verifier accepts the proof of the live graph (${honest.ms.toFixed(1)} ms, ${proof.length} bytes)${honest.ok ? "" : `: ${honest.error}`}`);
say(CASES.length === 7, `${CASES.length} changed statements to try (7 expected)`);
for (const [label, change] of CASES) {
  const s = JSON.parse(text);
  change(s);
  const r = await verify(s);
  say(!r.ok && !r.trap, `refused (case)  ${label}${r.ok ? ": ACCEPTED" : `: ${r.error.slice(0, 80)}`}`);
}
const flipped = Uint8Array.from(proof);
flipped[flipped.length >> 1] ^= 1;
const r = await verify(st, flipped);
say(!r.ok && !r.trap, `refused (proof bit)  one bit flipped in the proof${r.ok ? ": ACCEPTED" : r.trap ? ": a trap" : ""}`);
process.exit(bad ? 1 : 0);
