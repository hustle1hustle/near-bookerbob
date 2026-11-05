# REP Eval: certified scores on a sealed set

The envelope's second use: a certificate that a model scored X on a private benchmark, without
publishing the benchmark. `scripts/rep-eval.mjs`, panel round 3 action 9.

## The set and the protocol

- **The set:** 120 items at four levels, 30 each:
  - 4-digit multiplication;
  - 5-digit multiplication;
  - small modular powers (`b^e mod m`, e from 8 to 16, m from 101 to 199);
  - 6-digit multiplication.
- **What is private and what is public:** the items, their salts and the answers stay in
  KEYS_DIR. The set root (`758b21ccd7edc046…`, a Merkle root over salted item hashes) and
  the 120 item hashes are public.
- **The protocol:** each model answers every item at temperature 0 within **400
  output tokens**, reasoning included.
- **Signatures:** each answer's NEAR AI TEE signature is checked against the hashes of the exact
  request and response bytes. A model with one invalid signature gets no certificate.
- **Grading:** done in the worker's code (`worker/src/eval.rs`, `bookerbob eval-grade`). It
  grades exact integers and computes a deterministic bootstrap 95% CI (2,000 resamples).
- **The issuer:** a separate eval issuer key (`ed25519:4e338d29c21b55ec…`) signs one certificate
  per model. It is not the owner that registered the set, and not the verdict issuer. Its
  registration: [BdA6CyxU…](https://testnet.nearblocks.io/txns/BdA6CyxUFKZoPJNHyjtu3vJk4x9N5nQ8ZEozQgJe8DQm). The set: [HCajhUbQ…](https://testnet.nearblocks.io/txns/HCajhUbQiYBWzidX5mqbF4uDnLXpCWheKytKR6Zah1de).
- **On chain:** the bazaar stores the floored score per (model@budget, set) and answers
  `eval_passes(subject, set, threshold)`.

## Results (testnet, 2026-11-05)

| model | correct | 95% CI | by level (mul4 / mul5 / modpow / mul6, of 30) | out of budget | bucket on chain | certificate |
|---|---|---|---|---|---|---|
| `z-ai/glm-5.3-flash` | 61/120 | 41.7 to 60.0 | 29 / 12 / 9 / 11 | 58 | 50 | [EtSwDati…](https://testnet.nearblocks.io/txns/EtSwDati96iGjiqhxfHdp3wyK6ERFKu4aqdComFW3xRA) |
| `deepseek-ai/DeepSeek-V4.1-Flash-1017` | 115/120 | 91.7 to 99.2 | 30 / 30 / 28 / 27 | 5 | 90 | [EhhCrk4f…](https://testnet.nearblocks.io/txns/EhhCrk4fUeEd2P5sA6qFLFhHqfaUA4a9vsr5nuvAhAtd) |
| `Qwen/Qwen3.6-35B-A3B-FP8` | 0/120 | 0.0 to 0.0 | 0 / 0 / 0 / 0 | 120 | 0 | [BGMA7X7c…](https://testnet.nearblocks.io/txns/BGMA7X7cJd2sQt7Q5CGyyfpMXevobJQLiJfPLevXMnvm) |

`agents/eval.html` reads the three scores live from `bookerbob.testnet` (`agents/eval.json`
is its snapshot fallback). `make eval-verify` checks every TEE signature, the answers hash, the
issuer signature, the bucket from the published correct vector and the on-chain score. It
takes about a second and runs in `make judge`.

## Calibration, stated plainly

- **The first full run** used 1,000 tokens (`fixtures/live/eval/rep-eval-calibration-1000.json`,
  not put on chain). glm scored 95% and DeepSeek 100%, so the set did not separate them.
- **The certified run** uses 400 tokens. Only glm lands in the 40 to 80% target band.
- **DeepSeek** stays near the top at 96%.
- **The Qwen models** reason at length and run out of any tight budget: Qwen3.6 reached the
  limit on all 120 items (Qwen3.8 too, in probes). Its 0 measures the budget, not arithmetic.
- **Choosing the budget** came after seeing the 1,000-token run on the same set, which is mild
  tuning on the test set. A fresh sealed set would remove that; it is not built.
- **Not done:**
  - grading inside an enclave (it runs in the worker's code on the Mac);
  - publishing the items to an auditor;
  - a harder set that separates DeepSeek.
- **Cost:** about $0.33 of NEAR AI credit for both runs and the probes.
