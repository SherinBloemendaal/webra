//! Integer math for the simulation.
//!
//! World units follow OpenRA: one cell is 1024 units, a full turn is 1024
//! angle units. Facing 0 points north (screen up) and grows clockwise, so
//! 256 is east, 512 south and 768 west.

use crate::trig_table::SIN_Q;

pub const CELL: i32 = 1024;
pub const HALF_CELL: i32 = 512;
pub const FULL_TURN: i32 = 1024;

#[inline]
pub fn isqrt(v: i64) -> i64 {
    if v <= 0 {
        return 0;
    }
    // f64 sqrt is correctly rounded by IEEE 754, so this is deterministic;
    // the loops only fix the final integer rounding.
    let mut x = (v as f64).sqrt() as i64;
    while x * x > v {
        x -= 1;
    }
    while (x + 1) * (x + 1) <= v {
        x += 1;
    }
    x
}

#[inline]
pub fn dist(ax: i32, ay: i32, bx: i32, by: i32) -> i32 {
    let dx = (bx - ax) as i64;
    let dy = (by - ay) as i64;
    isqrt(dx * dx + dy * dy) as i32
}

#[inline]
pub fn dist_sq(ax: i32, ay: i32, bx: i32, by: i32) -> i64 {
    let dx = (bx - ax) as i64;
    let dy = (by - ay) as i64;
    dx * dx + dy * dy
}

#[inline]
pub fn wrap_angle(a: i32) -> i32 {
    a.rem_euclid(FULL_TURN)
}

/// sin(a) * 1024
pub fn sin(a: i32) -> i32 {
    let a = wrap_angle(a);
    match a {
        0..=256 => SIN_Q[a as usize],
        257..=512 => SIN_Q[(512 - a) as usize],
        513..=768 => -SIN_Q[(a - 512) as usize],
        _ => -SIN_Q[(1024 - a) as usize],
    }
}

/// cos(a) * 1024
pub fn cos(a: i32) -> i32 {
    sin(a + 256)
}

/// Unit vector (scaled by 1024) for a facing.
#[inline]
pub fn facing_vec(f: i32) -> (i32, i32) {
    (sin(f), -cos(f))
}

/// Facing that points along (dx, dy). Returns `None` for a zero vector.
pub fn facing_of(dx: i32, dy: i32) -> Option<i32> {
    if dx == 0 && dy == 0 {
        return None;
    }
    let ax = (dx as i64).abs();
    let ay = (dy as i64).abs();
    // Angle t in 0..=256 measured from the vertical axis: tan(t) = ax / ay.
    // Largest t with sin(t) * ay <= cos(t) * ax.
    let (mut lo, mut hi) = (0usize, 256usize);
    while lo < hi {
        let mid = (lo + hi + 1) / 2;
        if SIN_Q[mid] as i64 * ay <= SIN_Q[256 - mid] as i64 * ax {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    let t = lo as i32;
    let f = match (dx >= 0, dy < 0) {
        (true, true) => t,          // north-east
        (true, false) => 512 - t,   // south-east
        (false, false) => 512 + t,  // south-west
        (false, true) => 1024 - t,  // north-west
    };
    Some(wrap_angle(f))
}

/// Signed shortest difference `to - from` in -511..=512.
#[inline]
pub fn angle_diff(from: i32, to: i32) -> i32 {
    let d = wrap_angle(to - from);
    if d > 512 {
        d - 1024
    } else {
        d
    }
}

/// Turn `from` toward `to` by at most `step`.
pub fn turn_toward(from: i32, to: i32, step: i32) -> i32 {
    let d = angle_diff(from, to);
    if d.abs() <= step {
        wrap_angle(to)
    } else {
        wrap_angle(from + step * d.signum())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn facing_roundtrip() {
        for f in (0..1024).step_by(7) {
            let (x, y) = facing_vec(f);
            let back = facing_of(x, y).unwrap();
            assert!(angle_diff(f, back).abs() <= 1, "f={f} back={back}");
        }
        assert_eq!(facing_of(0, -10), Some(0));
        assert_eq!(facing_of(10, 0), Some(256));
        assert_eq!(facing_of(0, 10), Some(512));
        assert_eq!(facing_of(-10, 0), Some(768));
    }

    #[test]
    fn isqrt_exact() {
        for v in [0i64, 1, 2, 3, 4, 15, 16, 17, 1 << 40, (1 << 40) + 1] {
            let r = isqrt(v);
            assert!(r * r <= v && (r + 1) * (r + 1) > v);
        }
    }
}
