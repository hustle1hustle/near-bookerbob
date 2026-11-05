#!/usr/bin/env node
// h05's buyers join its review group through the normal path, so a sealed review round can
// release a second merchant's seed into the standing graph (panel: more than one name in
// in_top). The buyers: the hotel stay (already a member) and the 5 who paid h05 through the
// lisbon-g1 group treasury; each joins with a fresh Semaphore identity, relayed.
//   node scripts/seed-h05.mjs join          then: DEMO_MERCHANT=h05.bookerbob.testnet node
//   scripts/demo-tester.mjs reviews seal | reveal | publish
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config, Demo } from "./demo-tester.mjs";
import { keyFromSeed } from "../relayer/near.mjs";

const c = config({ ...process.env, DEMO_MERCHANT: "h05.bookerbob.testnet" });
const d = new Demo(c);
d.treasury = keyFromSeed(readFileSync(join(c.keysDir, "treasury.seed"), "utf8"));
const m = JSON.parse(readFileSync("fixtures/live/testnet-manifest.json", "utf8"));
const g = m.group_dao;
for (const x of g.members.filter((x) => x.tester !== g.dropout)) {
  const recPath = join(c.testersDir, `h05-member-${x.tester}.json`);
  if (existsSync(recPath)) { console.log(`   skip ${x.tester.split(".")[0]}: joined`); continue; }
  const v = await d.client.view(c.bazaar, "verdict", { nullifier: x.nullifier });
  if (!v?.spent || v.review_joined) { console.log(`   skip ${x.tester.split(".")[0]}: spent ${v?.spent}, joined ${v?.review_joined}`); continue; }
  const tester = { id: x.tester, key: keyFromSeed(readFileSync(join(c.testersDir, x.tester, "account.seed"), "utf8")) };
  const identity = randomBytes(32).toString("hex");
  const secretPath = join(c.testersDir, x.tester, "semaphore.secret");
  if (existsSync(secretPath)) throw new Error(`${x.tester} already has a Semaphore identity`);
  writeFileSync(secretPath, identity + "\n", { mode: 0o600 });
  const commitment = execFileSync("node", ["identity.mjs", "commitment"], { input: identity, cwd: "semaphore", encoding: "utf8" }).trim();
  const j = await d.relay("join_review_group", tester, c.bazaar, { type: "FunctionCall", method_name: "join_review_group", args: { nullifier: x.nullifier, identity_commitment: commitment }, gas: 100n * 10n ** 12n, deposit: 20n * 10n ** 21n });
  const added = j.logs.map((l) => (l.startsWith("EVENT_JSON:") ? JSON.parse(l.slice(11)) : null)).find((e) => e?.event === "review_member_added")?.data?.[0];
  writeFileSync(recPath, JSON.stringify({ tester: x.tester, merchant: c.merchant, nullifier: x.nullifier, txs: { review_join: j.hash }, review: { commitment, size: added?.size, root: added?.root } }, null, 2) + "\n", { mode: 0o600 });
  console.log(`   ok ${x.tester.split(".")[0]} joined h05's group, size ${added?.size}`);
}
console.log(`h05 review persons: ${await d.client.view(c.bazaar, "review_persons", { merchant: c.merchant })}`);
