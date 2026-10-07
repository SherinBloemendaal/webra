//! Security tests: every peer runs the same simulation on the same orders, so
//! anything that panics one panics all (the release build aborts). Orders come
//! from the network and rules overrides from strangers' maps; neither may ever
//! crash or hang the engine.

use crate::rng::Rng;
use crate::rules::Kind;
use crate::world::{cell_center, Order, World, NONE};

const NASTY: [i32; 14] = [i32::MIN, i32::MIN + 1, -1_000_000, -1025, -1, 0, 1, 7, 63, 1024, 65_535, 1_000_000, i32::MAX - 1, i32::MAX];

fn nasty_int(r: &mut Rng) -> i32 {
    if r.chance(50) {
        NASTY[r.range(0, NASTY.len() as i32) as usize]
    } else {
        r.range(-200, 200 * 1024)
    }
}

/// A busy world: full bases, one of every unit type for both sides, ships on a
/// lake, aircraft in the air, mines on the ground.
fn busy_world() -> World {
    let mut w = World::new(77, 96, &[("germany", false), ("ukraine", false)]);
    for y in 40..56 {
        for x in 40..56 {
            let i = w.map.idx(x, y);
            w.map.terrain[i] = crate::map::Terrain::Water;
            w.map.ore[i] = 0;
        }
    }
    w.pass = crate::flowfield::Passability::new(&w.map);
    w.pass_water = crate::flowfield::Passability::water(&w.map);
    for p in 0..2u8 {
        w.players[p as usize].cash = 1_000_000;
        w.players[p as usize].explored.iter_mut().for_each(|e| *e = 1);
    }
    let types: Vec<u16> = (0..w.rules.actors.len() as u16).collect();
    for (k, &t) in types.iter().enumerate() {
        let kind = w.rules.actors[t as usize].kind;
        if kind == Kind::Building || kind == Kind::Mine {
            continue;
        }
        for p in 0..2u8 {
            let (x, y) =
                if kind == Kind::Ship { (42 + (k as i32 % 12), 42 + p as i32 * 6) } else { (10 + (k as i32 % 30), 25 + p as i32 * 40) };
            w.spawn_unit(t, p, cell_center(x), cell_center(y), 0);
        }
    }
    w
}

fn random_order(w: &World, r: &mut Rng) -> Order {
    let refs: Vec<u32> = (0..w.actors.len()).filter(|&i| w.actors[i].alive).map(|i| w.make_ref(i)).collect();
    let id = |r: &mut Rng| -> u32 {
        match r.range(0, 4) {
            0 => NONE,
            1 => r.next_u64() as u32,
            _ if !refs.is_empty() => refs[r.range(0, refs.len() as i32) as usize],
            _ => 0,
        }
    };
    let ids = |r: &mut Rng| -> Vec<u32> { (0..r.range(0, 8)).map(|_| id(r)).collect() };
    let ty = |r: &mut Rng| -> u16 {
        if r.chance(30) {
            u16::MAX - r.range(0, 3) as u16
        } else {
            r.range(0, w.rules.actors.len() as i32 + 3) as u16
        }
    };
    let player = r.range(0, 2) as u8;
    let keys = ["", "spyplane", "paratroopers", "parabombs", "NukePower", "chronoshift", "IRONCURTAIN", "GpsPower", "x\u{0}y"];
    match r.range(0, 15) {
        0 => Order::Move { player, ids: ids(r), x: nasty_int(r), y: nasty_int(r), attack_move: r.chance(50) },
        1 => Order::Smart { player, ids: ids(r), x: nasty_int(r), y: nasty_int(r) },
        2 => Order::Attack { player, ids: ids(r), target: id(r) },
        3 => Order::Stop { player, ids: ids(r) },
        4 => Order::StartProduction { player, ty: ty(r), count: nasty_int(r) },
        5 => Order::CancelProduction { player, ty: ty(r) },
        6 => Order::Place { player, ty: ty(r), cx: nasty_int(r), cy: nasty_int(r) },
        7 => Order::Rally { player, building: id(r), x: nasty_int(r), y: nasty_int(r) },
        8 => Order::Sell { player, building: id(r) },
        9 => Order::Deploy { player, ids: ids(r) },
        10 => Order::Land { player, ids: ids(r), x: nasty_int(r), y: nasty_int(r) },
        11 => Order::ReturnToBase { player, ids: ids(r) },
        12 => Order::SupportPower {
            player,
            key: keys[r.range(0, keys.len() as i32) as usize].to_string(),
            x: nasty_int(r),
            y: nasty_int(r),
            x2: r.chance(50).then(|| nasty_int(r)),
            y2: r.chance(50).then(|| nasty_int(r)),
        },
        13 => Order::LayMines { player, ids: ids(r), x0: nasty_int(r), y0: nasty_int(r), x1: nasty_int(r), y1: nasty_int(r) },
        _ => Order::Teleport { player, ids: ids(r), x: nasty_int(r), y: nasty_int(r) },
    }
}

#[test]
fn hostile_orders_never_crash_the_engine() {
    let mut w = busy_world();
    let mut r = Rng::new(0xbad);
    let mut sent = 0;
    for _ in 0..1500 {
        for _ in 0..r.range(0, 6) {
            let o = random_order(&w, &mut r);
            // The network path drops unreasonable orders before they reach the world.
            if o.is_reasonable() {
                w.queue_order(o);
                sent += 1;
            }
        }
        w.step();
    }
    assert!(sent > 3000, "fuzzed {sent} orders");
}

#[test]
fn hostile_orders_through_json_never_crash_the_engine() {
    // Raw JSON as a malicious client would send it, through serde like apply_frame.
    let mut w = busy_world();
    let bad = [
        r#"{"o":"place","player":0,"ty":65535,"cx":5,"cy":5}"#,
        r#"{"o":"place","player":0,"ty":0,"cx":2147483647,"cy":-2147483648}"#,
        r#"{"o":"start_production","player":1,"ty":65535,"count":50}"#,
        r#"{"o":"move","player":0,"ids":[4294967295,0,1],"x":-2147483648,"y":2147483647,"attack_move":true}"#,
        r#"{"o":"lay_mines","player":1,"ids":[1],"x0":-2147483648,"y0":-2147483648,"x1":2147483647,"y1":2147483647}"#,
        r#"{"o":"support_power","player":0,"key":"NukePower","x":2147483647,"y":2147483647,"x2":-2147483648,"y2":0}"#,
        r#"{"o":"teleport","player":0,"ids":[1,2,3],"x":-1,"y":-1}"#,
        r#"{"o":"rally","player":1,"building":0,"x":2147483647,"y":2147483647}"#,
    ];
    for json in bad {
        if let Ok(o) = serde_json::from_str::<Order>(json) {
            if o.is_reasonable() {
                w.queue_order(o);
            }
        }
    }
    for _ in 0..200 {
        w.step();
    }
}

#[test]
fn random_valid_rules_overrides_simulate_safely() {
    // Anything validation accepts must be safe to play: pick random fields of
    // random actors and weapons, set them to boundary values, and when the
    // overrides validate, play the game for a while.
    let base: serde_json::Value = serde_json::from_str(crate::rules::RULES_JSON).unwrap();
    let mut r = Rng::new(0x5eed);
    let mut played = 0;
    for _ in 0..400 {
        let mut over = serde_json::Map::new();
        let mut actors = serde_json::Map::new();
        let mut weapons = serde_json::Map::new();
        for _ in 0..6 {
            let list = if r.chance(50) { "actors" } else { "weapons" };
            let key = if list == "actors" { "id" } else { "name" };
            let arr = base[list].as_array().unwrap();
            let entry = &arr[r.range(0, arr.len() as i32) as usize];
            let numeric: Vec<&String> = entry.as_object().unwrap().iter().filter(|(_, v)| v.is_i64()).map(|(k, _)| k).collect();
            if numeric.is_empty() {
                continue;
            }
            let field = numeric[r.range(0, numeric.len() as i32) as usize];
            let value = [0i64, 1, 2, 100, 1024, 100_000, -1][r.range(0, 7) as usize];
            let target = if list == "actors" { &mut actors } else { &mut weapons };
            let id = entry[key].as_str().unwrap().to_string();
            target.entry(id).or_insert_with(|| serde_json::json!({}))[field] = serde_json::json!(value);
        }
        over.insert("actors".into(), serde_json::Value::Object(actors));
        over.insert("weapons".into(), serde_json::Value::Object(weapons));
        let over = serde_json::Value::Object(over);
        if crate::rules::Rules::load_with(Some(&over)).is_err() {
            continue;
        }
        let m = crate::map::Map::generate_for(64, 64, 3, 12, 2);
        let mut d = crate::mapdata::MapData::from_map(&m, "Fuzz", "Fuzz", "");
        d.rules = Some(over);
        let players = [("russia", true), ("england", true)]
            .map(|(f, ai)| crate::world::PlayerSetup::new(f, ai.then_some(crate::world::AiDifficulty::Hard)));
        let o = crate::world::GameOptions { starting_cash: 50_000, ..Default::default() };
        let Ok(mut w) = World::from_map(&d, 1, &players, o) else { continue };
        for _ in 0..1500 {
            w.step();
        }
        played += 1;
    }
    assert!(played >= 40, "played {played} modded games");
}
