// L10: which bit sets give a settled amount under a public schedule (scripts/leak.mjs).
import { quote } from "../sdk/merchant.mjs";

const subsets = (xs) => xs.reduce((all, x) => all.concat(all.map((s) => [...s, x])), [[]]);

/** Every subset of the schedule's rule predicates, with and without the group unlock. */
export function decodeAmount(s, paid, returningBps = 0) {
  const all = subsets(s.rules.map((r) => r.predicate));
  const ks = s.cohort ? [0, s.cohort.k_min] : [0];
  const sets = new Map();
  for (const bits of all) for (const k of ks) {
    const price = quote(s, bits, () => k).price;
    if (String(price) === String(paid)) sets.set(JSON.stringify(bits), bits);
    // Buy Twice adds one more public bit: a price can also say "returning customer".
    if (returningBps && String(price - (price * BigInt(returningBps)) / 10000n) === String(paid)) sets.set(JSON.stringify([...bits, "returning"]), [...bits, "returning"]);
  }
  return { sets: [...sets.values()], of: all.length };
}
