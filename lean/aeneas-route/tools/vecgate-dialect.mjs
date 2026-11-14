// COPY of tools/vecgate.mjs for gap-aeneas (writes only under gap-aeneas/). Diff against the original to audit.
// The Rust vs Lean vector gate.
//
//   node tools/vecgate.mjs <program-id> [--fuzz N] [--seed S]
//
// For a smith program: resolve the spec's vectors (commit placeholders, hex_of_vector) with the
// smith's own postcard encoder (read from the smith worktree, not copied), run them through the
// Rust body.rs (tools/vecgate/runner, native) and through the Lean model (#eval over generated
// literals, with CommitFn.table standing in for the commitment), decode both outputs and compare
// verdict, output fields and refusal message. --fuzz N adds N mutated vectors (a field nudged,
// a list item dropped, duplicated or swapped, the root replaced) to look for a disagreement that
// the fixed vectors miss. Exit 1 on any disagreement.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "../..");  // lean-smith root: SmithLean is read from there, nothing written
const SMITH = process.env.SMITH_DIR || join(process.env.HOME, "dev/bookerbob-wt-smith");
const pc = await import(join(SMITH, "agents/smith/postcard.mjs"));
const RUNNER = join(here, "../target/release/gap-runner");  // dialect + original side by side
const LAKE = join(process.env.HOME, ".elan/bin/lake");

// Lean names per program: namespace, the committed value's path and its Lean type.
const LEAN = {
  "coalition-k-of-n": { ns: "Smith.Coalition", committed: "private.seats", ctype: "List Seat" },
  "spend-bucket": { ns: "Smith.SpendBucket", committed: "private", ctype: "Private" },
  "coalition-split": { ns: "Smith.S_bff28a1463eca2b6", committed: "private.seats", ctype: "List Seat", mod: "SmithLean.S_bff28a1463eca2b6.A" },
  // v2 of the request (explicit D = 0 refusal): spec and body live in this repo, not in the smith worktree
  "coalition-split-v2": { ns: "Smith.S_141a68aed288f1c4", committed: "private.seats", ctype: "List Seat", spec: join(ROOT, "specs/coalition-split.json"), mod: "SmithLean.S_141a68aed288f1c4.A" },
};

const [, , id, ...rest] = process.argv;
const arg = (k, d) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : d; };
// The driver passes the request's own names (AUDIT-1 C6): --ns, --mod, --spec, --committed, --ctype, --body.
// The table above is only the default for the three known programs.
if (!id) { console.error("usage: vecgate.mjs <program-id> [--ns NS --mod MOD --spec path --committed private.seats --ctype 'List Seat' --body body.rs] [--fuzz N] [--seed S]"); process.exit(2); }
if (!LEAN[id]) LEAN[id] = {};
for (const k of ["ns", "mod", "spec", "committed", "ctype"]) if (arg(`--${k}`)) LEAN[id][k] = arg(`--${k}`);
if (!LEAN[id].ns || !LEAN[id].committed || !LEAN[id].ctype) { console.error(`vecgate: ${id} needs --ns, --committed and --ctype`); process.exit(2); }
// H4: the Rust side is built here from tools/vecgate, with the body the driver names copied into the
// program crate first, so the runner always holds the body under test, not a stale copy.
const CRATE = join(here, "vecgate");
const BODY = arg("--body");
if (BODY) { console.error("gap-aeneas copy: --body unsupported"); process.exit(2);
  const dst = join(CRATE, "programs", id, "src", "body.rs");
  if (!existsSync(dst)) { console.error(`vecgate: no program crate for ${id} at ${dst}; create it from an existing one`); process.exit(2); }
  writeFileSync(dst, readFileSync(BODY));
}
// gap-aeneas: no build here; the runner is built in gap-aeneas/rust and holds both bodies.
const FUZZ = Number(arg("--fuzz", 0));
let seed = Number(arg("--seed", 1));
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const pick = (a) => a[Math.floor(rnd() * a.length)];

const spec = JSON.parse(readFileSync(LEAN[id].spec || join(SMITH, "zk/smith/specs", `${id}.json`), "utf8"));
const sha256 = async (b) => new Uint8Array(createHash("sha256").update(b).digest());
const L = LEAN[id];

// ---------- vectors: the spec's, then fuzzed ----------
const base = [];
for (const v of spec.vectors) base.push(await pc.resolveVector(spec, v, sha256, base));
const cases = base.map((r, i) => ({ label: spec.vectors[i].label, expect: spec.vectors[i].expect, public: r.public, private: r.private, rawPublic: spec.vectors[i].public }));

const isInt = (t) => /^u(32|64|128)$/.test(t);
function mutate(c) {
  const d = structuredClone({ public: c.public, private: c.private });
  const side = pick(["public", "private"]);
  const fields = pc.fieldsOf(spec, side === "public" ? "Public" : "Private");
  const [name, type] = pick(fields);
  const v = d[side][name];
  let how;
  if (isInt(type)) { const n = BigInt(v); d[side][name] = String(pick([n + 1n, n > 0n ? n - 1n : n + 7n, 0n, n * 2n])); how = `${side}.${name} nudged`; }
  else if (type === "bytes32") { d[side][name] = Array.from({ length: 32 }, () => Math.floor(rnd() * 256).toString(16).padStart(2, "0")).join(""); how = `${side}.${name} replaced`; }
  else if (type.startsWith("vec<") && Array.isArray(v) && v.length) {
    const i = Math.floor(rnd() * v.length); const op = pick(["drop", "dup", "swap", "tweak"]);
    if (op === "drop") v.splice(i, 1);
    else if (op === "dup") v.splice(i, 0, structuredClone(v[i]));
    else if (op === "swap" && v.length > 1) { const j = (i + 1) % v.length; [v[i], v[j]] = [v[j], v[i]]; }
    else if (typeof v[i] === "object" && v[i]) { const inner = type.slice(4, -1); const fs = inner in (spec.types || {}) ? spec.types[inner] : null; if (fs) { const [fn, ft] = pick(fs); const x = v[i][fn]; if (isInt(ft)) v[i][fn] = String(BigInt(x) + 1n); else if (ft === "string") v[i][fn] = x + "x"; else if (ft.startsWith("option<")) v[i][fn] = x === null ? "0".repeat(64) : null; else if (ft === "u32") v[i][fn] = x + 1; } }
    else if (isInt(type.slice(4, -1))) v[i] = String(BigInt(v[i]) + pick([1n, -1n, 1000n]) < 0n ? 0n : BigInt(v[i]) + pick([1n, -1n, 1000n])); else if (typeof v[i] === "string") v[i] = v[i] + "x";
    how = `${side}.${name}[${i}] ${op}`;
  } else if (type === "string") { d[side][name] = v + "x"; how = `${side}.${name} changed`; }
  else { d[side][name] = v; how = `${side}.${name} untouched`; }
  // A private mutation with the old root only ever hits the root check; most of the time, let the
  // root follow the mutated value (the spec's own commit placeholder) so the later rules run.
  if (side === "private" && c.rawPublic && rnd() < 0.75) {
    for (const [k, v] of Object.entries(c.rawPublic)) if (v && typeof v === "object" && v.commit) { d.public[k] = v; how += ", root recommitted"; }
  }
  return { ...d, how };
}
for (let i = 0; i < FUZZ; i++) {
  const m = mutate(pick(cases));
  const r = await pc.resolveVector(spec, { public: m.public, private: m.private }, sha256, base);
  cases.push({ label: `fuzz ${i}: ${m.how}`, expect: null, public: r.public, private: r.private });
}

// ---------- Rust ----------
const lines = cases.map((c) => JSON.stringify({ program: id, public: pc.hex(pc.encode(spec, "Public", c.public)), private: pc.hex(pc.encode(spec, "Private", c.private)) })).join("\n") + "\n";
const rs = spawnSync(RUNNER, [], { input: lines, encoding: "utf8" });
if (rs.status !== 0) { console.error(rs.stderr); process.exit(1); }
const rust = rs.stdout.trim().split("\n").map((l) => JSON.parse(l)).map((r) => r.ok !== undefined ? { ok: norm(pc.decode(spec, "Output", pc.unhex(r.ok))) } : { refuse: r.refuse });

// ---------- Lean ----------
const outFields = spec.output.map(([n]) => n);
function norm(o) { const r = {}; for (const [n] of spec.output) r[n] = String(o[n]); return r; }
const esc = (s) => JSON.stringify(s);
function lit(type, v) {
  if (type === "string") return esc(v);
  if (type === "u32") return `(${v} : UInt32)`;
  if (type === "u64") return `(${v} : UInt64)`;
  if (type === "u128") return `(${v} : Nat)`;
  if (type === "bytes32") return `([${Array.from(typeof v === "string" ? pc.unhex(v) : v).join(", ")}] : Bytes32)`;
  if (type.startsWith("option<")) return v === null || v === undefined ? "none" : `(some ${lit(type.slice(7, -1), v)})`;
  if (type.startsWith("vec<")) return `[${v.map((x) => lit(type.slice(4, -1), x)).join(", ")}]`;
  if (spec.types && spec.types[type]) return `({ ${spec.types[type].map(([n, t]) => `${n} := ${lit(t, v[n])}`).join(", ")} } : ${type})`;
  throw new Error(`no literal for ${type}`);
}
const structLit = (name, v) => `({ ${pc.fieldsOf(spec, name).map(([n, t]) => `${n} := ${lit(t, v[n])}`).join(", ")} } : ${name})`;
const committedOf = (c) => L.committed === "private" ? structLit("Private", c.private) : lit(pc.typeAt(spec, L.committed), c.private[L.committed.split(".")[1]]);
const rootOf = (c) => { const k = spec.public.find(([, t]) => t === "bytes32")[0]; return lit("bytes32", c.public[k]); };
// the real root of the committed value (what the Rust commit computes), so the table agrees with Rust on the honest value
const realRoot = (c) => { const path = L.committed; const val = path === "private" ? c.private : c.private[path.split(".")[1]]; const t = pc.typeAt(spec, path); const tagRule = spec.rules[0].match(/commit\("([^"]+)"/)[1]; const bytes = pc.concat([new TextEncoder().encode(tagRule), pc.encode(spec, t, val)]); return lit("bytes32", Array.from(createHash("sha256").update(bytes).digest())); };
let lean = `import SmithLean\nimport ${L.mod || "SmithLean"}\nopen Smith\nopen ${L.ns}\n`;
if (L.committed === "private") lean += `instance : DecidableEq ${L.ns}.Private := fun a b => by\n  cases a; cases b; simp only [${L.ns}.Private.mk.injEq]; exact inferInstance\n`;
cases.forEach((c, i) => {
  lean += `def c${i} : CommitFn (${L.ctype}) := CommitFn.table [(${committedOf(c)}, ${realRoot(c)})]\n#eval check c${i} ${structLit("Public", c.public)} ${structLit("Private", c.private)}\n`;
});
if (L.mod) { const lb = spawnSync(LAKE, ["build", L.mod], { cwd: ROOT, encoding: "utf8" }); if (lb.status !== 0) { console.error("lean side does not build:\n" + (lb.stdout || "").slice(-2000)); process.exit(1); } }
const dir = join(here, "../out/vecgate"); mkdirSync(dir, { recursive: true });
// H1: beside #eval (compiled code, which @[implemented_by] could divert), each vector is also stated
// as a theorem the KERNEL decides: `check c p s = <what Rust returned>` by `decide`. A vector on
// which the kernel's own evaluation of `check` disagrees with Rust fails the build and is reported.
const expectLit = (r) => r.ok ? `Except.ok ({ ${spec.output.map(([n, t]) => `${n} := ${lit(t, r.ok[n])}`).join(", ")} } : Output)` : `Except.error ${esc(r.refuse)}`;
cases.forEach((c, i) => { lean += `theorem k${i} : check c${i} ${structLit("Public", c.public)} ${structLit("Private", c.private)} = ${expectLit(rust[i])} := Eq.refl _\n`; });
const leanPath = join(dir, `${id.replace(/-/g, "_")}.lean`); writeFileSync(leanPath, lean);
const ls = spawnSync(LAKE, ["env", "lean", leanPath], { cwd: ROOT, encoding: "utf8" });
const leanOut = (ls.stdout || "").split("\n").filter((l) => l.startsWith("Except."));
const kernelFails = new Set(((ls.stdout || "") + (ls.stderr || "")).split("\n").filter((l) => /\.lean:\d+:\d+: error/.test(l)).map((l) => { const m = l.match(/\.lean:(\d+):/); return m ? Number(m[1]) : -1; }));
if (leanOut.length !== cases.length) { console.error("lean side failed:\n" + (ls.stdout || "").slice(0, 3000) + (ls.stderr || "")); process.exit(1); }
const theoremLine = (i) => lean.split("\n").findIndex((l) => l.startsWith(`theorem k${i} `)) + 1;
const leanRes = leanOut.map((l) => { const m = l.match(/^Except\.error "(.*)"$/); if (m) return { refuse: JSON.parse(`"${m[1]}"`) }; const o = {}; for (const [n] of spec.output) { const mm = l.match(new RegExp(`${n} := ([0-9]+)`)); o[n] = mm ? mm[1] : "?"; } return { ok: o }; });

// ---------- compare ----------
let bad = 0;
cases.forEach((c, i) => {
  const r = rust[i], l = leanRes[i];
  const same = JSON.stringify(r) === JSON.stringify(l);
  const expectOk = c.expect === null ? null : c.expect === "refuse" ? !!r.refuse : r.ok && outFields.every((f) => String(c.expect[f]) === r.ok[f]);
  const kernelOk = !kernelFails.has(theoremLine(i));
  const flag = !kernelOk ? "KERNEL" : same ? (expectOk === false ? "EXPECT" : "same") : (r.refuse && l.refuse ? "MSG" : "DIFF");
  if (flag !== "same") bad++;
  console.log(`${flag.padEnd(6)} ${c.label.slice(0, 60).padEnd(60)} rust ${JSON.stringify(r).slice(0, 70)}  lean ${JSON.stringify(l).slice(0, 70)}`);
});
console.log(`${cases.length} vectors (${spec.vectors.length} from the spec, ${FUZZ} fuzzed): ${bad === 0 ? "Rust and Lean agree on all (#eval and kernel decide)" : bad + " disagreements"}`);
process.exit(bad ? 1 : 0);
