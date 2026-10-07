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

// ---- Nested rules overrides (follow-up review N2, N3) ------------------------------

fn base_rules() -> serde_json::Value {
    serde_json::from_str(crate::rules::RULES_JSON).unwrap()
}

/// The smallest override that turns `base` into `changed`: objects are merged
/// key by key, everything else (numbers, strings, arrays) is replaced whole.
fn diff(base: &serde_json::Value, changed: &serde_json::Value) -> Option<serde_json::Value> {
    match (base, changed) {
        (serde_json::Value::Object(b), serde_json::Value::Object(c)) => {
            let mut out = serde_json::Map::new();
            for (k, v) in c {
                if let Some(d) = b.get(k).and_then(|bv| diff(bv, v)) {
                    out.insert(k.clone(), d);
                }
            }
            (!out.is_empty()).then_some(serde_json::Value::Object(out))
        }
        _ => (base != changed).then(|| changed.clone()),
    }
}

/// Rules with one built-in actor or weapon edited by `edit`, as a map would override them.
fn load_edited(section: &str, id: &str, edit: impl FnOnce(&mut serde_json::Value)) -> Result<crate::rules::Rules, String> {
    let key = if section == "actors" { "id" } else { "name" };
    let base = base_rules();
    let entry = base[section].as_array().unwrap().iter().find(|e| e[key] == id).unwrap_or_else(|| panic!("{id}")).clone();
    let mut changed = entry.clone();
    edit(&mut changed);
    let patch = diff(&entry, &changed).expect("the edit changes something");
    crate::rules::Rules::load_with(Some(&serde_json::json!({ section: { id: patch } })))
}

/// First actor id whose JSON satisfies `pred`.
fn actor_with(pred: impl Fn(&serde_json::Value) -> bool) -> String {
    base_rules()["actors"].as_array().unwrap().iter().find(|a| pred(a)).unwrap()["id"].as_str().unwrap().to_string()
}

/// A named edit of one rules entry, for table-driven tests.
type Edit<'a> = Box<dyn Fn(&mut serde_json::Value) + 'a>;

fn has_power(a: &serde_json::Value, kind: &str) -> bool {
    a["abilities"]["support_powers"].as_array().is_some_and(|l| l.iter().any(|p| p["kind"] == kind))
}

fn edit_power(a: &mut serde_json::Value, kind: &str, f: impl Fn(&mut serde_json::Value)) {
    for p in a["abilities"]["support_powers"].as_array_mut().unwrap() {
        if p["kind"] == kind {
            f(p);
        }
    }
}

#[test]
fn nested_rules_references_and_sizes_are_validated() {
    let bad_weapon = serde_json::json!(9999);
    let silo = actor_with(|a| has_power(a, "NukePower"));
    let badger = actor_with(|a| has_power(a, "ParatroopersPower"));
    let mad = actor_with(|a| !a["abilities"]["mad_tank"].is_null());
    let mcv = actor_with(|a| !a["abilities"]["transforms"].is_null() && a["kind"] == "vehicle");
    let gap = actor_with(|a| !a["abilities"]["creates_shroud"].is_null());
    let sighted = actor_with(|a| !a["abilities"]["gap_sight"].is_null());
    let plane = actor_with(|a| !a["unit"]["aircraft"]["crash_weapon"].is_null());
    let minelayer = actor_with(|a| !a["abilities"]["minelayer"].is_null());
    let cases: Vec<(&str, String, Edit)> = vec![
        // Indices into the weapon table (combat.rs impact via abilities.rs fire_nuke and tick_nukes).
        ("missile_weapon", silo.clone(), Box::new(|a| edit_power(a, "NukePower", |p| p["missile_weapon"] = bad_weapon.clone()))),
        ("thump_weapon", mad.clone(), Box::new(|a| a["abilities"]["mad_tank"]["thump_weapon"] = bad_weapon.clone())),
        ("detonation_weapon", mad.clone(), Box::new(|a| a["abilities"]["mad_tank"]["detonation_weapon"] = bad_weapon.clone())),
        ("crash_weapon", plane.clone(), Box::new(|a| a["unit"]["aircraft"]["crash_weapon"] = bad_weapon.clone())),
        // Fixed shapes (production.rs deploy_target reads offset[0] and offset[1]).
        ("transforms.offset", mcv.clone(), Box::new(|a| a["abilities"]["transforms"]["offset"] = serde_json::json!([1]))),
        ("transforms.offset", mcv.clone(), Box::new(|a| a["abilities"]["transforms"]["offset"] = serde_json::json!([]))),
        // Vision circles allocate (2r)^2 cells; negative radii loop forever.
        ("creates_shroud.range", gap.clone(), Box::new(|a| a["abilities"]["creates_shroud"]["range"] = serde_json::json!(2_000_000_000))),
        ("creates_shroud.range", gap.clone(), Box::new(|a| a["abilities"]["creates_shroud"]["range"] = serde_json::json!(-5000))),
        ("gap_sight.range", sighted.clone(), Box::new(|a| a["abilities"]["gap_sight"]["range"] = serde_json::json!(2_000_000_000))),
        // Squads spawn one plane per member (plane.rs launch_air_power).
        (
            "squad_size",
            badger.clone(),
            Box::new(|a| edit_power(a, "ParatroopersPower", |p| p["squad_size"] = serde_json::json!(1_000_000))),
        ),
        ("squad_size", badger.clone(), Box::new(|a| edit_power(a, "ParatroopersPower", |p| p["squad_size"] = serde_json::json!(0)))),
        // Spawned actors must be of a kind that can be spawned there.
        ("drop_items", badger.clone(), Box::new(|a| edit_power(a, "ParatroopersPower", |p| p["drop_items"] = serde_json::json!(["FACT"])))),
        ("unit_type", badger.clone(), Box::new(|a| edit_power(a, "ParatroopersPower", |p| p["unit_type"] = serde_json::json!("E1")))),
        ("driver", mad.clone(), Box::new(|a| a["abilities"]["mad_tank"]["driver"] = serde_json::json!("POWR"))),
        ("mine", minelayer.clone(), Box::new(|a| a["abilities"]["minelayer"]["mine"] = serde_json::json!("E1"))),
        ("transforms.into", mcv.clone(), Box::new(|a| a["abilities"]["transforms"]["into"] = serde_json::json!("MINV"))),
        // Counts that size render loops.
        ("ammo", minelayer.clone(), Box::new(|a| a["abilities"]["minelayer"]["ammo"] = serde_json::json!(2_000_000_000))),
        ("ammo_pips", plane.clone(), Box::new(|a| a["unit"]["aircraft"]["ammo_pips"] = serde_json::json!(2_000_000_000))),
        // Entries inside replaced arrays cannot change kind.
        ("kind", silo.clone(), Box::new(|a| edit_power(a, "NukePower", |p| p["kind"] = serde_json::json!("GpsPower")))),
    ];
    for (what, id, edit) in cases {
        let r = load_edited("actors", &id, |a| edit(a));
        assert!(r.is_err(), "{what} of {id} was accepted");
    }
    // Weapons: warhead lists are bounded and their kinds fixed; blast scans stay small.
    assert!(load_edited("weapons", "25mm", |w| w["warheads"][0]["kind"] = serde_json::json!("percent")).is_err());
    assert!(load_edited("weapons", "25mm", |w| {
        let h = w["warheads"][0].clone();
        w["warheads"] = serde_json::Value::Array(vec![h; 40]);
    })
    .is_err());
    assert!(load_edited("weapons", "25mm", |w| {
        w["warheads"][0]["spread"] = serde_json::json!(32 * 1024);
        w["warheads"][0]["falloff"] = serde_json::json!(vec![100; 64]);
    })
    .is_err());
    // Tuning inside an array that keeps every kind is still allowed.
    let tuned = load_edited("weapons", "25mm", |w| w["warheads"][0]["damage"] = serde_json::json!(77)).unwrap();
    assert_eq!(tuned.weapons[tuned.weapons.iter().position(|w| w.name == "25mm").unwrap()].warheads[0].damage, 77);
    let quick = load_edited("actors", &silo, |a| edit_power(a, "NukePower", |p| p["charge"] = serde_json::json!(10))).unwrap();
    assert!(quick.actors.iter().flat_map(|a| a.abilities.support_powers.iter().flatten()).any(|p| p.charge == 10));
}

#[test]
fn malformed_rules_shapes_are_errors_not_panics() {
    // N3: Rules::from_raw used to index and expect on these shapes before validation ran.
    let refinery = actor_with(|a| !a["building"]["refinery"].is_null());
    let factory = actor_with(|a| a["building"]["exits"].as_array().is_some_and(|e| !e.is_empty()));
    let turret = actor_with(|a| a["turret_offsets"].as_array().is_some_and(|t| !t.is_empty()));
    let cases: Vec<(&str, String, Edit)> = vec![
        ("footprint character", "POWR".into(), Box::new(|a| a["building"]["footprint"][0] = serde_json::json!("x?"))),
        ("footprint rows", "POWR".into(), Box::new(|a| a["building"]["footprint"] = serde_json::json!(["xxxxxx"]))),
        ("exits", factory, Box::new(|a| a["building"]["exits"] = serde_json::json!([[]]))),
        ("dock_offset", refinery.clone(), Box::new(|a| a["building"]["refinery"]["dock_offset"] = serde_json::json!([1]))),
        ("free_actor", refinery.clone(), Box::new(|a| a["building"]["refinery"]["free_actor"] = serde_json::json!("NOPE"))),
        ("free_actor_offset", refinery.clone(), Box::new(|a| a["building"]["refinery"]["free_actor_offset"] = serde_json::json!([]))),
        ("center_offset", "POWR".into(), Box::new(|a| a["building"]["center_offset"] = serde_json::json!([]))),
        ("turret_offsets", turret, Box::new(|a| a["turret_offsets"] = serde_json::json!([[5]]))),
    ];
    for (what, id, edit) in cases {
        let r = load_edited("actors", &id, |a| edit(a));
        assert!(r.is_err(), "{what} of {id} was accepted");
    }
}

/// Keys left out of the sweep: identity fields of an entry (the merge refuses
/// them) and free text or token lists (`provides`, `prerequisites`), which
/// only ever feed string comparisons.
fn skipped(key: &str, top: bool) -> bool {
    (top && matches!(key, "id" | "name" | "kind" | "queue")) || matches!(key, "description" | "provides" | "prerequisites")
}

/// Every slot an override can reach in a rules entry: numbers, strings,
/// booleans and arrays at any depth (nulls cannot be overridden).
fn count_slots(v: &serde_json::Value, top: bool) -> usize {
    match v {
        serde_json::Value::Object(o) => o.iter().filter(|(k, _)| !skipped(k, top)).map(|(_, x)| count_slots(x, false)).sum(),
        serde_json::Value::Array(a) => 1 + a.iter().map(|x| count_slots(x, false)).sum::<usize>(),
        serde_json::Value::Null => 0,
        _ => 1,
    }
}

/// Break slot number `k` (in `count_slots` order) of `v`: numbers become huge
/// (`big`) or negative / zero, arrays are emptied, cut, grown or get a
/// misshapen element, strings name unknown or wrong-kind actors, booleans flip.
/// Returns true once done.
fn mutate_slot(v: &mut serde_json::Value, k: &mut usize, top: bool, big: bool, r: &mut Rng, ids: &[String]) -> bool {
    use serde_json::{json, Value};
    const BIG: [i64; 6] = [51, 100, 4096, 1_000_000, 50_000_000, i32::MAX as i64];
    const LOW: [i64; 5] = [i32::MIN as i64, -5000, -2, -1, 0];
    let number = |r: &mut Rng| if big { BIG[r.range(0, BIG.len() as i32) as usize] } else { LOW[r.range(0, LOW.len() as i32) as usize] };
    match v {
        Value::Object(o) => {
            for (key, x) in o.iter_mut() {
                if !skipped(key, top) && mutate_slot(x, k, false, big, r, ids) {
                    return true;
                }
            }
            false
        }
        Value::Array(a) => {
            if *k == 0 {
                match r.range(0, 5) {
                    0 => a.clear(),
                    1 => a.truncate(1),
                    2 if !a.is_empty() => {
                        let last = a[a.len() - 1].clone();
                        a.extend(std::iter::repeat_n(last, 40));
                    }
                    3 if !a.is_empty() => {
                        let i = r.range(0, a.len() as i32) as usize;
                        a[i] = if a[i].is_array() { json!([]) } else { json!(number(r)) };
                    }
                    _ => a.push(json!(number(r))),
                }
                return true;
            }
            *k -= 1;
            a.iter_mut().any(|x| mutate_slot(x, k, false, big, r, ids))
        }
        Value::Null => false,
        _ if *k > 0 => {
            *k -= 1;
            false
        }
        Value::Number(_) => {
            *v = json!(number(r));
            true
        }
        Value::String(_) => {
            const ODD: [&str; 6] = ["", "NOPE", "x?_", "xxxxxxxxxxxxxxxxxxxxxxxxx", "FACT", "MINV"];
            *v = if big { json!(ODD[r.range(0, ODD.len() as i32) as usize]) } else { json!(ids[r.range(0, ids.len() as i32) as usize]) };
            true
        }
        Value::Bool(b) => {
            *b = !*b;
            true
        }
    }
}

/// Play a modded game that touches every rules path: one of every actor for
/// both sides, every support power fired as soon as it exists, every unit
/// deployed, teleported and mining, then everything killed (death weapons,
/// crashing planes, passengers).
fn exercise(over: &serde_json::Value, seed: u64) {
    let m = crate::map::Map::generate_for(64, 64, seed, 12, 2);
    let mut d = crate::mapdata::MapData::from_map(&m, "Fuzz", "Fuzz", "");
    d.rules = Some(over.clone());
    let players = [("russia", true), ("england", true)]
        .map(|(f, ai)| crate::world::PlayerSetup::new(f, ai.then_some(crate::world::AiDifficulty::Hard)));
    let o = crate::world::GameOptions { starting_cash: 50_000, explored: true, redeployable_mcv: true, ..Default::default() };
    let mut w = World::from_map(&d, seed, &players, o).expect("validated rules make a world");
    let n = w.rules.actors.len();
    for t in 0..n {
        for p in 0..2u8 {
            let k = t as i32;
            let (x, y) = (2 + (k % 12) * 5, 2 + (k / 12 % 3) * 5 + p as i32 * 32);
            match w.rules.actors[t].kind {
                Kind::Mine => {}
                Kind::Building => {
                    w.spawn_building(t as u16, p, x, y);
                }
                _ => {
                    w.spawn_unit(t as u16, p, cell_center(x), cell_center(y + 2), 0);
                }
            }
        }
    }
    let enemy = |p: usize| if p == 0 { (cell_center(30), cell_center(48)) } else { (cell_center(30), cell_center(16)) };
    for tick in 0..400 {
        if tick % 50 == 1 {
            for p in 0..2usize {
                for inst in w.powers.players.get_mut(p).into_iter().flatten() {
                    inst.remaining = 0;
                }
                let keys: Vec<String> = w.power_instances(p as u8).iter().map(|i| i.key.clone()).collect();
                let (ex, ey) = enemy(p);
                let (ox, oy) = enemy(1 - p);
                for key in keys {
                    w.queue_order(Order::SupportPower { player: p as u8, key, x: ex, y: ey, x2: Some(ox), y2: Some(oy) });
                }
            }
        }
        if tick == 5 || tick == 120 {
            for i in 0..w.actors.len() {
                let a = &w.actors[i];
                if !a.alive || a.kind == Kind::Building || a.kind == Kind::Mine {
                    continue;
                }
                let (player, ids) = (a.owner, vec![w.make_ref(i)]);
                let (ex, ey) = enemy(player as usize);
                w.queue_order(Order::Deploy { player, ids: ids.clone() });
                w.queue_order(Order::Teleport { player, ids: ids.clone(), x: ex, y: ey });
                w.queue_order(Order::LayMines { player, ids, x0: ex - 2048, y0: ey - 2048, x1: ex + 2048, y1: ey + 2048 });
            }
        }
        if tick == 300 {
            for i in 0..w.actors.len() {
                if w.actors[i].alive {
                    w.kill(i);
                }
            }
        }
        w.step();
    }
}

#[test]
fn nested_rules_overrides_are_rejected_or_safe() {
    // Like the top-level fuzz above, but systematic and at any depth: every
    // slot of every built-in actor and weapon (abilities, support powers,
    // aircraft, transforms, offsets, footprints, warheads...) is broken twice,
    // once with huge values and once with negative or zero ones, arrays are
    // emptied, cut, grown or misshapen. Each edit must be rejected, or survive
    // a game that exercises every rules path. Accepted edits share games, one
    // edit per actor or weapon per game.
    let base = base_rules();
    let ids: Vec<String> = base["actors"].as_array().unwrap().iter().map(|a| a["id"].as_str().unwrap().to_string()).collect();
    let mut r = Rng::new(0x0dd5);
    let (mut accepted, mut rejected) = (Vec::new(), 0);
    for (section, key) in [("actors", "id"), ("weapons", "name")] {
        for entry in base[section].as_array().unwrap() {
            let id = entry[key].as_str().unwrap();
            for k in 0..count_slots(entry, true) {
                for big in [true, false] {
                    let mut changed = entry.clone();
                    mutate_slot(&mut changed, &mut k.clone(), true, big, &mut r, &ids);
                    let Some(patch) = diff(entry, &changed) else { continue };
                    let over = serde_json::json!({ section: { id: patch.clone() } });
                    match crate::rules::Rules::load_with(Some(&over)) {
                        Ok(_) => accepted.push((section, id.to_string(), patch)),
                        Err(_) => rejected += 1,
                    }
                }
            }
        }
    }
    let mut games = 0u64;
    while !accepted.is_empty() {
        let mut batch = serde_json::json!({});
        let mut rest = Vec::new();
        for (section, id, patch) in accepted.drain(..) {
            if batch[section].get(&id).is_some() || batch[section].as_object().is_some_and(|o| o.len() >= 30) {
                rest.push((section, id, patch));
            } else {
                batch[section][&id] = patch;
            }
        }
        accepted = rest;
        // Edits that are fine alone but not together are played one by one.
        if crate::rules::Rules::load_with(Some(&batch)).is_ok() {
            exercise(&batch, games);
            games += 1;
        } else {
            for (section, list) in batch.as_object().unwrap() {
                for (id, patch) in list.as_object().unwrap() {
                    let one = serde_json::json!({ section: { id: patch.clone() } });
                    exercise(&one, games);
                    games += 1;
                }
            }
        }
    }
    assert!(games >= 40 && rejected >= 1000, "{games} games, {rejected} edits rejected");
}
