// Verifies a smith program's proof, in node and in the browser, with one generic wasm verifier
// (zk/smith/verify-wasm). What is checked, in order:
//   1. the program hash is sha256 of the verifier preprocessing (the bytes the proof is checked against)
//   2. the spec hash is sha256 of the canonical spec, and the statement names both
//   3. the public input re-encodes to the statement's bytes, the claimed output decodes exactly
//   4. the Jolt proof verifies for (public input bytes, (spec hash, private commitment, output))
// The private input is never here: it was untrusted advice in the guest.
import { concat, decode, encode, guestInputs, guestOutputs, hex, unhex } from "./postcard.mjs";

export const sha256 = async (b) => new Uint8Array(await crypto.subtle.digest("SHA-256", b));
const te = new TextEncoder();

export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

const never = (name) => () => {
  throw new Error(`verifier called ${name}`);
};
const IMPORTS = {
  __wbindgen_placeholder__: { __wbindgen_describe: never("describe") },
  __wbindgen_externref_xform__: { __wbindgen_externref_table_set_null: never("set_null"), __wbindgen_externref_table_grow: never("grow") },
};

/** The raw Jolt check: 1 or an error string. A fresh instance per call (the verifier's memory grows). */
export async function joltVerify(module, pp, proof, inputs, outputs) {
  const x = (await WebAssembly.instantiate(module, IMPORTS)).exports;
  const put = (b) => {
    const p = x.bb_alloc(b.length);
    new Uint8Array(x.memory.buffer, p, b.length).set(b);
    return [p, b.length];
  };
  const args = [...put(pp), ...put(proof), ...put(inputs), ...put(outputs)];
  const t = performance.now();
  let ok, error = null;
  try {
    ok = x.bb_verify(...args) === 1;
    if (!ok) error = new TextDecoder().decode(new Uint8Array(x.memory.buffer, x.bb_error_ptr(), x.bb_error_len()).slice());
  } catch (e) {
    ok = false;
    error = `trap: ${e.message}`;
  }
  return { ok, ms: performance.now() - t, error };
}

/**
 * Every check on one statement. `files`: { module (compiled wasm), spec, statement, pp (bytes),
 * proof (bytes) }. Optional `registered`: the program hash the registry holds.
 */
export async function verifyStatement({ module, spec, statement, pp, proof, registered, view }) {
  const lines = [];
  const line = (ok, what) => (lines.push({ ok, what }), ok);
  const programHash = hex(await sha256(pp));
  line(programHash === statement.program_hash, `program hash ${programHash.slice(0, 16)}.. is sha256 of the verifier preprocessing`);
  if (registered !== undefined) line(registered === programHash, `the registry holds this program hash for ${statement.id}`);
  const specHash = hex(await sha256(te.encode(canonical(spec))));
  line(specHash === statement.spec_hash && spec.id === statement.id, `spec hash ${specHash.slice(0, 16)}.. is sha256 of the request's canonical spec`);
  let publicBytes, outBytes, outputOk = false;
  try {
    publicBytes = encode(spec, "Public", statement.public);
    line(hex(publicBytes) === statement.public_hex, "the public input encodes to the statement's bytes");
    outBytes = unhex(statement.output_hex);
    outputOk = canonical(decode(spec, "Output", outBytes)) === canonical(statement.output);
  } catch (e) {
    line(false, `statement does not encode: ${e.message}`);
  }
  line(outputOk, `the claimed output ${JSON.stringify(statement.output)} decodes exactly from its bytes`);
  if (!publicBytes || !outBytes) return { ok: false, lines };
  // A statement about chain data is checked against the chain: `view(account, method, args)`
  // reads it (live over RPC, or a committed snapshot), and a binding names what must match.
  const bind = BINDINGS[spec.id];
  if (bind) {
    if (!view) line(false, `${spec.id} is bound to chain data and no chain view was given`);
    else {
      let rows;
      try {
        rows = await bind(spec, statement, view);
      } catch (e) {
        rows = [[false, `chain binding: ${String(e.message ?? e).slice(0, 120)}`]];
      }
      for (const [ok, what] of rows) line(ok, what);
    }
  }
  const r = await joltVerify(module, pp, proof, guestInputs(publicBytes), guestOutputs(unhex(statement.spec_hash), unhex(statement.private_commitment), outBytes));
  line(r.ok, `Jolt proof verifies for this public input and output (${r.ms.toFixed(0)} ms${r.error ? `: ${r.error.slice(0, 120)}` : ""})`);
  return { ok: lines.every((l) => l.ok), lines, ms: r.ms };
}

/** Changed statements a verifier must refuse, built from the honest one. */
export function tamperings(spec, statement) {
  const out = [];
  const clone = () => JSON.parse(JSON.stringify(statement));
  const bumpOutput = (f, t) => {
    const s = clone();
    const v = s.output[f];
    s.output[f] = typeof v === "string" ? (BigInt(v) + 1n).toString() : typeof v === "number" ? v + 1 : !v;
    s.output_hex = hex(encode(spec, "Output", s.output));
    return [`output ${f} + 1`, s];
  };
  for (const [f, t] of spec.output) if (/^u|bool/.test(t)) out.push(bumpOutput(f, t));
  for (const [f, t] of spec.public) {
    const s = clone();
    const v = s.public[f];
    if (t === "bytes32") s.public[f] = v.slice(0, 63) + (v[63] === "0" ? "1" : "0");
    else if (/^u/.test(t)) s.public[f] = typeof v === "string" ? (BigInt(v) + 1n).toString() : v + 1;
    else if (t === "string") s.public[f] = v + "x";
    else continue;
    s.public_hex = hex(encode(spec, "Public", s.public));
    out.push([`public ${f} changed`, s]);
  }
  const s = clone();
  s.private_commitment = s.private_commitment.slice(0, 63) + (s.private_commitment[63] === "0" ? "1" : "0");
  out.push(["private commitment changed", s]);
  return out;
}

/** Chain bindings per request id: what in the public input must equal what the chain says. */
export const BINDINGS = {
  "coalition-split": async (spec, st, view) => {
    const job = await view(st.public.coalition, "job", { job: st.public.job });
    const seats = seatsFromJobView(job);
    const ev = await view("tx", spec.chain.finalize_tx, { sender: spec.chain.finalize_signer, event: spec.chain.event });
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    return [
      [(await seatsRoot(spec, seats)) === st.public.seats_root && String(job.budget) === String(st.public.budget) && String(job.bond) === String(st.public.bond), `seats_root, budget and bond are job ${st.public.job}'s as ${st.public.coalition} returns them`],
      [ev.__executor === st.public.coalition && ev.__standard === "bookerbob-coalition", `the job_finalized event was logged by ${st.public.coalition} itself (receipt executor ${ev.__executor})`],
      [ev.job === st.public.job && same(ev.delivered, st.public.delivered) && same(ev.slashed.map((x) => x.member), st.public.slashed) && ev.to_buyer === String(st.public.to_buyer), `the payouts are the ones the job_finalized event of tx ${spec.chain.finalize_tx.slice(0, 10)}.. announced`],
    ];
  },
  "coalition-k-of-n": async (spec, st, view) => {
    const job = await view(st.public.coalition, "job", { job: st.public.job });
    const seats = seatsFromJobView(job);
    const delivered = seats.filter((s) => s.delivered).length;
    return [
      [(await seatsRoot(spec, seats)) === st.public.seats_root, `seats_root is the commitment over job ${st.public.job}'s seats as ${st.public.coalition} returns them`],
      [delivered === st.output.delivered && seats.length === st.output.seats, `the proven ${st.output.delivered} of ${st.output.seats} matches the chain's seats`],
    ];
  },
};

/** Job C's seat records from the coalition contract's `job` view, as the spec's Seat type. */
export const seatsFromJobView = (job) => job.seats.map((s, i) => ({ leg: i, member: s.member, price: s.price, delivered: s.delivered ?? null }));
export async function seatsRoot(spec, seats) {
  return hex(await sha256(concat([te.encode("bookerbob/smith/coalition-seats/v0"), encode(spec, "vec<Seat>", seats)])));
}

/**
 * Chain reads for bindings, over public RPC (node and browser): a contract view, or with
 * account "tx" the data of one EVENT_JSON event in a tx's receipts (method = tx hash, args =
 * {sender, event}). `snapshot` ({reads: [{account, method, args, result}]}) answers when RPC
 * does not; `used.snapshot` says whether it did.
 */
export function chainView({ rpc = "https://test.rpc.fastnear.com", archival = "https://archival-rpc.testnet.fastnear.com", snapshot = null, offline = false } = {}) {
  const used = { snapshot: false };
  const post = async (url, method, params) => {
    for (let i = 0; i < 4; i++) {
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      if (r.status === 429 || r.status >= 500) {
        await new Promise((s) => setTimeout(s, 1500 * (i + 1)));
        continue;
      }
      const j = await r.json();
      if (j.error || j.result?.error) throw new Error(JSON.stringify(j.error ?? j.result.error).slice(0, 160));
      return j.result;
    }
    throw new Error("RPC kept failing");
  };
  const live = async (account, method, args) => {
    if (account === "tx") {
      const res = await post(archival, "tx", { tx_hash: method, sender_account_id: args.sender, wait_until: "NONE" });
      // The event with the contract that logged it: a log line from another receipt is not it.
      for (const o of res.receipts_outcome) for (const l of o.outcome.logs) {
        if (!l.startsWith("EVENT_JSON:")) continue;
        const e = JSON.parse(l.slice(11));
        if (e.event === args.event) return { ...e.data[0], __executor: o.outcome.executor_id, __standard: e.standard };
      }
      throw new Error(`no ${args.event} event in ${method}`);
    }
    const b64 = typeof btoa === "function" ? btoa(JSON.stringify(args)) : Buffer.from(JSON.stringify(args)).toString("base64");
    const res = await post(rpc, "query", { request_type: "call_function", finality: "final", account_id: account, method_name: method, args_base64: b64 });
    return JSON.parse(new TextDecoder().decode(new Uint8Array(res.result)));
  };
  const fromSnapshot = (account, method, args) => {
    const hit = snapshot?.reads?.find((r) => r.account === account && r.method === method && JSON.stringify(r.args) === JSON.stringify(args));
    if (!hit) throw new Error(`no snapshot of ${account}.${method}`);
    used.snapshot = true;
    return hit.result;
  };
  const cache = new Map();
  const view = async (account, method, args) => {
    if (offline) return fromSnapshot(account, method, args);
    const k = JSON.stringify([account, method, args]);
    try {
      if (!cache.has(k)) cache.set(k, live(account, method, args));
      return await cache.get(k);
    } catch (e) {
      if (snapshot) return fromSnapshot(account, method, args);
      throw e;
    }
  };
  return { view, live, used };
}
