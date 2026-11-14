# On NEAR mainnet (2026-11-13)

Everything else in this repo ran on NEAR testnet. On mainnet, with the founder's own NEAR, five
things ran once each. The facts behind the first purchase's verdict are the same synthetic
fixture facts as on testnet; the second purchase ran on the founder's real GitHub proof. The
money is real and small.

All five keyless checks at once: `make mainnet-check` (also run by `JUDGE_LIVE=1 make judge` and the daily `live` workflow).

In a browser, with no project server: [mainnet.html](https://hustle1hustle.github.io/near-bookerbob/mainnet.html) reads every tx above from public mainnet RPC with its outcome and checks the NEAR AI verdict's ed25519 signature again against the model key the bazaar holds (`agents/mainnet.html`).

| what | record | check it (keyless, public RPC) |
|---|---|---|
| The bazaar, the audited wasm: code hash `Bt2rNwTLp1wyhL5rjJfyLUigiBiLXiSMt1BD1gAqysfn`, the same as both testnet bazaars, on the implicit account `3fd1e77f…9064c7` ([deploy and init](https://nearblocks.io/txns/Dz4UugSeNPbZ2w4WYFQXTtYbzPNMJNkWeoozaqvKXbpd)) | `fixtures/mainnet/bazaar.json` | `node scripts/mainnet-bazaar.mjs check` |
| One sealed round, `mainnet-1`: two merchant agents on their own accounts commit a hash and reveal after the deadline ([open](https://nearblocks.io/txns/6btt5Yce1QoZm92XT2JS4TUomPNLgwB1nLWo4kbVzGJs), [reveal](https://nearblocks.io/txns/9sK7nHeHnDHpnZqpRkRwAW6Fyfy9WDepDUTr89BphTwJ)) | `fixtures/mainnet/bazaar.json` | `node scripts/mainnet-bazaar.mjs check` |
| One purchase: a real E2EE NEAR AI verdict (DeepSeek V4.1 Flash) over the synthetic facts; the verdict's signature by the registered NEAR AI model key is checked on chain; the model key's TDX quote is verified on chain on mainnet (Intel DCAP, verifier e99f0afb…, `node scripts/mainnet-dcap.mjs check`); a receipt from a fresh mainnet referee key, 0.9025 Circle USDC escrowed and paid to the round's lowest bidder, the replay refused ([verdict](https://nearblocks.io/txns/99A78KAXogT5N9tKWnMugMfHmw7pL6hpAfwtyQgAFUnV), [settle](https://nearblocks.io/txns/6V7RHkgzkAyZVweT5J2E6WEfz6ZV4kg8Py8pwAJpNu84), [replay refused](https://nearblocks.io/txns/BvZ9SerkAeVS1LJ5SuhkZfpzqpWwNN9uGM3ZQAP2gSec)) | `fixtures/mainnet/buy.json` | `node scripts/mainnet-buy.mjs check` |
| Real data: the founder's signed-in GitHub proof (TLSNotary) is the whole proof set; asked for `github_builder` (an account at least 3 years old), the NEAR AI model's TEE-signed answer refuses it (the account is 2 years old), and the buyer pays the plain 0.95 USDC with a verdict that claims nothing ([verdict](https://nearblocks.io/txns/9E6copWnJBPDPGm5wro7ncYkUzBaSSyvmTtmNhVKgB4u), [settle](https://nearblocks.io/txns/GwLCRE5c41gvhZPryEprGtqmWwiN3bbnKatUF8aAeSj)) | `fixtures/mainnet/real-refusal.json` | `node scripts/mainnet-real.mjs check` |
| The NEAR AI model's TDX quote verified on chain on mainnet: the same dcap-qvl verifier as `spike.bookerbob.testnet` (byte-identical wasm, code hash `7ZabqCJb…`) on `e99f0afb…4b02`, five calls ([start](https://nearblocks.io/txns/5yendWfDf5JgDABUSzASDiaf8MZmvCEvXRQJ4Wz5k6nh), [finalize](https://nearblocks.io/txns/GcfqrmXmXre9QF7icFxWFEyuugahWQuRjMaTrVaur6yt)), UpToDate, report_data the model key; then the bazaar's quote verifier set to it ([BVuM5eya…](https://nearblocks.io/txns/BVuM5eyaMnnKTPyAo8bXbv1juGLoFY6GmgdLsfdpXNK)) and the model key registered against that verification ([DuFaeAxw…](https://nearblocks.io/txns/DuFaeAxwaM9HPPrbqai5W3gtf5QSR6J7S9bnFtLhV1g2)) | `fixtures/mainnet/dcap.json` | `node scripts/mainnet-dcap.mjs check` |
| One agent-to-agent settlement on NEAR Intents: the buyer agent's signed transfer intent moved 0.1 wNEAR to the merchant agent inside `intents.near` ([execute_intents](https://nearblocks.io/txns/42TLj4c7MKCcLUHP6HqB91LDcMqC6ZRdBzHem8BbmpVz)) | `fixtures/mainnet/intents-settle.json` | `node scripts/intents-settle.mjs check` |

What is not claimed: the mainnet trust keys (model attestation registration, evaluator, referee)
are REP's, set by the bazaar's owner; the bazaar owner is its own
account with a full-access key REP holds. The verdict reveals `airbnb_frequent` and
`claude_spender` only: there is no World verifier on mainnet. The runners are gated by
`--mainnet` and `BOOKERBOB_MAINNET_GO=<today>`; `demo-live` and `deploy-testnet.sh` still refuse
mainnet.
