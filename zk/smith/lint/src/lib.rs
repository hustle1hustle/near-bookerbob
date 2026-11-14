//! The static check on the one file the model writes (body.rs). It parses the file with syn and
//! walks every item, path, attribute, macro and unsafe marker against an allowlist; anything not
//! named here is refused. It is one layer: the body crate is also `#![no_std]` and
//! `#![forbid(unsafe_code)]` on every target, and the checker's builds and runs are sandboxed.
//!
//! Allowed: `use` of crate::types, crate::smith_std, alloc::{vec, string, collections, borrow},
//! core::{cmp, convert, iter, ops, num, option, result}; private helper functions and consts;
//! exactly one `pub fn check(p: &Public, s: &Private) -> Result<Output, &'static str>`;
//! `///` doc comments. Refused: every macro (including vec!, cfg!, include_*!, env!), every
//! other attribute, unsafe, extern, modules, impls, traits, statics, type definitions, any path
//! that starts with `::`, std, self, super, or a crate root outside the allowlist.
use syn::ext::IdentExt;
use syn::visit::{self, Visit};
use syn::{Attribute, Expr, ExprLit, ExprPath, ExprRepeat, ExprUnsafe, File, Item, ItemFn, Lit, Macro, Meta, Path, QSelf, TypeArray, TypePath, UseTree};

const ROOTS: &[(&str, &[&str])] = &[
    ("crate", &["types", "smith_std"]),
    ("alloc", &["vec", "string", "collections", "borrow"]),
    ("core", &["cmp", "convert", "iter", "ops", "num", "option", "result"]),
];
const NEVER: &[&str] = &["std", "self", "super", "proc_macro", "test", "jolt", "postcard", "serde", "sha2"];
pub const MAX_LINES: usize = 300;
/// The largest `[x; N]` or `[T; N]` a body may write; N must be an integer literal.
pub const MAX_ARRAY: u64 = 4096;
/// Primitive type names, allowed as the first segment of a path (`u64::MAX`, `u8::from`).
const PRIMITIVES: &[&str] = &["u8", "u16", "u32", "u64", "u128", "usize", "i8", "i16", "i32", "i64", "i128", "isize", "bool", "char", "str"];

struct Lint {
    problems: Vec<String>,
}

impl Lint {
    fn no(&mut self, what: String) {
        if !self.problems.contains(&what) {
            self.problems.push(what);
        }
    }

    fn root_ok(&mut self, segs: &[String], leading_colon: bool, ctx: &str) {
        if leading_colon {
            return self.no(format!("{ctx}: a path that starts with `::` ({})", segs.join("::")));
        }
        let Some(first) = segs.first() else { return };
        if NEVER.contains(&first.as_str()) {
            return self.no(format!("{ctx}: `{}` is not allowed", segs.join("::")));
        }
        if let Some((_, subs)) = ROOTS.iter().find(|(r, _)| r == first) {
            match segs.get(1) {
                Some(s) if subs.contains(&s.as_str()) => {}
                _ => self.no(format!("{ctx}: `{}` is outside the allowlist", segs.join("::"))),
            }
        } else if segs.len() > 1 && !PRIMITIVES.contains(&first.as_str()) && !first.starts_with(|c: char| c.is_ascii_uppercase()) {
            // A multi-segment path must start at an allowed root, a primitive or a type name
            // (`Vec::new`, `Public::clone`); a lowercase root is a crate or module name.
            self.no(format!("{ctx}: `{}` starts at `{first}`, which is not an allowed root", segs.join("::")));
        }
    }

    fn use_tree(&mut self, prefix: &mut Vec<String>, t: &UseTree, leading: bool) {
        match t {
            UseTree::Path(p) => {
                prefix.push(p.ident.unraw().to_string());
                self.use_tree(prefix, &p.tree, leading);
                prefix.pop();
            }
            UseTree::Name(n) => {
                prefix.push(n.ident.unraw().to_string());
                self.root_ok(&prefix.clone(), leading, "use");
                prefix.pop();
            }
            UseTree::Rename(r) => {
                prefix.push(r.ident.unraw().to_string());
                self.root_ok(&prefix.clone(), leading, "use");
                prefix.pop();
            }
            UseTree::Glob(_) => {
                let ok = matches!(prefix.iter().map(String::as_str).collect::<Vec<_>>().as_slice(), ["crate", "types"] | ["crate", "smith_std"]);
                if !ok {
                    self.no(format!("use: glob import of `{}::*`", prefix.join("::")));
                }
            }
            UseTree::Group(g) => {
                for t in &g.items {
                    self.use_tree(prefix, t, leading);
                }
            }
        }
        if prefix.is_empty() && !leading {
            // the root of a use tree must itself be an allowed crate root
        }
    }
}

impl Lint {
    /// `<T>::f` and `<T as Tr>::f`: syn writes them as a path with a leading `::` after the
    /// qualified self. Check the self type, check `Tr` from its root, and the rest as members.
    fn qualified(&mut self, q: &QSelf, p: &Path) {
        self.visit_type(&q.ty);
        let segs: Vec<String> = p.segments.iter().map(|s| s.ident.unraw().to_string()).collect();
        if q.position > 0 {
            self.root_ok(&segs[..q.position], false, "path");
        }
        for seg in &p.segments {
            visit::visit_path_arguments(self, &seg.arguments);
        }
    }

    fn array_len(&mut self, len: &Expr) {
        let ok = matches!(len, Expr::Lit(ExprLit { lit: Lit::Int(n), .. }) if n.base10_parse::<u64>().is_ok_and(|v| v <= MAX_ARRAY));
        if !ok {
            self.no(format!("an array length must be an integer literal of at most {MAX_ARRAY}"));
        }
    }
}

impl<'a> Visit<'a> for Lint {
    /// Only doc comments: `#[doc = "a string literal"]`, which is what `///` becomes. A doc
    /// attribute with a macro (`#[doc = include_str!(..)]`) or any other form is refused.
    fn visit_attribute(&mut self, a: &'a Attribute) {
        let plain_doc = matches!(&a.meta, Meta::NameValue(nv) if nv.path.is_ident("doc") && matches!(&nv.value, Expr::Lit(ExprLit { lit: Lit::Str(_), .. })));
        if !plain_doc {
            self.no(format!("attribute `#[{}]`", quote::ToTokens::to_token_stream(&a.meta).to_string().replace(' ', "")));
        }
    }

    fn visit_macro(&mut self, m: &'a Macro) {
        let name = m.path.segments.iter().map(|s| s.ident.unraw().to_string()).collect::<Vec<_>>().join("::");
        self.no(format!("macro `{name}!` (no macros are allowed)"));
    }

    fn visit_expr_path(&mut self, e: &'a ExprPath) {
        for a in &e.attrs {
            self.visit_attribute(a);
        }
        match &e.qself {
            Some(q) => self.qualified(q, &e.path),
            None => self.visit_path(&e.path),
        }
    }

    fn visit_type_path(&mut self, t: &'a TypePath) {
        match &t.qself {
            Some(q) => self.qualified(q, &t.path),
            None => self.visit_path(&t.path),
        }
    }

    fn visit_expr_repeat(&mut self, e: &'a ExprRepeat) {
        self.array_len(&e.len);
        visit::visit_expr_repeat(self, e);
    }

    fn visit_type_array(&mut self, t: &'a TypeArray) {
        self.array_len(&t.len);
        visit::visit_type_array(self, t);
    }

    fn visit_expr_unsafe(&mut self, _: &'a ExprUnsafe) {
        self.no("unsafe block".into());
    }

    fn visit_item(&mut self, i: &'a Item) {
        match i {
            Item::Use(u) => {
                self.use_tree(&mut vec![], &u.tree, u.leading_colon.is_some());
                for a in &u.attrs {
                    self.visit_attribute(a);
                }
            }
            Item::Fn(_) | Item::Const(_) => visit::visit_item(self, i),
            Item::Mod(_) => self.no("module".into()),
            Item::Impl(_) => self.no("impl block".into()),
            Item::Trait(_) | Item::TraitAlias(_) => self.no("trait".into()),
            Item::Static(_) => self.no("static".into()),
            Item::Macro(_) => self.no("macro item".into()),
            Item::ExternCrate(_) | Item::ForeignMod(_) => self.no("extern".into()),
            Item::Struct(_) | Item::Enum(_) | Item::Union(_) | Item::Type(_) => self.no("type definition (types come from the spec)".into()),
            _ => self.no("an item the template does not allow".into()),
        }
    }

    fn visit_item_fn(&mut self, f: &'a ItemFn) {
        if f.sig.unsafety.is_some() {
            self.no(format!("unsafe fn {}", f.sig.ident));
        }
        if f.sig.abi.is_some() {
            self.no(format!("extern fn {}", f.sig.ident));
        }
        if f.sig.asyncness.is_some() || f.sig.variadic.is_some() {
            self.no(format!("async or variadic fn {}", f.sig.ident));
        }
        visit::visit_item_fn(self, f);
    }

    fn visit_path(&mut self, p: &'a Path) {
        let segs: Vec<String> = p.segments.iter().map(|s| s.ident.unraw().to_string()).collect();
        self.root_ok(&segs, p.leading_colon.is_some(), "path");
        visit::visit_path(self, p);
    }
}

/// Problems with a body.rs; empty means it passes.
pub fn check(src: &str) -> Vec<String> {
    let mut lint = Lint { problems: vec![] };
    if src.lines().count() > MAX_LINES {
        lint.no(format!("over {MAX_LINES} lines"));
    }
    let file: File = match syn::parse_file(src) {
        Ok(f) => f,
        Err(e) => return vec![format!("does not parse: {e}")],
    };
    for a in &file.attrs {
        lint.visit_attribute(a);
    }
    for i in &file.items {
        lint.visit_item(i);
    }
    let checks: Vec<&ItemFn> = file.items.iter().filter_map(|i| if let Item::Fn(f) = i { Some(f) } else { None }).filter(|f| f.sig.ident == "check").collect();
    let want = "pub fn check (p : & Public , s : & Private) -> Result < Output , & 'static str >";
    match checks.as_slice() {
        [f] => {
            let got = format!("{} {}", quote::ToTokens::to_token_stream(&f.vis), quote::ToTokens::to_token_stream(&f.sig));
            if got != want {
                lint.no(format!("check has the wrong signature: {got}"));
            }
        }
        _ => lint.no("exactly one `pub fn check(p: &Public, s: &Private) -> Result<Output, &'static str>`".into()),
    }
    lint.problems
}

// ---------- wasm32 C ABI (agents/smith/lint.wasm), no imports ----------

static mut OUT: Vec<u8> = Vec::new();

#[no_mangle]
pub extern "C" fn lint_alloc(len: usize) -> *mut u8 {
    let mut b = Vec::<u8>::with_capacity(len);
    let p = b.as_mut_ptr();
    core::mem::forget(b);
    p
}

/// Lints `len` UTF-8 bytes at `p`; the result (problems, one per line; empty = pass) is at
/// lint_out_ptr/lint_out_len. Returns the number of problems.
///
/// # Safety
/// `p` and `len` must come from one `lint_alloc(len)` call, filled by the caller.
#[no_mangle]
#[allow(static_mut_refs)]
pub unsafe extern "C" fn lint_run(p: *mut u8, len: usize) -> u32 {
    let src = Vec::from_raw_parts(p, len, len);
    let problems = match core::str::from_utf8(&src) {
        Ok(s) => check(s),
        Err(_) => vec!["not UTF-8".into()],
    };
    OUT = problems.join("\n").into_bytes();
    problems.len() as u32
}

#[no_mangle]
#[allow(static_mut_refs)]
pub unsafe extern "C" fn lint_out_ptr() -> *const u8 {
    OUT.as_ptr()
}

#[no_mangle]
#[allow(static_mut_refs)]
pub unsafe extern "C" fn lint_out_len() -> usize {
    OUT.len()
}
