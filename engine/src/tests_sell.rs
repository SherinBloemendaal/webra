//! Selling structures (production.rs `sell_refund`, OpenRA Sellable, the Sell
//! activity and CustomSellValueExts.GetSellValue): the refund is
//! RefundPercent of the sell value (CustomSellValue, else the cost), scaled
//! by health and rounded down, and the Game API, the sound event and the
//! statistics show the same amount.

use crate::rules::Rules;
use crate::sound_events::{SoundEventKind, EVENT_STRIDE};
use crate::world::{cell_center, Order, World};
use crate::Game;

fn ty(w: &World, id: &str) -> u16 {
    w.rules.actor_index(id).unwrap() as u16
}

fn world() -> World {
    World::new(11, 64, &[("allies", false), ("soviet", false)])
}

/// Structure `id` of player 0 next to its start.
fn building(w: &mut World, id: &str, dx: i32) -> usize {
    let (sx, sy) = w.players[0].start;
    let t = ty(w, id);
    (0..40).find_map(|k| w.spawn_building(t, 0, sx + dx + k % 8, sy + 6 + k / 8)).unwrap_or_else(|| panic!("no room for {id}"))
}

/// Cash player 0 got for selling `b` through the lockstep order.
fn sell(w: &mut World, b: usize) -> i32 {
    let r = w.make_ref(b);
    let cash = w.players[0].cash;
    w.queue_order(Order::Sell { player: 0, building: r });
    w.step();
    assert!(w.resolve(r).is_none(), "sold");
    w.players[0].cash - cash
}

#[test]
fn a_pillbox_refunds_half_its_custom_sell_value_not_its_cost() {
    let mut w = world();
    let info = &w.rules.actors[ty(&w, "PBOX") as usize];
    assert_eq!((info.cost, info.custom_sell_value, info.sell_value()), (600, Some(400), 400), "PBOX CustomSellValue 400");
    let b = building(&mut w, "PBOX", 4);
    assert_eq!(sell(&mut w, b), 200, "50% of 400, not of the 600 it costs");
    // The camouflaged pillbox (CustomSellValue 550) and the refinery (300) too.
    let b = building(&mut w, "HBOX", 4);
    assert_eq!(sell(&mut w, b), 275);
    let b = building(&mut w, "PROC", 4);
    assert_eq!(sell(&mut w, b), 150);
}

#[test]
fn a_damaged_pillbox_refunds_its_sell_value_scaled_by_health_rounded_down() {
    let mut w = world();
    let b = building(&mut w, "PBOX", 4);
    assert_eq!(w.rules.actors[w.actors[b].ty as usize].hp, 40_000);
    w.actors[b].hp = 13_333;
    // 400 * 50 * 13333 / (100 * 40000) = 66.66: 66 (the cost would give 99).
    assert_eq!(w.sell_refund(b), Some(66));
    assert_eq!(sell(&mut w, b), 66);
}

#[test]
fn walls_can_be_sold_for_nothing() {
    let mut w = world();
    for id in ["SBAG", "FENC", "BRIK"] {
        assert_eq!(w.rules.actors[ty(&w, id) as usize].sell_value(), 0, "{id} CustomSellValue 0");
    }
    let b = building(&mut w, "BRIK", 4);
    assert_eq!(w.sell_refund(b), Some(0), "sellable, for $0");
    let g = Game::wrap(w.clone());
    let r = w.make_ref(b);
    assert_eq!(g.sell_value(0, r), 0, "the sell cursor shows over a wall");
    assert_eq!(sell(&mut w, b), 0, "the concrete wall costs 200 but pays nothing back");
    assert_eq!(w.player_stats(0).sold, 0);
}

#[test]
fn the_game_api_shows_the_refund_the_sale_pays() {
    let mut w = world();
    let b = building(&mut w, "PBOX", 4);
    w.actors[b].hp = 30_000;
    let r = w.make_ref(b);
    let (sx, sy) = w.players[0].start;
    let tank = w.spawn_unit(ty(&w, "1TNK"), 0, cell_center(sx + 2), cell_center(sy + 12), 0);
    let tank = w.make_ref(tank);
    let g = Game::wrap(w.clone());
    assert_eq!(g.sell_value(0, r), 150, "400 * 50% * 3/4");
    assert_eq!(g.sell_value(1, r), -1, "only its owner may sell it");
    assert_eq!(g.sell_value(0, tank), -1, "units cannot be sold");
    w.sound.set_enabled(true);
    assert_eq!(sell(&mut w, b), 150);
    // The Sold event carries the refund for the floating "+$150" (OpenRA Sell ShowTicks).
    let ev: Vec<[i32; EVENT_STRIDE]> = w.sound.take().chunks(EVENT_STRIDE).map(|c| c.try_into().unwrap()).collect();
    let sold = ev.iter().find(|e| e[0] == SoundEventKind::Sold as i32).expect("sold event");
    assert_eq!((sold[1], sold[4], sold[5]), (ty(&w, "PBOX") as i32, 0, 150));
    assert_eq!(w.player_stats(0).sold, 150, "the statistics count what was paid");
}

#[test]
fn map_rules_change_the_refund_like_openra() {
    let mut w = world();
    w.rules = Rules::load_with(Some(&serde_json::json!({ "actors": {
        // A new cost changes the sell value of a structure without CustomSellValue ...
        "POWR": { "cost": 900 },
        // ... and not of one with it, whose CustomSellValue can be changed itself.
        "PBOX": { "cost": 2000, "custom_sell_value": 1000 },
        // RefundPercent.
        "DOME": { "building": { "sell_refund": 100 } },
    } })))
    .expect("overrides load");
    let b = building(&mut w, "POWR", 4);
    assert_eq!(sell(&mut w, b), 450);
    let b = building(&mut w, "PBOX", 4);
    assert_eq!(sell(&mut w, b), 500);
    let b = building(&mut w, "DOME", 4);
    w.actors[b].hp /= 2;
    assert_eq!(sell(&mut w, b), 750, "RefundPercent 100 of 1500 at half health");
}
