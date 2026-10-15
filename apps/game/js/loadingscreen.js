// The loading screen between Start (or Restart, a mission, a save, a replay,
// an online game's start) and the game's first frame (js/main.js). It shows
// at once and names the step the game is at: the steps are the start's own
// work, followed through the spans of the start trace (js/perfcapture.js
// PerfTrace.onSpan), so the screen tells what really happens and costs
// nothing beyond a few DOM writes. A start that fails shows its error with
// a button back.
//
// While it shows it is a modal dialog: the rest of the page is inert (the
// game behind it, its menu and end of game dialog), the focus stays in the
// card, and keys stop at the screen, so neither Tab and Enter nor a game
// hotkey (Esc and the menu) reach what it covers. FirstFrameGuard ends the
// screen with an error when the game stops before its first frame.
//
// The game starts only once the screen is gone: the first drawn frame begins
// its close (`done`, with the stylesheet's transition or animation on
// `.is-closing`, at once with "Reduce motion"), and the promise `done`
// returns (also `closed`) resolves when the screen is hidden. js/main.js
// holds the game at tick 0 until then (js/gamesession.js GameStart).
//
// One screen card like the menu screens (css/loading.css): the grid shows
// around it. The spinner and the bar stand still with "Reduce motion" (the
// setting or the browser's). While loading the section is aria-busy, the
// step is a polite status line and the bar a progressbar; an error is an
// alert and takes the focus.

/** How much longer than its stylesheet's close the screen waits for the transition's end event (a hidden tab runs none). */
export const CLOSE_GRACE_MS = 100;

/** Milliseconds as a CSS time list gives them ('0.3s, 120ms'): the longest. */
function cssTimes(list) {
  return String(list ?? '')
    .split(',')
    .map((t) => {
      const v = Number.parseFloat(t);
      if (!Number.isFinite(v)) return 0;
      return /ms\s*$/.test(t) ? v : v * 1000;
    });
}

/**
 * How long `root`'s close takes: its longest transition or animation (with
 * delays) as the stylesheet sets them for `.is-closing`; 0 without any or
 * without computed styles.
 */
export function closeDuration(root) {
  const cs = root.ownerDocument?.defaultView?.getComputedStyle?.(root);
  if (!cs) return 0;
  const longest = (durations, delays) => {
    const d = cssTimes(durations);
    const w = cssTimes(delays);
    return d.reduce((max, ms, i) => Math.max(max, ms + (w[i % (w.length || 1)] ?? 0)), 0);
  };
  return Math.max(longest(cs.transitionDuration, cs.transitionDelay), longest(cs.animationDuration, cs.animationDelay));
}

/** What each step says while it runs. */
export const STEP_LABELS = Object.freeze({
  map: 'Downloading the map',
  mission: 'Loading the mission',
  content: 'Reading installed content',
  engine: 'Starting the engine',
  battlefield: 'Building sprites, terrain and sounds',
  frame: 'Drawing the first frame',
});

/** The world step (the engine making the game) per kind of start. */
const WORLD_LABELS = Object.freeze({
  skirmish: 'Generating the map',
  skirmishMap: 'Loading the map',
  mission: 'Starting the mission',
  save: 'Loading the saved game',
  replay: 'Opening the replay',
  online: 'Starting the game',
  stress: 'Placing the units',
});

/** What the screen's title says per kind of start. */
const TITLES = Object.freeze({
  skirmish: 'Skirmish',
  mission: 'Mission',
  save: 'Saved game',
  replay: 'Replay',
  online: 'Online game',
  stress: 'Stress test',
});

/**
 * Spans of the start trace (js/main.js launch and start, js/perfcapture.js)
 * and the step each one begins.
 */
export const SPAN_STEPS = Object.freeze({
  'content.load': 'content',
  'sim.host': 'engine',
  'sim.start': 'world',
  'rules.parse': 'battlefield',
});

/**
 * The steps of a start: `kind` 'skirmish', 'mission', 'save', 'replay',
 * 'online' or 'stress'. `mapFile`: a skirmish or online game on a map file
 * (not generated); `download`: an online game that may download its map or
 * mission first; `missionFile`: a mission whose file loads first; `title`:
 * a title of its own (a mission's name); `restart`: the game starts again.
 * @returns {{ title: string, steps: { id: string, label: string }[] }}
 */
export function loadingPlan(kind, { mapFile = false, download = false, missionFile = false, title = null, restart = false } = {}) {
  if (!Object.hasOwn(TITLES, kind)) throw new Error(`unknown kind of start: ${kind}`);
  const world = kind === 'skirmish' && mapFile ? WORLD_LABELS.skirmishMap : kind === 'online' && !mapFile ? WORLD_LABELS.skirmish : WORLD_LABELS[kind];
  const ids = [
    ...(download ? ['map'] : []),
    ...(missionFile ? ['mission'] : []),
    // Online games start from the content the page already loaded (js/main.js createOnlineGame).
    ...(kind === 'online' ? [] : ['content']),
    'engine',
    'world',
    'battlefield',
    'frame',
  ];
  const name = title ?? TITLES[kind];
  return {
    title: restart ? `Restarting: ${name}` : name,
    steps: ids.map((id) => ({ id, label: id === 'world' ? world : STEP_LABELS[id] })),
  };
}

function el(doc, tag, className, text) {
  const e = doc.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

export class LoadingScreen {
  /**
   * @param {HTMLElement} root the screen's section (index.html #loading)
   * @param {{ reducedMotion?: () => boolean, doc?: Document, closeMs?: (root: HTMLElement) => number,
   *   timers?: { setTimeout: Function, clearTimeout: Function } }} [o]
   *   `reducedMotion`: "Reduce motion" now (the setting or the browser's);
   *   `closeMs`: how long the close transition takes (default: the stylesheet's, closeDuration);
   *   `timers`: for the close's fallback timer (tests pass their own)
   */
  constructor(root, { reducedMotion = () => false, doc = globalThis.document, closeMs = closeDuration, timers = null } = {}) {
    this.root = root;
    this.doc = doc;
    this.reducedMotion = reducedMotion;
    this.closeMs = closeMs;
    this.timers = timers ?? { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id) };
    /** The close of the current start: `{ promise, resolve }` (begin makes it, done resolves it once the screen is gone). */
    this.closing = null;
    /** Ends a close transition that is running (the screen hides now). */
    this.finishClose = null;
    /** 'idle', 'loading', 'closing' (the first frame was drawn, the close transition runs) or 'failed'. */
    this.state = 'idle';
    this.steps = [];
    this.index = -1;
    /** The element that had the focus before the screen took it (given back when the screen closes without a game). */
    this.before = null;
    /** The page's other parts made inert while the screen shows, with whether they were inert before. */
    this.covered = [];
    root.hidden = true;
    root.classList.add('loading-screen');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-labelledby', 'loading-title');
    this.card = el(doc, 'div', 'menu-card loading-card');
    this.card.tabIndex = -1;
    root.replaceChildren(this.card);
    // Keys stop here: Tab cycles within the card, nothing reaches the game's hotkeys behind it.
    root.addEventListener('keydown', (e) => this.onKey(e));
  }

  onKey(e) {
    if (this.root.hidden) return;
    if (e.key === 'Tab') {
      e.preventDefault();
      const stops = [this.card, ...this.card.querySelectorAll('button')];
      const i = stops.indexOf(this.doc.activeElement);
      const next = stops[(i + (e.shiftKey ? stops.length - 1 : 1) + stops.length) % stops.length] ?? this.card;
      next.focus?.({ preventScroll: true });
    }
    e.stopPropagation();
  }

  /** The screen came up: everything else on the page goes inert (as it was before, once the screen goes). */
  cover() {
    if (this.covered.length) return;
    const parent = this.root.parentNode;
    for (const node of parent?.children ?? []) {
      if (node === this.root) continue;
      this.covered.push([node, !!node.inert]);
      node.inert = true;
    }
  }

  uncover() {
    for (const [node, was] of this.covered.splice(0)) node.inert = was;
  }

  /** Whether a start is on screen (loading, not failed). */
  get active() {
    return this.state === 'loading';
  }

  /**
   * The screen of the current start is gone after its first frame (`done`):
   * a promise, resolved once (after the close transition; with "Reduce
   * motion" or no transition at once). Resolved already when no start shows.
   */
  get closed() {
    return this.closing?.promise ?? Promise.resolve();
  }

  /** Show the screen for a start of `plan` (loadingPlan) at its first step. */
  begin(plan) {
    const doc = this.doc;
    // A close still running belongs to a start that is gone (a restart while it faded): it ends now.
    this.finishClose?.(false);
    let resolve;
    const promise = new Promise((r) => (resolve = r));
    this.closing = { promise, resolve };
    this.state = 'loading';
    this.steps = plan.steps.slice();
    this.index = -1;
    const active = doc.activeElement;
    this.before = active && active !== doc.body && !this.root.contains(active) ? active : this.before;
    this.title = el(doc, 'h1', 'loading-title', plan.title);
    this.title.id = 'loading-title';
    const spinner = el(doc, 'span', 'loading-spinner');
    spinner.setAttribute('aria-hidden', 'true');
    this.status = el(doc, 'p', 'loading-status');
    this.status.setAttribute('role', 'status');
    this.status.setAttribute('aria-live', 'polite');
    const head = el(doc, 'div', 'loading-head');
    head.append(spinner, this.status);
    this.bar = el(doc, 'div', 'loading-bar');
    this.bar.setAttribute('role', 'progressbar');
    this.bar.setAttribute('aria-label', 'Loading');
    this.bar.setAttribute('aria-valuemin', '0');
    this.bar.setAttribute('aria-valuemax', '100');
    this.fill = el(doc, 'span', 'loading-bar-fill');
    this.bar.append(this.fill);
    this.list = el(doc, 'ol', 'loading-steps');
    this.items = this.steps.map((s) => {
      const li = el(doc, 'li', 'loading-step', s.label);
      li.dataset.step = s.id;
      li.dataset.state = 'pending';
      this.list.append(li);
      return li;
    });
    this.card.replaceChildren(this.title, head, this.bar, this.list);
    this.root.classList.toggle('is-still', !!this.reducedMotion());
    this.root.classList.remove('is-failed', 'is-closing');
    this.root.setAttribute('aria-busy', 'true');
    this.root.hidden = false;
    this.cover();
    this.card.focus?.({ preventScroll: true });
    this.step(this.steps[0]?.id);
  }

  /** The start reached step `id`: the steps before it are done. Steps never go back; unknown ones are ignored. */
  step(id) {
    if (this.state !== 'loading') return;
    const i = this.steps.findIndex((s) => s.id === id);
    if (i < 0 || i <= this.index) return;
    this.index = i;
    this.items.forEach((li, k) => {
      li.dataset.state = k < i ? 'done' : k === i ? 'active' : 'pending';
      if (k === i) li.setAttribute('aria-current', 'step');
      else li.removeAttribute('aria-current');
    });
    this.status.textContent = `${this.steps[i].label}...`;
    // Done steps of all: the bar shows the work behind, never 100% before the first frame.
    const pct = Math.round((i / this.steps.length) * 100);
    this.fill.style.setProperty('--fill', String(i / this.steps.length));
    this.bar.setAttribute('aria-valuenow', String(pct));
    this.bar.setAttribute('aria-valuetext', `Step ${i + 1} of ${this.steps.length}: ${this.steps[i].label}`);
  }

  /** A span of the start trace began (PerfTrace.onSpan): its step, when it is one of this start's. */
  span(name) {
    if (Object.hasOwn(SPAN_STEPS, name)) this.step(SPAN_STEPS[name]);
  }

  /**
   * The game drew its first frame: the screen goes, with the stylesheet's
   * close transition on `.is-closing` (at once with "Reduce motion" or
   * without one). It stays modal until it is hidden. Returns `closed`.
   */
  done() {
    if (this.state === 'closing') return this.closed;
    if (this.state !== 'loading') return Promise.resolve();
    // The game has the screen now: the focus stays where the game puts it.
    this.before = null;
    this.state = 'closing';
    this.root.setAttribute('aria-busy', 'false');
    const closing = this.closing;
    const reduced = !!this.reducedMotion();
    if (!reduced) this.root.classList.add('is-closing');
    const ms = reduced ? 0 : Math.max(0, Number(this.closeMs(this.root)) || 0);
    let timer = null;
    const onEnd = (e) => {
      if (e.target === this.root) finish(true);
    };
    const finish = (hide) => {
      if (this.finishClose !== finish) return;
      this.finishClose = null;
      if (timer !== null) this.timers.clearTimeout(timer);
      this.root.removeEventListener('transitionend', onEnd);
      this.root.removeEventListener('animationend', onEnd);
      if (hide) this.close();
      // The game starts once its screen is gone; a start replaced meanwhile never does.
      if (hide) closing?.resolve();
    };
    this.finishClose = finish;
    if (ms <= 0) {
      finish(true);
    } else {
      this.root.addEventListener('transitionend', onEnd);
      this.root.addEventListener('animationend', onEnd);
      // A hidden tab runs no transitions (and sends no end event): the timer ends it.
      timer = this.timers.setTimeout(() => finish(true), ms + CLOSE_GRACE_MS);
    }
    return closing?.promise ?? Promise.resolve();
  }

  /**
   * The start failed: the screen says why (an alert) and offers `label`,
   * which runs `run` (by default the screen closes, back to where the start
   * came from).
   */
  fail(message, { label = 'Back', run = null } = {}) {
    const doc = this.doc;
    this.finishClose?.(false);
    this.state = 'failed';
    this.root.setAttribute('aria-busy', 'false');
    this.root.classList.remove('is-closing');
    this.root.classList.add('is-failed');
    this.root.hidden = false;
    this.cover();
    const title = el(doc, 'h1', 'loading-title', 'Could not start');
    title.id = 'loading-title';
    const text = el(doc, 'p', 'loading-error', message);
    text.setAttribute('role', 'alert');
    const back = el(doc, 'button', 'loading-back primary', label);
    back.type = 'button';
    back.addEventListener('click', () => {
      if (run) run();
      else this.close();
    });
    this.card.replaceChildren(title, text, back);
    back.focus?.({ preventScroll: true });
  }

  /** Hide the screen (a start that was given up before it began, or Back after an error). */
  close() {
    this.finishClose?.(false);
    this.state = 'idle';
    this.root.hidden = true;
    this.root.setAttribute('aria-busy', 'false');
    this.root.classList.remove('is-failed', 'is-closing');
    this.card.replaceChildren();
    this.uncover();
    const back = this.before;
    this.before = null;
    if (back?.isConnected) back.focus?.({ preventScroll: true });
  }
}

/**
 * The loading screen's end for one game (js/main.js runGame): the first
 * drawn frame closes it (`drawn`), and a game that stops before that (the
 * simulation failed, its frame threw) shows the error with the way back to
 * the menu instead of a screen that loads forever. `closed` resolves when
 * the screen is gone after the first frame: the game starts then.
 */
export class FirstFrameGuard {
  /**
   * @param {{ screen: LoadingScreen, stop: () => void, back: () => void }} o
   *   `stop`: the game's loop stops; `back`: back to the menu (the page reloads)
   */
  constructor({ screen, stop, back }) {
    this.screen = screen;
    this.stop = stop;
    this.back = back;
    this.drawn = false;
    let resolve;
    /** Resolves when the loading screen is gone after the first frame (never for a start that failed). */
    this.closed = new Promise((r) => (resolve = r));
    this.resolveClosed = resolve;
  }

  /** The first frame was drawn: the screen goes (`closed` follows once it is gone). */
  firstFrame() {
    if (this.drawn) return this.closed;
    this.drawn = true;
    this.screen.done().then(this.resolveClosed);
    return this.closed;
  }

  /** The game stopped with `message`. Before its first frame: the loop stops and the screen fails (true); after it, false. */
  fail(message) {
    if (this.drawn) return false;
    this.drawn = true;
    this.stop();
    this.screen.fail(message, { label: 'Back to the menu', run: () => this.back() });
    return true;
  }

  /** Run a frame: before the first one is drawn, an error in it ends the start; later ones throw as before. */
  run(fn) {
    if (this.drawn) return fn();
    try {
      return fn();
    } catch (err) {
      console.error('The game stopped before its first frame:', err);
      if (!this.fail(`The game stopped while it started: ${err?.message ?? err}`)) throw err;
      return undefined;
    }
  }
}
