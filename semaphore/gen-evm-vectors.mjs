// EIP-1559 test vectors for core::evm, made with ethers 6 (already a dependency of the
// Semaphore packages). Writes ../fixtures/evm/tx-vectors.json: for each payout, the fields,
// ethers' unsigned hash, and the unsigned serialized tx. No network.
import { writeFileSync } from "node:fs";
import { Transaction, Interface, Wallet } from "ethers";

const USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const erc20 = new Interface(["function transfer(address to, uint256 amount)"]);
const cases = [
  { to: "0x1111111111111111111111111111111111111111", amount: 38400000n, nonce: 0n },
  { to: "0xabcdef0123456789abcdef0123456789abcdef01", amount: 1n, nonce: 7n },
  { to: "0x00000000000000000000000000000000000000ff", amount: 123456789012n, nonce: 300n },
];
const out = cases.map((c) => {
  const tx = Transaction.from({
    type: 2,
    chainId: 84532n,
    nonce: Number(c.nonce),
    maxPriorityFeePerGas: 1_000_000n,
    maxFeePerGas: 100_000_000n,
    gasLimit: 100_000n,
    to: USDC_BASE_SEPOLIA,
    value: 0n,
    data: erc20.encodeFunctionData("transfer", [c.to, c.amount]),
    accessList: [],
  });
  // A throwaway test key (not funded, not used anywhere else) to check signed assembly.
  const w = new Wallet("0x" + "11".repeat(32));
  const sig = w.signingKey.sign(tx.unsignedHash);
  const signed = tx.clone();
  signed.signature = sig;
  return {
    merchant: c.to, amount: c.amount.toString(), nonce: Number(c.nonce), unsigned_serialized: tx.unsignedSerialized, unsigned_hash: tx.unsignedHash,
    test_signature: { r: sig.r, s: sig.s, y_parity: sig.yParity }, signed_serialized: signed.serialized, from: w.address,
  };
});
writeFileSync("../fixtures/evm/tx-vectors.json", JSON.stringify({ source: "ethers 6.13.4 Transaction (type 2)", chain_id: 84532, usdc: USDC_BASE_SEPOLIA, max_priority_fee: "1000000", max_fee: "100000000", gas_limit: 100000, cases: out }, null, 2) + "\n");
console.log(out.map((o) => o.unsigned_hash).join("\n"));
