// The map editor's Setup tab and actor properties (map format version 2,
// packages/protocol mapsetup.js): the player slots the lobby starts with
// (open, AI or closed, faction, team, colour, and which of them players may
// not change), the lobby options the map sets and locks, the map's tags, and
// the health, stance, veterancy and passengers of selected actors. Every
// change is one undoable document step. DOM through the editor's `el` and
// the game's themed controls only (the CSP allows no markup strings).

import { el } from './ui.js';
import { checkbox, slider } from '../../js/ui/controls.js';
import {
  BOT_TYPES,
  COLOR_NAMES,
  DIFFICULTIES,
  FACTION_GROUPS,
  LOBBY_SELECT_OPTIONS,
  LOBBY_TOGGLE_OPTIONS,
  TEAMS,
  WEATHER_MODES,
} from '../../js/lobby-state.js';
import {
  ACTOR_CARGO_MAX,
  ACTOR_HEALTH_MAX,
  ACTOR_HEALTH_MIN,
  MAP_OPTION_KEYS,
  MAP_OPTION_VALUES,
  MAP_SLOT_DEFAULTS,
  MAP_TAG_MAX,
  MAP_TAGS_MAX,
  canonicalSlot,
} from '../../js/protocol.js';

/** Labels of the options a map can set: the lobby's rows, plus weather. */
export const OPTION_ROWS = MAP_OPTION_KEYS.map((key) => {
  if (key === 'weather') return { key, label: 'Weather', choices: WEATHER_MODES };
  const select = LOBBY_SELECT_OPTIONS.find((o) => o.key === key);
  if (select) return { key, label: select.label, choices: select.choices };
  const toggle = LOBBY_TOGGLE_OPTIONS.find((o) => o.key === key);
  return { key, label: toggle?.label ?? key, choices: [{ value: true, label: 'On' }, { value: false, label: 'Off' }] };
});

const SLOT_TYPES = [
  { value: 'open', label: 'Open' },
  { value: 'ai', label: 'AI' },
  { value: 'closed', label: 'Closed' },
];
const LOCK_LABELS = { type: 'Player', faction: 'Faction', team: 'Team', color: 'Colour' };

const select = (choices, value, attrs = {}) => {
  const s = el('select', { class: 'ui-input', ...attrs }, choices.map((c) => el('option', { value: String(c.value) }, c.label)));
  s.value = String(value);
  return s;
};

/** Parse a select's value back to its choice's type (numbers, booleans). */
const valueOf = (choices, text) => choices.find((c) => String(c.value) === text)?.value;

/**
 * Change the map's game setup as one undoable step: `fn(meta)` changes
 * `doc.meta.players`, `options`, `lockedOptions` or `tags`.
 */
export function editSetup(doc, label, fn, key = null) {
  doc.begin(label, key);
  doc.touchMeta();
  fn(doc.meta);
  doc.commit();
}

/** Slot `k` of the document (its entry, or the defaults), as a mutable copy. */
function slotOf(doc, k) {
  return canonicalSlot(doc.meta.players[k] ?? {});
}

/** Write slot `k`, filling earlier missing slots with the defaults and trimming trailing default slots. */
export function setSlot(meta, k, slot) {
  while (meta.players.length <= k) meta.players.push(canonicalSlot({}));
  meta.players[k] = canonicalSlot(slot);
  const isDefault = (s) => JSON.stringify(canonicalSlot(s)) === JSON.stringify(canonicalSlot(MAP_SLOT_DEFAULTS));
  while (meta.players.length && isDefault(meta.players[meta.players.length - 1])) meta.players.pop();
}

/**
 * The slots table: one row per spawn. `teamCss(k)` is spawn k's colour for
 * its badge.
 */
export function slotsView(doc, teamCss) {
  const factions = FACTION_GROUPS.flatMap((g) => g.items.map((f) => ({ value: f.value, label: g.label === 'Random' ? f.label : `${f.label} (${g.label})` })));
  const colors = [{ value: -1, label: 'Any' }, ...COLOR_NAMES.map((name, i) => ({ value: i, label: name }))];
  const rows = doc.spawns.map((_, k) => {
    const s = slotOf(doc, k);
    const change = (label, f) =>
      editSetup(doc, `Slot ${k + 1}: ${label}`, (meta) => {
        const next = slotOf(doc, k);
        f(next);
        setSlot(meta, k, next);
      });
    const type = select(SLOT_TYPES, s.type, { 'aria-label': `Slot ${k + 1} player`, onchange: () => change('player', (x) => (x.type = type.value)) });
    const difficulty = select(DIFFICULTIES, s.difficulty, { 'aria-label': `Slot ${k + 1} AI difficulty`, onchange: () => change('AI difficulty', (x) => (x.difficulty = difficulty.value)) });
    const bot = select(BOT_TYPES, s.bot, { 'aria-label': `Slot ${k + 1} bot`, onchange: () => change('bot', (x) => (x.bot = bot.value)) });
    const faction = select(factions, s.faction, { 'aria-label': `Slot ${k + 1} faction`, onchange: () => change('faction', (x) => (x.faction = faction.value)) });
    const team = select(TEAMS, s.team, { 'aria-label': `Slot ${k + 1} team`, onchange: () => change('team', (x) => (x.team = Number(team.value))) });
    const color = select(colors, s.color, { 'aria-label': `Slot ${k + 1} colour`, onchange: () => change('colour', (x) => (x.color = Number(color.value))) });
    const locks = Object.entries(LOCK_LABELS).map(([lock, label]) => {
      const c = checkbox({
        label,
        checked: s.lock.includes(lock),
        disabled: lock === 'color' && s.color < 0,
        title: lock === 'color' && s.color < 0 ? 'Pick a colour to lock it' : `Players cannot change the ${label.toLowerCase()} of this slot`,
        onChange: (on) =>
          change(`${on ? 'lock' : 'unlock'} ${label.toLowerCase()}`, (x) => {
            x.lock = on ? [...x.lock.filter((l) => l !== lock), lock] : x.lock.filter((l) => l !== lock);
          }),
      });
      return c.row;
    });
    const badge = el('span', { class: 'swatch-dot' });
    badge.style.setProperty('--dot', teamCss(k));
    return el('section', { class: 'slot-row', 'data-slot': String(k) }, [
      el('h3', {}, [badge, ` Slot ${k + 1}`]),
      el('div', { class: 'grid2' }, [
        el('label', { class: 'field' }, [el('span', { class: 'label' }, 'Player'), type]),
        el('label', { class: 'field' }, [el('span', { class: 'label' }, 'Faction'), faction]),
        el('label', { class: 'field', hidden: s.type !== 'ai' }, [el('span', { class: 'label' }, 'AI'), difficulty]),
        el('label', { class: 'field', hidden: s.type !== 'ai' }, [el('span', { class: 'label' }, 'Bot'), bot]),
        el('label', { class: 'field' }, [el('span', { class: 'label' }, 'Team'), team]),
        el('label', { class: 'field' }, [el('span', { class: 'label' }, 'Colour'), color]),
      ]),
      el('div', { class: 'locks', role: 'group', 'aria-label': `Locked for slot ${k + 1}` }, [el('span', { class: 'label' }, 'Locked'), ...locks]),
    ]);
  });
  return el('div', { class: 'slots-view' }, rows);
}

/** The map's lobby options: "Lobby decides" or a value, and a lock for each one the map sets. */
export function optionsView(doc) {
  const rows = OPTION_ROWS.map((o) => {
    const set = Object.hasOwn(doc.meta.options, o.key);
    const choices = [{ value: '', label: 'Lobby decides' }, ...o.choices];
    const value = select(choices, set ? doc.meta.options[o.key] : '', {
      'aria-label': o.label,
      onchange: () =>
        editSetup(doc, `Option ${o.label.toLowerCase()}`, (meta) => {
          if (value.value === '') {
            delete meta.options[o.key];
            meta.lockedOptions = meta.lockedOptions.filter((k) => k !== o.key);
          } else meta.options[o.key] = valueOf(o.choices, value.value);
        }),
    });
    const lock = checkbox({
      label: 'Locked',
      checked: doc.meta.lockedOptions.includes(o.key),
      disabled: !set,
      title: set ? 'Players cannot change it in the lobby' : 'Set a value to lock it',
      onChange: (on) =>
        editSetup(doc, `${on ? 'Lock' : 'Unlock'} ${o.label.toLowerCase()}`, (meta) => {
          meta.lockedOptions = on ? [...meta.lockedOptions.filter((k) => k !== o.key), o.key] : meta.lockedOptions.filter((k) => k !== o.key);
        }),
    });
    return el('tr', { 'data-option': o.key }, [el('th', {}, o.label), el('td', {}, value), el('td', {}, lock.row)]);
  });
  return el('table', { class: 'options-table' }, el('tbody', {}, rows));
}

/** Tags from free text: lower case, split at commas, trimmed, each at most MAP_TAG_MAX, no repeats, at most MAP_TAGS_MAX. */
export function parseTags(textValue) {
  const out = [];
  for (const raw of String(textValue).split(',')) {
    const t = raw
      .toLowerCase()
      .replace(/[^a-z0-9 -]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^[ -]+|[ -]+$/g, '')
      .slice(0, MAP_TAG_MAX)
      .replace(/[ -]+$/, '');
    if (t && !out.includes(t)) out.push(t);
  }
  return out.slice(0, MAP_TAGS_MAX);
}

// ---- Actor properties -------------------------------------------------------------------

/**
 * Health, stance, veterancy and passengers of the selected actors (`sel`,
 * document actors; `catalog`: rules_json actors by id). Changes are one
 * undo step each (`ctl.setOnSelection`). Only what applies to every
 * selected actor is offered.
 */
export function actorStateView(sel, catalog, ctl) {
  const infos = sel.map((a) => catalog[a.type] ?? Object.values(catalog).find((c) => c.id.toLowerCase() === String(a.type).toLowerCase()));
  const parts = [];
  const same = (f) => {
    const v = new Set(sel.map(f));
    return v.size === 1 ? [...v][0] : null;
  };
  if (infos.every((i) => i && i.kind !== 'crate')) {
    parts.push(
      slider({
        label: 'Health',
        min: ACTOR_HEALTH_MIN,
        max: ACTOR_HEALTH_MAX,
        value: same((a) => a.health ?? 100) ?? 100,
        format: (v) => `${v}%`,
        onInput: (v) => ctl.setOnSelection('Change health', (a) => (v === 100 ? delete a.health : (a.health = v))),
      }).row,
    );
  }
  if (infos.every((i) => i?.stance)) {
    const stances = [
      { value: '', label: 'Its own' },
      { value: 'attack_anything', label: 'Attack anything' },
      { value: 'defend', label: 'Defend' },
      { value: 'return_fire', label: 'Return fire' },
      { value: 'hold_fire', label: 'Hold fire' },
    ];
    const s = select(stances, same((a) => a.stance ?? '') ?? '', {
      'aria-label': 'Stance',
      onchange: () => ctl.setOnSelection('Change stance', (a) => (s.value ? (a.stance = s.value) : delete a.stance)),
    });
    parts.push(el('label', { class: 'field' }, [el('span', { class: 'label' }, 'Stance'), s]));
  }
  const levels = Math.min(...infos.map((i) => i?.levels ?? 0));
  if (levels > 0) {
    const names = ['Rookie', 'Veteran', 'Elite', 'Heroic', 'Legend'];
    parts.push(
      slider({
        label: 'Veterancy',
        min: 0,
        max: levels,
        value: same((a) => a.veterancy ?? 0) ?? 0,
        format: (v) => `${v} (${names[v] ?? v})`,
        onInput: (v) => ctl.setOnSelection('Change veterancy', (a) => (v === 0 ? delete a.veterancy : (a.veterancy = v))),
      }).row,
    );
  }
  if (sel.length === 1 && infos[0]?.cargo) parts.push(cargoView(sel[0], infos[0], catalog, ctl));
  return el('div', { class: 'actor-state' }, parts);
}

/** Passengers of one transport: a list with remove buttons and a picker of what fits. */
function cargoView(actor, info, catalog, ctl) {
  const cargo = actor.cargo ?? [];
  const weight = (id) => catalog[id]?.passenger?.weight ?? 1;
  const used = cargo.reduce((n, id) => n + weight(id), 0);
  const fits = Object.values(catalog).filter((c) => c.passenger && info.cargo.types.includes(c.passenger.type) && c.kind !== 'proxy' && !c.world?.category);
  const pick = el(
    'select',
    { class: 'ui-input', 'aria-label': 'Add a passenger' },
    fits.map((c) => el('option', { value: c.id, disabled: used + c.passenger.weight > info.cargo.max }, `${c.name} (${c.passenger.weight})`)),
  );
  const add = el(
    'button',
    {
      type: 'button',
      disabled: used >= info.cargo.max || cargo.length >= ACTOR_CARGO_MAX,
      onclick: () => {
        const id = pick.value;
        if (!id || used + weight(id) > info.cargo.max) return;
        ctl.setOnSelection('Add passenger', (a) => (a.cargo = [...(a.cargo ?? []), id]));
      },
    },
    'Add',
  );
  return el('div', { class: 'cargo' }, [
    el('h3', {}, `Passengers ${used} / ${info.cargo.max}`),
    cargo.length
      ? el(
          'ul',
          { class: 'cargo-list' },
          cargo.map((id, k) =>
            el('li', {}, [
              el('span', {}, catalog[id]?.name ?? id),
              el(
                'button',
                {
                  type: 'button',
                  class: 'link danger-link',
                  onclick: () =>
                    ctl.setOnSelection('Remove passenger', (a) => {
                      const next = (a.cargo ?? []).filter((_, j) => j !== k);
                      if (next.length) a.cargo = next;
                      else delete a.cargo;
                    }),
                },
                'Remove',
              ),
            ]),
          ),
        )
      : el('p', { class: 'hint' }, 'Empty. Passengers start inside and belong to its owner.'),
    el('div', { class: 'row' }, [pick, add]),
  ]);
}
