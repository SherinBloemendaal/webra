// The loading screen between Start (or Restart, a mission, a save, a replay,
// an online game's start) and the game's first frame (js/main.js). It shows
// at once and names the step the game is at: the steps are the start's own
// work, followed through the spans of the start trace (js/perfcapture.js
// PerfTrace.onSpan), so the screen tells what really happens and costs
// nothing beyond a few DOM writes. A start that fails shows its error with
// a button back.
//
// One screen card like the menu screens (css/loading.css): the grid shows
// around it. The spinner and the bar stand still with "Reduce motion" (the
// setting or the browser's). While loading the section is aria-busy, the
// step is a polite status line and the bar a progressbar; an error is an
// alert and takes the focus.

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
  constructor(root, { reducedMotion = () => false, doc = globalThis.document } = {}) {
    this.root = root;
    this.doc = doc;
    this.reducedMotion = reducedMotion;
    /** 'idle', 'loading' or 'failed'. */
    this.state = 'idle';
    this.steps = [];
    this.index = -1;
    /** The element that had the focus before the screen took it (given back when the screen closes without a game). */
    this.before = null;
    root.hidden = true;
    root.classList.add('loading-screen');
    root.setAttribute('aria-labelledby', 'loading-title');
    this.card = el(doc, 'div', 'menu-card loading-card');
    this.card.tabIndex = -1;
    root.replaceChildren(this.card);
  }

  /** Whether a start is on screen (loading, not failed). */
  get active() {
    return this.state === 'loading';
  }

  /** Show the screen for a start of `plan` (loadingPlan) at its first step. */
  begin(plan) {
    const doc = this.doc;
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
    this.root.classList.remove('is-failed');
    this.root.setAttribute('aria-busy', 'true');
    this.root.hidden = false;
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

  /** The game drew its first frame: the screen goes. */
  done() {
    if (this.state !== 'loading') return;
    // The game has the screen now: the focus stays where the game puts it.
    this.before = null;
    this.close();
  }

  /**
   * The start failed: the screen says why (an alert) and offers `label`,
   * which runs `run` (by default the screen closes, back to where the start
   * came from).
   */
  fail(message, { label = 'Back', run = null } = {}) {
    const doc = this.doc;
    this.state = 'failed';
    this.root.setAttribute('aria-busy', 'false');
    this.root.classList.add('is-failed');
    this.root.hidden = false;
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
    this.state = 'idle';
    this.root.hidden = true;
    this.root.setAttribute('aria-busy', 'false');
    this.root.classList.remove('is-failed');
    this.card.replaceChildren();
    const back = this.before;
    this.before = null;
    if (back?.isConnected) back.focus?.({ preventScroll: true });
  }
}
