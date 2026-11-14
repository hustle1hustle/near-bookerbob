#!/usr/bin/env node
// The smith registry on testnet (smith-registry/, docs/smith.md). Testnet only; resumable: every
// tx is recorded in fixtures/live/smith-registry.json and a step that is done is skipped.
//   node scripts/smith-registry.mjs deploy          create smith-registry.<treasury>, deploy, new()
//   node scripts/smith-registry.mjs register <id>   the requester posts the request, the smith registers
//                                                   the program with its TEE signature, the requester accepts
//   node scripts/smith-registry.mjs snapshot        re-read every program into the snapshot
// Keys: seeds in ~/.rep-secrets/bookerbob-testnet (outside the repo, never printed). The coalition
// lead signs its own request with its own key (coalition/cl-lead-*.seed); the smith agent and
// the buyer agent get new accounts with new seeds under smith/.
import * as nodeCrypto from "node:crypto";
import { randomBytes } from "node:crypto";
globalThis.__crypto = nodeCrypto;
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { keyFromSeed, rpcClient, send, near } from "../relayer/near.mjs";
import { sha } from "./lib/e2ee.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(REPO, "fixtures/live/smith-registry.json");
const KEYS = process.env.KEYS_DIR ?? `${process.env.HOME}/.rep-secrets/bookerbob-testnet`;
const TREASURY = process.env.DEMO_TREASURY_ID ?? "bookerbob-demo.testnet";
const RPC = process.env.NEAR_RPC ?? "https://rpc.testnet.near.org";
if (/mainnet/.test(RPC) || !TREASURY.endsWith(".testnet")) (console.error("testnet only"), process.exit(2));
const CONTRACT = process.env.SMITH_REGISTRY ?? `smith-reg.${TREASURY}`;
const SMITH = `smith.${TREASURY}`;
const WINDOW_MS = Number(process.env.SMITH_WINDOW_MS ?? 600_000);
const RESOLVE_MS = Number(process.env.SMITH_RESOLVE_MS ?? 86_400_000);
const BOND = 10n ** 23n; // 0.1 NEAR
const TGAS = 10n ** 12n;
const fc = (method_name, args, deposit = 0n, gas = 50n * TGAS) => ({ type: "FunctionCall", method_name, args, gas, deposit });
const link = (h) => `https://testnet.nearblocks.io/txns/${h}`;
const json = (p) => JSON.parse(readFileSync(p, "utf8"));

const client = rpcClient(RPC);
const out = existsSync(OUT) ? json(OUT) : { note: "The smith registry on testnet: its account, every tx, and each program as get_program returned it.", contract: CONTRACT, smith: SMITH, window_ms: WINDOW_MS, txs: {}, programs: {} };
const save = () => writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");

function seed(name) {
  const dir = join(KEYS, "smith");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${name}.seed`);
  if (!existsSync(p)) writeFileSync(p, randomBytes(32).toString("hex") + "\n", { mode: 0o600 });
  return keyFromSeed(readFileSync(p, "utf8"));
}
const treasury = () => keyFromSeed(readFileSync(join(KEYS, "treasury.seed"), "utf8"));

async function tx(name, signer, key, receiver, actions) {
  if (out.txs[name]) return out.txs[name];
  const r = await send(client, { signer_id: signer, key, receiver_id: receiver, actions });
  console.log(`  ${r.ok ? "ok" : "FAILED"} ${name}  ${link(r.hash)}${r.ok ? "" : `\n  ${r.error}`}`);
  if (!r.ok) throw new Error(`${name}: ${r.error}`);
  out.txs[name] = { hash: r.hash, signer, receiver, at: new Date().toISOString() };
  save();
  return out.txs[name];
}

async function ensureAccount(id, key, amount) {
  if (await client.account(id)) return;
  await tx(`create_${id.split(".")[0]}`, TREASURY, treasury(), id, [{ type: "CreateAccount" }, { type: "Transfer", deposit: near(amount) }, { type: "AddKey", public_key_hex: key.pub, permission: "FullAccess" }]);
}

async function deploy() {
  const ck = seed(CONTRACT);
  await ensureAccount(CONTRACT, ck, 3);
  await ensureAccount(SMITH, seed(SMITH), 1);
  const wasm = join(REPO, "target/near/bookerbob_smith_registry.wasm");
  const code = readFileSync(wasm);
  out.wasm_sha256 = out.wasm_sha256 ?? sha(code);
  if (out.wasm_sha256 !== sha(code)) throw new Error("the wasm changed since the deploy; deploy a new account instead");
  await tx("deploy", CONTRACT, ck, CONTRACT, [{ type: "DeployContract", code }, fc("new", { owner: CONTRACT, smith: SMITH, window_ms: WINDOW_MS, resolve_ms: RESOLVE_MS, bond: BOND.toString() }, 0n, 30n * TGAS)]);
  save();
  console.log(`registry ${CONTRACT}: ${JSON.stringify(await client.view(CONTRACT, "config"))}`);
}

function requesterKey(account) {
  const coalitionSeed = join(KEYS, "coalition", `${account}.seed`);
  if (existsSync(coalitionSeed)) return keyFromSeed(readFileSync(coalitionSeed, "utf8"));
  return seed(account);
}

async function register(id) {
  const spec = json(join(REPO, "zk/smith/specs", `${id}.json`));
  const a = json(join(REPO, "zk/smith/programs", id, "smith/authorship.json"));
  const requester = spec.requester.account;
  const rk = requesterKey(requester);
  await ensureAccount(requester, rk, 0.5);
  await tx(`request_${id}`, requester, rk, CONTRACT, [fc("post_request", { id, spec_hash: a.spec_hash, registrar: null })]);
  // The owner lists the model key only after checking the attempt's report: bound to the nonce
  // the smith sent, naming this key and model. The TDX quote inside is not verified here.
  const attempt = join(REPO, "zk/smith/programs", id, "smith", `attempt-${a.attempt}`);
  const cap = json(join(attempt, "capture.json"));
  const ma = json(join(attempt, "report.json")).model_attestations?.[0];
  if (ma?.request_nonce !== cap.nonce || ma?.signing_address !== a.signing_address || ma?.model_name !== a.model) throw new Error("the report does not bind this key to this model and nonce");
  const keys = (await client.view(CONTRACT, "config")).model_keys ?? [];
  if (!keys.some(([k, m]) => k === a.signing_address && m === a.model)) {
    await tx(`model_key_${a.signing_address.slice(0, 16)}`, CONTRACT, seed(CONTRACT), CONTRACT, [fc("set_model_key", { key: a.signing_address, model: a.model })]);
  }
  await tx(`register_${id}`, SMITH, seed(SMITH), CONTRACT, [
    fc("register_program", {
      request_id: id,
      source_hash: a.source_sha256,
      program_hash: a.program_hash,
      elf_hash: a.elf_sha256,
      model: a.model,
      signing_address: a.signing_address,
      signed_text: a.signed_text,
      signature: a.signature,
      response_hash: a.response_sha256,
    }),
  ]);
  // The requester reran its own vectors (smith-check) before accepting.
  await tx(`accept_${id}`, requester, rk, CONTRACT, [fc("accept", { request_id: id, program_hash: a.program_hash })]);
  await snapshot();
}

/** The zk build of a program: its own request id (<id>-zk), the same spec, source, ELF and TEE
 *  signature, the program hash of the zk verifier preprocessing. */
async function registerZk(id) {
  const a = json(join(REPO, "zk/smith/programs", id, "smith/authorship.json"));
  const z = json(join(REPO, "zk/smith/programs", id, "out-zk/result.json"));
  if (z.elf_sha256 !== a.elf_sha256) throw new Error("the zk build has another ELF");
  const spec = json(join(REPO, "zk/smith/specs", `${id}.json`));
  const requester = spec.requester.account;
  const rk = requesterKey(requester);
  const zid = `${id}-zk`;
  await tx(`request_${zid}`, requester, rk, CONTRACT, [fc("post_request", { id: zid, spec_hash: a.spec_hash, registrar: null })]);
  await tx(`register_${zid}`, SMITH, seed(SMITH), CONTRACT, [
    fc("register_program", { request_id: zid, source_hash: a.source_sha256, program_hash: z.program_hash, elf_hash: z.elf_sha256, model: a.model, signing_address: a.signing_address, signed_text: a.signed_text, signature: a.signature, response_hash: a.response_sha256 }),
  ]);
  await tx(`accept_${zid}`, requester, rk, CONTRACT, [fc("accept", { request_id: zid, program_hash: z.program_hash })]);
  await snapshot();
}

/** After a re-preprocess (same source and ELF, new program hash): supersede, then the requester
 *  accepts again. `id` or `<id>-zk`. */
async function supersedeOne(rid) {
  const base = rid.replace(/-zk$/, "");
  const zk = rid !== base;
  const a = json(join(REPO, "zk/smith/programs", base, "smith/authorship.json"));
  const res = json(join(REPO, "zk/smith/programs", base, zk ? "out-zk/result.json" : "out/result.json"));
  const cur = await client.view(CONTRACT, "get_program", { request_id: rid });
  if (!cur) throw new Error(`${rid} is not registered`);
  if (cur.program_hash === res.program_hash) return console.log(`${rid}: already ${res.program_hash.slice(0, 16)}..`);
  if (cur.source_hash !== a.source_sha256) throw new Error(`${rid}: another source; supersede is only for a rebuild of the same source`);
  const n = Object.keys(out.txs).filter((k) => k.startsWith(`supersede_${rid}_`)).length + 1;
  await tx(`supersede_${rid}_${n}`, SMITH, seed(SMITH), CONTRACT, [fc("supersede", { request_id: rid, program_hash: res.program_hash, elf_hash: res.elf_sha256, reason: process.env.SUPERSEDE_REASON ?? "rebuilt from the same source: vendored dependencies in the build root, pinned Dory URS" })]);
  const spec = json(join(REPO, "zk/smith/specs", `${base}.json`));
  // The requester accepts the new hash by name, after its own check (smith-check) of the new build.
  await tx(`accept_${rid}_${n + 1}`, spec.requester.account, requesterKey(spec.requester.account), CONTRACT, [fc("accept", { request_id: rid, program_hash: res.program_hash })]);
}

async function snapshot() {
  for (const r of await client.view(CONTRACT, "list")) {
    out.programs[r.request.id] = { request: r.request, program: r.program, status_at_snapshot: r.status, read_at: new Date().toISOString() };
  }
  save();
  for (const [id, p] of Object.entries(out.programs)) console.log(`${id}: ${p.status_at_snapshot}, program ${p.program?.program_hash?.slice(0, 16)}.., usable after ${new Date(p.program?.usable_after_ms).toISOString()}`);
}

/** New code on the same account (the state layout is unchanged); every wasm hash is kept. */
async function upgrade() {
  const ck = seed(CONTRACT);
  const code = readFileSync(join(REPO, "target/near/bookerbob_smith_registry.wasm"));
  const h = sha(code);
  out.wasm_history = out.wasm_history ?? [out.wasm_sha256];
  if (out.wasm_sha256 === h) return console.log("already deployed");
  const n = out.wasm_history.length;
  await tx(`upgrade_${n}`, CONTRACT, ck, CONTRACT, [{ type: "DeployContract", code }]);
  out.wasm_history.push(h);
  out.wasm_sha256 = h;
  save();
}

/** sha256 over named files in order, as smith.mjs sourceHash does for a crate. */
function filesHash(files) {
  const { createHash } = globalThis.__crypto;
  const hh = createHash("sha256");
  for (const f of files) {
    const b = readFileSync(join(REPO, f));
    hh.update(`${f}\0${b.length}\0`);
    hh.update(b);
  }
  return hh.digest("hex");
}

async function pin(id) {
  const specPath = join(REPO, "zk/smith/pinned", `${id}.json`);
  const spec = json(specPath);
  const pp = readFileSync(join(REPO, spec.program_hash_of));
  if (sha(pp) !== spec.program_hash) throw new Error("program_hash is not sha256 of the named preprocessing");
  const { canonical } = await import("./smith.mjs");
  await tx(`pin_${id}`, CONTRACT, seed(CONTRACT), CONTRACT, [
    fc("pin_program", { request_id: id, spec_hash: sha(Buffer.from(canonical(spec))), source_hash: filesHash(spec.source_files), program_hash: spec.program_hash, elf_hash: spec.elf_hash, note: `${spec.guest}, Jolt ${spec.jolt.split(" ")[1].slice(0, 9)}` }),
  ]);
  await snapshot();
}

/** The owner lists a verifier key (an OutLayer TEE worker); the evidence is recorded with it. */
async function verifierKey(name, key, evidence) {
  if (!/^[0-9a-f]{64}$/.test(key)) throw new Error("key: 64 lowercase hex");
  await tx(`verifier_key_${name}`, CONTRACT, seed(CONTRACT), CONTRACT, [fc("set_verifier_key", { name, key })]);
  out.verifier_keys = { ...(out.verifier_keys ?? {}), [name]: { key, evidence } };
  save();
}

const [cmd, id, ...rest] = process.argv.slice(2);
if (cmd === "deploy") await deploy();
else if (cmd === "register") await register(id);
else if (cmd === "snapshot") await snapshot();
else if (cmd === "upgrade") await upgrade();
else if (cmd === "pin") await pin(id);
else if (cmd === "register-zk") await registerZk(id);
else if (cmd === "supersede") {
  await supersedeOne(id);
  await snapshot();
}
else if (cmd === "verifier-key") await verifierKey(id, rest[0], rest.slice(1).join(" "));
else (console.error("usage: node scripts/smith-registry.mjs deploy | register <id> | snapshot"), process.exit(2));
