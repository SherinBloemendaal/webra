// What happens when a game is decided for the local player: the defeat
// dialog (Mission failed), the victory dialog (Mission accomplished) and the
// final result once the whole game ends while the player watches on.
//
// - Single player and skirmish pause while a dialog is open. Online games
//   cannot pause (docs/contracts.md section 4), so there the dialog says so
//   and the game goes on behind it.
// - "Continue as spectator" closes the dialog and switches the screen to the
//   whole-map observer view with the player switcher and the observer panel;
//   the defeated player gives no more orders (the engine refuses them, online
//   the server drops them too) and the AIs play on until the game ends.
// - Spectators and the replay viewer only get the final result.
//
// EndGameFlow is the state machine (no DOM); EndGameDialog draws it.

/** Dialog kinds. */
export const DIALOGS = Object.freeze({ DEFEAT: 'defeat', VICTORY: 'victory', FINAL: 'final' });

export class EndGameFlow {
  /**
   * @param {{
   *   online?: boolean,  online lockstep: never pauses
   *   viewer?: boolean,  a spectator or the replay viewer: only the final result
   *   replay?: boolean,  the replay viewer: never pauses
   *   onChange?(flow: EndGameFlow): void,  after every change of the dialog, pause or spectating
   * }} opts
   */
  constructor({ online = false, viewer = false, replay = false, onChange = () => {} } = {}) {
    this.online = online;
    this.viewer = viewer;
    this.replay = replay;
    this.onChange = onChange;
    /** 'playing' | 'lost' | 'won' */
    this.phase = 'playing';
    /** The open dialog (DIALOGS) or null. */
    this.dialog = null;
    /** The local player watches the rest of the game (after its defeat). */
    this.spectating = false;
    /** The whole game ended (a winner was decided). */
    this.over = false;
    /** The local player's side won (it may have been defeated itself: its ally won). */
    this.won = false;
    /** The replay reached its end. */
    this.ended = false;
    this.finalShown = false;
  }

  /** Back to the start (a replay restarted from 0). */
  reset() {
    this.phase = 'playing';
    this.spectating = false;
    this.over = false;
    this.won = false;
    this.ended = false;
    this.finalShown = false;
    this.dialog = null;
    this.onChange(this);
  }

  /** Whether the simulation must stand still: a dialog is open in a local game. */
  get paused() {
    return this.dialog !== null && !this.online && !this.replay;
  }

  /** Whether the screen is the observer's (no sidebar, no orders). */
  get watching() {
    return this.viewer || this.spectating;
  }

  /**
   * The local player's state (`player_json`: defeated, won, winner); for the
   * replay viewer also whether the replay reached its end.
   * Returns the event that happened: 'defeat', 'victory', 'over' or null.
   */
  update(state, { ended = false } = {}) {
    if (!state) return null;
    // A winner, or the end without one (`gameOver`: the time limit can end a game where everyone lost).
    const over = (state.winner !== null && state.winner !== undefined) || !!state.gameOver;
    this.over = this.over || over;
    this.won = !!state.won;
    this.ended = this.ended || ended;
    if (this.viewer) {
      if ((over || this.ended) && !this.finalShown) {
        this.finalShown = true;
        this.open(DIALOGS.FINAL);
        return 'over';
      }
      return null;
    }
    if (this.phase === 'playing') {
      if (state.won) {
        this.phase = 'won';
        this.finalShown = true;
        this.open(DIALOGS.VICTORY);
        return 'victory';
      }
      if (state.defeated) {
        this.phase = 'lost';
        // Defeated on the tick the game ended (a 1 against 1): this is the final result.
        this.finalShown = over;
        this.open(DIALOGS.DEFEAT);
        return 'defeat';
      }
      return null;
    }
    if (this.phase === 'lost' && over && !this.finalShown) {
      this.finalShown = true;
      this.open(DIALOGS.FINAL);
      return 'over';
    }
    return null;
  }

  open(kind) {
    this.dialog = kind;
    this.onChange(this);
  }

  /** Close the dialog (the game goes on behind; nothing else changes). */
  close() {
    if (this.dialog === null) return;
    this.dialog = null;
    this.onChange(this);
  }

  /** Defeated: watch the rest of the game as a spectator. */
  spectate() {
    if (this.viewer || this.phase !== 'lost') return false;
    this.spectating = true;
    this.dialog = null;
    this.onChange(this);
    return true;
  }
}

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function button(text, className, onClick) {
  const b = el('button', className, text);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

/**
 * Title, text and buttons of a dialog. Pure, so the choices can be tested:
 * `[{ id, label, primary? }]` in display order.
 *
 * @param {EndGameFlow} flow
 * @param {{ winnerText?: string, canRestart?: boolean, restartLabel?: string, canDownload?: boolean,
 *   mission?: { next: string | null } | null }} ctx
 *   `restartLabel`: the restart button's text (online: the rematch, js/online.js);
 *   `mission`: a campaign mission (not its replay), with the title of the
 *   mission to play next once this one is won (js/campaign/progress.js)
 */
export function dialogContent(flow, { winnerText = '', canRestart = false, restartLabel = null, canDownload = false, mission = null } = {}) {
  const paused = flow.paused ? 'The game is paused.' : flow.online && !flow.viewer ? 'Online games cannot be paused: the game goes on while this is open.' : '';
  const result = winnerText ? `${winnerText}.` : '';
  const tail = (list) => [
    ...list,
    { id: 'stats', label: 'View statistics' },
    ...(canRestart ? [{ id: 'restart', label: restartLabel ?? (flow.replay ? 'Restart replay' : 'Play again') }] : []),
    ...(canDownload ? [{ id: 'download', label: 'Download replay' }] : []),
    { id: 'leave', label: flow.online && !flow.viewer ? 'Leave game' : 'Return to lobby' },
    { id: 'exit', label: 'Exit' },
  ];
  const join = (...parts) => parts.filter(Boolean).join(' ');
  if (mission) return missionContent(flow, { canRestart, restartLabel, canDownload, next: mission.next, paused, join });
  switch (flow.dialog) {
    case DIALOGS.DEFEAT:
      return {
        title: 'Mission failed',
        text: flow.over
          ? join('You were defeated.', result, paused)
          : join('You were defeated. Watch the rest of the game as a spectator, or leave.', paused),
        buttons: tail([{ id: 'spectate', label: flow.over ? 'Keep watching' : 'Continue as spectator', primary: true }]),
      };
    case DIALOGS.VICTORY:
      return {
        title: 'Mission accomplished',
        text: join('Your side won.', paused),
        buttons: tail([{ id: 'continue', label: 'Continue playing', primary: true }]),
      };
    case DIALOGS.FINAL:
      return {
        title: flow.viewer ? (flow.over || !flow.replay ? 'Game over' : 'Replay ended') : flow.won ? 'Mission accomplished' : 'Game over',
        text: join(
          flow.viewer ? '' : flow.won ? 'Your team won the game.' : '',
          result || (flow.replay && !flow.over ? 'The replay ended.' : 'The game is over.'),
          paused,
        ),
        buttons: [{ id: 'stats', label: 'View statistics', primary: true }, { id: 'continue', label: 'Keep watching' }, ...tail([]).slice(1)],
      };
    default:
      return null;
  }
}

/**
 * A campaign mission's dialogs: the next mission or the campaign screen after
 * a win, another try after a defeat. "Back to the campaign" is the leave action.
 */
function missionContent(flow, { canRestart, restartLabel, canDownload, next, paused, join }) {
  const rest = [
    { id: 'stats', label: 'View statistics' },
    ...(canDownload ? [{ id: 'download', label: 'Download replay' }] : []),
    { id: 'leave', label: 'Back to the campaign' },
    { id: 'exit', label: 'Exit' },
  ];
  const restart = canRestart ? [{ id: 'restart', label: restartLabel ?? 'Restart mission' }] : [];
  switch (flow.dialog) {
    case DIALOGS.DEFEAT:
      return {
        title: 'Mission failed',
        text: join('The mission failed.', paused),
        buttons: [...restart.map((b) => ({ ...b, primary: true })), { id: 'spectate', label: 'Keep watching', primary: !restart.length }, ...rest],
      };
    case DIALOGS.VICTORY:
    case DIALOGS.FINAL:
      if (!flow.won) {
        return { title: 'Mission failed', text: join('The mission is over.', paused), buttons: [...restart.map((b) => ({ ...b, primary: true })), { id: 'continue', label: 'Keep watching' }, ...rest] };
      }
      return {
        title: 'Mission accomplished',
        text: join(next ? `Next: ${next}.` : 'Every objective is done.', paused),
        buttons: [
          ...(next ? [{ id: 'next', label: 'Next mission', primary: true }] : []),
          { id: 'continue', label: 'Keep playing', primary: !next },
          ...restart.map((b) => ({ ...b, label: 'Play again' })),
          ...rest,
        ],
      };
    default:
      return null;
  }
}

/**
 * The dialog in its overlay section. Keys: game hotkeys stay quiet while it
 * is open; Esc does nothing (pick a button). `actions[id]()` runs a button.
 */
export class EndGameDialog {
  /**
   * @param {HTMLElement} root the overlay section (#gameover)
   * @param {{ flow: EndGameFlow, actions: Record<string, () => void>, context(): object, blocked?(): boolean }} opts
   *   `context()` gives dialogContent's ctx; `blocked()` is true while another dialog (statistics) is above it
   */
  constructor(root, { flow, actions, context, blocked = () => false }) {
    this.root = root;
    this.flow = flow;
    this.actions = actions;
    this.context = context;
    this.blocked = blocked;
    this.card = el('div', 'menu-card endgame-card');
    this.card.setAttribute('role', 'alertdialog');
    this.card.setAttribute('aria-modal', 'true');
    this.card.setAttribute('aria-labelledby', 'endgame-title');
    this.card.setAttribute('aria-describedby', 'endgame-text');
    root.replaceChildren(this.card);
    root.hidden = true;
    window.addEventListener(
      'keydown',
      (e) => {
        if (this.root.hidden || this.blocked()) return;
        if (e.key === 'Escape') e.preventDefault();
        e.stopImmediatePropagation();
      },
      true,
    );
  }

  /** Show the flow's dialog, or hide when none is open. */
  render() {
    const content = dialogContent(this.flow, this.context());
    if (!content) {
      if (this.root.contains(document.activeElement)) document.activeElement.blur();
      this.root.hidden = true;
      return;
    }
    const title = el('h1', null, content.title);
    title.id = 'endgame-title';
    const text = el('p', 'tagline', content.text);
    text.id = 'endgame-text';
    this.card.dataset.kind = this.flow.dialog;
    this.card.replaceChildren(
      title,
      text,
      ...content.buttons.map((b) => {
        const btn = button(b.label, b.primary ? 'primary' : null, () => this.actions[b.id]?.());
        btn.dataset.action = b.id;
        return btn;
      }),
    );
    this.root.hidden = false;
    this.card.querySelector('button.primary')?.focus({ preventScroll: true });
  }
}
