#!/usr/bin/env node
// `make rep-is-evil`: if REP turned malicious, what each key it holds could do. For every key,
// read live over public RPC that the contracts trust it today, then say the worst case, what
// limits it, and which offline check shows the power (the same code path, on fixtures).
// Read-only: views only, no keys used, no transactions.
import { rpcClient } from "../relayer/near.mjs";

const client = rpcClient(process.env.NEAR_RPC || "https://test.rpc.fastnear.com");
const LIVE = "bookerbob.testnet";
const MARKET = "market.bookerbob.testnet";
const SPIKE = "spike.bookerbob.testnet";
const view = (a, m, args = {}) => client.view(a, m, args).catch(() => null);
const fullKeys = async (a) => {
  const r = await client.rpc("query", { request_type: "view_access_key_list", finality: "final", account_id: a }).catch(() => null);
  return (r?.result?.keys ?? []).filter((k) => k.access_key.permission === "FullAccess").length;
};

export const KEYS = [
  {
    key: "the verdict issuer (testnet issuer seed)",
    live: async () => `${(await view(LIVE, "issuers"))?.length ?? "?"} issuer keys registered on ${LIVE}`,
    worst: "signs a verdict with any predicates for an agent it controls: a sybil buyer takes discounts it never earned",
    limits: "one agent per World person (attest_human), the referee refuses claims the proof set does not back, the per-context nullifier is spent once; a merchant with an eval gate takes only a verdict a NEAR AI model issued, which this key cannot sign (make model-buy); but REP also holds the World verifier key",
    shown: "make verify checks 10 and 13 (a registered enclave key's verdict is accepted) and 12 (one agent per World person); make eval-gate (an issuer-key verdict refused by a gated merchant, live)",
  },
  {
    key: "the World ID verifier (testnet world seed)",
    live: async () => `World verifier registered on ${LIVE} (placeholder action)`,
    worst: "binds any number of agents as distinct humans: the one-person-one-agent rule and the k >= 5 floors stop meaning people",
    limits: "nothing on chain: the contract trusts the service key; the live World ID service is not wired",
    shown: "make verify check 11 (attestations signed by the registered verifier key bind agents)",
  },
  {
    key: "the referee and Jolt worker (testnet referee seed)",
    live: async () => `${(await view(LIVE, "referees"))?.length ?? "?"} referee key; worker bond ${JSON.stringify((await view(LIVE, "worker_bond", { worker_key: (await view(LIVE, "referees"))?.[0]?.[0] }))?.[1] ?? "?")}`,
    worst: "signs a receipt for an unproven claim, or a false standing list",
    limits: "the price must be one the schedule's code produces; a standing update waits out a challenge window and a false one slashes the bond; but the arbiter is REP's too",
    shown: "make verify checks 19 to 23 (a forged receipt overturned by the arbiter, settle blocked)",
  },
  {
    key: "the dispute arbiter (testnet arbiter seed)",
    live: async () => `arbiter threshold ${await view(LIVE, "arbiter_threshold")} on ${LIVE}`,
    worst: "together with the referee: a false receipt stands, a false standing update is upheld",
    limits: "none outside REP today; a threshold of distinct arbiters is built (2 of 3 in tests) and needs outside operators",
    shown: "make verify check 22 and the 2-of-3 threshold contract tests",
  },
  {
    key: "the nullifier key (HMAC under a REP key)",
    live: async () => `${await view(LIVE, "spent_count")} nullifiers spent on ${LIVE}; each is an HMAC REP can recompute`,
    worst: "links one person's verdicts and purchases across contexts, which the per-context nullifier is meant to prevent",
    limits: "none yet; VOPRF nullifiers are chosen, not built",
    shown: "docs/leak.md (what a REP-side observer links), cli/src/fixtures.rs nullifier()",
  },
  {
    key: "the owner and full-access key of bookerbob.testnet",
    live: async () => `${await fullKeys(LIVE)} full-access key on ${LIVE}; anchor delay ${await view(LIVE, "anchor_delay")} ms`,
    worst: "redeploys any code: every rule above, the escrow and the payouts",
    limits: `none on ${LIVE} (the "before" exhibit); on ${MARKET} the owner is a 2-of-3 DAO with a 5-minute public delay, and its key is deleted at the lock`,
    shown: "make no-owner",
  },
  {
    key: `the market's temporary full-access key (${MARKET})`,
    live: async () => `${await fullKeys(MARKET)} full-access key on ${MARKET} (0 after the lock)`,
    worst: "until the lock: redeploys the DAO-owned market",
    limits: "the lock deletes it; after that only DAO-voted, publicly delayed changes",
    shown: "make no-owner, node scripts/market-bazaar.mjs lock",
  },
  {
    key: `the quote verifier's full-access key (${SPIKE})`,
    live: async () => `${await fullKeys(SPIKE)} full-access key on ${SPIKE}; both bazaars require it for model keys (${await view(LIVE, "quote_verifier")})`,
    worst: "until the lock: replaces the verifier with one that passes any quote, so a rogue model key could register",
    limits: "the lock deletes it; the TDX checks themselves are Intel-signed collateral checked on chain",
    shown: "tools/dcap-spike/README.md (a tampered quote fails at finalize)",
  },
  {
    key: "the REP notary (MPC-TLS, Fly, key 02114d7e)",
    live: async () => "not a contract key: verified off chain against the pinned notary key",
    worst: "signs a presentation for a TLS session that never happened: a fake fact behind a real-looking proof",
    limits: "none cryptographic today (one key, not attested); the facts in this repo are synthetic anyway",
    shown: "README, Post-quantum and trust tables (\"notary not attested\")",
  },
  {
    key: "the REP Eval issuer (separate key)",
    live: async () => "registered as an issuer; signs eval certificates only",
    worst: "certifies a score no run produced",
    limits: "anyone re-checks: every answer's NEAR AI TEE signature and the correct vector are public (make eval-verify)",
    shown: "make eval-verify",
  },
];

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log("if REP turned malicious: every key REP holds, read live where it can be\n");
  for (const k of KEYS) {
    let live;
    try {
      live = await k.live();
    } catch {
      live = "(public RPC unreachable)";
    }
    console.log(`${k.key}\n  live:    ${live}\n  worst:   ${k.worst}\n  limits:  ${k.limits}\n  shown:   ${k.shown}\n`);
  }
  console.log("Every row is REP's to fix by giving the key away: outside arbiters, an attested referee key on OutLayer, VOPRF nullifiers, the live World ID service, the lock.");
}
