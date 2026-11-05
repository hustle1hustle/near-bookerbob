#!/usr/bin/env node
// `make one-flow`: one buyer's path through every outside system, on one screen. Each leg says
// LIVE (it ran now, against the real service or chain) or DRY (what would be sent, and why it
// was not). Nothing here moves money; the testnet purchases themselves are `make demo-tester`,
// `make model-buy` and `make try`.
//
//   1. NEAR AI: the facts sealed to the model key registered on bookerbob.testnet (E2EE v2); the
//      model derives the predicates; its TEE signature is checked. LIVE (about $0.001 of credit).
//   2. OutLayer: request_referee with the referee input sealed to the worker's post-quantum key.
//      DRY: no OutLayer project is registered on the bazaar yet (docs/outlayer.md).
//   3. Settle with the function-call key: the agent's settle-only key, read from chain, and the
//      calls it was refused. LIVE (chain read).
//   4. 1Click: a top-up of a buying group's escrow from Base USDC. LIVE read of the supported
//      assets; the quote itself is DRY (a keyless dry quote was refused; mainnet is gated).
//   5. Agent Market: a competition job for the referee, checked against the live OpenAPI spec's
//      required fields. LIVE read of the spec; the post is DRY (mainnet only, needs a token).
//
// ONE_FLOW_DRY=1 makes every leg DRY (no NEAR AI call).
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { rpcClient } from "../relayer/near.mjs";

const BAZAAR = "bookerbob.testnet";
const client = rpcClient(process.env.NEAR_RPC || "https://test.rpc.fastnear.com");
const keysDir = process.env.KEYS_DIR || `${process.env.HOME}/.rep-secrets/bookerbob-testnet`;
const allDry = process.env.ONE_FLOW_DRY === "1";
const legs = [];
const leg = (n, mode, what, detail) => {
  legs.push({ n, mode, what });
  console.log(`${String(n).padEnd(2)} ${mode.padEnd(4)}  ${what}\n        ${detail}\n`);
};
const cli = (args, opts = {}) => execFileSync("cargo", ["run", "-q", "-p", "bookerbob-cli", "--", ...args], { encoding: "utf8", ...opts }).trim();

console.log("make one-flow: one buyer, every outside system, each leg LIVE or DRY\n");

// 1. NEAR AI
try {
  if (allDry) throw new Error("ONE_FLOW_DRY=1");
  const { issue } = await import("./model-buy.mjs");
  const base = JSON.parse(readFileSync("fixtures/verdict-ed25519.json", "utf8")).envelope;
  const { record } = await issue(client, BAZAAR, base, "fixtures/proofs.json", keysDir);
  leg(1, "LIVE", `NEAR AI ${record.model}: a verdict under E2EE v2, the facts sealed to the registered key`, `chat ${record.chat_id.slice(0, 12)}.., attested ${record.attested.join(", ")}; TEE signature over both wire hashes valid; no tx sent (make model-buy sends one)`);
} catch (e) {
  leg(1, "DRY", "NEAR AI: a verdict under E2EE v2", `not run: ${e.message.slice(0, 120)}`);
}

// 2. OutLayer
{
  const pub = cli(["referee-pub", keysDir]);
  const dir = join(keysDir, "one-flow");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, "input.json"), cli(["worker-input", "fixtures"]), { mode: 0o600 });
  const sealed = cli(["seal-input", pub, join(dir, "input.json")]);
  const v = JSON.parse(sealed).sealed;
  leg(2, "DRY", "OutLayer: request_referee, the referee input sealed to the worker key (X25519 + ML-KEM-768)", `would send ${sealed.length} bytes (v${v.v}, kem_ct ${v.kem_ct?.length / 2} bytes, no plaintext fact): near contract call-function as-transaction ${BAZAAR} request_referee json-args '{"project_id":"<owner>/bookerbob-referee","input_data":"<sealed>"}' ...; not sent: no OutLayer project registered on the bazaar (docs/outlayer.md, needs the founder)`);
}

// 3. the function-call key
{
  const m = JSON.parse(readFileSync("fixtures/live/testnet-manifest.json", "utf8"));
  const fck = m.fc_key_check;
  const keys = await client.rpc("query", { request_type: "view_access_key_list", finality: "final", account_id: fck.tester });
  const fc = (keys.result?.keys ?? []).map((k) => k.access_key.permission).find((p) => p.FunctionCall)?.FunctionCall;
  leg(3, fc ? "LIVE" : "DRY", `settle with the agent's function-call key (${fck.tester.split(".")[0]})`, fc ? `on chain now: receiver ${fc.receiver_id}, methods ${fc.method_names.join(", ")}, allowance ${fc.allowance ?? "none"}; refused when it tried: ${fck.refusals.map((r) => `${r.method} (${r.error.replace(/[{}"]/g, "").slice(0, 30)})`).join(", ")}` : "the key is no longer on chain");
}

// 4. 1Click
{
  const tokens = await fetch("https://1click.chaindefuser.com/v0/tokens", { signal: AbortSignal.timeout(15000) }).then((r) => r.json()).catch(() => null);
  const usdc = (tokens ?? []).find((t) => t.assetId === "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1");
  const base = (tokens ?? []).find((t) => t.assetId === "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near");
  const req = { dry: true, swapType: "EXACT_INPUT", originAsset: base?.assetId, destinationAsset: usdc?.assetId, amount: "36000000", recipient: "<group escrow on mainnet>", recipientType: "DESTINATION_CHAIN" };
  leg(4, "DRY", "1Click: top up a buying group's escrow from Base USDC into NEAR USDC", `${tokens ? `LIVE read: 1Click lists ${tokens.length} assets, NEAR USDC ${usdc ? "supported" : "missing"}, Base USDC ${base ? "supported" : "missing"}` : "the 1Click token list did not answer"}; the quote ${JSON.stringify(req).slice(0, 160)}.. is not sent: a keyless dry quote got "Quoting for this pair is not available" from 1Click (2026-11-05; an API key was not tried), and the top-up is mainnet (gated on the founder's word, scripts/mainnet-moment.mjs)`);
}

// 5. Agent Market
{
  const spec = await fetch("https://market.near.ai/openapi.json", { signal: AbortSignal.timeout(15000) }).then((r) => r.json()).catch(() => null);
  const s = spec?.components?.schemas?.CreateCompetitionRequest;
  const job = { title: "Referee a BookerBob purchase", description: "Check that every fact a merchant claim cites is in the buyer's proof set; return the signed receipt or refusal (worker/, docs/outlayer.md).", poolAmount: "5", poolToken: "USDC", entriesCloseAt: new Date(Date.now() + 7 * 86_400_000).toISOString(), tags: ["near", "verification"] };
  const missing = (s?.required ?? []).filter((k) => !(k in job));
  leg(5, "DRY", "Agent Market: a competition job for the referee", `${spec ? `LIVE read: market.near.ai OpenAPI ${spec.info?.version}, CreateCompetitionRequest requires ${s?.required?.join(", ")}; the manifest has ${missing.length ? `NOT ${missing.join(", ")}` : "all of them"}` : "the spec did not answer"}; not posted: Agent Market is mainnet only and needs a registered agent token (docs/agent-market.md)`);
}

const live = legs.filter((l) => l.mode === "LIVE").length;
console.log(`one-flow: ${live} LIVE, ${legs.length - live} DRY of ${legs.length} legs. The DRY legs name what they wait for.`);
