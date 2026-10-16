// Shared by every shader (prepended at load time).
struct Globals {
    view_size: vec2f,  // render target size in device pixels
    camera: vec2f,     // world pixel at the top-left of the view
    zoom: f32,         // device pixels per world pixel
    time: f32,         // seconds
    map_size: vec2f,   // map size in cells
    // Player colours: the eight of the lobby, then more for missions with more players.
    team_colors: array<vec4f, 16>,
    anim: vec4f,       // render clock for sprite animations: seconds, enabled (js/anim.js)
    // Biome and weather (js/weather-fx.js): biome (0 temperate, 1 snow,
    // 2 desert), weather (0 clear, 1 rain, 2 thunderstorm, 3 snowfall,
    // 4 sandstorm, 5 heat wave), intensity 0..1, lightning flash 0..1.
    env: vec4f,
    // Wind (world pixels per second), particle density 0..1 (quality and
    // reduced motion), particle instances, motion (0 when the player prefers
    // reduced motion, else 1).
    env2: vec4f,
    // Art (js/content): x terrain flags (1 tile terrain: original graphics or
    // a texture pack, 2 ore tiles, 4 gem tiles, 8 rotating water colours),
    // yzw unused.
    art: vec4f,
    // Weather particles in the world (js/weather-fx.js weatherGrid, shaders/weather.wgsl):
    // first block x and y (in blocks, offset by CELL_OFFSET cells), columns, rows;
    wgrid: vec4f,
    // cell size (world px), block size (cells), level of detail fade 0..1, size scale;
    wcell: vec4f,
    // fall phase of the far, mid and near layer (0..1), snow sway phase;
    wphase: vec4f,
    // fall height and the wind's drift over the far, mid and near layer's fall (world px).
    wfall: vec4f,
};

@group(0) @binding(0) var<uniform> g: Globals;

const CELL_PX: f32 = 24.0;

fn world_to_clip(w: vec2f) -> vec4f {
    let s = (w - g.camera) * g.zoom;
    return vec4f(s.x / g.view_size.x * 2.0 - 1.0, 1.0 - s.y / g.view_size.y * 2.0, 0.0, 1.0);
}

fn hash2(p: vec2f) -> f32 {
    var q = fract(p * vec2f(123.34, 456.21));
    q += dot(q, q + 45.32);
    return fract(q.x * q.y);
}

struct FullscreenOut {
    @builtin(position) pos: vec4f,
};

fn fullscreen_pos(i: u32) -> vec4f {
    // One triangle that covers the screen.
    let uv = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
    return vec4f(uv * 2.0 - 1.0, 0.0, 1.0);
}

/// Smooth value noise, 0..1, one lattice step per unit.
fn vnoise(p: vec2f) -> f32 {
    let i = floor(p);
    let f = fract(p);
    let u = f * f * (3.0 - 2.0 * f);
    let a = hash2(i);
    let b = hash2(i + vec2f(1.0, 0.0));
    let c = hash2(i + vec2f(0.0, 1.0));
    let d = hash2(i + vec2f(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
