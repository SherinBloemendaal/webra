// The boot screen of /play: from the page's first paint until the start menu
// is ready to use. index.html has it as static markup (#boot, the look of
// the loading screen in css/loading.css) and the body starts with
// `.is-booting`, which hides the menu screens behind it, so the menu bar
// never shows half built. Both work before any script runs.
//
// This module is loaded on its own ahead of js/main.js (index.html) and
// imported by it, so both share the one `bootScreen` below. It lights the
// boot's real steps as lamps (BOOT_STEPS): the game files load until
// js/main.js runs (`started`), then main.js `track`s the engine, the
// account, the installed content and the graphics card, and calls `ready`
// once the start menu is built. The account and the installed content get at
// most BOOT_WAIT_MS more: the menu works without them and they finish
// behind it. The screen then fades like the loading screen (LOADING_FADE_MS,
// the stylesheet's transition on `.is-closing`; at once with "Reduce
// motion"). A game that starts during the boot (a restart record, an online
// rejoin) hands over: the loading screen (#loading) begins under it and this
// screen fades over it (`handOver`).
//
// It never hangs: the game files that do not load (the main script's error
// event, or an error before js/main.js ran) and a boot that throws show the
// error with Reload (`fail`), and after a long wait a line with Reload shows
// by CSS alone (.boot-late), also without scripts; with scripts the polite
// status line says it too, so screen readers hear it. Known boot problems (no
// engine, no WebGPU) are not failures here: the lobby shows them once the
// screen is gone. While it shows the section is aria-busy, the step is a
// polite status line and the bar a progressbar; an error is an alert.

import { CLOSE_GRACE_MS, closeDuration } from './loadingscreen.js';

/** The boot's steps in screen order, with what each one says (index.html has the same lamps). */
export const BOOT_STEPS = Object.freeze([
  Object.freeze({ id: 'files', label: 'Loading the game files' }),
  Object.freeze({ id: 'engine', label: 'Starting the engine' }),
  Object.freeze({ id: 'account', label: 'Checking your account' }),
  Object.freeze({ id: 'content', label: 'Reading installed content' }),
  Object.freeze({ id: 'graphics', label: 'Checking the graphics card' }),
  Object.freeze({ id: 'menu', label: 'Opening the menu' }),
]);

/** Steps the menu does not need: `ready` waits at most this long for them. */
export const BOOT_OPTIONAL = Object.freeze(['account', 'content']);

/** How long `ready` waits for the optional steps (the account, installed content) once the menu is built. */
export const BOOT_WAIT_MS = 5000;

/** After how long css/loading.css shows the "taking longer" line with Reload (.boot-late, --boot-late) and the status line says so. */
export const BOOT_LATE_MS = 20000;

/** What the status line says after BOOT_LATE_MS (the .boot-late line in index.html says the same). */
export const BOOT_LATE_TEXT = 'This is taking longer than usual. Check your internet connection, or reload the page.';

const DONE = new Set(['done', 'failed', 'skipped']);

export class BootScreen {
  /**
   * @param {HTMLElement | null} root index.html #boot; without it every call does nothing
   * @param {{ doc?: Document, reload?: () => void, closeMs?: (root: HTMLElement) => number,
   *   timers?: { setTimeout: Function, clearTimeout: Function }, waitMs?: number }} [o]
   *   `reload`: what Reload does (the page reloads); `closeMs`: how long the close transition
   *   takes (default: the stylesheet's); `timers`: for the waits (tests pass their own)
   */
  constructor(root, { doc = globalThis.document, reload = () => globalThis.location?.reload(), closeMs = closeDuration, timers = null, waitMs = BOOT_WAIT_MS } = {}) {
    this.root = root;
    this.doc = doc;
    this.reload = reload;
    this.closeMs = closeMs;
    this.waitMs = waitMs;
    this.timers = timers ?? { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id) };
    /** 'booting', 'closing' (the fade runs), 'gone' or 'failed'. */
    this.state = root ? 'booting' : 'gone';
    /** Whether js/main.js runs (the game files loaded). */
    this.running = false;
    this.reducedMotion = () => !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    /** Step id to its state: 'pending', 'active', 'done', 'failed' or 'skipped'. */
    this.states = new Map(BOOT_STEPS.map((s) => [s.id, 'pending']));
    /** Listeners for step changes (`ready` waits on them). */
    this.watchers = new Set();
    let resolve;
    /** Resolves once the screen is gone (never after a failure). */
    this.closed = root ? new Promise((r) => (resolve = r)) : Promise.resolve();
    this.resolveClosed = resolve ?? (() => {});
    if (!root) return;
    this.status = root.querySelector('.loading-status');
    this.bar = root.querySelector('.loading-bar');
    this.fill = root.querySelector('.loading-bar-fill');
    this.items = new Map([...root.querySelectorAll('.loading-step')].map((li) => [li.dataset.step, li]));
    // The late line's Reload is a link to this page (it works without scripts); with them it reloads in place, the address's hash too.
    for (const link of root.querySelectorAll('.boot-reload')) {
      link.addEventListener('click', (e) => {
        e.preventDefault?.();
        this.reload();
      });
    }
    root.setAttribute('aria-busy', 'true');
    this.begin('files');
    // The late line shows by CSS alone; a change of visibility is not reliably announced, so the status line says it.
    this.lateTimer = this.timers.setTimeout(() => {
      this.lateTimer = null;
      if (this.state === 'booting' && this.status) this.status.textContent = BOOT_LATE_TEXT;
    }, BOOT_LATE_MS);
  }

  stopLate() {
    if (this.lateTimer === null || this.lateTimer === undefined) return;
    this.timers.clearTimeout(this.lateTimer);
    this.lateTimer = null;
  }

  /** Whether the screen still covers the page (booting or failed). */
  get showing() {
    return this.state === 'booting' || this.state === 'failed';
  }

  /** js/main.js runs: the files are loaded. `reducedMotion`: "Reduce motion" now (the setting or the browser's). */
  started({ reducedMotion = null } = {}) {
    this.running = true;
    if (reducedMotion) this.reducedMotion = reducedMotion;
    if (this.state !== 'booting') return;
    this.root.classList.toggle('is-still', !!this.reducedMotion());
    this.set('files', 'done');
  }

  /** Step `id` began. */
  begin(id) {
    if (this.states.get(id) === 'pending') this.set(id, 'active');
  }

  /**
   * Step `id` is the work of `promise`: active now, done when it resolves,
   * failed when it rejects. Without a promise the step is not available
   * (failed). Returns `promise` as it is, so the caller handles its result.
   */
  track(id, promise) {
    if (!promise || typeof promise.then !== 'function') {
      this.set(id, 'failed');
      return promise;
    }
    this.begin(id);
    promise.then(
      () => this.set(id, 'done'),
      () => this.set(id, 'failed'),
    );
    return promise;
  }

  /** Step `id` is now `state` (a finished step stays finished). */
  set(id, state) {
    const now = this.states.get(id);
    if (now === undefined || DONE.has(now) || now === state) return;
    this.states.set(id, state);
    for (const fn of [...this.watchers]) fn();
    if (this.state === 'booting') this.render();
  }

  /** Whether step `id` has ended (done, failed or skipped). */
  ended(id) {
    return DONE.has(this.states.get(id));
  }

  render() {
    const total = BOOT_STEPS.length;
    let finished = 0;
    for (const { id, label } of BOOT_STEPS) {
      const state = this.states.get(id);
      if (DONE.has(state)) finished++;
      const li = this.items.get(id);
      if (!li) continue;
      li.dataset.state = state;
      // The lamp's colour is not the only sign: the word says it too.
      li.textContent = state === 'failed' ? `${label}: unavailable` : label;
      if (state === 'active') li.setAttribute('aria-current', 'step');
      else li.removeAttribute('aria-current');
    }
    // The status line names the first step still running, in screen order.
    const current = BOOT_STEPS.find((s) => this.states.get(s.id) === 'active');
    if (this.status && current) this.status.textContent = `${current.label}...`;
    const pct = Math.round((finished / total) * 100);
    this.fill?.style.setProperty('--fill', String(finished / total));
    this.bar?.setAttribute('aria-valuenow', String(pct));
    this.bar?.setAttribute('aria-valuetext', current ? `${finished} of ${total} steps done: ${current.label}` : `${finished} of ${total} steps done`);
  }

  /** Resolves once every step in `ids` has ended, or after `ms`. */
  settled(ids, ms) {
    if (ids.every((id) => this.ended(id))) return Promise.resolve(true);
    return new Promise((resolve) => {
      const finish = (all) => {
        this.watchers.delete(check);
        this.timers.clearTimeout(timer);
        resolve(all);
      };
      const check = () => ids.every((id) => this.ended(id)) && finish(true);
      const timer = this.timers.setTimeout(() => finish(false), ms);
      this.watchers.add(check);
    });
  }

  /** Resolves once `promise` settled (either way) or after `ms`: boot work the screen waits for, never forever. */
  within(promise, ms) {
    return new Promise((resolve) => {
      const timer = this.timers.setTimeout(() => resolve(false), ms);
      Promise.resolve(promise).then(
        () => (this.timers.clearTimeout(timer), resolve(true)),
        () => (this.timers.clearTimeout(timer), resolve(true)),
      );
    });
  }

  /**
   * The start menu is built and usable: the menu step is done, the optional
   * steps get at most `waitMs` more, steps that never began are skipped, and
   * the screen fades. Returns `closed`: what must not open under the
   * screen (What's new) waits for it, and never opens after a failure.
   */
  async ready() {
    if (this.state !== 'booting') return this.closed;
    this.set('menu', 'done');
    await this.settled(BOOT_OPTIONAL, this.waitMs);
    if (this.state !== 'booting') return this.closed;
    for (const { id } of BOOT_STEPS) if (this.states.get(id) === 'pending') this.set(id, 'skipped');
    if (this.status) this.status.textContent = 'Ready';
    return this.close();
  }

  /** A game's loading screen begins during the boot (js/loadingscreen.js onBegin): this screen fades over it now. */
  handOver() {
    if (this.state !== 'booting') return this.closed;
    return this.close();
  }

  /** The fade (the stylesheet's transition on `.is-closing`, none with "Reduce motion"); the page shows the menu behind it. */
  close() {
    const root = this.root;
    this.stopLate();
    this.state = 'closing';
    root.setAttribute('aria-busy', 'false');
    this.doc.body?.classList.remove('is-booting');
    const reduced = !!this.reducedMotion();
    root.classList.toggle('is-still', reduced);
    if (!reduced) root.classList.add('is-closing');
    const ms = reduced ? 0 : Math.max(0, Number(this.closeMs(root)) || 0);
    let timer = null;
    const onEnd = (e) => {
      if (e.target === root) finish();
    };
    const finish = () => {
      if (this.state !== 'closing') return;
      if (timer !== null) this.timers.clearTimeout(timer);
      root.removeEventListener('transitionend', onEnd);
      root.removeEventListener('animationend', onEnd);
      this.state = 'gone';
      root.hidden = true;
      root.classList.remove('is-closing');
      this.resolveClosed();
    };
    if (ms <= 0) finish();
    else {
      root.addEventListener('transitionend', onEnd);
      root.addEventListener('animationend', onEnd);
      // A hidden tab runs no transitions (and sends no end event): the timer ends it.
      timer = this.timers.setTimeout(finish, ms + CLOSE_GRACE_MS);
    }
    return this.closed;
  }

  /**
   * The boot failed with `error` (an Error or a message): the screen says
   * why (an alert) and offers Reload. Once the screen is gone (a game took
   * over, the menu shows) a failure only goes to the console.
   */
  fail(error) {
    const message = String(error?.message ?? error ?? 'unknown error');
    if (!this.showing) {
      if (this.root) console.error('WebRA boot failed after its screen closed:', error);
      return;
    }
    const doc = this.doc;
    const active = BOOT_STEPS.find((s) => this.states.get(s.id) === 'active');
    if (active) this.set(active.id, 'failed');
    this.stopLate();
    this.state = 'failed';
    const root = this.root;
    root.setAttribute('aria-busy', 'false');
    root.classList.add('is-failed');
    const card = root.querySelector('.loading-card') ?? root;
    const title = doc.createElement('h1');
    title.className = 'loading-title';
    title.id = 'boot-title';
    title.textContent = 'Could not start';
    const text = doc.createElement('p');
    text.className = 'loading-error';
    text.setAttribute('role', 'alert');
    text.textContent = `WebRA could not start: ${message}`;
    const hint = doc.createElement('p');
    hint.className = 'boot-hint';
    hint.textContent = 'Check your internet connection and reload the page. If it keeps happening, try another browser or clear the data of this site.';
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'loading-back primary';
    button.textContent = 'Reload';
    button.addEventListener('click', () => this.reload());
    card.replaceChildren(title, text, hint, button);
    button.focus?.({ preventScroll: true });
  }
}

/**
 * Before js/main.js runs, a failure to load the game files is the boot's
 * failure: the main script's error event (a file that did not arrive) and an
 * error thrown while its modules load or run (a script error event on the
 * window). Once main.js runs, its boot reports its own failures.
 */
export function watchGameFiles(screen, { doc = globalThis.document, win = globalThis.window } = {}) {
  if (!screen.root) return;
  const main = doc.querySelector?.('script[type="module"][src="js/main.js"]');
  main?.addEventListener('error', () => {
    if (!screen.running) screen.fail(new Error('the game files did not load.'));
  });
  win?.addEventListener?.('error', (e) => {
    if (!screen.running) screen.fail(e?.error ?? e?.message ?? 'a script error while the game files loaded.');
  });
}

/** The page's boot screen (index.html #boot): js/main.js reports its steps here. */
export const bootScreen = new BootScreen(globalThis.document?.getElementById?.('boot') ?? null);
watchGameFiles(bootScreen);
