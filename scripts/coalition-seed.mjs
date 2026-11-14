#!/usr/bin/env node
// Purchases from one merchant through the normal demo path (scripts/demo-tester.mjs), so the
// merchant gets a review group of paying buyers and, after a released sealed-review round, a seed
// in the standing graph (docs/coalitions.md, "Standing rises").
//
//   node scripts/coalition-seed.mjs buy <merchant> [n]   n demo testers buy from <merchant>; each
//                                                         joins its review group
//   then: DEMO_MERCHANT=<merchant> node scripts/demo-tester.mjs reviews seal | reveal | publish
//
// Testnet only. A fixtures dir with the one merchant makes the referee price that merchant (as
// the hotel run does). Public parts go to fixtures/live/coalition/seed-<name>.json; seeds stay in
// KEYS_DIR/testers.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Demo, config } from "./demo-tester.mjs";

/** A purchase from `merchant` by a fresh demo tester; returns its public record. */
export async function buyFrom(merchant, env = process.env, opts = {}) {
  // opts.testersDir: buyers kept apart from KEYS_DIR/testers (a coalition job's named agents, as the
  // swarm keeps its buyers), so they do not count against the public demo's daily cap.
  const c = { ...config({ ...env, SHOPIFY_ENV_FILE: "/nonexistent" }), merchant, ...(opts.testersDir && { testersDir: opts.testersDir }) };
  const all = [...JSON.parse(readFileSync("fixtures/merchants.json", "utf8")), ...JSON.parse(readFileSync("agents/merchants.json", "utf8"))];
  const m = all.find((x) => x.account === merchant);
  if (!m) throw new Error(`${merchant} is not a known merchant`);
  const fx = join(c.testersDir, `fixtures-${merchant.split(".")[0]}`);
  mkdirSync(fx, { recursive: true });
  writeFileSync(join(fx, "merchants.json"), JSON.stringify([{ account: m.account, label: m.label ?? m.persona, category: m.category, schedule: m.schedule }], null, 2) + "\n");
  for (const f of ["proofs.json", "claims-honest.json"]) copyFileSync(join("fixtures", f), join(fx, f));
  const d = new Demo(c);
  const hotel = m.category === "hotel-lisbon";
  if (hotel) process.env.BOOKERBOB_MAX_SPEND = "450000000";
  try {
    const rec = await d.run({ fixturesDir: fx, ...(hotel && { mint: 500_000_000 }), ...opts });
    return { tester: rec.tester, merchant, nullifier: rec.nullifier, price: String(rec.price), txs: rec.txs, review_size: rec.review?.size };
  } finally {
    delete process.env.BOOKERBOB_MAX_SPEND;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, merchant, n] = process.argv.slice(2);
  if (cmd !== "buy" || !merchant?.endsWith(".testnet")) {
    console.error("usage: coalition-seed.mjs buy <merchant>.testnet [n]");
    process.exit(2);
  }
  const out = `fixtures/live/coalition/seed-${merchant.split(".")[0]}.json`;
  mkdirSync("fixtures/live/coalition", { recursive: true });
  const rec = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : { merchant, purchases: [] };
  for (let i = 0; i < Number(n ?? 1); i++) {
    console.log(`\n=== purchase ${i + 1} of ${n ?? 1} from ${merchant}`);
    rec.purchases.push(await buyFrom(merchant));
    writeFileSync(out, JSON.stringify(rec, null, 2) + "\n");
  }
  console.log(`\ncoalition-seed: ${rec.purchases.length} purchases from ${merchant} recorded in ${out}`);
}
