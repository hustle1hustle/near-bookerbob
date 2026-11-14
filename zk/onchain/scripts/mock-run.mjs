// Runs the contract's `measure` under node with a mocked NEAR host: checks it completes in wasm
// and gives wall time. Gas numbers come only from a real NEAR runtime.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
const [wasmPath, method = "measure", argJson = '{"upto":8}'] = process.argv.slice(2);
let mem; const regs = new Map(); const dec = new TextDecoder(); const enc = new TextEncoder();
const u8 = () => new Uint8Array(mem.buffer);
const t0 = performance.now();
const env = {
  input: (r) => regs.set(Number(r), enc.encode(argJson)),
  register_len: (r) => BigInt(regs.has(Number(r)) ? regs.get(Number(r)).length : 2n ** 64n - 1n),
  read_register: (r, p) => u8().set(regs.get(Number(r)), Number(p)),
  storage_read: () => 0n,
  sha256: (l, p, r) => regs.set(Number(r), new Uint8Array(createHash("sha256").update(u8().slice(Number(p), Number(p) + Number(l))).digest())),
  storage_write: () => 0n, storage_has_key: () => 0n, current_account_id: (r) => regs.set(Number(r), enc.encode("mock.testnet")),
  predecessor_account_id: (r) => regs.set(Number(r), enc.encode("mock.testnet")), attached_deposit: () => {}, prepaid_gas: () => 300n * 10n ** 12n,
  used_gas: () => BigInt(Math.round((performance.now() - t0) * 1e9)), // fake: 1 "Tgas" = 1 ms wall
  log_utf8: (l, p) => console.log("log:", dec.decode(u8().slice(Number(p), Number(p) + Number(l)))),
  value_return: (l, p) => console.log("return:", dec.decode(u8().slice(Number(p), Number(p) + Number(l)))),
  panic_utf8: (l, p) => { throw new Error("panic: " + dec.decode(u8().slice(Number(p), Number(p) + Number(l)))); },
};
const { instance } = await WebAssembly.instantiate(readFileSync(wasmPath), { env: new Proxy(env, { get: (o, k) => o[k] ?? ((...a) => { throw new Error("unmocked host fn " + String(k)); }) }) });
mem = instance.exports.memory;
instance.exports[method]();
console.log("wall ms", (performance.now() - t0).toFixed(1), "memory MB", mem.buffer.byteLength / 2 ** 20);
