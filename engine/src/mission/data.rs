//! Mission files (`apps/game/missions/<id>.json`, docs/contracts.md section 11),
//! made from OpenRA's missions by tools/gen_missions.py.

use crate::mapdata::MapData;
use serde::Deserialize;
use std::collections::BTreeMap;

/// The mission format this engine reads.
pub const FORMAT: u32 = 1;
/// Largest mission file accepted (the biggest OpenRA mission is under 200 KiB).
pub const MAX_BYTES: usize = 4 * 1024 * 1024;

#[derive(Deserialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct MissionData {
    pub format: u32,
    pub id: String,
    pub title: String,
    pub campaign: String,
    #[serde(default)]
    pub author: String,
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub briefing: String,
    #[serde(default)]
    pub videos: BTreeMap<String, String>,
    #[serde(default)]
    pub tileset: String,
    /// OpenRA cell of the map's cell (0, 0): scripts use OpenRA cells.
    pub origin: [i32; 2],
    /// Terrain, ore and gems (a map file without spawns).
    pub map: MapData,
    pub players: Vec<PlayerRef>,
    #[serde(default)]
    pub actors: Vec<MapActorRef>,
    /// Changes to the built-in rules (`Rules::load_mission`).
    #[serde(default)]
    pub rules: serde_json::Value,
    /// Script-only actor types without a body: waypoints, cameras, flares.
    #[serde(default)]
    pub props: BTreeMap<String, PropInfo>,
    /// How mission-only actors are drawn (client only).
    #[serde(default)]
    pub art: serde_json::Value,
    pub scripts: Vec<Script>,
    /// Fluent messages (`UserInterface.GetFluentMessage`).
    #[serde(default)]
    pub messages: BTreeMap<String, String>,
    /// Lobby dropdowns of the mission (`Map.LobbyOption`): difficulty.
    #[serde(default)]
    pub options: BTreeMap<String, OptionInfo>,
    #[serde(default)]
    pub starting_cash: i32,
    #[serde(default = "unrestricted")]
    pub tech_level: String,
    #[serde(default)]
    pub time_limit: TimeLimitInfo,
    #[serde(default)]
    pub start_notification: Option<String>,
    #[serde(default)]
    pub objectives: ObjectivesInfo,
    /// What an actor type leaves when it dies, when that is not a husk or a
    /// crate (OpenRA SpawnActorOnDeath of an oil derrick: its burning ruin).
    #[serde(default)]
    pub death_spawns: BTreeMap<String, String>,
    /// Actor types units never pick on their own (Targetable NoAutoTarget: barrels).
    #[serde(default)]
    pub no_auto_target: Vec<String>,
    /// Actor types that panic (OpenRA ScaredyCat): civilians.
    #[serde(default)]
    pub scaredy: Vec<String>,
    /// Actor types without health in OpenRA: never damaged, never targeted.
    #[serde(default)]
    pub indestructible: Vec<String>,
    /// Per actor type: the conditions scripts may grant (ExternalCondition)
    /// and what they switch (`actor.GrantCondition`, conditions.rs).
    #[serde(default)]
    pub conditions: BTreeMap<String, ConditionInfo>,
    /// Player conditions that switch bot modules on (`Player.GrantCondition`).
    #[serde(default)]
    pub bot_conditions: BTreeMap<String, Vec<String>>,
    #[serde(default)]
    pub smudges: Vec<SmudgeRef>,
    #[serde(default)]
    pub notes: Vec<String>,
}

fn unrestricted() -> String {
    "unrestricted".into()
}

#[derive(Deserialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct PlayerRef {
    pub name: String,
    pub faction: String,
    #[serde(default)]
    pub color: String,
    #[serde(default)]
    pub playable: bool,
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub owns_world: bool,
    #[serde(default)]
    pub non_combatant: bool,
    #[serde(default)]
    pub bot: Option<String>,
    #[serde(default)]
    pub allies: Vec<String>,
    #[serde(default)]
    pub enemies: Vec<String>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct MapActorRef {
    /// The script global it is known by.
    pub name: String,
    #[serde(rename = "type")]
    pub ty: String,
    pub owner: String,
    /// OpenRA cell.
    pub x: i32,
    pub y: i32,
    /// OpenRA WAngle: 0 north, counter-clockwise, 1024 a turn.
    #[serde(default)]
    pub facing: Option<i32>,
    #[serde(default)]
    pub turret_facing: Option<i32>,
    #[serde(default)]
    pub subcell: Option<i32>,
    /// Percent of full health.
    #[serde(default)]
    pub health: Option<i32>,
    #[serde(default)]
    pub stance: Option<String>,
    #[serde(default)]
    pub faction: Option<String>,
    /// Refineries: false spawns them without their free ore truck.
    #[serde(default)]
    pub free_actor: Option<bool>,
    #[serde(default)]
    pub tags: Vec<String>,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(deny_unknown_fields)]
pub struct PropInfo {
    /// World units the prop reveals for its owner (0: none).
    #[serde(default)]
    pub reveal: i32,
    /// Sprite image of a prop drawn in the game (a flare), or none.
    #[serde(default)]
    pub image: Option<String>,
}

/// Conditions of one actor type (tools/gen_missions.py reads them from the
/// traits that require them).
#[derive(Deserialize, Clone, Debug, Default)]
#[serde(deny_unknown_fields)]
pub struct ConditionInfo {
    /// Conditions an ExternalCondition trait accepts.
    #[serde(default)]
    pub external: Vec<String>,
    /// What a condition (or its absence, `!name`) switches.
    #[serde(default)]
    pub effects: Vec<ConditionEffect>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct ConditionEffect {
    /// The trait's RequiresCondition: `name` or `!name`.
    pub when: String,
    /// targetable, reveal, demolishable, invulnerable, kills_self, sell_survivors.
    pub effect: String,
    /// Reveal range (world units) for `reveal`.
    #[serde(default)]
    pub value: i32,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct Script {
    pub name: String,
    pub source: String,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct OptionInfo {
    #[serde(default)]
    pub label: String,
    /// [value, label] pairs.
    pub values: Vec<[String; 2]>,
    pub default: String,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(deny_unknown_fields)]
pub struct TimeLimitInfo {
    /// Mission text while a script time limit runs; `{0}` is the time left.
    #[serde(default)]
    pub countdown_text: Option<String>,
    /// Text of the minute warnings: `{0}` minutes, `{1}` the plural "s".
    #[serde(default)]
    pub notification: Option<String>,
    #[serde(default)]
    pub skip_expired_notification: bool,
    /// Minutes left at which a warning sounds, and the speech of each.
    #[serde(default)]
    pub warnings: Vec<i32>,
    #[serde(default)]
    pub warning_notifications: Vec<String>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct ObjectivesInfo {
    #[serde(default)]
    pub early_game_over: bool,
    #[serde(default = "game_over_delay")]
    pub game_over_delay: i32,
    #[serde(default)]
    pub cooperative: bool,
}

fn game_over_delay() -> i32 {
    1500
}

impl Default for ObjectivesInfo {
    fn default() -> Self {
        ObjectivesInfo { early_game_over: false, game_over_delay: game_over_delay(), cooperative: false }
    }
}

#[derive(Deserialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct SmudgeRef {
    pub x: i32,
    pub y: i32,
    #[serde(rename = "type")]
    pub ty: String,
    #[serde(default)]
    pub depth: i32,
}

impl MissionData {
    pub fn parse(json: &str) -> Result<MissionData, String> {
        if json.len() > MAX_BYTES {
            return Err(format!("mission is larger than {MAX_BYTES} bytes"));
        }
        let m: MissionData = serde_json::from_str(json)
            .map_err(|e| format!("invalid mission JSON: {}", e.to_string().chars().take(160).collect::<String>()))?;
        if m.format != FORMAT {
            return Err(format!("unsupported mission format {}", m.format));
        }
        if !m.players.iter().any(|p| p.playable) {
            return Err("the mission has no playable player".into());
        }
        if m.players.len() > 16 {
            return Err("a mission has at most 16 players".into());
        }
        if m.scripts.is_empty() {
            return Err("the mission has no script".into());
        }
        Ok(m)
    }

    /// The player a person plays: the first playable one.
    pub fn human(&self) -> usize {
        self.players.iter().position(|p| p.playable).expect("checked by parse")
    }

    /// The chosen value of a lobby option, or its default.
    pub fn option_value<'a>(&'a self, id: &str, chosen: &'a BTreeMap<String, String>) -> Option<&'a str> {
        let o = self.options.get(id)?;
        match chosen.get(id) {
            Some(v) if o.values.iter().any(|[k, _]| k == v) => Some(v.as_str()),
            _ => Some(o.default.as_str()),
        }
    }
}
