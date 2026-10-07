// Terrain: one texel per cell (R = terrain type, G = ore density), drawn with
// flat colours and per-pixel grain so it reads like the 1996 tiles.
@group(1) @binding(0) var terrain_tex: texture_2d<f32>;

@vertex
fn vs(@builtin(vertex_index) i: u32) -> FullscreenOut {
    var o: FullscreenOut;
    o.pos = fullscreen_pos(i);
    return o;
}

fn terrain_type(c: vec2i) -> u32 {
    let size = vec2i(g.map_size);
    if (c.x < 0 || c.y < 0 || c.x >= size.x || c.y >= size.y) {
        return 99u;
    }
    return u32(textureLoad(terrain_tex, c, 0).r * 255.0 + 0.5);
}

fn base_color(t: u32, w: vec2f, local: vec2f) -> vec3f {
    let grain = hash2(floor(w));
    let grain2 = hash2(floor(w * 0.5) + 17.0);
    switch t {
        case 0u: { // clear grass
            return mix(vec3f(0.20, 0.30, 0.14), vec3f(0.28, 0.38, 0.18), grain) * (0.92 + grain2 * 0.12);
        }
        case 1u: { // rough
            return mix(vec3f(0.33, 0.32, 0.19), vec3f(0.40, 0.37, 0.23), grain) * (0.9 + grain2 * 0.15);
        }
        case 2u: { // rock
            let ridge = smoothstep(0.2, 0.8, local.x * 0.5 + (1.0 - local.y) * 0.5);
            return mix(vec3f(0.36, 0.32, 0.27), vec3f(0.62, 0.56, 0.47), ridge * 0.7 + grain * 0.3);
        }
        case 3u: { // water
            let wave = sin(w.x * 0.35 + w.y * 0.2 + g.time * 1.4) * 0.5 + 0.5;
            return mix(vec3f(0.12, 0.24, 0.36), vec3f(0.16, 0.31, 0.44), wave * 0.6 + grain * 0.15);
        }
        case 4u: { // trees: one rounded crown per cell over grass
            let d = length(local - vec2f(0.5, 0.45));
            let grass = mix(vec3f(0.20, 0.30, 0.14), vec3f(0.26, 0.36, 0.17), grain);
            if (d < 0.42) {
                let shade = 1.0 - smoothstep(0.0, 0.42, length(local - vec2f(0.38, 0.3)));
                return mix(vec3f(0.08, 0.18, 0.07), vec3f(0.18, 0.34, 0.13), shade) * (0.9 + grain * 0.15);
            }
            if (length(local - vec2f(0.56, 0.58)) < 0.44) {
                return grass * 0.55; // shadow
            }
            return grass;
        }
        default: {
            return vec3f(0.0);
        }
    }
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
    var t_draw = t;
    // Organic edges: water and rock fray into neighbouring grass.
    if (t == 2u || t == 3u) {
        let n = hash2(floor(w * 0.5)) * 0.14 + 0.10;
        if ((local.x < n && terrain_type(c + vec2i(-1, 0)) != t) ||
            (local.x > 1.0 - n && terrain_type(c + vec2i(1, 0)) != t) ||
            (local.y < n && terrain_type(c + vec2i(0, -1)) != t) ||
            (local.y > 1.0 - n && terrain_type(c + vec2i(0, 1)) != t)) {
            t_draw = 0u;
        }
    }
    var col = base_color(t_draw, w, local);
    // Ore: golden speckles, denser with more ore.
    let ore = textureLoad(terrain_tex, c, 0).g;
    if (ore > 0.0) {
        let speck = hash2(floor(w * 0.5) + vec2f(7.0, 3.0));
        if (speck < 0.15 + ore * 0.55) {
            let glint = hash2(floor(w) + 11.0);
            col = mix(vec3f(0.62, 0.45, 0.12), vec3f(0.92, 0.74, 0.30), glint);
        } else {
            col = mix(col, vec3f(0.36, 0.30, 0.14), ore * 0.5);
        }
    }
    return vec4f(col, 1.0);
}
