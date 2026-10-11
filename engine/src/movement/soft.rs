//! The WebRA movement model: free positions and soft crowd separation.
//!
//! Units of the same domain that overlap are pushed apart at the end of
//! every tick; a moving tank crushes enemy soldiers it overlaps. The
//! separation is damped so that a crowd comes to rest:
//!
//! - Units that stand still only make room for each other when they
//!   overlap by more than `SETTLE_SLACK`, by half the overlap a tick,
//!   so an arrived group settles within a few ticks and then does not move.
//! - A unit that drives through a standing crowd on its way elsewhere
//!   pushes it aside (a crowd never plugs a road), but a unit arriving at
//!   its goal treats standing friends as walls: it stops against them
//!   (units.rs `goal_reached`) instead of shoving the group around.
//! - Units holding a dock, a repair pad or an ore cell are never pushed;
//!   the unit next in line for a pad or dock reserves it before it drives
//!   on, and the others wait where they are (units.rs `tick_repair`,
//!   `tick_harvest`).
//!
//! Every push goes through `World::try_move`, which never enters a cell
//! the unit's locomotor cannot enter.

use crate::flowfield::DIRS;
use crate::math::{isqrt, CELL};
use crate::sound_events::SoundEventKind;
use crate::world::{Activity, HarvState, World, NONE};

/// Most a unit is pushed per tick.
const MAX_PUSH: i32 = 96;
/// Overlap two standing units tolerate (world units).
const SETTLE_SLACK: i32 = 16;
/// Smallest step a standing unit takes to make room (world units).
const SETTLE_MIN: i32 = 8;
/// Within this many cells of its pad or dock a unit next in line waits.
pub(crate) const QUEUE_RANGE: i32 = 3;
/// Cells (of path) before its destination from which a moving unit stops
/// against standing friends instead of pushing them aside. Farther out it
/// pushes, so a big group funnels through a gap instead of stopping behind it.
const ARRIVAL_ZONE: i32 = 4;

impl World {
    /// Where moving unit `i` is headed and the zone before it (path length)
    /// where standing friends are walls rather than a crowd to push
    /// through: `ARRIVAL_ZONE` cells of a move, or the waiting range of a
    /// pad or dock for a unit that is not next in line. None for units
    /// doing anything else.
    fn soft_zone(&self, i: usize) -> Option<(u32, i32)> {
        let a = &self.actors[i];
        match a.activity {
            Activity::Move if a.goal != NONE => Some((a.goal, ARRIVAL_ZONE * CELL)),
            Activity::Repair if !self.on_repair_pad(i) => {
                let d = self.resolve(a.depot)?;
                Some((self.repair_pad_cell(d), QUEUE_RANGE * CELL))
            }
            Activity::Harvest if a.harv == HarvState::ToDock && !self.holds_dock(i) => {
                let r = self.resolve(a.refinery)?;
                Some((self.dock_cell(r), QUEUE_RANGE * CELL))
            }
            _ => None,
        }
    }

    /// Whether moving unit `i` is arriving: within its zone (`soft_zone`)
    /// along the path, so standing friends it runs into are walls.
    fn soft_arriving(&mut self, i: usize) -> bool {
        let Some((goal, zone)) = self.soft_zone(i) else { return false };
        self.path_remaining(i, goal).is_some_and(|rest| rest <= zone)
    }

    /// The crowd separation of the WebRA model (see the module doc). Called
    /// at the end of `tick_units`.
    pub(crate) fn separate_units(&mut self) {
        self.rebuild_hash();
        let n = self.actors.len();
        let mut push = vec![(0i32, 0i32); n];
        // Room two standing units make for each other, damped (see `settle_step`).
        let mut settle = vec![(0i32, 0i32); n];
        let mut jammed = vec![false; n];
        // Moving units close to their goal (see `soft_arriving`).
        let arriving: Vec<bool> = (0..n).map(|i| self.actors[i].alive && self.actors[i].moved && self.soft_arriving(i)).collect();
        // (victim, crusher): crushing counts as a kill by the crusher
        // (veterancy.rs, and for its owner in the observer stats).
        let mut crushed: Vec<(usize, usize)> = Vec::new();
        for i in 0..n {
            let a = &self.actors[i];
            // Planes and paratroopers in the air never bump into anything (plane.rs); mines are not units.
            // Leaping dogs and units walking into a target pass through the crowd (dog.rs, infantry.rs).
            if !a.alive || !a.is_unit() || a.air.parachute || self.is_plane(i) || self.passes_through(i) {
                continue;
            }
            let ra = self.rules.actors[a.ty as usize].unit.as_ref().unwrap().radius;
            let (cx, cy) = self.cell_of(a.x, a.y);
            for oy in -1..=1 {
                for ox in -1..=1 {
                    if !self.map.contains(cx + ox, cy + oy) {
                        continue;
                    }
                    for &j in self.units_in_cell(self.map.idx(cx + ox, cy + oy)) {
                        let j = j as usize;
                        if j <= i {
                            continue;
                        }
                        let (a, b) = (&self.actors[i], &self.actors[j]);
                        // Only units in the same domain bump into each other
                        // (aircraft fly over tanks, ships never meet tanks).
                        if !b.alive
                            || self.domain_of(i) != self.domain_of(j)
                            || b.air.parachute
                            || self.is_plane(j)
                            || self.passes_through(j)
                        {
                            continue;
                        }
                        // A landed helicopter and one flying over it do not touch.
                        if (a.altitude == 0) != (b.altitude == 0) {
                            continue;
                        }
                        let rb = self.rules.actors[b.ty as usize].unit.as_ref().unwrap().radius;
                        let min = ra + rb;
                        let (dx, dy) = (b.x - a.x, b.y - a.y);
                        let d2 = dx as i64 * dx as i64 + dy as i64 * dy as i64;
                        if d2 >= (min as i64) * (min as i64) {
                            continue;
                        }
                        let (a_moved, b_moved) = (a.moved, b.moved);
                        // A moving crusher (tracked vehicles, ore truck) runs over
                        // soldiers and civilians that are not its allies
                        // (OpenRA Crushable: CrushedByFriendlies false).
                        if !self.are_allies(a.owner, b.owner) {
                            let crush_reach = (min as i64) * (min as i64) * 9 / 16;
                            if d2 <= crush_reach {
                                if a_moved && self.crushable_by(j, i) {
                                    crushed.push((j, i));
                                    continue;
                                }
                                if b_moved && self.crushable_by(i, j) {
                                    crushed.push((i, j));
                                    continue;
                                }
                            }
                        }
                        // A soldier or civilian a moving tank may crush stands in its way
                        // like an enemy instead of being pushed aside.
                        let crushable = self.crushable_by(j, i) || self.crushable_by(i, j);
                        let friends = !self.are_enemies(self.actors[i].owner, self.actors[j].owner) && !crushable;
                        if friends {
                            jammed[i] |= b_moved;
                            jammed[j] |= a_moved;
                        }
                        let d = isqrt(d2) as i32;
                        let (nx, ny) = if d == 0 {
                            // Deterministic split for exactly overlapping units.
                            let f = (i * 7 + j * 13) % 8;
                            (DIRS[f].0 * 1024, DIRS[f].1 * 1024)
                        } else {
                            (dx * 1024 / d, dy * 1024 / d)
                        };
                        let overlap = (min - d).min(MAX_PUSH * 2);
                        let (pa, pb) = match (a_moved, b_moved, friends) {
                            // A moving unit and a standing friend: the friend makes
                            // room for one passing through, and is a wall for one
                            // that arrives (it stops against it instead).
                            (true, false, true) if arriving[i] => (overlap, 0),
                            (true, false, true) => (0, overlap),
                            (false, true, true) if arriving[j] => (0, overlap),
                            (false, true, true) => (overlap, 0),
                            // Standing enemies are walls.
                            (true, false, false) => (overlap, 0),
                            (false, true, false) => (0, overlap),
                            // Two standing units settle: only a real overlap,
                            // gently, so a crowd comes to rest.
                            (false, false, _) => {
                                let excess = (min - d - SETTLE_SLACK).clamp(0, 2 * MAX_PUSH);
                                let (sa, sb) = (excess / 2, excess - excess / 2);
                                settle[i].0 -= nx * sa / 1024;
                                settle[i].1 -= ny * sa / 1024;
                                settle[j].0 += nx * sb / 1024;
                                settle[j].1 += ny * sb / 1024;
                                (0, 0)
                            }
                            _ => (overlap / 2, overlap - overlap / 2),
                        };
                        push[i].0 -= nx * pa / 1024;
                        push[i].1 -= ny * pa / 1024;
                        push[j].0 += nx * pb / 1024;
                        push[j].1 += ny * pb / 1024;
                    }
                }
            }
        }
        self.jammed = jammed;
        for (k, crusher) in crushed {
            if self.actors[k].alive {
                self.run_over(k, crusher);
            }
        }
        for i in 0..n {
            let (sx, sy) = settle_step(settle[i]);
            let (px, py) = (push[i].0 + sx, push[i].1 + sy);
            if px == 0 && py == 0 || !self.actors[i].alive {
                continue;
            }
            let a = &self.actors[i];
            // Units busy at a dock, a repair pad or an ore cell hold their spot.
            if a.activity == Activity::Harvest && matches!(a.harv, HarvState::Unloading | HarvState::Harvesting) || self.on_repair_pad(i) {
                continue;
            }
            let (px, py) = (px.clamp(-MAX_PUSH, MAX_PUSH), py.clamp(-MAX_PUSH, MAX_PUSH));
            let (x, y) = (a.x, a.y);
            let moved = self.actors[i].moved;
            self.try_move(i, x + px, y + py);
            self.actors[i].moved = moved;
        }
    }

    /// Unit `victim` is run over by `crusher` (both models): the crush
    /// sound at the crusher (Crushable.CrushSound), a flattened body, and a
    /// kill for the crusher (veterancy.rs, observer statistics).
    pub(crate) fn run_over(&mut self, victim: usize, crusher: usize) {
        if !self.actors[victim].alive {
            return;
        }
        let (c, v) = (&self.actors[crusher], &self.actors[victim]);
        let (vty, cx, cy, vowner, cowner) = (v.ty as i32, c.x, c.y, v.owner, c.owner);
        self.sound.push(SoundEventKind::Crushed, vty, cx, cy, vowner, cowner as i32);
        let source = self.make_ref(crusher);
        // Crushed soldiers leave a flattened body (infantry_combat.rs).
        self.note_crushed(victim);
        self.award_kill(victim, source);
        let by = self.actors[crusher].owner;
        self.with_damage_source(by, |w| w.kill(victim));
    }

    /// Whether harvester `i` holds its refinery's dock (docked, or next in line).
    pub(crate) fn holds_dock(&self, i: usize) -> bool {
        let me = self.make_ref(i);
        self.resolve(self.actors[i].refinery).is_some_and(|r| self.actors[r].dock_user == me)
    }
}

/// How far a standing unit gives way for the overlaps it has with other
/// standing units: half their sum (pushes from all sides at once otherwise
/// overshoot and the crowd keeps trembling), nothing below `SETTLE_MIN`.
/// So a resting crowd stops moving for good once the overlaps left are
/// small or balance out.
fn settle_step((x, y): (i32, i32)) -> (i32, i32) {
    let (x, y) = (x / 2, y / 2);
    if x.abs() + y.abs() < SETTLE_MIN {
        (0, 0)
    } else {
        (x, y)
    }
}
