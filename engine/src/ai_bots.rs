//! The four bots of OpenRA's Red Alert (mods/ra/rules/ai.yaml): Rush AI,
//! Normal AI, Turtle AI and Naval AI. Each AI slot runs one of them; the
//! module configs come from tools/gen_rules.py (rules.json "bots"), so build
//! orders, fractions, limits, squad sizes and timings are OpenRA's numbers.
//!
//! On top of the bot type, the AI slot's difficulty scales how fast the bot
//! reacts (`Difficulty::interval`): how often it checks its production,
//! hands out roles and updates squads. OpenRA has no difficulty: in 2014 it
//! renamed its "Easy AI" and "Hard AI" to Rush AI and Turtle AI because they
//! were equally strong (OpenRA commit 2320a7d571, "avoid easy/hard
//! classification as they are identical"), so a bot type is a personality,
//! not a strength. Normal is OpenRA's timing exactly; Easy reacts at half
//! the speed, plays with an extra 25 % handicap and leaves the superweapons
//! and the Sonar Pulse alone; Hard reacts in two thirds of the time.
//! docs/contracts.md has the details and the measurements.

use crate::rules::Rules;
use crate::world::AiDifficulty;
use serde::Deserialize;

/// OpenRA's RA bot types (ModularBot@*.Type).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum BotType {
    Rush,
    Normal,
    Turtle,
    Naval,
}

impl Default for BotType {
    fn default() -> Self {
        BotType::Normal
    }
}

impl BotType {
    pub const ALL: [BotType; 4] = [BotType::Rush, BotType::Normal, BotType::Turtle, BotType::Naval];

    /// The lobby and rules.json name ("rush", "normal", "turtle", "naval").
    pub fn name(self) -> &'static str {
        match self {
            BotType::Rush => "rush",
            BotType::Normal => "normal",
            BotType::Turtle => "turtle",
            BotType::Naval => "naval",
        }
    }

    pub fn from_name(s: &str) -> Option<BotType> {
        BotType::ALL.into_iter().find(|b| b.name() == s)
    }
}

// ---- rules.json "bots" -------------------------------------------------------------

#[derive(Deserialize, Clone, Debug)]
pub struct BotInfo {
    #[serde(rename = "type")]
    pub kind: String,
    pub name: String,
    pub base_builder: BaseBuilderInfo,
    pub unit_builder: UnitBuilderInfo,
    pub squads: SquadsInfo,
    pub harvester: HarvesterInfo,
    #[serde(default)]
    pub resource_map: Option<ResourceMapInfo>,
    #[serde(default)]
    pub mcv_expansion: Option<McvExpansionInfo>,
    #[serde(default)]
    pub mcv_manager: Option<McvManagerInfo>,
    #[serde(default)]
    pub power_down: Option<PowerDownInfo>,
    #[serde(default)]
    pub building_repair: Option<BuildingRepairInfo>,
    #[serde(default)]
    pub support_powers: Option<SupportPowersInfo>,
    #[serde(default)]
    pub minelayer: Option<MinelayerInfo>,
}

/// Actor id and a number (BuildingFractions, UnitsToBuild, ...).
pub type ActorCount = (String, i32);

#[derive(Deserialize, Clone, Debug)]
pub struct BaseBuilderInfo {
    pub construction_yard_types: Vec<String>,
    pub refinery_types: Vec<String>,
    pub power_types: Vec<String>,
    pub production_types: Vec<String>,
    pub tech_types: Vec<String>,
    pub naval_production_types: Vec<String>,
    pub silo_types: Vec<String>,
    pub defense_types: Vec<String>,
    pub min_base_radius: i32,
    pub max_base_radius: i32,
    pub minimum_excess_power: i32,
    pub maximum_excess_power: i32,
    pub excess_power_increment: i32,
    pub excess_power_increase_threshold: i32,
    /// OpenRA's spelling (InititalMinimumRefineryCount).
    pub initital_minimum_refinery_count: i32,
    pub additional_minimum_refinery_count: i32,
    pub structure_production_inactive_delay: i32,
    pub structure_production_active_delay: i32,
    pub structure_production_random_bonus_delay: i32,
    pub structure_production_resume_delay: i32,
    pub maximum_failed_placement_attempts: i32,
    pub max_resource_cells_to_check: i32,
    pub check_for_new_bases_delay: i32,
    pub place_defense_towards_enemy_chance: i32,
    pub try_maintain_defense_range: i32,
    pub new_production_cash_threshold: i32,
    pub new_production_chance: i32,
    pub rally_point_scan_radius: i32,
    pub check_for_water_radius: i32,
    pub building_fractions: Vec<ActorCount>,
    pub building_limits: Vec<ActorCount>,
    pub building_delays: Vec<ActorCount>,
    pub production_min_cash_requirement: i32,
    pub assign_rally_points_interval: i32,
    pub check_best_resource_location_interval: i32,
    pub sell_refinery_interval: i32,
    pub sell_refinery_too_close_cell_distance: i32,
    pub sell_refinery_no_resource_distance: i32,
    pub max_refinery_per_indice: i32,
    pub expansion_tolerate: Vec<i32>,
    pub force_expansion_tolerate: Vec<i32>,
    pub per_expansion_tolerate_on_cash: i32,
}

#[derive(Deserialize, Clone, Debug)]
pub struct UnitBuilderInfo {
    pub idle_base_units_maximum: i32,
    pub unit_queues: Vec<String>,
    pub units_to_build: Vec<ActorCount>,
    pub unit_limits: Vec<ActorCount>,
    pub unit_delays: Vec<ActorCount>,
    pub production_min_cash_requirement: i32,
}

#[derive(Deserialize, Clone, Debug)]
pub struct SquadsInfo {
    pub naval_units_types: Vec<String>,
    pub air_units_types: Vec<String>,
    pub exclude_from_squads_types: Vec<String>,
    pub construction_yard_types: Vec<String>,
    pub naval_production_types: Vec<String>,
    pub protection_types: Vec<String>,
    pub aircraft_target_type: Vec<String>,
    pub squad_size: i32,
    pub squad_size_random_bonus: i32,
    pub assign_roles_interval: i32,
    pub rush_interval: i32,
    pub attack_force_interval: i32,
    pub minimum_attack_force_delay: i32,
    pub rush_attack_scan_radius: i32,
    pub protect_unit_scan_radius: i32,
    pub max_base_radius: i32,
    pub idle_scan_radius: i32,
    pub danger_scan_radius: i32,
    pub attack_scan_radius: i32,
    pub protection_scan_radius: i32,
    pub ignored_enemy_target_types: Vec<String>,
}

#[derive(Deserialize, Clone, Debug)]
pub struct HarvesterInfo {
    pub harvester_types: Vec<String>,
    pub refinery_types: Vec<String>,
    pub scan_for_idle_harvesters_interval: i32,
    pub scan_for_low_effect_harvesters_interval: i32,
    pub scan_interval_multipler_when_no_resources: i32,
    /// World units.
    pub harvester_enemy_avoidance_radius: i32,
    pub harvester_enemy_avoidance_cost_multipler: i32,
    pub resource_cells_per_harvester: i32,
    pub initial_harvesters: i32,
}

#[derive(Deserialize, Clone, Debug)]
pub struct ResourceMapInfo {
    pub valuable_resource_types: Vec<String>,
    pub resource_creator_types: Vec<String>,
    pub refinery_types: Vec<String>,
    pub harvester_types: Vec<String>,
    pub enemy_base_building_types: Vec<String>,
    /// OpenRA's spelling (UpdateResourceMapInverval).
    pub update_resource_map_inverval: i32,
    pub resource_map_stride_radius: i32,
}

#[derive(Deserialize, Clone, Debug)]
pub struct McvExpansionInfo {
    pub mcv_types: Vec<String>,
    pub construction_yard_types: Vec<String>,
    pub mcv_factory_types: Vec<String>,
    pub minimum_construction_yard_count: i32,
    pub additional_construction_yard_count: i32,
    pub build_additional_mcv_cash_amount: i32,
    pub scan_for_new_mcv_interval: i32,
    pub build_mcv_interval: i32,
    pub move_conyard_tick: i32,
    /// None: OpenRA picks oldest or newest at random each time.
    pub move_old_conyard_first: Option<bool>,
    pub cr_mode_min_deploy_radius: i32,
    pub cr_mode_max_deploy_radius: i32,
    pub cr_mode_try_maintain_range: i32,
    pub cr_mode_friendly_conyard_dislike_range: i32,
    pub cr_mode_friendly_refinery_dislike_range: i32,
    pub cb_mode_min_deploy_radius: i32,
    pub cb_mode_max_deploy_radius: i32,
}

#[derive(Deserialize, Clone, Debug)]
pub struct McvManagerInfo {
    pub mcv_types: Vec<String>,
    pub construction_yard_types: Vec<String>,
    pub mcv_factory_types: Vec<String>,
    pub minimum_construction_yard_count: i32,
    pub scan_for_new_mcv_interval: i32,
    pub min_base_radius: i32,
    pub max_base_radius: i32,
    pub restrict_mcv_deployment_fallback_to_base: bool,
}

#[derive(Deserialize, Clone, Debug)]
pub struct PowerDownInfo {
    pub interval: i32,
    pub power_down_types: Vec<String>,
}

#[derive(Deserialize, Clone, Debug)]
pub struct BuildingRepairInfo {
    pub repair_all_buildings_cool_down: i32,
}

#[derive(Deserialize, Clone, Debug)]
pub struct SupportPowersInfo {
    pub decisions: Vec<DecisionInfo>,
}

/// OpenRA SupportPowerDecision.
#[derive(Deserialize, Clone, Debug)]
pub struct DecisionInfo {
    pub order_name: String,
    pub minimum_attractiveness: i32,
    pub coarse_scan_radius: i32,
    pub fine_scan_radius: i32,
    pub minimum_scan_time_interval: i32,
    pub maximum_scan_time_interval: i32,
    pub considerations: Vec<ConsiderationInfo>,
}

/// OpenRA SupportPowerDecision.Consideration.
#[derive(Deserialize, Clone, Debug)]
pub struct ConsiderationInfo {
    /// "Enemy", "Ally" or "Neutral".
    pub against: String,
    /// Target types (Air, Ground, Water, Structure, ...).
    pub types: Vec<String>,
    pub attractiveness: i32,
    /// "None", "Value" or "Health".
    pub target_metric: String,
    /// World units.
    pub check_radius: i32,
}

#[derive(Deserialize, Clone, Debug)]
pub struct MinelayerInfo {
    pub ignored_enemy_target_types: Vec<String>,
    pub use_enemy_location_target_types: Vec<String>,
    pub minelaying_actor_types: Vec<String>,
    pub max_per_assign: i32,
    pub scan_tick: i32,
    pub mine_field_radius: i32,
    pub away_from_allied_target_types: Vec<String>,
    pub away_from_enemy_target_types: Vec<String>,
    pub away_from_cell_distance: i32,
    pub favorite_position_distance: i32,
}

// ---- Target types --------------------------------------------------------------------

/// OpenRA target types the bot configs name, as bits (`target_types`).
pub const TT_GROUND: u32 = 1;
pub const TT_AIR: u32 = 2;
pub const TT_WATER: u32 = 4;
pub const TT_STRUCTURE: u32 = 8;
pub const TT_DEFENSE: u32 = 16;
pub const TT_UNDERWATER: u32 = 32;

/// Bits of the target type names (Air and AirborneActor are both what flies).
pub fn target_type_mask(names: &[String]) -> u32 {
    names
        .iter()
        .map(|n| match n.as_str() {
            "Ground" | "GroundActor" => TT_GROUND,
            "Air" | "AirborneActor" => TT_AIR,
            "Water" | "WaterActor" => TT_WATER,
            "Structure" => TT_STRUCTURE,
            "Defense" => TT_DEFENSE,
            "Underwater" => TT_UNDERWATER,
            _ => 0,
        })
        .fold(0, |a, b| a | b)
}

/// The OpenRA target types actor `i` has right now (as `TT_*` bits): what
/// flies is Air, ships are Water (submerged submarines Underwater), the rest
/// Ground; structures are also Structure, and armed ones of the Defense
/// queue (pillboxes, turrets, Tesla Coils, anti-air) also Defense.
pub fn target_types(w: &crate::world::World, i: usize) -> u32 {
    use crate::rules::{Kind, TARGET_AIR, TARGET_STRUCTURE, TARGET_WATER};
    let a = &w.actors[i];
    let info = &w.rules.actors[a.ty as usize];
    let class = w.target_class(i);
    let mut t = 0;
    if class & TARGET_AIR != 0 {
        t |= TT_AIR;
    } else if a.kind == Kind::Ship {
        t |= if a.submerged { TT_UNDERWATER } else { TT_WATER };
    } else {
        t |= TT_GROUND;
        if class & TARGET_WATER != 0 {
            t |= TT_WATER;
        }
    }
    if class & TARGET_STRUCTURE != 0 {
        t |= TT_STRUCTURE;
        if info.defense {
            t |= TT_DEFENSE;
        }
    }
    t
}

// ---- Resolved configs ------------------------------------------------------------------

/// Actor types of a list, by index (ids the rules do not have are left out).
fn types(rules: &Rules, ids: &[String]) -> Vec<u16> {
    ids.iter().filter_map(|id| rules.actor_index(id)).map(|t| t as u16).collect()
}

fn counts(rules: &Rules, list: &[ActorCount]) -> Vec<(u16, i32)> {
    list.iter().filter_map(|(id, n)| rules.actor_index(id).map(|t| (t as u16, *n))).collect()
}

/// A bot's module configs with actor ids resolved to type indices.
#[derive(Debug)]
pub struct BotConfig {
    pub bot: BotType,
    pub info: BotInfo,
    pub yards: Vec<u16>,
    pub refineries: Vec<u16>,
    pub power: Vec<u16>,
    pub production: Vec<u16>,
    pub tech: Vec<u16>,
    pub naval_production: Vec<u16>,
    pub silos: Vec<u16>,
    pub defenses: Vec<u16>,
    pub fractions: Vec<(u16, i32)>,
    pub limits: Vec<(u16, i32)>,
    pub delays: Vec<(u16, i32)>,
    pub units_to_build: Vec<(u16, i32)>,
    pub unit_limits: Vec<(u16, i32)>,
    pub unit_delays: Vec<(u16, i32)>,
    pub naval_units: Vec<u16>,
    pub air_units: Vec<u16>,
    pub excluded: Vec<u16>,
    pub protection: Vec<u16>,
    pub squad_naval_production: Vec<u16>,
    pub aircraft_target: u32,
    pub ignored_targets: u32,
    pub harvesters: Vec<u16>,
    pub harvester_refineries: Vec<u16>,
    pub enemy_base_buildings: Vec<u16>,
    pub mcvs: Vec<u16>,
    pub mcv_factories: Vec<u16>,
    pub power_down: Vec<u16>,
    pub minelayers: Vec<u16>,
}

impl BotConfig {
    pub fn new(rules: &Rules, bot: BotType) -> BotConfig {
        let info = rules.bots.iter().find(|b| b.kind == bot.name()).unwrap_or_else(|| panic!("rules have no {} bot", bot.name())).clone();
        let bb = &info.base_builder;
        let sq = &info.squads;
        let (mcvs, mcv_factories) = match (&info.mcv_expansion, &info.mcv_manager) {
            (Some(m), _) => (types(rules, &m.mcv_types), types(rules, &m.mcv_factory_types)),
            (None, Some(m)) => (types(rules, &m.mcv_types), types(rules, &m.mcv_factory_types)),
            _ => (Vec::new(), Vec::new()),
        };
        BotConfig {
            bot,
            yards: types(rules, &bb.construction_yard_types),
            refineries: types(rules, &bb.refinery_types),
            power: types(rules, &bb.power_types),
            production: types(rules, &bb.production_types),
            tech: types(rules, &bb.tech_types),
            naval_production: types(rules, &bb.naval_production_types),
            silos: types(rules, &bb.silo_types),
            defenses: types(rules, &bb.defense_types),
            fractions: counts(rules, &bb.building_fractions),
            limits: counts(rules, &bb.building_limits),
            delays: counts(rules, &bb.building_delays),
            units_to_build: counts(rules, &info.unit_builder.units_to_build),
            unit_limits: counts(rules, &info.unit_builder.unit_limits),
            unit_delays: counts(rules, &info.unit_builder.unit_delays),
            naval_units: types(rules, &sq.naval_units_types),
            air_units: types(rules, &sq.air_units_types),
            excluded: types(rules, &sq.exclude_from_squads_types),
            protection: types(rules, &sq.protection_types),
            squad_naval_production: types(rules, &sq.naval_production_types),
            aircraft_target: target_type_mask(&sq.aircraft_target_type),
            ignored_targets: target_type_mask(&sq.ignored_enemy_target_types),
            harvesters: types(rules, &info.harvester.harvester_types),
            harvester_refineries: types(rules, &info.harvester.refinery_types),
            enemy_base_buildings: info.resource_map.as_ref().map_or_else(Vec::new, |r| types(rules, &r.enemy_base_building_types)),
            mcvs,
            mcv_factories,
            power_down: info.power_down.as_ref().map_or_else(Vec::new, |p| types(rules, &p.power_down_types)),
            minelayers: info.minelayer.as_ref().map_or_else(Vec::new, |m| types(rules, &m.minelaying_actor_types)),
            info,
        }
    }

    /// Value of `ty` in an actor/number list (None: not listed).
    pub fn lookup(list: &[(u16, i32)], ty: u16) -> Option<i32> {
        list.iter().find(|&&(t, _)| t == ty).map(|&(_, n)| n)
    }
}

/// Extra handicap of an Easy bot, in percent (a step of OpenRA's handicap).
pub const EASY_HANDICAP: u8 = 25;

/// What the slot's difficulty changes (see the module docs).
#[derive(Clone, Copy, Debug)]
pub struct Difficulty(pub AiDifficulty);

impl Difficulty {
    /// A decision interval of the bot's modules, scaled by the difficulty:
    /// Easy waits twice as long, Hard two thirds.
    pub fn interval(self, ticks: i32) -> i32 {
        match self.0 {
            AiDifficulty::Easy => ticks * 2,
            AiDifficulty::Normal => ticks,
            AiDifficulty::Hard => (ticks * 2 / 3).max(1),
        }
    }

    /// Handicap (OpenRA's, gamerules.rs) added to the slot's own: Easy bots
    /// play with EASY_HANDICAP percent less firepower and armour and slower
    /// production, as reacting slower alone hardly weakens them (measured
    /// with examples/bot_matrix.rs, docs/contracts.md).
    pub fn handicap(self) -> u8 {
        if self.0 == AiDifficulty::Easy {
            EASY_HANDICAP
        } else {
            0
        }
    }

    /// Whether the bot fires the superweapons OpenRA's bots never use (Iron
    /// Curtain, Chronosphere) and the Sonar Pulse (ai_support.rs).
    pub fn uses_extra_powers(self) -> bool {
        self.0 != AiDifficulty::Easy
    }
}
