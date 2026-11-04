#!/usr/bin/env node
// STAGED. `node sdk/buy.mjs "2 nights Lisbon under 450"`: you are the buyer. Parses the ask
// into a category and a budget, then runs one demo purchase: locally with the demo keys, or
// through a hosted relayer (BOOKERBOB_RELAYER_URL, which exists only once the founder OKs
// hosting it). Testnet only; dUSDC is a testnet demo token with no value.
import { spawnSync } from "node:child_process";

export function parseAsk(text) {
  const t = text.toLowerCase();
  const budget = Number(t.match(/under\s+\$?(\d+(?:\.\d+)?)/)?.[1] ?? NaN);
  const category = /lisbon|hotel|night/.test(t) ? "hotel-lisbon" : /hoodie|shirt|merch/.test(t) ? "hoodie" : null;
  const nights = Number(t.match(/(\d+)\s+nights?/)?.[1] ?? 1);
  if (!category) throw new Error("say what you want: a hotel in Lisbon or a hoodie");
  return { category, budget: Number.isFinite(budget) ? budget : null, nights };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const ask = parseAsk(process.argv.slice(2).join(" "));
  console.log(`ask: ${JSON.stringify(ask)}`);
  if (process.env.BOOKERBOB_RELAYER_URL) {
    const r = await fetch(`${process.env.BOOKERBOB_RELAYER_URL}/buy`, { method: "POST" });
    console.log(JSON.stringify(await r.json(), null, 2));
  } else {
    // The demo purchase is the hoodie flow today; the hotel category runs through the same
    // contract calls once a hotel buyer fixture exists.
    const r = spawnSync("node", ["scripts/demo-tester.mjs", "run"], { stdio: "inherit" });
    process.exit(r.status ?? 1);
  }
}
