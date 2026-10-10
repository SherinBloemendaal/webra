// Solid rectangles in world space: selection brackets, health bars, previews.
// A negative red channel selects a team colour (see vs).
struct VsOut {
    @builtin(position) pos: vec4f,
    @location(0) color: vec4f,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32, @location(0) r: vec4f, @location(1) color: vec4f) -> VsOut {
    var corners = array<vec2f, 6>(vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0),
                                  vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0));
    var o: VsOut;
    o.pos = world_to_clip(r.xy + corners[vi] * r.zw);
    o.color = color;
    // Red below zero: team colour -r - 1 scaled by g (selection brackets, engine/src/overlays.rs).
    if (color.r < 0.0) {
        let team = min(u32(-color.r - 0.5), 15u);
        o.color = vec4f(min(g.team_colors[team].rgb * color.g, vec3f(1.0)), color.a);
    }
    return o;
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
    return vec4f(in.color.rgb * in.color.a, in.color.a);
}
