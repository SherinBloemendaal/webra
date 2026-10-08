//! Biomes and weather. Everything here is part of the deterministic
//! simulation: the weather cycle runs on its own random stream seeded from
//! the game seed, so every peer sees the same sky at the same tick, and it
//! never draws from the world's random stream (turning weather off changes
//! nothing else in a game).
//!
//! A map has one biome (map file field `biome`, lobby option `biome` for
//! generated maps); the biome decides the terrain palette (rendering only) and
//! which weather can happen. The lobby option `weather` decides what weather
//! does: `full` (visuals and the modest gameplay effects below), `cosmetic`
//! (visuals only, no effect on the simulation at all, including the biome
//! effects) or `off` (always clear skies, no effects).
//!
//! Gameplay effects with `full`, every number in one place:
//!
//! | What | Effect |
//! |------|--------|
//! | Rain | sight of every actor 90 % |
//! | Thunderstorm | sight 85 %; lightning is cosmetic (no damage) |
//! | Snowfall (snow) | sight 85 % |
//! | Sandstorm (desert) | sight 75 % |
//! | Snow biome, infantry | speed 90 % |
//! | Snow biome, vehicles | momentum: gain 10 % of top speed per tick, lose 12 % per tick when braking or coasting (ice: 6 % and 7 %), turn at 70 % (ice 50 %) of their turn rate, keep sliding along their heading while they turn and for a short coast after stopping (about half a cell at full speed on snow, under a cell on ice) |
//! | Ice | rough ground in the snow biome (frozen ponds) |
//! | Heat wave (desert), vehicles | heat +1 per tick driving (40 s of driving), +25 per shot; at 1000 a vehicle overheats: speed 75 %, reload 4/3 as long, until it cools to 400 |
//! | Cooling | heat -5 per tick standing still without firing; -1 per tick otherwise outside a heat wave |
//!
//! Weather cycle: clear skies for the first 2 to 3 minutes, then the biome's
//! weather alternates with clear spells (temperate: rain or thunderstorm;
//! snow: snowfall; desert: heat wave or sandstorm), see [`next_weather`].

use crate::rng::Rng;
use crate::world::TICKS_PER_SECOND;

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Biome {
    #[default]
    Temperate,
    Snow,
    Desert,
}

impl Biome {
    pub const ALL: [Biome; 3] = [Biome::Temperate, Biome::Snow, Biome::Desert];

    pub fn name(self) -> &'static str {
        match self {
            Biome::Temperate => "temperate",
            Biome::Snow => "snow",
            Biome::Desert => "desert",
        }
    }

    pub fn from_name(s: &str) -> Option<Biome> {
        Biome::ALL.into_iter().find(|b| b.name() == s)
    }

    /// The biome of `random`: picked from the game seed.
    pub fn random(seed: u64) -> Biome {
        Biome::ALL[Rng::new(seed ^ 0xb10e_0000_0000_0003).range(0, Biome::ALL.len() as i32) as usize]
    }

    /// Map files leave the field out for the default biome.
    pub fn is_temperate(&self) -> bool {
        *self == Biome::Temperate
    }
}

/// Lobby option `weather`.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum WeatherMode {
    /// Visuals and gameplay effects.
    #[default]
    Full,
    /// Visuals only; the simulation behaves as with clear skies everywhere.
    Cosmetic,
    /// Clear skies, nothing happens.
    Off,
}

impl WeatherMode {
    pub fn name(self) -> &'static str {
        match self {
            WeatherMode::Full => "full",
            WeatherMode::Cosmetic => "cosmetic",
            WeatherMode::Off => "off",
        }
    }

    pub fn from_name(s: &str) -> Option<WeatherMode> {
        [WeatherMode::Full, WeatherMode::Cosmetic, WeatherMode::Off].into_iter().find(|m| m.name() == s)
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u8)]
pub enum Weather {
    Clear = 0,
    Rain = 1,
    Thunderstorm = 2,
    Snowfall = 3,
    Sandstorm = 4,
    HeatWave = 5,
}

impl Weather {
    pub fn name(self) -> &'static str {
        match self {
            Weather::Clear => "clear",
            Weather::Rain => "rain",
            Weather::Thunderstorm => "thunderstorm",
            Weather::Snowfall => "snowfall",
            Weather::Sandstorm => "sandstorm",
            Weather::HeatWave => "heatwave",
        }
    }

    /// Sight of every actor in percent (with `WeatherMode::Full`).
    pub fn sight_pct(self) -> i32 {
        match self {
            Weather::Clear | Weather::HeatWave => 100,
            Weather::Rain => 90,
            Weather::Thunderstorm | Weather::Snowfall => 85,
            Weather::Sandstorm => 75,
        }
    }
}

const SECOND: u32 = TICKS_PER_SECOND;

// Snow momentum (vehicles), percent of top speed per tick and of the turn rate.
pub const SNOW_ACCEL_PCT: i32 = 10;
pub const ICE_ACCEL_PCT: i32 = 6;
pub const SNOW_BRAKE_PCT: i32 = 12;
pub const ICE_BRAKE_PCT: i32 = 7;
pub const SNOW_TURN_PCT: i32 = 70;
pub const ICE_TURN_PCT: i32 = 50;
pub const SNOW_INFANTRY_SPEED_PCT: i32 = 90;

// Desert heat (vehicles).
pub const HEAT_MAX: i32 = 1000;
pub const HEAT_RECOVER: i32 = 400;
pub const HEAT_MOVE: i32 = 1;
pub const HEAT_FIRE: i32 = 25;
pub const HEAT_COOL_IDLE: i32 = 5;
pub const HEAT_COOL_ACTIVE: i32 = 1;
pub const OVERHEAT_SPEED_PCT: i32 = 75;
/// Reload time of an overheated vehicle, percent of the normal time.
pub const OVERHEAT_RELOAD_PCT: i32 = 133;

/// Per-unit weather state.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct UnitEnv {
    /// Current speed (world units per tick) of a vehicle on snow.
    pub vel: i32,
    /// Direction the vehicle is sliding in (its facing when it last drove).
    pub heading: i32,
    /// Heat, 0..=HEAT_MAX.
    pub heat: i32,
    pub overheated: bool,
    /// Fired a weapon this tick (heat).
    pub fired: bool,
}

/// The sky over a game.
#[derive(Clone, Debug)]
pub struct Environment {
    pub biome: Biome,
    pub mode: WeatherMode,
    pub weather: Weather,
    /// Ticks the current weather started and ends.
    pub since: u32,
    pub until: u32,
    /// Latest lightning flash: tick and world position (cosmetic).
    pub flash: Option<(u32, i32, i32)>,
    next_flash: u32,
    rng: Rng,
}

impl Default for Environment {
    fn default() -> Self {
        Environment::new(Biome::Temperate, WeatherMode::Off, 0)
    }
}

impl Environment {
    pub fn new(biome: Biome, mode: WeatherMode, seed: u64) -> Environment {
        let mut rng = Rng::new(seed ^ 0x5ca1_ab1e_0000_0005);
        // Clear skies for the opening: two to three minutes.
        let until = 120 * SECOND + rng.range(0, 60) as u32 * SECOND;
        Environment { biome, mode, weather: Weather::Clear, since: 0, until, flash: None, next_flash: 0, rng }
    }

    /// Gameplay effects apply (not cosmetic, not off).
    pub fn effects(&self) -> bool {
        self.mode == WeatherMode::Full
    }

    /// Sight after weather, from a base sight in world units.
    pub fn sight(&self, sight: i32) -> i32 {
        if !self.effects() {
            return sight;
        }
        sight * self.weather.sight_pct() / 100
    }

    pub fn snow_effects(&self) -> bool {
        self.effects() && self.biome == Biome::Snow
    }

    pub fn heat_wave(&self) -> bool {
        self.effects() && self.weather == Weather::HeatWave
    }

    /// Advance the cycle by one tick (World::step).
    pub fn tick(&mut self, tick: u32, width: i32, height: i32) {
        if self.mode == WeatherMode::Off {
            return;
        }
        if tick >= self.until {
            let (next, secs) = next_weather(self.biome, self.weather, &mut self.rng);
            self.weather = next;
            self.since = tick;
            self.until = tick + secs * SECOND;
            self.next_flash = tick + 3 * SECOND;
        }
        if self.weather == Weather::Thunderstorm && tick >= self.next_flash {
            let x = self.rng.range(0, width.max(1)) * crate::math::CELL + crate::math::HALF_CELL;
            let y = self.rng.range(0, height.max(1)) * crate::math::CELL + crate::math::HALF_CELL;
            self.flash = Some((tick, x, y));
            self.next_flash = tick + (4 + self.rng.range(0, 9) as u32) * SECOND;
        }
    }
}

/// The weather after `now` and how long it lasts (seconds): clear spells
/// alternate with the biome's weather.
pub fn next_weather(biome: Biome, now: Weather, rng: &mut Rng) -> (Weather, u32) {
    if now != Weather::Clear {
        return (Weather::Clear, 90 + rng.range(0, 91) as u32);
    }
    let roll = rng.range(0, 100);
    match biome {
        Biome::Temperate if roll < 60 => (Weather::Rain, 60 + rng.range(0, 61) as u32),
        Biome::Temperate => (Weather::Thunderstorm, 45 + rng.range(0, 46) as u32),
        Biome::Snow => (Weather::Snowfall, 60 + rng.range(0, 91) as u32),
        Biome::Desert if roll < 60 => (Weather::HeatWave, 60 + rng.range(0, 61) as u32),
        Biome::Desert => (Weather::Sandstorm, 40 + rng.range(0, 51) as u32),
    }
}

/// Lobby and editor preview colour of a terrain type in a biome (RGB).
pub fn preview_color(biome: Biome, t: crate::map::Terrain) -> [u8; 3] {
    use crate::map::Terrain as T;
    match (biome, t) {
        (Biome::Temperate, T::Clear) => [62, 88, 44],
        (Biome::Temperate, T::Rough) => [96, 92, 58],
        (Biome::Temperate, T::Rock) => [128, 118, 102],
        (Biome::Temperate, T::Water) => [36, 70, 102],
        (Biome::Temperate, T::Tree) => [28, 54, 24],
        (Biome::Temperate, T::Ford) => [74, 112, 118],
        (Biome::Snow, T::Clear) => [206, 214, 222],
        (Biome::Snow, T::Rough) => [158, 196, 222],
        (Biome::Snow, T::Rock) => [112, 114, 124],
        (Biome::Snow, T::Water) => [34, 62, 96],
        (Biome::Snow, T::Tree) => [40, 66, 58],
        (Biome::Snow, T::Ford) => [110, 150, 182],
        (Biome::Desert, T::Clear) => [200, 168, 110],
        (Biome::Desert, T::Rough) => [218, 188, 124],
        (Biome::Desert, T::Rock) => [150, 94, 60],
        (Biome::Desert, T::Water) => [38, 116, 138],
        (Biome::Desert, T::Tree) => [92, 122, 58],
        (Biome::Desert, T::Ford) => [112, 168, 158],
    }
}

/// Grip of a vehicle on snow: (acceleration, braking, turn rate), the first
/// two in percent of top speed per tick, the last in percent of the turn rate.
pub fn grip(ice: bool) -> (i32, i32, i32) {
    if ice {
        (ICE_ACCEL_PCT, ICE_BRAKE_PCT, ICE_TURN_PCT)
    } else {
        (SNOW_ACCEL_PCT, SNOW_BRAKE_PCT, SNOW_TURN_PCT)
    }
}

/// Heat after one tick. `driving` and `fired` describe the tick.
pub fn heat_step(env: &mut UnitEnv, heat_wave: bool, driving: bool, fired: bool) {
    let mut h = env.heat;
    if heat_wave && (driving || fired) {
        if driving {
            h += HEAT_MOVE;
        }
        if fired {
            h += HEAT_FIRE;
        }
    } else if !driving && !fired {
        h -= HEAT_COOL_IDLE;
    } else {
        h -= HEAT_COOL_ACTIVE;
    }
    env.heat = h.clamp(0, HEAT_MAX);
    if env.heat >= HEAT_MAX {
        env.overheated = true;
    } else if env.heat <= HEAT_RECOVER {
        env.overheated = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_cycle_is_deterministic_and_alternates_with_clear_skies() {
        for biome in Biome::ALL {
            let mut a = Environment::new(biome, WeatherMode::Full, 9);
            let mut b = Environment::new(biome, WeatherMode::Full, 9);
            let mut seen = Vec::new();
            let mut last = Weather::Clear;
            for t in 0..25 * 60 * 40 {
                a.tick(t, 64, 64);
                b.tick(t, 64, 64);
                assert_eq!((a.weather, a.flash), (b.weather, b.flash));
                if a.weather != last {
                    assert!(a.weather == Weather::Clear || last == Weather::Clear, "{biome:?}: {last:?} then {:?}", a.weather);
                    if t < 120 * 25 {
                        panic!("{biome:?}: weather before the opening ended");
                    }
                    last = a.weather;
                    seen.push(a.weather);
                }
            }
            let allowed: &[Weather] = match biome {
                Biome::Temperate => &[Weather::Clear, Weather::Rain, Weather::Thunderstorm],
                Biome::Snow => &[Weather::Clear, Weather::Snowfall],
                Biome::Desert => &[Weather::Clear, Weather::HeatWave, Weather::Sandstorm],
            };
            assert!(seen.len() >= 6, "{biome:?}: {seen:?}");
            assert!(seen.iter().all(|w| allowed.contains(w)), "{biome:?}: {seen:?}");
        }
    }

    #[test]
    fn off_and_cosmetic_have_no_gameplay_effect() {
        let mut off = Environment::new(Biome::Desert, WeatherMode::Off, 1);
        for t in 0..25 * 60 * 20 {
            off.tick(t, 64, 64);
            assert_eq!(off.weather, Weather::Clear);
        }
        let mut cosmetic = Environment::new(Biome::Desert, WeatherMode::Cosmetic, 1);
        let mut changed = false;
        for t in 0..25 * 60 * 20 {
            cosmetic.tick(t, 64, 64);
            changed |= cosmetic.weather != Weather::Clear;
            assert_eq!(cosmetic.sight(5000), 5000);
            assert!(!cosmetic.heat_wave() && !cosmetic.snow_effects());
        }
        assert!(changed, "cosmetic weather still shows");
    }

    #[test]
    fn heat_builds_in_a_heat_wave_and_cools_when_idle() {
        let mut u = UnitEnv::default();
        let mut ticks = 0;
        while !u.overheated {
            heat_step(&mut u, true, true, false);
            ticks += 1;
        }
        assert_eq!(ticks, (HEAT_MAX / HEAT_MOVE) as u32, "40 s of driving in a heat wave");
        let mut cool = 0;
        while u.overheated {
            heat_step(&mut u, true, false, false);
            cool += 1;
        }
        assert_eq!(cool, ((HEAT_MAX - HEAT_RECOVER) / HEAT_COOL_IDLE) as u32, "about 5 s idle to recover");
        // Outside a heat wave driving cools slowly and never overheats.
        let mut v = UnitEnv { heat: 600, ..Default::default() };
        for _ in 0..1000 {
            heat_step(&mut v, false, true, true);
        }
        assert_eq!(v.heat, 0);
        assert!(!v.overheated);
    }
}
