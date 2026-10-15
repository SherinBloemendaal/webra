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
// - A won game is over: the victory dialog stays until the player leaves,
//   plays again or opens the next mission; there is no playing on after it.
//
// EndGameFlow is the state machine (no DOM); EndGameDialog draws it.
//
// The dialog is the canvas boards GameOver and Defeat (css/endgame.css): a
// victory flashes white, a ring goes out and rays turn behind the green
// title; a defeat flashes red, the screen shakes, scan lines run and the
// red title glitches now and then. Under the title the winner and the game
// time, the replay kept in the account, the results per team (kills,
// losses, assets destroyed, earned, experience) whose rows slide in while
// the numbers count up, the rematch proposal with a lamp per player
// (online), and the buttons. "Reduce motion" leaves every animation out and
// shows the numbers at once.

import { formatMoney } from './observer.js';
import { shapeReport, teamSections } from './stats.js';
import { factionText } from './loadingboard.js';

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

  /** Close the dialog (the game goes on behind; nothing else changes). A won game's dialog stays. */
  close() {
    if (this.dialog === null || this.phase === 'won') return;
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
        text: join('Your side won.', result),
        buttons: tail([]).map((b, i) => (i === 0 ? { ...b, primary: true } : b)),
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
        text: next ? `Next: ${next}.` : 'Every objective is done.',
        buttons: [
          ...(next ? [{ id: 'next', label: 'Next mission', primary: true }] : []),
          ...restart.map((b) => ({ ...b, label: 'Play again', primary: !next })),
          ...rest.map((b) => (!next && !restart.length && b.id === 'leave' ? { ...b, primary: true } : b)),
        ],
      };
    default:
      return null;
  }
}

/**
 * How the dialog looks: 'victory' (the player's side won), 'defeat' (it
 * lost, or the player is out) or 'neutral' (a spectator or the replay).
 */
export function endOutcome(flow) {
  if (flow.viewer) return 'neutral';
  if (flow.dialog === DIALOGS.VICTORY) return 'victory';
  if (flow.dialog === DIALOGS.DEFEAT) return 'defeat';
  return flow.won ? 'victory' : 'defeat';
}

/** The line under the title: the winner and the game time ("Alice and Bob win · 31:05"). */
export function kickerText(winnerText, duration) {
  return [winnerText, duration].filter(Boolean).join(' · ');
}

/** The numbers of the results table per player (count up from 0). */
export const RESULT_COLUMNS = Object.freeze([
  { id: 'kills', label: 'Kills', of: (s) => s.unitsKilled + s.buildingsKilled },
  { id: 'losses', label: 'Losses', of: (s) => s.unitsLost + s.buildingsLost },
  { id: 'destroyed', label: 'Destroyed', of: (s) => s.assetsDestroyed, money: true },
  { id: 'earned', label: 'Earned', of: (s) => s.earned, money: true },
  { id: 'experience', label: 'Experience', of: (s) => s.experience },
]);

/**
 * The results table from a report (stats.js shapeReport): team heads
 * ("Team 1 · Winner") and player rows with their numbers.
 * @returns {{ kind: 'team' | 'player', label?: string, won?: boolean, name?: string, sub?: string, css?: string, local?: boolean, values?: number[] }[]}
 */
export function resultRows(shaped) {
  const out = [];
  for (const section of teamSections(shaped)) {
    if (section.label) out.push({ kind: 'team', label: section.won ? `${section.label} · Winner` : section.label, won: section.won });
    for (const r of section.rows) {
      const sub = [r.s.isAi ? 'AI' : null, factionText(r.s.faction)].filter(Boolean).join(' · ');
      out.push({ kind: 'player', name: r.name, sub, css: r.css, local: r.local, won: !!r.s.won, values: RESULT_COLUMNS.map((c) => Math.max(0, Math.round(c.of(r.s) || 0))) });
    }
  }
  return out;
}

/**
 * The rematch line: "Kara proposed it · 2 of 3 accepted", with a lamp per
 * player who has a say (`status`: js/online.js rematch handle's status()).
 */
export function rematchLine(status) {
  if (!status || !status.voters?.length) return null;
  const yes = status.voters.filter((v) => v.accepted).length;
  return { text: `${status.by ? `${status.by} proposed it · ` : ''}${yes} of ${status.voters.length} accepted`, voters: status.voters };
}

/** The replay line: what happened to this game's replay in the account. */
export const REPLAY_TEXTS = Object.freeze({
  saving: ['info', 'Saving the replay to your account...'],
  saved: ['ok', 'Replay saved to your account'],
  failed: ['warn', 'The replay could not be saved to your account'],
});

/** Count-up: the eased share of the way after `t` of `ms` (ease out cubic, like the board). */
export function countShare(t, ms) {
  const x = Math.max(0, Math.min(1, ms > 0 ? t / ms : 1));
  return 1 - (1 - x) ** 3;
}

/** The count-up starts this long after the dialog opens, and takes this long. */
export const COUNT_DELAY_MS = 1200;
export const COUNT_MS = 1400;

/**
 * The dialog in its overlay section. Keys: game hotkeys stay quiet while it
 * is open; Esc does nothing (pick a button). `actions[id]()` runs a button.
 */
export class EndGameDialog {
  /**
   * @param {HTMLElement} root the overlay section (#gameover)
   * @param {{
   *   flow: EndGameFlow, actions: Record<string, () => void>, context(): object, blocked?(): boolean,
   *   report?: () => Promise<object | null>, players?: { name: string, color: number[] }[],
   *   localPlayer?: number | null, reducedMotion?: () => boolean,
   *   raf?: (fn: (t: number) => void) => number, cancelRaf?: (id: number) => void, now?: () => number,
   * }} o
   *   `context()` gives dialogContent's ctx and also `replay` (REPLAY_TEXTS key or null) and
   *   `rematch` (js/online.js rematch handle's status(), or null); `blocked()` is true while
   *   another dialog (statistics) is above it; `report()` the parsed `observer_report` for the
   *   results (none without it)
   */
  constructor(root, { flow, actions, context, blocked = () => false, report = null, players = [], localPlayer = null, reducedMotion = () => false, raf = null, cancelRaf = null, now = null }) {
    this.root = root;
    this.flow = flow;
    this.actions = actions;
    this.context = context;
    this.blocked = blocked;
    this.loadReport = report;
    this.players = players;
    this.localPlayer = localPlayer;
    this.reducedMotion = reducedMotion;
    this.raf = raf ?? ((fn) => globalThis.requestAnimationFrame?.(fn) ?? 0);
    this.cancelRaf = cancelRaf ?? ((id) => globalThis.cancelAnimationFrame?.(id));
    this.now = now ?? (() => globalThis.performance?.now() ?? Date.now());
    /** The dialog kind the frame was built for (a new kind builds it again and replays the entrance). */
    this.shown = null;
    this.counting = 0;
    this.duration = '';
    this.card = el('div', 'menu-card endgame-card');
    this.card.setAttribute('role', 'alertdialog');
    this.card.setAttribute('aria-modal', 'true');
    this.card.setAttribute('aria-labelledby', 'endgame-title');
    this.card.setAttribute('aria-describedby', 'endgame-text');
    root.replaceChildren(this.card);
    root.hidden = true;
    this.onKey = (e) => {
      if (this.root.hidden || this.blocked()) return;
      if (e.key === 'Escape') e.preventDefault();
      e.stopImmediatePropagation();
    };
    window.addEventListener('keydown', this.onKey, true);
  }

  /** The game is going (a restart in place): the key listener goes and the section is emptied for the next game's dialog. */
  dispose() {
    window.removeEventListener('keydown', this.onKey, true);
    this.stopCount();
    if (this.root.contains(document.activeElement)) document.activeElement.blur();
    this.root.hidden = true;
    this.root.replaceChildren();
    this.fx = null;
  }

  /** Show the flow's dialog, or hide when none is open. */
  render() {
    const ctx = this.context();
    const content = dialogContent(this.flow, ctx);
    if (!content) {
      if (this.root.contains(document.activeElement)) document.activeElement.blur();
      this.stopCount();
      this.shown = null;
      this.root.hidden = true;
      return;
    }
    const fresh = this.shown !== this.flow.dialog;
    if (fresh) this.build();
    const p = this.parts;
    p.title.textContent = content.title;
    p.glitch.textContent = content.title;
    p.text.textContent = content.text;
    p.kicker.textContent = kickerText(ctx.winnerText ?? '', this.duration);
    this.renderReplay(ctx.replay ?? null);
    this.renderRematch(ctx.rematch ?? null);
    const hadFocus = this.card.contains(document.activeElement) ? document.activeElement?.dataset?.action : null;
    p.buttons.replaceChildren(
      ...content.buttons.map((b) => {
        const btn = button(b.label, b.primary ? 'primary' : null, () => this.actions[b.id]?.());
        btn.dataset.action = b.id;
        return btn;
      }),
    );
    this.root.hidden = false;
    // The focus: the main action on a new dialog, else where it was.
    const again = hadFocus ? p.buttons.querySelector(`[data-action="${hadFocus}"]`) : null;
    (again ?? (fresh || !this.card.contains(document.activeElement) ? p.buttons.querySelector('button.primary') : null))?.focus({ preventScroll: true });
    if (fresh) this.fillResults();
  }

  /** The frame of a dialog: the effects, the title, the lines, the results and the buttons. */
  build() {
    this.stopCount();
    this.shown = this.flow.dialog;
    const outcome = endOutcome(this.flow);
    const still = !!this.reducedMotion();
    this.root.dataset.outcome = outcome;
    this.root.classList.toggle('is-still', still);
    this.card.dataset.kind = this.flow.dialog;
    this.card.dataset.outcome = outcome;
    // The effects behind (decoration only).
    const fx = el('div', 'endgame-fx');
    fx.setAttribute('aria-hidden', 'true');
    fx.append(el('span', 'endgame-rays'), el('span', 'endgame-scan'), el('span', 'endgame-ring'), el('span', 'endgame-flash'));
    const kicker = el('p', 'endgame-kicker');
    const heading = el('div', 'endgame-heading');
    const title = el('h1', 'endgame-title');
    title.id = 'endgame-title';
    // The defeat's glitch: a copy of the title that flickers over it now and then.
    const glitch = el('span', 'endgame-glitch');
    glitch.setAttribute('aria-hidden', 'true');
    heading.append(title, glitch);
    const text = el('p', 'tagline endgame-text');
    text.id = 'endgame-text';
    const replay = el('p', 'endgame-replay');
    replay.setAttribute('role', 'status');
    replay.hidden = true;
    const head = el('header', 'endgame-head');
    head.append(kicker, heading, text, replay);
    const results = el('section', 'endgame-results');
    results.setAttribute('aria-label', 'Results');
    results.hidden = true;
    const rematch = el('div', 'endgame-rematch');
    rematch.setAttribute('role', 'status');
    rematch.hidden = true;
    const buttons = el('div', 'endgame-buttons');
    const foot = el('div', 'endgame-foot');
    foot.append(rematch, buttons);
    const body = el('div', 'endgame-body');
    body.append(head, results, foot);
    // Behind the card, over the whole screen (the card contains its layout: its own size for the title).
    this.fx?.remove();
    this.fx = fx;
    this.root.prepend(fx);
    this.card.replaceChildren(body);
    this.parts = { kicker, title, glitch, text, replay, results, rematch, buttons };
  }

  renderReplay(state) {
    const line = this.parts.replay;
    const spec = state ? REPLAY_TEXTS[state] : null;
    line.hidden = !spec;
    if (!spec) return;
    const lamp = el('span', `ui-led ui-led-${spec[0]}`);
    lamp.setAttribute('aria-hidden', 'true');
    line.replaceChildren(lamp, spec[1]);
  }

  renderRematch(status) {
    const box = this.parts.rematch;
    const line = rematchLine(status);
    box.hidden = !line;
    if (!line) return;
    const lamps = el('span', 'endgame-rematch-lamps');
    for (const v of line.voters) {
      // A lamp per player: lit green when it accepted; its name and answer for screen readers and the tooltip.
      const lamp = el('span', `ui-led ui-led-${v.accepted ? 'ok' : 'off'}`);
      lamp.title = `${v.name}: ${v.accepted ? 'accepted' : 'waiting'}`;
      lamp.setAttribute('role', 'img');
      lamp.setAttribute('aria-label', lamp.title);
      lamps.append(lamp);
    }
    box.replaceChildren(el('span', 'endgame-rematch-title', 'Rematch'), el('span', 'endgame-rematch-text', line.text), lamps);
  }

  /** The results table: loaded once per dialog, rows in, numbers counting up. */
  async fillResults() {
    if (!this.loadReport) return;
    const kind = this.shown;
    let report = null;
    try {
      report = await this.loadReport();
    } catch (err) {
      console.warn('The results are unavailable:', err);
    }
    if (!report || this.shown !== kind || this.root.hidden) return;
    const shaped = shapeReport(report, { players: this.players, localPlayer: this.localPlayer });
    this.duration = shaped.duration;
    const ctx = this.context();
    this.parts.kicker.textContent = kickerText(ctx.winnerText ?? '', this.duration);
    const rows = resultRows(shaped);
    const table = el('table', 'endgame-table');
    table.append(el('caption', 'ui-sr-only', 'Results per player'));
    const head = el('tr');
    const corner = el('th', null, 'Player');
    corner.setAttribute('scope', 'col');
    head.append(corner);
    for (const c of RESULT_COLUMNS) {
      const th = el('th', 'num', c.label);
      th.setAttribute('scope', 'col');
      head.append(th);
    }
    const thead = el('thead');
    thead.append(head);
    const tbody = el('tbody');
    const cells = [];
    rows.forEach((r, i) => {
      const tr = el('tr', r.kind === 'team' ? `endgame-team${r.won ? ' is-won' : ''}` : `endgame-player${r.local ? ' is-you' : ''}`);
      tr.style.setProperty('--row-delay', `${(0.15 + i * 0.12).toFixed(2)}s`);
      if (r.kind === 'team') {
        const th = el('th', null, r.label);
        th.setAttribute('scope', 'colgroup');
        th.colSpan = RESULT_COLUMNS.length + 1;
        tr.append(th);
      } else {
        const who = el('th', 'endgame-who');
        who.setAttribute('scope', 'row');
        if (r.css) who.style.setProperty('--player-color', r.css);
        who.append(el('span', 'endgame-name', r.local ? `${r.name} (you)` : r.name), el('span', 'endgame-sub', r.sub));
        tr.append(who);
        RESULT_COLUMNS.forEach((c, k) => {
          const td = el('td', c.money ? 'num ui-money' : 'num');
          cells.push({ td, value: r.values[k], money: !!c.money });
          tr.append(td);
        });
      }
      tbody.append(tr);
    });
    table.append(thead, tbody);
    this.parts.results.replaceChildren(table);
    this.parts.results.hidden = false;
    this.countUp(cells, table);
  }

  /** The numbers count up from 0 (at once with "Reduce motion"); the table is busy meanwhile. */
  countUp(cells, table) {
    const show = (share) => {
      for (const c of cells) {
        const v = Math.round(c.value * share);
        c.td.textContent = c.money ? formatMoney(v) : v.toLocaleString('en-US');
      }
    };
    if (this.reducedMotion()) {
      show(1);
      return;
    }
    show(0);
    table.setAttribute('aria-busy', 'true');
    const start = this.now() + COUNT_DELAY_MS;
    const step = () => {
      const share = countShare(this.now() - start, COUNT_MS);
      show(share);
      if (share >= 1) {
        this.counting = 0;
        table.setAttribute('aria-busy', 'false');
        return;
      }
      this.counting = this.raf(step);
    };
    this.counting = this.raf(step);
  }

  stopCount() {
    if (this.counting) this.cancelRaf(this.counting);
    this.counting = 0;
  }
}
