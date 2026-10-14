//! The WebAssembly API of missions (mission/, docs/contracts.md section 9):
//! start a mission, read its objectives and text, drain what the scripts
//! want shown or played.

use crate::mission::setup::MissionOptions;
use crate::mission::{MissionData, MissionResult, ObjectiveState};
use crate::render::PX_PER_CELL;
use crate::world::World;
use crate::Game;
use serde_json::json;
use sha2::{Digest, Sha256};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
impl Game {
    /// A game of a mission file (`apps/game/missions/<id>.json`) with
    /// `{ seed, options: { difficulty: "hard" }, humans?: ["Allies1",
    /// "Allies2"], localPlayer?: 0, movement?: "openra", factoryLoss?:
    /// "openra" }`: `humans` names
    /// the mission's playable players people take, in engine order
    /// (default: its first playable player alone), `localPlayer` this
    /// screen's (presentation only), `movement` the movement model
    /// (movement/; absent: `webra`, as games saved before the option),
    /// `factoryLoss` what a queue does without a structure of its type
    /// (production.rs; absent: `webra` likewise). The scripts are loaded
    /// and `WorldLoaded` has run.
    pub fn from_mission(mission_json: &str, options_json: &str) -> Result<Game, JsError> {
        let data = MissionData::parse(mission_json).map_err(|e| JsError::new(&e))?;
        let o: serde_json::Value = serde_json::from_str(options_json).map_err(|e| JsError::new(&format!("bad options: {e}")))?;
        let seed = o.get("seed").and_then(|s| s.as_u64()).unwrap_or(1);
        let mut chosen = MissionOptions::default();
        if let Some(opts) = o.get("options").and_then(|v| v.as_object()) {
            for (k, v) in opts {
                if let Some(s) = v.as_str() {
                    chosen.options.insert(k.chars().take(32).collect(), s.chars().take(32).collect());
                }
            }
        }
        if let Some(list) = o.get("humans").and_then(|v| v.as_array()) {
            if list.len() > 8 {
                return Err(JsError::new("at most 8 people play a mission"));
            }
            chosen.humans = list
                .iter()
                .map(|v| v.as_str().map(|s| s.chars().take(64).collect()).ok_or_else(|| JsError::new("humans must be names")))
                .collect::<Result<_, _>>()?;
        }
        chosen.local_player = o.get("localPlayer").and_then(|v| v.as_u64()).unwrap_or(0).min(255) as u8;
        // Absent in saves and replays from before the option: they played
        // with WebRA's soft crowd separation and replay with it.
        chosen.movement = match o.get("movement") {
            None => crate::movement::MovementModel::WebRA,
            Some(v) => v
                .as_str()
                .and_then(crate::movement::MovementModel::from_name)
                .ok_or_else(|| JsError::new("movement must be openra or webra"))?,
        };
        // Absent likewise: their unit queues waited for a new factory.
        chosen.factory_loss = match o.get("factoryLoss") {
            None => crate::world::FactoryLoss::WebRA,
            Some(v) => v
                .as_str()
                .and_then(crate::world::FactoryLoss::from_name)
                .ok_or_else(|| JsError::new("factoryLoss must be openra or webra"))?,
        };
        let world = World::from_mission(data, seed, &chosen).map_err(|e| JsError::new(&e))?;
        Ok(Game::wrap(world))
    }

    /// SHA-256 (hex) of a mission file's text: its identity in saves and replays.
    pub fn mission_hash(mission_json: &str) -> String {
        Sha256::digest(mission_json.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
    }

    /// Campaign menu preview of a mission's map: RGBA, one pixel per cell.
    pub fn mission_preview(mission_json: &str) -> Result<Vec<u8>, JsError> {
        let data = MissionData::parse(mission_json).map_err(|e| JsError::new(&e))?;
        let m = data.map.to_map().map_err(|e| JsError::new(&e))?;
        Ok(crate::preview_rgba(&m, data.map.biome))
    }

    /// Whether this game plays a mission.
    pub fn is_mission(&self) -> bool {
        self.world.mission().is_some()
    }

    /// `{ id, title, result, error, objectives: [{ description, type, required,
    /// state }], missionText: { text, color } | null, players: [{ name, color }],
    /// lowPowerQuiet, localPlayer }`: what the mission panel shows for this
    /// screen's player (null without a mission).
    pub fn mission_state(&self) -> String {
        let Some(m) = self.world.mission() else { return "null".into() };
        let state = |s: ObjectiveState| match s {
            ObjectiveState::Incomplete => "incomplete",
            ObjectiveState::Completed => "completed",
            ObjectiveState::Failed => "failed",
        };
        let result = match m.result {
            MissionResult::Playing => "playing",
            MissionResult::Won => "won",
            MissionResult::Lost => "lost",
            MissionResult::ScriptError => "error",
        };
        json!({
            "id": m.id,
            "title": m.title(),
            "result": result,
            "error": m.error,
            "objectives": m.players[m.local_player as usize].objectives.iter().map(|o| json!({
                "description": o.description,
                "type": o.kind,
                "required": o.required,
                "state": state(o.state),
            })).collect::<Vec<_>>(),
            "missionText": m.mission_text().map(|(t, c)| json!({"text": t, "color": c})),
            "players": m.players.iter().map(|p| json!({"name": p.name, "color": crate::mission::hex_color(p.color)})).collect::<Vec<_>>(),
            "lowPowerQuiet": m.low_power_quiet(m.local_player),
            "localPlayer": m.local_player,
        })
        .to_string()
    }

    /// What the scripts asked to show or play since the last call (JSON list of
    /// `mission::UiEvent`; positions in cells). Presentation only.
    pub fn take_mission_events(&mut self) -> String {
        let events = self.world.mission.as_mut().map(|m| m.take_ui()).unwrap_or_default();
        serde_json::to_string(&events).expect("events serialize")
    }

    /// Where the camera starts (world pixels): where the script put it, else
    /// the person's first actor.
    pub fn mission_camera(&self) -> Vec<f32> {
        let w = &self.world;
        let me = w.mission().map_or(0, |m| m.local_player);
        let pos = w.mission().and_then(|m| m.camera()).or_else(|| w.actors.iter().find(|a| a.alive && a.owner == me).map(|a| (a.x, a.y)));
        let (x, y) = pos.unwrap_or((w.map.width * crate::math::CELL / 2, w.map.height * crate::math::CELL / 2));
        vec![x as f32 * PX_PER_CELL / crate::math::CELL as f32, y as f32 * PX_PER_CELL / crate::math::CELL as f32]
    }
}
