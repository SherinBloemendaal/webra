// Heat shimmer over hot vehicles (desert heat waves, engine/src/weather.rs):
// one instanced quad per unit from Game.build_heat_fx (x, y, heat 0..1,
// overheated 0 or 1). Warm glow with wavy bands rising from the hull, red
// and flickering once the vehicle has overheated.
struct VsOut {
    @builtin(position) pos: vec4f,
    @location(0) uv: vec2f,
    @location(1) @interpolate(flat) info: vec2f,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32, @location(0) u: vec4f) -> VsOut {
    var corners = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
                                  vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0));
    let corner = corners[vi];
    var o: VsOut;
    // A little taller than wide: the shimmer rises above the unit.
    o.pos = world_to_clip(u.xy + corner * vec2f(18.0, 24.0) - vec2f(0.0, 6.0));
    o.uv = corner;
    o.info = u.zw;
    return o;
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
    let heat = clamp(in.info.x, 0.0, 1.0);
    let hot = in.info.y > 0.5;
    let t = g.time * mix(0.35, 1.0, g.env2.w);
    let r = length(in.uv * vec2f(1.0, 0.8));
    let fall = 1.0 - smoothstep(0.35, 1.0, r);
    let bands = 0.5 + 0.5 * sin(in.uv.y * 9.0 + t * 7.0 + sin(in.uv.x * 5.0 + t * 3.0) * 1.5);
    var rgb = mix(vec3f(1.0, 0.72, 0.30), vec3f(1.0, 0.30, 0.10), select(0.0, 1.0, hot));
    var a = fall * heat * heat * (0.18 + 0.22 * bands);
    if (hot) {
        a = a + fall * 0.12 * (0.6 + 0.4 * sin(t * 11.0));
    }
    a = clamp(a, 0.0, 0.6);
    return vec4f(rgb * a, a);
}
