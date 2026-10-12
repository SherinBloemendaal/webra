//! Replays, snapshots, observer statistics and the spectator view (observer.rs).

use crate::observer::OBSERVER;
use crate::render::SPRITE_FLOATS;
use crate::rules::{Kind, QueueType};
use crate::world::{cell_center, Order, PlayerSetup, World, MAX_WEAPONS};
use crate::Game;

/// One network frame: the tick it is queued at (before `step`) and the
/// orders per player.
type Frame = (u32, Vec<(u8, Vec<Order>)>);

const REPLAY_TICKS: u32 = 1500;
const SNAPSHOT_TICK: u32 = 600;

fn ty(w: &World, id: &str) -> u16 {
    w.rules.actor_index(id).unwrap() as u16
}

fn run(w: &mut World, ticks: u32) {
    for _ in 0..ticks {
        w.step();
    }
}

/// JSON round trip, as the client and replay files carry orders.
fn round_trip(o: &Order) -> Order {
    serde_json::from_str(&serde_json::to_string(o).unwrap()).unwrap()
}

/// Two humans and one AI.
fn replay_world() -> World {
    World::new(11, 80, &[("allies", false), ("soviet", false), ("soviet", true)])
}

fn own_units(w: &World, p: u8) -> Vec<u32> {
    (0..w.actors.len())
        .filter(|&i| {
            let a = &w.actors[i];
            a.alive && a.owner == p && a.is_unit() && a.in_world() && !w.is_harvester(i)
        })
        .map(|i| w.make_ref(i))
        .collect()
}

fn own_building(w: &World, p: u8, id: &str) -> Option<usize> {
    let t = ty(w, id);
    (0..w.actors.len()).find(|&i| w.actors[i].alive && w.actors[i].owner == p && w.actors[i].ty == t)
}

/// Orders a scripted human player gives before the next tick, decided from
/// the current state like a person looking at the screen.
fn script(w: &World, p: u8) -> Vec<Order> {
    let t = w.tick;
    let pl = &w.players[p as usize];
    let (sx, sy) = pl.start;
    let barracks = if pl.side == 0 { "TENT" } else { "BARR" };
    let mut out = Vec::new();
    let building_queue = &pl.queues[QueueType::Building as usize].items;
    if let Some(item) = building_queue.first().filter(|it| it.done) {
        let spot = (sx - 6..sx + 8).flat_map(|x| (sy - 6..sy + 8).map(move |y| (x, y))).find(|&(x, y)| w.can_place(p, item.ty, x, y));
        if let Some((cx, cy)) = spot {
            out.push(Order::Place { player: p, ty: item.ty, cx, cy });
        }
    } else if building_queue.is_empty() {
        if own_building(w, p, "POWR").is_none() {
            out.push(Order::StartProduction { player: p, ty: ty(w, "POWR"), count: 1 });
        } else if own_building(w, p, barracks).is_none() {
            out.push(Order::StartProduction { player: p, ty: ty(w, barracks), count: 1 });
        }
    }
    if own_building(w, p, barracks).is_some() && pl.queues[QueueType::Infantry as usize].items.len() < 2 && t.is_multiple_of(50) {
        out.push(Order::StartProduction { player: p, ty: ty(w, "E1"), count: 3 });
    }
    if let Some(b) = own_building(w, p, barracks) {
        if t % 300 == 7 {
            out.push(Order::Rally { player: p, building: w.make_ref(b), x: cell_center(sx + 2), y: cell_center(sy + 6) });
        }
    }
    let units = own_units(w, p);
    let enemy = 1 - p;
    let (ex, ey) = w.players[enemy as usize].start;
    if !units.is_empty() {
        match (t + p as u32 * 37) % 200 {
            0 if t < 900 => {
                out.push(Order::Move { player: p, ids: units.clone(), x: cell_center(sx + 3), y: cell_center(sy + 8), attack_move: false })
            }
            0 => out.push(Order::Move { player: p, ids: units.clone(), x: cell_center(ex), y: cell_center(ey), attack_move: true }),
            100 if t > 600 => {
                if let Some(target) = own_building(w, enemy, "FACT") {
                    out.push(Order::Attack { player: p, ids: units.clone(), target: w.make_ref(target) });
                }
            }
            150 => out.push(Order::Smart { player: p, ids: units.clone(), x: cell_center(sx + 1), y: cell_center(sy + 9) }),
            _ => {}
        }
        if t == 1200 {
            out.push(Order::Stop { player: p, ids: units[..units.len() / 2].to_vec() });
        }
    }
    if p == 1 && t == 1300 {
        if let Some(b) = own_building(w, p, "POWR") {
            out.push(Order::Sell { player: p, building: w.make_ref(b) });
        }
    }
    // Sidebar buttons (repair.rs, beacons.rs): repair the Construction Yard
    // once it is damaged, switch a structure off and on, mark a spot.
    if t == 900 {
        if let Some(b) = own_building(w, p, "FACT") {
            out.push(Order::RepairBuilding { player: p, building: w.make_ref(b) });
        }
        out.push(Order::PlaceBeacon { player: p, x: cell_center(10), y: cell_center(12) });
    }
    // Orders for things that do not exist are harmless and recorded too.
    if t == 333 {
        out.push(Order::Move { player: p, ids: vec![0xDEAD_BEEF], x: 5, y: 5, attack_move: false });
    }
    out
}

/// Play the scripted game and record its frames and the state hash after
/// every tick (`hashes[t]` is the hash at tick `t`).
fn record() -> (Vec<Frame>, Vec<u64>) {
    let mut w = replay_world();
    let mut frames = Vec::new();
    let mut hashes = vec![w.state_hash()];
    while w.tick < REPLAY_TICKS {
        let frame: Vec<(u8, Vec<Order>)> =
            (0..2u8).map(|p| (p, script(&w, p).iter().map(round_trip).collect::<Vec<_>>())).filter(|(_, o)| !o.is_empty()).collect();
        for (_, orders) in &frame {
            for o in orders {
                w.queue_order(o.clone());
            }
        }
        if !frame.is_empty() {
            frames.push((w.tick, frame));
        }
        w.step();
        hashes.push(w.state_hash());
    }
    (frames, hashes)
}

/// Feed a game the recorded frames up to tick `until`, the way the client
/// does: `apply_frame` with the frame as JSON, then `tick`. Checks the hash
/// after every tick.
fn replay_until(g: &mut Game, frames: &[Frame], hashes: &[u64], until: u32) {
    while g.world.tick < until {
        if let Some((_, frame)) = frames.iter().find(|(t, _)| *t == g.world.tick) {
            let json = serde_json::to_string(frame).unwrap();
            let queued = g.apply_frame(&json).unwrap();
            assert_eq!(queued as usize, frame.iter().map(|(_, o)| o.len()).sum::<usize>());
        }
        g.tick();
        let t = g.world.tick;
        assert_eq!(g.world.state_hash(), hashes[t as usize], "replay desync at tick {t}");
    }
}

#[test]
fn replay_of_recorded_frames_reproduces_every_tick() {
    let (frames, hashes) = record();
    // The script did play: buildings, infantry and a sale went through.
    let kinds: Vec<&str> = frames
        .iter()
        .flat_map(|(_, f)| f.iter().flat_map(|(_, o)| o.iter()))
        .map(|o| match o {
            Order::Place { .. } => "place",
            Order::StartProduction { .. } => "produce",
            Order::Move { .. } => "move",
            Order::Attack { .. } => "attack",
            Order::Sell { .. } => "sell",
            Order::RepairBuilding { .. } => "repair",
            Order::PlaceBeacon { .. } => "beacon",
            _ => "other",
        })
        .collect();
    for k in ["place", "produce", "move", "attack", "sell", "repair", "beacon"] {
        assert!(kinds.contains(&k), "script issued a {k} order");
    }
    let mut g = Game::wrap(replay_world());
    assert_eq!(g.world.state_hash(), hashes[0]);
    replay_until(&mut g, &frames, &hashes, REPLAY_TICKS);
    assert!(g.world.actors.iter().any(|a| a.alive && a.owner == 0 && a.kind == Kind::Infantry), "player 0 trained infantry");
}

#[test]
fn snapshots_continue_like_the_original_and_restore_rewinds() {
    let (frames, hashes) = record();
    let mut g = Game::wrap(replay_world());
    g.set_lockstep(true);
    replay_until(&mut g, &frames, &hashes, SNAPSHOT_TICK);
    // Plain clone of the world.
    let mut copy = g.world.clone();
    assert_eq!(copy.state_hash(), hashes[SNAPSHOT_TICK as usize]);
    // Game snapshot: same world, empty outbox and buffers, same lockstep flag.
    g.order_stop(0, vec![1]); // lands in the outbox (lockstep)
    let snap = g.snapshot();
    assert!(snap.outbox.is_empty() && snap.sprites.is_empty() && snap.lockstep);
    assert_eq!(snap.world.tick, SNAPSHOT_TICK);
    assert_eq!(snap.world.state_hash(), hashes[SNAPSHOT_TICK as usize]);

    // The original goes on unchanged by the copies.
    replay_until(&mut g, &frames, &hashes, REPLAY_TICKS);
    assert_eq!(snap.world.state_hash(), hashes[SNAPSHOT_TICK as usize], "snapshot untouched by the original");

    // The cloned world, fed the same frames, matches tick for tick.
    while copy.tick < REPLAY_TICKS {
        if let Some((_, frame)) = frames.iter().find(|(t, _)| *t == copy.tick) {
            for (p, orders) in frame {
                for o in orders {
                    let mut o = round_trip(o);
                    o.set_player(*p);
                    copy.queue_order(o);
                }
            }
        }
        copy.step();
        assert_eq!(copy.state_hash(), hashes[copy.tick as usize], "clone desync at tick {}", copy.tick);
    }

    // Restore rewinds the game to the snapshot; the snapshot stays as it was.
    g.world.terrain_dirty = false;
    g.restore(&snap);
    assert_eq!(g.world.tick, SNAPSHOT_TICK);
    assert_eq!(g.world.state_hash(), hashes[SNAPSHOT_TICK as usize]);
    assert!(g.world.terrain_dirty, "terrain uploads again after a restore");
    assert!(g.outbox.is_empty(), "restore clears the outbox");
    assert_eq!(g.take_orders(), "[]");
    replay_until(&mut g, &frames, &hashes, REPLAY_TICKS);
    assert_eq!(snap.world.state_hash(), hashes[SNAPSHOT_TICK as usize], "snapshot untouched by the restored game");
}

// ---- Observer statistics -------------------------------------------------------------

/// 64x64 open map, no ore; players 0 and 2 are allies (team 1), player 1 the enemy.
fn stats_world() -> World {
    let players: Vec<PlayerSetup> = [("allies", 1u8), ("soviet", 2), ("england", 1)]
        .iter()
        .map(|&(f, t)| PlayerSetup { faction: f.into(), ai: None, bot: Default::default(), team: t, handicap: 0, spawn: None })
        .collect();
    let mut w = World::with_options(5, 64, &players, crate::world::GameOptions::default());
    w.clear_neutral_world();
    for i in 0..w.map.cells() {
        w.map.terrain[i] = crate::map::Terrain::Clear;
        w.map.ore[i] = 0;
    }
    w.pass = crate::flowfield::Passability::new(&w.map);
    w.pass_water = crate::flowfield::Passability::water(&w.map);
    w.pass_landing = crate::flowfield::Passability::landing(&w.map);
    for b in 0..w.building_at.len() {
        if w.building_at[b] != crate::world::NONE {
            w.pass.set_blocked(b, true);
        }
    }
    w.pass.refresh(&w.map);
    w.options.ore_regrowth = false;
    w
}

fn unit(w: &mut World, id: &str, owner: u8, cx: i32, cy: i32) -> usize {
    let t = ty(w, id);
    w.spawn_unit(t, owner, cell_center(cx), cell_center(cy), 0)
}

fn stats_json(w: &World) -> Vec<serde_json::Value> {
    let g = Game::wrap(w.clone());
    serde_json::from_str(&g.observer_stats()).unwrap()
}

#[test]
fn observer_stats_count_kills_losses_and_income() {
    let mut w = stats_world();
    // Player 1's soldiers (they never fire) and a power plant near (30, 30).
    let victims: Vec<usize> = (0..3)
        .map(|k| {
            let u = unit(&mut w, "E1", 1, 30 + k, 34);
            w.actors[u].reload = [1_000_000; MAX_WEAPONS];
            u
        })
        .collect();
    let enemy_powr = w.spawn_building(ty(&w, "POWR"), 1, 30, 30).unwrap();
    let tanks: Vec<usize> = (0..4).map(|k| unit(&mut w, "2TNK", 0, 24 + k, 38)).collect();
    let own_rifle = unit(&mut w, "E1", 0, 10, 50);
    let ally_rifle = unit(&mut w, "E1", 2, 12, 50);
    let own_powr = w.spawn_building(ty(&w, "POWR"), 0, 6, 54).unwrap();
    let mine = unit(&mut w, "MINV", 1, 20, 50);
    let truck = unit(&mut w, "TRUK", 0, 3, 50);
    w.rebuild_hash();
    w.update_vision();
    let refs = |w: &World, v: &[usize]| v.iter().map(|&u| w.make_ref(u)).collect::<Vec<u32>>();

    // The supply truck delivers to the own power plant: income.
    let (tx, ty_) = (w.actors[own_powr].x, w.actors[own_powr].y);
    w.queue_order(Order::Smart { player: 0, ids: refs(&w, &[truck]), x: tx, y: ty_ });
    // The tanks shoot the soldiers, then the power plant.
    for &v in &victims {
        w.queue_order(Order::Attack { player: 0, ids: refs(&w, &tanks), target: w.make_ref(v) });
        run(&mut w, 25 * 8);
        assert!(!w.actors[v].alive, "soldier killed");
    }
    w.queue_order(Order::Attack { player: 0, ids: refs(&w, &tanks), target: w.make_ref(enemy_powr) });
    run(&mut w, 25 * 40);
    assert!(!w.actors[enemy_powr].alive, "power plant destroyed");
    assert!(!w.actors[truck].alive, "truck used up");

    // Player 0's weapons killing its own and an allied unit, and an enemy mine: no kills.
    w.with_damage_source(0, |w| {
        w.kill(own_rifle);
        w.kill(ally_rifle);
        w.kill(mine);
    });
    // Selling is not a loss.
    w.queue_order(Order::Sell { player: 0, building: w.make_ref(own_powr) });
    run(&mut w, 25 * 3);
    assert!(!w.actors[own_powr].alive, "sold");

    let s0 = w.player_stats(0);
    let s1 = w.player_stats(1);
    let s2 = w.player_stats(2);
    assert_eq!((s0.units_killed, s0.buildings_killed), (3, 1), "player 0 kills");
    assert_eq!((s0.units_lost, s0.buildings_lost), (1, 0), "player 0 lost its own soldier, the sale does not count");
    assert_eq!((s1.units_lost, s1.buildings_lost), (3, 1), "player 1 losses (mines do not count)");
    assert_eq!((s1.units_killed, s1.buildings_killed), (0, 0));
    assert_eq!((s2.units_lost, s2.units_killed), (1, 0), "allied loss, no kill for anyone");
    assert_eq!(s0.earned, 500, "supply truck payload");

    // A death without an attacker (cheat kill, crash) is a loss only.
    let lone = unit(&mut w, "E1", 1, 40, 10);
    w.kill(lone);
    assert_eq!(w.player_stats(1).units_lost, 4);
    assert_eq!(w.player_stats(0).units_killed, 3);

    // The JSON for the observer panel.
    let json = stats_json(&w);
    assert_eq!(json.len(), 3);
    let p0 = &json[0];
    assert_eq!(p0["player"], 0);
    assert_eq!(p0["faction"], "allies");
    assert_eq!(p0["team"], 1);
    assert_eq!(p0["unitsKilled"], 3);
    assert_eq!(p0["unitsLost"], 1);
    assert_eq!(p0["buildingsKilled"], 1);
    assert_eq!(p0["buildingsLost"], 0);
    assert_eq!(p0["earned"], 500);
    assert_eq!(p0["cash"], w.players[0].cash);
    assert_eq!(p0["funds"], w.players[0].funds());
    let tank_cost = i64::from(w.rules.actors[ty(&w, "2TNK") as usize].cost);
    let alive_tanks = tanks.iter().filter(|&&t| w.actors[t].alive).count() as i64;
    // The sold power plant's crew walked out (sell.rs): riflemen.
    let crew: i64 = w
        .actors
        .iter()
        .filter(|a| a.alive && a.owner == 0 && a.kind == Kind::Infantry)
        .map(|a| i64::from(w.rules.actors[a.ty as usize].cost))
        .sum();
    assert!(crew > 0, "a crew left the sold plant");
    assert_eq!(p0["armyValue"], alive_tanks * tank_cost + crew, "tanks and the crew: no structures, no used-up truck");
    for key in ["powerGenerated", "powerUsed", "defeated", "won"] {
        assert!(p0.get(key).is_some(), "{key} present");
    }
}

#[test]
fn observer_stats_shot_down_plane_counts_at_impact() {
    let mut w = stats_world();
    let yak = unit(&mut w, "YAK", 1, 30, 30);
    assert!(w.actors[yak].altitude > 0, "flying");
    w.with_damage_source(0, |w| w.kill(yak));
    assert!(w.actors[yak].alive, "falling");
    assert_eq!(w.player_stats(1).units_lost, 0, "counts when it hits the ground");
    run(&mut w, 25 * 10);
    assert!(!w.actors[yak].alive, "crashed");
    assert_eq!(w.player_stats(1).units_lost, 1);
    assert_eq!(w.player_stats(0).units_killed, 1, "credited to the player that shot it down");
}

#[test]
fn observer_stats_earned_grows_when_harvesters_unload() {
    let mut w = World::new(3, 80, &[("allies", false), ("soviet", false)]);
    let (sx, sy) = w.players[0].start;
    w.spawn_building(ty(&w, "POWR"), 0, sx + 4, sy);
    w.spawn_building(ty(&w, "PROC"), 0, sx, sy + 5);
    w.refresh_tokens();
    let start = w.players[0].funds();
    assert_eq!(w.player_stats(0).earned, 0);
    run(&mut w, 25 * 90);
    let earned = w.player_stats(0).earned;
    assert!(earned >= 500, "at least one load: {earned}");
    assert_eq!(earned, i64::from(w.players[0].funds() - start), "all income came from the harvester");
    assert_eq!(w.player_stats(1).earned, 0);
}

// ---- Spectator view ------------------------------------------------------------------

fn sprites(g: &Game) -> Vec<&[f32]> {
    g.sprites.chunks(SPRITE_FLOATS).collect()
}

#[test]
fn observer_view_shows_the_whole_map() {
    let mut w = World::new(5, 80, &[("allies", false), ("soviet", false)]);
    let (ex, ey) = w.players[1].start;
    let tank = unit(&mut w, "3TNK", 1, ex + 2, ey + 6);
    let (sx, sy) = w.players[0].start;
    let fact = own_building(&w, 0, "FACT").unwrap();
    w.actors[fact].rally = Some((cell_center(sx + 3), cell_center(sy + 3)));
    w.rebuild_hash();
    w.update_vision();
    assert!(!w.is_visible_to(tank, 0), "player 0 cannot see the enemy tank");
    let body = (w.actors[tank].ty * 2) as f32;
    let rally = crate::render::SpriteIds::new(w.rules.actors.len()).rally;
    let mut g = Game::wrap(w);
    g.set_selection(vec![g.world.make_ref(fact)]);
    let size = 80.0 * crate::render::PX_PER_CELL;
    let has = |g: &Game, sprite: f32, team: f32| sprites(g).iter().any(|s| s[3] == sprite && s[4] == team);

    g.build_render(0, 1.0, 0.0, 0.0, size, size);
    assert!(!has(&g, body, 1.0), "hidden from player 0");
    assert!(has(&g, rally, 0.0), "player 0 sees its own rally point");

    assert_eq!(Game::observer_player(), OBSERVER);
    g.build_render(OBSERVER, 1.0, 0.0, 0.0, size, size);
    assert!(!g.world.render_all, "flag cleared after the call");
    assert!(has(&g, body, 1.0), "observer sees the enemy tank");
    let enemy_fact = (ty(&g.world, "FACT") * 2) as f32;
    assert!(has(&g, enemy_fact, 1.0), "and the enemy base");
    assert!(!has(&g, rally, 0.0), "no owner-only decorations");

    g.fog_ptr(OBSERVER);
    assert_eq!(g.fog.len(), g.world.map.cells());
    assert!(g.fog.iter().all(|&f| f == 255), "whole map visible");
    g.fog_ptr(0);
    assert!(g.fog.iter().any(|&f| f != 255), "player 0 still has fog");

    // The simulation is unaffected: player 0 still cannot see or target the tank.
    let hash = g.world.state_hash();
    g.tick();
    assert!(!g.world.is_visible_to(tank, 0));
    g.build_render(0, 1.0, 0.0, 0.0, size, size);
    assert!(!has(&g, body, 1.0), "the observer view did not leak into player 0's view");
    // Observer rendering between ticks does not change the course of the game.
    let mut plain = g.world.clone();
    for _ in 0..50 {
        plain.step();
        g.build_render(OBSERVER, 0.5, 0.0, 0.0, size, size);
        g.tick();
    }
    assert_eq!(plain.state_hash(), g.world.state_hash());
    assert_ne!(plain.state_hash(), hash, "the game went on");
}

// ---- Presentation never changes the game ------------------------------------------------

/// Everything a client does besides applying its frames is presentation:
/// the selection, the hovered actor, control groups, health bars, sprite
/// poses (original art), building overlays, sound events, and building the
/// frame for any view (its own, another player's, all players' together, the
/// observer's). Two lockstep peers with different screens, settings and
/// installed art must stay in step: none of it may change the state hash.
#[test]
fn presentation_state_never_changes_the_simulation() {
    use crate::combined::COMBINED;
    use crate::world::NONE;
    let (frames, hashes) = record();
    let mut plain = Game::wrap(replay_world());
    let mut busy = Game::wrap(replay_world());
    busy.set_audio_events(true);
    busy.set_health_bars(2);
    busy.set_sprite_poses(true);
    let types = busy.world.rules.actors.len();
    busy.set_building_overlays(vec![1; types]);
    let size = 80.0 * crate::render::PX_PER_CELL;
    let mut events = 0;
    while plain.world.tick < SNAPSHOT_TICK {
        let t = plain.world.tick;
        if let Some((_, frame)) = frames.iter().find(|(ft, _)| *ft == t) {
            let json = serde_json::to_string(frame).unwrap();
            plain.apply_frame(&json).unwrap();
            busy.apply_frame(&json).unwrap();
        }
        // The busy peer looks around between ticks like a player's screen does.
        let units = own_units(&busy.world, (t % 2) as u8);
        busy.set_selection(units.clone());
        busy.set_hover(units.first().copied().unwrap_or(NONE));
        busy.set_control_groups(units.clone(), units.iter().map(|_| (t % 10) as u8).collect());
        if t.is_multiple_of(7) {
            busy.set_health_bars((t % 3) as u8);
            busy.set_sprite_poses(t.is_multiple_of(2));
        }
        for view in [0u8, 1, COMBINED, OBSERVER] {
            busy.build_render(view, 0.5, 0.0, 0.0, size, size);
            busy.build_render_records(view);
            busy.fog_ptr(view);
            busy.build_lines(view, 0.5, true, None);
            busy.build_heat_fx(view, 0.0, 0.0, size, size);
        }
        events += busy.take_audio_events().len();
        let _ = busy.player_json(0);
        let _ = busy.observer_stats();
        plain.tick();
        busy.tick();
        let tick = plain.world.tick;
        assert_eq!(busy.world.state_hash(), plain.world.state_hash(), "presentation changed the game at tick {tick}");
        assert_eq!(plain.world.state_hash(), hashes[tick as usize], "the plain peer follows the recording at tick {tick}");
    }
    assert!(events > 0, "the busy peer did take sound events");
}

// ---- Online saves ----------------------------------------------------------------------

/// An online save is the frames before its save point (the tick after a hash
/// tick) and the state hash every player agreed on there. A peer rebuilt
/// from it (as every client of a resumed game is) reaches that hash and
/// then plays on in step with a peer that never stopped, frame for frame.
#[test]
fn online_save_resumes_in_step_with_the_original() {
    let (frames, hashes) = record();
    // Saved after frame 500, a multiple of the protocol's hash interval (25).
    let save_ticks: u32 = 501;
    let saved: Vec<Frame> = frames.iter().filter(|(t, _)| *t < save_ticks).cloned().collect();
    assert!(saved.len() < frames.len(), "orders came after the save point too");
    let mut original = Game::wrap(replay_world());
    replay_until(&mut original, &frames, &hashes, save_ticks);
    let mut resumed = Game::wrap(replay_world());
    replay_until(&mut resumed, &saved, &hashes, save_ticks);
    assert_eq!(resumed.world.state_hash(), original.world.state_hash(), "the resumed peer has the saved state");
    assert_eq!(resumed.state_hash(), format!("{:016x}", hashes[save_ticks as usize]), "the hash players compare at the save point");
    // After the save point both run the same frames and stay identical.
    while original.world.tick < REPLAY_TICKS {
        let t = original.world.tick;
        if let Some((_, frame)) = frames.iter().find(|(ft, _)| *ft == t) {
            let json = serde_json::to_string(frame).unwrap();
            original.apply_frame(&json).unwrap();
            resumed.apply_frame(&json).unwrap();
        }
        original.tick();
        resumed.tick();
        let tick = original.world.tick;
        assert_eq!(resumed.world.state_hash(), original.world.state_hash(), "the resumed game left the original at tick {tick}");
        assert_eq!(original.world.state_hash(), hashes[tick as usize]);
    }
}
