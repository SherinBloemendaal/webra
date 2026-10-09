//! Audio events: a write-only log of what the simulation did (a weapon fired,
//! a warhead landed, an actor died, a unit came off the line, ...) that the
//! client drains once per frame to play sounds (apps/game/js/audio/).
//!
//! The simulation never reads this buffer, so it cannot change the outcome of
//! a game or the state hash: lockstep peers with and without sound stay in
//! sync. It is off by default (multiplayer server, tests); the browser client
//! turns it on with `Game::set_audio_events`.
//!
//! Layout: `EVENT_STRIDE` i32 values per event,
//! `[kind, a, x, y, owner, b]`, positions in world units. What `a` and `b`
//! hold depends on the kind (see `SoundEventKind`). The buffer is capped so a
//! client that stops draining (hidden tab) or a battle with thousands of units
//! cannot grow it without bound; combat events have a lower cap so they never
//! crowd out the rare announcements (unit ready, structure sold, ...).

use crate::rules::Kind;

/// i32 values per event.
pub const EVENT_STRIDE: usize = 6;
/// Events kept between two drains.
pub const MAX_EVENTS: usize = 2048;
/// Of those, at most this many fire, impact and damage events.
pub const MAX_COMBAT_EVENTS: usize = 1536;
/// Ticks between two "insufficient funds" events of one player.
pub const FUNDS_EVENT_INTERVAL: u32 = 25;
/// A structure that was hit within this many ticks does not report again
/// (one "under attack" event per burst of fire, not per bullet).
pub const DAMAGE_EVENT_QUIET_TICKS: u32 = 50;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(i32)]
pub enum SoundEventKind {
    /// a = weapon index (rules order), b = shooter actor type.
    Fire = 1,
    /// a = weapon index, b = 1 when it landed in open water.
    Impact = 2,
    /// a = actor type, b = kind code (`kind_code`).
    Death = 3,
    /// a = actor type of a structure taking damage after a quiet spell.
    BuildingDamaged = 4,
    /// a = actor type of a unit that left its factory.
    UnitProduced = 5,
    /// a = actor type of a structure placed by its owner.
    BuildingPlaced = 6,
    /// a = actor type of a structure sold.
    Sold = 7,
    /// Production stalled for lack of money; a = actor type being built.
    InsufficientFunds = 8,
    /// A support power fired at (x, y); a = power kind code (`power_code`).
    PowerActivated = 9,
    /// A structure finished building and waits for placement; a = actor type.
    ConstructionReady = 10,
    /// `owner` started repairing a structure (repair.rs); a = actor type, b = the structure's owner.
    RepairStarted = 11,
    /// A structure was switched off (b = 1) or on again (b = 0) with the power
    /// down button (repair.rs); a = actor type.
    PowerToggled = 12,
    /// `owner` placed a beacon at (x, y) (beacons.rs); b = ticks it stays.
    BeaconPlaced = 13,
    /// A unit of `owner` was hit by another player's weapon after a quiet
    /// spell (OpenRA DamageNotifier@Unit: a radar ping); a = actor type.
    UnitDamaged = 14,
    /// An actor of `owner` transformed (OpenRA Transforms: an MCV deployed, a
    /// Construction Yard packed up), at the old actor's position;
    /// a = actor type before, b = actor type after.
    Transformed = 15,
    /// A deploy order could not transform the actor where it stands (OpenRA
    /// Transforms NoTransformNotification); a = actor type.
    DeployBlocked = 16,
}

impl SoundEventKind {
    fn is_combat(self) -> bool {
        matches!(self, SoundEventKind::Fire | SoundEventKind::Impact | SoundEventKind::BuildingDamaged | SoundEventKind::UnitDamaged)
    }
}

/// Actor kind as the client numbers it (the order of `Game::rules_json` kinds).
pub fn kind_code(kind: Kind) -> i32 {
    match kind {
        Kind::Building => 0,
        Kind::Infantry => 1,
        Kind::Vehicle => 2,
        Kind::Ship => 3,
        Kind::Aircraft => 4,
        Kind::Mine => 5,
    }
}

/// Support power kind (powers.rs `SupportPowerInfo::kind`) as a number.
pub fn power_code(kind: &str) -> i32 {
    match kind {
        "NukePower" => 1,
        "ChronoshiftPower" => 2,
        "GrantExternalConditionPower" => 3,
        "AirstrikePower" => 4,
        "ParatroopersPower" => 5,
        "GpsPower" => 6,
        _ => 0,
    }
}

#[derive(Clone, Default)]
pub struct SoundEvents {
    enabled: bool,
    data: Vec<i32>,
    combat: usize,
    /// Events dropped because the buffer was full, since the last drain.
    dropped: u32,
    /// Last tick each player got an insufficient-funds event.
    funds_at: Vec<Option<u32>>,
}

impl SoundEvents {
    pub fn enabled(&self) -> bool {
        self.enabled
    }

    pub fn set_enabled(&mut self, on: bool) {
        self.enabled = on;
        if !on {
            self.data.clear();
            self.combat = 0;
            self.dropped = 0;
        }
    }

    pub fn push(&mut self, kind: SoundEventKind, a: i32, x: i32, y: i32, owner: u8, b: i32) {
        if !self.enabled {
            return;
        }
        let combat = kind.is_combat();
        if self.len() >= MAX_EVENTS || (combat && self.combat >= MAX_COMBAT_EVENTS) {
            self.dropped = self.dropped.saturating_add(1);
            return;
        }
        if combat {
            self.combat += 1;
        }
        self.data.extend_from_slice(&[kind as i32, a, x, y, owner as i32, b]);
    }

    /// Insufficient funds, at most once per `FUNDS_EVENT_INTERVAL` per player.
    pub fn push_funds(&mut self, tick: u32, owner: u8, ty: u16) {
        if !self.enabled {
            return;
        }
        let p = owner as usize;
        if self.funds_at.len() <= p {
            self.funds_at.resize(p + 1, None);
        }
        if self.funds_at[p].is_some_and(|t| tick < t + FUNDS_EVENT_INTERVAL) {
            return;
        }
        self.funds_at[p] = Some(tick);
        self.push(SoundEventKind::InsufficientFunds, ty as i32, 0, 0, owner, 0);
    }

    /// Number of buffered events.
    pub fn len(&self) -> usize {
        self.data.len() / EVENT_STRIDE
    }

    pub fn is_empty(&self) -> bool {
        self.data.is_empty()
    }

    pub fn dropped(&self) -> u32 {
        self.dropped
    }

    /// All buffered events (flat, `EVENT_STRIDE` per event); empties the buffer.
    pub fn take(&mut self) -> Vec<i32> {
        self.combat = 0;
        self.dropped = 0;
        std::mem::take(&mut self.data)
    }
}
