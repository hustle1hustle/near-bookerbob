#!/usr/bin/env node
// The economy anchor: the public events of the BookerBob testnet economy, one chained root per
// hour, kept on NEAR by an open anchor contract (anchor-open/, docs/anchor-format.md).
//
//   node scripts/econ/anchor.mjs chain                 epochs and roots from fixtures/live/econ/txs.json
//   node scripts/econ/anchor.mjs post                  posts every closed epoch not on chain yet (testnet)
//   node scripts/econ/anchor.mjs check [--snapshot] [--rpc[=N]] [--tamper]
//        recomputes every root from the source contracts' txs and compares it with the anchor
//   node scripts/econ/anchor.mjs rebuild [--snapshot]
//        agent outcomes and the standing input from the anchor's own posts, then the standing
//        root, matched against the bazaar's on-chain standing_root
//   node scripts/econ/anchor.mjs deploy | keys         once, testnet
//   node scripts/econ/anchor.mjs mainnet-plan          the exact mainnet cost, sends nothing
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { keyFromSeed, nearPublicKey, rpcClient, send } from "../../relayer/near.mjs";
import { SOURCE, EPOCH_SECS, GENESIS, WATCH, epochs, chain, decodeRecord, epochRoot, head, sha256, encodeRecord } from "./format.mjs";
import { accountTxs, fetchTxs, rpcTx, view, INDEXER, RPC } from "./source.mjs";

export const ACCOUNT = process.env.ECON_ANCHOR || "bookerbob-outcomes.testnet";
export const POSTER = process.env.ECON_POSTER || ACCOUNT;
const BAZAAR = "bookerbob.testnet";
// Where the anchor lives: testnet by default; the mainnet copy with ECON_ANCHOR_RPC and ECON_ANCHOR_INDEXER.
const ANCHOR_RPC = process.env.ECON_ANCHOR_RPC || RPC;
const ANCHOR_INDEXER = process.env.ECON_ANCHOR_INDEXER || INDEXER;
const KEYS = process.env.ECON_KEYS_DIR || join(homedir(), ".rep-secrets/bookerbob-testnet/econ", ACCOUNT);
const DIR = "fixtures/live/econ";
const TXS = join(DIR, "txs.json");
const CHAIN = join(DIR, "chain.json");
const EPOCHS = join(DIR, "epochs.json");
const RUN = join(DIR, "run.json");
const POSTS = join(DIR, "posts.json");
// Outputs of check and rebuild: per anchor (the mainnet copy writes to fixtures/mainnet/econ/).
const OUT = process.env.ECON_OUT || DIR;
const OUTCOMES = join(OUT, "outcomes.json");
const VIEWS = join(OUT, "views.json");
const link = (h) => `https://testnet.nearblocks.io/txns/${h}`;
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const writeJson = (p, o) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(o, null, 1) + "\n"); };
const short = (h) => `${h.slice(0, 8)}..`;
let failed = 0;
const pass = (ok, line) => { console.log(`${ok ? "PASS" : "FAIL"}  ${line}`); if (!ok) failed++; return ok; };

// The closed epochs: every one before the hour that ended at least 5 minutes ago.
const closedBefore = () => Math.floor((Date.now() - 5 * 60_000) / 1000 / EPOCH_SECS);

// ---- borsh of `post` (anchor-open/src/lib.rs `Post`), little-endian as borsh is ----
export function encodePost(p) {
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
  const src = Buffer.from(p.source, "utf8");
  return Buffer.concat([u32(src.length), src, u64(p.seq), Buffer.from(p.prev, "hex"), u64(p.epoch), u32(p.records.length), ...p.records.flatMap((r) => [u32(r.length), r])]);
}
export function decodePost(b) {
  let o = 0;
  const u32 = () => { const v = b.readUInt32LE(o); o += 4; return v; };
  const u64 = () => { const v = Number(b.readBigUInt64LE(o)); o += 8; return v; };
  const sl = u32();
  const source = b.subarray(o, o + sl).toString("utf8"); o += sl;
  const seq = u64();
  const prev = b.subarray(o, o + 32).toString("hex"); o += 32;
  const epoch = u64();
  const n = u32();
  const records = [];
  for (let i = 0; i < n; i++) { const l = u32(); records.push(Buffer.from(b.subarray(o, o + l))); o += l; }
  if (o !== b.length) throw new Error("trailing bytes in post args");
  return { source, seq, prev, epoch, records };
}

// ---- chain ----
function loadEpochs() {
  return epochs(readJson(TXS).txs);
}
function cmdChain() {
  const eps = loadEpochs();
  const links = chain(POSTER, SOURCE, eps, closedBefore());
  writeJson(CHAIN, { note: "The economy anchor's chain as computed from fixtures/live/econ/txs.json (docs/anchor-format.md).", source: SOURCE, poster: POSTER, epoch_secs: EPOCH_SECS, links: links.map(({ records, ...l }) => l) });
  writeJson(EPOCHS, links.map((l) => ({ epoch: l.epoch, root: l.root, head: l.head, records: l.records.map((r) => r.toString("base64")) })));
  const n = links.reduce((a, l) => a + l.n, 0);
  console.log(`   ${links.length} closed epochs, ${n} events, ${links.reduce((a, l) => a + l.records.reduce((x, r) => x + r.length, 0), 0)} record bytes; head ${short(links.at(-1).head)}  -> ${CHAIN}`);
  return Promise.resolve();
}

// ---- keys, deploy, post ----
function seed(name) {
  mkdirSync(KEYS, { recursive: true, mode: 0o700 });
  const p = join(KEYS, `${name}.seed`);
  if (!existsSync(p)) writeFileSync(p, randomBytes(32).toString("hex") + "\n", { mode: 0o600 });
  return keyFromSeed(readFileSync(p, "utf8"));
}
function cmdKeys() {
  console.log(`account: ${nearPublicKey(seed("account").pub)}  (full access: creates the account, deploys the code)`);
  console.log(`poster: ${nearPublicKey(seed("poster").pub)}  (function call: post only)`);
  return Promise.resolve();
}
async function cmdDeploy() {
  const client = rpcClient(RPC);
  const owner = seed("account");
  const poster = seed("poster");
  const wasm = process.env.ECON_WASM || "target/near/bookerbob_anchor_open.wasm";
  const code = readFileSync(wasm);
  const r = await send(client, { signer_id: ACCOUNT, key: owner, receiver_id: ACCOUNT, actions: [
    { type: "DeployContract", code },
    { type: "FunctionCall", method_name: "new", args: {}, gas: 30n * 10n ** 12n, deposit: 0n },
    { type: "AddKey", public_key_hex: poster.pub, permission: { allowance: null, receiver_id: ACCOUNT, method_names: ["post"] } },
  ] });
  if (!r.ok) throw new Error(`deploy: ${r.error}`);
  const code_sha256 = sha256(code).toString("hex");
  const run = existsSync(RUN) ? readJson(RUN) : {};
  writeJson(RUN, { ...run, network: "testnet", account: ACCOUNT, poster: POSTER, source: SOURCE, code_sha256, wasm_bytes: code.length, deploy_tx: r.hash, poster_key: nearPublicKey(poster.pub), poster_key_permission: "function call: post on this account only", posts: run.posts || [] });
  console.log(`deployed ${ACCOUNT} (code sha256 ${code_sha256}, ${code.length} bytes), poster key post-only  ${link(r.hash)}`);
}

async function cmdPost() {
  const client = rpcClient(RPC);
  const key = seed("poster");
  const eps = loadEpochs();
  const links = chain(POSTER, SOURCE, eps, closedBefore());
  const len = await view(ACCOUNT, "len", { poster: POSTER, source: SOURCE });
  const run = existsSync(RUN) ? readJson(RUN) : { posts: [] };
  const posts = existsSync(POSTS) ? readJson(POSTS) : {};
  for (const l of links.slice(len)) {
    const args = encodePost({ source: SOURCE, seq: l.seq, prev: l.prev, epoch: l.epoch, records: l.records });
    const gas = BigInt(Math.min(300, 20 + Math.ceil(args.length / 4000))) * 10n ** 12n;
    const r = await send(client, { signer_id: POSTER, key, receiver_id: ACCOUNT, actions: [{ type: "FunctionCall", method_name: "post", args, gas, deposit: 0n }] });
    if (!r.ok || r.value !== l.head) throw new Error(`post seq ${l.seq}: ${r.error || `head ${r.value} != ${l.head}`}`);
    run.posts.push({ seq: l.seq, epoch: l.epoch, n: l.n, bytes: args.length, root: l.root, head: l.head, tx: r.hash });
    posts[r.hash] = { signer: POSTER, args: args.toString("base64") };
    writeJson(RUN, { ...run, len: l.seq + 1, head: l.head });
    writeJson(POSTS, posts);
    console.log(`   seq ${l.seq} epoch ${l.epoch} (${new Date(l.epoch * EPOCH_SECS * 1000).toISOString().slice(0, 13)}h) ${l.n} events ${args.length} B  ${link(r.hash)}`);
  }
  console.log(`   ${ACCOUNT}: ${links.length} epochs on chain, head ${short(links.at(-1).head)}`);
}

// ---- the anchor's entries, live or from the snapshot ----
async function anchorEntries(flags) {
  if (flags.snapshot) return readJson(VIEWS).entries;
  const len = await view(ACCOUNT, "len", { poster: POSTER, source: SOURCE }, ANCHOR_RPC);
  const out = [];
  for (let s = 0; s < len; s++) out.push(await view(ACCOUNT, "get", { poster: POSTER, source: SOURCE, seq: s }, ANCHOR_RPC));
  return out;
}

// ---- check: the anchor against the source contracts ----
async function cmdCheck(flags) {
  let txs;
  if (flags.snapshot) txs = readJson(TXS).txs;
  else {
    console.log(`   reading every tx of ${WATCH.discover.length} contracts from ${INDEXER}`);
    const hashes = new Set();
    for (const a of WATCH.discover) for (const t of await accountTxs(a)) hashes.add(t.transaction_hash);
    txs = await fetchTxs([...hashes], ".econ-cache/txs.json");
  }
  if (flags.rpc) {
    // The trust path: the same txs from NEAR's public archival RPC, not the indexer.
    const all = Object.values(txs).filter((t) => t.receipts.some((r) => r.logs.some((l) => l.startsWith("EVENT_JSON:"))));
    const n = flags.rpc === true ? all.length : Number(flags.rpc);
    const pick = all.sort((a, b) => (a.hash < b.hash ? -1 : 1)).slice(0, n);
    let same = 0;
    for (const t of pick) {
      const r = await rpcTx(t.hash, t.signer);
      const a = JSON.stringify(t.receipts.map((x) => [x.id, x.executor, x.height, x.ts, x.ok, x.logs]).sort());
      const b = JSON.stringify(r.receipts.map((x) => [x.id, x.executor, x.height, x.ts, x.ok, x.logs]).sort());
      if (a === b) same++;
      else console.log(`   rpc differs: ${t.hash}`);
      txs[t.hash] = r;
      await new Promise((s) => setTimeout(s, Number(process.env.TX_GAP_MS ?? 1500)));
    }
    pass(same === pick.length, `archival RPC: ${same} of ${pick.length} txs byte-equal to the indexer's (receipts, logs, blocks)`);
  }
  const eps = epochs(txs);
  if (flags.tamper) {
    const e = eps[Math.floor(eps.length / 2)];
    const ev = e.events[0];
    ev.json = ev.json.replace(/"event":"/, '"event":"x');
    console.log(`   tamper: one event of epoch ${e.epoch} changed locally (nothing on chain changes)`);
  }
  const entries = await anchorEntries(flags);
  const links = chain(POSTER, SOURCE, eps);
  let firstBad = null;
  entries.forEach((en, i) => {
    const l = links[i];
    const ok = l && l.epoch === en.epoch && l.n === en.n && l.events === en.events && l.root === en.root && l.prev === en.prev && l.head === en.head;
    if (!ok && firstBad === null) firstBad = i;
  });
  pass(firstBad === null, firstBad === null
    ? `anchor: ${entries.length} epochs on ${ACCOUNT}, every root, events hash, count and head equal the ones recomputed from the watched contracts' txs as discovered (${entries.reduce((a, e) => a + e.n, 0)} events), head ${short(entries.at(-1).head)}`
    : `anchor: first epoch that differs is seq ${firstBad} (epoch ${entries[firstBad].epoch}); every later head differs too`);
  const pending = links.length - entries.length;
  if (pending > 0) console.log(`   ${pending} epochs not anchored yet (the open hour, or not posted)`);
  // Completeness, partly, from the contracts' own counters read at the last anchored block (the
  // archival RPC's state right after it): an event of these streams left out of the anchor shows here.
  const anchored = links.slice(0, entries.length).flatMap((l) => l.records.map(decodeRecord));
  const H = Math.max(...anchored.map((r) => r.height));
  const counters = flags.snapshot ? readJson(VIEWS).counters : await countersAt(H, anchored);
  const graph = anchored.filter((r) => r.executor === BAZAAR).map((r) => JSON.parse(r.json)).filter((j) => j.event === "graph_event").map((j) => j.data[0]);
  const contiguous = graph.every((g, i) => g.index === i + 1);
  const [gRoot, gCount] = counters.graph_root;
  pass(contiguous && graph.length === gCount && (gCount === 0 || graph.at(-1).root === gRoot),
    `completeness: the bazaar's graph events 1..${graph.length} are in the anchor with no gap, and its graph_root at block ${H} (the last anchored event) is ${short(gRoot)} over ${gCount} events, the last anchored running root`);
  for (const c of COALITIONS) {
    const ids = [...new Set(anchored.filter((r) => r.executor === c).map((r) => JSON.parse(r.json)).filter((j) => j.event === "job_opened").map((j) => j.data[0].job))];
    const k = counters.jobs[c];
    pass(ids.every((id, i) => id === i) && ids.length === k,
      `completeness: ${c.split(".")[0]} opened ${k} job${k === 1 ? "" : "s"} by block ${H} (job(${k}) is null there), and the anchor holds job_opened for ${ids.length ? `0..${ids.length - 1}` : "none"}`);
  }
  if (!flags.snapshot) { const v = existsSync(VIEWS) ? readJson(VIEWS) : {}; writeJson(VIEWS, { ...v, counters: { ...counters, height: H } }); }
  if (failed) { console.log("FAIL  make anchor-check"); process.exit(1); }
  console.log("PASS  make anchor-check");
}

const COALITIONS = ["coalition.bookerbob-demo.testnet", "coalition-v2.bookerbob-demo.testnet"];
async function countersAt(H) {
  const graph_root = await view(BAZAAR, "graph_root", {}, RPC, H);
  const jobs = {};
  for (const c of COALITIONS) {
    let n = 0;
    try { while ((await view(c, "job", { job: n }, RPC, H)) != null) n++; } catch (e) { if (n) throw e; /* not deployed yet at H */ }
    jobs[c] = n;
  }
  return { graph_root, jobs };
}

// ---- rebuild: from the anchor's own posts ----
async function postedEpochs(flags) {
  // The posting txs: from the snapshot, from NEAR's public archival RPC (--rpc, hashes from
  // fixtures/live/econ/run.json), or found on the anchor account through the indexer.
  let bodies = [];
  if (flags.snapshot) {
    return decodeAll(Object.entries(readJson(POSTS)).map(([tx, p]) => ({ tx, args: [p.args] })));
  } else if (flags.rpc) {
    for (const h of readJson(RUN).posts.map((p) => p.tx)) {
      const j = await rpcCall("EXPERIMENTAL_tx_status", { tx_hash: h, sender_account_id: POSTER, wait_until: "NONE" });
      bodies.push({ transaction: j.transaction, receipts: j.receipts_outcome.map((o) => ({ execution_outcome: o })) });
      await new Promise((s) => setTimeout(s, Number(process.env.TX_GAP_MS ?? 1500)));
    }
  } else {
    bodies = await fetchTxsRaw((await accountTxs(ACCOUNT, ANCHOR_INDEXER)).map((t) => t.transaction_hash));
  }
  const found = [];
  for (const t of bodies) {
    if (t.transaction.signer_id !== POSTER || t.transaction.receiver_id !== ACCOUNT) continue;
    // The receipt that ran the posts on the anchor account must have succeeded.
    const ran = (t.receipts || []).map((r) => r.execution_outcome).find((o) => o && o.outcome.executor_id === ACCOUNT);
    if (!ran || "Failure" in (ran.outcome.status || {})) continue;
    const args = t.transaction.actions.filter((a) => a.FunctionCall?.method_name === "post").map((a) => a.FunctionCall.args);
    if (args.length) found.push({ tx: t.transaction.hash, args });
  }
  return decodeAll(found);
}
function decodeAll(found) {
  const out = [];
  for (const f of found) for (const a of f.args) {
    const d = decodePost(Buffer.from(a, "base64"));
    if (d.source === SOURCE) out.push({ ...d, tx: f.tx });
  }
  return out.sort((a, b) => a.seq - b.seq);
}
async function rpcCall(method, params) {
  const url = process.env.NEAR_ARCHIVAL_RPC || "https://archival-rpc.testnet.fastnear.com";
  for (let i = 0; ; i++) {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const j = r.status === 200 ? await r.json() : null;
    if (j?.result) return j.result;
    if (i > 8) throw new Error(`${method}: ${r.status} ${JSON.stringify(j?.error ?? "").slice(0, 200)}`);
    await new Promise((s) => setTimeout(s, 3000 * (i + 1)));
  }
}
async function fetchTxsRaw(hashes) {
  const out = [];
  for (let i = 0; i < hashes.length; i += 20) {
    const r = await fetch(`${ANCHOR_INDEXER}/v0/transactions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tx_hashes: hashes.slice(i, i + 20) }) });
    out.push(...((await r.json()).transactions || []).filter(Boolean));
    await new Promise((s) => setTimeout(s, 600));
  }
  return out;
}

export function outcomesOf(records) {
  const acc = {};
  const a = (id) => (acc[id] ??= { settled: 0, settled_amount: 0n, reverted: 0, receipts: 0, refused: 0, overturned: 0, ratings: 0, reviews_rounds: 0, hired: [], hired_by: [], joined: 0, completed: 0, slashed: 0, earned: 0n, lost: 0n, programs: [] });
  const byNullifier = {};
  const unsatisfied = [];
  const graph = [];
  const programs = [];
  const seenRound = new Set();
  for (const r of records) {
    const j = JSON.parse(r.json);
    const d = j.data?.[0] ?? {};
    const where = `${r.executor}:${j.event}`;
    switch (where) {
      case "bookerbob.testnet:settled": a(d.merchant).settled++; a(d.merchant).settled_amount += BigInt(d.amount); byNullifier[d.nullifier] = d.merchant; break;
      case "bookerbob.testnet:settle_reverted": { const m = byNullifier[d.nullifier]; if (m) { a(m).reverted++; unsatisfied.push({ kind: "settle_reverted", account: m, nullifier: d.nullifier, height: r.height }); } break; }
      case "bookerbob.testnet:referee_receipt": a(d.merchant).receipts++; byNullifier[d.nullifier] ??= d.merchant; break;
      case "bookerbob.testnet:receipt_refused": a(d.merchant).refused++; unsatisfied.push({ kind: "receipt_refused", account: d.merchant, nullifier: d.nullifier, reason: d.reason, height: r.height }); break;
      case "bookerbob.testnet:dispute_overturned":
      case "bookerbob.testnet:dispute_overturned_after_settle": { const m = byNullifier[d.nullifier]; if (m) a(m).overturned++; unsatisfied.push({ kind: j.event, account: m ?? null, nullifier: d.nullifier, height: r.height }); break; }
      case "bookerbob.testnet:reviews_published": { const k = `${d.merchant}|${d.round}`; if (!seenRound.has(k)) { seenRound.add(k); a(d.merchant).ratings += d.ratings; a(d.merchant).reviews_rounds++; } break; }
      case "bookerbob.testnet:hired": a(d.agent).hired.push(d.sub_agent); a(d.sub_agent).hired_by.push(d.agent); break;
      case "bookerbob.testnet:graph_event": graph.push({ index: d.index, event: d.event, root: d.root }); break;
      case "bookerbob.testnet:graph_program_set": programs.push({ kind: "graph_program_set", program_hash: d.program_hash, height: r.height }); break;
      default:
        if (j.standard === "bookerbob-coalition") {
          const c = r.executor.split(".")[0];
          if (j.event === "joined") a(d.member).joined++;
          if (j.event === "job_finalized") {
            for (const m of d.delivered || []) { a(m.member).completed++; a(m.member).earned += BigInt(m.share) + BigInt(m.from_slashed || 0); /* the bond coming back is not earned (the contract's own rule) */ }
            for (const m of d.slashed || []) { a(m.member).slashed++; a(m.member).lost += BigInt(m.bond_lost); unsatisfied.push({ kind: "slashed", account: m.member, contract: c, job: d.job, bond_lost: m.bond_lost, height: r.height }); }
            (acc[`job:${c}:${d.job}`] = { status: d.status, buyer: d.buyer });
          }
        }
        if (j.standard === "bookerbob-smith" && (j.event === "register" || j.event === "pin")) programs.push({ kind: `smith_${j.event}`, registry: r.executor, request_id: d.request_id, program_hash: d.program_hash, height: r.height });
    }
  }
  const accounts = Object.fromEntries(Object.entries(acc).filter(([k]) => !k.startsWith("job:")).sort().map(([k, v]) => [k, { ...v, settled_amount: String(v.settled_amount), earned: String(v.earned), lost: String(v.lost) }]));
  return { accounts, graph, unsatisfied, programs };
}

async function cmdRebuild(flags) {
  const posted = await postedEpochs(flags);
  const entries = await anchorEntries(flags);
  // 1. Every post's records hash to the root the contract stored, and the heads chain.
  let prev = GENESIS;
  let ok = posted.length === entries.length;
  posted.forEach((p, i) => {
    const { events, root } = epochRoot(SOURCE, p.epoch, p.records);
    const h = head(POSTER, SOURCE, p.seq, prev, root);
    const e = entries[i];
    if (!(e && p.seq === i && p.prev === prev && e.root === root && e.events === events && e.head === h && e.n === p.records.length)) { if (ok) console.log(`   post seq ${p.seq} does not match the anchor`); ok = false; }
    prev = h;
  });
  const records = posted.flatMap((p) => p.records.map(decodeRecord));
  pass(ok, `posts: ${posted.length} posts by ${POSTER} read back from ${flags.snapshot ? "the snapshot of their tx args" : "their tx args"}; ${records.length} records hash to every stored root, heads chain to ${short(prev)}`);
  // 2. Agent outcomes from the records alone.
  const o = outcomesOf(records);
  // The coalition contracts keep their own per-member record: the rebuild must equal it.
  const views = flags.snapshot ? readJson(VIEWS) : null;
  const memberViews = {};
  let agree = 0, total = 0;
  const H = Math.max(...records.map((r) => r.height));
  for (const c of COALITIONS) {
    // Each coalition contract keeps its own member record over its own jobs: compare that slice.
    const slice = outcomesOf(records.filter((r) => r.executor === c)).accounts;
    for (const [m, mine] of Object.entries(slice).filter(([, v]) => v.joined > 0)) {
      const v = views ? views.members[`${c}|${m}`] : await view(c, "member", { account: m }, RPC, H);
      memberViews[`${c}|${m}`] = v;
      total++;
      if (v && v.joined === mine.joined && v.completed === mine.completed && v.slashed === mine.slashed && v.earned === mine.earned && v.lost === mine.lost) agree++;
      else console.log(`   ${c.split(".")[0]} ${m}: rebuilt ${JSON.stringify({ joined: mine.joined, completed: mine.completed, slashed: mine.slashed, earned: mine.earned, lost: mine.lost })}, contract ${JSON.stringify(v)}`);
    }
  }
  pass(agree === total && total > 0, `coalition outcomes: ${agree} of ${total} (contract, member) records rebuilt from the anchor's records equal that coalition contract's own member() view at block ${H}, the last anchored event (joined, completed, slashed, earned, lost; v1 and v2)`);
  // 3. The standing: graph events from the anchor, the standing program's code, the on-chain root.
  const onChain = views ? views.standing_root : await view(BAZAAR, "standing_root", {}, RPC, H);
  const [sRoot, sN, sScores, sGraph] = onChain;
  // The prefix of the anchored graph the proven update was over: up to the event whose running root is sGraph.
  const cut = o.graph.findIndex((g) => g.root === sGraph);
  const prefix = cut >= 0 ? o.graph.slice(0, cut + 1) : o.graph;
  const input = { events: prefix.map((g) => [...Buffer.from(g.event, "hex")]) };
  const inputPath = join(OUT, "standing-input.json");
  writeJson(inputPath, input);
  const t = JSON.parse(execFileSync("cargo", ["run", "-q", "-p", "bookerbob-cli", "--", "standing-proofs", inputPath], { encoding: "utf8" }));
  const pinned = o.programs.filter((p) => p.kind === "graph_program_set").at(-1)?.program_hash;
  const smithPinned = o.programs.filter((p) => p.kind === "smith_pin" && p.program_hash === pinned).map((p) => p.registry.split(".")[0]);
  pass(cut >= 0 && t.graph_root === sGraph && t.scores_hash === sScores && t.standing_root === sRoot && t.proofs.length === sN,
    `standing: ${prefix.length} graph events from the anchor, run through the standing program's code (bookerbob_graph::compute, what the Jolt guest ${pinned ? short(pinned) : "?"} proves${smithPinned.length ? `, pinned in ${smithPinned.join(" and ")}` : ""}): graph_root ${short(t.graph_root)}, scores_hash ${short(t.scores_hash)}, standing_root ${short(t.standing_root)} over ${t.proofs.length} merchants equal the bazaar's on-chain standing_root at block ${H}`);
  const out = { note: "Agent outcomes rebuilt from the economy anchor's posts alone (docs/anchor-format.md). unsatisfied: the events a later standing program can read as failed interactions.", source: SOURCE, poster: POSTER, anchor: ACCOUNT, epochs: posted.length, records: records.length, head: prev, standing: { graph_events: prefix.length, ...t, proofs: undefined, ranks: t.proofs.map((p) => [p.merchant, p.rank]) }, ...o };
  writeJson(OUTCOMES, out);
  if (!flags.snapshot) writeJson(VIEWS, { ...(existsSync(VIEWS) ? readJson(VIEWS) : {}), note: "The views make anchor-rebuild --snapshot and anchor-check --snapshot compare against, read live (members and standing_root at the last anchored block).", read_at: new Date().toISOString(), height: H, entries, standing_root: onChain, members: memberViews });
  const ranked = Object.entries(o.accounts).filter(([, v]) => v.joined || v.settled || v.ratings);
  console.log(`   ${ranked.length} agents with outcomes; ${o.unsatisfied.length} unsatisfied events (slashes, refused receipts, overturned disputes, reverted settles) -> ${OUTCOMES}`);
  if (failed) { console.log("FAIL  make anchor-rebuild"); process.exit(1); }
  console.log("PASS  make anchor-rebuild");
}

// ---- mainnet plan: the exact cost, nothing sent ----
async function cmdMainnetPlan() {
  const c = readJson(CHAIN);
  const run = existsSync(RUN) ? readJson(RUN) : {};
  console.log(JSON.stringify({ epochs: c.links.length, events: c.links.reduce((a, l) => a + l.n, 0), measured_testnet: run.gas || null }, null, 1));
}

const cmds = { chain: cmdChain, keys: cmdKeys, deploy: cmdDeploy, post: cmdPost, check: cmdCheck, rebuild: cmdRebuild, "mainnet-plan": cmdMainnetPlan };
if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = Object.fromEntries(rest.filter((x) => x.startsWith("--")).map((x) => { const [k, v] = x.slice(2).split("="); return [k, v ?? true]; }));
  if (!cmds[cmd]) { console.error("usage: node scripts/econ/anchor.mjs chain | keys | deploy | post | check [--snapshot] [--rpc[=N]] [--tamper] | rebuild [--snapshot] | mainnet-plan"); process.exit(2); }
  cmds[cmd](flags).catch((e) => { console.error(`FAIL  ${e.message}`); process.exit(1); });
}
