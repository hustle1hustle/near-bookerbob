//! `bookerbob` CLI.
//!
//!   bookerbob verify <fixtures-dir> [--receipts <json> [--check]]  offline end-to-end, PASS/FAIL per link
//!   bookerbob gen-fixtures <dir> [--check]  write (or check) deterministic fixtures
//!   bookerbob swarm <merchants.json> <verdict.json> <board.json> [--check]
//!   bookerbob referee <proofs.json> <verdict.json> <merchants.json> <merchant> <claims.json>
//!   bookerbob evals <evals.json> <proofs.json> <verdict.json> <merchants.json>
//!   bookerbob keys <dir> [--pub]            testnet trust-anchor keys (seeds stay in <dir>)
//!   bookerbob worker-input <fixtures-dir>   referee input for an OutLayer call
//!
//! `verify` runs the real `bazaar` contract code natively against near-sdk's
//! MockedBlockchain, which executes host functions (ed25519_verify, p256_verify, sha256)
//! through nearcore's VM logic. No network, no keys.

#[cfg(test)]
mod e2e_tests;
mod evals;
mod evidence;
mod fixtures;
mod keys;
mod near_ai;
mod reviews;
mod scenario;
mod swarm;
mod verify;
mod voprf;
mod zk_inputs;
mod zk_results;

use std::path::Path;
use std::process::ExitCode;

fn usage() -> ExitCode {
    eprintln!("usage: bookerbob verify <fixtures-dir> | gen-fixtures <dir> [--check] | swarm <merchants.json> <verdict.json> <board.json> [--check] | keys <dir> [--pub] | sign-live <keys-dir> <agent> <wallet2> <world-action> <out-dir>");
    ExitCode::from(2)
}

fn gen_fixtures(dir: &Path, check: bool) -> ExitCode {
    let mut stale = Vec::new();
    for (name, body) in fixtures::all() {
        let path = dir.join(name);
        if check {
            if std::fs::read_to_string(&path).ok().as_deref() != Some(body.as_str()) {
                stale.push(name);
            }
        } else {
            std::fs::create_dir_all(dir).expect("create fixtures dir");
            std::fs::write(&path, body).expect("write fixture");
            println!("wrote {}", path.display());
        }
    }
    if check {
        if stale.is_empty() {
            println!("fixtures up to date");
        } else {
            eprintln!("stale fixtures (run `make fixtures`): {}", stale.join(", "));
            return ExitCode::FAILURE;
        }
    }
    ExitCode::SUCCESS
}

/// `referee <proofs.json> <verdict.json> <merchants.json> <merchant> <claims.json>`:
/// prints the outcome as JSON; exit 0 on receipt, 1 on refusal.
fn referee_cmd(a: &[String]) -> ExitCode {
    fn load<T: serde::de::DeserializeOwned>(p: &str) -> T {
        serde_json::from_str(&std::fs::read_to_string(p).unwrap_or_else(|e| panic!("read {p}: {e}"))).unwrap_or_else(|e| panic!("parse {p}: {e}"))
    }
    let proofs: bookerbob_core::ProofSet = load(&a[0]);
    let verdict: bookerbob_core::SignedVerdict = load(&a[1]);
    let merchants: Vec<swarm::SwarmMerchant> = load(&a[2]);
    let claims: Vec<bookerbob_core::Claim> = load(&a[4]);
    let Some(m) = merchants.iter().find(|m| m.account == a[3]) else {
        eprintln!("unknown merchant {}", a[3]);
        return ExitCode::from(2);
    };
    let q = bookerbob_core::quote(&m.schedule, &verdict.envelope.predicates);
    let out = bookerbob_core::referee(&proofs, &verdict.envelope.predicates, &q, &claims);
    println!("{}", serde_json::to_string(&out).unwrap());
    if out.is_receipt() {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}

/// Print the referee worker input for the fixture purchase (honest claims, winner m01).
/// An optional second argument swaps in another signed verdict (the live one in demo-live).
/// `cohort_k`: the cohort size the contract counts now (its `quote` view), so the referee's
/// price equals the on-chain quote once a group price has unlocked; 0 offline.
/// 32 random bytes, hex: the salt of a live referee input (see `WorkerInput::salt`).
fn input_salt() -> Option<String> {
    use std::io::Read;
    let mut b = [0u8; 32];
    std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut b)).expect("urandom");
    Some(hex::encode(b))
}

fn worker_input(dir: &Path, verdict: Option<&Path>, cohort_k: u32) -> ExitCode {
    fn load<T: serde::de::DeserializeOwned>(p: std::path::PathBuf) -> T {
        serde_json::from_str(&std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("read {}: {e}", p.display()))).expect("parse")
    }
    let v: bookerbob_core::SignedVerdict = load(verdict.map(Path::to_path_buf).unwrap_or_else(|| dir.join("verdict-ed25519.json")));
    let ms: Vec<fixtures::MerchantFixture> = load(dir.join("merchants.json"));
    let input = bookerbob_referee_worker::WorkerInput {
        salt: input_salt(),
        v: 0,
        verdict_digest: hex::encode(v.envelope.digest()),
        nullifier: v.envelope.nullifier.clone(),
        merchant: ms[0].account.clone(),
        schedule: ms[0].schedule.clone(),
        revealed: v.envelope.predicates.clone(),
        claims: load(dir.join("claims-honest.json")),
        proofs: load(dir.join("proofs.json")),
        cohort_k,
        sealed_verdict: None,
    };
    println!("{}", serde_json::to_string(&input).unwrap());
    ExitCode::SUCCESS
}

/// The referee input for a sealed verdict: priced from its opening, no cohort.
fn worker_input_sealed(dir: &Path, verdict: &Path, opening: &Path) -> ExitCode {
    let read = |p: &Path| std::fs::read_to_string(p).unwrap_or_else(|e| panic!("read {}: {e}", p.display()));
    let v: bookerbob_core::SignedVerdict = serde_json::from_str(&read(verdict)).expect("verdict");
    let o: bookerbob_core::Opening = serde_json::from_str(&read(opening)).expect("opening");
    let ms: Vec<fixtures::MerchantFixture> = serde_json::from_str(&read(&dir.join("merchants.json"))).expect("merchants");
    let input = bookerbob_referee_worker::WorkerInput {
        salt: input_salt(),
        v: 0,
        verdict_digest: hex::encode(v.envelope.digest()),
        nullifier: v.envelope.nullifier.clone(),
        merchant: ms[0].account.clone(),
        schedule: ms[0].schedule.clone(),
        revealed: o.predicates.clone(),
        claims: serde_json::from_str(&read(&dir.join("claims-honest.json"))).expect("claims"),
        proofs: serde_json::from_str(&read(&dir.join("proofs.json"))).expect("proofs"),
        cohort_k: 0,
        sealed_verdict: Some(bookerbob_referee_worker::SealedVerdictInput { envelope: v.envelope, opening: o }),
    };
    println!("{}", serde_json::to_string(&input).unwrap());
    ExitCode::SUCCESS
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("verify") => match args.get(1) {
            Some(d) => {
                let receipts = args.iter().position(|a| a == "--receipts").and_then(|i| args.get(i + 1));
                verify::run_with_receipts(Path::new(d), receipts.map(|p| (Path::new(p.as_str()), args.iter().any(|a| a == "--check"))))
            }
            None => usage(),
        },
        Some("gen-fixtures") => match args.get(1) {
            Some(d) => gen_fixtures(Path::new(d), args.iter().any(|a| a == "--check")),
            None => usage(),
        },
        Some("referee") if args.len() >= 6 => referee_cmd(&args[1..6]),
        Some("keys") if args.len() >= 2 => keys::run(Path::new(&args[1]), args.iter().any(|a| a == "--pub")),
        Some("sign-live") if args.len() >= 6 => {
            // BOOKERBOB_NOW_MS re-creates an envelope already on chain (demo-live re-runs).
            let now = std::env::var("BOOKERBOB_NOW_MS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or_else(|| std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64);
            match keys::sign_live(Path::new(&args[1]), &args[2], &args[3], &args[4], now, Path::new(&args[5])) {
                Ok(()) => {
                    println!("wrote verdict.json, verdict-replay.json, world.json to {}", args[5]);
                    ExitCode::SUCCESS
                }
                Err(e) => {
                    eprintln!("{e}");
                    ExitCode::FAILURE
                }
            }
        }
        Some("evidence") => evidence::run(),
        // graph-input <onchain-root-hex> <out.json> <agent>:<sub> | hex:<event> ...: the standing guest's input
        // for a live graph, refused unless the events hash to the root read from chain.
        // referee-pub <keys-dir> [--x25519]: the worker key a buyer seals the referee input to;
        // by default the v1 hybrid key (pq1: X25519 + ML-KEM-768), --x25519 for the v0 key
        Some("referee-pub") if args.len() >= 2 => {
            let seed = std::fs::read_to_string(Path::new(&args[1]).join("referee.seed")).unwrap_or_default();
            match hex::decode(seed.trim()).ok().and_then(|b| <[u8; 32]>::try_from(b).ok()) {
                Some(s) => {
                    if args.iter().any(|a| a == "--x25519") {
                        println!("{}", bookerbob_referee_worker::sealed::public_hex(&s));
                    } else {
                        println!("{}", bookerbob_referee_worker::sealed::public_hex_v1(&s));
                    }
                    ExitCode::SUCCESS
                }
                None => {
                    eprintln!("no referee.seed in {}", args[1]);
                    ExitCode::FAILURE
                }
            }
        }
        // seal-input <worker-key> <input.json>: {"sealed":{..}} for request_referee; a pq1: key
        // gives a v1 hybrid envelope (X25519 + ML-KEM-768), a bare X25519 key a v0 one
        Some("seal-input") if args.len() >= 3 => {
            use std::io::Read;
            let mut rnd = [0u8; 88];
            std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut rnd)).expect("urandom");
            let pt = std::fs::read(&args[2]).expect("read input");
            let (eph, nonce, m): ([u8; 32], [u8; 24], [u8; 32]) =
                (rnd[..32].try_into().unwrap(), rnd[32..56].try_into().unwrap(), rnd[56..].try_into().unwrap());
            let sealed = if args[1].starts_with(bookerbob_referee_worker::sealed::PQ1) {
                bookerbob_referee_worker::sealed::seal_v1(&args[1], &pt, eph, m, nonce)
            } else {
                bookerbob_referee_worker::sealed::seal(&args[1], &pt, eph, nonce)
            };
            match sealed {
                Ok(s) => {
                    println!("{}", serde_json::json!({ "sealed": s }));
                    ExitCode::SUCCESS
                }
                Err(e) => {
                    eprintln!("{e}");
                    ExitCode::FAILURE
                }
            }
        }
        // graph-resolve <keys-dir> <root> <scores-hash> <proof-sha256> valid|invalid
        Some("graph-resolve") if args.len() >= 6 => match keys::graph_resolve(Path::new(&args[1]), &args[2], &args[3], &args[4], args[5] == "valid") {
            Ok(v) => {
                println!("{v}");
                ExitCode::SUCCESS
            }
            Err(e) => {
                eprintln!("{e}");
                ExitCode::FAILURE
            }
        },
        // graph-sign <keys-dir> <program-hash> <input.json> <out-args.json>
        // sign-real <keys-dir> <agent> <replay-account> <world-action> <out-dir> <proofs.json>: the device run
        // sign-real[-sealed] <keys-dir> <tester> <replay-account> <world-action> <out-dir> <proofs.json>
        Some(cmd @ ("sign-real" | "sign-real-sealed")) if args.len() >= 7 => {
            let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
            let f = if cmd == "sign-real" { keys::sign_real } else { keys::sign_real_sealed };
            match f(Path::new(&args[1]), &args[2], &args[3], &args[4], now, Path::new(&args[5]), Path::new(&args[6])) {
                Ok(n) => {
                    println!("{n}");
                    ExitCode::SUCCESS
                }
                Err(e) => {
                    eprintln!("{e}");
                    ExitCode::FAILURE
                }
            }
        }
        // sign-tester <keys-dir> <tester> <replay-account> <world-action> <out-dir>: prints the nullifier
        Some("sign-tester") if args.len() >= 6 => {
            let now = std::env::var("BOOKERBOB_NOW_MS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or_else(|| std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0));
            match keys::sign_tester(Path::new(&args[1]), &args[2], &args[3], &args[4], now, Path::new(&args[5])) {
                Ok(n) => {
                    println!("{n}");
                    ExitCode::SUCCESS
                }
                Err(e) => {
                    eprintln!("{e}");
                    ExitCode::FAILURE
                }
            }
        }
        // graph-sign <keys-dir> <program-hash> <input.json> <out-args.json> [proof.bin]
        Some("graph-sign") if args.len() >= 5 => {
            match keys::graph_sign_with_proof(Path::new(&args[1]), &args[2], Path::new(&args[3]), Path::new(&args[4]), args.get(5).map(Path::new)) {
                Ok(root) => {
                    println!("signed score update for root {}.. with the referee key; wrote {}", &root[..16], args[4]);
                    ExitCode::SUCCESS
                }
                Err(e) => {
                    eprintln!("{e}");
                    ExitCode::FAILURE
                }
            }
        }
        Some("graph-input") if args.len() >= 4 => {
            let ev: Vec<bookerbob_graph::Event> = args[3..]
                .iter()
                .map(|p| match p.strip_prefix("hex:") {
                    // A logged graph_event (e.g. the Seed from publish_reviews), as on chain.
                    Some(h) => bookerbob_graph::Event::from_bytes(&hex::decode(h).expect("hex event")).expect("graph event"),
                    None => {
                        let (a, b) = p.split_once(':').expect("agent:sub or hex:<event>");
                        bookerbob_graph::Event::Hire { agent: a.into(), sub: b.into() }
                    }
                })
                .collect();
            let s = bookerbob_graph::compute(&ev);
            if hex::encode(s.root) != args[1] {
                eprintln!("events hash to {}, chain says {}", hex::encode(s.root), args[1]);
                return ExitCode::FAILURE;
            }
            let bytes: Vec<Vec<u8>> = ev.iter().map(|e| e.bytes()).collect();
            let body = serde_json::json!({ "events": bytes, "expected": { "root": hex::encode(s.root), "scores_hash": hex::encode(s.hash()) } });
            std::fs::write(&args[2], serde_json::to_string_pretty(&body).unwrap() + "\n").expect("write");
            println!("{} events match the chain's graph_root {}..; wrote {}", ev.len(), &args[1][..16], args[2]);
            ExitCode::SUCCESS
        }
        Some("zk-results") if args.len() >= 3 => zk_results::run(Path::new(&args[1]), Path::new(&args[2])),
        Some("zk-inputs") if args.len() >= 2 => zk_inputs::run(Path::new(&args[1]), args.iter().any(|a| a == "--check")),
        Some("scenario") if args.len() >= 2 => scenario::run(Path::new(&args[1])),
        Some("reviews") if args.len() >= 2 => {
            reviews::run(Path::new(&args[1]), args.get(2).filter(|a| !a.starts_with("--")).map(Path::new), args.iter().any(|a| a == "--check"))
        }
        Some(c) if c.starts_with("voprf-") => voprf::run(&args),
        Some("near-ai") if args.len() >= 3 => near_ai::run(Path::new(&args[1]), Path::new(&args[2])),
        Some("near-ai-proof") if args.len() >= 2 => {
            let (_, p) = near_ai::proof(Path::new(&args[1]));
            let out = Path::new(&args[1]).join("proof.json");
            std::fs::write(&out, serde_json::to_string_pretty(&p).unwrap() + "\n").expect("write proof");
            println!("wrote {}", out.display());
            ExitCode::SUCCESS
        }
        // evaluator-sign <keys-dir> <draft-envelope.json> <request_sha256> <proofs.json>
        Some("evaluator-sign") if args.len() >= 5 => match keys::evaluator_sign(Path::new(&args[1]), Path::new(&args[2]), &args[3], Path::new(&args[4])) {
            Ok(sig) => {
                println!("{sig}");
                ExitCode::SUCCESS
            }
            Err(e) => {
                eprintln!("{e}");
                ExitCode::FAILURE
            }
        },
        Some("near-ai-bind") if args.len() >= 2 => {
            let e: bookerbob_core::Envelope = serde_json::from_str(&std::fs::read_to_string(&args[1]).expect("read envelope")).expect("parse envelope");
            println!("{}", e.near_ai_bind());
            ExitCode::SUCCESS
        }
        // standing-proofs <graph-input.json>: the proven standing tree of a graph (the guest input's
        // events): its root and every merchant's opening for the bazaar's in_top. Public: the
        // scores follow from the public events anyway.
        Some("standing-proofs") if args.len() >= 2 => {
            let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&args[1]).expect("read")).expect("json");
            let ev: Vec<bookerbob_graph::Event> = v["events"]
                .as_array()
                .expect("events")
                .iter()
                .map(|e| {
                    bookerbob_graph::Event::from_bytes(&e.as_array().into_iter().flatten().filter_map(|x| x.as_u64().map(|n| n as u8)).collect::<Vec<u8>>())
                        .expect("event")
                })
                .collect();
            let sc = bookerbob_graph::compute(&ev);
            let (root, proofs) = bookerbob_core::standing::graph(&sc.root, &sc.merchants);
            println!(
                "{}",
                serde_json::json!({ "graph_root": hex::encode(sc.root), "scores_hash": hex::encode(sc.hash()), "standing_root": hex::encode(root), "proofs": proofs })
            );
            ExitCode::SUCCESS
        }
        // quote <schedule-json> <pred,pred,..> <k>: the price by core (the contract's code) and by
        // zkcore directly (the code the Jolt price guest proves), for make audit's parity check.
        Some("quote") if args.len() >= 4 => {
            let s: bookerbob_core::Schedule = serde_json::from_str(&args[1]).expect("schedule json");
            let revealed: Vec<String> = args[2].split(',').filter(|x| !x.is_empty()).map(String::from).collect();
            let k: u32 = args[3].parse().expect("k");
            let core = bookerbob_core::quote_in_cohort(&s, &revealed, |_| k);
            let z = bookerbob_zkcore::price::quote_in_cohort(&s.to_zk(), &revealed, |_| k);
            println!("{}", serde_json::json!({ "core": core.price.to_string(), "zkcore": z.price.to_string(), "discount_bps": core.discount_bps }));
            ExitCode::SUCCESS
        }
        // eval-truth <items.json>: REP Eval v2's answers, from the referee's own check.
        // items: [{"proofs": ProofSet, "revealed": [..], "claims": [Claim]}]
        Some("eval-truth") if args.len() >= 2 => {
            #[derive(serde::Deserialize)]
            struct Item {
                proofs: bookerbob_core::ProofSet,
                revealed: Vec<String>,
                claims: Vec<bookerbob_core::Claim>,
            }
            let items: Vec<Item> = serde_json::from_str(&std::fs::read_to_string(&args[1]).expect("read")).expect("truth items");
            let out: Vec<serde_json::Value> = items
                .iter()
                .map(|it| {
                    let (n, why) = bookerbob_core::referee::first_refused(&it.proofs, &it.revealed, &it.claims);
                    serde_json::json!({ "answer": n, "reason": why })
                })
                .collect();
            println!("{}", serde_json::to_string(&out).unwrap());
            ExitCode::SUCCESS
        }
        // eval-grade <grade-input.json>: grade replies against expected answers, in the worker's code
        Some("eval-grade") if args.len() >= 2 => {
            let input: bookerbob_referee_worker::eval::GradeInput =
                serde_json::from_str(&std::fs::read_to_string(&args[1]).expect("read")).expect("grade input");
            match bookerbob_referee_worker::eval::grade(&input) {
                Ok(g) => {
                    println!("{}", serde_json::to_string(&g).unwrap());
                    ExitCode::SUCCESS
                }
                Err(e) => {
                    eprintln!("{e}");
                    ExitCode::FAILURE
                }
            }
        }
        // worker-input <fixtures-dir> [verdict.json] [cohort_k | opening.json]
        Some("worker-input") if args.len() >= 2 => match args.get(3).filter(|a| a.ends_with(".json")) {
            Some(o) => worker_input_sealed(Path::new(&args[1]), Path::new(&args[2]), Path::new(o)),
            None => worker_input(Path::new(&args[1]), args.get(2).map(Path::new), args.get(3).and_then(|k| k.parse().ok()).unwrap_or(0)),
        },
        Some("evals") if args.len() >= 5 => evals::run(Path::new(&args[1]), Path::new(&args[2]), Path::new(&args[3]), Path::new(&args[4])),
        Some("swarm") if args.len() >= 4 => swarm::run(Path::new(&args[1]), Path::new(&args[2]), Path::new(&args[3]), args.iter().any(|a| a == "--check")),
        _ => usage(),
    }
}
