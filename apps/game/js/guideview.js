// The game menu's Guide page (design board Guide): the chapters on the left
// with a lamp each (all steps done, some, none), the chosen chapter's steps
// with what ticks each off ("Watching: ..."), Skip this step for the open
// one, the chapter's tip, Previous and Next chapter, the progress and the
// "Tour in my games" switch (js/guide.js GuideProgress). Showing a chapter
// ticks off its steps that only explain. Texts: js/help.js GUIDE.

import { GUIDE } from './help.js';
import { guideText, readSteps, stepStatus } from './guide.js';
import { led, toggle } from './ui/controls.js';

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

/**
 * Draw the Guide page into `c` with chapter `chapterId` open; returns the
 * chapter shown. `o.onChapter(id)` switches chapters, `o.onBack()` goes back
 * to the menu. The caller draws the page again when the progress changes.
 * @param {HTMLElement} c
 * @param {{ progress: import('./guide.js').GuideProgress, hotkeys?: object, chapter?: string,
 *   onChapter(id: string): void, onBack(): void }} o
 */
export function renderGuide(c, o) {
  const { progress } = o;
  const chapter = GUIDE.find((x) => x.id === o.chapter) ?? GUIDE.find((x) => progress.firstOpen(x.id)) ?? GUIDE[0];
  // Reading the chapter is what its explaining steps ask for.
  progress.mark(readSteps(chapter.id));

  const head = el('div', 'gm-head');
  const back = button('', 'ui-btn ui-btn-icon gm-back', () => o.onBack());
  back.setAttribute('aria-label', 'Back to the game menu');
  const title = el('div', 'gm-title-row');
  title.append(back, el('h1', 'gm-title', 'Guide'));
  const side = el('div', 'guide-progress');
  const count = el('span', 'guide-count ui-num', progressText(progress));
  const tour = toggle({
    id: 'guide-tour-in-games',
    label: 'Tour in my games',
    hint: 'Steps tick off as you play. The tour starts by itself in your skirmish games.',
    checked: progress.tourInGames,
    rowClass: 'guide-tour-switch',
    onChange: (on) => progress.setTourInGames(on),
  });
  side.append(count, tour.row);
  head.append(title, side);

  const body = el('div', 'guide-body');
  const nav = el('nav', 'guide-chapters');
  nav.setAttribute('aria-label', 'Chapters');
  const list = el('ol', 'guide-chapter-list');
  GUIDE.forEach((ch, i) => {
    const p = progress.chapter(ch.id);
    const b = button('', 'guide-chapter', () => o.onChapter(ch.id));
    b.id = `guide-chapter-${ch.id}`;
    if (ch.id === chapter.id) b.setAttribute('aria-current', 'step');
    const state = chapterLamp(p);
    b.append(el('span', 'guide-chapter-n ui-num', String(i + 1)), el('span', 'guide-chapter-title', ch.title), led(state, `${p.done} of ${p.total} done`));
    const li = el('li');
    li.append(b);
    list.append(li);
  });
  nav.append(list);

  const index = GUIDE.indexOf(chapter);
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
    text.append(el('h3', 'guide-step-title', guideText(s.title, o.hotkeys)), el('p', 'guide-step-body', guideText(s.text, o.hotkeys)));
    const status = el('div', 'guide-step-status');
    const line = el('span', 'guide-step-watch');
    line.append(led(isDone ? 'ok' : active ? 'on' : 'off'), el('span', null, stepStatus(s.id, { done: isDone, active })));
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
  const prev = button('Previous', 'ui-btn ui-btn-ghost', () => o.onChapter(GUIDE[index - 1].id));
  prev.disabled = index === 0;
  const next = button('Next chapter', 'ui-btn ui-btn-primary', () => o.onChapter(GUIDE[index + 1].id));
  next.disabled = index === GUIDE.length - 1;
  pager.append(prev, next);
  main.append(pager);

  body.append(nav, main);
  c.append(head, body);
  return chapter.id;
}
