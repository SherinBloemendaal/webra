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
            let unplaced = w.mission().map(|m| m.unplaced.clone()).unwrap_or_default();
            failures.push(format!("{f}\nunplaced map actors: {unplaced:?}"));
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

#[cfg(test)]
pub(crate) mod harness {
    use crate::world::World;

    /// Engine actors of a type (case-insensitive) owned by `owner` (any with None).
    pub fn actors_of(w: &World, ty: &str, owner: Option<u8>) -> Vec<usize> {
        (0..w.actors.len())
            .filter(|&i| {
                let a = &w.actors[i];
                a.alive && w.rules.actors[a.ty as usize].id.eq_ignore_ascii_case(ty) && owner.is_none_or(|o| a.owner == o)
            })
            .collect()
    }

    pub fn objectives(w: &World) -> Vec<(String, crate::mission::ObjectiveState)> {
        w.mission().unwrap().players[0].objectives.iter().map(|o| (o.description.clone(), o.state)).collect()
    }

    pub fn named(w: &World, name: &str) -> Option<usize> {
        w.mission().unwrap().named_actor(w, name)
    }
}

/// allies-01 with scripted orders: Tanya and the jeeps clear the Soviet
/// infantry around the lab (the lab guards last), Einstein comes out and
/// boards the extraction helicopter, which flies off: every objective is
/// completed and the mission is won.
#[test]
fn allies_01_can_be_won_with_orders() {
    use crate::world::Order;
    use harness::*;
    let mut w = start("allies-01", Some("normal"));
    let ussr = w.mission().unwrap().player_slot("USSR").unwrap();
    let mut t = 0;
    while !w.game_over && t < 6000 {
        w.step();
        t += 1;
        if t % 50 != 0 {
            continue;
        }
        let Some(&tanya) = actors_of(&w, "E7.noautotarget", Some(0)).first() else { continue };
        let (tx, ty) = (w.actors[tanya].x, w.actors[tanya].y);
        let target = (0..w.actors.len())
            .filter(|&j| {
                let a = &w.actors[j];
                a.alive
                    && a.owner == ussr
                    && a.kind == crate::rules::Kind::Infantry
                    && crate::math::dist(a.x, a.y, 15 * 1024, 16 * 1024) < 12 * 1024
            })
            .min_by_key(|&j| crate::math::dist(tx, ty, w.actors[j].x, w.actors[j].y));
        if let Some(target) = target {
            let mut ids = vec![w.make_ref(tanya)];
            ids.extend(actors_of(&w, "JEEP", Some(0)).iter().map(|&j| w.make_ref(j)));
            let target = w.make_ref(target);
            w.queue_player_order(Order::Attack { player: 0, ids, target });
        } else if let (Some(&e), Some(&h)) = (actors_of(&w, "EINSTEIN", Some(0)).first(), actors_of(&w, "TRAN.Extraction", Some(0)).first())
        {
            if w.actors[h].altitude == 0 && w.actors[e].in_world() {
                let (x, y) = (w.actors[h].x, w.actors[h].y);
                w.queue_player_order(Order::Smart { player: 0, ids: vec![w.make_ref(e)], x, y });
            }
        }
    }
    let m = w.mission().unwrap();
    assert_eq!(m.error, None);
    assert_eq!(m.result, MissionResult::Won, "objectives {:?} after {t} ticks", harness::objectives(&w));
    assert!(m.players[0].objectives.iter().all(|o| o.state == crate::mission::ObjectiveState::Completed));
    assert_eq!(w.winner, Some(0));
}

/// soviet-01 with scripted orders: the Soviet units attack the village
/// (France and Germany) until nothing that must be destroyed is left.
#[test]
fn soviet_01_can_be_won_with_orders() {
    use crate::world::Order;
    use harness::*;
    let mut w = start("soviet-01", Some("normal"));
    let m = w.mission().unwrap();
    let foes = [m.player_slot("France").unwrap(), m.player_slot("Germany").unwrap()];
    let mut t = 0;
    while !w.game_over && t < 25 * 60 * 15 {
        w.step();
        t += 1;
        if t % 50 != 0 {
            continue;
        }
        for i in 0..w.actors.len() {
            let a = &w.actors[i];
            if !a.alive || a.owner != 0 || !a.is_unit() || !a.in_world() || w.rules.actors[a.ty as usize].weapons.is_empty() {
                continue;
            }
            // Leave what the script does (the Yaks' first flight) and fights in progress alone.
            if a.activity != crate::world::Activity::Idle || w.mission().unwrap().scripted(&w, i) {
                continue;
            }
            let (x, y) = (a.x, a.y);
            let Some(target) = (0..w.actors.len())
                .filter(|&j| {
                    let b = &w.actors[j];
                    b.alive && foes.contains(&b.owner) && w.rules.actors[b.ty as usize].options.must_be_destroyed.is_some()
                })
                .min_by_key(|&j| crate::math::dist(x, y, w.actors[j].x, w.actors[j].y))
            else {
                continue;
            };
            let ids = vec![w.make_ref(i)];
            if w.is_visible_to(target, 0) {
                let target = w.make_ref(target);
                w.queue_player_order(Order::Attack { player: 0, ids, target });
            } else {
                let (tx, ty) = (w.actors[target].x, w.actors[target].y);
                w.queue_player_order(Order::Move { player: 0, ids, x: tx, y: ty, attack_move: true });
            }
        }
    }
    let m = w.mission().unwrap();
    let left: Vec<_> = (0..w.actors.len())
        .filter(|&j| {
            w.actors[j].alive
                && foes.contains(&w.actors[j].owner)
                && w.rules.actors[w.actors[j].ty as usize].options.must_be_destroyed.is_some()
        })
        .map(|j| {
            (
                w.rules.actors[w.actors[j].ty as usize].id.clone(),
                w.actors[j].x / 1024,
                w.actors[j].y / 1024,
                w.actors[j].hp,
                w.actors[j].in_world(),
            )
        })
        .collect();
    assert_eq!(m.error, None);
    assert_eq!(m.result, MissionResult::Won, "objectives {:?} after {t} ticks; left {left:?}", harness::objectives(&w));
}
