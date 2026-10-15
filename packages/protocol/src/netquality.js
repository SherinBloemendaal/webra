// Connection quality (docs/contracts.md section 4, "Network quality"): the
// arithmetic the lobby, the game and the statistics share, so they all judge
// a connection the same way. Round trips are measured by each client with
// its own clock (`ping` / `pong`); nothing here needs synchronized clocks.

import {
  NET_GOOD_JITTER_MS,
  NET_GOOD_RTT_MS,
  NET_POOR_LATE_PCT,
  NET_POOR_RTT_MS,
} from './constants.js';

/** The median of a list of numbers (the lower middle one for an even count), or null for none. */
export function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[(sorted.length - 1) >> 1];
}

/** Jitter: the mean absolute difference between consecutive round trips, rounded (0 for fewer than two). */
export function jitterOf(samples) {
  if (samples.length < 2) return 0;
  let sum = 0;
  for (let i = 1; i < samples.length; i++) sum += Math.abs(samples[i] - samples[i - 1]);
  return Math.round(sum / (samples.length - 1));
}

/** Late pings as a percentage of `total`, rounded to one decimal (0 when nothing was sent). */
export function latePercent(late, total) {
  if (!total) return 0;
  return Math.round((late * 1000) / total) / 10;
}

/**
 * `good`, `fair` or `poor` for a measurement `{ rtt, jitter, late }` (rtt
 * and jitter in milliseconds, late in percent), or null while there is no
 * round trip yet. Poor: rtt above NET_POOR_RTT_MS or more than
 * NET_POOR_LATE_PCT percent late. Good: rtt below NET_GOOD_RTT_MS, jitter up
 * to NET_GOOD_JITTER_MS and no late pings. Everything else is fair.
 */
export function netQuality({ rtt, jitter = 0, late = 0 } = {}) {
  if (rtt === null || rtt === undefined) return null;
  const j = jitter ?? 0;
  const l = late ?? 0;
  if (rtt > NET_POOR_RTT_MS || l > NET_POOR_LATE_PCT) return 'poor';
  if (rtt < NET_GOOD_RTT_MS && j <= NET_GOOD_JITTER_MS && l === 0) return 'good';
  return 'fair';
}

/** Signal bars (0 to 4) for a quality: 4 good, 3 fair, 1 poor, 0 unknown. */
export function netBars(quality) {
  return { good: 4, fair: 3, poor: 1 }[quality] ?? 0;
}
