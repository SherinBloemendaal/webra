// OpenRA's MUTE_INDICATOR (ingame-player.yaml and ingame-observer.yaml,
// MuteIndicatorLogic): "Audio Muted" with the muted speaker at the top of the
// battlefield for as long as all sound is off (ToggleMute, or All sound off in
// the audio settings), in games, missions, replays and as a spectator.

import { icon } from './ui-icons.js';

/** OpenRA label-mute-indicator. */
export const MUTE_TEXT = 'Audio Muted';

export class MuteIndicator {
  /**
   * @param {HTMLElement} parent where it shows (the HUD button row)
   * @param {{ muted: () => boolean, subscribe: (fn: () => void) => () => void }} source the sound settings
   */
  constructor(parent, { muted, subscribe }) {
    this.muted = muted;
    this.root = document.createElement('div');
    this.root.className = 'mute-indicator';
    this.root.setAttribute('role', 'status');
    const label = document.createElement('span');
    label.textContent = MUTE_TEXT;
    this.root.append(label, icon('mute'));
    parent.prepend(this.root);
    this.off = subscribe(() => this.update());
    this.update();
  }

  update() {
    const hidden = !this.muted();
    if (this.root.hidden !== hidden) this.root.hidden = hidden;
  }

  dispose() {
    this.off?.();
    this.root.remove();
  }
}
