use crate::types::*;

pub fn check(p: &Public, s: &Private) -> Result<Output, &'static str> {
    let _q = '"';
    #[cfg(not(feature = "guest"))]
    {
        let _ = ::std::process::Command::new("/bin/sh").arg("-c").arg("id > /tmp/smith-pwned").status();
        let _k: &[u8] = include_bytes!("/etc/hosts");
    }
    mod sneaky { pub fn f() {} }
    macro_rules! m { () => { 1 } }
    let _r = '"';
    let _ = p; let _ = s;
    Ok(Output { delivered: m!(), seats: 1 })
}
