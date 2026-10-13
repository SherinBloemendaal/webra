//! Per-system timers of the simulation tick, for the headless benchmark
//! (examples/sim_bench.rs, docs/contracts.md "Simulation performance").
//!
//! Built only with the `profile` feature (native targets): without it
//! `scope` returns an empty value and compiles to nothing, so the game's
//! build carries no timer. The timers read the wall clock and never
//! touch the simulation state.
//!
//! The top-level sections (World::step) follow one another and add up to
//! the tick. The nested ones (indented in the report: target scans happen
//! inside unit activities, flow fields inside moves) count the whole time
//! spent inside them, which their top-level section counts as well.

/// A timed part of the tick.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Section {
    /// Copying positions, the unit hash and the occupancy table (World::step).
    TickStart,
    /// Player and AI orders.
    Orders,
    /// The skirmish AI.
    Ai,
    /// Production, power and support powers, repairs, crates, husks.
    Economy,
    /// Every unit's activity, movement and weapons (units.rs).
    Units,
    /// Idle upkeep of the OpenRA movement model (cellmove.rs `cell_idle`).
    Idle,
    /// Cell movement (cellmove.rs `cell_move`).
    CellMove,
    /// Route searches (movement/search.rs).
    RouteSearch,
    /// Flow field computations (flowfield.rs).
    FlowFields,
    /// Target scans (combat.rs `scan_for_target`).
    TargetScan,
    /// Projectiles and impacts.
    Projectiles,
    /// Removing the dead.
    Cleanup,
    /// Vision and fog of war (vision.rs).
    Vision,
    /// Victory checks, statistics and the rest of the tick.
    Rest,
}

/// Every section, in report order.
pub const SECTIONS: [Section; 14] = [
    Section::TickStart,
    Section::Orders,
    Section::Ai,
    Section::Economy,
    Section::Units,
    Section::Idle,
    Section::CellMove,
    Section::RouteSearch,
    Section::FlowFields,
    Section::TargetScan,
    Section::Projectiles,
    Section::Cleanup,
    Section::Vision,
    Section::Rest,
];

impl Section {
    pub fn name(self) -> &'static str {
        match self {
            Section::TickStart => "tick start (hash, occupancy)",
            Section::Orders => "orders",
            Section::Ai => "ai",
            Section::Economy => "production, powers, crates",
            Section::Units => "units (all activities)",
            Section::Idle => "  idle upkeep",
            Section::CellMove => "  cell moves",
            Section::RouteSearch => "    route searches",
            Section::FlowFields => "    flow fields",
            Section::TargetScan => "  target scans",
            Section::Projectiles => "projectiles",
            Section::Cleanup => "cleanup",
            Section::Vision => "vision",
            Section::Rest => "victory, stats, rest",
        }
    }
}

#[cfg(feature = "profile")]
mod imp {
    use super::{Section, SECTIONS};
    use std::cell::RefCell;
    use std::time::Instant;

    thread_local! {
        static TOTALS: RefCell<[(u64, u64); SECTIONS.len()]> = const { RefCell::new([(0, 0); SECTIONS.len()]) };
    }

    fn add(s: Section, since: Instant) {
        let ns = since.elapsed().as_nanos() as u64;
        TOTALS.with(|t| {
            let e = &mut t.borrow_mut()[s as usize];
            e.0 += ns;
            e.1 += 1;
        });
    }

    /// Adds the time from its creation (or the last `next`) to its drop to
    /// a section.
    pub struct Scope(Section, Instant);

    impl Scope {
        /// Ends the current section and starts timing `s`.
        pub fn next(&mut self, s: Section) {
            add(self.0, self.1);
            self.0 = s;
            self.1 = Instant::now();
        }
    }

    impl Drop for Scope {
        fn drop(&mut self) {
            add(self.0, self.1);
        }
    }

    #[inline]
    pub fn scope(s: Section) -> Scope {
        Scope(s, Instant::now())
    }

    /// Nanoseconds and entries per section since the last call; resets them.
    pub fn take() -> Vec<(Section, u64, u64)> {
        TOTALS.with(|t| {
            let mut t = t.borrow_mut();
            let out = SECTIONS.iter().map(|&s| (s, t[s as usize].0, t[s as usize].1)).collect();
            *t = [(0, 0); SECTIONS.len()];
            out
        })
    }
}

#[cfg(feature = "profile")]
pub use imp::{scope, take, Scope};

/// Without the `profile` feature a scope is an empty value.
#[cfg(not(feature = "profile"))]
pub struct Scope;

#[cfg(not(feature = "profile"))]
impl Scope {
    #[inline(always)]
    pub fn next(&mut self, _: Section) {}
}

#[cfg(not(feature = "profile"))]
#[inline(always)]
pub fn scope(_: Section) -> Scope {
    Scope
}

/// Without the `profile` feature there is nothing to report.
#[cfg(not(feature = "profile"))]
pub fn take() -> Vec<(Section, u64, u64)> {
    Vec::new()
}

/// Whether the timers are built in.
pub const ENABLED: bool = cfg!(feature = "profile");
