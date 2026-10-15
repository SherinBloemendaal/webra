//! The top-left support power timers (OpenRA SupportPowerTimerWidget,
//! powers.rs `power_timers`): which countdowns a viewer sees by the power's
//! DisplayTimerRelationships, and when one shows, pauses or goes away.

use crate::world::{Relationship, World};

fn ty(w: &World, id: &str) -> u16 {
    w.rules.actor_index(id).unwrap() as u16
}

/// Three players: 0 and 1 on one team, 2 on its own, each with plenty of
/// power. Every actor of the neutral player is gone.
fn world() -> World {
    let mut w = World::new(23, 96, &[("russia", false), ("england", false), ("ukraine", false)]);
    w.clear_neutral_world();
    w.players[0].team = 1;
    w.players[1].team = 1;
    for p in 0..3u8 {
        let (sx, sy) = w.players[p as usize].start;
        for dx in [0, 3, 6] {
            assert!(w.spawn_building(ty(&w, "APWR"), p, sx + dx, sy + 6).is_some());
        }
    }
    w.refresh_tokens();
    w.update_power();
    w
}

/// Place a structure of `owner` on the first free spot from `dx` cells right
/// of its start position (the start area holds its power plants).
fn build(w: &mut World, id: &str, owner: u8, dx: i32) -> usize {
    let (sx, sy) = w.players[owner as usize].start;
    let t = ty(w, id);
    let i = (-8..8)
        .flat_map(|dy| (0..12).map(move |x| (dx + x, dy)))
        .find_map(|(x, y)| w.spawn_building(t, owner, sx + x, sy + y))
        .unwrap_or_else(|| panic!("{id} placed"));
    w.refresh_tokens();
    w.update_power();
    i
}

fn run(w: &mut World, ticks: u32) {
    for _ in 0..ticks {
        w.step();
    }
}

/// `(owner, key)` of what `viewer` sees.
fn seen(w: &World, viewer: Option<u8>) -> Vec<(u8, String)> {
    w.power_timers(viewer).into_iter().map(|t| (t.player, t.key)).collect()
}

#[test]
fn the_rules_show_only_the_atom_bomb_and_gps_timers_to_everyone() {
    let w = world();
    let shown = |id: &str| -> Vec<Vec<String>> {
        let a = &w.rules.actors[ty(&w, id) as usize];
        a.abilities.support_powers.as_ref().unwrap().iter().map(|p| p.display_timer.clone()).collect()
    };
    let all = vec!["ally".to_string(), "neutral".to_string(), "enemy".to_string()];
    // data/source/rules/structures.yaml: NukePower and GpsPower have DisplayTimerRelationships: Ally, Neutral, Enemy.
    assert_eq!(shown("MSLO"), vec![all.clone()]);
    assert_eq!(shown("ATEK"), vec![all]);
    // The rest keeps OpenRA's default (None): no timer, not even for the owner.
    for id in ["IRON", "PDOX", "AFLD"] {
        assert!(shown(id).iter().all(|d| d.is_empty()), "{id}");
    }
}

#[test]
fn every_player_sees_a_superweapon_countdown_of_its_own_allies_and_enemies() {
    let mut w = world();
    build(&mut w, "MSLO", 2, 0);
    build(&mut w, "ATEK", 0, 0);
    // Powers that show no timer stay off the list, also for their owner.
    build(&mut w, "IRON", 1, 0);
    build(&mut w, "AFLD", 0, 4);
    run(&mut w, 10);
    let expect = vec![(0, "GpsPower".to_string()), (2, "NukePower".to_string())];
    for viewer in [Some(0), Some(1), Some(2), None] {
        assert_eq!(seen(&w, viewer), expect, "viewer {viewer:?}");
    }
    // The power bar still has them (player_json powers).
    assert!(w.power_instances(1).iter().any(|p| w.power_info(p).kind == "GrantExternalConditionPower"));

    let t = w.power_timers(Some(0)).into_iter().find(|t| t.player == 2).unwrap();
    assert_eq!(t.name, "Atom Bomb");
    assert!(!t.ready);
    let inst = w.power_instances(2).iter().find(|p| p.key == "NukePower").unwrap();
    assert_eq!(t.remaining, inst.remaining);
    assert_eq!(inst.total - inst.remaining, 10, "it charges a tick per tick");
}

#[test]
fn display_timer_relationships_decide_by_the_owners_relationship_to_the_viewer() {
    let mut w = world();
    assert_eq!(w.relationship(0, 0), Relationship::Ally);
    assert_eq!(w.relationship(0, 1), Relationship::Ally);
    assert_eq!(w.relationship(0, 2), Relationship::Enemy);
    let neutral = (w.players.len() - 1) as u8;
    assert!(w.players[neutral as usize].neutral);
    assert_eq!(w.relationship(0, neutral), Relationship::Neutral);

    build(&mut w, "MSLO", 0, 0);
    run(&mut w, 2);
    let mslo = ty(&w, "MSLO") as usize;
    let set = |w: &mut World, rels: &[&str]| {
        w.rules.actors[mslo].abilities.support_powers.as_mut().unwrap()[0].display_timer = rels.iter().map(|r| r.to_string()).collect();
    };
    let viewers =
        |w: &World| -> Vec<bool> { [Some(0), Some(1), Some(2), Some(neutral), None].iter().map(|&v| !seen(w, v).is_empty()).collect() };
    // soviet-13a's GPS: Ally (the owner and its team).
    set(&mut w, &["ally"]);
    assert_eq!(viewers(&w), [true, true, false, false, true]);
    set(&mut w, &["enemy"]);
    assert_eq!(viewers(&w), [false, false, true, false, true]);
    // allies-10a and situation-critical hide the enemy silo's timer: Neutral.
    set(&mut w, &["neutral"]);
    assert_eq!(viewers(&w), [false, false, false, true, true]);
    set(&mut w, &[]);
    assert_eq!(viewers(&w), [false, false, false, false, false]);
}

#[test]
fn a_paused_timer_stays_listed_and_a_charged_but_paused_power_is_not_ready() {
    let mut w = world();
    let silo = build(&mut w, "MSLO", 2, 0);
    run(&mut w, 5);
    // Switched off (PauseOnCondition: disabled): the countdown stops but stays.
    w.actors[silo].powered_off = true;
    w.update_power();
    run(&mut w, 1);
    let before = w.power_timers(Some(0))[0].remaining;
    run(&mut w, 30);
    let t = &w.power_timers(Some(0))[0];
    assert_eq!(t.remaining, before);
    assert!(!t.ready);

    // Charged: ready while powered, not while paused (OpenRA Ready = Active && RemainingTicks == 0).
    w.actors[silo].powered_off = false;
    w.update_power();
    w.powers.players[2][0].remaining = 1;
    run(&mut w, 2);
    assert!(w.power_timers(Some(0))[0].ready);
    assert_eq!(w.power_timers(Some(0))[0].remaining, 0);
    w.actors[silo].powered_off = true;
    w.update_power();
    run(&mut w, 1);
    assert!(!w.power_timers(Some(0))[0].ready);
}

#[test]
fn the_timer_goes_with_the_last_provider_the_owners_defeat_and_a_used_one_shot_power() {
    let mut w = world();
    let a = build(&mut w, "MSLO", 2, 0);
    let b = build(&mut w, "MSLO", 2, 4);
    run(&mut w, 3);
    // Two silos, one timer.
    assert_eq!(seen(&w, Some(0)), vec![(2, "NukePower".to_string())]);
    w.kill(a);
    run(&mut w, 1);
    assert_eq!(seen(&w, Some(0)).len(), 1);
    w.kill(b);
    run(&mut w, 1);
    assert!(seen(&w, Some(0)).is_empty());

    // A defeated owner's timers go (OpenRA: Disabled once the owner lost).
    build(&mut w, "MSLO", 2, 0);
    run(&mut w, 1);
    assert_eq!(seen(&w, Some(0)).len(), 1);
    w.players[2].defeated = true;
    assert!(seen(&w, Some(0)).is_empty());
    assert!(seen(&w, None).is_empty());

    // The GPS satellite launches itself when charged and then is gone for good (OneShot).
    build(&mut w, "ATEK", 0, 0);
    run(&mut w, 1);
    assert_eq!(seen(&w, Some(2)), vec![(0, "GpsPower".to_string())]);
    w.powers.players[0].iter_mut().for_each(|p| p.remaining = 1);
    run(&mut w, 5);
    assert!(seen(&w, Some(2)).is_empty(), "spent");
}

#[test]
fn neutral_players_have_no_timers() {
    let mut w = world();
    let neutral = (w.players.len() - 1) as u8;
    let (sx, sy) = w.players[0].start;
    let t = ty(&w, "MSLO");
    assert!(w.spawn_building(t, neutral, sx + 12, sy + 12).is_some());
    run(&mut w, 2);
    assert!(w.power_instances(neutral).iter().any(|p| p.key == "NukePower"), "it has the power");
    assert!(seen(&w, None).is_empty());
    assert!(seen(&w, Some(0)).is_empty());
}

#[test]
fn the_wasm_query_lists_the_viewers_timers() {
    let mut w = world();
    build(&mut w, "MSLO", 2, 0);
    run(&mut w, 1);
    let g = crate::Game::wrap(w);
    let v: serde_json::Value = serde_json::from_str(&g.power_timers_json(0)).unwrap();
    assert_eq!(v[0]["player"], 2);
    assert_eq!(v[0]["key"], "NukePower");
    assert_eq!(v[0]["name"], "Atom Bomb");
    assert_eq!(v[0]["ready"], false);
    assert!(v[0]["remainingTicks"].as_i64().unwrap() > 0);
    let all: serde_json::Value = serde_json::from_str(&g.power_timers_json(-1)).unwrap();
    assert_eq!(all, v);
}

/// The built-in support power list of `id` as JSON, for map rules that replace it.
fn powers_json(w: &World, id: &str) -> serde_json::Value {
    let rules: serde_json::Value = serde_json::from_str(include_str!("../rules.json")).unwrap();
    let a = rules["actors"].as_array().unwrap().iter().find(|a| a["id"] == id).unwrap().clone();
    assert!(w.rules.actor_index(id).is_some());
    a["abilities"]["support_powers"].clone()
}

#[test]
fn map_rules_set_charge_times_and_start_fully_charged_like_openra() {
    let mut w = world();
    // A map (an .oramap's MSLO NukePower ChargeInterval: 50000 and an Iron
    // Curtain with StartFullyCharged): the list is replaced whole.
    let mut nuke = powers_json(&w, "MSLO");
    nuke[0]["charge"] = 50_000.into();
    let mut iron = powers_json(&w, "IRON");
    iron[0]["start_fully_charged"] = true.into();
    w.rules = crate::rules::Rules::load_with(Some(&serde_json::json!({ "actors": {
        "MSLO": { "abilities": { "support_powers": nuke } },
        "IRON": { "abilities": { "support_powers": iron } },
    } })))
    .expect("overrides load");
    build(&mut w, "MSLO", 0, 0);
    build(&mut w, "IRON", 0, 4);
    run(&mut w, 10);
    let inst = |w: &World, key: &str| w.power_instances(0).iter().find(|p| p.key == key).cloned().unwrap();
    let n = inst(&w, "NukePower");
    assert_eq!(n.total, 50_000);
    assert_eq!(n.remaining, 50_000 - 10);
    // The countdown every player sees counts from the map's charge time.
    assert_eq!(w.power_timers(Some(2)).iter().find(|t| t.key == "NukePower").unwrap().remaining, 50_000 - 10);
    let c = inst(&w, "GrantExternalConditionPower@IRONCURTAIN");
    assert!(c.ready(), "StartFullyCharged: ready at once");
    assert_eq!(c.total, w.rules.actors[ty(&w, "IRON") as usize].abilities.support_powers.as_ref().unwrap()[0].charge);
    // After a launch it charges the whole time like any power.
    let (sx, sy) = w.players[2].start;
    assert!(w.activate_support_power(0, "GrantExternalConditionPower@IRONCURTAIN", sx * 1024, sy * 1024, None));
    assert_eq!(inst(&w, "GrantExternalConditionPower@IRONCURTAIN").remaining, c.total);
}

#[test]
fn map_rules_cannot_give_a_power_bad_timer_relationships() {
    let w = world();
    for bad in [serde_json::json!(["ally", "foe"]), serde_json::json!(["ally", "ally", "enemy", "neutral"])] {
        let mut nuke = powers_json(&w, "MSLO");
        nuke[0]["display_timer"] = bad.clone();
        let r = crate::rules::Rules::load_with(Some(&serde_json::json!({ "actors": { "MSLO": { "abilities": { "support_powers": nuke } } } })));
        assert!(r.is_err(), "{bad}");
    }
}
