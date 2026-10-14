//! How ground units and ships move among each other: the lobby option
//! "Movement" (`GameOptions::movement`, docs/contracts.md section 3).
//!
//! - `MovementModel::OpenRA` (the default) follows OpenRA's Mobile,
//!   Locomotor and Move activity: every unit holds the cells it stands on
//!   and drives into (`occupancy.rs`), steps from cell to cell, and never
//!   pushes anyone. A unit whose next cell is taken asks a friendly idle
//!   blocker to step aside (a nudge), waits for it (and, in a pass, for
//!   the queue ahead while it moves), then looks for another way or gives
//!   up when it is close enough (`cellmove.rs`, routes from `search.rs`).
//!   Infantry share a cell, up to five per cell.
//! - `MovementModel::WebRA` keeps WebRA's free positions with soft crowd
//!   separation, damped so that units which arrived stay put and queues at
//!   service depots and refineries wait their turn (`soft.rs`).
//!
//! Both models share the flow fields (flowfield.rs) for the way to a goal
//! and both keep the terrain invariant: no unit is ever moved, pushed or
//! nudged onto a cell its locomotor cannot enter. Aircraft fly over all of
//! it.

pub mod cellmove;
pub mod occupancy;
pub mod search;
pub mod soft;

#[cfg(test)]
mod tests;
#[cfg(test)]
mod tests_blocking;
#[cfg(test)]
mod tests_chokepoint;

pub use cellmove::Motion;

/// The movement model of a game (lobby option `movement`).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum MovementModel {
    /// OpenRA's cell occupancy, waiting and nudging (cellmove.rs).
    OpenRA,
    /// WebRA's damped soft crowd separation (soft.rs).
    WebRA,
}

impl MovementModel {
    pub const ALL: [MovementModel; 2] = [MovementModel::OpenRA, MovementModel::WebRA];

    /// Name in game options, saves and replays.
    pub fn name(self) -> &'static str {
        match self {
            MovementModel::OpenRA => "openra",
            MovementModel::WebRA => "webra",
        }
    }

    pub fn from_name(s: &str) -> Option<MovementModel> {
        MovementModel::ALL.into_iter().find(|m| m.name() == s)
    }
}

/// How a move ended (OpenRA MoveResult).
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum MoveResult {
    /// No move, or a new one that has not run yet.
    #[default]
    None,
    InProgress,
    /// The unit stands on its destination (CompleteDestinationReached).
    Reached,
    /// The unit stopped short: the way stayed blocked, or it was close enough
    /// to give up (CompleteDestinationBlocked).
    Blocked,
}
