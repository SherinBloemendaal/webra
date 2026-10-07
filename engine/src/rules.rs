//! Game rules, loaded from `rules.json` (generated from OpenRA data by
//! `tools/gen_rules.py`) and post-processed into lookup-friendly structures.

use serde::Deserialize;
use std::collections::BTreeMap;

pub(crate) const RULES_JSON: &str = include_str!("../rules.json");

#[derive(Deserialize)]
struct RawRules {
    factions: Vec<String>,
    player: PlayerRules,
    actors: Vec<RawActor>,
    weapons: Vec<RawWeapon>,
    locomotors: Vec<RawLocomotor>,
}

#[derive(Deserialize, Clone)]
pub struct PlayerRules {
    pub starting_cash: i32,
    pub ore_value: i32,
    pub low_power_modifier: i32,
    pub speed_reduction: Vec<i32>,
    pub ore_max_density: u8,
}

#[derive(Deserialize)]
struct RawActor {
    id: String,
    name: String,
    description: String,
    kind: String,
    queue: String,
    cost: i32,
    build_ticks: i32,
    palette_order: i32,
    prerequisites: Vec<String>,
    build_at: String,
    hp: i32,
    armor: usize,
    sight: i32,
    weapons: Vec<usize>,
    turret_turn_speed: Option<i32>,
    reload_override: Option<i32>,
    requires_power: bool,
    death_weapon: Option<usize>,
    self_heal: Option<SelfHeal>,
    abilities: Abilities,
    building: Option<RawBuilding>,
    unit: Option<UnitInfo>,
}

#[derive(Deserialize, Clone)]
pub struct SelfHeal {
    pub step: i32,
    pub delay: i32,
    pub start_if_below: i32,
    pub damage_cooldown: i32,
}

/// Special abilities from OpenRA traits. Each is optional.
#[derive(Deserialize, Clone, Default)]
pub struct Abilities {
    pub cargo: Option<CargoInfo>,
    pub minelayer: Option<MinelayerInfo>,
    pub jams_missiles: Option<RangeInfo>,
    pub creates_shroud: Option<RangeInfo>,
    pub cloak: Option<CloakInfo>,
    pub detect_cloaked: Option<RangeInfo>,
    pub portable_chrono: Option<PortableChronoInfo>,
    pub mad_tank: Option<MadTankInfo>,
    pub demo_truck: Option<serde_json::Value>,
    pub delivers_cash: Option<DeliversCashInfo>,
    pub transforms: Option<TransformsInfo>,
    pub line_build: Option<LineBuildInfo>,
    pub provides_radar: Option<serde_json::Value>,
    pub crushable: Option<Vec<String>>,
    pub support_powers: Option<Vec<SupportPowerInfo>>,
}

#[derive(Deserialize, Clone)]
pub struct CargoInfo {
    pub types: Vec<String>,
    pub max: i32,
    pub garrison: bool,
    pub initial: Vec<String>,
}

#[derive(Deserialize, Clone)]
pub struct MinelayerInfo {
    pub mine: String,
    pub ammo: i32,
}

#[derive(Deserialize, Clone)]
pub struct RangeInfo {
    pub range: i32,
}

#[derive(Deserialize, Clone)]
pub struct CloakInfo {
    pub initial_delay: i32,
    pub cloak_delay: i32,
    pub uncloak_on: Vec<String>,
}

#[derive(Deserialize, Clone)]
pub struct PortableChronoInfo {
    pub charge_delay: i32,
    pub max_distance: i32,
}

#[derive(Deserialize, Clone)]
pub struct MadTankInfo {
    pub charge_delay: i32,
    pub thump_interval: i32,
    pub thump_weapon: usize,
    pub detonation_weapon: usize,
}

#[derive(Deserialize, Clone)]
pub struct DeliversCashInfo {
    pub payload: i32,
}

#[derive(Deserialize, Clone)]
pub struct TransformsInfo {
    pub into: String,
    pub offset: Vec<i32>,
    pub facing: i32,
    /// Only allowed when the "Redeployable MCVs" lobby option is on.
    pub needs_option: bool,
}

#[derive(Deserialize, Clone)]
pub struct LineBuildInfo {
    pub range: i32,
}

#[derive(Deserialize, Clone)]
pub struct SupportPowerInfo {
    pub key: String,
    pub kind: String,
    pub name: String,
    pub description: String,
    pub charge: i32,
    pub prerequisites: Vec<String>,
    pub duration: i32,
    pub range: i32,
    pub max_distance: i32,
}

#[derive(Deserialize)]
struct RawBuilding {
    width: i32,
    height: i32,
    footprint: Vec<String>,
    terrain: Vec<String>,
    requires_base_provider: bool,
    power: i32,
    power_scales_with_health: bool,
    produces: Vec<String>,
    exits: Vec<Vec<i32>>,
    gives_buildable_area: bool,
    base_provider_range: i32,
    adjacent: i32,
    storage: i32,
    sell_refund: i32,
    provides: BTreeMap<String, Vec<String>>,
    refinery: Option<RawRefinery>,
    repairs: Option<RepairInfo>,
    center_offset: Vec<i32>,
}

#[derive(Deserialize)]
struct RawRefinery {
    dock_offset: Vec<i32>,
    free_actor: String,
    free_actor_offset: Vec<i32>,
}

#[derive(Deserialize, Clone)]
pub struct RepairInfo {
    pub hp_per_step: i32,
    pub interval: i32,
    pub value_percent: i32,
}

#[derive(Deserialize, Clone)]
pub struct UnitInfo {
    pub speed: i32,
    pub turn_speed: i32,
    pub turn_in_place: bool,
    pub locomotor: usize,
    pub radius: i32,
    pub passenger: Option<String>,
    pub harvester: Option<HarvesterInfo>,
    pub aircraft: Option<AircraftInfo>,
}

/// OpenRA `Aircraft` trait values (planes and helicopters).
#[derive(Deserialize, Clone)]
pub struct AircraftInfo {
    pub cruise_altitude: i32,
    pub can_hover: bool,
    pub vtol: bool,
    pub landable: Vec<String>,
    pub ammo: i32,
    pub rearm_actors: Vec<String>,
    /// AmmoPool: `reload_count` rounds come back every `reload_delay` ticks while resupplying.
    pub reload_delay: i32,
    pub reload_count: i32,
    /// Repairable: structures that repair this aircraft (service depot).
    pub repair_actors: Vec<String>,
    /// World units climbed or descended per tick.
    pub altitude_velocity: i32,
    /// Distance to hold from a busy resupply structure while waiting for it.
    pub wait_distance: i32,
    pub take_off_on_resupply: bool,
    /// AutoTarget InitialStance HoldFire: idle aircraft do not pick targets themselves.
    pub hold_fire: bool,
    /// AttackAircraft FacingTolerance: may fire while this far off the target's bearing.
    pub facing_tolerance: i32,
    /// Ammo pips shown under a selected aircraft.
    pub ammo_pips: i32,
    /// Forward offsets (world units) of the rotors drawn while airborne.
    pub rotors: Vec<i32>,
}

#[derive(Deserialize, Clone)]
pub struct HarvesterInfo {
    pub capacity: i32,
    pub bale_load_delay: i32,
    pub bale_unload_delay: i32,
    pub search_from_proc: i32,
    pub search_from_harv: i32,
}

#[derive(Deserialize)]
struct RawWeapon {
    name: String,
    range: i32,
    min_range: i32,
    reload: i32,
    burst: i32,
    burst_delays: Vec<i32>,
    projectile: String,
    speed: i32,
    inaccuracy: i32,
    arc: bool,
    valid: u32,
    invalid: u32,
    warheads: Vec<RawWarhead>,
}

#[derive(Deserialize)]
struct RawWarhead {
    kind: String,
    damage: i32,
    spread: i32,
    falloff: Vec<i32>,
    versus: Vec<i32>,
    delay: i32,
    valid: u32,
    invalid: u32,
}

#[derive(Deserialize)]
struct RawLocomotor {
    name: String,
    domain: String,
    speeds: Vec<i32>,
    crushes: Vec<String>,
}

/// Where a unit moves: on land (ground flow fields), on water (naval flow fields) or in the air.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Domain {
    Ground,
    Water,
    Air,
}

/// Target classes (bit flags, same values as gen_rules.py TARGET_BITS).
pub const TARGET_INFANTRY: u32 = 1;
pub const TARGET_VEHICLE: u32 = 2;
pub const TARGET_STRUCTURE: u32 = 4;
pub const TARGET_AIR: u32 = 8;
pub const TARGET_WATER: u32 = 16;
pub const TARGET_UNDERWATER: u32 = 64;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    Building,
    Infantry,
    Vehicle,
    Ship,
    Aircraft,
}

impl Kind {
    pub fn target_class(self) -> u32 {
        match self {
            Kind::Building => TARGET_STRUCTURE,
            Kind::Infantry => TARGET_INFANTRY,
            Kind::Vehicle => TARGET_VEHICLE,
            Kind::Ship => TARGET_WATER,
            Kind::Aircraft => TARGET_AIR,
        }
    }
}

/// Production queue types of the classic sidebar (tabs).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum QueueType {
    Building = 0,
    Defense = 1,
    Infantry = 2,
    Vehicle = 3,
    Aircraft = 4,
    Ship = 5,
}
pub const QUEUE_COUNT: usize = 6;

impl QueueType {
    pub fn from_index(i: usize) -> QueueType {
        match i {
            0 => QueueType::Building,
            1 => QueueType::Defense,
            2 => QueueType::Infantry,
            3 => QueueType::Vehicle,
            4 => QueueType::Aircraft,
            _ => QueueType::Ship,
        }
    }

    fn parse(s: &str) -> Option<QueueType> {
        match s {
            "Building" => Some(QueueType::Building),
            "Defense" => Some(QueueType::Defense),
            "Infantry" => Some(QueueType::Infantry),
            "Vehicle" => Some(QueueType::Vehicle),
            "Aircraft" => Some(QueueType::Aircraft),
            "Ship" => Some(QueueType::Ship),
            _ => None,
        }
    }

    /// Building and Defense items are placed on the map when finished.
    pub fn is_structure(self) -> bool {
        matches!(self, QueueType::Building | QueueType::Defense)
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum FootCell {
    Empty,
    Occupied,
    /// Part of the building but units may drive over it (bib, depot pad).
    Passable,
}

#[derive(Clone, Debug)]
pub struct Prereq {
    pub token: u16,
    /// `~`: hide the item while this prerequisite is unmet.
    pub hidden: bool,
    /// `!`: the prerequisite must be absent.
    pub negate: bool,
}

pub struct BuildingInfo {
    pub width: i32,
    pub height: i32,
    pub footprint: Vec<(i32, i32, FootCell)>,
    /// Cells that can be hit: the solid cells, or the whole pad for
    /// buildings without solid cells (the service depot).
    pub hit_cells: Vec<(i32, i32)>,
    /// Placed on water (naval yards) instead of clear ground.
    pub on_water: bool,
    pub requires_base_provider: bool,
    pub power: i32,
    pub power_scales_with_health: bool,
    /// Queue tabs this building serves.
    pub produces: Vec<QueueType>,
    /// Raw OpenRA production types, matched against `ActorInfo::build_at`.
    pub production_types: Vec<String>,
    pub exits: Vec<(i32, i32)>,
    pub gives_buildable_area: bool,
    pub base_provider_range: i32,
    pub adjacent: i32,
    pub storage: i32,
    pub sell_refund: i32,
    /// Prerequisite tokens provided, per faction index.
    pub provides: Vec<Vec<u16>>,
    pub refinery: Option<RefineryInfo>,
    pub repairs: Option<RepairInfo>,
    pub center_offset: (i32, i32),
}

pub struct RefineryInfo {
    pub dock_offset: (i32, i32),
    pub free_actor: usize,
    pub free_actor_offset: (i32, i32),
}

pub struct ActorInfo {
    pub id: String,
    pub name: String,
    pub description: String,
    pub kind: Kind,
    pub queue: QueueType,
    pub cost: i32,
    pub build_ticks: i32,
    pub palette_order: i32,
    pub prerequisites: Vec<Prereq>,
    pub build_at: String,
    pub hp: i32,
    pub armor: usize,
    pub sight: i32,
    pub weapons: Vec<usize>,
    pub turret_turn_speed: Option<i32>,
    pub reload_override: Option<i32>,
    pub requires_power: bool,
    pub death_weapon: Option<usize>,
    pub self_heal: Option<SelfHeal>,
    pub abilities: Abilities,
    pub building: Option<BuildingInfo>,
    pub unit: Option<UnitInfo>,
    /// Index of the actor this one deploys or undeploys into (MCV, FACT).
    pub transforms_into: Option<usize>,
}

impl ActorInfo {
    /// Longest range among weapons that can hit ground targets.
    pub fn max_range(&self, rules: &Rules) -> i32 {
        self.weapons
            .iter()
            .filter(|&&w| rules.weapons[w].valid & (TARGET_INFANTRY | TARGET_VEHICLE | TARGET_STRUCTURE) != 0)
            .map(|&w| rules.weapons[w].range)
            .max()
            .unwrap_or(0)
    }

    /// Whether any weapon can attack an actor of `kind`.
    pub fn can_attack(&self, rules: &Rules, kind: Kind) -> bool {
        self.weapons.iter().any(|&w| rules.weapons[w].can_target(kind))
    }

    pub fn is_wall(&self) -> bool {
        self.abilities.line_build.is_some()
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Projectile {
    Bullet,
    Missile,
    Instant,
    Tesla,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum WarheadKind {
    Spread,
    Target,
    Percent,
}

pub struct Warhead {
    pub kind: WarheadKind,
    pub damage: i32,
    pub spread: i32,
    pub falloff: Vec<i32>,
    pub versus: Vec<i32>,
    pub delay: i32,
    pub valid: u32,
    pub invalid: u32,
}

impl Warhead {
    /// Damage multiplier (percent) at `distance` from the impact, following
    /// OpenRA's SpreadDamage falloff: linear between steps of `spread`.
    pub fn falloff_at(&self, distance: i32) -> i32 {
        if self.kind == WarheadKind::Target {
            return if distance <= self.spread.max(64) { 100 } else { 0 };
        }
        if self.spread <= 0 {
            return if distance == 0 { 100 } else { 0 };
        }
        let step = (distance / self.spread) as usize;
        if step + 1 >= self.falloff.len() {
            return 0;
        }
        let a = self.falloff[step];
        let b = self.falloff[step + 1];
        let t = distance - step as i32 * self.spread;
        a + (b - a) * t / self.spread
    }

    /// Max distance at which this warhead still deals damage.
    pub fn damage_radius(&self) -> i32 {
        match self.kind {
            WarheadKind::Target => self.spread.max(64),
            _ => self.spread * (self.falloff.len() as i32 - 1),
        }
    }

    pub fn affects(&self, kind: Kind) -> bool {
        let c = kind.target_class();
        self.valid & c != 0 && self.invalid & c == 0
    }
}

pub struct WeaponInfo {
    pub name: String,
    pub range: i32,
    pub min_range: i32,
    pub reload: i32,
    pub burst: i32,
    pub burst_delays: Vec<i32>,
    pub projectile: Projectile,
    pub speed: i32,
    pub inaccuracy: i32,
    pub arc: bool,
    pub valid: u32,
    pub invalid: u32,
    pub warheads: Vec<Warhead>,
}

impl WeaponInfo {
    pub fn burst_delay(&self, shot: i32) -> i32 {
        let i = (shot.max(0) as usize).min(self.burst_delays.len() - 1);
        self.burst_delays[i]
    }

    pub fn can_target(&self, kind: Kind) -> bool {
        let c = kind.target_class();
        self.valid & c != 0 && self.invalid & c == 0
    }

    /// Strongest single-hit damage, used to size impact effects.
    pub fn max_damage(&self) -> i32 {
        self.warheads.iter().map(|w| w.damage).max().unwrap_or(0)
    }
}

pub struct Locomotor {
    pub name: String,
    pub domain: Domain,
    /// Speed percent per terrain class (Clear, Rough, Ore).
    pub speeds: Vec<i32>,
    /// OpenRA `Crushes: infantry`: drives over enemy soldiers.
    pub crushes_infantry: bool,
}

pub struct Rules {
    pub factions: Vec<String>,
    pub player: PlayerRules,
    pub actors: Vec<ActorInfo>,
    pub weapons: Vec<WeaponInfo>,
    pub locomotors: Vec<Locomotor>,
    pub tokens: Vec<String>,
    /// `obtainable[faction][actor]`: reachable through the tech tree at all
    /// (unrestricted tech level), starting from a Construction Yard.
    pub obtainable: Vec<Vec<bool>>,
}

pub const TOKEN_DISABLED: &str = "disabled";
pub const TECH_LEVELS: [&str; 5] = ["infonly", "low", "medium", "high", "unrestricted"];

impl Rules {
    pub fn load() -> Rules {
        Rules::load_with(None).expect("built-in rules are valid")
    }

    /// Load the built-in rules with optional overrides from a custom map
    /// (`{ "actors": { "1TNK": { "cost": 400 } }, "weapons": { "25mm": { "range": 6000 } } }`).
    /// Overrides may only change existing fields to values of the same type.
    pub fn load_with(overrides: Option<&serde_json::Value>) -> Result<Rules, String> {
        let mut base: serde_json::Value = serde_json::from_str(RULES_JSON).expect("rules.json is valid JSON");
        if let Some(o) = overrides {
            apply_overrides(&mut base, o)?;
        }
        let raw: RawRules = serde_json::from_value(base).map_err(|e| format!("rules overrides produce invalid rules: {e}"))?;
        Ok(Rules::from_raw(raw))
    }

    fn from_raw(raw: RawRules) -> Rules {
        let mut tokens: Vec<String> = vec![TOKEN_DISABLED.to_string()];
        for t in TECH_LEVELS {
            tokens.push(format!("techlevel.{t}"));
        }
        let mut intern = |t: &str| -> u16 {
            if let Some(i) = tokens.iter().position(|x| x == t) {
                i as u16
            } else {
                tokens.push(t.to_string());
                (tokens.len() - 1) as u16
            }
        };
        let ids: Vec<String> = raw.actors.iter().map(|a| a.id.clone()).collect();
        let index_of = |id: &str| ids.iter().position(|i| i.eq_ignore_ascii_case(id));
        let mut actors = Vec::new();
        for a in raw.actors {
            let kind = match a.kind.as_str() {
                "building" => Kind::Building,
                "infantry" => Kind::Infantry,
                "vehicle" => Kind::Vehicle,
                "ship" => Kind::Ship,
                "aircraft" => Kind::Aircraft,
                k => panic!("unknown kind {k}"),
            };
            let mut prerequisites = Vec::new();
            for p in &a.prerequisites {
                let mut s = p.as_str();
                let hidden = s.starts_with('~');
                s = s.trim_start_matches('~');
                let negate = s.starts_with('!');
                s = s.trim_start_matches('!');
                prerequisites.push(Prereq { token: intern(s), hidden, negate });
            }
            let building = a.building.map(|b| {
                let mut footprint = Vec::new();
                for (y, row) in b.footprint.iter().enumerate() {
                    for (x, c) in row.chars().enumerate() {
                        let cell = match c {
                            '_' => FootCell::Empty,
                            'x' | 'X' => FootCell::Occupied,
                            '=' | '+' => FootCell::Passable,
                            other => panic!("unknown footprint cell {other} in {}", a.id),
                        };
                        footprint.push((x as i32, y as i32, cell));
                    }
                }
                let provides = raw
                    .factions
                    .iter()
                    .map(|f| b.provides.get(f).map(|v| v.iter().map(|t| intern(t)).collect()).unwrap_or_default())
                    .collect();
                let solid: Vec<(i32, i32)> = footprint.iter().filter(|c| c.2 == FootCell::Occupied).map(|c| (c.0, c.1)).collect();
                let hit_cells = if solid.is_empty() {
                    footprint.iter().filter(|c| c.2 != FootCell::Empty).map(|c| (c.0, c.1)).collect()
                } else {
                    solid
                };
                let mut produces: Vec<QueueType> = b.produces.iter().filter_map(|p| QueueType::parse(p)).collect();
                produces.dedup();
                BuildingInfo {
                    width: b.width,
                    height: b.height,
                    footprint,
                    hit_cells,
                    on_water: b.terrain.iter().any(|t| t == "Water"),
                    requires_base_provider: b.requires_base_provider,
                    power: b.power,
                    power_scales_with_health: b.power_scales_with_health,
                    produces,
                    production_types: b.produces.clone(),
                    exits: b.exits.iter().map(|e| (e[0], e[1])).collect(),
                    gives_buildable_area: b.gives_buildable_area,
                    base_provider_range: b.base_provider_range,
                    adjacent: b.adjacent,
                    storage: b.storage,
                    sell_refund: b.sell_refund,
                    provides,
                    refinery: b.refinery.map(|r| RefineryInfo {
                        dock_offset: (r.dock_offset[0], r.dock_offset[1]),
                        free_actor: index_of(&r.free_actor).expect("free actor exists"),
                        free_actor_offset: (r.free_actor_offset[0], r.free_actor_offset[1]),
                    }),
                    repairs: b.repairs,
                    center_offset: (b.center_offset[0], b.center_offset[1]),
                }
            });
            let transforms_into = a.abilities.transforms.as_ref().and_then(|t| index_of(&t.into));
            actors.push(ActorInfo {
                id: a.id,
                name: a.name,
                description: a.description,
                kind,
                queue: QueueType::parse(&a.queue).unwrap_or_else(|| panic!("unsupported queue {}", a.queue)),
                cost: a.cost,
                build_ticks: a.build_ticks,
                palette_order: a.palette_order,
                prerequisites,
                build_at: a.build_at,
                hp: a.hp,
                armor: a.armor,
                sight: a.sight,
                weapons: a.weapons,
                turret_turn_speed: a.turret_turn_speed,
                reload_override: a.reload_override,
                requires_power: a.requires_power,
                death_weapon: a.death_weapon,
                self_heal: a.self_heal,
                abilities: a.abilities,
                building,
                unit: a.unit,
                transforms_into,
            });
        }
        let weapons = raw
            .weapons
            .into_iter()
            .map(|w| WeaponInfo {
                name: w.name,
                range: w.range,
                min_range: w.min_range,
                reload: w.reload,
                burst: w.burst.max(1),
                burst_delays: if w.burst_delays.is_empty() { vec![5] } else { w.burst_delays },
                projectile: match w.projectile.as_str() {
                    "bullet" => Projectile::Bullet,
                    "missile" => Projectile::Missile,
                    "tesla" => Projectile::Tesla,
                    _ => Projectile::Instant,
                },
                speed: w.speed,
                inaccuracy: w.inaccuracy,
                arc: w.arc,
                valid: w.valid,
                invalid: w.invalid,
                warheads: w
                    .warheads
                    .into_iter()
                    .map(|h| Warhead {
                        kind: match h.kind.as_str() {
                            "target" => WarheadKind::Target,
                            "percent" => WarheadKind::Percent,
                            _ => WarheadKind::Spread,
                        },
                        damage: h.damage,
                        spread: h.spread,
                        falloff: h.falloff,
                        versus: h.versus,
                        delay: h.delay,
                        valid: h.valid,
                        invalid: h.invalid,
                    })
                    .collect(),
            })
            .collect();
        let locomotors = raw
            .locomotors
            .into_iter()
            .map(|l| Locomotor {
                crushes_infantry: l.crushes.iter().any(|c| c == "infantry"),
                domain: match l.domain.as_str() {
                    "water" => Domain::Water,
                    "air" => Domain::Air,
                    _ => Domain::Ground,
                },
                name: l.name,
                speeds: l.speeds,
            })
            .collect();
        let mut rules = Rules { factions: raw.factions, player: raw.player, actors, weapons, locomotors, tokens, obtainable: Vec::new() };
        rules.obtainable = (0..rules.factions.len()).map(|f| rules.solve_obtainable(f)).collect();
        rules
    }

    /// Fixed point over the tech tree: which actors a faction can ever build.
    fn solve_obtainable(&self, faction: usize) -> Vec<bool> {
        let disabled = self.token(TOKEN_DISABLED);
        let mut have = vec![false; self.tokens.len()];
        for t in TECH_LEVELS {
            have[self.token(&format!("techlevel.{t}")).unwrap() as usize] = true;
        }
        let mut ok = vec![false; self.actors.len()];
        // The Construction Yard is where every game starts.
        if let Some(fact) = self.actor_index("FACT") {
            ok[fact] = true;
        }
        loop {
            let mut changed = false;
            for (i, a) in self.actors.iter().enumerate() {
                if ok[i] {
                    if let Some(b) = &a.building {
                        for &t in &b.provides[faction] {
                            if !have[t as usize] {
                                have[t as usize] = true;
                                changed = true;
                            }
                        }
                    }
                    continue;
                }
                let reachable = a.prerequisites.iter().all(|p| Some(p.token) != disabled && (p.negate || have[p.token as usize]));
                if reachable {
                    ok[i] = true;
                    changed = true;
                }
            }
            if !changed {
                break;
            }
        }
        // Negated prerequisites (e.g. the generic Spy for England) exclude items at the end.
        for (i, a) in self.actors.iter().enumerate() {
            if a.prerequisites.iter().any(|p| p.negate && have[p.token as usize] && self.always_provided(faction, p.token)) {
                ok[i] = false;
            }
        }
        ok
    }

    /// Whether `token` is given to `faction` by its Construction Yard (faction tokens).
    fn always_provided(&self, faction: usize, token: u16) -> bool {
        self.actor_index("FACT").is_some_and(|f| self.actors[f].building.as_ref().unwrap().provides[faction].contains(&token))
    }

    pub fn actor_index(&self, id: &str) -> Option<usize> {
        self.actors.iter().position(|a| a.id.eq_ignore_ascii_case(id))
    }

    pub fn faction_index(&self, name: &str) -> Option<usize> {
        self.factions.iter().position(|f| f == name)
    }

    pub fn token(&self, name: &str) -> Option<u16> {
        self.tokens.iter().position(|t| t == name).map(|i| i as u16)
    }

    /// Faction side: 0 = Allies, 1 = Soviet.
    pub fn side_of(&self, faction: usize) -> usize {
        match self.factions[faction].as_str() {
            "soviet" | "russia" | "ukraine" => 1,
            _ => 0,
        }
    }
}

/// Deep-merge `overrides` into the rules JSON. Only `actors` (by id) and
/// `weapons` (by name) can be changed, only existing fields, only with values
/// of the same JSON type; identity fields cannot change.
fn apply_overrides(base: &mut serde_json::Value, overrides: &serde_json::Value) -> Result<(), String> {
    use serde_json::Value;
    let o = overrides.as_object().ok_or("rules overrides must be an object")?;
    for (section, key_field) in [("actors", "id"), ("weapons", "name")] {
        let Some(patches) = o.get(section) else { continue };
        let patches = patches.as_object().ok_or_else(|| format!("rules.{section} must be an object"))?;
        let list = base[section].as_array_mut().expect("rules sections are arrays");
        for (id, patch) in patches {
            let target = list
                .iter_mut()
                .find(|e| e[key_field].as_str().is_some_and(|v| v.eq_ignore_ascii_case(id)))
                .ok_or_else(|| format!("rules.{section}: unknown id {}", truncate(id)))?;
            merge(target, patch, &format!("{section}.{}", truncate(id)), key_field)?;
        }
    }
    for k in o.keys() {
        if k != "actors" && k != "weapons" {
            return Err(format!("rules: unknown section {}", truncate(k)));
        }
    }
    fn merge(target: &mut Value, patch: &Value, path: &str, key_field: &str) -> Result<(), String> {
        let (Some(t), Some(p)) = (target.as_object_mut(), patch.as_object()) else {
            return Err(format!("{path}: expected an object"));
        };
        for (k, v) in p {
            if k == key_field || k == "kind" || k == "queue" {
                return Err(format!("{path}.{}: cannot be changed", truncate(k)));
            }
            let cur = t.get_mut(k).ok_or_else(|| format!("{path}: unknown field {}", truncate(k)))?;
            let same_type = matches!(
                (&*cur, v),
                (Value::Number(_), Value::Number(_))
                    | (Value::Bool(_), Value::Bool(_))
                    | (Value::String(_), Value::String(_))
                    | (Value::Array(_), Value::Array(_))
                    | (Value::Object(_), Value::Object(_))
            );
            if !same_type {
                return Err(format!("{path}.{}: wrong type", truncate(k)));
            }
            if v.is_object() {
                merge(cur, v, &format!("{path}.{}", truncate(k)), "")?;
            } else {
                if let Value::Number(n) = v {
                    if !(n.is_i64() || n.is_u64()) {
                        return Err(format!("{path}.{}: numbers must be integers", truncate(k)));
                    }
                }
                *cur = v.clone();
            }
        }
        Ok(())
    }
    Ok(())
}

fn truncate(s: &str) -> String {
    s.chars().take(40).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overrides_change_values_and_reject_bad_input() {
        let o: serde_json::Value = serde_json::json!({ "actors": { "1tnk": { "cost": 123, "unit": { "speed": 200 } } }, "weapons": { "25mm": { "range": 9000 } } });
        let r = Rules::load_with(Some(&o)).unwrap();
        let t = &r.actors[r.actor_index("1TNK").unwrap()];
        assert_eq!(t.cost, 123);
        assert_eq!(t.unit.as_ref().unwrap().speed, 200);
        assert_eq!(r.weapons[t.weapons[0]].range, 9000);
        for bad in [
            serde_json::json!({ "actors": { "NOPE": { "cost": 1 } } }),
            serde_json::json!({ "actors": { "1TNK": { "costt": 1 } } }),
            serde_json::json!({ "actors": { "1TNK": { "cost": "free" } } }),
            serde_json::json!({ "actors": { "1TNK": { "id": "2TNK" } } }),
            serde_json::json!({ "actors": { "1TNK": { "cost": 1.5 } } }),
            serde_json::json!({ "player": { "starting_cash": 1 } }),
        ] {
            assert!(Rules::load_with(Some(&bad)).is_err(), "{bad}");
        }
    }

    #[test]
    fn rules_load_and_resolve() {
        let r = Rules::load();
        let tnk = &r.actors[r.actor_index("3TNK").unwrap()];
        assert_eq!(tnk.cost, 1150);
        assert_eq!(r.weapons[tnk.weapons[0]].name, "105mm");
        assert_eq!(r.weapons[tnk.weapons[0]].burst, 2);
        let proc_ = r.actors[r.actor_index("PROC").unwrap()].building.as_ref().unwrap();
        assert_eq!(proc_.storage, 2000);
        let fact = &r.actors[r.actor_index("FACT").unwrap()];
        assert_eq!(r.tokens[fact.prerequisites[0].token as usize], TOKEN_DISABLED);
        assert_eq!(fact.transforms_into, r.actor_index("MCV"));
        // Mammoth missiles only hit infantry (and aircraft).
        let mammoth = &r.actors[r.actor_index("4TNK").unwrap()];
        let tusk = &r.weapons[mammoth.weapons[1]];
        assert!(tusk.can_target(Kind::Infantry) && !tusk.can_target(Kind::Vehicle));
        assert!(r.actors[r.actor_index("SYRD").unwrap()].building.as_ref().unwrap().on_water);
    }

    #[test]
    fn falloff_matches_openra() {
        let r = Rules::load();
        let w = &r.weapons[r.weapons.iter().position(|w| w.name == "M1Carbine").unwrap()].warheads[0];
        assert_eq!(w.falloff_at(0), 100);
        assert_eq!(w.falloff_at(w.spread), 37);
        assert_eq!(w.falloff_at(w.spread * 3), 0);
    }
}
