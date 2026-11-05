import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { verifySaved } from "./nras.mjs";

const saved = JSON.parse(readFileSync("fixtures/live/near-ai/nras.json", "utf8"));
const nonce = JSON.parse(JSON.parse(readFileSync("fixtures/live/near-ai/report.json", "utf8")).model_attestations[0].nvidia_payload).nonce;

test("the saved NRAS reply passes every check", () => {
  assert.ok(verifySaved(saved, nonce).every(([ok]) => ok));
});

test("another nonce, an edited claim or a dropped GPU fails", () => {
  assert.ok(!verifySaved(saved, "00".repeat(32)).every(([ok]) => ok), "another nonce");
  const edit = structuredClone(saved);
  const [h, p, s] = edit.response[0][1].split(".");
  const claims = JSON.parse(Buffer.from(p, "base64url"));
  claims["x-nvidia-overall-att-result"] = true;
  claims.nbf += 1;
  edit.response[0][1] = [h, Buffer.from(JSON.stringify(claims)).toString("base64url"), s].join(".");
  assert.ok(!verifySaved(edit, nonce)[0][0], "an edited platform token no longer verifies");
  const drop = structuredClone(saved);
  delete drop.response[1][Object.keys(drop.response[1])[0]];
  assert.ok(!verifySaved(drop, nonce).every(([ok]) => ok), "a GPU missing from the list");
});
