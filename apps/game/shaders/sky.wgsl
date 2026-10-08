// The sky over the battlefield, one full-screen pass after the particles:
// overcast tint for rain and storms, white haze for snowfall, drifting dust
// for sandstorms, warm haze in a heat wave, and the lightning flash (its
// strength already respects prefers-reduced-motion, see js/weather-fx.js).
@vertex
fn vs(@builtin(vertex_index) i: u32) -> FullscreenOut {
    var o: FullscreenOut;
    o.pos = fullscreen_pos(i);
    return o;
}

@fragment
fn fs(@builtin(position) p: vec4f) -> @location(0) vec4f {
    let w = g.camera + p.xy / g.zoom;
    let kind = u32(g.env.y + 0.5);
    let k = g.env.z;
    let t = g.time * mix(0.35, 1.0, g.env2.w);
    var rgb = vec3f(0.0);
    var a = 0.0;
    if (kind == 1u) {
        rgb = vec3f(0.10, 0.13, 0.18);
        a = 0.20 * k;
    } else if (kind == 2u) {
        rgb = vec3f(0.05, 0.07, 0.11);
        a = 0.32 * k;
    } else if (kind == 3u) {
        rgb = vec3f(0.86, 0.90, 0.98);
        a = (0.08 + 0.06 * vnoise(w / 220.0 + vec2f(t * 0.05, 0.0))) * k;
    } else if (kind == 4u) {
        rgb = vec3f(0.70, 0.53, 0.32);
        a = (0.22 + 0.16 * vnoise(w / 90.0 + vec2f(t * 1.2, t * 0.1))) * k;
    } else if (kind == 5u) {
        rgb = vec3f(1.0, 0.78, 0.45);
        a = 0.07 * k;
    }
    // Lightning: the whole sky goes white for an instant.
    let flash = clamp(g.env.w, 0.0, 1.0);
    rgb = mix(rgb, vec3f(0.92, 0.95, 1.0), flash);
    a = max(a, flash * 0.55);
    return vec4f(rgb * a, a);
}
