# History anchor: a market runs anywhere, its history lives on NEAR

A market can run on any chain. If its round history is also kept on NEAR, two things follow:
the market's state can be rebuilt from public data and checked, and the history cannot be
rewritten after the fact, because every round is chained to the one before it in a contract
that has no method to change an entry.

`anchor/src/lib.rs` is that contract. `scripts/anchor.mjs` reads a foreign market, cuts its
public logs into rounds, posts one root per round, and rebuilds and checks the whole thing.
The foreign market here is real: our ETHGlobal Mumbai build on Arc testnet (chain id 5042002,
market contract `0xcfbbe8aa3c231f3345afa7798f65b03e2738d56f`), 1,255 public logs in 55 rounds
between 2026-11-06 and 2026-11-07.

This is an auxiliary contract next to the bazaar, like the gate and dUSDC. It is not a second
market and the bazaar does not depend on it.

## The contract

- `new(poster)`: pins the one account that may post. There is no method to change it.
- `post(source, seq, prev, root, meta)`: only the poster. `source` names the foreign market
  (`eip155:<chain id>:<contract>`), `seq` must be the number of posts so far for that source,
  `prev` must be that source's current head. Returns the new head and logs one NEP-297 event
  (`standard: bookerbob-anchor`, `event: post`). The poster pays the storage: an attached
  deposit covers it and the rest is refunded, or, when the poster is the contract account
  itself, the account's own balance covers it.
- Views: `head(source)` (64 zeros before the first post), `len(source)`, `get(source, seq)`
  (`prev`, `root`, `meta`, `head`, block height, timestamp), `poster()`.

The head, exactly (all lengths and integers big-endian):

    head = sha256( "bookerbob-anchor/head/v1"
                   || u32(len(source)) || source || u64(seq)
                   || prev (32) || root (32)
                   || u32(len(meta)) || meta )

Each source has its own chain. A wrong poster, a wrong `seq`, a wrong `prev` and a replay are
refused (12 unit tests, one of them the 55 real Arc rounds through the contract code).

## The round root, exactly

A **round** is every log, in (block, logIndex) order, from blocks whose
`timestamp / 300` (integer division, the market's `epochLength`) equals the round number. The
logs are the market contract's, its seed registry's
(`0xd3fe2ec6b78f6e3d9c974b48fbea66c28bd8183b`), and the logs of the Semaphore contract
(`0x39646392d135dcde126b23bca5c8e020cc17f3e8`) from transactions that also carry a market or
registry log. A round with no logs gets no post. Only closed rounds are posted: every round
before the one the chain is in now.

One log's bytes (big-endian, no padding):

    u64 block || u64 timestamp || u32 logIndex || tx (32) || address (20)
    || u8 topics || each topic (32) || u32 len(data) || data
    || u8 extra || each extra word (32)

`extra` is what a log needs from its transaction's calldata, because no event carries it: for
`Joined` the buyer's commitment and the three nullifiers (receipt, context, payee) of the
`join` call; for `Reviewed` and `ReturningBuyer` the one nullifier of the `review` or
`proveReturn` call. Every other log has none.

    events = sha256( sha256(log_1) || ... || sha256(log_n) )
    state  = sha256( canonical JSON of the market state after this round )
    root   = sha256( "bookerbob-anchor/round/v1"
                     || u32(len(source)) || source || u64(round) || u32(n)
                     || events (32) || state (32) )

Canonical JSON: object keys in code-unit order, no whitespace, every number a decimal string,
32-byte values as `0x` and 64 hex characters. The state is cumulative (it carries every earlier
round) and is built by these rules, in log order:

| log | state |
|---|---|
| registry `IssuerSet`, `ContextAdded`, `MemberAdded`, `MemberReplaced` | `issuers[id]`, `contexts[id] = {issuer, budget, group, members[]}`; a replacement swaps the commitment in place |
| Semaphore `GroupCreated`, `MemberAdded`, `MembersAdded`, `MemberUpdated`, `MemberRemoved` | `groups[id] = {members[], root}`: members by index, `root` the Merkle root the log states |
| `Settled`, `SettledOffGraph` | `paid[epoch]`: count and sum, on and off the graph |
| `ReceiptRegistered` | `receipts[payee\|epoch] = group` |
| `Joined`, `JoinClosed`, `GroupUnlocked` | `joins[payee\|context\|epoch] = {joined, closed {group, members}, unlocked}`; the three nullifiers go to `nullifiers` |
| `Reviewed`, `ReturningBuyer` | `reviews[...]` scores in order, `returning[...]` order refs; the nullifier goes to `nullifiers` |
| `Minted`, `Carried` | `minted[epoch\|context]` nodes and sum, `carried[epoch\|context]` |
| `RankSubmitted`, `LongList` | `lists[epoch\|context] = {hash, long {at, values}}` |
| `ViewDefined`, `AdminDropped` | `views[]`, `admin_dropped` |

`nullifiers` is the sorted list of every spent nullifier. The replay also reports a state the
market's contracts could not have produced: a member index out of order, a nullifier spent
twice, a join closed with a member count other than the joins seen, a block in an earlier
round than the one before it, an event this file does not know. On the real data: 0 problems.

`meta`, the free text next to each root, is
`{"v":1,"round":R,"blocks":[first,last],"logs":n,"events":"<hex>","state":"<hex>"}`. It is under
the head hash, so a rebuild can say which part of a round differs.

The Arc market after its 55 rounds, as rebuilt: 58 Semaphore groups with 339 members, 6
contexts with 51 members, 476 nullifiers, 23 buying groups (all closed), 89 reviews, 20 lists,
262 payments (`fixtures/live/anchor/state.json`, state hash `733488a9…cdcb93`).

## What is checked, and what is not

`make anchor-rebuild` reads the anchors from NEAR and the logs from Arc's public RPC, then for
every round: NEAR's entry must chain from NEAR's previous head by the hash above, name the
same round, and hold the events hash, state hash, root and head that the rebuild computed. One
`PASS` line per round, then, when all pass, the live Semaphore root of every group on Arc
against the root rebuilt from the logs, then one final `PASS` or `FAIL`.

`ANCHOR_FLAGS=--tamper make anchor-rebuild` flips one bit of one Arc log locally (nothing on
either chain changes) and must fail first at that log's round; every later round fails too,
since its head no longer chains. `--tamper=<round>` picks the round.

Not checked, stated plainly:

- **It does not prove the foreign chain's events are true.** It proves that the history
  posted cannot change, and that today's Arc logs still produce it. If the poster posts a
  wrong root, the wrong root is what is kept; a rebuild then fails at that round, forever.
- **One poster key, ours.** No one else can post, and no one checks a root before it lands.
- **NEAR holds the roots, not the data.** The logs come from Arc's RPC, or from the snapshot
  committed here (`fixtures/live/anchor/arc-logs.json`, public data: `--snapshot`). If Arc
  testnet were reset, the snapshot plus the roots on NEAR would still show what the history
  was; with neither the snapshot nor Arc, the roots alone rebuild nothing.
- **Semaphore Merkle roots are read from the logs, not recomputed** (no Poseidon here). The
  member lists are rebuilt; their root is compared with the live contract, not derived.
- **The round of a log comes from the RPC's `blockTimestamp` field**, and the nullifiers from
  `eth_getTransactionByHash`. A lying RPC makes the rebuild fail, it cannot make it pass
  against roots computed from an honest one.
- The contract does not parse `meta` and does not know what a round is.

## Who can still change the code

The contract has no owner, no upgrade method and no method that rewrites or deletes an entry.
What remains is the account itself: whoever holds a full-access key of
`bookerbob-anchor.testnet` can deploy other code over it or delete the account. That key is
ours. The poster does not use it: posting uses a second key, a function-call key limited to
`post` on this account, which cannot deploy, transfer or add keys.

Locking it is one transaction: delete the full-access key. After that no one can replace the
code, the post-only key keeps posting, storage is paid from the account's balance, and anyone
can top the balance up with a plain transfer. Not done: we keep the key until the hackathon is
judged, so a bug can still be fixed. `near account list-keys bookerbob-anchor.testnet
network-config testnet-fastnear now` shows which keys exist.

## Live record

Live on NEAR testnet since 2026-11-10, at `bookerbob-anchor.testnet` (its own account, created
by the testnet faucet, so the bazaar's storage balance is not touched).

- deploy, `new(poster)` and the post-only key in one transaction: [EgM9jNbF…](https://testnet.nearblocks.io/txns/EgM9jNbFidNRciT8DUdCi9TJM8oNUYmii6PuVrGU84qf)
- 55 rounds of the Arc market (`eip155:5042002:0xcfbbe8aa3c231f3345afa7798f65b03e2738d56f`), one transaction each, from seq 0 [6KG4tUKu…](https://testnet.nearblocks.io/txns/6KG4tUKu4HVCg9khC4zuwXdovhu7tLdgzL6pKzZSDpYg) to seq 54 [2SFiDqBr…](https://testnet.nearblocks.io/txns/2SFiDqBrquceKjfEbmVrocHttwPHsPtrg65FBVuzfW8B); every hash is in `fixtures/live/anchor/run.json`
- head after seq 54: `b4e5ca0b131f9878878b616f194cbd5490b7da47e68efdba43c046773dcfa9d1`
- `make anchor-rebuild`, read live from Arc and from NEAR: `PASS  rebuild: 55 rounds, 1255 Arc logs, head b4e5ca0b…`; rebuilt state: 58 groups with 339 members, 6 contexts with 51 members, 476 nullifiers, 20 lists, 262 payments
- `ANCHOR_FLAGS=--tamper make anchor-rebuild`: one log changed locally, `FAIL  rebuild: first failing round 5979973`, the round that holds the changed log
- `make anchor-verify` (no keys): the committed record equals the contract's views

Account and contract: `https://testnet.nearblocks.io/address/bookerbob-anchor.testnet`.

## Ideas taken from our ETHGlobal Mumbai build

That build kept its Arc history on Ethereum Sepolia. No file from it is copied here; the
contract, the script, the byte format and the tests are this repo's own. These ideas came from it:

- Keep a market's public history on a second chain as a hash chain of round roots, so changing an old round changes every later root and a round cannot be skipped.
- A round is every public log in blocks whose `timestamp / epochLength` is the round number, in (block, logIndex) order; a round with no logs gets no post.
- A post proves only who sent it, so a reader trusts one named poster, and a rebuild from the source chain is what makes that poster worth trusting.
- A posted round can never be posted again or replaced.
- Nullifiers appear in no event: read them from the calldata of the `join`, `review` and `proveReturn` calls, found by selector through any wrapper.
- Rebuild the market state by replaying logs in order: contexts, members and replacements, receipt groups, join queues and their closing, reviews, mints, lists.
- Use the Semaphore group roots as a check that members were inserted in the same order.
- One documented byte format that the poster and the rebuild both follow, and a `make anchor-rebuild` that checks one against the other.

What is different here: NEAR holds roots and a state hash, not the event bytes; the contract
itself enforces the sequence, the previous head and the poster (there, any account could post
and a reader filtered by poster); sha256 in place of keccak for the chain.

## The bazaar's own rounds, later (not built)

The BookerBob bazaar on NEAR could post to the same contract under a second `source`
(`near:testnet:bookerbob.testnet`), one root per commit-reveal round over its NEP-297 events.
The chain would then show a NEAR market and an Arc market side by side, each with its own head.
That needs a poster that reads the bazaar's events and a root definition for them; neither exists yet.
