#!/usr/bin/env node
// STAGED, NOT RUN. Panel action 6: one Circle USDC dust settle on mainnet with its liability
// record, the Agent Market listing and one 1Click top-up. Real money: it runs only with BOTH
//   --mainnet --i-have-the-founders-word
// on the command line and BOOKERBOB_MAINNET_GO=<today's date, YYYY-MM-DD> in the environment,
// so a stale or copied command cannot fire later. Without them it prints the plan and exits 3.
// Even with them, this file only prints the near-cli commands for a human to run: it never
// signs a mainnet transaction itself.
const MAINNET_USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

export function gate(argv, env, today = new Date().toISOString().slice(0, 10)) {
  if (!argv.includes("--mainnet")) return "missing --mainnet";
  if (!argv.includes("--i-have-the-founders-word")) return "missing --i-have-the-founders-word (real money: the founder's word only)";
  if (env.BOOKERBOB_MAINNET_GO !== today) return `BOOKERBOB_MAINNET_GO must be today's date (${today}), set when the founder says go`;
  return null;
}

export function plan({ bazaar = "<mainnet bazaar>.near", agent = "<agent>.near", merchant = "<merchant>.near", dust = "100000" } = {}) {
  return [
    `1. deploy the bazaar to ${bazaar} (make wasm; near contract deploy ${bazaar} ... with-init-call new {"owner":"<DAO or key>","usdc":"${MAINNET_USDC}"})`,
    `2. register the issuer, referee, arbiter and World verifier keys (production keys, not the testnet seeds)`,
    `3. ${merchant} registers and is approved; storage_deposit for ${agent} and USDC storage for both`,
    `4. ${agent}: one verdict, the referee receipt, ft_transfer_call ${dust} USDC base units (0.10 USDC) to the bazaar, settle`,
    `5. record the settle tx and its liability record (view liability) in docs/mainnet.md`,
    `6. Agent Market listing for REP Read and the referee (docs/agent-market.md steps 2 and 3, re-read the openapi first)`,
    `7. one 1Click Intents top-up of the agent's escrow from another chain`,
  ];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const no = gate(process.argv.slice(2), process.env);
  console.log("mainnet moment: STAGED. Steps:\n" + plan().map((s) => `   ${s}`).join("\n"));
  if (no) {
    console.error(`\nrefusing to go further: ${no}`);
    process.exit(3);
  }
  console.log("\nGate open. This script still signs nothing: run each step by hand with near-cli, checking every tx before the next.");
}
