// Terrain from pre-rendered tiles (js/art/terrain.js): one atlas per biome
// and a per-cell layer that picks the tile, a decal, the water depth and the
// shadow cast by rock to the north and west. The engine's terrain texture
// (R = terrain type, G = ore density, B = gem density) adds ore, gems and
// the type for soft ground edges and water animation. Light comes from the
// top left, like the building art.
//
// With tile terrain (g.art.x bit 1: original graphics or a texture pack,
// js/content/terrain.js) the atlas holds the player's tiles as they are: no
// soft edges, noise, decals or rock shadows are added, and ore and gems are
// drawn from their overlay tiles (bits 2 and 4) when the atlas has them.
@group(1) @binding(0) var terrain_tex: texture_2d<f32>;
@group(1) @binding(1) var cell_tex: texture_2d<f32>;
@group(1) @binding(2) var atlas: texture_2d<f32>;
@group(1) @binding(3) var atlas_samp: sampler;

const ATLAS_COLS: u32 = 16u;
const DECAL_BASE: u32 = 60u;
// Tile terrain: ore and gem overlays, a tile per variant and density level
// (js/content/terrain.js ORE_TILE_BASE and friends).
const ORE_TILE_BASE: u32 = 192u;
const ORE_LEVELS: u32 = 12u;
const ORE_VARIANTS: u32 = 4u;
const GEM_TILE_BASE: u32 = 240u;
const GEM_LEVELS: u32 = 4u;
const GEM_VARIANTS: u32 = 4u;
const ART_TILES: u32 = 1u;
const ART_ORE: u32 = 2u;
const ART_GEMS: u32 = 4u;
// Original water (js/content/terrain.js): pixels with alpha WATER_ALPHA + k
// show the k-th of WATER_COLORS rotating colours, read from the atlas's last
// pixel row, turned WATER_STEPS_PER_SECOND times a second on the render
// clock like OpenRA's RotationPaletteEffect (0.25 steps a tick, 25 ticks a
// second).
const ART_WATER_ROTATION: u32 = 8u;
// Smudges (engine/src/smudges.rs): the terrain texture's alpha is 255 or
// crater << 6 | variant << 3 | depth. Tile terrain with the original smudge
// tiles (bit 16, js/content/terrain.js) draws tile SMUDGE_TILE_BASE +
// (crater * SMUDGE_VARIANTS + variant) * SMUDGE_DEPTHS + depth; otherwise
// they are drawn here, scorch marks and craters in WebRA's style.
const ART_SMUDGES: u32 = 16u;
const SMUDGE_TILE_BASE: u32 = 960u;
const SMUDGE_VARIANTS: u32 = 6u;
const SMUDGE_DEPTHS: u32 = 5u;
const NO_SMUDGE: u32 = 255u;
const WATER_ALPHA: u32 = 248u;
const WATER_COLORS: u32 = 7u;
const WATER_STEPS_PER_SECOND: f32 = 6.25;
// WebRA's ore and gems, as two blocks per cell (design board "Retexture 2D
// en 3D", 0.21.0), in the colours of the shared 2D/3D palette
// (js/art/shared-palette.js terrain: ore, oreDark, gems; materials.ice2 for
// the glint). Each block has a lit top and a darker front face along its
// lower edge, and one hard shadow to the lower right.
const ORE_LIGHT: vec3f = vec3f(1.0, 0.827, 0.302); // #ffd34d
const ORE_BASE: vec3f = vec3f(0.851, 0.588, 0.165); // #d9962a
const ORE_GROUND: vec3f = vec3f(0.478, 0.400, 0.188); // #7a6630
const GEM_BLUE: vec3f = vec3f(0.29, 0.549, 0.941); // #4a8cf0
const GEM_MAGENTA: vec3f = vec3f(0.91, 0.29, 0.69); // #e84ab0
const GEM_GLINT: vec3f = vec3f(0.878, 0.973, 1.0); // #e0f8ff
const GEM_GROUND: vec3f = vec3f(0.22, 0.2, 0.16);
// The two blocks of a resource cell: centre x, y and width, height in cells.
const RES_BLOCK_A: vec4f = vec4f(0.37, 0.35, 0.34, 0.3);
const RES_BLOCK_B: vec4f = vec4f(0.69, 0.68, 0.28, 0.26);
// The shadow: offset in cells (shared palette shadow.offset) and what it leaves of the ground (1 - shadow.alpha).
const RES_SHADOW: f32 = 0.08;
const RES_SHADE: f32 = 0.75;

@vertex
fn vs(@builtin(vertex_index) i: u32) -> FullscreenOut {
    var o: FullscreenOut;
    o.pos = fullscreen_pos(i);
    return o;
}

fn in_map(c: vec2i) -> bool {
    let size = vec2i(g.map_size);
    return c.x >= 0 && c.y >= 0 && c.x < size.x && c.y < size.y;
}

fn terrain_type(c: vec2i) -> u32 {
    if (!in_map(c)) {
        return 99u;
    }
    return u32(textureLoad(terrain_tex, c, 0).r * 255.0 + 0.5);
}

fn cell_tile(c: vec2i) -> u32 {
    return u32(textureLoad(cell_tex, c, 0).r * 255.0 + 0.5);
}

/// One atlas tile at cell-local position `local` (0..1), filtered inside the
/// tile only. Tiles are square, ATLAS_COLS to a row (32 pixels for WebRA's
/// own tiles, the original 24 for tile terrain).
fn tile_px(tile: u32, local: vec2f) -> vec4f {
    let dims = vec2f(textureDimensions(atlas));
    let size = dims.x / f32(ATLAS_COLS);
    let origin = vec2f(f32(tile % ATLAS_COLS), f32(tile / ATLAS_COLS)) * size;
    let p = origin + clamp(local * size, vec2f(0.5), vec2f(size - 0.5));
    return textureSampleLevel(atlas, atlas_samp, p / dims, 0.0);
}

/// An overlay tile for a resource density (0..1) at cell `c`, or none.
fn resource_tile(base: u32, levels: u32, variants: u32, density: f32, c: vec2i, local: vec2f) -> vec4f {
    let level = min(levels - 1u, u32(max(ceil(density * f32(levels)), 1.0)) - 1u);
    let variant = min(variants - 1u, u32(hash2(vec2f(c) + vec2f(3.7, 1.3)) * f32(variants)));
    return tile_px(base + variant * levels + level, local);
}

/// The colour of a rotating water pixel (alpha WATER_ALPHA + k) on the render clock.
fn water_color(k: u32) -> vec3f {
    var step = 0u;
    if (g.anim.y > 0.5) {
        step = u32(floor(max(g.anim.x, 0.0) * WATER_STEPS_PER_SECOND)) % WATER_COLORS;
    }
    let dims = vec2i(textureDimensions(atlas));
    let index = (k + WATER_COLORS - step) % WATER_COLORS;
    return textureLoad(atlas, vec2i(i32(index), dims.y - 1), 0).rgb;
}

/// The smudge byte of cell `c` (NO_SMUDGE when it has none).
fn smudge_of(c: vec2i) -> u32 {
    return u32(textureLoad(terrain_tex, c, 0).a * 255.0 + 0.5);
}

/// WebRA's smudges: a soot blotch (scorch) or a dark pit with a pale rim
/// (crater), bigger and darker with every hit; the variant shifts the shape.
fn smudge_color(col: vec3f, s: u32, c: vec2i, local: vec2f) -> vec3f {
    let crater = ((s >> 6u) & 1u) == 1u;
    let variant = f32((s >> 3u) & 7u);
    let depth = f32(s & 7u);
    let centre = vec2f(0.5) + (vec2f(hash2(vec2f(c) + variant), hash2(vec2f(c) + variant + 7.3)) - 0.5) * 0.18;
    let wobble = (vnoise((local + vec2f(c)) * 6.0 + variant * 3.1) - 0.5) * 0.12;
    let d = length(local - centre) + wobble;
    let r = 0.2 + 0.035 * depth;
    if (crater) {
        if (d < r) {
            return mix(col, vec3f(0.12, 0.10, 0.08), 0.55 + 0.05 * depth);
        }
        if (d < r + 0.07) {
            return mix(col, vec3f(0.55, 0.5, 0.42), 0.35);
        }
        return col;
    }
    let soot = (1.0 - smoothstep(r * 0.6, r + 0.12, d)) * (0.6 + 0.05 * depth);
    return mix(col, vec3f(0.08, 0.07, 0.06), soot);
}

/// Tile terrain (original graphics, texture packs): the tiles as they are,
/// water rotation (original) or shimmer (packs), and ore and gems from their
/// overlay tiles.
fn tiled(c: vec2i, t: u32, local: vec2f, w: vec2f, tile: u32) -> vec4f {
    let px = tile_px(tile, local);
    var col = px.rgb;
    let flags = u32(g.art.x + 0.5);
    if ((flags & ART_WATER_ROTATION) != 0u) {
        let a = u32(px.a * 255.0 + 0.5);
        if (a >= WATER_ALPHA && a < WATER_ALPHA + WATER_COLORS) {
            col = water_color(a - WATER_ALPHA);
        }
    } else if (t == 3u || t == 5u || t == 7u || t == 9u) {
        let wave = sin(w.x * 0.35 + w.y * 0.22 + g.time * 1.6 * g.env2.w) * sin(w.y * 0.31 - g.time * 1.1 * g.env2.w);
        col = col * (0.97 + 0.04 * wave);
    }
    let res = textureLoad(terrain_tex, c, 0);
    if (res.g > 0.0) {
        if ((flags & ART_ORE) != 0u) {
            let o = resource_tile(ORE_TILE_BASE, ORE_LEVELS, ORE_VARIANTS, res.g, c, local);
            col = mix(col, o.rgb, o.a);
        } else {
            col = mix(col, vec3f(0.62, 0.45, 0.12), res.g * 0.6);
        }
    }
    if (res.b > 0.0) {
        if ((flags & ART_GEMS) != 0u) {
            let o = resource_tile(GEM_TILE_BASE, GEM_LEVELS, GEM_VARIANTS, res.b, c, local);
            col = mix(col, o.rgb, o.a);
        } else {
            col = gem_color(col, c, local, res.b);
        }
    }
    let s = smudge_of(c);
    if (s != NO_SMUDGE) {
        if ((flags & ART_SMUDGES) != 0u) {
            let kind = (s >> 6u) & 1u;
            let variant = min((s >> 3u) & 7u, SMUDGE_VARIANTS - 1u);
            let depth = min(s & 7u, SMUDGE_DEPTHS - 1u);
            let o = tile_px(SMUDGE_TILE_BASE + (kind * SMUDGE_VARIANTS + variant) * SMUDGE_DEPTHS + depth, local);
            col = mix(col, o.rgb, o.a);
        } else {
            col = smudge_color(col, s, c, local);
        }
    }
    return vec4f(col, 1.0);
}

/// Water depth (0 at the shore, 1 four cells out), interpolated between cell
/// centres so the deep water has no cell edges. Off the map counts as deep.
fn water_depth(cf: vec2f) -> f32 {
    let p = cf - vec2f(0.5);
    let i = vec2i(floor(p));
    let f = fract(p);
    var d: array<f32, 4>;
    let offs = array<vec2i, 4>(vec2i(0, 0), vec2i(1, 0), vec2i(0, 1), vec2i(1, 1));
    for (var k = 0u; k < 4u; k++) {
        let c = i + offs[k];
        if (in_map(c)) {
            d[k] = textureLoad(cell_tex, c, 0).b;
        } else {
            d[k] = 1.0;
        }
    }
    return mix(mix(d[0], d[1], f.x), mix(d[2], d[3], f.x), f.y);
}

/// Clear and rough ground fade into each other over a ragged border instead of meeting at cell edges.
fn soft_ground(col: vec3f, t: u32, c: vec2i, local: vec2f, w: vec2f) -> vec3f {
    var out = col;
    let wob = (vnoise(w * 0.25) - 0.5) * 0.25;
    let dirs = array<vec2i, 4>(vec2i(0, -1), vec2i(1, 0), vec2i(0, 1), vec2i(-1, 0));
    let dist = array<f32, 4>(local.y, 1.0 - local.x, 1.0 - local.y, local.x);
    for (var k = 0u; k < 4u; k++) {
        let n = c + dirs[k];
        let nt = terrain_type(n);
        if ((nt == 0u || nt == 1u) && nt != t) {
            let f = (1.0 - smoothstep(0.0, 0.45, dist[k] + wob)) * 0.5;
            if (f > 0.0) {
                out = mix(out, tile_px(cell_tile(n), local).rgb, f);
            }
        }
    }
    return out;
}

/// The size of a resource cell's blocks for a density (0..1): bigger with more.
fn res_scale(density: f32) -> f32 {
    return 0.55 + 0.45 * density;
}

/// Whether cell-local point `p` lies in block `b` (centre, size) scaled by
/// `s`; `flip` mirrors the block's place left to right (every other cell).
fn in_res_block(p: vec2f, b: vec4f, s: f32, flip: bool) -> bool {
    var c = b.xy;
    if (flip) {
        c.x = 1.0 - c.x;
    }
    let d = abs(p - c);
    return d.x < b.z * s * 0.5 && d.y < b.w * s * 0.5;
}

/// The front face of block `b` scaled by `s`: its lower 30 %.
fn res_face(p: vec2f, b: vec4f, s: f32) -> bool {
    return p.y > b.y + b.w * s * 0.2;
}

/// Whether `p` lies in the lit top-left corner of block `b` (the gems' glint).
fn res_glint(p: vec2f, b: vec4f, s: f32, flip: bool) -> bool {
    var c = b.xy;
    if (flip) {
        c.x = 1.0 - c.x;
    }
    let corner = p - (c - vec2f(b.z, b.w) * s * 0.5);
    return corner.x < b.z * s * 0.3 && corner.y < b.w * s * 0.3;
}

/// WebRA's ore: two gold blocks per cell on a dark ochre ground, mirrored in
/// every other cell, bigger with more ore.
fn ore_color(ground: vec3f, c: vec2i, local: vec2f, ore: f32) -> vec3f {
    let base = mix(ground, ORE_GROUND, ore * 0.5);
    let s = res_scale(ore);
    let flip = ((c.x + c.y) & 1) == 1;
    let sh = local - vec2f(RES_SHADOW);
    var out = base;
    if (in_res_block(sh, RES_BLOCK_A, s, flip) || in_res_block(sh, RES_BLOCK_B, s, flip)) {
        out = base * RES_SHADE;
    }
    if (in_res_block(local, RES_BLOCK_A, s, flip)) {
        out = select(ORE_LIGHT, ORE_BASE, res_face(local, RES_BLOCK_A, s));
    } else if (in_res_block(local, RES_BLOCK_B, s, flip)) {
        out = select(ORE_LIGHT, ORE_BASE, res_face(local, RES_BLOCK_B, s));
    }
    return out;
}

/// WebRA's gems: two crystal blocks per cell, one blue and one magenta, over
/// bare darker ground, a pale glint in each block's lit corner.
fn gem_color(ground: vec3f, c: vec2i, local: vec2f, gems: f32) -> vec3f {
    let base = mix(ground, GEM_GROUND, 0.35);
    let s = res_scale(gems);
    let flip = ((c.x + c.y) & 1) == 1;
    let sh = local - vec2f(RES_SHADOW);
    var out = base;
    if (in_res_block(sh, RES_BLOCK_A, s, flip) || in_res_block(sh, RES_BLOCK_B, s, flip)) {
        out = base * RES_SHADE;
    }
    var hue_a = GEM_BLUE;
    var hue_b = GEM_MAGENTA;
    if (flip) {
        hue_a = GEM_MAGENTA;
        hue_b = GEM_BLUE;
    }
    if (in_res_block(local, RES_BLOCK_A, s, flip)) {
        out = select(hue_a, hue_a * 0.7, res_face(local, RES_BLOCK_A, s));
        if (res_glint(local, RES_BLOCK_A, s, flip)) {
            out = GEM_GLINT;
        }
    } else if (in_res_block(local, RES_BLOCK_B, s, flip)) {
        out = select(hue_b, hue_b * 0.7, res_face(local, RES_BLOCK_B, s));
        if (res_glint(local, RES_BLOCK_B, s, flip)) {
            out = GEM_GLINT;
        }
    }
    return out;
}

@fragment
fn fs(@builtin(position) p: vec4f) -> @location(0) vec4f {
    let w = g.camera + p.xy / g.zoom;
    let cf = w / CELL_PX;
    let c = vec2i(floor(cf));
    let t = terrain_type(c);
    if (t == 99u) {
        return vec4f(0.0, 0.0, 0.0, 1.0);
    }
    let local = fract(cf);
    let cell = textureLoad(cell_tex, c, 0);
    let tile = u32(cell.r * 255.0 + 0.5);
    if ((u32(g.art.x + 0.5) & ART_TILES) != 0u) {
        // Tile terrain names up to 1024 tiles: R + 256 G.
        return tiled(c, t, local, w, tile + 256u * u32(cell.g * 255.0 + 0.5));
    }
    let decal = u32(cell.g * 255.0 + 0.5);
    let shadow = u32(cell.a * 255.0 + 0.5);
    var col = tile_px(tile, local).rgb;
    // Water, fords, rivers and the river under a bridge (engine map.rs Terrain).
    let wet = t == 3u || t == 5u || t == 7u || t == 9u;
    if (t == 0u || t == 1u) {
        col = soft_ground(col, t, c, local, w);
    }
    if (!wet) {
        // Broad variation across the map so repeated tiles do not show.
        col = col * (0.92 + 0.16 * vnoise(w / 150.0)) * (0.97 + 0.06 * vnoise(w / 37.0 + 11.0));
    }
    if (decal > 0u) {
        let d = tile_px(DECAL_BASE + decal - 1u, local);
        col = mix(col, d.rgb, d.a);
    }
    if (wet) {
        // Deeper water further from the shore; a gentle wave drifts over it with time (flat, no glints:
        // the minimal look).
        if (t == 3u || t == 9u) {
            col = col * (1.0 - water_depth(cf) * 0.35);
        }
        let wave = sin(w.x * 0.35 + w.y * 0.22 + g.time * 1.6 * g.env2.w) * sin(w.y * 0.31 - g.time * 1.1 * g.env2.w);
        col = col * (0.97 + 0.04 * wave);
    }
    // Rock casts its shadow down and to the right.
    var s = 1.0;
    if ((shadow & 1u) != 0u) {
        s = s * (1.0 - 0.45 * max(0.0, 1.0 - local.y / 0.45));
    }
    if ((shadow & 2u) != 0u) {
        s = s * (1.0 - 0.40 * max(0.0, 1.0 - local.x / 0.35));
    }
    if ((shadow & 4u) != 0u && (shadow & 3u) == 0u) {
        s = s * (1.0 - 0.35 * max(0.0, 1.0 - length(local) / 0.4));
    }
    col = col * s;
    // Ore and gems: two blocks per cell, bigger with more.
    let res = textureLoad(terrain_tex, c, 0);
    if (res.g > 0.0) {
        col = ore_color(col, c, local, res.g);
    }
    if (res.b > 0.0) {
        col = gem_color(col, c, local, res.b);
    }
    // Scorch marks and craters (engine/src/smudges.rs).
    let smudge = smudge_of(c);
    if (smudge != NO_SMUDGE) {
        col = smudge_color(col, smudge, c, local);
    }
    // Rain and thunderstorms wet the ground: darker, a little more saturated.
    let weather = u32(g.env.y + 0.5);
    if ((weather == 1u || weather == 2u) && !wet) {
        let grey = dot(col, vec3f(0.3, 0.59, 0.11));
        col = mix(col, mix(vec3f(grey), col, 1.15), 1.0) * (1.0 - 0.18 * g.env.z);
    }
    return vec4f(col, 1.0);
}
