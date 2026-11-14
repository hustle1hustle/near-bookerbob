"""Split a lean4export 3.1 NDJSON file into BASE then DELTA (Emet's shape): base = every
declaration outside the given namespaces plus everything it references (theorem proofs replaced
by axioms when --slim), delta = the namespaces' declarations plus what only they reference.
Writes one file (base lines first, then delta lines, indices renumbered in that order) and prints
base_bytes, base_decls, delta_bytes. Usage: split.py in.ndjson out.ndjson [--slim] Smith. ..."""
import json, sys
args = sys.argv[1:]; slim = '--slim' in args; args = [a for a in args if a != '--slim']
# --base <base-export.ndjson>: the base is the set of declarations of that export (the fixed base
# roots, exported alone); everything else is delta. The program export must have been made with
# the same root list first (leanexport then emits an identical prefix), so the base part comes out
# byte-identical for every program. Without --base, the base is every declaration outside the
# given name prefixes (per-program base; not shared).
base_file = None
if '--base' in args:
    i = args.index('--base'); base_file = args[i + 1]; del args[i:i + 2]
src, dst, prefixes = args[0], args[1], args[2:]
names, levels, exprs, decls, meta = {}, {}, {}, [], None
for line in open(src):
    d = json.loads(line)
    if 'meta' in d: meta = d; continue
    if 'in' in d: names[d['in']] = d; continue
    if 'il' in d: levels[d['il']] = d; continue
    if 'ie' in d: exprs[d['ie']] = d; continue
    decls.append(d)
def name_str(i):
    parts = []
    while i != 0:
        n = names[i]; parts.append(n['str']['str'] if 'str' in n else str(n['num']['i']))
        i = (n.get('str') or n.get('num'))['pre']
    return '.'.join(reversed(parts))
N = {'name','pre','induct','typeName','ctor','param'}; NL = {'all','levelParams','ctors'}
L = {'sort','succ'}; LL = {'us','max','imax'}
E = {'fn','arg','type','body','value','rhs','struct','expr'}
class Marks:
    def __init__(s): s.n, s.l, s.e = set(), set(), set()
def walk(m, obj):
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k in ('in','il','ie'): continue
            if k in N and isinstance(v, int): mark_n(m, v)
            elif k in NL and isinstance(v, list) and all(isinstance(x, int) for x in v):
                for x in v: mark_n(m, x)
            elif k in L and isinstance(v, int): mark_l(m, v)
            elif k in LL and isinstance(v, list):
                for x in v: mark_l(m, x)
            elif k in E and isinstance(v, int): mark_e(m, v)
            else: walk(m, v)
    elif isinstance(obj, list):
        for x in obj: walk(m, x)
def mark_n(m, i):
    if i in m.n or i == 0: return
    m.n.add(i); walk(m, names[i])
def mark_l(m, i):
    if i in m.l or i == 0: return
    m.l.add(i); walk(m, levels[i])
def mark_e(m, i):
    if i in m.e: return
    m.e.add(i); walk(m, exprs[i])
def decl_name(d):
    k = next(iter(d)); body = d[k]
    return name_str(body['name'] if 'name' in body else body['types'][0]['name'])
base_names = None
if base_file:
    bn, base_names = {}, set()
    for line in open(base_file):
        d = json.loads(line)
        if 'in' in d: bn[d['in']] = d; continue
        if any(k in d for k in ('meta', 'il', 'ie')): continue
        k = next(iter(d)); body = d[k]; i = body['name'] if 'name' in body else body['types'][0]['name']
        parts = []
        while i != 0:
            n = bn[i]; parts.append(n['str']['str'] if 'str' in n else str(n['num']['i'])); i = (n.get('str') or n.get('num'))['pre']
        base_names.add('.'.join(reversed(parts)))
def is_delta(d):
    if base_names is not None: return decl_name(d) not in base_names
    return any(decl_name(d).startswith(p) for p in prefixes)
base_decls, delta_decls = [], []
for d in decls:
    k = next(iter(d)); body = d[k]
    if is_delta(d): delta_decls.append(d); continue
    if slim and k == 'thm':
        d = {'axiom': {'isUnsafe': False, 'levelParams': body['levelParams'], 'name': body['name'], 'type': body['type']}}
    base_decls.append(d)
B = Marks()
for d in base_decls: walk(B, d)
D = Marks()
for d in delta_decls: walk(D, d)
D.n -= B.n; D.l -= B.l; D.e -= B.e
# renumber: base first, then delta, each in ascending old index
rn = {0: 0}; rl = {0: 0}; re_ = {}
for i in sorted(B.n) + sorted(D.n): rn[i] = len(rn)
for i in sorted(B.l) + sorted(D.l): rl[i] = len(rl)
for i in sorted(B.e) + sorted(D.e): re_[i] = len(re_)
def renum(obj, k=None):
    if isinstance(obj, dict): return {kk: renum(v, kk) for kk, v in obj.items()}
    if isinstance(obj, list):
        if k in NL and all(isinstance(x, int) for x in obj): return [rn[x] for x in obj]
        if k in LL: return [rl[x] for x in obj]
        return [renum(x, k) for x in obj]
    if isinstance(obj, int) and not isinstance(obj, bool):
        if k in N or k == 'in': return rn[obj]
        if k in L or k == 'il': return rl[obj]
        if k in E or k == 'ie': return re_[obj]
    return obj
J = lambda o: json.dumps(renum(o), separators=(',', ':')) + '\n'
base = [J(meta)] + [J(names[i]) for i in sorted(B.n)] + [J(levels[i]) for i in sorted(B.l)] + [J(exprs[i]) for i in sorted(B.e)] + [J(d) for d in base_decls]
delta = [J(names[i]) for i in sorted(D.n)] + [J(levels[i]) for i in sorted(D.l)] + [J(exprs[i]) for i in sorted(D.e)] + [J(d) for d in delta_decls]
bb = sum(len(x.encode()) for x in base); db = sum(len(x.encode()) for x in delta)
def units(ds):
    # nanoda counts one declaration per theorem/def/axiom/opaque/quot and, for an inductive
    # record, one per type, constructor and recursor.
    u = 0
    for d in ds:
        k = next(iter(d)); b = d[k]
        u += len(b['types']) + len(b['ctors']) + len(b['recs']) if k == 'inductive' else 1
    return u
with open(dst, 'w') as f: f.writelines(base + delta)
print(json.dumps({'base_bytes': bb, 'base_records': len(base_decls), 'base_decls': units(base_decls), 'delta_bytes': db, 'delta_records': len(delta_decls), 'delta_decls': units(delta_decls), 'slim': slim}))
