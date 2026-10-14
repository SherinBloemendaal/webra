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
    // Clear skies: a lightning strike on a power plant (lightning.rs) would
    // black out the base and hold up the full charge this test counts.
    w.env = crate::weather::Environment::new(w.env.biome, crate::weather::WeatherMode::Off, 17);
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
