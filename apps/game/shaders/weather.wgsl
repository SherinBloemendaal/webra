// Weather particles: rain streaks, snowflakes and blowing sand, all made up
// in the vertex shader from the instance index and the time, so the CPU only
// sets the count (js/weather-fx.js caps it). The particle field is anchored
// in the world and wraps around the view, so it scrolls with the map.
struct VsOut {
    @builtin(position) pos: vec4f,
    @location(0) uv: vec2f,
    @location(1) alpha: f32,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VsOut {
    var corners = array<vec2f, 6>(vec2f(-0.5, -0.5), vec2f(0.5, -0.5), vec2f(-0.5, 0.5),
                                  vec2f(-0.5, 0.5), vec2f(0.5, -0.5), vec2f(0.5, 0.5));
    let kind = u32(g.env.y + 0.5);
    let fi = f32(ii);
    let h1 = hash2(vec2f(fi, 1.7));
    let h2 = hash2(vec2f(fi, 8.3));
    let h3 = hash2(vec2f(fi, 4.1));
    let motion = mix(0.35, 1.0, g.env2.w);
    let t = g.time * motion;
    var vel = vec2f(g.env2.x, 520.0) * (0.8 + 0.4 * h3);
    var size = vec2f(1.1, 15.0);
    var alpha = 0.35;
    if (kind == 2u) {
        vel = vec2f(g.env2.x * 1.6, 680.0) * (0.8 + 0.4 * h3);
        size = vec2f(1.2, 19.0);
        alpha = 0.42;
    } else if (kind == 3u) {
        vel = vec2f(g.env2.x * 0.5 + sin(t * 0.9 + h1 * 6.28) * 16.0, 38.0 + 30.0 * h3);
        size = vec2f(2.2 + 1.6 * h3, 2.2 + 1.6 * h3);
        alpha = 0.85;
    } else if (kind == 4u) {
        vel = vec2f(g.env2.x + 160.0 * h3, 18.0 + 20.0 * h1);
        size = vec2f(1.3, 9.0 + 8.0 * h3);
        alpha = 0.45;
    }
    let view = g.view_size / g.zoom;
    let start = vec2f(h1, h2) * view;
    let pos = g.camera + fract((start + vel * t - g.camera) / view) * view;
    // Streaks lie along their velocity.
    let dir = normalize(vel + vec2f(0.0001, 0.0));
    let side = vec2f(-dir.y, dir.x);
    let corner = corners[vi];
    let offset = side * corner.x * size.x + dir * corner.y * size.y;
    var o: VsOut;
    o.pos = world_to_clip(pos + offset);
    o.uv = corner + vec2f(0.5);
    o.alpha = alpha * g.env.z;
    return o;
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
    let kind = u32(g.env.y + 0.5);
    var rgb = vec3f(0.72, 0.78, 0.88);
    // Fade both ends of a streak; flakes are soft round dots.
    var a = in.alpha * (1.0 - abs(in.uv.y - 0.5) * 1.6);
    if (kind == 3u) {
        rgb = vec3f(0.97, 0.98, 1.0);
        a = in.alpha * (1.0 - smoothstep(0.25, 0.5, length(in.uv - vec2f(0.5))));
    } else if (kind == 4u) {
        rgb = vec3f(0.86, 0.70, 0.46);
    }
    a = clamp(a, 0.0, 1.0);
    return vec4f(rgb * a, a);
}
