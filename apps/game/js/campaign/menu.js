// The campaign screen: OpenRA's mission browser for the Red Alert campaign.
// Campaigns (Allied, Soviet, the expansions, OpenRA's own and the ant
// missions) on the left with their missions, which ones are won and which
// are still closed (js/campaign/progress.js); the chosen mission's map
// preview, briefing and options (difficulty) on the right, and Play.
//
// The mission list is apps/game/missions/index.json (tools/gen_missions.py);
// a mission file is fetched when it is chosen, for its map preview, and again
// (from the browser cache) when it starts.

import { campaignStates } from './progress.js';
import { infoTip } from '../infotip.js';
import { HELP } from '../help.js';
import { GAME_SPEEDS } from '../../protocol/constants.js';

/** Help texts the campaign screen shows (js/help.js): the screen, mission options (`mission.<key>`), the game speed. */
export const CAMPAIGN_HELP_KEYS = Object.freeze(['campaign', 'mission.difficulty', 'gameSpeed']);

/** Game speeds as the lobby names them. */
const SPEED_LABELS = { slowest: 'Slowest', slower: 'Slower', normal: 'Normal', fast: 'Fast', faster: 'Faster', fastest: 'Fastest' };

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

/** What the list says about a mission: "Won on Hard", "Won", "Closed" or "". */
export function stateText(state) {
  if (state.won !== null) return state.won ? `Won on ${optionLabel(state.mission, 'difficulty', state.won)}` : 'Won';
  return state.open ? '' : 'Closed';
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
    /** The magnifier over the mission's map, or null. */
    this.lens = ctx.lens?.() ?? null;
    root.hidden = true;
    root.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        this.close();
      }
    });
    ctx.progress.subscribe(() => {
      if (!this.root.hidden) this.render();
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
    this.root.hidden = true;
    this.root.replaceChildren();
    // The preview is gone: so is its lens, and the mission's map it read.
    this.lens?.detach();
    this.lens?.clearSource();
    this.ctx.onClose?.();
  }

  /** The first open mission not won yet of campaign `k` (else its first). */
  firstOpen(k) {
    const states = campaignStates(this.data.campaigns[k], this.ctx.progress.get());
    return (states.find((s) => s.open && s.won === null) ?? states[0])?.mission.id ?? null;
  }

  page(...children) {
    const page = el('div', 'campaign-page');
    page.setAttribute('role', 'dialog');
    page.setAttribute('aria-modal', 'true');
    page.setAttribute('aria-labelledby', 'campaign-title');
    const head = el('header', 'campaign-head');
    const title = el('h1', 'campaign-title', 'Campaign');
    title.id = 'campaign-title';
    head.append(title, infoTip('campaign', { label: 'Campaign' }).root, button('Back', 'campaign-btn', () => this.close()));
    page.append(head, ...children);
    return page;
  }

  render() {
    const progress = this.ctx.progress.get();
    const campaigns = this.data.campaigns;
    const tabs = el('div', 'campaign-tabs');
    tabs.setAttribute('role', 'tablist');
    campaigns.forEach((c, k) => {
      const won = c.missions.filter((m) => typeof progress[m.id] === 'string').length;
      const tab = button(c.name, 'campaign-tab', () => {
        this.campaign = k;
        this.selected = this.firstOpen(k);
        this.render();
      });
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', String(k === this.campaign));
      tab.title = `${won} of ${c.missions.length} missions won`;
      tabs.append(tab);
    });

    const states = campaignStates(campaigns[this.campaign], progress);
    const list = el('ol', 'campaign-missions');
    for (const s of states) {
      const item = el('li');
      const b = button('', 'campaign-mission', () => {
        this.selected = s.mission.id;
        this.render();
      });
      b.setAttribute('aria-current', String(s.mission.id === this.selected));
      b.dataset.state = s.won !== null ? 'won' : s.open ? 'open' : 'closed';
      b.append(el('span', 'campaign-mission-title', s.mission.title), el('span', 'campaign-mission-state', stateText(s)));
      item.append(b);
      list.append(item);
    }

    const state = states.find((s) => s.mission.id === this.selected) ?? states[0];
    const body = el('div', 'campaign-body');
    body.append(el('div', 'campaign-left'), state ? this.details(state) : el('div'));
    body.firstChild.append(tabs, list);
    this.root.replaceChildren(this.page(body));
  }

  /** The chosen mission: preview, briefing, options and Play. */
  details(state) {
    const entry = state.mission;
    const box = el('section', 'campaign-details');
    const canvas = el('canvas', 'campaign-preview');
    canvas.width = 1;
    canvas.height = 1;
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', `Map of ${entry.title}`);
    this.lens?.attach(canvas);
    this.lens?.clearSource();
    this.drawPreview(entry, canvas);
    const title = el('h2', 'campaign-mission-name', entry.title);
    const side = el('p', 'campaign-muted', entry.faction === 'soviet' ? 'Soviet mission' : 'Allied mission');
    const briefing = el('p', 'campaign-briefing', entry.briefing || 'No briefing.');

    const options = el('div', 'campaign-options');
    const chosen = this.choices.get(entry.id) ?? {};
    for (const [key, o] of Object.entries(entry.options ?? {})) {
      const field = el('label', 'campaign-field');
      field.append(el('span', null, o.label));
      const select = el('select', 'campaign-select');
      for (const [value, label] of o.values) {
        const opt = el('option', null, label);
        opt.value = value;
        select.append(opt);
      }
      select.value = chosen[key] ?? (state.won && key === 'difficulty' ? state.won : o.default);
      select.addEventListener('change', () => {
        this.choices.set(entry.id, { ...(this.choices.get(entry.id) ?? {}), [key]: select.value });
      });
      field.append(select);
      if (Object.hasOwn(HELP, `mission.${key}`)) field.append(infoTip(`mission.${key}`, { label: o.label, describes: select }).root);
      options.append(field);
    }
    const speedField = el('label', 'campaign-field');
    const speed = el('select', 'campaign-select');
    for (const v of GAME_SPEEDS) {
      const opt = el('option', null, SPEED_LABELS[v] ?? v);
      opt.value = v;
      speed.append(opt);
    }
    speed.value = this.gameSpeed;
    speed.addEventListener('change', () => {
      this.gameSpeed = speed.value;
    });
    speedField.append(el('span', null, 'Game speed'), speed, infoTip('gameSpeed', { label: 'Game speed', describes: speed }).root);

    const play = button('Play mission', 'campaign-btn campaign-btn-primary', () => {
      if (state.open) this.ctx.onPlay(entry, this.optionsOf(entry, options), speed.value);
    });
    play.disabled = !state.open;
    const note = state.open ? null : el('p', 'campaign-muted', 'Win a mission of the chapter before this one to open it.');
    options.append(speedField);
    box.append(canvas, title, side, briefing, options, ...(note ? [note] : []), play);
    return box;
  }

  /** The option values the screen shows for `entry`. */
  optionsOf(entry, container) {
    const out = {};
    const keys = Object.keys(entry.options ?? {});
    const selects = container.querySelectorAll('select');
    keys.forEach((key, k) => {
      out[key] = selects[k].value;
    });
    return out;
  }

  /** Draw the mission's map (one pixel per cell, scaled up crisp) once its file is here. */
  async drawPreview(entry, canvas) {
    const token = ++this.previewToken;
    try {
      const text = await this.ctx.missionText(entry);
      if (token !== this.previewToken) return;
      const p = this.ctx.preview(text);
      if (!p) return;
      canvas.width = p.width;
      canvas.height = p.height;
      canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(p.rgba), p.width, p.height), 0, 0);
      canvas.style.aspectRatio = `${p.width} / ${p.height}`;
      // The lens shows the mission as it starts: its map with the mission's actors.
      this.lens?.setSource(`mission:${entry.id}:${entry.sha256}`, (art) => art.fromMission(text), { width: p.width, height: p.height });
    } catch (err) {
      if (token === this.previewToken) canvas.replaceWith(el('p', 'campaign-error', `The mission could not be loaded: ${err.message ?? err}`));
    }
  }
}
