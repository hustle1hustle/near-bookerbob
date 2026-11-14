# Economy anchor: agent reputation as a public NEAR record anyone can rebuild

The public events of nine BookerBob testnet contracts (bids, verdicts, settles, referee and
arbiter results, hires and review seeds, coalition joins, deliveries, slashes and payouts,
standing roots, registered programs, dUSDC transfers) are cut into hourly epochs and kept on NEAR
as a hash chain of epoch roots. The records themselves travel in the posting transactions, so the
chain plus any archival node is enough to rebuild agent outcomes and the proven standing, with no
BookerBob server and without asking the contracts that produced them.

- Contract: `anchor-open/src/lib.rs`, on `bookerbob-outcomes.testnet` (its own crate and account;
  the bazaar did not change).
- Poster, checks and rebuild: `scripts/econ/` (`format.mjs` is the byte format below in code).
- `make anchor-check`: compare the anchor with the watched contracts' transactions, and check the
  streams that have counters for gaps.
- `make anchor-rebuild`: rebuild agent outcomes and the standing input from the anchor's posts
  alone, then match the coalition contracts' member records and the bazaar's on-chain `standing_root`.
- The same chain on NEAR mainnet: `make anchor-check-mainnet`, `make anchor-rebuild-mainnet` (below).

The design follows our ETHGlobal Mumbai build, where `HistoryAnchor` kept Arc's round history on
Ethereum, and the Arc anchor in `docs/anchor.md` (now `make arc-anchor-rebuild`). What is new
here: the anchored market is our own NEAR economy, anyone can post, and the contract hashes the
records itself.

## What is in it

The watched contracts (`WATCH` in `scripts/econ/format.mjs`):

| contract | events |
|---|---|
| `bookerbob.testnet`, the bazaar (standard `bookerbob`) | bids committed and revealed, verdicts, settles and reverted settles, escrow, hires and `graph_event` (hire and seed), `graph_scores`, `graph_program_set`, standing roots, OutLayer referee results (`referee_receipt`, `receipt_refused`, `referee_failed`), arbiter results (`dispute_overturned`, `dispute_upheld`, `dispute_overturned_after_settle`), merchants, reviews |
| `market.bookerbob.testnet` (the DAO-owned bazaar copy), `bookerbob-dao-bazaar.testnet` (the timelocked test bazaar), `gate.bookerbob.testnet` | the same bazaar events on those copies, and the gate's |
| `coalition.bookerbob-demo.testnet` (jobs A to C) and `coalition-v2.bookerbob-demo.testnet` (`bookerbob-coalition`) | `job_opened`, `job_funded`, `joined`, `join_refused`, `delivered`, `announced`, `job_finalized` (who delivered, their share and returned bond, who was slashed and the bond lost) |
| `bookerbob-dusdc.testnet` (`nep141`) | `ft_transfer`, `ft_mint`: bonds, payouts, settlements |
| `smith-reg.bookerbob-demo.testnet` and the superseded `smith-registry.bookerbob-demo.testnet` (`bookerbob-smith`) | `register`, `pin`, `request`, `accept`, `use`, `verifier_key` |
| `outlayer.testnet` (`near-outlayer`), only inside txs found above | `execution_requested`, `execution_completed` |

An **event** is one `EVENT_JSON:` log line written by a watched contract in a successful receipt.
Discovery lists every transaction that touched a watched contract (FastNear's public tx indexer,
`tx.test.fastnear.com`); the logs come from those transactions' receipts, from the indexer or from
NEAR's public archival RPC (`EXPERIMENTAL_tx_status`, `make anchor-check ECON_FLAGS=--rpc`).
Contracts outside the list (any other account in the economy) are not in the anchor.

## The bytes

One **record** per event, big-endian, no padding:

    u8 version (1) || u64 block height || u64 block timestamp (ns) || receipt id (32)
    || u16 log index || u8 len(executor) || executor || u32 len(json) || json

`json` is the log after `EVENT_JSON:`, byte for byte as the contract logged it: nothing is
re-encoded, so a record checks against any node's copy of the receipt. The block timestamp is the
exact u64 in nanoseconds (it is past 2^53, so a reader must not parse it as a float).

**Order**: block height, then the receipt id's 32 bytes, then the log index. Every source gives
the same order, since all three come from the receipt itself.

**Epoch**: `block timestamp / 3600 s` (integer division), one hour of block time. An hour with no
event gets no post. Only closed hours are posted (the poster waits 5 minutes after the hour; the
contract refuses an epoch that has not ended).

    events = sha256( sha256(record_1) || ... || sha256(record_n) )
    root   = sha256( "bookerbob-econ/epoch/v1" || u32 len(source) || source || u64 epoch || u32 n || events )
    head   = sha256( "bookerbob-econ/head/v1" || u32 len(poster) || poster || u32 len(source) || source
                     || u64 seq || prev (32) || root (32) )

`source` is `near:testnet:bookerbob.testnet`. `prev` is the poster's previous head for this
source, 32 zero bytes before its first post. Changing any old record changes that epoch's root
and every later head.

**Why sha256.** NEAR has a sha256 host function (`env::sha256`), so the contract hashes a 270 KB
epoch for a few Tgas; BLAKE3 has no host function and would run as wasm, many times the gas for
the same bytes. The bazaar's `graph_root`, its verdict digests and the Arc anchor are already
sha256, so one hash covers the whole stack.

## The contract

`anchor-open/src/lib.rs`, no owner, no upgrade method, no method that rewrites or deletes an entry.

- `post(Post)`, borsh arguments `{source: String, seq: u64, prev: [u8; 32], epoch: u64,
  records: Vec<Vec<u8>>}`. **Anyone may post.** Each poster has its own chain per source.
  The contract checks: `seq` is the poster's count so far, `prev` its current head, `epoch` after
  its last epoch and before the current one (an open or future epoch would freeze the chain), at
  least one record; each record has version 1, fields whose lengths add up, and a block timestamp
  inside `epoch`; records are in strictly increasing (height, receipt, log index) order, so one
  event cannot appear twice in an epoch. Then it computes `events`, `root` and `head` itself from
  the records and stores them; it keeps no record bytes. One NEP-297 event,
  `bookerbob-anchor-open` / `post`. The poster pays its storage (a deposit, the rest refunded), or
  the anchor account posts from its own balance with a function-call key limited to `post`.
- Views: `head(poster, source)`, `len(poster, source)`, `get(poster, source, seq)` (epoch, n,
  events, root, prev, head, block height, timestamp), `chains(from, limit)`.

**Pin the poster.** A post proves only who sent it. A reader names the poster it trusts and reads
that poster's chain; other posters' chains sit beside it and change nothing. Anyone can run
`make anchor-check` for any poster (`ECON_POSTER=<account>`).

Tests (`make anchor-open-test`): 8 contract tests, among them a byte vector shared with
`scripts/econ/anchor.test.mjs`, two posters on one source, wrong seq, prev and epoch, an open or
future epoch, a replay, records out of order, duplicated, outside the epoch or of the wrong
length, and all 42 real epochs through the contract's code with every head equal to the script's.

## `make anchor-check`

Reads every tx of the watched contracts again (the indexer lists them), rebuilds the records and
the chain, and compares every entry on the anchor (epoch, count, events hash, root, prev, head).
This shows the posted records are the ones the watched contracts logged, for the txs discovery
found.

Then completeness, for the two streams that have counters, read at the last anchored event's
block from the archival RPC (the state right after it): the bazaar's graph events must be 1..N
with no gap, N must equal the bazaar's `graph_root` event count there, and the last anchored
running root must equal its root; each coalition contract's anchored `job_opened` ids must run
0..k-1 where `job(k)` is the first missing job at that block.

- `ECON_FLAGS=--tamper`: one event of one epoch changed locally (nothing on chain changes); the
  check fails at that epoch and every later head differs.
- `ECON_FLAGS=--rpc=N`: the first N txs again from NEAR's public archival RPC (throttled by
  `TX_GAP_MS`, endpoint `NEAR_ARCHIVAL_RPC`), compared field by field with the indexer's copy
  (receipts, executors, blocks, timestamps, logs); the records are then built from the RPC copy.
  With no N, every tx (slow on the public archive).
- `ECON_FLAGS=--snapshot`: from `fixtures/live/econ/` with no network.

## `make anchor-rebuild`: agent reputation from NEAR alone

1. Finds the poster's `post` transactions on the anchor account (the indexer, or with `--rpc` the
   archival RPC and the hashes in `fixtures/live/econ/run.json`), keeps those whose receipt on the
   anchor account succeeded, and decodes their arguments (the records). Every epoch's records must
   hash to the root the contract stored, and the heads must chain. From here on only these
   records are used.
2. Rebuilds outcomes per account (`outcomesOf` in `scripts/econ/anchor.mjs`): settles and their
   amounts, reverted settles, referee receipts and refusals, overturned disputes, released review
   ratings, hires in and out, coalition joins, completed and slashed jobs, earned and lost bond.
   Each coalition contract keeps its own per-member record (`member(account)`); for every member of
   v1 and v2 the rebuild must equal it, read at the last anchored event's block.
3. Takes the bazaar's graph events (hires and review seeds) from the records, up to the one whose
   running root is the graph root the proven standing update was over, and runs them through
   `bookerbob standing-proofs`: `bookerbob_graph::compute` (the code the Jolt standing guest proves,
   program hash pinned on the bazaar by `graph_program_set` and in both smith registries) and the
   standing tree. Its `graph_root`, `scores_hash`, `standing_root` and merchant count must equal the
   bazaar's on-chain `standing_root` at that block.

The rebuild authenticates what was posted: it proves the outcomes follow from the anchored records
and agree with the contracts' own records. It does not prove that nothing was left out; that is
the job of `make anchor-check` (below). Writes `fixtures/live/econ/outcomes.json`: every agent's
outcomes, the standing input and ranks, the programs, and the unsatisfied events below.

## Live record (testnet, 2026-11-14)

- Account `bookerbob-outcomes.testnet` (testnet faucet). Deploy, `new()` and the post-only key in
  one transaction: [9ethoPfa…](https://testnet.nearblocks.io/txns/9ethoPfauVWGWPZDyTibFLypDJHr9FR44PvJxUt7wV1C),
  code sha256 `4ddd3f946d5a220b6e76c4b1a783df7ef392a429684a7af32f33ef286a40533c`, 142,059 bytes
  (built with `cargo near build non-reproducible-wasm`; a reproducible build needs Docker and a
  committed tree, not done).
- 42 epochs, 2026-11-04 15h to 2026-11-14 15h UTC, 3,241 events, 1.03 MB of records, one
  transaction each, from seq 0 [4tPChxoV…](https://testnet.nearblocks.io/txns/4tPChxoVjcs1B1kWQQRiwYNZRtkGyWhEczgb8ukiWrof)
  to seq 41 [Eu67jggo…](https://testnet.nearblocks.io/txns/Eu67jggobGWLco9tq2yAYj564NPaL7xT6GbhQFCe4xxY);
  the busiest hour (885 events, 270,575 bytes) is seq 23 [4FnXUJc9…](https://testnet.nearblocks.io/txns/4FnXUJc9KfchvVgMNsVc7jLrUL9ihM1dEnXDiTHFPsKg).
  Every hash and its gas: `fixtures/live/econ/run.json`, `fixtures/live/econ/gas.json`.
- Head after seq 41: `143a000d4353a88fd125087cc89c424570d7bcc5aa88f84571ec425e07fe5677`.
- `make anchor-check`: `PASS  anchor: 42 epochs ... (3241 events)`; the graph events 1..10 equal
  the bazaar's `graph_root` `7f1bf041…` at block 277678669; coalition jobs 0..2 and v2 job 0, with
  `job(3)` and `job(1)` null at that block. With `--tamper`: `FAIL  anchor: first epoch that differs
  is seq 21`, the epoch holding the changed event.
- `make anchor-rebuild`: `PASS  coalition outcomes: 6 of 6 (contract, member) records ... equal that
  coalition contract's own member() view`; `PASS  standing: 10 graph events from the anchor ...
  graph_root 7f1bf041.., scores_hash 121dc8dd.., standing_root 3b5db5e9.. over 3 merchants equal
  the bazaar's on-chain standing_root`.
- Superseded: a first chain on `bookerbob-econ.testnet` (source `near:testnet:bookerbob`, 42 posts,
  head `c5ce96b9…`, `fixtures/live/econ/v0/`) carried block timestamps rounded by a float parse of
  the indexer's JSON. The archival RPC cross-check found it; the chain above has the exact values.
  That first contract also lacked the closed-epoch rule.

## On mainnet (2026-11-14)

The same 42 epochs are kept on NEAR mainnet, on the founder's OK, at the implicit account
`a145dcce5119739380e74b3295098a2ae040e1ce4679efb4a7046420cee23474` (the same wasm, code hash
`6Ex4pgQ6LGuBcgFBAmERgufvdRD2Mte3GdXhDGdfVYyq`). The records keep their testnet source: mainnet
holds the testnet economy's history. Head `796e89abc6b6844dc8869d4fe012bf9aa26f8f3450a36e1597a67d1aebba7949`.

| step | tx |
|---|---|
| fund 1.597809 NEAR from the free balance of the mainnet DCAP verifier account | [EH95qz2r…](https://nearblocks.io/txns/EH95qz2rSK8XiCBwCdfyDTGsLAqvyjE14Bf8yKUCdkLV) |
| deploy, `new()`, post-only key | [7JFTYuZb…](https://nearblocks.io/txns/7JFTYuZbzMwjd94HYaMXoQxCUEt8feYAD8fQb29hQagf) |
| top-up 0.1 NEAR from the same account, after the failure below | [3WoNFDtJ…](https://nearblocks.io/txns/3WoNFDtJLTW68dYAnVm2QNxEGBSQJZKdc9cbtAiiAu5T) |
| post seq 0..22 (23 epochs) | [FpkDR3NW…](https://nearblocks.io/txns/FpkDR3NWBxkwfoQy6Kw4gEfMsPA4PZw3eSnMfMYDE8oC) |
| post seq 23 (885 events, 270,575 bytes) | [8XTHhfxn…](https://nearblocks.io/txns/8XTHhfxnbrD7b9ubxrgPPJpHpnRE4CmYps13QQUx9xxJ) |
| post seq 24..27 | [2ETg1cNL…](https://nearblocks.io/txns/2ETg1cNL9x7aKSgfqPC2V87jFaGGPrrDEgyqbcXmfajG) |
| post seq 28..40 | [5Cvq73vS…](https://nearblocks.io/txns/5Cvq73vSwbkaWwMvkvF2NroRJ98dTX1Zt8BcoV5YY2Bp) |
| post seq 41 | [FUekAg3A…](https://nearblocks.io/txns/FUekAg3AQvNVJKoCVRvQaC1sZnvoPw3oX2acLSwMNdFE) |

Two attempts failed. `8PnkXMDz…` was rejected before inclusion and cost nothing: a function-call key
may sign only a transaction with one FunctionCall action, and it carried 23; batches are now signed
with the account's full-access key. [9J4Z5zTz…](https://nearblocks.io/txns/9J4Z5zTzaxV7xt1Ff9qa14SmTAtaqqdUf2GnTWU87g1v)
failed with `LackBalanceForState`, 0.047339 NEAR short, and burnt 0.007221 NEAR; the plan had
measured storage on testnet, where the poster's name (part of every map key) is 26 characters
against 64 here, and it left no margin for the batch's prepaid gas.

Spend, from the balances (`fixtures/mainnet/econ-anchor.json`): the DCAP verifier account went from
9.743483 to 8.037724 NEAR, 1.705759 NEAR (1.697809 sent, inside the 1.7 NEAR cap, and 0.007950 of
transfer gas). The anchor account burnt 0.027493 NEAR of gas (deploy 0.001222, five posts 0.019051,
the failed post 0.007221) and holds 1.670316 NEAR, of which 1.557000 NEAR covers its 155,700 bytes of
storage (the plan said 153,990) and 0.113316 NEAR is free. In all: **0.035443 NEAR burnt, 1.557 NEAR
locked as storage**, reclaimable by deleting the account after judging.

`make anchor-check-mainnet` and `make anchor-rebuild-mainnet` run the same checks against it
(the source contracts on testnet, the anchor on mainnet): both PASS, the rebuild with 6 of 6 member
records and the standing root `3b5db5e9…`. `node scripts/econ/mainnet.mjs plan | run --dry | run
--mainnet` is the runner; `--mainnet` refuses to start without `BOOKERBOB_MAINNET_GO=<today>`.

## Slashes as unsatisfied events: what standing and EigenTrust can read next (not built)

Today a slash on the coalition contract never reaches the standing program. The program reads
only the bazaar's graph events (hires and review seeds under `graph_root`), so a no-show loses
standing only through the 1-star reviews that follow it (docs/coalitions.md, "The hired sybil":
180 no-show legs, each bond slashed, before the reviews removed its leaf). The coalition's
outcomes sit under another contract's state, with no root the standing guest can open.

The anchor gives one authenticated root over both. `outcomesOf` already sorts these as
**unsatisfied** events (31 in the live record): `slashed` (a coalition member that took a leg and
did not deliver; account, job, bond lost), `receipt_refused` (the referee refused the merchant's
receipt), `dispute_overturned` (an arbiter overturned a referee receipt), `settle_reverted` (a
settle that did not hold). A later standing program would take as input the records of a range of
epochs and the anchor head that commits to them:

1. The guest receives the epoch records and the poster's chain heads, recomputes `events`, `root`
   and `head` for each epoch (the bytes above), and commits the final head as a public input. The
   bazaar accepts the update only when that head equals `head(poster, source)` on the anchor,
   read by a cross-contract view in the same way it reads `graph_root` today.
2. Satisfied interactions (a delivered leg, a settled purchase with a referee receipt) and
   unsatisfied ones (above) become signed local trust: for EigenTrust, `s_ij = sat(i, j) - unsat(i, j)`
   between a buyer or job lead `i` and an agent `j`, clipped at zero and normalised per `i`.
3. The pre-trusted set stays what v3 uses: attested purchase reviews by buyers who proved their
   context and paid. Trust moves from them by the same bounded fan-out, now damped by each agent's
   unsatisfied count, so a slash costs standing in the next update with no wait for reviews.

The head pins what the program reads; it does not by itself show the records are complete, so
the update would carry the same counter checks as `make anchor-check` (graph count, job ids)
inside the guest. Nothing in the bazaar or the standing guest changes for this today.

## What is checked, and what is not

- **Posted records cannot change.** The contract stores the root it computed from the posted
  bytes; changing a record changes that epoch and every later head.
- **The rebuild authenticates.** `make anchor-rebuild` proves the outcomes and the standing root
  follow from what the poster posted and agree with the contracts' own records. A poster that
  leaves out an event no counter covers (a dUSDC transfer, a bid) still passes the rebuild.
- **Completeness is partial.** `make anchor-check` compares the anchor with the txs discovery
  found; the counters (graph event count and root, coalition job ids, read at the last anchored
  block) catch a gap in those streams only. A tx that the indexer does not list is caught by
  neither. Closing that needs a second indexer or a full archival scan of the watched accounts.
- **The indexer is trusted for discovery.** In the default mode it also supplies the logs; a
  lying indexer that is consistent with what was posted passes. `--rpc` reads the logs of the
  same txs from the public archival RPC instead, and a difference fails.
- **One poster key, ours**, for the testnet chain. Anyone can post another chain for the same
  source, and the check works for any poster.
- **The anchor account can still be redeployed** by its full-access key, which BookerBob holds
  until the hackathon is judged. Deleting that key locks the code; the post-only key keeps posting.
- **The standing match covers the graph events and the standing program's code path**
  (`bookerbob_graph::compute`), run natively; the Jolt proof of that run is the bazaar's own
  standing update, checked on chain when it was finalized.
