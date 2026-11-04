#!/usr/bin/env node
// `make demo-live`: the demo-offline story, run against a deployed bazaar on testnet.
// Env-driven (see .env.example). Testnet only: it refuses mainnet before doing anything.
//
//   DRY_RUN=1 make demo-live    print every step and what it needs, send nothing
//   make demo-live              run it (needs near-cli-rs and a deployed bazaar)
//
// Steps that need tools are marked; without them the run stops before the first such step
// and prints the install command. Written before near-cli-rs was on the build machine (same
// syntax as scripts/deploy-testnet.sh): do a dry run first and check the first tx by hand.
// Seeds stay in KEYS_DIR. Only signed public artifacts (verdict, World attestation, referee
// result) are written, to KEYS_DIR/live.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const TESTNET_USDC = "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af";
const MAINNET_USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

export function config(env) {
  const bazaar = env.BAZAAR_ACCOUNT_ID || "bookerbob.testnet";
  const keysDir = env.KEYS_DIR || join(homedir(), ".rep-secrets", "bookerbob-testnet");
  return {
    network: env.NEAR_NETWORK || "testnet",
    rpc: env.NEAR_RPC || "https://test.rpc.fastnear.com",
    near: env.NEAR_CLI || "near",
    bazaar,
    agent: env.AGENT_ACCOUNT_ID || `agent.${bazaar}`,
    wallet2: env.WALLET2_ACCOUNT_ID || `wallet2.${bazaar}`,
    usdc: env.USDC_CONTRACT_ID || TESTNET_USDC,
    mpc: env.MPC_SIGNER_ID || "v1.signer-prod.testnet",
    outlayer: env.OUTLAYER_CONTRACT_ID || "outlayer.testnet",
    outlayerProject: env.OUTLAYER_PROJECT || "",
    worldAction: env.WORLD_ACTION || "bookerbob-fixture-action",
    keysDir,
    liveDir: join(keysDir, "live"),
    dryRun: env.DRY_RUN === "1",
  };
}

/** A reason to refuse, or null. Checked before any step, dry run included. */
export function guard(c) {
  if (c.network !== "testnet") return `NEAR_NETWORK=${c.network}: demo-live is testnet only`;
  // rpc.testnet.near.org is deprecated (HTTP 429); fastnear's testnet host is allowed by name.
  if (!/testnet/.test(c.rpc) && !c.rpc.startsWith("https://test.rpc.fastnear.com")) return `RPC ${c.rpc} is not testnet`;
  for (const a of [c.bazaar, c.agent, c.wallet2]) if (!a.endsWith(".testnet")) return `${a} is not a .testnet account`;
  if (c.usdc === MAINNET_USDC) return "USDC_CONTRACT_ID is the mainnet token";
  for (const a of [c.mpc, c.outlayer]) if (a.endsWith(".near")) return `${a} is a mainnet contract`;
  return null;
}

const NEAR_CLI = "near-cli-rs (cargo install --locked near-cli-rs)";
const BOOKERBOB = ["cargo", "run", "-q", "-p", "bookerbob-cli", "--"];

/** The steps, in demo order. Pure: reads nothing from the network or the keys dir. */
// The amount escrowed and settled is the referee receipt's price, read during the run (on
// testnet the cohort is smaller than in the offline board, so the price differs).
const live_state = { price: null, cohortK: 0 };

export function plan(c, price) {
  const amount = () => String(live_state.price ?? price ?? 0);
  const call = (signer, contract, method, args, deposit, gas = "100.0 Tgas") => [
    "contract", "call-function", "as-transaction", contract, method, "json-args", args,
    "prepaid-gas", gas, "attached-deposit", deposit, "sign-as", signer, "network-config", "testnet", "sign-with-keychain", "send",
  ];
  const file = (name) => () => readFileSync(join(c.liveDir, name), "utf8").trim();
  const sub = (acct) => ["account", "create-account", "fund-myself", acct, "0.5 NEAR", "autogenerate-new-keypair", "save-to-keychain", "sign-as", c.bazaar, "network-config", "testnet", "sign-with-keychain", "send"];
  return [
    { id: "board", kind: "local", title: "30 merchant agents bid on the board (same check as demo-offline)", cmd: () => ["make", "-s", "swarm"] },
    { id: "deployed", kind: "view", title: `bazaar ${c.bazaar} is deployed with issuers and merchants`, view: [c.bazaar, "merchants", { from_index: 0, limit: 50 }], needs: ["scripts/deploy-testnet.sh has run"] },
    { id: "sign", kind: "local", title: "sign the purchase verdict and World attestation with the testnet keys", cmd: () => [...BOOKERBOB, "sign-live", c.keysDir, c.agent, c.wallet2, c.worldAction, c.liveDir], needs: [`seeds in ${c.keysDir} (deploy-testnet.sh makes them)`] },
    { id: "agents", kind: "tx", title: `create ${c.agent} and ${c.wallet2}`, near: [sub(c.agent), sub(c.wallet2)], needs: [NEAR_CLI], skipIf: [c.agent, c.wallet2] },
    // A function-call key for the agent, limited to `settle` on the bazaar. NEAR function-call
    // keys cannot attach a deposit, so submit_verdict (pays storage) and withdraw (1 yocto)
    // still need the full-access key; that is the point: this key can only spend escrow on
    // a refereed purchase.
    { id: "fckey", kind: "tx", skipFcKey: true, title: "add a function-call key for the agent: settle only, 0.25 NEAR gas allowance", near: [["account", "add-key", c.agent, "grant-function-call-access", "--allowance", "0.25 NEAR", "--contract-account-id", c.bazaar, "--function-names", "settle", "autogenerate-new-keypair", "save-to-keychain", "network-config", "testnet", "sign-with-keychain", "send"]], needs: [NEAR_CLI] },
    // (skipView: a view that says the step is already done on chain, so a re-run skips it)
    { id: "world", kind: "tx", skipView: [c.bazaar, "is_human", () => ({ agent: c.agent }), (v) => v === true], title: "bind the agent to one World ID person", near: [call(c.agent, c.bazaar, "attest_human", () => `{"attestation":${file("world.json")()}}`, "0.01 NEAR")], needs: [NEAR_CLI] },
    { id: "verdict", kind: "tx", skipView: [c.bazaar, "nullifier_status", () => ({ nullifier: JSON.parse(file("verdict.json")()).envelope.nullifier }), (v) => v !== "Unknown"], title: "submit the verdict: merchants see 3 bits and a commitment", near: [call(c.agent, c.bazaar, "submit_verdict", () => `{"verdict":${file("verdict.json")()}}`, "0.05 NEAR")], needs: [NEAR_CLI] },
    { id: "quote", kind: "view", title: "best hoodie quote on chain", view: [c.bazaar, "best_quote", () => ({ nullifier: JSON.parse(file("verdict.json")()).envelope.nullifier, category: "hoodie" })] },
    { id: "referee", kind: "local", title: "referee checks the winner's claims against the proofs, signs a receipt", cmd: () => [...BOOKERBOB, "worker-input", "fixtures", join(c.liveDir, "verdict.json"), String(live_state.cohortK ?? 0)], then: "worker", needs: [`referee.seed in ${c.keysDir}`] },
    { id: "receipt", kind: "tx", skipView: [c.bazaar, "verdict", () => ({ nullifier: JSON.parse(file("verdict.json")()).envelope.nullifier }), (v) => Boolean(v && v.receipt)], title: "post the signed referee receipt", near: [call(c.agent, c.bazaar, "submit_referee_result", () => `{"result":${file("referee-result.json")()}}`, "0 NEAR")], needs: [NEAR_CLI] },
    { id: "escrow", kind: "tx", title: `escrow ${price ? Number(price) / 1e6 : "the price in"} testnet USDC`, near: [
      call(c.agent, c.bazaar, "storage_deposit", "{}", "0.01 NEAR"),
      call(c.agent, c.usdc, "storage_deposit", `{"account_id":"${c.bazaar}","registration_only":true}`, "0.00125 NEAR"),
      // The agent itself must be registered with the USDC contract to hold and send USDC.
      call(c.agent, c.usdc, "storage_deposit", `{"account_id":"${c.agent}","registration_only":true}`, "0.00125 NEAR"),
      call(c.agent, c.usdc, "ft_transfer_call", () => `{"receiver_id":"${c.bazaar}","amount":"${amount()}","msg":""}`, "1 yoctoNEAR", "100.0 Tgas"),
    ], needs: [NEAR_CLI, `testnet USDC on ${c.agent} (faucet.circle.com, NEAR testnet)`] },
    { id: "settle", kind: "tx", title: "settle: the merchant is paid the receipt price, the nullifier is spent", near: [call(c.agent, c.bazaar, "settle", () => `{"nullifier":"${JSON.parse(file("verdict.json")()).envelope.nullifier}","merchant":"m01.${c.bazaar}","checkout_ref":"demo-live-1","amount":"${amount()}"}`, "0 NEAR", "150.0 Tgas")], needs: [NEAR_CLI] },
    { id: "replay", kind: "tx", title: "same account (same nullifier) from another wallet is refused", near: [call(c.wallet2, c.bazaar, "submit_verdict", () => `{"verdict":${file("verdict-replay.json")()}}`, "0.05 NEAR")], expectFail: "nullifier spent", needs: [NEAR_CLI] },
    { id: "outlayer", kind: "tx", title: "OutLayer runs the same referee in a TEE", needs: [NEAR_CLI, "OUTLAYER_PROJECT (worker for wasm32-wasip2, rustup target add wasm32-wasip2)"], optional: !c.outlayerProject, near: [call(c.bazaar, c.bazaar, "request_referee", () => JSON.stringify({ project_id: c.outlayerProject, input_data: readFileSync(join(c.liveDir, "worker-input.json"), "utf8").trim() }), "0.01 NEAR", "300.0 Tgas")] },
  ];
}

const has = (bin) => spawnSync("sh", ["-c", `command -v "${bin}"`], { stdio: "ignore" }).status === 0;

/** The dry-run report: one line per step, with what it needs. */
export function describe(c, steps, tools) {
  const out = [`demo-live on testnet: bazaar ${c.bazaar}, agent ${c.agent}${c.dryRun ? " (dry run, nothing is sent)" : ""}`];
  for (const [i, s] of steps.entries()) {
    const missing = (s.needs ?? []).filter((n) => (n === NEAR_CLI && !tools.near) || (/seed/.test(n) && !tools.keys));
    // A view can only be checked against the chain, so a dry run never calls it ready.
    const tag = s.optional ? "skip " : missing.length ? "NEEDS" : s.kind === "view" && c.dryRun ? "check" : "ready";
    out.push(`${String(i + 1).padStart(2)}  ${tag}  ${s.kind.padEnd(5)}  ${s.title}`);
    for (const n of s.needs ?? []) out.push(`             needs: ${n}`);
    if (s.near && c.dryRun) for (const a of s.near) out.push(`             + ${c.near} ${a.map((x) => (typeof x === "function" ? `<${s.id} args>` : x)).join(" ")}`);
  }
  return out.join("\n");
}

async function view(c, [account_id, method_name, args]) {
  const a = typeof args === "function" ? args() : args;
  const body = { jsonrpc: "2.0", id: "bookerbob", method: "query", params: { request_type: "call_function", finality: "final", account_id, method_name, args_base64: Buffer.from(JSON.stringify(a)).toString("base64") } };
  const r = await (await fetch(c.rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json();
  if (r.error || r.result?.error) throw new Error(`${method_name}: ${JSON.stringify(r.error ?? r.result.error).slice(0, 200)}`);
  return JSON.parse(Buffer.from(r.result.result).toString() || "null");
}

function run(cmd, opts = {}) {
  const r = spawnSync(cmd[0], cmd.slice(1), { encoding: "utf8", ...opts });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`, stdout: r.stdout ?? "" };
}

async function live(c, steps) {
  for (const [i, s] of steps.entries()) {
    if (s.optional) {
      console.log(`${i + 1}. skip: ${s.title} (${s.needs.at(-1)})`);
      continue;
    }
    console.log(`${i + 1}. ${s.title}`);
    if (s.kind === "view") {
      const v = await view(c, s.view);
      console.log(`   ${JSON.stringify(v).slice(0, 300)}`);
      if (s.id === "deployed" && (!Array.isArray(v) || v.length === 0)) throw new Error("no merchants: run scripts/deploy-testnet.sh first");
      if (s.id === "quote") live_state.cohortK = v?.cohort?.k ?? 0;
      if (s.id === "quote" && s.expect && v?.price !== s.expect.split(" ")[1]) throw new Error(`expected ${s.expect}, got ${JSON.stringify(v)}`);
      continue;
    }
    if (s.kind === "local") {
      let env = process.env;
      if (s.id === "sign") {
        // A verdict already on chain: sign the same envelope again (sign-live sets
        // expires = issued + 7 days, and the record keeps the expiry).
        const fixtureNullifier = JSON.parse(readFileSync("fixtures/verdict-ed25519.json", "utf8")).envelope.nullifier;
        const rec = await view(c, [c.bazaar, "verdict", { nullifier: fixtureNullifier }]).catch(() => null);
        if (rec && rec.expires_at_ms) {
          env = { ...process.env, BOOKERBOB_NOW_MS: String(rec.expires_at_ms - 7 * 24 * 3600 * 1000) };
          console.log("   the verdict is on chain: re-signing the same envelope");
        }
      }
      const r = run(s.cmd(), { env });
      if (!r.ok) throw new Error(`${s.id}: ${r.out.slice(-400)}`);
      if (s.then === "worker") {
        writeFileSync(join(c.liveDir, "worker-input.json"), r.stdout);
        const seed = readFileSync(join(c.keysDir, "referee.seed"), "utf8").trim();
        const w = run(["cargo", "run", "-q", "-p", "bookerbob-referee-worker"], { input: r.stdout, env: { ...process.env, REFEREE_SIGNING_SEED: seed } });
        if (!w.ok) throw new Error(`worker: ${w.out.slice(-400)}`);
        writeFileSync(join(c.liveDir, "referee-result.json"), w.stdout);
        live_state.price = JSON.parse(w.stdout).body.price;
        console.log(`   receipt signed, ${w.stdout.length} bytes, price ${live_state.price}`);
      } else console.log(`   ${r.stdout.trim().split("\n").at(-1)}`);
      continue;
    }
    if (s.skipFcKey && (await hasFunctionCallKey(c, c.agent))) {
      console.log("   skip: the agent already has a function-call key for the bazaar");
      continue;
    }
    if (s.skipView) {
      const [acct, method, args, done] = s.skipView;
      let v;
      try {
        v = await view(c, [acct, method, args]);
      } catch {
        v = undefined;
      }
      if (v !== undefined && done(v)) {
        console.log("   skip: already done on chain");
        continue;
      }
    }
    if (s.skipIf && (await Promise.all(s.skipIf.map((a) => accountExists(c, a)))).every(Boolean)) {
      console.log("   skip: exists");
      continue;
    }
    for (const a of s.near) {
      const args = a.map((x) => (typeof x === "function" ? x() : x));
      const r = run([c.near, ...args]);
      const hash = r.out.match(/Transaction ID: ([1-9A-HJ-NP-Za-km-z]{43,44})/)?.[1];
      if (s.expectFail) {
        if (r.ok || !r.out.includes(s.expectFail)) throw new Error(`${s.id}: expected "${s.expectFail}", got ${r.out.slice(-300)}`);
        console.log(`   refused: ${s.expectFail}${hash ? ` (tx ${hash})` : ""}`);
      } else {
        if (!r.ok) throw new Error(`${s.id}: ${r.out.slice(-400)}`);
        console.log(`   ok${hash ? ` tx ${hash} https://testnet.nearblocks.io/txns/${hash}` : ""}`);
      }
    }
  }
}

async function hasFunctionCallKey(c, account_id) {
  const body = { jsonrpc: "2.0", id: "bookerbob", method: "query", params: { request_type: "view_access_key_list", finality: "final", account_id } };
  const r = await (await fetch(c.rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json();
  return (r.result?.keys ?? []).some((k) => k.access_key?.permission?.FunctionCall?.receiver_id === c.bazaar);
}

async function accountExists(c, account_id) {
  const body = { jsonrpc: "2.0", id: "bookerbob", method: "query", params: { request_type: "view_account", finality: "final", account_id } };
  const r = await (await fetch(c.rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json();
  return Boolean(r.result);
}

export function hoodiePrice(board) {
  const cat = board.categories?.find((x) => x.category === "hoodie");
  return cat?.rows?.[0]?.price;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const c = config(process.env);
  const no = guard(c);
  if (no) {
    console.error(`refusing: ${no}`);
    process.exit(2);
  }
  const board = existsSync("agents/board.json") ? JSON.parse(readFileSync("agents/board.json", "utf8")) : {};
  const steps = plan(c, hoodiePrice(board));
  // Existence checks only: no seed is read before the live run needs it.
  const tools = { near: has(c.near), keys: existsSync(join(c.keysDir, "issuer.seed")) && existsSync(join(c.keysDir, "referee.seed")) };
  console.log(describe(c, steps, tools));
  if (c.dryRun) process.exit(0);
  if (!tools.near || !tools.keys) {
    if (!tools.keys) console.error(`\nstopped: no seeds in ${c.keysDir}. Run scripts/deploy-testnet.sh first.`);
    if (!tools.near) console.error("\nstopped: near-cli-rs is not installed (cargo install --locked near-cli-rs). DRY_RUN=1 shows every command.");
    process.exit(3);
  }
  mkdirSync(c.liveDir, { recursive: true });
  console.log();
  live(c, steps).then(
    () => console.log("\ndemo-live: PASS"),
    (e) => {
      console.error(`\ndemo-live: FAIL ${e.message}`);
      process.exit(1);
    },
  );
}
