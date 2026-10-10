//! OpenRA AttackOrFleeFuzzy: a Mamdani fuzzy system (min for "and", max for
//! "or", min implication, max aggregation, centroid) that decides whether a
//! group of own units attacks a group of enemies, from both sides' health,
//! their relative firepower and their relative speed. Integer math only
//! (inputs in thousandths, memberships in thousandths), so every client
//! decides alike; OpenRA uses doubles.

use crate::world::World;

/// Health terms (percent of maximum health).
#[derive(Clone, Copy, PartialEq, Eq)]
enum Health {
    NearDead,
    Injured,
    Normal,
}

/// Relative attack power and speed terms (own as a percentage of the enemy's).
#[derive(Clone, Copy, PartialEq, Eq)]
enum Rel {
    Low,
    Equal,
    High,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Out {
    Attack,
    Flee,
}

/// "if (OwnHealth is any of ...) and (EnemyHealth ...) and (RelativeAttackPower ...)
/// and (RelativeSpeed ...) then AttackOrFlee is ...".
struct Rule(&'static [Health], &'static [Health], &'static [Rel], &'static [Rel], Out);

use Health::{Injured, NearDead, Normal};
use Rel::{Equal, High, Low};
const ANY_H: &[Health] = &[NearDead, Injured, Normal];
const ANY_R: &[Rel] = &[Low, Equal, High];

const DEFAULT_NORMAL: &[Rule] = &[Rule(&[Normal], ANY_H, ANY_R, ANY_R, Out::Attack)];
const RUSH_NORMAL: &[Rule] =
    &[Rule(&[Normal], ANY_H, &[High], ANY_R, Out::Attack), Rule(&[Normal], ANY_H, &[Low, Equal], ANY_R, Out::Flee)];
const INJURED: &[Rule] = &[
    Rule(&[Injured], &[NearDead], ANY_R, ANY_R, Out::Attack),
    Rule(&[Injured], &[Injured, Normal], &[Equal, High], ANY_R, Out::Attack),
    Rule(&[Injured], &[Injured, Normal], &[Low], &[Low], Out::Attack),
    Rule(&[Injured], &[Injured, Normal], &[Low], &[Equal, High], Out::Flee),
    Rule(&[Injured], ANY_H, ANY_R, &[Low], Out::Attack),
];
const NEAR_DEAD: &[Rule] = &[
    Rule(&[NearDead], &[NearDead, Injured], &[Equal, High], &[Low, Equal], Out::Attack),
    Rule(&[NearDead], &[NearDead, Injured], &[Low], &[Equal, High], Out::Flee),
    Rule(&[NearDead], &[Normal], &[Low], &[Equal, High], Out::Flee),
    Rule(&[NearDead], &[Normal], &[Equal, High], &[High], Out::Flee),
    Rule(&[NearDead], &[Injured], &[Equal], &[High], Out::Flee),
];

/// OpenRA TrapezoidMembershipFunction, all values in thousandths; the result
/// is the membership in thousandths.
fn trapezoid(x: i64, a: i64, b: i64, c: i64, d: i64) -> i64 {
    if (x == a && x == b) || (x == c && x == d) {
        return 1000;
    }
    if x <= a || x >= d {
        0
    } else if x >= b && x <= c {
        1000
    } else if x < b {
        (x - a) * 1000 / (b - a)
    } else {
        (d - x) * 1000 / (d - c)
    }
}

fn health(term: Health, x: i64) -> i64 {
    match term {
        NearDead => trapezoid(x, 0, 0, 20_000, 40_000),
        Injured => trapezoid(x, 30_000, 50_000, 50_000, 70_000),
        Normal => trapezoid(x, 50_000, 80_000, 100_000, 100_000),
    }
}

fn relative(term: Rel, x: i64) -> i64 {
    match term {
        Low => trapezoid(x, 0, 0, 70_000, 90_000),
        Equal => trapezoid(x, 85_000, 100_000, 100_000, 115_000),
        High => trapezoid(x, 110_000, 150_000, 150_000, 1_000_000),
    }
}

fn output(term: Out, y: i64) -> i64 {
    match term {
        Out::Attack => trapezoid(y, 0, 15_000, 15_000, 30_000),
        Out::Flee => trapezoid(y, 25_000, 35_000, 35_000, 50_000),
    }
}

/// The two rule sets OpenRA uses: `Default` for squads in the field, `Rush`
/// for rushes on an enemy base.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Fuzzy {
    Default,
    Rush,
}

/// The fuzzy inputs, in thousandths: own and enemy health in percent,
/// relative attack power and speed in percent (0 to 999); None when OpenRA's
/// would be NaN (it never attacks then).
fn inputs(w: &World, own: &[usize], enemies: &[usize]) -> Option<[i64; 4]> {
    let power = relative_value(own.len(), enemies.len(), sum_of(w, own, |i| damage_rate(w, i)), sum_of(w, enemies, |i| damage_rate(w, i)))?;
    let speed = relative_value(own.len(), enemies.len(), average_speed(w, own), average_speed(w, enemies))?;
    Some([normalized_health(w, own) * 1000, normalized_health(w, enemies) * 1000, power, speed])
}

/// OpenRA AttackOrFleeFuzzy.CanAttack.
/// WebRA: when none of the enemies is armed (only structures and units that
/// cannot shoot back), the squad attacks; OpenRA's rules could still have a
/// badly hurt squad flee from undefended structures for good.
pub(crate) fn can_attack(w: &World, rules: Fuzzy, own: &[usize], enemies: &[usize]) -> bool {
    if !own.is_empty() && enemies.iter().all(|&i| w.rules.actors[w.actors[i].ty as usize].weapons.is_empty()) {
        return true;
    }
    let Some([own_hp, enemy_hp, power, speed]) = inputs(w, own, enemies) else { return false };
    let normal = if rules == Fuzzy::Rush { RUSH_NORMAL } else { DEFAULT_NORMAL };
    let fired: Vec<(i64, Out)> = normal
        .iter()
        .chain(INJURED)
        .chain(NEAR_DEAD)
        .map(|r| {
            let any_h = |set: &[Health], x: i64| set.iter().map(|&t| health(t, x)).max().unwrap_or(0);
            let any_r = |set: &[Rel], x: i64| set.iter().map(|&t| relative(t, x)).max().unwrap_or(0);
            let degree = any_h(r.0, own_hp).min(any_h(r.1, enemy_hp)).min(any_r(r.2, power)).min(any_r(r.3, speed));
            (degree, r.4)
        })
        .filter(|&(d, _)| d > 0)
        .collect();
    // Centroid of the aggregated output over 0..50, sampled every 0.1.
    let (mut num, mut den) = (0i64, 0i64);
    for k in 0..=500i64 {
        let y = k * 100;
        let mu = fired.iter().map(|&(d, o)| d.min(output(o, y))).max().unwrap_or(0);
        num += k * mu;
        den += mu;
    }
    // AttackOrFlee below 30 means attack.
    den > 0 && num < 300 * den
}

/// OpenRA NormalizedHealth: total health in percent of the total maximum.
fn normalized_health(w: &World, actors: &[usize]) -> i64 {
    let (mut hp, mut max) = (0i64, 0i64);
    for &i in actors {
        hp += w.actors[i].hp.max(0) as i64;
        max += w.rules.actors[w.actors[i].ty as usize].hp as i64;
    }
    if max == 0 {
        0
    } else {
        hp * 100 / max
    }
}

/// OpenRA RelativeValue in thousandths: own / enemy * 100, clamped to 0..999.
fn relative_value(own_count: usize, enemy_count: usize, own: Option<i64>, enemy: Option<i64>) -> Option<i64> {
    if enemy_count == 0 {
        return Some(999_000);
    }
    if own_count == 0 {
        return Some(0);
    }
    let (own, enemy) = (own.unwrap_or(0), enemy.unwrap_or(0));
    if enemy == 0 {
        // Division by zero: infinity clamps to 999, 0 / 0 is NaN.
        return (own != 0).then_some(999_000);
    }
    Some((own * 100_000 / enemy).clamp(0, 999_000))
}

fn sum_of(w: &World, actors: &[usize], f: impl Fn(usize) -> i64) -> Option<i64> {
    Some(actors.iter().filter(|&&i| !w.rules.actors[w.actors[i].ty as usize].weapons.is_empty()).map(|&i| f(i)).sum())
}

/// OpenRA RelativePower per actor: for every weapon and damage warhead,
/// Damage * Burst / (ReloadDelay + BurstDelay * (Burst - 1), at least 1 and
/// at most 200 added) * 100, in integer steps like OpenRA.
fn damage_rate(w: &World, i: usize) -> i64 {
    let info = &w.rules.actors[w.actors[i].ty as usize];
    let mut sum = 0i64;
    for &wi in &info.weapons {
        let wp = &w.rules.weapons[wi];
        let burst = wp.burst.max(1) as i64;
        let first_delay = wp.burst_delays.first().copied().unwrap_or(5) as i64;
        let reload = wp.reload as i64 + (first_delay * (burst - 1)).clamp(1, 200);
        for h in &wp.warheads {
            sum += h.damage as i64 * burst / reload.max(1) * 100;
        }
    }
    sum
}

/// OpenRA Average<MobileInfo> of Speed: integer mean over units that move
/// on the ground or water (aircraft have no Mobile).
fn average_speed(w: &World, actors: &[usize]) -> Option<i64> {
    let speeds: Vec<i64> = actors
        .iter()
        .filter(|&&i| w.domain_of(i) != crate::rules::Domain::Air)
        .filter_map(|&i| w.rules.actors[w.actors[i].ty as usize].unit.as_ref().map(|u| u.speed as i64))
        .collect();
    if speeds.is_empty() {
        return Some(0);
    }
    Some(speeds.iter().sum::<i64>() / speeds.len() as i64)
}
