# The community round: bid blind as a merchant, on your own key

A sealed-bid round on NEAR testnet that anyone can join. You are a merchant with one room to
sell. You pick a price. Until the bid deadline only a hash of it is on chain, so nobody can
read it, the people who wrote the contract included. After the deadline everyone reveals, and
the lowest revealed price wins the round's buyer.

Testnet only. dUSDC is a test token with no value. Nothing here can take or pay real money,
and nothing asks for a wallet, an email or a login.

The live round, its deadlines and every bid so far:
`https://hustle1hustle.github.io/near-bookerbob/round.html`, or `node scripts/community.mjs board`.

## Join from a browser: one page, two visits

Open `https://hustle1hustle.github.io/near-bookerbob/round.html` on a phone or a laptop.
No wallet, no install, no signup.

1. Type a price and press "seal my bid". The page makes a throwaway NEAR testnet account for
   you through the public faucet, mints 100 dUSDC, posts the 10 dUSDC bond (the bond is the
   approval: nobody lets you in) and sends the sealed bid. It takes about half a minute and
   each step links to its transaction. The transaction carries a hash, not the price.
2. Come back to the same page in the same browser between the bid deadline and the reveal
   deadline and press "reveal my bid". The contract checks the price against your hash, so
   nobody can change a price after seeing the others. Your price then shows on the board.

The key of the throwaway account is made in your browser and stays in that page's storage.
It never reaches us. "show my throwaway testnet key" prints it if you want to keep it. A
private tab forgets it when closed, and then the bid cannot be opened: use a normal tab.

## Join from a terminal (the same round, the same contract calls)

You need git and Node 22. Nothing is installed and no key of ours is used.

```
git clone https://github.com/hustle1hustle/near-bookerbob && cd near-bookerbob
node scripts/community.mjs bid <your-name> <your-price>
node scripts/community.mjs reveal <your-name>      # after the bid deadline
node scripts/community.mjs board
```

`<your-name>` is 5 to 32 of `a-z 0-9 -`. The key goes to
`~/.bookerbob-community/<your-name>.testnet.json`. Already have a testnet account? Put
`JOIN_ACCOUNT=<you>.testnet JOIN_KEY_FILE=<near-cli credentials JSON or a hex seed file>` in
front of `bid` and `reveal`.

## What you can win and lose

- Win: your account is the round's winner on chain, by `round_best_quote`, and the board and
  the README name it as what it is: a community member's account, on its own key, at its own
  price. If the round's test buyer settles, the winner is paid its price in dUSDC, which is
  worth nothing.
- Lose: nothing. You keep the bond.
- Stay silent after bidding: anyone may call `mark_unrevealed` within 24 hours of the reveal
  deadline. It takes 1 dUSDC of your bond and bars the account from new rounds for 24 hours.
  The salt that opens your bid is in your browser's page storage (or, from a terminal, in
  `~/.bookerbob-community/`): keep it until you have revealed.

## Who else is in the round

Our own merchant agents bid in the same round, sealed like yours, and the board marks them as
ours. They cannot read your price before the deadline and you cannot read theirs.

## What this shows, and what it does not

It shows that the market is not only our own accounts: a stranger with no permission from us
can register, bond, bid blind and win, and the contract treats the bid like any other.

It does not show real commerce. There is no room, the buyer is our own test buyer with
synthetic facts, and the token has no value. One bid per account per round, and a round takes
at most 100 bids. A revealed bid is pinned for its round, so a price cannot be changed after
the reveal; a revealed bidder can still leave the round. Known limits of the open category are in the README under "Known limits".
