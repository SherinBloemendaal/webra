//! The neutral world of OpenRA maps (mods/ra/rules civilian.yaml,
//! decoration.yaml, husks.yaml and misc.yaml): civilians that wander and
//! panic, civilian and tech buildings, barrels, trees and rocks, ore mines.
//! Bridges have their own module (bridges.rs).
//!
//! Rules come from `world` in rules.json (tools/gen_rules.py `world_info`),
//! one record per actor type with OpenRA's trait values:
//! - target classes of actors that are not hit like their kind (trees only by
//!   warheads that list Trees, bridges as structures on the water), actors
//!   that are never auto-targeted (NoAutoTarget) and actors without health;
//! - HiddenUnderShroud: trees, rocks and mines show once explored, also under the fog;
//! - death: extra death weapons (CivPanicExplosion), an actor spawned in
//!   place (SpawnActorOnDeath: tree husks, the burning V19), explosions on
//!   damage state changes (ExplosionOnDamageTransition: bridges);
//! - tech buildings: Capturable types, GivesCashOnCapture, CashTrickler (oil
//!   derricks pay their owner while it is a combatant, that is not neutral),
//!   OwnerLostAction (back to neutral when the owner is defeated);
//! - infantry: the Hospital's heal (ChangesHealth@HOSPITAL while the owner
//!   has the `hosp` prerequisite), ScaredyCat (panic and run when hit) and
//!   Wanders (idle civilians stroll);
//! - SeedsResource: ore and gem mines grow resources around them;
//! - the map editor's category and the biomes an actor belongs to.

use serde::Deserialize;

/// OpenRA `ExplosionOnDamageTransition`: `weapon` (None: visual only, like
/// BridgeExplode) explodes on the actor when its damage state reaches `state`.
#[derive(Deserialize, Clone, Debug)]
pub struct DamageExplosion {
    pub weapon: Option<usize>,
    pub state: String,
}

/// OpenRA `CashTrickler`.
#[derive(Deserialize, Clone, Debug)]
pub struct CashTrickler {
    pub interval: i32,
    pub initial_delay: i32,
    pub amount: i32,
    /// RequiresCondition granted by GrantConditionOnCombatantOwner: only pays
    /// a combatant owner (not the neutral player).
    pub combatant_only: bool,
}

/// RA's ^Infantry hospital heal: ChangesHealth while the owner has `prerequisite`
/// (a Hospital) and the soldier is damaged.
#[derive(Deserialize, Clone, Debug)]
pub struct HospitalHeal {
    pub prerequisite: String,
    pub step: i32,
    pub delay: i32,
    pub start_if_below: i32,
    pub damage_cooldown: i32,
}

/// OpenRA `ScaredyCat`: civilians panic when hit (and sometimes when they shoot).
#[derive(Deserialize, Clone, Debug)]
pub struct ScaredyCat {
    /// Percent chance to panic when damaged.
    pub panic_chance: i32,
    /// Ticks a panic lasts.
    pub duration: i32,
    /// Speed while panicking, percent.
    pub speed_modifier: i32,
    /// Percent chance to panic when firing.
    pub attack_panic_chance: i32,
}

/// OpenRA `Wanders`: idle civilians walk to a random nearby cell now and then.
#[derive(Deserialize, Clone, Debug)]
pub struct Wanders {
    /// WanderMoveRadius in cells.
    pub radius: i32,
    /// Ticks before a failed pick shrinks the radius.
    pub reduce_delay: i32,
    pub min_delay: i32,
    pub max_delay: i32,
}

/// OpenRA `SeedsResource`: ore and gem mines.
#[derive(Deserialize, Clone, Debug)]
pub struct Seeds {
    /// "ore" or "gems".
    pub resource: String,
    pub interval: i32,
    /// Cells of the random walk that looks for a cell to grow.
    pub max_range: i32,
}

/// The neutral world's traits of an actor type (rules.json `world`).
#[derive(Deserialize, Clone, Default, Debug)]
#[serde(default)]
pub struct WorldTraits {
    /// Target classes (rules::TARGET_*) instead of the kind's; 0: untargetable.
    pub target: Option<u32>,
    /// Targetable `NoAutoTarget`: only attacked when ordered (walls, barrels).
    pub no_auto_target: bool,
    /// Targetable `RequiresForceFire`: only attacked with force fire (bridges).
    pub force_fire: bool,
    /// No Health trait: rocks, fields, husks of trees, bridge huts.
    pub indestructible: bool,
    /// HiddenUnderShroud: drawn once explored, also under the fog.
    pub shroud_only: bool,
    /// Further death weapons (FireWarheadsOnDeath@CIVPANIC).
    pub death_weapons: Vec<usize>,
    /// SpawnActorOnDeath: the actor (id) that takes its place.
    pub spawn_on_death: Option<String>,
    pub damage_explosions: Vec<DamageExplosion>,
    /// GivesCashOnCapture.Amount.
    pub cash_on_capture: i32,
    pub cash_trickler: Option<CashTrickler>,
    pub hospital_heal: Option<HospitalHeal>,
    pub scaredy_cat: Option<ScaredyCat>,
    pub wanders: Option<Wanders>,
    pub seeds: Option<Seeds>,
    pub bridge: Option<crate::bridges::BridgeInfo>,
    /// OpenRA LegacyBridgeHut: engineers enter it to repair its bridge.
    pub bridge_hut: bool,
    /// OpenRA Selectable: can be selected and shows selection decorations
    /// (health bars); trees, barrels and husks cannot.
    pub selectable: bool,
    /// WithDeathAnimation of a structure (the tech buildings' "dead"
    /// sequence): a dying body where it stood, drawn with original art that
    /// has it (infantry_render.rs corpses).
    pub death_animation: bool,
    /// OpenRA RadarColorFromTerrain: shown on the radar in the colour of this
    /// terrain type (Tree, Ore, Gems, Wall) instead of its owner's.
    pub radar_terrain: Option<String>,
    /// MapEditorData.Categories (the editor's palette groups).
    pub category: Option<String>,
    /// Biomes the actor belongs to (MapEditorData tilesets); None: every biome.
    pub biomes: Option<Vec<String>>,
    /// OpenRA TooltipDescription@ally: what the owner and its allies read
    /// (tech buildings: what the capture gives them).
    pub ally_description: String,
    /// OpenRA TooltipDescription@other: what everyone else reads ("Capture to ...").
    pub other_description: String,
    /// Resolved by `Rules::from_raw`: actor type of `spawn_on_death`.
    #[serde(skip)]
    pub spawn_ty: Option<usize>,
    /// Resolved by `Rules::from_raw`: prerequisite token of `hospital_heal`.
    #[serde(skip)]
    pub hospital_token: Option<u16>,
}

/// OpenRA `DamageState` of an actor with health (Health.DamageState).
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub enum DamageState {
    Undamaged,
    Light,
    Medium,
    Heavy,
    Critical,
    Dead,
}

impl DamageState {
    /// OpenRA Health.DamageState: thresholds at 100, 75, 50 and 25 percent.
    pub fn of(hp: i32, max: i32) -> DamageState {
        let (hp, max) = (hp.max(0) as i64, max.max(1) as i64);
        if hp >= max {
            DamageState::Undamaged
        } else if hp == 0 {
            DamageState::Dead
        } else if hp * 100 < max * 25 {
            DamageState::Critical
        } else if hp * 100 < max * 50 {
            DamageState::Heavy
        } else if hp * 100 < max * 75 {
            DamageState::Medium
        } else {
            DamageState::Light
        }
    }

    pub fn parse(s: &str) -> Option<DamageState> {
        Some(match s {
            "undamaged" => DamageState::Undamaged,
            "light" => DamageState::Light,
            "medium" => DamageState::Medium,
            "heavy" => DamageState::Heavy,
            "critical" => DamageState::Critical,
            "dead" => DamageState::Dead,
            _ => return None,
        })
    }
}

/// Bounds for rules validation (modded maps come from strangers).
const TIMER: i32 = 100_000;

fn within(what: &str, v: i32, lo: i32, hi: i32) -> Result<(), String> {
    if v < lo || v > hi {
        return Err(format!("{what} must be between {lo} and {hi}, is {v}"));
    }
    Ok(())
}

impl WorldTraits {
    /// Range and reference checks (rules.rs `Rules::validate`); `n` names a field.
    pub(crate) fn validate(&self, n: &dyn Fn(&str) -> String, weapons: usize, actors: &[crate::rules::ActorInfo]) -> Result<(), String> {
        let weapon = |what: &str, w: usize| if w < weapons { Ok(()) } else { Err(n(&format!("{what}: unknown weapon {w}"))) };
        if self.death_weapons.len() > 4 {
            return Err(n("world.death_weapons may have at most 4 entries"));
        }
        for &w in &self.death_weapons {
            weapon("world.death_weapons", w)?;
        }
        if self.damage_explosions.len() > 4 {
            return Err(n("world.damage_explosions may have at most 4 entries"));
        }
        for e in &self.damage_explosions {
            if let Some(w) = e.weapon {
                weapon("world.damage_explosions", w)?;
            }
            if DamageState::parse(&e.state).is_none() {
                return Err(n("world.damage_explosions.state must be a damage state"));
            }
        }
        if let Some(t) = self.spawn_ty {
            if actors.get(t).is_none_or(|a| a.building.is_none()) {
                return Err(n("world.spawn_on_death must be a structure"));
            }
        }
        within(&n("world.cash_on_capture"), self.cash_on_capture, 0, 1_000_000)?;
        if let Some(c) = &self.cash_trickler {
            within(&n("world.cash_trickler.interval"), c.interval, 1, TIMER)?;
            within(&n("world.cash_trickler.initial_delay"), c.initial_delay, 0, TIMER)?;
            within(&n("world.cash_trickler.amount"), c.amount, -1_000_000, 1_000_000)?;
        }
        if let Some(h) = &self.hospital_heal {
            within(&n("world.hospital_heal.step"), h.step, 0, 100_000_000)?;
            within(&n("world.hospital_heal.delay"), h.delay, 1, TIMER)?;
            within(&n("world.hospital_heal.start_if_below"), h.start_if_below, 0, 100)?;
            within(&n("world.hospital_heal.damage_cooldown"), h.damage_cooldown, 0, TIMER)?;
        }
        if let Some(s) = &self.scaredy_cat {
            within(&n("world.scaredy_cat.panic_chance"), s.panic_chance, 0, 100)?;
            within(&n("world.scaredy_cat.duration"), s.duration, 0, TIMER)?;
            within(&n("world.scaredy_cat.speed_modifier"), s.speed_modifier, 0, 1000)?;
            within(&n("world.scaredy_cat.attack_panic_chance"), s.attack_panic_chance, 0, 100)?;
        }
        if let Some(w) = &self.wanders {
            within(&n("world.wanders.radius"), w.radius, 0, 16)?;
            within(&n("world.wanders.reduce_delay"), w.reduce_delay, 1, TIMER)?;
            within(&n("world.wanders.min_delay"), w.min_delay, 0, TIMER)?;
            within(&n("world.wanders.max_delay"), w.max_delay, w.min_delay, TIMER)?;
        }
        if let Some(s) = &self.seeds {
            if s.resource != "ore" && s.resource != "gems" {
                return Err(n("world.seeds.resource must be ore or gems"));
            }
            within(&n("world.seeds.interval"), s.interval, 1, TIMER)?;
            within(&n("world.seeds.max_range"), s.max_range, 0, 1000)?;
        }
        if let Some(t) = self.target {
            within(&n("world.target"), t as i32, 0, 4095)?;
        }
        if let Some(b) = &self.bridge {
            b.validate(n, weapons, actors)?;
        }
        Ok(())
    }
}

// ---- Simulation state ----------------------------------------------------------------

/// Per-actor state of the neutral world's traits (`Actor::world`). All of it
/// is simulation state (state_hash) except `burning`.
#[derive(Clone, Default, Debug)]
pub struct ActorWorld {
    /// ScaredyCat: the tick the panic started (0: calm).
    pub panic_tick: u32,
    /// Wanders: ticks until the next stroll.
    pub wander_countdown: i32,
    /// Wanders: idle ticks of failed picks (shrink the radius every `reduce_delay`).
    pub wander_idle: i32,
    /// Wanders: the radius of the next pick.
    pub wander_radius: i32,
    /// Wanders: busy with something else last tick (becoming idle restarts the countdown).
    pub wander_busy: bool,
    /// Hospital heal (ChangesHealth): ticks to the next step and damage cooldown ticks left.
    pub heal_ticks: i32,
    pub heal_cooldown: i32,
    /// CashTrickler: ticks to the next payment.
    pub trickle_ticks: i32,
    /// SeedsResource: ticks to the next seed.
    pub seed_ticks: i32,
    /// Presentation only: hit by an Incendiary warhead while damaged (trees
    /// burn: OpenRA WithDamageOverlay@*Burn). Not part of the state hash.
    pub burning: bool,
    /// Presentation only: per fire size (small, medium, large) the tick + 1
    /// it started and the tick + 1 it ended (0: never), for the original
    /// burn-s, burn-m and burn-l start, loop and end. Not part of the state hash.
    pub fire_start: [u32; 3],
    pub fire_end: [u32; 3],
}

impl ActorWorld {
    /// Mix the simulation state into the state hash.
    pub(crate) fn mix(&self, mix: &mut impl FnMut(i64)) {
        for v in [
            self.panic_tick as i64,
            self.wander_countdown as i64,
            self.wander_idle as i64,
            self.wander_radius as i64,
            self.wander_busy as i64,
            self.heal_ticks as i64,
            self.heal_cooldown as i64,
            self.trickle_ticks as i64,
            self.seed_ticks as i64,
        ] {
            mix(v);
        }
    }
}

/// An actor waiting to take a dead one's place (SpawnActorOnDeath) once the
/// dead actor's cells are free.
#[derive(Clone, Debug)]
pub struct PendingSpawn {
    pub ty: u16,
    pub owner: u8,
    pub cx: i32,
    pub cy: i32,
}

/// Passability for the crushers of one player and crush class mask: walls
/// they may drive over are open (cached per passability version).
#[derive(Clone)]
pub struct CrushBlocked {
    pub player: u8,
    pub mask: u8,
    pub version: u32,
    pub blocked: Vec<bool>,
}

/// World state of the neutral world (`World::neutral`).
#[derive(Clone, Default)]
pub struct NeutralState {
    /// Bridges (bridges.rs).
    pub bridges: crate::bridges::BridgeLayer,
    pub pending_spawns: Vec<PendingSpawn>,
    /// Crushers' passability (wall crushing; derived from the world, not hashed).
    pub crush_blocked: Vec<CrushBlocked>,
}

impl NeutralState {
    pub(crate) fn mix(&self, mix: &mut impl FnMut(i64)) {
        self.bridges.mix(mix);
        mix(self.pending_spawns.len() as i64);
    }
}

use crate::map::{Resource, Terrain};
use crate::math::CELL;
use crate::rules::Kind;
use crate::sound_events::{kind_code, SoundEventKind};
use crate::world::{cell_center, Activity, Effect, EffectKind, PendingImpact, World, NONE};

/// Damage type that sets trees alight (OpenRA WithDamageOverlay DamageTypes).
pub const INCENDIARY: &str = "Incendiary";

impl World {
    /// The world traits of actor `i`'s type.
    #[inline]
    pub fn world_traits(&self, i: usize) -> &WorldTraits {
        &self.rules.actors[self.actors[i].ty as usize].world
    }

    // ---- Lifecycle ------------------------------------------------------------------

    /// Starting state of a freshly spawned actor's world traits.
    pub(crate) fn init_world_traits(&mut self, i: usize) {
        let w = &self.rules.actors[self.actors[i].ty as usize].world;
        let trickle = w.cash_trickler.as_ref().map_or(0, |c| c.initial_delay);
        let wander = w.wanders.as_ref().map(|wd| (wd.min_delay, wd.max_delay, wd.radius));
        let mut state = ActorWorld { trickle_ticks: trickle, ..Default::default() };
        // OpenRA Wanders: the first stroll after a random delay.
        if let Some((lo, hi, r)) = wander {
            state.wander_countdown = self.rng.range(lo, hi);
            state.wander_radius = r;
        }
        self.actors[i].world = state;
    }

    /// After the map's actors are placed: tree terrain becomes tree actors
    /// (OpenRA maps place trees as actors; WebRA's generator and editor paint
    /// tree cells) and bridges take their state from the terrain under them.
    pub(crate) fn setup_neutral(&mut self) {
        self.trees_from_terrain();
        self.setup_bridges();
        // No ore under structures (an ore mine stands on its field's middle cell).
        for ci in 0..self.map.cells() {
            let b = self.building_at[ci];
            if b != NONE && self.occupies(b as usize, ci) {
                self.map.clear_resource(ci);
            }
        }
        self.update_world_terrain();
    }

    /// Turn every tree cell of the terrain into a neutral tree actor that
    /// occupies that cell: a single-cell tree of the biome, picked from the
    /// cell's position (the same map always gets the same trees). The cell
    /// becomes clear ground under the tree.
    fn trees_from_terrain(&mut self) {
        let Some(owner) = self.neutral_player() else { return };
        let biome = self.env.biome.name();
        // (type, dx, dy of its one occupied cell)
        let mut kinds: Vec<(u16, i32, i32)> = Vec::new();
        for (t, a) in self.rules.actors.iter().enumerate() {
            let (Some(b), Some(spawn)) = (a.building.as_ref(), a.world.spawn_ty) else { continue };
            let living_tree =
                a.world.category.as_deref() == Some("Tree") && self.rules.actors[spawn].world.category.as_deref() == Some("Tree");
            if !living_tree || !a.world.biomes.as_ref().is_none_or(|bs| bs.iter().any(|x| x == biome)) {
                continue;
            }
            let cells: Vec<(i32, i32)> = b.cells().collect();
            if let [(dx, dy)] = cells[..] {
                kinds.push((t as u16, dx, dy));
            }
        }
        if kinds.is_empty() {
            return;
        }
        let (w, h) = (self.map.width, self.map.height);
        for y in 0..h {
            for x in 0..w {
                let ci = self.map.idx(x, y);
                if self.map.terrain[ci] != Terrain::Tree || self.building_at[ci] != NONE {
                    continue;
                }
                let k = (x.wrapping_mul(73_856_093) ^ y.wrapping_mul(19_349_663)).unsigned_abs() as usize % kinds.len();
                let (ty, dx, dy) = kinds[k];
                self.map.terrain[ci] = Terrain::Clear;
                if self.spawn_building(ty, owner, x - dx, y - dy).is_none() {
                    // Cannot happen (the cell was free); keep the tree as terrain then.
                    self.map.terrain[ci] = Terrain::Tree;
                }
            }
        }
        self.terrain_dirty = true;
    }

    /// Passability of every cell from its terrain and the structures on it
    /// (after terrain changes: trees, bridges).
    pub(crate) fn update_world_terrain(&mut self) {
        for ci in 0..self.map.cells() {
            self.set_cell_passability(ci);
        }
        self.pass.refresh(&self.map);
        self.pass_water.refresh(&self.map);
        self.pass_landing.refresh(&self.map);
    }

    /// Cell `ci`'s passabilities from its terrain, the structure solid on it
    /// and a husk on it (husks.rs); the caller refreshes the labels.
    pub(crate) fn set_cell_passability(&mut self, ci: usize) {
        let t = self.map.terrain[ci];
        let b = self.building_at[ci];
        let occupied = (b != NONE && self.occupies(b as usize, ci)) || self.husk_at(ci).is_some();
        self.pass.set_blocked(ci, occupied || !t.passable());
        self.pass_water.set_blocked(ci, occupied || !t.ship_passable());
        self.pass_landing.set_blocked(ci, occupied || !t.landing_passable());
    }

    /// Whether structure `b` blocks cell `ci` (an Occupied footprint cell).
    pub(crate) fn occupies(&self, b: usize, ci: usize) -> bool {
        let a = &self.actors[b];
        let Some(info) = self.rules.actors[a.ty as usize].building.as_ref() else { return false };
        let (x, y) = ((ci as i32) % self.map.width, (ci as i32) / self.map.width);
        info.footprint.iter().any(|&(dx, dy, c)| c == crate::rules::FootCell::Occupied && (a.cx + dx, a.cy + dy) == (x, y))
    }

    // ---- Targeting and damage ---------------------------------------------------------

    /// Target classes of actor `i` when its world traits override its kind's
    /// (trees, bridges, husks; a destroyed bridge cannot be targeted).
    pub(crate) fn world_target_class(&self, i: usize) -> Option<u32> {
        let w = self.world_traits(i);
        if w.bridge.is_some() && self.actors[i].hp <= 0 {
            return Some(0);
        }
        w.target
    }

    /// An actor no auto-target picks: walls, barrels, bridges (NoAutoTarget,
    /// RequiresForceFire) and actors that cannot be hit at all.
    pub fn never_auto_targeted(&self, i: usize) -> bool {
        let w = self.world_traits(i);
        w.no_auto_target || w.force_fire || w.target == Some(0)
    }

    /// Whether actor `i` can take damage at all (OpenRA: has Health).
    pub fn has_health(&self, i: usize) -> bool {
        !self.world_traits(i).indestructible
    }

    /// Damage actor `u` just took (`old_hp` before the hit, `dmg` dealt,
    /// damage type bits `types`): damage state explosions, the hospital's
    /// damage cooldown, burning trees and panicking civilians.
    pub(crate) fn on_world_damaged(&mut self, u: usize, old_hp: i32, dmg: i32, types: u32) {
        let ty = self.actors[u].ty as usize;
        let max = self.rules.actors[ty].hp;
        let (before, after) = (DamageState::of(old_hp, max), DamageState::of(self.actors[u].hp, max));
        if before != after {
            let explosions = self.rules.actors[ty].world.damage_explosions.clone();
            for e in explosions {
                let s = DamageState::parse(&e.state).unwrap_or(DamageState::Dead);
                if after >= s && before < s {
                    self.damage_state_explosion(u, e.weapon);
                }
            }
        }
        if dmg <= 0 {
            return;
        }
        if let Some(h) = self.rules.actors[ty].world.hospital_heal.as_ref() {
            self.actors[u].world.heal_cooldown = h.damage_cooldown;
        }
        if types & self.rules.damage_type_bit(INCENDIARY) != 0 {
            self.actors[u].world.burning = true;
        }
        if self.actors[u].world.burning {
            self.update_fire(u, after);
        }
        if let Some(chance) = self.rules.actors[ty].world.scaredy_cat.as_ref().map(|s| s.panic_chance) {
            if self.rng.range(0, 100) < chance {
                self.panic(u);
            }
        }
    }

    /// The fire sizes of a burning actor in damage state `state` (OpenRA
    /// ^Tree WithDamageOverlay@SmallBurn Light to Medium, @MediumBurn Medium
    /// to Heavy, @LargeBurn from Heavy): the one burning starts, the others end.
    fn update_fire(&mut self, u: usize, state: DamageState) {
        let size = fire_size(state);
        let now = self.tick + 1;
        let w = &mut self.actors[u].world;
        for s in 0..3 {
            if Some(s) == size {
                if w.fire_start[s] == 0 || w.fire_end[s] != 0 {
                    w.fire_start[s] = now;
                    w.fire_end[s] = 0;
                }
            } else if w.fire_start[s] != 0 && w.fire_end[s] == 0 {
                w.fire_end[s] = now;
            }
        }
    }

    /// OpenRA ExplosionOnDamageTransition: the weapon explodes on the actor
    /// (or only the fire and sound of one, for visual-only weapons).
    fn damage_state_explosion(&mut self, u: usize, weapon: Option<usize>) {
        let (x, y, owner) = (self.actors[u].x, self.actors[u].y, self.actors[u].owner);
        match weapon {
            Some(w) => self.impact(w, x, y, owner),
            None => {
                self.effects.push(Effect { x, y, tx: x, ty: y, kind: EffectKind::LargeExplosion, ttl: 24, max: 24 });
                let ty = self.actors[u].ty as i32;
                self.sound.push(SoundEventKind::Death, ty, x, y, owner, kind_code(Kind::Building));
            }
        }
    }

    /// Called by `World::kill` for every actor that dies: further death
    /// weapons (CivPanicExplosion) and the actor that takes its place.
    pub(crate) fn on_world_killed(&mut self, i: usize) {
        let ty = self.actors[i].ty as usize;
        let (x, y, owner) = (self.actors[i].x, self.actors[i].y, self.actors[i].owner);
        let shot = crate::veterancy::Shot { source: NONE, firepower: 100 };
        for w in self.rules.actors[ty].world.death_weapons.clone() {
            self.queue_weapon(w, x, y, owner, shot, 1);
        }
        if self.rules.actors[ty].world.death_animation {
            // Presentation only, like the soldiers' (die1: the "dead" sequence).
            let c = crate::infantry::Corpse { x, y, facing: 0, ty: ty as u16, owner, sequence: 1, tick: self.tick };
            self.inf.corpses.push(c);
        }
        if let Some(spawn) = self.rules.actors[ty].world.spawn_ty {
            // OpenRA SpawnActorOnDeath.Probability (100) still draws from the shared random.
            let _ = self.rng.range(0, 100);
            let (cx, cy) = (self.actors[i].cx, self.actors[i].cy);
            self.neutral.pending_spawns.push(PendingSpawn { ty: spawn as u16, owner, cx, cy });
        }
    }

    /// A weapon lands at (x, y) `min_delay` ticks from now or later: every
    /// warhead after its delay (at least `min_delay`), and its cluster
    /// warheads' weapons on their cells, each with its effect and sound.
    /// Death weapons use this so chain reactions (barrels) ripple outward
    /// one step per tick instead of recursing.
    pub(crate) fn queue_weapon(&mut self, w: usize, x: i32, y: i32, owner: u8, shot: crate::veterancy::Shot, min_delay: i32) {
        // Damage warheads, then the effect warheads (smudges, resources: combat.rs).
        for h in 0..self.warhead_count(w) {
            let delay = self.warhead_delay(w, h).max(min_delay);
            self.pending.push(PendingImpact {
                tick: self.tick + delay as u32,
                weapon: w as u16,
                warhead: h as u8,
                x,
                y,
                altitude: 0,
                owner,
                shot,
            });
        }
        for (cw, cx, cy) in self.cluster_targets(w, x, y) {
            self.effects.push(Effect { x: cx, y: cy, tx: cx, ty: cy, kind: EffectKind::LargeExplosion, ttl: 18, max: 18 });
            self.sound.push(SoundEventKind::Impact, cw as i32, cx, cy, owner, 0);
            self.queue_weapon(cw, cx, cy, owner, shot, min_delay);
        }
    }

    /// The (weapon, x, y) a weapon's FireCluster warheads fire at when it
    /// lands at (x, y): the centres of the footprint's X cells around the
    /// impact cell, then `random_count` of its x cells picked at random.
    pub(crate) fn cluster_targets(&mut self, w: usize, x: i32, y: i32) -> Vec<(usize, i32, i32)> {
        if self.rules.weapons[w].clusters.is_empty() {
            return Vec::new();
        }
        let (cx, cy) = self.cell_of(x, y);
        let clusters = self.rules.weapons[w].clusters.clone();
        let mut out = Vec::new();
        for c in clusters {
            let mut cells: Vec<(i32, i32)> = c.cells.iter().map(|o| (o[0], o[1])).collect();
            if !c.random_cells.is_empty() {
                for _ in 0..c.random_count {
                    let k = self.rng.range(0, c.random_cells.len() as i32) as usize;
                    cells.push((c.random_cells[k][0], c.random_cells[k][1]));
                }
            }
            for (dx, dy) in cells {
                if self.map.contains(cx + dx, cy + dy) {
                    out.push((c.weapon, cell_center(cx + dx), cell_center(cy + dy)));
                }
            }
        }
        out
    }

    // ---- Owners -------------------------------------------------------------------------

    /// The effects of a capture once actor `i` belongs to its new owner
    /// (`old_owner` had it): GivesCashOnCapture pays the new owner, and walls
    /// change who may crush them. The rest follows from the owner itself on
    /// the next tick: oil derricks pay their new owner (CashTrickler), a
    /// Hospital heals the new owner's infantry, a Forward Command Post lets
    /// the new owner build around it, and the building's prerequisites
    /// (`hosp`, `bio`, `miss`, `fcom`, `oilb`) move with it. A capture that
    /// changes the owner itself calls this right after; `on_captured` does both.
    pub fn after_capture(&mut self, i: usize, old_owner: u8) {
        let new_owner = self.actors[i].owner;
        if !self.actors[i].alive || new_owner == old_owner {
            return;
        }
        let cash = self.world_traits(i).cash_on_capture;
        if cash > 0 && (new_owner as usize) < self.players.len() {
            // OpenRA PlayerResources.ChangeCash, shown as a cash tick (ShowTicks).
            self.players[new_owner as usize].cash += cash;
            self.show_cash_tick(i, new_owner, cash);
        }
        self.pass.touch();
    }

    /// Actor `i` was captured by `new_owner` without a captor (scripts,
    /// tests): the same as an engineer's capture (infantry.rs `capture`:
    /// owner change, CaptureNotification, then `after_capture`).
    pub fn on_captured(&mut self, i: usize, new_owner: u8) {
        if !self.actors[i].alive || new_owner as usize >= self.players.len() {
            return;
        }
        self.capture(i, new_owner, None);
    }

    // ---- Per tick ---------------------------------------------------------------------

    /// Once per tick after the units acted and the dead were cleaned up:
    /// husks and stumps appear, the hospital heals, oil derricks pay, mines
    /// grow ore, panics end and bridges are repaired or demolished span by span.
    pub(crate) fn tick_neutral(&mut self) {
        self.spawn_pending();
        let seeding = self.options.ore_regrowth;
        for i in 0..self.actors.len() {
            if !self.actors[i].alive || !self.actors[i].in_world() {
                continue;
            }
            let w = &self.rules.actors[self.actors[i].ty as usize].world;
            let (heal, trickle, seeds, scared) =
                (w.hospital_heal.is_some(), w.cash_trickler.is_some(), w.seeds.is_some(), w.scaredy_cat.is_some());
            if heal {
                self.tick_hospital_heal(i);
            }
            if trickle {
                self.tick_cash_trickler(i);
            }
            if seeds && seeding {
                self.tick_seeds(i);
            }
            if scared {
                self.tick_panic(i);
            }
        }
        self.tick_bridges();
    }

    /// Husks and stumps of actors that died (SpawnActorOnDeath).
    fn spawn_pending(&mut self) {
        if self.neutral.pending_spawns.is_empty() {
            return;
        }
        let pending = std::mem::take(&mut self.neutral.pending_spawns);
        for p in pending {
            // The dead actor's cells were freed by cleanup_dead; another
            // structure on them (none can be placed there in between) keeps it out.
            let _ = self.spawn_building(p.ty, p.owner, p.cx, p.cy);
        }
    }

    /// RA's hospital: ChangesHealth@HOSPITAL while the owner has a Hospital
    /// (`hosp`) and the soldier is damaged.
    fn tick_hospital_heal(&mut self, i: usize) {
        let ty = self.actors[i].ty as usize;
        let Some(h) = self.rules.actors[ty].world.hospital_heal.clone() else { return };
        let Some(token) = self.rules.actors[ty].world.hospital_token else { return };
        let max = self.rules.actors[ty].hp;
        let owner = self.actors[i].owner as usize;
        let hp = self.actors[i].hp;
        // GrantCondition@HOSPITAL: `hospital && damaged`; the trait is off otherwise.
        if !self.players[owner].tokens.get(token as usize).copied().unwrap_or(false) || hp >= max || hp <= 0 {
            return;
        }
        if (hp as i64) >= h.start_if_below as i64 * max as i64 / 100 {
            return;
        }
        let s = &mut self.actors[i].world;
        if s.heal_cooldown > 0 {
            s.heal_cooldown -= 1;
            return;
        }
        s.heal_ticks -= 1;
        if s.heal_ticks <= 0 {
            s.heal_ticks = h.delay;
            let a = &mut self.actors[i];
            a.hp = (a.hp + h.step).min(max);
        }
    }

    /// Whether infantry actor `i` is being healed by its owner's hospital
    /// (the blinking red cross, OpenRA WithDecoration@REDCROSS).
    pub fn hospital_healing(&self, i: usize) -> bool {
        let a = &self.actors[i];
        let info = &self.rules.actors[a.ty as usize];
        match (info.world.hospital_heal.as_ref(), info.world.hospital_token) {
            (Some(_), Some(t)) => {
                a.hp > 0 && a.hp < info.hp && self.players[a.owner as usize].tokens.get(t as usize).copied().unwrap_or(false)
            }
            _ => false,
        }
    }

    /// OpenRA CashTrickler (oil derricks): `amount` every `interval` ticks to a
    /// combatant owner.
    fn tick_cash_trickler(&mut self, i: usize) {
        let ty = self.actors[i].ty as usize;
        let Some(c) = self.rules.actors[ty].world.cash_trickler.clone() else { return };
        let owner = self.actors[i].owner as usize;
        if c.combatant_only && self.players[owner].neutral {
            // Disabled: the countdown starts over when it is enabled again.
            self.actors[i].world.trickle_ticks = c.interval;
            return;
        }
        let s = &mut self.actors[i].world;
        s.trickle_ticks -= 1;
        if s.trickle_ticks < 0 {
            s.trickle_ticks = c.interval;
            // OpenRA PlayerResources.ChangeCash: cash never drops below zero.
            let p = &mut self.players[owner];
            let paid = c.amount.max(-p.cash);
            p.cash += paid;
            self.show_cash_tick(i, owner as u8, paid);
        }
    }

    /// A cash tick over actor `i` in `owner`'s colour (OpenRA FloatingText
    /// with FormatCashTick: "+$15", "-$20"; sound_events.rs CashTick, drawn by
    /// js/battlefx.js); nothing for 0. Thieves and supply trucks show theirs
    /// the same way (infantry.rs, cargo.rs).
    pub fn show_cash_tick(&mut self, i: usize, owner: u8, amount: i32) {
        if amount == 0 {
            return;
        }
        let (x, y) = (self.actors[i].x, self.actors[i].y);
        self.sound.push(SoundEventKind::CashTick, amount, x, y, owner, 0);
    }

    /// OpenRA SeedsResource (ore and gem mines): every `interval` ticks a
    /// random walk from the mine finds the first cell that can take one more
    /// bale and grows it there.
    fn tick_seeds(&mut self, i: usize) {
        let ty = self.actors[i].ty as usize;
        let Some(s) = self.rules.actors[ty].world.seeds.clone() else { return };
        let st = &mut self.actors[i].world;
        st.seed_ticks -= 1;
        if st.seed_ticks > 0 {
            return;
        }
        st.seed_ticks = s.interval;
        let resource = if s.resource == "gems" { Resource::Gems } else { Resource::Ore };
        let (mut x, mut y) = self.cell_of(self.actors[i].x, self.actors[i].y);
        for _ in 0..s.max_range {
            // OpenRA Util.RandomWalk: a random step to one of the eight neighbours.
            loop {
                let (dx, dy) = (self.rng.range(-1, 2), self.rng.range(-1, 2));
                if dx != 0 || dy != 0 {
                    x += dx;
                    y += dy;
                    break;
                }
            }
            // Skip cells of this resource that are full (or blocked); stop at the first other cell.
            let same = self.map.contains(x, y) && self.map.resource(self.map.idx(x, y)).is_some_and(|(r, _)| r == resource);
            if same && !self.can_add_resource(resource, x, y) {
                continue;
            }
            if self.can_add_resource(resource, x, y) {
                let ci = self.map.idx(x, y);
                let bare = !self.map.has_resource(ci);
                match resource {
                    Resource::Ore => self.map.ore[ci] += 1,
                    Resource::Gems => self.map.gems[ci] += 1,
                }
                self.terrain_dirty = true;
                // Ore on bare ground slows units: routes over it cost more (flowfield.rs).
                if bare {
                    self.pass.note_cost_change(ci);
                    self.pass.refresh(&self.map);
                }
            }
            return;
        }
    }

    /// OpenRA ResourceLayer.CanAddResource: one more bale fits on (x, y):
    /// ground that holds resources without a structure on it, empty or of the
    /// same resource below its maximum density.
    pub(crate) fn can_add_resource(&self, resource: Resource, x: i32, y: i32) -> bool {
        if !self.map.contains(x, y) {
            return false;
        }
        let ci = self.map.idx(x, y);
        let max = match resource {
            Resource::Ore => self.rules.player.ore_max_density,
            Resource::Gems => self.rules.player.gem_max_density,
        };
        match self.map.resource(ci) {
            Some((r, d)) => r == resource && d < max,
            None => self.map.terrain[ci].holds_ore() && self.building_at[ci] == NONE && max > 0,
        }
    }

    // ---- Civilians (ScaredyCat, Wanders) ---------------------------------------------------

    /// Whether actor `i` panics (ScaredyCat).
    pub fn is_panicking(&self, i: usize) -> bool {
        self.actors[i].world.panic_tick > 0
    }

    /// Whether infantry `i` is drawn in its panic pose (OpenRA ScaredyCat
    /// PanicSequencePrefix: "panic-stand", "panic-run"), its second sprite slot.
    pub(crate) fn draws_panic(&self, i: usize) -> bool {
        self.actors[i].kind == Kind::Infantry && self.is_panicking(i)
    }

    /// OpenRA ScaredyCat.Panic: drop what it does and run.
    pub(crate) fn panic(&mut self, i: usize) {
        if self.actors[i].world.panic_tick == 0 {
            self.cancel_activity(i);
        }
        self.actors[i].world.panic_tick = self.tick.max(1);
    }

    /// OpenRA INotifyAttack.Attacking of ScaredyCat: an armed civilian may
    /// panic when it fires.
    pub(crate) fn on_world_fired(&mut self, i: usize) {
        let Some(chance) = self.world_traits(i).scaredy_cat.as_ref().map(|s| s.attack_panic_chance) else { return };
        if self.rng.range(0, 100) < chance {
            self.panic(i);
        }
    }

    fn tick_panic(&mut self, i: usize) {
        let start = self.actors[i].world.panic_tick;
        if start == 0 {
            return;
        }
        let duration = self.world_traits(i).scaredy_cat.as_ref().map_or(0, |s| s.duration) as u32;
        if self.tick >= start + duration {
            self.cancel_activity(i);
            self.actors[i].world.panic_tick = 0;
        }
    }

    /// Speed modifier (percent) of the neutral world's traits: panicking civilians run.
    pub(crate) fn world_speed_modifier(&self, i: usize) -> i32 {
        if self.actors[i].world.panic_tick > 0 {
            if let Some(s) = self.world_traits(i).scaredy_cat.as_ref() {
                return s.speed_modifier;
            }
        }
        100
    }

    /// Stop whatever unit `i` does (OpenRA CancelActivity): it stands idle.
    pub(crate) fn cancel_activity(&mut self, i: usize) {
        let a = &mut self.actors[i];
        if !a.is_unit() {
            return;
        }
        a.activity = Activity::Idle;
        a.goal = NONE;
        a.target = NONE;
        a.attack_move = false;
        a.waypoints.clear();
    }

    /// Idle civilians (units with ScaredyCat or Wanders): a panicking one
    /// runs to a random neighbouring cell (OpenRA ScaredyCat.TickIdle), a calm
    /// one strolls now and then (Wanders.TickIdle). True when it acted.
    pub(crate) fn tick_world_idle(&mut self, i: usize) -> bool {
        let w = self.world_traits(i);
        let (scared, wanders) = (w.scaredy_cat.is_some(), w.wanders.clone());
        if scared && self.actors[i].world.panic_tick > 0 {
            if let Some((x, y)) = self.adjacent_open_cell(i) {
                self.start_single_move(i, x, y);
                return true;
            }
            return false;
        }
        let Some(wd) = wanders else { return false };
        let s = &mut self.actors[i].world;
        if s.wander_busy {
            // OpenRA Wanders.OnBecomingIdle: a fresh countdown.
            s.wander_busy = false;
            s.wander_countdown = self.rng.range(wd.min_delay, wd.max_delay);
        }
        let s = &mut self.actors[i].world;
        s.wander_countdown -= 1;
        if s.wander_countdown > 0 {
            return false;
        }
        // PickTargetLocation: a point `radius` cells away in a random direction.
        let radius = s.wander_radius;
        let facing = self.rng.range(0, 256) * 4;
        let (vx, vy) = crate::math::facing_vec(facing);
        let (x, y) = (self.actors[i].x + vx * radius, self.actors[i].y + vy * radius);
        let inside = x >= 0 && y >= 0 && x < self.map.width * CELL && y < self.map.height * CELL;
        let s = &mut self.actors[i].world;
        if !inside {
            s.wander_idle += 1;
            if s.wander_idle % wd.reduce_delay.max(1) == 0 {
                s.wander_radius = (s.wander_radius - 1).max(0);
            }
            return false;
        }
        s.wander_idle = 0;
        s.wander_radius = wd.radius;
        let (cx, cy) = self.cell_of(x, y);
        self.start_single_move(i, cx, cy);
        true
    }

    /// A random neighbouring cell actor `i` can enter (Mobile.GetAdjacentCell).
    fn adjacent_open_cell(&mut self, i: usize) -> Option<(i32, i32)> {
        let (cx, cy) = self.cell_of(self.actors[i].x, self.actors[i].y);
        let pass = self.pass_of(i);
        let open: Vec<(i32, i32)> = crate::flowfield::DIRS
            .iter()
            .map(|&(dx, dy)| (cx + dx, cy + dy))
            .filter(|&(x, y)| self.map.contains(x, y) && !pass.blocked[self.map.idx(x, y)])
            .collect();
        if open.is_empty() {
            return None;
        }
        Some(open[self.rng.range(0, open.len() as i32) as usize])
    }

    /// Send one unit to a cell on its own (a move group of one).
    fn start_single_move(&mut self, i: usize, x: i32, y: i32) {
        let group = self.next_group();
        self.start_move_group(&[i], cell_center(x), cell_center(y), false, group, 1);
    }
}

#[cfg(test)]
impl World {
    /// Tests on open fields: take every neutral actor (the trees of the
    /// generated map) off the map at once, as if it was never there.
    pub(crate) fn clear_neutral_world(&mut self) {
        let Some(n) = self.neutral_player() else { return };
        for i in 0..self.actors.len() {
            if self.actors[i].alive && self.actors[i].owner == n {
                self.remove(i);
            }
        }
        self.cleanup_dead();
        self.neutral.bridges = Default::default();
    }
}

/// The fire size (small, medium, large) that burns in a damage state, if any.
fn fire_size(state: DamageState) -> Option<usize> {
    match state {
        DamageState::Undamaged | DamageState::Dead => None,
        DamageState::Light => Some(0),
        DamageState::Medium => Some(1),
        DamageState::Heavy | DamageState::Critical => Some(2),
    }
}

/// Decoration special sprites (apps/game/js/art/decorations.js, after the
/// wrench and the power off icon of repair.rs): flames on a burning tree and
/// the hospital's red cross.
pub const DECORATION_FLAME: f32 = 2.0;
pub const DECORATION_RED_CROSS: f32 = 3.0;
/// The medium and the large fire (the small one is `DECORATION_FLAME`).
pub const DECORATION_FLAME_MEDIUM: f32 = 4.0;
pub const DECORATION_FLAME_LARGE: f32 = 5.0;
/// Decoration slot of each fire size.
const FIRE_SLOTS: [f32; 3] = [DECORATION_FLAME, DECORATION_FLAME_MEDIUM, DECORATION_FLAME_LARGE];
/// OpenRA WithDecoration@REDCROSS BlinkInterval.
const RED_CROSS_BLINK: u32 = 32;

impl World {
    /// The frame of fire `size` over burning actor `i`: with the original art
    /// (`RenderOptions::fire_frames`) the frame of its start, loop and end in
    /// a row, None once its end played; `u32::MAX` for WebRA's flame while it
    /// burns. Presentation only.
    pub(crate) fn fire_frame(&self, i: usize, size: usize) -> Option<u32> {
        let w = &self.actors[i].world;
        let (start, end) = (w.fire_start[size], w.fire_end[size]);
        if start == 0 {
            return None;
        }
        let slot = (crate::render::SpriteIds::new(self.rules.actors.len()).decorations_base + FIRE_SLOTS[size]) as u32;
        let Some((ms, first, looped, last)) = self.render_opts.fire_frames[size].filter(|_| self.render_opts.is_original(slot)) else {
            return (end == 0).then_some(u32::MAX);
        };
        let frames = |since: u32| self.tick.saturating_sub(since) * (1000 / crate::world::TICKS_PER_SECOND) / ms.max(1);
        if end != 0 {
            let e = frames(end);
            return (e < last).then_some(first + looped + e);
        }
        let f = frames(start);
        Some(if f < first { f } else { first + (f - first) % looped.max(1) })
    }

    /// Flames on trees hit by fire while damaged (OpenRA WithDamageOverlay
    /// burn-s, burn-m and burn-l: bigger the worse the damage), and the red
    /// cross blinking on infantry the owner's hospital heals (shown to the
    /// owner and allies).
    pub(crate) fn render_world_decorations(&self, player: u8, sink: &mut crate::instances::Sink, base: f32, sprites: &mut Vec<f32>) {
        use crate::instances::SpriteRec;
        use crate::render::px;
        let cross_on = (self.tick / RED_CROSS_BLINK) % 2 == 1;
        for (i, a) in self.actors.iter().enumerate() {
            if !a.alive || !a.in_world() {
                continue;
            }
            if a.world.burning && a.kind == Kind::Building {
                if !self.is_visible_to(i, player) {
                    continue;
                }
                // Over the cells the tree occupies, each fire that burns or is ending.
                let b = self.rules.actors[a.ty as usize].building.as_ref().expect("a structure");
                for (size, &fire_slot) in FIRE_SLOTS.iter().enumerate() {
                    let Some(frame) = self.fire_frame(i, size) else { continue };
                    let slot = base + fire_slot;
                    let id = if frame == u32::MAX { slot } else { crate::render::posed(slot as u32, crate::render::Pose::Idle, frame) };
                    for (dx, dy) in b.cells() {
                        let (x, y) = (px((a.cx + dx) * CELL + CELL / 2), px((a.cy + dy) * CELL + CELL / 2));
                        if sink.visible([x, y], [x, y], 24.0) {
                            sink.sprite(sprites, SpriteRec::at(x, y, 24.0).look(id, a.owner as f32, 1.0, 0.9, 0.0));
                        }
                    }
                }
                continue;
            }
            if cross_on && a.kind == Kind::Infantry && !a.air.parachute && self.render_allied(a.owner, player) && self.hospital_healing(i) {
                // Bottom right of the selection box (WithDecoration Position: BottomRight).
                let (anchor, w, h) = self.selection_anchor(i);
                if sink.visible(anchor.from, anchor.to, 32.0) {
                    let r =
                        SpriteRec::moving(anchor.from, anchor.to, 32.0).look(base + DECORATION_RED_CROSS, a.owner as f32, 1.0, 1.0, 0.0);
                    sink.sprite(sprites, r.offset(w / 2.0 - 3.0, h / 2.0 - 3.0));
                }
            }
        }
    }
}

/// What the client needs of an actor's world traits (lib.rs `rules_json`):
/// the editor's category and biomes, whether it can be selected, damaged or
/// captured, and a bridge's templates (its art follows their cells).
pub fn world_json(a: &crate::rules::ActorInfo) -> serde_json::Value {
    let w = &a.world;
    serde_json::json!({
        "category": w.category,
        "biomes": w.biomes,
        "selectable": w.selectable,
        "indestructible": w.indestructible,
        "capturable": a.abilities.capturable.is_some(),
        "bridgeHut": w.bridge_hut,
        "allyDescription": w.ally_description,
        "otherDescription": w.other_description,
        "bridge": w.bridge.as_ref().map(|b| b.templates.iter().map(|(biome, t)| (biome.clone(), serde_json::json!({
            "size": t.size,
            "healthy": t.healthy,
            "destroyed": t.rows(crate::bridges::BridgeLook::Destroyed),
        }))).collect::<serde_json::Map<_, _>>()),
    })
}

// ---- Wall crushing (OpenRA Locomotor Crushes: wall, heavywall) ------------------

impl World {
    /// Crush classes of walls unit `i`'s locomotor drives over (flowfield::CRUSH_*), 0 for none.
    pub fn crush_mask(&self, i: usize) -> u8 {
        let Some(u) = self.rules.actors[self.actors[i].ty as usize].unit.as_ref() else { return 0 };
        crate::flowfield::crush_bits(&self.rules.locomotors[u.locomotor].crushes)
    }

    /// Whether unit `i` crushes the wall on cell `ci` when it drives in
    /// (OpenRA Crushable: the classes match and the wall's owner is not an
    /// ally; neutral walls are nobody's ally).
    pub fn crushes_wall_at(&self, i: usize, ci: usize) -> bool {
        let mask = self.crush_mask(i);
        if mask == 0 || self.pass.crush[ci] & mask == 0 {
            return false;
        }
        let b = self.building_at[ci];
        b != NONE && self.actors[b as usize].alive && !self.are_allies(self.actors[i].owner, self.actors[b as usize].owner)
    }

    /// Flow field key of unit `i` (flowfield::FlowField::crusher): 1 + its
    /// owner when it crushes walls and walls it may crush exist, else 0.
    pub(crate) fn flow_crusher(&self, i: usize) -> u8 {
        let mask = self.crush_mask(i);
        if mask == 0 || self.pass.crush_present & mask == 0 || self.domain_of(i) != crate::rules::Domain::Ground {
            return 0;
        }
        self.actors[i].owner + 1
    }

    /// The crushers' passability of `player` and `mask`, current for the passability version.
    fn crush_blocked(&mut self, player: u8, mask: u8) -> usize {
        let version = self.pass.version;
        if let Some(k) = self.neutral.crush_blocked.iter().position(|c| c.player == player && c.mask == mask) {
            if self.neutral.crush_blocked[k].version == version {
                return k;
            }
            self.neutral.crush_blocked.swap_remove(k);
        }
        let mut blocked = self.pass.blocked.clone();
        for (ci, b) in blocked.iter_mut().enumerate() {
            if *b && self.pass.crush[ci] & mask != 0 {
                let w = self.building_at[ci];
                if w != NONE && !self.are_allies(player, self.actors[w as usize].owner) {
                    *b = false;
                }
            }
        }
        self.neutral.crush_blocked.push(CrushBlocked { player, mask, version, blocked });
        self.neutral.crush_blocked.len() - 1
    }

    /// The flow field toward `goal` for unit `i`'s locomotor (crushers drive
    /// through walls they may crush), or None for aircraft, which fly straight.
    pub(crate) fn unit_flow_field(&mut self, i: usize, goal: u32) -> Option<&crate::flowfield::FlowField> {
        // The field as far as the unit's cell (flowfield.rs: partial fields).
        let cell = self.cell_index(self.actors[i].x, self.actors[i].y);
        self.unit_flow_field_from(i, goal, cell)
    }

    /// `unit_flow_field` as far as `cell` (a neighbour the unit may step to).
    pub(crate) fn unit_flow_field_from(&mut self, i: usize, goal: u32, cell: usize) -> Option<&crate::flowfield::FlowField> {
        let loco = self.rules.actors[self.actors[i].ty as usize].unit.as_ref()?.locomotor;
        let crusher = self.flow_crusher(i);
        if crusher > 0 {
            let mask = self.crush_mask(i);
            let k = self.crush_blocked(crusher - 1, mask);
            let crush = crate::flowfield::Crush { player: crusher - 1, blocked: &self.neutral.crush_blocked[k].blocked };
            return Some(self.flow.field_at(&self.map, &self.pass, &self.rules.locomotors, goal, loco as u8, Some(crush), cell));
        }
        if self.rules.locomotors[loco].domain == crate::rules::Domain::Air {
            return None;
        }
        let pass = if self.lands(i) {
            &self.pass_landing
        } else if self.rules.locomotors[loco].domain == crate::rules::Domain::Water {
            &self.pass_water
        } else {
            &self.pass
        };
        Some(self.flow.field_at(&self.map, pass, &self.rules.locomotors, goal, loco as u8, None, cell))
    }

    /// Nearest cell to `goal` that unit `i` can reach from where it stands
    /// (crushers: also through walls of their class), ties toward `from`.
    pub(crate) fn nearest_reachable(&self, i: usize, goal: (i32, i32), from: (i32, i32)) -> Option<u32> {
        let d = self.domain_of(i);
        let pass = self.pass_of(i);
        let ci = self.cell_index(self.actors[i].x, self.actors[i].y);
        let mask = if d == crate::rules::Domain::Ground { self.crush_mask(i) } else { 0 };
        if mask == 0 {
            return crate::flowfield::nearest_in_component(&self.map, pass, goal, pass.component[ci], from);
        }
        let labels = pass.components_for(mask);
        crate::flowfield::nearest_in_labels(&self.map, labels, |c| pass.open_for(c, mask), goal, labels[ci], from)
    }

    /// Unit `i` drove onto cell `ci`: a wall there it may crush is crushed
    /// (OpenRA Crushable.OnCrush; the crusher's owner gets the kill).
    pub(crate) fn crush_wall_at(&mut self, i: usize, ci: usize) {
        if !self.crushes_wall_at(i, ci) {
            return;
        }
        let wall = self.building_at[ci] as usize;
        let by = self.actors[i].owner;
        let source = self.make_ref(i);
        self.award_kill(wall, source);
        self.with_damage_source(by, |w| w.kill(wall));
    }
}

/// Radar blip owner codes of actors shown in a terrain colour (minimap.rs,
/// apps/game/js/minimap.js): `RADAR_TERRAIN + terrain value`, ore and gems.
pub const RADAR_TERRAIN: i32 = 1000;
pub const RADAR_ORE: i32 = 1100;
pub const RADAR_GEMS: i32 = 1101;

/// The radar blip owner code of an actor type the radar shows in a terrain
/// colour (OpenRA RadarColorFromTerrain), else None.
pub(crate) fn radar_terrain_code_of(w: &WorldTraits) -> Option<i32> {
    Some(match w.radar_terrain.as_deref()? {
        "Ore" => RADAR_ORE,
        "Gems" => RADAR_GEMS,
        "Tree" => RADAR_TERRAIN + Terrain::Tree as i32,
        "Wall" => RADAR_TERRAIN + Terrain::Wall as i32,
        "Rock" => RADAR_TERRAIN + Terrain::Rock as i32,
        _ => return None,
    })
}

impl World {
    /// `radar_terrain_code_of` actor `i`.
    pub(crate) fn radar_terrain_code(&self, i: usize) -> Option<i32> {
        radar_terrain_code_of(self.world_traits(i))
    }
}
