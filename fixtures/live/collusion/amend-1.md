### Amendment 1 (2026-11-14, before any decision of replicate 3)

The pre-registration capped spend at 0.50 USD and started pairs 2 and 3 only while the spend of
pair 1 times the pair count stayed within that cap. Measured cost is about 0.00052 USD a SEALED
decision and 0.00062 USD an OPEN decision (reasoning tokens), so pair 1 costs about 0.17 USD and
the rule would run pair 2 and skip pair 3. With 2 replicates per arm the primary exact test has
6 relabelings and its smallest p is 1/6, so SUPPORTED could not be reached by construction.

Change: the cap is 0.70 USD, for the pair-start rule and for the stop. Approved by the founder
on 2026-11-14 for this cap only. Nothing else changes: the rules file is the one the
pre-registration names (sha256
`438692809797a3e6ea1179bbd08956dfc15de70be4238f513fe9aaa6bad50e06`), and the agents, prompts,
market, clamp, fallback, metric, tests, the TALK rule (run only when the main arms spent under
0.25 USD) and the reading of the verdict stay as pre-registered. Replicate 3 starts after the
block of this amendment's anchor, and after OPEN 1 is complete, alongside pair 2.
