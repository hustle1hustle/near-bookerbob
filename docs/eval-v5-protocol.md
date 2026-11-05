# REP Eval v5: protocol (frozen 2026-11-06, before any v5 item exists)

v4 separated the models, but on 40 items its intervals overlap (DeepSeek 57.5 to 85.0, glm 37.5
to 70.0), and the gate read the point score: DeepSeek's bucket of 70 passed a 70 gate with a
lower bound of 57.5. The 70 itself was set after the v4 scores were known. v5 fixes both. This
file is committed on its own, before the code change that makes the set, and before any model
sees an item.

- **The same task and prompt** as v2 to v4 (the first claim the referee must refuse, or 0), the
  same eight rules, the truth from `zkcore::referee::check` via `bookerbob eval-truth`. No item
  is hand-labelled.
- **A new set of 120 items, 60 in `t4` and 60 in `t5`**, from the v4 generator unchanged, made
  once. None is reused from v4.
- **Budget: 8,000 output tokens,** temperature 0, one request per item. v4's misses were mostly
  replies cut at 4,000, so the budget doubles to measure accuracy more than endurance. A cut
  reply is still no answer.
- **Models:** `z-ai/glm-5.3-flash` and `deepseek-ai/DeepSeek-V4.1-Flash-1017`, run once.
- **The score:** correct / 120, a cut reply counting as not correct. The 95% interval is the
  Wilson score interval (z = 1.96), which anyone can recompute from the public correct vector;
  it replaces the bootstrap of earlier runs.
- **Truncation apart:** each model's table row gives cut replies, and accuracy among finished
  answers with its own Wilson interval. Neither enters the gate.
- **The gate: the lower bound of the interval, not the point score.** A model passes threshold T
  when `lower bound >= T`.
- **The threshold is 70, fixed here,** before any v5 result exists. It is not moved after the
  scores, whatever they are.
- **On chain, with no contract change.** `submit_eval_certificate` requires a bucket equal to
  `floor(correct * 100 / n)` floored to tens, so a lower bound cannot sit in the ordinary
  certificate. Each model gets two certificates on the set root:
  - `<model>@8000tok/referee-v5`: the point score, as in v2 to v4;
  - `<model>@8000tok/referee-v5/ci95-lower`: `correct` set to `floor(n * lower bound)`, so it is
    a count derived from the interval, not a count of right answers, and the subject says so.

  `eval_passes(<model>@8000tok/referee-v5/ci95-lower, root, 70)` is then the gate, and a merchant
  sets it with the same `set_eval_gate` (suffix `@8000tok/referee-v5/ci95-lower`). `make
  eval-verify` recomputes the derived count from the correct vector, so the issuer cannot state
  a bound the answers do not give.
- **Spend:** existing NEAR AI credit only, capped at 2 USD. A 402 stops the run; no certificate
  is issued for a partial run, and how far it got is reported.
- **The set owner** (`evalset.bookerbob-demo.testnet`) commits the root with `commit_eval_set`.
- **Reported whatever comes out.** If both models clear 70, or neither does, that is the result.
  Outside the v4 target band is reported, not tuned.
