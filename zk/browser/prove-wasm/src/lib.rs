//! The decide prover in a browser. The page hands it the guest ELF, the prover preprocessing
//! and public.json; it traces the guest, proves the trace with Jolt and returns the proof bytes.
//! Nothing leaves the device: the only imports are a random source and the progress channel.
//!
//! Progress is real: `trace` when the RISC-V run starts, `cycles` with the count the tracer
//! measured, then one `stage` per Jolt stage as the prover opens its tracing span
//! (prove_stage0 .. prove_stage8, with 6a and 6b: ten stages). They go out on a
//! BroadcastChannel so a rayon worker's panic reaches the page too.
use std::sync::Arc;

use decide_public::Public;
use jolt_host::JoltProgramSource;
use jolt_prover::ProverConfig;
use jolt_sdk::{JoltProverPreprocessing, MemoryConfig, ProofTranscript, TraceInputs, TracerBackend, F, PCS, VerifierVC};
use jolt_witness::{JoltVmWitnessConfig, JoltVmWitnessInputs, TraceBackend as WitnessTraceBackend};
use tracing::{span, Subscriber};
use tracing_subscriber::filter::LevelFilter;
use tracing_subscriber::layer::{Context, Layer, SubscriberExt};
use tracing_subscriber::registry::LookupSpan;
use tracing_subscriber::util::SubscriberInitExt;
use wasm_bindgen::prelude::*;

#[cfg(feature = "threads")]
pub use wasm_bindgen_rayon::init_thread_pool;

#[wasm_bindgen(inline_js = "
const channel = new BroadcastChannel('bookerbob-prove');
export function emit(kind, text, n) { channel.postMessage({ kind, text, n, at: performance.now() }); }
")]
extern "C" {
    fn emit(kind: &str, text: &str, n: f64);
}

/// Reports each Jolt stage as its span opens.
struct Stages;

impl<S: Subscriber + for<'a> LookupSpan<'a>> Layer<S> for Stages {
    fn on_new_span(&self, attrs: &span::Attributes<'_>, _: &span::Id, _: Context<'_, S>) {
        if let Some(stage) = attrs.metadata().name().strip_prefix("prove_stage") {
            emit("stage", stage, 0.0);
        }
    }
}

struct Guest(Vec<u8>);

impl JoltProgramSource for Guest {
    fn get_elf_contents(&self) -> Option<Vec<u8>> {
        Some(self.0.clone())
    }
    fn get_elf_compute_advice_contents(&self) -> Option<Vec<u8>> {
        None
    }
}

fn js(e: impl std::fmt::Display) -> JsError {
    JsError::new(&e.to_string())
}

#[wasm_bindgen]
pub struct Prover {
    guest: Guest,
    preprocessing: JoltProverPreprocessing,
}

#[wasm_bindgen]
impl Prover {
    #[wasm_bindgen(constructor)]
    pub fn new(elf: Vec<u8>, preprocessing: &[u8]) -> Result<Prover, JsError> {
        std::panic::set_hook(Box::new(|info| {
            console_error_panic_hook::hook(info);
            emit("panic", &info.to_string(), 0.0);
        }));
        let _ = tracing_subscriber::registry().with(Stages.with_filter(LevelFilter::INFO)).try_init();
        let (preprocessing, _) = bincode::serde::decode_from_slice(preprocessing, bincode::config::standard()).map_err(js)?;
        Ok(Prover { guest: Guest(elf), preprocessing })
    }

    /// True when this build hides the witness (Jolt's `zk` feature).
    pub fn zk() -> bool {
        cfg!(feature = "zk")
    }

    /// Traces and proves the statement in public.json. The steps are those of jolt-sdk's
    /// `prove_program`, kept apart here so the page can show the trace and its cycle count.
    pub fn prove(&self, public: &[u8]) -> Result<Vec<u8>, JsError> {
        let public = Public::from_json(public).map_err(|e| JsError::new(&e))?;
        let inputs = public.inputs().map_err(|e| JsError::new(&e))?;
        let expected = public.outputs().map_err(|e| JsError::new(&e))?;
        let pp = &self.preprocessing;

        emit("trace", "", 0.0);
        let program = Arc::new(self.guest.build_jolt_program().map_err(js)?);
        let program_preprocessing = pp.program_arc().ok_or_else(|| JsError::new("prover preprocessing does not retain the full program"))?;
        let m = pp.verifier.program.memory_layout();
        let memory_config = MemoryConfig {
            max_untrusted_advice_size: m.max_untrusted_advice_size,
            max_trusted_advice_size: m.max_trusted_advice_size,
            max_input_size: m.max_input_size,
            max_output_size: m.max_output_size,
            stack_size: m.stack_size,
            heap_size: m.heap_size,
            program_size: Some(m.program_size),
        };
        let trace = program.trace_with(&mut TracerBackend::new(), TraceInputs::new(inputs, Vec::new(), Vec::new(), memory_config)).map_err(js)?;
        let io = trace.device.clone();
        emit("cycles", "", trace.dimensions.trace_length as f64);
        if io.panic || !decide_public::same_output(&io.outputs, &expected) {
            return Err(JsError::new("the guest refused this statement: the claim does not follow the rules"));
        }

        let config = ProverConfig::derive_from_dimensions::<F>(
            trace.dimensions,
            m,
            pp.verifier.program.min_bytecode_address(),
            pp.verifier.program.program_image_len_words(),
            pp.verifier.program.max_padded_trace_length(),
        )
        .map_err(js)?;
        emit("padded", "", config.trace_length as f64);
        let witness_config = JoltVmWitnessConfig::new(config.trace_length.ilog2() as usize, config.ram_K, config.one_hot_config)
            .include_trusted_advice(false)
            .include_untrusted_advice(false);
        let witness = WitnessTraceBackend::try_new(witness_config, JoltVmWitnessInputs::new(&program, &program_preprocessing, trace)).map_err(js)?;
        let backend = jolt_prover::JoltBackend::<F, PCS>::optimized();
        let proof = jolt_prover::dory::prove::<F, PCS, VerifierVC, ProofTranscript>(backend.with_witness(&witness), pp, &config, None, &io).map_err(js)?;
        bincode::serde::encode_to_vec(&proof, bincode::config::standard()).map_err(js)
    }
}
