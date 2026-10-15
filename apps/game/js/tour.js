// The tour in the first skirmish games (docs/contracts.md, "The guide and the
// tour"; design board GuideTour): a card above the command bar with the
// open step of the guide's first chapter (js/help.js GUIDE, TOUR_CHAPTER),
// the sidebar's cameo for it lit up, and "Step done" when the game ticks a
// step off (js/guide.js GuideTracker). Skip step ticks the step off by hand,
// the close button skips the whole tour (guide.tourInGames off: the Guide's
// "Tour in my games" switch turns it on again), Full guide opens the game
// menu's Guide page. The tour never takes the focus; its announcements are a
// polite live region.
//
// When it runs is js/guide.js tourRuns: the player's own skirmish games
// only, never missions, online games, replays or spectators.

import { GUIDE } from './help.js';
import { STEPS, TOUR_CHAPTER, TOUR_STEPS, guideText } from './guide.js';
import { boundKey } from './hotkeys.js';

/** How long "Step done" stays (ms). */
export const TOAST_MS = 4000;

/** The sidebar cameos (js/sidebar.js `.sb-card[data-id]`) lit up for a tour step. */
export const TOUR_TARGETS = Object.freeze({
  'base.power': ['POWR'],
  'base.refinery': ['PROC'],
  'base.production': ['TENT', 'BARR', 'WEAP'],
  'base.radar': ['DOME'],
});

/** The class a lit cameo gets (css/guide.css). */
export const TARGET_CLASS = 'tour-target';

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

/** What the tour card shows for `progress`: the step, its place and the dots, or null when the tour is done. */
export function tourModel(progress, hotkeys = null) {
  const id = progress.tourStep();
  if (!id) return null;
  const { step, index } = STEPS.get(id);
  const chapter = GUIDE.find((c) => c.id === TOUR_CHAPTER);
  const done = progress.done;
  return {
    id,
    where: `Tour · ${chapter.title} · ${index + 1} of ${TOUR_STEPS.length}`,
    title: guideText(step.title, hotkeys),
    text: guideText(step.tour ?? step.text, hotkeys),
    watch: `Ticks off by itself: ${step.watch}.`,
    dots: TOUR_STEPS.map((s) => (done[s] === true ? 'done' : s === id ? 'active' : 'open')),
    targets: TOUR_TARGETS[id] ?? [],
  };
}

export class TourCard {
  /**
   * @param {HTMLElement} field the battlefield (#field): the card sits in its bottom left, above the command bar
   * @param {{
   *   progress: import('./guide.js').GuideProgress,
   *   hotkeys?: import('./hotkeys.js').HotkeyRegistry,
   *   onGuide?(): void,  opens the game menu's Guide page
   *   cameos?(): Iterable<HTMLElement>,  the sidebar's cameos (default: every `.sb-card` of the page)
   *   setTimeout?, clearTimeout?
   * }} o
   */
  constructor(field, o) {
    this.o = o;
    this.progress = o.progress;
    this.timers = { set: o.setTimeout ?? globalThis.setTimeout, clear: o.clearTimeout ?? globalThis.clearTimeout };
    this.toastTimer = null;
    this.lit = [];
    this.root = el('section', 'tour');
    this.root.setAttribute('aria-label', 'Tour');
    // A click on the card is not a click on the map, and does not capture the mouse (js/mouselock.js).
    this.root.dataset.noCapture = '';
    for (const type of ['mousedown', 'pointerdown', 'contextmenu', 'wheel']) this.root.addEventListener(type, (e) => e.stopPropagation());
    this.card = el('div', 'tour-card');
    this.where = el('span', 'tour-where');
    const close = button('', 'tour-close', () => this.skipTour());
    close.setAttribute('aria-label', 'Skip the tour');
    close.title = 'Skip the tour (the Guide turns it on again)';
    const head = el('div', 'tour-head');
    head.append(this.where, close);
    this.title = el('h2', 'tour-title');
    this.text = el('p', 'tour-text');
    this.watch = el('p', 'tour-watch');
    this.dots = el('ol', 'tour-dots');
    this.dots.setAttribute('aria-label', 'Tour steps');
    const actions = el('div', 'tour-actions');
    this.skip = button('Skip step', 'ui-btn ui-btn-sm ui-btn-ghost', () => this.skipStep());
    this.guide = button('Full guide', 'ui-btn ui-btn-sm', () => o.onGuide?.());
    this.guide.hidden = !o.onGuide;
    actions.append(this.skip, this.guide);
    const foot = el('div', 'tour-foot');
    foot.append(this.dots, actions);
    this.card.append(head, this.title, this.text, this.watch, foot);
    // "Step done" and "Tour done": a polite live region that stays in place.
    this.toast = el('p', 'tour-toast');
    this.toast.setAttribute('role', 'status');
    this.toast.setAttribute('aria-live', 'polite');
    this.root.append(this.toast, this.card);
    field.append(this.root);
    this.off = this.progress.subscribe(() => this.render());
    this.render();
  }

  /** Whether the card shows a step now. */
  get shown() {
    return !this.card.hidden;
  }

  render() {
    if (this.disposed) return;
    const m = this.progress.tourInGames ? tourModel(this.progress, this.o.hotkeys) : null;
    this.card.hidden = !m;
    this.root.classList.toggle('tour-idle', !m);
    this.light(m?.targets ?? []);
    if (!m) return;
    this.where.textContent = m.where;
    this.title.textContent = m.title;
    this.text.textContent = m.text;
    this.watch.textContent = m.watch;
    const key = this.o.hotkeys ? boundKey(this.o.hotkeys, 'menu') : null;
    this.guide.textContent = `Full guide (${key ? `${key} or Esc` : 'Esc'})`;
    this.dots.replaceChildren(
      ...m.dots.map((state, i) => {
        const li = el('li', `tour-dot tour-dot-${state}`);
        li.textContent = `Step ${i + 1}: ${state === 'done' ? 'done' : state === 'active' ? 'now' : 'to do'}`;
        if (state === 'active') li.setAttribute('aria-current', 'step');
        return li;
      }),
    );
  }

  /** Light the sidebar's cameos of the step (again on every refresh: the sidebar makes its cards when they first show). */
  light(ids) {
    for (const c of this.lit) c.classList.remove(TARGET_CLASS);
    this.lit = [];
    if (!ids.length) return;
    const cards = this.o.cameos ? this.o.cameos() : (this.root.ownerDocument?.querySelectorAll?.('.sb-card') ?? []);
    for (const c of cards) {
      if (ids.includes(c.dataset?.id)) {
        c.classList.add(TARGET_CLASS);
        this.lit.push(c);
      }
    }
  }

  /** Every state refresh of the game (100 ms): the cameos come and go with the sidebar's tabs. */
  refresh() {
    if (!this.disposed && this.shown) this.light(tourModel(this.progress, this.o.hotkeys)?.targets ?? []);
  }

  /** Steps the game just ticked off (GuideTracker onDone): "Step done" for the tour's. */
  stepsDone(ids) {
    const mine = ids.filter((id) => TOUR_STEPS.includes(id));
    if (!mine.length || this.disposed) return;
    const last = STEPS.get(mine[mine.length - 1]).step;
    this.say(this.progress.tourComplete() ? 'Tour done. The Guide (Esc) has more.' : `Step done: ${last.watch}`);
  }

  say(text) {
    this.toast.textContent = text;
    this.root.classList.add('tour-toasting');
    if (this.toastTimer !== null) this.timers.clear(this.toastTimer);
    this.toastTimer = this.timers.set(() => {
      this.toastTimer = null;
      this.root.classList.remove('tour-toasting');
      this.toast.textContent = '';
    }, TOAST_MS);
  }

  skipStep() {
    const id = this.progress.tourStep();
    if (!id) return;
    const fresh = this.progress.mark([id]);
    if (fresh.length && this.progress.tourComplete()) this.say('Tour done. The Guide (Esc) has more.');
  }

  skipTour() {
    this.progress.setTourInGames(false);
    this.say('Tour off. Esc, Guide turns it on again.');
  }

  dispose() {
    this.disposed = true;
    this.off?.();
    this.light([]);
    if (this.toastTimer !== null) this.timers.clear(this.toastTimer);
    this.root.remove();
  }
}
