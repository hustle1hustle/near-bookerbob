# Keyless: which BookerBob keys the operator still holds (2026-11-14)

The goal: no key the BookerBob operator (us) holds can decide a verdict, a receipt or a dispute
on its own. This page lists what moved into a TEE today, what did not, and why. Every claim names
its check. The bazaar contract did not change: `bookerbob.testnet` and the mainnet bazaar still
run the audited wasm (code hash `Bt2rNwTLp1wyhL5rjJfyLUigiBiLXiSMt1BD1gAqysfn`), so everything
below uses methods that wasm already had.

## The arbiter runs on OutLayer (testnet)

The OutLayer project `bookerbob.testnet/bookerbob-referee` (uuid `p000000000000018b`, active
version v1, wasm `6fca1eaa…`) holds two host keys derived in OutLayer's TEE keystore for the
project: `referee` (`5863e39d…feca`) and `arbiter` (`16173914…0e4a`). An input that carries a
contested referee `result` is a dispute: the module runs `arbitrate` (`worker/src/lib.rs`), which
re-checks the verdict signature and issuer key, the referee key and signature, the binding to
this verdict, the claims the referee signed, the code price, and re-runs the referee over the
proofs. It signs `upheld` or `overturned` with the `arbiter` host key, which OutLayer's keystore
derives for the project and does not hand out. The TDX quotes of the referee's testnet and mainnet runs are verified on chain by our DCAP
verifier (`node scripts/outlayer-attest.mjs verify`), and so is the TDX quote of the dispute run
below (request 46342); the timed-out first run's quote was not fetched; OutLayer's keystore is still trusted, and the project's owner can publish a
new version that signs with the same key (below).

On `bookerbob.testnet` the arbiter key was registered through the 5-minute anchor timelock:
queued `6Yyis8DY6oWaqq4qb8mxDmnWfepAjehLKiKEXqapzMcb` (anchor 3), executed
`3P8hnCqRYB4eoWDhP5cSLKjzb3cWeDSV7N7UyZx8gmff`. Then the arbiter threshold went from 1 to 2
([HPuUXT9T…](https://testnet.nearblocks.io/txns/HPuUXT9Ti42wTaxzSR4ToQ8NNq8oDgmc8qthhRd4U6f7)):
every dispute decision now needs both registered arbiter keys, ours and the OutLayer key.

### One dispute, end to end (`make outlayer-dispute`, historical)

A compromised referee is the case a dispute exists for, so the run uses one: our own testnet
referee key (`2f99e90f…3751`, registered 2026-11-04) signs a receipt for a buyer whose claims
include `F9`, a fact its proofs do not carry. Our honest referee run refuses it
("F9 not in proof set"); the forged copy says `receipt`. The dispute ran at threshold 1, before
the raise, so the OutLayer key's signature alone decided it. The run is historical: `run` needs
threshold 1, and a new dispute now needs our arbiter's signature too; `verify` still re-reads it.

| step | tx |
|---|---|
| the bazaar stores the forged receipt (it trusts the key) | [8gBa62UU…](https://testnet.nearblocks.io/txns/8gBa62UUe5DMKat9g2AGcR5BMJ8XLN7AjbaqYJBME5vo) |
| `bookerbob.testnet` calls OutLayer with the dispute input sealed to the project's X25519 key (request 46342) | [AjfwNan6…](https://testnet.nearblocks.io/txns/AjfwNan6WZ5vSgrfw8FSSnrLebzTnUba6vGYP34xKwXh) |
| OutLayer's worker resolves the request on chain with `overturned`, signed by the arbiter host key: "referee said receipt, re-run says refused: F9 not in proof set" (15.3M instructions, 1.1 s) | [AEuiNjB9…](https://testnet.nearblocks.io/txns/AEuiNjB97413UQ99vhhHaXna4Yv9iFkyPseKq61DUan4) |
| anyone relays the decision unchanged (`submit_dispute_decision`): `dispute_overturned`, the receipt is cleared | [9srAcjnj…](https://testnet.nearblocks.io/txns/9srAcjnjE51MTeqhjCW7df4wm877EthvtJbDVssiZvXN) |
| the tester's `settle_demo` for that purchase is refused: no referee receipt | [8A6wx7KT…](https://testnet.nearblocks.io/txns/8A6wx7KTxMVCWrNdUvkWsRPBqdTWExrvFnbn5bpgzvsx) |

The first run, about 15:20 UTC on the same verdict, is kept in the record as `first_run`: the
worker posted the same decision, but its resolve tx failed on chain ("Execution request not
found": the request had timed out, as had every resolve of the worker from 15:14 to 15:19), and
the decision was relayed from that failed tx's arguments. The check does not accept it as the
run: it requires the resolve tx to succeed, and lists the first run as a timeout. The second run
used a new forged receipt (another `detail`, so another result hash: an overturned result cannot
be sent again).

Check, no keys: `node scripts/outlayer-dispute.mjs verify` (9 checks over public RPC: the anchor,
the forged receipt, the request, the resolve, the relay and refused settle, the block order, the
first run's failed resolve, the arbiter keys, the threshold), also two `make verify-live` checks
and in the `make judge` snapshot. Record: `fixtures/live/outlayer/dispute.json`. The facts are the
synthetic fixture set; the money in this purchase never moved (no escrow, no settle). The arbiter
keys come from every `arbiter_registered` tx the nearblocks index lists: the contract has no view
of the set.

OutLayer was called directly; `request_referee`'s callback parses only a referee result. Because
`bookerbob.testnet` itself made the call, the module opened the input with the seal key it
derives for that caller, the same key the referee path uses (`seal_for` in the pubkey statement).

## The referee on OutLayer, on mainnet

The same public wasm as testnet v1 now runs as the project `bookerbob-referee` on
`outlayer.near`, owned by the mainnet bazaar (`3fd1e77f…`, uuid `p000000000000006a`). Its referee
key `8b9b3286…3037` is registered on the mainnet bazaar beside our own mainnet referee key, and
one purchase settled under a receipt that key signed. 0.320589 NEAR spent in all, 0.30 of it the
swap to USDC (bazaar and buyer balances, block 224534785 to 224534953).

| step | tx |
|---|---|
| `create_project` from the release URL, hash `6fca1eaa…` pinned | [FKiPwaw5…](https://nearblocks.io/txns/FKiPwaw5kYJQrnXdf8qNSrDmPKsn3ELvxgoXNJRU6jZ9) |
| pubkey run: the referee key and the seal key for the bazaar, signed by the referee key | [9iJzLrLD…](https://nearblocks.io/txns/9iJzLrLD7CqwhQLbN3qHh2ftcvcZQfRfSBysJDZpt4DB) |
| `set_outlayer(outlayer.near)`, `register_referee` (the mainnet anchor delay is 0) | [2zowALXR…](https://nearblocks.io/txns/2zowALXRamMDsSV1rfNYxHSSUzAxfpbSyunb7MBsgnDK), [6ewTqkDf…](https://nearblocks.io/txns/6ewTqkDfd9RYgfz2QpwpMBZDJfc8SmnAJBcM6gvVWX7x) |
| a NEAR AI verdict (DeepSeek V4.1 Flash, E2EE, TEE-signed) over the synthetic facts | [74z2gTay…](https://nearblocks.io/txns/74z2gTayPjFenqEdmWG9ysMxx8TxBDNxnijNkM7bz6sE) |
| `request_referee`: the input sealed to the project key, run on OutLayer, the signed receipt back through the bazaar's callback | [AWeGAm2u…](https://nearblocks.io/txns/AWeGAm2uAYnV3Hz8Hz5mbYHMacPNYoHDov39Kt8bDD7V) |
| escrow and settle: 0.9025 USDC to the round's lowest bidder (our own merchant account) | [9xMvnx8M…](https://nearblocks.io/txns/9xMvnx8MhfZEDTcToDptgE1JKq2J71DyScsVCLdAKgwb), [DisKLZ1z…](https://nearblocks.io/txns/DisKLZ1zfgJC3kvww4DrRePKitvjW1gNN7n4Ebn9zPas) |

Check, no keys: `node scripts/mainnet-outlayer.mjs check` (8 checks: every one of the 10 txs re-read, and the spend from archive balances at the two recorded blocks), also in
`make mainnet-check`. Record: `fixtures/mainnet/outlayer.json`. Limits: the run's TDX quote
is verified on chain by our DCAP verifier, a testnet contract (`node scripts/outlayer-attest.mjs verify`), and OutLayer's keystore is still trusted; our own mainnet referee key `f6fea996…1b70` stays registered (no `remove_referee`); the
project's owner is the bazaar account, whose full-access key we hold.

## The testnet issuer key is removed

Our testnet verdict issuer key (`ed25519:89a1f5d3…f612`) was removed from `bookerbob.testnet`
([842vjgRQ…](https://testnet.nearblocks.io/txns/842vjgRQztzSre82v4kEJLmLFXJw4USUSK2AZETDKnmM),
`issuer_removed`). Testnet, like mainnet, now takes verdicts from the attested NEAR AI model key
(`submit_near_ai_verdict`, `make model-buy`). `make demo-tester`, `make try` and the swarm buys
signed with that key, so they are historical on `bookerbob.testnet`; their records stay
checkable (`make verify-live`; `make audit` names the removal for a verdict that key signed).
`remove_issuer` is not timelocked; adding a key back waits out the 5-minute anchor delay.

## What the operator still holds, and why

- **Our arbiter key stays registered.** The audited wasm has no `remove_arbiter`. Our
  `testnet arbiter` key (`b5df0fa0…698b`) is the only other arbiter. The threshold is 2, so every
  dispute needs the OutLayer arbiter's signature and ours. With `bookerbob.testnet` locked, no one can add an
  arbiter key or publish a new project version on testnet.
- **A challenged standing update stays unresolved.** `resolve_graph_challenge` needs two arbiter
  signatures, and the OutLayer module does not sign graph resolutions yet (a next module
  version). Anyone can challenge a pending update with a 0.1 NEAR bond, and a new update is
  refused while one is pending, so one challenge stops every later standing update on
  `bookerbob.testnet`. An unchallenged update finalizes as before, and `in_top` reads the last
  finalized tree (`proven_standing`), so admission keeps working on the last one.
- **Our referee keys stay registered.** The audited wasm has no `remove_referee`, so
  `2f99e90f…3751` on testnet and `f6fea996…1b70` on mainnet can still sign a receipt. What
  catches a false one on testnet is the dispute above.
- **The issuers map is shared.** Our `REP Eval issuer` key (`4e338d29…340b`) is the one issuer
  key left on testnet, registered for eval certificates; `submit_verdict` accepts any registered
  issuer key, so it could still sign a verdict. It stays while `submit_eval_certificate` needs it.
- **The mainnet OutLayer project's owner is the mainnet bazaar account**, with one full-access key
  we hold. It can publish a new version, and the host keys are bound to the project and kept across versions,
  so a new version would sign with the same keys. `outlayer.testnet` does allow a two-step
  transfer (`accept_project_transfer` by the new owner, then `transfer_project`).
- **The evaluator still sees the facts.** A NEAR AI verdict needs the evaluator's signature on
  the request (`set_evaluator_key`), and our evaluator builds that request from the facts before
  sealing them to the model key (`scripts/model-buy.mjs`, `issue`). Moving it into the OutLayer
  module needs a third host key and an outbound call to NEAR AI from the TEE (network access and
  an API key as an OutLayer secret); the v1 manifest has neither. Not done today.
- **`bookerbob.testnet` is locked** (DeleteKey [28EvzuBN…](https://testnet.nearblocks.io/txns/28EvzuBNzLPPHd9kLX3jctGhC9xhcuGaykwGofSX7SaZ), 2026-11-14): it holds no access key, so
  the testnet OutLayer project gets no new version, and `set_graph_program`, every other owner
  method (trust anchors, rounds, fees, `remove_issuer`) and `cancel_anchor` are frozen. Standing
  updates by bonded workers keep running. Check: `node scripts/keyless-check.mjs`.
- **Mainnet runs the same bazaar code**; we keep its key for now so the storage deposit can be
  reclaimed after judging.

What else does not hold yet (real money beyond dust amounts, outside merchants beyond the public rounds, privacy from our evaluator until it runs in the TEE, a collusion effect beyond direction only): [docs/details.md](details.md#known-limits).
