// Largest function bodies in a wasm file, with names when a name section is present.
import { readFileSync } from "node:fs";
const b = readFileSync(process.argv[2]); let p = 8;
const u = () => { let r = 0, s = 0, x; do { x = b[p++]; r += (x & 127) * 2 ** s; s += 7; } while (x & 128); return r; };
let nImports = 0, sizes = [], names = new Map();
while (p < b.length) {
  const id = b[p++]; const len = u(); const end = p + len;
  if (id === 2) { const n = u(); for (let i = 0; i < n; i++) { let l = u(); p += l; l = u(); p += l; const k = b[p++]; if (k === 0) { u(); nImports++; } else if (k === 1) { p++; const f = b[p++]; u(); if (f & 1) u(); } else if (k === 2) { const f = b[p++]; u(); if (f & 1) u(); } else { p += 2; } } }
  if (id === 10) { const n = u(); for (let i = 0; i < n; i++) { const l = u(); sizes.push([nImports + i, l]); p += l; } }
  if (id === 0) { const nl = u(); const nm = b.slice(p, p + nl).toString(); p += nl; if (nm === "name") { while (p < end) { const sid = b[p++]; const sl = u(); const se = p + sl; if (sid === 1) { const c = u(); for (let i = 0; i < c; i++) { const idx = u(); const l = u(); names.set(idx, b.slice(p, p + l).toString()); p += l; } } p = se; } } }
  p = end;
}
sizes.sort((a, b) => b[1] - a[1]);
for (const [i, l] of sizes.slice(0, +(process.argv[3] || 8))) console.log(l, names.get(i)?.slice(0, 160) ?? i);
