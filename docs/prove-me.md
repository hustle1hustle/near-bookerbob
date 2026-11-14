# make prove-me: your own GitHub account as the real fact

Panel round 4, action 6. It replaces the parked phone run (docs/device-run.md) as the one real
fact behind a testnet purchase. Anyone with a GitHub account can run it on their own
account, so the fact is the judge's, not ours.

## What it proves

- **The request:** `GET https://api.github.com/user` with your own token. The design uses the
  authenticated `/user`, not a public profile page: a public page proves a fact about an
  account, not that the prover holds it. The two live runs so far were pipeline tests on a
  public profile (below); no run on an account its owner holds has happened yet.
- **What is revealed:** exactly three fields of the reply, `created_at`, `public_repos` and
  `followers`. The login, name, email, ids and every header stay out of the presentation. The
  request (the token in it) is never revealed; `tools/prove-me` refuses to write a presentation
  if it is. Out of the presentation is not the same as unlinkable: all three fields are public
  for any GitHub account, and `created_at` to the second picks out one account for whoever
  holds the presentation or reads the revealed fields. What the authenticated path adds is
  ownership of the account, not secrecy of these fields.
- **The rule:** `github account_age_years >= 3` gives `github_builder`. The age is counted
  from `created_at` to the notary's timestamp. Repos and followers are revealed facts in the
  proof set, not ruled on.

## The path

1. `make leak` before.
2. `tools/prove-me` notarizes the request through the REP notary on Fly (MPC-TLS): the notary
   co-runs TLS and sees ciphertext only, then signs. Its key is pinned
   (`02114d7e…ab25ef`). **The notary is not TEE-attested**: it is one key held by us (the BookerBob operator). The
   Phala TDX notary is behind `PROVE_ME_NOTARY_URL` / `PROVE_ME_NOTARY_KEY`; it is not up
   today.
3. `rep-verify` checks the signature against the pinned key; the reply must reveal those three
   fields and nothing else, and the privacy scan of `device-run.mjs` runs.
4. The three facts go to the NEAR AI model sealed to its attested key (E2EE v2) with the rule;
   its answer must name `github_builder`, and its TEE signature must cover both wire hashes.
5. A fresh tester buys with a **sealed** verdict: on chain only hashes (no predicate, tier or
   cap). The opening, which goes to the referee, reveals `github_builder` and `world_id_human`.
6. The merchants are the revealed bids of a blind round in the open category: `builders`
   (base 40, 20% for `github_builder`, 10% for a World-bound agent, cap 30%) and `house`
   (base 45, 5% for World). The referee prices both from the opening and the cheapest wins;
   the builder line takes the price from 36 to 28. Settle in dUSDC.
7. `make leak` after. `fixtures/live/prove-me/run.json` gets the presentation's sha256, the
   NEAR AI chat id and hashes, the round, the bids and the txs. The presentation stays in
   `KEYS_DIR/zktls` (mode 600).

## Run it

```
make prove-me                          # check, then run against round builder-1
node scripts/prove-me.mjs check        # notary, prover, verifier, keys, token file
node scripts/prove-me.mjs run builder-1 --dry-run   # everything up to the first tx
```

Needs: the tlsn-extension checkout next to this repo (for `tools/prove-me`, prior work,
PRIOR_WORK.md), a GitHub token in a file (`PROVE_ME_TOKEN_FILE`; a fine-grained token with no
permissions is enough for `/user`), the testnet keys, and a NEAR AI key for step 4.

## make try: you are the buyer

```
make try TOKEN=~/my-github.token          # TRY_DRY=1 stops before the first transaction
```

The same path with three changes: the token file is yours (a fine-grained token with no
permissions; revoke it after), the notary runs in PROXY mode (`TRY_MPC=1` for MPC-TLS;
`PROVE_ME_NOTARY_URL` / `PROVE_ME_NOTARY_KEY` select the Phala TDX notary when it is up), and
the buyer is a one-time implicit account: its id is a fresh key, the treasury funds it with one
transfer, and the relayer pays gas only for implicit ids it funded in that run. The record goes
to `fixtures/live/prove-me/try-<time>.json` and `make verify-live` re-checks every one.

It ran live once as a pipeline test on a public profile (`try-public-test.json`: proxy notary,
a fresh NEAR AI verdict, implicit account `71e8a4ea..`, builders at 28 dUSDC, the replay
refused). The run on your own `/user` needs your token. The local path needs this machine:
the testnet keys and the tlsn-extension checkout; a hosted lane for judges is not built.

## Not claimed

- That the notary is attested (it is not), or that we cannot sign a false presentation (we
  hold the notary key).
- That the rest of the proof set is real: F1 to F5 stay synthetic.
- That a 3-year-old account is a builder in any deeper sense: the predicate is the rule.
