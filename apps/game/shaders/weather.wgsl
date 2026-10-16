// Weather particles in the world: rain, snow and blowing sand, made up in the
// vertex shader from the instance index, so the CPU only sets the grid and
// the clock (js/weather-fx.js weatherGrid and WeatherFx.uniforms).
//
// The ground under the view is cut into square cells of g.wcell.x world
// pixels; each cell holds one particle per depth layer (far, mid, near). A
// particle has its own spot of ground in its cell and falls onto it: it
// starts g.wfall.x world pixels up in the air (screen up in Red Alert's
// top-down view), drifts with the wind (g.wfall.yzw over the whole fall of
// each layer) and lands, then splashes (rain) or lies a moment (snow) and
// starts again. Where it is in its fall comes from its layer's phase
// (g.wphase, kept by the CPU so it wraps) and a random offset, never from
// the screen position or a large time, so panning and zooming move the
// particles exactly like the map under them. A small perspective lifts
// particles high in the air away from the view centre (PARALLAX), so the
// layers drift a little against the ground while the camera moves.
//
// Level of detail: instances are blocks of g.wcell.y x g.wcell.y cells, and
// each block draws the one particle its random choice keeps (the same one
// at every level), so zooming out drops particles instead of moving them; the
// ones the next level drops fade out first (g.wcell.z).

const LAYERS: u32 = 3u;
/** js/weather-fx.js CELL_OFFSET: fine cell indices are offset so they stay positive. */
const CELL_OFFSET: f32 = 4096.0;
/** How far (share of its height) a particle at the view's edge is pushed outward by perspective. */
const PARALLAX: f32 = 0.18;

struct VsOut {
    @builtin(position) pos: vec4f,
    // -1..1 across the quad.
    @location(0) uv: vec2f,
    @location(1) alpha: f32,
    // 0 a streak (rain, sand), 1 a flake, 2 a splash ring.
    @location(2) shape: f32,
};

fn pcg3(v0: vec3u) -> vec3u {
    var v = v0 * 1664525u + vec3u(1013904223u);
    v.x += v.y * v.z;
    v.y += v.z * v.x;
    v.z += v.x * v.y;
    v = v ^ (v >> vec3u(16u));
    v.x += v.y * v.z;
    v.y += v.z * v.x;
    v.z += v.x * v.y;
    return v;
}

/** Three numbers 0..1 (never 1) from a cell and a salt. */
fn rand3(c: vec2u, salt: u32) -> vec3f {
    return vec3f(pcg3(vec3u(c, salt)) >> vec3u(8u)) * (1.0 / 16777216.0);
}

/** Which of the four half-size blocks of the block `b` (of `size` cells) keeps its particle. */
fn pick(b: vec2u, size: u32, layer: u32) -> vec2u {
    let r = pcg3(vec3u(b, size * 4u + layer + 7919u)).x;
    return vec2u(r & 1u, (r >> 1u) & 1u);
}

fn hidden() -> VsOut {
    var o: VsOut;
    o.pos = vec4f(-2.0, -2.0, 0.0, 1.0);
    o.uv = vec2f(0.0);
    o.alpha = 0.0;
    o.shape = 0.0;
    return o;
}

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VsOut {
    var corners = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
                                  vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0));
    let kind = u32(g.env.y + 0.5);
    let layer = ii % LAYERS;
    let index = ii / LAYERS;
    let cols = max(u32(g.wgrid.z + 0.5), 1u);
    let block = max(u32(g.wcell.y + 0.5), 1u);
    let b = vec2u(u32(g.wgrid.x + 0.5) + index % cols, u32(g.wgrid.y + 0.5) + index / cols);
    // The block's particle: down the levels, a random quarter each time.
    var size = block;
    var fine = b * block;
    loop {
        if (size <= 1u) {
            break;
        }
        let q = pick(fine / size, size, layer);
        size = size / 2u;
        fine += q * size;
    }
    // The next level keeps one block in four: the other three fade out first.
    let keep = all(pick(b / 2u, block * 2u, layer) == b % vec2u(2u));
    let lod = select(1.0 - g.wcell.z, 1.0, keep);
    let r1 = rand3(fine, layer);
    let r2 = rand3(fine, layer + 101u);
    // Heavier weather shows more of the particles (each fades in at its own intensity).
    let shown = clamp((g.env.z * g.env2.y - r1.z) * 12.0, 0.0, 1.0);
    if (shown * lod <= 0.002) {
        return hidden();
    }

    let cell = g.wcell.x;
    let ground = (vec2f(fine) - vec2f(CELL_OFFSET) + r1.xy) * cell;
    let depth = f32(layer) / f32(LAYERS - 1u);
    let scale = mix(0.6, 1.15, depth);
    let size_scale = g.wcell.w;
    let motion = g.env2.w;
    let height = g.wfall.x;
    let drift = g.wfall[layer + 1u];

    // How the kind falls and lands: the share of the cycle in the air, then
    // the splash (rain) or the flake lying on the ground (snow).
    var land = 1.0;
    var base = 0.38;
    if (kind == 1u || kind == 2u) {
        // No splashes with reduced motion.
        land = select(1.0, 0.76, motion > 0.5);
        if (kind == 2u) {
            base = 0.45;
        }
    } else if (kind == 3u) {
        land = 0.8;
        base = 0.85;
    } else if (kind == 4u) {
        base = 0.45;
    }
    let phase = fract(g.wphase[layer] + r2.x);
    let q = min(phase / land, 1.0);
    let after = clamp((phase - land) / max(1.0 - land, 0.0001), 0.0, 1.0);
    let z = height * (1.0 - q);

    // In the air: carried by the wind, and lifted away from the view centre by perspective.
    let half_view = g.view_size / (2.0 * g.zoom);
    let centre = g.camera + half_view;
    let lean = (ground - centre) / half_view * PARALLAX;
    var pos = ground - vec2f(drift * (1.0 - q), z) + lean * z;
    if (kind == 3u) {
        // Flakes sway, less in the last stretch so they settle where they were meant to.
        pos.x += sin((g.wphase.w + r2.y) * 6.2831853) * 7.0 * motion * min(1.0, (1.0 - q) * 4.0);
    }

    let corner = corners[vi];
    var o: VsOut;
    var alpha = base * mix(0.45, 1.0, depth) * shown * lod;
    var centre_w = pos;
    var offset = vec2f(0.0);
    if (phase >= land && (kind == 1u || kind == 2u)) {
        // A splash ring on the ground, flattened by the view.
        var r = mix(1.5, 5.0, after) * scale * size_scale;
        let px = r * g.zoom;
        if (px < 1.0) {
            alpha *= px;
            r = 1.0 / g.zoom;
        }
        alpha *= (1.0 - after) * 0.8;
        offset = corner * vec2f(r, r * 0.5);
        centre_w = ground;
        o.shape = 2.0;
    } else if (kind == 3u) {
        // A flake; on the ground it melts away.
        var r = (1.3 + 0.9 * r2.z) * scale * size_scale;
        let px = r * g.zoom;
        if (px < 1.0) {
            alpha *= px;
            r = 1.0 / g.zoom;
        }
        alpha *= smoothstep(0.0, 0.1, q) * (1.0 - after);
        offset = corner * r * 1.5;
        o.shape = 1.0;
    } else {
        // A streak along the way it moves, its head where the particle is.
        let vel = vec2f(drift, height) - lean * height;
        let dir = normalize(vel + vec2f(0.0001, 0.0));
        let side = vec2f(-dir.y, dir.x);
        var len = (16.0 + 6.0 * r2.z) * scale;
        var w = 1.0 * scale * size_scale;
        if (kind == 2u) {
            len = (20.0 + 8.0 * r2.z) * scale;
            w = 1.15 * scale * size_scale;
        } else if (kind == 4u) {
            len = (7.0 + 7.0 * r2.z) * scale;
            w = 1.2 * scale * size_scale;
        }
        let px = w * g.zoom;
        if (px < 1.0) {
            alpha *= px;
            w = 1.0 / g.zoom;
        }
        // Fade in high up; blowing sand also fades out before it would stop.
        alpha *= smoothstep(0.0, 0.12, q);
        if (kind == 4u) {
            alpha *= 1.0 - smoothstep(0.85, 1.0, q);
        }
        centre_w = pos - dir * len * 0.5;
        offset = side * corner.x * w + dir * corner.y * len * 0.5;
        o.shape = 0.0;
    }
    if (alpha <= 0.002) {
        return hidden();
    }
    o.pos = world_to_clip(centre_w + offset);
    o.uv = corner;
    o.alpha = clamp(alpha, 0.0, 1.0);
    return o;
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
    let kind = u32(g.env.y + 0.5);
    var rgb = vec3f(0.72, 0.78, 0.88);
    var a = in.alpha;
    if (in.shape > 1.5) {
        // Splash ring.
        rgb = vec3f(0.80, 0.86, 0.95);
        let d = length(in.uv);
        a *= smoothstep(0.45, 0.8, d) * (1.0 - smoothstep(0.8, 1.0, d));
    } else if (in.shape > 0.5) {
        // Soft round flake.
        rgb = vec3f(0.97, 0.98, 1.0);
        a *= 1.0 - smoothstep(0.35, 0.67, length(in.uv));
    } else {
        // Streak: soft across, fading towards both ends (the tail more).
        if (kind == 4u) {
            rgb = vec3f(0.86, 0.70, 0.46);
        }
        a *= (1.0 - abs(in.uv.x)) * (1.0 - abs(in.uv.y) * 0.8) * mix(0.6, 1.0, in.uv.y * 0.5 + 0.5);
    }
    a = clamp(a, 0.0, 1.0);
    return vec4f(rgb * a, a);
}
