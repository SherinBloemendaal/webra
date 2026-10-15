// Bulk editing of lobby slots, in the skirmish and the online lobby: OpenRA's
// slot admin and its "assign teams" command (LobbyCommands.cs AssignTeams),
// extended. The player selects rows (a click selects one row, Ctrl or Cmd
// adds or removes one, Shift selects every row from the anchor to the
// clicked one, top to bottom) and applies one action to them; with nothing
// selected an action applies to every slot it can change.
//
// Online the host changes another player's team, handicap and start
// position (and removes players), but not its faction or colour: OpenRA's
// lobby shows those read only for the host too (LobbyLogic).
//
// Pure: planBulk turns an action into per-slot changes ({ slot, ...fields },
// the fields of the protocol's `slot` message). The skirmish lobby applies
// them with applyBulk; the online lobby sends them as one `slots` message
// and the server validates every change like a single `slot` message
// (apps/server/src/room.js setSlots, docs/contracts.md section 4).

import { BOTS, DIFFICULTIES, HANDICAPS, PLAYABLE_FACTIONS } from '../protocol/constants.js';

/** The labels of the bot types and difficulties (OpenRA's names). */
export const BOT_LABELS = { rush: 'Rush AI', normal: 'Normal AI', turtle: 'Turtle AI', naval: 'Naval AI' };
export const DIFFICULTY_LABELS = { easy: 'Easy', normal: 'Normal', hard: 'Hard' };
const FACTION_LABELS = {
  random: 'Random',
  randomallies: 'Random Allies',
  randomsoviet: 'Random Soviet',
  england: 'England',
  france: 'France',
  germany: 'Germany',
  russia: 'Russia',
  ukraine: 'Ukraine',
};
/** Handicaps offered in bulk: every tenth (the protocol allows steps of 5). */
const BULK_HANDICAPS = HANDICAPS.filter((h) => h % 10 === 0);

// ---- Selection -------------------------------------------------------------------------

/**
 * Which rows are selected, by slot index. `click` follows the file managers:
 * a plain click selects that row alone, Ctrl or Cmd (`additive`) toggles it,
 * and both move the anchor there; Shift (`range`) selects every row between
 * the anchor and the clicked one, whichever is higher on screen, instead of
 * the selection (plain) or setting that range to the clicked row's new state
 * (additive, like Shift on a checkbox), and keeps the anchor.
 */
export class RowSelection {
  constructor() {
    this.selected = new Set();
    this.anchor = null;
  }

  get size() {
    return this.selected.size;
  }

  has(i) {
    return this.selected.has(i);
  }

  /** The selected rows, top to bottom. */
  list() {
    return [...this.selected].sort((a, b) => a - b);
  }

  click(i, { range = false, additive = false } = {}) {
    if (range && this.anchor !== null) {
      const from = Math.min(this.anchor, i);
      const to = Math.max(this.anchor, i);
      if (additive) {
        const on = !this.selected.has(i);
        for (let k = from; k <= to; k++) {
          if (on) this.selected.add(k);
          else this.selected.delete(k);
        }
      } else {
        this.selected = new Set();
        for (let k = from; k <= to; k++) this.selected.add(k);
      }
      return;
    }
    if (additive) {
      if (this.selected.has(i)) this.selected.delete(i);
      else this.selected.add(i);
    } else {
      this.selected = new Set([i]);
    }
    this.anchor = i;
  }

  /** Select every row of `rows` (indices). */
  selectAll(rows) {
    this.selected = new Set(rows);
    if (this.anchor === null && rows.length) this.anchor = Math.min(...rows);
  }

  clear() {
    this.selected = new Set();
    this.anchor = null;
  }

  /** Forget rows from `count` on (rows were removed). */
  prune(count) {
    for (const i of [...this.selected]) if (i >= count) this.selected.delete(i);
    if (this.anchor !== null && this.anchor >= count) this.anchor = null;
  }
}

// ---- Actions -----------------------------------------------------------------------------

/**
 * The actions of a lobby as option groups: [{ label, items: [{ id, label }] }].
 * `context` 'skirmish' or 'online'; `mission` (online co-op): only the slot
 * actions; `teamMax` the highest team; `players` how many slots play now
 * (team splits need two players per team).
 */
export function bulkActions({ context, mission = false, teamMax = 4, players = 8 }) {
  const online = context === 'online';
  const slots = {
    label: 'Slots',
    items: online
      ? [
          { id: 'slot:kick', label: 'Remove selected players (slot opens)' },
          { id: 'slot:open', label: 'Open AI and closed slots' },
          { id: 'slot:closed', label: 'Close AI and open slots' },
        ]
      : [{ id: 'slot:closed', label: 'Close AI slots' }],
  };
  if (mission) return [slots];
  const splits = [];
  for (let n = 2; n <= Math.min(teamMax, Math.max(2, Math.floor(players / 2))); n++) {
    splits.push({ id: `teams:split:${n}`, label: n === 2 ? 'Team 1 vs Team 2 (split in slot order)' : `${n} teams (split in slot order)` });
  }
  for (let n = 2; n <= Math.min(teamMax, Math.max(2, Math.floor(players / 2))); n++) {
    splits.push({ id: `teams:alternate:${n}`, label: `${n} teams (alternating)` });
  }
  slots.items.unshift({ id: 'slot:ai', label: online ? 'Make open and closed slots Normal AI' : 'Make closed slots Normal AI' });
  slots.items.push({ id: 'spawn:auto', label: 'Start positions back to automatic' });
  return [
    {
      label: 'Teams',
      items: [
        { id: 'teams:ffa', label: 'Free for all (no teams)' },
        { id: 'teams:humans-vs-ai', label: 'Humans vs AI (Team 1 vs Team 2)' },
        ...splits,
        ...Array.from({ length: teamMax + 1 }, (_, t) => ({ id: `team:${t}`, label: t === 0 ? 'Put on no team' : `Put on Team ${t}` })),
      ],
    },
    {
      label: 'AI players',
      items: [
        ...BOTS.map((b) => ({ id: `fill:${b}`, label: `Fill ${online ? 'open' : 'closed and new'} slots with ${BOT_LABELS[b]}` })),
        ...BOTS.map((b) => ({ id: `bot:${b}`, label: `AI plays ${BOT_LABELS[b]}` })),
        ...DIFFICULTIES.map((d) => ({ id: `difficulty:${d}`, label: `AI difficulty ${DIFFICULTY_LABELS[d]}` })),
        { id: 'clear-ai', label: online ? 'Remove AI players (slots open)' : 'Remove AI players (slots close)' },
      ],
    },
    {
      label: 'Factions and colors',
      items: [
        { id: 'faction:shuffle', label: 'Shuffle countries (pick now)' },
        ...Object.keys(FACTION_LABELS).map((f) => ({ id: `faction:${f}`, label: `Faction ${FACTION_LABELS[f]}` })),
        { id: 'colors:shuffle', label: 'Shuffle colors' },
        ...BULK_HANDICAPS.map((h) => ({ id: `handicap:${h}`, label: `Handicap ${h}%` })),
      ],
    },
    slots,
  ];
}

/** Every action id of `bulkActions(opts)`. */
export function bulkActionIds(opts) {
  return bulkActions(opts).flatMap((g) => g.items.map((i) => i.id));
}

const playing = (s) => s.type === 'human' || s.type === 'ai';
const locked = (s, part) => Array.isArray(s.locked) && s.locked.includes(part);

function shuffled(list, rng) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Plan action `id` for `slots`.
 *
 * Slots: [{ type: 'human' | 'ai' | 'open' | 'closed', you?, team, faction,
 * color, bot, difficulty, handicap, spawn?, locked?: ['team', 'faction',
 * 'color', 'type'] (the map's locks) }].
 *
 * Options: `context` 'skirmish' | 'online'; `selected` the selected rows
 * (none: every row); `colorCount`; `teamMax`; `mission` (online co-op: only
 * slot actions, within `missionPlaces`); skirmish only: `maxActive` (the
 * map's spawns), `maxRows`, `minPlayers`; `rng` for the shuffles.
 *
 * Returns { changes: [{ slot, ...fields }], add: [{ bot }] (skirmish fill:
 * new AI rows), summary } or { error }.
 */
export function planBulk(slots, id, opts) {
  const { context, selected = [], colorCount = 8, teamMax = 4, mission = false, missionPlaces = Infinity, maxActive = 8, maxRows = 8, minPlayers = 2, rng = Math.random } = opts;
  const online = context === 'online';
  if (!bulkActionIds({ context, mission, teamMax, players: Infinity }).includes(id)) return { error: 'That action is not available here.' };
  const rows = selected.length ? [...new Set(selected)].filter((i) => i >= 0 && i < slots.length).sort((a, b) => a - b) : slots.map((_, i) => i);
  const scope = selected.length ? 'selected' : 'all';
  const changes = new Map();
  const set = (slot, fields) => changes.set(slot, { slot, ...(changes.get(slot) ?? {}), ...fields });
  const result = (summary) => {
    const list = [...changes.values()].filter((c) => Object.keys(c).length > 1);
    return { changes: list, add: [], summary: list.length ? summary(list.length) : 'Nothing to change.' };
  };
  const [kind, arg, arg2] = id.split(':');
  const editable = (part) => rows.filter((i) => playing(slots[i]) && !locked(slots[i], part));
  // Online the host sets faction and colour only for its own slot and the
  // AI slots: OpenRA's lobby leaves another player's read only.
  const own = (part) => editable(part).filter((i) => !online || slots[i].type === 'ai' || slots[i].you);

  switch (kind) {
    case 'teams': {
      const targets = editable('team');
      targets.forEach((i, k) => {
        let team = 0;
        if (arg === 'humans-vs-ai') team = slots[i].type === 'human' ? 1 : 2;
        else if (arg === 'split') team = Math.floor((k * Number(arg2)) / targets.length) + 1;
        else if (arg === 'alternate') team = (k % Number(arg2)) + 1;
        if (team > teamMax) team = teamMax;
        if (slots[i].team !== team) set(i, { team });
      });
      return result((n) => `Teams set: ${plural(n, 'slot')} changed.`);
    }
    case 'team': {
      const team = Number(arg);
      for (const i of editable('team')) if (slots[i].team !== team) set(i, { team });
      return result((n) => `${plural(n, 'slot')} put on ${team ? `Team ${team}` : 'no team'}.`);
    }
    case 'faction': {
      for (const i of own('faction')) {
        const faction = arg === 'shuffle' ? PLAYABLE_FACTIONS[Math.floor(rng() * PLAYABLE_FACTIONS.length)] : arg;
        if (slots[i].faction !== faction) set(i, { faction });
      }
      return result((n) => (arg === 'shuffle' ? `Countries shuffled for ${plural(n, 'slot')}.` : `${plural(n, 'slot')} now ${FACTION_LABELS[arg]}.`));
    }
    case 'colors': {
      // Colours stay unique: the targets share the colours no other slot
      // holds (skirmish closed rows keep theirs too) and their own.
      const holds = (s) => (online ? playing(s) : true) && Number.isInteger(s.color);
      const targets = own('color');
      const others = new Set(slots.filter((s, i) => holds(s) && !targets.includes(i)).map((s) => s.color));
      const pool = shuffled(
        Array.from({ length: colorCount }, (_, c) => c).filter((c) => !others.has(c)),
        rng,
      );
      if (pool.length < targets.length) return { error: 'Not enough free colors.' };
      targets.forEach((i, k) => {
        if (slots[i].color !== pool[k]) set(i, { color: pool[k] });
      });
      return result((n) => `Colors shuffled: ${plural(n, 'slot')} changed.`);
    }
    case 'handicap': {
      const handicap = Number(arg);
      for (const i of rows) if (playing(slots[i]) && (slots[i].handicap ?? 0) !== handicap) set(i, { handicap });
      return result((n) => `Handicap ${handicap}% for ${plural(n, 'slot')}.`);
    }
    case 'bot':
    case 'difficulty': {
      for (const i of rows) if (slots[i].type === 'ai' && (slots[i][kind] ?? 'normal') !== arg) set(i, { [kind]: arg });
      return result((n) => `${plural(n, 'AI player')} changed.`);
    }
    case 'spawn': {
      for (const i of rows) if (playing(slots[i]) && Number.isInteger(slots[i].spawn)) set(i, { spawn: null });
      return result((n) => `${plural(n, 'start position')} back to automatic.`);
    }
    case 'fill': {
      const empty = online ? 'open' : 'closed';
      let active = slots.filter(playing).length;
      const room = online ? Infinity : maxActive;
      for (const i of rows) {
        if (slots[i].type !== empty || locked(slots[i], 'type') || active >= room) continue;
        set(i, { type: 'ai', bot: arg, difficulty: 'normal' });
        active++;
      }
      // Skirmish: with nothing selected, new rows until the map is full.
      const add = [];
      if (!online && scope === 'all') {
        for (let n = slots.length; n < maxRows && active < room; n++, active++) add.push({ bot: arg });
      }
      const out = result((n) => `${plural(n, 'slot')} filled with ${BOT_LABELS[arg]}.`);
      if (add.length) {
        out.add = add;
        out.summary = `${plural(out.changes.length + add.length, 'slot')} filled with ${BOT_LABELS[arg]}.`;
      }
      return out;
    }
    case 'clear-ai':
    case 'slot': {
      const to = kind === 'clear-ai' ? (online ? 'open' : 'closed') : arg;
      let active = slots.filter(playing).length;
      for (const i of rows) {
        const s = slots[i];
        if (s.you || locked(s, 'type') || (mission && i >= missionPlaces)) continue;
        if (to === 'kick') {
          if (s.type === 'human') set(i, { type: 'open' });
        } else if (to === 'ai') {
          if (s.type === 'ai' || s.type === 'human') continue;
          if (!online && active >= maxActive) continue;
          set(i, { type: 'ai', bot: 'normal', difficulty: 'normal' });
          active++;
        } else if (kind === 'clear-ai') {
          if (s.type === 'ai') set(i, { type: to });
        } else if (to === 'open' || to === 'closed') {
          if (s.type === 'human' || s.type === to || (!online && s.type !== 'ai')) continue;
          set(i, { type: to });
        }
      }
      if (!online) {
        const after = slots.filter((s, i) => (changes.has(i) ? changes.get(i).type !== 'closed' : playing(s))).length;
        if (after < minPlayers) return { error: 'A game needs at least two players.' };
      }
      const verb = { kick: 'removed', ai: 'now Normal AI', open: 'opened', closed: 'closed' }[to];
      return result((n) => `${plural(n, 'slot')} ${verb}.`);
    }
    default:
      return { error: 'That action is not available here.' };
  }
}

/**
 * Which of the team actions `ids` the slots' teams already are: the first
 * whose plan changes nothing (the lobby's team presets show it chosen), or
 * null. Fewer than two playing slots match none.
 */
export function matchingTeamAction(slots, ids, opts) {
  if (slots.filter(playing).length < 2) return null;
  for (const id of ids) {
    const plan = planBulk(slots, id, opts);
    if (!plan.error && plan.changes.length === 0) return id;
  }
  return null;
}

/**
 * Apply planned changes to a skirmish lobby state (lobby-state.js shape):
 * all or nothing. `addRow(bot)` adds an AI row (lobby-state addSlot) and
 * returns its index or -1. Returns null, or why it was refused (the state
 * is then unchanged).
 */
export function applyBulk(state, plan, { colorCount, addRow, maxActive = 8, minPlayers = 2 }) {
  const before = structuredClone(state.players);
  const refuse = (why) => {
    state.players = before;
    return why;
  };
  for (const c of plan.changes) {
    const p = state.players[c.slot];
    if (!p) return refuse('No such slot.');
    if (c.type !== undefined) {
      if (p.type === 'human') return refuse('You cannot change your own slot type.');
      p.type = c.type;
      if (c.type === 'closed') delete p.spawn;
    }
    for (const k of ['team', 'faction', 'color', 'handicap', 'bot', 'difficulty']) if (c[k] !== undefined) p[k] = c[k];
    if (c.spawn === null) delete p.spawn;
  }
  for (const a of plan.add ?? []) {
    const slot = addRow();
    if (slot < 0) return refuse('No room for another player.');
    state.players[slot].bot = a.bot;
  }
  const colors = state.players.map((p) => p.color);
  if (new Set(colors).size !== colors.length || colors.some((c) => !Number.isInteger(c) || c < 0 || c >= colorCount)) return refuse('Two slots would share a color.');
  const active = state.players.filter(playing).length;
  if (active < minPlayers) return refuse('A game needs at least two players.');
  if (active > maxActive) return refuse(`This map has ${maxActive} start positions.`);
  return null;
}
