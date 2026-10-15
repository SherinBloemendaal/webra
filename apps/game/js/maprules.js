// What a modded map's `rules` overrides change, in words, for the "modded
// map" prompts (skirmish lobby, online lobby, replays and saves): one line
// per changed value, built-in value to the map's (docs/contracts.md section 2).
// Every string from the map goes in as text, never as HTML.

/** Normal game speed: 40 ms per tick (js/main.js SPEEDS, as OpenRA). */
const NORMAL_TICK_MS = 40;

/** Labels of well-known fields (dotted paths inside an actor or weapon). */
const ACTOR_LABELS = {
  cost: 'cost',
  hp: 'hit points',
  sight: 'sight',
  build_ticks: 'build time',
  prerequisites: 'prerequisites',
  custom_sell_value: 'sell value',
  'unit.speed': 'speed',
  'unit.turn_speed': 'turn speed',
  'building.power': 'power',
};
const POWER_LABELS = {
  charge: 'charge time',
  one_shot: 'one use only',
  start_fully_charged: 'starts charged',
  prerequisites: 'prerequisites',
  display_timer: 'timer shown to',
};
const WEAPON_LABELS = {
  range: 'range',
  min_range: 'minimum range',
  reload: 'reload',
  burst: 'burst',
  speed: 'projectile speed',
  inaccuracy: 'inaccuracy',
  damage: 'damage',
};
/** Fields counted in ticks (shown as game time at normal speed too). */
const TICK_FIELDS = new Set(['build_ticks', 'charge', 'reload']);

/** "m:ss" of a tick count at normal game speed. */
export function ticksToTime(ticks) {
  const s = Math.floor((ticks * NORMAL_TICK_MS) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** The label of `key` in `labels`, or the key itself (own entries only). */
function label(labels, key) {
  return Object.hasOwn(labels, key) ? labels[key] : key;
}

function show(v) {
  if (v === undefined || v === null) return 'none';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (Array.isArray(v)) return v.length ? v.map(show).join(', ') : 'none';
  if (typeof v === 'object') return '...';
  return String(v);
}

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** One "label: old to new" line, with ticks also as time at normal speed. */
function change(label, field, from, to) {
  if (TICK_FIELDS.has(field) && Number.isInteger(to) && (from === undefined || Number.isInteger(from))) {
    const was = from === undefined ? '' : `${from} ticks (${ticksToTime(from)}) to `;
    return `${label}: ${was}${to} ticks (${ticksToTime(to)} at normal speed)`;
  }
  return `${label}: ${show(from)} to ${show(to)}`;
}

/**
 * Lines for every value `patch` changes in `base` (one actor or weapon).
 * Objects merge field by field; arrays are replaced whole, so their objects
 * (support powers, warheads) are compared entry by entry.
 */
function diff(patch, base, path, labels, out) {
  for (const [k, v] of Object.entries(patch ?? {})) {
    const b = base && typeof base === 'object' ? base[k] : undefined;
    const p = path ? `${path}.${k}` : k;
    if (k === 'support_powers' && Array.isArray(v)) {
      v.forEach((power, i) => {
        const was = Array.isArray(b) ? b[i] : undefined;
        const name = power?.name || power?.key || `power ${i + 1}`;
        for (const [f, x] of Object.entries(power ?? {})) {
          const old = was?.[f] ?? (typeof x === 'boolean' ? false : Array.isArray(x) ? [] : undefined);
          if (!same(old, x)) out.push(change(`${name} ${label(POWER_LABELS, f)}`, f, old, x));
        }
      });
    } else if (k === 'warheads' && Array.isArray(v)) {
      v.forEach((h, i) => {
        const was = Array.isArray(b) ? b[i] : undefined;
        for (const [f, x] of Object.entries(h ?? {})) {
          if (!same(was?.[f], x)) out.push(change(`${v.length > 1 ? `warhead ${i + 1} ` : ''}${label(WEAPON_LABELS, f)}`, f, was?.[f], x));
        }
      });
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      diff(v, b, p, labels, out);
    } else if (!same(b, v)) {
      out.push(change(label(labels, p), k, b, v));
    }
  }
}

/**
 * The changes of a map's `rules` against the built-in rules (`base`, the
 * engine's `base_rules_json()`), one line each ("Missile Silo (MSLO): Atom
 * Bomb charge time: 13500 ticks (9:00) to 50000 ticks (33:20 at normal
 * speed)"), at most `limit` lines plus one that counts the rest.
 * @param {object|null} rules the map's rules overrides
 * @param {{ actors?: object[], weapons?: object[] } | null} base
 * @param {{ limit?: number }} [opts]
 * @returns {string[]}
 */
export function describeMapRules(rules, base, { limit = 30 } = {}) {
  if (!rules || typeof rules !== 'object') return [];
  const lines = [];
  const sections = [
    ['actors', 'id', ACTOR_LABELS, (e, id) => (e?.name && e.name !== id ? `${e.name} (${id})` : id)],
    ['weapons', 'name', WEAPON_LABELS, (_e, id) => `Weapon ${id}`],
  ];
  for (const [section, key, labels, title] of sections) {
    const list = Array.isArray(base?.[section]) ? base[section] : [];
    for (const [id, patch] of Object.entries(rules[section] ?? {})) {
      const entry = list.find((e) => String(e?.[key]).toLowerCase() === id.toLowerCase());
      const out = [];
      diff(patch, entry, '', labels, out);
      for (const line of out) lines.push(`${title(entry, entry?.[key] ?? id)}: ${line}`);
    }
  }
  if (lines.length <= limit) return lines;
  return [...lines.slice(0, limit), `...and ${lines.length - limit} more changes.`];
}
