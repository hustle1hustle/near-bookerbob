// Sealed reviews fixtures (Semaphore v4). Deterministic identities from labels; proofs
// are randomized by snarkjs, so they are generated once and committed.
//   cd semaphore && npm install --ignore-scripts && node gen-fixtures.mjs
// Proving downloads the Semaphore V4 ceremony artifacts (zkey, wasm) for the tree depth
// from snark-artifacts.pse.dev. Writes ../fixtures/semaphore/.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Group, Identity, generateProof, verifyProof } from "@semaphore-protocol/core";
import { poseidon2 } from "poseidon-lite";

const OUT = "../fixtures/semaphore";
const sha = (s) => createHash("sha256").update(s).digest("hex");
const big = (hex) => BigInt(`0x${hex}`);
const MERCHANT = "m01.bookerbob.testnet";
const ROUND = 1;

// message preimage: sha256(json([rating, delivered, reason_hash])); scope preimage:
// sha256("bookerbob/review/v0|" + merchant + "|" + round). The contract recomputes both;
// Semaphore then hashes each with keccak256(x as 32 bytes) >> 8.
const messageOf = (r) => big(sha(JSON.stringify([r.rating, r.delivered, r.reason_hash])));
const scopeOf = (merchant, round) => big(sha(`bookerbob/review/v0|${merchant}|${round}`));

const ids = Array.from({ length: 6 }, (_, i) => new Identity(`bookerbob fixture reviewer ${i}`));
const outsider = new Identity("bookerbob fixture outsider");
const group = new Group();
const roots = [];
for (const id of ids) {
  group.addMember(id.commitment);
  roots.push(group.root.toString());
}

const reviews = [
  { rating: 5, delivered: true, reason: "arrived in two days, as described" },
  { rating: 4, delivered: true, reason: "good, a little late" },
  { rating: 5, delivered: true, reason: "exactly the hoodie on the page" },
  { rating: 2, delivered: false, reason: "not delivered yet" },
  { rating: 4, delivered: true, reason: "fine" },
  { rating: 3, delivered: true, reason: "ok" },
].map((r) => ({ rating: r.rating, delivered: r.delivered, reason_hash: sha(r.reason) }));

const scope = scopeOf(MERCHANT, ROUND);
const proofs = [];
for (const [i, id] of ids.entries()) {
  const p = await generateProof(id, group, messageOf(reviews[i]), scope);
  if (!(await verifyProof(p))) throw new Error("proof does not verify");
  proofs.push({ reviewer: i, review: reviews[i], proof: p });
}
// A second rating by reviewer 0 in the same round: same nullifier, must be refused.
const double = await generateProof(ids[0], group, messageOf({ rating: 1, delivered: false, reason_hash: sha("changed my mind") }), scope);
// A non-member: a valid proof, but for a group that is not the merchant's.
const other = new Group([outsider.commitment, ids[1].commitment]);
const nonMember = await generateProof(outsider, other, messageOf(reviews[0]), scope);

const vks = JSON.parse(readFileSync("node_modules/@semaphore-protocol/proof/src/verification-keys.json", "utf8"));
const depths = [...new Set([...proofs.map((p) => p.proof.merkleTreeDepth), double.merkleTreeDepth, nonMember.merkleTreeDepth])].sort();
const vk = {
  source: "@semaphore-protocol/proof 4.14.5, src/verification-keys.json (Semaphore V4 ceremony, 2024-07-13)",
  protocol: vks.protocol,
  curve: vks.curve,
  vk_alpha_1: vks.vk_alpha_1,
  vk_beta_2: vks.vk_beta_2,
  vk_gamma_2: vks.vk_gamma_2,
  by_depth: Object.fromEntries(depths.map((d) => [d, { vk_delta_2: vks.vk_delta_2[d - 1], IC: vks.IC[d - 1] }])),
};

// Poseidon(2) vectors for the Rust implementation (circomlib parameters).
const poseidon = [
  [1n, 2n],
  [0n, 0n],
  [ids[0].commitment, ids[1].commitment],
].map(([a, b]) => ({ inputs: [a.toString(), b.toString()], output: poseidon2([a, b]).toString() }));

mkdirSync(OUT, { recursive: true });
const j = (v) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x), 2) + "\n";
writeFileSync(`${OUT}/group.json`, j({ merchant: MERCHANT, members: ids.map((i) => i.commitment), roots_after_each_insert: roots }));
writeFileSync(`${OUT}/reviews.json`, j({ merchant: MERCHANT, round: ROUND, scope_preimage: scope, proofs, double_rating: double, non_member: nonMember }));
writeFileSync(`${OUT}/verification-key.json`, j(vk));
writeFileSync(`${OUT}/poseidon-vectors.json`, j(poseidon));
console.log(`group of ${ids.length}, depth ${proofs[0].proof.merkleTreeDepth}, root ${group.root}; ${proofs.length} proofs, vk depths ${depths.join(",")}`);
// snarkjs keeps its curve worker threads alive; exit explicitly.
process.exit(0);
