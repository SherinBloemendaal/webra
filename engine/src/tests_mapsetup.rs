//! Map format version 2 (mapdata.rs): the game setup a map carries (slots,
//! options and their locks, tags) and the state of pre-placed actors
//! (health, stance, veterancy, passengers), their checks, their canonical
//! form and how a game on the map starts with them.

use crate::map::{Map, Terrain};
use crate::mapdata::{MapActor, MapData, MapSlot, FORMAT_VERSION};
use crate::rules::Stance;
use crate::world::{GameOptions, PlayerSetup, World};

fn data(actors: Vec<MapActor>) -> MapData {
    let mut m = Map::filled(48, 48, Terrain::Clear);
    m.spawns = vec![(4, 4), (40, 40)];
    let mut d = MapData::from_map(&m, "Setup", "Test", "");
    d.actors = actors;
    d
}

fn errors(d: &MapData) -> Vec<String> {
    d.validate().errors
}

fn has(errors: &[String], needle: &str) -> bool {
    errors.iter().any(|e| e.contains(needle))
}

fn opts() -> GameOptions {
    GameOptions { starting_units: crate::world::StartingUnits::Base, ..GameOptions::default() }
}

fn players() -> [PlayerSetup; 2] {
    [PlayerSetup::new("england", None), PlayerSetup::new("russia", None)]
}

fn with(a: MapActor, f: impl FnOnce(&mut MapActor)) -> MapActor {
    let mut a = a;
    f(&mut a);
    a
}

#[test]
fn the_canonical_form_carries_the_setup_and_round_trips() {
    assert_eq!(FORMAT_VERSION, 2);
    let mut d = data(vec![with(MapActor::new("1TNK", 0, 10, 10, 256), |a| {
        a.health = 40;
        a.stance = Some("hold_fire".into());
        a.veterancy = 2;
    })]);
    d.players =
        vec![MapSlot { faction: "russia".into(), team: 2, color: 3, lock: vec!["faction".into(), "color".into()], ..MapSlot::default() }];
    d.options.insert("startingCash".into(), serde_json::json!(10000));
    d.options.insert("fog".into(), serde_json::json!(false));
    d.locked_options = vec!["startingCash".into()];
    d.tags = vec!["2 players".into(), "naval".into()];
    let v = d.validate();
    assert!(v.ok, "{:?}", v.errors);
    let text = d.canonical_json();
    assert!(text.starts_with(r#"{"formatVersion":2,"format":"#), "{}", &text[..40]);
    assert!(
        text.ends_with(
            r#""rules":null,"players":[{"faction":"russia","team":2,"color":3,"type":"open","difficulty":"normal","bot":"normal","lock":["faction","color"]}],"options":{"fog":false,"startingCash":10000},"lockedOptions":["startingCash"],"tags":["2 players","naval"]}"#
        ),
        "{text}"
    );
    assert!(text.contains(r#"{"type":"1TNK","owner":0,"x":10,"y":10,"facing":256,"health":40,"stance":"hold_fire","veterancy":2}"#));
    let again = MapData::parse(&text).unwrap();
    assert_eq!(again.canonical_json(), text);
    // Defaults are left out of an actor and filled into a slot.
    let plain = MapData::parse(&text.replace(r#","health":40,"stance":"hold_fire","veterancy":2"#, "")).unwrap();
    assert!(plain.canonical_json().contains(r#""facing":256}"#));
    let short = MapData::parse(&text.replace(r#""type":"open","difficulty":"normal","bot":"normal","#, "")).unwrap();
    assert_eq!(short.canonical_json(), text);
}

#[test]
fn slots_options_locks_and_tags_are_checked() {
    let mut d = data(vec![]);
    d.players = vec![
        MapSlot { faction: "martians".into(), color: 2, ..MapSlot::default() },
        MapSlot { team: 9, color: 2, ty: "robot".into(), lock: vec!["color".into(), "color".into()], ..MapSlot::default() },
        MapSlot::default(),
    ];
    d.options.insert("startingCash".into(), serde_json::json!(1234));
    d.options.insert("seed".into(), serde_json::json!(5));
    d.options.insert("fog".into(), serde_json::json!("false"));
    d.locked_options = vec!["techLevel".into()];
    d.tags = vec!["Naval".into(), "ok".into(), "ok".into()];
    let e = errors(&d);
    for needle in [
        "players lists 3 slots; the map has 2 spawns",
        "players[0].faction is unknown",
        "players[1].team must be 0 to 4",
        "two slots have the same colour",
        "players[1].type must be open, ai or closed",
        "players[1].lock must list",
        "options.startingCash must be one of",
        "options: seed is not an option a map can set",
        "options.fog must be one of",
        "lockedOptions[0] must name an option",
        "tags[0] must be",
        "tags[2] must be",
    ] {
        assert!(has(&e, needle), "{needle}: {e:?}");
    }
    let mut closed = data(vec![]);
    closed.players = vec![MapSlot { ty: "closed".into(), lock: vec!["type".into()], ..MapSlot::default() }];
    assert!(has(&errors(&closed), "at least two slots that can play"));
    let mut color = data(vec![]);
    color.players = vec![MapSlot { lock: vec!["color".into()], ..MapSlot::default() }];
    assert!(has(&errors(&color), "a locked colour needs a colour"));
}

#[test]
fn actor_state_is_checked_against_the_rules() {
    let d = data(vec![
        with(MapActor::new("1TNK", 0, 10, 10, 0), |a| a.health = 0),
        with(MapActor::new("1TNK", 0, 12, 10, 0), |a| a.stance = Some("berserk".into())),
        with(MapActor::new("DTRK", 0, 14, 10, 0), |a| a.stance = Some("defend".into())),
        with(MapActor::new("1TNK", 0, 16, 10, 0), |a| a.veterancy = 5),
        with(MapActor::new("1TNK", 0, 18, 10, 0), |a| a.cargo = vec!["E1".into()]),
        with(MapActor::new("JEEP", 0, 20, 10, 0), |a| a.cargo = vec!["E1".into(), "E1".into()]),
        with(MapActor::new("APC", 0, 22, 10, 0), |a| a.cargo = vec!["1TNK".into()]),
        with(MapActor::new("PBOX", 0, 24, 20, 0), |a| a.cargo = vec!["E1".into()]),
    ]);
    let e = errors(&d);
    for needle in [
        "health must be 1 to 100",
        "stance must be hold_fire",
        "DTRK has no fire stance",
        "veterancy must be 0 to 4",
        "1TNK carries no passengers",
        "the passengers weigh 2; JEEP carries 1",
        "1TNK cannot ride in APC",
        "PBOX carries no passengers",
    ] {
        assert!(has(&e, needle), "{needle}: {e:?}");
    }
    let ok = data(vec![
        with(MapActor::new("APC", 0, 22, 10, 0), |a| a.cargo = vec!["E1".into(), "E3".into(), "MEDI".into()]),
        with(MapActor::new("POWR", 1, 30, 30, 0), |a| a.health = 25),
        with(MapActor::new("E1", -1, 8, 20, 0), |a| {
            a.veterancy = 4;
            a.stance = Some("defend".into());
        }),
    ]);
    assert!(ok.validate().ok, "{:?}", ok.validate().errors);
}

#[test]
fn a_game_on_the_map_starts_its_actors_as_the_map_says() {
    let d = data(vec![
        with(MapActor::new("1TNK", 0, 10, 12, 0), |a| {
            a.health = 50;
            a.stance = Some("hold_fire".into());
            a.veterancy = 3;
        }),
        with(MapActor::new("APC", 1, 30, 30, 0), |a| a.cargo = vec!["E1".into(), "E1".into(), "E3".into()]),
        with(MapActor::new("POWR", -1, 20, 30, 0), |a| a.health = 10),
    ]);
    assert!(d.validate().ok, "{:?}", d.validate().errors);
    let w = World::from_map(&d, 1, &players(), opts()).expect("world");
    let find = |id: &str| {
        let t = w.rules.actor_index(id).unwrap() as u16;
        (0..w.actors.len()).find(|&i| w.actors[i].alive && w.actors[i].ty == t).unwrap_or_else(|| panic!("no {id}"))
    };
    let tank = find("1TNK");
    assert_eq!(w.actors[tank].hp, w.rules.actors[w.actors[tank].ty as usize].hp / 2);
    assert_eq!(w.actors[tank].stance, Stance::HoldFire);
    assert_eq!(w.rank(tank), 3);
    let apc = find("APC");
    let inside: Vec<String> = w.passengers(apc).iter().map(|&p| w.rules.actors[w.actors[p].ty as usize].id.clone()).collect();
    assert_eq!(inside, ["E1", "E1", "E3"]);
    assert!(w.passengers(apc).iter().all(|&p| w.actors[p].owner == 1 && !w.actors[p].in_world()));
    let powr = find("POWR");
    assert_eq!(w.actors[powr].hp, w.rules.actors[w.actors[powr].ty as usize].hp / 10);
    // The same map gives the same world, byte for byte.
    let again = World::from_map(&d, 1, &players(), opts()).expect("world");
    assert_eq!(w.state_hash(), again.state_hash());
}

#[test]
fn games_that_break_the_maps_locked_options_are_refused() {
    let mut d = data(vec![]);
    d.options.insert("startingCash".into(), serde_json::json!(10000));
    d.options.insert("fog".into(), serde_json::json!(false));
    d.locked_options = vec!["startingCash".into(), "fog".into()];
    assert!(d.validate().ok);
    let json = |cash: i64, fog: bool| {
        format!(
            r#"{{"seed":1,"startingCash":{cash},"fog":{fog},"players":[{{"type":"human","faction":"england"}},{{"type":"ai","faction":"russia","difficulty":"easy"}}]}}"#
        )
    };
    let map = d.canonical_json();
    assert!(crate::Game::from_map(&map, &json(10000, false)).is_ok());
    // Not settable only: an unlocked option the map sets is just where the lobby starts.
    assert!(d.locked_option_problem(&serde_json::from_str(&json(5000, false)).unwrap()).is_some());
    assert!(d.locked_option_problem(&serde_json::from_str(&json(10000, true)).unwrap()).unwrap().contains("fog"));
    assert!(d.locked_option_problem(&serde_json::from_str(&json(10000, false)).unwrap()).is_none());
}

#[test]
fn the_engine_reads_the_protocol_fixture_to_the_same_canonical_form_and_hash() {
    let file = include_str!("../../packages/protocol/test/fixtures/maps/format2-setup.webra-map.json");
    let expected: serde_json::Value =
        serde_json::from_str(include_str!("../../packages/protocol/test/fixtures/maps/format2-setup.expected.json")).unwrap();
    let d = MapData::parse(file.trim()).expect("the engine reads format 2");
    let v = d.validate();
    assert!(v.ok, "{:?}", v.errors);
    assert_eq!(d.canonical_json(), expected["canonical"].as_str().unwrap());
    assert_eq!(v.hash.as_deref(), expected["hash"].as_str());
    // Format 1 files are the protocol's to upgrade first.
    let old = include_str!("../../packages/protocol/test/fixtures/maps/format1-file.webra-map.json");
    assert!(MapData::parse(old.trim()).unwrap_err().contains("must be upgraded to format 2"));
}

#[test]
fn a_map_must_be_able_to_start_a_game() {
    let slot = |ty: &str, team: i32, lock: &[&str]| MapSlot {
        ty: ty.into(),
        team,
        lock: lock.iter().map(|l| l.to_string()).collect(),
        ..MapSlot::default()
    };
    let problems = |players: Vec<MapSlot>| {
        let mut d = data(vec![]);
        d.players = players;
        errors(&d)
    };
    // Every slot locked to an AI, or to an AI and closed: nobody can play it.
    let e = problems(vec![slot("ai", 0, &["type"]), slot("ai", 0, &["type"])]);
    assert!(has(&e, "players: a map must leave at least one slot a person can take"), "{e:?}");
    let e = problems(vec![slot("ai", 0, &["type"]), slot("closed", 0, &["type"])]);
    assert!(has(&e, "at least two slots that can play"), "{e:?}");
    // Every playable slot locked to the same team: nobody to fight.
    let e = problems(vec![slot("open", 2, &["team"]), slot("ai", 2, &["team"])]);
    assert!(has(&e, "every slot that can play is locked to team 2: nobody to fight"), "{e:?}");
    // Two open slots locked to one team are one side.
    let e = problems(vec![slot("open", 1, &["team"]), slot("open", 1, &["team"])]);
    assert!(has(&e, "locked to team 1"), "{e:?}");
    // Each of these can start: an unlocked AI slot takes a person, team 0 is
    // free for all, a slot whose team is not locked picks another one.
    for ok in [
        vec![slot("ai", 0, &[]), slot("ai", 0, &["type"])],
        vec![slot("open", 0, &["team"]), slot("open", 0, &["team"])],
        vec![slot("open", 1, &["team"]), slot("open", 1, &[])],
        vec![slot("open", 1, &["team"]), slot("ai", 2, &["team", "type"])],
        vec![slot("ai", 1, &["type", "team"])],
    ] {
        let e = problems(ok.clone());
        assert!(e.is_empty(), "{ok:?}: {e:?}");
    }
}

#[test]
fn null_setup_and_actor_fields_are_refused() {
    let d = data(vec![MapActor::new("1TNK", 0, 10, 10, 0)]);
    let text = d.canonical_json();
    let mut v: serde_json::Value = serde_json::from_str(&text).unwrap();
    v["actors"][0]["stance"] = serde_json::Value::Null;
    assert!(MapData::parse(&v.to_string()).is_err(), "a null stance is refused");
    let mut v: serde_json::Value = serde_json::from_str(&text).unwrap();
    v["players"] = serde_json::json!([{ "faction": null }]);
    assert!(MapData::parse(&v.to_string()).is_err(), "a null slot field is refused");
    let mut v: serde_json::Value = serde_json::from_str(&text).unwrap();
    v["actors"][0]["stance"] = serde_json::json!("hold_fire");
    assert!(MapData::parse(&v.to_string()).is_ok(), "a present stance is read");
}

#[test]
fn a_map_full_of_structures_relabels_the_cells_once() {
    // A community map carries hundreds of trees, mines and derricks; the
    // connectivity labels (every cell, three passabilities) are computed
    // once for all of them, not per structure (World::place_map_actors).
    let mut traps = Vec::new();
    for y in (8..40).step_by(2) {
        for x in (8..40).step_by(2) {
            traps.push(MapActor::new("TANKTRAP2", -1, x, y, 0));
        }
    }
    assert_eq!(traps.len(), 256);
    let many = World::from_map(&data(traps), 1, &players(), opts()).expect("world");
    let one = World::from_map(&data(vec![MapActor::new("TANKTRAP2", -1, 20, 20, 0)]), 1, &players(), opts()).expect("world");
    assert_eq!(many.actors.iter().filter(|a| a.alive && a.ty == many.rules.actor_index("TANKTRAP2").unwrap() as u16).count(), 256);
    assert!(many.pass.blocked[many.map.idx(8, 8)] && many.pass.blocked[many.map.idx(38, 38)]);
    for (a, b) in [(&many.pass, &one.pass), (&many.pass_water, &one.pass_water), (&many.pass_landing, &one.pass_landing)] {
        assert_eq!(a.version, b.version, "the same few relabellings whatever the number of map actors");
        assert!(a.version <= 8, "{}", a.version);
    }
    // And the labels are right: the trap cells are blocked, the rest connected.
    let open = many.map.idx(9, 9);
    assert_eq!(many.pass.component[open], many.pass.component[many.map.idx(45, 45)]);
}
