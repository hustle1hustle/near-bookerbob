use near_sdk::{env, Promise};

fn key(i: u32) -> Vec<u8> {
    format!("chunk{i}").into_bytes()
}
fn count() -> u32 {
    env::storage_read(b"n").map(|b| u32::from_le_bytes(b.try_into().unwrap())).unwrap_or(0)
}
fn owner_only() {
    if env::predecessor_account_id() != env::current_account_id() {
        env::panic_str("owner only");
    }
}

/// Raw input: the next chunk of the code.
#[no_mangle]
pub extern "C" fn put() {
    owner_only();
    let n = count();
    env::storage_write(&key(n), &env::input().unwrap());
    env::storage_write(b"n", &(n + 1).to_le_bytes());
    env::log_str(&format!("chunk {n} stored"));
}

/// Raw input: the 32-byte sha256 of the whole code.
#[no_mangle]
pub extern "C" fn deploy() {
    owner_only();
    let want = env::input().unwrap();
    let mut code = Vec::new();
    for i in 0..count() {
        code.extend(env::storage_read(&key(i)).unwrap());
        env::storage_remove(&key(i));
    }
    env::storage_remove(b"n");
    if env::sha256(&code) != want {
        env::panic_str("sha256 mismatch");
    }
    env::log_str(&format!("deploying {} bytes", code.len()));
    Promise::new(env::current_account_id()).deploy_contract(code);
}
