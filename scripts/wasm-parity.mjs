#!/usr/bin/env node
// `make wasm-parity`: rebuild the bazaar wasm and check it is the one both testnet bazaars run
// (contract/DEPLOYED.json). Needs Rust and cargo-near; the same toolchain gives the same bytes.
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { b58encode } from "../relayer/near.mjs";

const d = JSON.parse(readFileSync("contract/DEPLOYED.json", "utf8"));
execSync("cd contract && cargo near build non-reproducible-wasm --no-abi --out-dir ../target/near", { stdio: "ignore" });
const h = createHash("sha256").update(readFileSync("target/near/bookerbob_bazaar.wasm")).digest();
const ok = h.toString("hex") === d.wasm_sha256 && b58encode(h) === d.code_hash;
console.log(`${ok ? "PASS" : "FAIL"}  wasm-parity: a fresh build is ${b58encode(h).slice(0, 12)}.., deployed ${d.code_hash.slice(0, 12)}.. (tag ${d.tag}, ${d.toolchain})${ok ? "" : "; a different toolchain gives different bytes, see contract/DEPLOYED.json"}`);
process.exit(ok ? 0 : 1);
