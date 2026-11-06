// L10: which bit sets give a settled amount under a public schedule (scripts/leak.mjs).
import { quote } from "../sdk/merchant.mjs";

const subsets = (xs) => xs.reduce((all, x) => all.concat(all.map((s) => [...s, x])), [[]]);

/** Every subset of the schedule's rule predicates, with and without the group unlock. */
export function decodeAmount(s, paid) {
  const all = subsets(s.rules.map((r) => r.predicate));
  const ks = s.cohort ? [0, s.cohort.k_min] : [0];
  const sets = new Map();
  for (const bits of all) for (const k of ks) {
    if (String(quote(s, bits, () => k).price) === String(paid)) sets.set(JSON.stringify(bits), bits);
  }
  return { sets: [...sets.values()], of: all.length };
}
