// Instanced sprites from the atlas, tinted with team colours.
//
// Two kinds of sprite slots (js/sprites.js buildAtlas, js/content/atlas.js):
// - WebRA's own art: one frame, rotated by the instance angle; the head of an
//   animated building layer names its frames in `anim`.
// - Sequence slots (original graphics, texture packs): pre-rendered facings
//   and animations the OpenRA way. The sprite id carries the pose the engine
//   reports (engine/src/render.rs `Pose`: id = slot + 4096 * (pose + 16 *
//   age)); the slot's pose table names a sequence per pose, the instance
//   angle picks the facing frame instead of rotating the sprite, and the
//   render clock (or the age) picks the animation frame. js/content/sequences.js
//   mirrors this math and is tested against OpenRA's.
struct Frame {
    uv: vec4f,    // u0, v0, u1, v1
    size: vec4f,  // width, height, offset x, offset y of the centre, in world pixels
    // Head of a WebRA animation: first frame, frame count, frames per second (count > 1).
    // Pose descriptor: first frame, frames per facing, frames per second, mode.
    anim: vec4f,
    // Head of a sequence slot: first pose descriptor, pose count (> 0 marks the slot).
    // Pose descriptor: facings, flags (1 classic facings, 2 free rotation), interpolated facings,
    // lead-in frames (MODE_LEAD).
    seq: vec4f,
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

const TURN: f32 = 6.28318530717958647692;
const POSE_STRIDE: u32 = 4096u;
const POSE_CODES: u32 = 32u;
const MODE_LOOP: u32 = 0u;
const MODE_ONCE: u32 = 1u;
const MODE_STILL: u32 = 2u;
const MODE_INDEX: u32 = 3u;
// The first seq.w frames once from the age, then the rest looping on the render clock.
const MODE_LEAD: u32 = 4u;
// Play once from the age, then nothing (infantry death animations).
const MODE_VANISH: u32 = 5u;
const FLAG_CLASSIC: u32 = 1u;
const FLAG_ROTATE: u32 = 2u;
// Simulation ticks per second: ages are in ticks (engine TICKS_PER_SECOND).
const TICKS_PER_SECOND: f32 = 25.0;
// Exclusive upper OpenRA angle of each frame of classic 32-facing sprites
// (OpenRA.Mods.Cnc.Util.SpriteRanges; js/content/sequences.js CLASSIC_RANGES).
const CLASSIC_RANGES = array<u32, 32>(
    20u, 56u, 88u, 132u, 156u, 184u, 212u, 240u, 268u, 296u, 324u, 352u, 384u, 416u, 452u, 488u,
    532u, 568u, 604u, 644u, 668u, 696u, 724u, 752u, 780u, 808u, 836u, 864u, 896u, 928u, 964u, 1000u
);

// Frame of an animation at the render clock; 0 while animation is off
// (paused clocks just stop). Mirrors animFrame in js/anim.js.
fn anim_frame(time: f32, enabled: f32, fps: f32, count: u32, phase: f32) -> u32 {
    if (enabled < 0.5 || count <= 1u) {
        return 0u;
    }
    let step = floor(max(time, 0.0) * fps + phase * f32(count));
    return u32(step) % count;
}

// The OpenRA angle (counter-clockwise, 1024 per turn) of a WebRA instance
// angle in radians (clockwise), rounded to whole units.
fn openra_angle(radians: f32) -> u32 {
    let raw = i32(floor(radians * (1024.0 / TURN) + 0.5));
    return u32(((1024 - raw) % 1024 + 1024) % 1024);
}

// OpenRA Util.IndexFacing.
fn index_facing(a: u32, facings: u32) -> u32 {
    let step = 1024u / facings;
    return ((a + step / 2u) & 1023u) / step;
}

// OpenRA ClassicIndexFacing (32 facings with uneven steps).
fn classic_index_facing(a: u32, facings: u32) -> u32 {
    if (facings != 32u) {
        return index_facing(a, facings);
    }
    for (var i = 0u; i < 32u; i++) {
        if (a < CLASSIC_RANGES[i]) {
            return i;
        }
    }
    return 0u;
}

// OpenRA GetInterpolatedFacingRotation, as clockwise radians for the sprite.
fn interpolated_rotation(a: u32, facings: u32, interpolated: u32) -> f32 {
    let step = 1024u / facings;
    let half = step / 2u;
    let diff = i32(((a + half) & 1023u) % step) - i32(half);
    let wrapped = u32((diff + 1024) % 1024);
    let istep = 1024u / interpolated;
    let r = ((wrapped / istep) * istep) & 1023u;
    let signed = select(i32(r), i32(r) - 1024, r >= 512u);
    return -f32(signed) * (TURN / 1024.0);
}

@vertex
fn vs(@builtin(vertex_index) vi: u32,
      @location(0) a: vec4f,   // x, y, angle, sprite
      @location(1) b: vec4f    // team, scale, alpha, flash
) -> VsOut {
    var corners = array<vec2f, 6>(vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0),
                                  vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0));
    let corner = corners[vi];
    let code = u32(a.w);
    let slot = code % POSE_STRIDE;
    let packed = code / POSE_STRIDE;
    let pose = packed % POSE_CODES;
    let age = packed / POSE_CODES;
    // Each instance gets its own phase from its position, so neighbours do not blink in step.
    let phase = hash2(a.xy * 0.01);
    var index = slot;
    var angle = a.z;
    // A finished VANISH pose (death animations) draws nothing.
    var hidden = false;
    let head = frames[slot];
    if (head.seq.y > 0.5) {
        let base = u32(head.seq.x);
        var d = frames[base + min(pose, u32(head.seq.y) - 1u)];
        var mode = u32(d.anim.w);
        var k = 0u;
        if (mode == MODE_ONCE || mode == MODE_VANISH) {
            let f = u32(floor(f32(age) * d.anim.z / TICKS_PER_SECOND));
            let count = max(u32(d.anim.y), 1u);
            if (f < count) {
                k = f;
            } else if (mode == MODE_VANISH) {
                hidden = true;
                k = count - 1u;
            } else {
                // Finished: the idle pose takes over.
                d = frames[base];
                mode = u32(d.anim.w);
            }
        }
        let len = max(u32(d.anim.y), 1u);
        if (mode == MODE_LOOP) {
            k = anim_frame(g.anim.x, g.anim.y, d.anim.z, len, phase);
        } else if (mode == MODE_INDEX) {
            k = min(age, len - 1u);
        } else if (mode == MODE_STILL) {
            k = 0u;
        } else if (mode == MODE_LEAD) {
            let lead = min(u32(d.seq.w), len);
            let f = u32(floor(f32(age) * d.anim.z / TICKS_PER_SECOND));
            if (f < lead) {
                k = f;
            } else if (len > lead) {
                k = lead + anim_frame(g.anim.x, g.anim.y, d.anim.z, len - lead, phase);
            } else {
                k = len - 1u;
            }
        }
        let facings = max(u32(d.seq.x), 1u);
        let flags = u32(d.seq.y);
        var facing = 0u;
        if (facings > 1u) {
            let oa = openra_angle(a.z);
            if ((flags & FLAG_CLASSIC) != 0u) {
                facing = classic_index_facing(oa, facings);
            } else {
                facing = index_facing(oa, facings);
            }
            angle = 0.0;
            if (d.seq.z > 0.5) {
                angle = interpolated_rotation(oa, facings, u32(d.seq.z));
            }
        } else if ((flags & FLAG_ROTATE) == 0u) {
            angle = 0.0;
        }
        index = u32(d.anim.x) + facing * len + k;
    } else if (head.anim.y > 1.5) {
        index = u32(head.anim.x) + anim_frame(g.anim.x, g.anim.y, head.anim.z, u32(head.anim.y), phase);
    }
    let f = frames[index];
    let local = ((corner - 0.5) * f.size.xy + f.size.zw) * select(b.y, 0.0, hidden);
    let c = cos(angle);
    let s = sin(angle);
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
