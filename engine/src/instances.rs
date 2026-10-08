//! Tick-rate instance records: what `build_render` draws, described so that
//! the interpolation by `alpha` and the culling against the view can run
//! later, once per render frame, on the GPU (apps/game/shaders/instances.wgsl)
//! or right away on the CPU.
//!
//! Every sprite and rect of a frame is an affine function of `alpha` between
//! the previous and the current tick, plus a rotation for offsets along a
//! hull or rotor arm. A record holds both ends, the facing and its signed
//! turn (wraparound already resolved by `angle_diff`), and the reference
//! point and margin its group is culled by. `Sink` is where the render code
//! (render.rs, overlays.rs, helicopter.rs, plane.rs, veterancy.rs,
//! abilities.rs) puts them: in `Eval` mode each record is evaluated at once
//! (`Game.build_render`, the CPU path), in `Record` mode it is stored as
//! flat floats (`Game.build_render_records`, the GPU path). Both paths run
//! the same code, so they cannot drift apart; `eval_sprite` and `eval_rect`
//! are the reference the WGSL and apps/game/js/crowd.js follow operation by
//! operation.
//!
//! Flat layouts (f32 each, docs/contracts.md section 8):
//! - sprite record, `SPRITE_REC_FLOATS`: `[x0, y0, x1, y1, margin, angle,
//!   turn, sprite, team, scale, alpha, flash, extra]`; `extra` is an index
//!   into the extras array, or -1.
//! - sprite extra, `SPRITE_EXTRA_FLOATS`: `[ox0, oy0, ox1, oy1, forward,
//!   right, body, body_turn, angle_mul, angle_add, scale1, alpha1]`.
//! - rect record, `RECT_REC_FLOATS`: `[x0, y0, x1, y1, margin, ox, oy, w, h,
//!   r, g, b, a]`.
//!
//! A negative margin means "never culled".

use crate::render::View;

pub const SPRITE_REC_FLOATS: usize = 13;
pub const SPRITE_EXTRA_FLOATS: usize = 12;
pub const RECT_REC_FLOATS: usize = 13;
/// Margin of records that are drawn wherever they are (selection overlays).
pub const NO_CULL: f32 = -1.0;

const TAU: f32 = std::f32::consts::TAU;

/// The interpolation every record uses: `a + (b - a) * t` (render.rs `lerp`).
#[inline]
pub fn lerp(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t
}

/// Raw angle units (1024 per turn) to radians, as `lerp_angle` does.
#[inline]
fn radians(a: f32, turn: f32, t: f32) -> f32 {
    (a + turn * t) * TAU / 1024.0
}

/// Rare parts of a sprite record: offsets from the reference point (fixed or
/// interpolated), an arm along the hull, angle scaling and fades.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SpriteExtra {
    /// Offset from the reference point at the previous and current tick.
    pub offset0: [f32; 2],
    pub offset1: [f32; 2],
    /// Offset along the body (forward, right), turned by the body angle.
    pub arm: [f32; 2],
    /// Body angle and its turn, raw angle units.
    pub body: f32,
    pub body_turn: f32,
    /// Final angle: `angle * angle_mul + angle_add` (radians).
    pub angle_mul: f32,
    pub angle_add: f32,
    /// Scale and alpha at the current tick (the record holds the previous).
    pub scale1: f32,
    pub alpha1: f32,
}

/// One sprite of a frame, before interpolation and culling. The common
/// case (a body or turret on its actor) needs nothing more; `offset`,
/// `arm`, `radians`, `angle_affine` and `fade_to` turn it into a
/// `SpriteRecX` with a `SpriteExtra`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SpriteRec {
    /// Reference point at the previous and the current tick (world pixels):
    /// interpolated, culled against the view with `margin`, then offset.
    pub from: [f32; 2],
    pub to: [f32; 2],
    pub margin: f32,
    /// Raw facing at the previous tick and its signed turn to the current one.
    pub angle: f32,
    pub turn: f32,
    pub sprite: f32,
    pub team: f32,
    pub scale: f32,
    pub alpha: f32,
    pub flash: f32,
    /// `Eval` mode only (never stored): the reference point at the frame's
    /// alpha, already found inside the view by `Sink::group`.
    pub at: Option<[f32; 2]>,
}

/// A sprite record with its extra part.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SpriteRecX {
    pub rec: SpriteRec,
    pub extra: SpriteExtra,
}

impl SpriteRec {
    /// A sprite at a fixed point, culled with `margin` around it.
    #[inline]
    pub fn at(x: f32, y: f32, margin: f32) -> SpriteRec {
        SpriteRec::moving([x, y], [x, y], margin)
    }

    /// A sprite whose reference point moves from `from` to `to` during the tick.
    #[inline]
    pub fn moving(from: [f32; 2], to: [f32; 2], margin: f32) -> SpriteRec {
        SpriteRec { from, to, margin, angle: 0.0, turn: 0.0, sprite: 0.0, team: 0.0, scale: 1.0, alpha: 1.0, flash: 0.0, at: None }
    }

    /// Facing in raw angle units at the previous tick and its turn (`angle_diff`).
    #[inline]
    pub fn facing(mut self, angle: i32, turn: i32) -> SpriteRec {
        self.angle = angle as f32;
        self.turn = turn as f32;
        self
    }

    #[inline]
    pub fn look(mut self, sprite: f32, team: f32, scale: f32, alpha: f32, flash: f32) -> SpriteRec {
        self.sprite = sprite;
        self.team = team;
        self.scale = scale;
        self.alpha = alpha;
        self.flash = flash;
        self
    }

    /// The record with a neutral extra part: no offset or arm, the angle as
    /// it is, scale and alpha constant.
    #[inline]
    pub fn extended(self) -> SpriteRecX {
        let extra = SpriteExtra {
            offset0: [0.0, 0.0],
            offset1: [0.0, 0.0],
            arm: [0.0, 0.0],
            body: 0.0,
            body_turn: 0.0,
            angle_mul: 1.0,
            angle_add: 0.0,
            scale1: self.scale,
            alpha1: self.alpha,
        };
        SpriteRecX { rec: self, extra }
    }

    /// See `SpriteRecX::offset`.
    #[inline]
    pub fn offset(self, dx: f32, dy: f32) -> SpriteRecX {
        self.extended().offset(dx, dy)
    }

    /// See `SpriteRecX::offset_moving`.
    #[inline]
    pub fn offset_moving(self, from: [f32; 2], to: [f32; 2]) -> SpriteRecX {
        self.extended().offset_moving(from, to)
    }

    /// See `SpriteRecX::radians`.
    #[inline]
    pub fn radians(self, angle: f32) -> SpriteRecX {
        self.extended().radians(angle)
    }

    /// See `SpriteRecX::angle_affine`.
    #[inline]
    pub fn angle_affine(self, mul: f32, add: f32) -> SpriteRecX {
        self.extended().angle_affine(mul, add)
    }

    /// See `SpriteRecX::fade_to`.
    #[inline]
    pub fn fade_to(self, scale: f32, alpha: f32) -> SpriteRecX {
        self.extended().fade_to(scale, alpha)
    }
}

impl SpriteRecX {
    /// Drawn at a fixed offset from the reference point.
    #[inline]
    pub fn offset(self, dx: f32, dy: f32) -> SpriteRecX {
        self.offset_moving([dx, dy], [dx, dy])
    }

    /// Drawn at an offset that changes during the tick.
    #[inline]
    pub fn offset_moving(mut self, from: [f32; 2], to: [f32; 2]) -> SpriteRecX {
        self.extra.offset0 = from;
        self.extra.offset1 = to;
        self
    }

    /// Offset along a body that faces `body` (raw units, turning by `turn`):
    /// `forward` along the facing, `right` across it.
    #[inline]
    pub fn arm(mut self, forward: f32, right: f32, body: i32, turn: i32) -> SpriteRecX {
        self.extra.arm = [forward, right];
        self.extra.body = body as f32;
        self.extra.body_turn = turn as f32;
        self
    }

    /// A fixed angle in radians instead of a facing.
    #[inline]
    pub fn radians(mut self, angle: f32) -> SpriteRecX {
        self.rec.angle = 0.0;
        self.rec.turn = 0.0;
        self.extra.angle_mul = 1.0;
        self.extra.angle_add = angle;
        self
    }

    /// The interpolated facing (radians) times `mul`, plus `add`.
    #[inline]
    pub fn angle_affine(mut self, mul: f32, add: f32) -> SpriteRecX {
        self.extra.angle_mul = mul;
        self.extra.angle_add = add;
        self
    }

    /// Scale and alpha at the current tick (`look` gave the previous tick's).
    #[inline]
    pub fn fade_to(mut self, scale: f32, alpha: f32) -> SpriteRecX {
        self.extra.scale1 = scale;
        self.extra.alpha1 = alpha;
        self
    }
}

/// Something `Sink::sprite` takes: a plain or an extended sprite record.
pub trait Sprite: Copy {
    fn parts(&self) -> (&SpriteRec, Option<&SpriteExtra>);
}

impl Sprite for SpriteRec {
    #[inline(always)]
    fn parts(&self) -> (&SpriteRec, Option<&SpriteExtra>) {
        (self, None)
    }
}

impl Sprite for SpriteRecX {
    #[inline(always)]
    fn parts(&self) -> (&SpriteRec, Option<&SpriteExtra>) {
        (&self.rec, Some(&self.extra))
    }
}

/// One rect of a frame: `[x, y, w, h, r, g, b, a]` at `reference + offset`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RectRec {
    pub from: [f32; 2],
    pub to: [f32; 2],
    pub margin: f32,
    pub offset: [f32; 2],
    pub size: [f32; 2],
    pub color: [f32; 4],
}

/// A reference point that moves during the tick (an actor's box centre).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Anchor {
    pub from: [f32; 2],
    pub to: [f32; 2],
}

impl Anchor {
    #[inline]
    pub fn fixed(x: f32, y: f32) -> Anchor {
        Anchor { from: [x, y], to: [x, y] }
    }

    #[inline]
    pub fn at(&self, t: f32) -> (f32, f32) {
        (lerp(self.from[0], self.to[0], t), lerp(self.from[1], self.to[1], t))
    }

    /// A rect at `(x, y)` given relative to this anchor's position.
    #[inline]
    pub fn rect(&self, margin: f32, dx: f32, dy: f32, w: f32, h: f32, color: [f32; 4]) -> RectRec {
        RectRec { from: self.from, to: self.to, margin, offset: [dx, dy], size: [w, h], color }
    }
}

/// Evaluate a sprite record (and its extra part) at `t` (alpha). None when culled.
#[inline(always)]
pub fn eval_sprite(r: &SpriteRec, extra: Option<&SpriteExtra>, t: f32, view: &View) -> Option<[f32; 8]> {
    let (mut x, mut y) = match r.at {
        // Interpolated and culled by Sink::group already (the same operations).
        Some([x, y]) => (x, y),
        None => {
            let (x, y) = (lerp(r.from[0], r.to[0], t), lerp(r.from[1], r.to[1], t));
            if r.margin >= 0.0 && !view.contains(x, y, r.margin) {
                return None;
            }
            (x, y)
        }
    };
    let mut angle = radians(r.angle, r.turn, t);
    let (mut scale, mut alpha) = (r.scale, r.alpha);
    if let Some(e) = extra {
        x += lerp(e.offset0[0], e.offset1[0], t);
        y += lerp(e.offset0[1], e.offset1[1], t);
        if e.arm != [0.0, 0.0] {
            let (s, c) = radians(e.body, e.body_turn, t).sin_cos();
            // Forward is (sin, -cos) of the body angle, right is (cos, sin).
            x = x + s * e.arm[0] + c * e.arm[1];
            y = y - c * e.arm[0] + s * e.arm[1];
        }
        angle = angle * e.angle_mul + e.angle_add;
        scale = lerp(scale, e.scale1, t);
        alpha = lerp(alpha, e.alpha1, t);
    }
    Some([x, y, angle, r.sprite, r.team, scale, alpha, r.flash])
}

/// Evaluate a rect record at `t`. None when culled.
#[inline(always)]
pub fn eval_rect(r: &RectRec, t: f32, view: &View) -> Option<[f32; 8]> {
    let x = lerp(r.from[0], r.to[0], t);
    let y = lerp(r.from[1], r.to[1], t);
    if r.margin >= 0.0 && !view.contains(x, y, r.margin) {
        return None;
    }
    Some([x + r.offset[0], y + r.offset[1], r.size[0], r.size[1], r.color[0], r.color[1], r.color[2], r.color[3]])
}

/// Decode flat sprite record `i` and its extra part, if any.
pub fn sprite_rec_at(recs: &[f32], extras: &[f32], i: usize) -> (SpriteRec, Option<SpriteExtra>) {
    let r = &recs[i * SPRITE_REC_FLOATS..(i + 1) * SPRITE_REC_FLOATS];
    let extra = (r[12] >= 0.0).then(|| {
        let k = r[12] as usize * SPRITE_EXTRA_FLOATS;
        let e = &extras[k..k + SPRITE_EXTRA_FLOATS];
        SpriteExtra {
            offset0: [e[0], e[1]],
            offset1: [e[2], e[3]],
            arm: [e[4], e[5]],
            body: e[6],
            body_turn: e[7],
            angle_mul: e[8],
            angle_add: e[9],
            scale1: e[10],
            alpha1: e[11],
        }
    });
    let rec = SpriteRec {
        from: [r[0], r[1]],
        to: [r[2], r[3]],
        margin: r[4],
        angle: r[5],
        turn: r[6],
        sprite: r[7],
        team: r[8],
        scale: r[9],
        alpha: r[10],
        flash: r[11],
        at: None,
    };
    (rec, extra)
}

/// Decode flat rect record `i`.
pub fn rect_rec_at(recs: &[f32], i: usize) -> RectRec {
    let r = &recs[i * RECT_REC_FLOATS..(i + 1) * RECT_REC_FLOATS];
    RectRec {
        from: [r[0], r[1]],
        to: [r[2], r[3]],
        margin: r[4],
        offset: [r[5], r[6]],
        size: [r[7], r[8]],
        color: [r[9], r[10], r[11], r[12]],
    }
}

/// What the GPU pass does with flat records, on the CPU: every record
/// evaluated at `t`, the culled ones left out, order kept (tests, benchmarks).
pub fn eval_records(
    sprite_recs: &[f32],
    extras: &[f32],
    rect_recs: &[f32],
    t: f32,
    view: &View,
    sprites: &mut Vec<f32>,
    rects: &mut Vec<f32>,
) {
    sprites.clear();
    rects.clear();
    for i in 0..sprite_recs.len() / SPRITE_REC_FLOATS {
        let (rec, extra) = sprite_rec_at(sprite_recs, extras, i);
        if let Some(s) = eval_sprite(&rec, extra.as_ref(), t, view) {
            sprites.extend_from_slice(&s);
        }
    }
    for i in 0..rect_recs.len() / RECT_REC_FLOATS {
        if let Some(r) = eval_rect(&rect_rec_at(rect_recs, i), t, view) {
            rects.extend_from_slice(&r);
        }
    }
}

enum Mode<'a> {
    Eval { t: f32, view: &'a View },
    Record,
}

/// Where the render code puts sprites and rects. Layers (`Vec<f32>`) hold
/// evaluated instances (8 floats) in `Eval` mode and records in `Record`
/// mode; extras are shared by every layer, so layers can be appended to one
/// another as they are.
pub struct Sink<'a> {
    mode: Mode<'a>,
    pub extras: Vec<f32>,
}

impl<'a> Sink<'a> {
    /// The CPU path: evaluate at `alpha`, cull against `view`.
    pub fn eval(alpha: f32, view: &'a View) -> Sink<'a> {
        Sink { mode: Mode::Eval { t: alpha, view }, extras: Vec::new() }
    }

    /// The GPU path: keep records (no alpha, no view), extras into `extras`.
    pub fn record(mut extras: Vec<f32>) -> Sink<'static> {
        extras.clear();
        Sink { mode: Mode::Record, extras }
    }

    /// Whether a group culled at a point moving `from` → `to` with `margin`
    /// can be visible: lets loops skip work early. Every record still
    /// carries its own cull, so this only saves time.
    #[inline(always)]
    pub fn visible(&self, from: [f32; 2], to: [f32; 2], margin: f32) -> bool {
        match self.mode {
            Mode::Eval { t, view } => view.contains(lerp(from[0], to[0], t), lerp(from[1], to[1], t), margin),
            Mode::Record => true,
        }
    }

    /// The base record of a group of sprites that share one reference point
    /// and cull (an actor's body, turret, shadow...), or None when the
    /// group is culled at this frame's alpha. In `Eval` mode it carries the
    /// interpolated point, so its sprites skip interpolating and culling it
    /// again; records keep `from`, `to` and `margin` for the GPU.
    #[inline(always)]
    pub fn group(&self, from: [f32; 2], to: [f32; 2], margin: f32) -> Option<SpriteRec> {
        let mut r = SpriteRec::moving(from, to, margin);
        if let Mode::Eval { t, view } = self.mode {
            let (x, y) = (lerp(from[0], to[0], t), lerp(from[1], to[1], t));
            if margin >= 0.0 && !view.contains(x, y, margin) {
                return None;
            }
            r.at = Some([x, y]);
        }
        Some(r)
    }

    #[inline(always)]
    pub fn sprite(&mut self, layer: &mut Vec<f32>, sprite: impl Sprite) {
        let (r, extra) = sprite.parts();
        match self.mode {
            Mode::Eval { t, view } => {
                if let Some(s) = eval_sprite(r, extra, t, view) {
                    layer.extend_from_slice(&s);
                }
            }
            Mode::Record => {
                let extra = match extra {
                    Some(e) => {
                        let k = (self.extras.len() / SPRITE_EXTRA_FLOATS) as f32;
                        self.extras.extend_from_slice(&[
                            e.offset0[0],
                            e.offset0[1],
                            e.offset1[0],
                            e.offset1[1],
                            e.arm[0],
                            e.arm[1],
                            e.body,
                            e.body_turn,
                            e.angle_mul,
                            e.angle_add,
                            e.scale1,
                            e.alpha1,
                        ]);
                        k
                    }
                    None => -1.0,
                };
                layer.extend_from_slice(&[
                    r.from[0], r.from[1], r.to[0], r.to[1], r.margin, r.angle, r.turn, r.sprite, r.team, r.scale, r.alpha, r.flash, extra,
                ]);
            }
        }
    }

    #[inline]
    pub fn rect(&mut self, layer: &mut Vec<f32>, r: RectRec) {
        match self.mode {
            Mode::Eval { t, view } => {
                if let Some(q) = eval_rect(&r, t, view) {
                    layer.extend_from_slice(&q);
                }
            }
            Mode::Record => layer.extend_from_slice(&[
                r.from[0],
                r.from[1],
                r.to[0],
                r.to[1],
                r.margin,
                r.offset[0],
                r.offset[1],
                r.size[0],
                r.size[1],
                r.color[0],
                r.color[1],
                r.color[2],
                r.color[3],
            ]),
        }
    }
}
