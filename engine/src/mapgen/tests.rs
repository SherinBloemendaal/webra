//! Map style tests: every style keeps the generator's fairness rules (mirror
//! symmetry, ground connectivity, identical pockets) and adds a connected
//! water network with a harbour per base in the naval styles.

use super::metrics::measure;
use super::MapStyle;
use crate::map::{Map, Terrain};

fn sizes(players: usize) -> &'static [i32] {
    if players <= 4 {
        &[64, 96, 128]
    } else {
        &[96, 128, 160]
    }
}

fn mirrored(m: &Map) -> bool {
    (0..m.height).all(|y| {
        (0..m.width).all(|x| {
            let (i, j) = (m.idx(x, y), m.idx(m.width - 1 - x, y));
            m.terrain[i] == m.terrain[j] && m.ore[i] == m.ore[j] && m.gems[i] == m.gems[j]
        })
    })
}

#[test]
fn random_style_is_picked_from_the_seed_and_covers_every_style() {
    let picked: Vec<MapStyle> = (0..40).map(|s| MapStyle::Random.resolve(s)).collect();
    for style in MapStyle::CONCRETE {
        assert!(picked.contains(&style), "{style:?} never picked");
        assert_eq!(style.resolve(7), style, "a concrete style stays");
        assert_eq!(MapStyle::from_name(style.name()), Some(style));
    }
    assert_eq!(picked, (0..40).map(|s| MapStyle::Random.resolve(s)).collect::<Vec<_>>(), "deterministic");
    assert_eq!(MapStyle::from_name("random"), Some(MapStyle::Random));
    assert_eq!(MapStyle::from_name("volcano"), None);
}

/// Every style, player count, size and a handful of seeds: mirrored, ground
/// connected, ore only on clear or rough ground, and in the naval styles a
/// harbour on the one water network for every base.
#[test]
fn every_style_is_fair_and_connected() {
    for style in MapStyle::CONCRETE {
        for players in 2..=8 {
            for &size in sizes(players) {
                for seed in 0..4 {
                    let m = Map::generate_styled(size, size, seed, 12, players, style);
                    let what = format!("{style:?}, {players} players, size {size}, seed {seed}");
                    assert_eq!(m.spawns.len(), players, "{what}");
                    assert!(mirrored(&m), "{what}: mirrored");
                    for &s in &m.spawns {
                        assert!(m.connected(m.spawns[0], s), "{what}: spawn {s:?} reachable by ground");
                    }
                    for i in 0..m.cells() {
                        assert!(!m.has_resource(i) || m.terrain[i].holds_ore(), "{what}: ore or gems on {:?}", m.terrain[i]);
                    }
                    assert_eq!(super::validate(&m, style), Ok(()), "{what}");
                    let stats = measure(&m);
                    if style.naval() {
                        for (k, b) in stats.bases.iter().enumerate() {
                            assert!(b.naval_yard_site, "{what}: base {k} has no naval yard site on the network: {b:?}");
                            assert!(b.naval_steps.is_some(), "{what}: base {k} cut off from the water network");
                        }
                        assert!(stats.water as i32 > size * size / 40, "{what}: too little water ({})", stats.water);
                    } else {
                        assert_eq!(stats.fords, 0, "{what}: fords on a land map");
                    }
                }
            }
        }
    }
}

/// Two players: the bases are mirror images, so everything they get is equal.
#[test]
fn two_player_bases_get_identical_access() {
    for style in MapStyle::CONCRETE {
        for seed in 0..12 {
            let m = Map::generate_styled(96, 96, seed, 12, 2, style);
            let s = measure(&m);
            assert_eq!(s.bases[0], s.bases[1], "{style:?} seed {seed}");
        }
    }
}

/// Three to eight players: every harbour is about as far from the hub of the
/// water network as the others (channels run nearly straight to it, and the
/// hub sits where the bases are evenly far), in the same range as the ground
/// distances between bases differ.
#[test]
fn naval_access_is_close_to_equal_for_every_base() {
    for style in [MapStyle::Rivers, MapStyle::Lakes, MapStyle::Islands] {
        for players in 3..=8 {
            let size = if players <= 4 { 96 } else { 128 };
            for seed in 0..6 {
                let m = Map::generate_styled(size, size, seed, 12, players, style);
                let s = measure(&m);
                let what = format!("{style:?}, {players} players, seed {seed}");
                let (lo, hi) = s.spread(|b| b.naval_steps).unwrap_or_else(|| panic!("{what}: no harbour on the network: {s:?}"));
                assert!(2 * hi <= 3 * lo + 16, "{what}: naval steps from the hub {lo}..{hi}");
                let (lo, _) = s.spread(|b| Some(b.harbour_cells)).unwrap();
                assert!(lo >= 20, "{what}: harbour of {lo} cells");
            }
        }
    }
}

/// Seeds make different maps: styles vary, and so does the amount of water.
#[test]
fn seeds_make_varied_maps() {
    let styles: std::collections::BTreeSet<&str> = (0..12).map(|seed| MapStyle::Random.resolve(seed).name()).collect();
    assert!(styles.len() >= 3, "styles over 12 seeds: {styles:?}");
    for players in [2, 4, 6] {
        let size = if players <= 4 { 96 } else { 128 };
        let maps: Vec<Map> = (0..12).map(|seed| Map::generate_for(size, size, seed, 12, players)).collect();
        let water: Vec<u32> = maps.iter().map(|m| measure(m).water).collect();
        let (lo, hi) = (water.iter().min().unwrap(), water.iter().max().unwrap());
        assert!(*hi >= 2 * lo, "{players} players: water per seed {water:?}");
        for (a, ma) in maps.iter().enumerate() {
            for mb in &maps[a + 1..] {
                assert_ne!(ma.terrain, mb.terrain, "{players} players: two seeds made the same map");
            }
        }
    }
}

/// Rivers cross the map, so ground routes over them use fords; to ships a
/// ford is land (OpenRA's ford templates are Rough and Road), so no base
/// needs one to reach the shared sea: with every ford counted as land each
/// base still has its naval yard site and its route to the hub.
#[test]
fn rivers_have_fords_and_no_sea_route_needs_one() {
    assert!(Terrain::Ford.passable() && !Terrain::Ford.ship_passable() && !Terrain::Ford.landing_passable());
    assert!(!Terrain::Ford.buildable() && !Terrain::Ford.holds_ore());
    let mut fords = 0;
    for seed in 0..8 {
        for players in [2, 4, 6] {
            let size = if players <= 4 { 96 } else { 128 };
            let m = Map::generate_styled(size, size, seed, 12, players, MapStyle::Rivers);
            let stats = measure(&m);
            fords += stats.fords;
            for (k, b) in stats.bases.iter().enumerate() {
                assert!(b.naval_yard_site && b.naval_steps.is_some(), "seed {seed}, {players} players: base {k} {b:?}");
            }
        }
    }
    assert!(fords > 0, "rivers without fords");
}

/// Every generator preset over many seeds: the map passes the generator's
/// validation (`mapgen::validate`: bases joined by ground, no large land cut
/// off, and in the naval styles a naval yard site on the shared sea for
/// every base, over open water only), and the first layout already does
/// almost always: sea routes are kept free of roads and fords, channels
/// stay off the map border and land enclosed by sea routes is flooded, so
/// the retry with another layout is a rare fallback.
#[test]
fn every_preset_passes_validation_almost_always_at_the_first_layout() {
    let (mut total, mut retried) = (0, Vec::new());
    for style in MapStyle::CONCRETE {
        for players in 2..=8 {
            for &size in sizes(players) {
                for seed in 0..12u64 {
                    total += 1;
                    let first = if players == 2 {
                        Map::generate_two_once(size, size, seed, 12, style)
                    } else {
                        Map::generate_pockets_once(size, size, seed, 12, players, style)
                    };
                    let what = format!("{style:?}, {players} players, size {size}, seed {seed}");
                    if let Err(e) = super::validate(&first, style) {
                        retried.push(format!("{what}: {e}"));
                    }
                    let m = Map::generate_styled(size, size, seed, 12, players, style);
                    assert_eq!(super::validate(&m, style), Ok(()), "{what}");
                }
            }
        }
    }
    assert!(100 * retried.len() <= total, "{} of {total} first layouts failed:\n{}", retried.len(), retried.join("\n"));
}

/// The pockets of 3 to 8 players are the same picture for ground units, and
/// exactly one of each base's moats is a harbour.
#[test]
fn pockets_keep_one_harbour_each() {
    for players in 3..=8 {
        let size = if players <= 4 { 96 } else { 128 };
        for seed in 0..4 {
            let m = Map::generate_styled(size, size, seed, 12, players, MapStyle::Lakes);
            let centres: Vec<(i32, i32)> = m.spawns.iter().map(|&(x, y)| (x + 1, y + 2)).collect();
            let r = crate::map::pocket_radius(&centres);
            let half = r - 2;
            for &(cx, cy) in &centres {
                let water_rows = |rows: std::ops::RangeInclusive<i32>| {
                    rows.flat_map(|dy| (-half..=half).map(move |dx| (cx + dx, cy + dy)))
                        .filter(|&(x, y)| m.contains(x, y))
                        .all(|(x, y)| m.terrain[m.idx(x, y)] == Terrain::Water)
                };
                let (north, south) = (water_rows(-r - 3..=-r - 1), water_rows(r + 3..=r + 5));
                assert!(north ^ south, "{players} players, seed {seed}: base at {cx},{cy} moats north {north} south {south}");
            }
        }
    }
}

/// No channel or strait cuts the bases off from a large part of the land:
/// every land region of `MAINLAND_REGION` cells or more is joined to the
/// bases by ground, and the land they reach holds enough ore for long games
/// (at least 5 % of the map is ore or gems their trucks can reach).
#[test]
fn the_bases_reach_all_large_land_and_enough_ore() {
    for style in MapStyle::CONCRETE {
        for (players, size) in [(2, 80), (2, 96), (4, 96), (6, 128)] {
            for seed in 0..6 {
                let m = Map::generate_styled(size, size, seed, 12, players, style);
                let what = format!("{style:?}, {players} players, size {size}, seed {seed}");
                // Land components (4-connected passable cells).
                let mut label = vec![u32::MAX; m.cells()];
                let mut sizes = Vec::new();
                for s in 0..m.cells() {
                    if label[s] != u32::MAX || !m.terrain[s].passable() {
                        continue;
                    }
                    let id = sizes.len() as u32;
                    label[s] = id;
                    let mut stack = vec![s];
                    let mut n = 0;
                    while let Some(i) = stack.pop() {
                        n += 1;
                        let (x, y) = ((i as i32) % size, (i as i32) / size);
                        for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
                            if m.contains(x + dx, y + dy) {
                                let j = m.idx(x + dx, y + dy);
                                if label[j] == u32::MAX && m.terrain[j].passable() {
                                    label[j] = id;
                                    stack.push(j);
                                }
                            }
                        }
                    }
                    sizes.push(n);
                }
                let (sx, sy) = m.spawns[0];
                let main = label[m.idx(sx + 1, sy + 1)];
                for (id, &n) in sizes.iter().enumerate() {
                    assert!(id as u32 == main || n < super::MAINLAND_REGION, "{what}: a land region of {n} cells is cut off");
                }
                let ore = (0..m.cells()).filter(|&i| label[i] == main && m.has_resource(i)).count() as i32;
                assert!(ore * 20 >= size * size, "{what}: only {ore} reachable ore and gem cells");
            }
        }
    }
}

/// Three to eight players (map_stats numbers): every base has as many ore
/// cells within `REACH` as the others (the generator grows ore at the poorer
/// bases), and where the layout is symmetric top to bottom (four players in
/// two rows, rings of six and eight) a base and its mirror image below are
/// about as far from their nearest neighbour by ground (within 10 %), so no
/// pair of bases is closer than its mirror image. Pockets face south and are
/// not mirrored, so channels and roads near them can still differ a little:
/// at most one mirrored pair in fifty may differ by more. Seed 1706698519 is
/// the eight player lakes map whose bottom pair used to be uniquely close
/// (25 steps, 37 for the others) and whose bases had 117 to 139 ore cells
/// nearby.
#[test]
fn bases_get_equal_ore_and_no_pair_is_uniquely_close() {
    let mut cases: Vec<(MapStyle, usize, i32, u64)> = vec![(MapStyle::Random, 8, 96, 1706698519)];
    for style in MapStyle::CONCRETE {
        for players in 3..=8 {
            for &size in &sizes(players)[..2] {
                for seed in 0..4 {
                    cases.push((style, players, size, seed));
                }
            }
        }
    }
    let (mut pairs, mut uneven) = (0, Vec::new());
    for (style, players, size, seed) in cases {
        let m = Map::generate_styled(size, size, seed, 12, players, style);
        let s = measure(&m);
        let what = format!("{style:?}, {players} players, size {size}, seed {seed}");
        let (lo, hi) = s.spread(|b| Some(b.ore_cells)).unwrap();
        assert!(20 * (hi - lo) <= hi, "{what}: ore cells near the bases {:?}", s.bases.iter().map(|b| b.ore_cells).collect::<Vec<_>>());
        if !matches!(players, 4 | 6 | 8) {
            continue;
        }
        let yards: Vec<(i32, i32)> = m.spawns.iter().map(|&(x, y)| (x + 1, y + 2)).collect();
        for (k, &(cx, cy)) in yards.iter().enumerate().filter(|(_, c)| c.1 < size - c.1) {
            let below = yards.iter().position(|&y| y == (cx, size - cy)).unwrap_or_else(|| panic!("{what}: no mirror image of base {k}"));
            let (a, b) = (s.bases[k].rush.unwrap(), s.bases[below].rush.unwrap());
            pairs += 1;
            if a.abs_diff(b) > 4.max(a.max(b) / 10) {
                uneven.push(format!("{what}: base {k} is {a} steps from its nearest neighbour, its mirror image {below} {b}"));
            }
        }
    }
    assert!(!uneven.iter().any(|u| u.contains("1706698519")), "the reported map is uneven again:\n{}", uneven.join("\n"));
    assert!(50 * uneven.len() <= pairs, "{} of {pairs} mirrored pairs differ:\n{}", uneven.len(), uneven.join("\n"));
}
