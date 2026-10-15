// What the loading screen shows besides its steps (the canvas board
// "Laadscherm (geanimeerd)", screens/Loading): the emblem, a line with the
// kind of game and the sides ("SKIRMISH · 2 VS 2"), the map's name, the
// players by team with their flags and colours (two sides face each other
// with VS between them), and the tips (js/tips.js) with Previous and Next.
//
// js/loadingscreen.js owns the screen (its steps, bar, focus and close);
// this module only adds to its card: `begin` when a start shows, `describe`
// once the start's players and map are known (js/main.js launch), `end` when
// the screen goes. The tips move on every TIP_MS and the last one shown is
// kept (`guide.lastTip`), so the next start shows the next tip.
//
// The entrance (the emblem drops in, the title wipes in, the sides slide in
// from left and right, VS punches in, the bottom fades in) and the tip change
// are CSS (css/loading.css); "Reduce motion" (.is-still or the browser's)
// leaves them out. DOM through createElement and textContent only.

import { boundKey, formatCombo, normalizeCombo, openraDefaults } from './hotkeys.js';
import { TIPS, TIP_ACTIONS, TIP_MS, nextTipIndex, stepTip, tipParts } from './tips.js';

/** The countries' names (protocol PLAYABLE_FACTIONS) and their side. */
const COUNTRIES = Object.freeze({
  england: ['England', 'Allies'],
  france: ['France', 'Allies'],
  germany: ['Germany', 'Allies'],
  russia: ['Russia', 'Soviet'],
  ukraine: ['Ukraine', 'Soviet'],
  random: ['Random', null],
  randomallies: ['Random', 'Allies'],
  randomsoviet: ['Random', 'Soviet'],
});

const BOTS = Object.freeze({ rush: 'Rush AI', normal: 'Normal AI', turtle: 'Turtle AI', naval: 'Naval AI' });
const DIFFICULTY = Object.freeze({ easy: 'Easy', normal: 'Normal', hard: 'Hard' });

/** What the kicker calls each kind of start. */
const KINDS = Object.freeze({ skirmish: 'Skirmish', online: 'Online', mission: 'Mission', save: 'Saved game', replay: 'Replay', stress: 'Stress test' });

/** A colour `[r, g, b]` (0 to 1, renderer.js TEAM_PALETTE) as CSS, or null. */
export function colorCss(c) {
  if (!Array.isArray(c) || c.length < 3) return null;
  const b = (v) => Math.round(Math.min(1, Math.max(0, v)) * 255);
  return `rgb(${b(c[0])}, ${b(c[1])}, ${b(c[2])})`;
}

/** "Allies · England", "Soviet", "Random". */
export function factionText(faction) {
  const [name, side] = COUNTRIES[faction] ?? [String(faction ?? ''), null];
  if (!side) return name;
  return name === 'Random' ? `${side} · Random` : `${side} · ${name}`;
}

/** The name in a map file's JSON text (the canonical map format), or null. */
export function mapNameOf(text) {
  if (typeof text !== 'string' || !text) return null;
  try {
    const name = JSON.parse(text)?.name;
    return typeof name === 'string' && name.trim() ? name.trim() : null;
  } catch {
    return null;
  }
}

/**
 * The sides of a start from its engine options' players (`{ type, name?,
 * faction, team, color, bot?, difficulty? }`): players on a team together,
 * everyone without a team alone. `you` is the local player's index (null
 * for a spectator or a replay); `colorOf(color)` the CSS colour of a colour
 * index.
 * @returns {{ label: string | null, players: { name: string, tag: string, faction: string, factionText: string, color: string | null, you: boolean }[] }[]}
 */
export function startSides(players, { you = null, colorOf = () => null } = {}) {
  const sides = new Map();
  (players ?? []).forEach((p, i) => {
    if (!p || p.type === 'closed' || p.type === 'open') return;
    const ai = p.type === 'ai';
    const name = ai ? (p.name ?? BOTS[p.bot ?? 'normal'] ?? 'AI') : (p.name ?? `Player ${i + 1}`);
    const tag = i === you ? 'You' : ai ? `AI · ${DIFFICULTY[p.difficulty] ?? 'Normal'}` : '';
    const key = p.team > 0 ? `t${p.team}` : `p${i}`;
    if (!sides.has(key)) sides.set(key, { team: p.team > 0 ? p.team : null, players: [] });
    sides.get(key).players.push({ name, tag, faction: p.faction ?? 'random', factionText: factionText(p.faction), color: colorOf(p.color), you: i === you });
  });
  const list = [...sides.values()].sort((a, b) => (a.team ?? 99) - (b.team ?? 99));
  return list.map((s) => ({ label: s.team ? `Team ${s.team}` : null, players: s.players }));
}

/** "2 VS 2", "1 VS 1 VS 1", or "FREE FOR ALL" for more than three sides of one. */
export function versusText(sides) {
  if (sides.length < 2) return '';
  if (sides.length > 3 && sides.every((s) => s.players.length === 1)) return 'Free for all';
  return sides.map((s) => s.players.length).join(' vs ');
}

/**
 * What the board says about a start (js/main.js launch's `spec`): the
 * kicker ("Skirmish · 2 vs 2"), the title (the map's name, the mission's
 * title, or null to keep the screen's) and the sides.
 * @param {{ kind: string, options?: object, map?: string | null, replay?: object, player?: number | null }} spec
 * @param {{ title?: string | null, colorOf?: (color: number) => string | null }} o
 */
export function describeStart(spec, { title = null, colorOf = () => null } = {}) {
  const options = spec.options ?? spec.replay?.options ?? null;
  const viewer = spec.kind === 'replay';
  // The local player: the start's own (a skirmish, an online game), a save's recording player
  // (replay files keep it); a replay watches. Missions list no players, so they show no sides.
  const own = Number.isInteger(spec.player) ? spec.player : Number.isInteger(spec.replay?.player) ? spec.replay.player : null;
  const you = viewer ? null : own;
  const sides = options?.players ? startSides(options.players, { you, colorOf }) : [];
  const kind = KINDS[spec.kind] ?? null;
  const versus = versusText(sides);
  const map = mapNameOf(spec.map ?? spec.replay?.map ?? null);
  return {
    kicker: [kind, versus].filter(Boolean).join(' · '),
    title: map ?? title,
    sides,
  };
}

function el(doc, tag, className, text) {
  const e = doc.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** A hotkey's default key as the tips show it ("A", "Ctrl+X"), null when it has none. */
export function defaultKeyText(name) {
  try {
    const [combo] = openraDefaults(name);
    return combo ? formatCombo(combo) : null;
  } catch {
    return null;
  }
}

/**
 * The key the player bound to the action of OpenRA hotkey `name` (tips.js
 * TIP_ACTIONS) in `registry` (js/hotkeys.js HotkeyRegistry): the live
 * binding once the game registered the action (boundKey), before that the
 * saved rebinding (an empty one: unbound, null), else the default.
 */
export function boundKeyText(registry, name) {
  const action = TIP_ACTIONS[name];
  if (!action || !registry) return defaultKeyText(name);
  if (registry.actions?.has(action)) return boundKey(registry, action);
  const saved = registry.overrides?.()[action];
  if (Array.isArray(saved)) {
    const combo = saved.map(normalizeCombo).find(Boolean);
    return combo ? formatCombo(combo) : null;
  }
  return defaultKeyText(name);
}

export class LoadingBoard {
  /**
   * @param {{
   *   doc?: Document,
   *   tips?: { get(): number, set(index: number): void },  the last tip shown (guide.lastTip)
   *   keyText?: (hotkey: string) => string | null,
   *   timers?: { setInterval: Function, clearInterval: Function },
   *   tipMs?: number,
   * }} [o]
   */
  constructor({ doc = globalThis.document, tips = null, keyText = defaultKeyText, timers = globalThis, tipMs = TIP_MS } = {}) {
    this.doc = doc;
    this.store = tips;
    this.keyText = keyText;
    this.timers = timers;
    this.tipMs = tipMs;
    this.timer = null;
    this.tip = -1;
    this.parts = null;
  }

  /**
   * A start shows on `card` (the screen's, with its title, status, bar and
   * steps): the emblem and the kicker go before the title, the sides and the
   * tips after the steps.
   */
  begin(card, plan) {
    this.end();
    const doc = this.doc;
    const title = card.querySelector('.loading-title');
    const brand = el(doc, 'div', 'loading-brand ui-brand');
    brand.setAttribute('aria-hidden', 'true');
    const emblem = el(doc, 'img', 'ui-brand-emblem');
    // Under 40 px the simplified emblem (docs/contracts.md, Logo).
    emblem.src = 'brand/favicon.svg';
    emblem.alt = '';
    emblem.width = 34;
    emblem.height = 34;
    const word = el(doc, 'span', 'ui-brand-word', 'Web');
    word.append(el(doc, 'span', null, 'RA'));
    brand.append(emblem, word);
    const kicker = el(doc, 'p', 'loading-kicker', plan.title);
    const intro = el(doc, 'div', 'loading-intro');
    intro.append(brand, kicker);
    if (title) {
      title.before(intro);
      intro.append(title);
    } else card.prepend(intro);

    const sides = el(doc, 'div', 'loading-sides');
    sides.hidden = true;

    const tipBox = el(doc, 'div', 'loading-tip');
    const label = el(doc, 'span', 'loading-tip-label', 'Tip');
    label.setAttribute('aria-hidden', 'true');
    // A polite region: the tip changes by itself.
    const text = el(doc, 'p', 'loading-tip-text');
    text.setAttribute('aria-live', 'polite');
    const prev = el(doc, 'button', 'loading-tip-prev');
    prev.type = 'button';
    prev.setAttribute('aria-label', 'Previous tip');
    prev.addEventListener('click', () => this.showTip(stepTip(this.tip, -1), true));
    const next = el(doc, 'button', 'loading-tip-next');
    next.type = 'button';
    next.setAttribute('aria-label', 'Next tip');
    next.addEventListener('click', () => this.showTip(stepTip(this.tip, 1), true));
    const buttons = el(doc, 'span', 'loading-tip-buttons');
    buttons.append(prev, next);
    tipBox.append(label, text, buttons);
    const count = el(doc, 'p', 'loading-tip-count');
    const bottom = el(doc, 'div', 'loading-bottom');
    // The status, bar and steps of the screen sit in the bottom block, with the tip under them.
    const parts = [...card.children].filter((c) => c !== intro);
    bottom.append(...parts, tipBox, count);
    card.append(sides, bottom);
    this.parts = { intro, kicker, title, sides, text, count, prev, next };
    this.showTip(nextTipIndex(this.store?.get() ?? -1));
    this.timer = this.timers.setInterval(() => this.showTip(stepTip(this.tip, 1)), this.tipMs);
  }

  /** Tip `index` on the screen; `byHand` (Previous, Next) starts the wait for the next one again. */
  showTip(index, byHand = false) {
    const p = this.parts;
    if (!p || index < 0) return;
    this.tip = index;
    const { key, text } = tipParts(TIPS[index], this.keyText);
    p.text.replaceChildren();
    if (key) p.text.append(el(this.doc, 'kbd', 'loading-tip-key', key), ' ');
    p.text.append(text);
    // A new element each time replays the CSS fade (no animation with Reduce motion).
    p.text.classList.remove('is-new');
    void p.text.offsetWidth;
    p.text.classList.add('is-new');
    p.count.textContent = `Tip ${index + 1} of ${TIPS.length}`;
    if (byHand && this.timer !== null) {
      this.timers.clearInterval(this.timer);
      this.timer = this.timers.setInterval(() => this.showTip(stepTip(this.tip, 1)), this.tipMs);
    }
  }

  /** The start's kicker, title and sides are known (describeStart). */
  describe({ kicker, title, sides }) {
    const p = this.parts;
    if (!p) return;
    if (kicker) p.kicker.textContent = kicker;
    if (title && p.title) p.title.textContent = title;
    p.sides.replaceChildren();
    p.sides.hidden = !sides?.length;
    if (!sides?.length) return;
    const doc = this.doc;
    const two = sides.length === 2;
    p.sides.classList.toggle('loading-sides-two', two);
    sides.forEach((side, k) => {
      if (two && k === 1) {
        const vs = el(doc, 'span', 'loading-vs', 'VS');
        vs.setAttribute('aria-hidden', 'true');
        p.sides.append(vs);
      }
      const box = el(doc, 'section', `loading-side loading-side-${two ? (k === 0 ? 'left' : 'right') : 'list'}`);
      // A team is named over its players; a player without a team is a side of its own.
      if (side.label) box.append(el(doc, 'h2', 'loading-side-label', side.label));
      else box.setAttribute('aria-label', side.players.map((pl) => pl.name).join(', '));
      const list = el(doc, 'ul', 'loading-players');
      side.players.forEach((pl, i) => {
        const li = el(doc, 'li', 'loading-player');
        li.style.setProperty('--player-delay', `${i * 0.15}s`);
        if (pl.color) li.style.setProperty('--player-color', pl.color);
        const strip = el(doc, 'span', 'loading-player-strip');
        const flag = el(doc, 'span', 'observer-flag loading-flag');
        flag.dataset.faction = pl.faction;
        flag.setAttribute('aria-hidden', 'true');
        const who = el(doc, 'span', 'loading-player-who');
        const line = el(doc, 'span', 'loading-player-line');
        line.append(el(doc, 'span', 'loading-player-name', pl.name));
        if (pl.tag) line.append(el(doc, 'span', `loading-player-tag${pl.you ? ' is-you' : ''}`, pl.tag));
        who.append(line, el(doc, 'span', 'loading-player-faction', pl.factionText));
        li.append(strip, flag, who);
        list.append(li);
      });
      box.append(list);
      p.sides.append(box);
    });
  }

  /** The screen goes: the tips stop and the last one shown is kept for the next start. */
  end() {
    if (this.timer !== null) this.timers.clearInterval(this.timer);
    this.timer = null;
    if (this.parts && this.tip >= 0) {
      try {
        this.store?.set(this.tip);
      } catch (err) {
        console.warn('The last tip was not kept:', err?.message ?? err);
      }
    }
    this.parts = null;
  }
}
