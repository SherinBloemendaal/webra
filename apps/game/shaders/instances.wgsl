// GPU instance pass (js/crowd-gpu.js): turns the tick-rate records of
// engine/src/instances.rs into this frame's sprite and rect instances.
// Per record: interpolate by alpha, cull against the view, evaluate; then a
// stable compaction (order kept) writes the visible ones and the instance
// count of an indirect draw. Three dispatches per kind:
//
//   *_count    one invocation per record: visible flags, one total per block of 256
//   scan       one workgroup: exclusive prefix sum of the block totals, the draw count
//   *_write    one invocation per record: the flags again, a scan within the block,
//              and the instance at block offset + rank
//
// The math follows engine/src/instances.rs (eval_sprite, eval_rect)
// operation by operation; js/crowd.js is its CPU reference, tested against
// Game.build_render. Presentation only: nothing here feeds the simulation.

const WG: u32 = 256u;
const SPRITE_REC: u32 = 13u;
const SPRITE_EXTRA: u32 = 12u;
const RECT_REC: u32 = 13u;
const OUT_FLOATS: u32 = 8u;
const TAU: f32 = 6.28318530717958647692;

struct Params {
    view: vec4f,   // x0, y0, x1, y1: the visible world rectangle in pixels
    alpha: f32,    // 0 at the previous tick, 1 at the current one
    count: u32,    // records
    blocks: u32,   // workgroups of the count and write passes
    pad: u32,
};

@group(1) @binding(0) var<uniform> params: Params;
@group(1) @binding(1) var<storage, read> records: array<f32>;
@group(1) @binding(2) var<storage, read> extras: array<f32>;
@group(1) @binding(3) var<storage, read_write> instances: array<f32>;
@group(1) @binding(4) var<storage, read_write> block_sums: array<u32>;
// drawIndirect arguments: vertex count, instance count, first vertex, first instance.
@group(1) @binding(5) var<storage, read_write> draw_args: array<u32, 4>;

var<workgroup> scratch: array<u32, 256>;

fn mix_lerp(a: f32, b: f32, t: f32) -> f32 {
    return a + (b - a) * t;
}

// Raw angle units (1024 per turn) plus turn times t, in radians.
fn turn_radians(a: f32, turn: f32, t: f32) -> f32 {
    return (a + turn * t) * TAU / 1024.0;
}

// View::contains with a margin; a negative margin is never culled.
fn in_view(x: f32, y: f32, margin: f32) -> bool {
    if (margin < 0.0) {
        return true;
    }
    let v = params.view;
    return x >= v.x - margin && x <= v.z + margin && y >= v.y - margin && y <= v.w + margin;
}

fn sprite_visible(i: u32) -> bool {
    let b = i * SPRITE_REC;
    let t = params.alpha;
    return in_view(mix_lerp(records[b], records[b + 2u], t), mix_lerp(records[b + 1u], records[b + 3u], t), records[b + 4u]);
}

fn rect_visible(i: u32) -> bool {
    let b = i * RECT_REC;
    let t = params.alpha;
    return in_view(mix_lerp(records[b], records[b + 2u], t), mix_lerp(records[b + 1u], records[b + 3u], t), records[b + 4u]);
}

fn write_sprite(i: u32, o: u32) {
    let b = i * SPRITE_REC;
    let t = params.alpha;
    var x = mix_lerp(records[b], records[b + 2u], t);
    var y = mix_lerp(records[b + 1u], records[b + 3u], t);
    var angle = turn_radians(records[b + 5u], records[b + 6u], t);
    var scale = records[b + 9u];
    var alpha = records[b + 10u];
    let e = records[b + 12u];
    if (e >= 0.0) {
        let k = u32(e) * SPRITE_EXTRA;
        x = x + mix_lerp(extras[k], extras[k + 2u], t);
        y = y + mix_lerp(extras[k + 1u], extras[k + 3u], t);
        let forward = extras[k + 4u];
        let right = extras[k + 5u];
        if (forward != 0.0 || right != 0.0) {
            // Forward is (sin, -cos) of the body angle, right is (cos, sin).
            let body = turn_radians(extras[k + 6u], extras[k + 7u], t);
            let s = sin(body);
            let c = cos(body);
            x = x + s * forward + c * right;
            y = y - c * forward + s * right;
        }
        angle = angle * extras[k + 8u] + extras[k + 9u];
        scale = mix_lerp(scale, extras[k + 10u], t);
        alpha = mix_lerp(alpha, extras[k + 11u], t);
    }
    let w = o * OUT_FLOATS;
    instances[w] = x;
    instances[w + 1u] = y;
    instances[w + 2u] = angle;
    instances[w + 3u] = records[b + 7u];
    instances[w + 4u] = records[b + 8u];
    instances[w + 5u] = scale;
    instances[w + 6u] = alpha;
    instances[w + 7u] = records[b + 11u];
}

fn write_rect(i: u32, o: u32) {
    let b = i * RECT_REC;
    let t = params.alpha;
    let w = o * OUT_FLOATS;
    instances[w] = mix_lerp(records[b], records[b + 2u], t) + records[b + 5u];
    instances[w + 1u] = mix_lerp(records[b + 1u], records[b + 3u], t) + records[b + 6u];
    for (var k = 2u; k < 8u; k++) {
        instances[w + k] = records[b + 5u + k];
    }
}

// Inclusive prefix sum of `v` over the workgroup (Hillis and Steele);
// every invocation must call it.
fn workgroup_scan(lid: u32, v: u32) -> u32 {
    scratch[lid] = v;
    workgroupBarrier();
    for (var stride = 1u; stride < WG; stride = stride << 1u) {
        var add = 0u;
        if (lid >= stride) {
            add = scratch[lid - stride];
        }
        workgroupBarrier();
        scratch[lid] = scratch[lid] + add;
        workgroupBarrier();
    }
    return scratch[lid];
}

@compute @workgroup_size(256)
fn sprite_count(@builtin(global_invocation_id) gid: vec3u, @builtin(local_invocation_index) lid: u32, @builtin(workgroup_id) wid: vec3u) {
    var flag = 0u;
    if (gid.x < params.count && sprite_visible(gid.x)) {
        flag = 1u;
    }
    let sum = workgroup_scan(lid, flag);
    if (lid == WG - 1u) {
        block_sums[wid.x] = sum;
    }
}

@compute @workgroup_size(256)
fn rect_count(@builtin(global_invocation_id) gid: vec3u, @builtin(local_invocation_index) lid: u32, @builtin(workgroup_id) wid: vec3u) {
    var flag = 0u;
    if (gid.x < params.count && rect_visible(gid.x)) {
        flag = 1u;
    }
    let sum = workgroup_scan(lid, flag);
    if (lid == WG - 1u) {
        block_sums[wid.x] = sum;
    }
}

// Block totals to block offsets (exclusive), 256 at a time with a carry; the
// grand total is the indirect draw's instance count.
@compute @workgroup_size(256)
fn scan(@builtin(local_invocation_index) lid: u32) {
    var carry = 0u;
    let chunks = (params.blocks + WG - 1u) / WG;
    for (var c = 0u; c < chunks; c++) {
        let i = c * WG + lid;
        var v = 0u;
        if (i < params.blocks) {
            v = block_sums[i];
        }
        let inclusive = workgroup_scan(lid, v);
        if (i < params.blocks) {
            block_sums[i] = carry + inclusive - v;
        }
        carry = carry + scratch[WG - 1u];
        workgroupBarrier();
    }
    if (lid == 0u) {
        draw_args[0] = 6u;
        draw_args[1] = carry;
        draw_args[2] = 0u;
        draw_args[3] = 0u;
    }
}

@compute @workgroup_size(256)
fn sprite_write(@builtin(global_invocation_id) gid: vec3u, @builtin(local_invocation_index) lid: u32, @builtin(workgroup_id) wid: vec3u) {
    var flag = 0u;
    if (gid.x < params.count && sprite_visible(gid.x)) {
        flag = 1u;
    }
    let rank = workgroup_scan(lid, flag);
    if (flag == 1u) {
        write_sprite(gid.x, block_sums[wid.x] + rank - 1u);
    }
}

@compute @workgroup_size(256)
fn rect_write(@builtin(global_invocation_id) gid: vec3u, @builtin(local_invocation_index) lid: u32, @builtin(workgroup_id) wid: vec3u) {
    var flag = 0u;
    if (gid.x < params.count && rect_visible(gid.x)) {
        flag = 1u;
    }
    let rank = workgroup_scan(lid, flag);
    if (flag == 1u) {
        write_rect(gid.x, block_sums[wid.x] + rank - 1u);
    }
}
