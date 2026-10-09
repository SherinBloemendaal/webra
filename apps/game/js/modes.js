// Game modes in the lobbies: the built-in modes of the protocol package
// (protocol/presets.js) plus the player's saved ones (settings registry,
// `lobby.presets`), which mode a set of options is, and saving and deleting.
// No DOM here: js/modepicker.js draws it, Node tests import it.

import {
  BUILTIN_MODES,
  PRESET_KEYS,
  PRESET_NAME_MAX,
  PRESETS_MAX,
  presetNameKey,
  presetOptions,
  validPresetName,
  validateSavedPresets,
} from '../protocol/presets.js';

export { PRESET_KEYS, PRESET_NAME_MAX, PRESETS_MAX, presetOptions };

/** Id of "no mode": options set by hand. */
export const CUSTOM = 'custom';
const SAVED_PREFIX = 'saved:';

/** Id of a saved mode in the mode list. */
export const savedId = (name) => `${SAVED_PREFIX}${name}`;
export const isSavedId = (id) => typeof id === 'string' && id.startsWith(SAVED_PREFIX);

/**
 * The modes offered in a lobby: built-in ones (without the skirmish-only
 * ones online) and then the saved ones, as `{ id, name, description,
 * options, saved }`.
 * @param {'skirmish' | 'online'} context
 * @param {{ name: string, options: object }[]} saved
 */
export function modeList(context, saved = []) {
  const builtin = BUILTIN_MODES.filter((m) => context === 'skirmish' || !m.skirmishOnly).map((m) => ({ ...m, saved: false }));
  const own = saved.map((p) => ({
    id: savedId(p.name),
    name: p.name,
    description: 'Your saved mode.',
    options: presetOptions(p.options),
    saved: true,
  }));
  return [...builtin, ...own];
}

/** Whether `options` hold exactly the bundle of `mode`. */
export function matchesMode(options, mode) {
  return PRESET_KEYS.every((k) => options?.[k] === mode.options[k]);
}

/**
 * Which mode `options` are: the `preferred` id when it still matches (a
 * saved mode that equals a built-in one stays itself, Custom stays Custom
 * when the player chose it), else the first mode that matches, else Custom.
 */
export function currentMode(options, modes, preferred = null) {
  if (preferred === CUSTOM) return CUSTOM;
  const pref = preferred && modes.find((m) => m.id === preferred);
  if (pref && matchesMode(options, pref)) return pref.id;
  return modes.find((m) => matchesMode(options, m))?.id ?? CUSTOM;
}

/** `options` with the bundle of `mode` applied (seed, map size, players and the rest kept). */
export function applyMode(options, mode) {
  return { ...options, ...presetOptions(mode.options) };
}

const BUILTIN_NAMES = new Set(BUILTIN_MODES.map((m) => presetNameKey(m.name)));

/**
 * Save the mode bundle of `options` as `name`. A saved mode of the same name
 * (ignoring case) is replaced in place. Returns `{ list, name, replaced }`,
 * or `{ error }` with a sentence for the player.
 */
export function savePreset(list, name, options) {
  let clean;
  try {
    clean = validPresetName(name, 'The name');
  } catch (err) {
    return { error: `${err.message}.` };
  }
  if (BUILTIN_NAMES.has(presetNameKey(clean))) return { error: `"${clean}" is a built-in mode; pick another name.` };
  const entry = { name: clean, options: presetOptions(options) };
  const at = list.findIndex((p) => presetNameKey(p.name) === presetNameKey(clean));
  if (at < 0 && list.length >= PRESETS_MAX) return { error: `You can keep ${PRESETS_MAX} modes; delete one first.` };
  const next = at < 0 ? [...list, entry] : list.map((p, i) => (i === at ? entry : p));
  try {
    return { list: validateSavedPresets(next), name: clean, replaced: at >= 0 };
  } catch (err) {
    return { error: `This setup cannot be saved: ${err.message}.` };
  }
}

/** The list without the saved mode `name`. */
export function deletePreset(list, name) {
  return list.filter((p) => presetNameKey(p.name) !== presetNameKey(name));
}
