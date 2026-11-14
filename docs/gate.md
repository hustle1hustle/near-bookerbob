# Verdict Gate: a DAO role from a verdict

`gate.bookerbob.testnet` (`gate/src/lib.rs`, `scripts/gate-demo.mjs`) lets any Sputnik DAO grant
a role to an agent whose BookerBob verdict reveals a predicate. The DAO learns one bit and
the agent account; never the facts behind it.

## How it works

1. **The DAO opts in, by its own proposal.** It calls `set_rule(role, predicate, context, bond)`
   on the gate; the rule is keyed by the calling DAO, so no one else can set or change it, and
   the gate has no owner.
2. **The DAO's policy gives the gate one narrow role:** `gate`, with only
   `add_member_to_role:AddProposal` and `add_member_to_role:VoteApprove`. It cannot move funds,
   call contracts or change the policy.
3. **An agent calls `join(dao, role, nullifier)`.** The gate reads `verdict(nullifier)` from
   `bookerbob.testnet` and admits only if the verdict names the caller as its agent, reveals the
   predicate, is in the rule's context and has not expired, and the nullifier has not already
   admitted someone to that role. Then it proposes and approves `AddMemberToRole` in one call.
4. **Refused:** another agent's verdict, the same verdict twice for one role, a verdict without
   the predicate, an expired one, and a **sealed** verdict (it shows no predicate on chain, so
   there is nothing to check).

## Live on testnet (2026-11-05)

Two consumer DAOs, each created with the gate role in its policy and opting in by its own
proposal:

| DAO | role | admits on | created | rule set by its own proposal | member admitted |
|---|---|---|---|---|---|
| `lisbon-travellers.sputnikv2.testnet` | traveller | `airbnb_frequent` in the demo context | [298cZnRf…](https://testnet.nearblocks.io/txns/298cZnRfZyvvQag3p2DLR7rfHwcjKxVM3RUgvy586NYT) | [F7N8NpBP…](https://testnet.nearblocks.io/txns/F7N8NpBPBC5U4bowptXjmDWTf28v7iHhEEb2VPibysGV) | `t-4fdc17` [CvJoNKBZ…](https://testnet.nearblocks.io/txns/CvJoNKBZfsccMqfyFE2tnqBvZBb5HgeDGaKz4oQqb3yq) |
| `one-human.sputnikv2.testnet` | human | `world_id_human`, any context | [Anuymd6Q…](https://testnet.nearblocks.io/txns/Anuymd6QTA74kib6Dkvta9XH6JAzJ4Bo4uyTzULmsrLp) | [BdfBqS63…](https://testnet.nearblocks.io/txns/BdfBqS63XX1Hw6RGqFrbmNPd1L1ijHnBTRAZVbt2B1rn) | `t-22c72f` [6MDRNSw6…](https://testnet.nearblocks.io/txns/6MDRNSw6Qqp8swjzpNBqEjVks1fqFvq3VPRhf8xd3NCA) |

Refused on chain: another agent's unused verdict [5gbpD7KK…](https://testnet.nearblocks.io/txns/5gbpD7KK4G8oajwS28jpto7zzVrDFSyvKRAdxzsMcXK2), the same verdict again
[H3WxG5Gd…](https://testnet.nearblocks.io/txns/H3WxG5GdCqpEsiGbojCGy6zTQHWCBPxLNQSuB8vAFZir), a sealed verdict [7XZKVZQX…](https://testnet.nearblocks.io/txns/7XZKVZQXnx33LTmfczBns3xegKHo4WtJBiuhq3pbDQ22). `make verify-live` re-checks the
rules, the role members, the gate role's permissions and the three refusals.

## Stated plainly

- **Both DAOs belong to us (the BookerBob operator).** Their council is `bookerbob-dao-ops.testnet`; they are separate
  consumers of the gate, but not outside operators. An outside DAO needs only the policy role
  and its own `set_rule` proposal.
- **The facts behind the verdicts are synthetic**, as for every demo buyer.
- **The gate account keeps its full-access key** today (the operator's), so its code could be replaced;
  the same fix as the bazaar applies (docs: `make no-owner`).
- A DAO that trusts the gate trusts the bazaar's verdicts, so it inherits the bazaar's trust
  anchors (README, "Who can lie").
