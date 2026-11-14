#!/usr/bin/env node
// Writes mcp/standing-live.json: every merchant's opening in bookerbob.testnet's proven standing
// tree, for the get_standing and verify_standing tools. The openings come from the bookerbob
// CLI over the exact input the on-chain Jolt proof covers (fixtures/zk/standing-live-input.json);
// each score is the value its public commitment opens to (the scores follow from public events
// anyway, and the graph tree's salt is public). Offline; the tools compare the root to the chain.
//   node mcp/standing-data.mjs
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { graphSalt, scoreCommit, opens, GRAPH_CONTEXT } from "./reputation.mjs";

const root = new URL("..", import.meta.url).pathname;
const input = "fixtures/zk/standing-live-input.json";
const out = JSON.parse(execFileSync("cargo", ["run", "-q", "-p", "bookerbob-cli", "--", "standing-proofs", input], { cwd: root, encoding: "utf8" }));
const onchain = JSON.parse(readFileSync(new URL("../zk/out/standing-live/result.json", import.meta.url), "utf8")).output;
const hex = (a) => Buffer.from(a).toString("hex");
if (out.graph_root !== hex(onchain[0]) || out.scores_hash !== hex(onchain[1])) throw new Error("the CLI's graph root or scores hash differs from the on-chain proof's output");

const entries = out.proofs.map((p) => {
  const salt = graphSalt(out.graph_root, p.merchant);
  let score = -1;
  for (let s = 0; s < 1 << 24 && score < 0; s++) if (scoreCommit(s, salt) === p.score_commit) score = s;
  if (score < 0) throw new Error(`no score under 2^24 opens ${p.merchant}'s commitment`);
  if (!opens(out.standing_root, GRAPH_CONTEXT, p)) throw new Error(`${p.merchant}'s path does not open`);
  return { ...p, score_x100: score };
});

const data = {
  note: "The proven standing tree of bookerbob.testnet: one opening per merchant, made by `bookerbob standing-proofs` from the input the on-chain Jolt proof covers. Rebuild: node mcp/standing-data.mjs.",
  contract: "bookerbob.testnet",
  input,
  graph_root: out.graph_root,
  scores_hash: out.scores_hash,
  standing_root: out.standing_root,
  n: entries.length,
  proof: {
    program_hash: "c780ceabae4decfa59703a9988ab2483313c6c1d2f15c7c0ad8fc60255a5c3a5",
    proof_dir: "zk/out/standing-live",
    proof_sha256: "5619f62dcf9d94b41c74cd67b9b0e8cf5fffc0583eb8bb7ed4acb9c1b59454d1",
    submit_tx: "8AmCe4FNKXafMqZpeohNEK51bAtDDTm27pPDS8rSWBDD",
    finalize_tx: "GSkXViv8a2Ho1K5iPxNZe9iwhHk9UjNbLZpSqeyn8MhR",
  },
  entries,
};
writeFileSync(new URL("./standing-live.json", import.meta.url), JSON.stringify(data, null, 1) + "\n");
console.log(`wrote mcp/standing-live.json: root ${out.standing_root.slice(0, 12)}.., n=${entries.length}`);
