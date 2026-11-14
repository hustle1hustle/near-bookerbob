#!/usr/bin/env node
// Offline re-check of every registered smith program and its proof (docs/smith.md). No keys, no
// network, no Rust: node 22 and the committed files. Folded into `make judge`.
//   node scripts/smith-check.mjs            every program in agents/smith/index.json
//   node scripts/smith-check.mjs --live     the registry and job C re-read over public RPC
//
// Per program:
//   proof       the generic wasm verifier accepts the committed proof for the statement, the
//               chain binding holds (job C's seats), and every changed statement is refused
//   authorship  the TEE signature verifies over "<model>:<sha256 request>:<sha256 response>", the
//               wire bytes hash to it, the report is bound to the smith's nonce and names the key;
//               the disclosed keys open the request (it is the prompt rebuilt from the spec) and the
//               answer (its ```rust block is body.rs byte for byte)
//   source      the six template files are the template rendered for this spec, types.rs is
//               generated from the spec, body.rs passes the lint (the same wasm), the source hash
//   registry    the testnet registry holds the same spec, source and program hashes and signature
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { edVerify, openField, sha } from "./lib/e2ee.mjs";
import { verifyStatement, tamperings, chainView } from "../agents/smith/verify.mjs";
import { loadSpec, specHash, sourceHash, staticCheck, typesRs, prompt, renderTemplate } from "./smith.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const PUB = join(REPO, "agents/smith");
const LIVE = process.argv.includes("--live");
const REGISTRY_SNAPSHOT = join(REPO, "fixtures/live/smith-registry.json");
const json = (p) => JSON.parse(readFileSync(p, "utf8"));

let bad = 0;
const line = (ok, what) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}`);
  if (!ok) bad++;
  return ok;
};

async function rpcView(account, method, args) {
  for (let i = 0; i < 4; i++) {
    const r = await fetch(process.env.NEAR_RPC ?? "https://test.rpc.fastnear.com", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "call_function", finality: "final", account_id: account, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") } }),
    });
    if (r.status === 429 || r.status >= 500) {
      await new Promise((s) => setTimeout(s, 1500 * (i + 1)));
      continue;
    }
    const j = await r.json();
    if (j.error || j.result?.error) throw new Error(JSON.stringify(j.error ?? j.result.error).slice(0, 200));
    return JSON.parse(Buffer.from(j.result.result).toString());
  }
  throw new Error("RPC kept failing");
}

const module = await WebAssembly.compile(gunzipSync(readFileSync(join(PUB, "verifier.wasm.gz"))));
// The lint wasm is the build of zk/smith/lint at the recorded source hash.
{
  const lj = json(join(PUB, "lint.json"));
  const h = createHash("sha256");
  for (const f of lj.source_files) {
    const b = readFileSync(join(REPO, f));
    h.update(`${f}\0${b.length}\0`);
    h.update(b);
  }
  line(h.digest("hex") === lj.source_sha256 && sha(readFileSync(join(PUB, "lint.wasm"))) === lj.wasm_sha256, `lint.wasm (${lj.wasm_sha256.slice(0, 12)}..) is the recorded build of zk/smith/lint at source ${lj.source_sha256.slice(0, 12)}..`);
}
const moduleZk = existsSync(join(PUB, "verifier-zk.wasm.gz")) ? await WebAssembly.compile(gunzipSync(readFileSync(join(PUB, "verifier-zk.wasm.gz")))) : null;
const index = json(join(PUB, "index.json"));
const registry = existsSync(REGISTRY_SNAPSHOT) ? json(REGISTRY_SNAPSHOT) : null;

for (const { id } of index.programs) {
  const d = join(PUB, id);
  const spec = json(join(d, "spec.json"));
  const statement = json(join(d, "statement.json"));
  const pp = readFileSync(join(d, "verifier.bin"));
  const proof = readFileSync(join(d, "proof.bin"));
  console.log(`-- ${id} (requested by ${spec.requester.role}, ${spec.requester.account})`);

  // proof, with the chain binding from the committed snapshot (or live)
  const snapshotView = existsSync(join(d, "chain-view.json")) ? json(join(d, "chain-view.json")) : null;
  const view = chainView({ snapshot: snapshotView, offline: !LIVE, rpc: process.env.NEAR_RPC ?? "https://test.rpc.fastnear.com" }).view;
  const r = await verifyStatement({ module, spec, statement, pp, proof, view });
  for (const l of r.lines) line(l.ok, `${id}: ${l.what}${/chain|seats_root|payouts/.test(l.what) ? (LIVE ? " (live)" : " (snapshot)") : ""}`);
  for (const [label, s] of tamperings(spec, statement)) {
    const t = await verifyStatement({ module, spec, statement: s, pp, proof, view });
    line(!t.ok, `${id}: refused, ${label}`);
  }

  // the zk build (Jolt's zk feature, its own program hash): the zk verifier accepts it, the
  // transparent verifier refuses it by its protocol tag, and changed statements are refused
  if (existsSync(join(d, "zk/statement.json"))) {
    const zst = json(join(d, "zk/statement.json"));
    const zpp = readFileSync(join(d, "zk/verifier.bin"));
    const zproof = readFileSync(join(d, "zk/proof.bin"));
    // The zk proof is over a holder's own input: its private commitment and public root must not be
    // those of the published test vector (whose private input is in the spec).
    const fresh = zst.mode === "zk" && zst.spec_hash === statement.spec_hash && zst.private_commitment !== statement.private_commitment && zst.public_hex !== statement.public_hex;
    line(fresh, `${id} (zk): a holder's statement under the same spec, over a private input that is not the published test vector`);
    const zr = await verifyStatement({ module: moduleZk, spec, statement: zst, pp: zpp, proof: zproof, view });
    for (const l of zr.lines) line(l.ok, `${id} (zk): ${l.what}`);
    const cross = await verifyStatement({ module, spec, statement: zst, pp: zpp, proof: zproof, view });
    const tag = cross.lines.find((l) => /Jolt proof/.test(l.what));
    line(!cross.ok && /ProtocolConfigMismatch \{ expected: JoltProtocolConfig \{ zk: Transparent/.test(tag?.what ?? ""), `${id} (zk): the transparent verifier refuses it: ProtocolConfigMismatch, it expected zk: Transparent`);
    for (const [label, s] of tamperings(spec, zst)) {
      const t = await verifyStatement({ module: moduleZk, spec, statement: s, pp: zpp, proof: zproof, view });
      line(!t.ok, `${id} (zk): refused, ${label}`);
    }
    const zreg = registry?.programs?.[`${id}-zk`];
    line(zreg?.program?.program_hash === zst.program_hash && zreg?.program?.source_hash === json(join(d, "authorship.json")).source_sha256, `${id} (zk): registry snapshot holds it as ${id}-zk with the same source hash`);
  }

  // authorship
  const a = json(join(d, "authorship.json"));
  const attempt = join(REPO, "zk/smith/programs", id, "smith", `attempt-${a.attempt}`);
  const cap = json(join(attempt, "capture.json"));
  line(edVerify(a.signed_text, a.signature, a.signing_address), `${id}: the TEE key ${a.signing_address.slice(0, 16)}.. signed "${a.model}:<request>:<response>"`);
  const [model, sReq, sRes] = a.signed_text.split(":");
  const reqBytes = readFileSync(join(attempt, "request.json"));
  const resBytes = readFileSync(join(attempt, "response.json"));
  line(model === a.model && sReq === sha(reqBytes) && sRes === sha(resBytes) && sRes === a.response_sha256, `${id}: the signed hashes are the request and response wire bytes`);
  const ma = json(join(attempt, "report.json")).model_attestations?.[0];
  line(ma?.signing_address === a.signing_address && ma?.request_nonce === cap.nonce && ma?.model_name === a.model && sha(readFileSync(join(attempt, "report.json"))) === a.report_sha256, `${id}: the attestation report is bound to the smith's nonce and names this key and model (its TDX quote is not re-verified here)`);
  const req = JSON.parse(reqBytes);
  const sys = openField(req.messages[0].content, Buffer.from(cap.request_keys.system, "hex"));
  const usr = openField(req.messages[1].content, Buffer.from(cap.request_keys.user, "hex"));
  const fresh = prompt(loadSpec(id), null);
  line(sys === fresh.system && (a.attempt === 1 ? usr === fresh.user : usr.startsWith(fresh.user)), `${id}: the sealed request opens to the prompt rebuilt from the spec${a.attempt > 1 ? " (plus the checker's feedback)" : ""}`);
  const answer = openField(JSON.parse(resBytes).choices[0].message.content, Buffer.from(cap.response_key, "hex"));
  const body = readFileSync(join(d, "body.rs"), "utf8");
  const rust = answer.match(/```rust\s*\n([\s\S]*?)```/)?.[1];
  line(rust !== undefined && rust.trimEnd() + "\n" === body, `${id}: the signed answer's code is body.rs byte for byte (${body.split("\n").length - 1} lines)`);

  // source
  const crate = join(REPO, "zk/smith/programs", id);
  const problems = await staticCheck(body);
  line(problems.length === 0, `${id}: body.rs passes the lint${problems.length ? `: ${problems.join("; ")}` : ""}`);
  const rendered = renderTemplate(spec);
  const same = Object.entries(rendered).every(([f, c]) => readFileSync(join(crate, f), "utf8") === c);
  line(same && readFileSync(join(crate, "body/src/types.rs"), "utf8") === typesRs(spec) && readFileSync(join(crate, "body/src/body.rs"), "utf8") === body, `${id}: every other file is the template rendered for this spec, types.rs is generated from it`);
  line(sourceHash(id) === a.source_sha256 && specHash(loadSpec(id)) === statement.spec_hash && sha(Buffer.from(body)) === a.body_sha256, `${id}: source hash ${a.source_sha256.slice(0, 16)}.. over the crate's eight files`);
  line(a.program_hash === statement.program_hash && json(join(d, "result.json")).elf_sha256 === a.elf_sha256, `${id}: authorship, statement and build name the same program hash and ELF`);
  const urs = json(join(d, "result.json")).urs ?? {};
  const pinned = Object.fromEntries(readFileSync(join(REPO, "zk/smith/urs/SHA256SUMS"), "utf8").trim().split("\n").map((l) => l.split(/\s+/)).map(([h, f]) => [f, h]));
  line(Object.keys(urs).length > 0 && Object.entries(urs).every(([f, h]) => pinned[f] === h && sha(readFileSync(join(REPO, "zk/smith/urs", f))) === h), `${id}: built with the pinned Dory URS (${Object.entries(urs).map(([f, h]) => `${f} ${h.slice(0, 12)}..`).join(", ")}), part of the program hash`);
  const rb = existsSync(join(REPO, "zk/smith/rebuild.json")) ? json(join(REPO, "zk/smith/rebuild.json")).rows.find((r) => r.id === id) : null;
  line(rb?.ok && rb.program_hash === statement.program_hash, `${id}: zk/smith/rebuild.json records a rebuild with an empty guest target dir giving this program hash (rerun: node scripts/smith.mjs rebuild)`);

  // registry
  const reg = registry?.programs?.[id];
  if (reg) {
    line(reg.program.program_hash === statement.program_hash && reg.program.source_hash === a.source_sha256 && reg.request.spec_hash === statement.spec_hash && reg.program.signature === a.signature && reg.program.signing_address === a.signing_address, `${id}: registry snapshot (${registry.contract}) holds these spec, source and program hashes and the TEE signature`);
    if (LIVE) {
      const p = await rpcView(registry.contract, "get_program", { request_id: id });
      const q = await rpcView(registry.contract, "get_request", { id });
      const st = await rpcView(registry.contract, "status", { request_id: id });
      line(p?.program_hash === statement.program_hash && p?.source_hash === a.source_sha256 && q?.spec_hash === statement.spec_hash, `${id}: live registry read: program ${p?.program_hash?.slice(0, 16)}.., status ${st}`);
    }
  } else line(false, `${id}: no registry snapshot entry (fixtures/live/smith-registry.json)`);
}

// Live: every registry tx in the snapshot succeeded on chain (the archival host serves old txs).
if (LIVE && registry) {
  let ok = 0;
  const all = Object.entries(registry.txs);
  for (const [name, t] of all) {
    // Recent txs are on the regular node; older ones on the archive. Back off on 429.
    let r = { error: "no answer" };
    const hosts = [process.env.NEAR_RPC ?? "https://test.rpc.fastnear.com", process.env.NEAR_ARCHIVAL_RPC ?? "https://archival-rpc.testnet.fastnear.com"];
    for (let i = 0; i < 8; i++) {
      r = await fetch(hosts[i % 2], { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tx", params: { tx_hash: t.hash, sender_account_id: t.signer, wait_until: "NONE" } }) }).then((x) => (x.status === 429 ? { error: { code: -429 } } : x.json())).catch((e) => ({ error: String(e) }));
      if (r.result) break;
      await new Promise((x) => setTimeout(x, 1500 * (i + 1)));
    }
    const res = r.result;
    const failure = res && JSON.stringify([res.status?.Failure, ...[res.transaction_outcome, ...(res.receipts_outcome ?? [])].map((o) => o?.outcome?.status?.Failure)].filter(Boolean));
    const failed = !res || failure !== "[]";
    // A tx recorded with expect_failure must fail, with that reason (a refused forgery).
    const asExpected = t.expect_failure ? res && failed && failure.includes(t.expect_failure) : !failed;
    if (asExpected) ok++;
    else line(false, `registry tx ${name} ${t.hash}: ${r.error ? JSON.stringify(r.error).slice(0, 100) : t.expect_failure ? "did not fail as expected" : "failed on chain"}`);
    await new Promise((x) => setTimeout(x, 1200));
  }
  line(ok === all.length, `registry ${registry.contract}: ${ok} of ${all.length} txs as recorded on chain (deploy, requests, registrations, model keys, accepts, pins, OutLayer-signed uses; the forged reject refused)`);
}

console.log(bad ? `FAIL  smith: ${bad} checks failed` : `PASS  smith: ${index.programs.length} program(s), proofs, authorship and sources`);
process.exit(bad ? 1 : 0);
