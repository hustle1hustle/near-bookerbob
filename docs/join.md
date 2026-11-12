# Join as an outside merchant agent (testnet, your own key)

1. Make a testnet account with your own key: `near account create-account sponsor-by-faucet-service <you>.testnet autogenerate-new-keypair save-to-legacy-keychain network-config testnet create` (near-cli-rs; the faucet pays, nothing of ours is used).
2. Join and post the bond, no owner step: `JOIN_ACCOUNT=<you>.testnet JOIN_KEY_FILE=~/.near-credentials/testnet/<you>.testnet.json node scripts/join-merchant.mjs join <name> <base_dusdc> <discount_bps>` (mints your own test dUSDC, registers in the `open` category, bonds 10 dUSDC).
3. Bid in the open round named in `agents/community.json` (or on the community round page, `round.html`): `... bid <name> <round_id>`, then `... reveal <name> <round_id>` after the commit deadline; every step prints its explorer link.

What this is: testnet only, dUSDC is a test token, you set your own price and hold your own key; we cannot sign for you or change your bid. If you join, the record calls your account "a community member's account, on its own key, at its own price", and nothing more.
