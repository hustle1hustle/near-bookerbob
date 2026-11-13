# On NEAR mainnet (2026-11-13)

Everything else in this repo ran on NEAR testnet. On mainnet, with the founder's own NEAR, three
things ran once each. The facts behind the verdict are the same synthetic fixture facts as on
testnet; the money is real and small.

| what | record | check it (keyless, public RPC) |
|---|---|---|
| The bazaar, the audited wasm: code hash `Bt2rNwTLp1wyhL5rjJfyLUigiBiLXiSMt1BD1gAqysfn`, the same as both testnet bazaars, on the implicit account `3fd1e77f…9064c7` ([deploy and init](https://nearblocks.io/txns/Dz4UugSeNPbZ2w4WYFQXTtYbzPNMJNkWeoozaqvKXbpd)) | `fixtures/mainnet/bazaar.json` | `node scripts/mainnet-bazaar.mjs check` |
| One sealed round, `mainnet-1`: two merchant agents on their own accounts commit a hash and reveal after the deadline ([open](https://nearblocks.io/txns/6btt5Yce1QoZm92XT2JS4TUomPNLgwB1nLWo4kbVzGJs), [reveal](https://nearblocks.io/txns/9sK7nHeHnDHpnZqpRkRwAW6Fyfy9WDepDUTr89BphTwJ)) | `fixtures/mainnet/bazaar.json` | `node scripts/mainnet-bazaar.mjs check` |
| One purchase: a real E2EE NEAR AI verdict (DeepSeek V4.1 Flash) over the synthetic facts; the verdict's signature by the registered NEAR AI model key is checked on chain; the model key's TDX quote was verified on testnet (spike.bookerbob.testnet), not on mainnet; a receipt from a fresh mainnet referee key, 0.9025 Circle USDC escrowed and paid to the round's lowest bidder, the replay refused ([verdict](https://nearblocks.io/txns/99A78KAXogT5N9tKWnMugMfHmw7pL6hpAfwtyQgAFUnV), [settle](https://nearblocks.io/txns/6V7RHkgzkAyZVweT5J2E6WEfz6ZV4kg8Py8pwAJpNu84), [replay refused](https://nearblocks.io/txns/BvZ9SerkAeVS1LJ5SuhkZfpzqpWwNN9uGM3ZQAP2gSec)) | `fixtures/mainnet/buy.json` | `node scripts/mainnet-buy.mjs check` |
| One agent-to-agent settlement on NEAR Intents: the buyer agent's signed transfer intent moved 0.1 wNEAR to the merchant agent inside `intents.near` ([execute_intents](https://nearblocks.io/txns/42TLj4c7MKCcLUHP6HqB91LDcMqC6ZRdBzHem8BbmpVz)) | `fixtures/mainnet/intents-settle.json` | `node scripts/intents-settle.mjs check` |

What is not claimed: the mainnet trust keys (model attestation registration, evaluator, referee)
are REP's, set by the bazaar's owner; the model's TDX quote was verified on chain on testnet, not
on mainnet (there is no quote verifier contract on mainnet yet); the bazaar owner is its own
account with a full-access key REP holds. The verdict reveals `airbnb_frequent` and
`claude_spender` only: there is no World verifier on mainnet. The runners are gated by
`--mainnet` and `BOOKERBOB_MAINNET_GO=<today>`; `demo-live` and `deploy-testnet.sh` still refuse
mainnet.
