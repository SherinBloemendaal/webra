//! OpenRA SquadManagerBotModule and its squad state machines: new units hang
//! around the base until there are SquadSize (plus a random bonus) of them,
//! then they leave as an assault squad; a rush squad goes for an enemy
//! Construction Yard when the fuzzy rush rules say the units around the base
//! can take its defenders; aircraft fly in an air squad that strikes where
//! there is little anti-air; ships form a naval squad; and units near the
//! base form a protection squad against attackers of the base. Squads that
//! should flee (AttackOrFleeFuzzy, ai_fuzzy.rs) fall back to the base and
//! disband.
//!
//! WebRA differences: squads prefer actors of the player the AI attacks
//! (ai.rs, free for all fairness) unless a squad fled from that player
//! lately, enemy structures count as seen (the AI
//! knows the bases), and an air squad skips flight paths with heavy
//! anti-air (OpenRA's check is inverted and skips the safe ones) and looks
//! for targets all over the map (OpenRA's grid misses the far edges).
//!
//! Naval squads (WebRA, ai_naval.rs): one per body of water; an idle fleet
//! looks for enemies around its target rather than around the point it
//! aims at (at a Cruiser's range those are 20 cells apart, and OpenRA's
//! fleets never set out); each ship heads for a point from which it sees
//! the target and attacks what it sees directly (on an attack move ships
//! below the AttackAnything stance skip most structures); ships that are
//! firing are not ordered on, nor is the fleet counted stuck; a target the
//! fleet cannot see from where it should is left alone for a while (a Gap
//! Generator); a fleeing fleet falls back to a naval yard on its water;
//! and the ship nearest an attacker of the base decides whether the fleet
//! can answer it.

use crate::ai::{attack_offset, can_attack, current_target, is_preferred_enemy, owned_buildings, rand};
use crate::ai_bots::BotConfig;
use crate::ai_fuzzy::{can_attack as fuzzy_attack, Fuzzy};
use crate::math::{dist_sq, CELL};
use crate::rules::Kind;
use crate::world::{cell_center, Activity, Order, World, NONE};

/// SquadManagerBotModule.MaxRespondToAttackCooldown.
const MAX_RESPOND_COOLDOWN: i32 = 30;
/// Ticks without progress after which an attacking squad stops and looks again.
const STUCK_TICKS: u32 = 63;
/// AirStateBase.MissileUnitMultiplier.
const MISSILE_UNIT_MULTIPLIER: usize = 3;
/// AirIdleState.MaxCheckTimesPerTick.
const MAX_AIR_CHECKS: usize = 2;
/// UnitsForProtectionAttackState.BackoffTicks.
const BACKOFF_TICKS: i32 = 4;
/// WebRA stalemate breaker: units at the base that stopped growing for this
/// long (no money, unit limits) leave as an assault squad below SquadSize,
/// once the game is this old and they are at least STALL_MIN_UNITS (any
/// number once the bot earns nothing any more).
const STALL_TICKS: u32 = 120 * crate::world::TICKS_PER_SECOND;
const STALL_FROM: u32 = 600 * crate::world::TICKS_PER_SECOND;
const STALL_MIN_UNITS: usize = 4;
/// WebRA patience: a bot that may form attack forces at any time
/// (MinimumAttackForceDelay below this) sends the units at its base after
/// this long without an attack force, even while they still trickle in.
const PATIENCE_TICKS: u32 = 300 * crate::world::TICKS_PER_SECOND;
/// WebRA: after a squad fled from a player's actors, squads prefer other
/// enemies for this long (else a squad too weak for its target player's
/// defences would gather, flee and gather again for good).
const FLED_TICKS: u32 = 180 * crate::world::TICKS_PER_SECOND;
/// WebRA: a naval squad that got where it should see its target and does
/// not (a Gap Generator's shroud) leaves it alone for this long.
const BLIND_TICKS: u32 = 120 * crate::world::TICKS_PER_SECOND;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum SquadType {
    Assault,
    Air,
    Rush,
    Protection,
    Naval,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum State {
    GroundIdle,
    GroundAttackMove,
    GroundAttack,
    GroundFlee,
    AirIdle,
    AirAttack,
    AirFlee,
    ProtectionIdle,
    ProtectionAttack,
    ProtectionFlee,
}

#[derive(Clone, Debug)]
pub(crate) struct Squad {
    id: u32,
    pub(crate) kind: SquadType,
    /// Actor references.
    pub(crate) units: Vec<u32>,
    /// Target actor reference (NONE: none) and the offset of the point aimed at.
    target: u32,
    offset: (i32, i32),
    state: State,
    // Per state (reset by `change_state`).
    leader: u32,
    last_updated: u32,
    last_leader_cell: Option<(i32, i32)>,
    last_target: u32,
    backoff: i32,
    air_cells: Vec<u32>,
    air_checked: usize,
}

#[derive(Clone, Default, Debug)]
pub(crate) struct SquadState {
    pub(crate) squads: Vec<Squad>,
    /// Units already given a role.
    active: Vec<u32>,
    /// Units waiting at the base for the next squad.
    pub(crate) hanging: Vec<u32>,
    pending: Vec<u32>,
    rush_ticks: i32,
    assign_ticks: i32,
    attack_force_ticks: i32,
    min_attack_force_ticks: i32,
    respond_cooldown: i32,
    protect_from: u32,
    next_id: u32,
    /// Units at the base when last counted, and the tick they last grew.
    hanging_seen: usize,
    hanging_grew_at: u32,
    /// Tick of the last attack force (or rush) that left the base.
    left_at: u32,
    /// Players a squad fled from, and until when squads look elsewhere first.
    fled_from: Vec<(u8, u32)>,
    /// Attacks naval squads started (idle to attack move), for `naval_report`.
    naval_attacks: u32,
    /// Targets naval squads could not see from where they should have
    /// (`check_blind`), and until when; kept when a squad disbands.
    blind: Vec<(u32, u32)>,
}

pub(crate) fn start(w: &mut World, player: u8) {
    let cfg = w.ai[player as usize].cfg.clone();
    let sq = &cfg.info.squads;
    let fraction = sq.rush_interval / 20;
    let rush = rand(w, sq.rush_interval - fraction, sq.rush_interval + fraction);
    let assign = rand(w, 0, sq.assign_roles_interval);
    let force = rand(w, 0, sq.attack_force_interval);
    let min_force = rand(w, 0, sq.minimum_attack_force_delay);
    let st = &mut w.ai[player as usize].squads;
    st.rush_ticks = rush;
    st.assign_ticks = assign;
    st.attack_force_ticks = force;
    st.min_attack_force_ticks = min_force;
    st.respond_cooldown = MAX_RESPOND_COOLDOWN;
    st.protect_from = NONE;
}

fn sq(w: &mut World, player: u8) -> &mut SquadState {
    &mut w.ai[player as usize].squads
}

/// A unit the bot can still order (OpenRA unitCannotBeOrdered negated).
fn orderable(w: &World, player: u8, r: u32) -> Option<usize> {
    w.resolve(r).filter(|&i| w.actors[i].alive && w.actors[i].owner == player && w.actors[i].in_world())
}

fn units_of(w: &World, player: u8, s: &Squad) -> Vec<usize> {
    s.units.iter().filter_map(|&r| orderable(w, player, r)).collect()
}

/// Living units of squad `k`.
fn units_k(w: &World, player: u8, k: usize) -> Vec<usize> {
    units_of(w, player, &w.ai[player as usize].squads.squads[k])
}

pub(crate) fn tick(w: &mut World, player: u8) {
    let cfg = w.ai[player as usize].cfg.clone();
    let info = &cfg.info.squads;
    let level = w.ai[player as usize].level();
    // CleanSquads.
    let squads = std::mem::take(&mut sq(w, player).squads);
    let squads: Vec<Squad> = squads
        .into_iter()
        .map(|mut s| {
            s.units.retain(|&r| orderable(w, player, r).is_some());
            s
        })
        .filter(|s| !s.units.is_empty())
        .collect();
    sq(w, player).squads = squads;
    let active: Vec<u32> = w.ai[player as usize].squads.active.iter().copied().filter(|&r| orderable(w, player, r).is_some()).collect();
    let hanging: Vec<u32> = w.ai[player as usize].squads.hanging.iter().copied().filter(|&r| orderable(w, player, r).is_some()).collect();
    w.ai[player as usize].units.idle_units = hanging.len();
    let passive = w.ai[player as usize].passive;
    let st = sq(w, player);
    st.active = active;
    st.hanging = hanging;
    st.rush_ticks -= 1;
    if st.rush_ticks <= 0 {
        st.rush_ticks = info.rush_interval;
        if !passive {
            try_rush(w, player, &cfg);
        }
    }
    let st = sq(w, player);
    st.attack_force_ticks -= 1;
    if st.attack_force_ticks <= 0 {
        st.attack_force_ticks = level.interval(info.attack_force_interval);
        let ids: Vec<u32> = st.squads.iter().map(|s| s.id).collect();
        st.pending.extend(ids);
    }
    let st = sq(w, player);
    let n = st.pending.len().div_ceil(st.attack_force_ticks.max(1) as usize);
    for _ in 0..n {
        let Some(id) = sq(w, player).pending.pop() else { break };
        update_squad(w, player, &cfg, id);
    }
    let st = sq(w, player);
    st.assign_ticks -= 1;
    if st.assign_ticks <= 0 {
        st.assign_ticks = level.interval(info.assign_roles_interval);
        find_new_units(w, player, &cfg);
    }
    let st = sq(w, player);
    st.min_attack_force_ticks -= 1;
    if st.min_attack_force_ticks <= 0 {
        st.min_attack_force_ticks = info.minimum_attack_force_delay;
        if !passive {
            create_attack_force(w, player, &cfg);
        }
    }
    if !passive {
        break_stalemate(w, player);
    }
    let st = sq(w, player);
    let protect = st.respond_cooldown == MAX_RESPOND_COOLDOWN;
    st.respond_cooldown -= 1;
    if protect {
        let from = st.protect_from;
        protect_own(w, player, &cfg, from);
    }
}

/// IBotRespondToAttack: an attack on a protected type (most structures, ore
/// trucks, MCVs) calls a protection squad on the attacker next tick.
pub(crate) fn respond_to_attack(w: &mut World, player: u8, victim: usize, attacker: usize) {
    let cfg = w.ai[player as usize].cfg.clone();
    if sq(w, player).respond_cooldown > 0
        || !cfg.protection.contains(&w.actors[victim].ty)
        || !is_preferred_enemy(w, player, attacker, cfg.ignored_targets)
    {
        return;
    }
    let cell = w.cell_of(w.actors[attacker].x, w.actors[attacker].y);
    w.ai[player as usize].base.defense_center = Some(cell);
    let r = w.make_ref(attacker);
    let st = sq(w, player);
    st.respond_cooldown = MAX_RESPOND_COOLDOWN;
    st.protect_from = r;
}

fn new_squad(w: &mut World, player: u8, kind: SquadType, target: Option<(usize, (i32, i32))>) -> usize {
    let st = sq(w, player);
    st.next_id += 1;
    let state = match kind {
        SquadType::Assault | SquadType::Rush | SquadType::Naval => State::GroundIdle,
        SquadType::Air => State::AirIdle,
        SquadType::Protection => State::ProtectionIdle,
    };
    let s = Squad {
        id: st.next_id,
        kind,
        units: Vec::new(),
        target: NONE,
        offset: (0, 0),
        state,
        leader: NONE,
        last_updated: 0,
        last_leader_cell: None,
        last_target: NONE,
        backoff: BACKOFF_TICKS,
        air_cells: Vec::new(),
        air_checked: 0,
    };
    st.squads.push(s);
    let k = st.squads.len() - 1;
    set_target(w, player, k, target);
    if state == State::AirIdle {
        activate_air_idle(w, player, k);
    }
    k
}

fn squad_of_type(w: &World, player: u8, kind: SquadType) -> Option<usize> {
    w.ai[player as usize].squads.squads.iter().position(|s| s.kind == kind)
}

/// Units not in a role yet: aircraft join the air squad, ships the naval
/// squad, the rest hang around the base.
fn find_new_units(w: &mut World, player: u8, cfg: &BotConfig) {
    let new: Vec<usize> = (0..w.actors.len())
        .filter(|&i| {
            let a = &w.actors[i];
            a.alive
                && a.owner == player
                && a.in_world()
                && a.is_unit()
                && !matches!(a.kind, Kind::Mine | Kind::Husk)
                && !cfg.excluded.contains(&a.ty)
                && !w.is_support_aircraft(i)
                // Engineers belong to the capture manager (ai_infantry.rs).
                && w.rules.actors[a.ty as usize].abilities.captures.is_none()
        })
        .filter(|&i| !w.ai[player as usize].squads.active.contains(&w.make_ref(i)))
        .collect();
    for i in new {
        let r = w.make_ref(i);
        let ty = w.actors[i].ty;
        if cfg.air_units.contains(&ty) {
            let k = squad_of_type(w, player, SquadType::Air).unwrap_or_else(|| new_squad(w, player, SquadType::Air, None));
            sq(w, player).squads[k].units.push(r);
        } else if cfg.naval_units.contains(&ty) {
            let k = naval_squad_for(w, player, i).unwrap_or_else(|| new_squad(w, player, SquadType::Naval, None));
            sq(w, player).squads[k].units.push(r);
        } else {
            sq(w, player).hanging.push(r);
        }
        sq(w, player).active.push(r);
    }
    w.ai[player as usize].units.idle_units = sq(w, player).hanging.len();
}

/// The body of water ship `i` is on, as a `pass_water` label (None on no
/// water). Landing craft (the Transport, in OpenRA's NavalUnitsTypes, so
/// it joins naval squads) move on `pass_landing`, whose labels also join
/// beaches and cannot be compared; on a beach the craft counts as on the
/// water next to it (the first open neighbour, row by row).
pub(crate) fn water_of(w: &World, i: usize) -> Option<u32> {
    let pass = &w.pass_water;
    let (cx, cy) = w.cell_of(w.actors[i].x, w.actors[i].y);
    let open = |x: i32, y: i32| w.map.contains(x, y) && !pass.blocked[w.map.idx(x, y)];
    if open(cx, cy) {
        return Some(pass.component[w.map.idx(cx, cy)]);
    }
    if !w.lands(i) {
        return None;
    }
    (-1..=1)
        .flat_map(|dy| (-1..=1).map(move |dx| (cx + dx, cy + dy)))
        .find(|&(x, y)| open(x, y))
        .map(|(x, y)| pass.component[w.map.idx(x, y)])
}

/// The naval squad on ship `i`'s body of water. WebRA: one naval squad per
/// body of water (OpenRA has one naval squad, so ships on a lake or behind
/// a ford held a whole fleet back with their leader; ai_naval.rs).
fn naval_squad_for(w: &World, player: u8, i: usize) -> Option<usize> {
    let water = water_of(w, i);
    w.ai[player as usize].squads.squads.iter().position(|s| {
        s.kind == SquadType::Naval && s.units.iter().find_map(|&u| orderable(w, player, u)).is_some_and(|u| water_of(w, u) == water)
    })
}

/// Enough units at the base: they all leave as an assault squad.
fn create_attack_force(w: &mut World, player: u8, cfg: &BotConfig) {
    let info = &cfg.info.squads;
    let size = info.squad_size + rand(w, 0, info.squad_size_random_bonus);
    if (sq(w, player).hanging.len() as i32) < size {
        return;
    }
    let k = new_squad(w, player, SquadType::Assault, None);
    let tick = w.tick;
    let st = sq(w, player);
    let units = std::mem::take(&mut st.hanging);
    st.squads[k].units = units;
    st.left_at = tick;
    w.ai[player as usize].units.idle_units = 0;
}

/// WebRA: an army at the base that stopped growing (both economies dry, or
/// at its unit limits) would wait for SquadSize for good; after STALL_TICKS
/// it leaves as an assault squad with what it has, and so it does after
/// PATIENCE_TICKS without an attack force (bots that attack at any time).
fn break_stalemate(w: &mut World, player: u8) {
    let tick = w.tick;
    let patient = (w.ai[player as usize].cfg.info.squads.minimum_attack_force_delay as u32) < PATIENCE_TICKS;
    let st = sq(w, player);
    let n = st.hanging.len();
    if n > st.hanging_seen {
        st.hanging_grew_at = tick;
    }
    st.hanging_seen = n;
    let min = if crate::ai_economy::no_income(w, player) { 1 } else { STALL_MIN_UNITS };
    let st = sq(w, player);
    let stalled = tick >= st.hanging_grew_at + STALL_TICKS;
    let waited = patient && tick >= st.left_at + PATIENCE_TICKS;
    if tick < STALL_FROM || !(stalled || waited) || n < min {
        return;
    }
    let k = new_squad(w, player, SquadType::Assault, None);
    let st = sq(w, player);
    let units = std::mem::take(&mut st.hanging);
    st.squads[k].units = units;
    st.hanging_seen = 0;
    st.hanging_grew_at = tick;
    st.left_at = tick;
    w.ai[player as usize].units.idle_units = 0;
}

/// OpenRA TryToRushAttack: with SquadSize ground units, the units at the base
/// rush an enemy Construction Yard whose defenders the rush rules say they
/// can take.
fn try_rush(w: &mut World, player: u8, cfg: &BotConfig) {
    let info = &cfg.info.squads;
    let mut ground = sq(w, player).hanging.len();
    for s in &w.ai[player as usize].squads.squads {
        if !matches!(s.kind, SquadType::Air | SquadType::Naval) {
            ground += s.units.len();
        }
    }
    if (ground as i32) < info.squad_size {
        return;
    }
    let hanging: Vec<usize> = sq(w, player).hanging.clone().iter().filter_map(|&r| orderable(w, player, r)).collect();
    let armed: Vec<usize> = hanging.iter().copied().filter(|&i| !w.rules.actors[w.actors[i].ty as usize].weapons.is_empty()).collect();
    let Some(unit) = crate::ai_units::pick(w, &armed) else { return };
    let yards: Vec<usize> = (0..w.actors.len()).filter(|&i| w.actors[i].alive && cfg.yards.contains(&w.actors[i].ty)).collect();
    for (yard, offset) in find_enemies(w, player, cfg, &yards, unit) {
        let (yx, yy) = (w.actors[yard].x, w.actors[yard].y);
        let r = (info.rush_attack_scan_radius * CELL) as i64;
        let near: Vec<usize> = (0..w.actors.len())
            .filter(|&i| {
                let a = &w.actors[i];
                a.alive
                    && dist_sq(a.x, a.y, yx, yy) <= r * r
                    && !w.rules.actors[a.ty as usize].weapons.is_empty()
                    && !cfg.air_units.contains(&a.ty)
                    && !cfg.naval_units.contains(&a.ty)
            })
            .collect();
        let enemies = find_enemies(w, player, cfg, &near, unit);
        let enemy_ids: Vec<usize> = enemies.iter().map(|e| e.0).collect();
        if !fuzzy_attack(w, Fuzzy::Rush, &hanging, &enemy_ids) {
            continue;
        }
        let target = match crate::ai_units::pick(w, &enemies) {
            Some(e) => e,
            None => (yard, offset),
        };
        for k in 0..sq(w, player).squads.len() {
            set_target(w, player, k, Some(target));
        }
        let k = squad_of_type(w, player, SquadType::Rush).unwrap_or_else(|| new_squad(w, player, SquadType::Rush, Some(target)));
        let tick = w.tick;
        let st = sq(w, player);
        let units = std::mem::take(&mut st.hanging);
        st.squads[k].units.extend(units);
        st.left_at = tick;
        w.ai[player as usize].units.idle_units = 0;
        return;
    }
}

/// OpenRA ProtectOwn: squads near the attacker turn on it, and the units at
/// the base that can reach it form (or join) the protection squad.
fn protect_own(w: &mut World, player: u8, cfg: &BotConfig, from: u32) {
    let Some(attacker) = w.resolve(from) else { return };
    if !is_preferred_enemy(w, player, attacker, cfg.ignored_targets) {
        return;
    }
    let r = cfg.info.squads.protect_unit_scan_radius;
    let ac = w.cell_of(w.actors[attacker].x, w.actors[attacker].y);
    for k in 0..sq(w, player).squads.len() {
        // OpenRA asks the squad's first unit (the first of a hash set, any
        // of them); WebRA asks a naval squad's ship nearest the attacker, so
        // a fleet by the harbour defends it whichever ship was built first.
        let (ax, ay) = (w.actors[attacker].x, w.actors[attacker].y);
        let first = if sq(w, player).squads[k].kind == SquadType::Naval {
            units_k(w, player, k).into_iter().min_by_key(|&i| (dist_sq(w.actors[i].x, w.actors[i].y, ax, ay), i))
        } else {
            sq(w, player).squads[k].units.first().copied().and_then(|u| orderable(w, player, u))
        };
        let Some(first) = first else { continue };
        let fc = w.cell_of(w.actors[first].x, w.actors[first].y);
        let near = (fc.0 - ac.0) * (fc.0 - ac.0) + (fc.1 - ac.1) * (fc.1 - ac.1) <= r * r;
        if near && !find_enemies(w, player, cfg, &[attacker], first).is_empty() {
            set_target(w, player, k, Some((attacker, (0, 0))));
        }
    }
    let k = squad_of_type(w, player, SquadType::Protection)
        .unwrap_or_else(|| new_squad(w, player, SquadType::Protection, Some((attacker, (0, 0)))));
    let hanging = std::mem::take(&mut sq(w, player).hanging);
    let mut unused = Vec::new();
    for r in hanging {
        let Some(i) = orderable(w, player, r) else { continue };
        let joins = if w.actors[i].kind == Kind::Aircraft {
            !cfg.air_units.contains(&w.actors[i].ty)
        } else {
            !find_enemies(w, player, cfg, &[attacker], i).is_empty()
        };
        if joins {
            sq(w, player).squads[k].units.push(r);
        } else {
            unused.push(r);
        }
    }
    w.ai[player as usize].units.idle_units = unused.len();
    sq(w, player).hanging = unused;
    if !sq(w, player).squads[k].units.is_empty() {
        let center = center_unit(w, player, k);
        if center.is_some_and(|c| !target_valid(w, player, cfg, k, c)) {
            set_target(w, player, k, Some((attacker, (0, 0))));
        }
    }
}

// ---- Targets --------------------------------------------------------------------------

/// OpenRA FindEnemies: preferred enemies among `actors` that `source` can
/// hit and reach (ai.rs `attack_offset`), with the offset of the nearest
/// reachable point.
fn find_enemies(w: &World, player: u8, cfg: &BotConfig, actors: &[usize], source: usize) -> Vec<(usize, (i32, i32))> {
    actors
        .iter()
        .filter(|&&a| is_preferred_enemy(w, player, a, cfg.ignored_targets) && can_attack(w, source, a))
        // Squads aim at structures themselves, not at the edge of their
        // weapon range: the engine's units only auto-target what they see
        // (OpenRA's also remember structures under the fog).
        // (Ships keep the edge of their range: they cannot drive ashore.)
        .filter_map(|&a| {
            let ground = w.domain_of(source) == crate::rules::Domain::Ground;
            attack_offset(w, source, a).map(|o| (a, if ground && w.actors[a].kind == Kind::Building { (0, 0) } else { o }))
        })
        .collect()
}

/// OpenRA FindClosestEnemy (within `radius` cells, if given): the nearest
/// enemy `source` can hit and reach; among the actors of the player the AI
/// attacks first, when there are any.
/// Never one squad `k` cannot see (`check_blind`).
fn closest_enemy(w: &World, player: u8, cfg: &BotConfig, k: usize, source: usize, radius: Option<i32>) -> Option<(usize, (i32, i32))> {
    let (sx, sy) = (w.actors[source].x, w.actors[source].y);
    let candidates: Vec<usize> = (0..w.actors.len())
        .filter(|&i| {
            let a = &w.actors[i];
            a.alive
                && radius.is_none_or(|r| dist_sq(a.x, a.y, sx, sy) <= (r * CELL) as i64 * (r * CELL) as i64)
                && !is_blind(w, player, k, i)
        })
        .collect();
    let enemies = find_enemies(w, player, cfg, &candidates, source);
    let tick = w.tick;
    let fled = &w.ai[player as usize].squads.fled_from;
    let avoided = |p: u8| fled.iter().any(|&(q, until)| q == p && tick < until);
    let focus = current_target(w, player).filter(|&t| !avoided(t));
    let preferred: Vec<&(usize, (i32, i32))> = enemies.iter().filter(|e| Some(w.actors[e.0].owner) == focus).collect();
    let others: Vec<&(usize, (i32, i32))> = enemies.iter().filter(|e| !avoided(w.actors[e.0].owner)).collect();
    let pool: Vec<&(usize, (i32, i32))> = if !preferred.is_empty() {
        preferred
    } else if !others.is_empty() {
        others
    } else {
        enemies.iter().collect()
    };
    pool.into_iter().min_by_key(|e| (dist_sq(w.actors[e.0].x, w.actors[e.0].y, sx, sy), e.0)).copied()
}

fn set_target(w: &mut World, player: u8, k: usize, target: Option<(usize, (i32, i32))>) {
    let r = target.map_or(NONE, |(t, _)| w.make_ref(t));
    let s = &mut sq(w, player).squads[k];
    s.target = r;
    s.offset = target.map_or((0, 0), |t| t.1);
}

fn target_actor(w: &World, player: u8, k: usize) -> Option<usize> {
    w.resolve(w.ai[player as usize].squads.squads[k].target).filter(|&t| w.actors[t].alive && w.actors[t].in_world())
}

/// Where the squad aims: its target actor, moved by the offset.
fn target_pos(w: &World, player: u8, k: usize) -> Option<(i32, i32)> {
    let s = &w.ai[player as usize].squads.squads[k];
    target_actor(w, player, k).map(|t| (w.actors[t].x + s.offset.0, w.actors[t].y + s.offset.1))
}

/// OpenRA Squad.IsTargetValid: the target lives and is still an enemy
/// `unit` can hit and reach (the offset is refreshed).
fn target_valid(w: &mut World, player: u8, cfg: &BotConfig, k: usize, unit: usize) -> bool {
    let Some(t) = target_actor(w, player, k) else { return false };
    let units = units_of(w, player, &w.ai[player as usize].squads.squads[k]);
    if !units.iter().any(|&u| can_attack(w, u, t)) || w.actors[t].kind == Kind::Husk || is_blind(w, player, k, t) {
        return false;
    }
    let found = find_enemies(w, player, cfg, &[t], unit).first().copied();
    set_target(w, player, k, found);
    found.is_some()
}

/// Whether naval squad `k` leaves actor `t` alone as out of sight (`check_blind`).
fn is_blind(w: &World, player: u8, k: usize, t: usize) -> bool {
    w.ai[player as usize].squads.squads[k].kind == SquadType::Naval && naval_blind(w, player, t)
}

/// Whether the naval squads of `player` leave actor `t` alone as out of
/// sight (`check_blind`; ai_naval.rs builds no warships for it either).
pub(crate) fn naval_blind(w: &World, player: u8, t: usize) -> bool {
    let r = w.make_ref(t);
    w.ai[player as usize].squads.blind.iter().any(|&(b, until)| b == r && w.tick < until)
}

/// Whether actor `t` is out of `player`'s sight because of the fog or a
/// Gap Generator's shroud, not because it is cloaked (a submerged
/// submarine sits on a cell `player` sees: it surfaces to fire).
fn fogged(w: &World, t: usize, player: u8) -> bool {
    if w.actors[t].kind == Kind::Building {
        return !w.is_visible_to(t, player);
    }
    w.players[player as usize].visible[w.cell_index(w.actors[t].x, w.actors[t].y)] == 0
}

/// WebRA: a ship of naval squad `k` that can hit its target is within its
/// sight reach of it (ai.rs `sight_reach`, after the weather), or for a
/// structure at the point it went to see it from (ai.rs `view_offset`),
/// and does not see it, as under a Gap Generator's shroud (`fogged`; a
/// cloak does not count): naval squads leave that target alone for
/// BLIND_TICKS (the engine's units only fire at what their owner sees;
/// OpenRA's fleets waited there for good).
fn check_blind(w: &mut World, player: u8, k: usize) {
    if sq(w, player).squads[k].kind != SquadType::Naval {
        return;
    }
    let Some(t) = target_actor(w, player, k).filter(|&t| fogged(w, t, player)) else { return };
    let (tx, ty) = (w.actors[t].x, w.actors[t].y);
    let building = w.actors[t].kind == Kind::Building;
    let there = units_k(w, player, k).into_iter().any(|u| {
        let (ux, uy) = (w.actors[u].x, w.actors[u].y);
        let near = crate::ai::sight_reach(w, w.actors[u].ty).max(0) as i64;
        can_attack(w, u, t)
            && (dist_sq(ux, uy, tx, ty) <= near * near
                || building
                    && crate::ai::view_offset(w, u, t).is_some_and(|(ox, oy)| {
                        let r = (3 * CELL / 2) as i64;
                        dist_sq(ux, uy, tx + ox, ty + oy) <= r * r
                    }))
    });
    if !there {
        return;
    }
    let (r, tick) = (w.make_ref(t), w.tick);
    let st = sq(w, player);
    st.blind.retain(|&(_, until)| tick < until);
    st.blind.push((r, tick + BLIND_TICKS));
    crate::ai_naval::invalidate(w, player);
}

// ---- Squad positions ------------------------------------------------------------------

fn center_position(w: &World, units: &[usize]) -> (i32, i32) {
    let n = units.len().max(1) as i64;
    let x = units.iter().map(|&i| w.actors[i].x as i64).sum::<i64>() / n;
    let y = units.iter().map(|&i| w.actors[i].y as i64).sum::<i64>() / n;
    (x as i32, y as i32)
}

/// OpenRA Squad.CenterUnit: the unit nearest the squad's centre.
fn center_unit(w: &World, player: u8, k: usize) -> Option<usize> {
    let units = units_of(w, player, &w.ai[player as usize].squads.squads[k]);
    let c = center_position(w, &units);
    units.into_iter().min_by_key(|&i| (dist_sq(w.actors[i].x, w.actors[i].y, c.0, c.1), i))
}

/// OpenRA GroundStateBase.Leader: among the units with the fewest terrain
/// types they can cross (the slowest locomotor class), the one nearest the
/// centre; kept until it leaves the squad.
fn leader(w: &mut World, player: u8, k: usize) -> Option<usize> {
    let s = &w.ai[player as usize].squads.squads[k];
    if let Some(l) = orderable(w, player, s.leader).filter(|_| s.units.contains(&s.leader)) {
        return Some(l);
    }
    let units = units_of(w, player, s);
    let passable = |i: usize| {
        w.rules.actors[w.actors[i].ty as usize]
            .unit
            .as_ref()
            .map(|u| w.rules.locomotors[u.locomotor].speeds.iter().filter(|&&sp| sp > 0).count())
    };
    let least = units.iter().filter_map(|&i| passable(i)).min();
    let pool: Vec<usize> = match least {
        Some(l) => units.iter().copied().filter(|&i| passable(i) == Some(l)).collect(),
        None => units,
    };
    let c = center_position(w, &pool);
    let l = pool.into_iter().min_by_key(|&i| (dist_sq(w.actors[i].x, w.actors[i].y, c.0, c.1), i))?;
    let r = w.make_ref(l);
    sq(w, player).squads[k].leader = r;
    Some(l)
}

/// OpenRA NewLeaderAndFindClosestEnemy: a new leader and the enemy nearest
/// to it. WebRA: when the leader can hit nothing in reach (Tanya among
/// structures, anti-air only aircraft left), the next unit nearest the
/// squad's centre that can becomes the leader, so a squad never idles while
/// some of its units could fight.
fn new_leader_and_closest(w: &mut World, player: u8, cfg: &BotConfig, k: usize) -> Option<(usize, (i32, i32))> {
    sq(w, player).squads[k].leader = NONE;
    let l = leader(w, player, k)?;
    if let Some(e) = closest_enemy(w, player, cfg, k, l, None) {
        return Some(e);
    }
    let units = units_k(w, player, k);
    let c = center_position(w, &units);
    let mut others: Vec<usize> = units.into_iter().filter(|&u| u != l).collect();
    others.sort_by_key(|&i| (dist_sq(w.actors[i].x, w.actors[i].y, c.0, c.1), i));
    // One unit per weapon set is enough to ask.
    let mut asked: Vec<&Vec<usize>> = vec![&w.rules.actors[w.actors[l].ty as usize].weapons];
    for u in others {
        let weapons = &w.rules.actors[w.actors[u].ty as usize].weapons;
        if asked.contains(&weapons) {
            continue;
        }
        asked.push(weapons);
        if let Some(e) = closest_enemy(w, player, cfg, k, u, None) {
            let r = w.make_ref(u);
            sq(w, player).squads[k].leader = r;
            return Some(e);
        }
    }
    None
}

fn change_state(w: &mut World, player: u8, k: usize, state: State) {
    let old = sq(w, player).squads[k].state;
    if state == State::GroundFlee {
        if let Some(t) = target_actor(w, player, k).filter(|&t| w.are_enemies(player, w.actors[t].owner)) {
            let (owner, until) = (w.actors[t].owner, w.tick + FLED_TICKS);
            let fled = &mut sq(w, player).fled_from;
            fled.retain(|f| f.0 != owner);
            fled.push((owner, until));
        }
    }
    // Leaving a flee state disbands the squad (OpenRA Deactivate: UnregisterSquad).
    if matches!(old, State::GroundFlee | State::ProtectionFlee) {
        let st = sq(w, player);
        let units = std::mem::take(&mut st.squads[k].units);
        st.active.retain(|r| !units.contains(r));
    }
    let s = &mut sq(w, player).squads[k];
    s.state = state;
    s.leader = NONE;
    s.last_updated = 0;
    s.last_leader_cell = None;
    s.last_target = NONE;
    s.backoff = BACKOFF_TICKS;
    if state == State::AirIdle {
        activate_air_idle(w, player, k);
    }
}

fn order_move(w: &mut World, player: u8, units: &[usize], to: (i32, i32), attack_move: bool) {
    if units.is_empty() {
        return;
    }
    let ids: Vec<u32> = units.iter().map(|&i| w.make_ref(i)).collect();
    w.queue_order(Order::Move { player, ids, x: to.0, y: to.1, attack_move });
}

/// OpenRA GoToRandomOwnBuilding: a random own structure, else the base centre.
fn random_building_location(w: &mut World, player: u8) -> (i32, i32) {
    let buildings = owned_buildings(w, player);
    let c = match crate::ai_units::pick(w, &buildings) {
        Some(b) => (w.actors[b].cx, w.actors[b].cy),
        None => crate::ai_base::random_base_center(w, player),
    };
    (cell_center(c.0), cell_center(c.1))
}

/// Where a fleeing naval squad goes: WebRA, the water by a random own ship
/// producer on its body of water (OpenRA's random own structure is on land,
/// out of a ship's reach), or None when it has none there.
pub(crate) fn naval_retreat(w: &mut World, player: u8, units: &[usize]) -> Option<(i32, i32)> {
    let water = units.iter().find_map(|&u| water_of(w, u))?;
    let docks: Vec<(i32, i32)> = owned_buildings(w, player).into_iter().filter_map(|b| crate::ai_naval::dock_cell(w, b, water)).collect();
    let (x, y) = crate::ai_units::pick(w, &docks)?;
    Some((cell_center(x), cell_center(y)))
}

/// A member busy with an attack: firing, or on its way into range. One that
/// waits short of range (behind other units, or for a short way to show up)
/// is not, so the squad gives it new orders (attack_range.rs).
fn busy_attack(w: &World, i: usize) -> bool {
    w.actors[i].activity == Activity::Attack && !w.range_waiting(i)
}

// ---- Squad updates --------------------------------------------------------------------

fn update_squad(w: &mut World, player: u8, cfg: &BotConfig, id: u32) {
    let Some(k) = sq(w, player).squads.iter().position(|s| s.id == id) else { return };
    if units_k(w, player, k).is_empty() {
        return;
    }
    match sq(w, player).squads[k].state {
        State::GroundIdle => ground_idle(w, player, cfg, k),
        State::GroundAttackMove => ground_attack_move(w, player, cfg, k),
        State::GroundAttack => ground_attack(w, player, cfg, k),
        State::GroundFlee => {
            let units = units_k(w, player, k);
            let to = match sq(w, player).squads[k].kind {
                SquadType::Naval => naval_retreat(w, player, &units),
                _ => None,
            };
            let to = to.unwrap_or_else(|| random_building_location(w, player));
            order_move(w, player, &units, to, false);
            change_state(w, player, k, State::GroundIdle);
        }
        State::AirIdle => air_idle(w, player, cfg, k),
        State::AirAttack => air_attack(w, player, cfg, k),
        State::AirFlee => air_flee(w, player, k),
        State::ProtectionIdle => change_state(w, player, k, State::ProtectionAttack),
        State::ProtectionAttack => protection_attack(w, player, cfg, k),
        State::ProtectionFlee => {
            let units = units_k(w, player, k);
            let to = random_building_location(w, player);
            order_move(w, player, &units, to, false);
            change_state(w, player, k, State::ProtectionIdle);
        }
    }
}

/// GroundStateBase.ShouldFlee: armed enemies around the squad that the
/// default fuzzy rules say it cannot take (never next to an own structure).
fn ground_should_flee(w: &World, player: u8, cfg: &BotConfig, k: usize) -> bool {
    let units = units_of(w, player, &w.ai[player as usize].squads.squads[k]);
    let (enemies, own_building) = danger_around(w, player, cfg, &units);
    !own_building && !enemies.is_empty() && !fuzzy_attack(w, Fuzzy::Default, &units, &enemies)
}

/// Armed preferred enemies within DangerScanRadius of the squad centre, and
/// whether an own structure is there.
fn danger_around(w: &World, player: u8, cfg: &BotConfig, units: &[usize]) -> (Vec<usize>, bool) {
    let c = center_position(w, units);
    let r = (cfg.info.squads.danger_scan_radius * CELL) as i64;
    let mut enemies = Vec::new();
    for i in 0..w.actors.len() {
        let a = &w.actors[i];
        if !a.alive || dist_sq(a.x, a.y, c.0, c.1) > r * r {
            continue;
        }
        if a.owner == player && a.kind == Kind::Building {
            return (Vec::new(), true);
        }
        if !w.rules.actors[a.ty as usize].weapons.is_empty() && is_preferred_enemy(w, player, i, cfg.ignored_targets) {
            enemies.push(i);
        }
    }
    (enemies, false)
}

fn ensure_target(w: &mut World, player: u8, cfg: &BotConfig, k: usize) -> bool {
    let Some(l) = leader(w, player, k) else { return false };
    if target_valid(w, player, cfg, k, l) {
        return true;
    }
    let closest = new_leader_and_closest(w, player, cfg, k);
    set_target(w, player, k, closest);
    closest.is_some()
}

fn ground_idle(w: &mut World, player: u8, cfg: &BotConfig, k: usize) {
    if !ensure_target(w, player, cfg, k) {
        return;
    }
    let Some(l) = leader(w, player, k) else { return };
    let Some(tp) = target_pos(w, player, k) else { return };
    let Some(t) = target_actor(w, player, k) else { return };
    // OpenRA scans around the point it aims at, which for a ship firing
    // from the edge of its weapon range (a Cruiser's 20 cells) is far from
    // the target: it found nothing there, so the fleet never set out and
    // grew without end. WebRA scans around a naval squad's target itself.
    let (cx, cy) = if sq(w, player).squads[k].kind == SquadType::Naval { (w.actors[t].x, w.actors[t].y) } else { tp };
    let r = (cfg.info.squads.idle_scan_radius * CELL) as i64;
    let around: Vec<usize> =
        (0..w.actors.len()).filter(|&i| w.actors[i].alive && dist_sq(w.actors[i].x, w.actors[i].y, cx, cy) <= r * r).collect();
    let enemies: Vec<usize> = find_enemies(w, player, cfg, &around, l).into_iter().map(|e| e.0).collect();
    if enemies.is_empty() {
        return;
    }
    let units = units_k(w, player, k);
    if fuzzy_attack(w, Fuzzy::Default, &units, &enemies) {
        // WebRA: members firing at a target in reach keep firing (a stuck
        // leader sends the squad back here; OpenRA orders every unit on).
        let movers: Vec<usize> = units.iter().copied().filter(|&u| !w.attack_firing(u)).collect();
        move_to_target(w, player, k, &movers, tp, true);
        if sq(w, player).squads[k].kind == SquadType::Naval {
            sq(w, player).naval_attacks += 1;
        }
        change_state(w, player, k, State::GroundAttackMove);
    } else {
        change_state(w, player, k, State::GroundFlee);
    }
}

/// Progress check shared by the attack move and attack states: true when the
/// squad made no progress for STUCK_TICKS (it goes back to idle).
fn stuck(w: &mut World, player: u8, k: usize, l: usize) -> bool {
    let cell = w.cell_of(w.actors[l].x, w.actors[l].y);
    let tick = w.tick;
    // WebRA: a naval squad's leader that is firing makes progress too
    // (OpenRA counts it stuck after 63 ticks in place, which drops a fleet
    // shelling the shore back to idle and orders every ship to move again).
    let firing = sq(w, player).squads[k].kind == SquadType::Naval && w.attack_firing(l);
    let s = &mut sq(w, player).squads[k];
    if firing {
        s.last_updated = tick;
    }
    if s.last_leader_cell != Some(cell) {
        s.last_leader_cell = Some(cell);
        s.last_updated = tick;
    }
    if s.target != s.last_target {
        s.last_target = s.target;
        s.last_updated = tick;
    }
    tick > s.last_updated + STUCK_TICKS
}

fn ground_attack_move(w: &mut World, player: u8, cfg: &BotConfig, k: usize) {
    check_blind(w, player, k);
    if !ensure_target(w, player, cfg, k) {
        change_state(w, player, k, State::GroundFlee);
        return;
    }
    let Some(l) = leader(w, player, k) else { return };
    if stuck(w, player, k, l) {
        change_state(w, player, k, State::GroundIdle);
        return;
    }
    // WebRA: a member that cannot reach the leader at all (left on an
    // island, cut off by a fallen bridge) leaves the squad, else the leader
    // would stop and wait for it for good (OpenRA #21054). It is free for
    // the next squad formed where it stands.
    drop_cut_off(w, player, k, l);
    let units = units_k(w, player, k);
    // Stragglers catch up with the leader first.
    let r = units.len() as i64 * CELL as i64 / 3;
    let (lx, ly) = (w.actors[l].x, w.actors[l].y);
    let behind: Vec<usize> = units.iter().copied().filter(|&i| dist_sq(w.actors[i].x, w.actors[i].y, lx, ly) > r * r).collect();
    if !behind.is_empty() {
        let lr = w.make_ref(l);
        w.queue_order(Order::Stop { player, ids: vec![lr] });
        let cell = w.cell_of(lx, ly);
        order_move(w, player, &behind, (cell_center(cell.0), cell_center(cell.1)), true);
    } else if let Some(t) = closest_enemy(w, player, cfg, k, l, Some(cfg.info.squads.attack_scan_radius)) {
        set_target(w, player, k, Some(t));
        change_state(w, player, k, State::GroundAttack);
    } else if let Some(tp) = target_pos(w, player, k) {
        // WebRA: ships already firing (a Cruiser shelling the shore from
        // here) keep firing; OpenRA orders the whole squad on again.
        let movers: Vec<usize> = if sq(w, player).squads[k].kind == SquadType::Naval {
            units.into_iter().filter(|&u| !busy_attack(w, u)).collect()
        } else {
            units
        };
        move_to_target(w, player, k, &movers, tp, true);
    }
    if ground_should_flee(w, player, cfg, k) {
        change_state(w, player, k, State::GroundFlee);
    }
}

/// Attack move `units` of squad `k` to its target point `tp`. WebRA: the
/// ships of a naval squad each to a point where they can see the target
/// (ai.rs `view_offset`). `grouped`: one order for the units that go to
/// `tp` (else one order each).
fn move_to_target(w: &mut World, player: u8, k: usize, units: &[usize], tp: (i32, i32), grouped: bool) {
    let naval = sq(w, player).squads[k].kind == SquadType::Naval;
    let t = target_actor(w, player, k).filter(|_| naval);
    let mut rest = Vec::new();
    for &u in units {
        match t.and_then(|t| crate::ai::view_offset(w, u, t).map(|o| (t, o))) {
            Some((t, (ox, oy))) => order_move(w, player, &[u], (w.actors[t].x + ox, w.actors[t].y + oy), true),
            None if grouped => rest.push(u),
            None => order_move(w, player, &[u], tp, true),
        }
    }
    order_move(w, player, &rest, tp, true);
}

/// Members of squad `k` that cannot reach leader `l` by ground (or water,
/// for a naval squad) leave the squad and its roles; aircraft always can.
fn drop_cut_off(w: &mut World, player: u8, k: usize, l: usize) {
    let reach = |w: &World, i: usize| -> Option<u32> {
        match w.domain_of(i) {
            crate::rules::Domain::Air => return None,
            // Ships and landing craft compare bodies of water (`water_of`).
            crate::rules::Domain::Water => return water_of(w, i),
            _ => {}
        }
        let pass = w.pass_of(i);
        let ci = w.cell_index(w.actors[i].x, w.actors[i].y);
        (!pass.blocked[ci]).then(|| pass.component[ci])
    };
    let Some(home) = reach(w, l) else { return };
    let cut: Vec<u32> = units_k(w, player, k)
        .into_iter()
        .filter(|&i| i != l && w.domain_of(i) == w.domain_of(l) && reach(w, i).is_some_and(|c| c != home))
        .map(|i| w.make_ref(i))
        .collect();
    if cut.is_empty() {
        return;
    }
    let st = sq(w, player);
    st.squads[k].units.retain(|r| !cut.contains(r));
    st.active.retain(|r| !cut.contains(r));
}

fn ground_attack(w: &mut World, player: u8, cfg: &BotConfig, k: usize) {
    check_blind(w, player, k);
    if !ensure_target(w, player, cfg, k) {
        change_state(w, player, k, State::GroundFlee);
        return;
    }
    let Some(l) = leader(w, player, k) else { return };
    if stuck(w, player, k, l) {
        change_state(w, player, k, State::GroundIdle);
        return;
    }
    let units = units_k(w, player, k);
    let mut idle: Vec<usize> = units.into_iter().filter(|&u| !busy_attack(w, u)).collect();
    // WebRA: ships attack a target they see directly. On an attack move
    // their auto-targeting skips structures other than defences below the
    // AttackAnything stance (OpenRA AutoTargetPriority@DEFAULT), and the
    // bots' Missile Submarines start on ReturnFire (InitialStanceAI): OpenRA's
    // submarine fleets wait beside the structure they were sent to.
    if sq(w, player).squads[k].kind == SquadType::Naval {
        if let Some(t) = target_actor(w, player, k).filter(|&t| w.targetable(t, player)) {
            let tr = w.make_ref(t);
            let (direct, rest): (Vec<usize>, Vec<usize>) = idle.into_iter().partition(|&u| can_attack(w, u, t));
            for u in direct {
                let r = w.make_ref(u);
                w.queue_order(Order::Attack { player, ids: vec![r], target: tr });
            }
            idle = rest;
        }
    }
    if let Some(tp) = target_pos(w, player, k) {
        move_to_target(w, player, k, &idle, tp, false);
    }
    if ground_should_flee(w, player, cfg, k) {
        change_state(w, player, k, State::GroundFlee);
    }
}

fn protection_attack(w: &mut World, player: u8, cfg: &BotConfig, k: usize) {
    let Some(l) = leader(w, player, k) else { return };
    if !target_valid(w, player, cfg, k, l) {
        let t = closest_enemy(w, player, cfg, k, l, Some(cfg.info.squads.protection_scan_radius));
        set_target(w, player, k, t);
        if t.is_none() {
            change_state(w, player, k, State::ProtectionFlee);
            return;
        }
    }
    let units = units_k(w, player, k);
    if let Some(tp) = target_pos(w, player, k) {
        order_move(w, player, &units, tp, true);
    }
    let visible = target_actor(w, player, k).is_some_and(|t| w.is_visible_to(t, player));
    let s = &mut sq(w, player).squads[k];
    if visible {
        s.backoff = BACKOFF_TICKS;
        return;
    }
    if s.backoff < 0 {
        change_state(w, player, k, State::ProtectionFlee);
        return;
    }
    s.backoff -= 1;
}

// ---- Air squads -------------------------------------------------------------------------

/// Anti-air units among `units` (not aircraft): armed against what flies.
fn count_anti_air(w: &World, cfg: &BotConfig, units: &[usize]) -> usize {
    let air_classes = if cfg.aircraft_target & crate::ai_bots::TT_AIR != 0 { crate::rules::TARGET_AIR } else { 0 };
    units
        .iter()
        .filter(|&&i| {
            let a = &w.actors[i];
            a.kind != Kind::Aircraft
                && !(a.kind == Kind::Building && w.is_powered_down(i))
                && w.rules.actors[a.ty as usize].can_attack_class(&w.rules, air_classes)
        })
        .count()
}

fn activate_air_idle(w: &mut World, player: u8, k: usize) {
    let danger = w.ai[player as usize].cfg.info.squads.danger_scan_radius.max(1);
    let side = (danger * 141 / 100).max(1);
    let cols = (w.map.width + side - 1) / side;
    let rows = (w.map.height + side - 1) / side;
    let mut cells: Vec<u32> = (0..(cols * rows) as u32).collect();
    crate::ai_base::shuffle(w, &mut cells);
    let s = &mut sq(w, player).squads[k];
    s.air_cells = cells;
    s.air_checked = 0;
}

/// Preferred enemies within DangerScanRadius of a point.
fn enemies_around(w: &World, player: u8, cfg: &BotConfig, at: (i32, i32)) -> Vec<usize> {
    let r = (cfg.info.squads.danger_scan_radius * CELL) as i64;
    (0..w.actors.len())
        .filter(|&i| w.actors[i].alive && dist_sq(w.actors[i].x, w.actors[i].y, at.0, at.1) <= r * r)
        .filter(|&i| is_preferred_enemy(w, player, i, cfg.ignored_targets))
        .collect()
}

/// OpenRA NearToPosSafely: safe when there are no enemies near the point, or
/// too little anti-air for the squad (then one of them is a target).
fn near_safely(w: &mut World, player: u8, cfg: &BotConfig, at: (i32, i32), squad: usize) -> (bool, Option<usize>) {
    let around = enemies_around(w, player, cfg, at);
    if around.is_empty() {
        return (true, None);
    }
    if count_anti_air(w, cfg, &around) * MISSILE_UNIT_MULTIPLIER < squad {
        return (true, crate::ai_units::pick(w, &around));
    }
    (false, None)
}

fn air_should_flee(w: &World, player: u8, cfg: &BotConfig, k: usize) -> bool {
    let units = units_of(w, player, &w.ai[player as usize].squads.squads[k]);
    let (enemies, own_building) = danger_around(w, player, cfg, &units);
    !own_building && !enemies.is_empty() && count_anti_air(w, cfg, &enemies) * MISSILE_UNIT_MULTIPLIER > units.len()
}

fn air_idle(w: &mut World, player: u8, cfg: &BotConfig, k: usize) {
    if air_should_flee(w, player, cfg, k) {
        change_state(w, player, k, State::AirFlee);
        return;
    }
    let units = units_k(w, player, k);
    let from = center_position(w, &units);
    let danger = cfg.info.squads.danger_scan_radius.max(1);
    let side = (danger * 141 / 100).max(1);
    let cols = ((w.map.width + side - 1) / side).max(1);
    for _ in 0..=MAX_AIR_CHECKS {
        let s = &mut sq(w, player).squads[k];
        if s.air_cells.is_empty() {
            return;
        }
        if s.air_checked >= s.air_cells.len() {
            s.air_checked = 0;
        }
        let idx = s.air_cells[s.air_checked] as i32;
        s.air_checked += 1;
        // OpenRA spaces the checks by DangerScanRadius but counts the
        // columns by the larger square side, so it never looks at the far
        // edges of a map; WebRA spaces them by the side.
        let cell = ((idx % cols) * side + side / 2, (idx / cols) * side + side / 2);
        if !w.map.contains(cell.0, cell.1) {
            continue;
        }
        let to = (cell_center(cell.0), cell_center(cell.1));
        // Enemy anti-air along the way (OpenRA counts every actor on the line, own ones too).
        let on_line: Vec<usize> = actors_on_line(w, from, to, danger * CELL)
            .into_iter()
            .filter(|&i| is_preferred_enemy(w, player, i, cfg.ignored_targets))
            .collect();
        if count_anti_air(w, cfg, &on_line) * MISSILE_UNIT_MULTIPLIER >= units.len() {
            continue;
        }
        if let (true, Some(t)) = near_safely(w, player, cfg, to, units.len()) {
            let n = sq(w, player).squads[k].air_cells.len() as i32;
            let next = rand(w, 0, n) as usize;
            sq(w, player).squads[k].air_checked = next;
            set_target(w, player, k, Some((t, (0, 0))));
            change_state(w, player, k, State::AirAttack);
            return;
        }
    }
}

/// Enemy actors within `width` of the segment from `a` to `b` (OpenRA FindActorsOnLine).
fn actors_on_line(w: &World, a: (i32, i32), b: (i32, i32), width: i32) -> Vec<usize> {
    let (dx, dy) = ((b.0 - a.0) as i64, (b.1 - a.1) as i64);
    let len2 = (dx * dx + dy * dy).max(1);
    (0..w.actors.len())
        .filter(|&i| {
            let p = &w.actors[i];
            if !p.alive || !p.in_world() {
                return false;
            }
            let (px, py) = ((p.x - a.0) as i64, (p.y - a.1) as i64);
            let t = (px * dx + py * dy).clamp(0, len2);
            let (cx, cy) = (a.0 as i64 + dx * t / len2, a.1 as i64 + dy * t / len2);
            let (ex, ey) = (p.x as i64 - cx, p.y as i64 - cy);
            ex * ex + ey * ey <= width as i64 * width as i64
        })
        .collect()
}

fn ammo(w: &World, i: usize) -> (i32, i32) {
    if w.is_helicopter(i) {
        w.heli_ammo(i)
    } else {
        (w.ammo_left(i), w.max_ammo(i))
    }
}

/// OpenRA IsRearming: on the way back to a rearm structure, or reloading
/// on it (a plane parked with full ammo waits for orders).
fn is_rearming(w: &World, i: usize) -> bool {
    let a = &w.actors[i];
    let (left, max) = ammo(w, i);
    a.heli.task == crate::helicopter::HeliTask::Resupply
        || a.air.phase == crate::plane::Phase::Returning
        || (a.air.phase == crate::plane::Phase::Parked && left < max)
}

fn air_attack(w: &mut World, player: u8, cfg: &BotConfig, k: usize) {
    let Some(l) = center_unit(w, player, k) else { return };
    if !target_valid(w, player, cfg, k, l) {
        let t = closest_enemy(w, player, cfg, k, l, None);
        set_target(w, player, k, t);
        if t.is_none() {
            change_state(w, player, k, State::AirFlee);
            return;
        }
    }
    let Some(t) = target_actor(w, player, k) else { return };
    let units = units_k(w, player, k);
    let (tx, ty) = (w.actors[t].x, w.actors[t].y);
    let nearest = units.iter().copied().min_by_key(|&i| (dist_sq(w.actors[i].x, w.actors[i].y, tx, ty), i)).unwrap_or(l);
    let at = (w.actors[nearest].x, w.actors[nearest].y);
    if !near_safely(w, player, cfg, at, units.len()).0 {
        change_state(w, player, k, State::AirFlee);
        return;
    }
    let tr = w.make_ref(t);
    for u in units {
        if busy_attack(w, u) || is_rearming(w, u) {
            continue;
        }
        let r = w.make_ref(u);
        if ammo(w, u).0 <= 0 {
            w.queue_order(Order::ReturnToBase { player, ids: vec![r] });
            continue;
        }
        if !can_attack(w, u, t) {
            continue;
        }
        if w.targetable(t, player) {
            w.queue_order(Order::Attack { player, ids: vec![r], target: tr });
        } else {
            // A structure under the fog: fly there first (the engine only
            // takes attack orders on what the player sees; OpenRA's bots
            // attack the frozen structure).
            let (tx, ty) = (w.actors[t].x, w.actors[t].y);
            w.queue_order(Order::Move { player, ids: vec![r], x: tx, y: ty, attack_move: false });
        }
    }
}

fn air_flee(w: &mut World, player: u8, k: usize) {
    let units = units_k(w, player, k);
    for u in units {
        if is_rearming(w, u) {
            continue;
        }
        let r = w.make_ref(u);
        let (left, max) = ammo(w, u);
        if left < max {
            w.queue_order(Order::ReturnToBase { player, ids: vec![r] });
            continue;
        }
        let to = random_building_location(w, player);
        w.queue_order(Order::Move { player, ids: vec![r], x: to.0, y: to.1, attack_move: false });
    }
    change_state(w, player, k, State::AirIdle);
}

/// The squads as "Type/State:units" (ai::debug_summary).
pub(crate) fn describe(w: &World, player: u8) -> String {
    let st = &w.ai[player as usize].squads;
    let cell = |r: u32| w.resolve(r).map(|i| w.cell_of(w.actors[i].x, w.actors[i].y));
    let parts: Vec<String> = st
        .squads
        .iter()
        .map(|s| {
            let first = s.units.iter().find_map(|&u| orderable(w, player, u)).map(|i| w.cell_of(w.actors[i].x, w.actors[i].y));
            format!("{:?}/{:?}:{} at {:?} target {:?}", s.kind, s.state, units_of(w, player, s).len(), first, cell(s.target))
        })
        .collect();
    parts.join(" ")
}

/// What a bot's naval squads do right now (examples/naval_probe.rs).
#[derive(Clone, Copy, Debug, Default)]
pub struct NavalReport {
    /// Naval squads and the ships in them.
    pub squads: usize,
    pub ships: usize,
    /// Ships of the largest naval squad.
    pub largest: usize,
    /// Ships in naval squads that idle without a target.
    pub idle_ships: usize,
    /// Attacks naval squads started so far.
    pub attacks: u32,
}

pub fn naval_report(w: &World, player: u8) -> NavalReport {
    let st = &w.ai[player as usize].squads;
    let mut r = NavalReport { attacks: st.naval_attacks, ..NavalReport::default() };
    for (k, s) in st.squads.iter().enumerate().filter(|(_, s)| s.kind == SquadType::Naval) {
        let n = units_of(w, player, s).len();
        r.squads += 1;
        r.ships += n;
        r.largest = r.largest.max(n);
        if s.state == State::GroundIdle && target_actor(w, player, k).is_none() {
            r.idle_ships += n;
        }
    }
    r
}

/// Each naval squad that idles without a target (the squads
/// `naval_report` counts as idle): its id and its ships (tests).
#[cfg(test)]
pub(crate) fn idle_naval_squads(w: &World, player: u8) -> Vec<(u32, Vec<usize>)> {
    let st = &w.ai[player as usize].squads;
    st.squads
        .iter()
        .enumerate()
        .filter(|(k, s)| s.kind == SquadType::Naval && s.state == State::GroundIdle && target_actor(w, player, *k).is_none())
        .map(|(_, s)| (s.id, units_of(w, player, s)))
        .filter(|(_, ships)| !ships.is_empty())
        .collect()
}

/// The target actor of `player`'s first naval squad (tests).
#[cfg(test)]
pub(crate) fn naval_target(w: &World, player: u8) -> Option<usize> {
    let k = squad_of_type(w, player, SquadType::Naval)?;
    target_actor(w, player, k)
}

/// Point `player`'s first naval squad at actor `t` and run its check for
/// a target it cannot see (tests).
#[cfg(test)]
pub(crate) fn naval_target_check(w: &mut World, player: u8, t: usize) {
    let k = squad_of_type(w, player, SquadType::Naval).expect("a naval squad");
    set_target(w, player, k, Some((t, (0, 0))));
    check_blind(w, player, k);
}

/// Own living units in squads of `kind` (tests).
#[cfg(test)]
pub(crate) fn squad_units(w: &World, player: u8, kind: SquadType) -> Vec<usize> {
    w.ai[player as usize].squads.squads.iter().filter(|s| s.kind == kind).flat_map(|s| units_of(w, player, s)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A member of an attacking squad that waits short of range (behind
    /// other units, or for a short way) is not busy: the squad orders it on
    /// toward the target. A member firing at a target in reach keeps firing.
    #[test]
    fn a_squad_re_tasks_members_that_wait_short_of_range() {
        let mut w = World::new(5, 64, &[("russia", true), ("england", false)]);
        let ty = |w: &World, id: &str| w.rules.actor_index(id).unwrap() as u16;
        let (sx, sy) = w.players[0].start;
        let foe = w.spawn_unit(ty(&w, "2TNK"), 1, cell_center(sx + 12), cell_center(sy + 6), 0);
        w.actors[foe].hp = 1_000_000;
        w.actors[foe].reload = [1_000_000; crate::world::MAX_WEAPONS];
        let firing = w.spawn_unit(ty(&w, "3TNK"), 0, cell_center(sx + 9), cell_center(sy + 6), 256);
        let waiting = w.spawn_unit(ty(&w, "3TNK"), 0, cell_center(sx + 2), cell_center(sy + 6), 256);
        w.players[0].explored.iter_mut().for_each(|e| *e = 1);
        w.add_reveal(0, w.actors[foe].x, w.actors[foe].y, 6 * CELL, 25 * 600);
        w.update_vision();
        w.step();
        let tr = w.make_ref(foe);
        for &u in &[firing, waiting] {
            let a = &mut w.actors[u];
            a.activity = Activity::Attack;
            a.target = tr;
            a.forced = false;
        }
        // The rear tank waits for a short way into range to show up.
        let tick = w.tick;
        let a = &mut w.actors[waiting];
        a.chase_cell = w.map.idx(sx + 12, sy + 6) as u32;
        a.goal = w.map.idx(sx + 3, sy + 6) as u32;
        a.range_retry = tick + crate::attack_range::RETRY_TICKS;
        assert!(w.attack_firing(firing) && busy_attack(&w, firing));
        assert!(w.range_waiting(waiting) && !busy_attack(&w, waiting) && !w.attack_firing(waiting));
        let k = new_squad(&mut w, 0, SquadType::Assault, Some((foe, (0, 0))));
        let refs: Vec<u32> = [firing, waiting].iter().map(|&u| w.make_ref(u)).collect();
        let s = &mut sq(&mut w, 0).squads[k];
        s.units = refs;
        s.state = State::GroundAttack;
        s.last_updated = tick;
        let cfg = w.ai[0].cfg.clone();
        ground_attack(&mut w, 0, &cfg, k);
        w.step();
        assert_eq!(w.actors[firing].activity, Activity::Attack, "the firing tank keeps firing");
        assert_ne!(w.actors[waiting].activity, Activity::Attack, "the waiting tank got a new order");
        assert!(w.actors[waiting].attack_move, "an attack move toward the target");
    }
}
