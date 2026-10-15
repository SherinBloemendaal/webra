// The map editor's Setup tab and actor properties (map format version 2,
// packages/protocol mapsetup.js): the player slots the lobby starts with
// (open, AI or closed, faction, team, colour, and which of them players may
// not change), the lobby options the map sets and locks, the map's tags, and
// the health, stance, veterancy and passengers of selected actors. Every
// change is one undoable document step. DOM through the editor's `el` and
// the game's themed controls only (the CSP allows no markup strings).

import { el, selectField } from './ui.js';
import { checkbox, selectPlate, slider } from '../../js/ui/controls.js';
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

/** A labelled select plate (ui.js selectField): `{ field, select }`; `onChange(value)` gets the choice's own value (numbers, booleans). */
const pick = (label, choices, value, o = {}, attrs = {}) => selectField(label, { options: choices, value, small: true, ...o }, attrs);

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
    // Each plate is named by its visible label and the slot ("Slot 2 faction" on the phone sheet).
    const slotPick = (label, what, choices, value, onChange, attrs) => pick(label, choices, value, { id: `slot-${k}-${what}`, onChange, label: `Slot ${k + 1} ${label.toLowerCase()}` }, attrs);
    const type = slotPick('Player', 'player', SLOT_TYPES, s.type, (v) => change('player', (x) => (x.type = v)));
    const difficulty = slotPick('AI', 'difficulty', DIFFICULTIES, s.difficulty, (v) => change('AI difficulty', (x) => (x.difficulty = v)), { hidden: s.type !== 'ai' });
    const bot = slotPick('Bot', 'bot', BOT_TYPES, s.bot, (v) => change('bot', (x) => (x.bot = v)), { hidden: s.type !== 'ai' });
    const faction = slotPick('Faction', 'faction', factions, s.faction, (v) => change('faction', (x) => (x.faction = v)));
    const team = slotPick('Team', 'team', TEAMS, s.team, (v) => change('team', (x) => (x.team = Number(v))));
    const color = slotPick('Colour', 'colour', colors, s.color, (v) => change('colour', (x) => (x.color = Number(v))));
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
      el('div', { class: 'grid2' }, [type.field, faction.field, difficulty.field, bot.field, team.field, color.field]),
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
    // The row head names the plate (th id); choices keep their types (numbers, booleans).
    const head = el('th', { id: `map-option-${o.key}` }, o.label);
    const value = selectPlate({
      id: `map-option-${o.key}-value`,
      label: o.label,
      labelledBy: head.id,
      options: choices,
      value: set ? doc.meta.options[o.key] : '',
      small: true,
      block: true,
      onChange: (v) =>
        editSetup(doc, `Option ${o.label.toLowerCase()}`, (meta) => {
          if (v === '') {
            delete meta.options[o.key];
            meta.lockedOptions = meta.lockedOptions.filter((k) => k !== o.key);
          } else meta.options[o.key] = v;
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
    return el('tr', { 'data-option': o.key }, [head, el('td', {}, value.root), el('td', {}, lock.row)]);
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
    // Several actors with different stances: no choice shown until one is made.
    const stance = pick('Stance', stances, same((a) => a.stance ?? ''), {
      id: 'actor-stance',
      placeholder: 'Mixed',
      onChange: (v) => ctl.setOnSelection('Change stance', (a) => (v ? (a.stance = v) : delete a.stance)),
    });
    parts.push(stance.field);
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
  const room = (c) => used + c.passenger.weight <= info.cargo.max;
  const passenger = selectPlate({
    id: 'cargo-pick',
    label: 'Add a passenger',
    options: fits.map((c) => ({ value: c.id, label: `${c.name} (${c.passenger.weight})`, disabled: !room(c), title: room(c) ? undefined : 'Does not fit any more' })),
    // The first one that fits, as the native list showed it.
    value: fits.find(room)?.id ?? null,
    placeholder: 'Nothing fits',
    small: true,
  });
  const add = el(
    'button',
    {
      type: 'button',
      disabled: used >= info.cargo.max || cargo.length >= ACTOR_CARGO_MAX,
      onclick: () => {
        const id = passenger.get();
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
    el('div', { class: 'row' }, [passenger.root, add]),
  ]);
}
