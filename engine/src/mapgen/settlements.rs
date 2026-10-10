//! Tech buildings and civilian villages on generated maps, like OpenRA's
//! random map generator (ClassicMapGenerator, mods/ra/rules/map-generators.yaml:
//! the lobby option "Buildings" and the civilian buildings it scatters).
//!
//! The generator's maps are mirrored left to right, rings of six or eight
//! and four players in two rows top to bottom as well. Everything here is
//! placed by orbits of that symmetry: a spot is only taken when all of its
//! mirror images are free, and then all of them are, so every base finds the
//! same neutral buildings around it.
//!
//! - **Per base**: oil derricks in the back corners of every base area (the
//!   same corner of every pocket, mirrored on the right half), so every player
//!   has the same derrick to capture first.
//! - **Contested**: one building where the water network meets (the hub on
//!   the mirror axis), and with the richer choices more between neighbouring
//!   bases, at the nearest free spot.
//! - **Villages**: small groups of civilian buildings of the map's biome, away
//!   from bases, roads of travel left open (every building keeps a free ring
//!   around it, so a village never closes a passage).
//!
//! OpenRA picks its buildings at random positions and projects them through
//! the symmetry; this generator uses fixed rules instead, so the same seed
//! and options always give the same map in every client.

use crate::map::{Map, Terrain};
use crate::mapdata::MapActor;
use crate::rng::Rng;
use crate::rules::Rules;
use crate::weather::Biome;

/// Lobby option `techBuildings` (OpenRA's map generator option "Buildings").
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum TechBuildings {
    /// No tech buildings.
    None,
    /// An oil derrick per base and a hospital in the middle (OpenRA Standard:
    /// hospitals, tech centers and mostly oil derricks).
    #[default]
    Standard,
    /// Standard plus forward command posts and communications centers between
    /// neighbouring bases (OpenRA Extra).
    Extra,
    /// Oil derricks only: one per base and one in the middle (OpenRA Oil only).
    OilOnly,
    /// Many oil derricks: two per base, in the middle and between neighbours
    /// (OpenRA Oil rush).
    OilRush,
}

impl TechBuildings {
    pub const ALL: [TechBuildings; 5] =
        [TechBuildings::None, TechBuildings::Standard, TechBuildings::Extra, TechBuildings::OilOnly, TechBuildings::OilRush];

    pub fn name(self) -> &'static str {
        match self {
            TechBuildings::None => "none",
            TechBuildings::Standard => "standard",
            TechBuildings::Extra => "extra",
            TechBuildings::OilOnly => "oilonly",
            TechBuildings::OilRush => "oilrush",
        }
    }

    pub fn from_name(s: &str) -> Option<TechBuildings> {
        TechBuildings::ALL.into_iter().find(|t| t.name() == s)
    }

    /// Oil derricks in every base area.
    fn derricks_per_base(self) -> usize {
        match self {
            TechBuildings::None => 0,
            TechBuildings::OilRush => 2,
            _ => 1,
        }
    }

    /// The building in the middle of the map.
    fn centre(self) -> Option<&'static str> {
        match self {
            TechBuildings::None => None,
            TechBuildings::Standard | TechBuildings::Extra => Some("HOSP"),
            TechBuildings::OilOnly | TechBuildings::OilRush => Some("OILB"),
        }
    }

    /// Buildings between neighbouring bases, one per pair, taking turns.
    fn between(self) -> &'static [&'static str] {
        match self {
            TechBuildings::Extra => &["FCOM", "MISS"],
            TechBuildings::OilRush => &["OILB"],
            _ => &[],
        }
    }
}

/// Civilian buildings a village is made of, per biome (OpenRA MapEditorData
/// tilesets of the V actors), and how likely each is picked.
fn village_types(biome: Biome) -> &'static [(&'static str, i32)] {
    match biome {
        Biome::Desert => &[
            ("V20", 2),
            ("V21", 2),
            ("V22", 3),
            ("V23", 3),
            ("V24", 2),
            ("V25", 1),
            ("V26", 3),
            ("V27", 3),
            ("V28", 3),
            ("V29", 3),
            ("V30", 2),
            ("V31", 2),
            ("V32", 2),
            ("V33", 2),
            ("V34", 3),
            ("V35", 3),
            ("V36", 3),
        ],
        Biome::Snow => &[
            ("V01", 1),
            ("V02", 2),
            ("V03", 2),
            ("V04", 2),
            ("V05", 3),
            ("V06", 3),
            ("V07", 3),
            ("V08", 3),
            ("V09", 3),
            ("V10", 3),
            ("V11", 3),
            ("V12", 2),
            ("V13", 2),
            ("SNOWHUT", 3),
        ],
        Biome::Temperate => &[
            ("V01", 1),
            ("V02", 2),
            ("V03", 2),
            ("V04", 2),
            ("V05", 3),
            ("V06", 3),
            ("V07", 3),
            ("V08", 3),
            ("V09", 3),
            ("V10", 3),
            ("V11", 3),
            ("V12", 1),
            ("V13", 1),
            ("V14", 2),
            ("V15", 2),
            ("V16", 2),
            ("V17", 2),
            ("V18", 2),
            ("WINDMILL", 1),
        ],
    }
}

/// Cells kept free around a contested building or a village and the bases.
const BASE_GAP: i32 = 4;
/// How far the search for a free spot goes from its target (Chebyshev cells).
const SEARCH: i32 = 12;
/// Half the side of a village's square.
const VILLAGE_RADIUS: i32 = 4;
/// Buildings per village.
const VILLAGE_SIZE: (i32, i32) = (3, 6);
/// Map cells per village.
const VILLAGE_AREA: i32 = 4000;

/// The symmetry of a generated map with `players` bases, and where the bases are.
struct Frame {
    w: i32,
    h: i32,
    flip_y: bool,
    /// Yard centres (spawn + (1, 2), as map.rs places them).
    bases: Vec<(i32, i32)>,
    /// Base areas: (x0, y0, x1, y1) rectangles nothing contested goes into.
    areas: Vec<(i32, i32, i32, i32)>,
    /// Back corners of a base area for the derricks, the first one used
    /// first: offsets (x, y) of the top-left cell of a 2x2 building from the
    /// yard centre, left-half bases (right-half bases use the mirror image).
    /// With three to eight players the inner corner (toward the map's middle)
    /// comes first: on the outer one the AI's mirrored base layouts drifted
    /// apart and one side of the map won the mirrored 2v2s.
    corners: [(i32, i32); 2],
}

impl Frame {
    fn new(m: &Map) -> Frame {
        let (w, h) = (m.width, m.height);
        let players = m.spawns.len();
        let bases: Vec<(i32, i32)> = m.spawns.iter().map(|&(x, y)| (x + 1, y + 2)).collect();
        // map.rs: four players in two rows and rings of six or eight are also
        // mirrored top to bottom; two players have a round clearing.
        let flip_y = players == 4 || (players >= 5 && players.is_multiple_of(2));
        let (areas, corners) = if players == 2 {
            // generate_two: a clearing of radius 11 around the yard centre.
            let areas = bases.iter().map(|&(x, y)| (x - 11, y - 11, x + 11, y + 11)).collect();
            (areas, [(-5, -8), (3, -8)])
        } else {
            // generate_pockets: rows -r - 3 ..= r + 5 and columns -r ..= r are
            // the pocket; its clearing spans columns -(r - 2) ..= r - 2 from row -r
            // (walls above), and the derricks keep a free ring inside it.
            let r = crate::map::pocket_radius(&bases);
            let half = r - 2;
            let areas = bases.iter().map(|&(x, y)| (x - r, y - r - 3, x + r, y + r + 5)).collect();
            (areas, [(half - 2, -r + 1), (-half + 1, -r + 1)])
        };
        Frame { w, h, flip_y, bases, areas, corners }
    }

    /// Top-left cells of the images of a `fw` x `fh` footprint at (x, y),
    /// without repeats (a footprint on a mirror axis is its own image).
    fn images(&self, x: i32, y: i32, fw: i32, fh: i32) -> Vec<(i32, i32)> {
        let mut out = vec![(x, y), (self.w - x - fw, y)];
        if self.flip_y {
            out.push((x, self.h - y - fh));
            out.push((self.w - x - fw, self.h - y - fh));
        }
        out.sort_unstable();
        out.dedup();
        out
    }

    /// Whether the cell lies in a base area (grown by `gap` cells).
    fn in_base(&self, x: i32, y: i32, gap: i32) -> bool {
        self.areas.iter().any(|&(x0, y0, x1, y1)| x >= x0 - gap && x <= x1 + gap && y >= y0 - gap && y <= y1 + gap)
    }

    /// Whether the base at yard centre x is a left-half one.
    fn left(&self, x: i32) -> bool {
        2 * x < self.w - 1
    }

    /// Whether the base at yard centre x sits on the mirror axis (half a
    /// cell off it at most: an odd player count's middle base).
    fn on_axis(&self, x: i32) -> bool {
        (2 * x - (self.w - 1)).abs() <= 1
    }
}

/// A building to place: type and footprint cells (rules area_cells).
struct Kind<'a> {
    ty: &'a str,
    w: i32,
    h: i32,
    cells: Vec<(i32, i32)>,
}

fn kind<'a>(rules: &Rules, ty: &'a str) -> Option<Kind<'a>> {
    let b = rules.actors[rules.actor_index(ty)?].building.as_ref()?;
    Some(Kind { ty, w: b.width, h: b.height, cells: b.area_cells().collect() })
}

/// Cells taken so far (a free ring is kept around every building), and the
/// buildings placed.
struct Taken {
    w: i32,
    cells: Vec<bool>,
    out: Vec<MapActor>,
}

impl Taken {
    fn at(&self, x: i32, y: i32) -> bool {
        self.cells[(y * self.w + x) as usize]
    }
}

/// Whether `k` fits at (x, y): its cells on open clear ground without ore,
/// gems or anything placed, and the ring around it passable and free, so it
/// never closes a passage.
fn fits(m: &Map, taken: &Taken, k: &Kind, x: i32, y: i32) -> bool {
    k.cells.iter().all(|&(dx, dy)| {
        let (cx, cy) = (x + dx, y + dy);
        if !m.contains(cx, cy) {
            return false;
        }
        let i = m.idx(cx, cy);
        if m.terrain[i] != Terrain::Clear || m.has_resource(i) {
            return false;
        }
        (-1..=1).all(|oy| {
            (-1..=1).all(|ox| {
                let (nx, ny) = (cx + ox, cy + oy);
                m.contains(nx, ny) && m.terrain[m.idx(nx, ny)].passable() && !taken.at(nx, ny)
            })
        })
    })
}

/// Place `k` at every image of (x, y) when all of them fit and none overlap.
fn place_orbit(m: &Map, f: &Frame, taken: &mut Taken, k: &Kind, x: i32, y: i32, base_gap: Option<i32>) -> bool {
    let images = f.images(x, y, k.w, k.h);
    let cells = |&(ix, iy): &(i32, i32)| k.cells.iter().map(move |&(dx, dy)| (ix + dx, iy + dy));
    let ok =
        images.iter().all(|p| fits(m, taken, k, p.0, p.1) && base_gap.is_none_or(|gap| cells(p).all(|(cx, cy)| !f.in_base(cx, cy, gap))));
    // Images may not overlap each other (they would on a footprint that is
    // almost, but not exactly, on a mirror axis).
    let mut seen = std::collections::HashSet::new();
    if !ok || !images.iter().flat_map(cells).all(|c| seen.insert(c)) {
        return false;
    }
    for &(ix, iy) in &images {
        for (cx, cy) in cells(&(ix, iy)) {
            let i = m.idx(cx, cy);
            taken.cells[i] = true;
        }
        taken.out.push(MapActor::new(k.ty, -1, ix, iy, 0));
    }
    true
}

/// Search the nearest spot to (tx, ty) (Chebyshev rings, then distance, row
/// and column) where the orbit of `k` fits away from the bases.
fn place_near(m: &Map, f: &Frame, taken: &mut Taken, k: &Kind, tx: i32, ty: i32) -> bool {
    let mut spots: Vec<(i32, i32, i32)> = Vec::new();
    for dy in -SEARCH..=SEARCH {
        for dx in -SEARCH..=SEARCH {
            spots.push((dx * dx + dy * dy, ty + dy, tx + dx));
        }
    }
    spots.sort_unstable();
    spots.into_iter().any(|(_, y, x)| place_orbit(m, f, taken, k, x, y, Some(BASE_GAP)))
}

/// Tech buildings and villages for a generated map `m` of `biome` (see the
/// module comment); `seed` varies the villages.
pub fn settlements(m: &Map, rules: &Rules, biome: Biome, tech: TechBuildings, seed: u64, existing: &[MapActor]) -> Vec<MapActor> {
    if m.spawns.len() < 2 {
        return Vec::new();
    }
    let f = Frame::new(m);
    let mut taken = Taken { w: m.width, cells: vec![false; m.cells()], out: Vec::new() };
    // Mines and anything else already there, and the starting yards.
    for a in existing {
        if let Some(k) = kind(rules, &a.ty) {
            for &(dx, dy) in &k.cells {
                if m.contains(a.x + dx, a.y + dy) {
                    taken.cells[m.idx(a.x + dx, a.y + dy)] = true;
                }
            }
        } else if m.contains(a.x, a.y) {
            taken.cells[m.idx(a.x, a.y)] = true;
        }
    }
    for &(sx, sy) in &m.spawns {
        for dy in -1..=4 {
            for dx in -1..=3 {
                if m.contains(sx + dx, sy + dy) {
                    taken.cells[m.idx(sx + dx, sy + dy)] = true;
                }
            }
        }
    }

    // Oil derricks in the back corners of every base area: the same corner
    // of every base, or none at all where one base has no room. A base on the
    // mirror axis (three, five or seven players) is its own mirror image: a
    // single derrick goes in the middle of its back row, two go in both
    // corners, mirrored onto each other.
    if let Some(oil) = kind(rules, "OILB") {
        let per_base = tech.derricks_per_base();
        for k in 0..per_base {
            let spots: Vec<(i32, i32)> = f
                .bases
                .iter()
                .map(|&(bx, by)| {
                    let corner = f.corners[k];
                    let y = by + corner.1;
                    if f.on_axis(bx) {
                        let left = bx + f.corners[0].0;
                        match (per_base, k) {
                            (1, _) => ((m.width - oil.w) / 2, y),
                            (_, 0) => (left, y),
                            _ => (m.width - left - oil.w, y),
                        }
                    } else if f.left(bx) {
                        (bx + corner.0, y)
                    } else {
                        (bx - corner.0 - oil.w + 1, y)
                    }
                })
                .collect();
            if spots.iter().all(|&(x, y)| fits(m, &taken, &oil, x, y)) {
                for &(x, y) in &spots {
                    for &(dx, dy) in &oil.cells {
                        let i = m.idx(x + dx, y + dy);
                        taken.cells[i] = true;
                    }
                    taken.out.push(MapActor::new(oil.ty, -1, x, y, 0));
                }
            }
        }
    }

    // The middle: on the mirror axis at the hub row or the nearest free row
    // within a quarter of the map height (the hub itself is often water: the
    // water network grows from it); failing that, a mirrored pair as near to
    // the hub as there is room.
    let hub = super::hub(m.width, m.height, &f.bases).0;
    if let Some(k) = tech.centre().and_then(|t| kind(rules, t)) {
        let x = (m.width - k.w) / 2;
        let y0 = hub.1 - k.h / 2;
        let placed = (0..=m.height / 4).flat_map(|d| [y0 - d, y0 + d]).any(|y| place_orbit(m, &f, &mut taken, &k, x, y, Some(BASE_GAP)));
        if !placed {
            place_near(m, &f, &mut taken, &k, x - k.w, y0);
        }
    }

    // Between neighbouring bases (at most a quarter farther apart than a
    // base's nearest neighbour), canonical pairs only: the rest are images.
    let between = tech.between();
    if !between.is_empty() {
        let d2 = |a: (i32, i32), b: (i32, i32)| (a.0 - b.0) * (a.0 - b.0) + (a.1 - b.1) * (a.1 - b.1);
        let mut mids = Vec::new();
        for (i, &a) in f.bases.iter().enumerate() {
            let near = f.bases.iter().filter(|&&b| b != a).map(|&b| d2(a, b)).min().unwrap_or(0);
            for &b in &f.bases[i + 1..] {
                if d2(a, b) * 16 <= near * 25 {
                    mids.push(((a.0 + b.0) / 2, (a.1 + b.1) / 2));
                }
            }
        }
        mids.retain(|&(x, y)| 2 * x < m.width && (!f.flip_y || 2 * y < m.height));
        mids.sort_unstable();
        mids.dedup();
        for (n, &(x, y)) in mids.iter().enumerate() {
            if let Some(k) = kind(rules, between[n % between.len()]) {
                place_near(m, &f, &mut taken, &k, x - k.w / 2, y - k.h / 2);
            }
        }
    }

    villages(m, rules, &f, biome, seed, &mut taken);
    taken.out
}

/// Civilian villages: squares of open clear ground on the canonical part of
/// the map (left half; top-left quarter when mirrored top to bottom too),
/// away from the bases, each with a few buildings of the biome.
fn villages(m: &Map, rules: &Rules, f: &Frame, biome: Biome, seed: u64, taken: &mut Taken) {
    let images = if f.flip_y { 4 } else { 2 };
    let wanted = (m.width * m.height / (VILLAGE_AREA * images)).max(1);
    let mut rng = Rng::new(seed ^ 0x7111_a6e5_0000_0001);
    let r = VILLAGE_RADIUS;
    // Room for the square and its images apart from each other.
    let (xmax, ymax) = (m.width / 2 - r - 2, if f.flip_y { m.height / 2 - r - 2 } else { m.height - r - 1 });
    let open = |x: i32, y: i32| {
        (y - r..=y + r).all(|cy| {
            (x - r..=x + r).all(|cx| {
                m.contains(cx, cy) && {
                    let i = m.idx(cx, cy);
                    m.terrain[i] == Terrain::Clear && !m.has_resource(i) && !taken.at(cx, cy) && !f.in_base(cx, cy, BASE_GAP + 2)
                }
            })
        })
    };
    let mut sites: Vec<(i32, i32)> =
        (r + 1..=ymax).flat_map(|y| (r + 1..=xmax).map(move |x| (x, y))).filter(|&(x, y)| open(x, y)).collect();
    let types: Vec<(Kind, i32)> = village_types(biome).iter().filter_map(|&(t, wt)| kind(rules, t).map(|k| (k, wt))).collect();
    let total: i32 = types.iter().map(|t| t.1).sum();
    if types.is_empty() || total <= 0 {
        return;
    }
    for _ in 0..wanted {
        if sites.is_empty() {
            break;
        }
        let (vx, vy) = sites[rng.range(0, sites.len() as i32) as usize];
        // The next village keeps its distance.
        sites.retain(|&(x, y)| (x - vx).abs().max((y - vy).abs()) > 3 * r);
        let houses = rng.range(VILLAGE_SIZE.0, VILLAGE_SIZE.1 + 1);
        let mut built = 0;
        for _ in 0..houses * 8 {
            if built == houses {
                break;
            }
            let mut pick = rng.range(0, total);
            let k = &types
                .iter()
                .find(|t| {
                    pick -= t.1;
                    pick < 0
                })
                .expect("weights add up")
                .0;
            let x = vx + rng.range(-r, r + 1) - k.w / 2;
            let y = vy + rng.range(-r, r + 1) - k.h / 2;
            if (x..x + k.w).all(|cx| (vx - r..=vx + r).contains(&cx))
                && (y..y + k.h).all(|cy| (vy - r..=vy + r).contains(&cy))
                && place_orbit(m, f, taken, k, x, y, None)
            {
                built += 1;
            }
        }
    }
}
