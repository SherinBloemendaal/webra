// What a mission shows besides the battlefield (presentation only; the
// mission itself runs in the engine, engine/src/mission):
//
// - the objectives panel (OpenRA's MissionObjectives in the game menu): a HUD
//   button; it opens by itself when an objective is added or decided, so the
//   player sees what changed
// - mission messages (Media.DisplayMessage, OpenRA's chat lines), the mission
//   text (UserInterface.SetMissionText) and floating texts over the map
// - movies (Media.PlayMovieFullscreen and friends): the original movie when
//   the player installed it (js/content/movies.js, never bundled), else a card
//   that names the movie and closes with a click, Esc, or after a few seconds
// - speech and sounds the scripts play, camera moves, radar pings
// - a script error: a banner with the error and Restart or Leave (the
//   mission's scripts stop; the battle itself goes on, like OpenRA)
//
// The engine sends the panel state and the events with each frame
// (js/sim/core.js `mission`, js/sim/proxy.js MissionFeed).

import { speechKey, fileName } from '../audio/catalog.js';
import { attachTooltip } from '../ui/tooltip.js';

/** How long a mission message stays (seconds), then fades (OpenRA ChatDisplayTime is about 10 s). */
export const MESSAGE_SECONDS = 10;
/** A movie card closes by itself after this long (ms). */
export const MOVIE_CARD_MS = 4000;

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function button(text, className, onClick) {
  const b = el('button', className, text);
  b.type = 'button';
  if (onClick) b.addEventListener('click', onClick);
  return b;
}

const cssHex = (hex) => (/^[0-9a-f]{6}$/i.test(hex ?? '') ? `#${hex}` : '#ffffff');

/** "Primary" or "Secondary" for an objective type. */
export function objectiveLabel(o) {
  return o.required === false ? 'Secondary' : 'Primary';
}

/** A movie's title for its card: its file name without the extension ("landing.vqa": "Movie: landing"). */
export function movieTitle(file) {
  const name = String(file ?? '').toLowerCase().replace(/\.vqa$/, '');
  return name ? `Movie: ${name}` : 'Movie';
}

export class MissionView {
  /**
   * @param {{
   *   field: HTMLElement, hudButtons: HTMLElement,
   *   feed: import('../sim/proxy.js').MissionFeed,
   *   audio: object | null,
   *   centerOn(x: number, y: number): void,  world pixels
   *   ping(x: number, y: number, rgb: number[], ticks: number): void,  world pixels
   *   toScreen(x: number, y: number): [number, number] | null,  world pixels to CSS pixels of the field
   *   pxPerCell: number, tickMs: number,
   *   localPlayer?: number,  the engine player of this screen (co-op missions online; else 0)
   *   movies?: { has(file: string): boolean, play(file: string, parent: HTMLElement): Promise<string>, stop(): void } | null,
   *     the original movies the player installed (content/movies.js createMoviePlayer); without one, or when it fails, a card
   *   onRestart(): void, onLeave(): void,
   *   now?(): number,  milliseconds of the page clock (message lines fade on it, like OpenRA's text notifications)
   *   gameNow?(): number,  milliseconds of the simulation clock (js/simclock.js): floating texts count game ticks, so they stand still while the game is paused
   * }} o
   */
  constructor(o) {
    this.o = o;
    this.localPlayer = o.localPlayer ?? 0;
    this.now = o.now ?? (() => performance.now());
    this.gameNow = o.gameNow ?? this.now;
    this.state = null;
    this.objectivesKey = '';
    this.panel = el('section', 'mission-panel');
    this.panel.setAttribute('aria-label', 'Objectives');
    this.panel.hidden = true;
    this.messages = el('div', 'mission-messages');
    this.messages.setAttribute('role', 'log');
    this.messages.setAttribute('aria-live', 'polite');
    this.text = el('div', 'mission-text');
    this.text.hidden = true;
    this.floating = [];
    this.card = null;
    this.error = null;
    o.field.append(this.panel, this.messages, this.text);
    this.button = button('Objectives', 'hud-button', () => this.toggle());
    this.button.setAttribute('aria-controls', 'mission-panel');
    this.panel.id = 'mission-panel';
    this.button.setAttribute('aria-expanded', 'false');
    o.hudButtons.prepend(this.button);
    attachTooltip(this.button, () => ({ title: 'Objectives', desc: 'What the mission asks of you, and which objectives are done or failed. Opens by itself when they change.' }), { side: 'bottom' });
  }

  toggle(open = this.panel.hidden) {
    this.panel.hidden = !open;
    this.button.setAttribute('aria-expanded', String(open));
    if (open) this.renderPanel();
  }

  /** Once per frame: the newest state and the scripts' events. */
  frame() {
    const s = this.o.feed.state;
    if (s && s !== this.state) {
      this.state = s;
      const key = JSON.stringify(s.objectives);
      if (key !== this.objectivesKey) {
        // A new or decided objective: show the panel (OpenRA flashes the menu button).
        const first = this.objectivesKey === '';
        this.objectivesKey = key;
        if (!first && s.objectives.length) this.toggle(true);
        else if (!this.panel.hidden) this.renderPanel();
      }
      this.renderText(s.missionText);
      if (s.error && !this.error) this.showError(s.error);
      // The script's PlayLowPowerNotification for this screen's player (OpenRA PowerManager).
      this.o.audio?.lowPowerQuiet?.(!!s.lowPowerQuiet);
    }
    for (const e of this.o.feed.take()) this.event(e);
    this.tickMessages();
    this.renderFloating();
  }

  event(e) {
    const o = this.o;
    switch (e.kind) {
      case 'message':
        this.message(e.prefix, e.text, e.color);
        break;
      case 'speech':
        if (e.player === 255 || e.player === this.localPlayer) {
          const key = speechKey(e.name);
          // The script's line: it waits while the game is paused (js/audio/announcer.js).
          if (key) o.audio?.announce(key, { world: true });
        }
        break;
      case 'sound':
        if (e.player === 255 || e.player === this.localPlayer) o.audio?.notify(e.name, { world: true });
        break;
      case 'sound_file':
        // An original sound by file name; without the player's own copy there is nothing to play.
        o.audio?.effect({ synth: null, originals: [fileName(e.file)] }, { world: true });
        break;
      case 'camera':
        o.centerOn(e.x * o.pxPerCell, e.y * o.pxPerCell);
        break;
      case 'movie':
        this.movie(e.file);
        break;
      case 'mission_text':
        this.renderText(e.text ? { text: e.text, color: e.color } : null);
        break;
      case 'floating_text':
        this.floating.push({ text: e.text, x: e.x * o.pxPerCell, y: e.y * o.pxPerCell, color: e.color, until: this.gameNow() + e.ticks * o.tickMs, node: null });
        break;
      case 'radar_ping': {
        const v = parseInt(e.color, 16);
        o.ping(e.x * o.pxPerCell, e.y * o.pxPerCell, [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255], e.ticks);
        break;
      }
      case 'debug':
        console.info('Mission:', e.text);
        break;
      case 'error':
        this.showError(e.text);
        break;
      default:
        // 'objectives' and 'result' come with the state (panel, end of game dialogs).
        break;
    }
  }

  renderPanel() {
    const list = el('ul', 'mission-objectives');
    for (const o of this.state?.objectives ?? []) {
      const li = el('li', 'mission-objective');
      li.dataset.state = o.state;
      const body = el('div');
      body.append(el('div', 'mission-objective-type', `${objectiveLabel(o)}${o.state === 'incomplete' ? '' : o.state === 'completed' ? ', completed' : ', failed'}`), el('div', null, o.description));
      li.append(body);
      list.append(li);
    }
    const title = el('h2', null, this.state?.title ?? 'Objectives');
    this.panel.replaceChildren(title, this.state?.objectives?.length ? list : el('p', null, 'No objectives yet.'));
  }

  renderText(t) {
    this.text.hidden = !t?.text;
    if (t?.text) {
      this.text.textContent = t.text;
      this.text.style.color = cssHex(t.color);
    }
  }

  message(prefix, text, color) {
    const line = el('div', 'mission-message');
    const who = el('span', null, prefix ? `${prefix}: ` : '');
    who.style.color = cssHex(color);
    line.append(who, document.createTextNode(text));
    line.dataset.until = String(this.now() + MESSAGE_SECONDS * 1000);
    this.messages.append(line);
    while (this.messages.childElementCount > 8) this.messages.firstChild.remove();
  }

  tickMessages() {
    const t = this.now();
    for (const line of [...this.messages.children]) {
      const until = Number(line.dataset.until);
      if (t > until + 600) line.remove();
      else if (t > until) line.classList.add('fading');
    }
  }

  renderFloating() {
    const t = this.gameNow();
    this.floating = this.floating.filter((f) => {
      const at = t <= f.until ? this.o.toScreen(f.x, f.y) : null;
      if (!at) {
        f.node?.remove();
        return t <= f.until;
      }
      if (!f.node) {
        f.node = el('div', 'mission-floating', f.text);
        f.node.style.color = cssHex(f.color);
        this.o.field.append(f.node);
      }
      f.node.style.left = `${at[0]}px`;
      f.node.style.top = `${at[1]}px`;
      return true;
    });
  }

  /**
   * A movie: the original one full screen when the player installed it
   * (`movies`), else a card that names it (also when the movie fails).
   */
  movie(file) {
    this.card?.close();
    const card = () => {
      const root = el('div', 'mission-card');
      const box = el('div', 'mission-card-box');
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-label', 'Movie');
      const close = () => {
        clearTimeout(timer);
        window.removeEventListener('keydown', onKey, true);
        root.remove();
        if (this.card === handle) this.card = null;
      };
      const onKey = (e) => {
        if (e.key === 'Escape' || e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          e.stopImmediatePropagation();
          close();
        }
      };
      const skip = button('Skip', 'campaign-btn campaign-btn-primary', close);
      box.append(el('h2', null, movieTitle(file)), el('p', null, 'The original game plays a movie here.'), skip);
      root.append(box);
      root.addEventListener('click', close);
      this.o.field.append(root);
      window.addEventListener('keydown', onKey, true);
      const timer = setTimeout(close, MOVIE_CARD_MS);
      const handle = { close };
      this.card = handle;
      skip.focus({ preventScroll: true });
    };
    const movies = this.o.movies;
    if (!movies?.has(file)) {
      card();
      return;
    }
    // The movie plays over the field; closing it (another movie) ends it as skipped.
    const handle = { close: () => movies.stop() };
    this.card = handle;
    const ended = (result) => {
      if (this.card !== handle) return; // a newer movie took over
      this.card = null;
      if (result === 'failed' || result === 'missing') card();
    };
    movies.play(file, this.o.field).then(ended, () => ended('failed'));
  }

  showError(text) {
    if (this.error) return;
    const box = el('div', 'mission-error');
    box.setAttribute('role', 'alert');
    box.append(
      el('strong', null, 'The mission script stopped with an error.'),
      el('pre', null, text),
      el('p', null, 'The battle goes on without the script; restart the mission to try again.'),
      button('Restart mission', 'campaign-btn', () => this.o.onRestart()),
      button('Leave', 'campaign-btn', () => this.o.onLeave()),
      button('Close', 'campaign-btn', () => box.remove()),
    );
    this.o.field.append(box);
    this.error = box;
  }
}
