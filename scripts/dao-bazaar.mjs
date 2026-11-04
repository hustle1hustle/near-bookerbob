#!/usr/bin/env node
// Panel action 9, on a separate test bazaar (the live bookerbob.testnet keeps its key owner):
// the bazaar's owner is a Sputnik DAO with a 3-member council and a 2-of-3 vote, so one
// stolen council key cannot register a rogue issuer.
//   node scripts/dao-bazaar.mjs keys      seeds for ops, c1, c2, the bazaar (prints public keys)
//   node scripts/dao-bazaar.mjs setup     council accounts, the DAO, the bazaar under it
//   node scripts/dao-bazaar.mjs attack    one council key calls register_issuer directly
//   node scripts/dao-bazaar.mjs propose   proposal to register an issuer; 1 vote, then 2
// Testnet only. Seeds in KEYS_DIR/dao (outside the repo); state in KEYS_DIR/dao/state.json.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./demo-tester.mjs";
import { keyFromSeed, near, nearPublicKey, rpcClient, send } from "../relayer/near.mjs";

const TGAS = 10n ** 12n;
const c = config(process.env);
const OPS = process.env.DAO_OPS_ID || "bookerbob-dao-ops.testnet";
const BAZAAR = process.env.DAO_BAZAAR_ID || "bookerbob-dao-bazaar.testnet";
const FACTORY = "sputnikv2.testnet";
const DAO_NAME = process.env.DAO_NAME || "bookerbob-gov";
const DAO = `${DAO_NAME}.${FACTORY}`;
const USDC = "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af";
for (const a of [OPS, BAZAAR, DAO]) if (!a.endsWith(".testnet")) { console.error(`refusing: ${a} is not testnet`); process.exit(2); }
const dir = join(c.keysDir, "dao");
mkdirSync(dir, { recursive: true });
const statePath = join(dir, "state.json");
const st = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { txs: {} };
const save = () => writeFileSync(statePath, JSON.stringify(st, null, 2) + "\n", { mode: 0o600 });
const seed = (n) => {
  const p = join(dir, `${n}.seed`);
  if (!existsSync(p)) writeFileSync(p, randomBytes(32).toString("hex") + "\n", { mode: 0o600 });
  return keyFromSeed(readFileSync(p, "utf8"));
};
const K = { ops: seed("ops"), c1: seed("c1"), c2: seed("c2"), bazaar: seed("bazaar") };
const ID = { ops: OPS, c1: `c1.${OPS}`, c2: `c2.${OPS}`, bazaar: BAZAAR };
const client = rpcClient(c.rpc);
const fc = (method_name, args, deposit = 0n, gas = 100n * TGAS) => ({ type: "FunctionCall", method_name, args, gas, deposit });
const link = (h) => `https://testnet.nearblocks.io/txns/${h}`;
const tx = async (label, who, receiver_id, actions, expectFail) => {
  const r = await send(client, { signer_id: ID[who], key: K[who], receiver_id, actions });
  if (expectFail) {
    const refused = !r.ok && r.error.includes(expectFail);
    console.log(`   ${refused ? "refused as expected" : "UNEXPECTED"} ${label}: ${expectFail}  ${link(r.hash)}`);
    if (!refused) throw new Error(`${label}: ${r.ok ? "succeeded" : r.error}`);
  } else {
    console.log(`   ${r.ok ? "ok" : "FAILED"} ${label}  ${link(r.hash)}${r.ok ? "" : `\n   ${r.error}`}`);
    if (!r.ok) throw new Error(`${label}: ${r.error}`);
  }
  return r;
};
const view = (a, m, args) => client.view(a, m, args);
// A fixture issuer key the council wants registered (public test key; any 32-byte key works).
const ISSUER = `ed25519:${"ab".repeat(32)}`;

const cmd = process.argv[2];
if (cmd === "keys") {
  for (const n of ["ops", "bazaar"]) console.log(`${ID[n]}: near account create-account sponsor-by-faucet-service ${ID[n]} use-manually-provided-public-key ${nearPublicKey(K[n].pub)} network-config testnet create`);
} else if (cmd === "setup") {
  for (const n of ["c1", "c2"]) {
    if (!(await client.account(ID[n]))) st.txs[`create_${n}`] = (await tx(`create ${ID[n]}`, "ops", ID[n], [{ type: "CreateAccount" }, { type: "Transfer", deposit: near(1.3) }, { type: "AddKey", public_key_hex: K[n].pub, permission: "FullAccess" }])).hash;
  }
  if (!(await client.account(DAO))) {
    const args = Buffer.from(JSON.stringify({ config: { name: DAO_NAME, purpose: "Governs the BookerBob test bazaar: trust anchors need 2 of 3 council votes", metadata: "" }, policy: [ID.ops, ID.c1, ID.c2] })).toString("base64");
    st.txs.dao = (await tx(`create DAO ${DAO} (council ${ID.ops}, ${ID.c1}, ${ID.c2})`, "ops", FACTORY, [fc("create", { name: DAO_NAME, args }, near(6), 150n * TGAS)])).hash;
  }
  if (!(await view(BAZAAR, "issuers", {}).catch(() => null))) {
    const code = readFileSync("target/near/bookerbob_bazaar.wasm");
    st.txs.bazaar = (await tx(`deploy the bazaar to ${BAZAAR}, owner = ${DAO}`, "bazaar", BAZAAR, [{ type: "DeployContract", code }, fc("new", { owner: DAO, usdc: USDC }, 0n, 100n * TGAS)])).hash;
  }
  const p = await view(DAO, "get_policy", {});
  console.log(`DAO council: ${p.roles.find((r) => r.name === "council").kind.Group.join(", ")}; vote threshold ${p.default_vote_policy.threshold.join("/")} of council weight`);
  save();
} else if (cmd === "attack") {
  st.txs.attack = (await tx("c1 alone calls register_issuer on the bazaar", "c1", BAZAAR, [fc("register_issuer", { key_id: ISSUER, label: "rogue" }, 0n, 30n * TGAS)], "owner only")).hash;
  save();
} else if (cmd === "propose") {
  const inner = Buffer.from(JSON.stringify({ key_id: ISSUER, label: "council-approved test issuer" })).toString("base64");
  const p = await tx("c1 proposes register_issuer", "c1", DAO, [fc("add_proposal", { proposal: { description: "Register the BookerBob test issuer", kind: { FunctionCall: { receiver_id: BAZAAR, actions: [{ method_name: "register_issuer", args: inner, deposit: "0", gas: String(50n * TGAS) }] } } } }, near(1), 50n * TGAS)]);
  st.txs.propose = p.hash;
  st.proposal = p.value;
  save();
  st.txs.vote1 = (await tx(`c1 votes approve on proposal ${st.proposal}`, "c1", DAO, [fc("act_proposal", { id: st.proposal, action: "VoteApprove", proposal: { FunctionCall: { receiver_id: BAZAAR, actions: [{ method_name: "register_issuer", args: inner, deposit: "0", gas: String(50n * TGAS) }] } } }, 0n, 200n * TGAS)])).hash;
  const after1 = await view(BAZAAR, "issuers", {});
  console.log(`   after 1 of 3 votes: issuers = ${JSON.stringify(after1)}`);
  st.after_one_vote = after1;
  st.txs.vote2 = (await tx(`c2 votes approve on proposal ${st.proposal}`, "c2", DAO, [fc("act_proposal", { id: st.proposal, action: "VoteApprove", proposal: { FunctionCall: { receiver_id: BAZAAR, actions: [{ method_name: "register_issuer", args: inner, deposit: "0", gas: String(50n * TGAS) }] } } }, 0n, 250n * TGAS)])).hash;
  const after2 = await view(BAZAAR, "issuers", {});
  const pr = await view(DAO, "get_proposal", { id: st.proposal });
  console.log(`   after 2 of 3 votes: proposal ${pr.status}; issuers = ${JSON.stringify(after2)}`);
  st.after_two_votes = after2;
  save();
} else {
  console.error("usage: dao-bazaar.mjs keys|setup|attack|propose");
  process.exit(2);
}
