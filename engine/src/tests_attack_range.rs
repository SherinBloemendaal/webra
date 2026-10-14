//! Moving into weapon range (combat.rs `approach_range`, OpenRA
//! MoveWithinRange): a unit out of range heads for the nearest free cell
//! from which its target is in range, not for the target's own cell, so a
//! row of artillery or ships that is told to fire shifts up a few cells
//! instead of driving around its own front units.

use crate::map::{Map, Terrain};
use crate::math::{dist, CELL};
use crate::movement::MovementModel;
use crate::rules::Rules;
use crate::world::{cell_center, Activity, Order, World};

fn ty(w: &World, id: &str) -> u16 {
    w.rules.actor_index(id).unwrap() as u16
}

fn open_map(w: i32, h: i32) -> Map {
    let n = (w * h) as usize;
    Map { width: w, height: h, terrain: vec![Terrain::Clear; n], ore: vec![0; n], gems: vec![0; n], spawns: vec![(1, 1), (w - 3, h - 3)] }
}

/// An open `w` x `h` map with two passive players (0 and 1, enemies) on `model`.
fn arena(model: MovementModel, w: i32, h: i32) -> World {
    let mut world = World::empty(Rules::load(), open_map(w, h), 9);
    world.options.movement = model;
    world.stress = true;
    world.add_player(world.rules.faction_index("allies").unwrap(), false, (1, 1));
    world.add_player(world.rules.faction_index("soviet").unwrap(), false, (w - 3, h - 3));
    world
}

/// Terrain on the given cells, passability rebuilt.
fn paint(w: &mut World, terrain: Terrain, cells: impl IntoIterator<Item = (i32, i32)>) {
    for (x, y) in cells {
        let i = w.map.idx(x, y);
        w.map.terrain[i] = terrain;
    }
    w.reset_passability();
}

fn unit(w: &mut World, id: &str, owner: u8, cx: i32, cy: i32, facing: i32) -> usize {
    let t = ty(w, id);
    w.spawn_unit(t, owner, cell_center(cx), cell_center(cy), facing)
}

fn refs(w: &World, units: &[usize]) -> Vec<u32> {
    units.iter().map(|&u| w.make_ref(u)).collect()
}

fn weapon_range(w: &World, name: &str) -> (i32, i32) {
    let wi = w.rules.weapons.iter().position(|x| x.name == name).unwrap();
    (w.rules.weapons[wi].min_range, w.rules.weapons[wi].range)
}

/// What a run of `ticks` did to each unit: the length of the way it
/// drove, and the first tick it fired (None: never).
struct Trace {
    driven: Vec<i32>,
    first_shot: Vec<Option<u32>>,
}

fn trace(w: &mut World, units: &[usize], ticks: u32) -> Trace {
    let mut driven = vec![0; units.len()];
    let mut first_shot = vec![None; units.len()];
    let mut last: Vec<(i32, i32)> = units.iter().map(|&u| (w.actors[u].x, w.actors[u].y)).collect();
    let reload: Vec<i32> = units.iter().map(|&u| w.actors[u].reload[0]).collect();
    for t in 0..ticks {
        w.step();
        for (k, &u) in units.iter().enumerate() {
            let p = (w.actors[u].x, w.actors[u].y);
            driven[k] += dist(last[k].0, last[k].1, p.0, p.1);
            last[k] = p;
            if first_shot[k].is_none() && w.actors[u].reload[0] > reload[k].max(0) {
                first_shot[k] = Some(t);
            }
        }
    }
    Trace { driven, first_shot }
}

// ---- A column of artillery force-fires on the ground ----------------------------------

/// Seven artillery in a column, the front one exactly at maximum range of
/// the spot they are told to shell: the ones behind only need to come a
/// few cells forward, beside the column.
fn artillery_column(model: MovementModel) {
    let mut w = arena(model, 64, 40);
    let (_, range) = weapon_range(&w, "155mm");
    let cells = range / CELL;
    let (x0, y) = (10, 20);
    let units: Vec<usize> = (0..7).map(|k| unit(&mut w, "ARTY", 0, x0 + k, y, 256)).collect();
    let front = x0 + 6;
    let (tx, ty) = (cell_center(front + cells), cell_center(y));
    w.queue_order(Order::AttackGround { player: 0, ids: refs(&w, &units), x: tx, y: ty });
    let tr = trace(&mut w, &units, 25 * 30);
    for (k, &u) in units.iter().enumerate() {
        // The way forward: from its cell to the column's front, around the
        // units ahead, plus a cell's slack.
        let need = (6 - k as i32).max(0) * CELL;
        let bound = need + 4 * CELL;
        assert!(
            tr.driven[k] <= bound,
            "{model:?}: unit {k} drove {} cells for a {}-cell shift (no detour)",
            tr.driven[k] / CELL,
            need / CELL
        );
        assert!(tr.first_shot[k].is_some(), "{model:?}: unit {k} got in range and fired");
        let d = dist(w.actors[u].x, w.actors[u].y, tx, ty);
        assert!(d <= range, "{model:?}: unit {k} stands in range ({d})");
        assert_eq!(w.actors[u].activity, Activity::AttackGround);
    }
    // The front one was in range already: it does not drive (in the WebRA
    // model the soft crowd separation may nudge it).
    let nudge = if model == MovementModel::WebRA { 2 * CELL } else { 0 };
    assert!(tr.driven[6] <= nudge, "{model:?}: the unit in range stays ({})", tr.driven[6]);
}

#[test]
fn an_artillery_column_shifts_up_into_range_openra() {
    artillery_column(MovementModel::OpenRA);
}

#[test]
fn an_artillery_column_shifts_up_into_range_webra() {
    artillery_column(MovementModel::WebRA);
}

// ---- A line of cruisers along a coast -----------------------------------------------

/// Land on the left (x < `shore`), sea on the right; a power plant of
/// player 1 on land as the target.
fn coast(model: MovementModel, shore: i32) -> World {
    let mut w = arena(model, 64, 40);
    paint(&mut w, Terrain::Water, (shore..64).flat_map(|x| (0..40).map(move |y| (x, y))));
    w
}

/// Five cruisers in a line out to sea, the first on the coast with the
/// target at maximum range: the ones behind sail up to the coast beside it.
fn cruiser_line(model: MovementModel) {
    let shore = 20;
    let mut w = coast(model, shore);
    let (_, range) = weapon_range(&w, "8Inch");
    let cells = range / CELL;
    let y = 20;
    let target = w.spawn_building(ty(&w, "POWR"), 1, shore - cells + 1, y).unwrap();
    // It outlasts the test.
    w.actors[target].hp = 100_000_000;
    w.refresh_tokens();
    w.update_power();
    // See the target the whole time.
    w.players[0].explored.iter_mut().for_each(|e| *e = 1);
    w.add_reveal(0, cell_center(shore - cells), cell_center(y), 8 * CELL, 25 * 600);
    let ships: Vec<usize> = (0..5).map(|k| unit(&mut w, "CA", 0, shore + 2 * k, y, 768)).collect();
    w.update_vision();
    w.step();
    assert!(w.is_visible_to(target, 0));
    let in_range = |w: &World, u: usize| w.hit_distance(target, w.actors[u].x, w.actors[u].y) <= range;
    assert!(in_range(&w, ships[0]), "the first cruiser starts in range");
    assert!(!in_range(&w, ships[4]), "the last one does not");
    w.queue_order(Order::Attack { player: 0, ids: refs(&w, &ships), target: w.make_ref(target) });
    let tr = trace(&mut w, &ships, 25 * 40);
    for (k, &u) in ships.iter().enumerate() {
        let need = w.hit_distance(target, cell_center(shore + 2 * k as i32), cell_center(y)) - range;
        let bound = need.max(0) + 5 * CELL;
        assert!(
            tr.driven[k] <= bound,
            "{model:?}: cruiser {k} sailed {} cells for a {}-cell shift (no detour)",
            tr.driven[k] / CELL,
            need.max(0) / CELL
        );
        assert!(tr.first_shot[k].is_some(), "{model:?}: cruiser {k} got in range and fired");
        assert!(in_range(&w, u) || !w.actors[target].alive, "{model:?}: cruiser {k} in range");
    }
    assert_eq!(tr.driven[0], 0, "{model:?}: the cruiser in range stays");
}

#[test]
fn a_line_of_cruisers_shifts_up_to_the_coast_openra() {
    cruiser_line(MovementModel::OpenRA);
}

#[test]
fn a_line_of_cruisers_shifts_up_to_the_coast_webra() {
    cruiser_line(MovementModel::WebRA);
}

// ---- Across a river with the only ford far away ------------------------------------

/// A river down column `x`, with a ford in row `ford` only.
fn river(w: &mut World, x: i32, ford: i32) {
    let h = w.map.height;
    paint(w, Terrain::Water, (0..h).filter(|&y| y != ford).map(|y| (x, y)));
}

/// Artillery in a column on one bank shells a spot on the other. The spot
/// itself can only be reached over a ford at the far end of the map: the
/// units out of range shift up to the bank instead of heading for the ford.
fn artillery_across_a_river(model: MovementModel) {
    let mut w = arena(model, 64, 40);
    river(&mut w, 30, 1);
    let (_, range) = weapon_range(&w, "155mm");
    let y = 36;
    let units: Vec<usize> = (0..7).map(|k| unit(&mut w, "ARTY", 0, 20 + k, y, 256)).collect();
    let (tx, ty) = (cell_center(26) + range - CELL / 2, cell_center(y));
    w.queue_order(Order::AttackGround { player: 0, ids: refs(&w, &units), x: tx, y: ty });
    let tr = trace(&mut w, &units, 25 * 30);
    for (k, &u) in units.iter().enumerate() {
        let need = (6 - k as i32) * CELL;
        assert!(tr.driven[k] <= need + 4 * CELL, "{model:?}: unit {k} drove {} cells (no trip to the ford)", tr.driven[k] / CELL);
        assert!(tr.first_shot[k].is_some(), "{model:?}: unit {k} fired");
        assert!(w.actors[u].x < cell_center(30), "{model:?}: unit {k} stayed on its bank");
    }
}

#[test]
fn artillery_shifts_up_to_the_bank_instead_of_driving_to_a_far_ford_openra() {
    artillery_across_a_river(MovementModel::OpenRA);
}

#[test]
fn artillery_shifts_up_to_the_bank_instead_of_driving_to_a_far_ford_webra() {
    artillery_across_a_river(MovementModel::WebRA);
}

// ---- Ships beside a peninsula --------------------------------------------------------

/// Sea with a peninsula of land down from the top edge (columns 28 to 33,
/// rows 0 to 30) and an enemy power plant on it, nearer to its east shore.
/// Cruisers in a line west of it: those out of range sail up a few cells on
/// their side, not round the peninsula to the water nearest the target.
fn cruisers_beside_a_peninsula(model: MovementModel) {
    let mut w = arena(model, 64, 40);
    paint(&mut w, Terrain::Water, (0..64).flat_map(|x| (0..40).map(move |y| (x, y))));
    paint(&mut w, Terrain::Clear, (28..34).flat_map(|x| (0..31).map(move |y| (x, y))));
    let (_, range) = weapon_range(&w, "8Inch");
    let target = w.spawn_building(ty(&w, "POWR"), 1, 31, 10).unwrap();
    w.actors[target].hp = 100_000_000;
    w.refresh_tokens();
    w.update_power();
    w.players[0].explored.iter_mut().for_each(|e| *e = 1);
    w.add_reveal(0, cell_center(32), cell_center(11), 6 * CELL, 25 * 600);
    let y = 11;
    let xs: Vec<i32> = (0..5).map(|k| 13 - 2 * k).collect();
    let ships: Vec<usize> = xs.iter().map(|&x| unit(&mut w, "CA", 0, x, y, 256)).collect();
    w.update_vision();
    w.step();
    let in_range = |w: &World, u: usize| w.hit_distance(target, w.actors[u].x, w.actors[u].y) <= range;
    assert!(in_range(&w, ships[0]) && !in_range(&w, ships[4]));
    w.queue_order(Order::Attack { player: 0, ids: refs(&w, &ships), target: w.make_ref(target) });
    let tr = trace(&mut w, &ships, 25 * 40);
    for (k, &u) in ships.iter().enumerate() {
        let need = (w.hit_distance(target, cell_center(xs[k]), cell_center(y)) - range).max(0);
        assert!(
            tr.driven[k] <= need + 5 * CELL,
            "{model:?}: cruiser {k} sailed {} cells for a {}-cell shift",
            tr.driven[k] / CELL,
            need / CELL
        );
        assert!(tr.first_shot[k].is_some(), "{model:?}: cruiser {k} fired");
        assert!(w.actors[u].x < cell_center(28), "{model:?}: cruiser {k} stayed west of the peninsula");
    }
}

#[test]
fn cruisers_shift_up_beside_a_peninsula_instead_of_sailing_round_it_openra() {
    cruisers_beside_a_peninsula(MovementModel::OpenRA);
}

#[test]
fn cruisers_shift_up_beside_a_peninsula_instead_of_sailing_round_it_webra() {
    cruisers_beside_a_peninsula(MovementModel::WebRA);
}

// ---- In range, minimum range, far away -----------------------------------------------

/// A group that has the target in range already does not move at all.
fn in_range_stays(model: MovementModel) {
    let mut w = arena(model, 64, 40);
    let units: Vec<usize> = (0..6).map(|k| unit(&mut w, "2TNK", 0, 20 + k % 3, 18 + k / 3, 256)).collect();
    let foe = unit(&mut w, "2TNK", 1, 24, 19, 768);
    w.actors[foe].hp = 100_000_000;
    w.actors[foe].reload = [1_000_000; crate::world::MAX_WEAPONS];
    w.queue_order(Order::Attack { player: 0, ids: refs(&w, &units), target: w.make_ref(foe) });
    let tr = trace(&mut w, &units, 25 * 4);
    for k in 0..units.len() {
        assert!(tr.first_shot[k].is_some(), "{model:?}: tank {k} fired");
        assert_eq!(tr.driven[k], 0, "{model:?}: tank {k} stayed where it was");
    }
}

#[test]
fn units_in_range_stay_openra() {
    in_range_stays(MovementModel::OpenRA);
}

#[test]
fn units_in_range_stay_webra() {
    in_range_stays(MovementModel::WebRA);
}

/// Artillery told to shell a spot inside its minimum range moves out to a
/// cell from which it is at least that far, a short way, and fires.
fn out_of_minimum_range(model: MovementModel) {
    let mut w = arena(model, 64, 40);
    let (min, range) = weapon_range(&w, "155mm");
    let arty = unit(&mut w, "ARTY", 0, 20, 20, 256);
    // Walls of rock on three sides but the way back (west).
    paint(&mut w, Terrain::Rock, (17..26).flat_map(|x| [(x, 18), (x, 22)]));
    let (tx, ty) = (cell_center(22), cell_center(20));
    w.queue_order(Order::AttackGround { player: 0, ids: refs(&w, &[arty]), x: tx, y: ty });
    let mut fired_inside = false;
    let reload = w.actors[arty].reload[0];
    let mut driven = 0;
    let mut last = (w.actors[arty].x, w.actors[arty].y);
    for _ in 0..25 * 20 {
        w.step();
        let p = (w.actors[arty].x, w.actors[arty].y);
        driven += dist(last.0, last.1, p.0, p.1);
        last = p;
        if w.actors[arty].reload[0] > reload.max(0) && dist(p.0, p.1, tx, ty) < min {
            fired_inside = true;
        }
    }
    let d = dist(w.actors[arty].x, w.actors[arty].y, tx, ty);
    assert!(!fired_inside, "{model:?}: no shot inside minimum range");
    assert!(d >= min && d <= range, "{model:?}: in range, out of minimum range ({d})");
    assert!(w.actors[arty].reload[0] > 0, "{model:?}: it fires");
    assert!(driven <= 6 * CELL, "{model:?}: a short way back ({} cells)", driven / CELL);
}

#[test]
fn artillery_moves_out_of_minimum_range_openra() {
    out_of_minimum_range(MovementModel::OpenRA);
}

#[test]
fn artillery_moves_out_of_minimum_range_webra() {
    out_of_minimum_range(MovementModel::WebRA);
}

/// A spot no cell near the unit is in range of (across a lake whose only
/// way round is long) is still reached, the long way, and shelled.
fn far_target(model: MovementModel) {
    let mut w = arena(model, 64, 40);
    // A lake from column 20 to 45, open only along the bottom two rows.
    paint(&mut w, Terrain::Water, (20..46).flat_map(|x| (0..38).map(move |y| (x, y))));
    let tank = unit(&mut w, "2TNK", 0, 10, 5, 256);
    let (tx, ty) = (cell_center(55), cell_center(5));
    w.queue_order(Order::AttackGround { player: 0, ids: refs(&w, &[tank]), x: tx, y: ty });
    let tr = trace(&mut w, &[tank], 25 * 120);
    assert!(tr.first_shot[0].is_some(), "{model:?}: the tank got round the lake and fired");
    assert_eq!(w.actors[tank].activity, Activity::AttackGround);
}

#[test]
fn a_target_only_reachable_the_long_way_is_still_reached_openra() {
    far_target(MovementModel::OpenRA);
}

#[test]
fn a_target_only_reachable_the_long_way_is_still_reached_webra() {
    far_target(MovementModel::WebRA);
}

// ---- Work with a big army -------------------------------------------------------------

/// Route search work for a big army told to fire at one target out of
/// range: the cells in range are worked out once per tick for all of
/// them, and each unit's search is capped, so no tick blows up.
fn big_army_work(model: MovementModel) -> (u64, u64) {
    let mut w = arena(model, 128, 96);
    let units: Vec<usize> = (0..300).map(|k| unit(&mut w, "ARTY", 0, 10 + k % 20, 30 + k / 20, 256)).collect();
    let (tx, ty) = (cell_center(70), cell_center(37));
    w.queue_order(Order::AttackGround { player: 0, ids: refs(&w, &units), x: tx, y: ty });
    let range = weapon_range(&w, "155mm").1;
    let (mut worst, mut total) = (0, 0);
    for _ in 0..25 * 90 {
        let e0 = w.search.expanded;
        w.step();
        let e = w.search.expanded - e0;
        worst = worst.max(e);
        total += e;
    }
    // The front ranks get in range and stay; the ranks behind file round
    // them (the same pace as with the old chase toward the target's cell).
    let firing = units.iter().filter(|&&u| dist(w.actors[u].x, w.actors[u].y, tx, ty) <= range).count();
    assert!(firing >= 60, "{model:?}: the army gets in range ({firing} of 300)");
    (worst, total)
}

#[test]
fn a_big_army_moving_into_range_keeps_route_searches_bounded() {
    for model in [MovementModel::OpenRA, MovementModel::WebRA] {
        let (worst, total) = big_army_work(model);
        // About 250 cells per unit when all 300 search at once.
        assert!(worst <= 120_000, "{model:?}: {worst} cells expanded in one tick");
        assert!(total <= 3_000_000, "{model:?}: {total} cells expanded in all");
    }
}
