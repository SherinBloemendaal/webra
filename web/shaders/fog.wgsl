// Shroud (black) and fog (dimmed) from a one-byte-per-cell texture, softened by
// linear filtering between cell centres.
@group(1) @binding(0) var fog_tex: texture_2d<f32>;
@group(1) @binding(1) var fog_samp: sampler;

@vertex
fn vs(@builtin(vertex_index) i: u32) -> FullscreenOut {
    var o: FullscreenOut;
    o.pos = fullscreen_pos(i);
    return o;
}

@fragment
fn fs(@builtin(position) p: vec4f) -> @location(0) vec4f {
    let w = g.camera + p.xy / g.zoom;
    let uv = w / CELL_PX / g.map_size;
    let v = textureSampleLevel(fog_tex, fog_samp, uv, 0.0).r;
    // 0 = shroud, 0.5 = fog, 1 = visible
    var a: f32;
    if (v < 0.5) {
        a = mix(1.0, 0.55, smoothstep(0.0, 0.5, v));
    } else {
        a = mix(0.55, 0.0, smoothstep(0.5, 1.0, v));
    }
    return vec4f(0.0, 0.0, 0.0, a);
}
