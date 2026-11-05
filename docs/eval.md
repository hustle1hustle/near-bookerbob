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

## Protocol v3 (frozen 2026-11-05, after v2, before any v3 request)

v2 showed every miss was a reply cut at the budget, so it measured budget, not accuracy. v3
asks the accuracy question with everything else held fixed. Committed before any v3 request
is sent:

- **The same 60 items** (set root `6271b6d20467ce99…`, already committed by its owner); no item
  is changed, added or dropped.
- **Budget: 2,000 output tokens**, so a cut reply should be rare. Temperature 0, one request
  per item, the same prompt.
- **The same three models**, run once. Qwen3.6 stays a budget probe.
- **Truncation is still no answer**, reported apart.
- **Reported as the accuracy result next to v2's budget result.** Neither replaces the other.
  If the models are right on every item they answer again, the finding is that the set is too
  easy for them, and that is what gets written.
- Certificates under the subject `<model>@2000tok/referee-v3` on the same set root.

## Results v3: the same items at 2,000 tokens (testnet, 2026-11-05, run once)

The accuracy result, next to v2's budget result; neither replaces the other.

| model | correct | 95% CI | by tier (t1 / t2 / t3, of 20) | no answer (cut at 2,000 tokens) | bucket on chain | certificate |
|---|---|---|---|---|---|---|
| `deepseek-ai/DeepSeek-V4.1-Flash-1017` | 58/60 | 91.7 to 100.0 | 20 / 20 / 18 | 2 | 90 | [6gCM3SJv…](https://testnet.nearblocks.io/txns/6gCM3SJvq5aHn2zf8qvhc3b3H4Ca8dCDfBoPuF9Uif99) |
| `z-ai/glm-5.3-flash` | 55/60 | 83.3 to 98.3 | 20 / 20 / 15 | 5 | 90 | [9FknLVJ5…](https://testnet.nearblocks.io/txns/9FknLVJ54rpctoQhJ2NqGFwGPRWJmmfzUNTbaJUH4Nkq) |
| `Qwen/Qwen3.6-35B-A3B-FP8` (budget probe, not ranked) | 0/60 | 0.0 to 0.0 | 0 / 0 / 0 | 60 | 0 | [67mvrTRn…](https://testnet.nearblocks.io/txns/67mvrTRnjmqYEkBuNqQbX21ENj6mYU4KG28e2zbWTbRo) |

- **The finding: this set is too easy for these models.** With room to finish, every answer
  either model gave was right again (DeepSeek 58 of 58, glm 55 of 55); every miss is still a
  cut reply. Across v2 and v3, 192 finished answers, no wrong one.
- So the referee-claim set does not separate the two models by accuracy; the v2/v3 difference
  is how long each reasons. A set that does would need harder items (longer proof sets, more
  claims, rules that interact), made and frozen before a v4 run; none is made.
- Qwen3.6 reached 2,000 tokens on every item too.
- **Cost:** about $0.22 (v2 and v3 together about $0.33).

## Protocol v4 (frozen 2026-11-05, after v3, before any v4 item exists)

v3 showed the referee-claim set is too easy: 192 finished answers, no wrong one. v4 asks for
a set that separates models by accuracy. Committed before any v4 item is generated or sent:

- **The same task and prompt** as v2/v3 (the first claim the referee must refuse, or 0), the
  same eight rules stated the same way, the truth from `zkcore::referee::check` via
  `bookerbob eval-truth`. No item is hand-labelled.
- **A new set of 40 items in 2 harder tiers of 20**, generated once:
  - `t4`: 7 facts (two of them on one platform, one at or under the rule's minimum), 6
    claims, each citing 1 to 3 facts; 2 or 3 planted mistakes per item (the first one decides
    the answer), drawn from the v2 near misses and a cited fact that proves another line;
  - `t5`: the t4 shape with 8 claims and text near misses that the split rule decides
    (`gold-plated` is refused, `golden` holds; `superb` holds, `uber` on another line is
    refused; a decimal like `3.5` carries the numbers 3 and 5; a text of exactly 280
    characters holds and 281 is refused; one non-ASCII letter is refused).
  About a fifth of the items have every claim holding (answer 0).
- **Budget: 4,000 output tokens,** temperature 0, one request per item. A cut reply is no
  answer, reported apart.
- **Models:** glm-5.3-flash and DeepSeek-V4.1-Flash. Qwen3.6 is dropped: it hit the budget on
  every item in v1, v2 and v3, so a v4 run would only spend credit.
- **Target:** the top model at 40 to 80%. Outside that band is reported, not tuned.
- **Spend:** existing NEAR AI credit only, capped at 1 USD; a 402 stops the run, and the
  partial result is reported as partial.
- **The set owner** commits the root with `commit_eval_set`; certificates under the subject
  `<model>@4000tok/referee-v4` on that root.
- **What it is for:** a merchant can require `eval_passes(subject, set_root, threshold)` of
  the model that issued a buyer's verdict (the `eval_gate`, built after this freeze).

## Results v4: 40 harder items at 4,000 tokens (testnet, 2026-11-05, run once)

Set root `af82187494d180ed…` (40 items, 5 with every claim holding, against the frozen "about
a fifth": reported, not regenerated), committed by its own owner `evalset.bookerbob-demo.testnet`
[91ZUKXoz…](https://testnet.nearblocks.io/txns/91ZUKXoz78uvTLd4C75LZV8TP83iCmksiqsSuAtH7YyM).
The generator was committed (`6d23772`) before any model saw an item.

| model | correct | 95% CI | by tier (t4 / t5, of 20) | answered | wrong among answered | no answer (cut at 4,000 tokens) | bucket on chain | certificate |
|---|---|---|---|---|---|---|---|---|
| `deepseek-ai/DeepSeek-V4.1-Flash-1017` | 29/40 | 57.5 to 85.0 | 20 / 9 | 29 | 0 | 11 | 70 | [5usqCoLx…](https://testnet.nearblocks.io/txns/5usqCoLxywrSUQNUwp3sXBtnTC4ESEUiFuGqSVH24Fu3) |
| `z-ai/glm-5.3-flash` | 22/40 | 37.5 to 70.0 | 18 / 4 | 23 | 1 | 17 | 50 | [AWo2iet1…](https://testnet.nearblocks.io/txns/AWo2iet1653akoieAHFgq5v8bYaeXnexbBZ43YMi5MmK) |

- **In the target band:** the top model at 72.5%, inside 40 to 80%.
- **The set separates the models now,** and t5 is where: DeepSeek 9 of 20, glm 4 of 20.
- **The first wrong finished answer in any run:** glm, 1 of 23. Across v2 to v4 that is 1 wrong
  in 244 finished answers. Most misses are still cut replies, now on the 8-claim t5 items, so
  v4 measures accuracy and endurance together, and the table reports them apart.
- In the generator, before the set was made: a sample showed the first mistake sat at claim 1 in
  60% of items, which a model could guess. The placement was made uniform (the first mistake
  at any of claims 1 to n-1, the others after it) before the one set was generated. Both are in
  `6d23772`; no model had seen an item.
- **Cost:** about $0.16 of existing NEAR AI credit; no 402.

## The eval gate: a merchant requires a passing model (testnet, 2026-11-05)

`set_eval_gate({set_root, subject_suffix, threshold})`, called by a registered merchant: a
referee receipt naming that merchant is refused unless the buyer's verdict was issued by a NEAR
AI model key (`submit_near_ai_verdict`) whose model passes `eval_passes(model + suffix,
set_root, threshold)`. `None` clears it. On testnet (`make eval-gate`, also in `make judge`):

- `vetted.bookerbob-demo.testnet` registered with m01's schedule and set the gate to the v4
  root, `@4000tok/referee-v4`, 70: [7y4q5ZAk…](https://testnet.nearblocks.io/txns/7y4q5ZAkM8CJjkppQCL4ZDfqp6ezm3VZreToeX3c5GUg).
- `eval_passes` on chain: DeepSeek (bucket 70) passes, glm (bucket 50) does not.
- A fresh tester with an ordinary sealed verdict (signed by the issuer key, not a model) asked
  for a receipt from it, and the contract refused: "merchant's eval gate: the verdict was not
  issued by a NEAR AI model key" [AH8Yuaou…](https://testnet.nearblocks.io/txns/AH8YuaournDh8erCyQvPAprY4tju83YH82AJVNRD1hjp).
- **Not run live:** the passing purchase, a verdict through `submit_near_ai_verdict` from a
  model at 70 or more. The live purchases use the issuer key; the model-issued path and the gate
  together are covered on near-sdk's mocked chain (`certified_eval`: refused under the
  threshold, accepted at it, an unregistered model key refused, only a registered merchant sets
  a gate, the set must be committed, a cleared gate takes any issuer).

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
