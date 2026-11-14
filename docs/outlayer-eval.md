# The evaluator inside OutLayer's TEE

The buyer's zkTLS facts go sealed into OutLayer's TEE. There the evaluator checks the
notary-signed TLSNotary presentation, derives the facts and the predicates, and signs the verdict
with a key the TEE derives. The bazaar accepts it through its ordinary `submit_verdict`, under that
key registered as an issuer. Our issuer, the bazaar, the relayer and the merchants see the
revealed predicates and hashes. The facts stay sealed to the TEE.

Two versions:

- **v0, deployed on testnet** (2026-11-14). It runs live: release `evaluator-v0`, sha256
  `a77f88c9…65ba`, project `bookerbob.testnet/bookerbob-evaluator`, key `be7c92fe…4b58`
  registered as an issuer on `bookerbob.testnet`. An audit the same evening found the issues below.
  v0 seals the presented facts to the TEE; under CRIT 1 those facts can belong to another account.
  It does not establish one account per context, and its verdicts can be linked across contexts.
  **The v0 key is still a registered issuer on `bookerbob.testnet`, and that bazaar is locked, so
  the key cannot be revoked: verdicts in the CRIT 1 shape (another account's facts and nullifier)
  can still be submitted there.** Sources kept in `worker/outlayer-eval/v0/`.
- **v1: audited, all named tests pass (22/22), wasm 4d2c4a3b; not deployed, since the testnet
  bazaar is locked and new issuers need its deleted owner key.** An independent review of the
  fixes (2026-11-14) found no CRIT or HIGH. It found open items for a v2: the hidden range starts in
  the `Authorization` value but may run on into further hidden headers, and request headers such as
  `Host` are not checked. The binding uses only public inputs, so GitHub can link the account to the
  `cnf`. Bare-LF line ends are not counted. Transcript sizes are not capped before decoding.
  v1 fixes the audit issues below (`worker/outlayer-eval/src`,
  sha256 `4d2c4a3b…f107` at the fixed build path). `bookerbob.testnet` is locked (no full-access
  key), and it owns both the OutLayer project and the bazaar's trust anchors. So v1 cannot be
  published as a version of that project, and no new issuer can be registered on that bazaar.
  Running v1 live needs a bazaar whose owner can register its key, and a presentation in the v1
  request shape (below). **The v0 and v1 keys must never both be issuers on one bazaar**: a bazaar
  that registers v1 must not list v0's key.

Check v0's live run keylessly: `make outlayer-eval-verify` (20 checks over public RPC). Run v1
locally: `make outlayer-eval-local`.

## What runs where

| step | where | sees the facts |
|---|---|---|
| the buyer seals `{presentation, context, cnf, cap, ttl, predicates to reveal, salt}` to `seal_x25519` | the buyer's machine | the buyer |
| `request_execution` on OutLayer with that ciphertext as `input_data` | chain (public) | no one: ciphertext only |
| open; verify the presentation; derive facts, predicates, tier, nullifier, commitment; sign | OutLayer worker, Intel TDX | the TEE run |
| the output: the signed envelope (hashes and the revealed predicates), or a signed refusal | chain (public) | no one: no fact is in it |
| `submit_verdict` from the buyer (`cnf`) | the bazaar | no one |

## The audit of v0, and v1

| # | v0 (deployed) | v1 (code) | v1 test |
|---|---|---|---|
| CRIT 1 | Everything past the request line could be hidden. A second request hidden after `GET /user` (for example `GET /users/<someone else>`) could have its answer's `created_at` read as the buyer's: another account's age and nullifier, so unlimited sybil verdicts. | The request is revealed except one range inside the value of `Authorization`, which must be the last header. The only revealed `\r\n\r\n` ends the request. The facts are read only from the first response: its head and body fully revealed, `200 OK`, one `Content-Length`, no transfer or content encoding, the body one JSON object with unique top-level keys, its top-level `id` and `created_at` read. A request pipelined inside the hidden range is answered after the first response, and nothing of that answer is read. | `pipelined_second_request_is_refused`, `a_revealed_second_request_is_refused`, `hiding_anything_but_the_authorization_value_is_refused`, `chunked_or_encoded_or_unbounded_bodies_are_refused`, `fields_outside_the_first_body_do_not_count` |
| HIGH 2 | No agent binding, no freshness: the committed founder presentation could be replayed by anyone under their own `cnf`. | The request line must be `GET /user?bb=<sha256("bookerbob/eval-bind/v1\|cnf\|context")> HTTP/1.1`, and the session must be at most 6 h old by the OutLayer worker's system clock (5 min skew), which TDX does not attest. | `replay_under_another_agent_or_context_is_refused`, `stale_or_future_sessions_are_refused`, `v1_refuses_the_v0_era_presentation` |
| HIGH 3 | The nullifier came from `created_at`, which is not unique per account. | It comes from the account `id`. | `one_account_id_one_nullifier_per_context` |
| HIGH 4 | Linkable across contexts: `proof_hash` was the same in every context, and a refusal published the presentation's sha256 next to the `cnf`. | `proof_hash` is salted by the buyer's salt, and a refusal names only the context, the agent and a fixed reason. | `two_contexts_share_nothing_linkable`, the refusal checks in `real.rs` |
| HIGH 5 | Keys bound to the project (`bind: "project"`): the project owner can publish other code under them. | `bind: "wasm"` in the manifest: OutLayer issues such keys only to a direct run of that wasm URL. Untested on OutLayer, since nothing was sent after the audit. A new build gets new keys, and so a new nullifier space. | none (OutLayer behavior) |
| MED 6 | `verify` left the pubkey, submit, register, anchor, funding, buyers, context, keys and the sybil's args unbound. | `verify` binds every tx's signer, receiver, method and args to the record (20 checks). | `scripts/outlayer-eval.test.mjs`: replay plus 13 tampers |
| MED 7 | The buyer chose any context, and a new context gave a new nullifier. | A compiled list of contexts (`CONTEXTS`); any other gets an error and nothing signed. | `a_context_outside_the_list_or_a_bad_cnf_gets_nothing_signed` |
| MED 8 | The zero-predicate verdict was described as "one real account per context". | Reworded here: v0 seals the presented facts to the TEE, and under CRIT 1 those facts can belong to another account. | |
| LOW 9 | Some errors echoed input bytes. | Errors and refusal reasons are fixed strings. | `no_clock_no_verdict_and_errors_carry_no_input` |
| LOW 10 | Without a clock, `issued_at_ms` fell back to the buyer's value. | No clock, no verdict. The clock is the OutLayer worker's system clock, which TDX does not attest; checking it against NEAR's block timestamp is a next step. | same |
| re-audit LOW | A nested `"id"` or a duplicate key could be read as the account; a refusal was signed over any `cnf` and context. | The whole first body must be revealed and is parsed as one JSON object; a duplicate top-level key is refused and only the top-level `id` and `created_at` are read. A `cnf` that is not a NEAR account id, or a context outside the list, gets an error and nothing signed. | `a_nested_or_duplicate_id_is_not_the_account`, `a_partly_hidden_body_is_refused`, `a_context_outside_the_list_or_a_bad_cnf_gets_nothing_signed` |
| LOW 11 | The driver's header said the buyer sent the accept run. | Corrected: `bookerbob.testnet` sent it. | |

v1 is three layers, each tested on its own (`worker/outlayer-eval/src/lib.rs`):

1. `verify_presentation`: upstream TLSNotary `v0.1.0-alpha.15` checks the notary's signature, the
   server certificate chain (Mozilla roots), and the notary key against the pinned list. It returns
   the transcript and a mask of the revealed bytes. It is tested on the real committed
   presentations (`tests/real.rs`, 7 tests).
2. `check_transcript`: the policy above, a pure function of the transcript, the binding and the
   clock (the OutLayer worker's system clock, which TDX does not attest). It is tested on
   constructed transcripts, one per attack (`tests/policy.rs`, 15 tests).
   These stand for what layer 1 outputs. No real presentation in the v1 shape exists yet.
3. `evaluate_account`: the fact `github.account_age_years`, predicates and tier from the
   workspace rule table, the nullifier (an ed25519 signature under a TEE key over the context and
   the account id, hashed; a PRF only the TEE can evaluate), the commitment, the salted proof hash,
   and the signed envelope.

`worker/outlayer-eval/host` (8 checks) runs the v1 wasm in wasmtime 36 with a MOCK signing host:
- its pubkey statement is byte-identical to the native library's;
- the real presentations are verified inside the component, then refused by the policy (signed, naming no presentation);
- a plaintext input is refused with nothing echoed;
- a layer-3 verdict goes into the real bazaar code on near-sdk's mocked chain: `submit_verdict`
  accepts it under the registered key, refuses the same GitHub id under a second agent
  (`nullifier pending`), refuses an unregistered key, and refuses a forged predicate.

A presentation v1 accepts needs the prover (`scripts/prove-me.mjs`, the extension) to request
`GET /user?bb=<binding>` with the token as the last header. It must also reveal the whole request
except the token and the whole first response (head and body), and
GitHub must answer with a `Content-Length` and no compression (`Accept-Encoding: identity`). That
prover change is not made.

## The live run of v0, 2026-11-14 (testnet)

Record: `fixtures/live/outlayer/eval.json`. Driver: `scripts/outlayer-eval.mjs` (plan by default, one
step per `--go`; the steps are for v0 and the record is v0's).

The presentation is the founder's own GitHub account, signed in (`GET /user`, the rest of the
request hidden), notarized by REP's Fly notary (`02114d7e…`, outside a TEE), committed as
`fixtures/live/prove-me/founder-github-owner.presentation`. The account is 2 years old and proves
no GitHub predicate, so the accept reveals none.

| step | tx | what it shows |
|---|---|---|
| `create_project` | [FHyFCSD1…](https://testnet.nearblocks.io/txns/FHyFCSD1xhV8ifZMYX585zaQUegdZu4pAF2zytrWPcs) | `bookerbob.testnet/bookerbob-evaluator`, version `a77f88c9…65ba`, release `evaluator-v0` |
| pubkey | [9yDskw4N…](https://testnet.nearblocks.io/txns/9yDskw4NWp4cVYqPa3Rqj8M33pjWnbuzrzoGuuciwYzS), resolve [Gmz33c7C…](https://testnet.nearblocks.io/txns/Gmz33c7C49PRDF8FhLQhKRPNFASxUqMpT4hkDRmwSNds) | `evaluator_key be7c92fe…4b58`, `seal_x25519 86097ce0…5959`, signed |
| `register_issuer` | [4dCK9ayK…](https://testnet.nearblocks.io/txns/4dCK9ayKvKHtSySmAiA6j1293wCDBUxRHAreAanfj3bd), then `execute_anchor` [EvBWgAoW…](https://testnet.nearblocks.io/txns/EvBWgAoW1acgG7kJwR1A52gDsaT3qA7AjGBdALz3ovNf) | anchor 5, after the 5 minute delay |
| accept (sent by `bookerbob.testnet`) | [Bqc8J1Xs…](https://testnet.nearblocks.io/txns/Bqc8J1XsuXPYghJ1dkJsRWDVwbCazHkeLB73CPaiB3jB), resolve [AcpZJXHh…](https://testnet.nearblocks.io/txns/AcpZJXHhwLPEfhStibuot2vQEpWoXSQPwsNq8tCR3z3C) | request 47510: sealed presentation in, a verdict signed by the TEE key out, nothing revealed; 204,677,914 instructions, 1,864 ms |
| `submit_verdict` (buyer A) | [EVd12BCD…](https://testnet.nearblocks.io/txns/EVd12BCD2VRLkKdewfqpsP2FR3gTvTSHJKD61fY2SjMG) | the bazaar records it, issuer `ed25519:be7c92fe…` |
| second agent (buyer B) | [DLKKXVWD…](https://testnet.nearblocks.io/txns/DLKKXVWD7yMuQoBfKpEb5BCaVYdFht414gWVAu7fqEZe), resolve [5ez17Md9…](https://testnet.nearblocks.io/txns/5ez17Md9kXwRCLxzd9UeenxUjhdn16ncpLxHJwCyzsMU), submit [HGm3Hrpr…](https://testnet.nearblocks.io/txns/HGm3HrprcZTjgnhXWBug2b8We73m6ARE6Xu6kC3toYTM) | the same presentation under another `cnf` (which v0 did not bind): the same nullifier, and the bazaar refuses it with `nullifier pending` |
| refuse (buyer A) | [7xCsPaXa…](https://testnet.nearblocks.io/txns/7xCsPaXa3m7e1gZ9JDjWD1S6XHfVz9sJNVSQa9VTLQx), resolve [985AmsvQ…](https://testnet.nearblocks.io/txns/985AmsvQbPQ9a5u7KJ5rG5jD4R8eSPfDz18ELBUxFmoj) | the same presentation asking for `github_builder`: a refusal signed by the TEE key |

The buyers are one-time implicit accounts funded by the demo treasury (`bookerbob-demo.testnet`).
Every OutLayer callback timed out on the yield window (as in `docs/outlayer.md`), so each output
was read from OutLayer's resolve tx for the same request id, and `verify` re-reads it there.

Other runs: request 47443 (tx Bn32vRbR…) failed because the driver wrapped the sealed input twice,
so the component answered an error and exited 1. A second accept run returned a valid verdict, but
the driver crashed reading OutLayer's resolve shape before saving it, and its output is not used.
Two buyer sends were refused by the RPC for balance and never landed.

What `verify` re-derives over public RPC, with no keys, for each tx: the signer, the receiver, the
method and the args, against the record. That covers:
- the project and its build;
- each run's sender, project and input shape, and that its output is what
  `worker.outlayer.testnet` posted for that request id;
- the pubkey statement;
- the owner's `register_issuer` for exactly this key, its anchor id, and the `execute_anchor` that applied it;
- the buyers' funding;
- the verdict's signature (checked exactly as `submit_verdict` checks it), its `cnf` and context;
- buyer A's submit, carrying exactly the TEE's output, and the bazaar's record (issuer, agent, context);
- buyer B's verdict and its refused submit;
- the signed refusal.

## Trust

- **The pinned notary keys**: `0307293878…ed32` (REP's notary inside an Intel TDX enclave on
  Phala, `rep-notary-ext`, key 1) and `02114d7e…25ef` (REP's Fly notary). A notary colluding with a
  buyer can sign a false transcript. The live presentation is from the Fly notary.
- **OutLayer's keystore**, which derives the keys inside its TEE. Its own attestation is outside
  these checks (`docs/outlayer.md`, "Trust").
- **The project owner**, for v0: `bookerbob.testnet` owns the project, and v0's keys are bound to
  the project, so that account could publish other code under the same keys. It is now locked, which
  ends that power and also any update. v1 binds its keys to the wasm instead (HIGH 5).
- **OutLayer's approved worker measurements**, for the TDX side. These runs' TDX quotes have not
  been put through `scripts/outlayer-attest.mjs` (the OutLayer worktree's on-chain DCAP check).

## Limits (v1)

- One presentation per run, GitHub `/user` only.
- The prover does not yet produce the v1 request shape, so no live v1 accept exists.
- `bind: "wasm"` is from OutLayer's documentation and source, and has not been run.
- `tcb_status` in the envelope is `fixture`, which the bazaar accepts on testnet only.
- The referee and settle steps of a purchase are not wired to this issuer's proof set.
