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
    /// World actor rules of the lobby options (rules_options.rs).
    world: crate::rules_options::RawWorldRules,
    /// OpenRA's RA bots (ai.yaml, ai_bots.rs).
    bots: Vec<crate::ai_bots::BotInfo>,
}

#[derive(Deserialize, Clone)]
pub struct PlayerRules {
    pub starting_cash: i32,
    pub ore_value: i32,
    pub low_power_modifier: i32,
    pub speed_reduction: Vec<i32>,
    pub ore_max_density: u8,
    /// Credits per gem bale (PlayerResources.ResourceValues.Gems).
    pub gem_value: i32,
    /// Bales a gem cell holds at most (ResourceLayer Gems MaxDensity).
    pub gem_max_density: u8,
    /// Ticks a placed beacon stays on the map (PlaceBeacon.Duration, beacons.rs).
    pub beacon_duration: i32,
}

#[derive(Deserialize)]
struct RawActor {
    id: String,
    name: String,
    description: String,
    kind: String,
    queue: String,
    cost: i32,
    /// OpenRA CustomSellValue.Value (absent: the cost counts).
    #[serde(default)]
    custom_sell_value: Option<i32>,
    build_ticks: i32,
    palette_order: i32,
    /// OpenRA Buildable.BuildLimit (0: no limit).
    #[serde(default)]
    build_limit: i32,
    prerequisites: Vec<String>,
    build_at: String,
    hp: i32,
    armor: usize,
    sight: i32,
    weapons: Vec<usize>,
    turret_turn_speed: Option<i32>,
    reload_override: Option<i32>,
    requires_power: bool,
    defense: bool,
    opportunity_fire: bool,
    base_building: bool,
    /// OpenRA Selectable (selection.rs); null: cannot be selected.
    #[serde(default)]
    selection: Option<SelectionInfo>,
    death_weapon: Option<usize>,
    self_heal: Option<SelfHeal>,
    turret_offsets: Vec<Vec<i32>>,
    stance: Option<(Stance, Stance)>,
    abilities: Abilities,
    experience: Option<ExperienceInfo>,
    gives_experience: Option<GivesExperienceInfo>,
    take_cover: Option<RawTakeCover>,
    producible_level: Option<ProducibleLevel>,
    #[serde(default)]
    production_overlays: Vec<ProductionOverlay>,
    fire_delays: Vec<i32>,
    targets_allies: bool,
    death: Option<RawDeath>,
    infiltrate_types: Vec<String>,
    disguisable: bool,
    /// OpenRA Tooltip (tooltip.rs); null: none (EditorOnlyTooltip).
    #[serde(default)]
    tooltip: Option<TooltipInfo>,
    /// Range circles (range_circles.rs).
    #[serde(default)]
    range_circles: Vec<RangeCircleInfo>,
    building: Option<RawBuilding>,
    unit: Option<UnitInfo>,
    /// The neutral world's traits (neutral.rs).
    #[serde(default)]
    world: crate::neutral::WorldTraits,
    /// Lobby options and leftovers (rules_options.rs).
    #[serde(flatten)]
    options: crate::rules_options::RawActorOptions,
}

/// OpenRA `Selectable` (selection.rs).
#[derive(Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct SelectionInfo {
    /// Selection priority: among the actors a hotkey or box finds, only those
    /// of the highest priority are selected (combat units 10, support units 8,
    /// harvesters 6, defences 4, other structures 2).
    pub priority: i32,
    /// `PriorityModifiers` bits (`SELECT_CTRL`, `SELECT_ALT`): holding that
    /// key (and not the other) raises the priority above every other.
    pub modifiers: u8,
    /// Selection class: double click and the select by type hotkey pick the
    /// actors of the same class (the actor's own name unless the trait sets one).
    pub class: String,
    /// `Bounds` in world units: width, height and the x, y offset of their
    /// centre; empty: the footprint (structures) or one cell.
    pub bounds: Vec<i32>,
}

/// OpenRA `Tooltip` (and the spy's `DisguiseTooltip`): how the battlefield
/// tooltip names an actor (tooltip.rs). The name is `ActorInfo::name`.
#[derive(Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct TooltipInfo {
    /// GenericName: shown instead of the name to the relationships of `generic_visibility`.
    pub generic_name: String,
    /// GenericVisibility: `REL_*` bits.
    pub generic_visibility: u8,
    /// GenericStancePrefix: "Ally" or "Enemy" before the generic name.
    pub generic_prefix: bool,
    /// ShowOwnerRow: the owner's flag and name under the name.
    pub show_owner: bool,
}

/// OpenRA `PlayerRelationship` flags, as in `TooltipInfo::generic_visibility`.
pub const REL_ALLY: u8 = 1;
pub const REL_NEUTRAL: u8 = 2;
pub const REL_ENEMY: u8 = 4;

/// Which OpenRA trait draws a range circle (range_circles.rs).
#[derive(Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CircleKind {
    /// RenderRangeCircle: the longest weapon range (`range`: FallbackRange).
    Range,
    /// RenderDetectionCircle: the DetectCloaked range.
    Detection,
    /// RenderShroudCircle: the CreatesShroud range (gap generators).
    Shroud,
    /// RenderJammerCircle: the JamsMissiles range.
    Jammer,
    /// WithRangeCircle: a fixed range.
    Fixed,
}

/// A range circle (range_circles.rs): drawn around the selected actor for its
/// owner and allies, and while a structure with one is placed.
#[derive(Deserialize, Clone, Debug, PartialEq)]
pub struct RangeCircleInfo {
    pub kind: CircleKind,
    /// RangeCircleType (RenderRangeCircle) or Type (WithRangeCircle): placing
    /// a structure shows the circles of the same group around other actors.
    pub group: String,
    /// Radius in world units (RenderRangeCircle: FallbackRange).
    pub range: i32,
    /// Line and border colours, RGBA 0..=255.
    pub color: [u8; 4],
    pub border: [u8; 4],
    /// Line and border widths (OpenRA Width, BorderWidth).
    pub width: f32,
    pub border_width: f32,
    /// Shown while placing the structure (IPlaceBuildingDecorationInfo, enabled by default).
    pub placement: bool,
    /// Shown only with one of these passengers inside (PassengerConditions); empty: always.
    pub passengers: Vec<String>,
}

/// `SelectionInfo::modifiers` bits.
pub const SELECT_CTRL: u8 = 1;
pub const SELECT_ALT: u8 = 2;

/// OpenRA `ProducibleWithLevel`: produced with `levels` veterancy levels while
/// the owner has every prerequisite (a spy infiltrated a barracks, say).
#[derive(Deserialize, Clone)]
pub struct ProducibleLevel {
    pub prerequisites: Vec<String>,
    pub levels: i32,
}

/// OpenRA `WithProductionIconOverlay`: the cameo shows the overlays of
/// `types` (a `ProductionIconOverlayManager` of the player draws each: RA's
/// Veterancy chevron) while the owner has every prerequisite.
#[derive(Deserialize, Clone)]
pub struct ProductionOverlay {
    pub types: Vec<String>,
    pub prerequisites: Vec<String>,
}

#[derive(Deserialize)]
struct RawDeath {
    types: Vec<RawDeathType>,
    crushed: bool,
}

#[derive(Deserialize)]
struct RawDeathType {
    #[serde(rename = "type")]
    ty: String,
    sequence: u8,
}

/// OpenRA `WithDeathAnimation` of infantry (infantry.rs): which death
/// sequence (`die1`..`die6`) a kill with a damage type plays, by damage type
/// bit (`Rules::damage_types`), and whether being crushed has its own.
#[derive(Clone, Debug)]
pub struct DeathInfo {
    pub by_type: Vec<(u32, u8)>,
    pub crushed: bool,
}

#[derive(Deserialize, Clone)]
pub struct SelfHeal {
    pub step: i32,
    pub delay: i32,
    pub start_if_below: i32,
    pub damage_cooldown: i32,
}

/// OpenRA `GainsExperience` with RA's rank bonuses (veterancy.rs). Every list
/// has one entry per level, index 0 = level 1; modifiers are percentages.
#[derive(Deserialize, Clone)]
pub struct ExperienceInfo {
    /// Experience needed for each level, as a multiple of the actor's own
    /// value (`Conditions` keys: 200 = twice its cost in killed enemies).
    pub thresholds: Vec<i32>,
    /// FirepowerMultiplier: damage of the actor's warheads.
    pub firepower: Vec<i32>,
    /// DamageMultiplier: damage the actor takes.
    pub damage: Vec<i32>,
    /// SpeedMultiplier: movement speed.
    pub speed: Vec<i32>,
    /// ReloadDelayMultiplier: delay between bursts.
    pub reload: Vec<i32>,
    /// ChangesHealth@ELITE: self repair from level `rank` up.
    pub heal: Option<RankHeal>,
}

/// OpenRA `ChangesHealth` switched on by a rank (elite self repair).
#[derive(Deserialize, Clone)]
pub struct RankHeal {
    /// First level (1-based) that heals.
    pub rank: i32,
    pub step: i32,
    /// Percentage of the maximum health healed per step, on top of `step`.
    pub percentage_step: i32,
    pub delay: i32,
    pub start_if_below: i32,
    pub damage_cooldown: i32,
}

/// OpenRA `GivesExperience`: what the killer of this actor gains.
#[derive(Deserialize, Clone)]
pub struct GivesExperienceInfo {
    /// Experience value; -1 uses the actor's cost.
    pub experience: i32,
    /// ActorExperienceModifier: percentage of the value the killing actor gains.
    pub actor_modifier: i32,
    /// PlayerExperienceModifier: percentage of the value the killing player gains (gamerules.rs).
    pub player_modifier: i32,
}

#[derive(Deserialize)]
struct RawTakeCover {
    duration: i32,
    speed_modifier: i32,
    damage_triggers: Vec<String>,
    damage_modifiers: Vec<RawDamageModifier>,
}

#[derive(Deserialize)]
struct RawDamageModifier {
    #[serde(rename = "type")]
    ty: String,
    percent: i32,
}

/// OpenRA `TakeCover` (veterancy.rs): infantry go prone when a warhead with a
/// trigger damage type hits them, take less damage from some damage types and
/// move slower while prone. Damage types are bits of `Rules::damage_types`.
#[derive(Clone)]
pub struct TakeCoverInfo {
    /// Ticks the actor stays prone after the last triggering hit.
    pub duration: i32,
    /// Movement speed while prone, percent.
    pub speed_modifier: i32,
    /// Damage type bits that make the actor go prone (DamageTriggers).
    pub triggers: u32,
    /// (damage type bit, percent) applied to hits of that type while prone (DamageModifiers).
    pub modifiers: Vec<(u32, i32)>,
}

/// Special abilities from OpenRA traits. Each is optional.
#[derive(Deserialize, Clone, Default)]
pub struct Abilities {
    pub cargo: Option<CargoInfo>,
    pub minelayer: Option<MinelayerInfo>,
    /// OpenRA `EjectOnDeath` (aircraft): a pilot may bail out when it is destroyed.
    pub eject_on_death: Option<EjectOnDeathInfo>,
    pub jams_missiles: Option<RangeInfo>,
    pub creates_shroud: Option<RangeInfo>,
    pub cloak: Option<CloakInfo>,
    pub detect_cloaked: Option<DetectCloakedInfo>,
    pub portable_chrono: Option<PortableChronoInfo>,
    pub mad_tank: Option<MadTankInfo>,
    pub demo_truck: Option<serde_json::Value>,
    pub delivers_cash: Option<DeliversCashInfo>,
    pub transforms: Option<TransformsInfo>,
    pub line_build: Option<LineBuildInfo>,
    /// OpenRA `ProvidesRadar`: owning one that is powered (and not jammed) turns the radar minimap on (minimap.rs).
    pub provides_radar: Option<ProvidesRadarInfo>,
    /// Mobile Radar Jammer (`ProximityExternalCondition@JAMMER`, condition `jammed`):
    /// enemy radar structures in range go offline and enemy radar shows no blips in range (minimap.rs).
    pub jams_radar: Option<RangeInfo>,
    pub crushable: Option<Vec<String>>,
    pub support_powers: Option<Vec<SupportPowerInfo>>,
    /// OpenRA `MineImmune`: drives over mines without setting them off (Minelayer).
    pub mine_immune: Option<serde_json::Value>,
    /// OpenRA `AcceptsDeliveredCash`: a Supply Truck can deliver its payload here.
    pub accepts_cash: Option<serde_json::Value>,
    /// Vision range that also sees through gap generator shroud
    /// (`RevealsShroud` with `RevealGeneratedShroud: True`, e.g. `@GAPGEN`).
    pub gap_sight: Option<RangeInfo>,
    /// Iron Curtain can make it invulnerable (ExternalCondition@INVULNERABILITY).
    pub iron_curtainable: Option<IronCurtainableInfo>,
    /// The Chronosphere can shift it (Chronoshiftable).
    pub chronoshiftable: Option<ChronoshiftableInfo>,
    // ---- Infantry abilities (infantry.rs) ------------------------------------
    /// OpenRA `Captures` (Engineer, Thief, Mechanic): one entry per trait.
    pub captures: Option<Vec<CapturesInfo>>,
    /// OpenRA `Capturable`: capture types that can take it over.
    pub capturable: Option<CapturableInfo>,
    /// OpenRA `InstantlyRepairs` (Engineer): enters an own or allied
    /// structure that has `instantly_repairable` and repairs it fully.
    pub instantly_repairs: Option<serde_json::Value>,
    pub instantly_repairable: Option<serde_json::Value>,
    /// OpenRA `RepairsBridges` (Engineer). Bridges come with the world objects;
    /// they call `World::repair_target` (infantry.rs) to take it into account.
    pub repairs_bridges: Option<serde_json::Value>,
    /// OpenRA `Infiltrates` (Spy, Thief, Mechanic).
    pub infiltrates: Option<InfiltratesInfo>,
    /// OpenRA `InfiltrateFor*` effects of a structure (or husk) when entered.
    pub infiltrated: Option<Vec<InfiltratedInfo>>,
    /// OpenRA `Disguise` (Spy).
    pub disguise: Option<serde_json::Value>,
    /// OpenRA `IgnoresDisguise` (Dog, Spy): sees through spies' disguises.
    pub ignores_disguise: Option<serde_json::Value>,
    /// OpenRA `Demolition` (Tanya's C4).
    pub demolition: Option<DemolitionInfo>,
    /// OpenRA `Demolishable`: C4 can blow it up.
    pub demolishable: Option<serde_json::Value>,
    /// OpenRA `AttackLeap` (Dog).
    pub attack_leap: Option<AttackLeapInfo>,
    /// A proxy (OpenRA InfiltrateForSupportPower.Proxy): the prerequisites it provides.
    pub proxy: Option<ProxyInfo>,
    /// OpenRA `AnnounceOnKill` (Tanya): a voice line after a kill, at most every `interval` ticks.
    pub announce_on_kill: Option<AnnounceOnKillInfo>,
}

#[derive(Deserialize, Clone, Debug)]
pub struct AnnounceOnKillInfo {
    pub interval: i32,
}

/// One OpenRA `Captures` trait.
#[derive(Deserialize, Clone, Debug)]
pub struct CapturesInfo {
    pub types: Vec<String>,
    /// CaptureDelay: ticks next to the target before entering it.
    pub delay: i32,
    /// ConsumedByCapture: the captor enters and is used up.
    pub consumed: bool,
    pub experience: i32,
    /// 1: only with the Reusable Engineers option, -1: only without, 0: always.
    pub option: i32,
}

#[derive(Deserialize, Clone, Debug)]
pub struct CapturableInfo {
    pub types: Vec<String>,
    /// CancelActivity: the captured actor stops what it was doing.
    pub cancel_activity: bool,
}

#[derive(Deserialize, Clone, Debug)]
pub struct InfiltratesInfo {
    /// Target types (`ActorInfo::infiltrate_types`) it can enter.
    pub types: Vec<String>,
    /// ValidRelationships as RELATION_* bits.
    pub relationships: u32,
}

/// One OpenRA `InfiltrateFor*` trait of an infiltratable actor.
#[derive(Deserialize, Clone, Debug)]
pub struct InfiltratedInfo {
    /// cash, exploration, power_outage, support_power, power_reset or decoration.
    pub kind: String,
    /// Infiltrates types that trigger it.
    pub types: Vec<String>,
    pub experience: i32,
    #[serde(default)]
    pub percentage: i32,
    #[serde(default)]
    pub minimum: i32,
    #[serde(default)]
    pub maximum: i32,
    #[serde(default)]
    pub experience_percentage: i32,
    /// Power outage ticks.
    #[serde(default)]
    pub duration: i32,
    /// Proxy actor id granted to the infiltrator's owner (support_power).
    #[serde(default)]
    pub proxy: String,
    /// transform (InfiltrateForTransform, husks): the actor it turns into and its health percentage.
    #[serde(default)]
    pub into: String,
    #[serde(default)]
    pub health: i32,
}

#[derive(Deserialize, Clone, Debug)]
pub struct DemolitionInfo {
    pub delay: i32,
    pub flashes: i32,
    pub flash_delay: i32,
    pub flash_interval: i32,
}

#[derive(Deserialize, Clone, Debug)]
pub struct AttackLeapInfo {
    /// World units per tick while leaping.
    pub speed: i32,
    /// SpeedMultiplier while aiming (the `run` condition), percent.
    pub run_speed: i32,
    /// Ticks the dog stands still after a bite (GrantConditionOnAttack `eating`).
    pub eat_ticks: i32,
}

#[derive(Deserialize, Clone, Debug)]
pub struct ProxyInfo {
    pub provides: Vec<String>,
}

#[derive(Deserialize, Clone, Default)]
pub struct ProvidesRadarInfo {
    /// `RequiresCondition: !jammed`: an enemy radar jammer in range switches it off.
    #[serde(default)]
    pub jammable: bool,
}

#[derive(Deserialize, Clone)]
pub struct IronCurtainableInfo {
    /// KillsSelf on invulnerability (Demolition Truck).
    pub kills: bool,
}

#[derive(Deserialize, Clone)]
pub struct ChronoshiftableInfo {
    /// Explodes instead of teleporting (Demolition Truck).
    pub explode_instead: bool,
    /// Only while not deployed (MAD tank).
    pub not_deployed: bool,
}

/// OpenRA `Cargo` (transports and garrisons). See cargo.rs.
#[derive(Deserialize, Clone)]
pub struct CargoInfo {
    pub types: Vec<String>,
    /// MaxWeight: sum of the passengers' `passenger_weight`.
    pub max: i32,
    pub garrison: bool,
    pub initial: Vec<String>,
    pub before_unload_delay: i32,
    pub after_unload_delay: i32,
    pub eject_on_sell: bool,
    pub eject_on_death: bool,
}

#[derive(Deserialize, Clone)]
pub struct EjectOnDeathInfo {
    /// Actor id of the pilot (PilotActor, an infantry type).
    pub pilot: String,
    /// Percent chance per death (SuccessRate).
    pub success_rate: i32,
    /// Ejects while the actor is in the air (EjectInAir) / at ground level (EjectOnGround).
    pub in_air: bool,
    pub on_ground: bool,
    /// The pilot also comes out over cells it cannot stand on (AllowUnsuitableCell).
    pub allow_unsuitable_cell: bool,
}

#[derive(Deserialize, Clone)]
pub struct MinelayerInfo {
    pub mine: String,
    pub ammo: i32,
    /// Ticks per mine reloaded at a rearm actor (AmmoPool.ReloadDelay).
    pub reload_delay: i32,
    pub terrain: Vec<String>,
    pub rearm_actors: Vec<String>,
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
    /// Detection types that reveal it (Cloak, Underwater, Mine).
    pub types: Vec<String>,
    /// Cloaking pauses while the actor is critically damaged.
    pub off_when_critical: bool,
}

/// OpenRA `DetectCloaked`: reveals cloaked actors whose cloak types match.
#[derive(Deserialize, Clone)]
pub struct DetectCloakedInfo {
    pub range: i32,
    pub types: Vec<String>,
    /// Only works while the owner has enough power (Tesla Coil).
    pub needs_power: bool,
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
    pub detonation_delay: i32,
    /// Actor that bails out before the detonation.
    pub driver: String,
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
    /// SupportPowerPaletteOrder: position in the support power bar.
    #[serde(default)]
    pub palette_order: i32,
    /// SupportPowerInfo.Icon: its picture (sequence of OpenRA's `icon` image) in the observer's support power icons.
    #[serde(default)]
    pub icon: String,
    /// OrderName: how the AI's SupportPowerBotModule decisions name the power (ai_support.rs).
    #[serde(default)]
    pub order_name: String,
    // ---- Aircraft powers (AirstrikePower, ParatroopersPower); see powers.rs and plane.rs.
    /// Actor id of the aircraft that flies in (UnitType).
    #[serde(default)]
    pub unit_type: String,
    #[serde(default)]
    pub squad_size: i32,
    /// SquadOffset (x, y) between the planes of a squad, in world units.
    #[serde(default)]
    pub squad_offset: Vec<i32>,
    /// Actor ids dropped by a ParatroopersPower (DropItems).
    #[serde(default)]
    pub drop_items: Vec<String>,
    /// Reveal range of the power's camera at the target (0: none).
    #[serde(default)]
    pub camera_range: i32,
    /// Ticks the camera stays after the aircraft passed (CameraRemoveDelay).
    #[serde(default)]
    pub camera_remove_delay: i32,
    // ---- Superweapons (ChronoshiftPower, GrantExternalConditionPower, NukePower, GpsPower); see abilities.rs.
    /// Target area rows ('x' = affected cell), centred on the target cell.
    #[serde(default)]
    pub footprint: Vec<String>,
    /// Chronoshift: passengers of shifted transports die.
    #[serde(default)]
    pub kill_cargo: bool,
    /// Nuke: weapon index of the missile.
    #[serde(default)]
    pub missile_weapon: Option<usize>,
    /// Nuke: ticks before the missile leaves the silo, and its flight time.
    #[serde(default)]
    pub missile_delay: i32,
    #[serde(default)]
    pub flight_delay: i32,
    /// Nuke: the target camera appears this many ticks before impact.
    #[serde(default)]
    pub camera_spawn_advance: i32,
    /// Nuke: how fast the missile rises and falls (FlightVelocity, world
    /// units per tick): it turns at that speed times half the flight time up.
    #[serde(default)]
    pub flight_velocity: i32,
    /// Nuke: where the missile leaves the silo (SpawnOffset: forward, right,
    /// up from its centre, world units; turned into the world like OpenRA's
    /// BodyOrientation.LocalToWorld).
    #[serde(default)]
    pub spawn_offset: Vec<i32>,
    /// Nuke: the target beacon goes this many ticks before the flight time
    /// ends (BeaconRemoveAdvance).
    #[serde(default)]
    pub beacon_remove_advance: i32,
    /// GPS: ticks from launch until the map is revealed.
    #[serde(default)]
    pub reveal_delay: i32,
    /// Fires once per game (GPS Satellite).
    #[serde(default)]
    pub one_shot: bool,
    /// StartFullyCharged: a new instance starts ready instead of empty
    /// (OpenRA SupportPowerInstance; no Red Alert power sets it, maps may).
    #[serde(default)]
    pub start_fully_charged: bool,
    /// DisplayTimerRelationships: who sees the power's countdown in the
    /// top-left timer list, relative to its owner ("ally", "neutral", "enemy";
    /// the owner counts as an ally). Empty: nobody (OpenRA's default None).
    #[serde(default)]
    pub display_timer: Vec<String>,
    // ---- SpawnActorPower (the Sonar Pulse, infantry.rs).
    /// Terrain types the target cell must have (empty: any).
    #[serde(default)]
    pub terrain: Vec<String>,
    /// AllowUnderShroud: false needs an explored target cell.
    #[serde(default)]
    pub allow_under_shroud: bool,
    /// DetectCloaked of the spawned actor: range and detection types.
    #[serde(default)]
    pub detect_range: i32,
    #[serde(default)]
    pub detect_types: Vec<String>,
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
    /// Priority of each exit (OpenRA ExitInfo.Priority); absent when all are 1.
    #[serde(default)]
    exit_priorities: Vec<i32>,
    /// Production types of each exit (OpenRA ExitInfo.ProductionTypes); absent when no exit has any.
    #[serde(default)]
    exit_types: Vec<Vec<String>>,
    gives_area: Vec<String>,
    requires_area: Option<Vec<String>>,
    base_provider_range: i32,
    adjacent: i32,
    storage: i32,
    sell_refund: i32,
    provides: BTreeMap<String, Vec<String>>,
    refinery: Option<RawRefinery>,
    repairs: Option<RepairInfo>,
    repairable: Option<RepairableInfo>,
    power_down: bool,
    #[serde(default)]
    fake_tag: bool,
    #[serde(default)]
    make_ticks: i32,
    #[serde(default)]
    make_gates: Vec<String>,
    center_offset: Vec<i32>,
    #[serde(default)]
    lightning_rod: i32,
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

/// The repair button (OpenRA RepairableBuilding, repair.rs): a step of at
/// most `step` hit points every `interval` ticks, costing `percent` percent of
/// the building's value for a full repair; `bonuses` speed up each step when
/// several allied players repair together (one entry per repairer count, so
/// at most `bonuses.len() - 1` players repair at once).
#[derive(Deserialize, Clone, Debug)]
pub struct RepairableInfo {
    pub percent: i32,
    pub interval: i32,
    pub step: i32,
    pub bonuses: Vec<i32>,
    /// PlayerExperience an allied repairer gains when the repair completes (gamerules.rs).
    pub player_experience: i32,
}

#[derive(Deserialize, Clone)]
pub struct UnitInfo {
    pub speed: i32,
    pub turn_speed: i32,
    pub turn_in_place: bool,
    pub locomotor: usize,
    pub radius: i32,
    pub passenger: Option<String>,
    /// OpenRA Passenger.Weight (counts against the transport's MaxWeight).
    pub passenger_weight: i32,
    /// Repairable / RepairableNear RepairActors (actor ids).
    pub repair_at: Vec<String>,
    /// RepairableNear (ships): repaired within range of the repairer, not on a pad.
    pub repair_near: bool,
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
    /// AttackAircraft FacingTolerance: may fire while this far off the target's bearing.
    pub facing_tolerance: i32,
    /// AttackAircraft AbortOnResupply: true ends the attack and the orders
    /// queued after it, and the aircraft stays at its base once rearmed;
    /// false (WebRA's default, OpenRA's is true) takes the attack up again.
    #[serde(default = "abort_on_resupply_default")]
    pub abort_on_resupply: bool,
    /// Ammo pips shown under a selected aircraft.
    pub ammo_pips: i32,
    /// Forward offsets (world units) of the rotors drawn while airborne.
    pub rotors: Vec<i32>,
    /// ParaDrop.DropRange: paratroopers jump within this distance of the target (0: no ParaDrop).
    #[serde(default)]
    pub drop_range: i32,
    /// FallsToEarth.Velocity of the husk an airborne plane leaves (0: no crash).
    #[serde(default)]
    pub crash_velocity: i32,
    /// FallsToEarth.Explosion: weapon index fired where the husk hits the ground.
    #[serde(default)]
    pub crash_weapon: Option<usize>,
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
    #[serde(default)]
    range_limit: i32,
    arc: bool,
    valid: u32,
    invalid: u32,
    warheads: Vec<RawWarhead>,
    effects: Vec<crate::rules_options::RawWarheadEffect>,
    #[serde(default)]
    clusters: Vec<Cluster>,
}

/// OpenRA `FireClusterWarhead`: on impact, `weapon` is fired at the impact
/// cell plus each of `cells`, and at `random_count` cells picked from
/// `random_cells` (cell offsets).
#[derive(Deserialize, Clone, Debug)]
pub struct Cluster {
    pub weapon: usize,
    pub cells: Vec<Vec<i32>>,
    pub random_cells: Vec<Vec<i32>>,
    pub random_count: i32,
}

#[derive(Deserialize)]
struct RawWarhead {
    kind: String,
    relationships: u32,
    damage: i32,
    spread: i32,
    falloff: Vec<i32>,
    versus: Vec<i32>,
    delay: i32,
    valid: u32,
    invalid: u32,
    damage_types: Vec<String>,
}

#[derive(Deserialize)]
struct RawLocomotor {
    name: String,
    domain: String,
    speeds: Vec<i32>,
    crushes: Vec<String>,
    #[serde(default)]
    shares_cell: bool,
    #[serde(default = "default_wait_average")]
    wait_average: i32,
}

/// WebRA's AbortOnResupply default: aircraft out of ammo come back for
/// their target once rearmed (OpenRA's AttackFollowInfo default is true).
fn abort_on_resupply_default() -> bool {
    false
}

/// OpenRA LocomotorInfo.WaitAverage default.
fn default_wait_average() -> i32 {
    40
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
pub const TARGET_MINE: u32 = 32;
pub const TARGET_UNDERWATER: u32 = 64;
/// Submarines, surfaced or submerged (depth charge warheads).
pub const TARGET_SUBMARINE: u32 = 128;
/// Bare land (OpenRA target type `Ground`): force-fire on the ground. No actor
/// carries it; a water cell is a `TARGET_WATER` ground target.
pub const TARGET_GROUND: u32 = 256;
/// Husks (OpenRA target type `Husk`, plus GroundActor; see `class_accepts`).
pub const TARGET_HUSK: u32 = 512;
/// Trees and the like (OpenRA ^Tree target type `Trees`): only warheads that
/// list it hit them (fire, V2, nukes, barrels; neutral.rs).
pub const TARGET_TREES: u32 = 1024;
/// Damaged infantry (OpenRA Targetable@HEAL): the Medic's Heal weapon.
pub const TARGET_HEAL: u32 = 2048;
/// Damaged vehicles, ships and landed aircraft (Targetable@REPAIR): the Mechanic's Repair weapon.
pub const TARGET_REPAIR: u32 = 4096;

/// OpenRA PlayerRelationship bits (gen_rules.py RELATIONSHIPS).
pub const RELATION_ALLY: u32 = 1;
pub const RELATION_NEUTRAL: u32 = 2;
pub const RELATION_ENEMY: u32 = 4;

/// OpenRA `UnitStance` of an actor with `AutoTarget`, from least to most
/// aggressive (the order matters: `stance >= Stance::Defend` and so on).
/// - HoldFire: never picks targets itself and does not shoot back.
/// - ReturnFire: shoots back at attackers it can hit from where it stands.
/// - Defend: also attacks enemies that come into range, without moving.
/// - AttackAnything: attacks and chases enemies that come into range.
#[derive(Deserialize, serde::Serialize, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
#[serde(rename_all = "snake_case")]
pub enum Stance {
    HoldFire = 0,
    ReturnFire = 1,
    Defend = 2,
    AttackAnything = 3,
}

impl Stance {
    pub const ALL: [Stance; 4] = [Stance::HoldFire, Stance::ReturnFire, Stance::Defend, Stance::AttackAnything];

    pub fn name(self) -> &'static str {
        match self {
            Stance::HoldFire => "hold_fire",
            Stance::ReturnFire => "return_fire",
            Stance::Defend => "defend",
            Stance::AttackAnything => "attack_anything",
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    Building,
    Infantry,
    Vehicle,
    Ship,
    Aircraft,
    /// Mines laid by a Minelayer: immobile, cloaked, not units.
    Mine,
    /// A vehicle's wreck (husks.rs): blocks its cell and burns down; only
    /// force-fire targets it. Not a unit.
    Husk,
    /// A crate (crates.rs): picked up by driving over it. Not a unit, never a target.
    Crate,
    /// Player-level proxies (OpenRA InfiltrateForSupportPower.Proxy): never on
    /// the map, kept per player (`Player::proxies`, infantry.rs).
    Proxy,
}

impl Kind {
    pub fn target_class(self) -> u32 {
        match self {
            Kind::Building => TARGET_STRUCTURE,
            Kind::Infantry => TARGET_INFANTRY,
            Kind::Vehicle => TARGET_VEHICLE,
            Kind::Ship => TARGET_WATER,
            Kind::Aircraft => TARGET_AIR,
            Kind::Mine => TARGET_MINE,
            Kind::Husk => TARGET_HUSK,
            Kind::Crate => 0,
            Kind::Proxy => 0,
        }
    }
}

/// Whether a valid/invalid target mask pair accepts target classes `c`.
/// Mines carry the OpenRA target types `GroundActor, Mine`; the generator
/// folds GroundActor into infantry|vehicle|structure, so a mask with all three
/// accepts mines.
pub(crate) fn class_accepts(valid: u32, invalid: u32, c: u32) -> bool {
    // Husks are `GroundActor, Husk` in OpenRA (no Vehicle): the same rule.
    if c & TARGET_HUSK != 0 {
        let ground = TARGET_INFANTRY | TARGET_VEHICLE | TARGET_STRUCTURE;
        return (valid & TARGET_HUSK != 0 || valid & ground == ground) && invalid & TARGET_HUSK == 0;
    }
    if c & TARGET_MINE != 0 {
        let ground = TARGET_INFANTRY | TARGET_VEHICLE | TARGET_STRUCTURE;
        return (valid & TARGET_MINE != 0 || valid & ground == ground) && invalid & TARGET_MINE == 0;
    }
    valid & c != 0 && invalid & c == 0
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

    /// The queue's OpenRA ProductionQueue Type (also the production type a
    /// unit without Buildable.BuildAtProductionType is built as).
    pub fn name(self) -> &'static str {
        match self {
            QueueType::Building => "Building",
            QueueType::Defense => "Defense",
            QueueType::Infantry => "Infantry",
            QueueType::Vehicle => "Vehicle",
            QueueType::Aircraft => "Aircraft",
            QueueType::Ship => "Ship",
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
    /// The cell belongs to the structure (hits, visibility) without claiming
    /// it: bridges and their huts, which lie over cells units cross (OpenRA
    /// footprint `_` of a Bridge or LegacyBridgeHut). Footprint letter `-`.
    Overlay,
}

#[derive(Clone, Debug)]
pub struct Prereq {
    pub token: u16,
    /// `~`: hide the item while this prerequisite is unmet.
    pub hidden: bool,
    /// `!`: the prerequisite must be absent.
    pub negate: bool,
}

#[derive(Clone)]
pub struct BuildingInfo {
    pub width: i32,
    pub height: i32,
    pub footprint: Vec<(i32, i32, FootCell)>,
    /// Cells that can be hit: the solid cells, or the whole pad for
    /// buildings without solid cells (the service depot).
    pub hit_cells: Vec<(i32, i32)>,
    /// Footprint cells units may cross but not stop on (OpenRA footprint
    /// `+`, OccupiedPassableTransitOnly: the service depot's pad), as
    /// offsets from the top-left cell (movement/cellmove.rs).
    pub transit_cells: Vec<(i32, i32)>,
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
    /// OpenRA ExitInfo.Priority of each exit (same order as `exits`): units
    /// leave by an exit of the highest priority they can use (production.rs).
    pub exit_priority: Vec<i32>,
    /// OpenRA ExitInfo.ProductionTypes of each exit (same order as
    /// `exits`): an exit with types only lets out units built as one of
    /// them (`ActorInfo::build_at`); empty lets out all.
    pub exit_types: Vec<Vec<String>>,
    /// OpenRA GivesBuildableArea.AreaTypes, as bits of `Rules::area_types`
    /// (0: gives no buildable area).
    pub gives_area: u32,
    /// OpenRA RequiresBuildableArea.AreaTypes as bits of `Rules::area_types`;
    /// None without the trait (placed anywhere its terrain allows, with no
    /// base provider needed either: Building.IsCloseEnoughToBase).
    pub requires_area: Option<u32>,
    pub base_provider_range: i32,
    /// RequiresBuildableArea.Adjacent: how many cells from a structure that
    /// gives a matching area type a footprint cell may be.
    pub adjacent: i32,
    pub storage: i32,
    pub sell_refund: i32,
    /// Prerequisite tokens provided, per faction index.
    pub provides: Vec<Vec<u16>>,
    pub refinery: Option<RefineryInfo>,
    pub repairs: Option<RepairInfo>,
    /// The repair button works on it (repair.rs).
    pub repairable: Option<RepairableInfo>,
    /// The power down button works on it (repair.rs).
    pub power_down: bool,
    /// A fake (OpenRA WithDecoration@fake): its owner and allies see the FAKE
    /// tag over it (infantry_render.rs).
    pub fake_tag: bool,
    /// Ticks a structure placed during the game plays its make animation
    /// (OpenRA WithMakeAnimation: the frames of its `make` sequence, one per
    /// tick; tools/gen_rules.py MAKE_FRAMES), 0 for none. Meanwhile it is
    /// `build-incomplete` (world.rs `build_incomplete`) and `make_gates`
    /// are off.
    pub make_ticks: u32,
    pub make_gates: MakeGates,
    pub center_offset: (i32, i32),
    /// WebRA's Lightning Rod (data/webra/rules.yaml `LightningRod`, lightning.rs):
    /// lightning that would land within this range (world units) is grounded on it; 0 for none.
    pub lightning_rod: i32,
}

/// What a structure's `build-incomplete` condition switches off (OpenRA's
/// RequiresCondition / PauseOnCondition `!build-incomplete`; rules
/// `building.make_gates`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct MakeGates {
    /// Sellable: no selling.
    pub sell: bool,
    /// Capturable: engineers cannot take it.
    pub capture: bool,
    /// AttackTurreted, AttackTesla, AttackGarrisoned (paused) and Turreted:
    /// it neither turns its turret nor fires.
    pub attack: bool,
    /// Transforms: the Construction Yard does not pack up.
    pub transform: bool,
}

impl BuildingInfo {
    /// Footprint cells the structure claims (not `_` or `-`), as offsets
    /// from its top-left cell. Placement, spawning and map validation all use
    /// these, so a structure only ever covers cells that were checked.
    pub fn cells(&self) -> impl Iterator<Item = (i32, i32)> + '_ {
        self.footprint.iter().filter(|c| matches!(c.2, FootCell::Occupied | FootCell::Passable)).map(|c| (c.0, c.1))
    }

    /// Every footprint cell that belongs to the structure (not `_`),
    /// including `Overlay` cells: what it is seen and hit by.
    pub fn area_cells(&self) -> impl Iterator<Item = (i32, i32)> + '_ {
        self.footprint.iter().filter(|c| c.2 != FootCell::Empty).map(|c| (c.0, c.1))
    }

    /// OpenRA's CenterPosition of the structure with its top-left at (cx, cy):
    /// the footprint's centre plus LocalCenterOffset (Building.CenterOffset).
    /// Actor positions (`Actor::x`, `y`) are the footprint's centre only.
    pub fn openra_center(&self, cx: i32, cy: i32) -> (i32, i32) {
        (cx * CELLS + self.width * CELLS / 2 + self.center_offset.0, cy * CELLS + self.height * CELLS / 2 + self.center_offset.1)
    }

    /// Whether the structure fits inside `map` with its top-left at (cx, cy).
    pub fn fits(&self, map: &crate::map::Map, cx: i32, cy: i32) -> bool {
        self.area_cells().all(|(dx, dy)| map.contains(cx + dx, cy + dy))
    }
}

#[derive(Clone)]
pub struct RefineryInfo {
    pub dock_offset: (i32, i32),
    pub free_actor: usize,
    pub free_actor_offset: (i32, i32),
}

#[derive(Clone)]
pub struct ActorInfo {
    pub id: String,
    pub name: String,
    pub description: String,
    pub kind: Kind,
    pub queue: QueueType,
    pub cost: i32,
    /// OpenRA CustomSellValue: what selling, repairing and kill bounties count
    /// instead of the cost (see `sell_value`).
    pub custom_sell_value: Option<i32>,
    pub build_ticks: i32,
    pub palette_order: i32,
    /// OpenRA Buildable.BuildLimit: at most this many owned and queued (0: no limit).
    pub build_limit: i32,
    pub prerequisites: Vec<Prereq>,
    pub build_at: String,
    pub hp: i32,
    pub armor: usize,
    pub sight: i32,
    pub weapons: Vec<usize>,
    pub turret_turn_speed: Option<i32>,
    pub reload_override: Option<i32>,
    pub requires_power: bool,
    /// Targetable as `Defense` (OpenRA ^Defense: turrets, pillboxes, Tesla
    /// and AA): the one kind of structure auto-targeted below AttackAnything.
    pub defense: bool,
    /// Fires at targets of opportunity while moving (OpenRA AttackTurreted
    /// with OpportunityFire, the default): turreted units.
    pub opportunity_fire: bool,
    /// OpenRA BaseBuilding (Construction Yard, MCV): the base hotkey cycles through them.
    pub base_building: bool,
    /// OpenRA Selectable: what the selection hotkeys and double click pick
    /// (selection.rs). None for actors that cannot be selected (walls, mines).
    pub selection: Option<SelectionInfo>,
    pub death_weapon: Option<usize>,
    pub self_heal: Option<SelfHeal>,
    /// (forward, lateral) offset of each turret from the actor's centre (OpenRA Turreted.Offset).
    pub turret_offsets: Vec<(i32, i32)>,
    /// AutoTarget initial stances (for humans, for the AI). None: the actor
    /// never picks targets on its own and has no stance (Demolition Truck).
    pub stance: Option<(Stance, Stance)>,
    pub abilities: Abilities,
    /// Veterancy (veterancy.rs): GainsExperience and GivesExperience.
    pub experience: Option<ExperienceInfo>,
    pub gives_experience: Option<GivesExperienceInfo>,
    /// Prone infantry (veterancy.rs): TakeCover.
    pub take_cover: Option<TakeCoverInfo>,
    /// ProducibleWithLevel (infantry.rs).
    pub producible_level: Option<ProducibleLevel>,
    /// WithProductionIconOverlay (World::production_overlays).
    pub production_overlays: Vec<ProductionOverlay>,
    /// Armament.FireDelay per weapon slot (ticks from firing to the shot).
    pub fire_delays: Vec<i32>,
    /// Armament.TargetRelationships Ally: the weapons heal or repair friends (Medic, Mechanic).
    pub targets_allies: bool,
    /// WithDeathAnimation of infantry (infantry.rs).
    pub death: Option<DeathInfo>,
    /// Infiltrates types that can enter it (Targetable SpyInfiltrate, ThiefInfiltrate, Husk).
    pub infiltrate_types: Vec<String>,
    /// Targetable as Disguise: spies can take its looks.
    pub disguisable: bool,
    /// OpenRA Tooltip (tooltip.rs); None: no battlefield tooltip.
    pub tooltip: Option<TooltipInfo>,
    /// Range circles (range_circles.rs).
    pub range_circles: Vec<RangeCircleInfo>,
    pub building: Option<BuildingInfo>,
    pub unit: Option<UnitInfo>,
    /// Index of the actor this one deploys or undeploys into (MCV, FACT).
    pub transforms_into: Option<usize>,
    /// The neutral world's traits (neutral.rs).
    pub world: crate::neutral::WorldTraits,
    /// Lobby options and leftovers (rules_options.rs).
    pub options: crate::rules_options::ActorOptions,
}

impl ActorInfo {
    /// Longest range among all weapons (OpenRA AttackBase.GetMaximumRange):
    /// how far auto-target scans look. Anti-air weapons count too, so an
    /// AA gun or SAM site (air-only weapons) and a rocket soldier's Redeye
    /// (longer than its Dragon) spot aircraft at their full reach.
    pub fn max_range(&self, rules: &Rules) -> i32 {
        self.weapons.iter().map(|&w| rules.weapons[w].range).max().unwrap_or(0)
    }

    /// Longest range among the weapons that can hit target classes `class`
    /// (OpenRA AttackBase.GetMaximumRangeVersusTarget); 0 when none can.
    pub fn range_against(&self, rules: &Rules, class: u32) -> i32 {
        self.weapons.iter().map(|&w| &rules.weapons[w]).filter(|w| w.can_target_class(class)).map(|w| w.range).max().unwrap_or(0)
    }

    /// Whether a weapon that can hit target classes `class` reaches a target
    /// at squared distance `d_sq`: within its range and outside its minimum
    /// range (OpenRA AutoTarget's armament filter for scans that may not move).
    pub fn reaches_class(&self, rules: &Rules, class: u32, d_sq: i64) -> bool {
        self.weapons.iter().map(|&w| &rules.weapons[w]).any(|w| {
            let (r, m) = (w.range as i64, w.min_range as i64);
            w.can_target_class(class) && d_sq <= r * r && d_sq >= m * m
        })
    }

    /// Whether any weapon can attack an actor of `kind`.
    pub fn can_attack(&self, rules: &Rules, kind: Kind) -> bool {
        self.weapons.iter().any(|&w| rules.weapons[w].can_target(kind))
    }

    /// Whether any weapon can attack an actor with target classes `class` (see `World::target_class`).
    pub fn can_attack_class(&self, rules: &Rules, class: u32) -> bool {
        self.weapons.iter().any(|&w| rules.weapons[w].can_target_class(class))
    }

    pub fn is_wall(&self) -> bool {
        self.abilities.line_build.is_some()
    }

    /// OpenRA CustomSellValueExts.GetSellValue: CustomSellValue, else the
    /// Valued cost. The base of the sell refund (production.rs), the repair
    /// cost (repair.rs), kill bounties (gamerules.rs) and the sell crew (sell.rs).
    pub fn sell_value(&self) -> i32 {
        self.custom_sell_value.unwrap_or(self.cost)
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Projectile {
    Bullet,
    Missile,
    Instant,
    Tesla,
    /// GravityBomb: dropped from an aircraft, falls straight down at `speed` per tick.
    Bomb,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum WarheadKind {
    Spread,
    Target,
    Percent,
}

#[derive(Clone)]
pub struct Warhead {
    pub kind: WarheadKind,
    pub damage: i32,
    pub spread: i32,
    pub falloff: Vec<i32>,
    pub versus: Vec<i32>,
    pub delay: i32,
    pub valid: u32,
    pub invalid: u32,
    /// DamageTypes that TakeCover and death animations react to, as bits of `Rules::damage_types`.
    pub damage_types: u32,
    /// ValidRelationships as RELATION_* bits, seen from the shooter.
    pub relationships: u32,
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
        self.affects_class(kind.target_class())
    }

    /// Whether this warhead damages an actor with target classes `c` (any valid bit, no invalid bit).
    pub fn affects_class(&self, c: u32) -> bool {
        class_accepts(self.valid, self.invalid, c)
    }
}

#[derive(Clone)]
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
    /// Missiles: how far one flies before it runs out of fuel and explodes
    /// (OpenRA Missile RangeLimit, else the weapon's Range); 0: no limit.
    pub range_limit: i32,
    pub arc: bool,
    pub valid: u32,
    pub invalid: u32,
    pub warheads: Vec<Warhead>,
    /// FireCluster warheads (BarrelExplode's burning barrels around it).
    pub clusters: Vec<Cluster>,
    /// Warheads that change no health (smudges.rs), in YAML order.
    pub effects: Vec<crate::rules_options::WarheadEffect>,
}

impl WeaponInfo {
    pub fn burst_delay(&self, shot: i32) -> i32 {
        let i = (shot.max(0) as usize).min(self.burst_delays.len() - 1);
        self.burst_delays[i]
    }

    pub fn can_target(&self, kind: Kind) -> bool {
        self.can_target_class(kind.target_class())
    }

    /// Whether this weapon may fire at an actor with target classes `c`.
    pub fn can_target_class(&self, c: u32) -> bool {
        class_accepts(self.valid, self.invalid, c)
    }

    /// Strongest single-hit damage, used to size impact effects.
    pub fn max_damage(&self) -> i32 {
        self.warheads.iter().map(|w| w.damage).max().unwrap_or(0)
    }
}

#[derive(Clone)]
pub struct Locomotor {
    pub name: String,
    pub domain: Domain,
    /// Speed percent per terrain class (Clear, Rough, Ore).
    pub speeds: Vec<i32>,
    /// OpenRA `Crushes: infantry`: drives over enemy soldiers.
    pub crushes_infantry: bool,
    /// Every crush class of OpenRA `Crushes` (walls: `wall`, `heavywall`).
    pub crushes: Vec<String>,
    /// OpenRA `SharesCell`: up to five units (infantry) share a cell, one
    /// per sub-cell (movement/occupancy.rs).
    pub shares_cell: bool,
    /// OpenRA `WaitAverage`: ticks a move blocked by another unit waits for
    /// it to leave before it looks for another way (movement/cellmove.rs).
    pub wait_average: i32,
}

#[derive(Clone)]
pub struct Rules {
    pub factions: Vec<String>,
    pub player: PlayerRules,
    pub actors: Vec<ActorInfo>,
    pub weapons: Vec<WeaponInfo>,
    pub locomotors: Vec<Locomotor>,
    /// Per locomotor: `Crushes: mine` (sets off mines it drives over).
    pub locomotor_crushes_mines: Vec<bool>,
    /// Per locomotor: `Crushes: crate` (picks up crates, crates.rs).
    pub locomotor_crushes_crates: Vec<bool>,
    /// World actor rules of the lobby options (rules_options.rs).
    pub world: crate::rules_options::WorldRules,
    /// The skirmish AI's bot types and their module configs (ai_bots.rs).
    pub bots: Vec<crate::ai_bots::BotInfo>,
    pub tokens: Vec<String>,
    /// Damage type names that some actor's TakeCover or death animation refers
    /// to; bit `k` of a warhead's, TakeCover's or DeathInfo's damage type mask
    /// is `damage_types[k]`.
    pub damage_types: Vec<String>,
    /// Buildable area type names (GivesBuildableArea, RequiresBuildableArea);
    /// bit `k` of a structure's area masks is `area_types[k]`.
    pub area_types: Vec<String>,
    /// `obtainable[faction][actor]`: reachable through the tech tree at all
    /// (unrestricted tech level), starting from a Construction Yard.
    pub obtainable: Vec<Vec<bool>>,
    /// Presentation facts (fx.rs, engine/render.json): explosions, muzzle
    /// flashes, damage smoke, working animations. Never read by the simulation.
    pub render: crate::fx::RenderData,
}

thread_local! {
    /// The rules `Rules::load_with` loaded last and the overrides (JSON text) they were loaded with.
    static LAST_LOADED: std::cell::RefCell<Option<(String, Rules)>> = const { std::cell::RefCell::new(None) };
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
    ///
    /// The last rules loaded are kept with their overrides and handed out
    /// again (a copy) for the same overrides: the map editor's preview and
    /// checks, map validation and every game on a map load the same rules
    /// over and over, and reading rules.json is most of that work.
    pub fn load_with(overrides: Option<&serde_json::Value>) -> Result<Rules, String> {
        // Never empty for overrides (JSON text), so it cannot match "no overrides".
        let key = overrides.map(|o| o.to_string()).unwrap_or_default();
        let cached = LAST_LOADED.with(|last| last.borrow().as_ref().filter(|(k, _)| *k == key).map(|(_, r)| r.clone()));
        if let Some(rules) = cached {
            return Ok(rules);
        }
        let mut base: serde_json::Value = serde_json::from_str(RULES_JSON).expect("rules.json is valid JSON");
        if let Some(o) = overrides {
            apply_overrides(&mut base, o)?;
        }
        let raw: RawRules = serde_json::from_value(base).map_err(|e| format!("rules overrides produce invalid rules: {e}"))?;
        let rules = Rules::from_raw(raw)?;
        // Custom maps come from strangers: every value must be safe to simulate.
        rules.validate()?;
        LAST_LOADED.with(|last| *last.borrow_mut() = Some((key, rules.clone())));
        Ok(rules)
    }

    /// Load the built-in rules with the changes of a mission (mission/data.rs,
    /// made by tools/gen_missions.py): `actors`, `weapons` and `locomotors`
    /// are lists whose entries either name a built-in entry (by id or name)
    /// and set some of its fields, or are complete new entries appended in
    /// order (weapon and locomotor indices count on that order);
    /// `armor_types` lists armor types appended to the built-in ones. The
    /// result is validated like any modded map.
    pub fn load_mission(changes: &serde_json::Value) -> Result<Rules, String> {
        let mut base: serde_json::Value = serde_json::from_str(RULES_JSON).expect("rules.json is valid JSON");
        if !changes.is_null() {
            apply_mission_changes(&mut base, changes)?;
        }
        let raw: RawRules = serde_json::from_value(base).map_err(|e| format!("mission rules are invalid: {e}"))?;
        let rules = Rules::from_raw(raw)?;
        rules.validate()?;
        Ok(rules)
    }

    /// Semantic checks that keep the simulation panic-free and bounded, whatever
    /// a modded map sets: value ranges, table lengths and cross references.
    /// Every field an override can reach is covered: indices into the weapon
    /// and actor tables must resolve (to the right kind of actor where the
    /// simulation spawns it), arrays with a fixed shape must have it, and
    /// ranges, counts and timers stay within bounds that keep loops and
    /// allocations small (vision circles, blast scans, squads, pips).
    pub fn validate(&self) -> Result<(), String> {
        within("player.beacon_duration", self.player.beacon_duration, 1, TIMER)?;
        let armors = self.weapons.iter().flat_map(|w| w.warheads.iter()).map(|h| h.versus.len()).min().unwrap_or(5);
        let max_armor = self.actors.iter().map(|a| a.armor).max().unwrap_or(0);
        if max_armor >= armors {
            return Err(format!("armor index {max_armor} has no versus entry"));
        }
        for a in &self.actors {
            self.validate_actor(a)?;
        }
        self.validate_options()?;
        for w in &self.weapons {
            let n = |f: &str| format!("weapons.{}.{f}", w.name);
            within(&n("range"), w.range, 0, 64 * CELLS)?;
            within(&n("min_range"), w.min_range, 0, 64 * CELLS)?;
            within(&n("reload"), w.reload, 1, TIMER)?;
            within(&n("burst"), w.burst, 1, 100)?;
            within(&n("speed"), w.speed, 0, 64 * CELLS)?;
            within(&n("inaccuracy"), w.inaccuracy, 0, 64 * CELLS)?;
            within(&n("range_limit"), w.range_limit, 0, 64 * CELLS)?;
            if w.burst_delays.is_empty() || w.burst_delays.len() > 100 || w.burst_delays.iter().any(|&d| !(0..=TIMER).contains(&d)) {
                return Err(n("burst_delays must be 1 to 100 values between 0 and 100000"));
            }
            count(&n("warheads"), w.warheads.len(), 16)?;
            for h in &w.warheads {
                within(&n("warheads.damage"), h.damage, -10_000_000, 100_000_000)?;
                within(&n("warheads.spread"), h.spread, 0, 32 * CELLS)?;
                within(&n("warheads.delay"), h.delay, 0, 10_000)?;
                within(&n("warheads.relationships"), h.relationships as i32, 0, 7)?;
                if h.falloff.is_empty() || h.falloff.len() > 64 || h.falloff.iter().any(|&f| !(0..=10_000).contains(&f)) {
                    return Err(n("warheads.falloff must be 1 to 64 values between 0 and 10000"));
                }
                if h.versus.len() < armors || h.versus.len() > 64 || h.versus.iter().any(|&v| !(0..=10_000).contains(&v)) {
                    return Err(n("warheads.versus needs a value between 0 and 10000 per armor type"));
                }
                // Impacts scan every cell within this radius.
                within(&n("warheads: spread times falloff steps"), h.damage_radius(), 0, 64 * CELLS)?;
            }
            count(&n("clusters"), w.clusters.len(), 4)?;
            for c in &w.clusters {
                self.weapon_ref(&n("clusters.weapon"), c.weapon)?;
                count(&n("clusters.cells"), c.cells.len() + c.random_cells.len(), 64)?;
                within(&n("clusters.random_count"), c.random_count, 0, 64)?;
                if c.cells.iter().chain(&c.random_cells).any(|o| o.len() != 2 || o.iter().any(|v| !(-8..=8).contains(v))) {
                    return Err(n("clusters: cells must be [x, y] within 8 cells"));
                }
            }
        }
        for l in &self.locomotors {
            if l.speeds.len() != crate::map::SPEED_CLASSES || l.speeds.iter().any(|&v| !(0..=1000).contains(&v)) {
                return Err(format!("locomotors.{}: speeds must be {} values between 0 and 1000", l.name, crate::map::SPEED_CLASSES));
            }
            count(&format!("locomotors.{}.crushes", l.name), l.crushes.len(), 16)?;
        }
        Ok(())
    }

    fn validate_actor(&self, a: &ActorInfo) -> Result<(), String> {
        let n = |f: &str| format!("actors.{}.{f}", a.id);
        within(&n("cost"), a.cost, 0, 1_000_000)?;
        if let Some(v) = a.custom_sell_value {
            within(&n("custom_sell_value"), v, 0, 1_000_000)?;
        }
        within(&n("build_ticks"), a.build_ticks, 0, TIMER)?;
        within(&n("build_limit"), a.build_limit, 0, 1000)?;
        // Crates and proxies have no health (OpenRA ^Crate has no Health trait; proxies no body).
        within(&n("hp"), a.hp, if matches!(a.kind, Kind::Crate | Kind::Proxy) { 0 } else { 1 }, 100_000_000)?;
        within(&n("sight"), a.sight, 0, MAX_VISION)?;
        count(&n("prerequisites"), a.prerequisites.len(), 32)?;
        if let Some(t) = a.turret_turn_speed {
            within(&n("turret_turn_speed"), t, 1, 1024)?;
        }
        if let Some(r) = a.reload_override {
            within(&n("reload_override"), r, 1, TIMER)?;
        }
        if let Some(h) = &a.self_heal {
            within(&n("self_heal.step"), h.step, 0, 100_000_000)?;
            within(&n("self_heal.delay"), h.delay, 1, TIMER)?;
            within(&n("self_heal.start_if_below"), h.start_if_below, 0, 100)?;
            within(&n("self_heal.damage_cooldown"), h.damage_cooldown, 0, TIMER)?;
        }
        count(&n("weapons"), a.weapons.len(), crate::world::MAX_WEAPONS)?;
        for &w in &a.weapons {
            self.weapon_ref(&n("weapons"), w)?;
        }
        if let Some(w) = a.death_weapon {
            self.weapon_ref(&n("death_weapon"), w)?;
        }
        count(&n("turret_offsets"), a.turret_offsets.len(), 8)?;
        if let Some(t) = &a.tooltip {
            if t.generic_name.len() > 64 || t.generic_visibility & !(REL_ALLY | REL_NEUTRAL | REL_ENEMY) != 0 {
                return Err(n("tooltip: generic_name at most 64 bytes, generic_visibility bits 1, 2 and 4"));
            }
        }
        count(&n("range_circles"), a.range_circles.len(), 8)?;
        for c in &a.range_circles {
            within(&n("range_circles.range"), c.range, 0, 64 * CELLS)?;
            if c.group.len() > 32 || c.passengers.len() > 8 || !(0.0..=8.0).contains(&c.width) || !(0.0..=8.0).contains(&c.border_width) {
                return Err(n("range_circles: group at most 32 bytes, 8 passengers, widths 0 to 8"));
            }
        }
        if let Some(sel) = &a.selection {
            within(&n("selection.priority"), sel.priority, -1000, 1000)?;
            if sel.modifiers & !(SELECT_CTRL | SELECT_ALT) != 0 {
                return Err(n("selection.modifiers must be 0 to 3"));
            }
            if sel.class.is_empty() || sel.class.len() > 64 {
                return Err(n("selection.class must be 1 to 64 bytes"));
            }
            if !sel.bounds.is_empty() && sel.bounds.len() != 4 {
                return Err(n("selection.bounds must be empty or 4 values"));
            }
            for (i, &v) in sel.bounds.iter().enumerate() {
                within(&n("selection.bounds"), v, if i < 2 { 0 } else { -8 * CELLS }, 8 * CELLS)?;
            }
        }
        for &(f, l) in &a.turret_offsets {
            within(&n("turret_offsets"), f, -8 * CELLS, 8 * CELLS)?;
            within(&n("turret_offsets"), l, -8 * CELLS, 8 * CELLS)?;
        }
        if let Some(u) = &a.unit {
            self.validate_unit(a, u)?;
        }
        if let Some(b) = &a.building {
            self.validate_building(a, b)?;
        }
        self.validate_veterancy(a)?;
        a.world.validate(&n, self.weapons.len(), &self.actors)?;
        self.validate_abilities(a)
    }

    /// Veterancy and prone infantry (veterancy.rs).
    fn validate_veterancy(&self, a: &ActorInfo) -> Result<(), String> {
        let n = |f: &str| format!("actors.{}.{f}", a.id);
        let percents = |what: &str, list: &[i32], len: usize| -> Result<(), String> {
            if list.len() != len {
                return Err(n(&format!("experience.{what} needs one value per threshold")));
            }
            for &v in list {
                within(&n(&format!("experience.{what}")), v, 0, MAX_PERCENT)?;
            }
            Ok(())
        };
        let mut fastest = 100;
        if let Some(x) = &a.experience {
            let levels = x.thresholds.len();
            count(&n("experience.thresholds"), levels, MAX_LEVELS)?;
            for &t in &x.thresholds {
                within(&n("experience.thresholds"), t, 0, 100_000)?;
            }
            if x.thresholds.windows(2).any(|w| w[1] < w[0]) {
                return Err(n("experience.thresholds must not decrease"));
            }
            percents("firepower", &x.firepower, levels)?;
            percents("damage", &x.damage, levels)?;
            percents("speed", &x.speed, levels)?;
            percents("reload", &x.reload, levels)?;
            fastest = x.speed.iter().copied().fold(100, i32::max);
            if let Some(h) = &x.heal {
                within(&n("experience.heal.rank"), h.rank, 1, levels.max(1) as i32)?;
                within(&n("experience.heal.step"), h.step, 0, 100_000_000)?;
                within(&n("experience.heal.percentage_step"), h.percentage_step, 0, 100)?;
                within(&n("experience.heal.delay"), h.delay, 1, TIMER)?;
                within(&n("experience.heal.start_if_below"), h.start_if_below, 0, 100)?;
                within(&n("experience.heal.damage_cooldown"), h.damage_cooldown, 0, TIMER)?;
            }
        }
        if let Some(g) = &a.gives_experience {
            within(&n("gives_experience.experience"), g.experience, -1, 1_000_000)?;
            within(&n("gives_experience.actor_modifier"), g.actor_modifier, 0, 1_000_000)?;
        }
        if let Some(tc) = &a.take_cover {
            // Infantry only: the prone pose is drawn with the sprite slot a turret would use.
            if a.kind != Kind::Infantry {
                return Err(n("take_cover: only infantry can go prone"));
            }
            within(&n("take_cover.duration"), tc.duration, 1, TIMER)?;
            within(&n("take_cover.speed_modifier"), tc.speed_modifier, 0, MAX_PERCENT)?;
            for &(_, p) in &tc.modifiers {
                within(&n("take_cover.damage_modifiers"), p, 0, MAX_PERCENT)?;
            }
            fastest = fastest * tc.speed_modifier.max(100) / 100;
        }
        // Rank and prone speed bonuses stay within the movement bound of unit.speed.
        if let Some(u) = &a.unit {
            within(
                &n("unit.speed with rank and prone modifiers"),
                (u.speed as i64 * fastest as i64 / 100).min(i32::MAX as i64) as i32,
                0,
                2 * CELLS,
            )?;
        }
        Ok(())
    }

    fn validate_unit(&self, a: &ActorInfo, u: &UnitInfo) -> Result<(), String> {
        let n = |f: &str| format!("actors.{}.unit.{f}", a.id);
        within(&n("speed"), u.speed, 0, 2 * CELLS)?;
        within(&n("turn_speed"), u.turn_speed, 1, 1024)?;
        within(&n("radius"), u.radius, 1, 2 * CELLS)?;
        // 0: rides without taking room (OpenRA missions give Tanya Weight 0).
        within(&n("passenger_weight"), u.passenger_weight, 0, 100)?;
        if u.locomotor >= self.locomotors.len() {
            return Err(n("locomotor: unknown locomotor"));
        }
        count(&n("repair_at"), u.repair_at.len(), 32)?;
        if let Some(hv) = &u.harvester {
            within(&n("harvester.capacity"), hv.capacity, 1, 10_000)?;
            within(&n("harvester.bale_load_delay"), hv.bale_load_delay, 1, 10_000)?;
            within(&n("harvester.bale_unload_delay"), hv.bale_unload_delay, 0, 10_000)?;
            within(&n("harvester.search_from_proc"), hv.search_from_proc, 0, 256)?;
            within(&n("harvester.search_from_harv"), hv.search_from_harv, 0, 256)?;
        }
        if let Some(ac) = &u.aircraft {
            within(&n("aircraft.cruise_altitude"), ac.cruise_altitude, 0, 20 * CELLS)?;
            within(&n("aircraft.ammo"), ac.ammo, 0, 1000)?;
            within(&n("aircraft.reload_delay"), ac.reload_delay, 0, TIMER)?;
            within(&n("aircraft.reload_count"), ac.reload_count, 0, 1000)?;
            within(&n("aircraft.altitude_velocity"), ac.altitude_velocity, 0, 4 * CELLS)?;
            within(&n("aircraft.wait_distance"), ac.wait_distance, 0, 64 * CELLS)?;
            within(&n("aircraft.facing_tolerance"), ac.facing_tolerance, 0, 512)?;
            within(&n("aircraft.ammo_pips"), ac.ammo_pips, 0, 100)?;
            within(&n("aircraft.drop_range"), ac.drop_range, 0, 64 * CELLS)?;
            within(&n("aircraft.crash_velocity"), ac.crash_velocity, 0, 20 * CELLS)?;
            count(&n("aircraft.landable"), ac.landable.len(), 32)?;
            count(&n("aircraft.rearm_actors"), ac.rearm_actors.len(), 32)?;
            count(&n("aircraft.repair_actors"), ac.repair_actors.len(), 32)?;
            count(&n("aircraft.rotors"), ac.rotors.len(), 8)?;
            for &r in &ac.rotors {
                within(&n("aircraft.rotors"), r, -4 * CELLS, 4 * CELLS)?;
            }
            if let Some(w) = ac.crash_weapon {
                self.weapon_ref(&n("aircraft.crash_weapon"), w)?;
            }
        }
        Ok(())
    }

    fn validate_building(&self, a: &ActorInfo, b: &BuildingInfo) -> Result<(), String> {
        let n = |f: &str| format!("actors.{}.building.{f}", a.id);
        within(&n("width"), b.width, 1, 8)?;
        within(&n("height"), b.height, 1, 8)?;
        let inside = |x: i32, y: i32| (0..b.width).contains(&x) && (0..b.height).contains(&y);
        if b.footprint.len() != (b.width * b.height) as usize || b.footprint.iter().any(|&(x, y, _)| !inside(x, y)) {
            return Err(n("footprint does not match its size"));
        }
        if b.area_cells().next().is_none() {
            return Err(n("footprint needs at least one cell"));
        }
        // Overlay cells belong to bridges and their huts only.
        if b.footprint.iter().any(|c| c.2 == FootCell::Overlay) && a.world.bridge.is_none() && !a.world.bridge_hut {
            return Err(n("footprint: `-` cells are for bridges and bridge huts"));
        }
        within(&n("power"), b.power, -100_000, 100_000)?;
        within(&n("storage"), b.storage, 0, 10_000_000)?;
        within(&n("sell_refund"), b.sell_refund, 0, 100)?;
        within(&n("adjacent"), b.adjacent, 0, 16)?;
        within(&n("base_provider_range"), b.base_provider_range, 0, 128 * CELLS)?;
        count(&n("produces"), b.production_types.len(), 16)?;
        for p in &b.provides {
            count(&n("provides"), p.len(), 32)?;
        }
        // Exits and the free actor's spot sit on or next to the footprint.
        let near = |what: &str, (x, y): (i32, i32)| -> Result<(), String> {
            within(&n(what), x, -4, b.width + 3)?;
            within(&n(what), y, -4, b.height + 3)
        };
        count(&n("exits"), b.exits.len(), 16)?;
        for &e in &b.exits {
            near("exits", e)?;
        }
        count(&n("exit_priority"), b.exit_priority.len(), b.exits.len())?;
        count(&n("exit_types"), b.exit_types.len(), b.exits.len())?;
        for t in &b.exit_types {
            count(&n("exit_types"), t.len(), 8)?;
        }
        for &p in &b.exit_priority {
            within(&n("exit_priority"), p, -100, 100)?;
        }
        within(&n("center_offset"), b.center_offset.0, -4 * CELLS, 4 * CELLS)?;
        within(&n("center_offset"), b.center_offset.1, -4 * CELLS, 4 * CELLS)?;
        if let Some(r) = &b.repairs {
            within(&n("repairs.hp_per_step"), r.hp_per_step, 0, 100_000_000)?;
            within(&n("repairs.interval"), r.interval, 1, TIMER)?;
            within(&n("repairs.value_percent"), r.value_percent, 0, 1000)?;
        }
        if let Some(r) = &b.repairable {
            within(&n("repairable.percent"), r.percent, 0, MAX_PERCENT)?;
            within(&n("repairable.interval"), r.interval, 1, TIMER)?;
            within(&n("repairable.step"), r.step, 0, 100_000_000)?;
            if r.bonuses.is_empty() || r.bonuses.len() > MAX_REPAIR_BONUSES {
                return Err(n(&format!("repairable.bonuses needs 1 to {MAX_REPAIR_BONUSES} values")));
            }
            for &v in &r.bonuses {
                within(&n("repairable.bonuses"), v, 0, MAX_PERCENT)?;
            }
        }
        if let Some(r) = &b.refinery {
            within(&n("refinery.dock_offset"), r.dock_offset.0, -4 * CELLS, 4 * CELLS)?;
            within(&n("refinery.dock_offset"), r.dock_offset.1, -4 * CELLS, 4 * CELLS)?;
            near("refinery.free_actor_offset", r.free_actor_offset)?;
            self.actor_ref(&n("refinery.free_actor"), r.free_actor, &[Kind::Infantry, Kind::Vehicle])?;
        }
        Ok(())
    }

    fn validate_abilities(&self, a: &ActorInfo) -> Result<(), String> {
        let n = |f: &str| format!("actors.{}.abilities.{f}", a.id);
        let ab = &a.abilities;
        let units = [Kind::Infantry, Kind::Vehicle];
        if let Some(c) = &ab.cargo {
            within(&n("cargo.max"), c.max, 0, 100)?;
            within(&n("cargo.before_unload_delay"), c.before_unload_delay, 0, TIMER)?;
            within(&n("cargo.after_unload_delay"), c.after_unload_delay, 0, TIMER)?;
            count(&n("cargo.types"), c.types.len(), 16)?;
            count(&n("cargo.initial"), c.initial.len(), 16)?;
            for id in &c.initial {
                self.actor_id_ref(&n("cargo.initial"), id, &units)?;
            }
        }
        if let Some(e) = &ab.eject_on_death {
            self.actor_id_ref(&n("eject_on_death.pilot"), &e.pilot, &[Kind::Infantry])?;
            within(&n("eject_on_death.success_rate"), e.success_rate, 0, 100)?;
        }
        if let Some(m) = &ab.minelayer {
            self.actor_id_ref(&n("minelayer.mine"), &m.mine, &[Kind::Mine])?;
            within(&n("minelayer.ammo"), m.ammo, 0, 100)?;
            within(&n("minelayer.reload_delay"), m.reload_delay, 0, TIMER)?;
            count(&n("minelayer.terrain"), m.terrain.len(), 32)?;
            count(&n("minelayer.rearm_actors"), m.rearm_actors.len(), 32)?;
        }
        if let Some(r) = &ab.jams_missiles {
            within(&n("jams_missiles.range"), r.range, 0, 64 * CELLS)?;
        }
        if let Some(r) = &ab.jams_radar {
            within(&n("jams_radar.range"), r.range, 0, 64 * CELLS)?;
        }
        // Shroud and gap sight ranges size the cached vision circles.
        if let Some(r) = &ab.creates_shroud {
            within(&n("creates_shroud.range"), r.range, 0, MAX_VISION)?;
        }
        if let Some(r) = &ab.gap_sight {
            within(&n("gap_sight.range"), r.range, 0, MAX_VISION)?;
        }
        if let Some(c) = &ab.cloak {
            within(&n("cloak.initial_delay"), c.initial_delay, 0, TIMER)?;
            within(&n("cloak.cloak_delay"), c.cloak_delay, 0, TIMER)?;
            count(&n("cloak.uncloak_on"), c.uncloak_on.len(), 16)?;
            count(&n("cloak.types"), c.types.len(), 16)?;
        }
        if let Some(d) = &ab.detect_cloaked {
            within(&n("detect_cloaked.range"), d.range, 0, 64 * CELLS)?;
            count(&n("detect_cloaked.types"), d.types.len(), 16)?;
        }
        if let Some(pc) = &ab.portable_chrono {
            within(&n("portable_chrono.charge_delay"), pc.charge_delay, 0, TIMER)?;
            within(&n("portable_chrono.max_distance"), pc.max_distance, 0, 256)?;
        }
        if let Some(m) = &ab.mad_tank {
            within(&n("mad_tank.charge_delay"), m.charge_delay, 0, TIMER)?;
            within(&n("mad_tank.thump_interval"), m.thump_interval, 1, TIMER)?;
            within(&n("mad_tank.detonation_delay"), m.detonation_delay, 0, TIMER)?;
            self.actor_id_ref(&n("mad_tank.driver"), &m.driver, &units)?;
            self.weapon_ref(&n("mad_tank.thump_weapon"), m.thump_weapon)?;
            self.weapon_ref(&n("mad_tank.detonation_weapon"), m.detonation_weapon)?;
        }
        if let Some(d) = &ab.delivers_cash {
            within(&n("delivers_cash.payload"), d.payload, 0, 1_000_000)?;
        }
        if let Some(t) = &ab.transforms {
            let Some(into) = a.transforms_into else { return Err(n("transforms.into: unknown actor")) };
            self.actor_ref(&n("transforms.into"), into, &[Kind::Building, Kind::Infantry, Kind::Vehicle])?;
            if t.offset.len() != 2 {
                return Err(n("transforms.offset must be [x, y]"));
            }
            for &o in &t.offset {
                within(&n("transforms.offset"), o, -8, 8)?;
            }
            within(&n("transforms.facing"), t.facing, 0, 1023)?;
        }
        if let Some(l) = &ab.line_build {
            within(&n("line_build.range"), l.range, 0, 16)?;
        }
        if let Some(c) = &ab.crushable {
            count(&n("crushable"), c.len(), 16)?;
        }
        if let Some(list) = &ab.support_powers {
            count(&n("support_powers"), list.len(), 8)?;
            for p in list {
                self.validate_power(a, p)?;
            }
        }
        self.validate_infantry_abilities(a)
    }

    /// Infantry abilities and what they act on (infantry.rs).
    fn validate_infantry_abilities(&self, a: &ActorInfo) -> Result<(), String> {
        let n = |f: &str| format!("actors.{}.{f}", a.id);
        let ab = &a.abilities;
        if let Some(p) = &a.producible_level {
            count(&n("producible_level.prerequisites"), p.prerequisites.len(), 16)?;
            within(&n("producible_level.levels"), p.levels, 0, MAX_LEVELS as i32)?;
        }
        count(&n("production_overlays"), a.production_overlays.len(), 4)?;
        for o in &a.production_overlays {
            count(&n("production_overlays.types"), o.types.len(), 4)?;
            count(&n("production_overlays.prerequisites"), o.prerequisites.len(), 16)?;
        }
        if a.fire_delays.len() > crate::world::MAX_WEAPONS {
            return Err(n("fire_delays: more delays than weapon slots"));
        }
        for &d in &a.fire_delays {
            within(&n("fire_delays"), d, 0, 1000)?;
        }
        count(&n("infiltrate_types"), a.infiltrate_types.len(), 8)?;
        if let Some(list) = &ab.captures {
            count(&n("abilities.captures"), list.len(), 8)?;
            for c in list {
                within(&n("abilities.captures.delay"), c.delay, 0, TIMER)?;
                within(&n("abilities.captures.experience"), c.experience, 0, 1_000_000)?;
                within(&n("abilities.captures.option"), c.option, -1, 1)?;
                count(&n("abilities.captures.types"), c.types.len(), 8)?;
            }
        }
        if let Some(c) = &ab.capturable {
            count(&n("abilities.capturable.types"), c.types.len(), 8)?;
        }
        if let Some(i) = &ab.infiltrates {
            count(&n("abilities.infiltrates.types"), i.types.len(), 8)?;
        }
        if let Some(list) = &ab.infiltrated {
            count(&n("abilities.infiltrated"), list.len(), 8)?;
            for e in list {
                let m = |f: &str| n(&format!("abilities.infiltrated.{f}"));
                if !matches!(
                    e.kind.as_str(),
                    "cash" | "exploration" | "power_outage" | "support_power" | "power_reset" | "decoration" | "transform"
                ) {
                    return Err(m("kind: unknown effect"));
                }
                count(&m("types"), e.types.len(), 8)?;
                within(&m("experience"), e.experience, 0, 1_000_000)?;
                within(&m("percentage"), e.percentage, 0, 100)?;
                within(&m("minimum"), e.minimum, -1, 1_000_000)?;
                within(&m("maximum"), e.maximum, 0, i32::MAX)?;
                within(&m("experience_percentage"), e.experience_percentage, 0, 100)?;
                within(&m("duration"), e.duration, 0, TIMER)?;
                if e.kind == "support_power" {
                    self.actor_id_ref(&m("proxy"), &e.proxy, &[Kind::Proxy])?;
                }
                if e.kind == "transform" {
                    self.actor_id_ref(&m("into"), &e.into, &[Kind::Infantry, Kind::Vehicle, Kind::Ship, Kind::Aircraft])?;
                    within(&m("health"), e.health, 0, 100)?;
                }
            }
        }
        if let Some(d) = &ab.demolition {
            within(&n("abilities.demolition.delay"), d.delay, 0, TIMER)?;
            within(&n("abilities.demolition.flashes"), d.flashes, 0, 100)?;
            within(&n("abilities.demolition.flash_delay"), d.flash_delay, 0, TIMER)?;
            within(&n("abilities.demolition.flash_interval"), d.flash_interval, 1, TIMER)?;
        }
        if let Some(l) = &ab.attack_leap {
            within(&n("abilities.attack_leap.speed"), l.speed, 1, 4 * CELLS)?;
            within(&n("abilities.attack_leap.run_speed"), l.run_speed, 0, MAX_PERCENT)?;
            within(&n("abilities.attack_leap.eat_ticks"), l.eat_ticks, 0, TIMER)?;
            // Running is a speed bonus: it must stay within the movement bound.
            if let Some(u) = &a.unit {
                within(
                    &n("unit.speed while running"),
                    (u.speed as i64 * l.run_speed as i64 / 100).min(i32::MAX as i64) as i32,
                    0,
                    2 * CELLS,
                )?;
            }
        }
        if let Some(k) = &ab.announce_on_kill {
            within(&n("abilities.announce_on_kill.interval"), k.interval, 0, TIMER)?;
        }
        if let Some(p) = &ab.proxy {
            if a.kind != Kind::Proxy {
                return Err(n("abilities.proxy: only proxies provide prerequisites without a body"));
            }
            count(&n("abilities.proxy.provides"), p.provides.len(), 16)?;
        }
        if a.kind == Kind::Proxy && (a.unit.is_some() || a.building.is_some()) {
            return Err(n("kind: a proxy has no body"));
        }
        Ok(())
    }

    fn validate_power(&self, a: &ActorInfo, p: &SupportPowerInfo) -> Result<(), String> {
        let n = |f: &str| format!("actors.{}.abilities.support_powers.{}.{f}", a.id, truncate(&p.key));
        if !(1..=64).contains(&p.key.chars().count()) {
            return Err(format!("actors.{}.abilities.support_powers: keys must be 1 to 64 characters", a.id));
        }
        within(&n("charge"), p.charge, 0, 1_000_000)?;
        within(&n("duration"), p.duration, 0, TIMER)?;
        within(&n("range"), p.range, 0, 64 * CELLS)?;
        within(&n("max_distance"), p.max_distance, 0, 256)?;
        count(&n("prerequisites"), p.prerequisites.len(), 16)?;
        // DisplayTimerRelationships: who sees the countdown (powers.rs power_timers).
        count(&n("display_timer"), p.display_timer.len(), 3)?;
        if let Some(r) = p.display_timer.iter().find(|r| !matches!(r.as_str(), "ally" | "neutral" | "enemy")) {
            return Err(format!("{}: unknown relationship {}", n("display_timer"), truncate(r)));
        }
        // SpawnActorPower (Sonar Pulse): a detector for `duration` ticks.
        within(&n("detect_range"), p.detect_range, 0, 64 * CELLS)?;
        count(&n("detect_types"), p.detect_types.len(), 8)?;
        count(&n("terrain"), p.terrain.len(), 16)?;
        // Aircraft powers spawn a squad of planes that fly in from the map edge.
        let air = matches!(p.kind.as_str(), "AirstrikePower" | "ParatroopersPower");
        within(&n("squad_size"), p.squad_size, if air { 1 } else { 0 }, 16)?;
        if air {
            let plane = self
                .actor_index(&p.unit_type)
                .and_then(|t| self.actors[t].unit.as_ref())
                .and_then(|u| u.aircraft.as_ref())
                .is_some_and(|ac| !ac.can_hover);
            if !plane {
                return Err(n("unit_type must be a plane"));
            }
        }
        count(&n("squad_offset"), p.squad_offset.len(), 2)?;
        for &o in &p.squad_offset {
            within(&n("squad_offset"), o, -16 * CELLS, 16 * CELLS)?;
        }
        // OpenRA missions drop up to 20 (production-disruption's CHALK3).
        count(&n("drop_items"), p.drop_items.len(), 32)?;
        for id in &p.drop_items {
            self.actor_id_ref(&n("drop_items"), id, &[Kind::Infantry, Kind::Vehicle])?;
        }
        within(&n("camera_range"), p.camera_range, 0, 64 * CELLS)?;
        within(&n("camera_remove_delay"), p.camera_remove_delay, 0, TIMER)?;
        count(&n("footprint"), p.footprint.len(), 16)?;
        if p.footprint.iter().any(|row| row.chars().count() > 16 || row.chars().any(|c| c != 'x' && c != '_')) {
            return Err(n("footprint rows must be at most 16 cells of x or _"));
        }
        if let Some(w) = p.missile_weapon {
            self.weapon_ref(&n("missile_weapon"), w)?;
        }
        within(&n("missile_delay"), p.missile_delay, 0, TIMER)?;
        within(&n("flight_delay"), p.flight_delay, 0, TIMER)?;
        within(&n("camera_spawn_advance"), p.camera_spawn_advance, 0, TIMER)?;
        within(&n("flight_velocity"), p.flight_velocity, 0, 4 * CELLS)?;
        if !p.spawn_offset.is_empty() {
            count(&n("spawn_offset"), p.spawn_offset.len(), 3)?;
            for &o in &p.spawn_offset {
                within(&n("spawn_offset"), o, -16 * CELLS, 16 * CELLS)?;
            }
        }
        within(&n("beacon_remove_advance"), p.beacon_remove_advance, -TIMER, TIMER)?;
        within(&n("reveal_delay"), p.reveal_delay, 0, TIMER)
    }

    fn weapon_ref(&self, what: &str, w: usize) -> Result<(), String> {
        if w >= self.weapons.len() {
            return Err(format!("{what}: unknown weapon {w}"));
        }
        Ok(())
    }

    /// Actor table index `ty` must be an actor of one of `kinds`.
    fn actor_ref(&self, what: &str, ty: usize, kinds: &[Kind]) -> Result<(), String> {
        match self.actors.get(ty) {
            Some(t) if kinds.contains(&t.kind) => Ok(()),
            Some(_) => Err(format!("{what}: wrong kind of actor")),
            None => Err(format!("{what}: unknown actor")),
        }
    }

    /// Actor id `id` must name an actor of one of `kinds`.
    fn actor_id_ref(&self, what: &str, id: &str, kinds: &[Kind]) -> Result<(), String> {
        match self.actor_index(id) {
            Some(t) => self.actor_ref(what, t, kinds),
            None => Err(format!("{what}: unknown actor {}", truncate(id))),
        }
    }

    /// Resolve the raw JSON shapes (footprint rows, offsets, actor ids) into
    /// lookup structures. Overrides can reshape any array, so every shape is
    /// checked here and reported as an error, never assumed.
    fn from_raw(mut raw: RawRules) -> Result<Rules, String> {
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
        // Prerequisites only proxies provide and ProducibleWithLevel and
        // WithProductionIconOverlay ask for (infantry.rs).
        for a in &raw.actors {
            for t in a
                .abilities
                .proxy
                .iter()
                .flat_map(|p| p.provides.iter())
                .chain(a.producible_level.iter().flat_map(|p| p.prerequisites.iter()))
                .chain(a.production_overlays.iter().flat_map(|o| o.prerequisites.iter()))
            {
                intern(t);
            }
        }
        let ids: Vec<String> = raw.actors.iter().map(|a| a.id.clone()).collect();
        // Damage types TakeCover refers to get one bit each; other types never matter.
        let mut damage_types: Vec<String> = Vec::new();
        for a in &raw.actors {
            let Some(tc) = &a.take_cover else { continue };
            let n = |f: &str| format!("actors.{}.take_cover.{f}", truncate(&a.id));
            if tc.damage_triggers.len() > MAX_TAKE_COVER_TYPES || tc.damage_modifiers.len() > MAX_TAKE_COVER_TYPES {
                return Err(n(&format!("damage_triggers and damage_modifiers may have at most {MAX_TAKE_COVER_TYPES} entries")));
            }
            for t in tc.damage_triggers.iter().chain(tc.damage_modifiers.iter().map(|m| &m.ty)) {
                if !damage_types.contains(t) {
                    damage_types.push(t.clone());
                }
            }
        }
        // Burning trees (neutral.rs) look for Incendiary hits.
        if !damage_types.iter().any(|t| t == crate::neutral::INCENDIARY) {
            damage_types.push(crate::neutral::INCENDIARY.to_string());
        }
        // Damage types of death animations (WithDeathAnimation.DeathTypes) too.
        for a in &raw.actors {
            let Some(d) = &a.death else { continue };
            if d.types.len() > MAX_TAKE_COVER_TYPES {
                return Err(format!("actors.{}.death.types may have at most {MAX_TAKE_COVER_TYPES} entries", truncate(&a.id)));
            }
            for t in &d.types {
                if !damage_types.contains(&t.ty) {
                    damage_types.push(t.ty.clone());
                }
            }
        }
        if damage_types.len() > 32 {
            return Err(format!("take_cover: at most 32 different damage types, found {}", damage_types.len()));
        }
        let type_bit = |t: &str| damage_types.iter().position(|d| d == t).map_or(0, |k| 1u32 << k);
        // Buildable area types get one bit each.
        let mut area_types: Vec<String> = Vec::new();
        for b in raw.actors.iter().filter_map(|a| a.building.as_ref()) {
            for t in b.gives_area.iter().chain(b.requires_area.iter().flatten()) {
                if !area_types.contains(t) {
                    area_types.push(t.clone());
                }
            }
        }
        if area_types.len() > 32 {
            return Err(format!("building: at most 32 different buildable area types, found {}", area_types.len()));
        }
        let area_mask = |ts: &[String]| ts.iter().fold(0u32, |m, t| m | area_types.iter().position(|a| a == t).map_or(0, |k| 1u32 << k));
        let index_of = |id: &str| ids.iter().position(|i| i.eq_ignore_ascii_case(id));
        let mut actors = Vec::new();
        for a in raw.actors {
            let n = |f: &str| format!("actors.{}.{f}", truncate(&a.id));
            let kind = match a.kind.as_str() {
                "building" => Kind::Building,
                "infantry" => Kind::Infantry,
                "vehicle" => Kind::Vehicle,
                "ship" => Kind::Ship,
                "aircraft" => Kind::Aircraft,
                "mine" => Kind::Mine,
                "husk" => Kind::Husk,
                "crate" => Kind::Crate,
                "proxy" => Kind::Proxy,
                _ => return Err(n("kind: unknown kind")),
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
            let building = match a.building {
                None => None,
                Some(b) => {
                    if b.footprint.len() != b.height.max(0) as usize
                        || b.footprint.iter().any(|row| row.chars().count() != b.width.max(0) as usize)
                    {
                        return Err(n("building.footprint must have `height` rows of `width` cells"));
                    }
                    let mut footprint = Vec::new();
                    let mut transit_cells = Vec::new();
                    for (y, row) in b.footprint.iter().enumerate() {
                        for (x, c) in row.chars().enumerate() {
                            if c == '+' {
                                transit_cells.push((x as i32, y as i32));
                            }
                            let cell = match c {
                                '_' => FootCell::Empty,
                                'x' | 'X' => FootCell::Occupied,
                                '=' | '+' => FootCell::Passable,
                                '-' => FootCell::Overlay,
                                _ => return Err(n("building.footprint: cells must be one of _ x X = + -")),
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
                    let mut exits = Vec::new();
                    for e in &b.exits {
                        exits.push(pair(e).ok_or_else(|| n("building.exits: each exit must be [x, y]"))?);
                    }
                    let exit_priority = match b.exit_priorities.len() {
                        0 => vec![1; exits.len()],
                        len if len == exits.len() => b.exit_priorities.clone(),
                        _ => return Err(n("building.exit_priorities: one per exit")),
                    };
                    let exit_types = match b.exit_types.len() {
                        0 => vec![Vec::new(); exits.len()],
                        len if len == exits.len() => b.exit_types.clone(),
                        _ => return Err(n("building.exit_types: one list per exit")),
                    };
                    let refinery = match b.refinery {
                        None => None,
                        Some(r) => Some(RefineryInfo {
                            dock_offset: pair(&r.dock_offset).ok_or_else(|| n("building.refinery.dock_offset must be [x, y]"))?,
                            free_actor: index_of(&r.free_actor).ok_or_else(|| n("building.refinery.free_actor: unknown actor"))?,
                            free_actor_offset: pair(&r.free_actor_offset)
                                .ok_or_else(|| n("building.refinery.free_actor_offset must be [x, y]"))?,
                        }),
                    };
                    Some(BuildingInfo {
                        width: b.width,
                        height: b.height,
                        footprint,
                        hit_cells,
                        transit_cells,
                        on_water: b.terrain.iter().any(|t| t == "Water"),
                        requires_base_provider: b.requires_base_provider,
                        power: b.power,
                        power_scales_with_health: b.power_scales_with_health,
                        produces,
                        production_types: b.produces.clone(),
                        exits,
                        exit_priority,
                        exit_types,
                        gives_area: area_mask(&b.gives_area),
                        requires_area: b.requires_area.as_deref().map(area_mask),
                        base_provider_range: b.base_provider_range,
                        adjacent: b.adjacent,
                        storage: b.storage,
                        sell_refund: b.sell_refund,
                        provides,
                        refinery,
                        repairs: b.repairs,
                        repairable: b.repairable,
                        power_down: b.power_down,
                        fake_tag: b.fake_tag,
                        make_ticks: u32::try_from(b.make_ticks)
                            .ok()
                            .filter(|&t| t <= TIMER as u32)
                            .ok_or_else(|| n("building.make_ticks must be between 0 and 100000"))?,
                        make_gates: {
                            let mut g = MakeGates::default();
                            for name in &b.make_gates {
                                match name.as_str() {
                                    "sell" => g.sell = true,
                                    "capture" => g.capture = true,
                                    "attack" => g.attack = true,
                                    "transform" => g.transform = true,
                                    _ => return Err(n("building.make_gates: unknown gate (sell, capture, attack, transform)")),
                                }
                            }
                            g
                        },
                        center_offset: pair(&b.center_offset).ok_or_else(|| n("building.center_offset must be [x, y]"))?,
                        lightning_rod: b.lightning_rod,
                    })
                }
            };
            let mut turret_offsets = Vec::new();
            for o in &a.turret_offsets {
                turret_offsets.push(pair(o).ok_or_else(|| n("turret_offsets: each offset must be [forward, lateral]"))?);
            }
            let queue = QueueType::parse(&a.queue).ok_or_else(|| n("queue: unsupported queue"))?;
            let transforms_into = a.abilities.transforms.as_ref().and_then(|t| index_of(&t.into));
            let mut world = a.world;
            if let Some(id) = &world.spawn_on_death {
                world.spawn_ty = Some(index_of(id).ok_or_else(|| n("world.spawn_on_death: unknown actor"))?);
            }
            if let Some(h) = &world.hospital_heal {
                world.hospital_token = Some(intern(&h.prerequisite));
            }
            if let Some(b) = world.bridge.as_mut() {
                for h in b.huts.iter_mut() {
                    h.ty = index_of(&h.actor).ok_or_else(|| n("world.bridge.huts.actor: unknown actor"))?;
                }
                let mut shore = Vec::new();
                for id in &b.shore_pieces {
                    shore.push(index_of(id).ok_or_else(|| n("world.bridge.shore_pieces: unknown actor"))?);
                }
                b.shore_tys = shore;
            }
            let death =
                a.death.map(|d| DeathInfo { by_type: d.types.iter().map(|t| (type_bit(&t.ty), t.sequence)).collect(), crushed: d.crushed });
            let take_cover = a.take_cover.map(|tc| TakeCoverInfo {
                duration: tc.duration,
                speed_modifier: tc.speed_modifier,
                triggers: tc.damage_triggers.iter().fold(0, |m, t| m | type_bit(t)),
                modifiers: tc.damage_modifiers.iter().map(|m| (type_bit(&m.ty), m.percent)).collect(),
            });
            let options = crate::rules_options::resolve_actor(&a.id, a.options, &ids, &raw.factions, &mut intern)?;
            actors.push(ActorInfo {
                id: a.id,
                name: a.name,
                description: a.description,
                kind,
                queue,
                cost: a.cost,
                custom_sell_value: a.custom_sell_value,
                build_ticks: a.build_ticks,
                palette_order: a.palette_order,
                build_limit: a.build_limit,
                prerequisites,
                build_at: a.build_at,
                hp: a.hp,
                armor: a.armor,
                sight: a.sight,
                weapons: a.weapons,
                turret_turn_speed: a.turret_turn_speed,
                reload_override: a.reload_override,
                requires_power: a.requires_power,
                defense: a.defense,
                opportunity_fire: a.opportunity_fire,
                base_building: a.base_building,
                selection: a.selection,
                death_weapon: a.death_weapon,
                self_heal: a.self_heal,
                turret_offsets,
                stance: a.stance,
                abilities: a.abilities,
                experience: a.experience,
                gives_experience: a.gives_experience,
                take_cover,
                producible_level: a.producible_level,
                production_overlays: a.production_overlays,
                fire_delays: a.fire_delays,
                targets_allies: a.targets_allies,
                death,
                infiltrate_types: a.infiltrate_types,
                disguisable: a.disguisable,
                tooltip: a.tooltip,
                range_circles: a.range_circles,
                building,
                unit: a.unit,
                transforms_into,
                world,
                options,
            });
        }
        for w in &raw.weapons {
            if w.warheads.iter().any(|h| h.damage_types.len() > MAX_DAMAGE_TYPES) {
                return Err(format!("weapons.{}.warheads.damage_types may have at most {MAX_DAMAGE_TYPES} entries", truncate(&w.name)));
            }
        }
        let mut weapon_effects = Vec::new();
        for w in raw.weapons.iter_mut() {
            weapon_effects.push(crate::rules_options::resolve_effects(&w.name, std::mem::take(&mut w.effects))?);
        }
        let weapons = raw
            .weapons
            .into_iter()
            .zip(weapon_effects)
            .map(|(w, effects)| WeaponInfo {
                name: w.name,
                range: w.range,
                min_range: w.min_range,
                reload: w.reload,
                burst: w.burst,
                burst_delays: w.burst_delays,
                projectile: match w.projectile.as_str() {
                    "bullet" => Projectile::Bullet,
                    "missile" => Projectile::Missile,
                    "tesla" => Projectile::Tesla,
                    "bomb" => Projectile::Bomb,
                    _ => Projectile::Instant,
                },
                speed: w.speed,
                inaccuracy: w.inaccuracy,
                range_limit: w.range_limit,
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
                        damage_types: h.damage_types.iter().fold(0, |m, t| m | type_bit(t)),
                        relationships: h.relationships,
                    })
                    .collect(),
                clusters: w.clusters,
                effects,
            })
            .collect();
        let locomotor_crushes_mines = raw.locomotors.iter().map(|l| l.crushes.iter().any(|c| c == "mine")).collect();
        let locomotor_crushes_crates = raw.locomotors.iter().map(|l| l.crushes.iter().any(|c| c == "crate")).collect();
        let world = crate::rules_options::resolve_world(raw.world, &ids, &raw.factions)?;
        let locomotors = raw
            .locomotors
            .into_iter()
            .map(|l| Locomotor {
                crushes_infantry: l.crushes.iter().any(|c| c == "infantry"),
                crushes: l.crushes,
                domain: match l.domain.as_str() {
                    "water" => Domain::Water,
                    "air" => Domain::Air,
                    _ => Domain::Ground,
                },
                name: l.name,
                speeds: l.speeds,
                shares_cell: l.shares_cell,
                wait_average: l.wait_average.clamp(0, 1000),
            })
            .collect();
        let mut rules = Rules {
            factions: raw.factions,
            player: raw.player,
            actors,
            weapons,
            locomotors,
            locomotor_crushes_mines,
            locomotor_crushes_crates,
            world,
            bots: raw.bots,
            tokens,
            damage_types,
            area_types,
            obtainable: Vec::new(),
            render: Default::default(),
        };
        rules.obtainable = (0..rules.factions.len()).map(|f| rules.solve_obtainable(f)).collect();
        rules.render = crate::fx::RenderData::load(&rules);
        Ok(rules)
    }

    /// Fixed point over the tech tree: which actors a faction can ever build.
    fn solve_obtainable(&self, faction: usize) -> Vec<bool> {
        let disabled = self.token(TOKEN_DISABLED);
        let mut have = vec![false; self.tokens.len()];
        for t in TECH_LEVELS {
            have[self.token(&format!("techlevel.{t}")).unwrap() as usize] = true;
        }
        // Granted in every skirmish and multiplayer game (production.rs refresh_tokens).
        if let Some(t) = self.token(crate::production::GLOBAL_SKIRMISH) {
            have[t as usize] = true;
        }
        let mut ok = vec![false; self.actors.len()];
        // The Construction Yard is where every game starts.
        if let Some(fact) = self.actor_index("FACT") {
            ok[fact] = true;
        }
        loop {
            let mut changed = false;
            for (i, a) in self.actors.iter().enumerate() {
                // Proxies are granted by infiltration, never built (infantry.rs).
                if a.kind == Kind::Proxy {
                    continue;
                }
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
        self.actor_index("FACT")
            .and_then(|f| self.actors[f].building.as_ref())
            .is_some_and(|b| b.provides.get(faction).is_some_and(|p| p.contains(&token)))
    }

    pub fn actor_index(&self, id: &str) -> Option<usize> {
        self.actors.iter().position(|a| a.id.eq_ignore_ascii_case(id))
    }

    pub fn faction_index(&self, name: &str) -> Option<usize> {
        self.factions.iter().position(|f| f == name)
    }

    /// The bit of a damage type in warhead damage type masks (0 when no rule refers to it).
    pub fn damage_type_bit(&self, name: &str) -> u32 {
        self.damage_types.iter().position(|d| d == name).map_or(0, |k| 1u32 << k)
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

/// World units per cell, for range bounds.
const CELLS: i32 = 1024;
/// Most damage types one warhead may list, and one TakeCover may refer to per list.
const MAX_DAMAGE_TYPES: usize = 16;
const MAX_TAKE_COVER_TYPES: usize = 16;
/// Most veterancy levels (rank decorations, level-up loops).
pub const MAX_LEVELS: usize = 8;
/// Upper bound for percentage modifiers (firepower, damage, speed, reload, prone).
const MAX_PERCENT: i32 = 1000;
/// Upper bound for timers and delays, in ticks (over an hour of game time).
const TIMER: i32 = 100_000;
/// Most repair bonus steps: one more than the players that may repair one building at once (repair.rs).
pub const MAX_REPAIR_BONUSES: usize = 9;
/// Largest vision-like radius (sight, gap generator shroud and sight): vision
/// circles are cached per radius and cost (2r + 1)^2 cells.
const MAX_VISION: i32 = 40 * CELLS;

fn within(what: &str, v: i32, lo: i32, hi: i32) -> Result<(), String> {
    if v < lo || v > hi {
        return Err(format!("{what} must be between {lo} and {hi}, is {v}"));
    }
    Ok(())
}

fn count(what: &str, len: usize, max: usize) -> Result<(), String> {
    if len > max {
        return Err(format!("{what} may have at most {max} entries, has {len}"));
    }
    Ok(())
}

/// Apply mission rules changes (`Rules::load_mission`).
fn apply_mission_changes(base: &mut serde_json::Value, changes: &serde_json::Value) -> Result<(), String> {
    let c = changes.as_object().ok_or("mission rules must be an object")?;
    // `bots`: the mission's campaign bot (ai_bots.rs BotType::Campaign), by type.
    for (section, key_field) in [("actors", "id"), ("weapons", "name"), ("locomotors", "name"), ("bots", "type")] {
        let Some(entries) = c.get(section) else { continue };
        let entries = entries.as_array().ok_or_else(|| format!("mission rules.{section} must be a list"))?;
        let list = base[section].as_array_mut().expect("rules sections are arrays");
        for e in entries {
            let obj = e.as_object().ok_or_else(|| format!("mission rules.{section}: entries must be objects"))?;
            let key =
                obj.get(key_field).and_then(|v| v.as_str()).ok_or_else(|| format!("mission rules.{section}: entry without {key_field}"))?;
            match list.iter_mut().find(|t| t[key_field].as_str() == Some(key)) {
                Some(target) => {
                    let t = target.as_object_mut().expect("rules entries are objects");
                    for (k, v) in obj {
                        if !t.contains_key(k) {
                            return Err(format!("mission rules.{section}.{}: unknown field {}", truncate(key), truncate(k)));
                        }
                        t.insert(k.clone(), v.clone());
                    }
                }
                None => list.push(e.clone()),
            }
        }
    }
    for k in c.keys() {
        if !matches!(k.as_str(), "actors" | "weapons" | "locomotors" | "bots" | "armor_types") {
            return Err(format!("mission rules: unknown section {}", truncate(k)));
        }
    }
    Ok(())
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
            let path = format!("{section}.{}", truncate(id));
            if section == "actors" {
                if let Some(v) = patch.get("custom_sell_value") {
                    // OpenRA CustomSellValue may be given to any actor, and null takes a
                    // built-in one away (`-CustomSellValue`: the cost counts again).
                    set_custom_sell_value(target, v, &path)?;
                    let mut rest = patch.clone();
                    rest.as_object_mut().expect("has a key, so an object").remove("custom_sell_value");
                    merge(target, &rest, &path, key_field)?;
                    continue;
                }
            }
            merge(target, patch, &path, key_field)?;
        }
    }
    for k in o.keys() {
        if k != "actors" && k != "weapons" {
            return Err(format!("rules: unknown section {}", truncate(k)));
        }
    }
    fn set_custom_sell_value(target: &mut Value, v: &Value, path: &str) -> Result<(), String> {
        let t = target.as_object_mut().ok_or_else(|| format!("{path}: expected an object"))?;
        match v {
            Value::Null => {
                t.remove("custom_sell_value");
            }
            Value::Number(n) if n.is_i64() || n.is_u64() => {
                t.insert("custom_sell_value".into(), v.clone());
            }
            Value::Number(_) => return Err(format!("{path}.custom_sell_value: numbers must be integers")),
            _ => return Err(format!("{path}.custom_sell_value: wrong type")),
        }
        Ok(())
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
                // Arrays are replaced whole; objects inside them keep their identity.
                keep_identity(Some(&*cur), v, &format!("{path}.{}", truncate(k)))?;
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
    /// `kind` and `queue` cannot be changed anywhere: inside a replaced array an
    /// object may only repeat the built-in value at the same position (so a
    /// warhead or support power list can be tuned, but no entry changes kind).
    fn keep_identity(cur: Option<&Value>, v: &Value, path: &str) -> Result<(), String> {
        match v {
            Value::Array(items) => {
                for (i, item) in items.iter().enumerate() {
                    keep_identity(cur.and_then(|c| c.get(i)), item, path)?;
                }
            }
            Value::Object(o) => {
                for (k, x) in o {
                    let base = cur.and_then(|c| c.get(k));
                    if (k == "kind" || k == "queue") && base != Some(x) {
                        return Err(format!("{path}.{}: cannot be changed", truncate(k)));
                    }
                    keep_identity(base, x, path)?;
                }
            }
            _ => {}
        }
        Ok(())
    }
    Ok(())
}

/// A two-element `[x, y]` array as a tuple.
fn pair(v: &[i32]) -> Option<(i32, i32)> {
    match *v {
        [x, y] => Some((x, y)),
        _ => None,
    }
}

fn truncate(s: &str) -> String {
    s.chars().take(40).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn built_in_rules_pass_validation() {
        Rules::load().validate().unwrap();
    }

    #[test]
    fn overrides_with_unsafe_values_are_rejected() {
        for bad in [
            serde_json::json!({ "actors": { "POWR": { "hp": 0 } } }),
            serde_json::json!({ "actors": { "1TNK": { "cost": -5 } } }),
            serde_json::json!({ "actors": { "1TNK": { "unit": { "speed": 100000 } } } }),
            serde_json::json!({ "weapons": { "25mm": { "burst": 0 } } }),
            serde_json::json!({ "weapons": { "25mm": { "burst_delays": [] } } }),
            serde_json::json!({ "weapons": { "25mm": { "range": 2000000000 } } }),
            // Repair button (repair.rs).
            serde_json::json!({ "actors": { "POWR": { "building": { "repairable": { "interval": 0 } } } } }),
            serde_json::json!({ "actors": { "POWR": { "building": { "repairable": { "bonuses": [] } } } } }),
            serde_json::json!({ "actors": { "POWR": { "building": { "repairable": { "bonuses": [100, 100, 100, 100, 100, 100, 100, 100, 100, 100] } } } } }),
            serde_json::json!({ "actors": { "POWR": { "building": { "repairable": { "percent": -1 } } } } }),
            serde_json::json!({ "actors": { "PBOX": { "custom_sell_value": -1 } } }),
        ] {
            assert!(Rules::load_with(Some(&bad)).is_err(), "{bad}");
        }
    }

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
    fn rules_loaded_again_are_the_same_and_never_mixed_up() {
        let cost = |r: &Rules| r.actors[r.actor_index("1TNK").unwrap()].cost;
        let a = serde_json::json!({ "actors": { "1TNK": { "cost": 111 } } });
        let b = serde_json::json!({ "actors": { "1TNK": { "cost": 222 } } });
        let base = cost(&Rules::load());
        // Each load hands out its own copy: changing one changes no later load.
        let mut first = Rules::load_with(Some(&a)).unwrap();
        first.actors[0].cost = 1;
        let again = Rules::load_with(Some(&a)).unwrap();
        assert_eq!(cost(&again), 111);
        assert_ne!(again.actors[0].cost, 1);
        assert_eq!(cost(&Rules::load_with(Some(&b)).unwrap()), 222);
        assert_eq!(cost(&Rules::load()), base);
        assert_eq!(cost(&Rules::load_with(Some(&a)).unwrap()), 111);
        // A refused override is refused every time and changes nothing kept.
        let bad = serde_json::json!({ "actors": { "1TNK": { "cost": -1 } } });
        assert!(Rules::load_with(Some(&bad)).is_err());
        assert!(Rules::load_with(Some(&bad)).is_err());
        assert_eq!(cost(&Rules::load_with(Some(&a)).unwrap()), 111);
        assert_eq!(cost(&Rules::load_with(None).unwrap()), base);
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
        // Resources (PlayerResources, ResourceLayer): the map format fixes the densities.
        assert_eq!((r.player.ore_value, r.player.gem_value), (25, 50));
        assert_eq!(r.player.ore_max_density, crate::map::ORE_MAX_DENSITY);
        assert_eq!(r.player.gem_max_density, crate::map::GEM_MAX_DENSITY);
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
