// Pure helpers for a spend fact read from a notarized reply: the privacy scan of the revealed
// parts and the derived monthly spend. No network, no keys.
/** What must never appear in a presentation we keep or publish (checked on the revealed parts). */
export const FORBIDDEN = [/"email"/i, /@[a-z0-9-]+\.[a-z]{2,}/i, /"name"\s*:/i, /Bearer\s+[A-Za-z0-9._-]{10,}/, /cookie/i, /sessionKey/i, /"address"/i];

/** The fact: the latest paid invoice's total, in whole USD, as `monthly_spend_usd`. */
export function deriveSpend(recv) {
  const invoices = [...recv.matchAll(/"total":([0-9]+)[^{}]*?"status":"([a-z]+)"[^{}]*?"created_ts":([0-9]+)/g)].map((m) => ({ total: Number(m[1]), status: m[2], ts: Number(m[3]) }));
  const paid = invoices.filter((i) => i.status === "paid").sort((a, b) => b.ts - a.ts);
  if (!paid.length) throw new Error("no paid invoice in the revealed transcript");
  return { monthly_spend_usd: Math.floor(paid[0].total / 100), invoices: invoices.length, latest_ts: paid[0].ts };
}

export function privacyProblems(text) {
  return FORBIDDEN.filter((re) => re.test(text)).map((re) => re.source);
}
