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

/// Script errors OpenRA has as well, reached only by a player who does
/// nothing (long runs, `WEBRA_MISSION_TICKS`): soviet-05's Tick marks
/// Greece's objective on GoodGuy (`GoodGuy.MarkCompletedObjective(BeatUSSR)`)
/// once the USSR has lost its only unit, the MCV, and OpenRA's objective ids
/// are per player (MissionObjectiveProperties: "Objective ID is out of range").
const UPSTREAM_SCRIPT_ERRORS: &[(&str, &str)] = &[("soviet-05", "soviet05.lua:143: Objective ID is out of range.")];

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
        if std::env::var("WEBRA_MISSION_REPORT").is_ok() {
            // One line per mission (with --nocapture): how far it ran and where it stands.
            let m = w.mission().unwrap();
            let obj = &m.players[0].objectives;
            let done = obj.iter().filter(|o| o.state == crate::mission::ObjectiveState::Completed).count();
            let lost = obj.iter().filter(|o| o.state == crate::mission::ObjectiveState::Failed).count();
            eprintln!(
                "{id}: {t} ticks, {:?}, objectives {done} done {lost} failed of {}, map actors not placed: {:?}{}",
                m.result,
                obj.len(),
                m.unplaced,
                failed.as_deref().map(|f| format!(", ERROR {f}")).unwrap_or_default()
            );
        }
        let upstream = error_of(&w).is_some_and(|e| UPSTREAM_SCRIPT_ERRORS.iter().any(|(m, text)| *m == id && e.starts_with(text)));
        if let Some(f) = failed.filter(|_| !upstream) {
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
    assert!(
        m.players[0].objectives.iter().all(|o| o.state == crate::mission::ObjectiveState::Completed),
        "objectives {:?}",
        harness::objectives(&w)
    );
    assert_eq!(w.winner, Some(0));
}

/// soviet-01 with scripted orders: the Soviet units attack the village
/// (France and Germany) until nothing that must be destroyed is left.
#[test]
fn soviet_01_can_be_won_with_orders() {
    use crate::world::Order;
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

// ---- The scripting API ------------------------------------------------------------

/// Run `src` in allies-01's script context and return its first result as text.
fn lua_in(w: &mut World, src: &str) -> String {
    let r = w.mission_exec(src).unwrap_or_else(|e| panic!("{e}"));
    match r.into_iter().next() {
        Some(v) => v.to_text().unwrap_or_else(|| v.type_name().to_string()),
        None => "nil".into(),
    }
}

#[test]
fn coordinates_and_utils_behave_like_openra() {
    let mut w = start("allies-01", None);
    assert_eq!(lua_in(&mut w, "return tostring(CPos.New(3, 4) + CVec.New(1, -1))"), "4,3");
    assert_eq!(lua_in(&mut w, "local v = CPos.New(5, 5) - CPos.New(2, 1) return v.X * 10 + v.Y"), "34");
    assert_eq!(lua_in(&mut w, "return tostring(WPos.New(1024, 2048, 0) - WPos.New(0, 0, 0))"), "1024,2048,0");
    assert_eq!(lua_in(&mut w, "return WDist.FromCells(3).Length"), "3072");
    assert_eq!(lua_in(&mut w, "return tostring(WDist.New(1536))"), "1c512");
    assert_eq!(lua_in(&mut w, "return tostring(WDist.FromCells(1) < WDist.FromCells(2))"), "true");
    assert_eq!(lua_in(&mut w, "return (CVec.New(2, 3) * 2).Y"), "6");
    assert_eq!(lua_in(&mut w, "return tostring(CPos.New(1, 2) == CPos.New(1, 2))"), "true");
    assert_eq!(lua_in(&mut w, "return Angle.East.Angle"), "768");
    assert_eq!(lua_in(&mut w, "return WVec.New(1024, 0, 0).Facing.Angle"), "768");
    assert_eq!(lua_in(&mut w, "return DateTime.Seconds(3) + DateTime.Minutes(1)"), "1575");
    assert_eq!(lua_in(&mut w, "return Utils.FormatTime(DateTime.Seconds(90))"), "01:30");
    assert_eq!(lua_in(&mut w, "return #Utils.Where({1, 2, 3, 4}, function(x) return x % 2 == 0 end)"), "2");
    assert_eq!(lua_in(&mut w, "return tostring(Utils.Any({1, 2}, function(x) return x > 1 end))"), "true");
    assert_eq!(lua_in(&mut w, "return tostring(Utils.All({1, 2}, function(x) return x > 1 end))"), "false");
    assert_eq!(lua_in(&mut w, "return #Utils.Concat({1}, {2, 3})"), "3");
    assert_eq!(lua_in(&mut w, "return #Utils.Take(2, {1, 2, 3})"), "2");
    assert_eq!(lua_in(&mut w, "return #Utils.ExpandFootprint({CPos.New(5, 5)}, true)"), "9");
    assert_eq!(lua_in(&mut w, "local n = Utils.RandomInteger(3, 4) return n"), "3");
    // allies-01 has no difficulty dropdown (OpenRA: nil); allies-02 has one.
    assert_eq!(lua_in(&mut w, "return tostring(Map.LobbyOption('difficulty'))"), "nil");
    let mut w2 = start("allies-02", Some("hard"));
    assert_eq!(lua_in(&mut w2, "return Map.LobbyOption('difficulty')"), "hard");
    assert_eq!(lua_in(&mut w2, "return Difficulty"), "hard");
    assert_eq!(lua_in(&mut w, "return Map.LobbyOptionOrDefault('nope', 'fallback')"), "fallback");
    assert_eq!(lua_in(&mut w, "return UserInterface.GetFluentMessage('find-einstein')"), "Find Einstein.");
    assert_eq!(lua_in(&mut w, "return UserInterface.GetFluentMessage('unknown-key')"), "unknown-key");
    assert_eq!(lua_in(&mut w, "return Player.GetPlayer('USSR').Faction"), "soviet");
    assert_eq!(lua_in(&mut w, "return tostring(Player.GetPlayer('Greece').IsLocalPlayer)"), "true");
    assert_eq!(lua_in(&mut w, "return tostring(Player.GetPlayer('Nobody'))"), "nil");
    assert_eq!(lua_in(&mut w, "return tostring(Player.GetPlayer('Greece').IsAlliedWith(Player.GetPlayer('England')))"), "true");
    assert_eq!(lua_in(&mut w, "return tostring(Map.NamedActor('Lab').Type)"), "stek");
    assert_eq!(lua_in(&mut w, "return Lab.Location.X .. ',' .. Lab.Location.Y"), "61,60");
    assert_eq!(lua_in(&mut w, "return tostring(Lab.HasProperty('Move'))"), "false");
    assert_eq!(lua_in(&mut w, "return tostring(LabGuard1.HasProperty('Hunt'))"), "true");
    // Errors name what went wrong.
    let e = w.mission_exec("Lab.Move(CPos.New(1, 1))").unwrap_err();
    assert!(e.contains("'Move' is not supported by actor stek"), "{e}");
}

#[test]
fn script_activities_run_in_order_and_triggers_fire() {
    let mut w = start("allies-01", None);
    lua_in(
        &mut w,
        r#"
        Log = ''
        local greece = Player.GetPlayer('Greece')
        local jeep = Actor.Create('jeep', true, { Owner = greece, Location = CPos.New(63, 50) })
        jeep.Move(CPos.New(66, 50))
        jeep.CallFunc(function() Log = Log .. 'arrived@' .. jeep.Location.X .. ' ' end)
        jeep.Wait(10)
        jeep.CallFunc(function() Log = Log .. 'waited ' end)
        Trigger.AfterDelay(5, function() Log = Log .. 'delay5 ' end)
        Trigger.AfterDelay(2, function() Log = Log .. 'delay2 ' end)
        Trigger.OnIdle(jeep, function() IdleSeen = true end)
        Trigger.OnKilled(jeep, function(self, killer) Log = Log .. 'killed ' .. tostring(self.IsDead) .. ' ' end)
        Jeep = jeep
        Footprint = Trigger.OnEnteredFootprint({ CPos.New(65, 50) }, function(a, id)
            Log = Log .. 'footprint ' .. a.Type .. ' '
            Trigger.RemoveFootprintTrigger(id)
        end)
        "#,
    );
    for _ in 0..400 {
        w.step();
    }
    let log = w.mission_global("Log").unwrap();
    assert!(log.starts_with("delay2 delay5 "), "{log}");
    let order: Vec<&str> = log.split(' ').collect();
    let pos = |s: &str| order.iter().position(|x| x.starts_with(s)).unwrap_or_else(|| panic!("{s} missing in {log}"));
    // The engine's move ends on the goal cell or right next to it.
    assert!(pos("footprint") < pos("arrived@6") && pos("arrived@6") < pos("waited"), "{log}");
    assert_eq!(lua_in(&mut w, "return tostring(IdleSeen)"), "true");
    lua_in(&mut w, "Jeep.Kill()");
    w.step();
    let log = w.mission_global("Log").unwrap();
    assert!(log.ends_with("killed true "), "{log}");
    assert!(lua_in(&mut w, "return tostring(Jeep.IsDead) .. ' ' .. Jeep.Type").starts_with("true jeep"));
}

/// A trigger that runs for the blow that killed an actor (OnDamaged runs at
/// the end of the tick, after the death) may still change it, as in OpenRA,
/// where the actor exists until the end of its tick: nothing happens, no error.
#[test]
fn changing_an_actor_killed_this_tick_does_nothing() {
    let mut w = start("allies-01", None);
    lua_in(
        &mut w,
        r#"
        Plant = Actor23
        Trigger.OnDamaged(Plant, function(self)
            self.StartBuildingRepairs()
            self.Sell()
            Repaired = 'yes'
        end)
        "#,
    );
    lua_in(&mut w, "Plant.Kill()");
    w.step();
    assert_eq!(w.mission().unwrap().error, None);
    assert_eq!(lua_in(&mut w, "return tostring(Repaired) .. ' ' .. tostring(Plant.IsDead)"), "yes true");
    // Later the actor is gone for good: changing it is an error again.
    w.step();
    let e = w.mission_exec("Plant.StartBuildingRepairs()").unwrap_err();
    assert!(e.contains("the actor is dead or not in the world"), "{e}");
}

/// allies-03b's Soviet base draws its power from two Advanced Power Plants
/// beyond the map's playable area, as in OpenRA.
#[test]
fn structures_beyond_the_playable_area_still_power_their_owner() {
    let w = start("allies-03b", Some("normal"));
    let ussr = w.mission().unwrap().player_slot("USSR").unwrap();
    let apwr = w.rules.actor_index("apwr").unwrap() as u16;
    assert_eq!(w.offmap.iter().filter(|s| s.owner == ussr && s.ty == apwr).count(), 2);
    let p = &w.players[ussr as usize];
    assert!(p.power_gen >= 400 && p.power_gen >= p.power_use, "{} of {}", p.power_gen, p.power_use);
    assert!(!w.has_no_required_units(ussr));
}

#[test]
fn missions_are_deterministic() {
    for id in ["allies-02", "soviet-03", "allies-05a"] {
        let run = |n: u32| {
            let mut w = start(id, Some("normal"));
            let mut hashes = Vec::new();
            for t in 0..n {
                w.step();
                if t % 100 == 0 {
                    hashes.push(w.state_hash());
                }
            }
            (w, hashes)
        };
        let (a, ha) = run(1200);
        let (_, hb) = run(1200);
        assert_eq!(ha, hb, "{id}: two runs of the same mission differ");
        // A copy of the world mid-game (lockstep peers, saves) goes on identically.
        let mut c1 = a.clone();
        let mut c2 = a;
        for _ in 0..300 {
            c1.step();
            c2.step();
        }
        assert_eq!(c1.state_hash(), c2.state_hash(), "{id}: a cloned world went its own way");
        // The script state is part of the hash.
        let before = c1.state_hash();
        c1.mission_exec("SomeNewGlobal = 42").unwrap();
        assert_ne!(before, c1.state_hash());
    }
}

/// Player maps (uploaded, shared in lobbies, imported .oramap) are map files:
/// the format has no field for scripts, so none can reach the interpreter.
/// Only mission files (the game's own, pinned by hash) run Lua.
#[test]
fn player_maps_cannot_carry_scripts() {
    let map: serde_json::Value = serde_json::from_str(&crate::Game::generated_map(5, 64, 2)).unwrap();
    let ok: serde_json::Value = serde_json::from_str(&crate::Game::validate_map(&map.to_string())).unwrap();
    assert_eq!(ok["ok"], true, "{ok}");
    for (key, value) in [
        ("scripts", serde_json::json!([{ "name": "x.lua", "source": "while true do end" }])),
        ("lua", serde_json::json!("while true do end")),
        ("mission", serde_json::json!({ "id": "allies-01" })),
    ] {
        let mut bad = map.clone();
        bad[key] = value;
        let v: serde_json::Value = serde_json::from_str(&crate::Game::validate_map(&bad.to_string())).unwrap();
        assert_eq!(v["ok"], false, "{key}: {v}");
        assert!(v["errors"][0].as_str().unwrap().contains("unknown field"), "{key}: {v}");
    }
}

/// Every run of a mission script has its instruction budget: a script that
/// never ends stops with an error no pcall can catch, and the game goes on.
#[test]
fn a_script_that_never_ends_is_stopped() {
    let mut w = start("allies-01", None);
    let e = w.mission_exec("pcall(function() while true do end end) Survived = true").unwrap_err();
    assert!(e.contains("budget") || e.contains("instructions"), "{e}");
    assert_eq!(w.mission_global("Survived"), None);
    let e = w.mission_exec("local function f() return f() + 1 end f()").unwrap_err();
    assert!(e.contains("stack overflow") || e.contains("depth"), "{e}");
    let e = w.mission_exec("local t = {} for i = 1, 1e9 do t[i] = string.rep('x', 1000) end").unwrap_err();
    assert!(!e.is_empty());
    let hash = w.state_hash();
    w.step();
    assert_ne!(w.state_hash(), hash, "the game goes on");
}

/// Co-op missions online: two people take Allies1 and Allies2; each client
/// runs the scripts with its own local player (camera, objective messages)
/// and still computes the same game and the same state hash.
#[test]
fn coop_missions_agree_between_their_players() {
    for id in ["evacuation", "exodus", "infiltration"] {
        let world = |local: u8| {
            let opts = MissionOptions {
                options: [("difficulty".to_string(), "normal".to_string())].into(),
                humans: vec!["Allies1".into(), "Allies2".into()],
                local_player: local,
                ..Default::default()
            };
            World::from_mission(load(id), 11, &opts).unwrap_or_else(|e| panic!("{id}: {e}"))
        };
        let (mut a, mut b) = (world(0), world(1));
        {
            let m = a.mission().unwrap();
            assert_eq!(m.humans, 2);
            assert_eq!((m.players[0].name.as_str(), m.players[1].name.as_str()), ("Allies1", "Allies2"));
            assert!(m.players[0].playable && m.players[1].playable && !m.players[0].bot && !m.players[1].bot);
        }
        assert_eq!(lua_in(&mut a, "return tostring(Allies1.IsLocalPlayer) .. tostring(Allies2.IsLocalPlayer)"), "truefalse");
        assert_eq!(lua_in(&mut b, "return tostring(Allies1.IsLocalPlayer) .. tostring(Allies2.IsLocalPlayer)"), "falsetrue");
        // To the end of the mission (nobody gives orders, so the Soviets win
        // sooner or later), or half an hour of game time.
        let horizon = std::env::var("WEBRA_COOP_TICKS").ok().and_then(|v| v.parse().ok()).unwrap_or(25 * 60 * 30);
        let mut t = 0;
        while t < horizon && !(a.game_over && b.game_over) {
            a.step();
            b.step();
            t += 1;
            assert_eq!(a.state_hash(), b.state_hash(), "{id} differs at tick {t}");
            assert_eq!(a.game_over, b.game_over, "{id}: the game ends at the same tick");
        }
        assert_eq!(error_of(&a), None, "{id}");
        assert_eq!(error_of(&b), None, "{id}");
        eprintln!("{id}: {t} ticks, game over: {}, winner: {:?}", a.game_over, a.winner);
    }
    // Names that are not playable, or taken twice, are refused.
    let bad = |humans: Vec<&str>, local: u8| {
        let opts = MissionOptions { humans: humans.into_iter().map(String::from).collect(), local_player: local, ..Default::default() };
        World::from_mission(load("evacuation"), 1, &opts).err().unwrap_or_default()
    };
    assert!(bad(vec!["Soviets"], 0).contains("not a playable player"));
    assert!(bad(vec!["Allies1", "Allies1"], 0).contains("taken twice"));
    assert!(bad(vec!["Allies1"], 1).contains("local player"));
}

/// Host round trips (`Utils.Do` calling back into Lua) nest the mission API's
/// frames between the interpreter's: they take HOST_LEVELS levels each, which
/// must keep MAX_LEVELS inside the interpreter's stack bound, and unbounded
/// round trips end in a "stack overflow" error within the native test stack.
#[test]
fn host_round_trips_fit_the_native_stack() {
    let measure = start("allies-01", None);
    let h = std::thread::Builder::new()
        .stack_size(64 << 20)
        .spawn(move || {
            let mut w = measure;
            let m = crate::stack_check::measure_mission(&mut w, crate::stack_check::HOST_CASE).unwrap();
            crate::lua::tests::assert_levels_fit("host round trips", m);
        })
        .unwrap();
    h.join().unwrap();
    let deep = start("allies-01", None);
    let h = std::thread::Builder::new()
        .stack_size(if cfg!(debug_assertions) { 32 << 20 } else { crate::stack_check::NATIVE_TEST_STACK })
        .spawn(move || {
            let mut w = deep;
            for src in crate::stack_check::HOST_OVERFLOW_CASES {
                assert!(crate::stack_check::mission_overflows(&mut w, src), "{src}");
            }
        })
        .unwrap();
    h.join().unwrap();
}

/// Script positions, vectors and distances stay in a range the engine's
/// arithmetic cannot overflow, whatever a script computes (OpenRA's are C#
/// ints; extreme values clamp here instead of wrapping into the map).
#[test]
fn script_positions_never_overflow() {
    let mut w = start("allies-01", None);
    let max = crate::mission::api_limits().0;
    assert_eq!(lua_in(&mut w, "return CPos.New(1e300, -1e300).X"), max.to_string());
    assert_eq!(lua_in(&mut w, "return (CPos.New(2^31, 0) + CVec.New(2^31, 0)).X"), max.to_string());
    assert_eq!(lua_in(&mut w, "return WDist.FromCells(2^31).Length"), crate::mission::api_limits().1.to_string());
    assert_eq!(lua_in(&mut w, "return (WVec.New(-2^31, 0, 0) / -1).X"), crate::mission::api_limits().1.to_string());
    assert_eq!(lua_in(&mut w, "return (-WDist.New(-2^31)).Length"), crate::mission::api_limits().1.to_string());
    // Using them is safe too: an actor ordered far off the map, a huge delay.
    lua_in(&mut w, "local a = Actor.Create('e1', true, { Owner = Player.GetPlayer('Greece'), Location = CPos.New(60, 50) }) a.Move(CPos.New(1e300, 1e300), 2^40)");
    lua_in(&mut w, "Trigger.AfterDelay(1e300, function() end) Reinforcements.Reinforce(Player.GetPlayer('Greece'), { 'e1', 'e1' }, { CPos.New(60, 50) }, 2^40)");
    for _ in 0..50 {
        w.step();
    }
    assert_eq!(error_of(&w), None);
}

/// Actor.Create and Reinforcements.Reinforce with a ship on a shore cell:
/// it appears on the nearest water (World::open_cell_for), never on land.
#[test]
fn script_created_ships_appear_on_water() {
    use crate::map::Terrain;
    // A clear cell on the coast of the first campaign map that has one.
    let shore_of = |w: &World| {
        let m = &w.map;
        (0..m.cells()).map(|i| (i as i32 % m.width, i as i32 / m.width)).find(|&(x, y)| {
            m.terrain[m.idx(x, y)] == Terrain::Clear
                && w.building_at[m.idx(x, y)] == crate::world::NONE
                && [(1, 0), (-1, 0), (0, 1), (0, -1)]
                    .iter()
                    .any(|&(dx, dy)| m.contains(x + dx, y + dy) && m.terrain[m.idx(x + dx, y + dy)] == Terrain::Water)
        })
    };
    let (mut w, shore) = mission_ids()
        .iter()
        .find_map(|id| {
            let w = start(id, None);
            let s = shore_of(&w)?;
            Some((w, s))
        })
        .expect("a mission with a coast");
    let (ox, oy) = w.mission().unwrap().cell_out(shore.0, shore.1);
    lua_in(&mut w, &format!("Actor.Create('pt', true, {{ Owner = Player.GetPlayer('Greece'), Location = CPos.New({ox}, {oy}) }})"));
    lua_in(&mut w, &format!("Reinforcements.Reinforce(Player.GetPlayer('Greece'), {{ 'dd' }}, {{ CPos.New({ox}, {oy}) }})"));
    for _ in 0..5 {
        w.step();
    }
    assert_eq!(error_of(&w), None);
    for id in ["PT", "DD"] {
        let t = w.rules.actor_index(id).unwrap() as u16;
        let ships: Vec<usize> = (0..w.actors.len()).filter(|&i| w.actors[i].alive && w.actors[i].ty == t).collect();
        assert!(!ships.is_empty(), "{id} created");
        for i in ships {
            let ci = w.cell_index(w.actors[i].x, w.actors[i].y);
            assert_eq!(w.map.terrain[ci], Terrain::Water, "{id} on water, not at {shore:?}");
        }
    }
}

/// Players a mission hands to OpenRA's bot play the campaign bot, configured
/// by the mission's own bot modules (soviet-05's GoodGuy builds with its
/// BaseBuilderBotModule@campaign limits once the script grants ai-active).
#[test]
fn mission_bots_play_the_campaign_bot_of_their_rules() {
    let mut w = start("soviet-05", Some("normal"));
    let good = w.mission().unwrap().player_slot("GoodGuy").unwrap();
    let cfg = w.ai[good as usize].cfg.clone();
    assert_eq!(cfg.bot, crate::ai_bots::BotType::Campaign);
    let powr = w.rules.actor_index("powr").unwrap() as u16;
    assert!(cfg.limits.contains(&(powr, 6)), "{:?}", cfg.limits);
    assert!(!w.mission().unwrap().players[good as usize].ai_enabled);
    lua_in(&mut w, "GoodGuy.GrantCondition('ai-active')");
    assert!(w.mission().unwrap().players[good as usize].ai_enabled, "the script's condition switches the bot on");
    assert!(!w.scripted_player(good));
    for _ in 0..25 * 60 {
        w.step();
    }
    assert_eq!(error_of(&w), None);
    // The skirmish AI only runs for players whose bot the script switched on.
    let greece = w.mission().unwrap().player_slot("Greece").unwrap();
    assert!(w.scripted_player(greece));
}

/// OpenRA's Actor.Create adds no SkipMakeAnimsInit: a structure a script
/// creates plays its make animation (build-incomplete), also in WorldLoaded
/// at tick 0, while the map's own structures skip it.
#[test]
fn script_created_structures_are_built_and_map_structures_are_not() {
    let mut w = start("allies-01", None);
    assert_eq!(w.tick, 0);
    let map_structures: Vec<usize> =
        (0..w.actors.len()).filter(|&i| w.actors[i].alive && w.actors[i].kind == crate::rules::Kind::Building).collect();
    assert!(!map_structures.is_empty());
    assert!(map_structures.iter().all(|&i| w.actors[i].make_until == 0 && !w.build_incomplete(i)), "map actors skip the make animation");
    let powr = w.rules.actor_index("powr").unwrap() as u16;
    let before = w.actors.iter().filter(|a| a.alive && a.ty == powr).count();
    // The first spot (in the script's map coordinates) where it fits.
    lua_in(
        &mut w,
        "for y = 30, 90 do for x = 30, 90 do \
           if pcall(Actor.Create, 'powr', true, { Owner = Player.GetPlayer('Greece'), Location = CPos.New(x, y) }) then return end \
         end end",
    );
    let made: Vec<usize> =
        (0..w.actors.len()).filter(|&i| w.actors[i].alive && w.actors[i].ty == powr && !map_structures.contains(&i)).collect();
    assert_eq!((before + 1, made.len()), (w.actors.iter().filter(|a| a.alive && a.ty == powr).count(), 1));
    let p = made[0];
    assert_eq!(w.actors[p].make_until, 13, "created at tick 0: being built through tick 13");
    assert!(w.build_incomplete(p));
}
