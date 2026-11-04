import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { gate } from "./mainnet-moment.mjs";

const today = "2026-11-12";

test("the mainnet moment refuses without both flags and today's go", () => {
  assert.match(gate([], {}, today), /--mainnet/);
  assert.match(gate(["--mainnet"], {}, today), /founders-word/);
  assert.match(gate(["--mainnet", "--i-have-the-founders-word"], {}, today), /BOOKERBOB_MAINNET_GO/);
  assert.match(gate(["--mainnet", "--i-have-the-founders-word"], { BOOKERBOB_MAINNET_GO: "2026-11-11" }, today), /today/);
  assert.equal(gate(["--mainnet", "--i-have-the-founders-word"], { BOOKERBOB_MAINNET_GO: today }, today), null);
});

test("run with no flags, it prints the plan and exits 3", () => {
  const r = spawnSync("node", [new URL("./mainnet-moment.mjs", import.meta.url).pathname], { encoding: "utf8", env: { PATH: process.env.PATH } });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /refusing/);
});
