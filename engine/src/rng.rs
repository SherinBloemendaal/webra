//! Small deterministic PRNG (SplitMix64). Same seed, same sequence on every platform.

#[derive(Clone, Debug)]
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Rng(seed ^ 0x9E37_79B9_7F4A_7C15)
    }

    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// Uniform integer in `lo..hi` (hi exclusive). Returns `lo` for an empty range.
    /// The span is computed in i64, so ranges wider than `i32::MAX` (script
    /// input such as `Utils.RandomInteger`) stay in range; for every span that
    /// fits an i32 the result is the one the i32 formula gave.
    pub fn range(&mut self, lo: i32, hi: i32) -> i32 {
        if hi <= lo {
            return lo;
        }
        let span = (hi as i64 - lo as i64) as u64;
        (lo as i64 + (self.next_u64() % span) as i64) as i32
    }

    /// True with probability `percent` / 100.
    pub fn chance(&mut self, percent: i32) -> bool {
        self.range(0, 100) < percent
    }
}

#[cfg(test)]
mod tests {
    use super::Rng;

    #[test]
    fn range_stays_inside_spans_wider_than_i32() {
        let mut r = Rng::new(1);
        for (lo, hi) in [(i32::MIN, i32::MAX), (-2_000_000_000, 2_000_000_000), (i32::MIN, 1), (-1, i32::MAX)] {
            for _ in 0..1000 {
                let v = r.range(lo, hi);
                assert!((lo..hi).contains(&v), "{v} outside {lo}..{hi}");
            }
        }
    }

    #[test]
    fn range_keeps_the_stream_of_spans_that_fit_i32() {
        // Every game's random stream depends on these values.
        let mut r = Rng::new(7);
        assert_eq!([r.range(-50, 950), r.range(-50, 950), r.range(-50, 950)], [679, 459, 944]);
        // The i32 formula range used before, on the same draws.
        let (mut a, mut b, mut picks) = (Rng::new(3), Rng::new(3), Rng::new(11));
        for _ in 0..10_000 {
            let lo = picks.next_u64() as i32;
            let span = (picks.next_u64() % i32::MAX as u64) as i32 + 1;
            let Some(hi) = lo.checked_add(span) else { continue };
            assert_eq!(a.range(lo, hi), lo + (b.next_u64() % (hi - lo) as u64) as i32, "{lo}..{hi}");
        }
        assert_eq!(a.range(5, 5), 5, "an empty range is lo");
    }
}
