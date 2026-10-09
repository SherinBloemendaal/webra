//! Equal armies on an open field, one the exact mirror image of the other,
//! under different order styles. With fair combat the mirrored scenarios
//! (`idle_vs_idle`, `am_vs_am`) come out even whatever tick the fight starts
//! on; the others show what an order style is worth against idle or
//! attack-moving defenders.
//!
//! Usage: cargo run -p webra-sim --release --example mirror_fight -- [scenario] [reps] [army]
//! Scenarios: move_into, move_past, attack_one, attack_move, am_vs_am,
//! move_vs_am, attackone_vs_am, hold_vs_am, idle_vs_idle.
//! Armies: mixed (default: 6 E1 + 4 2TNK), inf, tanks, lt, jeeps, soviet.
//! Environment: PRE_STEPS=n starts the fight n ticks later (shifts the tick
//! parity), AXIS=y fights top against bottom, FLIP puts army A on the high
//! side, INTERLEAVE spawns the armies' units alternately (A's and B's actor
//! slots interleave instead of A's all coming first), FOG plays with fog of
//! war, VERBOSE prints every repetition.
use webra_sim::map::{Map, Terrain};
use webra_sim::math::CELL;
use webra_sim::world::{Activity, GameOptions, PlayerSetup, World};

fn cc(c: i32) -> i32 {
    c * CELL + CELL / 2
}

/// Unit `k` of `owner`'s formation centred on cell (cx, cy), facing the
/// other army; army B is army A's mirror image across the midline.
#[allow(clippy::too_many_arguments)]
fn spawn_one(w: &mut World, owner: u8, id: &str, k: usize, cx: i32, cy: i32, axis: char, flip: bool) -> usize {
    // `near` is +1 toward the enemy for the side at the low coordinate.
    let near: i32 = if (owner == 0) != flip { 1 } else { -1 };
    let ty = w.rules.actor_index(id).unwrap() as u16;
    let (da, db) = ((k as i32 % 4) - 2, (k as i32 / 4) - 1);
    let along = if near == 1 { da } else { -da - 1 };
    let (x, y) = if axis == 'x' { (cx + along, cy + db * 2) } else { (cx + db * 2, cy + along) };
    let facing = match (axis, near) {
        ('x', 1) => 256,
        ('x', _) => 768,
        (_, 1) => 512,
        _ => 0,
    };
    w.spawn_unit(ty, owner, cc(x), cc(y), facing)
}

fn alive_hp(w: &World, ids: &[usize]) -> (usize, i32) {
    let alive: Vec<usize> = ids.iter().copied().filter(|&i| w.actors[i].alive).collect();
    (alive.len(), alive.iter().map(|&i| w.actors[i].hp).sum())
}

fn main() {
    let arg = |k: usize| std::env::args().nth(k);
    let scenario = arg(1).unwrap_or_else(|| "am_vs_am".into());
    let reps: u64 = arg(2).map_or(10, |s| s.parse().expect("reps is a number"));
    let comp_name = arg(3).unwrap_or_else(|| "mixed".into());
    let comp: Vec<&str> = match comp_name.as_str() {
        "inf" => vec!["E1"; 8],
        "tanks" => vec!["2TNK"; 4],
        "lt" => vec!["1TNK"; 6],
        "jeeps" => vec!["JEEP"; 6],
        "soviet" => vec!["E1", "E1", "E1", "E1", "3TNK", "3TNK", "3TNK", "3TNK"],
        _ => vec!["E1", "E1", "E1", "E1", "E1", "E1", "2TNK", "2TNK", "2TNK", "2TNK"],
    };
    let env = |k: &str| std::env::var(k).ok();
    let pre_steps: u32 = env("PRE_STEPS").map_or(0, |v| v.parse().expect("PRE_STEPS is a number"));
    let axis = env("AXIS").map_or('x', |v| v.chars().next().unwrap_or('x'));
    let flip = env("FLIP").is_some();
    let (mut wins_a, mut wins_b, mut sum_a, mut sum_b, mut hp_a, mut hp_b) = (0, 0, 0, 0, 0i64, 0i64);
    for rep in 0..reps {
        let players = [PlayerSetup::new("allies", None), PlayerSetup::new("allies", None)];
        let options = GameOptions { fog: env("FOG").is_some(), explored: true, ..GameOptions::default() };
        let mut map = Map::filled(64, 64, Terrain::Clear);
        map.spawns = vec![(4, 4), (56, 56)];
        let mut w = World::on_map(rep + 1, map, &players, options);
        let (lo, hi) = (20, 34);
        let (a_c, b_c) = if flip { (hi, lo) } else { (lo, hi) };
        let at = |c: i32| if axis == 'x' { (c, 30) } else { (30, c) };
        let ((ax, ay), (bx, by)) = (at(a_c), at(b_c));
        let (mut a, mut b) = (Vec::new(), Vec::new());
        if env("INTERLEAVE").is_some() {
            for (k, id) in comp.iter().enumerate() {
                a.push(spawn_one(&mut w, 0, id, k, ax, ay, axis, flip));
                b.push(spawn_one(&mut w, 1, id, k, bx, by, axis, flip));
            }
        } else {
            for (k, id) in comp.iter().enumerate() {
                a.push(spawn_one(&mut w, 0, id, k, ax, ay, axis, flip));
            }
            for (k, id) in comp.iter().enumerate() {
                b.push(spawn_one(&mut w, 1, id, k, bx, by, axis, flip));
            }
        }
        // Let vision settle; PRE_STEPS shifts the tick parity of the whole fight.
        for _ in 0..=pre_steps {
            w.step();
        }
        let ((ax, ay), (bx, by)) = ((cc(ax), cc(ay)), (cc(bx), cc(by)));
        match scenario.as_str() {
            "idle_vs_idle" => {}
            "move_into" => w.order_move(&a, bx, by, false),
            "move_past" => w.order_move(&a, bx + 10 * CELL, by, false),
            "attack_one" => w.order_attack(&a, *b.last().unwrap(), true),
            "attack_move" => w.order_move(&a, bx, by, true),
            "am_vs_am" => {
                w.order_move(&a, bx, by, true);
                w.order_move(&b, ax, ay, true);
            }
            "move_vs_am" => {
                w.order_move(&a, bx, by, false);
                w.order_move(&b, ax, ay, true);
            }
            "attackone_vs_am" => {
                w.order_attack(&a, *b.last().unwrap(), true);
                w.order_move(&b, ax, ay, true);
            }
            "hold_vs_am" => w.order_move(&b, ax, ay, true),
            other => panic!("unknown scenario {other}"),
        }
        let mut t = 0;
        loop {
            w.step();
            t += 1;
            let ((na, _), (nb, _)) = (alive_hp(&w, &a), alive_hp(&w, &b));
            let quiet = w.actors.iter().filter(|x| x.alive).all(|x| x.activity != Activity::Attack);
            if na == 0 || nb == 0 || t > 25 * 240 || (t > 25 * 60 && quiet) {
                break;
            }
        }
        let ((na, ha), (nb, hb)) = (alive_hp(&w, &a), alive_hp(&w, &b));
        if na > nb {
            wins_a += 1;
        } else if nb > na {
            wins_b += 1;
        }
        sum_a += na;
        sum_b += nb;
        hp_a += ha as i64;
        hp_b += hb as i64;
        if env("VERBOSE").is_some() {
            println!("rep {rep}: A {na} ({ha} hp) vs B {nb} ({hb} hp) after {t} ticks");
        }
    }
    let r = reps.max(1) as f64;
    println!(
        "{scenario} [{comp_name}] x{reps}, pre steps {pre_steps}: A wins {wins_a}, B wins {wins_b}; mean survivors A {:.2} B {:.2}; mean hp A {:.0} B {:.0}",
        sum_a as f64 / r,
        sum_b as f64 / r,
        hp_a as f64 / r,
        hp_b as f64 / r
    );
}
