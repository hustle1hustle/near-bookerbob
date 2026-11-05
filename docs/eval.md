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

## Results: the held-out set (the headline, testnet, 2026-11-05)

The protocol (400 tokens, these 3 models, one run) was frozen and committed (`4370ed7`) before
this set existed. Then a fresh sealed set of 120 items (root `b7b6094074b1b70a…`) was made
and run once.

| model | correct | 95% CI | by level (mul4 / mul5 / modpow / mul6, of 30) | out of budget | bucket on chain | certificate |
|---|---|---|---|---|---|---|
| `z-ai/glm-5.3-flash` | 58/120 | 39.2 to 56.7 | 29 / 11 / 8 / 10 | 62 | 40 | [2zdTRPaR…](https://testnet.nearblocks.io/txns/2zdTRPaRaXUYkkoq9CybbKHhgnqaWuE5mGBqinPSGaC6) |
| `deepseek-ai/DeepSeek-V4.1-Flash-1017` | 112/120 | 88.3 to 97.5 | 30 / 30 / 28 / 24 | 8 | 90 | [Ep4ctyYW…](https://testnet.nearblocks.io/txns/Ep4ctyYWkkhcquuP97Y2XcxrJcu6L7DM2knib2bxRHCW) |
| `Qwen/Qwen3.6-35B-A3B-FP8` (budget-bound) | 0/120 | 0.0 to 0.0 | 0 / 0 / 0 / 0 | 120 | 0 | [5WLGhB6N…](https://testnet.nearblocks.io/txns/5WLGhB6NpFCpxxvNfgeCjRxNvUKJcJg9GXVvyu3Z1NiY) |

## Results v2: referee claims (testnet, 2026-11-05, run once)

Set root `6271b6d20467ce99…` (60 items, 11 with every claim holding), committed by its own
owner account `evalset.bookerbob-demo.testnet` with `commit_eval_set` [E6fdRa1e…](https://testnet.nearblocks.io/txns/E6fdRa1e6QMxTBwK8tvttDS7uX2yHBkcdSgsQrRs9VfB),
not by the bazaar owner. `eval_set(root)` names that account.

| model | correct | 95% CI | by tier (t1 / t2 / t3, of 20) | no answer (cut at 600 tokens) | bucket on chain | certificate |
|---|---|---|---|---|---|---|
| `z-ai/glm-5.3-flash` | 44/60 | 61.7 to 83.3 | 20 / 18 / 6 | 16 | 70 | [HDjy5czq…](https://testnet.nearblocks.io/txns/HDjy5czqb6qkkwCqxK7XpchhRpwJJGVUxeUrFBy1N1pE) |
| `deepseek-ai/DeepSeek-V4.1-Flash-1017` | 35/60 | 46.7 to 71.7 | 20 / 9 / 6 | 25 | 50 | [8pkbHtMr…](https://testnet.nearblocks.io/txns/8pkbHtMrMjjoTBnSWRjezo5ihNP2uuE9JuHaV1yXnWzG) |
| `Qwen/Qwen3.6-35B-A3B-FP8` (budget probe, not ranked) | 0/60 | 0.0 to 0.0 | 0 / 0 / 0 | 60 | 0 | [ET8AZoFA…](https://testnet.nearblocks.io/txns/ET8AZoFA2hz7jh2EzBpFZpP1ixLSwMkAPaRVL9zgiuKE) |

- **The target band held for the top model:** glm at 73%, inside 60 to 85%.
- **Every answer given was right.** glm answered 44 items and got 44; DeepSeek answered 35
  and got 35. Every miss is a reply cut at 600 tokens. So v2, as frozen, measures how much of
  the referee's work a model finishes inside the budget, not whether it gets a claim wrong.
  The harder tiers need longer reasoning (t3: 6 of 20 finished for each).
- **The order flipped from v1** for the same reason: DeepSeek reasons longer, so 25 of its
  replies were cut against glm's 16.
- **What this does not show:** an error rate on finished answers (none was observed in 79), or
  how the models rank with a larger budget. A v3 that separates mistakes from budget would need
  a larger budget frozen in advance; that is not run.
- **Cost:** about $0.11 of NEAR AI credit.
- **Not done:** the set was still made by REP's machine; the owner account is separate from
  the bazaar owner, but an outside set owner (a fresh Codex session, as the panel asked) is
  not: Codex is not installed here. `commit_eval_set` is what such an owner would call.

`make eval-verify` checks v2 too: all 180 TEE signatures, the answers hashes, the issuer
signatures, that no cut reply is graded correct, the buckets, the on-chain scores and the
set owner.

## The calibration set (tuned, not the headline)

The first sealed set (root `758b21ccd7edc046…`) chose the budget. Its 400-token run is also
on chain under its own set root:

| model | correct | 95% CI | by level (mul4 / mul5 / modpow / mul6, of 30) | out of budget | bucket on chain | certificate |
|---|---|---|---|---|---|---|
| `z-ai/glm-5.3-flash` | 61/120 | 41.7 to 60.0 | 29 / 12 / 9 / 11 | 58 | 50 | [EtSwDati…](https://testnet.nearblocks.io/txns/EtSwDati96iGjiqhxfHdp3wyK6ERFKu4aqdComFW3xRA) |
| `deepseek-ai/DeepSeek-V4.1-Flash-1017` | 115/120 | 91.7 to 99.2 | 30 / 30 / 28 / 27 | 5 | 90 | [EhhCrk4f…](https://testnet.nearblocks.io/txns/EhhCrk4fUeEd2P5sA6qFLFhHqfaUA4a9vsr5nuvAhAtd) |
| `Qwen/Qwen3.6-35B-A3B-FP8` (budget-bound) | 0/120 | 0.0 to 0.0 | 0 / 0 / 0 / 0 | 120 | 0 | [BGMA7X7c…](https://testnet.nearblocks.io/txns/BGMA7X7cJd2sQt7Q5CGyyfpMXevobJQLiJfPLevXMnvm) |

The held-out scores sit within 3 items of the calibration scores (glm 58 against 61, DeepSeek
112 against 115), so the budget choice did not inflate them.

`agents/eval.html` reads the three scores live from `bookerbob.testnet` (`agents/eval.json`
is its snapshot fallback). `make eval-verify` checks every TEE signature, the answers hash, the
issuer signature, the bucket from the published correct vector and the on-chain score. It
takes about a second and runs in `make judge`.


## Protocol v2 (frozen 2026-11-05, before its set exists)

Written and committed before any v2 item was generated or any model saw one. The run that
follows it happens once; nothing below changes after seeing a result.

- **The task: referee claims.** Each item is a small proof set (facts), the rule table, the
  revealed predicates and a numbered list of merchant claims with citations. The answer is
  the number of the first claim the referee must refuse, or 0 if every claim holds.
- **The truth comes from code.** Each item's answer is what `zkcore::referee::check` returns
  claim by claim (the same check the referee worker and the Jolt referee guest run), via
  `bookerbob eval-truth`. No answer is hand-labelled.
- **The set:** 60 items in 3 tiers of 20:
  - `t1`: 3 facts, 2 claims, plain mistakes (a value that differs, a fact not in the set);
  - `t2`: 5 facts, 3 claims, near misses (the right value under another field, a value at
    or just under the rule's minimum, a line not revealed);
  - `t3`: 6 facts, 4 claims, the referee's text rules (an unproven status word, another
    platform's name, a number in the text that is not an asserted value, a window number
    that is allowed) mixed with the t2 mistakes.
  About a quarter of the items have every claim holding (answer 0).
- **Budget:** 600 output tokens, reasoning included, temperature 0, one request per item.
- **Truncation counts as no answer.** A reply cut at the budget (`finish_reason` = `length`)
  is graded as no answer, even if it happens to end in a number, and the count is reported
  apart. (v1 graded the last integer of a cut reply; v2 does not.)
- **Models:** the same three TEE-signed models. Qwen3.6 is reported as a **budget probe**:
  certified and listed, not ranked, because v1 showed it spends the whole budget reasoning.
- **Grading and CI:** unchanged (`worker/src/eval.rs`: exact integer, bootstrap 95% CI).
- **The set owner:** the set root is committed with `commit_eval_set` by the account that made
  the set, not by the bazaar owner; the contract records who committed it.
- **Target:** the top model at 60 to 85%. If it lands outside, that is reported, not tuned.

## Calibration, stated plainly

- **The 1,000-token run** on the calibration set (`rep-eval-calibration-1000.json`, not on
  chain) scored 95%, 100% and 1%, so it did not separate the models. 400 tokens was chosen after
  seeing it. That is why the headline is a held-out set made after the choice was frozen.
- **The target band:** only glm lands in the 40 to 80% band (48% held-out). DeepSeek stays near
  the top (93%).
- **Qwen3.6 is budget-bound.** It reasons at length and reached the token limit on every item,
  so its 0 measures the budget, not arithmetic. No signed model that fits the budget could
  replace it:
  - glm-5.3 returns no TEE signature;
  - Qwen3.8 runs out of budget the same way (probes);
  - the Anthropic, OpenAI and Gemini models on NEAR AI Cloud are not TEE-signed.
- **Not done:**
  - grading inside an enclave (it runs in the worker's code on the Mac);
  - publishing the items to an auditor;
  - a harder set that separates DeepSeek.
- **Cost:** about $0.44 of NEAR AI credit for every run and probe.
