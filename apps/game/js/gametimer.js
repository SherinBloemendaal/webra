// OpenRA GameTimerLogic for the game clock of the sidebar (js/sidebar.js)
// and the replay bar's time (js/records.js), without a DOM:
//
// - while the game is paused, or a replay runs at another speed, a status
//   blinks: shown every other second from the clock's creation
//   (ShouldShowStatus);
// - the status: "Paused" (also a paused replay), "Max Speed" at the
//   highest replay speed, else "N% Speed";
// - RA's player clock has no status label, so "Paused" takes the time's
//   place there while it blinks;
// - a replay's timer tooltip: "N% complete".

/** OpenRA label-paused, label-max-speed, label-replay-speed, label-replay-complete. */
export const PAUSED_TEXT = 'Paused';
export const MAX_SPEED_TEXT = 'Max Speed';

/** ShouldShowStatus's blink: on in the even seconds since `startMs`. */
export function blinkOn(nowMs, startMs) {
  return Math.floor(Math.max(0, nowMs - startMs) / 1000) % 2 === 0;
}

/**
 * The status of a replay at `speed` (a factor, js/replay.js REPLAY_SPEEDS;
 * `maxSpeed` the highest), or null at normal speed while it plays.
 */
export function replayStatus({ playing, speed, maxSpeed }) {
  if (!playing) return PAUSED_TEXT;
  if (speed === 1) return null;
  if (speed >= maxSpeed) return MAX_SPEED_TEXT;
  return `${Math.round(speed * 100)}% Speed`;
}

/** The player clock's text: "Paused" in the blink's on phase while paused, else the time. */
export function clockText(timeText, paused, on) {
  return paused && on ? PAUSED_TEXT : timeText;
}

/** The replay timer's tooltip (label-replay-complete), from the ticks played and the replay's length. */
export function completeText(ticks, length) {
  if (!(length > 0)) return null;
  return `${Math.floor((Math.max(0, Math.min(ticks, length)) * 100) / length)}% complete`;
}
