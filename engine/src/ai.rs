//! Skirmish AI: every AI slot runs one of OpenRA's four Red Alert bots (Rush,
//! Normal, Turtle, Naval; ai_bots.rs) with OpenRA's module configs from
//! rules.json. It plays by the same rules and economy as a human and runs in
//! lockstep on every client: all its randomness comes from the world RNG.
//!
//! The modules, ported from OpenRA.Mods.Common/Traits/BotModules:
//!
//! | OpenRA module | file |
//! |---|---|
//! | BaseBuilderBotModule (+ BaseBuilderQueueManager) | ai_base.rs |
//! | UnitBuilderBotModule | ai_units.rs |
//! | SquadManagerBotModule (assault, rush, air, naval, protection squads) | ai_squads.rs, ai_fuzzy.rs |
//! | HarvesterBotModule, ResourceMapBotModule | ai_harvest.rs |
//! | McvManagerBotModule, McvExpansionManagerBotModule | ai_mcv.rs |
//! | SupportPowerBotModule | ai_support.rs |
//! | BuildingRepairBotModule, PowerDownBotModule | ai_upkeep.rs |
//! | MinelayerBotModule | ai_mines.rs |
//! | CaptureManagerBotModule | ai_infantry.rs |
//!
//! WebRA additions: in free for all and team games each AI picks one enemy
//! player to attack (below): the nearest hostile base, and among equally near
//! ones a player that recently hit its structures, else the one the fewest
//! other AIs already attack, so neighbours do not gang up on one player. Its
//! squads prefer that player's actors. AI teammates attack the same enemy as
//! their team leader. Allies and neutral actors are never targeted. Like most
//! skirmish AIs it knows where enemy structures are (OpenRA's squads only see
//! what is visible; without the bases known, games on large maps could stall).
//! When its economy runs dry it sells surplus structures for one more army
//! (ai_economy.rs). While thunderstorms can strike it covers its power plants
//! with WebRA's Lightning Rods (ai_lightning.rs).

use crate::ai_bots::{BotConfig, BotType, Difficulty};
use crate::math::{dist, CELL};
use crate::rules::Kind;
use crate::world::{AiDifficulty, World};
use std::sync::Arc;

/// Enemy bases within this distance of the nearest one count as equally near.
const NEAR_TIE: i32 = 8 * CELL;
/// How long an attack target is kept before it is reconsidered (one minute).
const RETARGET_TICKS: u32 = 60 * crate::world::TICKS_PER_SECOND;
/// How long a player that damaged our structures stays the preferred target.
const GRUDGE_TICKS: u32 = 2 * RETARGET_TICKS;
/// Most attack notifications kept between two bot ticks.
const MAX_EVENTS: usize = 64;

/// One hit on an own actor (OpenRA IBotRespondToAttack.RespondToAttack).
#[derive(Clone, Copy, Debug)]
pub(crate) struct AttackEvent {
    /// Actor reference of the victim.
    pub victim: u32,
    /// Actor reference of the attacker.
    pub attacker: u32,
    /// Health before and after the hit.
    pub before: i32,
    pub after: i32,
}

#[derive(Clone)]
pub struct AiState {
    pub player: u8,
    /// The OpenRA bot type this slot plays.
    pub bot: BotType,
    pub difficulty: AiDifficulty,
    pub(crate) cfg: Arc<BotConfig>,
    /// Enemy player the squads go for, and when to reconsider it.
    pub target_player: Option<u8>,
    retarget_at: u32,
    /// Game seed, to break ties between equally good choices without
    /// favouring low player slots.
    pub salt: u64,
    /// Builds and defends its base but never sends attack squads. Not a
    /// lobby option: fairness sweeps (examples/target_sweep.rs) use it to
    /// stand in for a human who turtles.
    pub passive: bool,
    /// Per player: last tick it damaged one of our structures.
    pub(crate) hurt_at: Vec<Option<u32>>,
    /// The modules drew their random start delays (OpenRA TraitEnabled).
    started: bool,
    /// Hits on own actors since the last bot tick.
    pub(crate) events: Vec<AttackEvent>,
    pub(crate) base: crate::ai_base::BaseState,
    pub(crate) units: crate::ai_units::UnitState,
    pub(crate) squads: crate::ai_squads::SquadState,
    pub(crate) harvest: crate::ai_harvest::HarvestState,
    pub(crate) mcv: crate::ai_mcv::McvState,
    pub(crate) upkeep: crate::ai_upkeep::UpkeepState,
    pub(crate) support: crate::ai_support::SupportState,
    pub(crate) capture: crate::ai_infantry::CaptureState,
    pub(crate) mines: crate::ai_mines::MineState,
    /// Which water reaches an enemy, this bot tick (ai_naval.rs).
    pub(crate) reach: crate::ai_naval::ReachCache,
    /// Tick of the last structure sold for cash (ai_economy.rs).
    pub(crate) last_sale: u32,
}

impl AiState {
    pub fn new(rules: &crate::rules::Rules, player: u8, bot: BotType, difficulty: AiDifficulty) -> AiState {
        AiState {
            player,
            bot,
            difficulty,
            cfg: Arc::new(BotConfig::new(rules, bot)),
            target_player: None,
            retarget_at: 0,
            salt: 0,
            passive: false,
            hurt_at: Vec::new(),
            started: false,
            events: Vec::new(),
            base: Default::default(),
            units: Default::default(),
            squads: Default::default(),
            harvest: Default::default(),
            mcv: Default::default(),
            upkeep: Default::default(),
            support: Default::default(),
            capture: Default::default(),
            mines: Default::default(),
            reach: Default::default(),
            last_sale: 0,
        }
    }

    pub(crate) fn level(&self) -> Difficulty {
        Difficulty(self.difficulty)
    }
}

/// One bot tick (OpenRA ModularBot ticks its modules every world tick, in
/// the order of ai.yaml; attack notifications reach them first).
pub fn think(w: &mut World, player: u8) {
    let st = &mut w.ai[player as usize];
    if !st.started {
        st.started = true;
        start_modules(w, player);
    }
    let events = std::mem::take(&mut w.ai[player as usize].events);
    for e in events {
        respond_to_attack(w, player, e);
    }
    update_target_player(w, player);
    w.refresh_reach_counts();
    crate::ai_harvest::tick_resource_map(w, player);
    crate::ai_support::tick(w, player);
    crate::ai_harvest::tick(w, player);
    crate::ai_base::tick(w, player);
    crate::ai_upkeep::tick_power_down(w, player);
    crate::ai_squads::tick(w, player);
    crate::ai_mcv::tick(w, player);
    crate::ai_units::tick(w, player);
    crate::ai_mines::tick(w, player);
    crate::ai_infantry::tick_capture(w, player);
    crate::ai_economy::tick(w, player);
}

/// OpenRA TraitEnabled of every module: random first delays, so not every
/// AI evaluates on the same tick.
fn start_modules(w: &mut World, player: u8) {
    crate::ai_base::start(w, player);
    crate::ai_units::start(w, player);
    crate::ai_squads::start(w, player);
    crate::ai_harvest::start(w, player);
    crate::ai_mcv::start(w, player);
    crate::ai_upkeep::start(w, player);
    crate::ai_infantry::start_capture(w, player);
    crate::ai_mines::start(w, player);
}

fn respond_to_attack(w: &mut World, player: u8, e: AttackEvent) {
    let (Some(victim), Some(attacker)) = (w.resolve(e.victim), w.resolve(e.attacker)) else { return };
    if w.actors[victim].owner != player {
        // An ally was hit: the squads help (WebRA, AI teammates and allies).
        crate::ai_squads::respond_to_attack(w, player, victim, attacker);
        return;
    }
    crate::ai_base::respond_to_attack(w, player, victim, attacker);
    crate::ai_upkeep::respond_to_attack(w, player, victim, attacker, e);
    crate::ai_squads::respond_to_attack(w, player, victim, attacker);
    crate::ai_harvest::respond_to_attack(w, player, victim, attacker);
    crate::ai_mcv::respond_to_attack(w, player, victim);
    crate::ai_mines::respond_to_attack(w, player, victim, attacker);
    crate::ai_support::note_hidden_attack(w, player, victim, attacker);
}

/// A hit on actor `u` by actor reference `source` (or, without a shooter
/// actor, by the player of the observer's damage source) that took it from
/// `before` to its current health (combat.rs). An AI victim prefers to
/// strike back at the player who hit its structures (`target_candidates`);
/// the victim's AI and its AI allies hear of the hit (`respond_to_attack`).
pub(crate) fn note_damage(w: &mut World, u: usize, source: u32, before: i32) {
    let victim = w.actors[u].owner;
    let shooter = w.resolve(source);
    let Some(attacker) = shooter.map(|s| w.actors[s].owner).or(w.observer.source) else { return };
    if attacker == victim || victim as usize >= w.players.len() {
        return;
    }
    let tick = w.tick;
    if w.actors[u].kind == Kind::Building && w.are_enemies(victim, attacker) && w.players[victim as usize].is_ai {
        if let Some(st) = w.ai.get_mut(victim as usize) {
            if st.hurt_at.len() <= attacker as usize {
                st.hurt_at.resize(attacker as usize + 1, None);
            }
            st.hurt_at[attacker as usize] = Some(tick);
        }
    }
    if shooter.is_none() {
        return;
    }
    let e = AttackEvent { victim: w.make_ref(u), attacker: source, before, after: w.actors[u].hp };
    for p in 0..w.players.len().min(w.ai.len()) {
        let pl = &w.players[p];
        if pl.is_ai && !pl.defeated && (p == victim as usize || w.are_allies(p as u8, victim)) {
            let events = &mut w.ai[p].events;
            if events.len() < MAX_EVENTS {
                events.push(e);
            }
        }
    }
}

/// One line about a bot's state for balance debugging (examples/ai_probe.rs):
/// its target player, squads (type, state, units) and units at the base.
pub fn debug_summary(w: &World, player: u8) -> String {
    let st = &w.ai[player as usize];
    format!(
        "{:?} {:?} target {:?} hanging {} squads {}",
        st.bot,
        st.difficulty,
        st.target_player,
        st.squads.hanging.len(),
        crate::ai_squads::describe(w, player)
    )
}

// ---- Shared helpers -------------------------------------------------------------------

pub(crate) fn owned_buildings(w: &World, player: u8) -> Vec<usize> {
    (0..w.actors.len()).filter(|&i| w.actors[i].alive && w.actors[i].owner == player && w.actors[i].kind == Kind::Building).collect()
}

/// Own living actors of the listed types (OpenRA AIUtils.CountActorByCommonName
/// counts these, in the world or not).
pub(crate) fn own_of(w: &World, player: u8, types: &[u16]) -> Vec<usize> {
    (0..w.actors.len()).filter(|&i| w.actors[i].alive && w.actors[i].owner == player && types.contains(&w.actors[i].ty)).collect()
}

pub(crate) fn count_own(w: &World, player: u8, types: &[u16]) -> usize {
    w.actors.iter().filter(|a| a.alive && a.owner == player && types.contains(&a.ty)).count()
}

/// Centre of a player's starting yard.
pub(crate) fn base_point(w: &World, player: u8) -> (i32, i32) {
    let (sx, sy) = w.players[player as usize].start;
    (crate::world::cell_center(sx + 1), crate::world::cell_center(sy + 2))
}

/// Uniform random integer in `lo..hi` from the world RNG (OpenRA LocalRandom.Next).
pub(crate) fn rand(w: &mut World, lo: i32, hi: i32) -> i32 {
    w.rng.range(lo, hi)
}

/// OpenRA damage states by health share: 0 Undamaged, 1 Light, 2 Medium,
/// 3 Heavy, 4 Critical, 5 Dead (Health.DamageState).
pub(crate) fn damage_state(hp: i32, max: i32) -> u8 {
    let (hp, max) = (hp as i64, max.max(1) as i64);
    if hp <= 0 {
        5
    } else if hp * 100 <= max * 25 {
        4
    } else if hp * 100 <= max * 50 {
        3
    } else if hp * 100 <= max * 75 {
        2
    } else if hp < max {
        1
    } else {
        0
    }
}

/// OpenRA SquadManagerBotModule.IsPreferredEnemyUnit: an enemy actor that is
/// not a husk, has target types outside `ignored` (TT_* bits) and that
/// `player` can see. Enemy structures count as seen (the AI knows the bases),
/// and so do the units of a player without structures.
pub(crate) fn is_preferred_enemy(w: &World, player: u8, i: usize, ignored: u32) -> bool {
    is_preferred_enemy_with(w, player, i, ignored, |p| has_buildings(w, p))
}

/// `is_preferred_enemy` with whether a player has structures given, for
/// callers that check many actors (ai_naval.rs counts them once).
pub(crate) fn is_preferred_enemy_with(w: &World, player: u8, i: usize, ignored: u32, has_buildings: impl Fn(u8) -> bool) -> bool {
    let a = &w.actors[i];
    if !a.alive || !a.in_world() || matches!(a.kind, Kind::Husk | Kind::Crate | Kind::Mine | Kind::Proxy) {
        return false;
    }
    if !w.are_enemies(player, a.owner) || w.players[a.owner as usize].defeated {
        return false;
    }
    // The last units of a player without structures are hunted down, even
    // aircraft squads would otherwise ignore (or AI-only games could stall).
    let hunted = !has_buildings(a.owner);
    let tt = crate::ai_bots::target_types(w, i);
    if tt == 0 || (tt & ignored != 0 && !hunted) {
        return false;
    }
    // Structures are known, and so are hunted units.
    a.kind == Kind::Building || w.targetable(i, player) || (hunted && !w.is_cloaked_from(i, player))
}

/// Whether a weapon of unit `i` can hit actor `t` as it is now (OpenRA
/// AttackBase.HasAnyValidWeapons).
pub(crate) fn can_attack(w: &World, i: usize, t: usize) -> bool {
    w.rules.actors[w.actors[i].ty as usize].can_attack_class(&w.rules, w.target_class(t))
}

/// Where unit `i` can attack actor `t` from (OpenRA FindEnemies and
/// ClosestTo: the target itself or one of eight points at the edge of the
/// unit's weapon range around it, which the unit can reach); the offset
/// from the target of the nearest such point, or None.
///
/// WebRA: a ship can only fire at what its owner sees, so for a target out
/// of sight it must get within its own sight (less a cell, after the
/// weather, `sight_reach`) instead of its
/// weapon range: a Cruiser (sight 7 cells, range 20) on a river stretch 20
/// cells from a structure cannot see it, and OpenRA's test sent fleets
/// there to wait for good. (Ground squads aim at a structure itself.)
pub(crate) fn attack_offset(w: &World, i: usize, t: usize) -> Option<(i32, i32)> {
    let d = w.domain_of(i);
    if d == crate::rules::Domain::Air {
        return Some((0, 0));
    }
    let ci = w.cell_index(w.actors[i].x, w.actors[i].y);
    let comp = w.pass_for(d).component[ci];
    reach_offset(w, w.actors[i].owner, w.actors[i].ty, comp, t)
}

/// `attack_offset` for a unit of `player` of type `ty` (ground or water)
/// anywhere in connectivity component `comp` of its domain's passability.
pub(crate) fn reach_offset(w: &World, player: u8, ty: u16, comp: u32, t: usize) -> Option<(i32, i32)> {
    let info = &w.rules.actors[ty as usize];
    let d = info.unit.as_ref().map_or(crate::rules::Domain::Ground, |u| w.rules.locomotors[u.locomotor].domain);
    // The reach of the weapons that can hit it (GetMaximumRangeVersusTarget).
    let mut r = info.range_against(&w.rules, w.target_class(t));
    if d == crate::rules::Domain::Water && !w.targetable(t, player) {
        r = r.min(sight_reach(w, ty)).max(0);
    }
    offset_within(w, w.pass_for(d), comp, t, r)
}

/// Where ship `i` should aim to attack actor `t` (WebRA, naval squads): the
/// nearest of OpenRA's nine points at the smaller of its weapon range and
/// its sight (less a cell) that it can reach, so it sees the target when
/// it gets there, else `attack_offset`. OpenRA's squads send every unit to
/// the point the leader picked at the leader's range, where ships with a
/// shorter range or sight could not fire.
pub(crate) fn view_offset(w: &World, i: usize, t: usize) -> Option<(i32, i32)> {
    let info = &w.rules.actors[w.actors[i].ty as usize];
    let d = w.domain_of(i);
    let r = info.range_against(&w.rules, w.target_class(t));
    if r == 0 || d != crate::rules::Domain::Water {
        return None;
    }
    let pass = w.pass_for(d);
    let comp = pass.component[w.cell_index(w.actors[i].x, w.actors[i].y)];
    offset_within(w, pass, comp, t, r.min(sight_reach(w, w.actors[i].ty)).max(0)).or_else(|| attack_offset(w, i, t))
}

/// How near a unit of type `ty` must get to an actor to see it: its sight
/// as the weather leaves it (rain, snow, sandstorms; vision.rs uses the
/// same), less a cell.
pub(crate) fn sight_reach(w: &World, ty: u16) -> i32 {
    w.env.sight(w.rules.actors[ty as usize].sight) - CELL
}

/// The nearest of the target itself and the eight points `r` around it
/// that are open and in component `comp` of `pass`, as an offset.
fn offset_within(w: &World, pass: &crate::flowfield::Passability, comp: u32, t: usize, r: i32) -> Option<(i32, i32)> {
    let diag = r * 724 / 1024;
    let (tx, ty) = (w.actors[t].x, w.actors[t].y);
    [(0, 0), (r, 0), (-r, 0), (0, r), (0, -r), (diag, diag), (-diag, diag), (-diag, -diag), (diag, -diag)]
        .into_iter()
        .filter(|&(ox, oy)| {
            let (x, y) = (tx + ox, ty + oy);
            if x < 0 || y < 0 || x >= w.map.width * CELL || y >= w.map.height * CELL {
                return false;
            }
            let c = w.cell_index(x, y);
            !pass.blocked[c] && pass.component[c] == comp
        })
        .min_by_key(|&(ox, oy)| (ox as i64 * ox as i64 + oy as i64 * oy as i64, ox, oy))
}

/// The enemy player `player` attacks, while it is still in the game.
pub(crate) fn current_target(w: &World, player: u8) -> Option<u8> {
    w.ai.get(player as usize).and_then(|a| a.target_player).filter(|&t| is_live_enemy(w, player, t))
}

// ---- Target choice in free for alls ------------------------------------------------

pub(crate) fn has_buildings(w: &World, player: u8) -> bool {
    w.actors.iter().any(|a| a.alive && a.owner == player && a.kind == Kind::Building)
}

/// A player still in the game that `player` may attack.
pub(crate) fn is_live_enemy(w: &World, player: u8, p: u8) -> bool {
    w.are_enemies(player, p) && !w.players[p as usize].defeated && w.actors.iter().any(|a| a.alive && a.owner == p)
}

/// Military strength: value of armed units and armed structures.
fn strength(w: &World, player: u8) -> i64 {
    w.actors
        .iter()
        .filter(|a| a.alive && a.owner == player)
        .filter(|a| {
            let info = &w.rules.actors[a.ty as usize];
            !info.weapons.is_empty() && !info.is_wall()
        })
        .map(|a| w.rules.actors[a.ty as usize].cost as i64)
        .sum()
}

/// How far a player's base is: its starting yard while it has structures
/// (an expansion toward someone does not make it a nearer target), else its
/// nearest unit.
fn distance_to_player(w: &World, from: (i32, i32), p: u8) -> i32 {
    if has_buildings(w, p) {
        let b = base_point(w, p);
        return dist(from.0, from.1, b.0, b.1);
    }
    w.actors
        .iter()
        .filter(|a| a.alive && a.owner == p && a.in_world() && a.kind != Kind::Mine)
        .map(|a| dist(from.0, from.1, a.x, a.y))
        .min()
        .unwrap_or(i32::MAX)
}

/// Other AIs that attack `p`, not counting `player` and its allies (AI
/// teammates attack their leader's target on purpose).
fn attackers_of(w: &World, player: u8, p: u8) -> usize {
    (0..w.players.len() as u8)
        .filter(|&q| q != player && !w.are_allies(player, q) && w.players[q as usize].is_ai && !w.players[q as usize].defeated)
        .filter(|&q| w.ai.get(q as usize).is_some_and(|a| a.target_player == Some(p)))
        .count()
}

/// Whether `p` damaged one of `player`'s structures within `GRUDGE_TICKS`.
fn has_grudge(w: &World, player: u8, p: u8) -> bool {
    w.ai.get(player as usize).and_then(|a| a.hurt_at.get(p as usize).copied().flatten()).is_some_and(|t| w.tick < t + GRUDGE_TICKS)
}

/// An enemy player `player` could attack and what speaks for it.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Candidate {
    pub player: u8,
    /// It recently damaged one of our structures.
    pub grudge: bool,
    /// Other AIs already attacking it.
    pub attackers: usize,
    /// Seeded tie break: how far around the map centre the candidate's base
    /// is from ours, in the game's direction (`turn_from`), then a seeded hash.
    tie: (i32, u64),
    strength: i64,
}

impl Candidate {
    /// What makes a target clearly better than another (hysteresis in
    /// `update_target_player`): a grudge first, then fewer attackers.
    fn merit(&self) -> (bool, usize) {
        (!self.grudge, self.attackers)
    }

    /// Full order: merit, then the seeded tie break, then strength (weakest
    /// first; only decides exact ties).
    fn rank(&self) -> (bool, usize, (i32, u64), i64) {
        (!self.grudge, self.attackers, self.tie, self.strength)
    }
}

/// The enemies `player` may attack, best first: only bases about as near as
/// the nearest one (within `NEAR_TIE`); among those a player that recently
/// hit our structures, then the one the fewest other AIs already attack, so
/// two neighbours do not gang up on the same player; then a seeded tie break
/// that favours no slot (the next base around the map in the game's
/// direction, `turn_from`); strength only decides exact ties.
pub(crate) fn target_candidates(w: &World, player: u8) -> Vec<Candidate> {
    let base = base_point(w, player);
    let enemies: Vec<(u8, i32)> =
        (0..w.players.len() as u8).filter(|&p| is_live_enemy(w, player, p)).map(|p| (p, distance_to_player(w, base, p))).collect();
    let Some(nearest) = enemies.iter().map(|&(_, d)| d).min() else { return Vec::new() };
    let turn = |p: u8| turn_from(w, player, base_point(w, p));
    let mut out: Vec<Candidate> = enemies
        .iter()
        .filter(|&&(_, d)| d <= nearest.saturating_add(NEAR_TIE))
        .map(|&(p, _)| Candidate {
            player: p,
            grudge: has_grudge(w, player, p),
            attackers: attackers_of(w, player, p),
            tie: (turn(p), tie_break(w, player, p as u64)),
            strength: strength(w, p),
        })
        .collect();
    out.sort_by_key(|c| (c.rank(), c.player));
    out
}

/// How far `to` lies around the map centre from `player`'s base, as an
/// angle (0 to 1023) clockwise or counterclockwise: the direction is the same
/// for every AI of a game and picked by its seed. Among otherwise equal
/// targets every AI takes the next base in that direction, so AIs on a ring
/// each take a different neighbour instead of two of them meeting at one.
fn turn_from(w: &World, player: u8, to: (i32, i32)) -> i32 {
    let centre = (w.map.width * CELL / 2, w.map.height * CELL / 2);
    let angle = |(x, y): (i32, i32)| crate::math::facing_of(x - centre.0, y - centre.1).unwrap_or(0);
    let salt = w.ai.get(player as usize).map_or(0, |a| a.salt);
    let delta = (angle(to) - angle(base_point(w, player))).rem_euclid(1024);
    if (salt >> 17) & 1 == 0 {
        delta
    } else {
        (1024 - delta) % 1024
    }
}

/// The enemy player to attack from `player`'s point of view (see `target_candidates`).
pub(crate) fn choose_target_player(w: &World, player: u8) -> Option<u8> {
    target_candidates(w, player).first().map(|c| c.player)
}

/// Deterministic pseudo-random key for breaking ties between equal choices
/// (seeded by the game, so no player slot or map side is favoured).
fn tie_break(w: &World, player: u8, choice: u64) -> u64 {
    let salt = w.ai.get(player as usize).map_or(0, |a| a.salt);
    let mut z = salt ^ ((player as u64) << 16) ^ choice;
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

/// The team leader: the lowest slot AI player still alive on `player`'s team.
fn team_leader(w: &World, player: u8) -> u8 {
    if w.players[player as usize].team == 0 {
        return player;
    }
    (0..w.players.len() as u8)
        .find(|&p| w.are_allies(player, p) && w.players[p as usize].is_ai && !w.players[p as usize].defeated)
        .unwrap_or(player)
}

/// Keep (or pick) the enemy player this AI attacks. AI teammates follow their
/// leader's choice so the team attacks one enemy together.
pub(crate) fn update_target_player(w: &mut World, player: u8) -> Option<u8> {
    let leader = team_leader(w, player);
    if leader != player {
        if let Some(t) = w.ai[leader as usize].target_player.filter(|&t| is_live_enemy(w, player, t)) {
            w.ai[player as usize].target_player = Some(t);
            return Some(t);
        }
    }
    let state = &w.ai[player as usize];
    let current = state.target_player.filter(|&t| is_live_enemy(w, player, t));
    if current.is_some() && w.tick < state.retarget_at {
        return current;
    }
    // Keep the current target unless another one is clearly better (a
    // grudge, or fewer attackers): targets do not flip at every retarget.
    let candidates = target_candidates(w, player);
    let best = candidates.first().copied();
    let kept =
        current.and_then(|c| candidates.iter().find(|k| k.player == c).copied()).filter(|k| best.is_none_or(|b| b.merit() >= k.merit()));
    let chosen = kept.or(best).map(|c| c.player);
    let state = &mut w.ai[player as usize];
    state.target_player = chosen;
    state.retarget_at = w.tick + RETARGET_TICKS;
    chosen
}
