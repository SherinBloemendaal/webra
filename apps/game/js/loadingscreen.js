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
// The look is the canvas board "Laadscherm (geanimeerd)" (css/loading.css):
// js/loadingboard.js adds the emblem, the kind of game, the map's name, the
// players by side and the tips around the steps. The screen always shows,
// also for a quick start, for at least LOADING_MIN_MS: the bar's animation
// (its stripes reveal it in that time, never ahead of the real steps).
// done() only says how much of that time is left, as --loading-hold on the
// section: css/loading.css makes it the delay of the fade (LOADING_FADE_MS)
// on `#loading.is-closing`. The close itself is the start gate's
// (work/startgate: done() adds .is-closing and waits for the stylesheet's
// transition, its duration plus its delay, before the screen hides and the
// game begins), so with it the screen waits out the rest of the least time
// and then fades. Until then done() hides the screen at once. With "Reduce
// motion" (the setting or the browser's) the spinner, the bar and the
// entrance stand still and there is no hold and no fade. While loading the
// section is aria-busy, the step is a polite status line and the bar a
// progressbar; an error is an alert and takes the focus.

/** The least time the screen shows (the bar's fill animation, css/loading.css --loading-min). */
export const LOADING_MIN_MS = 1600;
/** The fade out after the first frame (css/loading.css --loading-fade). */
export const LOADING_FADE_MS = 300;

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
   * @param {{ reducedMotion?: () => boolean, doc?: Document }} [o]
   *   `reducedMotion`: "Reduce motion" now (the setting or the browser's)
   */
  constructor(root, { reducedMotion = () => false, doc = globalThis.document, board = null, now = () => globalThis.performance?.now() ?? Date.now() } = {}) {
    this.root = root;
    this.doc = doc;
    this.reducedMotion = reducedMotion;
    /** The board around the steps (js/loadingboard.js), or null. */
    this.board = board;
    this.now = now;
    /** When the current start's screen came up (the least showing time counts from here). */
    this.shownAt = 0;
    /** 'idle', 'loading' or 'failed'. */
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

  /** Show the screen for a start of `plan` (loadingPlan) at its first step. */
  begin(plan) {
    const doc = this.doc;
    this.shownAt = this.now();
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
    this.board?.begin(this.card, plan);
    this.root.classList.toggle('is-still', !!this.reducedMotion());
    this.root.classList.remove('is-failed');
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

  /** The start's players and map are known (js/loadingboard.js describeStart): the board shows them. */
  describe(info) {
    if (this.state === 'loading') this.board?.describe(info);
  }

  /** How much longer the screen must show (LOADING_MIN_MS from begin; 0 with "Reduce motion"). */
  holdMs() {
    if (this.reducedMotion()) return 0;
    return Math.max(0, Math.round(LOADING_MIN_MS - (this.now() - this.shownAt)));
  }

  /** The game drew its first frame: the bar fills, and the screen goes. */
  done() {
    if (this.state !== 'loading') return;
    // The game has the screen now: the focus stays where the game puts it.
    this.before = null;
    this.fill.style.setProperty('--fill', '1');
    this.bar.setAttribute('aria-valuenow', '100');
    this.bar.setAttribute('aria-valuetext', 'Ready');
    this.status.textContent = 'Ready. Starting the game';
    // The least showing time left: the delay of the fade on #loading.is-closing (css/loading.css),
    // which the start gate's close waits for. Set before .is-closing goes on.
    this.root.style.setProperty('--loading-hold', `${this.holdMs()}ms`);
    this.close();
  }

  /**
   * The start failed: the screen says why (an alert) and offers `label`,
   * which runs `run` (by default the screen closes, back to where the start
   * came from).
   */
  fail(message, { label = 'Back', run = null } = {}) {
    const doc = this.doc;
    this.board?.end();
    this.state = 'failed';
    this.root.setAttribute('aria-busy', 'false');
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
    this.board?.end();
    this.state = 'idle';
    this.root.hidden = true;
    this.root.setAttribute('aria-busy', 'false');
    this.root.classList.remove('is-failed');
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
 * the menu instead of a screen that loads forever.
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
  }

  /** The first frame was drawn: the screen goes. */
  firstFrame() {
    if (this.drawn) return;
    this.drawn = true;
    this.screen.done();
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
