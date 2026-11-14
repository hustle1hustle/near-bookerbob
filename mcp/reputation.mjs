// Agent reputation tools for any MCP client: an agent's proven standing on the BookerBob bazaar,
// a check of the Jolt proof behind it, the zk check a requester can commission from the smith,
// and the coalition jobs it can join. Testnet views over public RPC and local files only: no
// keys, no transactions, no smith or model code is run. Served by mcp/rep-read.mjs.
//
// Env: STANDING_ACCOUNT_ID (default bookerbob.testnet), SMITH_REGISTRY_ID (default
// smith-reg.bookerbob-demo.testnet), COALITION_ACCOUNT_IDS (default coalition-v3, coalition-v2, coalition, .bookerbob-demo.testnet),
// NEAR_RPC (default testnet RPC).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

const RPC = () => process.env.NEAR_RPC ?? "https://test.rpc.fastnear.com";
const STANDING = () => process.env.STANDING_ACCOUNT_ID ?? process.env.BAZAAR_ACCOUNT_ID ?? "bookerbob.testnet";
const REGISTRY = () => process.env.SMITH_REGISTRY_ID ?? "smith-reg.bookerbob-demo.testnet";
const NEARBLOCKS = "https://testnet.nearblocks.io/txns/";
const repo = (p) => new URL(`../${p}`, import.meta.url);

// ---------- the standing tree (zkcore/src/standing.rs, byte for byte) ----------

export const GRAPH_CONTEXT = "graph";
const TAG = (t) => Buffer.from(`bookerbob/standing-${t}/v1\x00`);
const sha = (...parts) => createHash("sha256").update(Buffer.concat(parts.map((p) => Buffer.from(p)))).digest();
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const unhex32 = (h) => { if (!/^[0-9a-f]{64}$/.test(h ?? "")) throw new Error(`not 32 bytes of hex: ${h}`); return Buffer.from(h, "hex"); };

export const graphSalt = (graphRoot, merchant) => sha(TAG("salt"), unhex32(graphRoot), Buffer.from(merchant)).toString("hex");
export const scoreCommit = (score, salt) => sha(TAG("score"), u64(score), unhex32(salt)).toString("hex");
export const leaf = (context, merchant, rank, n, commit) =>
  sha(TAG("leaf"), Buffer.from(context), [0], Buffer.from(merchant), [0], u32(rank), u32(n), unhex32(commit));
const node = (l, r) => sha(TAG("node"), l, r);

/** The opening (a TopProof) leads from its leaf to `root`. */
export function opens(root, context, p) {
  try {
    if (!(p.rank >= 1 && p.rank <= p.n)) return false;
    let cur = leaf(context, p.merchant, p.rank, p.n, p.score_commit);
    for (const [sib, left] of p.path) cur = left ? node(unhex32(sib), cur) : node(cur, unhex32(sib));
    return cur.toString("hex") === root;
  } catch {
    return false;
  }
}

/** "In the top pct%": rank r of n with r <= ceil(pct * n / 100) (core/src/standing.rs). */
export const inTopRule = (rank, n, pct) => pct >= 0 && pct <= 100 && rank * 100 <= pct * n + 99;
/** The smallest pct the rank qualifies for. */
export const topPct = (rank, n) => Math.max(1, Math.ceil(((rank * 100 - 99) / n)));

// ---------- testnet views ----------

export async function view(account, method_name, args = {}) {
  const body = {
    jsonrpc: "2.0",
    id: "rep-reputation",
    method: "query",
    params: { request_type: "call_function", finality: "final", account_id: account, method_name, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") },
  };
  const r = await (await fetch(RPC(), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json();
  if (r.error) throw new Error(`${account}.${method_name}: ${r.error.cause?.name ?? r.error.message ?? "rpc error"}`);
  if (r.result?.error) throw new Error(`${account}.${method_name}: ${r.result.error}`);
  return { block_height: r.result.block_height, value: JSON.parse(Buffer.from(r.result.result).toString() || "null") };
}

/** The live proven standing: (tree root, n, scores hash, graph root), the graph log, the program. */
async function liveStanding() {
  const account = STANDING();
  const [sr, gr, prog] = await Promise.all([view(account, "standing_root"), view(account, "graph_root"), view(account, "graph_program")]);
  if (!sr.value) throw new Error(`${account} has no proven standing tree yet`);
  const [standing_root, n, scores_hash, graph_root] = sr.value;
  return { contract: account, block_height: sr.block_height, standing_root, n, scores_hash, graph_root, graph_events: gr.value?.[1] ?? null, live_graph_root: gr.value?.[0] ?? null, program_hash: prog.value };
}

const data = () => JSON.parse(readFileSync(repo("mcp/standing-live.json"), "utf8"));

// ---------- get_standing ----------

export async function getStanding({ account }) {
  if (!account) throw new Error("account is required");
  const live = await liveStanding();
  const d = data();
  const e = d.entries.find((x) => x.merchant === account);
  const sameTree = d.standing_root === live.standing_root && d.n === live.n;
  const base = {
    account,
    contract: live.contract,
    block_height: live.block_height,
    standing_root: live.standing_root,
    graph_root: live.graph_root,
    n: live.n,
  };
  if (!sameTree) return { ...base, found: false, reason: `the committed openings are for root ${d.standing_root.slice(0, 12)}.. and the chain now holds ${live.standing_root.slice(0, 12)}..; rebuild with node mcp/standing-data.mjs` };
  if (!e) return { ...base, found: false, reason: `${account} is not in the proven standing tree (${d.n} ranked: ${d.entries.map((x) => x.merchant).join(", ")}). Standing starts at merchants with released ratings from paid, sealed reviews, and flows through hires.` };
  const opening = { merchant: e.merchant, rank: e.rank, n: e.n, score_commit: e.score_commit, path: e.path };
  const scoreOpens = scoreCommit(e.score_x100, graphSalt(live.graph_root, account)) === e.score_commit;
  return {
    ...base,
    found: true,
    rank: e.rank,
    top_pct: topPct(e.rank, e.n),
    score: e.score_x100 / 100,
    score_x100: e.score_x100,
    checks: {
      opening_opens_to_live_root: opens(live.standing_root, GRAPH_CONTEXT, opening),
      score_opens_its_commitment: scoreOpens,
    },
    opening,
    proof: {
      program_hash: live.program_hash,
      program_matches_committed_proof: live.program_hash === d.proof.program_hash,
      proof_sha256: d.proof.proof_sha256,
      proof_dir: d.proof.proof_dir,
      finalize_tx: d.proof.finalize_tx,
      finalize_url: NEARBLOCKS + d.proof.finalize_tx,
      submit_tx: d.proof.submit_tx,
    },
    next: `verify_standing {"account":"${account}","pct":${topPct(e.rank, e.n)}} checks the Jolt proof and asks the contract's in_top`,
  };
}

// ---------- verify_standing ----------

// The wasm verifier and its preprocessing, pinned by sha256 (as zk/browser/check-standing.mjs
// pins them). The preprocessing carries the guest bytecode the proof is checked against, so a
// swapped program fails here.
export const PINS = {
  "verifier.bin": "8cb059d83c0a5377a6b681677ee0cdf8cae51121685d8163fb224752aa211634",
  "verifier.wasm.gz": "020fe1181ac3b1e7cda4bee507570166ae60db8d153cc29cdb78613883546e99",
};
const STANDING_DIR = () => process.env.STANDING_DIR ?? repo("agents/standing").pathname;
let wasm;
async function verifier() {
  if (wasm) return wasm;
  const dir = STANDING_DIR();
  const files = Object.fromEntries(Object.keys(PINS).map((f) => [f, readFileSync(`${dir}/${f}`)]));
  const pins = Object.entries(PINS).map(([f, want]) => {
    const got = createHash("sha256").update(f.endsWith(".gz") ? gunzipSync(files[f]) : files[f]).digest("hex");
    return { file: f, ok: got === want, sha256: got };
  });
  const never = (name) => () => { throw new Error(`verifier called ${name}`); };
  const imports = {
    __wbindgen_placeholder__: { __wbindgen_describe: never("describe") },
    __wbindgen_externref_xform__: { __wbindgen_externref_table_set_null: never("set_null"), __wbindgen_externref_table_grow: never("grow") },
  };
  const module = await WebAssembly.compile(gunzipSync(files["verifier.wasm.gz"]));
  wasm = { dir, pins, module, imports, pp: files["verifier.bin"], proof: readFileSync(`${dir}/proof.bin`), statement: JSON.parse(readFileSync(`${dir}/statement.json`, "utf8")) };
  return wasm;
}

/** The Jolt verifier on (statement, proof): ok, or the verifier's reason. A trap is a refusal. */
export async function joltVerify(statement, proofBytes) {
  const w = await verifier();
  const x = (await WebAssembly.instantiate(w.module, w.imports)).exports;
  const put = (b) => { const p = x.bb_alloc(b.length); new Uint8Array(x.memory.buffer, p, b.length).set(b); return [p, b.length]; };
  const t = performance.now();
  try {
    const ok = x.bb_verify(...put(w.pp), ...put(proofBytes ?? w.proof), ...put(Buffer.from(JSON.stringify(statement)))) === 1;
    const error = ok ? null : Buffer.from(new Uint8Array(x.memory.buffer, x.bb_error_ptr(), x.bb_error_len())).toString();
    return { ok, ms: Math.round(performance.now() - t), error };
  } catch (e) {
    return { ok: false, ms: Math.round(performance.now() - t), error: `trap: ${e.message}` };
  }
}

/**
 * accept only if every check holds: the pinned verifier, the Jolt proof of the statement, the
 * statement's roots equal to the live chain's, and (with an account) its opening against the live
 * standing root, locally and through the contract's own in_top view.
 */
export async function verifyStanding({ account, statement, proof_base64, opening, pct } = {}) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: !!ok, ...(detail == null ? {} : { detail }) });
  if (!account && !opening) add("an account or an opening to check", false, "a standing claim is about one agent: give account, opening, or both");
  const w = await verifier();
  for (const p of w.pins) add(`pinned ${p.file}`, p.ok, `sha256 ${p.sha256.slice(0, 16)}..`);
  const st = statement ?? w.statement;
  const proofBytes = proof_base64 ? Buffer.from(proof_base64, "base64") : w.proof;
  const pinsOk = w.pins.every((p) => p.ok);
  const j = pinsOk ? await joltVerify(st, proofBytes) : { ok: false, error: "verifier files differ from their pins: not run", ms: 0 };
  add("Jolt proof verifies for the statement (wasm verifier, in Node)", j.ok, j.ok ? `${j.ms} ms, ${proofBytes.length} bytes, ${st.events?.length ?? 0} graph events` : j.error?.slice(0, 160));

  const live = await liveStanding();
  add("the statement's graph root is the chain's proven graph root", st.root === live.graph_root, `statement ${String(st.root).slice(0, 12)}.., chain ${live.graph_root.slice(0, 12)}..`);
  add("the statement's standing hash is the chain's proven scores hash", st.scores_hash === live.scores_hash, `statement ${String(st.scores_hash).slice(0, 12)}.., chain ${live.scores_hash.slice(0, 12)}..`);
  add("the chain's standing program is the program of the committed proof", live.program_hash === data().proof.program_hash, `chain ${String(live.program_hash).slice(0, 12)}..`);
  add("the chain's graph log has not moved past the proven root", live.live_graph_root === live.graph_root, live.live_graph_root === live.graph_root ? null : `${live.graph_events} events now, root ${String(live.live_graph_root).slice(0, 12)}..`);

  let rank = null;
  let in_top = null;
  if (account || opening) {
    let o = opening;
    if (!o) {
      const d = data();
      const e = d.entries.find((x) => x.merchant === account);
      o = e && d.standing_root === live.standing_root ? { merchant: e.merchant, rank: e.rank, n: e.n, score_commit: e.score_commit, path: e.path } : null;
    }
    if (!o) add(`${account} has an opening in the live standing tree`, false, "not ranked in the proven tree");
    else {
      if (account && o.merchant !== account) add("the opening is the asked account's", false, `opening is for ${o.merchant}`);
      rank = o.rank;
      const want = pct ?? topPct(o.rank, o.n);
      add(`the opening (rank ${o.rank} of ${o.n}) opens to the live standing root`, opens(live.standing_root, GRAPH_CONTEXT, o) && o.n === live.n, `root ${live.standing_root.slice(0, 12)}..`);
      try {
        const r = await view(live.contract, "in_top", { proof: o, pct: want });
        in_top = { pct: want, contract_says: r.value, block_height: r.block_height };
        add(`contract ${live.contract}.in_top(pct=${want})`, r.value === true, `returned ${r.value}`);
      } catch (e) {
        in_top = { pct: want, error: e.message };
        add(`contract ${live.contract}.in_top(pct=${want})`, false, e.message);
      }
    }
  }
  if (rank == null && !checks.some((c) => !c.ok)) add("a rank was checked", false, "no opening was checked");
  const reasons = checks.filter((c) => !c.ok).map((c) => `${c.name}${c.detail ? `: ${c.detail}` : ""}`);
  return {
    verdict: reasons.length ? "reject" : "accept",
    reasons,
    account: account ?? opening?.merchant ?? null,
    rank,
    in_top,
    contract: live.contract,
    block_height: live.block_height,
    program_hash: live.program_hash,
    checks,
    scope:
      "The wasm verifier checks a Jolt proof (browser pin) of the same statement the on-chain proof covers: the graph events and the roots they produce. It proves the standing follows from the logged events; it does not judge whether the events themselves were honest.",
  };
}

// ---------- commission_check ----------

// The smith's spec format (scripts/smith.mjs in the smith tree: validateSpec, typesRs, canonical).
const ACCOUNT = /^[a-z0-9._-]{2,64}$/;
const SCALARS = new Set(["u8", "u16", "u32", "u64", "u128", "bool", "bytes32", "string", "bytes"]);
const KEYWORDS = new Set(["type", "match", "fn", "mod", "use", "crate", "self", "super", "impl", "loop", "ref", "move"]);
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}
export const specHash = (spec) => createHash("sha256").update(canonical(spec)).digest("hex");

/** Every problem with a spec, as the smith would see it; empty when it is valid. */
export function validateSpec(spec) {
  const p = [];
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) return ["the spec must be a JSON object"];
  if (typeof spec.id !== "string" || !/^[a-z0-9-]{1,64}$/.test(spec.id)) p.push("id: lowercase letters, digits and '-', 1 to 64 characters");
  if (!Number.isInteger(spec.version) || spec.version < 1) p.push("version: a positive integer");
  if (typeof spec.requester?.account !== "string" || !ACCOUNT.test(spec.requester.account)) p.push("requester.account: a NEAR account id");
  if (typeof spec.requester?.role !== "string" || !spec.requester.role) p.push("requester.role: who asks (for example 'buyer agent')");
  if (typeof spec.ask !== "string" || spec.ask.trim().length < 10) p.push("ask: the claim to prove, in plain language");
  if (spec.privacy !== undefined && typeof spec.privacy !== "boolean") p.push("privacy: true or false (absent means false)");
  const types = spec.types ?? {};
  if (typeof types !== "object" || Array.isArray(types)) p.push("types: an object {Name: [[field, type], ...]}");
  const typeOk = (t) => {
    if (typeof t !== "string") return false;
    if (SCALARS.has(t)) return true;
    const m = t.match(/^(vec|option)<(.+)>$/);
    if (m) return typeOk(m[2]);
    return /^[A-Z][A-Za-z0-9]*$/.test(t) && Object.hasOwn(types, t);
  };
  const fields = (where, list) => {
    if (!Array.isArray(list)) return p.push(`${where}: a list of [field, type] pairs`);
    const seen = new Set();
    for (const f of list) {
      if (!Array.isArray(f) || f.length !== 2) { p.push(`${where}: each entry is [field, type]`); continue; }
      const [name, t] = f;
      if (typeof name !== "string" || !/^[a-z][a-z0-9_]*$/.test(name) || KEYWORDS.has(name)) p.push(`${where}.${name}: field name not allowed (lowercase snake case, not a Rust keyword)`);
      if (seen.has(name)) p.push(`${where}.${name}: duplicate field`);
      seen.add(name);
      if (!typeOk(t)) p.push(`${where}.${name}: type not allowed: ${t}`);
    }
  };
  for (const [n, f] of Object.entries(typeof types === "object" && types ? types : {})) {
    if (["Public", "Private", "Output"].includes(n)) p.push(`types.${n}: type name reserved`);
    else if (!/^[A-Z][A-Za-z0-9]*$/.test(n)) p.push(`types.${n}: type names are CamelCase`);
    fields(`types.${n}`, f);
  }
  fields("public", spec.public);
  fields("private", spec.private);
  fields("output", spec.output);
  if (spec.privacy === true && Array.isArray(spec.private) && !spec.private.some((f) => Array.isArray(f) && f[0] === "salt" && f[1] === "bytes32"))
    p.push("privacy: a privacy spec needs a `salt: bytes32` private field (the private commitment is sha256 of the private bytes)");
  if (!Array.isArray(spec.rules) || !spec.rules.length || spec.rules.some((r) => typeof r !== "string")) p.push("rules: a non-empty list of strings");
  if (!Array.isArray(spec.vectors) || !spec.vectors.length) p.push("vectors: at least one test vector");
  else
    spec.vectors.forEach((v, i) => {
      if (typeof v?.label !== "string") p.push(`vectors[${i}].label: a string`);
      if (typeof v?.public !== "object" || v.public === null) p.push(`vectors[${i}].public: an object`);
      if (typeof v?.private !== "object" || v.private === null) p.push(`vectors[${i}].private: an object`);
      if (!(v?.expect === "refuse" || (typeof v?.expect === "object" && v.expect !== null))) p.push(`vectors[${i}].expect: "refuse" or the output fields`);
    });
  for (const k of ["heap", "max_input", "max_private", "max_output", "max_trace"])
    if (!Number.isInteger(spec.limits?.[k]) || spec.limits[k] <= 0) p.push(`limits.${k}: a positive integer`);
  return p;
}

export async function commissionCheck({ spec, request_id, registrar } = {}) {
  if (!spec && !request_id) throw new Error("give a spec to check, a request_id to look up, or both");
  if (registrar != null && (typeof registrar !== "string" || !ACCOUNT.test(registrar))) throw new Error("registrar: a NEAR account id (a-z, 0-9, '.', '_', '-') or null");
  if (request_id != null && (typeof request_id !== "string" || !/^[a-z0-9-]{1,64}$/.test(request_id))) throw new Error("request_id: lowercase letters, digits and '-', 1 to 64 characters");
  const out = { registry: REGISTRY() };
  if (spec) {
    const problems = validateSpec(spec);
    out.spec = { valid: problems.length === 0, problems };
    if (!problems.length) {
      const hash = specHash(spec);
      // Everything that lands in the command line is checked against a closed character set.
      const callArgs = { id: spec.id, spec_hash: hash, registrar: registrar ?? null };
      if (![REGISTRY(), spec.requester.account, ...(registrar ? [registrar] : [])].every((a) => ACCOUNT.test(a)) || !/^[a-z0-9-]+$/.test(spec.id) || !/^[0-9a-f]{64}$/.test(hash))
        throw new Error("an account id or the spec id has characters outside the allowed set");
      out.spec.spec_hash = hash;
      out.request = {
        note: "Sign and send this from the requester's own account; this tool sends nothing. Then the spec file goes to the smith (zk/smith/specs/<id>.json).",
        signer_id: spec.requester.account,
        receiver_id: REGISTRY(),
        actions: [{ FunctionCall: { method_name: "post_request", args: callArgs, gas: "50000000000000", deposit: "0" } }],
        near_cli: `near contract call-function as-transaction ${REGISTRY()} post_request json-args '${JSON.stringify(callArgs)}' prepaid-gas '50 Tgas' attached-deposit '0 NEAR' sign-as ${spec.requester.account} network-config testnet`,
      };
    }
  }
  const id = request_id ?? (out.spec?.valid ? spec.id : null);
  if (id) {
    const [s, req] = await Promise.all([view(REGISTRY(), "status", { request_id: id }), view(REGISTRY(), "get_request", { id }).catch((e) => ({ value: null, error: e.message }))]);
    out.registry_status = { request_id: id, status: s.value, block_height: s.block_height, request: req.value };
    if (s.value === "usable" || s.value === "pending" || s.value === "challenged") {
      const prog = await view(REGISTRY(), "get_program", { request_id: id }).catch(() => ({ value: null }));
      out.registry_status.program = prog.value;
    }
    if (spec && out.spec?.valid && req.value?.spec_hash) out.registry_status.spec_hash_matches = req.value.spec_hash === out.spec.spec_hash;
  }
  return out;
}

// ---------- coalitions ----------

// v3 first (job E; a seat's `announced` is a list of nullifiers), then v2 (job D: buyers list,
// one announced nullifier per seat, released seats, claim), then v1, where jobs A to C ran.
// coalition/src/lib.rs: job status is "open", then "complete" or "failed" on all three.
const COALITIONS = () =>
  process.env.COALITION_ACCOUNT_ID ? [process.env.COALITION_ACCOUNT_ID] : (process.env.COALITION_ACCOUNT_IDS ?? "coalition-v3.bookerbob-demo.testnet,coalition-v2.bookerbob-demo.testnet,coalition.bookerbob-demo.testnet").split(",").map((x) => x.trim()).filter(Boolean);

/** Each leg's seat as a word: open (no member yet), pending (bazaar answers in flight), seated, announced, delivered. */
const announced = (a) => (Array.isArray(a) ? a.length > 0 : !!a); // v3: a list; v2: one nullifier or null
export const seatState = (s) => (!s ? "open" : s.pending ? "pending" : s.delivered ? "delivered" : announced(s.announced) ? "announced" : "seated");

export async function coalitionJob({ id, contract }) {
  if (!Number.isInteger(id) || id < 0) throw new Error("id: a job number from 0");
  const c = contract ?? COALITIONS()[0];
  if (!COALITIONS().includes(c)) throw new Error(`contract: one of ${COALITIONS().join(", ")}`);
  const r = await view(c, "job", { job: id });
  return { contract: c, block_height: r.block_height, job: r.value, seats: r.value ? (r.value.seats ?? []).map((s, i) => ({ leg: i, state: seatState(s), member: s?.member ?? null })) : null };
}

export async function coalitionOpenJobs({ max = 50 } = {}) {
  if (!Number.isInteger(max) || max < 1 || max > 200) throw new Error("max: an integer from 1 to 200");
  const contracts = [];
  for (const c of COALITIONS()) {
    const jobs = [];
    let block_height = null;
    for (let id = 0; id < max; id++) {
      const r = await view(c, "job", { job: id });
      block_height = r.block_height;
      if (!r.value) break;
      jobs.push(r.value);
    }
    contracts.push({ contract: c, block_height, jobs_read: jobs.length, jobs });
  }
  const open = [];
  for (const { contract, jobs } of contracts)
    for (const j of jobs.filter((x) => x.status === "open"))
      open.push({
        contract,
        id: j.id,
        buyer: j.buyer,
        legs: j.legs.map((l, i) => ({ ...l, seat: seatState(j.seats?.[i]) })),
        seats_open: (j.seats ?? []).map((s, i) => (s ? null : i)).filter((i) => i !== null),
        min_top_pct: j.min_top_pct,
        bond: j.bond,
        budget: j.budget,
        funded: j.funded,
        deadline_ms: j.deadline_ms,
      });
  return {
    contracts: contracts.map(({ contract, block_height, jobs_read, jobs }) => ({ contract, block_height, jobs_read, closed: jobs.filter((j) => j.status !== "open").map((j) => ({ id: j.id, status: j.status })) })),
    open,
    note: open.length ? "A seat needs standing in the top min_top_pct% (get_standing, verify_standing)." : "No open job now.",
  };
}

/** An agent's coalition record on each contract: seats joined, completed, slashed, released, earned, lost; and what it can claim (v2, v3). */
export async function coalitionMember({ account }) {
  if (typeof account !== "string" || !ACCOUNT.test(account)) throw new Error("account: a NEAR account id");
  const out = [];
  for (const c of COALITIONS()) {
    const m = await view(c, "member", { account });
    const claim = await view(c, "claimable_of", { account }).catch(() => ({ value: null }));
    out.push({ contract: c, block_height: m.block_height, record: m.value, claimable: claim.value });
  }
  return { account, coalitions: out };
}

// ---------- the MCP tool table ----------

const obj = (properties, required = []) => ({ type: "object", properties, required });
export const REPUTATION_TOOLS = [
  {
    name: "get_standing",
    description:
      "An agent's proven standing (agent reputation) on the BookerBob bazaar: its rank and score in the Jolt-proven standing tree, the Merkle opening, and the proof reference (program hash, proof sha256, the tx that finalized it). Reads the live standing_root and graph_root on NEAR testnet.",
    inputSchema: obj({ account: { type: "string", pattern: "^[a-z0-9._-]{2,64}$", description: "NEAR account, e.g. m01.bookerbob.testnet" } }, ["account"]),
    run: getStanding,
  },
  {
    name: "verify_standing",
    description:
      "Check a standing claim before trusting it: verifies the Jolt proof with the wasm verifier, checks its roots against the live chain, opens the account's leaf to the live standing root and asks the contract's in_top(pct). Returns accept or reject with reasons. Pass a statement, proof or opening to check someone else's claim instead of the committed one.",
    inputSchema: obj({
      account: { type: "string", pattern: "^[a-z0-9._-]{2,64}$" },
      pct: { type: "integer", minimum: 1, maximum: 100, description: "top pct% to check; default the best the rank qualifies for" },
      statement: { type: "object", description: "{events: [hex], root, scores_hash}; default the committed statement" },
      proof_base64: { type: "string", description: "a Jolt proof; default the committed proof" },
      opening: { type: "object", description: "a TopProof {merchant, rank, n, score_commit, path}; default the committed one" },
    }),
    run: verifyStanding,
  },
  {
    name: "commission_check",
    description:
      "Commission a zk check from the Jolt smith: validates a spec in the smith's format and returns the unsigned post_request payload for the smith registry, and/or the registry's status of a request id (none, pending, challenged, rejected, usable). Sends nothing and runs no smith or model code.",
    inputSchema: obj({
      spec: { type: "object", description: "the smith spec: id, version, requester, ask, privacy, types, public, private, output, rules, vectors, limits" },
      request_id: { type: "string", pattern: "^[a-z0-9-]{1,64}$" },
      registrar: { type: "string", pattern: "^[a-z0-9._-]{2,64}$", description: "a named registrar; default the smith" },
    }),
    run: commissionCheck,
  },
  {
    name: "coalition_open_jobs",
    description: "Open coalition jobs on testnet: multi-leg purchases agents fill together, each with its legs, open seats and the standing a seat needs (min_top_pct).",
    inputSchema: obj({ max: { type: "integer", minimum: 1, maximum: 200 } }),
    run: coalitionOpenJobs,
  },
  {
    name: "coalition_job",
    description: "One coalition job by id: buyer, legs, each leg's seat (open, pending, seated, announced, delivered), bond, budget, status.",
    inputSchema: obj({ id: { type: "integer", minimum: 0 }, contract: { type: "string", pattern: "^[a-z0-9._-]{2,64}$", description: "default the newest coalition contract (v3)" } }, ["id"]),
    run: coalitionJob,
  },
  {
    name: "coalition_member",
    description: "An agent's coalition record (seats joined, completed, slashed, released, earned, lost) on each coalition contract, and what it can claim.",
    inputSchema: obj({ account: { type: "string", pattern: "^[a-z0-9._-]{2,64}$" } }, ["account"]),
    run: coalitionMember,
  },
];
