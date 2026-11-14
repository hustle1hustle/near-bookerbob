// The local cases for `make outlayer-jolt-local`: the live standing proof (zk/out/standing-testnet-3,
// program c780ceab.., the hash the bazaar pins) and four changes to it. Writes target/cases/*.json.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const dir = new URL("../../fixtures/live/outlayer/jolt/standing-coalition/", import.meta.url);
const out = new URL("./target/cases/", import.meta.url);
const PROGRAM = "c780ceabae4decfa59703a9988ab2483313c6c1d2f15c7c0ad8fc60255a5c3a5";
const proof = readFileSync(new URL("proof.bin", dir));
const io = readFileSync(new URL("io_device.bin", dir));
const result = JSON.parse(readFileSync(new URL("result.json", dir), "utf8"));
// The claimed output (the new graph root first) as it sits in the device's output bytes.
const root = Buffer.from(result.output[0]);
const at = io.indexOf(root);
if (at < 0) throw new Error("the output root is not in io_device.bin");
const input = (p, d, h = PROGRAM) => ({ program_hash: h, proof: p.toString("base64"), io: d.toString("hex") });
const flip = (b, i) => {
  const c = Buffer.from(b);
  c[i] ^= 1;
  return c;
};
mkdirSync(out, { recursive: true });
const cases = [
  ["pubkey", { cmd: "pubkey" }, "pubkey"],
  ["honest standing proof", input(proof, io), "accept"],
  ["one proof byte flipped", input(flip(proof, proof.length - 100), io), "reject"],
  ["claimed output changed (one bit of the graph root)", input(proof, flip(io, at)), "reject"],
  ["a program this module does not pin", input(proof, io, "ff".repeat(32)), "reject"],
];
for (const [i, [name, inp, expect]] of cases.entries()) writeFileSync(new URL(`${i}.json`, out), JSON.stringify({ name, input: inp, expect }));
console.log(`${cases.length} cases in worker/outlayer-jolt/target/cases/ (proof ${proof.length} bytes, input ${JSON.stringify(input(proof, io)).length} bytes)`);
