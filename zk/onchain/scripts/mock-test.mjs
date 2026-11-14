#!/usr/bin/env node
// Runs the contract wasm under a mocked NEAR host (persistent storage, deposits, block height,
// transfers) and checks submit's refusals, expire, a full honest run and the refund.
// Gas is not metered here (used_gas is 0); gas numbers come from testnet only.
// Usage: node scripts/mock-test.mjs [target/jolt_onchain.wasm]   (after `audit` wrote forged/)
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
const dir = new URL("..", import.meta.url).pathname;
const wasm = new WebAssembly.Module(readFileSync(process.argv[2] || dir + "target/jolt_onchain.wasm"));
const STANDING = dir + "../out/standing-testnet-3/";
const NEAR = 10n ** 24n, BYTE = 10n ** 19n;
const host = { storage: new Map(), block: 1000n, transfers: [] };
const usage = () => [...host.storage].reduce((a, [k, v]) => a + BigInt(k.length / 2 + v.length + 40), 0n);

function call(method, args, { deposit = 0n, from = "alice.testnet" } = {}) {
  let mem; const regs = new Map(); const logs = []; let ret = null; const promises = [];
  const u8 = () => new Uint8Array(mem.buffer);
  const get = (l, p) => u8().slice(Number(p), Number(p) + Number(l));
  const hexk = (l, p) => Buffer.from(get(l, p)).toString("hex");
  const setReg = (r, b) => regs.set(Number(r), new Uint8Array(b));
  const input = typeof args === "string" ? Buffer.from(args) : Buffer.from(JSON.stringify(args));
  const env = {
    input: (r) => setReg(r, input),
    register_len: (r) => BigInt(regs.has(Number(r)) ? regs.get(Number(r)).length : 2n ** 64n - 1n),
    read_register: (r, p) => u8().set(regs.get(Number(r)), Number(p)),
    storage_read: (l, p, r) => { const v = host.storage.get(hexk(l, p)); if (!v) return 0n; setReg(r, v); return 1n; },
    storage_write: (kl, kp, vl, vp, r) => { const k = hexk(kl, kp); const old = host.storage.get(k); host.storage.set(k, get(vl, vp)); if (old) { setReg(r, old); return 1n; } return 0n; },
    storage_remove: (l, p, r) => { const k = hexk(l, p); const old = host.storage.get(k); if (!old) return 0n; host.storage.delete(k); setReg(r, old); return 1n; },
    storage_usage: () => usage(),
    predecessor_account_id: (r) => setReg(r, Buffer.from(from)),
    attached_deposit: (p) => { const b = Buffer.alloc(16); b.writeBigUInt64LE(deposit & (2n ** 64n - 1n)); b.writeBigUInt64LE(deposit >> 64n, 8); u8().set(b, Number(p)); },
    block_index: () => host.block,
    prepaid_gas: () => 1000n * 10n ** 12n,
    used_gas: () => 0n,
    sha256: (l, p, r) => setReg(r, createHash("sha256").update(get(l, p)).digest()),
    log_utf8: (l, p) => logs.push(Buffer.from(get(l, p)).toString()),
    value_return: (l, p) => { ret = Buffer.from(get(l, p)).toString(); },
    panic_utf8: (l, p) => { throw new Error("PANIC " + Buffer.from(get(l, p)).toString()); },
    promise_batch_create: (l, p) => { promises.push({ to: Buffer.from(get(l, p)).toString() }); return BigInt(promises.length - 1); },
    promise_batch_action_transfer: (i, p) => { const b = Buffer.from(get(16, p)); promises[Number(i)].amount = b.readBigUInt64LE(0) + (b.readBigUInt64LE(8) << 64n); },
  };
  const imports = { env: new Proxy(env, { get: (o, k) => o[k] ?? (() => { throw new Error("unmocked host fn " + String(k)); }) }) };
  const before = new Map(host.storage);
  try {
    const inst = new WebAssembly.Instance(wasm, imports);
    mem = inst.exports.memory;
    inst.exports[method]();
    for (const p of promises) host.transfers.push(p);
    return { ok: true, ret: ret && JSON.parse(ret), logs };
  } catch (e) {
    host.storage = before; // a failed receipt changes nothing
    return { ok: false, err: e.message, logs };
  }
}

let fails = 0;
const check = (c, m) => { console.log(`${c ? "PASS" : "FAIL"}  ${m}`); if (!c) fails++; };
const b64 = (f) => readFileSync(f).toString("base64");
const honest = { proof: b64(STANDING + "proof.bin"), io: b64(STANDING + "io_device.bin") };
const refused = (r, re) => !r.ok && re.test(r.err);

let r = call("submit", honest, { deposit: NEAR / 10n });
check(refused(r, /attach at least/), `submit with 0.1 NEAR: refused (${r.err?.slice(6, 70)})`);
for (const [f, re, what] of [
  ["trace0.bin", /trace_length/, "trace_length 0"],
  ["tracehuge.bin", /trace_length|proof:/, "trace_length usize::MAX"],
  ["nusigma.bin", /dory proof shape/, "nu > sigma"],
]) {
  r = call("submit", { proof: b64(dir + "forged/" + f), io: honest.io }, { deposit: 2n * NEAR });
  check(refused(r, re), `submit ${what}: refused (${r.err?.slice(6, 80)})`);
}
r = call("submit", { proof: honest.proof, io: b64(dir + "forged/io-panic.bin") }, { deposit: 2n * NEAR });
check(refused(r, /panicked/), `submit io with panic=true: refused`);
r = call("submit", { proof: honest.proof, io: b64(dir + "forged/io-outputs-5000.bin") }, { deposit: 2n * NEAR });
check(refused(r, /max_output_size/), `submit outputs of 5000 bytes: refused`);
r = call("submit", { proof: Buffer.alloc(140 * 1024, 1).toString("base64"), io: honest.io }, { deposit: 2n * NEAR });
check(refused(r, /128 KB/), `submit a 140 KB proof: refused`);
check(host.storage.size === 0, `nothing stored by refused submits`);

// expire
r = call("submit", honest, { deposit: 2n * NEAR });
check(r.ok && r.ret === 1, `honest submit: job ${r.ret}`);
const ev = JSON.parse(r.logs.find((l) => l.includes('"submitted"')).slice(11));
check(ev.data.statement && ev.data.outputs_b64, `submitted event carries statement and outputs`);
r = call("expire", { id: 1 });
check(refused(r, /not yet expired/), `expire before 1200 blocks: refused`);
host.block += 1200n;
r = call("expire", { id: 1 }, { from: "anyone.testnet" });
check(r.ok && r.ret.status === "refused: expired without a verdict", `expire by anyone after 1200 blocks: ${r.ret?.status}`);
const t1 = host.transfers.at(-1);
// the job record: key b"K" + u64 id (borsh), NEAR counts key + value + 40 bytes
const jobKey = "4b" + Buffer.from(new BigUint64Array([1n]).buffer).toString("hex");
const rec1 = BigInt(jobKey.length / 2 + host.storage.get(jobKey).length + 40);
check(t1 && t1.to === "alice.testnet" && t1.amount === 2n * NEAR - rec1 * BYTE, `refund ${Number(t1?.amount) / 1e24} NEAR = deposit minus the kept job record (${rec1} bytes)`);

// full honest run
r = call("submit", honest, { deposit: 2n * NEAR });
const id = r.ret;
let st;
for (let i = 0; i < 10; i++) { st = call("advance", { id }, { from: "bob.testnet" }).ret; if (st.status !== "running") break; }
check(st.status === "verified" && st.units_done === 56, `advance until done: ${st.status}, ${st.units_done} units`);
const done = call("status", { id }).ret;
const stdOut = JSON.parse(readFileSync(STANDING + "result.json")).output.flat();
check(done.outputs_sha256 === createHash("sha256").update(Buffer.from(stdOut)).digest("hex"), `outputs_sha256 is sha256 of the standing result`);
const keys = [...host.storage.keys()].filter((k) => k.startsWith("6a")); // b"j" proof/io/checkpoint keys
check(keys.length === 0, `proof, claim and checkpoint removed`);
const t2 = host.transfers.at(-1);
check(t2.to === "alice.testnet" && t2.amount < 2n * NEAR && t2.amount > 19n * NEAR / 10n, `refund to the submitter: ${Number(t2.amount) / 1e24} NEAR`);
r = call("expire", { id });
check(refused(r, /not running/), `expire on an ended job: refused`);
console.log(fails ? `FAIL  mock-test (${fails})` : "PASS  mock-test");
process.exit(fails ? 1 : 0);
