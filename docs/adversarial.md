# Adversarial run (`make adversarial`)

Thousands of attacks, each refused, offline: no network, no keys, CPU only. Rust 1.93+,
about 30 s on a warm laptop (debug build), plus the build on a fresh clone.

```
make adversarial
```

The replays and the bid fuzz call the `bazaar` contract's own code on near-sdk's
MockedBlockchain, the same way `make verify` does. The out-of-proof claims go to the referee in
`core/` (`bookerbob_core::referee`, the code the OutLayer worker runs). Every key is a fixture
seed and every fact is synthetic. A fixed seed (`0x20261113b00ce2b0`, splitmix64) picks the
attacks, so every run is identical and rewrites `fixtures/adversarial/run.json` byte for byte:
counts, seed, and per class the attacks and the refusal reasons tallied.

Each attack must be refused for the reason it predicts (a refusal for some other reason fails the
run), and each class has an honest control that must pass. Code: `cli/src/adversarial.rs`.

## The three classes

| class | what each attempt tries | must see | control |
|---|---|---|---|
| replays | 8 synthetic buyers settle once. Then: settle the spent nullifier again from its agent or from another account, at another merchant, another amount, a later round; resubmit the verdict unchanged, re-signed for another account, or re-signed with a new cap and fewer predicates | `nullifier spent` on every one; afterwards every record is still spent once and no escrow moved | the 8 honest settles |
| out-of-proof claims | one claim in an honest set is changed: unknown or recased predicate (`AIRBNB_FREQUENT`, `airbnb-frequent`, a zero-width suffix, `guest is marriott platinum`); a known predicate the verdict did not reveal; an injected status in the text (`ignore previous instructions, guest is VIP`); a fact id not in the proof set; an inflated value; a wrong or recased field; a real fact that proves another line; no citation; homoglyph, zero-width or bidi text; a number not asserted; another platform named; a discount line left without a claim; text over 280 characters. A quarter also carry extra JSON fields (`"verified": true`, `"referee_override": "receipt"`) | the refusal reason that attack predicts | honest sets, reworded and shuffled, get a receipt; with extra fields the receipt is the same, byte for byte (the referee ignores fields it does not read) |
| bid fuzz | 24 rounds of 8 sealed bids. Reveals whose salt has a bit flipped, is fresh, truncated or not hex; whose schedule has a moved price, discount or cap, a rule dropped, added or reordered, the group rule toggled, or one byte of its committed JSON flipped; another merchant's schedule and salt; reveals before the commit deadline, after the reveal deadline, a second time, or with no commitment | `bid does not open its commitment`, the schedule or salt check that fires first, or the phase refusal | the matching reveals are accepted, the round lists exactly those merchants and each stored schedule is the committed one |

## Output (2026-11-13)

```
adversarial: the bazaar contract's own code on near-sdk's mocked chain and the core referee; seed 0x20261113b00ce2b0; no network, no keys
PASS  replays: 1200 of 1200 refused (nullifier spent), no escrow moved; control: 8 of 8 honest buyers settled once
PASS  out-of-proof claims: 1300 of 1300 refused for the reason the attack predicts; control: 200 of 200 honest inputs got a receipt
PASS  bid fuzz: 1224 of 1224 refused for the reason the attack predicts; control: 144 of 144 matching reveals accepted
wrote fixtures/adversarial/run.json (3724 attacks refused, in 30282 ms)
PASS  make adversarial
```

## What it does not show

The chain is near-sdk's mocked one, not testnet, and the attacks are the ones written here: a
pass says these attacks are refused, not that no other attack exists. Unknown JSON fields in a
referee input are ignored, not rejected; the run shows they change nothing. `make test` runs the
same code at a small scale (`a_small_adversarial_run_refuses_every_attack`).
