// The agent reputation tools (mcp/reputation.mjs) over stdio, against a local fake NEAR RPC that
// serves the live testnet values (bookerbob.testnet's proven standing, the smith registry, the
// coalition contract). No network. The Jolt proof is checked for real by the wasm verifier.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { opens, inTopRule, GRAPH_CONTEXT, validateSpec, specHash, topPct } from "./reputation.mjs";

const LIVE = {
  standing_root: ["3b5db5e91745e01e7cc6b9dcfda9ddf2bd6341c9a9bd32bcfa350985f0df3a01", 3, "121dc8dd70a6fef8b2cab4f59e9762a3cf41aabb706411c66caaa74a08d5295d", "7f1bf041fef4c7bd32257e7ba2d8ef431df605b3dc991a0c3913a65432bee530"],
  graph_root: ["7f1bf041fef4c7bd32257e7ba2d8ef431df605b3dc991a0c3913a65432bee530", 10],
  graph_program: "c780ceabae4decfa59703a9988ab2483313c6c1d2f15c7c0ad8fc60255a5c3a5",
};
const spec = (id) => JSON.parse(readFileSync(new URL(`./fixtures/${id}.json`, import.meta.url), "utf8"));
// v3: `announced` is a list; an empty one is a seat with nothing announced yet.
const V3_JOB = { id: 0, buyer: "b.testnet", buyers: [], legs: [{ category: "hoodie", max_price: "48000000" }, { category: "hotel-lisbon", max_price: "450000000" }], seats: [{ member: "m01.bookerbob.testnet", price: "48000000", pending: false, announced: [], delivered: null }, { member: "h05.bookerbob.testnet", price: "450000000", pending: false, announced: ["bb".repeat(32)], delivered: null }], bond: "5000000", budget: "20000000", funded: true, min_top_pct: 100, deadline_ms: 1, status: "failed" };
const OPEN_JOB = { id: 0, buyer: "b.testnet", buyers: [], legs: [{ category: "hoodie", max_price: "48000000" }, { category: "hotel-lisbon", max_price: "450000000" }], seats: [null, { member: "h05.bookerbob.testnet", price: "420000000", pending: false, announced: "aa".repeat(32), delivered: null }], bond: "5000000", budget: "20000000", funded: true, min_top_pct: 50, deadline_ms: 1, status: "open" };

async function fakeRpc(over = {}) {
  const seen = [];
  const srv = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const b = JSON.parse(raw);
    const { account_id: acct, method_name: m } = b.params;
    const args = JSON.parse(Buffer.from(b.params.args_base64, "base64").toString());
    seen.push({ acct, m, args });
    const live = { ...LIVE, ...over };
    let value = null;
    if (acct === "bookerbob.testnet") {
      if (m === "in_top") {
        // The contract's rule (contract/src/lib.rs in_top): n matches, the path opens, the rank fits.
        const [root, n] = live.standing_root;
        value = args.proof.n === n && inTopRule(args.proof.rank, args.proof.n, args.pct) && opens(root, GRAPH_CONTEXT, args.proof);
      } else value = live[m];
    } else if (acct === "smith-reg.bookerbob-demo.testnet") {
      if (m === "status") value = args.request_id === "spend-bucket" ? "usable" : "none";
      if (m === "get_request") value = args.id === "spend-bucket" ? { id: "spend-bucket", spec_hash: specHash(spec("spend-bucket")) } : null;
      if (m === "get_program") value = { program_hash: "ab".repeat(32) };
    } else if (acct === "coalition.bookerbob-demo.testnet") {
      if (m === "job") value = [{ id: 0, status: "failed", seats: [] }, { id: 1, status: "complete", seats: [] }, { id: 2, status: "failed", seats: [] }][args.job] ?? null;
      if (m === "member") value = { joined: 2, completed: 2, slashed: 0, earned: "8493537", lost: "0" };
      if (m === "claimable_of") return res.end(JSON.stringify({ jsonrpc: "2.0", id: b.id, result: { block_height: 7, error: "wasm execution failed with error: MethodResolveError(MethodNotFound)", logs: [] } }));
    } else if (acct === "coalition-v3.bookerbob-demo.testnet") {
      if (m === "job") value = [V3_JOB][args.job] ?? null;
      if (m === "member") value = { joined: 2, completed: 1, slashed: 0, released: 1, earned: "1927710", lost: "0" };
      if (m === "claimable_of") value = "0";
    } else if (acct === "coalition-v2.bookerbob-demo.testnet") {
      if (m === "job") value = [OPEN_JOB][args.job] ?? null;
      if (m === "member") value = { joined: 1, completed: 1, slashed: 0, released: 0, earned: "3942255", lost: "0" };
      if (m === "claimable_of") value = "0";
    }
    res.end(JSON.stringify({ jsonrpc: "2.0", id: b.id, result: { block_height: 7, result: [...Buffer.from(JSON.stringify(value))] } }));
  });
  srv.listen(0, "127.0.0.1");
  await once(srv, "listening");
  return { srv, seen, url: `http://127.0.0.1:${srv.address().port}` };
}

function client(env) {
  const p = spawn(process.execPath, [new URL("./rep-read.mjs", import.meta.url).pathname], { env: { ...process.env, BAZAAR_ACCOUNT_ID: "bookerbob.testnet", ...env } });
  let buf = "";
  const waiting = new Map();
  p.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const m = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      waiting.get(m.id)?.(m);
    }
  });
  let n = 0;
  const call = (method, params) =>
    new Promise((ok) => {
      const id = ++n;
      waiting.set(id, ok);
      p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  const tool = async (name, args) => {
    const r = await call("tools/call", { name, arguments: args });
    return { isError: r.result.isError, out: r.result.isError ? r.result.content[0].text : JSON.parse(r.result.content[0].text) };
  };
  return { call, tool, close: () => p.kill() };
}

async function withServer(over, fn) {
  const rpc = await fakeRpc(over);
  const c = client({ NEAR_RPC: rpc.url });
  try {
    await fn(c, rpc);
  } finally {
    c.close();
    rpc.srv.close();
  }
}

const statement = () => JSON.parse(readFileSync(new URL("../agents/standing/statement.json", import.meta.url), "utf8"));
const data = () => JSON.parse(readFileSync(new URL("./standing-live.json", import.meta.url), "utf8"));
const hex = (bytes) => Buffer.from(bytes).toString("hex");
const hire = (a, b) => {
  const s = (x) => { const n = Buffer.alloc(4); n.writeUInt32LE(x.length); return Buffer.concat([n, Buffer.from(x)]); };
  return hex(Buffer.concat([Buffer.from([1]), s(a), s(b)]));
};

test("the six reputation tools are listed next to the bazaar views", async () => {
  await withServer({}, async (c) => {
    const names = (await c.call("tools/list", {})).result.tools.map((t) => t.name);
    for (const t of ["get_standing", "verify_standing", "commission_check", "coalition_open_jobs", "coalition_job", "coalition_member"]) assert.ok(names.includes(t), t);
    assert.ok(names.includes("nullifier_status") && names.includes("buy"));
  });
});

test("the committed openings are the live tree: every one opens to bookerbob.testnet's standing root", () => {
  const d = data();
  assert.equal(d.standing_root, LIVE.standing_root[0]);
  assert.equal(d.n, LIVE.standing_root[1]);
  for (const e of d.entries) assert.ok(opens(d.standing_root, GRAPH_CONTEXT, e), e.merchant);
  assert.deepEqual(d.entries.map((e) => [e.merchant, e.rank]), [["m01.bookerbob.testnet", 1], ["h05.bookerbob.testnet", 2], ["m02.bookerbob.testnet", 3]]);
  assert.deepEqual([topPct(1, 3), topPct(2, 3), topPct(3, 3)], [1, 34, 67]);
  for (const [r, n] of [[1, 3], [2, 3], [3, 3], [5, 7], [1, 1]]) assert.ok(inTopRule(r, n, topPct(r, n)) && (topPct(r, n) === 1 || !inTopRule(r, n, topPct(r, n) - 1)));
});

test("get_standing: rank, score, opening and the proof reference; an unranked account and a moved root say so", async () => {
  await withServer({}, async (c) => {
    const { isError, out } = await c.tool("get_standing", { account: "h05.bookerbob.testnet" });
    assert.equal(isError, false);
    assert.equal(out.found, true);
    assert.equal(out.rank, 2);
    assert.equal(out.n, 3);
    assert.equal(out.score, 3.81);
    assert.equal(out.top_pct, 34);
    assert.deepEqual(out.checks, { opening_opens_to_live_root: true, score_opens_its_commitment: true });
    assert.equal(out.proof.program_hash, LIVE.graph_program);
    assert.equal(out.proof.program_matches_committed_proof, true);
    assert.equal(out.proof.finalize_tx, "GSkXViv8a2Ho1K5iPxNZe9iwhHk9UjNbLZpSqeyn8MhR");
    assert.equal(out.proof.proof_sha256, "5619f62dcf9d94b41c74cd67b9b0e8cf5fffc0583eb8bb7ed4acb9c1b59454d1");
    const none = await c.tool("get_standing", { account: "nobody.testnet" });
    assert.equal(none.out.found, false);
    assert.match(none.out.reason, /not in the proven standing tree/);
  });
  await withServer({ standing_root: ["ee".repeat(32), 4, "11".repeat(32), "22".repeat(32)] }, async (c) => {
    const { out } = await c.tool("get_standing", { account: "h05.bookerbob.testnet" });
    assert.equal(out.found, false);
    assert.match(out.reason, /rebuild with node mcp\/standing-data.mjs/);
  });
});

test("verify_standing accepts the live claim: the Jolt proof, the live roots, the opening and the contract's in_top", async () => {
  await withServer({}, async (c, rpc) => {
    const { out } = await c.tool("verify_standing", { account: "h05.bookerbob.testnet" });
    assert.equal(out.verdict, "accept", JSON.stringify(out.reasons));
    assert.equal(out.rank, 2);
    assert.deepEqual(out.in_top, { pct: 34, contract_says: true, block_height: 7 });
    assert.ok(out.checks.find((x) => x.name.startsWith("Jolt proof verifies")).ok);
    assert.ok(rpc.seen.some((s) => s.m === "in_top" && s.args.pct === 34 && s.args.proof.merchant === "h05.bookerbob.testnet"));
  });
});

test("verify_standing refuses a forged proof: one bit flipped", async () => {
  await withServer({}, async (c) => {
    const proof = Buffer.from(readFileSync(new URL("../agents/standing/proof.bin", import.meta.url)));
    proof[proof.length >> 1] ^= 1;
    const { out } = await c.tool("verify_standing", { account: "h05.bookerbob.testnet", proof_base64: proof.toString("base64") });
    assert.equal(out.verdict, "reject");
    assert.ok(out.reasons.some((r) => r.startsWith("Jolt proof verifies")), JSON.stringify(out.reasons));
    assert.ok(!out.reasons.some((r) => r.includes("trap")), "a trap is not a refusal");
  });
});

test("verify_standing refuses a forged statement: a sybil ring added, a claimed root changed", async () => {
  await withServer({}, async (c) => {
    const s = statement();
    s.events.push(hire("s1.sybil.testnet", "s2.sybil.testnet"), hire("s2.sybil.testnet", "s1.sybil.testnet"));
    const a = await c.tool("verify_standing", { statement: s });
    assert.equal(a.out.verdict, "reject");
    assert.ok(a.out.reasons.some((r) => r.startsWith("Jolt proof verifies")));
    const t = statement();
    t.root = "00".repeat(32);
    const b = await c.tool("verify_standing", { statement: t });
    assert.equal(b.out.verdict, "reject");
    assert.ok(b.out.reasons.some((r) => r.startsWith("Jolt proof verifies")));
    assert.ok(b.out.reasons.some((r) => r.startsWith("the statement's graph root is the chain's")));
  });
});

test("verify_standing refuses a forged opening (a better rank claimed) and a pct the rank does not reach", async () => {
  await withServer({}, async (c) => {
    const e = data().entries.find((x) => x.merchant === "h05.bookerbob.testnet");
    const forged = { merchant: e.merchant, rank: 1, n: e.n, score_commit: e.score_commit, path: e.path };
    const a = await c.tool("verify_standing", { account: e.merchant, opening: forged, pct: 1 });
    assert.equal(a.out.verdict, "reject");
    assert.ok(a.out.reasons.some((r) => r.includes("opens to the live standing root")));
    assert.ok(a.out.reasons.some((r) => r.includes("in_top(pct=1)")));
    const other = await c.tool("verify_standing", { account: "m02.bookerbob.testnet", opening: { ...e } });
    assert.ok(other.out.reasons.some((r) => r.startsWith("the opening is the asked account's")));
    const b = await c.tool("verify_standing", { account: "m02.bookerbob.testnet", pct: 50 });
    assert.equal(b.out.verdict, "reject");
    assert.deepEqual(b.out.reasons, ["contract bookerbob.testnet.in_top(pct=50): returned false"]);
  });
});

test("verify_standing rejects when the chain has moved past the proven root", async () => {
  await withServer({ graph_root: ["99".repeat(32), 12], standing_root: ["ee".repeat(32), 3, LIVE.standing_root[2], "99".repeat(32)] }, async (c) => {
    const { out } = await c.tool("verify_standing", { account: "h05.bookerbob.testnet" });
    assert.equal(out.verdict, "reject");
    assert.ok(out.reasons.some((r) => r.startsWith("the statement's graph root is the chain's")));
    assert.ok(out.reasons.some((r) => r.includes("has an opening in the live standing tree")));
  });
});

test("commission_check: the smith's spec hash, the unsigned post_request, the registry status; bad specs refused with reasons", async () => {
  // The hashes scripts/smith.mjs (the smith's tree) gives for the same two specs.
  assert.equal(specHash(spec("spend-bucket")), "7c6350d9082b6af1616754b5117467f0ab96b8592d05cec7213ea7cd73a9a58f");
  assert.equal(specHash(spec("coalition-k-of-n")), "7d92675f839e4acd5b305440d30e2e0e258e70294c050d51bc5b2a0b837d7fc9");
  assert.deepEqual(validateSpec(spec("coalition-k-of-n")), []);
  const bad = (change) => { const s = spec("spend-bucket"); change(s); return validateSpec(s); };
  assert.match(bad((s) => { s.private = s.private.filter(([f]) => f !== "salt"); }).join(), /salt: bytes32/);
  assert.match(bad((s) => { s.public.push(["x", "f64"]); }).join(), /type not allowed: f64/);
  assert.match(bad((s) => { s.public.push(["type", "u8"]); }).join(), /field name not allowed/);
  assert.match(bad((s) => { s.types.Output = [["a", "u8"]]; }).join(), /reserved/);
  assert.match(bad((s) => { s.public.push(["r", "vec<Missing>"]); }).join(), /type not allowed: vec<Missing>/);
  assert.match(bad((s) => { s.id = "Spend Bucket"; }).join(), /^id:/);
  assert.match(bad((s) => { delete s.limits.max_trace; }).join(), /limits.max_trace/);

  await withServer({}, async (c, rpc) => {
    const { out } = await c.tool("commission_check", { spec: spec("spend-bucket") });
    assert.equal(out.spec.valid, true);
    assert.equal(out.request.receiver_id, "smith-reg.bookerbob-demo.testnet");
    assert.equal(out.request.signer_id, "buyer-agent.bookerbob-demo.testnet");
    assert.deepEqual(out.request.actions[0].FunctionCall.args, { id: "spend-bucket", spec_hash: specHash(spec("spend-bucket")), registrar: null });
    assert.equal(out.registry_status.status, "usable");
    assert.equal(out.registry_status.spec_hash_matches, true);
    assert.ok(rpc.seen.every((s) => ["status", "get_request", "get_program"].includes(s.m)), "views only");
    const r = await c.tool("commission_check", { spec: { ...spec("spend-bucket"), privacy: "yes" } });
    assert.equal(r.out.spec.valid, false);
    assert.equal(r.out.request, undefined);
    const s = await c.tool("commission_check", { request_id: "never-posted" });
    assert.equal(s.out.registry_status.status, "none");
    const e = await c.tool("commission_check", {});
    assert.equal(e.isError, true);
  });
});

test("coalitions: open jobs across v3, v2 and v1 with each leg's seat; one job; a member's record on both", async () => {
  await withServer({}, async (c) => {
    const { out } = await c.tool("coalition_open_jobs", {});
    assert.deepEqual(out.contracts.map((x) => [x.contract, x.jobs_read]), [["coalition-v3.bookerbob-demo.testnet", 1], ["coalition-v2.bookerbob-demo.testnet", 1], ["coalition.bookerbob-demo.testnet", 3]]);
    assert.deepEqual(out.open.map((j) => [j.contract, j.id, j.seats_open, j.min_top_pct, j.legs.map((l) => l.seat)]), [["coalition-v2.bookerbob-demo.testnet", 0, [0], 50, ["open", "announced"]]]);
    assert.deepEqual(out.contracts[2].closed.map((j) => j.status), ["failed", "complete", "failed"]);
    const v3 = await c.tool("coalition_job", { id: 0 });
    assert.equal(v3.out.contract, "coalition-v3.bookerbob-demo.testnet");
    assert.deepEqual(v3.out.seats.map((x) => x.state), ["seated", "announced"]);
    const v2 = await c.tool("coalition_job", { id: 0, contract: "coalition-v2.bookerbob-demo.testnet" });
    assert.equal(v2.out.contract, "coalition-v2.bookerbob-demo.testnet");
    assert.deepEqual(v2.out.seats.map((x) => x.state), ["open", "announced"]);
    const v1 = await c.tool("coalition_job", { id: 1, contract: "coalition.bookerbob-demo.testnet" });
    assert.equal(v1.out.job.status, "complete");
    assert.equal((await c.tool("coalition_job", { id: 0, contract: "evil.testnet" })).isError, true);
    assert.equal((await c.tool("coalition_job", { id: -1 })).isError, true);
    const m = await c.tool("coalition_member", { account: "m01.bookerbob.testnet" });
    assert.deepEqual(m.out.coalitions.map((x) => [x.contract, x.record.completed, x.claimable]), [["coalition-v3.bookerbob-demo.testnet", 1, "0"], ["coalition-v2.bookerbob-demo.testnet", 1, "0"], ["coalition.bookerbob-demo.testnet", 2, null]]);
  });
});

test("verify_standing with no account and no opening rejects; non-object or unknown arguments are refused before any tool runs", async () => {
  await withServer({}, async (c, rpc) => {
    const { out } = await c.tool("verify_standing", {});
    assert.equal(out.verdict, "reject");
    assert.equal(out.rank, null);
    assert.ok(out.reasons.some((r) => r.startsWith("an account or an opening to check")));
    const before = rpc.seen.length;
    for (const [args, msg] of [
      ["h05.bookerbob.testnet", /arguments must be an object/],
      [[1], /arguments must be an object/],
      [{ account: "h05.bookerbob.testnet", extra: 1 }, /unknown argument: extra/],
      [{ account: 5 }, /account must be a string/],
      [{ account: "H05;rm" }, /account does not match/],
      [{ account: "h05.bookerbob.testnet", pct: 0 }, /pct must be at least 1/],
      [{ account: "h05.bookerbob.testnet", pct: 2.5 }, /pct must be an integer/],
    ]) {
      const r = await c.call("tools/call", { name: "verify_standing", arguments: args });
      assert.equal(r.result.isError, true, JSON.stringify(args));
      assert.match(r.result.content[0].text, msg);
    }
    const m = await c.call("tools/call", { name: "coalition_open_jobs", arguments: { max: 500 } });
    assert.match(m.result.content[0].text, /max must be at most 200/);
    const g = await c.call("tools/call", { name: "get_standing", arguments: {} });
    assert.match(g.result.content[0].text, /account is required/);
    assert.equal(rpc.seen.length, before, "nothing was read for a refused call");
  });
});

test("commission_check refuses a shell injection in the registrar, the requester or the request id; the command line holds only allowed characters", async () => {
  const INJECT = "x' ; touch /tmp/pwned ; echo '";
  await withServer({}, async (c) => {
    const a = await c.call("tools/call", { name: "commission_check", arguments: { spec: spec("spend-bucket"), registrar: INJECT } });
    assert.equal(a.result.isError, true);
    assert.match(a.result.content[0].text, /registrar does not match/);
    const s = spec("spend-bucket");
    s.requester.account = INJECT;
    const b = await c.tool("commission_check", { spec: s });
    assert.equal(b.out.spec.valid, false);
    assert.equal(b.out.request, undefined);
    const r = await c.call("tools/call", { name: "commission_check", arguments: { request_id: INJECT } });
    assert.equal(r.result.isError, true);
    const ok = await c.tool("commission_check", { spec: spec("spend-bucket"), registrar: "smith.bookerbob-demo.testnet" });
    assert.match(ok.out.request.near_cli, /^near contract call-function as-transaction [a-z0-9._-]+ post_request json-args '\{"id":"[a-z0-9-]+","spec_hash":"[0-9a-f]{64}","registrar":"[a-z0-9._-]+"\}' prepaid-gas '50 Tgas' attached-deposit '0 NEAR' sign-as [a-z0-9._-]+ network-config testnet$/);
  });
  // The library entry refuses it too, without the server's schema in front.
  const { commissionCheck } = await import("./reputation.mjs");
  await assert.rejects(commissionCheck({ spec: spec("spend-bucket"), registrar: INJECT }), /registrar/);
});

test("verify_standing rejects when the chain's standing program differs from the committed proof's", async () => {
  await withServer({ graph_program: "ab".repeat(32) }, async (c) => {
    const { out } = await c.tool("verify_standing", { account: "h05.bookerbob.testnet" });
    assert.equal(out.verdict, "reject");
    assert.ok(out.reasons.some((r) => r.startsWith("the chain's standing program is the program of the committed proof")));
  });
});
