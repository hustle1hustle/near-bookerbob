# NEP-366 relayer for sealed reviews

`relay.mjs`, no dependencies. A rater signs a NEP-366 `SignedDelegateAction` for
`submit_review` or `reveal_review` with a **fresh one-time ed25519 key**; the sender is that
key's implicit account. The relayer checks the policy and pays the gas.

`check(signed, ctx)` accepts only:
- the bazaar as receiver, exactly one `FunctionCall`, method `submit_review` or `reveal_review`;
- an attached deposit at or below the relayer's cap (storage for the sealed rating);
- `max_block_height` not passed;
- a sender that is the implicit account of the signing key (a one-time account);
- a valid ed25519 signature over `sha256(borsh(SignableMessage))`, discriminant `2^30 + 366`.

Tests (`relay.test.mjs`, synthetic, no network): a real `submit_review` from the Semaphore
fixture is accepted; another method, receiver, a deposit over the cap, an expired action,
a named account, a tampered action and a foreign signature are refused.

## Limits, stated plainly

- NEP-366 hides who pays the gas, not who signs. The one-time account is the caller on
  chain. Privacy comes from that account being fresh and unfunded by the buyer, not from
  the relayer.
- The storage deposit for `submit_review` is paid by the sender, so the relayer funds each
  one-time account with a small transfer first. That transfer links the account to the
  relayer, never to the buyer.
- The relayer sees every sender, the sealed hash during the round and the rating at reveal
  time, and it can refuse to relay (censor). Anyone can run one; the contract does not
  trust it.
- Not built yet: wrapping the delegate in the outer transaction (`Delegate` action) and
  sending it with `send_tx` on testnet. That waits on the testnet deploy.
