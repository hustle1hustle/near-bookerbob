// Live demo helper (scripts/demo-tester.mjs, demo-reviews.mjs). Reads JSON or a secret on
// stdin, writes JSON or a decimal to stdout. Secrets never leave stdin/stdout.
//   node identity.mjs commitment        stdin: identity secret (hex)  -> commitment (decimal)
//   node identity.mjs prove             stdin: { secret, members[], message_hex, scope_hex }
//                                       -> { depth, merkle_root, nullifier, points } (verified)
import { Group, Identity, generateProof, verifyProof } from "@semaphore-protocol/core";

const input = await new Promise((ok) => { let s = ""; process.stdin.on("data", (d) => (s += d)); process.stdin.on("end", () => ok(s.trim())); });
const cmd = process.argv[2];
if (cmd === "commitment") {
  console.log(new Identity(input).commitment.toString());
} else if (cmd === "prove") {
  const q = JSON.parse(input);
  const id = new Identity(q.secret);
  const group = new Group(q.members.map(BigInt));
  if (group.indexOf(id.commitment) < 0) throw new Error("identity is not a member");
  const p = await generateProof(id, group, BigInt(`0x${q.message_hex}`), BigInt(`0x${q.scope_hex}`));
  if (!(await verifyProof(p))) throw new Error("proof does not verify");
  console.log(JSON.stringify({ depth: p.merkleTreeDepth, merkle_root: String(p.merkleTreeRoot), nullifier: String(p.nullifier), points: p.points.map(String), root_js: group.root.toString() }));
  // snarkjs keeps its curve worker threads alive; without this the process never exits.
  process.exit(0);
} else {
  console.error("usage: identity.mjs commitment|prove");
  process.exit(2);
}
