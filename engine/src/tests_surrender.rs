//! Surrender (OpenRA's in-game menu Surrender, `Order::Surrender`): the
//! player loses at once like ConquestVictoryConditions' defeat, the game ends
//! when the players left are on one side, every peer and replay agrees, and a
//! mission fails the player's open objectives (MissionObjectives ForceDefeat).

use crate::mission::{MissionResult, ObjectiveState};
use crate::sound_events::{SoundEventKind, EVENT_STRIDE};
use crate::world::{Order, World};
use crate::Game;

fn run(w: &mut World, ticks: u32) {
    for _ in 0..ticks {
        w.step();
    }
}

fn owned(w: &World, p: u8) -> usize {
    w.actors.iter().filter(|a| a.alive && a.owner == p).count()
}

fn three_players() -> World {
    World::new(5, 80, &[("allies", false), ("soviet", false), ("soviet", true)])
}

#[test]
fn surrender_defeats_the_player_and_the_last_side_wins() {
    let mut w = three_players();
    w.sound.set_enabled(true);
    run(&mut w, 10);
    w.sound.take();
    assert!(owned(&w, 1) > 0);
    assert!(w.queue_player_order(Order::Surrender { player: 1 }));
    w.step();
    assert!(w.players[1].defeated, "the surrendering player lost");
    assert_eq!(w.defeated_at(1), Some(w.tick), "defeated this tick (statistics)");
    assert_eq!(owned(&w, 1), 0, "OwnerLostAction: its units and structures are destroyed");
    let lost: Vec<i32> = w.sound.take().chunks(EVENT_STRIDE).filter(|e| e[0] == SoundEventKind::PlayerLost as i32).map(|e| e[4]).collect();
    assert_eq!(lost, vec![1], "the defeat line and notification follow");
    assert!(!w.game_over, "two players are left");
    // A defeated player's later orders are refused, a second surrender too.
    assert!(!w.queue_player_order(Order::Surrender { player: 1 }));

    assert!(w.queue_player_order(Order::Surrender { player: 2 }));
    w.step();
    assert!(w.players[2].defeated);
    assert!(w.game_over, "one side is left");
    assert_eq!(w.winner, Some(0));
    assert!(!w.players[0].defeated);
    // After the game is decided a surrender changes nothing.
    w.queue_player_order(Order::Surrender { player: 0 });
    w.step();
    assert!(!w.players[0].defeated && w.has_won(0));
}

#[test]
fn surrender_is_a_lockstep_order_every_peer_applies_alike() {
    let mut a = Game::wrap(three_players());
    let mut b = Game::wrap(three_players());
    a.set_lockstep(true);
    b.set_lockstep(true);
    for _ in 0..20 {
        a.tick();
        b.tick();
    }
    // Peer b's player 1 surrenders; its outbox goes out as player 1's frame.
    b.surrender(1);
    let orders: serde_json::Value = serde_json::from_str(&b.take_orders()).unwrap();
    assert_eq!(orders, serde_json::json!([{ "o": "surrender", "player": 1 }]));
    let frame = serde_json::json!([[1, orders]]).to_string();
    assert_eq!(a.apply_frame(&frame).unwrap(), 1);
    assert_eq!(b.apply_frame(&frame).unwrap(), 1);
    a.tick();
    b.tick();
    assert!(a.world.players[1].defeated && b.world.players[1].defeated);
    assert_eq!(a.world.state_hash(), b.world.state_hash());
    // The server re-stamps the sender: a surrender sent for someone else defeats the sender.
    let forged = serde_json::json!([[2, [{ "o": "surrender", "player": 0 }]]]).to_string();
    assert_eq!(a.apply_frame(&forged).unwrap(), 1);
    a.tick();
    assert!(a.world.players[2].defeated && !a.world.players[0].defeated);
    assert_eq!(a.world.winner, Some(0));
    // Unknown fields are refused like every order (deny_unknown_fields).
    let extra = serde_json::json!([[0, [{ "o": "surrender", "player": 0, "now": true }]]]).to_string();
    assert_eq!(b.apply_frame(&extra).unwrap(), 0);
}

#[test]
fn surrender_in_a_mission_fails_the_open_objectives() {
    let mut w = crate::tests_mission::start("allies-01", Some("normal"));
    run(&mut w, 30);
    let open = w.mission().unwrap().players[0].objectives.len();
    assert!(open > 0, "the mission gave its objectives");
    assert!(w.queue_player_order(Order::Surrender { player: 0 }));
    w.step();
    let m = w.mission().unwrap();
    assert_eq!(m.error, None);
    assert!(m.players[0].objectives.iter().all(|o| o.state == ObjectiveState::Failed), "ForceDefeat fails every open objective");
    assert_eq!(m.result, MissionResult::Lost);
    assert!(w.players[0].defeated);
}
