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
    w.queue_order(Order::CancelProduction { player: 0, ty: powr });
    run(&mut w, 1);
    assert_eq!(w.players[0].queues[BQ].items.len(), 1);
    assert!(w.players[0].queues[BQ].items[0].paid > 0, "the one in progress stayed");
    w.queue_order(Order::CancelProduction { player: 0, ty: powr });
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
    w.queue_order(Order::CancelProduction { player: 0, ty: powr });
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
