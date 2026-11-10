// Runs the prover and the verifier off the page, so the page can keep its clock moving.
// Nothing here sends anything anywhere: it only fetches the static files next to it.
//
//   { load: "prove" | "check", threads }   fetch what the mode needs, counting real bytes
//   { prove: publicJsonText }              trace + prove, answers { proved } with the proof bytes
//   { verify: publicJsonText, proof }      answers { verified: { valid, ms, error } }
//
// Stage progress during a proof comes from inside the wasm on BroadcastChannel "bookerbob-prove".
let sizes, prover, proverWasm, verifier, verifierPp, mode;

/** Fetches a file and reports every chunk that arrives. `.gz` files are gunzipped here, because a
 *  plain static host (GitHub Pages, python http.server) sends them as they are. */
async function read(path, got) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: http ${res.status}`);
  const counted = res.body.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        got(chunk.length);
        controller.enqueue(chunk);
      },
    }),
  );
  const stream = path.endsWith(".gz") ? counted.pipeThrough(new DecompressionStream("gzip")) : counted;
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// The verifier is plain wasm with no glue. These imports are left by a dependency and are never
// called; a call to one stops the check instead of passing silently.
const never = (name) => () => {
  throw new Error(`verifier called ${name}`);
};
const verifierImports = {
  __wbindgen_placeholder__: { __wbindgen_describe: never("describe") },
  __wbindgen_externref_xform__: { __wbindgen_externref_table_set_null: never("set_null"), __wbindgen_externref_table_grow: never("grow") },
};

async function load(want, threads) {
  let step = "download";
  try {
    const started = performance.now();
    sizes = await (await fetch("sizes.json", { cache: "no-cache" })).json();
    mode = want === "prove" && threads > 1 && sizes.files["threads/bookerbob_prove_wasm_bg.wasm.gz"] ? "threads" : "single";
    const names = ["verifier.wasm.gz", "verifier.bin"];
    if (want === "check") names.push("sample-proof.bin");
    else names.push(`${mode}/bookerbob_prove_wasm_bg.wasm.gz`, "prover.bin", "guest.elf");
    const total = names.reduce((sum, n) => sum + sizes.files[n], 0);
    let seen = 0;
    let last = 0;
    const got = (n) => {
      seen += n;
      const now = performance.now();
      if (now - last > 50 || seen >= total) self.postMessage({ bytes: { seen, total } }), (last = now);
    };
    self.postMessage({ bytes: { seen: 0, total } });
    const glue = want === "prove" ? import(`./${mode}/bookerbob_prove_wasm.js`) : null;
    const files = Object.fromEntries(await Promise.all(names.map(async (n) => [n, await read(n, got)])));
    const downloadMs = performance.now() - started;
    self.postMessage({ bytes: { seen: total, total }, downloadMs });

    step = "start";
    const t = performance.now();
    verifier = await WebAssembly.compile(files["verifier.wasm.gz"]);
    verifierPp = files["verifier.bin"];
    let sample = null;
    if (want === "prove") {
      const pkg = await glue;
      proverWasm = await pkg.default({ module_or_path: files[`${mode}/bookerbob_prove_wasm_bg.wasm.gz`] });
      if (mode === "threads") await pkg.initThreadPool(threads);
      prover = new pkg.Prover(files["guest.elf"], files["prover.bin"]);
    } else {
      sample = files["sample-proof.bin"];
    }
    self.postMessage({ ready: { mode, threads: mode === "threads" ? threads : 1, startMs: performance.now() - t, downloadMs, downloadBytes: total, sample } });
  } catch (e) {
    self.postMessage({ error: String(e?.message ?? e), step });
  }
}

function prove(publicJson) {
  try {
    const t0 = performance.now();
    const proof = prover.prove(new TextEncoder().encode(publicJson));
    const t1 = performance.now();
    const memoryBytes = proverWasm.memory.buffer.byteLength;
    self.postMessage({ proved: { proof, t0, t1, proveMs: t1 - t0, memoryBytes } });
  } catch (e) {
    self.postMessage({ error: String(e?.message ?? e), step: "prove" });
  }
}

async function verify(publicJson, proof) {
  try {
    // A fresh instance per check: a refused proof can never leave state behind for the next one.
    const x = (await WebAssembly.instantiate(verifier, verifierImports)).exports;
    const put = (bytes) => {
      const p = x.bb_alloc(bytes.length);
      new Uint8Array(x.memory.buffer, p, bytes.length).set(bytes);
      return [p, bytes.length];
    };
    const args = [...put(verifierPp), ...put(proof), ...put(new TextEncoder().encode(publicJson))];
    const t = performance.now();
    const ok = x.bb_verify(...args);
    const ms = performance.now() - t;
    const error = ok === 1 ? null : new TextDecoder().decode(new Uint8Array(x.memory.buffer, x.bb_error_ptr(), x.bb_error_len()).slice());
    self.postMessage({ verified: { valid: ok === 1, ms, error } });
  } catch (e) {
    // A trap inside the verifier is a refusal too, and the page says which kind it was.
    self.postMessage({ verified: { valid: false, ms: 0, error: `verifier stopped: ${String(e?.message ?? e)}` } });
  }
}

self.onmessage = ({ data }) => {
  if (data.load) load(data.load, data.threads ?? 1);
  else if (data.prove) prove(data.prove);
  else if (data.verify) verify(data.verify, data.proof);
};
