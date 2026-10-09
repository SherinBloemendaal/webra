// Line segments in world space with a fixed width on screen: unit path lines
// and rally lines. Instance: p.xy = start, p.zw = end (world pixels), color =
// rgba; a negative red channel selects a team colour like rect.wgsl (rally
// lines in the owner's colour, engine/src/overlays.rs).
struct VsOut {
    @builtin(position) pos: vec4f,
    @location(0) color: vec4f,
};

// Half the line width, in device pixels.
const HALF_WIDTH: f32 = 1.0;

@vertex
fn vs(@builtin(vertex_index) vi: u32, @location(0) p: vec4f, @location(1) color: vec4f) -> VsOut {
    // Corners as (along, across): two triangles covering the segment.
    var corners = array<vec2f, 6>(vec2f(0.0, -1.0), vec2f(1.0, -1.0), vec2f(0.0, 1.0),
                                  vec2f(0.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0));
    let c = corners[vi];
    let a = (p.xy - g.camera) * g.zoom;
    let b = (p.zw - g.camera) * g.zoom;
    let d = b - a;
    let len = length(d);
    var dir = vec2f(1.0, 0.0);
    if (len > 0.0001) {
        dir = d / len;
    }
    let normal = vec2f(-dir.y, dir.x);
    let s = mix(a, b, c.x) + normal * HALF_WIDTH * c.y;
    var o: VsOut;
    o.pos = vec4f(s.x / g.view_size.x * 2.0 - 1.0, 1.0 - s.y / g.view_size.y * 2.0, 0.0, 1.0);
    o.color = color;
    if (color.r < 0.0) {
        let team = min(u32(-color.r - 0.5), 7u);
        o.color = vec4f(min(g.team_colors[team].rgb * color.g, vec3f(1.0)), color.a);
    }
    return o;
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
    return vec4f(in.color.rgb * in.color.a, in.color.a);
}
