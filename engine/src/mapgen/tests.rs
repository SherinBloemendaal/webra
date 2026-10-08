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
            m.terrain[i] == m.terrain[j] && m.ore[i] == m.ore[j]
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
                        assert!(m.ore[i] == 0 || m.terrain[i].holds_ore(), "{what}: ore on {:?}", m.terrain[i]);
                    }
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

/// Rivers cross the map, so ground routes over them use fords that ships
/// can still pass.
#[test]
fn rivers_have_fords_that_ships_can_pass() {
    let mut fords = 0;
    for seed in 0..8 {
        let m = Map::generate_styled(96, 96, seed, 12, 2, MapStyle::Rivers);
        fords += measure(&m).fords;
        assert!(Terrain::Ford.passable() && Terrain::Ford.ship_passable() && !Terrain::Ford.buildable() && !Terrain::Ford.holds_ore());
    }
    assert!(fords > 0, "rivers without fords");
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
