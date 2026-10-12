//! Bridges like OpenRA's LegacyBridgeLayer (mods/ra/rules/civilian.yaml).
//!
//! A bridge is a structure actor over its template's cells: in OpenRA the
//! bridge is a terrain template (tiles) that the bridge layer turns into an
//! actor, and the actor swaps the template when its damage state changes.
//! WebRA maps store terrain types, not templates, so each bridge type carries
//! its templates' terrain per biome (rules.json `world.bridge.templates`, one
//! letter per cell, tools/gen_rules.py `bridge_info`): the healthy, damaged
//! and destroyed template, and for long bridge spans the destroyed ones that
//! join a destroyed neighbour (OpenRA DestroyedPlusNorth/South/BothTemplate).
//!
//! - A map places a bridge with its template's top-left cell; the terrain
//!   under it tells the state it starts in (OpenRA's HealthInit of the
//!   template: 100, 49 or 0 percent). Terrain that matches no state gets the
//!   healthy template (a bridge placed in the editor on other ground).
//! - Below half health (DamageState Heavy) the damaged template applies,
//!   at 0 the destroyed one: the bridge stays (OpenRA Health.RemoveOnDeath
//!   false) but cannot be targeted, and units standing on cells they cannot
//!   be on any more die (Bridge.KillUnitsOnBridge). Pathfinding follows the
//!   new terrain at once (passability changes bump the flow field version).
//! - Long bridges (BR1..BR3) link to the spans at NorthOffset and
//!   SouthOffset; a destroyed shore piece makes its neighbour look destroyed
//!   as well (OpenRA's LongBridgeSegmentIsDead).
//! - Huts (OpenRA LegacyBridgeHut, spawned by the bridge's FreeActor) are
//!   where engineers repair a bridge: `repair_bridge_at_hut` resurrects the
//!   spans from the hut to the next hut, one span every RepairPropagationDelay
//!   ticks, and kills units the repaired bridge lands on
//!   (`demolish_bridge_at_hut` is the reverse, for demolition charges).

use crate::neutral::DamageState;
use serde::Deserialize;
use std::collections::BTreeMap;

/// The terrain templates of one bridge type on one biome.
#[derive(Deserialize, Clone, Debug)]
pub struct BridgeTemplate {
    /// [width, height] in cells.
    pub size: Vec<i32>,
    /// One string of terrain letters per row (map.rs `Terrain::from_letter`);
    /// '.' marks a cell the template does not cover.
    pub healthy: Vec<String>,
    #[serde(default)]
    pub damaged: Option<Vec<String>>,
    #[serde(default)]
    pub destroyed: Option<Vec<String>>,
    #[serde(default)]
    pub destroyed_north: Option<Vec<String>>,
    #[serde(default)]
    pub destroyed_south: Option<Vec<String>>,
    #[serde(default)]
    pub destroyed_both: Option<Vec<String>>,
}

/// A hut a bridge spawns (OpenRA FreeActor), in some biomes only.
#[derive(Deserialize, Clone, Debug)]
pub struct BridgeHutInfo {
    pub actor: String,
    /// Cell offset from the bridge's top-left cell.
    pub offset: Vec<i32>,
    /// Biomes it appears on; None: every biome.
    #[serde(default)]
    pub biomes: Option<Vec<String>>,
    /// Resolved actor type (Rules::from_raw).
    #[serde(skip)]
    pub ty: usize,
}

/// OpenRA `Bridge` of a bridge type (rules.json `world.bridge`).
#[derive(Deserialize, Clone, Debug)]
pub struct BridgeInfo {
    /// A span of a long bridge (BR3): its art follows its neighbours.
    pub long: bool,
    /// Ticks between repairing (or demolishing) neighbouring spans.
    pub repair_delay: i32,
    /// Shore piece actor ids of long bridges (a dead one makes its neighbour look dead).
    pub shore_pieces: Vec<String>,
    /// Cell offsets of the neighbouring spans (long bridges), from the top-left cell.
    #[serde(default)]
    pub north: Option<Vec<i32>>,
    #[serde(default)]
    pub south: Option<Vec<i32>>,
    /// Templates per WebRA biome ("temperate", "snow", "desert").
    pub templates: BTreeMap<String, BridgeTemplate>,
    pub huts: Vec<BridgeHutInfo>,
    /// Weapon of a demolition (OpenRA Bridge.DemolishWeapon).
    pub demolish_weapon: usize,
    /// Resolved shore piece actor types (Rules::from_raw).
    #[serde(skip)]
    pub shore_tys: Vec<usize>,
}

/// Which template a bridge shows (OpenRA Bridge.ChooseTemplate).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum BridgeLook {
    Healthy,
    Damaged,
    Destroyed,
    /// Long bridge span, destroyed together with its north neighbour.
    DestroyedNorth,
    DestroyedSouth,
    DestroyedBoth,
}

impl BridgeLook {
    pub fn code(self) -> u8 {
        self as u8
    }
}

impl BridgeTemplate {
    /// The rows of a look; looks a template lacks fall back like OpenRA
    /// (a template id of 0 keeps the healthy or plain destroyed one).
    pub fn rows(&self, look: BridgeLook) -> &[String] {
        let destroyed = self.destroyed.as_deref().unwrap_or(&self.healthy);
        match look {
            BridgeLook::Healthy => &self.healthy,
            BridgeLook::Damaged => self.damaged.as_deref().unwrap_or(&self.healthy),
            BridgeLook::Destroyed => destroyed,
            BridgeLook::DestroyedNorth => self.destroyed_north.as_deref().unwrap_or(destroyed),
            BridgeLook::DestroyedSouth => self.destroyed_south.as_deref().unwrap_or(destroyed),
            BridgeLook::DestroyedBoth => self.destroyed_both.as_deref().unwrap_or(destroyed),
        }
    }

    pub fn width(&self) -> i32 {
        self.size.first().copied().unwrap_or(0)
    }

    pub fn height(&self) -> i32 {
        self.size.get(1).copied().unwrap_or(0)
    }
}

impl BridgeInfo {
    pub(crate) fn validate(&self, n: &dyn Fn(&str) -> String, weapons: usize, actors: &[crate::rules::ActorInfo]) -> Result<(), String> {
        if self.demolish_weapon >= weapons {
            return Err(n("world.bridge.demolish_weapon: unknown weapon"));
        }
        if !(0..=100_000).contains(&self.repair_delay) {
            return Err(n("world.bridge.repair_delay must be between 0 and 100000"));
        }
        if self.templates.is_empty() || self.templates.len() > 3 {
            return Err(n("world.bridge.templates needs 1 to 3 biomes"));
        }
        for (biome, t) in &self.templates {
            if crate::weather::Biome::from_name(biome).is_none() {
                return Err(n("world.bridge.templates: unknown biome"));
            }
            if t.size.len() != 2 || !(1..=8).contains(&t.width()) || !(1..=8).contains(&t.height()) {
                return Err(n("world.bridge.templates.size must be [w, h] of 1 to 8 cells"));
            }
            for look in [
                BridgeLook::Healthy,
                BridgeLook::Damaged,
                BridgeLook::Destroyed,
                BridgeLook::DestroyedNorth,
                BridgeLook::DestroyedSouth,
                BridgeLook::DestroyedBoth,
            ] {
                let rows = t.rows(look);
                let ok = rows.len() == t.height() as usize
                    && rows.iter().all(|r| {
                        r.chars().count() == t.width() as usize
                            && r.chars().all(|c| c == '.' || crate::map::Terrain::from_letter(c).is_some())
                    });
                if !ok {
                    return Err(n("world.bridge.templates: rows must be size[1] strings of size[0] terrain letters or ."));
                }
                // Every look covers the same cells.
                let covers = |rows: &[String]| rows.iter().map(|r| r.chars().map(|c| c != '.').collect::<Vec<_>>()).collect::<Vec<_>>();
                if covers(rows) != covers(&t.healthy) {
                    return Err(n("world.bridge.templates: every state must cover the same cells"));
                }
            }
            if !t.healthy.iter().any(|r| r.chars().any(|c| c != '.')) {
                return Err(n("world.bridge.templates: a template needs at least one cell"));
            }
        }
        for o in [&self.north, &self.south].into_iter().flatten() {
            if o.len() != 2 || o.iter().any(|v| !(-8..=8).contains(v)) {
                return Err(n("world.bridge.north and south must be [x, y] within 8 cells"));
            }
        }
        if self.huts.len() > 4 {
            return Err(n("world.bridge.huts may have at most 4 entries"));
        }
        for h in &self.huts {
            if h.offset.len() != 2 || h.offset.iter().any(|v| !(-8..=8).contains(v)) {
                return Err(n("world.bridge.huts.offset must be [x, y] within 8 cells"));
            }
            if actors.get(h.ty).is_none_or(|a| !a.world.bridge_hut) {
                return Err(n("world.bridge.huts.actor must be a bridge hut"));
            }
        }
        if self.shore_pieces.len() > 4 {
            return Err(n("world.bridge.shore_pieces may have at most 4 entries"));
        }
        Ok(())
    }
}

/// The look a bridge shows for its damage state (OpenRA Bridge.ChooseTemplate,
/// without the long bridge neighbours).
pub fn look_of(state: DamageState) -> BridgeLook {
    match state {
        DamageState::Dead => BridgeLook::Destroyed,
        DamageState::Heavy | DamageState::Critical => BridgeLook::Damaged,
        _ => BridgeLook::Healthy,
    }
}

// ---- Simulation state -------------------------------------------------------------------

/// One bridge span (OpenRA Bridge on a bridge actor).
#[derive(Clone, Debug)]
pub struct Bridge {
    /// Actor reference of the bridge.
    pub actor: u32,
    pub ty: u16,
    /// Top-left cell of the template.
    pub cx: i32,
    pub cy: i32,
    /// Cells the template covers: (dx, dy, cell index).
    pub cells: Vec<(i32, i32, usize)>,
    pub look: BridgeLook,
    /// Long bridge neighbours (north, south): indices into `BridgeLayer::bridges`.
    pub neighbours: [Option<usize>; 2],
    /// OpenRA Bridge.huts: the huts before and after this span (`BridgeLayer::huts`).
    pub huts: [Option<usize>; 2],
    /// OpenRA Bridge.Hut: this span's own hut (None for none, or for two).
    pub hut: Option<usize>,
}

/// A bridge hut (OpenRA LegacyBridgeHut).
#[derive(Clone, Debug)]
pub struct Hut {
    pub actor: u32,
    pub bridge: usize,
    /// Repairs still spreading from it (OpenRA repairDirections); > 0: repairing.
    pub repairing: i32,
}

/// A repair or demolition reaching a span later (OpenRA DelayedAction).
#[derive(Clone, Debug)]
pub struct BridgeAction {
    pub tick: u32,
    pub bridge: usize,
    pub direction: usize,
    /// Repair: the hut whose repair this is. Demolish: None.
    pub hut: Option<usize>,
    /// The player who repairs or demolishes.
    pub by: u8,
}

/// Every bridge of the map (OpenRA LegacyBridgeLayer).
#[derive(Clone, Default)]
pub struct BridgeLayer {
    pub bridges: Vec<Bridge>,
    pub huts: Vec<Hut>,
    /// Bridge per cell: index + 1, 0 for none.
    pub at: Vec<u32>,
    pub actions: Vec<BridgeAction>,
}

impl BridgeLayer {
    pub(crate) fn mix(&self, mix: &mut impl FnMut(i64)) {
        for b in &self.bridges {
            mix(b.look.code() as i64);
        }
        for h in &self.huts {
            mix(h.repairing as i64);
        }
        for a in &self.actions {
            for v in [a.tick as i64, a.bridge as i64, a.direction as i64, a.hut.map_or(-1, |h| h as i64), a.by as i64] {
                mix(v);
            }
        }
    }

    /// The bridge covering cell `ci`.
    pub fn bridge_at(&self, ci: usize) -> Option<usize> {
        match self.at.get(ci) {
            Some(&k) if k > 0 => Some(k as usize - 1),
            _ => None,
        }
    }
}

use crate::world::World;

impl World {
    /// The template of bridge actor type `ty` on this map's biome.
    pub fn bridge_template(&self, ty: u16) -> Option<&BridgeTemplate> {
        self.rules.actors[ty as usize].world.bridge.as_ref()?.templates.get(self.env.biome.name())
    }

    /// Index of actor `i`'s bridge span, if it is a bridge.
    pub fn bridge_of(&self, i: usize) -> Option<usize> {
        let r = self.make_ref(i);
        let a = &self.actors[i];
        let ci = self.map.idx(a.cx.clamp(0, self.map.width - 1), a.cy.clamp(0, self.map.height - 1));
        // Usually the top-left cell is covered; otherwise search.
        if let Some(b) = self.neutral.bridges.bridge_at(ci).filter(|&b| self.neutral.bridges.bridges[b].actor == r) {
            return Some(b);
        }
        self.neutral.bridges.bridges.iter().position(|b| b.actor == r)
    }

    /// The sprite of bridge actor `i` (render.rs): the body for the healthy
    /// and damaged templates, the second slot for the destroyed ones. With
    /// poses (original art, content/atlas.js) the pose picks the template:
    /// body Idle healthy, Damaged damaged; second slot Idle destroyed, Move
    /// destroyed with the north span, Attack with the south span, Harvest both.
    pub fn bridge_sprite(&self, i: usize) -> Option<f32> {
        use crate::render::Pose;
        let look = self.bridge_look(i)?;
        let body = self.actors[i].ty as u32 * 2;
        let (slot, pose) = match look {
            BridgeLook::Healthy => (body, Pose::Idle),
            BridgeLook::Damaged => (body, Pose::Damaged),
            BridgeLook::Destroyed => (body + 1, Pose::Idle),
            BridgeLook::DestroyedNorth => (body + 1, Pose::Move),
            BridgeLook::DestroyedSouth => (body + 1, Pose::Attack),
            BridgeLook::DestroyedBoth => (body + 1, Pose::Harvest),
        };
        Some(if self.render_opts.poses { crate::render::posed(slot, pose, 0) } else { slot as f32 })
    }

    /// The look of actor `i` if it is a bridge (render.rs, bridge art).
    pub fn bridge_look(&self, i: usize) -> Option<BridgeLook> {
        self.bridge_of(i).map(|b| self.neutral.bridges.bridges[b].look)
    }

    /// Set up the map's bridges (World::setup): each bridge actor takes the
    /// state its terrain shows (or stamps its healthy template), spans of
    /// long bridges link up, and the huts appear.
    pub(crate) fn setup_bridges(&mut self) {
        self.neutral.bridges = BridgeLayer { at: vec![0; self.map.cells()], ..Default::default() };
        let mut list: Vec<usize> = (0..self.actors.len())
            .filter(|&i| self.actors[i].alive && self.rules.actors[self.actors[i].ty as usize].world.bridge.is_some())
            .collect();
        // OpenRA converts bridges in cell order (rows, then columns).
        list.sort_by_key(|&i| (self.actors[i].cy, self.actors[i].cx, i));
        for i in list {
            let ty = self.actors[i].ty;
            let Some(t) = self.bridge_template(ty).cloned() else {
                // No such bridge on this biome's tileset.
                self.remove(i);
                continue;
            };
            let (cx, cy) = (self.actors[i].cx, self.actors[i].cy);
            let mut cells = Vec::new();
            for (dy, row) in t.healthy.iter().enumerate() {
                for (dx, c) in row.chars().enumerate() {
                    let (x, y) = (cx + dx as i32, cy + dy as i32);
                    if c != '.' && self.map.contains(x, y) && self.neutral.bridges.at[self.map.idx(x, y)] == 0 {
                        cells.push((dx as i32, dy as i32, self.map.idx(x, y)));
                    }
                }
            }
            if cells.is_empty() {
                self.remove(i);
                continue;
            }
            // The state the terrain shows (OpenRA HealthInit of the template).
            let matches = |look: BridgeLook| {
                let rows = t.rows(look);
                cells.iter().all(|&(dx, dy, ci)| {
                    let c = rows[dy as usize].chars().nth(dx as usize).unwrap_or('.');
                    crate::map::Terrain::from_letter(c) == Some(self.map.terrain[ci])
                })
            };
            let look = [
                BridgeLook::Healthy,
                BridgeLook::Damaged,
                BridgeLook::Destroyed,
                BridgeLook::DestroyedNorth,
                BridgeLook::DestroyedSouth,
                BridgeLook::DestroyedBoth,
            ]
            .into_iter()
            .find(|&l| matches(l));
            let max = self.rules.actors[ty as usize].hp;
            self.actors[i].hp = match look {
                Some(BridgeLook::Healthy) | None => max,
                Some(BridgeLook::Damaged) => max * 49 / 100,
                Some(_) => 0,
            };
            let idx = self.neutral.bridges.bridges.len();
            for &(_, _, ci) in &cells {
                self.neutral.bridges.at[ci] = idx as u32 + 1;
            }
            let actor = self.make_ref(i);
            self.neutral.bridges.bridges.push(Bridge {
                actor,
                ty,
                cx,
                cy,
                cells,
                look: look.unwrap_or(BridgeLook::Healthy),
                neighbours: [None, None],
                huts: [None, None],
                hut: None,
            });
            if look.is_none() {
                // Ground that matches no state (placed in the editor): the healthy template.
                self.apply_bridge_terrain(idx);
            }
        }
        // OpenRA LinkNeighbouringBridges.
        for b in 0..self.neutral.bridges.bridges.len() {
            let info = self.bridge_info(b).clone();
            for (d, offset) in [info.north.as_ref(), info.south.as_ref()].into_iter().enumerate() {
                if self.neutral.bridges.bridges[b].neighbours[d].is_some() {
                    continue;
                }
                let Some(o) = offset else { continue };
                let br = &self.neutral.bridges.bridges[b];
                let (x, y) = (br.cx + o[0], br.cy + o[1]);
                if !self.map.contains(x, y) {
                    continue;
                }
                if let Some(n) = self.neutral.bridges.bridge_at(self.map.idx(x, y)).filter(|&n| n != b) {
                    self.neutral.bridges.bridges[b].neighbours[d] = Some(n);
                    self.neutral.bridges.bridges[n].neighbours[1 - d] = Some(b);
                }
            }
        }
        // Long spans next to destroyed shore pieces look destroyed from the start.
        for b in 0..self.neutral.bridges.bridges.len() {
            self.update_bridge(b);
        }
        // Huts (OpenRA FreeActor on the bridge, then LegacyBridgeHut.AddHut).
        let biome = self.env.biome.name();
        for b in 0..self.neutral.bridges.bridges.len() {
            let info = self.bridge_info(b).clone();
            let br = &self.neutral.bridges.bridges[b];
            let (cx, cy) = (br.cx, br.cy);
            let Some(owner) = self.resolve(br.actor).map(|i| self.actors[i].owner) else { continue };
            for h in &info.huts {
                if !h.biomes.as_ref().is_none_or(|bs| bs.iter().any(|x| x == biome)) {
                    continue;
                }
                let Some(i) = self.spawn_building(h.ty as u16, owner, cx + h.offset[0], cy + h.offset[1]) else { continue };
                let hut = self.neutral.bridges.huts.len();
                let actor = self.make_ref(i);
                self.neutral.bridges.huts.push(Hut { actor, bridge: b, repairing: 0 });
                self.add_hut(b, hut);
            }
        }
    }

    fn bridge_info(&self, b: usize) -> &BridgeInfo {
        self.rules.actors[self.neutral.bridges.bridges[b].ty as usize].world.bridge.as_ref().expect("bridge actor")
    }

    /// OpenRA Bridge.AddHut (kept as OpenRA has it: which huts a span sits between).
    fn add_hut(&mut self, b: usize, hut: usize) {
        let layer = &mut self.neutral.bridges;
        let br = &mut layer.bridges[b];
        if br.huts[0] == br.huts[1] {
            br.huts[1] = Some(hut);
        }
        if br.hut.is_none() {
            br.hut = Some(hut);
            if br.huts[0].is_none() {
                br.huts[0] = Some(hut);
            }
            for d in 0..2 {
                let mut cur = layer.bridges[b].neighbours[d];
                while let Some(n) = cur {
                    layer.bridges[n].huts[d] = Some(hut);
                    cur = if layer.bridges[n].hut.is_none() { layer.bridges[n].neighbours[d] } else { None };
                }
            }
        } else {
            br.hut = None;
        }
    }

    /// Health of a span's actor (0 when gone).
    fn span_hp(&self, b: usize) -> (i32, i32) {
        let br = &self.neutral.bridges.bridges[b];
        let max = self.rules.actors[br.ty as usize].hp;
        (self.resolve(br.actor).map_or(0, |i| self.actors[i].hp.max(0)), max)
    }

    fn span_state(&self, b: usize) -> DamageState {
        let (hp, max) = self.span_hp(b);
        DamageState::of(hp, max)
    }

    /// OpenRA Bridge.NeighbourIsDeadShore.
    fn neighbour_is_dead_shore(&self, b: usize, n: Option<usize>) -> bool {
        let Some(n) = n else { return false };
        let ty = self.neutral.bridges.bridges[n].ty as usize;
        self.bridge_info(b).shore_tys.contains(&ty) && self.span_hp(n).0 <= 0
    }

    /// OpenRA Bridge.LongBridgeSegmentIsDead.
    fn segment_dead(&self, b: usize) -> bool {
        let dead = self.span_hp(b).0 <= 0;
        if !self.bridge_info(b).long {
            return dead;
        }
        let [n0, n1] = self.neutral.bridges.bridges[b].neighbours;
        self.neighbour_is_dead_shore(b, n0) || self.neighbour_is_dead_shore(b, n1) || dead
    }

    /// OpenRA Bridge.ChooseTemplate.
    fn choose_look(&self, b: usize) -> BridgeLook {
        if self.bridge_info(b).long && self.segment_dead(b) {
            let [n0, n1] = self.neutral.bridges.bridges[b].neighbours;
            let prev = n0.is_some_and(|n| self.segment_dead(n));
            let next = n1.is_some_and(|n| self.segment_dead(n));
            return match (prev, next) {
                (true, true) => BridgeLook::DestroyedBoth,
                (true, false) => BridgeLook::DestroyedNorth,
                (false, true) => BridgeLook::DestroyedSouth,
                _ => BridgeLook::Destroyed,
            };
        }
        look_of(self.span_state(b))
    }

    /// OpenRA Bridge.UpdateState: swap the template when the look changes;
    /// a span that went down kills what stands on it.
    fn update_bridge(&mut self, b: usize) {
        let look = self.choose_look(b);
        if look == self.neutral.bridges.bridges[b].look {
            return;
        }
        self.neutral.bridges.bridges[b].look = look;
        self.apply_bridge_terrain(b);
        // Whatever stands where the new look leaves no room for it dies: on a
        // fallen span, under a repaired one. OpenRA kills only when a span
        // falls (killedUnits) or a dead one is repaired, so a boat in the
        // water gap a fallen neighbour leaves in a long bridge (BR3
        // destroyed_north) would sit on the deck once that neighbour is
        // repaired; here it sinks, and ships are never on land.
        self.kill_units_on_bridge(b);
    }

    /// The span's template terrain for its look; passability follows.
    fn apply_bridge_terrain(&mut self, b: usize) {
        let br = &self.neutral.bridges.bridges[b];
        let Some(t) = self.bridge_template(br.ty) else { return };
        let rows = t.rows(br.look).to_vec();
        let cells = br.cells.clone();
        for (dx, dy, ci) in cells {
            let c = rows[dy as usize].chars().nth(dx as usize).unwrap_or('.');
            let Some(terrain) = crate::map::Terrain::from_letter(c) else { continue };
            self.map.terrain[ci] = terrain;
            if !terrain.holds_ore() {
                self.map.clear_resource(ci);
            }
            self.set_cell_passability(ci);
        }
        if !self.placing_map_actors {
            self.pass.refresh(&self.map);
            self.pass_water.refresh(&self.map);
            self.pass_landing.refresh(&self.map);
        }
        self.terrain_dirty = true;
    }

    /// OpenRA Bridge.KillUnitsOnBridge: units on the span's cells that
    /// cannot be on that ground die (tanks on a fallen bridge, a ship under
    /// a repaired one). Aircraft in the air fly on.
    fn kill_units_on_bridge(&mut self, b: usize) {
        let cells: Vec<usize> = self.neutral.bridges.bridges[b].cells.iter().map(|c| c.2).collect();
        let doomed: Vec<usize> = (0..self.actors.len())
            .filter(|&i| {
                let a = &self.actors[i];
                if !a.alive || !a.is_unit() || !a.in_world() || a.altitude > 0 || a.kind == crate::rules::Kind::Mine {
                    return false;
                }
                let ci = self.cell_index(a.x, a.y);
                if !cells.contains(&ci) {
                    return false;
                }
                // OpenRA CanExistInCell: the terrain must be open to its
                // locomotor (a landed helicopter needs ground to stand on).
                let t = self.map.terrain[ci];
                match self.domain_of(i) {
                    crate::rules::Domain::Air => !t.passable(),
                    _ => !self.terrain_open_to(a.ty as usize, t),
                }
            })
            .collect();
        for i in doomed {
            self.kill(i);
        }
    }

    /// Health of a span changed (damage, repair, demolition): every span the
    /// change can show on updates (OpenRA DamageStateChanged on a Bridge).
    pub(crate) fn bridge_health_changed(&mut self, b: usize) {
        let [n0, n1] = self.neutral.bridges.bridges[b].neighbours;
        self.update_bridge(b);
        for n in [n0, n1].into_iter().flatten() {
            self.update_bridge(n);
        }
        // A shore piece also changes the art of its neighbour's neighbour.
        let ty = self.neutral.bridges.bridges[b].ty as usize;
        if self.bridge_info(b).shore_tys.contains(&ty) {
            for d in 0..2 {
                if let Some(n) = self.neutral.bridges.bridges[b].neighbours[d] {
                    if let Some(nn) = self.neutral.bridges.bridges[n].neighbours[d] {
                        self.update_bridge(nn);
                    }
                }
            }
        }
    }

    /// Damage changed the health of bridge actor `i` (combat.rs damage_from):
    /// the bridge follows its damage state. At 0 it is destroyed but stays
    /// (OpenRA Health.RemoveOnDeath false). Returns true for bridges.
    pub(crate) fn bridge_damaged(&mut self, i: usize) -> bool {
        let Some(b) = self.bridge_of(i) else { return false };
        if self.actors[i].hp <= 0 {
            self.actors[i].hp = 0;
        }
        self.bridge_health_changed(b);
        true
    }

    // ---- Huts: repair and demolition ----------------------------------------------------

    /// The bridge hut actor at world position (x, y), if any (engineers are
    /// ordered onto a hut to repair its bridge).
    pub fn bridge_hut_at(&self, x: i32, y: i32) -> Option<usize> {
        let (cx, cy) = self.cell_of(x, y);
        self.neutral.bridges.huts.iter().filter_map(|h| self.resolve(h.actor)).find(|&i| {
            let a = &self.actors[i];
            self.rules.actors[a.ty as usize]
                .building
                .as_ref()
                .is_some_and(|b| b.area_cells().any(|(dx, dy)| (a.cx + dx, a.cy + dy) == (cx, cy)))
        })
    }

    /// Every living bridge hut actor (the engineers' side keeps its list of
    /// huts to enter in step with this one).
    pub fn bridge_huts(&self) -> Vec<usize> {
        self.neutral.bridges.huts.iter().filter_map(|h| self.resolve(h.actor)).collect()
    }

    /// Whether a repair started at hut actor `hut` still spreads over its
    /// bridge (OpenRA LegacyBridgeHut.Repairing).
    pub fn bridge_hut_repairing(&self, hut: usize) -> bool {
        self.hut_index(hut).is_some_and(|h| self.neutral.bridges.huts[h].repairing > 0)
    }

    fn hut_index(&self, hut: usize) -> Option<usize> {
        let r = self.make_ref(hut);
        self.neutral.bridges.huts.iter().position(|h| h.actor == r)
    }

    /// OpenRA LegacyBridgeHut.BridgeDamageState: the worst state of the
    /// spans this hut repairs (Bridge.AggregateDamageState).
    pub fn bridge_hut_damage_state(&self, hut: usize) -> Option<DamageState> {
        let h = self.hut_index(hut)?;
        let b = self.neutral.bridges.huts[h].bridge;
        let mut worst = self.span_state(b);
        for d in 0..2 {
            let mut cur = self.neutral.bridges.bridges[b].neighbours[d];
            while let Some(n) = cur {
                worst = worst.max(self.span_state(n));
                let nb = &self.neutral.bridges.bridges[n];
                cur = if nb.hut.is_none() { nb.neighbours[d] } else { None };
            }
        }
        Some(worst)
    }

    /// OpenRA Bridge.IsDangling: a span reached from one hut only, at the
    /// end of the chain (a long bridge cut off from its other shore).
    fn bridge_dangling(&self, b: usize) -> bool {
        let br = &self.neutral.bridges.bridges[b];
        br.huts[0] == br.huts[1] && (br.neighbours[0].is_none() || br.neighbours[1].is_none())
    }

    /// Whether an engineer may repair the bridge of hut actor `hut` now
    /// (OpenRA RepairsBridges: damaged, not already being repaired, not dangling).
    pub fn can_repair_bridge_at_hut(&self, hut: usize) -> bool {
        let Some(h) = self.hut_index(hut) else { return false };
        let hut_rec = &self.neutral.bridges.huts[h];
        self.bridge_hut_damage_state(hut) != Some(DamageState::Undamaged) && hut_rec.repairing <= 0 && !self.bridge_dangling(hut_rec.bridge)
    }

    /// An engineer of `by` entered hut actor `hut` (OpenRA RepairBridge
    /// activity, LegacyBridgeHut.Repair): the hut's span is repaired at once
    /// and the repair spreads span by span to the next hut. Returns false
    /// when there is nothing to repair. The engineer's side (walking there,
    /// being used up: RepairsBridges EnterBehaviour Dispose) is the caller's.
    pub fn repair_bridge_at_hut(&mut self, hut: usize, by: u8) -> bool {
        if !self.can_repair_bridge_at_hut(hut) {
            return false;
        }
        let h = self.hut_index(hut).expect("checked");
        let b = self.neutral.bridges.huts[h].bridge;
        let br = &self.neutral.bridges.bridges[b];
        let own = br.huts[0] == Some(h) || br.huts[1] == Some(h);
        self.neutral.bridges.huts[h].repairing = if own { 1 } else { 2 };
        // OpenRA Bridge.Do: the span itself, then its neighbours in their direction.
        let [n0, n1] = br.neighbours;
        self.repair_span(b, None, h, by);
        if let Some(n) = n0 {
            self.repair_span(n, Some(0), h, by);
        }
        if let Some(n) = n1 {
            self.repair_span(n, Some(1), h, by);
        }
        true
    }

    /// OpenRA Bridge.Repair of one span, spreading on in `direction`.
    fn repair_span(&mut self, b: usize, direction: Option<usize>, hut: usize, by: u8) {
        let initial = self.span_state(b);
        let Some(i) = self.resolve(self.neutral.bridges.bridges[b].actor) else { return };
        self.actors[i].hp = self.rules.actors[self.actors[i].ty as usize].hp;
        // Health.Resurrect: the repaired span kills what it lands on (update_bridge).
        self.bridge_health_changed(b);
        let br = &self.neutral.bridges.bridges[b];
        let done = match direction {
            None => br.neighbours[0].is_none() && br.neighbours[1].is_none(),
            Some(d) => br.hut.is_some() || br.neighbours[d].is_none(),
        };
        if done {
            self.neutral.bridges.huts[hut].repairing -= 1;
        }
        if let Some(d) = direction {
            if br.hut.is_none() {
                if let Some(n) = br.neighbours[d] {
                    let delay = if initial == DamageState::Undamaged || self.neighbour_is_dead_shore(b, Some(n)) {
                        0
                    } else {
                        self.bridge_info(b).repair_delay
                    };
                    // OpenRA DelayedAction: at least the next tick.
                    let tick = self.tick + delay.max(1) as u32;
                    self.neutral.bridges.actions.push(BridgeAction { tick, bridge: n, direction: d, hut: Some(hut), by });
                }
            }
        }
    }

    /// Whether a demolition charge on hut actor `hut` can still bring its
    /// bridge down (OpenRA LegacyBridgeHut IDemolishable.IsValidTarget).
    pub fn can_demolish_bridge_at_hut(&self, hut: usize) -> bool {
        self.bridge_hut_damage_state(hut).is_some_and(|s| s != DamageState::Dead)
    }

    /// A demolition charge of `by` on hut actor `hut` went off (OpenRA
    /// LegacyBridgeHut.Demolish): the spans from this hut to the next fall,
    /// one every RepairPropagationDelay ticks.
    pub fn demolish_bridge_at_hut(&mut self, hut: usize, by: u8) -> bool {
        if !self.can_demolish_bridge_at_hut(hut) {
            return false;
        }
        let h = self.hut_index(hut).expect("checked");
        let b = self.neutral.bridges.huts[h].bridge;
        let [n0, n1] = self.neutral.bridges.bridges[b].neighbours;
        self.demolish_span(b, None, by);
        if let Some(n) = n0 {
            self.demolish_span(n, Some(0), by);
        }
        if let Some(n) = n1 {
            self.demolish_span(n, Some(1), by);
        }
        true
    }

    /// OpenRA Bridge.Demolish of one span: the demolition weapon goes off on
    /// it and it falls; the next span follows after the propagation delay.
    fn demolish_span(&mut self, b: usize, direction: Option<usize>, by: u8) {
        let initial = self.span_state(b);
        let Some(i) = self.resolve(self.neutral.bridges.bridges[b].actor) else { return };
        let w = self.bridge_info(b).demolish_weapon;
        let (x, y) = (self.actors[i].x, self.actors[i].y);
        self.with_damage_source(by, |w2| w2.impact(w, x, y, by));
        self.actors[i].hp = 0;
        self.bridge_health_changed(b);
        let br = &self.neutral.bridges.bridges[b];
        if let Some(d) = direction {
            if br.hut.is_none() {
                if let Some(n) = br.neighbours[d] {
                    let delay = if initial == DamageState::Dead || self.neighbour_is_dead_shore(b, Some(n)) {
                        0
                    } else {
                        self.bridge_info(b).repair_delay
                    };
                    let tick = self.tick + delay.max(1) as u32;
                    self.neutral.bridges.actions.push(BridgeAction { tick, bridge: n, direction: d, hut: None, by });
                }
            }
        }
    }

    /// Repairs and demolitions reaching their next span.
    pub(crate) fn tick_bridges(&mut self) {
        if self.neutral.bridges.actions.is_empty() {
            return;
        }
        let tick = self.tick;
        let (due, later): (Vec<BridgeAction>, Vec<BridgeAction>) =
            std::mem::take(&mut self.neutral.bridges.actions).into_iter().partition(|a| a.tick <= tick);
        self.neutral.bridges.actions = later;
        for a in due {
            match a.hut {
                Some(h) => self.repair_span(a.bridge, Some(a.direction), h, a.by),
                None => self.demolish_span(a.bridge, Some(a.direction), a.by),
            }
        }
    }

    /// Distance from a point to bridge actor `i`'s hit shape: OpenRA's
    /// ^1x1Shape, one cell square around the bridge's centre.
    pub(crate) fn bridge_hit_distance(&self, i: usize, x: i32, y: i32) -> i32 {
        let a = &self.actors[i];
        let h = crate::math::HALF_CELL;
        let nx = x.clamp(a.x - h, a.x + h);
        let ny = y.clamp(a.y - h, a.y + h);
        crate::math::dist(x, y, nx, ny)
    }

    /// Bridge actors whose cells lie within `r` cells of (cx, cy) (warhead scans).
    pub(crate) fn bridges_near(&self, cx: i32, cy: i32, r: i32) -> Vec<usize> {
        let mut out: Vec<usize> = Vec::new();
        for y in cy - r..=cy + r {
            for x in cx - r..=cx + r {
                if !self.map.contains(x, y) {
                    continue;
                }
                if let Some(b) = self.neutral.bridges.bridge_at(self.map.idx(x, y)) {
                    if let Some(i) = self.resolve(self.neutral.bridges.bridges[b].actor) {
                        if !out.contains(&i) {
                            out.push(i);
                        }
                    }
                }
            }
        }
        out
    }
}
