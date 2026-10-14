// What a hidden page does to the game (js/main.js): a single-player game
// either plays on, ticked by the simulation's own timer since hidden pages
// get no animation frames (js/sim/core.js setBackground), or, with Settings >
// "Pause when the game is hidden" on, opens the game menu and so pauses.
// Online games never pause (the lockstep driver keeps up from network
// events), replays and the stress test stand still while hidden. Losing the
// window's focus alone (another app, another monitor) changes nothing here.

/** Whether the game is played on this device alone: skirmish, a mission or a loaded save. */
const local = ({ stress = false, online = false, replay = false }) => !stress && !online && !replay;

/** The page became hidden: open the game menu (and so pause)? Only a local game with the setting on. */
export function pausesWhenHidden(game, pauseWhenHidden) {
  return local(game) && !!pauseWhenHidden;
}

/** Whether a local game should tick on the background timer: hidden, and not paused (the menu, Pause, the debug menu, end dialogs). */
export function runsInBackground(game, { hidden = false, paused = false } = {}) {
  return local(game) && !!hidden && !paused;
}
