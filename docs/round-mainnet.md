# The open round on NEAR mainnet: mainnet-open-1 (2026-11-14)

One sealed-bid round on the mainnet bazaar (`3fd1e77f…9064c7`, the audited wasm) that anyone can
enter with their own NEAR account and key. Bids close 21:30 UTC, reveals close 22:30 UTC, and then
our buyer agent pays the lowest revealed price in Circle USDC.

Page: `https://hustle1hustle.github.io/near-bookerbob/round-mainnet.html` (`agents/round-mainnet.html`,
config `agents/round-mainnet.json`). Record: `fixtures/mainnet/round.json`. Keyless check:
`node scripts/round-mainnet.mjs check` (also in `make mainnet-check`).

## How a stranger bids

From the page: it makes an ed25519 key in the browser. The key's public key in hex is the
account name (a NEAR implicit account). Send it about 0.1 NEAR from any wallet or exchange; that
creates the account. NEAR asks a transaction to hold more than it spends; bidding ends up using
about 0.01 NEAR (USDC storage so a winner can be paid, the merchant record, the sealed bid), and
the rest stays on the account ("show my key" exports it). The reveal is signed in the page as a
NEP-366 delegate and time-locked with drand to the bid deadline, inside the commit's arguments;
after the deadline `scripts/round-mainnet.mjs watch` opens it and relays it once, from a small relayer account of ours (0.05 NEAR, funded from the buyer only while the buyer keeps 0.4 NEAR for the settle), paying the gas. It
checks that the opened delegate is exactly one `reveal_bid` on this round signed by the bidder's
own key, so it cannot change a price.

From a terminal, with an existing account:

```
JOIN_ACCOUNT=you.near JOIN_KEY_FILE=<near-cli credentials JSON or a hex seed file> node scripts/round-mainnet.mjs bid 0.15
JOIN_ACCOUNT=you.near JOIN_KEY_FILE=... node scripts/round-mainnet.mjs reveal     # after 21:30 UTC
node scripts/round-mainnet.mjs board
```

Prices are in USDC, 0.01 to 0.23 (what the buyer holds); the page and the script refuse more.

## Who approves a bidder

The contract's permissionless `open` category approves a merchant by a 10 USDC bond, and the
contract has no way to withdraw a merchant bond. On mainnet that would lock 10 real USDC per
bidder, so this round runs in the owner-approved category `mainnet-rooms` and BookerBob's watcher
approves each account that registers in it and has registered with USDC (so a winner can be paid), while bids are open, up to 60 accounts. The watcher signs with a
function-call key on the bazaar limited to `open_round` and `approve_merchant`, with a 0.1 NEAR
gas allowance NEAR itself enforces (`check` re-reads the key's permission). The bond lane stays on
testnet (`docs/community-round.md`).

## Who else bids

Our two mainnet merchant agents (merchant-a, merchant-b, each on its own implicit account), each at
a price drawn at random from 0.12 to 0.20 USDC before the round and kept sealed like everyone
else's; and one test account of ours that ran the page's own flow (`page_test` in the record,
0.23 USDC). The page marks all three as ours.

## What it shows, and what it does not

It shows that an outside account, with no permission from us beyond the watcher's automatic
approval, can bid sealed on mainnet, reveal, win and be paid real USDC by an agent, and that every
step is on chain.

The buyer is our own agent and its facts are the synthetic fixture facts of `fixtures/mainnet/buy.json`
(a real NEAR AI verdict over them). The approval step is ours. The money is real and small.

## REP-side spend

Held to 0.25 NEAR plus at most 0.20 USDC: the watcher key's
allowance (0.1 NEAR at most), our agents' commits and reveals, relayed reveals, the purchase's gas
and storage, 0.06 NEAR to the page-test account (still ours, its key in
`~/.rep-secrets/bookerbob-mainnet`), and the winning price in USDC from the buyer's existing balance.

## The first 10 entries are sponsored

The first 10 new accounts made on the page could press "get 0.07 NEAR to start": a small service
of ours (`faucet/server.mjs`, Fly app `bookerbob-faucet`) sends 0.07 NEAR from a faucet account
funded once with 0.72 NEAR. It funds only a 64-hex implicit account that does not exist on chain
yet, one per IP per 10 minutes, ten in all; the faucet's balance alone also allows no more. Those
entries were sponsored by BookerBob; the bids on them are still each bidder's own, on a key made in
their browser. Funding and every payout: `fixtures/mainnet/faucet.json` (`node scripts/round-mainnet.mjs faucet`
re-reads it from chain), checked by `node scripts/round-mainnet.mjs check`.
