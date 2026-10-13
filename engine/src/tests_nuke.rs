//! The atom bomb (OpenRA NukePower on the Missile Silo, weapon Atomic) the
//! way a player gets and uses it: the silo is built through the Defense
//! queue, the power charges for its ChargeInterval and says so, the order
//! goes through the lockstep order queue, the missile leaves the silo after
//! MissileDelay and lands FlightDelay later, and its warheads hurt, clear
//! ore, leave scorch marks, flash and shake the screen.

use crate::rules::Kind;
use crate::sound_events::{SoundEventKind as K, EVENT_STRIDE};
use crate::world::{cell_center, Order, World};

const KEY: &str = "NukePower";

fn ty(w: &World, id: &str) -> u16 {
    w.rules.actor_index(id).unwrap() as u16
}

fn events(w: &mut World) -> Vec<[i32; EVENT_STRIDE]> {
    w.sound.take().chunks(EVENT_STRIDE).map(|c| c.try_into().unwrap()).collect()
}

/// A Soviet base with what the Missile Silo needs (power, a tech center),
/// next to an English base with ore around it. Player 0 builds the silo itself.
fn silo_world() -> World {
    let mut w = World::new(17, 64, &[("russia", false), ("england", false)]);
    w.clear_neutral_world();
    let (sx, sy) = w.players[0].start;
    for (id, dx, dy) in
        [("APWR", 4, 0), ("APWR", 4, 4), ("APWR", 8, 0), ("BARR", 8, 4), ("PROC", -4, 0), ("WEAP", 0, 6), ("DOME", 8, 8), ("STEK", 4, 8)]
    {
        let t = ty(&w, id);
        assert!(w.spawn_building(t, 0, sx + dx, sy + dy).is_some(), "{id}");
    }
    w.players[0].cash = 100_000;
    w.refresh_tokens();
    w.update_power();
    for p in w.players.iter_mut() {
        p.explored.iter_mut().for_each(|e| *e = 1);
    }
    w.sound.set_enabled(true);
    w
}

fn instance(w: &World) -> Option<&crate::powers::PowerInstance> {
    w.power_instances(0).iter().find(|p| p.key == KEY)
}

#[test]
fn the_missile_silo_is_built_charges_and_launches_an_atom_bomb_that_lands() {
    let mut w = silo_world();
    let mslo = ty(&w, "MSLO");
    assert!(w.rules.obtainable[w.players[0].faction][mslo as usize], "the Soviets build the silo");
    // Build and place it like a player (the Defense queue).
    w.queue_order(Order::StartProduction { player: 0, ty: mslo, count: 1 });
    let (sx, sy) = w.players[0].start;
    let mut placed = None;
    for _ in 0..25 * 120 {
        w.step();
        if placed.is_none() && w.players[0].queues[w.rules.actors[mslo as usize].queue as usize].items.first().is_some_and(|it| it.done) {
            'spot: for dy in -2..12 {
                for dx in -6..14 {
                    if w.can_place(0, mslo, sx + dx, sy + dy) {
                        w.queue_order(Order::Place { player: 0, ty: mslo, cx: sx + dx, cy: sy + dy });
                        placed = Some((sx + dx, sy + dy));
                        break 'spot;
                    }
                }
            }
        }
        if (0..w.actors.len()).any(|i| w.actors[i].alive && w.actors[i].ty == mslo) {
            break;
        }
    }
    let silo = (0..w.actors.len()).find(|&i| w.actors[i].alive && w.actors[i].ty == mslo).expect("the silo stands");
    assert_eq!(w.actors[silo].owner, 0);
    w.step();
    // Charging: 13500 ticks (ChargeInterval), "charging" once, then "ready" once.
    let inst = instance(&w).expect("the atom bomb is offered").clone();
    assert_eq!(inst.total, 13500);
    assert!(inst.charging && !inst.ready());
    let mut seen = events(&mut w);
    let mut ticks = 0;
    while !instance(&w).unwrap().ready() {
        w.step();
        seen.extend(events(&mut w));
        ticks += 1;
        assert!(ticks <= 13500, "charged in ChargeInterval");
    }
    assert!(ticks >= 13400, "a full charge, not {ticks} ticks");
    let charging = seen.iter().filter(|e| e[0] == K::PowerCharging as i32 && e[4] == 0).count();
    let ready = seen.iter().filter(|e| e[0] == K::PowerReady as i32 && e[4] == 0).count();
    assert!(charging >= 1 && ready == 1, "charging {charging}, ready {ready}");
    // The enemy base: its Construction Yard, a tank and ore by it.
    let (ex, ey) = w.players[1].start;
    let yard = (0..w.actors.len()).find(|&i| w.actors[i].alive && w.actors[i].owner == 1 && w.actors[i].kind == Kind::Building).unwrap();
    let tank = w.spawn_unit(ty(&w, "2TNK"), 1, cell_center(ex + 3), cell_center(ey + 3), 0);
    let (tx, ty_) = (ex + 1, ey + 1);
    // Ore within three cells of the target (the last DestroyResource clears five).
    let ore_cells: Vec<usize> = (-3..=3)
        .flat_map(|dy| (-3..=3).map(move |dx| (dx, dy)))
        .filter(|&(dx, dy)| dx * dx + dy * dy <= 9)
        .map(|(dx, dy)| w.map.idx(tx + dx, ty_ + dy))
        .collect();
    for &c in &ore_cells {
        if w.building_at[c] == crate::world::NONE {
            w.map.ore[c] = 10;
        }
    }
    let yard_hp = w.actors[yard].hp;
    let tank_ref = w.make_ref(tank);
    // Launch at the yard through the order queue (lockstep, online alike).
    w.queue_order(Order::SupportPower { player: 0, key: KEY.into(), x: cell_center(tx), y: cell_center(ty_), x2: None, y2: None });
    w.step();
    let ev = events(&mut w);
    assert!(ev.iter().any(|e| e[0] == K::PowerActivated as i32 && e[4] == 0), "launched");
    assert_eq!(w.abil.nukes.len(), 1, "a missile");
    let inst = instance(&w).unwrap();
    assert!(inst.remaining >= inst.total - 1, "charging again from empty");
    let n = w.abil.nukes[0].clone();
    assert_eq!(n.launch, n.impact - 400, "FlightDelay 400");
    // In the air: nothing hit yet; the target camera opens before impact.
    while w.tick + 2 < n.impact {
        w.step();
    }
    assert_eq!(w.actors[yard].hp, yard_hp);
    assert!(w.players[0].visible[w.map.idx(tx, ty_)] != 0, "camera over the target");
    let mut impact = Vec::new();
    for _ in 0..40 {
        w.step();
        impact.extend(events(&mut w));
    }
    assert!(w.abil.nukes.is_empty(), "landed");
    assert!(!w.actors[yard].alive || w.actors[yard].hp < yard_hp / 2, "the yard took the blast: {} of {yard_hp}", w.actors[yard].hp);
    assert!(w.resolve(tank_ref).is_none(), "the tank by it is gone");
    assert!(ore_cells.iter().all(|&c| w.map.ore[c] == 0), "DestroyResource cleared the ore");
    assert!(impact.iter().any(|e| e[0] == K::Flash as i32), "the white flash (FlashEffect)");
    assert!(impact.iter().any(|e| e[0] == K::ScreenShake as i32), "the screen shakes (ShakeScreen)");
    assert!(impact.iter().any(|e| e[0] == K::Impact as i32), "the explosion sounds");
}

/// A ready silo of player 0 at its start and the target far away in the
/// enemy's corner, seen by nobody. Returns the world, the silo and the target cell.
fn ready_silo() -> (World, usize, (i32, i32)) {
    let mut w = silo_world();
    let (sx, sy) = w.players[0].start;
    let mslo = ty(&w, "MSLO");
    let silo = (0..3).find_map(|k| w.spawn_building(mslo, 0, sx + 2 + k, sy - 4)).expect("room for the silo");
    w.refresh_tokens();
    w.update_power();
    w.step();
    w.powers.players[0].iter_mut().find(|p| p.key == KEY).expect("the atom bomb is offered").remaining = 0;
    let (ex, ey) = w.players[1].start;
    (w, silo, (ex + 2, ey + 2))
}

/// OpenRA NukeLaunch and NukePower.Activate with Red Alert's numbers
/// (MissileDelay 5, FlightDelay 400, FlightVelocity 512, SpawnOffset
/// 1c0,427,0, CameraRange 10c0, CameraSpawnAdvance and CameraRemoveDelay
/// 25, BeaconRemoveAdvance 25): the effects start the tick after the order;
/// the missile leaves on the sixth, climbs 512 units a tick for 200 ticks,
/// appears 102400 units over the target and falls as fast for 200 ticks.
#[test]
fn the_atom_bomb_flies_like_openras_nuke_launch() {
    let (mut w, silo, (tx, ty_)) = ready_silo();
    let info = w.rules.actors[w.actors[silo].ty as usize]
        .abilities
        .support_powers
        .as_ref()
        .unwrap()
        .iter()
        .find(|p| p.key == KEY)
        .unwrap()
        .clone();
    assert_eq!((info.missile_delay, info.flight_delay, info.flight_velocity), (5, 400, 512));
    assert_eq!((info.spawn_offset.clone(), info.beacon_remove_advance), (vec![1024, 427, 0], 25));
    w.queue_order(Order::SupportPower { player: 0, key: KEY.into(), x: cell_center(tx), y: cell_center(ty_), x2: None, y2: None });
    w.step();
    let order = w.tick;
    let n = w.abil.nukes[0].clone();
    assert_eq!((n.launch, n.impact), (order + 6, order + 406));
    assert_eq!(n.top, 512 * 200);
    // SpawnOffset through LocalToWorld: 427 east, sin(40 deg) * 1024 north.
    assert_eq!((n.sx, n.sy), (w.actors[silo].x + 427, w.actors[silo].y - 654));
    assert_eq!(n.position(order + 5), None, "still in the silo");
    assert_eq!(n.position(order + 6), Some((n.sx, n.sy, 0, false)));
    assert_eq!(n.position(order + 6 + 100), Some((n.sx, n.sy, 51_200, false)));
    assert_eq!(n.position(order + 6 + 199), Some((n.sx, n.sy, 512 * 199, false)));
    assert_eq!(n.position(order + 6 + 200), Some((n.x, n.y, 102_400, true)), "over the target");
    assert_eq!(n.position(order + 6 + 300), Some((n.x, n.y, 51_200, true)));
    assert_eq!(n.position(order + 406), Some((n.x, n.y, 0, true)));
    let target = w.map.idx(tx, ty_);
    let seen = |w: &World| w.players[0].visible[target] != 0;
    let beacon = crate::render::SpriteIds::new(w.rules.actors.len()).abilities_base + 5.0;
    let beacons = |w: &World| {
        let view = crate::render::View { x0: 0.0, y0: 0.0, x1: 64.0 * 24.0, y1: 64.0 * 24.0 };
        let (mut sprites, mut rects) = (Vec::new(), Vec::new());
        w.build_render(0, 1.0, &view, &[], &mut sprites, &mut rects);
        sprites.chunks(crate::render::SPRITE_FLOATS).filter(|c| c[3] == beacon).count()
    };
    assert_eq!(beacons(&w), 1, "the beacon over the target");
    while w.tick < order + 375 {
        w.step();
        assert!(!seen(&w), "no camera yet at {}", w.tick - order);
    }
    assert_eq!(beacons(&w), 1, "the beacon until FlightDelay - BeaconRemoveAdvance");
    // RevealShroudEffect: delay FlightDelay - CameraSpawnAdvance, from the effect's first tick.
    w.step();
    assert!(seen(&w), "the camera opens 376 ticks after the order");
    assert_eq!(beacons(&w), 0, "the beacon is gone");
    while w.tick < order + 405 {
        w.step();
        assert_eq!(w.abil.nukes.len(), 1, "in the air at {}", w.tick - order);
    }
    w.step();
    assert!(w.abil.nukes.is_empty(), "lands 406 ticks after the order");
    while w.tick < order + 425 {
        w.step();
        assert!(seen(&w), "the camera stays 50 ticks, at {}", w.tick - order);
    }
    w.step();
    assert!(!seen(&w), "and closes");
}

/// What the missile looks like: the silo plays its activation animation at
/// the order (WithSupportPowerActivationAnimation), the missile rises with
/// the `up` sprite from the silo and comes down with the `down` sprite, at
/// its height over the ground, moving smoothly between ticks.
#[test]
fn the_silo_opens_and_the_missile_rises_and_falls_with_its_sprites() {
    use crate::fx::{FX_NUKE_DOWN, FX_NUKE_UP};
    use crate::render::{px, SpriteIds, View, SPRITE_FLOATS};
    let (mut w, silo, _) = ready_silo();
    let (tx, ty_) = (w.actors[silo].cx + 12, w.actors[silo].cy + 2);
    // A soldier at the target, so player 0 sees it come down.
    w.spawn_unit(ty(&w, "E1"), 0, cell_center(tx), cell_center(ty_), 0);
    w.render_opts.poses = true;
    w.queue_order(Order::SupportPower { player: 0, key: KEY.into(), x: cell_center(tx), y: cell_center(ty_), x2: None, y2: None });
    w.step();
    let order = w.tick;
    assert_eq!(w.building_pose(silo).0, crate::render::Pose::Active, "the silo opens at the order");
    let ids = SpriteIds::new(w.rules.actors.len());
    let (up, down) = (ids.fx_base + FX_NUKE_UP, ids.fx_base + FX_NUKE_DOWN);
    let missile = |w: &World, alpha: f32| {
        let view = View { x0: -2000.0, y0: -4000.0, x1: 64.0 * 24.0 + 2000.0, y1: 64.0 * 24.0 + 2000.0 };
        let (mut sprites, mut rects) = (Vec::new(), Vec::new());
        w.build_render(0, alpha, &view, &[], &mut sprites, &mut rects);
        let found: Vec<(f32, f32, f32)> =
            sprites.chunks(SPRITE_FLOATS).filter(|c| c[3] == up || c[3] == down).map(|c| (c[0], c[1], c[3])).collect();
        assert!(found.len() <= 1, "{found:?}");
        found.first().copied()
    };
    while w.tick < order + 5 {
        w.step();
        assert_eq!(missile(&w, 1.0), None, "in the silo");
    }
    let n = w.abil.nukes[0].clone();
    w.step();
    assert_eq!(missile(&w, 1.0), Some((px(n.sx), px(n.sy), up)), "out of the silo");
    for _ in 0..10 {
        w.step();
    }
    let j = (w.tick - n.launch) as f32;
    let (x, y, s) = missile(&w, 1.0).unwrap();
    assert_eq!((x, s), (px(n.sx), up));
    assert!((y - (px(n.sy) - px(512) * j)).abs() < 0.01, "12 pixels a tick up: {y}");
    let (_, half, _) = missile(&w, 0.5).unwrap();
    assert!((half - (y + px(512) / 2.0)).abs() < 0.01, "between the ticks: {half}");
    while w.tick < n.launch + 200 {
        w.step();
    }
    let (x, y, s) = missile(&w, 0.0).unwrap();
    assert_eq!((x, y, s), (px(n.x), px(n.y) - px(102_400), down), "turned: high over the target, no streak across the map");
    while w.tick < n.impact - 1 {
        w.step();
    }
    let (x, y, s) = missile(&w, 1.0).unwrap();
    assert_eq!((x, s), (px(n.x), down));
    assert!((y - (px(n.y) - px(512))).abs() < 0.01, "one tick over the ground: {y}");
}

/// OpenRA's Beacon removes itself only for a positive duration (FlightDelay
/// less BeaconRemoveAdvance): with an advance of FlightDelay or more the
/// beacon stays, in WebRA as long as the missile flies.
#[test]
fn a_beacon_advance_past_the_flight_time_keeps_the_beacon_up() {
    use crate::abilities::beacon_until;
    assert_eq!(beacon_until(100, 400, 25), 475);
    assert_eq!(beacon_until(100, 400, -10), 510);
    assert_eq!(beacon_until(100, 400, 399), 101);
    assert_eq!(beacon_until(100, 400, 400), u32::MAX);
    assert_eq!(beacon_until(100, 400, 5000), u32::MAX);
    let (mut w, silo, (tx, ty_)) = ready_silo();
    let t = w.actors[silo].ty as usize;
    for p in w.rules.actors[t].abilities.support_powers.as_mut().unwrap().iter_mut().filter(|p| p.key == KEY) {
        p.beacon_remove_advance = p.flight_delay;
    }
    w.queue_order(Order::SupportPower { player: 0, key: KEY.into(), x: cell_center(tx), y: cell_center(ty_), x2: None, y2: None });
    w.step();
    let beacon = crate::render::SpriteIds::new(w.rules.actors.len()).abilities_base + 5.0;
    let beacons = |w: &World| {
        let view = crate::render::View { x0: 0.0, y0: 0.0, x1: 64.0 * 24.0, y1: 64.0 * 24.0 };
        let (mut sprites, mut rects) = (Vec::new(), Vec::new());
        w.build_render(0, 1.0, &view, &[], &mut sprites, &mut rects);
        sprites.chunks(crate::render::SPRITE_FLOATS).filter(|c| c[3] == beacon).count()
    };
    let impact = w.abil.nukes[0].impact;
    while w.tick + 1 < impact {
        assert_eq!(beacons(&w), 1, "shown at {}", w.tick);
        w.step();
    }
    assert_eq!(beacons(&w), 1);
    w.step();
    assert!(w.abil.nukes.is_empty());
    assert_eq!(beacons(&w), 0, "gone with the missile");
}
