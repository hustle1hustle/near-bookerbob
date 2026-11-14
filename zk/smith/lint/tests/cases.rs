//! Must-reject and must-pass cases for the smith lint.
use smith_lint::check;

fn rejects(src: &str, needle: &str) {
    let p = check(src);
    assert!(p.iter().any(|x| x.contains(needle)), "expected a problem containing {needle:?}, got {p:?}");
}

const OK_HEAD: &str = "use crate::types::*;\nuse crate::smith_std::commit;\n";

#[test]
fn evil1_from_the_audit_is_rejected_on_every_count() {
    let src = include_str!("fixtures/evil1.rs");
    let p = check(src);
    for needle in ["attribute `#[cfg", "a path that starts with `::`", "macro `include_bytes!`", "module", "macro item"] {
        assert!(p.iter().any(|x| x.contains(needle)), "evil1: missing {needle:?} in {p:?}");
    }
}

#[test]
fn the_accepted_coalition_body_passes() {
    let src = include_str!("../../programs/coalition-k-of-n/body/src/body.rs");
    assert_eq!(check(src), Vec::<String>::new());
}

#[test]
fn quotes_cannot_hide_code() {
    rejects(&format!("{OK_HEAD}pub fn check(p: &Public, s: &Private) -> Result<Output, &'static str> {{ let a = '\"'; let _ = std::process::Command::new(\"x\"); let b = '\"'; Err(\"x\") }}"), "`std::process::Command::new` is not allowed");
}

#[test]
fn every_macro_is_refused() {
    for m in ["vec![1]", "cfg!(unix)", "include_str!(\"/etc/hosts\")", "env!(\"HOME\")", "format!(\"x\")", "concat!(\"a\")"] {
        rejects(&format!("{OK_HEAD}pub fn check(p: &Public, s: &Private) -> Result<Output, &'static str> {{ let _ = {m}; Err(\"x\") }}"), "macro");
    }
}

#[test]
fn unsafe_extern_and_roots_are_refused() {
    let f = |body: &str| format!("{OK_HEAD}pub fn check(p: &Public, s: &Private) -> Result<Output, &'static str> {{ {body} Err(\"x\") }}");
    rejects(&f("unsafe { }"), "unsafe block");
    rejects(&f("let _ = core::ptr::null::<u8>();"), "outside the allowlist");
    rejects(&f("let _ = core::mem::size_of::<u8>();"), "outside the allowlist");
    rejects(&f("let _ = alloc::alloc::Layout::new::<u8>();"), "outside the allowlist");
    rejects(&f("let _ = ::core::cmp::max(1, 2);"), "starts with `::`");
    rejects(&f("let _ = self::check;"), "`self::check` is not allowed");
    rejects(&format!("{OK_HEAD}unsafe fn x() {{}}\npub fn check(p: &Public, s: &Private) -> Result<Output, &'static str> {{ Err(\"x\") }}"), "unsafe fn");
    rejects(&format!("{OK_HEAD}extern \"C\" fn x() {{}}\npub fn check(p: &Public, s: &Private) -> Result<Output, &'static str> {{ Err(\"x\") }}"), "extern fn");
    rejects(&format!("use std::fs;\npub fn check(p: &Public, s: &Private) -> Result<Output, &'static str> {{ Err(\"x\") }}"), "`std::fs` is not allowed");
    rejects(&format!("use alloc::*;\npub fn check(p: &Public, s: &Private) -> Result<Output, &'static str> {{ Err(\"x\") }}"), "glob import");
    rejects(&format!("{OK_HEAD}static X: u8 = 1;\npub fn check(p: &Public, s: &Private) -> Result<Output, &'static str> {{ Err(\"x\") }}"), "static");
    rejects(&format!("{OK_HEAD}impl Output {{}}\npub fn check(p: &Public, s: &Private) -> Result<Output, &'static str> {{ Err(\"x\") }}"), "impl block");
    rejects(&format!("#![no_std]\n{OK_HEAD}pub fn check(p: &Public, s: &Private) -> Result<Output, &'static str> {{ Err(\"x\") }}"), "attribute");
}

#[test]
fn the_check_signature_is_fixed() {
    rejects(&format!("{OK_HEAD}pub fn check(p: &Public, s: &mut Private) -> Result<Output, &'static str> {{ Err(\"x\") }}"), "wrong signature");
    rejects(&format!("{OK_HEAD}fn helper() {{}}"), "exactly one");
}

#[test]
fn raw_identifiers_are_read_as_what_they_name() {
    let f = |body: &str| format!("{OK_HEAD}pub fn check(p: &Public, s: &Private) -> Result<Output, &'static str> {{ {body} Err(\"x\") }}");
    rejects(&f("let _ = r#std::process::exit;"), "`std::process::exit` is not allowed");
    rejects(&f("let _ = r#core::ptr::null::<u8>();"), "outside the allowlist");
    rejects(&f("let _ = r#alloc::alloc::Layout::new::<u8>();"), "outside the allowlist");
    rejects("use r#std::fs;\npub fn check(p: &Public, s: &Private) -> Result<Output, &'static str> { Err(\"x\") }", "`std::fs` is not allowed");
}

#[test]
fn doc_attributes_only_as_plain_strings() {
    let tail = "\npub fn check(p: &Public, s: &Private) -> Result<Output, &'static str> { Err(\"x\") }";
    rejects(&format!("{OK_HEAD}#[doc = include_str!(\"/etc/hosts\")]{tail}"), "attribute");
    rejects(&format!("{OK_HEAD}#[doc = env!(\"HOME\")]{tail}"), "attribute");
    rejects(&format!("{OK_HEAD}#[doc = concat!(\"a\", \"b\")]{tail}"), "attribute");
    rejects(&format!("{OK_HEAD}#[doc(hidden)]{tail}"), "attribute");
    assert_eq!(check(&format!("{OK_HEAD}/// a plain doc comment{tail}")), Vec::<String>::new());
}

#[test]
fn a_path_starts_at_an_allowed_root_a_primitive_or_a_type() {
    let f = |body: &str| format!("{OK_HEAD}pub fn check(p: &Public, s: &Private) -> Result<Output, &'static str> {{ {body} Err(\"x\") }}");
    rejects(&f("let _ = serde::de::value::Error::custom;"), "not allowed");
    rejects(&f("let _ = postcard::to_allocvec(&1u8);"), "not allowed");
    rejects(&f("let _ = somecrate::thing();"), "which is not an allowed root");
    rejects(&f("let _ = <u8 as core::ptr::Thing>::f();"), "outside the allowlist");
    rejects(&f("let _ = <std::fs::File>::open;"), "not allowed");
    for ok in ["let _ = Public::clone(p);", "let _ = <Public>::clone(p);", "let _ = u64::MAX;", "let _: alloc::vec::Vec<u8> = Vec::new();", "let _ = Option::<u8>::None;", "let _ = core::cmp::max(1u8, 2u8);"] {
        assert_eq!(check(&f(ok)), Vec::<String>::new(), "{ok}");
    }
}

#[test]
fn array_lengths_are_small_literals() {
    let f = |body: &str| format!("{OK_HEAD}pub fn check(p: &Public, s: &Private) -> Result<Output, &'static str> {{ {body} Err(\"x\") }}");
    rejects(&f("let _ = [0u8; 100000000];"), "array length");
    rejects(&f("const N: usize = 8; let _ = [0u8; N];"), "array length");
    rejects(&f("let _: [u8; 1 << 30] = [0u8; 4];"), "array length");
    assert_eq!(check(&f("let _ = [0u8; 64]; let _: [u8; 32] = [0u8; 32];")), Vec::<String>::new());
}
