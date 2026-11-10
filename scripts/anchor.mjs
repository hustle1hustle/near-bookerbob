#!/usr/bin/env node
// History anchor (anchor/src/lib.rs, docs/anchor.md): a market runs on another chain, its
// history is kept on NEAR. The market here is our ETHGlobal Mumbai build on Arc testnet. Its
// public logs are cut into rounds, each round gets a root, and the roots are posted in order to
// `bookerbob-anchor.testnet`, which hash-chains them.
//
//   node scripts/anchor.mjs read              Arc logs over public RPC -> rounds, roots, state
//   node scripts/anchor.mjs post              post the rounds NEAR does not hold yet, in order
//   node scripts/anchor.mjs rebuild           NEAR anchors + Arc logs: every root and the whole
//                                             chain recomputed, one PASS line per round
//   node scripts/anchor.mjs rebuild --tamper  the same with one Arc log changed locally: must
//                                             FAIL at that log's round (--tamper=<round> picks it)
//   node scripts/anchor.mjs verify            no keys, no Arc: the committed record and snapshot
//                                             in fixtures/live/anchor/ against NEAR views
//   node scripts/anchor.mjs deploy            once: the wasm, `new`, and the post-only key
//   node scripts/anchor.mjs keys              the two public keys (seeds made on first use)
//
// `--snapshot` reads the committed Arc logs (fixtures/live/anchor/arc-logs.json) instead of the
// Arc RPC; `read --save` rewrites that file. Arc is read-only here: eth_getLogs, eth_call and
// eth_getTransactionByHash on the public RPC, no key. NEAR writes need one testnet key
// (KEYS_DIR/anchor/poster.seed), a function-call key that can only call `post`.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { keyFromSeed, nearPublicKey, rpcClient, send } from "../relayer/near.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = join(ROOT, "fixtures", "live", "anchor");

/** The foreign market: public facts only (addresses, chain id, the public RPC). */
export const ARC = {
  chainId: 5042002,
  rpc: "https://rpc.testnet.arc.network",
  explorer: "https://explorer.testnet.arc.io",
  firstBlock: 71036231,
  /** Seconds per round: `params().epochLength` of the market contract, re-read by `read`. */
  epochLength: 300,
  contracts: {
    market: "0xcfbbe8aa3c231f3345afa7798f65b03e2738d56f",
    seeds: "0xd3fe2ec6b78f6e3d9c974b48fbea66c28bd8183b",
    semaphore: "0x39646392d135dcde126b23bca5c8e020cc17f3e8",
  },
};
export const SOURCE = `eip155:${ARC.chainId}:${ARC.contracts.market}`;
export const GENESIS = "00".repeat(32);
const HEAD_TAG = "bookerbob-anchor/head/v1";
const ROUND_TAG = "bookerbob-anchor/round/v1";

// ---- hashes and bytes ----

const sha256 = (b) => createHash("sha256").update(b).digest();
const u8 = (n) => Buffer.from([n]);
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; };
const unhex = (h) => Buffer.from(h.replace(/^0x/, ""), "hex");

/** keccak-256 (Ethereum's, not NIST SHA3-256): event topics and function selectors. */
export function keccak256(input) {
  const M = (1n << 64n) - 1n;
  const rol = (v, n) => (n === 0 ? v : ((v << BigInt(n)) | (v >> BigInt(64 - n))) & M);
  const rate = 136;
  const msg = Buffer.concat([Buffer.from(input), Buffer.alloc(rate - (input.length % rate))]);
  msg[input.length] ^= 0x01;
  msg[msg.length - 1] ^= 0x80;
  const s = Array(25).fill(0n);
  for (let off = 0; off < msg.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) s[i] ^= msg.readBigUInt64LE(off + 8 * i);
    let lfsr = 1;
    for (let round = 0; round < 24; round++) {
      const c = [0, 1, 2, 3, 4].map((x) => s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20]);
      for (let x = 0; x < 5; x++) {
        const d = c[(x + 4) % 5] ^ rol(c[(x + 1) % 5], 1);
        for (let y = 0; y < 25; y += 5) s[x + y] ^= d;
      }
      let [x, y, cur] = [1, 0, s[1]];
      for (let t = 0; t < 24; t++) {
        [x, y] = [y, (2 * x + 3 * y) % 5];
        const next = s[x + 5 * y];
        s[x + 5 * y] = rol(cur, (((t + 1) * (t + 2)) / 2) % 64);
        cur = next;
      }
      for (let row = 0; row < 25; row += 5) {
        const r = s.slice(row, row + 5);
        for (let i = 0; i < 5; i++) s[row + i] = r[i] ^ (~r[(i + 1) % 5] & M & r[(i + 2) % 5]);
      }
      for (let j = 0; j < 7; j++) {
        lfsr = ((lfsr << 1) ^ ((lfsr >> 7) * 0x71)) % 256;
        if (lfsr & 2) s[0] ^= 1n << ((1n << BigInt(j)) - 1n);
      }
    }
  }
  const out = Buffer.alloc(32);
  for (let i = 0; i < 4; i++) out.writeBigUInt64LE(s[i], 8 * i);
  return out;
}

// ---- the market's events (public ABI) ----

const EVENTS = {
  market: [
    "Settled(uint256 indexed epoch,address indexed payer,address indexed payee,uint256 amount,bytes32 intentHash)",
    "SettledOffGraph(uint256 indexed epoch,address indexed payer,address indexed payee,uint256 amount,bytes32 intentHash)",
    "Carried(uint256 indexed epoch,uint256 indexed contextId,uint256 fromEpoch)",
    "Minted(uint256 indexed epoch,uint256 indexed contextId,uint256 indexed node,uint256 amount)",
    "ReceiptRegistered(address indexed payee,uint256 indexed epoch,uint256 groupId)",
    "Joined(address indexed payee,uint256 indexed contextId,uint256 indexed epoch)",
    "JoinClosed(address indexed payee,uint256 indexed contextId,uint256 indexed epoch,uint256 groupId,uint256 members)",
    "Reviewed(address indexed payee,uint256 indexed contextId,uint256 indexed epoch,uint256 score)",
    "RankSubmitted(uint256 indexed epoch,uint256 indexed contextId,bytes32 vectorHash)",
    "LongList(uint256 indexed epoch,uint256 indexed contextId,uint32[] at,uint256[] values)",
    "ViewDefined(bytes32 indexed viewId)",
    "AdminDropped()",
    "ReturningBuyer(address indexed payee,uint256 indexed epoch,uint256 orderRef)",
    "GroupUnlocked(address indexed payee,uint256 indexed contextId,uint256 indexed epoch)",
  ],
  seeds: [
    "IssuerSet(uint32 indexed issuerId,address signer)",
    "AdminDropped()",
    "ContextAdded(uint256 indexed contextId,uint32 indexed issuerId,uint64 budget,uint256 groupId)",
    "MemberAdded(uint256 indexed contextId,uint256 commitment)",
    "MemberReplaced(uint256 indexed contextId,uint256 oldCommitment,uint256 newCommitment)",
  ],
  semaphore: [
    "GroupCreated(uint256 indexed groupId)",
    "GroupAdminUpdated(uint256 indexed groupId,address indexed oldAdmin,address indexed newAdmin)",
    "MemberAdded(uint256 indexed groupId,uint256 index,uint256 identityCommitment,uint256 merkleTreeRoot)",
    "MembersAdded(uint256 indexed groupId,uint256 startIndex,uint256[] identityCommitments,uint256 merkleTreeRoot)",
    "MemberUpdated(uint256 indexed groupId,uint256 index,uint256 identityCommitment,uint256 newIdentityCommitment,uint256 merkleTreeRoot)",
    "MemberRemoved(uint256 indexed groupId,uint256 index,uint256 identityCommitment,uint256 merkleTreeRoot)",
  ],
};

const PROOF = "(uint256,uint256,uint256,uint256,uint256,uint256[8])";
/** Calls whose Semaphore nullifiers appear in no event. `at` = the word index of each proof. */
const CALLS = {
  Joined: { sig: `join(address,uint256,uint256,uint256,${PROOF},${PROOF},${PROOF})`, proofs: [4, 17, 30], words: 43 },
  Reviewed: { sig: `review(address,uint256,${PROOF})`, proofs: [2], words: 15 },
  ReturningBuyer: { sig: `proveReturn(address,uint256,${PROOF})`, proofs: [2], words: 15 },
};
for (const c of Object.values(CALLS)) c.selector = keccak256(Buffer.from(c.sig)).subarray(0, 4).toString("hex");

function parseEvent(text) {
  const [, name, inner] = text.match(/^(\w+)\((.*)\)$/);
  const params = inner ? inner.split(",").map((p) => { const w = p.trim().split(" "); return { type: w[0], indexed: w.includes("indexed"), name: w.at(-1) }; }) : [];
  return { name, params, topic: "0x" + keccak256(Buffer.from(`${name}(${params.map((p) => p.type).join(",")})`)).toString("hex") };
}
const TABLE = new Map();
for (const [src, list] of Object.entries(EVENTS)) for (const text of list) { const e = parseEvent(text); TABLE.set(`${src}:${e.topic}`, e); }
export const topicOf = (src, name) => [...TABLE.entries()].find(([k, e]) => k.startsWith(src + ":") && e.name === name)[1].topic;

const SRC_OF = Object.fromEntries(Object.entries(ARC.contracts).map(([k, v]) => [v, k]));
const word = (v) => "0x" + BigInt(v).toString(16).padStart(64, "0");
const value = (type, w) => (type === "address" ? "0x" + w.slice(24) : type === "bytes32" ? "0x" + w : BigInt("0x" + w).toString());

/** One log decoded: { src, name, args }, or name null for an event this file does not know. */
export function decodeLog(log) {
  const src = SRC_OF[log.address];
  const e = TABLE.get(`${src}:${log.topics[0]}`);
  if (!e) return { src, name: null, args: {} };
  const data = log.data.replace(/^0x/, "");
  const at = (i) => data.slice(64 * i, 64 * i + 64);
  const args = {};
  let topic = 1;
  let head = 0;
  for (const p of e.params) {
    if (p.indexed) { args[p.name] = value(p.type, log.topics[topic++].slice(2)); continue; }
    if (p.type.endsWith("[]")) {
      const start = Number(BigInt("0x" + at(head++))) / 32;
      const n = Number(BigInt("0x" + at(start)));
      args[p.name] = Array.from({ length: n }, (_, i) => value(p.type.slice(0, -2), at(start + 1 + i)));
    } else args[p.name] = value(p.type, at(head++));
  }
  return { src, name: e.name, args };
}

/**
 * The words a log needs from its transaction's calldata: for `Joined` the receipt proof's
 * message (the buyer's commitment) and the three nullifiers; for `Reviewed` and
 * `ReturningBuyer` the one nullifier. `nth` = which call of that kind in the transaction (a
 * wrapper may batch several). The call is found by its selector anywhere in the input.
 */
export function calldataWords(name, input, nth = 0) {
  const c = CALLS[name];
  if (!c) return [];
  const hex = input.replace(/^0x/, "");
  let seen = 0;
  for (let i = hex.indexOf(c.selector); i !== -1; i = hex.indexOf(c.selector, i + 2)) {
    if (i % 2 || hex.length - i - 8 < 64 * c.words) continue;
    if (seen++ < nth) continue;
    const w = (k) => "0x" + hex.slice(i + 8 + 64 * k, i + 8 + 64 * k + 64);
    const nullifiers = c.proofs.map((p) => w(p + 2));
    return name === "Joined" ? [w(c.proofs[0] + 3), ...nullifiers] : nullifiers;
  }
  throw new Error(`no ${c.sig.split("(")[0]} call number ${nth} in this transaction's input`);
}

// ---- rounds, roots, the chain (pure; mirrored in docs/anchor.md) ----

/**
 * The canonical bytes of one log:
 * u64 block | u64 timestamp | u32 logIndex | tx 32 | address 20 | u8 topics | topics 32 each |
 * u32 data length | data | u8 extra words | extra 32 each. Big-endian. `extra` = calldataWords.
 */
export function leaf(log) {
  const data = unhex(log.data);
  return Buffer.concat([u64(log.block), u64(log.ts), u32(log.index), unhex(log.tx), unhex(log.address), u8(log.topics.length), ...log.topics.map(unhex), u32(data.length), data, u8(log.extra.length), ...log.extra.map(unhex)]);
}

/** events = sha256 over the concatenated sha256 of each log's bytes, in (block, logIndex) order. */
export const eventsHash = (logs) => sha256(Buffer.concat(logs.map((l) => sha256(leaf(l))))).toString("hex");

/** Canonical JSON: object keys in code-unit order, no whitespace, every number a decimal string. */
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  if (typeof v === "number" || typeof v === "bigint") throw new Error("numbers are decimal strings in the state");
  return JSON.stringify(v);
}
export const stateHash = (state) => sha256(Buffer.from(canonical(state))).toString("hex");

/** root = sha256(tag | u32 len(source) | source | u64 round | u32 logs | events 32 | state 32). */
export function roundRoot(source, round, count, events, state) {
  return sha256(Buffer.concat([Buffer.from(ROUND_TAG), u32(Buffer.byteLength(source)), Buffer.from(source), u64(round), u32(count), unhex(events), unhex(state)])).toString("hex");
}

/** The contract's head: sha256(tag | u32 len(source) | source | u64 seq | prev 32 | root 32 | u32 len(meta) | meta). */
export function headHash(source, seq, prev, root, meta) {
  return sha256(Buffer.concat([Buffer.from(HEAD_TAG), u32(Buffer.byteLength(source)), Buffer.from(source), u64(seq), unhex(prev), unhex(root), u32(Buffer.byteLength(meta)), Buffer.from(meta)])).toString("hex");
}

export const emptyState = () => ({ admin_dropped: {}, carried: {}, contexts: {}, groups: {}, issuers: {}, joins: {}, lists: {}, minted: {}, nullifiers: [], paid: {}, receipts: {}, returning: {}, reviews: {}, views: [] });
const add = (a, b) => (BigInt(a) + BigInt(b)).toString();

/**
 * Applies one log to the market state (the rules are listed in docs/anchor.md). Returns the
 * problems it saw: a state that the market's own contracts could not have produced.
 */
export function apply(state, log) {
  const { src, name, args: a } = decodeLog(log);
  const bad = [];
  const group = (id) => (state.groups[id] ??= { members: [], root: "0" });
  if (src === "seeds") {
    if (name === "IssuerSet") state.issuers[a.issuerId] = a.signer;
    else if (name === "AdminDropped") state.admin_dropped.seeds = "1";
    else if (name === "ContextAdded") state.contexts[a.contextId] = { budget: a.budget, group: a.groupId, issuer: a.issuerId, members: [] };
    else if (name === "MemberAdded") (state.contexts[a.contextId] ?? (bad.push(`member of unknown context ${a.contextId}`), { members: [] })).members.push(word(a.commitment));
    else if (name === "MemberReplaced") {
      const m = state.contexts[a.contextId]?.members ?? [];
      const i = m.indexOf(word(a.oldCommitment));
      if (i < 0) bad.push(`replaced a commitment context ${a.contextId} does not hold`);
      else m[i] = word(a.newCommitment);
    }
  } else if (src === "semaphore") {
    if (name === "GroupCreated") group(a.groupId);
    else if (name === "MemberAdded" || name === "MembersAdded") {
      const g = group(a.groupId);
      const start = Number(name === "MemberAdded" ? a.index : a.startIndex);
      if (start !== g.members.length) bad.push(`group ${a.groupId}: member index ${start}, expected ${g.members.length}`);
      for (const c of name === "MemberAdded" ? [a.identityCommitment] : a.identityCommitments) g.members.push(word(c));
      g.root = word(a.merkleTreeRoot);
    } else if (name === "MemberUpdated" || name === "MemberRemoved") {
      const g = group(a.groupId);
      if (g.members[Number(a.index)] !== word(a.identityCommitment)) bad.push(`group ${a.groupId}: slot ${a.index} does not hold the old commitment`);
      g.members[Number(a.index)] = word(name === "MemberUpdated" ? a.newIdentityCommitment : 0);
      g.root = word(a.merkleTreeRoot);
    }
  } else if (src === "market") {
    const key = `${a.payee}|${a.contextId}|${a.epoch}`;
    const cell = `${a.epoch}|${a.contextId}`;
    const join = () => (state.joins[key] ??= { closed: null, joined: "0", unlocked: "0" });
    const spend = (words) => {
      for (const n of words) {
        if (state.nullifiers.includes(n)) bad.push(`nullifier ${n} spent twice`);
        else state.nullifiers.push(n);
      }
      state.nullifiers.sort();
    };
    if (name === "Settled" || name === "SettledOffGraph") {
      const p = (state.paid[a.epoch] ??= { off_graph: { amount: "0", count: "0" }, settled: { amount: "0", count: "0" } })[name === "Settled" ? "settled" : "off_graph"];
      p.count = add(p.count, 1);
      p.amount = add(p.amount, a.amount);
    } else if (name === "ReceiptRegistered") state.receipts[`${a.payee}|${a.epoch}`] = a.groupId;
    else if (name === "Joined") {
      join().joined = add(join().joined, 1);
      spend(log.extra.slice(1));
    } else if (name === "JoinClosed") {
      if (join().joined !== a.members) bad.push(`join ${key} closed with ${a.members} members after ${join().joined} joins`);
      join().closed = { group: a.groupId, members: a.members };
    } else if (name === "GroupUnlocked") join().unlocked = "1";
    else if (name === "Reviewed") {
      (state.reviews[key] ??= []).push(a.score);
      spend(log.extra);
    } else if (name === "ReturningBuyer") {
      (state.returning[`${a.payee}|${a.epoch}`] ??= []).push(a.orderRef);
      spend(log.extra);
    } else if (name === "Minted") {
      const m = (state.minted[cell] ??= { amount: "0", nodes: "0" });
      m.nodes = add(m.nodes, 1);
      m.amount = add(m.amount, a.amount);
    } else if (name === "Carried") state.carried[cell] = a.fromEpoch;
    else if (name === "RankSubmitted") (state.lists[cell] ??= { hash: null, long: null }).hash = a.vectorHash;
    else if (name === "LongList") (state.lists[cell] ??= { hash: null, long: null }).long = { at: a.at, values: a.values };
    else if (name === "ViewDefined") state.views.push(a.viewId);
    else if (name === "AdminDropped") state.admin_dropped.market = "1";
  }
  if (!name) bad.push(`unknown event ${log.topics[0]} from ${log.address} (hashed, not replayed)`);
  return bad;
}

export const roundOf = (log, epochLength = ARC.epochLength) => Math.floor(Number(log.ts) / epochLength);
export const metaOf = (r) => JSON.stringify({ v: 1, round: r.round, blocks: [r.from, r.to], logs: r.count, events: r.events, state: r.state });

/**
 * Logs in (block, logIndex) order -> one link per round that has logs:
 * { seq, round, from, to, count, events, state, root, meta, prev, head }, plus the final state.
 * `state` is the hash of the whole market state after the round, so it carries every earlier round.
 */
export function chainOf(logs, { source = SOURCE, epochLength = ARC.epochLength } = {}) {
  const sorted = [...logs].sort((a, b) => a.block - b.block || a.index - b.index);
  const state = emptyState();
  const links = [];
  const problems = [];
  let prev = GENESIS;
  for (let i = 0; i < sorted.length; ) {
    const round = roundOf(sorted[i], epochLength);
    let j = i;
    while (j < sorted.length && roundOf(sorted[j], epochLength) === round) j++;
    const part = sorted.slice(i, j);
    if (links.length && round <= links.at(-1).round) problems.push({ round, block: part[0].block, index: part[0].index, problem: `block ${part[0].block} is in an earlier round than the block before it` });
    for (const l of part) for (const p of apply(state, l)) problems.push({ round, block: l.block, index: l.index, problem: p });
    const r = { seq: links.length, round, from: part[0].block, to: part.at(-1).block, count: part.length, events: eventsHash(part), state: stateHash(state) };
    r.root = roundRoot(source, round, r.count, r.events, r.state);
    r.meta = metaOf(r);
    r.prev = prev;
    r.head = prev = headHash(source, r.seq, r.prev, r.root, r.meta);
    links.push(r);
    i = j;
  }
  return { links, state, problems };
}

/**
 * The rebuilt chain against what NEAR holds (`entries[seq]` = the contract's `get`). One line
 * per round. A round passes when NEAR's entry chains from NEAR's previous head by the documented
 * hash, names this round, and holds the root and head this side computed.
 */
export function compare(links, entries, source = SOURCE) {
  const lines = [];
  let firstFail = null;
  let nearPrev = GENESIS;
  const n = Math.min(links.length, entries.length);
  for (let i = 0; i < n; i++) {
    const [l, e] = [links[i], entries[i]];
    let m = {};
    try { m = JSON.parse(e.meta); } catch { /* an unreadable meta fails below */ }
    const why = [];
    if (e.prev !== nearPrev || e.head !== headHash(source, i, e.prev, e.root, e.meta)) why.push("NEAR's own chain does not recompute");
    if (m.round !== l.round) why.push(`NEAR holds round ${m.round} here`);
    else {
      if (m.events !== l.events) why.push("events differ");
      if (m.state !== l.state) why.push("state differs");
      if (e.root !== l.root) why.push("root differs");
    }
    if (e.head !== l.head) why.push(firstFail === null ? "head differs" : `head differs (the chain is broken since round ${firstFail})`);
    nearPrev = e.head;
    if (why.length && firstFail === null) firstFail = l.round;
    lines.push(`${why.length ? "FAIL" : "PASS"}  round ${l.round} seq ${i}: ${l.count} logs, blocks ${l.from}..${l.to}, root ${l.root.slice(0, 16)} head ${l.head.slice(0, 16)}${why.length ? "  <- " + why.join("; ") : ""}`);
  }
  if (entries.length > links.length) {
    firstFail ??= "beyond";
    lines.push(`FAIL  NEAR holds ${entries.length} rounds, the foreign chain has logs for ${links.length}`);
  }
  return { lines, firstFail, checked: n, pending: Math.max(0, links.length - entries.length) };
}

/** One log changed locally: the lowest bit of its data (or of its last topic) flipped. */
export function tamper(logs, round, epochLength = ARC.epochLength) {
  const i = logs.findIndex((l) => roundOf(l, epochLength) === round);
  if (i < 0) throw new Error(`no log in round ${round}`);
  const flip = (h) => h.slice(0, -1) + (parseInt(h.at(-1), 16) ^ 1).toString(16);
  const l = logs[i];
  const changed = l.data.length > 2 ? { ...l, data: flip(l.data) } : { ...l, topics: [...l.topics.slice(0, -1), flip(l.topics.at(-1))] };
  return { logs: logs.map((x, k) => (k === i ? changed : x)), was: l };
}

// ---- Arc, read-only ----

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function arcClient(url = process.env.ARC_RPC || ARC.rpc) {
  let id = 0;
  const post = async (body) => {
    for (let i = 0; ; i++) {
      let j = null;
      try { j = await (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json(); } catch { /* retried */ }
      const errs = j ? (Array.isArray(j) ? j : [j]).filter((x) => x.error) : [];
      if (j && !errs.length) return j;
      if (i >= 8 || (errs.length && !/rate limit|timeout|busy/i.test(JSON.stringify(errs[0].error)))) throw new Error(`Arc RPC: ${j ? JSON.stringify(errs[0].error) : "no answer"}`);
      await sleep(1500 * (i + 1));
    }
  };
  const call = async (method, params) => (await post({ jsonrpc: "2.0", id: ++id, method, params })).result;
  return {
    call,
    /** Several calls in one request, results in order. */
    async batch(calls) {
      const out = [];
      // Ten per request: the public RPC refuses a larger batch of eth_call outright.
      for (let i = 0; i < calls.length; i += 10) {
        const part = calls.slice(i, i + 10).map(([method, params], k) => ({ jsonrpc: "2.0", id: i + k, method, params }));
        const got = await post(part);
        out.push(...part.map((p) => got.find((g) => g.id === p.id).result));
        await sleep(400);
      }
      return out;
    },
  };
}

/**
 * Every public log of the market from its first block to `toBlock`, with the calldata words:
 * the market and seeds contracts' logs, and the Semaphore logs of the same transactions.
 */
export async function readArc(arc, { toBlock, onProgress } = {}) {
  if (Number(await arc.call("eth_chainId", [])) !== ARC.chainId) throw new Error("the RPC is not Arc testnet");
  const tip = await arc.call("eth_getBlockByNumber", ["latest", false]);
  const head = Number(tip.number);
  const to = Math.min(toBlock ?? head, head);
  const raw = [];
  for (let a = ARC.firstBlock; a <= to; a += 9000) {
    const b = Math.min(a + 8999, to);
    raw.push(...(await arc.call("eth_getLogs", [{ address: Object.values(ARC.contracts), fromBlock: "0x" + a.toString(16), toBlock: "0x" + b.toString(16) }])));
    onProgress?.(b);
    await sleep(200);
  }
  const ours = new Set(raw.filter((l) => l.address.toLowerCase() !== ARC.contracts.semaphore).map((l) => l.transactionHash));
  const logs = raw
    .filter((l) => !l.removed && ours.has(l.transactionHash))
    .map((l) => ({ block: Number(l.blockNumber), ts: Number(l.blockTimestamp), index: Number(l.logIndex), tx: l.transactionHash, address: l.address.toLowerCase(), topics: l.topics, data: l.data, extra: [] }))
    .sort((x, y) => x.block - y.block || x.index - y.index);
  if (logs.some((l) => !Number.isFinite(l.ts))) throw new Error("the RPC returned logs with no blockTimestamp");
  const need = logs.filter((l) => CALLS[decodeLog(l).name]);
  const txs = [...new Set(need.map((l) => l.tx))];
  const inputs = new Map((await arc.batch(txs.map((h) => ["eth_getTransactionByHash", [h]]))).map((t, i) => [txs[i], t.input]));
  const seen = new Map();
  for (const l of need) {
    const name = decodeLog(l).name;
    const k = `${l.tx}:${name}`;
    l.extra = calldataWords(name, inputs.get(l.tx), seen.get(k) ?? 0);
    seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  return { logs, head, headTs: Number(tip.timestamp), to };
}

/** Rounds that can no longer gain a log: every round before the one the chain is in now. */
export const closed = (links, headTs, epochLength = ARC.epochLength) => links.filter((l) => l.round < Math.floor(headTs / epochLength));

const snapshotPath = join(FIXTURES, "arc-logs.json");
const recordPath = join(FIXTURES, "run.json");
const chainPath = join(FIXTURES, "chain.json");
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const writeJson = (p, v) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(v, null, 1) + "\n"); };

/** The committed snapshot: the same logs, addresses as indexes into `contracts` to keep it small. */
export function packSnapshot({ logs, head, headTs, to }) {
  const addrs = Object.values(ARC.contracts);
  return { source: SOURCE, rpc: ARC.rpc, contracts: ARC.contracts, first_block: ARC.firstBlock, to_block: to, head_block: head, head_timestamp: headTs, fields: ["block", "timestamp", "logIndex", "tx", "contract", "topics", "data", "calldata words"], logs: logs.map((l) => [l.block, l.ts, l.index, l.tx, addrs.indexOf(l.address), l.topics, l.data, l.extra]) };
}
export function unpackSnapshot(s) {
  const addrs = Object.values(s.contracts);
  return { logs: s.logs.map(([block, ts, index, tx, a, topics, data, extra]) => ({ block, ts, index, tx, address: addrs[a], topics, data, extra })), head: s.head_block, headTs: s.head_timestamp, to: s.to_block };
}

// ---- NEAR ----

function nearConfig(env = process.env) {
  const rpc = env.NEAR_RPC || "https://test.rpc.fastnear.com";
  if (!/test/.test(rpc)) throw new Error(`RPC ${rpc} is not testnet: the anchor is testnet only`);
  const account = env.ANCHOR_ACCOUNT_ID || "bookerbob-anchor.testnet";
  if (!account.endsWith(".testnet")) throw new Error(`${account} is not a testnet account`);
  return { rpc, account, keysDir: join(env.KEYS_DIR || join(homedir(), ".rep-secrets", "bookerbob-testnet"), "anchor") };
}

async function nearEntries(client, account, source = SOURCE) {
  const len = await client.view(account, "len", { source });
  const entries = [];
  for (let seq = 0; seq < len; seq++) entries.push(await client.view(account, "get", { source, seq }));
  return entries;
}

const txLink = (h) => `https://testnet.nearblocks.io/txns/${h}`;
const summary = (state) => {
  const size = (o) => Object.keys(o).length;
  return { contexts: size(state.contexts), context_members: Object.values(state.contexts).reduce((n, c) => n + c.members.length, 0), groups: size(state.groups), group_members: Object.values(state.groups).reduce((n, g) => n + g.members.length, 0), nullifiers: state.nullifiers.length, receipts: size(state.receipts), joins: size(state.joins), joins_closed: Object.values(state.joins).filter((j) => j.closed).length, reviews: Object.values(state.reviews).reduce((n, r) => n + r.length, 0), lists: size(state.lists), returning_buyers: Object.values(state.returning).reduce((n, r) => n + r.length, 0), payments: Object.values(state.paid).reduce((n, p) => n + Number(p.settled.count) + Number(p.off_graph.count), 0) };
};

async function load(flags) {
  if (flags.snapshot) {
    console.log(`Arc logs from the committed snapshot ${snapshotPath.replace(ROOT + "/", "")} (no Arc RPC)`);
    return unpackSnapshot(readJson(snapshotPath));
  }
  process.stderr.write(`reading Arc testnet over ${process.env.ARC_RPC || ARC.rpc} from block ${ARC.firstBlock} `);
  const got = await readArc(arcClient(), { onProgress: () => process.stderr.write(".") });
  process.stderr.write("\n");
  return got;
}

/** The live Semaphore root of every group against the last root the logs gave it. */
async function checkGroupsOnArc(state) {
  const arc = arcClient();
  const ids = Object.keys(state.groups);
  const selector = keccak256(Buffer.from("getMerkleTreeRoot(uint256)")).subarray(0, 4).toString("hex");
  const roots = await arc.batch(ids.map((g) => ["eth_call", [{ to: ARC.contracts.semaphore, data: "0x" + selector + word(g).slice(2) }, "latest"]]));
  const off = ids.filter((g, i) => BigInt(roots[i]) !== BigInt(state.groups[g].root));
  return { groups: ids.length, off };
}

async function cmdRead(flags) {
  const got = await load(flags);
  const { links, state, problems } = chainOf(got.logs);
  if (!flags.snapshot) {
    const selector = keccak256(Buffer.from("params()")).subarray(0, 4).toString("hex");
    const params = await arcClient().call("eth_call", [{ to: ARC.contracts.market, data: "0x" + selector }, "latest"]);
    if (Number(BigInt(params.slice(0, 66))) !== ARC.epochLength) throw new Error("the market's epochLength is not the 300 s this file cuts rounds by");
  }
  console.log(`${SOURCE}: ${got.logs.length} logs in ${links.length} rounds, blocks ${ARC.firstBlock}..${got.to} (head ${got.head})`);
  for (const l of links) console.log(`round ${l.round} seq ${l.seq}: ${l.count} logs, blocks ${l.from}..${l.to}, root ${l.root}`);
  console.log("state after the last round:", JSON.stringify(summary(state)));
  console.log(`state hash ${links.at(-1)?.state ?? "(no rounds)"}, head ${links.at(-1)?.head ?? GENESIS}`);
  for (const p of problems) console.log(`PROBLEM  round ${p.round} block ${p.block} log ${p.index}: ${p.problem}`);
  console.log(`${problems.length ? "FAIL" : "PASS"}  replay: ${problems.length} problems (member indexes in order, no nullifier twice, joins closed with the members that joined, no unknown event)`);
  if (flags.save) {
    const { logs, ...top } = packSnapshot(got);
    // One log per line: the file stays reviewable in a diff.
    writeFileSync(snapshotPath, JSON.stringify(top, null, 1).replace(/\n}$/, `,\n "logs": [\n${logs.map((l) => JSON.stringify(l)).join(",\n")}\n ]\n}\n`));
    writeJson(join(FIXTURES, "state.json"), { source: SOURCE, after_round: links.at(-1).round, state_hash: links.at(-1).state, summary: summary(state), state });
    writeJson(chainPath, { source: SOURCE, note: "the roots this repo computes from arc-logs.json: what `post` sends, in order. Not a record of what NEAR holds (that is run.json)", len: links.length, head: links.at(-1).head, links });
    console.log(`wrote ${snapshotPath.replace(ROOT + "/", "")}, chain.json and state.json`);
  }
  if (problems.length) process.exit(1);
}

async function cmdPost(flags) {
  const c = nearConfig();
  const client = rpcClient(c.rpc);
  const got = await load(flags);
  const { links, problems } = chainOf(got.logs);
  if (problems.length) throw new Error(`the replay saw ${problems.length} problems: run \`read\` first`);
  const ready = closed(links, got.headTs);
  const entries = await nearEntries(client, c.account);
  const done = compare(ready, entries);
  if (done.firstFail !== null) throw new Error(`NEAR already disagrees with Arc at round ${done.firstFail}: run \`rebuild\``);
  const todo = ready.slice(entries.length);
  console.log(`${c.account}: ${entries.length} rounds anchored, ${todo.length} to post, ${links.length - ready.length} still open`);
  if (!todo.length) return;
  const key = keyFromSeed(readFileSync(process.env.ANCHOR_KEY_FILE || join(c.keysDir, "poster.seed"), "utf8"));
  const poster = await client.view(c.account, "poster");
  const record = existsSync(recordPath) ? readJson(recordPath) : { posts: [] };
  // The poster is the anchor account itself (a function-call key carries no deposit: the
  // account's balance pays the storage). Another poster attaches 0.01 NEAR, the rest comes back.
  const deposit = poster === c.account ? 0n : 10n ** 22n;
  // One round per transaction: a function-call key may sign exactly one function call.
  for (const l of todo) {
    const r = await send(client, { signer_id: poster, key, receiver_id: c.account, actions: [{ type: "FunctionCall", method_name: "post", args: { source: SOURCE, seq: l.seq, prev: l.prev, root: l.root, meta: l.meta }, gas: 20n * 10n ** 12n, deposit }] });
    if (!r.ok) throw new Error(`post of seq ${l.seq} failed: ${r.error}  ${txLink(r.hash)}`);
    if (r.value !== l.head) throw new Error(`seq ${l.seq}: the contract returned head ${r.value}, this side computed ${l.head}`);
    record.posts.push({ seq: l.seq, round: l.round, blocks: [l.from, l.to], logs: l.count, events: l.events, state: l.state, root: l.root, meta: l.meta, head: l.head, tx: r.hash });
    writeJson(recordPath, { ...record, network: "testnet", account: c.account, poster, source: SOURCE, len: record.posts.length, head: l.head });
    console.log(`posted seq ${l.seq} round ${l.round}  ${txLink(r.hash)}`);
  }
  const head = await client.view(c.account, "head", { source: SOURCE });
  if (head !== todo.at(-1).head) throw new Error("NEAR's head is not the head this side computed");
  console.log(`head ${head}; record in ${recordPath.replace(ROOT + "/", "")}`);
}

/** The anchors to rebuild against: the NEAR contract, or with `--anchors=<file>` a local chain file (a dry run, not NEAR). */
async function anchors(flags) {
  if (flags.anchors) {
    const file = flags.anchors === true ? chainPath : flags.anchors;
    console.log(`anchors from the local file ${file.replace(ROOT + "/", "")}: a dry run, NOT read from NEAR`);
    return { where: "the local file", poster: "(none: local file)", entries: readJson(file).links.map((l) => ({ prev: l.prev, root: l.root, meta: l.meta, head: l.head })) };
  }
  const c = nearConfig();
  const client = rpcClient(c.rpc);
  if (!(await client.account(c.account))) throw new Error(`${c.account} does not exist on testnet yet (docs/anchor.md, "Live record"); \`--anchors\` runs the same check against fixtures/live/anchor/chain.json`);
  return { where: c.account, poster: await client.view(c.account, "poster"), entries: await nearEntries(client, c.account) };
}

async function cmdRebuild(flags) {
  const got = await load(flags);
  const { where, poster, entries } = await anchors(flags);
  if (!entries.length) throw new Error(`${where} holds no rounds for ${SOURCE}`);
  let logs = got.logs;
  let target = null;
  if (flags.tamper) {
    const honest = chainOf(logs).links;
    target = flags.tamper === true ? honest[Math.min(entries.length, honest.length) >> 1].round : Number(flags.tamper);
    const t = tamper(logs, target);
    logs = t.logs;
    console.log(`tamper: one bit of one log changed locally (round ${target}, block ${t.was.block}, log ${t.was.index}, tx ${t.was.tx}); NEAR and Arc are untouched`);
  }
  const { links, state, problems } = chainOf(logs);
  const res = compare(closed(links, got.headTs), entries);
  for (const line of res.lines) console.log(line);
  console.log(`poster ${poster}, ${entries.length} rounds on ${where}, ${res.pending} closed Arc rounds not anchored yet`);
  if (flags.tamper) {
    const caught = res.firstFail === target;
    console.log(`FAIL  rebuild: first failing round ${res.firstFail ?? "none"}`);
    console.log(`${caught ? "PASS" : "FAIL"}  tamper check: the changed log is in round ${target}, the rebuild ${caught ? "fails first at that round" : "did not fail there"}`);
    process.exit(caught ? 0 : 1);
  }
  let ok = res.firstFail === null && !problems.length;
  for (const p of problems) console.log(`PROBLEM  round ${p.round}: ${p.problem}`);
  if (!flags.snapshot && ok && !res.pending) {
    const g = await checkGroupsOnArc(state);
    console.log(`${g.off.length ? "FAIL" : "PASS"}  Arc now: ${g.groups} Semaphore group roots read from the chain equal the roots rebuilt from the logs${g.off.length ? ` (off: ${g.off.join(", ")})` : ""}`);
    ok &&= !g.off.length;
  }
  const s = summary(state);
  console.log(`rebuilt state: ${s.groups} groups with ${s.group_members} members, ${s.contexts} contexts with ${s.context_members} members, ${s.nullifiers} nullifiers, ${s.lists} lists, ${s.payments} payments`);
  console.log(`${ok ? "PASS" : "FAIL"}  rebuild: ${res.checked} rounds, ${logs.length} Arc logs, head ${entries.at(-1).head}${ok ? "" : `; first failing round ${res.firstFail}`}`);
  process.exit(ok ? 0 : 1);
}

/** The committed record alone: its chain recomputed, and the snapshot's roots against it. */
export function checkRecord(record, snapshot) {
  const out = [];
  let prev = GENESIS;
  const chained = record.posts.every((p, i) => { const ok = p.seq === i && headHash(record.source, i, prev, p.root, p.meta) === p.head; prev = p.head; return ok; });
  out.push([chained && prev === record.head && record.len === record.posts.length, `the record's ${record.posts.length} heads recompute from its roots and metas`]);
  if (snapshot) {
    const got = unpackSnapshot(snapshot);
    const { links, problems } = chainOf(got.logs, { source: record.source });
    const same = links.length >= record.posts.length && record.posts.every((p, i) => links[i].root === p.root && links[i].meta === p.meta && links[i].head === p.head);
    out.push([same && !problems.length, `the snapshot's ${got.logs.length} Arc logs rebuild the same ${record.posts.length} roots`]);
  }
  return out;
}

async function cmdVerify() {
  if (!existsSync(recordPath)) throw new Error("no live record yet: fixtures/live/anchor/run.json is written by `deploy` and `post` (docs/anchor.md, \"Live record\")");
  const record = readJson(recordPath);
  const checks = checkRecord(record, existsSync(snapshotPath) ? readJson(snapshotPath) : null);
  const c = nearConfig({ ...process.env, ANCHOR_ACCOUNT_ID: record.account });
  const client = rpcClient(c.rpc);
  const [poster, len, head] = await Promise.all([client.view(record.account, "poster"), client.view(record.account, "len", { source: record.source }), client.view(record.account, "head", { source: record.source })]);
  checks.push([poster === record.poster, `poster is ${record.poster}`]);
  checks.push([len >= record.len, `NEAR holds ${len} rounds, the record ${record.len}`]);
  let same = 0;
  for (const p of record.posts) {
    const e = await client.view(record.account, "get", { source: record.source, seq: p.seq });
    if (e && e.root === p.root && e.head === p.head && e.meta === p.meta && e.prev === (p.seq ? record.posts[p.seq - 1].head : GENESIS)) same++;
  }
  checks.push([same === record.posts.length, `${same} of ${record.posts.length} entries on ${record.account} equal the record (prev, root, meta, head)`]);
  checks.push([len > record.len || head === record.head, len > record.len ? `the head has moved on (${len - record.len} newer rounds)` : `head is ${record.head}`]);
  for (const [ok, text] of checks) console.log(`${ok ? "PASS" : "FAIL"}  ${text}`);
  const ok = checks.every(([k]) => k);
  console.log(`${ok ? "PASS" : "FAIL"}  anchor verify: ${record.source} on ${record.account}`);
  process.exit(ok ? 0 : 1);
}

/** Once, with the account's full-access key: the code, `new(poster = the account)`, and a key that can only call `post`. */
async function cmdDeploy() {
  const c = nearConfig();
  const client = rpcClient(c.rpc);
  const owner = keyFromSeed(readFileSync(join(c.keysDir, "account.seed"), "utf8"));
  const poster = keyFromSeed(readFileSync(join(c.keysDir, "poster.seed"), "utf8"));
  const code = readFileSync(join(ROOT, "target", "near", "bookerbob_anchor.wasm"));
  const r = await send(client, { signer_id: c.account, key: owner, receiver_id: c.account, actions: [
    { type: "DeployContract", code },
    { type: "FunctionCall", method_name: "new", args: { poster: c.account }, gas: 30n * 10n ** 12n, deposit: 0n },
    { type: "AddKey", public_key_hex: poster.pub, permission: { allowance: null, receiver_id: c.account, method_names: ["post"] } },
  ] });
  if (!r.ok) throw new Error(`deploy failed: ${r.error}  ${txLink(r.hash)}`);
  const record = existsSync(recordPath) ? readJson(recordPath) : { posts: [] };
  writeJson(recordPath, { network: "testnet", account: c.account, poster: c.account, source: SOURCE, ...record, code_sha256: sha256(code).toString("hex"), deploy_tx: r.hash, poster_key: nearPublicKey(poster.pub), poster_key_permission: "function call: post on this account only" });
  console.log(`deployed ${c.account} (code sha256 ${sha256(code).toString("hex")}), poster key ${nearPublicKey(poster.pub)} (post only)  ${txLink(r.hash)}`);
}

/** The two public keys, made on first use (32-byte seeds, mode 600, outside the repo). Prints no secret. */
function cmdKeys() {
  const c = nearConfig();
  mkdirSync(c.keysDir, { recursive: true, mode: 0o700 });
  for (const [name, role] of [["account", "full access: creates the account, deploys the code"], ["poster", "function call: `post` only"]]) {
    const p = join(c.keysDir, `${name}.seed`);
    if (!existsSync(p)) writeFileSync(p, randomBytes(32).toString("hex") + "\n", { mode: 0o600 });
    console.log(`${name}: ${nearPublicKey(keyFromSeed(readFileSync(p, "utf8")).pub)}  (${role})`);
  }
  return Promise.resolve();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = Object.fromEntries(rest.filter((a) => a.startsWith("--")).map((a) => { const [k, v] = a.slice(2).split("="); return [k, v ?? true]; }));
  const run = { read: cmdRead, post: cmdPost, rebuild: cmdRebuild, verify: cmdVerify, deploy: cmdDeploy, keys: cmdKeys }[cmd];
  if (!run) {
    console.error("usage: node scripts/anchor.mjs read [--save] | post | rebuild [--tamper[=round]] [--anchors] | verify | deploy | keys   (--snapshot: no Arc RPC)");
    process.exit(2);
  }
  run(flags).catch((e) => { console.error(`FAIL  ${e.message}`); process.exit(1); });
}
