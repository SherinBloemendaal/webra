//! What one level of the Lua interpreter's nesting (`lua::MAX_LEVELS`) costs
//! in stack on the target this is built for. The native tests check it for
//! the target they run on (`lua::tests::native_stack_per_level`,
//! `tests_mission::host_round_trips_fit_the_native_stack`); the wasm32 build,
//! the one that matters in the browser and the server's validator, is
//! checked by `examples/lua_stack.rs` run in node (tools/lua-stack-wasm.mjs).
//!
//! The deepest kinds of nesting: nested expressions, Lua calls, library calls,
//! calls inside nested expressions, and host round trips (`Utils.Do` calling
//! back into Lua through the mission API, whose frames are the largest).

use crate::lua::{stack_probe, Lua, NoHost};
use crate::world::World;

/// Per-target stack budgets for MAX_LEVELS levels, in bytes, each half of the
/// stack the code runs on (the rest is for the callers). WebAssembly: half of
/// its 1 MiB stack (rustc's default for wasm32, checked against the module's
/// stack pointer by tools/lua-stack-wasm.mjs).
pub const WASM_BUDGET: usize = 512 << 10;
/// Native: half of the 1 MiB threads the overflow tests run on. Native code
/// is only the tests' and the tools' (the game and the server run wasm32),
/// and its frames vary most between compilers and platforms (an optimised
/// build measured 490 to 680 bytes per level on arm64 and x86_64 macOS, up to
/// about 850 on Linux x86_64 in CI).
pub const NATIVE_BUDGET: usize = 512 << 10;
/// Stack of the threads the overflow tests run on (native, optimised).
pub const NATIVE_TEST_STACK: usize = 1 << 20;

/// The budget of the target this is built for.
pub const fn budget() -> usize {
    if cfg!(target_arch = "wasm32") {
        WASM_BUDGET
    } else {
        NATIVE_BUDGET
    }
}

/// The Lua cases: name and source. Each stays below MAX_LEVELS levels and
/// above 90, so the per-level cost is measured over many levels.
pub fn lua_cases() -> Vec<(&'static str, String)> {
    vec![
        ("nested parentheses", format!("return {}1{}", "(".repeat(95), ")".repeat(95))),
        ("Lua calls", "local function f(n) if n == 0 then return 0 end return 1 + f(n - 1) end return f(45)".to_string()),
        ("library calls", "local function f(n) if n == 0 then return 0 end return select(2, pcall(f, n - 1)) end return f(40)".to_string()),
        (
            "calls in nested expressions",
            format!(
                "local function f(n) if n == 0 then return 0 end return {}f(n - 1){} end return f(7)",
                "(1 + ".repeat(20),
                ")".repeat(20)
            ),
        ),
    ]
}

/// The host round trip case, run in a mission's interpreter.
pub const HOST_CASE: &str = "local function f(n) if n == 0 then return end Utils.Do({ 1 }, function() f(n - 1) end) end f(18)";

/// Unbounded recursion of every kind: each must end in a "stack overflow"
/// Lua error (or, through pcall, its message as the result) before the real
/// stack runs out.
pub fn overflow_cases() -> Vec<String> {
    vec![
        "local function f(n) return 1 + f(n + 1) end return f(1)".to_string(),
        "local function f(t) return {f({t})} end return f({})".to_string(),
        format!("local function f(n) return {}f(n + 1){} end return f(1)", "(1 + ".repeat(45), ")".repeat(45)),
        "local function f(n) return select(2, pcall(f, n + 1)) end return f(1)".to_string(),
        "local function f(t) table.sort({1, 2, 3}, function(a, b) f(t) return a < b end) end f(1)".to_string(),
    ]
}

/// The same through the mission API (`Utils.Do` calling back into Lua).
pub const HOST_OVERFLOW_CASES: [&str; 2] = [
    "local function f() Utils.Do({ 1 }, function() f() end) end f()",
    "local function f() Utils.Do({ 1 }, function() return ((((((((f())))))))) end) end f()",
];

/// Whether `src` ends in "stack overflow" in a fresh interpreter.
pub fn lua_overflows(src: &str) -> bool {
    let mut lua = Lua::new();
    match lua.exec(&mut NoHost, "case.lua", src) {
        Err(e) => e.report().contains("stack overflow"),
        Ok(v) => v.first().and_then(|v| v.to_text()).is_some_and(|t| t.contains("stack overflow")),
    }
}

/// Whether `src` ends in "stack overflow" in the mission world `w`.
pub fn mission_overflows(w: &mut World, src: &str) -> bool {
    w.mission_exec(src).err().is_some_and(|e| e.contains("stack overflow"))
}

/// One measurement: stack bytes used and the most levels in use.
#[derive(Clone, Copy, Debug)]
pub struct Measured {
    pub bytes: usize,
    pub levels: u32,
}

impl Measured {
    pub fn per_level(self) -> f64 {
        self.bytes as f64 / self.levels.max(1) as f64
    }

    /// Bytes MAX_LEVELS levels of this kind take.
    pub fn worst(self) -> f64 {
        self.per_level() * crate::lua::MAX_LEVELS as f64
    }
}

/// Run Lua case `src` in a fresh interpreter and measure it.
pub fn measure_lua(src: &str) -> Result<Measured, String> {
    let mut lua = Lua::new();
    let start = stack_probe::start();
    lua.exec(&mut NoHost, "case.lua", src).map_err(|e| e.report())?;
    let (bytes, levels) = stack_probe::used(start);
    Ok(Measured { bytes, levels })
}

/// Run `src` in the mission world `w` (its API is the host) and measure it.
pub fn measure_mission(w: &mut World, src: &str) -> Result<Measured, String> {
    let start = stack_probe::start();
    w.mission_exec(src)?;
    let (bytes, levels) = stack_probe::used(start);
    Ok(Measured { bytes, levels })
}
