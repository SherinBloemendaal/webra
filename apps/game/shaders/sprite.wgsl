// Instanced, rotated sprites from the generated atlas, tinted with team colours.
struct Frame {
    uv: vec4f,    // u0, v0, u1, v1
    size: vec4f,  // width, height in world pixels
};

@group(1) @binding(0) var atlas: texture_2d<f32>;
@group(1) @binding(1) var mask: texture_2d<f32>;
@group(1) @binding(2) var samp: sampler;
@group(1) @binding(3) var<storage, read> frames: array<Frame>;

struct VsOut {
    @builtin(position) pos: vec4f,
    @location(0) uv: vec2f,
    @location(1) @interpolate(flat) team: u32,
    @location(2) alpha: f32,
    @location(3) flash: f32,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32,
      @location(0) a: vec4f,   // x, y, angle, sprite
      @location(1) b: vec4f    // team, scale, alpha, flash
) -> VsOut {
    var corners = array<vec2f, 6>(vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0),
                                  vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0));
    let corner = corners[vi];
    let f = frames[u32(a.w)];
    let local = (corner - 0.5) * f.size.xy * b.y;
    let c = cos(a.z);
    let s = sin(a.z);
    let rotated = vec2f(local.x * c - local.y * s, local.x * s + local.y * c);
    var o: VsOut;
    o.pos = world_to_clip(a.xy + rotated);
    o.uv = mix(f.uv.xy, f.uv.zw, corner);
    o.team = u32(b.x);
    o.alpha = b.z;
    o.flash = b.w;
    return o;
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
    let base = textureSample(atlas, samp, in.uv);
    let m = textureSample(mask, samp, in.uv).r;
    let team = g.team_colors[min(in.team, 7u)].rgb;
    // Team areas are painted grey in the atlas; the grey level becomes shading.
    var rgb = mix(base.rgb, team * (0.35 + base.r * 1.05), m);
    // flash > 0: white hit flash; flash < 0: solid black (aircraft shadows).
    rgb = select(mix(rgb, vec3f(1.0), in.flash * 0.55), vec3f(0.0), in.flash < 0.0);
    let a = base.a * in.alpha;
    return vec4f(rgb * a, a);
}
