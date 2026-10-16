// The game menu's Guide page (design board Guide): the chapters on the left
// with a lamp each (all steps done, some, none), the chosen chapter's steps
// with what ticks each off ("Watching: ..."), Skip this step for the open
// one, the chapter's tip, Previous and Next chapter, the progress and the
// "Tour in my games" switch (js/guide.js GuideProgress), with Take the tour
// again once it is done, and Reset guide progress (the menu asks first). Showing a chapter ticks off its steps that only
// explain, in order: one waits for the steps before it. Steps a later version added since the player last opened the
// Guide carry a "New" badge, their chapters the count (js/gamemenu.js takes
// them when the page opens and marks them seen). Texts: js/help.js GUIDE.

import { guideText, stepStatus } from './guide.js';
import { badge, led, toggle } from './ui/controls.js';

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

/** The lamp of a chapter: every step done (ok), some (warn), none (off). */
export function chapterLamp({ done, total }) {
  if (total > 0 && done === total) return 'ok';
  return done > 0 ? 'warn' : 'off';
}

/** "3 of 28 steps done". */
export function progressText(progress) {
  return `${progress.count()} of ${progress.total} steps done`;
}

/** The "New" badge of a step, or of a chapter with `n` new steps. */
export function newBadge(n = 1) {
  return badge('info', n === 1 ? 'New' : `${n} new`, { title: n === 1 ? 'Added since you last opened the guide' : `${n} steps added since you last opened the guide` });
}

/**
 * Draw the Guide page into `c` with chapter `chapterId` open; returns the
 * chapter shown. `o.onChapter(id)` switches chapters, `o.onBack()` goes back
 * to the menu, `o.onReset()` asks to reset the progress, `o.fresh` holds the
 * step ids shown as new. The caller draws
 * the page again when the progress changes.
 * @param {HTMLElement} c
 * @param {{ progress: import('./guide.js').GuideProgress, hotkeys?: object, chapter?: string,
 *   fresh?: Set<string>, onChapter(id: string): void, onBack(): void, onReset?(): void }} o
 */
export function renderGuide(c, o) {
  const { progress } = o;
  const { chapters } = progress.content;
  const fresh = o.fresh ?? new Set();
  // The chapter asked for, else the first with a new step, else the first with an open step.
  const chapter =
    chapters.find((x) => x.id === o.chapter) ??
    chapters.find((x) => x.steps.some((s) => fresh.has(s.id))) ??
    chapters.find((x) => progress.firstOpen(x.id)) ??
    chapters[0];
  // Reading the chapter is what its explaining steps ask for: in order, each once the steps before it are done.
  progress.markRead(chapter.id);

  const head = el('div', 'gm-head');
  const back = button('', 'ui-btn ui-btn-icon gm-back', () => o.onBack());
  back.setAttribute('aria-label', 'Back to the game menu');
  const title = el('div', 'gm-title-row');
  title.append(back, el('h1', 'gm-title', 'Guide'));
  const side = el('div', 'guide-progress');
  const count = el('span', 'guide-count ui-num', progressText(progress));
  const finished = progress.tourComplete();
  const tour = toggle({
    id: 'guide-tour-in-games',
    label: 'Tour in my games',
    hint: finished
      ? 'Tour done. Steps that later versions add to it start by themselves in your skirmish games.'
      : 'Steps tick off as you play. The tour starts by itself in your skirmish games.',
    checked: progress.tourInGames,
    rowClass: 'guide-tour-switch',
    onChange: (on) => progress.setTourInGames(on),
  });
  side.append(count, tour.row);
  if (finished) side.append(button('Take the tour again', 'ui-btn ui-btn-sm ui-btn-ghost guide-tour-again', () => progress.restartTour()));
  // Everything over again, after the menu's confirm step (o.onReset): only when there is progress to lose.
  if (o.onReset && progress.started) side.append(button('Reset guide progress', 'ui-btn ui-btn-sm ui-btn-ghost guide-reset', () => o.onReset()));
  head.append(title, side);

  const body = el('div', 'guide-body');
  const nav = el('nav', 'guide-chapters');
  nav.setAttribute('aria-label', 'Chapters');
  const list = el('ol', 'guide-chapter-list');
  chapters.forEach((ch, i) => {
    const p = progress.chapter(ch.id);
    const b = button('', 'guide-chapter', () => o.onChapter(ch.id));
    b.id = `guide-chapter-${ch.id}`;
    if (ch.id === chapter.id) b.setAttribute('aria-current', 'step');
    const state = chapterLamp(p);
    const name = el('span', 'guide-chapter-title', ch.title);
    const n = ch.steps.filter((s) => fresh.has(s.id)).length;
    if (n) name.append(' ', newBadge(n));
    b.append(el('span', 'guide-chapter-n ui-num', String(i + 1)), name, led(state, `${p.done} of ${p.total} done`));
    const li = el('li');
    li.append(b);
    list.append(li);
  });
  nav.append(list);

  const index = chapters.indexOf(chapter);
  const main = el('section', 'guide-chapter-body');
  main.setAttribute('aria-labelledby', 'guide-chapter-title');
  const heading = el('h2', 'guide-chapter-heading');
  heading.id = 'guide-chapter-title';
  heading.append(el('span', 'guide-eyebrow', `Chapter ${index + 1}`), el('span', null, chapter.title));
  main.append(heading, el('p', 'guide-intro', chapter.intro));

  const steps = el('ol', 'guide-steps');
  const done = progress.done;
  const open = progress.firstOpen(chapter.id);
  chapter.steps.forEach((s, i) => {
    const isDone = done[s.id] === true;
    const active = s.id === open;
    const li = el('li', `guide-step${isDone ? ' guide-step-done' : ''}${active ? ' guide-step-active' : ''}`);
    li.dataset.step = s.id;
    if (active) li.setAttribute('aria-current', 'step');
    const n = el('span', 'guide-step-n ui-num', isDone ? '✓' : String(i + 1));
    n.setAttribute('aria-hidden', 'true');
    const text = el('div', 'guide-step-text');
    const title = el('h3', 'guide-step-title', guideText(s.title, o.hotkeys));
    if (fresh.has(s.id)) {
      li.classList.add('guide-step-new');
      title.append(' ', newBadge());
    }
    text.append(title, el('p', 'guide-step-body', guideText(s.text, o.hotkeys)));
    const status = el('div', 'guide-step-status');
    const line = el('span', 'guide-step-watch');
    line.append(led(isDone ? 'ok' : active ? 'on' : 'off'), el('span', null, stepStatus(s.id, { done: isDone, active }, progress.content)));
    status.append(line);
    if (active) status.append(button('Skip this step', 'ui-btn ui-btn-sm ui-btn-ghost', () => progress.mark([s.id])));
    li.append(n, text, status);
    steps.append(li);
  });
  main.append(steps);
  if (chapter.tip) {
    const tip = el('p', 'guide-tip');
    tip.append(el('span', 'guide-tip-label', 'Tip'), el('span', null, chapter.tip));
    main.append(tip);
  }
  const pager = el('div', 'guide-pager');
  const prev = button('Previous', 'ui-btn ui-btn-ghost', () => o.onChapter(chapters[index - 1].id));
  prev.disabled = index === 0;
  const next = button('Next chapter', 'ui-btn ui-btn-primary', () => o.onChapter(chapters[index + 1].id));
  next.disabled = index === chapters.length - 1;
  pager.append(prev, next);
  main.append(pager);

  body.append(nav, main);
  c.append(head, body);
  return chapter.id;
}
