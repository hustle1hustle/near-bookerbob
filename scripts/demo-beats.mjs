// The 2:30 video, beat by beat: what to say, what runs on screen, the live tx it points to.
// One source for the demo script (not in this public copy) and scripts/demo-run.mjs. Lines are plain and lowercase; every
// tx is on NEAR testnet; dUSDC is a testnet demo token; the facts behind verdicts are synthetic.
// Beats marked short make the 95 s cut (demo-run --short): one buyer, one refusal, one purchase.
const tx = (h) => `https://testnet.nearblocks.io/txns/${h}`;

export const BEATS = [
  {
    t: "0:00",
    title: "title",
    short: true,
    say: "bookerbob. merchants compete for you. none of them learns who you are.",
    run: null,
    show: "title card",
  },
  {
    t: "0:06",
    title: "the problem",
    short: true,
    say: "to get a better price you hand over your history. here you prove a few facts about it, and only the verdict leaves.",
    run: null,
    show: "README first screen",
  },
  {
    t: "0:16",
    title: "prove, sealed",
    short: true,
    say: "the facts go sealed to an attested enclave on near ai. on chain the verdict is hashes only: no predicate, no tier; after the sale it shows just the price paid.",
    view: ["bookerbob.testnet", "verdict", "sealed"],
    show: "the verdict view: predicates [], tier sealed",
    link: tx("C9yVJ2s2MhxZfhuabSWTBxmRXhkYJAL2aJvXJS3i4hVP"),
  },
  {
    t: "0:32",
    title: "blind bids, code prices",
    short: true,
    say: "merchant agents bid blind, then reveal. code computes every price, not a model. the board reads the chain live.",
    run: ["open", "agents/board.html"],
    show: "board.html: the live line, bids, the discount stack",
  },
  {
    t: "0:48",
    title: "cheats refused",
    short: true,
    say: "a merchant that cites a fact you never proved gets no receipt. and one that inflates its base to fake a discount is refused on chain.",
    run: ["node", "scripts/cheat.mjs", "run"],
    show: "the red receipt card, then: h05 at 600 over its public 510, refused",
    link: tx("6M3Bi7RY6thU4yfbUUQShHz9M9drHSNwrMY683rjB16u"),
  },
  {
    t: "1:04",
    title: "the agent buys",
    short: true,
    say: "ask in plain words. the agent prices every hotel by the contract's code and picks the one that fits. this one paid 408 in dusdc.",
    run: ["node", "sdk/buy.mjs", "3 nights Lisbon under 450"],
    show: "the plan: hotel bids only, h05 wins; then the settle tx",
    link: tx("9Esa4qikkoje5yJktpxdSoCEWJitm1Mren2LiHWVyRr6"),
    planOnly: true,
  },
  {
    t: "1:20",
    title: "no owner",
    say: "this market is owned by a dao from block one. anchors go in by a two of three vote, and no single key can replace the code.",
    run: ["node", "scripts/no-owner.mjs"],
    show: "make no-owner: market.bookerbob.testnet keys, then the old bazaar with its one key",
    link: tx("3FmakCAmra7B1h9GFNGA1qsDSiiDDcHg6gooAk3KB7Vh"),
  },
  {
    t: "1:36",
    title: "strangers buy as one",
    say: "buyers who proved the same bits form a group, unlock a lower price at five, and pay from their own dao treasury.",
    run: null,
    show: "nearblocks: the group treasury release to h05",
    link: tx("5A8LgNQnNGrErkWAo48Kd8xRARK9Zqb8jEZUnbcBSV7A"),
  },
  {
    t: "1:50",
    title: "sealed reviews, proven standing",
    say: "buyers who paid rate with zero knowledge proofs, released only at five. standing comes from a jolt proof, and the chain answers is this merchant in the top half, without the scores.",
    run: ["node", "scripts/standing-root.mjs", "fixtures/zk/standing-testnet-3-input.json"],
    show: "in_top(m01, 50%) = true; a false claim refused",
    link: tx("DswLxceMNRZxjuhk5BMWDY8WANLMaxBUFNrwFgjFgTuj"),
  },
  {
    t: "2:06",
    title: "a verdict opens a door",
    say: "any dao can grant a role on a verdict. this one admits travellers who proved frequent stays, and never sees the stays.",
    run: null,
    show: "nearblocks: the gate join into lisbon-travellers",
    link: tx("CvJoNKBZfsccMqfyFE2tnqBvZBb5HgeDGaKz4oQqb3yq"),
  },
  {
    t: "2:16",
    title: "check it yourself",
    short: true,
    say: "one command checks all of it, offline or live. built at near hackathon.",
    run: ["make", "judge"],
    show: "make judge: PASS lines; end card with the repo",
  },
];

export const X_POST = "a better price costs you your history. bookerbob: your agent proves a few facts, merchant agents bid sealed, a referee refuses cheats, code sets the price. you stay unknown. testnet. built at NEAR HACKATHON @NEARProtocol #NEARHackathon github.com/hustle1hustle/near-bookerbob";
