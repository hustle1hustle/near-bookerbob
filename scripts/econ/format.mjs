// The economy anchor's bytes, exactly as docs/anchor-format.md states them. The poster, the
// contract (anchor-open/src/lib.rs, same constants) and both checks use this file.
import { createHash } from "node:crypto";

// The first chain (2026-11-14, source near:testnet:bookerbob) carried timestamps rounded by a
// JSON parse; it is superseded by this source (docs/anchor-format.md).
export const SOURCE = "near:testnet:bookerbob.testnet";
export const EPOCH_SECS = 3600;
export const RECORD_VERSION = 1;
export const ROOT_TAG = "bookerbob-econ/epoch/v1";
export const HEAD_TAG = "bookerbob-econ/head/v1";
export const GENESIS = "0".repeat(64);

// The contracts whose events make the economy. Discovery lists every tx that touched one of
// them; an event counts when one of `executors` logged it in a successful receipt.
export const WATCH = {
  discover: [
    "bookerbob.testnet", // bazaar: verdicts, settles, graph events (hire, seed), standing, referee and arbiter results
    "coalition.bookerbob-demo.testnet", // coalition v1: jobs A to C
    "coalition-v2.bookerbob-demo.testnet", // coalition v2: job D on
    "bookerbob-dusdc.testnet", // dUSDC: bonds, payouts, settlements (ft_transfer)
    "smith-reg.bookerbob-demo.testnet", // smith registry: registered programs
    "smith-registry.bookerbob-demo.testnet", // the superseded registry, its history
    "market.bookerbob.testnet", // the DAO-owned bazaar copy
    "bookerbob-dao-bazaar.testnet", // the timelocked test bazaar under a Sputnik DAO
    "gate.bookerbob.testnet", // the gate
  ],
  // outlayer.testnet's own `near-outlayer` events count only inside txs found above.
  executors: new Set([
    "bookerbob.testnet",
    "coalition.bookerbob-demo.testnet",
    "coalition-v2.bookerbob-demo.testnet",
    "bookerbob-dusdc.testnet",
    "smith-reg.bookerbob-demo.testnet",
    "smith-registry.bookerbob-demo.testnet",
    "market.bookerbob.testnet",
    "bookerbob-dao-bazaar.testnet",
    "gate.bookerbob.testnet",
    "outlayer.testnet",
  ]),
};

export const sha256 = (...parts) => {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
};

const u8 = (n) => Buffer.from([n]);
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; };
const lp8 = (s) => { const b = Buffer.from(s, "utf8"); if (b.length > 255) throw new Error("account too long"); return Buffer.concat([u8(b.length), b]); };
const lp32 = (s) => { const b = Buffer.from(s, "utf8"); return Buffer.concat([u32(b.length), b]); };

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function b58decode(s) {
  let n = 0n;
  for (const c of s) { const i = B58.indexOf(c); if (i < 0) throw new Error(`bad base58 ${s}`); n = n * 58n + BigInt(i); }
  const hex = n.toString(16).padStart(64, "0");
  if (hex.length !== 64) throw new Error(`receipt id is not 32 bytes: ${s}`);
  return Buffer.from(hex, "hex");
}
export function b58encode(buf) {
  let n = BigInt("0x" + Buffer.from(buf).toString("hex"));
  let s = "";
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of buf) { if (b !== 0) break; s = "1" + s; }
  return s;
}

// The events of one transaction (slim shape from source.mjs), each with its sort key.
export function eventsOfTx(t) {
  const out = [];
  for (const r of t.receipts) {
    if (!r.ok || !WATCH.executors.has(r.executor)) continue;
    r.logs.forEach((log, i) => {
      if (!log.startsWith("EVENT_JSON:")) return;
      const json = log.slice("EVENT_JSON:".length);
      let ev;
      try { ev = JSON.parse(json); } catch { return; }
      if (r.executor === "outlayer.testnet" && ev.standard !== "near-outlayer") return;
      out.push({ height: r.height, ts: BigInt(r.ts), receipt: r.id, index: i, executor: r.executor, json, tx: t.hash, signer: t.signer });
    });
  }
  return out;
}

// One record (big-endian, no padding):
// u8 version || u64 block height || u64 block timestamp (ns) || receipt id (32)
// || u16 log index || u8 len(executor) || executor || u32 len(json) || json (the log after "EVENT_JSON:", as logged)
export function encodeRecord(e) {
  return Buffer.concat([u8(RECORD_VERSION), u64(e.height), u64(e.ts), b58decode(e.receipt), u16(e.index), lp8(e.executor), lp32(e.json)]);
}

export function decodeRecord(b) {
  let o = 0;
  const v = b[o]; o += 1;
  if (v !== RECORD_VERSION) throw new Error(`record version ${v}`);
  const height = Number(b.readBigUInt64BE(o)); o += 8;
  const ts = b.readBigUInt64BE(o); o += 8;
  const receipt = b58encode(b.subarray(o, o + 32)); o += 32;
  const index = b.readUInt16BE(o); o += 2;
  const el = b[o]; o += 1;
  const executor = b.subarray(o, o + el).toString("utf8"); o += el;
  const jl = b.readUInt32BE(o); o += 4;
  const json = b.subarray(o, o + jl).toString("utf8"); o += jl;
  if (o !== b.length) throw new Error("trailing bytes in record");
  return { height, ts, receipt, index, executor, json };
}

// Total order: block height, then receipt id bytes, then log index.
export function order(a, b) {
  return a.height - b.height || Buffer.compare(b58decode(a.receipt), b58decode(b.receipt)) || a.index - b.index;
}

export const epochOf = (ts) => Number(BigInt(ts) / (BigInt(EPOCH_SECS) * 1_000_000_000n));

// All events, deduplicated and ordered, cut into epochs: [{epoch, events: [...]}], oldest first.
export function epochs(txs) {
  const seen = new Map();
  for (const t of Object.values(txs)) for (const e of eventsOfTx(t)) seen.set(`${e.receipt}/${e.index}`, e);
  const all = [...seen.values()].sort(order);
  const by = new Map();
  for (const e of all) {
    const k = epochOf(e.ts);
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(e);
  }
  return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([epoch, events]) => ({ epoch, events }));
}

// events = sha256(sha256(record_1) || ... || sha256(record_n))
// root   = sha256(ROOT_TAG || u32 len(source) || source || u64 epoch || u32 n || events)
export function epochRoot(source, epoch, records) {
  const events = sha256(...records.map((r) => sha256(r)));
  const root = sha256(Buffer.from(ROOT_TAG), lp32(source), u64(epoch), u32(records.length), events);
  return { events: events.toString("hex"), root: root.toString("hex") };
}

// head = sha256(HEAD_TAG || u32 len(poster) || poster || u32 len(source) || source || u64 seq || prev (32) || root (32))
export function head(poster, source, seq, prevHex, rootHex) {
  return sha256(Buffer.from(HEAD_TAG), lp32(poster), lp32(source), u64(seq), Buffer.from(prevHex, "hex"), Buffer.from(rootHex, "hex")).toString("hex");
}

// The chain of every closed epoch (one before `nowEpoch`), as a poster would post it.
export function chain(poster, source, eps, nowEpoch = Infinity) {
  let prev = GENESIS;
  return eps.filter((e) => e.epoch < nowEpoch).map((e, seq) => {
    const records = e.events.map(encodeRecord);
    const { events, root } = epochRoot(source, e.epoch, records);
    const h = head(poster, source, seq, prev, root);
    const out = { seq, epoch: e.epoch, n: records.length, events, root, prev, head: h, records };
    prev = h;
    return out;
  });
}
