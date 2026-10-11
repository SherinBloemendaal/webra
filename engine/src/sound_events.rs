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
    /// a = actor type of a structure taking another player's fire after a
    /// quiet spell, b = the attacking player.
    BuildingDamaged = 4,
    /// a = actor type of a unit that left its factory.
    UnitProduced = 5,
    /// a = actor type of a structure placed by its owner.
    BuildingPlaced = 6,
    /// a = actor type of a structure sold.
    Sold = 7,
    /// Production stalled for lack of money; a = actor type being built.
    InsufficientFunds = 8,
    /// A support power fired at (x, y); a = power kind code (`power_code`),
    /// b = `power_ref` of the power instance.
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
    /// spell (OpenRA DamageNotifier@Unit: a radar ping); a = actor type,
    /// b = the attacking player.
    UnitDamaged = 14,
    /// An actor of `owner` transformed (OpenRA Transforms: an MCV deployed, a
    /// Construction Yard packed up), at the old actor's position;
    /// a = actor type before, b = actor type after.
    Transformed = 15,
    /// A deploy order could not transform the actor where it stands (OpenRA
    /// Transforms NoTransformNotification); a = actor type.
    DeployBlocked = 16,
    /// A support power of `owner` started charging (OpenRA SupportPower.Charging:
    /// BeginChargeSpeechNotification); a = provider actor type, b = index into
    /// its support powers (`power_ref` packs both for other events).
    PowerCharging = 17,
    /// A support power of `owner` finished charging (SupportPower.Charged:
    /// EndChargeSpeechNotification); a = provider actor type, b = power index.
    PowerReady = 18,
    /// The first paratrooper plane of a drop reached the drop zone (OpenRA
    /// ParatroopersPower ReinforcementsArrivedSpeechNotification), at the
    /// target; a = provider actor type, b = power index.
    ReinforcementsArrived = 19,
    /// Production removed an item that can no longer be built and refunded it
    /// (OpenRA ProductionQueue.CancelUnbuildableItems: CancelledAudio); a = actor type.
    ProductionCancelled = 20,
    /// A finished unit cannot leave its factory (OpenRA ProductionQueue:
    /// BlockedAudio, once per item); a = actor type.
    ProductionBlocked = 21,
    /// A unit of `owner` started its repair at a structure (OpenRA Resupply:
    /// RepairsUnits StartRepairingNotification); a = unit type, b = repairing structure type.
    UnitRepairStarted = 22,
    /// A unit of `owner` was fully repaired (RepairsUnits FinishRepairingNotification);
    /// a = unit type, b = repairing structure type.
    UnitRepaired = 23,
    /// An actor of `owner` rose one veterancy level (OpenRA GainsExperience
    /// LevelUpNotification); a = actor type.
    LevelUp = 24,
    /// An actor was crushed (OpenRA Crushable.CrushSound, at the crusher's
    /// position); a = victim type, owner = victim's owner, b = crusher's owner.
    Crushed = 25,
    /// An actor fell to Heavy damage (OpenRA SoundOnDamageTransition
    /// DamagedSounds: below half health); a = actor type.
    DamageHeavy = 26,
    /// An actor cloaked (b = 1) or uncloaked (b = 0) (OpenRA Cloak
    /// CloakSound / UncloakSound); a = actor type.
    CloakChanged = 27,
    /// An aircraft dropped a passenger by parachute (OpenRA ParaDrop.ChuteSound,
    /// at the aircraft); a = the aircraft's type.
    ParaDrop = 28,
    /// A parachuted actor landed where it cannot stand and died (OpenRA
    /// Parachutable Ground/WaterImpactSound); a = actor type, b = 1 on water.
    ParachuteImpact = 29,
    /// An actor of `owner` reloaded one magazine at its rearm structure (OpenRA
    /// Rearmable: AmmoPool.RearmSound, to the owner); a = actor type.
    Rearmed = 30,
    /// Placing a structure gave `owner` more things to build (OpenRA
    /// PlaceBuilding NewOptionsNotification, NewOptionsNotificationDelay later).
    NewOptions = 31,
    /// `owner` made a structure its primary building (OpenRA PrimaryBuilding
    /// SelectionNotification); a = structure type.
    PrimaryBuildingSelected = 32,
    /// An actor changed hands by capture (OpenRA CaptureNotification);
    /// a = actor type, owner = new owner, b = old owner.
    Captured = 33,
    /// A structure was infiltrated (OpenRA Infiltrates.Notification and the
    /// target's InfiltrateFor* notifications); a = target type, owner = target's
    /// owner, b = `infiltrator_code(infiltrator type, infiltrator owner)`.
    Infiltrated = 34,
    /// A time limit warning (OpenRA TimeLimitManager.TimeLimitWarnings), to
    /// every player (owner = `ALL_PLAYERS`); a = minutes remaining.
    TimeLimitWarning = 35,
    /// `owner` collected a crate (OpenRA CrateAction Sound and Notification,
    /// at the crate); a = `crate_action_code` of the action, b = crate actor type.
    CrateCollected = 36,
    /// A pilot bailed out of a destroyed aircraft (OpenRA EjectOnDeath.ChuteSound,
    /// at the aircraft); a = the aircraft's type.
    PilotEjected = 37,
    // Lobby options and battlefield effects (gamerules.rs, smudges.rs); crates,
    // primary buildings and time limit warnings use the kinds above.
    /// Kill bounty (gamerules.rs): `owner` got paid for a kill at (x, y);
    /// a = the bounty shown (with passengers'). The client shows it to that
    /// player's allies only, like OpenRA's floating text.
    Bounty = 38,
    /// The time limit ran out (OpenRA TimeLimitManager), to every player
    /// (owner = `ALL_PLAYERS`).
    TimeLimitExpired = 39,
    /// `owner` lost (OpenRA "player is defeated" line).
    PlayerLost = 40,
    /// Camera shake at (x, y) (OpenRA ShakeScreen warhead, ShakeOnDeath);
    /// a = duration in ticks, b = intensity, owner = multiplier x + 16 * multiplier y.
    ScreenShake = 41,
    /// OpenRA FlashEffect warhead: a = duration in ticks, b = flash type (1: nuke).
    Flash = 42,
    /// A unit of `owner` killed an enemy and says so (OpenRA AnnounceOnKill,
    /// Tanya; infantry.rs); a = the killer's type.
    KillAnnounced = 43,
    /// A cash tick over an actor at (x, y) (OpenRA FloatingText with
    /// FormatCashTick, ShowTicks: CashTrickler, GivesCashOnCapture,
    /// InfiltrateForCash, DeliversCash); a = the amount, owner = the player
    /// whose colour it shows. Everyone who sees the spot sees it.
    CashTick = 44,
    /// A deployed MAD tank of `owner` (OpenRA MadTank): b = 0 when it starts
    /// charging (ChargeSound, ChargeDelay ticks after deploying), 1 when it
    /// detonates (DetonationSound and its DetonationWeapon's impact); a = actor type.
    MadTank = 45,
    /// An actor of `owner` was teleported (OpenRA Teleport: ChronoshiftSound),
    /// one event at each end; a = actor type, b = 1 for a chrono tank's own
    /// jump (PortableChrono), 0 for the Chronosphere and the return (Chronoshiftable).
    Teleported = 46,
}

/// `owner` of events every player hears (time limit warnings).
pub const ALL_PLAYERS: u8 = 255;
/// Minutes before the time limit that are announced (OpenRA RA world.yaml TimeLimitWarnings).
pub const TIME_LIMIT_WARNINGS: [u32; 9] = [40, 30, 20, 10, 5, 4, 3, 2, 1];
/// Ticks after a placement before NewOptions plays (OpenRA PlaceBuilding NewOptionsNotificationDelay).
pub const NEW_OPTIONS_DELAY: u32 = 10;
/// Paratrooper drops whose arrival was announced, remembered at most.
const ARRIVALS_KEPT: usize = 16;

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
        Kind::Husk => 6,
        Kind::Crate => 7,
        Kind::Proxy => 8,
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
        "SpawnActorPower" => 7,
        _ => 0,
    }
}

/// One support power of one provider: its actor type and the index into its
/// support powers, packed (`b` of PowerActivated; the client reads the key
/// from `Game.rules_json` actors[ty].powers[index]).
pub fn power_ref(provider_ty: u16, index: usize) -> i32 {
    ((provider_ty as i32) << 8) | (index as i32 & 0xff)
}

/// The infiltrator of an Infiltrated event: its actor type and owner, packed.
pub fn infiltrator_code(ty: u16, owner: u8) -> i32 {
    ((ty as i32) << 8) | owner as i32
}

/// OpenRA crate action trait class (`GiveCashCrateAction`; an `@suffix`
/// is ignored) as a number for CrateCollected; 0 for an unknown action. The
/// client's list (apps/game/js/audio/catalog.js CRATE_ACTIONS) follows this order.
pub fn crate_action_code(action: &str) -> i32 {
    match action.split('@').next().unwrap_or("") {
        "GiveCashCrateAction" => 1,
        "LevelUpCrateAction" => 2,
        "ExplodeCrateAction" => 3,
        "HideMapCrateAction" => 4,
        "HealActorsCrateAction" => 5,
        "RevealMapCrateAction" => 6,
        "DuplicateUnitCrateAction" => 7,
        "GiveBaseBuilderCrateAction" => 8,
        "GiveUnitCrateAction" => 9,
        "GrantExternalConditionCrateAction" => 10,
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
    /// Paratrooper drops already announced: (owner, power_ref, launch tick).
    arrivals: Vec<(u8, i32, u32)>,
    /// Queues whose finished unit was reported blocked: (player, queue index).
    blocked: Vec<(u8, usize)>,
    /// Pending NewOptions events: (player, tick of the placement).
    new_options: Vec<(u8, u32)>,
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
            self.arrivals.clear();
            self.blocked.clear();
            self.new_options.clear();
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

    /// ReinforcementsArrived for the first plane of a paratrooper drop
    /// (`launched`: the tick the squad was launched) that reaches the drop zone.
    pub fn push_arrival(&mut self, owner: u8, power: i32, launched: u32, x: i32, y: i32) {
        if !self.enabled || self.arrivals.contains(&(owner, power, launched)) {
            return;
        }
        if self.arrivals.len() >= ARRIVALS_KEPT {
            self.arrivals.remove(0);
        }
        self.arrivals.push((owner, power, launched));
        self.push(SoundEventKind::ReinforcementsArrived, power >> 8, x, y, owner, power & 0xff);
    }

    /// ProductionBlocked once per finished unit that cannot leave (OpenRA's
    /// `notified`); `unblock` when it left or the queue moved on.
    pub fn push_blocked(&mut self, player: u8, queue: usize, ty: u16) {
        if !self.enabled || self.blocked.contains(&(player, queue)) {
            return;
        }
        self.blocked.push((player, queue));
        self.push(SoundEventKind::ProductionBlocked, ty as i32, 0, 0, player, 0);
    }

    pub fn unblock(&mut self, player: u8, queue: usize) {
        self.blocked.retain(|&b| b != (player, queue));
    }

    /// A placement gave `player` more things to build: NewOptions follows
    /// `NEW_OPTIONS_DELAY` ticks later (`flush_new_options`).
    pub fn note_new_options(&mut self, player: u8, tick: u32) {
        if self.enabled {
            self.new_options.retain(|n| n.0 != player);
            self.new_options.push((player, tick));
        }
    }

    /// Push the NewOptions events of `player` that are due at `tick`.
    pub fn flush_new_options(&mut self, player: u8, tick: u32) {
        if self.new_options.iter().any(|n| n.0 == player && tick >= n.1 + NEW_OPTIONS_DELAY) {
            self.new_options.retain(|n| n.0 != player);
            self.push(SoundEventKind::NewOptions, 0, 0, 0, player, 0);
        }
    }

    /// TimeLimitWarning when `ticks_left` is exactly one of the announced
    /// minutes (OpenRA TimeLimitManager.Tick), for a game with
    /// `ticks_per_second` ticks per second.
    pub fn push_time_limit(&mut self, ticks_left: u32, ticks_per_second: u32) {
        if let Some(&m) = TIME_LIMIT_WARNINGS.iter().find(|&&m| ticks_left == m * 60 * ticks_per_second) {
            self.push(SoundEventKind::TimeLimitWarning, m as i32, 0, 0, ALL_PLAYERS, 0);
        }
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
