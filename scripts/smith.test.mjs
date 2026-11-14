// The smith's three layers against model-written code (docs/smith.md, "What runs the model's
// code"), each tested on its own with the audit's evil1.rs (zk/smith/lint/tests/fixtures):
//   1. the lint (agents/smith/lint.wasm) rejects it, and passes the accepted bodies
//   2. the body crate is no_std on every target: with the lint bypassed, evil1 does not compile
//      and its command never runs (needs the build root; skipped when it is not there)
//   3. the sandbox (zk/smith/sandbox.sb): no network, no reads under $HOME but the toolchains,
//      no writes outside the build root (macOS sandbox-exec; skipped elsewhere)
//   node --test scripts/smith.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { lint } from "../agents/smith/lint.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const WASM = readFileSync(join(REPO, "agents/smith/lint.wasm"));
const EVIL = readFileSync(join(REPO, "zk/smith/lint/tests/fixtures/evil1.rs"), "utf8");
const ROOT = "/tmp/bookerbob-smith";
const SB = join(REPO, "zk/smith/sandbox.sb");
const HOME = process.env.HOME;
const REAL = existsSync(ROOT) ? spawnSync("realpath", [ROOT]).stdout.toString().trim() : ROOT;
const sandboxed = (args, opts = {}) => {
  mkdirSync(join(REAL, "tmp"), { recursive: true });
  const env = { PATH: `${HOME}/.cargo/bin:/usr/bin:/bin`, RUSTUP_HOME: `${HOME}/.rustup`, CARGO_HOME: join(REAL, "cargo-home"), TMPDIR: join(REAL, "tmp"), HOME: join(REAL, "home"), ...(opts.env ?? {}) };
  const xcode = dirname(spawnSync("xcrun", ["--find", "clang"]).stdout.toString().trim());
  return spawnSync("sandbox-exec", ["-f", SB, "-D", `HOME=${HOME}`, "-D", `ROOT=${REAL}`, "-D", `TMP=${join(REAL, "tmp")}`, "-D", `XCODE_BIN=${xcode}`, ...args], { encoding: "utf8", ...opts, env });
};
const haveSandbox = process.platform === "darwin" && spawnSync("which", ["sandbox-exec"]).status === 0;

test("lint: evil1 is rejected on every count", async () => {
  const p = await lint(EVIL, WASM);
  for (const needle of ["attribute `#[cfg(", "starts with `::`", "include_bytes!", "module", "macro item"]) assert.ok(p.some((x) => x.includes(needle)), `${needle} in ${p}`);
});

test("lint: quotes and comments cannot hide code", async () => {
  const src = "use crate::types::*;\npub fn check(p: &Public, s: &Private) -> Result<Output, &'static str> { let a = '\"'; /* \" */ let _ = std::process::Command::new(\"sh\"); let b = '\"'; Err(\"x\") }";
  assert.ok((await lint(src, WASM)).some((x) => x.includes("std::process::Command::new")));
});

test("lint: every accepted body passes", async () => {
  const progs = join(REPO, "zk/smith/programs");
  for (const id of ["coalition-k-of-n", "spend-bucket"]) {
    const f = join(progs, id, "body/src/body.rs");
    if (existsSync(f)) assert.deepEqual(await lint(readFileSync(f, "utf8"), WASM), [], id);
  }
});

test("no_std: evil1 with the lint bypassed does not compile, and its command never runs", { skip: !haveSandbox || !existsSync(join(ROOT, "Cargo.lock")) || !existsSync(join(REPO, "zk/smith/programs/coalition-k-of-n/body/src/lib.rs")) }, () => {
  const d = join(REAL, "tmp", "evil-probe");
  rmSync(d, { recursive: true, force: true });
  mkdirSync(join(d, "src"), { recursive: true });
  const body = join(REPO, "zk/smith/programs/coalition-k-of-n/body");
  writeFileSync(join(d, "Cargo.toml"), readFileSync(join(body, "Cargo.toml"), "utf8").replace(/name = "smith-[a-z-]+-body"/, 'name = "evil-probe"') + "\n[workspace]\n");
  for (const f of ["lib.rs", "types.rs", "smith_std.rs"]) cpSync(join(body, "src", f), join(d, "src", f));
  writeFileSync(join(d, "src/body.rs"), EVIL);
  cpSync(join(REAL, "Cargo.lock"), join(d, "Cargo.lock"));
  rmSync("/tmp/smith-pwned", { force: true });
  const clang = spawnSync("xcrun", ["--find", "clang"]).stdout.toString().trim();
  const r = sandboxed([join(HOME, ".cargo/bin/cargo"), "build", "--offline", "-j", "2", "--target-dir", join(REAL, "target", "evil-probe")], { cwd: d, env: { CC: clang, CARGO_TARGET_AARCH64_APPLE_DARWIN_LINKER: clang, SDKROOT: spawnSync("xcrun", ["--show-sdk-path"]).stdout.toString().trim() } });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /cannot find `std`/);
  assert.equal(existsSync("/tmp/smith-pwned"), false);
});

test("sandbox: deny by default; reads, writes, network and exec from inside, with a C probe", { skip: !haveSandbox || !existsSync(join(ROOT, "crates")) }, () => {
  const probeBin = join(REAL, "target", "sbprobe");
  const cc = spawnSync("xcrun", ["clang", "-O1", "-o", probeBin, join(REPO, "zk/smith/sandbox-probe.c")], { encoding: "utf8" });
  assert.equal(cc.status, 0, cc.stderr);
  const p = (...a) => sandboxed([probeBin, ...a]).status;
  const secret = join(HOME, ".smith-sandbox-probe");
  writeFileSync(secret, "secret\n");
  try {
    assert.equal(p("read", join(REAL, "Cargo.toml")), 0, "the probe cannot read the root (the probe itself is broken)");
    assert.notEqual(p("read", secret), 0, "a file in $HOME is readable");
    assert.notEqual(p("net", "1.1.1.1", "443"), 0, "the network is open");
    assert.notEqual(p("exec", "/bin/sh"), 0, "/bin/sh runs");
    for (const f of [join(HOME, ".smith-sandbox-write"), join(HOME, ".cargo/registry/smith-probe"), "/private/var/folders/smith-probe", join(REAL, "vendor/jolt/smith-probe"), join(REAL, "crates/smith-probe"), join(REAL, ".cargo/config.toml"), join(REAL, "cargo-home/config.toml"), join(REAL, "programs/smith-probe"), join(REAL, "Cargo.toml")]) {
      assert.notEqual(p("write", f), 0, `${f} is writable`);
    }
    for (const f of [join(REAL, "tmp/probe"), join(REAL, "target/probe"), join(REAL, "home/probe")]) assert.equal(p("write", f), 0, `${f} is not writable`);
    // Renaming a writable directory itself, or a planted dir onto it, is refused (cargo-home).
    const planted = join(REAL, "tmp", "planted-home");
    mkdirSync(planted, { recursive: true });
    writeFileSync(join(planted, "config.toml"), "[build]\n");
    assert.notEqual(p("rename", join(REAL, "cargo-home"), join(REAL, "tmp", "moved-home")), 0, "cargo-home can be renamed away");
    assert.notEqual(p("rename", planted, join(REAL, "cargo-home")), 0, "a planted dir can be renamed onto cargo-home");
    assert.notEqual(p("rename", join(REAL, "target"), join(REAL, "tmp", "moved-target")), 0, "target can be renamed away");
    assert.notEqual(p("write", join(REAL, "cargo-home", "config.toml")), 0, "cargo-home/config.toml is writable");
    assert.ok(existsSync(join(REAL, "cargo-home")) && !existsSync(join(REAL, "cargo-home", "config.toml")));
    rmSync(planted, { recursive: true, force: true });
    for (const bin of ["/bin/launchctl", "/usr/bin/pbpaste", "/usr/bin/security", "/usr/bin/curl", "/bin/sh"]) assert.notEqual(sandboxed([bin]).status, 0, `${bin} runs`);
  } finally {
    rmSync(secret, { force: true });
    rmSync(join(HOME, ".smith-sandbox-write"), { force: true });
  }
});

// Hand-assembled wasm modules for the policy and the worker limits.
const leb = (n) => { const o = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; o.push(b); } while (n); return o; };
const sec = (id, body) => [id, ...leb(body.length), ...body];
const name = (s) => [...leb(s.length), ...Buffer.from(s)];
function module({ importF = false, maxPages = 16, loop = false } = {}) {
  const types = sec(1, [3, 0x60, 1, 0x7f, 1, 0x7f, 0x60, 4, 0x7f, 0x7f, 0x7f, 0x7f, 1, 0x7f, 0x60, 0, 1, 0x7f, ...(importF ? [] : [])]);
  const imports = importF ? sec(2, [1, ...name("env"), ...name("f"), 0, 2]) : [];
  const funcs = sec(3, [3, 0, 1, 2]);
  const mem = sec(5, maxPages === null ? [1, 0, 1] : [1, 1, 1, ...leb(maxPages)]);
  const exp = (n, kind, i) => [...name(n), kind, i];
  const fi = importF ? 1 : 0;
  const exports = sec(7, [4, ...exp("memory", 2, 0), ...exp("h_alloc", 0, fi), ...exp("h_commit", 0, fi + 1), ...exp("h_out_ptr", 0, fi + 2)]);
  const body = (code) => [...leb(code.length + 1), 0, ...code];
  const commit = loop ? [0x03, 0x40, 0x0c, 0x00, 0x0b, 0x41, 0x00, 0x0b] : [0x41, 0x00, 0x0b];
  const code = sec(10, [3, ...body([0x41, 0x00, 0x0b]), ...body(commit), ...body([0x41, 0x00, 0x0b])]);
  const typesImport = importF ? sec(1, [4, 0x60, 1, 0x7f, 1, 0x7f, 0x60, 4, 0x7f, 0x7f, 0x7f, 0x7f, 1, 0x7f, 0x60, 0, 1, 0x7f, 0x60, 0, 0]) : types;
  return Uint8Array.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, ...typesImport, ...imports, ...funcs, ...mem, ...exports, ...code]);
}

test("wasm policy: imports and a memory without a cap are refused", async () => {
  const { wasmPolicy } = await import("./smith.mjs");
  assert.deepEqual(wasmPolicy(module()), []);
  assert.ok(wasmPolicy(module({ importF: true })).some((x) => x.includes("imports env.f")));
  assert.ok(wasmPolicy(module({ maxPages: null })).some((x) => x.includes("no maximum")));
  assert.ok(wasmPolicy(module({ maxPages: 4096 })).some((x) => x.includes("over")));
});

test("wasm worker: a body that never returns is stopped by the time limit", { timeout: 60_000 }, async () => {
  const { runWasm } = await import("./smith.mjs");
  const r = await runWasm(module({ loop: true }), "00", "00");
  assert.equal(r.ok, false);
  assert.match(r.reason, /timed out/);
});
