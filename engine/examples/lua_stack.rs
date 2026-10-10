//! The Lua interpreter's stack use per level in a wasm32 build (src/stack_check.rs),
//! built with `cargo build --release --target wasm32-unknown-unknown --example
//! lua_stack --features stack-probe` and run by tools/lua-stack-wasm.mjs.
//! Exports plain functions (no wasm-bindgen glue): the number of cases, and
//! per case its stack bytes and levels.

use webra_sim::mission::setup::MissionOptions;
use webra_sim::mission::MissionData;
use webra_sim::stack_check::{
    lua_cases, lua_overflows, measure_lua, measure_mission, mission_overflows, overflow_cases, Measured, HOST_CASE, HOST_OVERFLOW_CASES,
};
use webra_sim::world::World;

/// allies-01, for the host round trips (any mission has the API).
const MISSION: &str = include_str!("../../apps/game/missions/allies-01.json");

/// Cases: the Lua ones, then the host round trips.
#[no_mangle]
pub extern "C" fn case_count() -> u32 {
    lua_cases().len() as u32 + 1
}

#[no_mangle]
pub extern "C" fn max_levels() -> u32 {
    webra_sim::lua::MAX_LEVELS
}

/// The wasm budget the native code assumes (stack_check::WASM_BUDGET).
#[no_mangle]
pub extern "C" fn budget() -> u32 {
    webra_sim::stack_check::budget() as u32
}

fn mission() -> World {
    let data = MissionData::parse(MISSION).expect("allies-01 parses");
    World::from_mission(data, 1, &MissionOptions::default()).expect("allies-01 starts")
}

fn run(case: u32) -> Measured {
    let cases = lua_cases();
    if (case as usize) < cases.len() {
        return measure_lua(&cases[case as usize].1).expect("the case runs");
    }
    measure_mission(&mut mission(), HOST_CASE).expect("the host case runs")
}

/// Unbounded recursion cases: the Lua ones, then the host ones.
#[no_mangle]
pub extern "C" fn overflow_count() -> u32 {
    (overflow_cases().len() + HOST_OVERFLOW_CASES.len()) as u32
}

/// 1 when unbounded recursion case `case` ends in a "stack overflow" Lua
/// error (a real stack overflow traps instead).
#[no_mangle]
pub extern "C" fn overflow(case: u32) -> u32 {
    let cases = overflow_cases();
    let k = case as usize;
    let ok =
        if k < cases.len() { lua_overflows(&cases[k]) } else { mission_overflows(&mut mission(), HOST_OVERFLOW_CASES[k - cases.len()]) };
    ok as u32
}

/// Stack bytes of case `case` (high 32 bits) and its levels (low 32 bits).
#[no_mangle]
pub extern "C" fn measure(case: u32) -> u64 {
    let m = run(case);
    ((m.bytes as u64) << 32) | m.levels as u64
}
