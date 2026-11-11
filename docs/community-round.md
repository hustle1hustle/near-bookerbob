# The community round: bid blind as a merchant, on your own key

A sealed-bid round on NEAR testnet that anyone can join. You are a merchant with one room to
sell. You pick a price. Until the bid deadline only a hash of it is on chain, so nobody can
read it, the people who wrote the contract included. After the deadline everyone reveals, and
the lowest revealed price wins the round's buyer.

Testnet only. dUSDC is a test token with no value. Nothing here can take or pay real money,
and nothing asks for a wallet, an email or a login.

The live round, its deadlines and every bid so far:
`https://hustle1hustle.github.io/near-bookerbob/round.html`, or `node scripts/community.mjs board`.

## Join: two commands, two visits

You need git and Node 22. Nothing is installed and no key of ours is used.

```
git clone https://github.com/hustle1hustle/near-bookerbob && cd near-bookerbob
node scripts/community.mjs bid <your-name> <your-price>
```

`<your-name>` is 5 to 32 of `a-z 0-9 -`, for example `quiet-otter-7`. `<your-price>` is a
number, for example `33.5`. You see, each with its explorer link:

1. `<your-name>.testnet` created by the public NEAR testnet faucet. Its key is made on your
   machine and saved to `~/.bookerbob-community/<your-name>.testnet.json`. We never see it.
2. 100 dUSDC minted to you (the test token lets any account mint).
3. `register_merchant` in the `open` category and a 10 dUSDC bond. The bond is the approval:
   no owner step, nobody lets you in.
4. `commit_bid`: your sealed bid. The transaction carries a hash, not the price.

Then it prints when to come back. Between the bid deadline and the reveal deadline:

```
node scripts/community.mjs reveal <your-name>
```

You see `reveal_bid` ok and your price appears on the board. A reveal that does not match
your hash is refused by the contract, so nobody can change a price after seeing the others.

After the reveal deadline, `node scripts/community.mjs board` and the page name the winner.

Already have a testnet account? Put `JOIN_ACCOUNT=<you>.testnet JOIN_KEY_FILE=<near-cli
credentials JSON or a hex seed file>` in front of both commands. It pays about 0.03 testnet
NEAR in gas and storage.

## What you can win and lose

- Win: your account is the round's winner on chain, by `round_best_quote`, and the board and
  the README name it as what it is: a community member's account, on its own key, at its own
  price. If the round's test buyer settles, the winner is paid its price in dUSDC, which is
  worth nothing.
- Lose: nothing. You keep the bond.
- Stay silent after bidding: anyone may call `mark_unrevealed` within 24 hours of the reveal
  deadline. It takes 1 dUSDC of your bond and bars the account from new rounds for 24 hours.
  Keep the file in `~/.bookerbob-community/` until you have revealed: the salt in it is the
  only way to open your bid.

## Who else is in the round

Our own merchant agents bid in the same round, sealed like yours, and the board marks them as
ours. They cannot read your price before the deadline and you cannot read theirs.

## What this shows, and what it does not

It shows that the market is not only our own accounts: a stranger with no permission from us
can register, bond, bid blind and win, and the contract treats the bid like any other.

It does not show real commerce. There is no room, the buyer is our own test buyer with
synthetic facts, and the token has no value. One bid per account per round, and a round takes
at most 100 bids. Known limits of the open category are in the README under "Known limits".
