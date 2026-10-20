// The campaign screen: OpenRA's mission browser for the Red Alert campaign.
// Campaigns (Allied, Soviet, the expansions, OpenRA's own and the ant
// missions) as tabs on the left with how many missions are won and their
// missions, which ones are won, which one comes next and which are still
// locked (js/campaign/progress.js); the chosen mission's briefing, map
// preview and briefing movie on the right, with its options (difficulty and
// game speed) and Play below them.
//
// The objectives are not shown here (a design decision, docs/contracts.md
// "Campaign screen and progress"): the mission scripts only set them while
// the mission runs.
//
// The mission list is apps/game/missions/index.json (tools/gen_missions.py);
// a mission file is fetched when it is chosen, for its map preview, and again
// (from the browser cache) when it starts.

import { campaignNext, campaignStates, chapterOf, missionStatus } from './progress.js';
import { infoTip } from '../infotip.js';
import { HELP } from '../help.js';
import { GAME_SPEEDS } from '../../protocol/constants.js';
import { led, segmented, selectPlate, tabs } from '../ui/controls.js';
import { controlOwnsKey } from '../ownkeys.js';

/** Help texts the campaign screen shows (js/help.js): the screen, mission options (`mission.<key>`), the game speed. */
export const CAMPAIGN_HELP_KEYS = Object.freeze(['campaign', 'mission.difficulty', 'gameSpeed']);

/** Game speeds as the lobby names them. */
const SPEED_LABELS = { slowest: 'Slowest', slower: 'Slower', normal: 'Normal', fast: 'Fast', faster: 'Faster', fastest: 'Fastest' };

/** A mission option with this many values or fewer is a row of buttons (segmented); more open a list. */
export const SEGMENTED_MAX = 5;

/** The lamp of each mission status: lit for won and next, dark for open and locked (the word is the second signal). */
const STATUS_LED = { won: 'ok', next: 'on', open: 'off', locked: 'off' };

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

/** "Hard" for a mission's chosen value of option `key`, from its index entry. */
export function optionLabel(entry, key, value) {
  const o = entry.options?.[key];
  return o?.values.find(([v]) => v === value)?.[1] ?? value;
}

/**
 * What the list says about a mission: "Won on Hard", "Won", "Next", "Locked"
 * or "" (open). `next` is the mission marked NEXT (campaignNext), or null.
 */
export function stateText(state, next = null) {
  if (state.won !== null) return state.won ? `Won on ${optionLabel(state.mission, 'difficulty', state.won)}` : 'Won';
  const status = missionStatus(state, next);
  return status === 'locked' ? 'Locked' : status === 'next' ? 'Next' : '';
}

/**
 * A mission title split for the list: its number ("03a: Dead End" -> "03a")
 * and name; an unnumbered one gets its place in the list (`at`, from 0).
 */
export function missionLabel(title, at) {
  const m = /^(\d+[a-z]?):\s*(.*)$/i.exec(String(title ?? ''));
  if (m && m[2]) return { number: m[1], name: m[2] };
  return { number: String(at + 1).padStart(2, '0'), name: String(title ?? '') };
}

/** "4 / 14 won" and the share for the bar (0..1). */
export function campaignCount(campaign, progress) {
  const won = campaign.missions.filter((m) => typeof progress[m.id] === 'string').length;
  const total = campaign.missions.length;
  return { won, total, text: `${won} / ${total} won`, share: total ? won / total : 0 };
}

/** The line above the mission's name: its side and chapter ("Allied mission, chapter 3"). */
export function missionKicker(entry) {
  const side = entry.faction === 'soviet' ? 'Soviet mission' : 'Allied mission';
  const chapter = chapterOf(entry.title);
  return chapter === null ? side : `${side}, chapter ${chapter}`;
}

export class CampaignMenu {
  /**
   * @param {HTMLElement} root the #campaign-root section
   * @param {{
   *   index(): Promise<object>,  apps/game/missions/index.json
   *   missionText(entry: object): Promise<string>,  a mission file's text (checked against entry.sha256)
   *   preview(text: string): { rgba: Uint8Array, width: number, height: number } | null,
   *   progress: import('./progress.js').CampaignProgress,
   *   onPlay(entry: object, options: Record<string, string>, gameSpeed: string): void,
   *   onClose?(): void,
   *   lens?: () => import('../maplens/lens.js').MapLens,  a magnifier over the mission's map (js/maplens)
   *   movies?: { has(file: string): boolean, play(file: string, parent: HTMLElement): Promise<string>,
   *     subscribe?(fn: () => void): void } | null,
   *     the original movies the player installed (js/content/movies.js createMoviePlayer, and the content
   *     system's changes): the briefing movie plays from here; without it the screen says nothing about movies
   *   onInstallContent?(): void,  open the original content dialog (js/content/panel.js)
   * }} ctx
   */
  constructor(root, ctx) {
    this.root = root;
    this.ctx = ctx;
    this.data = null;
    this.campaign = 0;
    this.selected = null;
    /** Chosen option values per mission id (difficulty), for this page. */
    this.choices = new Map();
    this.gameSpeed = 'normal';
    this.previewToken = 0;
    /** The open select of the screen (its list lives in the top layer), closed with the screen. */
    this.plates = [];
    /** The magnifier over the mission's map, or null. */
    this.lens = ctx.lens?.() ?? null;
    root.hidden = true;
    root.addEventListener('keydown', (e) => {
      // An open select list keeps its Esc (js/ownkeys.js); from the tabs Esc closes the screen.
      if (e.key === 'Escape' && !e.defaultPrevented && !controlOwnsKey(e.target)) {
        e.preventDefault();
        this.close();
      }
    });
    ctx.progress.subscribe(() => {
      if (!this.root.hidden) this.render();
    });
    // A movie installed (or removed) from the content dialog over this screen.
    ctx.movies?.subscribe?.(() => {
      if (!this.root.hidden && this.data) this.render();
    });
  }

  get isOpen() {
    return !this.root.hidden;
  }

  /** Show the screen, at mission `id` when given. */
  async open(id = null) {
    this.root.hidden = false;
    this.root.replaceChildren(el('p', 'campaign-loading', 'Loading the campaign...'));
    try {
      this.data ??= await this.ctx.index();
    } catch (err) {
      this.root.replaceChildren(this.page(el('p', 'campaign-error', `The missions could not be loaded: ${err.message ?? err}`)));
      return;
    }
    const at = id ? this.data.campaigns.findIndex((c) => c.missions.some((m) => m.id === id)) : -1;
    if (at >= 0) {
      this.campaign = at;
      this.selected = id;
    }
    this.selected ??= this.firstOpen(this.campaign);
    this.render();
    this.root.querySelector('.campaign-mission[aria-current="true"]')?.focus({ preventScroll: true });
  }

  close() {
    if (this.root.hidden) return;
    this.dropPlates();
    this.root.hidden = true;
    this.root.replaceChildren();
    // The preview is gone: so is its lens, and the mission's map it read.
    this.lens?.detach();
    this.lens?.clearSource();
    this.ctx.onClose?.();
  }

  /** The mission NEXT points at in campaign `k`, else its first open one (else its first). */
  firstOpen(k) {
    const campaign = this.data.campaigns[k];
    const progress = this.ctx.progress.get();
    const next = campaignNext(campaign, progress);
    if (next) return next.id;
    const states = campaignStates(campaign, progress);
    return (states.find((s) => s.open) ?? states[0])?.mission.id ?? null;
  }

  page(...children) {
    const page = el('div', 'campaign-page');
    page.setAttribute('role', 'dialog');
    page.setAttribute('aria-modal', 'true');
    page.setAttribute('aria-labelledby', 'campaign-title');
    const head = el('header', 'campaign-head');
    const title = el('h1', 'campaign-title', 'Campaign');
    title.id = 'campaign-title';
    head.append(title, infoTip('campaign', { label: 'Campaign' }).root, button('Back', 'ui-btn campaign-back', () => this.close()));
    page.append(head, ...children);
    return page;
  }

  /** Close the lists of the selects of the last render (their popovers outlive the replaced page). */
  dropPlates() {
    for (const p of this.plates) p.destroy();
    this.plates = [];
  }

  render() {
    this.dropPlates();
    const progress = this.ctx.progress.get();
    const campaigns = this.data.campaigns;
    const current = campaigns[this.campaign];

    const left = el('section', 'campaign-left');
    left.setAttribute('aria-label', 'Missions');
    // The chosen campaign's tab panel: its count, bar and missions.
    const panel = el('div', 'campaign-panel');
    const list = el('ol', 'campaign-missions');
    const tabRow = tabs({
      id: 'campaign-tabs',
      label: 'Campaigns',
      value: String(this.campaign),
      tabs: campaigns.map((c, k) => ({
        id: String(k),
        label: c.name,
        title: `${campaignCount(c, progress).won} of ${c.missions.length} missions won`,
        panel: k === this.campaign ? panel : undefined,
      })),
      onChange: (id) => {
        this.campaign = Number(id);
        this.selected = this.firstOpen(this.campaign);
        this.render();
        this.root.querySelector(`#campaign-tabs-${id}`)?.focus({ preventScroll: true });
      },
    });
    tabRow.root.classList.add('campaign-tabs');
    for (const b of tabRow.buttons.values()) b.classList.add('campaign-tab');

    const count = campaignCount(current, progress);
    const summary = el('div', 'campaign-count');
    summary.append(el('span', 'campaign-count-name', current.name), el('span', 'campaign-count-value ui-num', count.text));
    const bar = el('div', 'campaign-progress ui-progress');
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-label', `${current.name}: missions won`);
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', String(count.total));
    bar.setAttribute('aria-valuenow', String(count.won));
    bar.setAttribute('aria-valuetext', `${count.won} of ${count.total} won`);
    bar.style.setProperty('--ui-progress', `${Math.round(count.share * 1000) / 10}%`);

    const next = campaignNext(current, progress);
    const states = campaignStates(current, progress);
    states.forEach((s, k) => {
      const item = el('li');
      const status = missionStatus(s, next);
      const b = button('', 'campaign-mission', () => {
        this.selected = s.mission.id;
        this.render();
        this.root.querySelector('.campaign-mission[aria-current="true"]')?.focus({ preventScroll: true });
      });
      b.setAttribute('aria-current', String(s.mission.id === this.selected));
      b.dataset.state = status;
      const label = missionLabel(s.mission.title, k);
      const word = el('span', 'campaign-mission-state');
      word.append(led(STATUS_LED[status]), el('span', null, stateText(s, next)));
      b.append(el('span', 'campaign-mission-number ui-num', label.number), el('span', 'campaign-mission-title', label.name), word);
      item.append(b);
      list.append(item);
    });
    panel.append(summary, bar, list);
    left.append(tabRow.root, panel);

    const state = states.find((s) => s.mission.id === this.selected) ?? states[0];
    const body = el('div', 'campaign-body');
    body.append(left, state ? this.details(state, missionStatus(state, next)) : el('div'));
    this.root.replaceChildren(this.page(body));
  }

  /** The chosen mission: briefing, preview and movie, options and Play. */
  details(state, status) {
    const entry = state.mission;
    const box = el('section', 'campaign-details');
    box.setAttribute('aria-label', 'Briefing');
    const stripe = el('div', 'campaign-stripe ui-hazard');
    stripe.setAttribute('aria-hidden', 'true');

    const text = el('div', 'campaign-text');
    const title = el('h2', 'campaign-mission-name', entry.title);
    const briefing = el('p', 'campaign-briefing', entry.briefing || 'No briefing.');
    text.append(el('p', 'campaign-kicker', missionKicker(entry)), title, briefing);

    const media = el('div', 'campaign-media');
    const frame = el('div', 'campaign-frame');
    const canvas = el('canvas', 'campaign-preview');
    canvas.width = 1;
    canvas.height = 1;
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', `Map of ${entry.title}`);
    const caption = el('p', 'campaign-caption', 'Map preview');
    this.lens?.attach(canvas);
    this.lens?.clearSource();
    this.drawPreview(entry, canvas, caption);
    frame.append(canvas);
    const movie = this.movieNote(entry);
    if (movie) frame.append(movie);
    media.append(frame, caption);

    const brief = el('div', 'campaign-brief');
    brief.append(text, media);

    const launch = el('div', 'campaign-launch');
    const options = el('div', 'campaign-options');
    const chosen = this.choices.get(entry.id) ?? {};
    for (const [key, o] of Object.entries(entry.options ?? {})) {
      const value = chosen[key] ?? (state.won && key === 'difficulty' && o.values.some(([v]) => v === state.won) ? state.won : o.default);
      const pick = (v) => this.choices.set(entry.id, { ...(this.choices.get(entry.id) ?? {}), [key]: v });
      options.append(this.optionField(`campaign-opt-${key}`, o.label, o.values.map(([v, label]) => ({ value: v, label })), value, pick, Object.hasOwn(HELP, `mission.${key}`) ? `mission.${key}` : null));
    }
    const speeds = GAME_SPEEDS.map((v) => ({ value: v, label: SPEED_LABELS[v] ?? v }));
    options.append(this.optionField('campaign-speed', 'Game speed', speeds, this.gameSpeed, (v) => (this.gameSpeed = v), 'gameSpeed'));

    const play = button('Play mission', 'ui-btn ui-btn-primary campaign-play', () => {
      if (state.open) this.ctx.onPlay(entry, this.optionsOf(entry), this.gameSpeed);
    });
    play.disabled = !state.open;
    const note = state.open ? null : el('p', 'campaign-muted campaign-locked-note', 'Locked: win a mission of the chapter before this one to open it.');
    if (note) {
      note.id = 'campaign-locked-note';
      play.setAttribute('aria-describedby', note.id);
    }
    const go = el('div', 'campaign-go');
    go.append(...(note ? [note] : []), play);
    launch.append(options, go);
    box.dataset.state = status;
    box.append(stripe, brief, launch);
    return box;
  }

  /**
   * One option: a row of buttons for up to SEGMENTED_MAX values (the board's
   * look), else a select. `help`: the js/help.js key of its "?" button.
   */
  optionField(id, label, options, value, onChange, help) {
    const field = el('div', 'campaign-field');
    const name = el('span', 'campaign-field-label ui-caps', label);
    name.id = `${id}-label`;
    const head = el('div', 'campaign-field-head');
    head.append(name);
    let control;
    let describes;
    if (options.length >= 2 && options.length <= SEGMENTED_MAX) {
      const seg = segmented({ name: id, id, label, options, value, onChange });
      seg.root.classList.add('campaign-segmented');
      seg.root.dataset.option = id;
      control = seg.root;
      describes = seg.root;
    } else {
      const plate = selectPlate({ id, label, labelledBy: name.id, options, value, onChange });
      plate.root.classList.add('campaign-plate');
      plate.root.dataset.option = id;
      this.plates.push(plate);
      control = plate.root;
      describes = plate.button;
    }
    if (help) head.append(infoTip(help, { label, describes }).root);
    field.append(head, control);
    return field;
  }

  /**
   * The briefing movie over the preview: Watch when the player installed it,
   * else "Original movie not installed" with the way to install it. Null when
   * the mission has none or the game has no content system.
   */
  movieNote(entry) {
    const file = entry.videos?.briefing;
    const movies = this.ctx.movies;
    if (!file || !movies) return null;
    const note = el('div', 'campaign-movie');
    if (movies.has(file)) {
      note.dataset.state = 'installed';
      const watch = button('Watch the briefing', 'ui-btn ui-btn-sm campaign-watch', () => {
        // The movie plays over everything; focus comes back here when it ends or is skipped.
        movies
          .play(file, document.body)
          .catch(() => {})
          .then(() => watch.isConnected && watch.focus({ preventScroll: true }));
      });
      watch.prepend(led('ok'));
      note.append(watch);
    } else {
      note.dataset.state = 'missing';
      note.append(el('span', 'campaign-movie-text', 'Original movie not installed'));
      if (this.ctx.onInstallContent) note.append(button('Install from your own copy', 'ui-btn ui-btn-ghost ui-btn-sm campaign-install', () => this.ctx.onInstallContent()));
    }
    return note;
  }

  /** The option values chosen for `entry` (the screen's choices, else what it shows: a won difficulty, else the default). */
  optionsOf(entry) {
    const out = {};
    const chosen = this.choices.get(entry.id) ?? {};
    const won = this.ctx.progress.get()[entry.id];
    for (const [key, o] of Object.entries(entry.options ?? {})) {
      const has = (v) => o.values.some(([x]) => x === v);
      out[key] = has(chosen[key]) ? chosen[key] : key === 'difficulty' && has(won) ? won : o.default;
    }
    return out;
  }

  /** Draw the mission's map (one pixel per cell, scaled up crisp) once its file is here. */
  async drawPreview(entry, canvas, caption) {
    const token = ++this.previewToken;
    try {
      const text = await this.ctx.missionText(entry);
      if (token !== this.previewToken) return;
      const p = this.ctx.preview(text);
      if (!p) return;
      canvas.width = p.width;
      canvas.height = p.height;
      canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(p.rgba), p.width, p.height), 0, 0);
      canvas.style.setProperty('aspect-ratio', `${p.width} / ${p.height}`);
      caption.textContent = `Map preview: ${p.width} x ${p.height} cells`;
      // The lens shows the mission as it starts: its map with the mission's actors.
      this.lens?.setSource(`mission:${entry.id}:${entry.sha256}`, (art) => art.missionSteps(text), { width: p.width, height: p.height });
    } catch (err) {
      if (token === this.previewToken) canvas.replaceWith(el('p', 'campaign-error', `The mission could not be loaded: ${err.message ?? err}`));
    }
  }
}
