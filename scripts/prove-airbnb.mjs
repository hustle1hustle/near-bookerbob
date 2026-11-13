#!/usr/bin/env node
// node scripts/prove-airbnb.mjs : the founder's Airbnb trip count, proved from the Mac through the
// REP notary (MPC-TLS), like make prove-me. Input: the PastTripsV2Query request copied from his
// logged-in browser as cURL (on the clipboard, read once). It is sent as a POST so the userId sits
// in the hidden body, not in the request line the presentation reveals. Only "totalCount":N in the
// reply is revealed. The session file (cookies) lives in a 600 file for the run and is deleted
// after; nothing of it is printed or written to the repo. The presentation goes to KEYS_DIR/zktls.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

// REP's prover (prior work; not in the public copy): PROVE_ME_BIN, or prove-me on PATH.
const PROVE_ME = process.env.PROVE_ME_BIN || "prove-me";
const VERIFY = "tools/verify-presentation/target/release/verify-presentation";
const KEY = "02114d7e15cb2a93ad88997af3394d00008dae381b601f31379d638de492ab25ef";
const REVEAL = '"totalCount":\\s*[0-9]+';

/** Split a "Copy as cURL" command into url, headers and cookies (bash quoting as Chromium writes it). */
export function parseCurl(s) {
  const toks = [];
  const re = /'((?:[^'\\]|\\.|'\\'')*)'|"((?:[^"\\]|\\.)*)"|\$'((?:[^'\\]|\\.)*)'|(\S+)/g;
  for (const m of s.replace(/\\\r?\n/g, " ").matchAll(re)) toks.push((m[1] ?? m[2] ?? m[3] ?? m[4]).replace(/'\\''/g, "'"));
  let url = null; const headers = []; let body = null;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t === "-H" || t === "--header") { const h = toks[++i]; const k = h.indexOf(":"); headers.push([h.slice(0, k).trim(), h.slice(k + 1).trim()]); }
    else if (t === "-b" || t === "--cookie") headers.push(["Cookie", toks[++i]]);
    else if (t === "--data-raw" || t === "--data" || t === "-d") body = toks[++i];
    else if (/^https?:\/\//.test(t)) url = t;
  }
  return { url, headers, body };
}

/** The same GraphQL query as a POST: the variables (the userId) move into the body. */
export function asPost({ url, headers, body: copied }) {
  const u = new URL(url);
  if (u.hostname !== "www.airbnb.com" || !u.pathname.startsWith("/api/v3/PastTripsV2Query")) throw new Error("not the PastTripsV2Query request: copy that one");
  // Copied as a GET, the variables are in the query; copied as a POST, they are already in the body.
  const body = u.searchParams.has("variables") ? JSON.stringify({ operationName: "PastTripsV2Query", variables: JSON.parse(u.searchParams.get("variables")), extensions: JSON.parse(u.searchParams.get("extensions")) }) : copied;
  if (!body) throw new Error("no variables in the copied request");
  const line = new URL(u.origin + u.pathname);
  for (const k of ["operationName", "locale", "currency"]) if (u.searchParams.has(k)) line.searchParams.set(k, u.searchParams.get(k));
  const keep = headers.filter(([n]) => !/^(accept-encoding|content-length|content-type|host|priority|sec-fetch-|sec-ch-|upgrade-insecure)/i.test(n));
  return { url: line.toString(), method: "POST", headers: [...keep, ["Content-Type", "application/json"]], body, reveal: REVEAL };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const curl = process.env.CURL_FILE ? (await import("node:fs")).readFileSync(process.env.CURL_FILE, "utf8") : execFileSync("pbpaste", { encoding: "utf8" });
  const spec = asPost(parseCurl(curl));
  if (/userId|VXNlcj/.test(spec.url)) throw new Error("the request line would carry the userId");
  const dir = mkdtempSync(join(tmpdir(), "prove-airbnb-"));
  const specFile = join(dir, "spec.json");
  const out = join(process.env.KEYS_DIR ?? join(homedir(), ".rep-secrets", "bookerbob-testnet"), "zktls", `airbnb-${Date.now()}.presentation`);
  try {
    writeFileSync(specFile, JSON.stringify(spec), { mode: 0o600 });
    console.log(`request line to be revealed: POST ${new URL(spec.url).pathname.slice(0, 40)}..${new URL(spec.url).search}`);
    execFileSync(PROVE_ME, [out, ...(process.argv.includes("--proxy") ? ["--proxy"] : [])], { env: { ...process.env, PROVE_SITE_SPEC: specFile }, stdio: ["ignore", "inherit", "inherit"] });
  } finally { rmSync(dir, { recursive: true, force: true }); }
  const v = JSON.parse(execFileSync(VERIFY, [out, KEY], { encoding: "utf8" }));
  const sentShown = v.sent.replace(/X+/g, " ").trim(), recvShown = v.recv.split(/X+/).filter(Boolean);
  const fields = recvShown.filter((x) => x.startsWith('"'));
  const bad = [/cookie/i, /bearer/i, /userId|VXNlcj/i, /@/, /"(name|email|id|first_name)"/i].filter((r) => r.test(sentShown + recvShown.join(" ")));
  console.log(`verified ${v.verified}, notary key pinned ${v.key_matches}, server ${v.server_name}`);
  console.log(`sent shown: ${sentShown}`);
  console.log(`recv shown: ${recvShown.join(" | ")}`);
  const ok = v.verified && v.key_matches && v.server_name === "www.airbnb.com" && fields.length === 1 && /^"totalCount":\s*\d+$/.test(fields[0]) && !bad.length;
  console.log(ok ? `PASS  ${out}` : `FAIL  privacy or shape check (${bad.map(String).join(", ") || "fields: " + fields.length}); not for publishing`);
  process.exit(ok ? 0 : 1);
}
