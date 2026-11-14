// The changed statements the standing page and zk/browser/check-standing.mjs try against the
// proof. Each must be refused by the Jolt verifier. Shared by the browser and Node.
// Event bytes (graph/src/lib.rs): tag 1 = Hire {agent, sub}, tag 2 = Seed {merchant, ratings u64,
// sum u64}; a string is a u32 little-endian length, then its bytes.
const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const unhex = (h) => Uint8Array.from(h.match(/../g).map((x) => parseInt(x, 16)));
const str = (s) => { const b = new TextEncoder().encode(s); const n = new Uint8Array(4); new DataView(n.buffer).setUint32(0, b.length, true); return [...n, ...b]; };
export const hire = (a, b) => hex([1, ...str(a), ...str(b)]);
const flip = (h, i) => h.slice(0, i * 2) + ((parseInt(h.slice(i * 2, i * 2 + 2), 16) ^ 1).toString(16).padStart(2, "0")) + h.slice(i * 2 + 2);

export const CASES = [
  ["a hire edge outside the proven log (m09 hires m01)", (s) => { s.events.push(hire("m09.bookerbob.testnet", "m01.bookerbob.testnet")); }],
  ["a sybil ring added (s1 to s3 hire each other)", (s) => { s.events.push(hire("s1.sybil.testnet", "s2.sybil.testnet"), hire("s2.sybil.testnet", "s3.sybil.testnet"), hire("s3.sybil.testnet", "s1.sybil.testnet")); }],
  ["a seed's weight changed (6 ratings claimed as 60)", (s) => {
    const i = s.events.findIndex((e) => e.startsWith("02"));
    const b = unhex(s.events[i]);
    new DataView(b.buffer).setBigUint64(b.length - 16, 60n, true);
    s.events[i] = hex(b);
  }],
  ["a hire edge dropped", (s) => { s.events.shift(); }],
  ["two events swapped (the chain's order)", (s) => { [s.events[0], s.events[1]] = [s.events[1], s.events[0]]; }],
  ["the claimed graph root, one byte", (s) => { s.root = flip(s.root, 0); }],
  ["the claimed standing hash, one byte", (s) => { s.scores_hash = flip(s.scores_hash, 31); }],
];
