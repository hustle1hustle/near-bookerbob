// The smith's static check (zk/smith/lint, syn with an allowlist), compiled to wasm32: the same
// check in scripts/smith.mjs before anything compiles, in scripts/smith-check.mjs and in the page.
let modP;
export async function lint(src, wasmBytes) {
  modP ??= WebAssembly.compile(wasmBytes);
  const x = (await WebAssembly.instantiate(await modP, {})).exports;
  const b = new TextEncoder().encode(src);
  const p = x.lint_alloc(b.length);
  new Uint8Array(x.memory.buffer, p, b.length).set(b);
  const n = x.lint_run(p, b.length);
  const out = new TextDecoder().decode(new Uint8Array(x.memory.buffer, x.lint_out_ptr(), x.lint_out_len()).slice());
  return n ? out.split("\n") : [];
}
