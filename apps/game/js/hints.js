// One-time gameplay tips. For now one: after a clicked attack target dies,
// units go idle and only take on enemies that come into weapon range (OpenRA
// AutoTarget), and a plain move walks past enemies without a shot from
// infantry and artillery. Attack-move is the order for that, so the first
// time the player sends armed units on a plain move past or toward visible
// enemies, the battlefield shows:
//
//   Tip: A + click attack-moves (units engage enemies on the way)
//
// with the key the player bound to attack-move. It shows once per player:
// the settings registry remembers it (game.attackMoveTipSeen, synced with the
// account like every setting), and the close button or a timeout hides it.
// The engine decides when a move qualifies (World::move_hint).
//
// AttackMoveTip holds the decision without a DOM (tests/hints.test.mjs);
// TipView draws a tip.

/** Registry setting that remembers the tip was shown. */
export const ATTACK_MOVE_TIP_SETTING = Object.freeze(['game', 'attackMoveTipSeen']);
/** Seconds a tip stays up unless closed first. */
export const TIP_SECONDS = 15;

/** The tip text for the key bound to attack-move ("A" by default). */
export function attackMoveTipText(key = 'A') {
  return `Tip: ${key} + click attack-moves (units engage enemies on the way)`;
}

export class AttackMoveTip {
  /**
   * @param {{
   *   registry: { get(group: string, key: string): any, set(group: string, key: string, value: any): any },
   *   ask: { move_hint(player: number, ids: Uint32Array, x: number, y: number): Promise<boolean> },
   *   player: number,
   *   keyLabel?: () => string | null,
   *   show(text: string): void,
   * }} o
   */
  constructor({ registry, ask, player, keyLabel = () => 'A', show }) {
    this.registry = registry;
    this.ask = ask;
    this.player = player;
    this.keyLabel = keyLabel;
    this.show = show;
    /** A question is on its way (moves meanwhile do not ask again). */
    this.pending = false;
  }

  get seen() {
    return this.registry.get(...ATTACK_MOVE_TIP_SETTING) === true;
  }

  /**
   * The player gave `units` a plain move to world point `at`. Shows the tip
   * when it was never shown and the engine says the move passes enemies the
   * armed units would ignore. Resolves to whether it showed.
   */
  async plainMove(units, at) {
    if (this.seen || this.pending || !units.length) return false;
    this.pending = true;
    try {
      const hint = await this.ask.move_hint(this.player, Uint32Array.from(units), at.x, at.y);
      if (!hint || this.seen) return false;
      this.registry.set(...ATTACK_MOVE_TIP_SETTING, true);
      this.show(attackMoveTipText(this.keyLabel() || 'A'));
      return true;
    } finally {
      this.pending = false;
    }
  }
}

/**
 * A tip box over the battlefield with a close button. Built with
 * createElement and textContent only (the CSP forbids HTML strings and
 * inline styles); css/theme.css styles #tip.
 */
export class TipView {
  /**
   * @param {HTMLElement} parent the battlefield (#field)
   * @param {{ seconds?: number, setTimer?: typeof setTimeout, clearTimer?: typeof clearTimeout }} [o]
   */
  constructor(parent, { seconds = TIP_SECONDS, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    this.parent = parent;
    this.seconds = seconds;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.root = null;
    this.timer = null;
  }

  get open() {
    return this.root !== null;
  }

  show(text) {
    this.close();
    const root = document.createElement('div');
    root.id = 'tip';
    root.className = 'ui-plate';
    root.setAttribute('role', 'status');
    const label = document.createElement('span');
    label.className = 'tip-text';
    label.textContent = text;
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'tip-close';
    close.textContent = 'Got it';
    close.setAttribute('aria-label', 'Dismiss the tip');
    close.addEventListener('click', () => this.close());
    root.append(label, close);
    this.parent.append(root);
    this.root = root;
    this.timer = this.setTimer(() => this.close(), this.seconds * 1000);
  }

  close() {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    this.root?.remove();
    this.root = null;
  }
}
