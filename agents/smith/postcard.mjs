// Postcard bytes for smith spec types, in node and in the browser (no imports).
// Types: u8 (one byte), u16/u32/u64/u128 (unsigned LEB128 varint), bool, bytes32 ([u8; 32]:
// 32 raw bytes), string and bytes (varint length + bytes), vec<T>, option<T>, and the struct
// names a spec defines in `types` (fields in order). JSON side: numbers or decimal strings,
// hex for bytes32 and bytes, null for None.

const te = new TextEncoder();
const td = new TextDecoder("utf-8", { fatal: true });

export const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
export const unhex = (h) => {
  if (typeof h !== "string" || h.length % 2 || /[^0-9a-f]/.test(h)) throw new Error(`not lowercase hex: ${String(h).slice(0, 20)}`);
  return Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
};
export const concat = (parts) => {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) (out.set(p, o), (o += p.length));
  return out;
};

const UINT_BITS = { u16: 16n, u32: 32n, u64: 64n, u128: 128n };

export function varint(n) {
  let v = BigInt(n);
  if (v < 0n) throw new Error("negative");
  const out = [];
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return Uint8Array.from(out);
}

function inner(t, prefix) {
  return t.startsWith(prefix + "<") && t.endsWith(">") ? t.slice(prefix.length + 1, -1) : null;
}

/** Field list of a struct type: "Public", "Private", "Output" come from the spec's top level. */
export function fieldsOf(spec, name) {
  if (name === "Public") return spec.public;
  if (name === "Private") return spec.private;
  if (name === "Output") return spec.output;
  const f = spec.types?.[name];
  if (!f) throw new Error(`unknown type ${name}`);
  return f;
}

export function encode(spec, t, v) {
  if (t === "u8") {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n > 255) throw new Error(`u8 out of range: ${v}`);
    return Uint8Array.of(n);
  }
  if (UINT_BITS[t]) {
    const n = BigInt(v);
    if (n < 0n || n >= 1n << UINT_BITS[t]) throw new Error(`${t} out of range: ${v}`);
    return varint(n);
  }
  if (t === "bool") {
    if (typeof v !== "boolean") throw new Error("bool expected");
    return Uint8Array.of(v ? 1 : 0);
  }
  if (t === "bytes32") {
    const b = unhex(v);
    if (b.length !== 32) throw new Error("bytes32 needs 64 hex characters");
    return b;
  }
  if (t === "string") {
    const b = te.encode(v);
    return concat([varint(b.length), b]);
  }
  if (t === "bytes") {
    const b = unhex(v);
    return concat([varint(b.length), b]);
  }
  let i;
  if ((i = inner(t, "vec"))) {
    if (!Array.isArray(v)) throw new Error(`${t}: array expected`);
    return concat([varint(v.length), ...v.map((x) => encode(spec, i, x))]);
  }
  if ((i = inner(t, "option"))) return v === null || v === undefined ? Uint8Array.of(0) : concat([Uint8Array.of(1), encode(spec, i, v)]);
  const fields = fieldsOf(spec, t);
  if (typeof v !== "object" || v === null) throw new Error(`${t}: object expected`);
  const extra = Object.keys(v).filter((k) => !fields.some(([f]) => f === k));
  if (extra.length) throw new Error(`${t}: unknown field ${extra[0]}`);
  return concat(fields.map(([f, ft]) => encode(spec, ft, v[f])));
}

export function decode(spec, t, bytes) {
  let o = 0;
  const need = (n) => {
    if (o + n > bytes.length) throw new Error("short input");
  };
  const readVar = () => {
    let v = 0n,
      s = 0n;
    for (;;) {
      need(1);
      const b = bytes[o++];
      v |= BigInt(b & 0x7f) << s;
      if (!(b & 0x80)) return v;
      s += 7n;
      if (s > 140n) throw new Error("varint too long");
    }
  };
  const go = (t) => {
    if (t === "u8") return (need(1), bytes[o++]);
    if (UINT_BITS[t]) {
      const v = readVar();
      return t === "u64" || t === "u128" ? v.toString() : Number(v);
    }
    if (t === "bool") return (need(1), bytes[o++] === 1);
    if (t === "bytes32") return (need(32), hex(bytes.slice(o, (o += 32))));
    if (t === "string" || t === "bytes") {
      const n = Number(readVar());
      need(n);
      const b = bytes.slice(o, (o += n));
      return t === "string" ? td.decode(b) : hex(b);
    }
    let i;
    if ((i = inner(t, "vec"))) return Array.from({ length: Number(readVar()) }, () => go(i));
    if ((i = inner(t, "option"))) return (need(1), bytes[o++] ? go(i) : null);
    return Object.fromEntries(fieldsOf(spec, t).map(([f, ft]) => [f, go(ft)]));
  };
  const v = go(t);
  if (o !== bytes.length) throw new Error(`${bytes.length - o} trailing bytes`);
  return v;
}

/** The field type at a dotted path under Public/Private ("private.seats" -> vec<Seat>). */
export function typeAt(spec, path) {
  const [root, ...rest] = path.split(".");
  let t = root === "public" ? "Public" : root === "private" ? "Private" : null;
  if (!t) throw new Error(`path must start with public or private: ${path}`);
  for (const k of rest) {
    const f = fieldsOf(spec, t).find(([n]) => n === k);
    if (!f) throw new Error(`no field ${k} in ${t}`);
    t = f[1];
  }
  return t;
}

/**
 * Resolve a vector's special values: {"commit": tag, "of": "private.x"} becomes
 * hex(sha256(tag || postcard(value))), the template's smith_std::commit; {"hex_of_vector": i,
 * "field": f} copies resolved public field f of vector i.
 */
export async function resolveVector(spec, vec, sha256, resolved = []) {
  const priv = vec.private;
  const pub = {};
  for (const [f] of spec.public) {
    const v = vec.public[f];
    if (v && typeof v === "object" && !Array.isArray(v) && "commit" in v) {
      const path = v.of.split(".");
      let val = { private: priv, public: vec.public }[path[0]];
      for (const k of path.slice(1)) val = val[k];
      pub[f] = hex(await sha256(concat([te.encode(v.commit), encode(spec, typeAt(spec, v.of), val)])));
    } else if (v && typeof v === "object" && !Array.isArray(v) && "hex_of_vector" in v) {
      pub[f] = resolved[v.hex_of_vector].public[v.field];
    } else pub[f] = v;
  }
  return { ...vec, public: pub };
}

/** The guest's input bytes: its one public argument, a Vec<u8>, postcard. */
export const guestInputs = (publicBytes) => concat([varint(publicBytes.length), publicBytes]);
/** The guest's output bytes: (spec hash, private commitment, output bytes), postcard. */
export const guestOutputs = (specHash, privateCommit, outputBytes) => concat([specHash, privateCommit, varint(outputBytes.length), outputBytes]);
