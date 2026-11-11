# Who it is for, who pays, why it lasts

Every number here comes from a file or a command in this repo, named at the end of its paragraph.
Testnet numbers are testnet, simulated numbers are labelled simulated.

**User.** Two of them. A person whose agent shops with a few proven facts and gets a better price, while no merchant learns who they are. And a merchant who wants to give a proven customer a better price without cutting its public price for everyone. Neither exists here yet: the buyers are our test accounts and all 30 listed merchants are REP-run (`README.md`, "Who can lie"; `make demo-offline`).

**What it saves.** In the hotel replay the public rate is 510.00, the buyer with proven bits pays 408.00, and in a group of 5 each pays 367.20 (a fixed 10% tier off 408, not a clearing price). These are testnet rounds with synthetic facts and a test token with no value; the 510 is a public JMPR comparison rate and no room was booked (`docs/testnet.md`, "A hotel stay bought on testnet"; `make audit NULLIFIER=<hex>`).

**Who pays.** The merchant. The fee is taken out of the price and never added to it, so merchant + fee = price (`contract/src/lib.rs:3078-3079`). The owner sets it, at most 2% (`contract/src/lib.rs:608`, `set_fee` at `:828`). On testnet it is 1%, 100 bps, and it goes to the Sputnik DAO `bookerbob-gov.sputnikv2.testnet`, a 2-of-3 council of accounts we created; anyone can call `sweep_fees` (`:849`). So far: 0.36 dUSDC on one 36.00 purchase, swept (`fixtures/live/testnet-manifest.json`, `fee`; `make verify-live`).

**What it costs to run.** One purchase, measured on testnet: about 0.0102 NEAR in gas and compute, plus about 0.016 NEAR of storage that no call frees today. At an assumed NEAR price of $2.50 that is $0.026, or $0.066 with storage, so a 1% fee covers a basket of $2.56, or $6.62 with storage; at $5 it is $5.12 and $13.24. Not counted: the relayer that pays every gas line in the demo, and hosting (`docs/unit-economics.md`).

**The honest pair, simulated.** In our market model (1,000 rounds, 22 merchants, assumed values, not market data), merchants that would otherwise fight on one public price keep 9.3% to 24.0% more profit with BookerBob, with the assumed lifetime-value uplift set to zero, and the buyer pays 2.28 to 2.91 more per sale than in that price war. Against fixed prices and no competition, total merchant profit falls 57.9% after the 1% fee. No merchant has agreed to pay, and none has told us it would (`docs/market-eval.md`; `make market-eval`).

**Why it keeps running without us, and where it does not.** Three things need no permission from us. A merchant joins on its own testnet account and key, approved by a 10 dUSDC bond with no owner step (`AGENTS.md`, "Join the market"; `scripts/join-merchant.mjs`), and anyone can bid blind in the community round from a faucet account (`docs/community-round.md`). Every live testnet claim is re-derived daily over public RPC, with no keys (`.github/workflows/live.yml`; `make verify-live`). And 55 rounds of our Arc testnet market are hash-chained on NEAR testnet in a contract with no method to change an entry (`docs/anchor.md`; `make anchor-rebuild`). What still needs us: an owner opens each round, every trust key (issuer, referee, arbiter, notary) is REP's, and no third party has joined yet. `market.bookerbob.testnet` is owned by the DAO from its first call, but one REP full-access key is still on it and on the anchor account, so the code can still be replaced; deleting those keys is one transaction each and is not done (`docs/testnet.md`, "market.bookerbob.testnet"; `make no-owner`).

## After the hackathon

Nothing below has a date. Each line says what must be true first.

- next: the first real fact from an account its owner holds. Needs a notary run on the buyer's own machine and a contract path that reads the notary signature at settle; today none does, and the notary key is REP's (`README.md`, "Who can lie"; `docs/prove-me.md`).
- next: the first real merchant. Needs one with a public price to anchor to, a way to check delivery (settle pays on the receipt today), and its own word that a 1% fee is worth it (`docs/unit-economics.md`, "The merchant's side").
- next: remove our hand from the code. Delete the full-access key on `market.bookerbob.testnet` and on `bookerbob-anchor.testnet`. It cannot be undone, so it waits until judging ends and no fix is pending (`docs/testnet.md`; `docs/anchor.md`, "Who can still change the code").
- next: move the remaining trust keys off one operator. The referee on OutLayer needs the founder's registration; the VOPRF and evaluator in an enclave are decided, not built (`docs/outlayer.md`; `README.md`, "Who can lie").
- next: make a purchase pay for itself. Needs a call that frees a verdict's storage (about 0.016 NEAR is locked per purchase today) and a relayer whose gas is paid by someone other than us (`docs/unit-economics.md`).
