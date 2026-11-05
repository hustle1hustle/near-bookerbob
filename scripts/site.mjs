#!/usr/bin/env node
// `make site`: site/ for GitHub Pages. The board, the receipts and the REP Eval leaderboard,
// each reading bookerbob.testnet over public RPC and falling back to its committed snapshot,
// plus a landing page. Static files only. Pages itself is turned on with the public flip
// (.github/workflows/pages.yml is manual and does nothing until Pages is enabled).
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const FILES = ["board.html", "receipts.html", "eval.html", "live.js", "board.json", "receipts.json", "reviews.json", "eval.json", "live.json", "out/live-run.json"];
mkdirSync("site/out", { recursive: true });
for (const f of FILES) {
  mkdirSync(dirname(join("site", f)), { recursive: true });
  copyFileSync(join("agents", f), join("site", f));
}
writeFileSync("site/.nojekyll", "");
writeFileSync(
  "site/index.html",
  `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>BookerBob</title>
<style>
  :root { --bg: #0A0A0F; --panel: #10101A; --fg: #E6E6EF; --dim: #7C7C94; --line: #1C1C2A; --blue: #3B5BFF; --green: #5BE3A0; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; }
  main { max-width: 760px; margin: 0 auto; padding: 48px 16px 64px; }
  h1 { font-size: 20px; font-weight: 600; margin: 0 0 6px; }
  .sub { color: var(--dim); margin-bottom: 28px; }
  a.card { display: block; background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 16px; margin-bottom: 12px; color: var(--fg); text-decoration: none; }
  a.card:hover { border-color: var(--blue); }
  a.card b { color: var(--blue); font-weight: 600; }
  .live { color: var(--dim); font-size: 12px; margin: 20px 0; }
  .live.on::before { content: ""; display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--green); margin-right: 8px; }
  footer { color: var(--dim); font-size: 12px; margin-top: 28px; }
</style>
</head>
<body>
<main>
  <h1>bookerbob</h1>
  <div class="sub">merchants compete for you. none of them learns who you are. built at NEAR HACKATHON.</div>
  <a class="card" href="board.html"><b>the board</b><br>merchant agents bid blind; code computes every price; which merchants are on chain now</a>
  <a class="card" href="receipts.html"><b>receipts</b><br>every testnet purchase, its nullifier status read from the chain, and the sealed reviews</a>
  <a class="card" href="eval.html"><b>REP Eval</b><br>certified scores of three NEAR AI models on a private test set</a>
  <div class="live" id="live">reading bookerbob.testnet ...</div>
  <footer>testnet only; dUSDC is a demo token; the facts behind every verdict are synthetic. Check everything yourself: make judge.</footer>
</main>
<script src="live.js"></script>
<script>
loadLive().then((l) => {
  const el = document.getElementById("live");
  el.textContent = liveBanner(l);
  if (l && l.source === "live") el.classList.add("on");
});
</script>
</body>
</html>
`,
);
console.log(`site/: ${FILES.length} files and index.html (open site/index.html through a static server; Pages turns on with the public flip)`);
