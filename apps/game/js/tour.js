// The tour in the skirmish games (docs/contracts.md, "The guide and the
// tour"; design board GuideTour): a card above the command bar with the
// tour's step (js/guide.js GuideProgress.tourStep: the first open step of
// the first chapter in TOUR_ORDER that still has one in this game), an
// "Also" line for a step that runs beside it (train infantry while the War
// Factory goes up), a low power warning, the sidebar's cameos for them lit
// up, and "Step done" when the game ticks a step off (js/guide.js
// GuideTracker). The tour goes on through every chapter by itself; steps
// that only happen to the player (`passive`) or outside a skirmish
// (`outside`) never stop it. Skip step (Got it for a step that only
// explains) ticks the step off by hand, the close button skips the whole
// tour (guide.tourInGames off: the Guide's "Tour in my games" switch turns
// it on again), Full guide opens the game menu's Guide page. When every
// step it counts is done, the card asks once whether to keep the quick tips
// (game.quickTips, guide.quickTipsAsked).
//
// Tour steps that a later version adds show, the open steps only, while the
// switch is on: for players who finished the tour since 0.18.0 (finishing
// leaves it on), never for players who skipped it. 0.17.0 turned it off on
// finishing too; those players get the "New" badges (js/guide.js
// GuideProgress). The tour never takes the focus; its announcements are a
// polite live region.
//
// When it runs is js/guide.js tourRuns: the player's own skirmish games
// only, never missions, online games, replays or spectators.

import { EVERY_STEP, guideText, isRead } from './guide.js';
import { boundKey } from './hotkeys.js';

/** How long "Step done" stays (ms). */
export const TOAST_MS = 4000;

/** The sidebar cameos (js/sidebar.js `.sb-card[data-id]`) lit up for a tour step; the sidebar only has its faction's. */
export const TOUR_TARGETS = Object.freeze({
  'base.power': ['POWR'],
  'base.refinery': ['PROC'],
  'base.barracks': ['TENT', 'BARR'],
  'army.infantry': ['E1', 'E2'],
  'base.factory': ['WEAP'],
  'army.vehicle': ['1TNK', 'APC', 'FTRK'],
  'base.morePower': ['POWR'],
  'base.radar': ['DOME'],
  'ore.truck': ['HARV'],
  'ore.silo': ['SILO'],
  'power.more': ['POWR', 'APWR'],
  'weather.rod': ['LROD'],
});

/** The class a lit cameo gets (css/guide.css). */
export const TARGET_CLASS = 'tour-target';

/** The extra class of the "Also" step's cameos: a dimmer pulse. */
export const ALSO_CLASS = 'tour-target-also';

/** The card's line while the player is on low power (engine rules.json low_power_modifier 300: three times slower). */
export const LOW_POWER_WARNING = 'Low power: everything builds three times slower. Build a Power Plant.';

/** The cameos lit with the low power line. */
const LOW_POWER_TARGETS = ['POWR'];

/** The last card's question. */
export const FINALE_TEXT =
  'Quick tips say what a building or unit does when you hover it, in the build menu and on the battlefield. Keep them on, or turn them off now that you know your way around? You can change this later under Settings, Game.';

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

function chapterOf(progress, id) {
  return progress.content.steps.get(id).chapter;
}

/**
 * What the tour card shows: `{ id, where, title, text, watch, read, dots,
 * targets, also, warn, note, finale }`, or null when the tour is done (and
 * its question answered). `ctx` says which steps this game has
 * (GuideTracker.ctx), `state` is the player state (the low power line).
 * `also` is `{ id, title, text, targets }` or null; `note` says the tour has
 * nothing more in this game; `finale` is the quick tips question.
 */
export function tourModel(progress, ctx = EVERY_STEP, state = null, hotkeys = null) {
  const done = progress.done;
  const none = { id: null, read: false, dots: [], targets: [], also: null, warn: null, note: null, finale: false };
  if (progress.finalePending(done)) return { ...none, where: 'Tour · Done', title: 'Tour done', text: FINALE_TEXT, watch: '', finale: true };
  if (progress.tourComplete(done)) return null;
  const { steps } = progress.content;
  const warn = state?.lowPower === true ? LOW_POWER_WARNING : null;
  const id = progress.tourStep(ctx, done);
  if (!id) {
    // Every open step of the tour is missing from this game (its game mode or tech level).
    const missing = progress.content.tourIds.find((s) => done[s] !== true);
    const { step, chapter } = steps.get(missing);
    const note = `Nothing more in this game: "${guideText(step.title, hotkeys)}" needs a higher tech level or another game mode. The tour goes on in your next skirmish.`;
    return { ...none, where: `Tour · ${chapter.title}`, title: chapter.title, text: note, watch: '', warn, targets: warn ? LOW_POWER_TARGETS : [], note };
  }
  const { step, chapter } = steps.get(id);
  const counted = progress.tourStepsOf(chapter);
  const alsoId = progress.tourAlso(ctx, done);
  const also = alsoId
    ? { id: alsoId, title: guideText(steps.get(alsoId).step.title, hotkeys), text: guideText(steps.get(alsoId).step.tour ?? steps.get(alsoId).step.text, hotkeys), targets: TOUR_TARGETS[alsoId] ?? [] }
    : null;
  const read = isRead(id);
  const targets = [...(TOUR_TARGETS[id] ?? [])];
  if (warn) for (const t of LOW_POWER_TARGETS) if (!targets.includes(t)) targets.push(t);
  return {
    id,
    where: `Tour · ${chapter.title} · ${counted.indexOf(id) + 1} of ${counted.length}`,
    title: guideText(step.title, hotkeys),
    text: guideText(step.tour ?? step.text, hotkeys),
    watch: read ? 'Got it ticks it off, or opening this chapter in the Guide.' : `Ticks off by itself: ${step.watch}.`,
    read,
    dots: counted.map((s) => (done[s] === true ? 'done' : s === id ? 'active' : s === alsoId ? 'also' : 'open')),
    targets,
    also,
    warn,
    note: null,
    finale: false,
  };
}

/** The steps that tick off by themselves after the tour (passive and outside ones) still open. */
function leftOpen(progress, done) {
  return progress.content.stepIds.filter((id) => done[id] !== true && !progress.content.tourIds.includes(id)).length;
}

/** What the live region says when the tour is done; `asking`: the quick tips question shows. */
export function tourDoneText(progress, done = progress.done, asking = progress.finalePending(done)) {
  const n = leftOpen(progress, done);
  const rest =
    n === 0 ? '' : n === 1 ? ' The Guide (Esc) keeps the rest: 1 step ticks off by itself when it happens.' : ` The Guide (Esc) keeps the rest: ${n} steps tick off by themselves when they happen.`;
  return `Tour done.${asking ? ' Keep the quick tips? Two buttons on the tour card.' : ''}${rest}`;
}

export class TourCard {
  /**
   * @param {HTMLElement} field the battlefield (#field): the card sits in its bottom left, above the command bar
   * @param {{
   *   progress: import('./guide.js').GuideProgress,
   *   hotkeys?: import('./hotkeys.js').HotkeyRegistry,
   *   ctx?(): { available(id: string): boolean },  which steps this game has (GuideTracker.ctx; default every step)
   *   onGuide?(): void,  opens the game menu's Guide page
   *   cameos?(): Iterable<HTMLElement>,  the sidebar's cameos (default: every `.sb-card` of the page)
   *   setTimeout?, clearTimeout?
   * }} o
   */
  constructor(field, o) {
    this.o = o;
    this.progress = o.progress;
    // The page's timers are called on the window: as methods of another object
    // (`this.timers.set(...)`) browsers throw "Illegal invocation", and that
    // throw, from the GuideTracker inside js/main.js frameBody, stopped the game loop.
    this.timers = {
      set: o.setTimeout ?? ((fn, ms) => globalThis.setTimeout(fn, ms)),
      clear: o.clearTimeout ?? ((id) => globalThis.clearTimeout(id)),
    };
    this.toastTimer = null;
    this.lit = [];
    this.state = null;
    this.shownKey = null;
    // Whether the last state was on low power (the live region says it on the drop only).
    this.wasLow = false;
    // The note "nothing more in this game" closed: hidden for this game, the tour stays on.
    this.dismissed = false;
    this.root = el('section', 'tour');
    this.root.setAttribute('aria-label', 'Tour');
    // A click on the card is not a click on the map, and does not capture the mouse (js/mouselock.js).
    this.root.dataset.noCapture = '';
    for (const type of ['mousedown', 'pointerdown', 'contextmenu', 'wheel']) this.root.addEventListener(type, (e) => e.stopPropagation());
    this.card = el('div', 'tour-card');
    this.where = el('span', 'tour-where');
    this.close = button('', 'tour-close', () => this.skipTour());
    this.close.setAttribute('aria-label', 'Skip the tour');
    this.close.title = 'Skip the tour (the Guide turns it on again)';
    const head = el('div', 'tour-head');
    head.append(this.where, this.close);
    this.title = el('h2', 'tour-title');
    this.text = el('p', 'tour-text');
    this.also = el('p', 'tour-also');
    this.warn = el('p', 'tour-warn');
    this.watch = el('p', 'tour-watch');
    // The last card: the quick tips question.
    this.finale = el('div', 'tour-finale');
    this.finale.setAttribute('role', 'group');
    this.finale.setAttribute('aria-labelledby', 'tour-finale-title');
    const finaleTitle = el('h2', 'tour-title', 'Tour done');
    finaleTitle.id = 'tour-finale-title';
    const finaleText = el('p', 'tour-text', FINALE_TEXT);
    finaleText.id = 'tour-finale-text';
    const keep = button('Keep quick tips', 'ui-btn ui-btn-sm ui-btn-primary', () => this.answer(true));
    const off = button('Turn them off', 'ui-btn ui-btn-sm ui-btn-ghost', () => this.answer(false));
    for (const b of [keep, off]) b.setAttribute('aria-describedby', 'tour-finale-text');
    const finaleActions = el('div', 'tour-actions');
    finaleActions.append(keep, off);
    this.finale.append(finaleTitle, finaleText, finaleActions);
    this.dots = el('ol', 'tour-dots');
    this.dots.setAttribute('aria-label', 'Tour steps');
    const actions = el('div', 'tour-actions');
    this.skip = button('Skip step', 'ui-btn ui-btn-sm ui-btn-ghost', () => this.skipStep());
    this.guide = button('Full guide', 'ui-btn ui-btn-sm', () => o.onGuide?.());
    this.guide.hidden = !o.onGuide;
    actions.append(this.skip, this.guide);
    const foot = el('div', 'tour-foot');
    foot.append(this.dots, actions);
    this.card.append(head, this.title, this.text, this.also, this.warn, this.watch, this.finale, foot);
    // "Step done" and "Tour done": a polite live region that stays in place.
    this.toast = el('p', 'tour-toast');
    this.toast.setAttribute('role', 'status');
    this.toast.setAttribute('aria-live', 'polite');
    this.root.append(this.toast, this.card);
    field.append(this.root);
    this.off = this.progress.subscribe(() => this.render());
    this.render();
  }

  /** Whether the card shows now. */
  get shown() {
    return !this.card.hidden;
  }

  ctx() {
    return this.o.ctx?.() ?? EVERY_STEP;
  }

  model() {
    return this.progress.tourInGames ? tourModel(this.progress, this.ctx(), this.state, this.o.hotkeys) : null;
  }

  render() {
    if (this.disposed) return;
    let m = this.model();
    if (m?.note && this.dismissed) m = null;
    this.card.hidden = !m;
    this.root.classList.toggle('tour-idle', !m);
    this.light(m?.targets ?? [], m?.also?.targets ?? []);
    if (!m) {
      this.shownKey = null;
      return;
    }
    const key = this.o.hotkeys ? boundKey(this.o.hotkeys, 'menu') : null;
    const shownKey = JSON.stringify([m.id, m.where, m.title, m.text, m.watch, m.dots, m.also, m.warn, m.note, m.finale, key]);
    // Every state refresh draws the card: only when something changed.
    if (shownKey === this.shownKey) return;
    this.shownKey = shownKey;
    this.where.textContent = m.where;
    for (const e of [this.title, this.text, this.watch, this.dots]) e.hidden = m.finale;
    this.finale.hidden = !m.finale;
    this.title.textContent = m.title;
    this.text.textContent = m.text;
    this.watch.textContent = m.watch;
    this.watch.hidden = m.finale || !m.watch;
    this.also.hidden = !m.also;
    this.also.textContent = m.also?.text ?? '';
    this.warn.hidden = !m.warn;
    this.warn.textContent = m.warn ?? '';
    this.skip.hidden = m.finale || !!m.note;
    this.skip.textContent = m.read ? 'Got it' : 'Skip step';
    this.close.setAttribute('aria-label', m.note || m.finale ? 'Close' : 'Skip the tour');
    this.close.title = m.note
      ? 'Close (the tour goes on in your next skirmish)'
      : m.finale
        ? 'Close (the quick tips stay as they are)'
        : 'Skip the tour (the Guide turns it on again)';
    this.guide.textContent = `Full guide (${key ? `${key} or Esc` : 'Esc'})`;
    this.dots.hidden = m.finale || !m.dots.length;
    this.dots.replaceChildren(
      ...m.dots.map((state, i) => {
        const li = el('li', `tour-dot tour-dot-${state}`);
        li.textContent = `Step ${i + 1}: ${state === 'done' ? 'done' : state === 'active' ? 'now' : state === 'also' ? 'also now' : 'to do'}`;
        if (state === 'active') li.setAttribute('aria-current', 'step');
        return li;
      }),
    );
  }

  /** Light the sidebar's cameos of the step and the "Also" step (again on every refresh: the sidebar makes its cards when they first show). */
  light(ids, alsoIds = []) {
    for (const c of this.lit) c.classList.remove(TARGET_CLASS, ALSO_CLASS);
    this.lit = [];
    if (!ids.length && !alsoIds.length) return;
    const cards = this.o.cameos ? this.o.cameos() : (this.root.ownerDocument?.querySelectorAll?.('.sb-card') ?? []);
    for (const c of cards) {
      const id = c.dataset?.id;
      if (ids.includes(id)) c.classList.add(TARGET_CLASS);
      else if (alsoIds.includes(id)) c.classList.add(TARGET_CLASS, ALSO_CLASS);
      else continue;
      this.lit.push(c);
    }
  }

  /**
   * Every state refresh of the game (100 ms): the low power line, which steps
   * this game has, and the cameos, which come and go with the sidebar's tabs.
   * The live region says the low power line once each time the power drops,
   * not again while it stays low.
   */
  refresh(state = null) {
    if (this.disposed) return;
    this.state = state;
    this.render();
    const low = state?.lowPower === true;
    if (low && !this.wasLow && this.shown && !this.warn.hidden) this.say(LOW_POWER_WARNING);
    this.wasLow = low;
  }

  /** Steps the game just ticked off (GuideTracker onDone, in the order they ticked): "Step done", "already done", "Chapter done", "Tour done". */
  stepsDone(ids) {
    if (this.disposed || !this.progress.tourInGames) return;
    const mine = ids.filter((id) => this.progress.content.tourIds.includes(id));
    if (mine.length) this.announce(mine, false);
  }

  /** One line in the live region for steps that just ticked (`skipped`: by hand, no "Step done"). */
  announce(ids, skipped) {
    const { progress } = this;
    const done = progress.done;
    if (progress.tourComplete(done)) {
      this.say(tourDoneText(progress, done));
      return;
    }
    const chapters = [...new Set(ids.map((id) => chapterOf(progress, id)))].filter((c) => progress.tourStepsOf(c).every((s) => done[s] === true));
    const rest = ids.filter((id) => !chapters.includes(chapterOf(progress, id)));
    const parts = [];
    if (chapters.length) parts.push(`Chapter done: ${chapters.map((c) => c.title).join(', ')}.`);
    if (!skipped) {
      rest.forEach((id, i) => {
        const { watch } = progress.content.steps.get(id).step;
        parts.push(i === 0 && !chapters.length ? `Step done: ${watch}.` : `${watch} (already done).`);
      });
    }
    if (parts.length) this.say(parts.join(' '));
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

  /** Skip step, or Got it for a step that only explains: the step shown is done. */
  skipStep() {
    const id = this.progress.tourStep(this.ctx());
    if (!id) return;
    const fresh = this.progress.mark([id]);
    if (fresh.length) this.announce(fresh, true);
  }

  /** The quick tips question answered: keep them (true) or turn them off (false). */
  answer(keep) {
    this.progress.answerQuickTips(keep);
    this.say(keep ? 'Quick tips stay on.' : 'Quick tips off. Settings, Game turns them on again.');
  }

  skipTour() {
    const m = this.model();
    if (m?.note) {
      // Nothing more in this game: close the card, the tour goes on in the next skirmish.
      this.dismissed = true;
      this.render();
      return;
    }
    if (m?.finale) {
      // Closing the question is no answer to change a setting for: the quick tips stay as they are.
      // The tour is done, not skipped: the switch stays on, so tour steps of later versions still come.
      this.progress.answerQuickTips(null);
      this.say('Quick tips stay as they are. Settings, Game has them.');
      return;
    }
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
