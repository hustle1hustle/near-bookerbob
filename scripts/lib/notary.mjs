// The REP notary the prove-me and device-run pipelines use, and the presentation verifier.
// The verifier binary is not in this repo: set REP_VERIFY, or put rep-verify on PATH.
export const NOTARY_URL = "https://rep-notary.fly.dev";
export const NOTARY_KEY = "02114d7e15cb2a93ad88997af3394d00008dae381b601f31379d638de492ab25ef";
export const REP_VERIFY = process.env.REP_VERIFY || "rep-verify";
