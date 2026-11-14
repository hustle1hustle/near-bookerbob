# bookerbob-faucet

Starter NEAR for the mainnet round page (`agents/round-mainnet.html`): the first 10 new implicit
accounts get 0.07 NEAR each. `server.mjs` is the whole service; it signs with `relayer/near.mjs`.

Deploy (copies the signer next to the server, the faucet seed as a Fly secret):

    cp ../relayer/near.mjs ../relayer/relay.mjs . && fly deploy --org personal
    fly secrets set FAUCET_SEED=<seed> -a bookerbob-faucet

near.mjs and relay.mjs here are build copies, not committed.
