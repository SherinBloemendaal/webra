//! Production queue tests (production.rs): queued structures, losing the
//! Construction Yard and losing an item's prerequisites (OpenRA
//! `CancelUnbuildableItems`).

use crate::rules::{Kind, QueueType};
use crate::world::{cell_center, Order, World};

const BQ: usize = QueueType::Building as usize;
const DQ: usize = QueueType::Defense as usize;
const VQ: usize = QueueType::Vehicle as usize;

fn ty(w: &World, id: &str) -> u16 {
    w.rules.actor_index(id).unwrap() as u16
}

fn run(w: &mut World, ticks: u32) {
    for _ in 0..ticks {
        w.step();
    }
}

fn count(w: &World, owner: u8, id: &str) -> usize {
    let t = ty(w, id);
    w.actors.iter().filter(|a| a.alive && a.owner == owner && a.ty == t).count()
}

fn find(w: &World, owner: u8, id: &str) -> usize {
    let t = ty(w, id);
    (0..w.actors.len()).find(|&i| w.actors[i].alive && w.actors[i].owner == owner && w.actors[i].ty == t).unwrap()
}

fn queue_ids(w: &World, player: u8, q: usize) -> Vec<String> {
    w.players[player as usize].queues[q].items.iter().map(|it| w.rules.actors[it.ty as usize].id.clone()).collect()
}

/// Destroy actor `i` and let the world notice (cleanup, tokens).
fn destroy(w: &mut World, i: usize) {
    w.kill(i);
    w.cleanup_dead();
    w.refresh_tokens();
    w.update_power();
}

/// Construction Yard (from the start), power, refinery, war factory, service
/// depot, radar dome and barracks for `player`, with plenty of cash.
fn base(w: &mut World, player: u8, barracks: &str) {
    let (sx, sy) = w.players[player as usize].start;
    for (id, dx, dy) in [("APWR", 4, 0), ("APWR", 4, 4), ("PROC", -4, 0), ("WEAP", 0, 6), ("FIX", 8, 0), ("DOME", 8, 4), (barracks, -4, 5)]
    {
        let t = ty(w, id);
        w.spawn_building(t, player, sx + dx, sy + dy).unwrap_or_else(|| panic!("{id} fits"));
    }
    w.players[player as usize].cash = 100_000;
    w.refresh_tokens();
    w.update_power();
}

/// First free spot for `id` near the start position.
fn spot(w: &World, player: u8, id: &str) -> (i32, i32) {
    let t = ty(w, id);
    let (sx, sy) = w.players[player as usize].start;
    (-12..14)
        .flat_map(|dy| (-12..14).map(move |dx| (sx + dx, sy + dy)))
        .find(|&(x, y)| w.can_place(player, t, x, y))
        .expect("a free spot in the base")
}

/// Run until the head of queue `q` is finished (bounded).
fn run_until_done(w: &mut World, player: u8, q: usize) {
    for _ in 0..5000 {
        if w.players[player as usize].queues[q].items.first().is_some_and(|it| it.done) {
            return;
        }
        w.step();
    }
    panic!("queue {q} never finished its first item");
}

// ---- Queued structures (OpenRA: one ready structure per queue) --------------------

#[test]
fn structures_queue_and_wait_for_placement_one_at_a_time() {
    let mut w = World::new(1, 80, &[("allies", false), ("soviet", false)]);
    w.players[0].cash = 100_000;
    let powr = ty(&w, "POWR");
    // Three clicks (or a shift click) queue several structures.
    w.queue_order(Order::StartProduction { player: 0, ty: powr, count: 3 });
    run(&mut w, 1);
    assert_eq!(queue_ids(&w, 0, BQ), ["POWR", "POWR", "POWR"]);
    run_until_done(&mut w, 0, BQ);
    let paid_after_first = 100_000 - w.players[0].funds();
    assert_eq!(paid_after_first, 300, "only the first one was paid for");
    // The next one does not start while the first waits for placement.
    run(&mut w, 400);
    let items = &w.players[0].queues[BQ].items;
    assert!(items[0].done);
    assert!(items[1..].iter().all(|it| it.paid == 0 && it.total == 0 && !it.done), "the rest wait");
    assert_eq!(100_000 - w.players[0].funds(), 300);
    // Placing the ready one starts the next.
    let (x, y) = spot(&w, 0, "POWR");
    w.queue_order(Order::Place { player: 0, ty: powr, cx: x, cy: y });
    run(&mut w, 30);
    assert_eq!(count(&w, 0, "POWR"), 1);
    let items = &w.players[0].queues[BQ].items;
    assert_eq!(items.len(), 2);
    assert!(items[0].paid > 0 && !items[0].done, "the second one is being built");
    // Right click cancels the last queued one (nothing paid yet), then the one
    // in progress, refunding what it cost so far.
    w.queue_order(Order::CancelProduction { player: 0, ty: powr, count: 1 });
    run(&mut w, 1);
    assert_eq!(w.players[0].queues[BQ].items.len(), 1);
    assert!(w.players[0].queues[BQ].items[0].paid > 0, "the one in progress stayed");
    w.queue_order(Order::CancelProduction { player: 0, ty: powr, count: 1 });
    run(&mut w, 1);
    assert!(w.players[0].queues[BQ].items.is_empty());
    assert_eq!(100_000 - w.players[0].funds(), 300, "net cost: only the placed power plant");
}

#[test]
fn a_ready_structure_cancelled_refunds_its_full_cost() {
    let mut w = World::new(2, 80, &[("allies", false), ("soviet", false)]);
    w.players[0].cash = 10_000;
    let powr = ty(&w, "POWR");
    w.queue_order(Order::StartProduction { player: 0, ty: powr, count: 1 });
    run_until_done(&mut w, 0, BQ);
    assert_eq!(w.players[0].funds(), 9_700);
    w.queue_order(Order::CancelProduction { player: 0, ty: powr, count: 1 });
    run(&mut w, 1);
    assert!(w.players[0].queues[BQ].items.is_empty());
    assert_eq!(w.players[0].funds(), 10_000);
}

#[test]
fn different_structures_queue_behind_each_other_in_both_structure_queues() {
    let mut w = World::new(3, 80, &[("allies", false), ("soviet", false)]);
    base(&mut w, 0, "TENT");
    let (powr, apwr, pbox, gun) = (ty(&w, "POWR"), ty(&w, "APWR"), ty(&w, "PBOX"), ty(&w, "GUN"));
    w.queue_order(Order::StartProduction { player: 0, ty: powr, count: 1 });
    w.queue_order(Order::StartProduction { player: 0, ty: apwr, count: 5 });
    w.queue_order(Order::StartProduction { player: 0, ty: pbox, count: 1 });
    w.queue_order(Order::StartProduction { player: 0, ty: gun, count: 1 });
    run(&mut w, 1);
    assert_eq!(queue_ids(&w, 0, BQ), ["POWR", "APWR", "APWR", "APWR", "APWR", "APWR"]);
    assert_eq!(queue_ids(&w, 0, DQ), ["PBOX", "GUN"]);
    run(&mut w, 600);
    // Each queue has one ready structure; the ones behind it have not started.
    for q in [BQ, DQ] {
        let items = &w.players[0].queues[q].items;
        assert!(items[0].done);
        assert!(items[1..].iter().all(|it| it.paid == 0 && !it.done));
    }
    // Placing the wrong type does nothing: only the head of the queue can be placed.
    let (x, y) = spot(&w, 0, "APWR");
    w.queue_order(Order::Place { player: 0, ty: apwr, cx: x, cy: y });
    run(&mut w, 1);
    assert_eq!(count(&w, 0, "APWR"), 2);
    assert_eq!(w.players[0].queues[BQ].items.len(), 6);
}

#[test]
fn queued_structures_stay_deterministic() {
    let play = || {
        let mut w = World::new(9, 80, &[("allies", false), ("soviet", true)]);
        w.players[0].cash = 20_000;
        let powr = ty(&w, "POWR");
        w.queue_order(Order::StartProduction { player: 0, ty: powr, count: 5 });
        run(&mut w, 300);
        let (x, y) = spot(&w, 0, "POWR");
        w.queue_order(Order::Place { player: 0, ty: powr, cx: x, cy: y });
        run(&mut w, 300);
        w.state_hash()
    };
    assert_eq!(play(), play());
}

// ---- Losing the Construction Yard ---------------------------------------------------

#[test]
fn losing_the_construction_yard_cancels_structures_but_not_units() {
    let mut w = World::new(4, 80, &[("allies", false), ("soviet", false)]);
    base(&mut w, 0, "TENT");
    let (powr, pbox, harv) = (ty(&w, "POWR"), ty(&w, "PBOX"), ty(&w, "HARV"));
    w.queue_order(Order::StartProduction { player: 0, ty: powr, count: 3 });
    w.queue_order(Order::StartProduction { player: 0, ty: pbox, count: 1 });
    w.queue_order(Order::StartProduction { player: 0, ty: harv, count: 1 });
    run(&mut w, 60);
    let paid: i32 = [BQ, DQ].iter().flat_map(|&q| w.players[0].queues[q].items.iter().map(|it| it.paid)).sum();
    assert!(paid > 0);
    let harv_paid = w.players[0].queues[VQ].items[0].paid;
    let funds = w.players[0].funds();
    let harvesters = count(&w, 0, "HARV");

    let fact = find(&w, 0, "FACT");
    destroy(&mut w, fact);
    assert!(!w.can_produce(0, powr) && !w.can_produce(0, pbox));
    assert!(w.availability(0, powr).enabled, "prerequisites alone are still met");
    assert!(w.requirements(0, powr).iter().any(|r| r.label == "Construction Yard" && !r.never));
    assert!(w.can_produce(0, harv), "the war factory keeps working");
    run(&mut w, 1);
    // OpenRA (ClassicProductionQueue without a producer): every structure is cancelled and refunded.
    assert!(w.players[0].queues[BQ].items.is_empty() && w.players[0].queues[DQ].items.is_empty());
    let harv_spent = w.players[0].queues[VQ].items[0].paid - harv_paid;
    assert_eq!(w.players[0].funds(), funds + paid - harv_spent, "structures refunded exactly");
    // New structure orders are refused.
    w.queue_order(Order::StartProduction { player: 0, ty: powr, count: 1 });
    run(&mut w, 1);
    assert!(w.players[0].queues[BQ].items.is_empty());
    // Unit production continues.
    run(&mut w, 1500);
    assert_eq!(count(&w, 0, "HARV"), harvesters + 1);

    // A new Construction Yard (MCV deploy) restores the structure queues.
    let (sx, sy) = w.players[0].start;
    let mcv = w.spawn_unit(ty(&w, "MCV"), 0, cell_center(sx + 1), cell_center(sy + 1), 512);
    assert!(w.deploy(mcv), "the MCV deploys where the old yard stood");
    assert!(w.can_produce(0, powr) && w.can_produce(0, pbox));
    assert!(w.requirements(0, powr).is_empty());
    w.queue_order(Order::StartProduction { player: 0, ty: powr, count: 1 });
    run_until_done(&mut w, 0, BQ);
}

#[test]
fn a_ready_structure_cannot_be_placed_after_the_yard_died() {
    let mut w = World::new(5, 80, &[("allies", false), ("soviet", false)]);
    base(&mut w, 0, "TENT");
    let powr = ty(&w, "POWR");
    w.queue_order(Order::StartProduction { player: 0, ty: powr, count: 1 });
    run_until_done(&mut w, 0, BQ);
    let (x, y) = spot(&w, 0, "POWR");
    let funds = w.players[0].funds();
    // The yard dies in the same tick the place order arrives.
    let fact = find(&w, 0, "FACT");
    w.kill(fact);
    assert!(!w.place_building(0, powr, x, y));
    w.cleanup_dead();
    w.queue_order(Order::Place { player: 0, ty: powr, cx: x, cy: y });
    run(&mut w, 1);
    assert_eq!(count(&w, 0, "POWR"), 0);
    assert!(w.players[0].queues[BQ].items.is_empty());
    assert_eq!(w.players[0].funds(), funds + 300, "the finished power plant is refunded");
}

// ---- Losing an item's prerequisites -----------------------------------------------

#[test]
fn losing_a_unit_prerequisite_cancels_that_item_and_the_queue_moves_on() {
    let mut w = World::new(6, 80, &[("soviet", false), ("allies", false)]);
    base(&mut w, 0, "BARR");
    let (t3, harv) = (ty(&w, "3TNK"), ty(&w, "HARV"));
    w.queue_order(Order::StartProduction { player: 0, ty: t3, count: 1 });
    w.queue_order(Order::StartProduction { player: 0, ty: harv, count: 1 });
    run(&mut w, 60);
    assert_eq!(queue_ids(&w, 0, VQ), ["3TNK", "HARV"]);
    let paid = w.players[0].queues[VQ].items[0].paid;
    assert!(paid > 0);
    let funds = w.players[0].funds();
    let harvesters = count(&w, 0, "HARV");

    // The heavy tank needs the service depot: destroy it mid-production.
    let fix = find(&w, 0, "FIX");
    destroy(&mut w, fix);
    run(&mut w, 1);
    assert_eq!(queue_ids(&w, 0, VQ), ["HARV"], "the blocked tank is cancelled, the harvester moves up");
    let harv_spent = w.players[0].queues[VQ].items[0].paid;
    assert_eq!(w.players[0].funds(), funds + paid - harv_spent, "the tank is refunded exactly");
    // Queuing it again is refused while the depot is gone; the rest keeps going.
    w.queue_order(Order::StartProduction { player: 0, ty: t3, count: 1 });
    run(&mut w, 1500);
    assert_eq!(count(&w, 0, "HARV"), harvesters + 1);
    assert!(w.players[0].queues[VQ].items.is_empty(), "nothing stuck in the queue");

    // With a new depot the tank can be built again.
    let (x, y) = spot(&w, 0, "FIX");
    w.spawn_building(ty(&w, "FIX"), 0, x, y).unwrap();
    w.refresh_tokens();
    let tanks = count(&w, 0, "3TNK");
    w.queue_order(Order::StartProduction { player: 0, ty: t3, count: 1 });
    run(&mut w, 1500);
    assert_eq!(count(&w, 0, "3TNK"), tanks + 1);
}

#[test]
fn losing_a_structure_prerequisite_never_blocks_the_building_queue() {
    let mut w = World::new(7, 80, &[("soviet", false), ("allies", false)]);
    base(&mut w, 0, "BARR");
    let (stek, powr, sam, ftur) = (ty(&w, "STEK"), ty(&w, "POWR"), ty(&w, "SAM"), ty(&w, "FTUR"));
    // The tech center (needs the radar dome) heads the queue, a power plant waits behind it;
    // in the defense queue a SAM site (needs the dome) and a flame tower.
    w.queue_order(Order::StartProduction { player: 0, ty: stek, count: 1 });
    w.queue_order(Order::StartProduction { player: 0, ty: powr, count: 1 });
    w.queue_order(Order::StartProduction { player: 0, ty: sam, count: 1 });
    w.queue_order(Order::StartProduction { player: 0, ty: ftur, count: 1 });
    run(&mut w, 100);
    let paid: i32 = [BQ, DQ].iter().map(|&q| w.players[0].queues[q].items[0].paid).sum();
    assert!(paid > 0);
    let funds = w.players[0].funds();

    let dome = find(&w, 0, "DOME");
    destroy(&mut w, dome);
    run(&mut w, 1);
    assert_eq!(queue_ids(&w, 0, BQ), ["POWR"]);
    assert_eq!(queue_ids(&w, 0, DQ), ["FTUR"]);
    let spent: i32 = [BQ, DQ].iter().map(|&q| w.players[0].queues[q].items[0].paid).sum();
    assert_eq!(w.players[0].funds(), funds + paid - spent, "both refunded exactly");
    run_until_done(&mut w, 0, BQ);
    run_until_done(&mut w, 0, DQ);
    // The queue is not stuck: the power plant can be placed and more queued.
    let (x, y) = spot(&w, 0, "POWR");
    w.queue_order(Order::Place { player: 0, ty: powr, cx: x, cy: y });
    w.queue_order(Order::StartProduction { player: 0, ty: powr, count: 1 });
    run(&mut w, 2);
    assert_eq!(count(&w, 0, "POWR"), 1);
    assert_eq!(queue_ids(&w, 0, BQ), ["POWR"]);
    // A new radar dome brings the tech center back.
    assert!(!w.can_produce(0, stek));
    let (x, y) = spot(&w, 0, "DOME");
    w.spawn_building(ty(&w, "DOME"), 0, x, y).unwrap();
    w.refresh_tokens();
    assert!(w.can_produce(0, stek));
}

#[test]
fn a_finished_structure_whose_prerequisite_died_is_refunded() {
    let mut w = World::new(8, 80, &[("soviet", false), ("allies", false)]);
    base(&mut w, 0, "BARR");
    let sam = ty(&w, "SAM");
    w.queue_order(Order::StartProduction { player: 0, ty: sam, count: 1 });
    run_until_done(&mut w, 0, DQ);
    let funds = w.players[0].funds();
    let dome = find(&w, 0, "DOME");
    destroy(&mut w, dome);
    run(&mut w, 1);
    assert!(w.players[0].queues[DQ].items.is_empty());
    assert_eq!(w.players[0].funds(), funds + w.rules.actors[sam as usize].cost);
}

#[test]
fn the_ai_rebuilds_after_losing_a_prerequisite() {
    // The engine cancels blocked items for every player, the AI included.
    let mut w = World::new(10, 96, &[("allies", false), ("soviet", true)]);
    base(&mut w, 1, "BARR");
    let stek = ty(&w, "STEK");
    w.start_production(1, stek, 1);
    run(&mut w, 50);
    let dome = find(&w, 1, "DOME");
    destroy(&mut w, dome);
    run(&mut w, 1);
    assert!(!w.players[1].queues[BQ].items.iter().any(|it| it.ty == stek));
    run(&mut w, 25 * 60);
    let buildings = w.actors.iter().filter(|a| a.alive && a.owner == 1 && a.kind == Kind::Building).count();
    assert!(buildings >= 8, "the AI kept building: {buildings}");
}

// ---- Placement near the base (OpenRA BuildingInfo.IsCloseEnoughToBase) ------------

/// A 48x24 map: land west of x = 18, a two cell beach, open water from x = 20.
/// Player 0 owns a Construction Yard at (12, 10) (cells 12..14, 10..13) and
/// has explored the whole map.
fn shore_world() -> World {
    use crate::map::{Map, Terrain};
    let mut m = Map::filled(48, 24, Terrain::Water);
    m.spawns = vec![(12, 10), (40, 2)];
    for y in 0..24 {
        for x in 0..20 {
            let i = m.idx(x, y);
            m.terrain[i] = if x < 18 { Terrain::Clear } else { Terrain::Beach };
        }
    }
    let mut w = World::empty(crate::rules::Rules::load(), m, 5);
    for (f, start) in [("allies", (12, 10)), ("soviet", (40, 2))] {
        let fi = w.rules.faction_index(f).unwrap();
        w.add_player(fi, false, start);
    }
    for p in w.players.iter_mut() {
        p.explored.iter_mut().for_each(|e| *e = 1);
    }
    let fact = ty(&w, "FACT");
    w.spawn_building(fact, 0, 12, 10).unwrap();
    w.refresh_tokens();
    w.update_power();
    w
}

/// OpenRA SYRD and SPEN: RequiresBuildableArea Adjacent 8. Past a beach the
/// first all-water 3x3 spot lies more than two cells from the base; it must
/// still take a naval yard, up to eight cells from a structure that gives
/// buildable area (and no further).
#[test]
fn naval_yards_and_sub_pens_go_up_to_eight_cells_from_the_base() {
    let w = shore_world();
    for id in ["SYRD", "SPEN"] {
        let t = ty(&w, id);
        assert_eq!(w.rules.actors[t as usize].building.as_ref().unwrap().adjacent, 8, "{id}");
        // The yard's east edge is x = 14: a gap of 5 (x = 20, by the beach) to 8 (x = 22).
        for cx in 20..=22 {
            assert!(w.can_place(0, t, cx, 10), "{id} at x {cx}");
        }
        assert!(!w.can_place(0, t, 23, 10), "{id} nine cells out");
        // The footprint must be all water: not on the beach.
        assert!(!w.can_place(0, t, 19, 10), "{id} on the beach");
        // The placement preview (lib.rs placement_preview) agrees cell by cell.
        assert!(w.placement_cells(0, t, 22, 10).iter().all(|c| c.2), "{id} preview");
        assert!(w.placement_cells(0, t, 23, 10).iter().all(|c| !c.2), "{id} preview nine cells out");
    }
}

/// The whole order path: a finished naval yard placed by its order.
#[test]
fn a_finished_naval_yard_is_placed_by_its_order() {
    let mut w = shore_world();
    let syrd = ty(&w, "SYRD");
    for (id, x, y) in [("POWR", 8, 10), ("PROC", 8, 14)] {
        w.spawn_building(ty(&w, id), 0, x, y).unwrap();
    }
    w.players[0].cash = 100_000;
    w.refresh_tokens();
    w.update_power();
    w.queue_order(Order::StartProduction { player: 0, ty: syrd, count: 1 });
    run_until_done(&mut w, 0, BQ);
    w.queue_order(Order::Place { player: 0, ty: syrd, cx: 21, cy: 12 });
    run(&mut w, 2);
    let yard = find(&w, 0, "SYRD");
    assert_eq!((w.actors[yard].cx, w.actors[yard].cy), (21, 12));
}

/// OpenRA ^Wall: RequiresBuildableArea Adjacent 7.
#[test]
fn walls_go_up_to_seven_cells_from_the_base() {
    let w = shore_world();
    let brik = ty(&w, "BRIK");
    assert!(w.can_place(0, brik, 5, 11), "seven cells west of the yard");
    assert!(!w.can_place(0, brik, 4, 11), "eight cells west of the yard");
}

/// OpenRA AreaTypes: fakes give and need only `fake` area; real structures
/// give `building, fake` and need `building`. So a real structure cannot go
/// next to a fake alone, a fake can.
#[test]
fn fake_structures_give_area_only_to_fakes() {
    let mut w = shore_world();
    w.spawn_building(ty(&w, "FPWR"), 0, 2, 18).unwrap();
    assert!(!w.can_place(0, ty(&w, "POWR"), 5, 18), "a power plant next to a fake only");
    assert!(w.can_place(0, ty(&w, "FPWR"), 5, 18), "a fake next to a fake");
    // A real structure gives fakes their area too.
    assert!(w.can_place(0, ty(&w, "FPWR"), 16, 10), "a fake next to the yard");
}

/// OpenRA counts footprint cells, not the bounding box: the empty corners of
/// the service depot (`_+_ +++ _+_`) give no buildable area.
#[test]
fn empty_footprint_corners_give_no_buildable_area() {
    let mut w = shore_world();
    // FIX at (4, 2): its south-east corner (6, 4) is empty.
    w.spawn_building(ty(&w, "FIX"), 0, 4, 2).unwrap();
    let powr = ty(&w, "POWR");
    assert!(w.can_place(0, powr, 7, 6), "two cells from the depot's pad (5, 4)");
    assert!(!w.can_place(0, powr, 8, 6), "two cells from the empty corner only");
}

/// OpenRA scans up to, not including, Map.Clamp(topLeft + Dimensions +
/// Adjacent): on the map's last row a structure gives no area to a
/// footprint below the scan end.
#[test]
fn the_last_map_row_is_left_out_of_the_buildable_area_scan() {
    let mut w = shore_world();
    let (sbag, powr) = (ty(&w, "SBAG"), ty(&w, "POWR"));
    // A one cell structure that gives buildable area (synthetic rules).
    let area = w.rules.actors[powr as usize].building.as_ref().unwrap().gives_area;
    w.rules.actors[sbag as usize].building.as_mut().unwrap().gives_area = area;
    w.spawn_building(sbag, 0, 2, 22).unwrap();
    assert!(w.can_place(0, powr, 2, 19), "two rows above a giver on row 22");
    let b = w.building_at[w.map.idx(2, 22)] as usize;
    w.remove(b);
    w.spawn_building(sbag, 0, 2, 23).unwrap();
    assert!(!w.can_place(0, powr, 2, 20), "two rows above a giver on the last row");
}

// ---- Shroud, fog and hidden actors (OpenRA World.IsCellBuildable) ------------------

/// Finish a `q` item of `id` for player 0 and place it at (x, y) by order.
fn build_and_place(w: &mut World, id: &str, q: usize, x: i32, y: i32) {
    let t = ty(w, id);
    w.players[0].cash = 100_000;
    w.queue_order(Order::StartProduction { player: 0, ty: t, count: 1 });
    run_until_done(w, 0, q);
    w.queue_order(Order::Place { player: 0, ty: t, cx: x, cy: y });
    run(w, 2);
}

/// OpenRA never asks the shroud when placing: a footprint may reach into
/// cells the player has not explored, in the preview and by order.
#[test]
fn structures_go_into_the_shroud_like_openra() {
    let mut w = shore_world();
    w.spawn_building(ty(&w, "POWR"), 0, 8, 10).unwrap();
    w.refresh_tokens();
    w.update_power();
    for p in w.players.iter_mut() {
        p.explored.iter_mut().for_each(|e| *e = 0);
    }
    let syrd = ty(&w, "SYRD");
    assert!(w.placement_cells(0, syrd, 21, 12).iter().all(|c| c.2), "preview over unexplored water");
    build_and_place(&mut w, "SYRD", BQ, 21, 12);
    assert_eq!(count(&w, 0, "SYRD"), 1, "placed into the shroud");
}

/// OpenRA checks the true world state (ActorMap), so an enemy unit the
/// player cannot see still blocks its cell: the preview shows that cell
/// blocked (it gives the unit away) and the order is refused. Cloaked units
/// (a submarine under a naval yard's footprint) block the same way.
#[test]
fn hidden_actors_block_their_cells_like_openra() {
    let mut w = shore_world();
    for p in w.players.iter_mut() {
        p.explored.iter_mut().for_each(|e| *e = 0);
    }
    let syrd = ty(&w, "SYRD");
    let sub = w.spawn_unit(ty(&w, "SS"), 1, cell_center(22), cell_center(11), 0);
    w.rebuild_hash();
    assert!(w.players[0].explored[w.map.idx(22, 11)] == 0, "the player has not seen the cell");
    let cells = w.placement_cells(0, syrd, 21, 10);
    let blocked: Vec<(i32, i32)> = cells.iter().filter(|c| !c.2).map(|c| (c.0, c.1)).collect();
    assert_eq!(blocked, vec![(22, 11)], "only the submarine's cell is blocked");
    w.remove(sub);
    w.rebuild_hash();
    assert!(w.can_place(0, syrd, 21, 10), "free once it is gone");
}

/// A paratrooper on its parachute occupies its cell from its creation
/// (OpenRA: every Mobile actor is in the ActorMap; only Aircraft keep no
/// cell in the air).
#[test]
fn a_descending_paratrooper_blocks_placement() {
    let mut w = shore_world();
    let powr = ty(&w, "POWR");
    let e1 = w.spawn_unit(ty(&w, "E1"), 1, cell_center(9), cell_center(11), 0);
    w.actors[e1].altitude = 4096;
    w.rebuild_hash();
    assert!(!w.can_place(0, powr, 9, 11), "a paratrooper still in the air");
    w.remove(e1);
    w.rebuild_hash();
    assert!(w.can_place(0, powr, 9, 11), "free once it is gone");
}

/// A crate on its parachute takes its cell too (OpenRA Crate is in the
/// ActorMap from its creation, falling or landed).
#[test]
fn a_falling_crate_blocks_placement() {
    let mut w = shore_world();
    let powr = ty(&w, "POWR");
    let c = w.place_crate(ty(&w, "CRATE") as usize, 1, 9, 11, 4096);
    w.rebuild_hash();
    assert!(w.actors[c].altitude > 0 && w.actors[c].air.parachute);
    assert!(!w.can_place(0, powr, 9, 11), "a crate still in the air");
    w.remove(c);
    w.rebuild_hash();
    assert!(w.can_place(0, powr, 9, 11), "free once it is gone");
}

/// Aircraft in the air occupy no cell (OpenRA Aircraft.OccupiedCells holds
/// only landing cells); a landed one blocks.
#[test]
fn only_landed_aircraft_block_placement() {
    let mut w = shore_world();
    let powr = ty(&w, "POWR");
    let heli = w.spawn_unit(ty(&w, "HELI"), 1, cell_center(9), cell_center(11), 0);
    w.rebuild_hash();
    assert!(w.actors[heli].altitude > 0, "spawned flying");
    assert!(w.can_place(0, powr, 9, 11), "a helicopter overhead");
    w.actors[heli].altitude = 0;
    assert!(!w.can_place(0, powr, 9, 11), "a landed helicopter");
}

/// OpenRA LineBuild Range 8 searches cells 1 to 7 out: posts seven cells
/// apart are joined, eight apart are not.
#[test]
fn wall_lines_reach_seven_cells() {
    for (gap, joined) in [(7, true), (8, false)] {
        let mut w = shore_world();
        build_and_place(&mut w, "SBAG", DQ, 6, 8);
        build_and_place(&mut w, "SBAG", DQ, 6 + gap, 8);
        assert_eq!(count(&w, 0, "SBAG"), if joined { gap as usize + 1 } else { 2 }, "posts {gap} apart");
    }
}

/// OpenRA GetLineBuildCells passes over unexplored cells, also occupied
/// ones: the line is filled through the shroud. An occupied unexplored cell
/// stays empty (OpenRA puts a piece over what is there; WebRA structures
/// never share a cell).
#[test]
fn wall_lines_are_filled_through_the_shroud() {
    let mut w = shore_world();
    build_and_place(&mut w, "SBAG", DQ, 6, 8);
    let rifle = w.spawn_unit(ty(&w, "E1"), 1, cell_center(9), cell_center(8), 0);
    for x in 8..=10 {
        let i = w.map.idx(x, 8);
        w.players[0].explored[i] = 0;
    }
    build_and_place(&mut w, "SBAG", DQ, 12, 8);
    let walls: Vec<i32> = (6..=12).filter(|&x| w.building_at[w.map.idx(x, 8)] != crate::world::NONE).collect();
    assert_eq!(walls, vec![6, 7, 8, 10, 11, 12], "all but the rifleman's cell");
    assert!(w.actors[rifle].alive);
}

/// OpenRA's line search connects to any LineBuildNode of the wall's type,
/// whoever owns it.
#[test]
fn wall_lines_join_another_players_wall() {
    let mut w = shore_world();
    w.spawn_building(ty(&w, "SBAG"), 1, 11, 8).unwrap();
    build_and_place(&mut w, "SBAG", DQ, 7, 8);
    let owners: Vec<u8> = (7..=11).map(|x| w.actors[w.building_at[w.map.idx(x, 8)] as usize].owner).collect();
    assert_eq!(owners, vec![0, 0, 0, 0, 1]);
}

/// OpenRA Building.FindBaseProvider measures from the candidate's centre to
/// the provider's CenterPosition, both with LocalCenterOffset: the yard's
/// centre is half a cell above its footprint's (FACT 0,-512). Power plants
/// next to a giver, near the edge of the yard's 16c0 build radius.
#[test]
fn the_build_radius_is_measured_from_the_yards_openra_centre() {
    use crate::map::{Map, Terrain};
    let mut m = Map::filled(48, 24, Terrain::Clear);
    m.spawns = vec![(12, 10), (40, 2)];
    let mut w = World::empty(crate::rules::Rules::load(), m, 5);
    for (f, start) in [("allies", (12, 10)), ("soviet", (40, 2))] {
        let fi = w.rules.faction_index(f).unwrap();
        w.add_player(fi, false, start);
    }
    assert!(w.options.build_radius);
    let (fact, powr) = (ty(&w, "FACT"), ty(&w, "POWR"));
    w.spawn_building(fact, 0, 12, 10).unwrap();
    // Givers of buildable area that give no build radius.
    w.spawn_building(powr, 0, 25, 4).unwrap();
    w.spawn_building(powr, 0, 24, 19).unwrap();
    // (25, 1): 16077 from the yard's OpenRA centre (16392 from its footprint's).
    assert!(w.can_place(0, powr, 25, 1), "north of the yard, inside the radius");
    // (24, 22): 16654 from the yard's OpenRA centre (16296 from its footprint's).
    assert!(!w.can_place(0, powr, 24, 22), "south of the yard, outside the radius");
}

/// OpenRA FindBaseProvider compares squared lengths (HorizontalLengthSquared
/// <= Range * Range), not a rounded square root. Red Alert's centres lie on
/// a 512 grid where the two never differ, so a synthetic LocalCenterOffset
/// puts a pillbox 16384.3 from the yard's centre: the rounded root (16384)
/// would let it in.
#[test]
fn the_build_radius_compares_squared_lengths() {
    use crate::map::{Map, Terrain};
    let mut m = Map::filled(48, 24, Terrain::Clear);
    m.spawns = vec![(12, 10), (40, 2)];
    let mut w = World::empty(crate::rules::Rules::load(), m, 5);
    for (f, start) in [("allies", (12, 10)), ("soviet", (40, 2))] {
        let fi = w.rules.faction_index(f).unwrap();
        w.add_player(fi, false, start);
    }
    let (fact, powr, pbox) = (ty(&w, "FACT"), ty(&w, "POWR"), ty(&w, "PBOX"));
    w.spawn_building(fact, 0, 12, 10).unwrap();
    // A giver of buildable area next to the spot, out of the radius itself.
    w.spawn_building(powr, 0, 30, 10).unwrap();
    // The pillbox's centre at (29, 11) is 16384 east of the yard's OpenRA centre.
    assert!(w.can_place(0, pbox, 29, 11), "exactly at the radius");
    w.rules.actors[pbox as usize].building.as_mut().unwrap().center_offset = (0, 100);
    assert!(!w.can_place(0, pbox, 29, 11), "100 further down: 16384.3 away");
}

// ---- Losing the last factory of a queue (lobby option `factoryLoss`) ---------------------

/// A partly built harvester and a queued one, every prerequisite met (the
/// "all tech" cheat, so only the producer counts), then the war factory
/// dies. OpenRA's rule (ClassicProductionQueue.Tick, ClearQueue): the
/// Vehicle queue is emptied and everything paid refunded, silently, and
/// nothing can be queued there until a war factory stands again. WebRA's:
/// the queue waits, nothing paid, and builds again with a new factory.
#[test]
fn losing_the_last_war_factory_under_each_factory_loss_rule() {
    use crate::world::FactoryLoss;
    for rule in FactoryLoss::ALL {
        let mut w = World::new(4, 80, &[("allies", false), ("soviet", false)]);
        w.options.factory_loss = rule;
        base(&mut w, 0, "TENT");
        w.players[0].dev.all_tech = true;
        let harv = ty(&w, "HARV");
        w.queue_order(Order::StartProduction { player: 0, ty: harv, count: 2 });
        run(&mut w, 60);
        let paid: i32 = w.players[0].queues[VQ].items.iter().map(|it| it.paid).sum();
        assert!(paid > 0 && !w.players[0].queues[VQ].items[0].done, "{rule:?}: partly built");
        let funds = w.players[0].funds();
        let harvesters = count(&w, 0, "HARV");
        w.sound.set_enabled(true);
        let weap = find(&w, 0, "WEAP");
        destroy(&mut w, weap);
        run(&mut w, 1);
        let cancelled = w
            .sound
            .take()
            .chunks(crate::sound_events::EVENT_STRIDE)
            .filter(|e| e[0] == crate::sound_events::SoundEventKind::ProductionCancelled as i32)
            .count();
        assert_eq!(cancelled, 0, "{rule:?}: no announcement");
        match rule {
            FactoryLoss::OpenRA => {
                assert!(w.players[0].queues[VQ].items.is_empty(), "cleared");
                assert_eq!(w.players[0].funds(), funds + paid, "refunded exactly");
                assert!(!w.can_produce(0, harv), "nothing to queue without a war factory");
                assert!(!w.requirements(0, harv).is_empty(), "the sidebar names the factory");
                w.queue_order(Order::StartProduction { player: 0, ty: harv, count: 1 });
                run(&mut w, 1);
                assert!(w.players[0].queues[VQ].items.is_empty(), "the order is refused");
            }
            FactoryLoss::WebRA => {
                assert_eq!(w.players[0].queues[VQ].items.len(), 2, "kept");
                assert!(w.can_produce(0, harv), "units may still be queued");
                run(&mut w, 300);
                assert_eq!(w.players[0].queues[VQ].items.iter().map(|it| it.paid).sum::<i32>(), paid, "the queue waits");
                assert_eq!(w.players[0].funds(), funds, "nothing paid, nothing refunded");
            }
        }
        // A new war factory: production goes on (OpenRA: from scratch).
        let (sx, sy) = w.players[0].start;
        w.spawn_building(ty(&w, "WEAP"), 0, sx, sy + 6).expect("the war factory fits again");
        w.refresh_tokens();
        w.update_power();
        if rule == FactoryLoss::OpenRA {
            assert!(w.can_produce(0, harv));
            w.queue_order(Order::StartProduction { player: 0, ty: harv, count: 1 });
        }
        run(&mut w, 2500);
        assert!(count(&w, 0, "HARV") > harvesters, "{rule:?}: built again");
    }
}

/// A finished structure waiting for placement when the Construction Yard
/// dies: OpenRA's rule refunds its whole cost silently (ClearQueue), WebRA's
/// cancels it with a refund and one announcement.
#[test]
fn a_ready_structure_is_refunded_in_full_under_each_factory_loss_rule() {
    use crate::world::FactoryLoss;
    for rule in FactoryLoss::ALL {
        let mut w = World::new(5, 80, &[("allies", false), ("soviet", false)]);
        w.options.factory_loss = rule;
        base(&mut w, 0, "TENT");
        let powr = ty(&w, "POWR");
        w.queue_order(Order::StartProduction { player: 0, ty: powr, count: 1 });
        run_until_done(&mut w, 0, BQ);
        let funds = w.players[0].funds();
        w.sound.set_enabled(true);
        let fact = find(&w, 0, "FACT");
        destroy(&mut w, fact);
        run(&mut w, 1);
        let cancelled = w
            .sound
            .take()
            .chunks(crate::sound_events::EVENT_STRIDE)
            .filter(|e| e[0] == crate::sound_events::SoundEventKind::ProductionCancelled as i32)
            .count();
        assert!(w.players[0].queues[BQ].items.is_empty(), "{rule:?}: emptied");
        assert_eq!(w.players[0].funds(), funds + w.rules.actors[powr as usize].cost, "{rule:?}: the whole cost back");
        assert_eq!(cancelled, usize::from(rule == FactoryLoss::WebRA), "{rule:?}: announcement");
    }
}

/// The lobby option travels in the game options: saves and replays carry
/// it, and those from before it (no `factoryLoss`) play WebRA's rule.
#[test]
fn the_factory_loss_option_round_trips_through_game_options() {
    use crate::world::FactoryLoss;
    let base = r#"{"seed": 3, "mapSize": 64, "players": [{"type": "human", "faction": "england"}, {"type": "ai", "faction": "russia"}]"#;
    let rule = |extra: &str| crate::parse_options(&format!("{base}{extra}}}")).map(|p| p.options.factory_loss);
    assert_eq!(rule(""), Ok(FactoryLoss::WebRA), "games from before the option");
    assert_eq!(rule(r#", "factoryLoss": "openra""#), Ok(FactoryLoss::OpenRA));
    assert_eq!(rule(r#", "factoryLoss": "webra""#), Ok(FactoryLoss::WebRA));
    assert!(rule(r#", "factoryLoss": "refund""#).is_err());
    assert!(rule(r#", "factoryLoss": true"#).is_err());
    assert_eq!(crate::world::GameOptions::default().factory_loss, FactoryLoss::OpenRA, "the lobby default");
    let replay = |extra: &str| {
        let mut g = crate::Game::from_options(&format!("{base}{extra}}}")).unwrap();
        for _ in 0..25 * 30 {
            g.world.step();
        }
        g.world.state_hash()
    };
    assert_eq!(replay(r#", "factoryLoss": "openra""#), replay(r#", "factoryLoss": "openra""#));
    assert_eq!(replay(""), replay(r#", "factoryLoss": "webra""#), "absent is WebRA's rule");
    assert_ne!(replay(r#", "factoryLoss": "openra""#), replay(r#", "factoryLoss": "webra""#), "the rule is in the state hash");
}

/// The producers the sidebar names for a queue without one are those the
/// player's faction can have (like `providers`): an Allied player without
/// infantry structures is told about the Allied Barracks only, a Soviet
/// one about the Soviet Barracks and the Kennel.
#[test]
fn missing_producers_are_named_for_the_faction() {
    for (faction, want) in [("allies", "Allied Barracks"), ("soviet", "Soviet Barracks or Kennel")] {
        let mut w = World::new(4, 80, &[(faction, false), ("allies", false)]);
        w.options.factory_loss = crate::world::FactoryLoss::OpenRA;
        w.players[0].dev.all_tech = true;
        let e1 = ty(&w, "E1");
        let labels: Vec<String> = w.requirements(0, e1).into_iter().map(|r| r.label).collect();
        assert_eq!(labels, vec![want.to_string()], "{faction}");
    }
}

// ---- Queueing without money, shift +5/-5 (OpenRA ProductionQueue) ----------------

const IQ: usize = QueueType::Infantry as usize;

/// `base` with a barracks in the open, so riflemen can leave it.
fn infantry_base(w: &mut World) {
    base(w, 0, "TENT");
    let (x, y) = spot(w, 0, "TENT");
    w.spawn_building(ty(w, "TENT"), 0, x, y).unwrap();
    w.refresh_tokens();
    w.update_power();
}

#[test]
fn items_queue_without_money_and_build_once_it_comes_in() {
    let mut w = World::new(31, 80, &[("allies", false), ("soviet", false)]);
    infantry_base(&mut w);
    w.players[0].cash = 0;
    w.players[0].resources = 0;
    let e1 = ty(&w, "E1");
    // Seven shift clicks: 35 riflemen, more than the old cap of 30 per queue.
    for _ in 0..7 {
        w.queue_order(Order::StartProduction { player: 0, ty: e1, count: 5 });
    }
    run(&mut w, 1);
    assert_eq!(w.players[0].queues[IQ].items.len(), 35, "every item queued with no credits");
    assert!(w.can_start(0, e1), "money never stops queueing");
    // Production waits for money (OpenRA ProductionItem.Tick: TakeCash fails).
    run(&mut w, 200);
    let items = &w.players[0].queues[IQ].items;
    assert_eq!(items.len(), 35);
    assert_eq!(items[0].paid, 0);
    assert_eq!(items[0].remaining, items[0].total, "no progress without credits");
    assert_eq!(count(&w, 0, "E1"), 0);
    // Once the money arrives it resumes on its own.
    w.players[0].cash = 1_000;
    run(&mut w, 600);
    assert!(count(&w, 0, "E1") >= 1, "the first rifleman was trained");
    assert!(w.players[0].queues[IQ].items.len() < 35);
}

#[test]
fn production_pauses_mid_item_while_money_is_short_and_resumes() {
    let mut w = World::new(32, 80, &[("allies", false), ("soviet", false)]);
    infantry_base(&mut w);
    let e1 = ty(&w, "E1");
    // Enough for part of one rifleman (cost 100).
    w.players[0].cash = 40;
    w.players[0].resources = 0;
    w.queue_order(Order::StartProduction { player: 0, ty: e1, count: 1 });
    run(&mut w, 400);
    let it = w.players[0].queues[IQ].items[0].clone();
    assert!(it.paid > 0 && it.paid <= 40, "paid what there was: {}", it.paid);
    assert!(!it.done && it.remaining > 0);
    let stalled = it.remaining;
    run(&mut w, 50);
    assert_eq!(w.players[0].queues[IQ].items[0].remaining, stalled, "stalled while short");
    w.players[0].cash += 100;
    run(&mut w, 400);
    assert_eq!(count(&w, 0, "E1"), 1);
    assert_eq!(w.players[0].funds(), 40, "paid 100 in all");
}

#[test]
fn cancel_with_a_count_removes_the_last_items_and_refunds_partly_paid_ones() {
    let mut w = World::new(33, 80, &[("allies", false), ("soviet", false)]);
    infantry_base(&mut w);
    let (e1, e3) = (ty(&w, "E1"), ty(&w, "E3"));
    let start = w.players[0].funds();
    w.queue_order(Order::StartProduction { player: 0, ty: e1, count: 4 });
    w.queue_order(Order::StartProduction { player: 0, ty: e3, count: 2 });
    w.queue_order(Order::StartProduction { player: 0, ty: e1, count: 3 });
    run(&mut w, 40);
    let head = w.players[0].queues[IQ].items[0].clone();
    assert!(head.ty == e1 && head.paid > 0 && !head.done, "the head is partly paid");
    assert_eq!(start - w.players[0].funds(), head.paid);
    // Shift + right click: the last five riflemen go, last first; the
    // rocket soldiers between them stay.
    w.queue_order(Order::CancelProduction { player: 0, ty: e1, count: 5 });
    run(&mut w, 1);
    assert_eq!(queue_ids(&w, 0, IQ), ["E1", "E1", "E3", "E3"]);
    // Five more: only two riflemen are left, the partly paid head among
    // them, and what it cost so far comes back.
    w.queue_order(Order::CancelProduction { player: 0, ty: e1, count: 5 });
    run(&mut w, 1);
    assert_eq!(queue_ids(&w, 0, IQ), ["E3", "E3"]);
    let paid_e3: i32 = w.players[0].queues[IQ].items.iter().map(|it| it.paid).sum();
    assert_eq!(start - w.players[0].funds(), paid_e3, "the rifleman's payment was refunded");
}

#[test]
fn an_order_without_a_cancel_count_cancels_one_and_counts_are_capped() {
    let o: Order = serde_json::from_str(r#"{"o":"cancel_production","player":0,"ty":3}"#).unwrap();
    assert!(matches!(o, Order::CancelProduction { count: 1, .. }), "older clients and replays cancel one");
    assert!(o.is_reasonable());
    let o: Order = serde_json::from_str(r#"{"o":"cancel_production","player":0,"ty":3,"count":5}"#).unwrap();
    assert!(matches!(o, Order::CancelProduction { count: 5, .. }) && o.is_reasonable());
    for bad in [0, -1, 51] {
        assert!(!Order::CancelProduction { player: 0, ty: 3, count: bad }.is_reasonable(), "count {bad}");
    }
}

#[test]
fn a_queue_takes_up_to_item_limit_of_one_type_unless_all_tech() {
    let mut w = World::new(34, 80, &[("allies", false), ("soviet", false)]);
    infantry_base(&mut w);
    let (e1, e3) = (ty(&w, "E1"), ty(&w, "E3"));
    for _ in 0..21 {
        w.queue_order(Order::StartProduction { player: 0, ty: e1, count: 50 });
    }
    run(&mut w, 1);
    let n = |w: &World, t: u16| w.players[0].queues[IQ].items.iter().filter(|it| it.ty == t).count() as i32;
    assert_eq!(n(&w, e1), crate::production::ITEM_LIMIT, "OpenRA ItemLimit 999");
    assert!(!w.can_start(0, e1));
    assert_eq!(w.item_room(0, e1), 0);
    // The limit is per type: the queue itself has none (QueueLimit 0).
    w.queue_order(Order::StartProduction { player: 0, ty: e3, count: 5 });
    run(&mut w, 1);
    assert_eq!(n(&w, e3), 5);
    w.players[0].dev.all_tech = true;
    assert_eq!(w.item_room(0, e1), crate::production::QUEUE_CAP - 999 - 5, "only WebRA's queue cap is left");
    w.queue_order(Order::StartProduction { player: 0, ty: e1, count: 2 });
    run(&mut w, 1);
    assert_eq!(n(&w, e1), crate::production::ITEM_LIMIT + 2, "the all tech cheat lifts it");
}

#[test]
fn a_queue_holds_at_most_queue_cap_items_even_with_all_tech() {
    use crate::production::QUEUE_CAP;
    let mut w = World::new(35, 80, &[("allies", false), ("soviet", false)]);
    infantry_base(&mut w);
    // No credits: nothing is built, so the queue only changes by the orders.
    w.players[0].cash = 0;
    w.players[0].resources = 0;
    let types: Vec<u16> = ["E1", "E3", "E6", "MEDI"].iter().map(|id| ty(&w, id)).collect();
    // ItemLimit 999 per type would allow 3996; the queue stops at QUEUE_CAP.
    for &t in &types {
        for _ in 0..20 {
            w.queue_order(Order::StartProduction { player: 0, ty: t, count: 50 });
        }
    }
    run(&mut w, 1);
    assert_eq!(w.players[0].queues[IQ].items.len() as i32, QUEUE_CAP);
    assert!(types.iter().all(|&t| !w.can_start(0, t) && w.item_room(0, t) == 0));
    w.players[0].dev.all_tech = true;
    w.queue_order(Order::StartProduction { player: 0, ty: types[0], count: 5 });
    run(&mut w, 1);
    assert_eq!(w.players[0].queues[IQ].items.len() as i32, QUEUE_CAP, "the cheat does not lift it");
    // A count cancel takes the last ones of its type in one pass and leaves the others in order.
    let before: Vec<u16> = w.players[0].queues[IQ].items.iter().map(|it| it.ty).collect();
    w.queue_order(Order::CancelProduction { player: 0, ty: types[1], count: 50 });
    run(&mut w, 1);
    let after: Vec<u16> = w.players[0].queues[IQ].items.iter().map(|it| it.ty).collect();
    let n1 = before.iter().filter(|&&t| t == types[1]).count();
    let mut expected = before.clone();
    let mut seen = 0;
    expected.retain(|&t| {
        t != types[1] || {
            seen += 1;
            seen <= n1 - 50
        }
    });
    assert_eq!(after, expected);
}
