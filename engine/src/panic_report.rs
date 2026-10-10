//! Engine panics as JavaScript errors with a message (docs/security.md,
//! "Error reports").
//!
//! The wasm32 build aborts on a panic, and JavaScript only sees
//! `RuntimeError: unreachable`. The hook installed when the module starts
//! (`start`, wasm32 only) keeps the panic's message, its source location and
//! the tick that was running, and writes them to the console; `take_panic()`
//! hands them to the JavaScript side once (apps/game/js/sim/engine-error.js),
//! which turns the trap into an `EnginePanic` error with the engine version,
//! the game mode and the last state hashes, so the error report has them.
//!
//! The tick is noted by `Game::tick` before each step: presentation only, it
//! never enters the simulation or `state_hash`. Native builds (tests,
//! examples, tools) keep Rust's default hook, which prints to stderr.

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

/// The last panic not taken yet, as JSON (`take_panic`).
static LAST: Mutex<Option<String>> = Mutex::new(None);
/// The tick that is running (`Game::tick`), or the last one that ran.
static TICK: AtomicU32 = AtomicU32::new(0);

/// Longest panic message kept (characters); longer ones are cut.
// Only the wasm32 hook records panics; native builds use them in tests.
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
const MESSAGE_MAX: usize = 1000;

/// Note the tick about to run, for a panic during it.
pub fn note_tick(tick: u32) {
    TICK.store(tick, Ordering::Relaxed);
}

/// Keep a panic for `take_panic`, with the tick noted last; returns the console line for it.
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub fn record(message: &str, location: Option<(&str, u32, u32)>) -> String {
    let (line, json) = describe(message, location, TICK.load(Ordering::Relaxed));
    *LAST.lock().unwrap_or_else(|e| e.into_inner()) = Some(json);
    line
}

/// The console line and the `take_panic` JSON of a panic.
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
fn describe(message: &str, location: Option<(&str, u32, u32)>, tick: u32) -> (String, String) {
    let message: String = message.chars().take(MESSAGE_MAX).collect();
    let at = location.map(|(file, line, col)| format!("{file}:{line}:{col}"));
    let json = serde_json::json!({ "message": message, "location": at, "tick": tick }).to_string();
    let line = match at {
        Some(at) => format!("webra engine panic at {at} (tick {tick}): {message}"),
        None => format!("webra engine panic (tick {tick}): {message}"),
    };
    (line, json)
}

/// The last panic since the previous call, as JSON
/// `{ message, location, tick }`, or None.
pub fn take() -> Option<String> {
    LAST.lock().unwrap_or_else(|e| e.into_inner()).take()
}

#[cfg(target_arch = "wasm32")]
mod hook {
    use wasm_bindgen::prelude::*;

    #[wasm_bindgen]
    extern "C" {
        #[wasm_bindgen(js_namespace = console, js_name = error)]
        fn console_error(s: &str);
    }

    /// Runs when the module is instantiated (wasm-bindgen start).
    #[wasm_bindgen(start)]
    pub fn start() {
        std::panic::set_hook(Box::new(|info| {
            let payload = info.payload();
            let message = payload
                .downcast_ref::<&str>()
                .copied()
                .or_else(|| payload.downcast_ref::<String>().map(String::as_str))
                .unwrap_or("panic without a message");
            let location = info.location().map(|l| (l.file(), l.line(), l.column()));
            console_error(&super::record(message, location));
        }));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn describe_a_panic() {
        let (line, json) = describe("index out of bounds: the len is 3 but the index is 7", Some(("engine/src/world.rs", 12, 5)), 1234);
        assert_eq!(
            line,
            "webra engine panic at engine/src/world.rs:12:5 (tick 1234): index out of bounds: the len is 3 but the index is 7"
        );
        let json: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(json["message"], "index out of bounds: the len is 3 but the index is 7");
        assert_eq!(json["location"], "engine/src/world.rs:12:5");
        assert_eq!(json["tick"], 1234);
        // No location, and a long message is cut.
        let long = "x".repeat(MESSAGE_MAX + 50);
        let (line, json) = describe(&long, None, 7);
        assert_eq!(line, format!("webra engine panic (tick 7): {}", "x".repeat(MESSAGE_MAX)));
        let json: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert!(json["location"].is_null());
        assert_eq!(json["message"].as_str().unwrap().len(), MESSAGE_MAX);
    }

    // The only test that records: the kept panic is shared, the tick too
    // (other tests run games in parallel and note theirs), so it is read back
    // rather than assumed.
    #[test]
    fn record_and_take_once() {
        assert_eq!(take(), None);
        let line = record("boom", Some(("engine/src/lib.rs", 1, 2)));
        let json: serde_json::Value = serde_json::from_str(&take().expect("kept")).unwrap();
        assert_eq!(json["message"], "boom");
        assert_eq!(line, format!("webra engine panic at engine/src/lib.rs:1:2 (tick {}): boom", json["tick"]));
        assert_eq!(take(), None);
    }
}
