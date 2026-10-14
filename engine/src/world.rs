//! World state, actor storage, orders and the fixed-step tick loop.

use crate::flowfield::{FlowCache, Passability};
use crate::map::Map;
use crate::math::{dist, CELL, HALF_CELL};
use crate::rng::Rng;
use crate::rules::{FootCell, Kind, QueueType, Rules, Stance, QUEUE_COUNT};
use crate::sound_events::{kind_code, SoundEventKind};
use std::collections::BTreeMap;

/// Simulation ticks per second at normal speed (OpenRA: 40 ms per tick).
pub const TICKS_PER_SECOND: u32 = 25;
pub const NONE: u32 = u32::MAX;
const IDX_BITS: u32 = 22;
const IDX_MASK: u32 = (1 << IDX_BITS) - 1;
const GEN_MASK: u32 = (1 << (32 - IDX_BITS)) - 1;
pub const MAX_WEAPONS: usize = 4;
const VISION_INTERVAL: u32 = 2;
/// Queued waypoints a unit keeps at most (Shift+click moves); later ones are dropped.
pub const MAX_WAYPOINTS: usize = 16;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Activity {
    Idle,
    Move,
    Attack,
    Harvest,
    Repair,
    /// Walking to a transport to get in (cargo.rs).
    Board,
    /// Transport letting its passengers out (cargo.rs).
    Unload,
    /// Unit ability task (abilities.rs: minefields, cash delivery, MAD tank).
    Ability,
    /// Follow the unit in `guard` and fight what comes near (OpenRA Guard).
    Guard,
    /// Fire at the ground at `fire_at` until told otherwise (OpenRA force-fire).
    AttackGround,
    /// Walk into an actor to capture, infiltrate, repair or demolish it (infantry.rs).
    Enter,
}

/// A queued move (Shift+click), started once the unit is idle. Units of one
/// order share the group, so they arrive together like a normal group move.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Waypoint {
    pub x: i32,
    pub y: i32,
    pub attack_move: bool,
    pub group: u32,
    pub group_size: i32,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum HarvState {
    Search,
    ToOre,
    Harvesting,
    ToDock,
    Unloading,
    Wait,
}

#[derive(Clone)]
pub struct Actor {
    pub alive: bool,
    pub gen: u32,
    pub kind: Kind,
    pub ty: u16,
    pub owner: u8,
    pub x: i32,
    pub y: i32,
    pub px: i32,
    pub py: i32,
    pub facing: i32,
    pub turret: i32,
    pub pfacing: i32,
    pub pturret: i32,
    pub hp: i32,

    // Units
    pub activity: Activity,
    pub goal: u32,
    pub group: u32,
    pub group_size: i32,
    pub attack_move: bool,
    /// Original attack-move destination, resumed after a fight.
    pub dest: (i32, i32),
    pub target: u32,
    /// Where `target` was last seen by the owner. An attack whose target went
    /// out of sight heads there (OpenRA Attack: last visible target) and ends
    /// on arrival unless the target shows up again (combat.rs).
    pub target_seen: Option<(i32, i32)>,
    /// Target of opportunity fire: a turreted unit on a plain move shoots at
    /// it without stopping (OpenRA AttackTurreted OpportunityFire, units.rs).
    pub opportunity: u32,
    pub forced: bool,
    pub chase_cell: u32,
    /// The move's goal is a stand-in for `dest`, the nearest cell that could
    /// be reached when the way was cut (a husk in a gap, a fallen bridge);
    /// the move goes back to `dest` when a later passability change opens
    /// the way again (units.rs `keep_goal_reachable`, `restore_dest`).
    pub retargeted: bool,
    /// Passability version the stand-in goal was last checked against.
    pub goal_version: u32,
    pub reload: [i32; MAX_WEAPONS],
    pub burst_shot: [i32; MAX_WEAPONS],
    pub scan_cooldown: i32,
    /// Least remaining path length toward the current goal so far (units.rs).
    pub best_dist: i32,
    /// Ticks in a row without progress toward the goal.
    pub stuck_ticks: i32,
    /// Ticks without progress that a moving crowd around the unit does not
    /// explain (see `World::jammed`). Reset with `stuck_ticks` on progress.
    pub stall_ticks: i32,
    pub moved: bool,
    /// Fire stance (OpenRA AutoTarget stance); only matters with rules `stance`.
    pub stance: Stance,
    /// Enemy that hit this actor while it was idle, until it shoots back (or not).
    pub aggressor: u32,
    /// The current attack may not move the unit (auto-targets under Defend and
    /// ReturnFire): it ends once the target is out of range.
    pub hold: bool,
    /// Unit protected by Activity::Guard, or NONE.
    pub guard: u32,
    /// Ground point of Activity::AttackGround (world units).
    pub fire_at: (i32, i32),
    /// Queued moves (Shift+click), oldest first.
    pub waypoints: Vec<Waypoint>,

    // Harvesters
    pub harv: HarvState,
    /// Bales on board, of any resource.
    pub bales: i32,
    /// How many of `bales` are gems (OpenRA StoresResources keeps a count per type).
    pub gem_bales: i32,
    pub harv_timer: i32,
    pub harv_cell: u32,
    pub refinery: u32,

    // Repair
    pub depot: u32,
    pub repair_timer: i32,
    /// Place in the service depot's line (service.rs).
    pub svc: crate::service::ServiceState,

    // Buildings
    pub cx: i32,
    pub cy: i32,
    pub rally: Option<(i32, i32)>,
    pub dock_user: u32,

    /// Ticks of white hit-flash left (render only).
    pub flash: i32,
    pub last_damaged: u32,
    pub heal_timer: i32,
    /// Iron Curtain: no damage until this tick.
    pub invulnerable_until: u32,
    /// Height above ground in world units (aircraft); 0 on the ground.
    pub altitude: i32,
    /// Ability state (abilities.rs).
    pub ab: crate::abilities::ActorAbility,

    // Transports and passengers (cargo.rs)
    /// Transport this unit rides in, or NONE. Passengers are out of the world.
    pub carrier: u32,
    /// Transport this unit walks to while boarding (Activity::Board), or NONE.
    pub board_target: u32,
    /// Passengers of a transport, in loading order.
    pub cargo: Vec<u32>,
    pub unload_timer: i32,

    // Submarines (naval.rs)
    pub submerged: bool,
    /// Ticks until a surfaced submarine submerges (OpenRA Cloak remaining time).
    pub cloak_timer: i32,
    /// Players (one bit per slot) whose detectors reveal this submerged submarine.
    pub detected_by: u32,

    /// Helicopter state (helicopter.rs): task, ammo, reserved helipad.
    pub heli: crate::helicopter::HeliState,
    /// Aircraft state: ammo, airfield, flight phase, support missions, parachutes (plane.rs).
    pub air: crate::plane::AirState,
    /// Snow momentum and desert heat (weather.rs).
    pub env: crate::weather::UnitEnv,

    // Veterancy and prone infantry (veterancy.rs)
    /// Experience, in OpenRA's units: percent of the actor's own value
    /// (killing an enemy worth 100 gives 10000 with the default modifier).
    pub xp: i64,
    /// Veterancy level: 0 rookie, then one per GainsExperience threshold reached.
    pub rank: u8,
    /// Ticks left prone (TakeCover); 0 when standing.
    pub prone_ticks: i32,
    /// Elite self repair (ChangesHealth@ELITE) step timer.
    pub rank_heal_timer: i32,
    /// Tick the actor appeared (0 for actors of the starting map). Presentation
    /// only: the sprite poses (render.rs `Pose::Make`) read it; it is not part
    /// of the state hash and nothing in the simulation depends on it.
    pub born: u32,
    /// When it fired, smoked, worked (fx.rs): presentation only, not in the state hash.
    pub fx: crate::fx::ActorFx,

    // Repair and power down buttons (repair.rs)
    /// Players repairing this building (OpenRA RepairableBuilding.Repairers), in the order they started.
    pub repairers: Vec<u8>,
    /// Ticks until the next repair step.
    pub repair_ticks: i32,
    /// A repairer paid for the last step (OpenRA RepairActive): the wrench shows.
    pub repair_active: bool,
    /// Switched off with the power down button (OpenRA `powerdown` condition).
    pub powered_off: bool,
    /// State of the neutral world's traits (neutral.rs): panic, wandering,
    /// hospital heal, oil derrick and ore mine timers.
    pub world: crate::neutral::ActorWorld,

    /// Faction it was made for (OpenRA FactionInit): a captured structure
    /// keeps providing its own faction's prerequisites.
    pub faction: u8,
    /// Infantry abilities: entering, disguise, leaps, C4 (infantry.rs, dog.rs).
    pub inf: crate::infantry::InfantryState,
    /// Husks and crates (husks.rs, crates.rs): burn timer, slide, age on the ground.
    pub leftover: crate::husks::Leftover,
    /// The owner's primary production structure (primary.rs, OpenRA PrimaryBuilding).
    pub primary: bool,
    /// Cells held and the move under way in the OpenRA movement model (movement/cellmove.rs).
    pub mv: crate::movement::Motion,
}

impl Actor {
    fn blank() -> Actor {
        Actor {
            alive: false,
            gen: 0,
            kind: Kind::Vehicle,
            ty: 0,
            owner: 0,
            x: 0,
            y: 0,
            px: 0,
            py: 0,
            facing: 512,
            turret: 512,
            pfacing: 512,
            pturret: 512,
            hp: 0,
            activity: Activity::Idle,
            goal: NONE,
            group: 0,
            group_size: 1,
            attack_move: false,
            dest: (0, 0),
            target: NONE,
            target_seen: None,
            opportunity: NONE,
            forced: false,
            chase_cell: NONE,
            retargeted: false,
            goal_version: 0,
            reload: [0; MAX_WEAPONS],
            burst_shot: [0; MAX_WEAPONS],
            scan_cooldown: 0,
            best_dist: i32::MAX,
            stuck_ticks: 0,
            stall_ticks: 0,
            moved: false,
            stance: Stance::AttackAnything,
            aggressor: NONE,
            hold: false,
            guard: NONE,
            fire_at: (0, 0),
            waypoints: Vec::new(),
            harv: HarvState::Search,
            bales: 0,
            gem_bales: 0,
            harv_timer: 0,
            harv_cell: NONE,
            refinery: NONE,
            depot: NONE,
            repair_timer: 0,
            svc: Default::default(),
            cx: 0,
            cy: 0,
            rally: None,
            dock_user: NONE,
            flash: 0,
            last_damaged: 0,
            heal_timer: 0,
            invulnerable_until: 0,
            altitude: 0,
            ab: crate::abilities::ActorAbility::default(),
            heli: crate::helicopter::HeliState::default(),
            carrier: NONE,
            board_target: NONE,
            cargo: Vec::new(),
            unload_timer: 0,
            submerged: false,
            cloak_timer: 0,
            detected_by: 0,
            air: crate::plane::AirState::default(),
            env: crate::weather::UnitEnv::default(),
            xp: 0,
            rank: 0,
            prone_ticks: 0,
            rank_heal_timer: 0,
            born: 0,
            fx: Default::default(),
            repairers: Vec::new(),
            repair_ticks: 0,
            repair_active: false,
            powered_off: false,
            world: crate::neutral::ActorWorld::default(),
            faction: 0,
            inf: Default::default(),
            leftover: Default::default(),
            primary: false,
            mv: Default::default(),
        }
    }

    pub fn is_unit(&self) -> bool {
        !matches!(self.kind, Kind::Building | Kind::Mine | Kind::Husk | Kind::Crate)
    }

    /// False for passengers inside a transport (out of the world: not ticked,
    /// not in the spatial hash, not drawn, not targetable).
    pub fn in_world(&self) -> bool {
        self.carrier == NONE
    }
}

#[derive(Clone)]
pub struct QueueItem {
    pub ty: u16,
    pub total: i32,
    pub remaining: i32,
    pub paid: i32,
    pub slow: i32,
    pub done: bool,
    /// On hold (OpenRA ProductionItem.Paused): a paused first item holds up its queue.
    pub paused: bool,
}

#[derive(Clone, Default)]
pub struct Queue {
    pub items: Vec<QueueItem>,
}

#[derive(Clone)]
pub struct Ghost {
    pub actor: u32,
    pub ty: u16,
    pub owner: u8,
    pub cx: i32,
    pub cy: i32,
}

/// OpenRA `PlayerRelationship` between two players (`World::relationship`).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Relationship {
    Ally,
    Neutral,
    Enemy,
}

impl Relationship {
    /// The name the rules use (`SupportPowerInfo::display_timer`).
    pub fn name(self) -> &'static str {
        match self {
            Relationship::Ally => "ally",
            Relationship::Neutral => "neutral",
            Relationship::Enemy => "enemy",
        }
    }
}

#[derive(Clone)]
pub struct Player {
    pub faction: usize,
    pub side: usize,
    pub cash: i32,
    pub resources: i32,
    pub storage: i32,
    pub power_gen: i32,
    pub power_use: i32,
    pub tokens: Vec<bool>,
    pub queues: [Queue; QUEUE_COUNT],
    pub visible: Vec<u8>,
    pub explored: Vec<u8>,
    pub ghosts: BTreeMap<u32, Ghost>,
    pub is_ai: bool,
    pub defeated: bool,
    pub start: (i32, i32),
    /// 0: no team; equal non-zero teams are allies.
    pub team: u8,
    /// Owner of neutral map actors: never plays, never wins or loses.
    pub neutral: bool,
    /// Debug menu cheat flags (debug.rs); only orders of a game with cheats set them.
    pub dev: crate::debug::DevFlags,
    /// Proxy actor types infiltrations granted (OpenRA InfiltrateForSupportPower; infantry.rs), sorted.
    pub proxies: Vec<u16>,
    /// Handicap in percent (gamerules.rs).
    pub handicap: i32,
    /// OpenRA PlayerExperience: kills, repairs for allies and captures; the
    /// time limit's winner has the most (gamerules.rs).
    pub experience: i64,
}

impl Player {
    pub fn funds(&self) -> i32 {
        self.cash + self.resources
    }
    pub fn low_power(&self) -> bool {
        self.power_use > self.power_gen && !self.dev.unlimited_power
    }
}

#[derive(Clone)]
pub struct Projectile {
    pub x: i32,
    pub y: i32,
    pub tx: i32,
    pub ty: i32,
    pub weapon: u16,
    pub owner: u8,
    pub target: u32,
    pub facing: i32,
    /// Who fired it, and with what firepower (veterancy.rs).
    pub shot: crate::veterancy::Shot,
    /// Height it bursts at: the target's altitude (an aircraft in the air,
    /// else 0), followed by homing missiles (combat.rs `tick_projectiles`).
    pub alt: i32,
    /// A homing missile's inaccuracy: the offset from its target it flies
    /// to (OpenRA Missile `offset`).
    pub ox: i32,
    pub oy: i32,
    /// Distance flown so far (OpenRA Missile `distanceCovered`, against its RangeLimit).
    pub travel: i32,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum EffectKind {
    SmallExplosion,
    LargeExplosion,
    Piff,
    /// Line effect from (x, y) to (tx, ty).
    TeslaBolt,
    NukeExplosion,
    ChronoShimmer,
    /// Dust cloud of a sold or packed-up structure.
    Dust,
    /// Naval special effect (index into NAVAL_SPECIALS, see naval.rs).
    Naval(u8),
    /// Smudge smoke, flames and crate pickup animations (husks.rs `LEFTOVER_*`).
    Leftover(u8),
    /// An explosion of a CreateEffect warhead (fx.rs): its index in
    /// `Rules::render.explosions` and the ticks before it shows.
    Explosion(u16, u8),
}

#[derive(Clone)]
pub struct Effect {
    pub x: i32,
    pub y: i32,
    /// End point for line effects; equal to (x, y) otherwise.
    pub tx: i32,
    pub ty: i32,
    pub kind: EffectKind,
    pub ttl: i32,
    pub max: i32,
}

/// A warhead that lands later (delayed warheads, chained death explosions).
#[derive(Clone)]
pub struct PendingImpact {
    pub tick: u32,
    pub weapon: u16,
    pub warhead: u8,
    pub x: i32,
    pub y: i32,
    /// Height it burst at (smudges.rs: no smudges from bursts in the air).
    pub altitude: i32,
    pub owner: u8,
    /// Who fired it, and with what firepower (veterancy.rs).
    pub shot: crate::veterancy::Shot,
}

/// Lobby options (see apps/game/js/lobby.js). Defaults follow OpenRA's.
#[derive(Clone, Debug)]
pub struct GameOptions {
    pub starting_cash: i32,
    pub starting_units: StartingUnits,
    /// Index into rules::TECH_LEVELS.
    pub tech_level: usize,
    pub fog: bool,
    pub explored: bool,
    pub build_radius: bool,
    pub redeployable_mcv: bool,
    pub ore_regrowth: bool,
    /// Layout of a generated map (map files bring their own).
    pub map_style: crate::mapgen::MapStyle,
    /// Biome of a generated map; None picks one from the seed. Map files
    /// bring their own biome and ignore this.
    pub biome: Option<crate::weather::Biome>,
    /// What weather does (weather.rs).
    pub weather: crate::weather::WeatherMode,
    /// Lobby option "Debug menu" (OpenRA `cheats`): cheat orders work (debug.rs).
    pub cheats: bool,
    /// Tech buildings of a generated map (OpenRA's map generator option
    /// "Buildings", mapgen/settlements.rs). Map files bring their own.
    pub tech_buildings: crate::mapgen::settlements::TechBuildings,
    /// Lobby option "Reusable engineers" (OpenRA `reusable-engineers`): engineers
    /// capture from outside and stay (Captures@REUSABLE; infantry.rs).
    pub reusable_engineers: bool,
    /// OpenRA `crates`: the crate spawner drops crates (crates.rs).
    pub crates: bool,
    /// OpenRA `shortgame`: a player loses with its last structure (and MCV),
    /// not its last unit (gamerules.rs).
    pub short_game: bool,
    /// OpenRA `timelimit` in minutes, 0 for none (gamerules.rs).
    pub time_limit: i32,
    /// Milliseconds per tick of the game speed: the time limit counts real
    /// minutes, like OpenRA (`1000 / Timestep` ticks a second).
    pub tick_ms: i32,
    /// OpenRA `bounty`: killers get a share of the victim's value (gamerules.rs).
    pub bounty: bool,
    /// OpenRA `separateteamspawns`: team mates start next to each other, apart from their enemies.
    pub separate_team_spawns: bool,
    /// OpenRA `allybuild`: allied structures extend the build area too (production.rs).
    pub ally_build_radius: bool,
    /// How units move among each other (movement/): OpenRA's cell
    /// occupancy (the lobby default) or WebRA's soft crowd separation.
    pub movement: crate::movement::MovementModel,
}

impl Default for GameOptions {
    fn default() -> Self {
        GameOptions {
            starting_cash: 5000,
            starting_units: StartingUnits::Base,
            tech_level: 4,
            fog: true,
            explored: false,
            build_radius: true,
            redeployable_mcv: true,
            ore_regrowth: true,
            map_style: crate::mapgen::MapStyle::Random,
            biome: Some(crate::weather::Biome::Temperate),
            weather: crate::weather::WeatherMode::Full,
            cheats: false,
            tech_buildings: crate::mapgen::settlements::TechBuildings::Standard,
            // Tests and tools: no crates, the classic "everything must go"
            // victory and every slot at its own spawn, so scenarios stay as
            // they are set up. The lobby defaults (OpenRA's: crates, short
            // game and separate team spawns on) come from packages/protocol
            // and `parse_options`.
            crates: false,
            short_game: false,
            time_limit: 0,
            tick_ms: 40,
            bounty: false,
            separate_team_spawns: false,
            ally_build_radius: true,
            reusable_engineers: false,
            movement: crate::movement::MovementModel::OpenRA,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum StartingUnits {
    /// Just a Mobile Construction Vehicle (OpenRA default).
    Mcv,
    /// MCV plus a few soldiers and a light vehicle.
    Light,
    /// MCV plus a stronger escort.
    Heavy,
    /// An already deployed Construction Yard.
    Base,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum AiDifficulty {
    Easy,
    Normal,
    Hard,
}

pub struct PlayerSetup {
    pub faction: String,
    pub ai: Option<AiDifficulty>,
    /// The OpenRA bot an AI slot plays (ai_bots.rs); ignored for humans.
    pub bot: crate::ai_bots::BotType,
    /// 0: no team (free for all); equal non-zero teams are allies.
    pub team: u8,
    /// OpenRA handicap in percent (0..95, steps of 5): less firepower and
    /// armour, slower production (gamerules.rs).
    pub handicap: u8,
    /// The spawn the player picked in the lobby (OpenRA's lobby spawn
    /// selection, Session.Client.SpawnPoint, here 0-based), or None for the
    /// lobby's automatic choice (gamerules.rs `assign_spawns`).
    pub spawn: Option<u8>,
}

impl PlayerSetup {
    pub fn new(faction: &str, ai: Option<AiDifficulty>) -> PlayerSetup {
        PlayerSetup { faction: faction.to_string(), ai, bot: crate::ai_bots::BotType::Normal, team: 0, handicap: 0, spawn: None }
    }
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(tag = "o", rename_all = "snake_case", deny_unknown_fields)]
pub enum Order {
    Move {
        player: u8,
        ids: Vec<u32>,
        x: i32,
        y: i32,
        attack_move: bool,
    },
    Smart {
        player: u8,
        ids: Vec<u32>,
        x: i32,
        y: i32,
    },
    Attack {
        player: u8,
        ids: Vec<u32>,
        target: u32,
    },
    Stop {
        player: u8,
        ids: Vec<u32>,
    },
    StartProduction {
        player: u8,
        ty: u16,
        count: i32,
    },
    CancelProduction {
        player: u8,
        ty: u16,
    },
    /// Put the first queued item of `ty` on hold or resume it (OpenRA PauseProduction).
    PauseProduction {
        player: u8,
        ty: u16,
        paused: bool,
    },
    Place {
        player: u8,
        ty: u16,
        cx: i32,
        cy: i32,
    },
    Rally {
        player: u8,
        building: u32,
        x: i32,
        y: i32,
    },
    Sell {
        player: u8,
        building: u32,
    },
    /// Deploy an MCV into a Construction Yard, or pack a Construction Yard up.
    /// Helicopters land where they hover, or take off again.
    Deploy {
        player: u8,
        ids: Vec<u32>,
    },
    /// Helicopters: land on (or next to) a cell.
    Land {
        player: u8,
        ids: Vec<u32>,
        x: i32,
        y: i32,
    },
    /// Aircraft: fly back to a free rearm structure (helipad) and resupply.
    ReturnToBase {
        player: u8,
        ids: Vec<u32>,
    },
    /// Fire a support power (powers.rs) at (x, y); (x2, y2) optionally sets a
    /// direction (the flight direction of aircraft powers).
    SupportPower {
        player: u8,
        key: String,
        x: i32,
        y: i32,
        // Left out when there is none: the protocol (packages/protocol
        // validOrder) and every client's LocalDriver check orders, and a
        // plain click (the atom bomb, the Iron Curtain) has no direction.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        x2: Option<i32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        y2: Option<i32>,
    },
    /// Minelayers mine the cell rectangle (x0, y0)-(x1, y1) (abilities.rs).
    LayMines {
        player: u8,
        ids: Vec<u32>,
        x0: i32,
        y0: i32,
        x1: i32,
        y1: i32,
    },
    /// Chrono tanks teleport to a world position (abilities.rs).
    Teleport {
        player: u8,
        ids: Vec<u32>,
        x: i32,
        y: i32,
    },
    /// Fire at a spot on the ground until told otherwise (OpenRA force-fire, Ctrl+click).
    AttackGround {
        player: u8,
        ids: Vec<u32>,
        x: i32,
        y: i32,
    },
    /// Follow an own or allied unit and fight what comes near (OpenRA Guard).
    Guard {
        player: u8,
        ids: Vec<u32>,
        target: u32,
    },
    /// Each unit moves to a random free neighbouring cell (OpenRA Scatter).
    Scatter {
        player: u8,
        ids: Vec<u32>,
    },
    /// Move there after the current orders (OpenRA queued move, Shift+click).
    Waypoint {
        player: u8,
        ids: Vec<u32>,
        x: i32,
        y: i32,
        attack_move: bool,
    },
    /// Fire stance of units and defences (OpenRA UnitStance).
    SetStance {
        player: u8,
        ids: Vec<u32>,
        stance: Stance,
    },
    /// Start or stop repairing an own or allied structure (the sidebar's
    /// Repair button, OpenRA RepairableBuilding; repair.rs).
    RepairBuilding {
        player: u8,
        building: u32,
    },
    /// Switch an own structure off or on again (the sidebar's Power down
    /// button, OpenRA ToggleConditionOnOrder; repair.rs).
    PowerDown {
        player: u8,
        building: u32,
    },
    /// Mark a spot on the map for the player's allies (OpenRA PlaceBeacon; beacons.rs).
    PlaceBeacon {
        player: u8,
        x: i32,
        y: i32,
    },
    /// Give up: the player loses at once (OpenRA's in-game menu Surrender,
    /// the "Surrender" order MissionObjectives.ResolveOrder turns into
    /// ForceDefeat; gamerules.rs `surrender`).
    Surrender {
        player: u8,
    },
    /// Debug menu: switch one of the player's cheat flags (debug.rs). Ignored
    /// unless the game has the cheats option.
    DevFlag {
        player: u8,
        flag: crate::debug::DevFlag,
        on: bool,
    },
    /// Debug menu: give the player cash (debug.rs). Ignored without cheats.
    DevCash {
        player: u8,
    },
    /// Debug menu: destroy actors of any owner (debug.rs). Ignored without cheats.
    DevKill {
        player: u8,
        ids: Vec<u32>,
    },
    /// Debug menu: raise the player's own listed units one veterancy level
    /// (OpenRA's "level up" debug order, veterancy.rs). Ignored without cheats.
    DevExperience {
        player: u8,
        ids: Vec<u32>,
    },
}

impl Order {
    /// Issuing player of this order.
    /// Debug menu cheat orders (debug.rs): they only work in games with the cheats option.
    pub fn is_cheat(&self) -> bool {
        matches!(self, Order::DevFlag { .. } | Order::DevCash { .. } | Order::DevKill { .. } | Order::DevExperience { .. })
    }

    pub fn player(&self) -> u8 {
        match self {
            Order::Move { player, .. }
            | Order::Smart { player, .. }
            | Order::Attack { player, .. }
            | Order::Stop { player, .. }
            | Order::StartProduction { player, .. }
            | Order::CancelProduction { player, .. }
            | Order::PauseProduction { player, .. }
            | Order::Place { player, .. }
            | Order::Rally { player, .. }
            | Order::Sell { player, .. }
            | Order::Deploy { player, .. }
            | Order::Land { player, .. }
            | Order::ReturnToBase { player, .. }
            | Order::SupportPower { player, .. }
            | Order::LayMines { player, .. }
            | Order::Teleport { player, .. }
            | Order::AttackGround { player, .. }
            | Order::Guard { player, .. }
            | Order::Scatter { player, .. }
            | Order::Waypoint { player, .. }
            | Order::SetStance { player, .. }
            | Order::RepairBuilding { player, .. }
            | Order::PowerDown { player, .. }
            | Order::PlaceBeacon { player, .. }
            | Order::Surrender { player }
            | Order::DevFlag { player, .. }
            | Order::DevCash { player }
            | Order::DevKill { player, .. }
            | Order::DevExperience { player, .. } => *player,
        }
    }

    /// Replace the issuing player (the multiplayer server decides who sent an order).
    pub fn set_player(&mut self, p: u8) {
        match self {
            Order::Move { player, .. }
            | Order::Smart { player, .. }
            | Order::Attack { player, .. }
            | Order::Stop { player, .. }
            | Order::StartProduction { player, .. }
            | Order::CancelProduction { player, .. }
            | Order::PauseProduction { player, .. }
            | Order::Place { player, .. }
            | Order::Rally { player, .. }
            | Order::Sell { player, .. }
            | Order::Deploy { player, .. }
            | Order::Land { player, .. }
            | Order::ReturnToBase { player, .. }
            | Order::SupportPower { player, .. }
            | Order::LayMines { player, .. }
            | Order::Teleport { player, .. }
            | Order::AttackGround { player, .. }
            | Order::Guard { player, .. }
            | Order::Scatter { player, .. }
            | Order::Waypoint { player, .. }
            | Order::SetStance { player, .. }
            | Order::RepairBuilding { player, .. }
            | Order::PowerDown { player, .. }
            | Order::PlaceBeacon { player, .. }
            | Order::Surrender { player }
            | Order::DevFlag { player, .. }
            | Order::DevCash { player }
            | Order::DevKill { player, .. }
            | Order::DevExperience { player, .. } => *player = p,
        }
    }

    /// Bound the size of id lists so one order cannot carry unbounded work.
    pub fn is_reasonable(&self) -> bool {
        const MAX_IDS: usize = 2000;
        match self {
            Order::Move { ids, .. }
            | Order::Smart { ids, .. }
            | Order::Attack { ids, .. }
            | Order::Stop { ids, .. }
            | Order::Deploy { ids, .. }
            | Order::Land { ids, .. }
            | Order::ReturnToBase { ids, .. }
            | Order::Teleport { ids, .. }
            | Order::AttackGround { ids, .. }
            | Order::Guard { ids, .. }
            | Order::Scatter { ids, .. }
            | Order::Waypoint { ids, .. }
            | Order::SetStance { ids, .. }
            | Order::DevKill { ids, .. }
            | Order::DevExperience { ids, .. } => ids.len() <= MAX_IDS,
            Order::LayMines { ids, x0, y0, x1, y1, .. } => {
                let area = ((*x1 as i64 - *x0 as i64).abs() + 1) * ((*y1 as i64 - *y0 as i64).abs() + 1);
                ids.len() <= MAX_IDS && area <= crate::abilities::MAX_MINEFIELD_CELLS as i64
            }
            Order::StartProduction { count, .. } => (1..=50).contains(count),
            Order::SupportPower { key, .. } => key.len() <= 64,
            _ => true,
        }
    }

    /// Units this order gives a new command, which replaces their queued
    /// waypoints and ends guarding. Waypoints add to the queue and stances do
    /// not change what a unit is doing, so they keep both.
    fn commanded_ids(&self) -> Option<&[u32]> {
        match self {
            Order::Move { ids, .. }
            | Order::Smart { ids, .. }
            | Order::Attack { ids, .. }
            | Order::Stop { ids, .. }
            | Order::Deploy { ids, .. }
            | Order::Land { ids, .. }
            | Order::ReturnToBase { ids, .. }
            | Order::LayMines { ids, .. }
            | Order::Teleport { ids, .. }
            | Order::AttackGround { ids, .. }
            | Order::Guard { ids, .. }
            | Order::Scatter { ids, .. } => Some(ids),
            Order::Waypoint { .. }
            | Order::SetStance { .. }
            | Order::StartProduction { .. }
            | Order::CancelProduction { .. }
            | Order::PauseProduction { .. }
            | Order::Place { .. }
            | Order::Rally { .. }
            | Order::Sell { .. }
            | Order::SupportPower { .. }
            | Order::RepairBuilding { .. }
            | Order::PowerDown { .. }
            | Order::PlaceBeacon { .. }
            | Order::Surrender { .. }
            | Order::DevFlag { .. }
            | Order::DevCash { .. }
            | Order::DevKill { .. }
            | Order::DevExperience { .. } => None,
        }
    }
}

/// What a smart (right-click) order would do at a position.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum SmartAction {
    None = 0,
    Move = 1,
    Attack = 2,
    Harvest = 3,
    Dock = 4,
    Repair = 5,
    /// Get into an own transport (cargo.rs).
    Load = 6,
    /// Supply truck onto an own or allied structure (abilities.rs).
    DeliverCash = 7,
    // ---- Infantry (infantry.rs) ----
    /// Engineer, thief or mechanic takes the target over (cursor `enter`).
    Capture = 8,
    /// Spy or thief gets in (cursor `enter`).
    Infiltrate = 9,
    /// Tanya plants C4 (cursor `c4`).
    Demolish = 10,
    /// Engineer repairs an own or allied structure, or a bridge (cursor `goldwrench`).
    InstantRepair = 11,
    /// Medic heals (cursor `heal`).
    Heal = 12,
    /// Mechanic repairs a vehicle (cursor `repair`).
    Fix = 13,
    /// Spy takes the target's looks (cursor `ability`).
    Disguise = 14,
    /// Capturable target that cannot be taken now (cursor `enter-blocked`).
    EnterBlocked = 15,
    /// Engineer over an undamaged own structure (cursor `goldwrench-blocked`).
    RepairBlocked = 16,
    /// Reusable engineer captures from outside (Captures@REUSABLE EnterCursor `ability`).
    CaptureOutside = 17,
    /// A move to explored terrain none of the units can drive on (OpenRA
    /// Mobile MoveOrderTargeter BlockedCursor `move-blocked`); still a move order.
    MoveBlocked = 18,
}

#[derive(Clone)]
pub struct World {
    pub rules: Rules,
    pub map: Map,
    /// Passability for land units.
    pub pass: Passability,
    /// Passability for ships.
    pub pass_water: Passability,
    /// Passability for landing craft (the Transport): ships' water and beaches.
    pub pass_landing: Passability,
    pub flow: FlowCache,
    pub actors: Vec<Actor>,
    free: Vec<u32>,
    /// Actor index occupying each cell's footprint (buildings only), or NONE.
    pub building_at: Vec<u32>,
    pub players: Vec<Player>,
    pub projectiles: Vec<Projectile>,
    pub effects: Vec<Effect>,
    pub tick: u32,
    pub rng: Rng,
    orders: Vec<Order>,
    pub(crate) dying: Vec<u32>,
    // Spatial hash of units by cell, rebuilt every tick (counting sort).
    pub(crate) hash_start: Vec<u32>,
    pub(crate) hash_items: Vec<u32>,
    pub terrain_dirty: bool,
    /// Per actor: pressed against a friendly unit that moved in the last
    /// crowd separation, so it waits in a queue rather than being blocked for
    /// good (units.rs).
    pub(crate) jammed: Vec<bool>,
    /// The service depots' lines, gathered once a tick (service.rs; derived, not hashed).
    pub(crate) svc_index: crate::service::ServiceIndex,
    /// This tick's answers of `keep_goal_reachable` (units.rs): goal cell,
    /// connectivity label, passability (0 ground, 1 water, 2 landing
    /// craft), crush mask, and the cell found. A cut-off group asks the
    /// same question once per unit; the answer only depends on these.
    pub(crate) retarget_memo: Vec<(u32, u32, u8, u8, u32)>,
    /// Which units hold which cells (OpenRA movement model, movement/occupancy.rs).
    pub(crate) occupancy: crate::movement::occupancy::Occupancy,
    /// Bookkeeping of the route searches (movement/search.rs); never game state.
    pub search: crate::movement::search::Scratch,
    /// Salt of the per-tick ranks of units that want the same cell
    /// (movement/cellmove.rs `claim_rank`), from the game seed.
    pub(crate) claim_salt: u64,
    /// Nearest-cell searches run by `keep_goal_reachable` (a counter for
    /// tests, never part of the state hash).
    pub retarget_scans: u64,
    pub tokens_dirty: bool,
    next_group: u32,
    pub ai: Vec<crate::ai::AiState>,
    pub winner: Option<u8>,
    pub circle_cache: Vec<Vec<(i32, i32)>>,
    pub stress: bool,
    /// While a map's actors are placed (`place_map_actors`, missions):
    /// structures, bridge terrain and husks mark their cells but the
    /// connectivity labels are recomputed once at the end (nothing in
    /// between reads them), not three times per actor. Never part of the
    /// state hash.
    pub(crate) placing_map_actors: bool,
    /// Open cells holding ore or gems per ground connectivity label, as of
    /// `reach_counts_labels` (the AI's reachable ore, ai_economy.rs; stale
    /// at `u32::MAX`). Never part of the state hash.
    pub(crate) reach_counts: Vec<u32>,
    pub(crate) reach_counts_labels: u32,
    /// Actors destroyed so far, per owner.
    pub losses: Vec<u32>,
    pub pending: Vec<PendingImpact>,
    pub options: GameOptions,
    /// Ability and support power state (abilities.rs).
    pub abil: crate::abilities::AbilityState,
    /// Infantry state: power outages, sonar pulses, delayed shots, corpses (infantry.rs).
    pub inf: crate::infantry::InfantryWorld,
    /// Helicopters falling after being shot down (helicopter.rs).
    pub crashes: Vec<crate::helicopter::Crash>,
    /// Support power timers, cameras and falling bombs (powers.rs).
    pub powers: crate::powers::PowersState,
    /// Biome and weather (weather.rs).
    pub env: crate::weather::Environment,
    /// Write-only audio event log for the client (sound_events.rs).
    pub sound: crate::sound_events::SoundEvents,
    /// Production doors (doors.rs): presentation only, never read by the
    /// simulation and not part of `state_hash`.
    pub doors: crate::doors::Doors,
    /// Client render settings (overlays.rs); never read by the simulation
    /// (the production doors read them, presentation only: doors.rs).
    pub render_opts: crate::overlays::RenderOptions,
    /// Observer statistics (observer.rs). Not part of `state_hash`.
    pub observer: crate::observer::ObserverStats,
    /// Render only (observer.rs): while true, visibility helpers report
    /// everything as visible. Set by `Game::build_render` for the spectator
    /// view for the duration of that call; always false while `step` runs.
    pub render_all: bool,
    /// Render only (combined.rs): slot 0 holds every player's vision for the
    /// spectator "All players" view; decorations follow the spectator rules.
    pub render_combined: bool,
    /// Map beacons players placed for their allies (beacons.rs).
    pub beacons: crate::beacons::Beacons,
    /// The neutral world: bridges, husks to spawn, the neutral player (neutral.rs, bridges.rs).
    pub neutral: crate::neutral::NeutralState,
    /// Crate spawner and crate delivery flights (crates.rs).
    pub crates: crate::crates::CrateState,
    /// Scorch marks and craters (smudges.rs): presentation only, never read
    /// by the simulation and not part of `state_hash`.
    pub smudges: crate::smudges::Smudges,
    /// The husk and the crate of every cell (husks.rs, crates.rs).
    pub leftover_at: crate::husks::LeftoverCells,
    /// The game ended (a winner was decided, or every remaining player lost
    /// at once: the time limit can end a game without a winner; gamerules.rs).
    pub game_over: bool,
    /// The mission this world plays (mission/), with its scripts.
    pub mission: Option<Box<crate::mission::Mission>>,
    /// A mission runs: engine events are recorded for its triggers.
    pub(crate) mission_on: bool,
    pub(crate) script_events: Vec<crate::mission::ScriptEvent>,
    /// A mission map's structures beyond its playable area (mission/mod.rs `OffMapStructure`).
    pub offmap: Vec<crate::mission::OffMapStructure>,
    /// Who dealt the blow of the kill in progress (mission OnKilled triggers).
    pub(crate) kill_source: u32,
    /// Missions: each player's stance toward each other player
    /// (`mission::setup` ALLY, NEUTRAL, ENEMY), row major. Empty: teams decide.
    pub diplomacy: Vec<u8>,
}

/// Spawn players of the map editor's preview (`World::editor_preview`):
/// the most a map has; its neutral player is the next slot.
pub const EDITOR_SLOTS: usize = 8;

/// Where a world's map came from (`World::setup`).
enum MapSource<'a> {
    /// Generated: its spawns are listed by column, top first, for fair team
    /// splits (gamerules.rs `assign_spawns`); with its neutral actors (ore
    /// mines, tech buildings and villages: mapgen/sites.rs, settlements.rs).
    Generated(&'a [crate::mapdata::MapActor]),
    /// A prepared map without actors (`World::on_map`).
    Prepared,
    /// A map file with its pre-placed actors.
    File(&'a [crate::mapdata::MapActor]),
}

impl World {
    /// Quick setup used by tests and tools: a deployed base each, default options.
    pub fn new(seed: u64, map_size: i32, factions: &[(&str, bool)]) -> World {
        let players: Vec<PlayerSetup> = factions.iter().map(|&(f, ai)| PlayerSetup::new(f, ai.then_some(AiDifficulty::Normal))).collect();
        World::with_options(seed, map_size, &players, GameOptions::default())
    }

    pub fn with_options(seed: u64, map_size: i32, players: &[PlayerSetup], options: GameOptions) -> World {
        let rules = Rules::load();
        let map = Map::generate_styled(map_size, map_size, seed, rules.player.ore_max_density, players.len(), options.map_style);
        let biome = options.biome.unwrap_or_else(|| crate::weather::Biome::random(seed));
        // Ore mines in the fields, tech buildings and villages (mapgen/sites.rs, settlements.rs).
        let actors = crate::mapgen::sites::world_actors(&map, &rules, biome, options.tech_buildings, seed);
        World::setup(rules, map, seed, players, options, MapSource::Generated(&actors), biome)
    }

    /// World on a prepared map with the default rules: players start at the
    /// map's spawns. Harnesses and tests use it for scenario maps (an open
    /// field for mirrored fights, say). Without a lobby biome the weather is
    /// temperate, so no snow or heat waves change a scenario.
    pub fn on_map(seed: u64, map: Map, players: &[PlayerSetup], options: GameOptions) -> World {
        let biome = options.biome.unwrap_or(crate::weather::Biome::Temperate);
        World::setup(Rules::load(), map, seed, players, options, MapSource::Prepared, biome)
    }

    /// World from a map file; rules overrides (modded maps) apply.
    pub fn from_map(data: &crate::mapdata::MapData, seed: u64, players: &[PlayerSetup], options: GameOptions) -> Result<World, String> {
        let v = data.validate();
        if !v.ok {
            return Err(v.errors.join("; "));
        }
        if players.len() > data.spawns.len() {
            return Err(format!("this map has {} spawns, {} players joined", data.spawns.len(), players.len()));
        }
        if let Some(problem) = crate::gamerules::spawn_pick_problem(players, data.spawns.len()) {
            return Err(problem);
        }
        let rules = Rules::load_with(data.rules())?;
        let map = data.to_map()?;
        Ok(World::setup(rules, map, seed, players, options, MapSource::File(&data.actors), data.biome))
    }

    fn setup(
        rules: Rules,
        map: Map,
        seed: u64,
        players: &[PlayerSetup],
        options: GameOptions,
        source: MapSource,
        biome: crate::weather::Biome,
    ) -> World {
        let (actors, generated) = match source {
            MapSource::Generated(actors) => (actors, true),
            MapSource::Prepared => (&[][..], false),
            MapSource::File(actors) => (actors, false),
        };
        let mut w = World::empty(rules, map, seed);
        w.options = options.clone();
        w.env = crate::weather::Environment::new(biome, options.weather, seed);
        let spawns = w.map.spawns.clone();
        // OpenRA MapStartingLocations: which spawn each player starts at (gamerules.rs).
        let order = crate::gamerules::assign_spawns(&spawns, players, options.separate_team_spawns, generated);
        for (slot, p) in players.iter().enumerate() {
            let fi = w.rules.faction_index(&p.faction).unwrap_or_else(|| panic!("unknown faction {}", p.faction));
            w.add_player(fi, p.ai.is_some(), spawns[order[slot]]);
            w.players[slot].cash = options.starting_cash;
            w.players[slot].team = p.team;
            // An Easy AI plays with an extra handicap (ai_bots.rs).
            let extra = p.ai.map_or(0, |d| crate::ai_bots::Difficulty(d).handicap());
            w.players[slot].handicap = i32::from(p.handicap.saturating_add(extra).min(crate::gamerules::MAX_HANDICAP));
            if options.explored {
                w.players[slot].explored.iter_mut().for_each(|e| *e = 1);
            }
        }
        w.ai = players
            .iter()
            .enumerate()
            .map(|(slot, p)| crate::ai::AiState::new(&w.rules, slot as u8, p.bot, p.ai.unwrap_or(AiDifficulty::Normal)))
            .collect();
        for a in w.ai.iter_mut() {
            a.salt = seed.wrapping_mul(0x9E37_79B9_7F4A_7C15).wrapping_add(1);
        }
        for slot in 0..players.len() {
            w.spawn_start(slot as u8);
        }
        // Pre-placed map actors. Those of empty spawns are skipped; neutral
        // ones (and the trees of tree terrain, neutral.rs) belong to an
        // extra, passive player. Crates and their delivery planes belong to
        // that player too (OpenRA's world owner, crates.rs).
        let trees = w.map.terrain.contains(&crate::map::Terrain::Tree);
        if actors.iter().any(|a| a.owner < 0) || options.crates || trees {
            let fi = w.rules.faction_index("allies").unwrap();
            w.add_player(fi, false, (0, 0));
            let n = w.players.len() - 1;
            w.players[n].neutral = true;
            w.players[n].cash = 0;
            let neutral_ai = crate::ai::AiState::new(&w.rules, n as u8, crate::ai_bots::BotType::Normal, AiDifficulty::Easy);
            w.ai.push(neutral_ai);
        }
        let neutral = w.players.len() as u8 - 1;
        w.crates = crate::crates::CrateState::new(&w.rules, options.crates);
        w.place_map_actors(actors, players.len(), neutral);
        w
    }

    /// Place a map file's pre-placed actors (owners of `players` spawns,
    /// neutral ones to `neutral`; those of empty spawns are skipped), then
    /// the trees of tree terrain and the bridges (neutral.rs, bridges.rs).
    /// A unit the map puts on a structure's cell stays there, as in OpenRA
    /// (no placement check), and walks off when it moves (`nearest_reachable`,
    /// movement/cellmove.rs `route_next`). The connectivity labels are
    /// recomputed once for all of them (`placing_map_actors`): a large map
    /// with hundreds of trees, mines and derricks would otherwise relabel
    /// every cell three times per structure.
    fn place_map_actors(&mut self, actors: &[crate::mapdata::MapActor], players: usize, neutral: u8) {
        self.placing_map_actors = true;
        for a in actors {
            let owner = if a.owner < 0 { neutral } else { a.owner as u8 };
            if a.owner >= players as i32 {
                continue;
            }
            let Some(ty) = self.rules.actor_index(&a.ty) else { continue };
            let placed = match self.rules.actors[ty].kind {
                // Proxies (infantry.rs) have no body to place.
                Kind::Proxy => None,
                Kind::Building => self.spawn_building(ty as u16, owner, a.x, a.y),
                // Crates and husks keep their cell (crates.rs, husks.rs).
                Kind::Crate => {
                    if self.crate_at(self.map.idx(a.x, a.y)).is_none() {
                        self.place_crate(ty, owner, a.x, a.y, 0);
                    }
                    None
                }
                Kind::Husk => Some(self.place_husk(ty, owner, cell_center(a.x), cell_center(a.y), a.facing.rem_euclid(1024), 0)),
                _ => self
                    .map_unit_cell(ty, a.x, a.y)
                    .map(|(x, y)| self.spawn_unit(ty as u16, owner, cell_center(x), cell_center(y), a.facing.rem_euclid(1024))),
            };
            if let Some(i) = placed {
                self.apply_map_actor_state(i, a);
            }
        }
        // The trees of tree terrain, the bridges (their terrain too) and
        // husks mark their cells as well; the one relabelling of all cells
        // is `update_world_terrain` in `setup_neutral`.
        self.setup_neutral();
        self.placing_map_actors = false;
        self.refresh_tokens();
        self.update_power();
        self.update_vision();
    }

    /// The state a map gives a pre-placed actor (map format version 2,
    /// mapdata.rs): health in percent of its hit points, its fire stance,
    /// veterancy levels (quietly: no level-up sound or effect at the start)
    /// and passengers, made and put inside at once. What does not apply to
    /// the actor is left out (the map's validation refuses it; the editor's
    /// preview shows maps that are not valid yet).
    fn apply_map_actor_state(&mut self, i: usize, a: &crate::mapdata::MapActor) {
        let ty = self.actors[i].ty as usize;
        let max_hp = self.rules.actors[ty].hp;
        if (1..100).contains(&a.health) {
            self.actors[i].hp = (max_hp as i64 * a.health as i64 / 100).max(1) as i32;
        }
        if let Some(stance) = a.stance.as_deref().and_then(|s| crate::rules::Stance::ALL.iter().copied().find(|x| x.name() == s)) {
            if self.has_stance(i) {
                self.actors[i].stance = stance;
            }
        }
        let levels = (a.veterancy.max(0) as usize).min(self.max_rank(i) as usize);
        if levels > 0 {
            self.actors[i].xp = self.level_experience(i, levels);
            self.actors[i].rank = levels as u8;
        }
        if a.cargo.is_empty() || !self.is_transport(i) {
            return;
        }
        let (x, y, owner) = (self.actors[i].x, self.actors[i].y, self.actors[i].owner);
        for p in &a.cargo {
            let Some(pt) = self.rules.actor_index(p) else { continue };
            if !matches!(self.rules.actors[pt].kind, Kind::Infantry | Kind::Vehicle) {
                continue;
            }
            let passenger = self.spawn_unit(pt as u16, owner, x, y, 0);
            if !self.load_passenger(i, passenger) {
                self.remove(passenger);
            }
        }
    }

    /// The map editor's picture of a map file (apps/game/editor): the world a
    /// game on it starts with, drawn by the game's renderer, so the editor
    /// shows the map's actors, the trees of tree terrain and the bridges
    /// exactly as the game does. The map is not validated (the editor shows
    /// maps while they are being made) and nobody plays: `EDITOR_SLOTS`
    /// passive players stand at the spawns without starting units, the
    /// neutral player follows them. Rules overrides that do not load fall
    /// back to the base rules (the editor reports them). Never simulated.
    pub fn editor_preview(data: &crate::mapdata::MapData) -> Result<World, String> {
        let rules = Rules::load_with(data.rules()).unwrap_or_else(|_| Rules::load());
        let map = data.to_map()?;
        let mut w = World::empty(rules, map, 0);
        w.env = crate::weather::Environment::new(data.biome, GameOptions::default().weather, 0);
        let faction = w.rules.faction_index("allies").expect("built-in faction");
        for k in 0..EDITOR_SLOTS {
            let start = w.map.spawns.get(k).copied().unwrap_or((0, 0));
            w.add_player(faction, false, start);
        }
        w.add_player(faction, false, (0, 0));
        let neutral = EDITOR_SLOTS as u8;
        w.players[neutral as usize].neutral = true;
        w.crates = crate::crates::CrateState::new(&w.rules, false);
        // Actors off the map (an invalid file) are left out; the editor lists them.
        let inside: Vec<crate::mapdata::MapActor> = data.actors.iter().filter(|a| w.map.contains(a.x, a.y)).cloned().collect();
        w.place_map_actors(&inside, EDITOR_SLOTS, neutral);
        Ok(w)
    }

    pub(crate) fn empty(rules: Rules, map: Map, seed: u64) -> World {
        let pass = Passability::new(&map);
        let pass_water = Passability::water(&map);
        let pass_landing = Passability::landing(&map);
        let cells = map.cells();
        World {
            rules,
            pass,
            pass_water,
            pass_landing,
            flow: FlowCache::new(),
            actors: Vec::new(),
            free: Vec::new(),
            building_at: vec![NONE; cells],
            players: Vec::new(),
            projectiles: Vec::new(),
            effects: Vec::new(),
            tick: 0,
            rng: Rng::new(seed.wrapping_mul(31).wrapping_add(7)),
            orders: Vec::new(),
            dying: Vec::new(),
            hash_start: vec![0; cells + 1],
            hash_items: Vec::new(),
            terrain_dirty: true,
            jammed: Vec::new(),
            svc_index: Default::default(),
            retarget_memo: Vec::new(),
            occupancy: Default::default(),
            search: Default::default(),
            claim_salt: seed.wrapping_mul(0xD1B5_4A32_D192_ED03),
            retarget_scans: 0,
            tokens_dirty: true,
            next_group: 1,
            ai: Vec::new(),
            winner: None,
            circle_cache: Vec::new(),
            stress: false,
            placing_map_actors: false,
            reach_counts: Vec::new(),
            reach_counts_labels: u32::MAX,
            losses: Vec::new(),
            pending: Vec::new(),
            options: GameOptions::default(),
            abil: Default::default(),
            inf: Default::default(),
            crashes: Vec::new(),
            powers: Default::default(),
            env: Default::default(),
            sound: Default::default(),
            doors: Default::default(),
            render_opts: Default::default(),
            observer: Default::default(),
            render_all: false,
            render_combined: false,
            beacons: Default::default(),
            neutral: Default::default(),
            crates: Default::default(),
            smudges: crate::smudges::Smudges::new(cells),
            game_over: false,
            leftover_at: crate::husks::LeftoverCells::new(cells),
            mission: None,
            mission_on: false,
            script_events: Vec::new(),
            offmap: Vec::new(),
            kill_source: NONE,
            diplomacy: Vec::new(),
            map,
        }
    }

    pub(crate) fn add_player(&mut self, faction: usize, is_ai: bool, start: (i32, i32)) {
        let cells = self.map.cells();
        let side = self.rules.side_of(faction);
        self.losses.push(0);
        self.players.push(Player {
            faction,
            side,
            cash: self.rules.player.starting_cash,
            resources: 0,
            storage: 0,
            power_gen: 0,
            power_use: 0,
            tokens: vec![false; self.rules.tokens.len()],
            queues: Default::default(),
            visible: vec![0; cells],
            explored: vec![0; cells],
            ghosts: BTreeMap::new(),
            is_ai,
            defeated: false,
            start,
            team: 0,
            neutral: false,
            dev: Default::default(),
            proxies: Vec::new(),
            handicap: 0,
            experience: 0,
        });
    }

    /// Hostile players: different players that are not on the same team and not neutral.
    #[inline]
    pub fn are_enemies(&self, a: u8, b: u8) -> bool {
        if a == b {
            return false;
        }
        let (pa, pb) = (&self.players[a as usize], &self.players[b as usize]);
        if !self.diplomacy.is_empty() {
            return self.diplomacy[a as usize * self.players.len() + b as usize] == crate::mission::setup::ENEMY;
        }
        !pa.neutral && !pb.neutral && (pa.team == 0 || pa.team != pb.team)
    }

    #[inline]
    pub fn are_allies(&self, a: u8, b: u8) -> bool {
        if !self.diplomacy.is_empty() {
            return a == b || self.diplomacy[a as usize * self.players.len() + b as usize] == crate::mission::setup::ALLY;
        }
        a == b || (!self.are_enemies(a, b) && !self.players[a as usize].neutral && !self.players[b as usize].neutral)
    }

    /// OpenRA `Player.RelationshipWith`: how `b` stands to `a` (a player is
    /// its own ally; neither allied nor hostile is neutral).
    pub fn relationship(&self, a: u8, b: u8) -> Relationship {
        if self.are_allies(a, b) {
            Relationship::Ally
        } else if self.are_enemies(a, b) {
            Relationship::Enemy
        } else {
            Relationship::Neutral
        }
    }

    /// Whether some players are allied to others (teams, or a mission's relations).
    pub fn has_alliances(&self) -> bool {
        !self.diplomacy.is_empty() || self.players.iter().any(|p| p.team != 0)
    }

    // ---- Actor references -------------------------------------------------

    #[inline]
    pub fn make_ref(&self, idx: usize) -> u32 {
        idx as u32 | ((self.actors[idx].gen & GEN_MASK) << IDX_BITS)
    }

    #[inline]
    pub fn resolve(&self, r: u32) -> Option<usize> {
        if r == NONE {
            return None;
        }
        let idx = (r & IDX_MASK) as usize;
        let a = self.actors.get(idx)?;
        if a.alive && (a.gen & GEN_MASK) == r >> IDX_BITS {
            Some(idx)
        } else {
            None
        }
    }

    fn alloc(&mut self) -> usize {
        if let Some(i) = self.free.pop() {
            i as usize
        } else {
            self.actors.push(Actor::blank());
            self.actors.len() - 1
        }
    }

    // ---- Spawning ----------------------------------------------------------

    pub fn spawn_unit(&mut self, ty: u16, owner: u8, x: i32, y: i32, facing: i32) -> usize {
        // The first auto-target scan comes after a random delay, like every
        // later one (combat.rs `scan_due`).
        let first_scan = self.rng.range(1, crate::combat::MAX_SCAN_TICKS);
        let i = self.alloc();
        let gen = self.actors[i].gen;
        let info = &self.rules.actors[ty as usize];
        let mut a = Actor::blank();
        a.alive = true;
        a.gen = gen;
        a.faction = self.players.get(owner as usize).map_or(0, |p| p.faction as u8);
        a.kind = info.kind;
        a.ty = ty;
        a.owner = owner;
        a.x = x;
        a.y = y;
        a.px = x;
        a.py = y;
        a.facing = facing;
        a.turret = facing;
        a.pfacing = facing;
        a.pturret = facing;
        a.hp = info.hp;
        a.scan_cooldown = first_scan;
        // Aircraft enter the world flying at their cruise altitude.
        a.altitude = info.unit.as_ref().and_then(|u| u.aircraft.as_ref()).map_or(0, |ac| ac.cruise_altitude);
        if info.unit.as_ref().is_some_and(|u| u.harvester.is_some()) {
            a.activity = Activity::Harvest;
            a.harv = HarvState::Search;
        }
        // Cloaked actors (submarines) hide after their InitialDelay.
        a.cloak_timer = info.abilities.cloak.as_ref().map_or(0, |c| c.initial_delay);
        a.stance = self.initial_stance(ty, owner);
        a.born = self.tick;
        self.actors[i] = a;
        self.init_abilities(i);
        self.init_world_traits(i);
        // ProducibleWithLevel (infantry.rs).
        self.on_created(i);
        i
    }

    /// Put a structure with its top-left at (cx, cy). Returns None, and
    /// changes nothing, when `ty` is not a structure, its footprint does not
    /// fit inside the map (every footprint cell of a live structure indexes
    /// the cell tables) or another structure already covers one of its cells
    /// (each cell has one owner in `building_at`).
    pub fn spawn_building(&mut self, ty: u16, owner: u8, cx: i32, cy: i32) -> Option<usize> {
        self.spawn_building_with(ty, owner, cx, cy, true, false)
    }

    /// `spawn_building`; `free_actor` false leaves out a refinery's free ore
    /// truck (OpenRA FreeActorInit false, set by mission maps). With
    /// `overlap`, cells another structure already holds stay that one's
    /// (OpenRA spawns map actors without a placement check: a mission's
    /// church may stand on a fence).
    pub fn spawn_building_with(&mut self, ty: u16, owner: u8, cx: i32, cy: i32, free_actor: bool, overlap: bool) -> Option<usize> {
        let info = self.rules.actors.get(ty as usize)?;
        let b = info.building.as_ref()?;
        if !b.fits(&self.map, cx, cy) || (!overlap && b.cells().any(|(dx, dy)| self.building_at[self.map.idx(cx + dx, cy + dy)] != NONE)) {
            return None;
        }
        let i = self.alloc();
        let gen = self.actors[i].gen;
        let info = &self.rules.actors[ty as usize];
        let b = info.building.as_ref()?;
        let mut a = Actor::blank();
        a.alive = true;
        a.gen = gen;
        a.kind = Kind::Building;
        a.ty = ty;
        a.owner = owner;
        a.faction = self.players.get(owner as usize).map_or(0, |p| p.faction as u8);
        a.cx = cx;
        a.cy = cy;
        a.x = cx * CELL + b.width * HALF_CELL;
        a.y = cy * CELL + b.height * HALF_CELL;
        a.px = a.x;
        a.py = a.y;
        a.hp = info.hp;
        a.stance = self.initial_stance(ty, owner);
        a.born = self.tick;
        let footprint = b.footprint.clone();
        let free_actor = b.refinery.as_ref().map(|r| (r.free_actor, r.free_actor_offset)).filter(|_| free_actor);
        let crush = info.abilities.crushable.as_ref().map_or(0, crate::flowfield::crush_bits);
        self.actors[i] = a;
        self.init_abilities(i);
        self.init_world_traits(i);
        for (dx, dy, c) in footprint {
            // Overlay cells (bridges and their huts) are not claimed.
            if matches!(c, FootCell::Empty | FootCell::Overlay) {
                continue;
            }
            // Checked by `fits` above.
            let ci = self.map.idx(cx + dx, cy + dy);
            if self.building_at[ci] != NONE {
                continue;
            }
            self.building_at[ci] = i as u32;
            if c == FootCell::Occupied {
                self.pass.set_blocked(ci, true);
                self.pass_water.set_blocked(ci, true);
                self.pass_landing.set_blocked(ci, true);
                // Walls tanks may drive over (neutral.rs).
                self.pass.set_crush(ci, crush);
            }
        }
        if !self.placing_map_actors {
            self.pass.refresh(&self.map);
            self.pass_water.refresh(&self.map);
            self.pass_landing.refresh(&self.map);
        }
        self.tokens_dirty = true;
        if let Some((ty, (ox, oy))) = free_actor {
            let (x, y) = (cell_center(cx + ox), cell_center(cy + oy));
            let h = self.spawn_unit(ty as u16, owner, x, y, 512);
            // The free ore truck belongs to its refinery: it starts on the
            // dock and leaves it while there is no ore (units.rs `dock_unblock_cell`).
            if self.is_harvester(h) {
                self.actors[h].refinery = self.make_ref(i);
            }
        }
        Some(i)
    }

    pub fn kill(&mut self, i: usize) {
        if !self.actors[i].alive {
            return;
        }
        // OpenRA EjectOnDeath: the pilot may bail out (plane.rs).
        self.eject_pilot(i);
        // Airborne planes fall first and die where they hit the ground (plane.rs).
        if self.begin_crash(i) {
            // Remember who shot it down; the kill counts at impact (observer.rs).
            self.note_shot_down(i);
            return;
        }
        let (x, y, kind) = (self.actors[i].x, self.actors[i].y, self.actors[i].kind);
        // A husk burns out or is shot to pieces (husks.rs): it just goes.
        if kind == Kind::Husk {
            self.actors[i].alive = false;
            self.actors[i].hp = 0;
            self.dying.push(i as u32);
            return;
        }
        // Kill bounty for the player that dealt the blow (gamerules.rs).
        self.give_bounty(i);
        // Mission triggers (OnKilled): the victim where it died and its killer.
        let killer = std::mem::replace(&mut self.kill_source, NONE);
        if self.mission_on {
            let (victim, snap) = (self.make_ref(i), crate::mission::Snapshot::of(self, i));
            self.script_events.push(crate::mission::ScriptEvent::Killed { victim, killer, snap });
        }
        self.actors[i].alive = false;
        self.actors[i].hp = 0;
        self.losses[self.actors[i].owner as usize] += 1;
        self.record_death(i);
        self.dying.push(i as u32);
        let (ty, owner) = (self.actors[i].ty as i32, self.actors[i].owner);
        // The death sequence (infantry.rs) picks the scream: b = kind | sequence << 8.
        let death = (self.actors[i].inf.death as i32) << 8;
        self.sound.push(SoundEventKind::Death, ty, x, y, owner, kind_code(kind) | death);
        // A dying soldier for the renderer (infantry_combat.rs).
        self.infantry_died(i);
        // Structures shake the screen as they go (OpenRA ShakeOnDeath, presentation).
        if let Some((duration, intensity)) = self.rules.actors[ty as usize].options.shake_on_death {
            self.sound.push(SoundEventKind::ScreenShake, duration, x, y, 1 + 16, intensity);
        }
        // Helicopters shot down in flight fall and explode on impact (helicopter.rs).
        if self.begin_heli_crash(i) {
            // Passengers go down with it (cargo.rs).
            self.cargo_on_death(i);
            return;
        }
        let effect = if kind == Kind::Infantry { EffectKind::Piff } else { EffectKind::LargeExplosion };
        // Long enough for OpenRA's self_destruct explosion (art-exp1.shp, 22 frames at one per tick).
        let ttl = if kind == Kind::Building { 30 } else { 22 };
        // A death weapon with explosions shows those instead (death_explosion, fx.rs).
        if kind == Kind::Infantry || !self.has_death_explosions(i) {
            self.effects.push(Effect { x, y, tx: x, ty: y, kind: effect, ttl, max: ttl });
        }
        if kind == Kind::Ship {
            self.ship_death_effect(i);
        }
        self.death_explosion(i);
        // Further death weapons and husks (neutral.rs).
        self.on_world_killed(i);
        // Ground vehicles leave a husk (husks.rs, OpenRA SpawnActorOnDeath).
        self.spawn_husk(i);
        // Passengers die with their transport, or get out (Cargo.EjectOnDeath).
        self.cargo_on_death(i);
    }

    /// Remove an actor without it dying (sold, deployed, packed up).
    pub fn remove(&mut self, i: usize) {
        if !self.actors[i].alive {
            return;
        }
        if self.mission_on {
            let (actor, snap) = (self.make_ref(i), crate::mission::Snapshot::of(self, i));
            self.script_events.push(crate::mission::ScriptEvent::Removed { actor, snap });
        }
        self.actors[i].alive = false;
        self.dying.push(i as u32);
        // Passengers get out (Cargo.EjectOnSell).
        self.cargo_on_remove(i);
    }

    /// Free storage and cells of actors killed this tick.
    pub(crate) fn cleanup_dead(&mut self) {
        let dying = std::mem::take(&mut self.dying);
        for i in dying {
            let i = i as usize;
            let a = self.actors[i].clone();
            if a.kind == Kind::Building {
                let b = self.rules.actors[a.ty as usize].building.as_ref().unwrap();
                for &(dx, dy, c) in &b.footprint {
                    if c == FootCell::Empty {
                        continue;
                    }
                    let ci = self.map.idx(a.cx + dx, a.cy + dy);
                    if self.building_at[ci] == i as u32 {
                        self.building_at[ci] = NONE;
                        self.pass.set_blocked(ci, !self.map.terrain[ci].passable());
                        self.pass_water.set_blocked(ci, !self.map.terrain[ci].ship_passable());
                        self.pass_landing.set_blocked(ci, !self.map.terrain[ci].landing_passable());
                        self.pass.set_crush(ci, 0);
                    }
                }
                self.tokens_dirty = true;
            }
            // A husk no longer blocks its cell (husks.rs).
            if a.kind == Kind::Husk {
                self.husk_cell_freed(i);
            }
            // A crate leaves its cell (crates.rs).
            if a.kind == Kind::Crate {
                self.crate_removed(i);
            }
            // Release a refinery dock this harvester held.
            if let Some(r) = self.resolve(a.refinery) {
                let me = idx_ref(i, a.gen);
                if self.actors[r].dock_user == me {
                    self.actors[r].dock_user = NONE;
                }
            }
            self.actors[i].gen = self.actors[i].gen.wrapping_add(1);
            self.free.push(i as u32);
        }
        self.pass.refresh(&self.map);
        self.pass_water.refresh(&self.map);
        self.pass_landing.refresh(&self.map);
    }

    // ---- Domains (ground, water, air) -----------------------------------------

    /// Movement domain of an actor (structures count as ground).
    pub fn domain_of(&self, i: usize) -> crate::rules::Domain {
        let info = &self.rules.actors[self.actors[i].ty as usize];
        info.unit.as_ref().map_or(crate::rules::Domain::Ground, |u| self.rules.locomotors[u.locomotor].domain)
    }

    /// Passability for a domain. Aircraft ignore it (callers check for Air first).
    pub fn pass_for(&self, d: crate::rules::Domain) -> &Passability {
        match d {
            crate::rules::Domain::Water => &self.pass_water,
            _ => &self.pass,
        }
    }

    /// Whether unit `i` is a landing craft: a ship whose locomotor also
    /// drives on beaches (OpenRA `lcraft`, TerrainSpeeds Beach: the Transport).
    pub fn lands(&self, i: usize) -> bool {
        self.type_lands(self.actors[i].ty as usize)
    }

    /// `lands` for actor type `ty`.
    pub fn type_lands(&self, ty: usize) -> bool {
        self.rules.actors[ty].unit.as_ref().is_some_and(|u| {
            let l = &self.rules.locomotors[u.locomotor];
            l.domain == crate::rules::Domain::Water && l.speeds.get(crate::map::SPEED_BEACH).is_some_and(|&s| s > 0)
        })
    }

    /// Passability for unit `i`: its domain's, or for landing craft water and beaches.
    pub fn pass_of(&self, i: usize) -> &Passability {
        self.pass_of_type(self.actors[i].ty as usize)
    }

    /// `pass_of` for actor type `ty` (structures get the ground's; aircraft ignore it).
    pub fn pass_of_type(&self, ty: usize) -> &Passability {
        if self.type_lands(ty) {
            return &self.pass_landing;
        }
        let domain =
            self.rules.actors[ty].unit.as_ref().map_or(crate::rules::Domain::Ground, |u| self.rules.locomotors[u.locomotor].domain);
        self.pass_for(domain)
    }

    /// Whether terrain `t` is open to the locomotor of unit type `ty`
    /// (OpenRA Locomotor TerrainSpeeds; the terrain half of CanEnterCell).
    /// Ships: water (fords are land); landing craft also beaches; ground
    /// units passable land; aircraft anything. Structures stand on nothing.
    /// The passabilities are built from the same predicates
    /// (`Passability::water`, `landing`, `new`).
    pub fn terrain_open_to(&self, ty: usize, t: crate::map::Terrain) -> bool {
        let Some(u) = self.rules.actors[ty].unit.as_ref() else { return false };
        match self.rules.locomotors[u.locomotor].domain {
            crate::rules::Domain::Air => true,
            crate::rules::Domain::Water if self.type_lands(ty) => t.landing_passable(),
            crate::rules::Domain::Water => t.ship_passable(),
            crate::rules::Domain::Ground => t.passable(),
        }
    }

    /// Nearest cell to (cx, cy), within `radius` rings, where a unit of type
    /// `ty` may stand: open terrain for its locomotor and no structure (its
    /// passability). (cx, cy) itself when it is such a cell; ties go to the
    /// lowest cell index. Aircraft may be anywhere on the map. Used to put
    /// units that would appear where they cannot be (map actors, mission
    /// actors, a chronoshift back to a cell that closed) on open ground or
    /// water instead, like OpenRA's Nudge and Teleport.ChooseBestDestinationCell.
    /// The cell a map's pre-placed unit of type `ty` at (cx, cy) appears on:
    /// that cell when its terrain is open to the unit's locomotor, else the
    /// nearest open cell within 7 rings (a ship drawn onto the shore, a tank
    /// in the sea), None when there is none (the unit is not placed). OpenRA
    /// spawns such map actors where they are, stuck for good; the editor
    /// warns about them (apps/game/editor/js/mapformat.js).
    pub(crate) fn map_unit_cell(&self, ty: usize, cx: i32, cy: i32) -> Option<(i32, i32)> {
        if !self.map.contains(cx, cy) {
            return None;
        }
        // Actors without a locomotor (mines) lie where they are put. So does
        // a unit on a cell a structure holds (OpenRA maps can put a civilian
        // on its house: it walks off); only terrain closed to its locomotor
        // moves it to the nearest open cell.
        if self.rules.actors[ty].unit.is_none() || self.terrain_open_to(ty, self.map.terrain[self.map.idx(cx, cy)]) {
            return Some((cx, cy));
        }
        self.open_cell_for(ty, cx, cy, 7)
    }

    pub fn open_cell_for(&self, ty: usize, cx: i32, cy: i32, radius: i32) -> Option<(i32, i32)> {
        let air =
            self.rules.actors[ty].unit.as_ref().is_some_and(|u| self.rules.locomotors[u.locomotor].domain == crate::rules::Domain::Air);
        let pass = self.pass_of_type(ty);
        let open = |x: i32, y: i32| self.map.contains(x, y) && (air || !pass.blocked[self.map.idx(x, y)]);
        for r in 0..=radius {
            let mut best: Option<(i32, usize, (i32, i32))> = None;
            for y in cy - r..=cy + r {
                for x in cx - r..=cx + r {
                    if ((x - cx).abs() != r && (y - cy).abs() != r) || !open(x, y) {
                        continue;
                    }
                    let key = ((x - cx).pow(2) + (y - cy).pow(2), self.map.idx(x, y));
                    if best.is_none_or(|(d, c, _)| key < (d, c)) {
                        best = Some((key.0, key.1, (x, y)));
                    }
                }
            }
            if let Some((_, _, c)) = best {
                return Some(c);
            }
        }
        None
    }

    /// Rebuild every passability from the map (after replacing it wholesale; tests, harnesses).
    pub fn reset_passability(&mut self) {
        self.resource_cells_changed();
        self.pass = Passability::new(&self.map);
        self.pass_water = Passability::water(&self.map);
        self.pass_landing = Passability::landing(&self.map);
    }

    /// Goal cell for moving actor `i` toward cell (gx, gy): the nearest cell it
    /// can actually reach in its domain (any cell for aircraft), or NONE.
    pub fn path_goal(&self, i: usize, gx: i32, gy: i32) -> u32 {
        let from = self.cell_of(self.actors[i].x, self.actors[i].y);
        self.path_goal_from(i, gx, gy, from)
    }

    /// `path_goal`, with ties between equally near reachable cells broken
    /// toward cell `from` (where the units come from), not by scan order.
    pub fn path_goal_from(&self, i: usize, gx: i32, gy: i32, from: (i32, i32)) -> u32 {
        let d = self.domain_of(i);
        let (gx, gy) = (gx.clamp(0, self.map.width - 1), gy.clamp(0, self.map.height - 1));
        if d == crate::rules::Domain::Air {
            return self.map.idx(gx, gy) as u32;
        }
        // Crushers reach what lies behind walls they may crush (neutral.rs).
        self.nearest_reachable(i, (gx, gy), from).unwrap_or(NONE)
    }

    // ---- Geometry helpers --------------------------------------------------

    #[inline]
    pub fn cell_of(&self, x: i32, y: i32) -> (i32, i32) {
        ((x.div_euclid(CELL)).clamp(0, self.map.width - 1), (y.div_euclid(CELL)).clamp(0, self.map.height - 1))
    }

    /// Cell of a target point as seen from (fx, fy): a point exactly on a cell
    /// border counts for the cell on the viewer's side. Unlike `cell_of`, this
    /// gives mirrored answers for mirrored situations.
    pub fn cell_toward(&self, x: i32, y: i32, fx: i32, fy: i32) -> (i32, i32) {
        let toward = |v: i32, f: i32| if v.rem_euclid(CELL) == 0 { v - (v - f).signum() } else { v };
        self.cell_of(toward(x, fx), toward(y, fy))
    }

    #[inline]
    pub fn cell_index(&self, x: i32, y: i32) -> usize {
        let (cx, cy) = self.cell_of(x, y);
        self.map.idx(cx, cy)
    }

    /// Distance from a point to the actor's hit shape.
    pub fn hit_distance(&self, i: usize, x: i32, y: i32) -> i32 {
        let a = &self.actors[i];
        if matches!(a.kind, Kind::Mine | Kind::Crate) {
            return dist(x, y, a.x, a.y);
        }
        if a.kind == Kind::Husk {
            return self.husk_hit_distance(i, x, y);
        }
        if a.kind == Kind::Building {
            let b = self.rules.actors[a.ty as usize].building.as_ref().unwrap();
            // Bridges are hit around their centre (bridges.rs).
            if self.rules.actors[a.ty as usize].world.bridge.is_some() {
                return self.bridge_hit_distance(i, x, y);
            }
            let mut best = i32::MAX;
            for &(dx, dy) in &b.hit_cells {
                let x0 = (a.cx + dx) * CELL;
                let y0 = (a.cy + dy) * CELL;
                let nx = x.clamp(x0, x0 + CELL);
                let ny = y.clamp(y0, y0 + CELL);
                best = best.min(dist(x, y, nx, ny));
            }
            best
        } else {
            let r = self.rules.actors[a.ty as usize].unit.as_ref().unwrap().radius;
            (dist(x, y, a.x, a.y) - r / 2).max(0)
        }
    }

    pub fn is_visible_to(&self, i: usize, player: u8) -> bool {
        let a = &self.actors[i];
        // Spectator view (observer.rs): everything on the map is visible.
        if self.render_all {
            return a.in_world();
        }
        // Husks hide under the fog even from their owner (HiddenUnderFog
        // AlwaysVisibleRelationships: None); crates belong to nobody.
        if a.owner == player && !matches!(a.kind, Kind::Husk | Kind::Crate) {
            return true;
        }
        let vis = &self.players[player as usize].visible;
        if a.kind == Kind::Building {
            let info = &self.rules.actors[a.ty as usize];
            let b = info.building.as_ref().unwrap();
            // HiddenUnderShroud (trees, rocks, bridges): seen once explored (neutral.rs).
            let vis = if info.world.shroud_only { &self.players[player as usize].explored } else { vis };
            b.footprint.iter().any(|&(dx, dy, c)| c != FootCell::Empty && vis[self.map.idx(a.cx + dx, a.cy + dy)] != 0)
        } else {
            // Passengers are inside their transport; submerged submarines need a detector.
            a.in_world() && self.naval_visible(i, player) && vis[self.cell_index(a.x, a.y)] != 0
        }
    }

    /// Unit indices in the given cell (from this tick's spatial hash).
    #[inline]
    pub fn units_in_cell(&self, ci: usize) -> &[u32] {
        let s = self.hash_start[ci] as usize;
        let e = self.hash_start[ci + 1] as usize;
        &self.hash_items[s..e]
    }

    pub(crate) fn rebuild_hash(&mut self) {
        let cells = self.map.cells();
        let mut counts = vec![0u32; cells + 1];
        let mut cell_of = Vec::with_capacity(self.actors.len());
        for a in &self.actors {
            // Mines are tracked per cell by abilities.rs, husks and crates by
            // `leftover_at` (husks.rs, crates.rs): not in the unit hash.
            if a.alive && a.is_unit() && a.in_world() {
                let ci = self.cell_index(a.x, a.y);
                counts[ci] += 1;
                cell_of.push(ci as u32);
            } else {
                cell_of.push(NONE);
            }
        }
        let mut acc = 0u32;
        for c in counts.iter_mut() {
            let n = *c;
            *c = acc;
            acc += n;
        }
        self.hash_start = counts.clone();
        self.hash_items.clear();
        self.hash_items.resize(acc as usize, 0);
        let mut fill = counts;
        for (i, &ci) in cell_of.iter().enumerate() {
            if ci != NONE {
                let p = fill[ci as usize] as usize;
                self.hash_items[p] = i as u32;
                fill[ci as usize] += 1;
            }
        }
    }

    // ---- Economy -----------------------------------------------------------

    pub fn spend(&mut self, player: u8, amount: i32) -> bool {
        let p = &mut self.players[player as usize];
        if amount <= 0 {
            return true;
        }
        if p.funds() < amount {
            return false;
        }
        // OpenRA spends stored ore before cash.
        let from_res = amount.min(p.resources);
        p.resources -= from_res;
        p.cash -= amount - from_res;
        true
    }

    pub fn refund(&mut self, player: u8, amount: i32) {
        self.players[player as usize].cash += amount;
    }

    pub fn give_resources(&mut self, player: u8, amount: i32) {
        let p = &mut self.players[player as usize];
        p.resources = (p.resources + amount).min(p.storage.max(p.resources));
    }

    // ---- Orders ------------------------------------------------------------

    pub fn queue_order(&mut self, o: Order) {
        self.orders.push(o);
    }

    /// Queue an order from the order log (a player's action, not an AI
    /// decision): refused for defeated players, counted for the observer
    /// stats otherwise. Returns whether it was queued.
    pub fn queue_player_order(&mut self, o: Order) -> bool {
        let p = o.player();
        if self.players.get(p as usize).is_none_or(|pl| pl.defeated) {
            return false;
        }
        self.note_order(p);
        self.orders.push(o);
        true
    }

    fn owned_units(&self, player: u8, ids: &[u32]) -> Vec<usize> {
        let mut out: Vec<usize> = ids
            .iter()
            .filter_map(|&r| self.resolve(r))
            .filter(|&i| {
                self.actors[i].owner == player && self.actors[i].is_unit() && self.actors[i].in_world()
                    // Support power aircraft reject orders (OpenRA RejectsOrders).
                    && !self.is_support_aircraft(i)
            })
            .collect();
        out.sort_unstable();
        out.dedup();
        out
    }

    fn apply_orders(&mut self) {
        let orders = std::mem::take(&mut self.orders);
        for o in orders {
            // A defeated player is out of the game: whatever it still owns
            // (submarines, walls, mines) takes no more orders.
            if self.players.get(o.player() as usize).is_none_or(|p| p.defeated) {
                continue;
            }
            if let Some(ids) = o.commanded_ids() {
                for i in self.owned_units(o.player(), ids) {
                    self.clear_commands(i);
                }
            }
            match o {
                Order::Move { player, ids, x, y, attack_move } => {
                    let units = self.owned_units(player, &ids);
                    self.order_move(&units, x, y, attack_move);
                }
                Order::Smart { player, ids, x, y } => {
                    let units = self.owned_units(player, &ids);
                    self.order_smart(player, &units, x, y);
                }
                Order::Attack { player, ids, target } => {
                    let units = self.owned_units(player, &ids);
                    if let Some(t) = self.resolve(target) {
                        self.order_attack(&units, t, true);
                    }
                }
                Order::Stop { player, ids } => {
                    for i in self.owned_units(player, &ids) {
                        self.release_dock(i);
                        let a = &mut self.actors[i];
                        a.activity = Activity::Idle;
                        a.target = NONE;
                        a.attack_move = false;
                        a.air.new_order();
                    }
                }
                Order::StartProduction { player, ty, count } => self.start_production(player, ty, count),
                Order::CancelProduction { player, ty } => self.cancel_production(player, ty),
                Order::PauseProduction { player, ty, paused } => self.pause_production(player, ty, paused),
                Order::Place { player, ty, cx, cy } => {
                    self.place_building(player, ty, cx, cy);
                }
                Order::Sell { player, building } => {
                    if let Some(b) = self.resolve(building) {
                        if self.actors[b].owner == player {
                            self.sell(b);
                        }
                    }
                }
                Order::Deploy { player, ids } => {
                    let mut actors: Vec<usize> = ids
                        .iter()
                        .filter_map(|&r| self.resolve(r))
                        .filter(|&i| self.actors[i].owner == player && self.actors[i].in_world())
                        .collect();
                    actors.sort_unstable();
                    actors.dedup();
                    for i in actors {
                        // Deploy on a loaded transport unloads it (cargo.rs); a
                        // helicopter lands or takes off (helicopter.rs); ability
                        // units deploy their ability (abilities.rs).
                        if self.can_unload(i) {
                            self.order_unload(i);
                        } else if self.actors[i].kind == Kind::Aircraft && self.is_helicopter(i) {
                            self.heli_deploy(i);
                        } else if self.toggle_primary(i) {
                            // A production structure became primary, or not any more (primary.rs).
                        } else if !self.ability_deploy(i) {
                            self.deploy(i);
                        }
                    }
                }
                Order::LayMines { player, ids, x0, y0, x1, y1 } => self.order_lay_mines(player, &ids, x0, y0, x1, y1),
                Order::Teleport { player, ids, x, y } => self.order_teleport(player, &ids, x, y),
                Order::Land { player, ids, x, y } => {
                    let units = self.owned_units(player, &ids);
                    self.order_land(&units, x, y);
                }
                Order::ReturnToBase { player, ids } => {
                    let units = self.owned_units(player, &ids);
                    self.order_return_to_base(&units);
                    // Planes fly home to a free airfield (plane.rs).
                    for &i in &units {
                        self.plane_return_to_base(i, None);
                    }
                }
                Order::Rally { player, building, x, y } => {
                    if let Some(b) = self.resolve(building) {
                        if self.actors[b].owner == player && self.actors[b].kind == Kind::Building {
                            self.actors[b].rally = Some((x, y));
                        }
                    }
                }
                Order::SupportPower { player, key, x, y, x2, y2 } => {
                    self.activate_support_power(player, &key, x, y, x2.zip(y2));
                }
                Order::AttackGround { player, ids, x, y } => {
                    let units = self.owned_units(player, &ids);
                    self.order_attack_ground(&units, x, y);
                }
                Order::Guard { player, ids, target } => {
                    let units = self.owned_units(player, &ids);
                    if let Some(t) = self.resolve(target) {
                        self.order_guard(player, &units, t);
                    }
                }
                Order::Scatter { player, ids } => {
                    let units = self.owned_units(player, &ids);
                    self.order_scatter(&units);
                }
                Order::Waypoint { player, ids, x, y, attack_move } => {
                    let units = self.owned_units(player, &ids);
                    self.order_waypoint(&units, x, y, attack_move);
                }
                Order::SetStance { player, ids, stance } => self.set_stance(player, &ids, stance),
                Order::RepairBuilding { player, building } => {
                    if let Some(b) = self.resolve(building) {
                        self.toggle_repair(player, b);
                    }
                }
                Order::PowerDown { player, building } => {
                    if let Some(b) = self.resolve(building) {
                        self.toggle_power_down(player, b);
                    }
                }
                Order::PlaceBeacon { player, x, y } => self.place_beacon(player, x, y),
                Order::Surrender { player } => self.surrender(player),
                // Cheats (debug.rs): each handler ignores them unless the game has the cheats option.
                Order::DevFlag { player, flag, on } => self.dev_set_flag(player, flag, on),
                Order::DevCash { player } => self.dev_give_cash(player),
                Order::DevKill { player, ids } => self.dev_kill(player, &ids),
                Order::DevExperience { player, ids } => self.dev_give_experience(player, &ids),
            }
        }
    }

    /// Called for every new order to a unit: frees the refinery dock it held
    /// and ends helicopter tasks (landing, resupply) with their helipad reservation.
    pub(crate) fn release_dock(&mut self, i: usize) {
        // The move under way ends; a step already begun is finished (movement/cellmove.rs).
        self.actors[i].mv.cancel();
        self.actors[i].mv.order_near = crate::movement::cellmove::ORDER_NEAR_ENOUGH;
        let me = self.make_ref(i);
        if let Some(r) = self.resolve(self.actors[i].refinery) {
            if self.actors[r].dock_user == me {
                self.actors[r].dock_user = NONE;
            }
        }
        // The service depot's pad and line (service.rs): a unit given a new
        // order while in a depot's line keeps its place and its hold on the
        // pad, so a new repair order to the same depot goes on where it was
        // (OpenRA queues the new Resupply on the host). After any other
        // order the kept state is dead: everything that reads it checks the
        // Repair activity, the next repair order arrives here with another
        // activity and clears it, a repair order to another depot starts
        // afresh (`sync_service`), and units that start a repair without an
        // order get a fresh place (`enter_service_line`).
        if self.actors[i].activity != Activity::Repair {
            if let Some(d) = self.resolve(self.actors[i].depot) {
                if self.actors[d].dock_user == me {
                    self.actors[d].dock_user = NONE;
                }
            }
            self.actors[i].svc = Default::default();
        }
        self.heli_cancel(i);
    }

    pub fn order_move(&mut self, units: &[usize], x: i32, y: i32, attack_move: bool) {
        if units.is_empty() {
            return;
        }
        let group = self.next_group();
        self.start_move_group(units, x, y, attack_move, group, units.len() as i32);
    }

    /// A fresh move group id.
    pub(crate) fn next_group(&mut self) -> u32 {
        let g = self.next_group;
        self.next_group += 1;
        g
    }

    /// `order_move` as part of move group `group` of `group_size` units (queued
    /// waypoints keep the group of the order that queued them).
    pub(crate) fn start_move_group(&mut self, units: &[usize], x: i32, y: i32, attack_move: bool, group: u32, group_size: i32) {
        if units.is_empty() {
            return;
        }
        // The group's centre decides ties (border targets, blocked goals), so a
        // mirrored order on a symmetric map picks the mirrored cell.
        let n = units.len() as i64;
        let cx = (units.iter().map(|&i| self.actors[i].x as i64).sum::<i64>() / n) as i32;
        let cy = (units.iter().map(|&i| self.actors[i].y as i64).sum::<i64>() / n) as i32;
        let from = self.cell_of(cx, cy);
        let (gx, gy) = self.cell_toward(x, y, cx, cy);
        // Reachable goals per (domain, landing craft, component, crushed
        // walls), shared by the group. A landing craft's components are
        // labels of its own passability (beaches too), not the other ships'.
        let mut goals: Vec<((crate::rules::Domain, bool, u32, u8), u32)> = Vec::new();
        for &i in units {
            if !self.actors[i].in_world() {
                continue;
            }
            self.release_dock(i);
            let d = self.domain_of(i);
            let comp = if d == crate::rules::Domain::Air {
                0
            } else {
                self.pass_of(i).component[self.cell_index(self.actors[i].x, self.actors[i].y)]
            };
            let crush = self.crush_mask(i);
            let key = (d, self.lands(i), comp, crush);
            let goal = match goals.iter().find(|(k, _)| *k == key) {
                Some(&(_, g)) => g,
                None => {
                    let g = self.path_goal_from(i, gx, gy, from);
                    goals.push((key, g));
                    g
                }
            };
            let a = &mut self.actors[i];
            a.activity = if goal == NONE { Activity::Idle } else { Activity::Move };
            a.goal = goal;
            a.group = group;
            a.group_size = group_size;
            a.attack_move = attack_move;
            a.dest = (x, y);
            a.target = NONE;
            a.forced = false;
            a.hold = false;
            a.retargeted = false;
            a.best_dist = i32::MAX;
            a.stuck_ticks = 0;
            a.air.new_order();
        }
    }

    pub fn order_attack(&mut self, units: &[usize], target: usize, forced: bool) {
        let tref = self.make_ref(target);
        for &i in units {
            // Force fire with C4 on a structure (Demolition ForceTargetRelationships, infantry.rs).
            if forced && self.can_demolish(i, target, true) && !self.can_attack_class_now(i, target) {
                self.order_enter(i, target, crate::infantry::EnterKind::Demolish);
                continue;
            }
            // Only what the owner sees gives the attack a place to head for.
            let owner = self.actors[i].owner;
            let seen = self.is_visible_to(target, owner).then(|| (self.actors[target].x, self.actors[target].y));
            // Only units with a weapon that can hit it (OpenRA issues the
            // attack to those its order targeter accepts): a tank ordered
            // onto a flying aircraft carries on with what it was doing.
            if !self.can_attack_actor(i, target) || !self.actors[i].in_world() {
                continue;
            }
            self.release_dock(i);
            let a = &mut self.actors[i];
            a.activity = Activity::Attack;
            a.target = tref;
            a.target_seen = seen;
            a.forced = forced;
            a.hold = false;
            a.attack_move = false;
            a.chase_cell = NONE;
            a.group_size = 1;
            a.best_dist = i32::MAX;
            a.stuck_ticks = 0;
            a.air.new_order();
        }
    }

    /// Actor visible to `player` at a world position, preferring units over buildings.
    pub fn actor_at(&self, player: u8, x: i32, y: i32) -> Option<usize> {
        let (cx, cy) = self.cell_of(x, y);
        let mut best: Option<(i32, usize)> = None;
        for oy in -1..=1 {
            for ox in -1..=1 {
                if !self.map.contains(cx + ox, cy + oy) {
                    continue;
                }
                for &u in self.units_in_cell(self.map.idx(cx + ox, cy + oy)) {
                    let u = u as usize;
                    let a = &self.actors[u];
                    if !a.alive || !self.is_visible_to(u, player) || self.is_cloaked_from(u, player) {
                        continue;
                    }
                    let r = self.rules.actors[a.ty as usize].unit.as_ref().unwrap().radius.max(256);
                    let d = dist(x, y, a.x, a.y);
                    if d <= r && best.is_none_or(|(bd, _)| d < bd) {
                        best = Some((d, u));
                    }
                }
            }
        }
        if let Some((_, u)) = best {
            return Some(u);
        }
        let b = self.building_at[self.map.idx(cx, cy)];
        if b != NONE && self.actors[b as usize].alive && self.is_visible_to(b as usize, player) && !self.is_cloaked_from(b as usize, player)
        {
            return Some(b as usize);
        }
        // Mines: own, allied or detected ones (abilities.rs).
        if let Some(m) = self.mine_at(self.map.idx(cx, cy)) {
            if self.is_visible_to(m, player) && !self.is_cloaked_from(m, player) {
                return Some(m);
            }
        }
        // Husks (force-fire targets) and crates (husks.rs, crates.rs).
        let ci = self.map.idx(cx, cy);
        if let Some(l) = self.husk_at(ci).or_else(|| self.crate_at(ci)).filter(|&l| self.is_visible_to(l, player)) {
            return Some(l);
        }
        // A bridge hut (engineers repair its bridge from there, bridges.rs).
        if let Some(h) = self.bridge_hut_at(x, y).filter(|&h| self.is_visible_to(h, player)) {
            return Some(h);
        }
        // A bridge under the cursor (force fire on it, bridges.rs).
        if let Some(b) = self.neutral.bridges.bridge_at(ci) {
            if let Some(i) = self.resolve(self.neutral.bridges.bridges[b].actor) {
                if self.is_visible_to(i, player) {
                    return Some(i);
                }
            }
        }
        None
    }

    pub fn smart_action(&self, player: u8, units: &[usize], x: i32, y: i32) -> SmartAction {
        if units.is_empty() {
            return SmartAction::None;
        }
        // Planes over an own airfield: return to base (plane.rs).
        if let Some(act) = self.plane_smart_action(player, units, x, y) {
            return act;
        }
        // Helicopters on an own helipad (dock) or service depot (repair).
        if let Some(action) = self.heli_smart_action(player, units, x, y) {
            return action;
        }
        let (cx, cy) = self.cell_of(x, y);
        let ci = self.map.idx(cx, cy);
        let any_harv = units.iter().any(|&i| self.is_harvester(i));
        if let Some(t) = self.actor_at(player, x, y) {
            // Capture, infiltrate, C4, disguise, heal (infantry.rs).
            if let Some(act) = self.infantry_smart_action(player, units, t) {
                return act;
            }
            let ta = &self.actors[t];
            if self.can_deliver_cash(player, units, t) {
                return SmartAction::DeliverCash;
            }
            if ta.kind == Kind::Mine && self.are_allies(player, ta.owner) {
                return SmartAction::Move;
            }
            // Husks need force-fire, crates are driven onto (husks.rs, crates.rs).
            if matches!(ta.kind, Kind::Husk | Kind::Crate) {
                return SmartAction::Move;
            }
            if self.are_enemies(player, ta.owner) {
                // OpenRA AttackOrderTargeter: the attack cursor only when a
                // weapon of the selection can hit it as it is now (a tank
                // over a flying aircraft, an AA gun over a tank: no); the
                // rest of the selection moves there (`order_smart`), and
                // without such a weapon the move cursor shows (below).
                if units.iter().any(|&i| self.can_attack_class_now(i, t)) {
                    return SmartAction::Attack;
                }
            } else if ta.owner != player {
                return SmartAction::Move; // allied or neutral: just move there
            } else {
                if units.iter().any(|&u| self.can_enter(u, t)) {
                    return SmartAction::Load;
                }
                if ta.kind == Kind::Building {
                    let b = self.rules.actors[ta.ty as usize].building.as_ref().unwrap();
                    if b.refinery.is_some() && any_harv {
                        return SmartAction::Dock;
                    }
                    // Vehicles and planes repair on a service depot pad, ships near a naval
                    // yard (Repairable(Near).RepairActors); with nothing to repair or rearm
                    // there the cursor is blocked and the click does nothing (OpenRA
                    // EnterBlockedCursor, Repairable ignores the order).
                    if b.repairs.is_some() && units.iter().any(|&u| self.repairs_at(u, t)) {
                        if units.iter().any(|&u| self.repairs_at(u, t) && self.needs_service(u, t)) {
                            return SmartAction::Repair;
                        }
                        return SmartAction::EnterBlocked;
                    }
                }
            }
        }
        if any_harv && self.map.has_resource(ci) && self.players[player as usize].explored[ci] != 0 {
            return SmartAction::Harvest;
        }
        // OpenRA MoveOrderTargeter: the blocked cursor over explored terrain the
        // locomotor cannot enter (unexplored cells show the move cursor, MoveIntoShroud).
        // With a mixed selection the move cursor wins while any unit can go there.
        if self.players[player as usize].explored[ci] != 0 && !units.iter().any(|&i| self.terrain_open_for(i, ci)) {
            return SmartAction::MoveBlocked;
        }
        SmartAction::Move
    }

    /// Whether unit `i`'s locomotor can drive on cell `ci`'s terrain, ignoring
    /// actors (OpenRA Locomotor.MovementCostForCell): the terrain half of `pass_of`.
    pub fn terrain_open_for(&self, i: usize, ci: usize) -> bool {
        let t = self.map.terrain[ci];
        match self.domain_of(i) {
            crate::rules::Domain::Air => true,
            crate::rules::Domain::Water if self.lands(i) => t.landing_passable(),
            crate::rules::Domain::Water => t.ship_passable(),
            _ => t.passable(),
        }
    }

    fn order_smart(&mut self, player: u8, units: &[usize], x: i32, y: i32) {
        // Planes clicked onto an own airfield return to base there (plane.rs).
        let rest = self.plane_smart_rtb(player, units, x, y);
        // Helicopters sent to an own helipad or service depot (helicopter.rs).
        let rest = self.heli_order_smart(player, &rest, x, y);
        let units = &rest[..];
        match self.smart_action(player, units, x, y) {
            SmartAction::None => {}
            SmartAction::Move | SmartAction::MoveBlocked => self.order_move(units, x, y, false),
            SmartAction::Attack => {
                let t = self.actor_at(player, x, y).unwrap();
                // Units with a weapon that can hit it attack, the others move there.
                let (fighters, others): (Vec<usize>, Vec<usize>) = units.iter().partition(|&&i| self.can_attack_class_now(i, t));
                self.order_attack(&fighters, t, true);
                self.order_move(&others, x, y, false);
            }
            SmartAction::Harvest => {
                let (harvs, others): (Vec<usize>, Vec<usize>) = units.iter().partition(|&&i| self.is_harvester(i));
                let ci = self.cell_index(x, y) as u32;
                for i in harvs {
                    self.release_dock(i);
                    let a = &mut self.actors[i];
                    a.activity = Activity::Harvest;
                    a.harv = HarvState::ToOre;
                    a.harv_cell = ci;
                    a.goal = ci;
                    a.group_size = 1;
                    a.best_dist = i32::MAX;
                    a.stuck_ticks = 0;
                }
                self.order_move(&others, x, y, false);
            }
            SmartAction::Dock => {
                let t = self.actor_at(player, x, y).unwrap();
                let tref = self.make_ref(t);
                let (harvs, others): (Vec<usize>, Vec<usize>) = units.iter().partition(|&&i| self.is_harvester(i));
                for i in harvs {
                    self.release_dock(i);
                    let a = &mut self.actors[i];
                    a.activity = Activity::Harvest;
                    a.harv = HarvState::ToDock;
                    a.refinery = tref;
                    a.best_dist = i32::MAX;
                    a.stuck_ticks = 0;
                }
                self.order_move(&others, x, y, false);
            }
            SmartAction::DeliverCash => {
                let t = self.actor_at(player, x, y).unwrap();
                self.order_deliver_cash(units, t, x, y);
            }
            SmartAction::Load => {
                let t = self.actor_at(player, x, y).unwrap();
                self.order_load(units, t);
            }
            act @ (SmartAction::Capture
            | SmartAction::CaptureOutside
            | SmartAction::Infiltrate
            | SmartAction::Demolish
            | SmartAction::InstantRepair
            | SmartAction::Heal
            | SmartAction::Fix
            | SmartAction::Disguise
            | SmartAction::EnterBlocked
            | SmartAction::RepairBlocked) => {
                let t = self.actor_at(player, x, y).unwrap();
                self.order_smart_infantry(act, units, t, x, y);
            }
            SmartAction::Repair => {
                let t = self.actor_at(player, x, y).unwrap();
                let tref = self.make_ref(t);
                let (veh, others): (Vec<usize>, Vec<usize>) = units.iter().partition(|&&i| self.repairs_at(i, t));
                for i in veh {
                    self.release_dock(i);
                    let a = &mut self.actors[i];
                    a.activity = Activity::Repair;
                    a.depot = tref;
                    a.repair_timer = 0;
                    a.group_size = 1;
                    a.best_dist = i32::MAX;
                    a.stuck_ticks = 0;
                }
                self.order_move(&others, x, y, false);
            }
        }
    }

    pub fn is_harvester(&self, i: usize) -> bool {
        self.rules.actors[self.actors[i].ty as usize].unit.as_ref().is_some_and(|u| u.harvester.is_some())
    }

    // ---- Tick --------------------------------------------------------------

    pub fn step(&mut self) {
        // The spectator view flag is render only (observer.rs).
        debug_assert!(!self.render_all, "render_all set while the simulation runs");
        self.tick += 1;
        self.env.tick(self.tick, self.map.width, self.map.height);
        for a in self.actors.iter_mut() {
            a.px = a.x;
            a.py = a.y;
            a.pfacing = a.facing;
            a.pturret = a.turret;
        }
        self.rebuild_hash();
        // Who holds which cells (OpenRA movement model), before this tick's
        // orders and with last tick's moves (movement/occupancy.rs).
        if self.cell_moves() {
            self.occupancy_begin_tick();
        }
        self.retarget_memo.clear();
        self.apply_orders();
        if self.tokens_dirty {
            self.refresh_tokens();
        }
        self.update_power();
        // Production doors (doors.rs, presentation only): the frame steps
        // before this tick's production, like OpenRA's door animation runs
        // the tick after UnitProduced.
        self.tick_doors();
        // Landing craft doors (fx.rs, presentation only).
        self.tick_fx();
        for p in 0..self.players.len() {
            // Mission players follow their scripts, not the skirmish AI (mission/).
            if self.players[p].is_ai && !self.players[p].defeated && !self.scripted_player(p as u8) {
                crate::ai::think(self, p as u8);
            }
        }
        for p in 0..self.players.len() {
            self.tick_production(p as u8);
            self.tick_powers(p as u8);
        }
        // Support power timers, cameras and falling bombs (powers.rs).
        self.tick_support_powers();
        // Repair button steps (repair.rs) and beacons running out (beacons.rs).
        self.tick_repairs();
        self.tick_beacons();
        self.tick_abilities_world();
        // Crate spawner, delivery flights and parachuting crates (crates.rs),
        // and burning husks (husks.rs).
        self.tick_crates();
        self.tick_husks();
        // Delayed shots, C4, outages, sonar pulses, captures (infantry.rs).
        self.tick_infantry_world();
        self.tick_units();
        self.tick_projectiles();
        self.tick_crashes();
        self.cleanup_dead();
        // Husks, the hospital, oil derricks, ore mines (with the "Ore
        // regrowth" option), panics and bridge repairs (neutral.rs).
        self.tick_neutral();
        // Mission scripts (mission/): triggers, script activities, Tick().
        if self.mission.is_some() {
            self.tick_mission();
            self.cleanup_dead();
        }
        if self.tokens_dirty {
            self.refresh_tokens();
        }
        if self.tick.is_multiple_of(VISION_INTERVAL) {
            self.update_vision();
        }
        for e in self.effects.iter_mut() {
            e.ttl -= 1;
        }
        self.effects.retain(|e| e.ttl > 0);
        // Missions win and lose by their objectives (OpenRA campaign rules
        // remove ConquestVictoryConditions).
        if self.tick.is_multiple_of(TICKS_PER_SECOND) && self.mission.is_none() {
            self.check_victory();
        }
        // The time limit counts every tick (gamerules.rs).
        self.tick_time_limit();
        // Statistics history (observer.rs): reads the world, never changes it.
        self.sample_stats();
    }

    /// Whether `player` is on the winning side (game over).
    pub fn has_won(&self, player: u8) -> bool {
        self.winner.is_some_and(|w| self.are_allies(w, player))
    }

    /// FNV-1a over the simulation state; used to check determinism.
    pub fn state_hash(&self) -> u64 {
        let mut h: u64 = 0xcbf2_9ce4_8422_2325;
        let mut mix = |v: i64| {
            h ^= v as u64;
            h = h.wrapping_mul(0x0100_0000_01b3);
        };
        mix(self.tick as i64);
        for (i, a) in self.actors.iter().enumerate() {
            if a.alive {
                for v in [a.ty as i32, a.owner as i32, a.x, a.y, a.facing, a.turret, a.hp, a.bales, a.gem_bales] {
                    mix(v as i64);
                }
                // Transports and submarines (cargo.rs, naval.rs).
                mix(a.carrier as i64);
                mix(a.submerged as i64);
                // Snow momentum and desert heat (weather.rs).
                mix(a.env.vel as i64);
                mix(a.env.heat as i64);
                // Command bar state (commands.rs): stance, guard and queued moves.
                mix(a.stance as i64);
                mix(a.guard as i64);
                mix(a.waypoints.len() as i64);
                // Veterancy and prone infantry (veterancy.rs).
                mix(a.xp);
                mix(a.rank as i64);
                mix(a.prone_ticks as i64);
                // Repair and power down buttons (repair.rs).
                mix(a.repairers.len() as i64);
                for &p in &a.repairers {
                    mix(p as i64);
                }
                mix(a.repair_ticks as i64);
                mix(a.powered_off as i64);
                // The service depot's line and pad reservation (service.rs).
                mix(a.repair_timer as i64);
                a.svc.mix(&mut mix);
                mix(a.dock_user as i64);
                // Pathing (units.rs): waiting in a queue versus blocked for good.
                mix(a.stall_ticks as i64);
                mix(self.jammed.get(i).copied().unwrap_or(false) as i64);
                // Burning husks and crate timers (husks.rs, crates.rs), primary structures (primary.rs).
                mix(a.leftover.ticks as i64);
                mix(a.leftover.drag_ticks as i64);
                mix(a.altitude as i64);
                mix(a.primary as i64);
                // Infantry abilities (infantry.rs).
                self.hash_infantry_actor(a, &mut mix);
                // Cells and moves of the OpenRA movement model (movement/cellmove.rs).
                if self.options.movement == crate::movement::MovementModel::OpenRA {
                    a.mv.mix(&mut mix);
                }
                // The neutral world's traits (neutral.rs).
                a.world.mix(&mut mix);
            }
        }
        // Bridges and husks to spawn (bridges.rs, neutral.rs).
        self.neutral.mix(&mut mix);
        self.hash_infantry_world(&mut mix);
        // Lobby options (gamerules.rs, crates.rs): experience, losses and the spawner.
        for p in &self.players {
            mix(p.experience);
            mix(p.defeated as i64);
        }
        mix(self.game_over as i64);
        mix(self.options.movement as i64);
        mix(self.crates.hash());
        mix(self.env.weather as i64);
        for p in &self.players {
            mix(p.cash as i64);
            mix(p.resources as i64);
            // Production on hold (production.rs).
            mix(p.queues.iter().flat_map(|q| &q.items).filter(|it| it.paused).count() as i64);
            // Cheat flags are simulation state; they can only be set with the cheats option.
            if self.options.cheats {
                mix(p.dev.bits() as i64);
            }
        }
        for &o in &self.map.ore {
            mix(o as i64);
        }
        for &g in &self.map.gems {
            mix(g as i64);
        }
        // Mission scripts and their state (mission/).
        if let Some(m) = &self.mission {
            mix(m.state_hash() as i64);
        }
        h
    }

    pub fn queue_type_index(q: QueueType) -> usize {
        q as usize
    }
}

#[inline]
pub fn cell_center(c: i32) -> i32 {
    c * CELL + HALF_CELL
}

#[inline]
pub(crate) fn idx_ref(idx: usize, gen: u32) -> u32 {
    idx as u32 | ((gen & GEN_MASK) << IDX_BITS)
}
