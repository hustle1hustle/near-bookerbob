// Buy Twice fixtures: Semaphore proofs for claim_returning, same identities and group as
// gen-fixtures.mjs. Scope: sha256("bookerbob/returning/v0|" + merchant + "|" + epoch), message:
// the verdict nullifier. Writes ../fixtures/semaphore/returning.json.
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { Group, Identity, generateProof } from "@semaphore-protocol/core";

const sha = (s) => createHash("sha256").update(s).digest("hex");
const big = (hex) => BigInt(`0x${hex}`);
const MERCHANT = "m01.bookerbob.testnet";
const EPOCH = Math.floor(1_793_793_600_000 / (30 * 86_400_000));
const nullifierOf = (i) => (220 + i).toString(16).repeat(32);
const scope = big(sha(`bookerbob/returning/v0|${MERCHANT}|${EPOCH}`));
const ids = Array.from({ length: 6 }, (_, i) => new Identity(`bookerbob fixture reviewer ${i}`));
const group = new Group(ids.map((id) => id.commitment));
const claims = [];
for (let i = 0; i < 6; i++) claims.push({ member: i, nullifier: nullifierOf(i), proof: await generateProof(ids[i], group, big(nullifierOf(i)), scope) });
// Member 0 again, on another verdict, in the same epoch: same Semaphore nullifier.
const again = { member: 0, nullifier: nullifierOf(6), proof: await generateProof(ids[0], group, big(nullifierOf(6)), scope) };
writeFileSync("../fixtures/semaphore/returning.json", JSON.stringify({ merchant: MERCHANT, epoch: EPOCH, claims, again }, null, 2) + "\n");
console.log(`returning.json: ${claims.length} claims, epoch ${EPOCH}`);
process.exit(0); // snarkjs leaves workers open
