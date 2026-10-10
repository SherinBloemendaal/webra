//! Missions (mission/): every mission of OpenRA's Red Alert campaign loads
//! and runs without script errors, scripts are deterministic, and the first
//! Allied and Soviet missions can be won with scripted orders.

use crate::mission::setup::MissionOptions;
use crate::mission::{MissionData, MissionResult};
use crate::world::World;
use std::path::PathBuf;

pub(crate) fn missions_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../apps/game/missions")
}

/// Every mission file id in campaign order (apps/game/missions/index.json).
pub(crate) fn mission_ids() -> Vec<String> {
    let index: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(missions_dir().join("index.json")).expect("index.json")).expect("index");
    let mut out = Vec::new();
    for c in index["campaigns"].as_array().expect("campaigns") {
        for m in c["missions"].as_array().expect("missions") {
            out.push(m["id"].as_str().expect("id").to_string());
        }
    }
    out
}

pub(crate) fn load(id: &str) -> MissionData {
    let text = std::fs::read_to_string(missions_dir().join(format!("{id}.json"))).expect("mission file");
    MissionData::parse(&text).unwrap_or_else(|e| panic!("{id}: {e}"))
}

pub(crate) fn start(id: &str, difficulty: Option<&str>) -> World {
    let mut opts = MissionOptions::default();
    if let Some(d) = difficulty {
        opts.options.insert("difficulty".into(), d.into());
    }
    World::from_mission(load(id), 7, &opts).unwrap_or_else(|e| panic!("{id}: {e}"))
}

fn error_of(w: &World) -> Option<String> {
    w.mission().and_then(|m| m.error.clone())
}

#[test]
fn every_mission_loads_and_runs_without_script_errors() {
    let ticks: u32 = std::env::var("WEBRA_MISSION_TICKS").ok().and_then(|v| v.parse().ok()).unwrap_or(1500);
    let only = std::env::var("WEBRA_MISSION").ok();
    let mut failures = Vec::new();
    for id in mission_ids() {
        if only.as_deref().is_some_and(|o| o != id) {
            continue;
        }
        let mut w = start(&id, None);
        let mut failed = error_of(&w).map(|e| format!("{id} at load: {e}"));
        let mut t = 0;
        while failed.is_none() && t < ticks && !w.game_over {
            w.step();
            t += 1;
            failed = error_of(&w).map(|e| format!("{id} at tick {t}: {e}"));
        }
        if let Some(f) = failed {
            failures.push(f);
        }
    }
    assert!(failures.is_empty(), "{} missions failed:\n{}", failures.len(), failures.join("\n\n"));
}

#[test]
fn mission_results_start_open() {
    let w = start("allies-01", None);
    let m = w.mission().unwrap();
    assert_eq!(m.result, MissionResult::Playing);
    assert!(m.players[0].playable);
    assert_eq!(m.players[0].name, "Greece");
}
