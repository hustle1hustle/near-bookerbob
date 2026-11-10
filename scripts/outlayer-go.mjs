#!/usr/bin/env node
// The referee on OutLayer, staged (docs/outlayer.md). Testnet only.
//
//   node scripts/outlayer-go.mjs                 print the plan with the real values; sends nothing
//   node scripts/outlayer-go.mjs --step <id> --i-have-the-founders-word [--referee-key <hex>]
//        [--seal-key <pq1:..>] [--tx <hash>] [--anchor-id <n>]
//                                                run ONE step. Only after the founder's OK, and only
//                                                after the repo is public (the wasm URL).
//
// Without --i-have-the-founders-word nothing leaves this machine: no transaction, no release, no call
// to OutLayer. With it, one named step runs and the script stops; a value a later step needs
// (the key the pubkey run printed, a tx hash) is passed back in by flag, so a person reads each
// result before the next step is sent. Every account must end in .testnet or the script exits.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const NET = "testnet-fastnear";
const SIGNER = "bookerbob.testnet";
const BAZAAR = "bookerbob.testnet";
const MARKET = "market.bookerbob.testnet";
const DAO = "bookerbob-gov.sputnikv2.testnet";
const OPS = "bookerbob-dao-ops.testnet";
const OUTLAYER = "outlayer.testnet";
const API = "https://testnet-api.outlayer.ai";
const REPO = "hustle1hustle/bookerbob-near";
const TAG = "outlayer-referee-v0";
const NAME = "bookerbob-referee";
const PROJECT = `${SIGNER}/${NAME}`;
const ASSET = "bookerbob-referee-outlayer.wasm";
const WASM = `worker/outlayer/target/wasm32-wasip2/release/${ASSET}`;
const URL = `https://github.com/${REPO}/releases/download/${TAG}/${ASSET}`;
const OUT = "worker/outlayer/target/go";
// The contract's own defaults, written out: the worker's event parser has no default for them.
const LIMITS = { max_instructions: 1_000_000_000, max_memory_mb: 128, max_execution_seconds: 60 };

const argv = process.argv.slice(2);
const flag = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
const GO = argv.includes("--i-have-the-founders-word");
const STEP = flag("--step");
const sha = existsSync(WASM) ? createHash("sha256").update(readFileSync(WASM)).digest("hex") : null;
const SHA = sha ?? "<sha256: run worker/outlayer/build.sh>";
const REFEREE = flag("--referee-key") ?? "<referee_key from the pubkey run>";
const SEAL = flag("--seal-key") ?? "<seal_key from the sealkey run>";
const TX = flag("--tx") ?? "<tx hash of the pubkey run>";
const ANCHOR = flag("--anchor-id") ?? "<id from the anchor_queued event>";
const HELLO = createHash("sha256").update("bookerbob outlayer hello-world v0").digest("hex");
const LABEL = `OutLayer referee ${PROJECT} (host key, caller none)`;

for (const a of [SIGNER, BAZAAR, MARKET, DAO, OPS, OUTLAYER]) {
  if (!a.endsWith(".testnet")) {
    console.error(`refusing: ${a} is not a testnet account`);
    process.exit(2);
  }
}

const q = (s) => (/^[A-Za-z0-9_.:\/=@-]+$/.test(s) ? s : `'${s.replaceAll("'", "'\\''")}'`);
const call = (contract, method, args, deposit = "0 NEAR", gas = "100.0 Tgas", signer = SIGNER) => [
  "near", "contract", "call-function", "as-transaction", contract, method, "json-args", JSON.stringify(args),
  "prepaid-gas", gas, "attached-deposit", deposit, "sign-as", signer, "network-config", NET, "sign-with-keychain", "send",
];
const view = (contract, method, args = {}) => ["near", "contract", "call-function", "as-read-only", contract, method, "json-args", JSON.stringify(args), "network-config", NET, "now"];
const run = (input, format = "Json") =>
  call(OUTLAYER, "request_execution", { source: { Project: { project_id: PROJECT, version_key: null } }, resource_limits: LIMITS, input_data: JSON.stringify(input), response_format: format }, "0.05 NEAR", "300.0 Tgas");

const requestArgs = join(OUT, "request-referee-args.json");
/** The fixture referee input, sealed to the key the sealkey run printed; written as the args file of request_referee. */
function sealFixture() {
  const cli = (a) => spawnSync("cargo", ["run", "-q", "-p", "bookerbob-cli", "--", ...a], { encoding: "utf8" });
  mkdirSync(OUT, { recursive: true });
  const input = cli(["worker-input", "fixtures"]);
  if (input.status !== 0) throw new Error(`worker-input: ${input.stderr}`);
  // The fixture nullifier has a live verdict on the bazaar (another digest), so the hello-world
  // names one no verdict has: the callback then reports the result instead of applying it.
  writeFileSync(join(OUT, "input.json"), JSON.stringify({ ...JSON.parse(input.stdout), nullifier: HELLO }));
  const sealed = cli(["seal-input", SEAL, join(OUT, "input.json")]);
  if (sealed.status !== 0) throw new Error(`seal-input: ${sealed.stderr}`);
  writeFileSync(requestArgs, JSON.stringify({ project_id: PROJECT, input_data: sealed.stdout.trim() }));
}

/** One DAO proposal on the market bazaar, voted by c1 and c2 (2 of 3): scripts/market-bazaar.mjs viaDao. */
async function marketProposal() {
  const { keyFromSeed, near, rpcClient, send } = await import("../relayer/near.mjs");
  const keys = process.env.KEYS_DIR || join(process.env.HOME, ".rep-secrets", "bookerbob-testnet");
  const key = (n) => keyFromSeed(readFileSync(join(keys, "dao", `${n}.seed`), "utf8"));
  const client = rpcClient(process.env.NEAR_RPC || "https://test.rpc.fastnear.com");
  const TGAS = 10n ** 12n;
  const fc = (method_name, args, deposit, gas) => ({ type: "FunctionCall", method_name, args, gas: gas * TGAS, deposit });
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
  const kind = {
    FunctionCall: {
      receiver_id: MARKET,
      actions: [
        { method_name: "set_outlayer", args: b64({ outlayer: OUTLAYER }), deposit: "0", gas: String(20n * TGAS) },
        { method_name: "register_referee", args: b64({ key_hex: REFEREE, label: LABEL }), deposit: "0", gas: String(20n * TGAS) },
      ],
    },
  };
  const tx = async (label, who, actions) => {
    const r = await send(client, { signer_id: `${who}.${OPS}`, key: key(who), receiver_id: DAO, actions });
    console.log(`   ${r.ok ? "ok" : "FAILED"} ${label}  https://testnet.nearblocks.io/txns/${r.hash}`);
    if (!r.ok) throw new Error(`${label}: ${r.error}`);
    return r;
  };
  const p = await tx("c1 proposes", "c1", [fc("add_proposal", { proposal: { description: `market bazaar: ${LABEL}`, kind } }, near(1), 50n)]);
  await tx(`c1 votes on ${p.value}`, "c1", [fc("act_proposal", { id: p.value, action: "VoteApprove", proposal: kind }, 0n, 100n)]);
  const v = await tx(`c2 votes on ${p.value}: executes`, "c2", [fc("act_proposal", { id: p.value, action: "VoteApprove", proposal: kind }, 0n, 300n)]);
  const queued = v.logs.map((l) => (l.startsWith("EVENT_JSON:") ? JSON.parse(l.slice(11)) : null)).find((e) => e?.event === "anchor_queued")?.data?.[0];
  console.log(queued ? `   register_referee queued as anchor ${queued.id}, ready at ${new Date(queued.ready_ms).toISOString()}: then --step market-execute --anchor-id ${queued.id}` : "   no anchor_queued event: read the proposal's logs");
}

// kind: local (this machine only), reads (a public read), SENDS (needs the OK).
const steps = [
  { id: "build", kind: "local", what: "build the component; its sha256 is the `hash` of create_project", cmds: [["worker/outlayer/build.sh"], ["make", "outlayer-local"]], note: `sha256 now: ${SHA}` },
  { id: "release", kind: "SENDS", what: "publish the wasm as a release asset of the public repo (GitHub)", cmds: [["gh", "release", "create", TAG, WASM, "--repo", REPO, "--title", "BookerBob referee, OutLayer component", "--notes", `wasm32-wasip2 component of worker/outlayer. sha256 ${SHA}`]], note: `the URL create_project will name: ${URL}` },
  { id: "release-check", kind: "reads", what: "the public URL serves exactly the built bytes", sh: `test "$(curl -sL ${URL} | shasum -a 256 | cut -d' ' -f1)" = ${SHA} && echo same` },
  { id: "project", kind: "SENDS", what: `create the project ${PROJECT} on ${OUTLAYER} (storage deposit, the excess is refunded; undo: delete_project)`, cmds: [call(OUTLAYER, "create_project", { name: NAME, source: { WasmUrl: { url: URL, hash: SHA, build_target: "wasm32-wasip2" } } }, "0.1 NEAR")] },
  { id: "project-check", kind: "reads", what: "the project exists; its active version is the hash; note its uuid (the keys belong to it)", cmds: [view(OUTLAYER, "get_project", { project_id: PROJECT })] },
  { id: "pubkey", kind: "SENDS", what: "one run with {\"cmd\":\"pubkey\"}: the tx result names referee_key, arbiter_key and the seal key, signed by referee_key", cmds: [run({ cmd: "pubkey" })], note: "0.05 NEAR attached, the excess over the run's cost comes back; estimate: 0.0070001 NEAR (fixtures/live/views.json)" },
  { id: "sealkey", kind: "SENDS", what: "one run with {\"cmd\":\"sealkey\"}: the pq1: key (X25519 + ML-KEM-768) a buyer seals to, for calls OutLayer receives from bookerbob.testnet", cmds: [run({ cmd: "sealkey" })] },
  { id: "attest", kind: "reads", what: "the pubkey run's TDX attestation, checked off chain (Intel chain, approved measurements, task hash over input, output and wasm)", cmds: [["cargo", "install", "--git", "https://github.com/out-layer/outlayer-verify", "outlayer-verify"], ["outlayer-verify", "tx", TX, "--network", "testnet", "--bundle", "fixtures/live/outlayer/pubkey-proof.json"]], note: `the record itself: curl -s ${API}/attestations/by-tx/${TX} ; its wasm hash must be ${SHA}` },
  { id: "set-outlayer", kind: "SENDS", what: `${BAZAAR}: point request_referee at ${OUTLAYER}`, cmds: [call(BAZAAR, "set_outlayer", { outlayer: OUTLAYER })] },
  { id: "referee", kind: "SENDS", what: `${BAZAAR}: register the attested key as a referee`, cmds: [call(BAZAAR, "register_referee", { key_hex: REFEREE, label: LABEL })] },
  { id: "referee-check", kind: "reads", what: "the key is among the referees; if anchor_delay is above 0 the change was queued (anchor_queued in the tx logs) and needs execute_anchor after the delay", cmds: [view(BAZAAR, "anchor_delay"), view(BAZAAR, "referees")] },
  { id: "market", kind: "SENDS", what: `${MARKET}: one DAO proposal (${DAO}, c1 proposes, c1 and c2 vote) with set_outlayer and register_referee; the referee change is queued for the 5 minute anchor delay`, fn: marketProposal, show: `node scripts/outlayer-go.mjs --step market --referee-key ${REFEREE} --i-have-the-founders-word` },
  { id: "market-execute", kind: "SENDS", what: `${MARKET}: apply the queued referee change, 300 s after the proposal executed (anyone may)`, cmds: [call(MARKET, "execute_anchor", { id: Number(ANCHOR) || ANCHOR }, "0 NEAR", "50.0 Tgas")], note: `then: ${view(MARKET, "referees").map(q).join(" ")}` },
  {
    id: "request",
    kind: "SENDS",
    what: `${BAZAAR}: one request_referee, the fixture input sealed to the seal key (no plaintext fact in the tx)`,
    pre: sealFixture,
    cmds: [["near", "contract", "call-function", "as-transaction", BAZAAR, "request_referee", "file-args", requestArgs, "prepaid-gas", "300.0 Tgas", "attached-deposit", "0.05 NEAR", "sign-as", SIGNER, "network-config", NET, "sign-with-keychain", "send"]],
    note: `the args file is written first: bookerbob worker-input fixtures, its nullifier replaced by ${HELLO.slice(0, 16)}.. (no verdict has it), sealed with bookerbob seal-input to the seal key. Expected: the bazaar logs referee_failed {reason: "unknown nullifier", outcome: "receipt", output_sha256}: the TEE-signed result came back through the callback and nothing is stored. A receipt a settle consumes needs a fresh purchase whose referee step is request_referee (not written).`,
  },
];

if (!GO) {
  console.log(`outlayer-go: the plan, testnet only. Nothing is sent (no --i-have-the-founders-word).\n`);
  console.log(`project ${PROJECT} on ${OUTLAYER}; signer ${SIGNER} (keychain), network-config ${NET}`);
  console.log(`wasm ${WASM}${sha ? ` (${readFileSync(WASM).length} bytes)` : " (not built)"}\nsha256 ${SHA}\n`);
  steps.forEach((s, i) => {
    console.log(`${String(i + 1).padStart(2)}. [${s.kind === "SENDS" ? "sends: needs the OK" : s.kind}] ${s.id}: ${s.what}`);
    for (const c of s.cmds ?? []) console.log(`      ${c.map(q).join(" ")}`);
    if (s.sh) console.log(`      ${s.sh}`);
    if (s.show) console.log(`      ${s.show}`);
    if (s.note) console.log(`      note: ${s.note}`);
  });
  console.log(`\n15. [local] record: fixtures/live/outlayer/run.json and an "outlayer" block in fixtures/live/testnet-manifest.json (project, uuid, wasm sha256 and URL, referee_key, tx hashes, the proof bundle); make verify-live then re-derives it (docs/outlayer.md "What verify-live should record").`);
  console.log(`\nTo run one step after the OK: node scripts/outlayer-go.mjs --step <id> --i-have-the-founders-word`);
  process.exit(0);
}

const step = steps.find((s) => s.id === STEP);
if (!step) {
  console.error(`--i-have-the-founders-word needs --step <id>, one of: ${steps.map((s) => s.id).join(", ")}`);
  process.exit(2);
}
if (!sha) {
  console.error(`refusing: ${WASM} is not built (worker/outlayer/build.sh)`);
  process.exit(2);
}
const placeholder = JSON.stringify([step.cmds ?? [], step.show ?? ""]).match(/<[a-z_ ]+ (from|of) [^<>]+>/);
if (placeholder || (step.id === "request" && SEAL.startsWith("<"))) {
  console.error(`refusing: step ${step.id} needs a value from an earlier step (${placeholder?.[0] ?? "--seal-key"}); pass it by flag`);
  process.exit(2);
}
if (step.id === "project") {
  // The hash put on chain must be the hash of what the URL serves.
  const got = createHash("sha256").update(Buffer.from(await (await fetch(URL)).arrayBuffer())).digest("hex");
  if (got !== sha) {
    console.error(`refusing: ${URL} serves sha256 ${got}, the local build is ${sha}`);
    process.exit(2);
  }
}
console.log(`outlayer-go: step ${step.id} (${step.kind}), testnet. ${step.what}`);
if (step.pre) step.pre();
if (step.fn) await step.fn();
for (const c of step.cmds ?? []) {
  console.log(`$ ${c.map(q).join(" ")}`);
  const r = spawnSync(c[0], c.slice(1), { stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`step ${step.id} stopped: ${c[0]} exited ${r.status}`);
    process.exit(1);
  }
}
if (step.sh) process.exit(spawnSync("sh", ["-c", step.sh], { stdio: "inherit" }).status ?? 1);
