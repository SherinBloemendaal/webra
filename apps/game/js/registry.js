// The settings registry: every user setting of the game, the map editor and
// the lobby in one place, with its schema and default, kept in this browser
// under one localStorage key (REGISTRY_KEY) and synced to the player's
// account (js/account/sync.js). Admins edit the same document on the
// website (apps/website/admin.html) with forms generated from this schema.
//
// The groups and keys are the account's SettingsDocument (docs/accounts-api.md,
// section 5.8): `document()` is what the account stores, and every value the
// registry holds passes the server's validation. Settings without a place in
// that document live in its free `extra` section.
//
//   import { defaultRegistry } from './registry.js';
//   const registry = defaultRegistry();
//   registry.get('audio', 'master');                 // 0.8
//   registry.set('audio', 'master', 0.5);            // normalized, stored, listeners called
//   registry.patch('audio', { master: 0.5, music: 0 });
//   const off = registry.subscribe('audio', (values, changes, origin) => ...);
//
// Values are always valid: a stored or synced value of the wrong type or out
// of range is replaced by the default (numbers are clamped). `checkDocument`
// is the strict variant for editors: it reports every problem instead.
//
// Before the registry, every module kept its own key; `migrateLegacy` reads
// those once (LEGACY_KEYS) so nothing a player set is lost, and removes them
// after the registry key is safely written.
//
// Not settings, and so not here: installed content and texture packs
// (IndexedDB, js/content/store.js), the installed lobby map file and the map
// editor's draft (large data of this device, DEVICE_DATA_KEYS), and the
// per-tab session records in sessionStorage (rejoin, editor test map).
//
// No DOM in this module: Node tests and the website's admin page import it.

import { VIEWS } from './debug-views.js';
import { normalizeVersion } from './releasenotes.js';
import { LIMITS as MAP_LIMITS, TERRAIN, TERRAIN_NAMES } from '../editor/js/mapformat.js';
import { SYMMETRY_MODES } from '../editor/js/symmetry.js';
import { BRUSH_SIZES } from '../editor/js/edits.js';
import { FACTIONS } from '../protocol/constants.js';
import { text as protocolText } from '../protocol/check.js';
import { UI_SCALE_LIMITS, GAME_SCALE_LIMITS, ZOOM_FACTOR_LIMITS, MUSIC_REPEAT_MODES } from '../protocol/accounts.js';
import { PRESETS_MAX, presetNameKey, validateSavedPresets } from '../protocol/presets.js';

/** localStorage key of the registry document. */
export const REGISTRY_KEY = 'webra.prefs.v1';
/** Schema of the settings document (`schema` member). */
export const SCHEMA_VERSION = 1;
/** Largest document (bytes of its JSON), as the account accepts it. */
export const MAX_DOCUMENT_BYTES = 32 * 1024;

/** Limits of free JSON values (lobby.lastOptions, extra): docs/accounts-api.md 5.8. */
export const JSON_RULES = Object.freeze({ maxDepth: 4, key: /^[A-Za-z0-9_.-]{1,64}$/, maxString: 500, maxArray: 64 });
const HOTKEY_ACTION = /^[A-Za-z0-9_.:-]{1,64}$/;
const HOTKEY_COMBO = /^[\x21-\x7e]{1,40}$/;
const PACK_ID = /^[^\u0000-\u001f\u007f]{1,160}$/;

/**
 * Setting types:
 * - number { min, max, step? }: clamped; integer { min, max }: rounded and clamped
 * - scale { min, max, step? }: 'auto' (the game picks one for the screen) or
 *   a number, clamped like number
 * - boolean
 * - choice { options: [values], labels?: { value: text } }
 * - string { maxLength, minLength?, nullable?, version?, name? }: trimmed;
 *   `version` takes a release version, `name` the lobby name text rules
 * - keymap { maxEntries, maxKeys }: { actionName: ['Ctrl+X', ...] } hotkey overrides
 * - packs { maxItems }: [{ id, enabled }] texture packs in priority order
 * - json { maxBytes, nullable? }: a free JSON object (JSON_RULES)
 * - presets { maxItems }: [{ name, options }] saved game modes (protocol/presets.js)
 *
 * Every setting has `label` and may have `help`. Groups have `label`,
 * `description` and `scope` ('game' or 'editor': where they are used);
 * `open: true` (extra) keeps unknown keys that hold valid JSON.
 */
export const GROUPS = deepFreeze({
  game: {
    label: 'Game',
    description: 'Scrolling, mouse capture, graphics, health bars, hotkeys and tips.',
    scope: 'game',
    settings: {
      edgeScrollSpeed: { type: 'number', default: 1, min: 0, max: 3, step: 0.25, label: 'Edge scroll speed', help: '0 turns edge scrolling off.' },
      keyScrollSpeed: { type: 'number', default: 1, min: 0.25, max: 3, step: 0.25, label: 'Arrow key scroll speed' },
      showUnitPaths: { type: 'boolean', default: false, label: 'Show unit paths' },
      // OpenRA TargetLines (Settings.Game.TargetLines, DrawLineToTarget): js/targetlines.js.
      targetLines: {
        type: 'choice',
        default: 'automatic',
        options: ['disabled', 'manual', 'automatic'],
        labels: { disabled: 'Off', manual: 'With Shift', automatic: 'After orders' },
        label: 'Target lines',
      },
      pixelRatioCap: { type: 'number', default: 2, min: 0.5, max: 3, step: 0.25, label: 'Highest pixel ratio', help: 'Lower is faster on phones.' },
      lowQuality: { type: 'boolean', default: false, label: 'Low quality rendering' },
      // Camera shake and the nuke's flash (js/battlefx.js): 'auto' follows prefers-reduced-motion.
      reduceMotion: {
        type: 'choice',
        default: 'auto',
        options: ['auto', 'on', 'off'],
        labels: { auto: 'Like the browser', on: 'On', off: 'Off' },
        label: 'Reduce motion',
        help: 'On: no camera shake and a dim nuclear flash.',
      },
      uiScale: {
        type: 'scale',
        default: 'auto',
        min: UI_SCALE_LIMITS.min,
        max: UI_SCALE_LIMITS.max,
        step: UI_SCALE_LIMITS.step,
        label: 'UI scale',
        help: 'Size of the sidebar, bars, menus and dialogs (1 = 100%). Auto picks one for the screen.',
      },
      gameScale: {
        type: 'scale',
        default: 'auto',
        min: GAME_SCALE_LIMITS.min,
        max: GAME_SCALE_LIMITS.max,
        step: GAME_SCALE_LIMITS.step,
        label: 'Game scale',
        help: 'How big units and terrain appear (1 = 100%); the mouse wheel zooms from there. Auto picks one for the screen.',
      },
      // The player's own zoom (wheel, zoom keys, pinch) as a factor of the game scale's base zoom (js/input.js, js/scale.js).
      zoomFactor: {
        type: 'number',
        default: 1,
        min: ZOOM_FACTOR_LIMITS.min,
        max: ZOOM_FACTOR_LIMITS.max,
        label: 'Remembered zoom',
        help: 'The zoom of your last game as a factor of the game scale (1 = the game scale itself); the next game starts there. Reset zoom and Defaults set it back to 1.',
      },
      healthBars: {
        type: 'choice',
        default: 'damaged',
        options: ['off', 'damaged', 'all'],
        labels: { off: 'Selected and hovered only', damaged: 'Also damaged units and buildings', all: 'All units and buildings' },
        label: 'Health bars',
      },
      // OpenRA UsePlayerStanceColors: you green, allies yellow, enemies red, neutrals tan.
      playerStanceColors: { type: 'boolean', default: false, label: 'Relationship colours', help: 'Colour players by relationship instead of their own colour.' },
      // OpenRA Settings.Game.HideReplayChat and TextNotificationPoolFilters (js/chatlog.js, js/notifications.js).
      hideReplayChat: { type: 'boolean', default: false, label: 'Hide chat in replays', help: "The players' chat stays in the chat history only." },
      uiFeedbackNotifications: { type: 'boolean', default: true, label: 'Show UI feedback notifications', help: 'Text lines for UI events.' },
      gameEventNotifications: { type: 'boolean', default: true, label: 'Show game event notifications', help: 'Text lines for game events.' },
      graphics: {
        type: 'choice',
        default: 'webra',
        options: ['webra', 'original'],
        labels: { webra: 'WebRA art', original: 'Original Red Alert (when installed)' },
        label: 'Graphics',
        help: 'Original graphics need the original content installed on the device.',
      },
      hotkeys: { type: 'keymap', default: {}, maxEntries: 200, maxKeys: 4, label: 'Changed hotkeys', help: 'An empty list leaves the action without a key.' },
      attackMoveTipSeen: {
        type: 'boolean',
        default: false,
        label: 'Attack-move tip shown',
        help: 'The tip shows once, the first time armed units are sent on a plain move past enemies (js/hints.js).',
      },
      // Mouse capture (js/mouselock.js, Pointer Lock API): keeps the mouse in the game on multi-monitor setups.
      mouseCapture: {
        type: 'choice',
        default: 'fullscreen',
        options: ['off', 'fullscreen', 'always'],
        labels: { off: 'Off', fullscreen: 'In fullscreen', always: 'Always (click into the game)' },
        label: 'Capture the mouse',
        help: 'Keeps the pointer inside the game. The release hotkey (Alt+E) or Esc releases it.',
      },
      // Unadjusted movement (raw mouse counts) with WebRA's own acceleration curve, where the browser has it (js/mouselock.js).
      mouseCaptureRaw: {
        type: 'boolean',
        default: false,
        label: 'Raw mouse input',
        help: "Off: the captured pointer moves exactly like the system pointer. On: raw mouse movement with the game's own acceleration, where the browser supports it.",
      },
      mouseCaptureSpeed: { type: 'number', default: 1, min: 0.25, max: 3, step: 0.25, label: 'Captured mouse speed', help: 'Pointer speed while the mouse is captured.' },
      mouseCaptureEscMenu: {
        type: 'boolean',
        default: true,
        label: 'Esc also opens the menu while the mouse is captured',
        help: 'Off: the first Esc only releases the mouse, the next one opens the menu.',
      },
      // The "Mouse captured. Press Alt+E to release." notice (js/mouselock.js): every capture, the first few, or never.
      mouseCaptureNotice: {
        type: 'choice',
        default: 'always',
        options: ['always', 'first', 'off'],
        labels: { always: 'Every time', first: 'First 3 times', off: 'Never' },
        label: 'Mouse captured notice',
        help: 'The short notice at the top that names the key that releases the mouse.',
      },
      // A single-player game whose page is hidden (another tab, a minimised window): the menu opens and pauses it, or it plays on (js/main.js).
      pauseWhenHidden: {
        type: 'boolean',
        default: false,
        label: 'Pause when the game is hidden',
        help: 'Single player: open the menu (and so pause) when the game\'s tab or window is hidden. Off: the game plays on.',
      },
    },
  },
  audio: {
    label: 'Sound',
    description: 'Volumes, speech, original sounds and music.',
    scope: 'game',
    settings: {
      enabled: { type: 'boolean', default: true, label: 'Sound on' },
      master: { type: 'number', default: 0.8, min: 0, max: 1, step: 0.01, label: 'Master volume' },
      effects: { type: 'number', default: 0.8, min: 0, max: 1, step: 0.01, label: 'Effects volume' },
      voices: { type: 'number', default: 0.9, min: 0, max: 1, step: 0.01, label: 'Voices and announcer volume' },
      music: { type: 'number', default: 0.5, min: 0, max: 1, step: 0.01, label: 'Music volume' },
      speech: { type: 'boolean', default: true, label: 'Speak unit replies and announcements' },
      original: { type: 'boolean', default: true, label: 'Use installed original sounds' },
      // OpenRA Settings.Sound.CashTicks.
      cashTicks: { type: 'boolean', default: true, label: 'Cash ticks', help: 'Ticks while the credits counter counts up or down.' },
      // OpenRA plays its ClickSound on every interface button; this can mute them.
      clickSounds: { type: 'boolean', default: true, label: 'Interface clicks', help: 'A click on buttons, tabs and switches, like Red Alert.' },
      // OpenRA Settings.Sound.MuteBackgroundMusic, the other way round.
      menuMusic: { type: 'boolean', default: true, label: 'Main menu music', help: 'The intro track behind the main menu, when the music is installed.' },
      musicOn: { type: 'boolean', default: true, label: 'Music on', help: 'Music needs installed original content or a texture pack with music.' },
      musicShuffle: { type: 'boolean', default: true, label: 'Shuffle music' },
      musicRepeat: {
        type: 'choice',
        default: 'all',
        options: [...MUSIC_REPEAT_MODES],
        labels: { all: 'Repeat all tracks', one: 'Repeat one track', off: 'Stop after the last track' },
        label: 'Repeat music',
      },
    },
  },
  content: {
    label: 'Texture packs',
    description: 'The installed files stay on each device; this is their order and which are on.',
    scope: 'game',
    settings: {
      packs: {
        type: 'packs',
        default: [],
        maxItems: 64,
        label: 'Texture packs',
        help: 'Highest priority first. Packs not installed on a device are skipped there.',
      },
    },
  },
  debug: {
    label: 'Debug views',
    description: 'Local overlays of the debug menu.',
    scope: 'game',
    settings: {
      ...Object.fromEntries(VIEWS.map((v) => [v.key, { type: 'boolean', default: false, label: v.label }])),
      cpuInstances: { type: 'boolean', default: false, label: 'Force the CPU instance path' },
    },
  },
  lobby: {
    label: 'Lobby',
    description: 'Name, faction and colour, the last skirmish setup and saved game modes.',
    scope: 'game',
    settings: {
      name: { type: 'string', default: 'Commander', minLength: 1, maxLength: 20, name: true, label: 'Player name', help: 'Used when not signed in.' },
      faction: { type: 'choice', default: 'random', options: [...FACTIONS], label: 'Faction' },
      color: { type: 'integer', default: 0, min: 0, max: 7, label: 'Colour' },
      lastOptions: { type: 'json', default: {}, maxBytes: 4 * 1024, label: 'Last skirmish setup', help: 'Checked by the lobby when it loads.' },
      presets: {
        type: 'presets',
        default: [],
        maxItems: PRESETS_MAX,
        label: 'Saved game modes',
        help: 'Named bundles of lobby options, picked from the Game mode list in the lobby.',
      },
    },
  },
  releaseNotes: {
    label: 'Release notes',
    description: 'The newest version whose notes were shown.',
    scope: 'game',
    settings: {
      lastSeenVersion: { type: 'string', default: null, nullable: true, maxLength: 64, version: true, label: 'Last seen version' },
    },
  },
  privacy: {
    label: 'Privacy',
    description: 'Error reports to WebRA\'s own Sentry (the privacy notice says what they hold).',
    scope: 'game',
    settings: {
      // js/telemetry/index.js reads it before the game loads and follows every change.
      errorReports: {
        type: 'boolean',
        default: true,
        label: 'Send error reports',
        help: 'When the site has error reporting on and something breaks, the game and the website in this browser send the error, the version and the browser to WebRA\'s own Sentry, without your name, chat or account. The server then reports its own errors either way, without player data.',
      },
    },
  },
  extra: {
    label: 'Other',
    description: 'The original content notice, the mouse capture hint, the map editor and the campaign progress.',
    scope: 'game',
    open: true,
    maxBytes: 8 * 1024,
    settings: {
      contentNoticeDismissed: { type: 'boolean', default: false, label: 'Original content notice dismissed' },
      editorAuthor: { type: 'string', default: '', maxLength: MAP_LIMITS.authorMax, label: 'Map editor: author name' },
      editorMaterial: {
        type: 'choice',
        default: TERRAIN.WATER,
        options: Object.values(TERRAIN),
        labels: Object.fromEntries(Object.values(TERRAIN).map((t) => [t, TERRAIN_NAMES[t]])),
        label: 'Map editor: terrain brush',
      },
      editorSize: { type: 'choice', default: 3, options: [...BRUSH_SIZES], label: 'Map editor: brush size' },
      editorOre: { type: 'integer', default: 8, min: 1, max: MAP_LIMITS.maxOre, label: 'Map editor: ore density' },
      editorGems: { type: 'integer', default: 3, min: 1, max: MAP_LIMITS.maxGems, label: 'Map editor: gem density' },
      editorSymmetry: {
        type: 'choice',
        default: 'none',
        options: SYMMETRY_MODES.map((m) => m.id),
        labels: Object.fromEntries(SYMMETRY_MODES.map((m) => [m.id, m.label])),
        label: 'Map editor: symmetry',
      },
      editorGrid: { type: 'boolean', default: true, label: 'Map editor: show grid' },
      editorPaint: { type: 'choice', default: 'terrain', options: ['terrain', 'ore', 'gems'], label: 'Map editor: what the paint tools paint' },
      editorShapeFill: { type: 'boolean', default: true, label: 'Map editor: filled rectangles and ellipses' },
      editorAutoShore: { type: 'boolean', default: false, label: 'Map editor: beaches along painted water' },
      editorLayers: {
        type: 'json',
        default: {},
        maxBytes: 512,
        label: 'Map editor: layers shown',
        help: 'Which overlays the map editor shows (passability, zones, rush paths and more).',
      },
      // How often the "Mouse captured" hint was shown (js/mouselock.js shows it the first few times).
      mouseCaptureHints: { type: 'integer', default: 0, min: 0, max: 99, label: 'Mouse capture hints shown' },
      // Campaign missions won (js/campaign/progress.js): mission id -> the difficulty it was won on ('' without one).
      campaignProgress: {
        type: 'json',
        default: {},
        maxBytes: 3 * 1024,
        label: 'Campaign progress',
        help: 'The missions won and their difficulty; the next chapter of a campaign opens once one mission of the chapter before is won.',
      },
    },
  },
});

/**
 * Keys that hold data of this device rather than settings: never synced,
 * listed for the data export and so nothing forgets them.
 */
export const DEVICE_DATA_KEYS = Object.freeze({
  'webra.lobby.map.v1': 'The map file installed in the skirmish lobby',
  'webra.editor.draft': 'The map editor draft',
  'webra.editor.recovery': 'Map editor recovery copies of the last maps worked on',
  'webra.editor.stamps': 'Map editor stamps (saved regions)',
});

/** Keys of the modules before the registry, read once by migrateLegacy. */
export const LEGACY_KEYS = Object.freeze([
  'webra.settings',
  'webra.audio.v1',
  'webra.debug.v1',
  'webra.lobby.v2',
  'webra.lobby.v1',
  'webra.online.v1',
  'webra.releaseNotes.seen',
  'webra.content.prompt.v1',
  'webra.editor.prefs',
  'webra.editor.author',
]);

// ---- Values ---------------------------------------------------------------------------

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

const isPlainObject = (v) => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};
const clone = (v) => (v && typeof v === 'object' ? structuredClone(v) : v);
export const jsonBytes = (v) => new TextEncoder().encode(JSON.stringify(v)).length;

/** Whether `group` and `key` name a known setting. */
export function specOf(group, key) {
  const g = Object.hasOwn(GROUPS, group) ? GROUPS[group] : null;
  return g && Object.hasOwn(g.settings, key) ? g.settings[key] : null;
}

/** The default value of a setting (a fresh copy). */
export const defaultOf = (spec) => clone(spec.default);

/** What is wrong with a free JSON value (JSON_RULES), or null. */
export function checkJson(value, depth = 1) {
  if (value === null || typeof value === 'boolean') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? null : 'must hold finite numbers only';
  if (typeof value === 'string') return value.length > JSON_RULES.maxString ? `must hold text of at most ${JSON_RULES.maxString} characters` : null;
  if (depth > JSON_RULES.maxDepth) return `must be at most ${JSON_RULES.maxDepth} levels deep`;
  if (Array.isArray(value)) {
    if (value.length > JSON_RULES.maxArray) return `must hold lists of at most ${JSON_RULES.maxArray} entries`;
    for (const v of value) {
      const p = checkJson(v, depth + 1);
      if (p) return p;
    }
    return null;
  }
  if (!isPlainObject(value)) return 'must hold JSON values only';
  for (const [k, v] of Object.entries(value)) {
    if (!JSON_RULES.key.test(k)) return `has an invalid key "${k.slice(0, 40)}"`;
    const p = checkJson(v, depth + 1);
    if (p) return p;
  }
  return null;
}

/**
 * What is wrong with `value` for `spec`, or null when it is valid. Strict: a
 * number out of range is an error here (normalizeValue clamps it).
 */
export function checkValue(spec, value) {
  switch (spec.type) {
    case 'number':
    case 'integer': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return 'must be a number';
      if (spec.type === 'integer' && !Number.isInteger(value)) return 'must be a whole number';
      if (value < spec.min || value > spec.max) return `must be between ${spec.min} and ${spec.max}`;
      return null;
    }
    case 'scale': {
      if (value === 'auto') return null;
      if (typeof value !== 'number' || !Number.isFinite(value)) return 'must be "auto" or a number';
      if (value < spec.min || value > spec.max) return `must be "auto" or between ${spec.min} and ${spec.max}`;
      return null;
    }
    case 'boolean':
      return typeof value === 'boolean' ? null : 'must be true or false';
    case 'choice':
      return spec.options.includes(value) ? null : `must be one of ${spec.options.map((o) => JSON.stringify(o)).join(', ')}`;
    case 'string': {
      if (value === null) return spec.nullable ? null : 'must be text';
      if (typeof value !== 'string') return 'must be text';
      if (spec.name) {
        try {
          if (protocolText(value, spec.minLength ?? 1, spec.maxLength, 'name') !== value) return 'must not have extra spaces';
        } catch (err) {
          return err.message.replace(/^name /, '');
        }
        return null;
      }
      if (Array.from(value).length < (spec.minLength ?? 0)) return `must be at least ${spec.minLength} characters`;
      if (Array.from(value).length > spec.maxLength) return `must be at most ${spec.maxLength} characters`;
      if (/[\u0000-\u001f\u007f]/.test(value)) return 'must not hold control characters';
      if (spec.version && normalizeVersion(value) !== value) return 'must be a version such as 1.2.3';
      return null;
    }
    case 'keymap': {
      if (!isPlainObject(value)) return 'must be an object of action names to key lists';
      const entries = Object.entries(value);
      if (entries.length > spec.maxEntries) return `must have at most ${spec.maxEntries} actions`;
      for (const [action, keys] of entries) {
        if (!HOTKEY_ACTION.test(action)) return `has an invalid action name "${action.slice(0, 40)}"`;
        if (!Array.isArray(keys) || keys.length > spec.maxKeys) return `${action} must be a list of at most ${spec.maxKeys} keys`;
        if (keys.some((k) => typeof k !== 'string' || !HOTKEY_COMBO.test(k))) return `${action} has an invalid key`;
      }
      return null;
    }
    case 'packs': {
      if (!Array.isArray(value)) return 'must be a list';
      if (value.length > spec.maxItems) return `must have at most ${spec.maxItems} packs`;
      const ids = new Set();
      for (let i = 0; i < value.length; i++) {
        const p = value[i];
        if (!isPlainObject(p) || Object.keys(p).some((k) => k !== 'id' && k !== 'enabled')) return `pack ${i + 1} must be { id, enabled }`;
        if (typeof p.id !== 'string' || !PACK_ID.test(p.id)) return `pack ${i + 1} has an invalid id`;
        if (typeof p.enabled !== 'boolean') return `pack ${i + 1} needs enabled true or false`;
        if (ids.has(p.id)) return `lists pack "${p.id.slice(0, 40)}" twice`;
        ids.add(p.id);
      }
      return null;
    }
    case 'presets': {
      if (Array.isArray(value) && value.length > spec.maxItems) return `must have at most ${spec.maxItems} modes`;
      try {
        validateSavedPresets(value, 'presets');
        return null;
      } catch (err) {
        // "presets[2].options.biome has ..." reads "mode 3 options.biome has ...".
        const m = /^presets\[(\d+)\]\.?(\S*) (.*)$/.exec(err.message);
        if (!m) return err.message.replace(/^presets /, '');
        return `mode ${Number(m[1]) + 1}${m[2] && m[2] !== ':' ? ` ${m[2]}` : m[2]} ${m[3]}`;
      }
    }
    case 'json': {
      if (value === null) return spec.nullable ? null : 'must be an object';
      if (!isPlainObject(value)) return 'must be an object';
      const problem = checkJson(value);
      if (problem) return problem;
      if (jsonBytes(value) > spec.maxBytes) return `must be at most ${spec.maxBytes} bytes`;
      return null;
    }
    default:
      return 'has an unknown type';
  }
}

/** A valid value for `spec` from anything: clamps numbers, trims text, drops bad entries, else the default. */
export function normalizeValue(spec, value) {
  switch (spec.type) {
    case 'number':
    case 'integer': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return defaultOf(spec);
      const v = spec.type === 'integer' ? Math.round(value) : value;
      return Math.min(spec.max, Math.max(spec.min, v));
    }
    case 'scale': {
      if (value === 'auto') return 'auto';
      if (typeof value !== 'number' || !Number.isFinite(value)) return defaultOf(spec);
      return Math.min(spec.max, Math.max(spec.min, value));
    }
    case 'string': {
      if (typeof value !== 'string') return value === null && spec.nullable ? null : defaultOf(spec);
      if (spec.version) return normalizeVersion(value) ?? defaultOf(spec);
      if (spec.name) {
        try {
          return protocolText(Array.from(value).slice(0, spec.maxLength * 2).join(''), spec.minLength ?? 1, spec.maxLength, 'name');
        } catch {
          return defaultOf(spec);
        }
      }
      const v = Array.from(value.trim()).slice(0, spec.maxLength).join('');
      return checkValue(spec, v) ? defaultOf(spec) : v;
    }
    case 'keymap': {
      if (!isPlainObject(value)) return defaultOf(spec);
      const out = {};
      for (const [action, keys] of Object.entries(value).slice(0, spec.maxEntries)) {
        if (!HOTKEY_ACTION.test(action) || !Array.isArray(keys)) continue;
        out[action] = keys.filter((k) => typeof k === 'string' && HOTKEY_COMBO.test(k)).slice(0, spec.maxKeys);
      }
      return out;
    }
    case 'packs': {
      if (!Array.isArray(value)) return defaultOf(spec);
      const out = [];
      for (const p of value) {
        if (out.length >= spec.maxItems) break;
        if (!isPlainObject(p) || typeof p.id !== 'string' || !PACK_ID.test(p.id) || out.some((q) => q.id === p.id)) continue;
        out.push({ id: p.id, enabled: p.enabled !== false });
      }
      return out;
    }
    case 'presets': {
      // Keep every valid mode (first of a name wins), drop the rest.
      if (!Array.isArray(value)) return defaultOf(spec);
      const out = [];
      for (const p of value) {
        if (out.length >= spec.maxItems) break;
        try {
          const [clean] = validateSavedPresets([p], 'presets');
          if (!out.some((q) => presetNameKey(q.name) === presetNameKey(clean.name))) out.push(clean);
        } catch {
          // A bad entry (an older or newer build, a hand edit): skipped.
        }
      }
      return out;
    }
    default:
      return checkValue(spec, value) ? defaultOf(spec) : clone(value);
  }
}

/** Every setting of a group at its default. */
export function groupDefaults(group) {
  return Object.fromEntries(Object.entries(GROUPS[group].settings).map(([k, spec]) => [k, defaultOf(spec)]));
}

/** Every group at its defaults: `{ group: { key: value } }`. */
export function defaultValues() {
  return Object.fromEntries(Object.keys(GROUPS).map((g) => [g, groupDefaults(g)]));
}

/** Keys of an open group (extra) that are not settings but hold valid JSON, within the group's size. */
function keepOpen(group, entries, values) {
  const out = {};
  for (const [key, value] of Object.entries(entries)) {
    if (specOf(group, key) || !JSON_RULES.key.test(key) || checkJson(value, 2)) continue;
    out[key] = clone(value);
  }
  return jsonBytes({ ...out, ...values }) <= GROUPS[group].maxBytes ? out : {};
}

/**
 * Normalize a settings document (or a bare `{ group: { key: value } }`):
 * known settings become valid values, missing ones their default. Unknown
 * groups and keys are dropped (the account refuses them), except valid JSON
 * under `extra`, which is kept for other builds (`open`).
 * @returns {{ values: object, open: object }}
 */
export function normalizeValues(raw) {
  const values = defaultValues();
  const open = {};
  if (!isPlainObject(raw)) return { values, open };
  for (const [group, entries] of Object.entries(raw)) {
    if (!Object.hasOwn(GROUPS, group) || !isPlainObject(entries)) continue;
    for (const [key, value] of Object.entries(entries)) {
      const spec = specOf(group, key);
      if (spec) values[group][key] = normalizeValue(spec, value);
    }
    if (GROUPS[group].open) open[group] = keepOpen(group, entries, values[group]);
  }
  return { values, open };
}

/** A settings document (docs/accounts-api.md 5.8) from values and open keys. */
export function toDocument(values, open = {}) {
  const doc = { schema: SCHEMA_VERSION };
  for (const group of Object.keys(GROUPS)) {
    doc[group] = clone(open[group] ?? {});
    // Null means "not set" (the account takes no nulls): left out.
    for (const [key, value] of Object.entries(values[group])) if (value !== null) doc[group][key] = clone(value);
  }
  return doc;
}

/**
 * Strict check of a settings document, for editors (the admin's JSON
 * editor): every problem as `{ path: 'audio.master', message }`, the paths
 * the server uses too (without its `settings.` prefix). `values` is the
 * normalized result. Missing groups and keys are fine (the client fills
 * defaults).
 */
export function checkDocument(doc) {
  const errors = [];
  if (!isPlainObject(doc)) return { ok: false, errors: [{ path: '', message: 'must be an object of setting groups' }], values: defaultValues() };
  if ('schema' in doc && doc.schema !== SCHEMA_VERSION) errors.push({ path: 'schema', message: `must be ${SCHEMA_VERSION}` });
  if (jsonBytes(doc) > MAX_DOCUMENT_BYTES) errors.push({ path: '', message: `must be at most ${MAX_DOCUMENT_BYTES} bytes` });
  for (const [group, entries] of Object.entries(doc)) {
    if (group === 'schema') continue;
    if (!Object.hasOwn(GROUPS, group)) {
      errors.push({ path: group, message: 'is not a known settings group' });
      continue;
    }
    if (!isPlainObject(entries)) {
      errors.push({ path: group, message: 'must be an object of settings' });
      continue;
    }
    for (const [key, value] of Object.entries(entries)) {
      const spec = specOf(group, key);
      if (!spec) {
        if (!GROUPS[group].open) errors.push({ path: `${group}.${key}`, message: 'is not a known setting' });
        else if (!JSON_RULES.key.test(key)) errors.push({ path: `${group}.${key}`, message: 'is not a valid key' });
        else {
          const problem = checkJson(value, 2);
          if (problem) errors.push({ path: `${group}.${key}`, message: problem });
        }
        continue;
      }
      const problem = checkValue(spec, value);
      if (problem) errors.push({ path: `${group}.${key}`, message: problem });
    }
    if (GROUPS[group].open && jsonBytes(entries) > GROUPS[group].maxBytes) errors.push({ path: group, message: `must be at most ${GROUPS[group].maxBytes} bytes` });
  }
  return { ok: errors.length === 0, errors, values: normalizeValues(doc).values };
}

/** The changed settings between two values objects: `[{ group, key, from, to }]`. */
export function diffValues(a, b) {
  const out = [];
  for (const group of Object.keys(GROUPS)) {
    for (const key of Object.keys(GROUPS[group].settings)) {
      const from = a?.[group]?.[key];
      const to = b?.[group]?.[key];
      if (JSON.stringify(from) !== JSON.stringify(to)) out.push({ group, key, from, to });
    }
  }
  return out;
}

// ---- Migration from the old per-module keys ----------------------------------------------

function readKey(storage, key) {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function readJsonKey(storage, key) {
  const raw = readKey(storage, key);
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * The values the old per-module keys hold (LEGACY_KEYS), as a raw document
 * for normalizeValues, and which keys were found.
 */
export function migrateLegacy(storage) {
  const raw = {};
  const found = LEGACY_KEYS.filter((k) => readKey(storage, k) !== null);
  const put = (group, key, value) => {
    if (value !== undefined) (raw[group] ??= {})[key] = value;
  };
  const settings = readJsonKey(storage, 'webra.settings');
  if (isPlainObject(settings)) {
    for (const key of Object.keys(GROUPS.game.settings)) put('game', key, settings[key]);
  }
  const audio = readJsonKey(storage, 'webra.audio.v1');
  if (isPlainObject(audio)) for (const key of Object.keys(GROUPS.audio.settings)) put('audio', key, audio[key]);
  const debug = readJsonKey(storage, 'webra.debug.v1');
  if (isPlainObject(debug)) for (const key of Object.keys(GROUPS.debug.settings)) put('debug', key, debug[key]);
  const lobby = readJsonKey(storage, 'webra.lobby.v2') ?? readJsonKey(storage, 'webra.lobby.v1');
  if (isPlainObject(lobby)) {
    put('lobby', 'lastOptions', lobby);
    // The human player's slot gives the default name, faction and colour.
    const me = Array.isArray(lobby.players) ? lobby.players.find((p) => p?.type === 'human') : null;
    if (me) {
      put('lobby', 'name', me.name);
      put('lobby', 'faction', me.faction);
      put('lobby', 'color', me.color);
    }
  }
  // The online name was the lobby name online: it wins over the skirmish slot's.
  const online = readJsonKey(storage, 'webra.online.v1');
  if (isPlainObject(online) && typeof online.name === 'string' && online.name.trim()) put('lobby', 'name', online.name);
  const seen = readKey(storage, 'webra.releaseNotes.seen');
  if (seen !== null) put('releaseNotes', 'lastSeenVersion', seen);
  if (readKey(storage, 'webra.content.prompt.v1') === 'no') put('extra', 'contentNoticeDismissed', true);
  const editor = readJsonKey(storage, 'webra.editor.prefs');
  if (isPlainObject(editor)) {
    for (const key of ['material', 'size', 'ore', 'gems', 'symmetry', 'grid']) put('extra', `editor${key[0].toUpperCase()}${key.slice(1)}`, editor[key]);
  }
  const author = readKey(storage, 'webra.editor.author');
  if (author !== null) put('extra', 'editorAuthor', author);
  return { raw, found };
}

// ---- The store ------------------------------------------------------------------------------

function defaultStorage() {
  try {
    // Browsers only: Node exposes an experimental localStorage that warns when touched.
    return globalThis.window?.localStorage ?? null;
  } catch {
    return null;
  }
}

function report(err) {
  if (typeof globalThis.reportError === 'function') globalThis.reportError(err);
  else console.error(err);
}

/**
 * A registry over `storage` (a Web Storage object, or null: memory only).
 * Changes carry an `origin`: 'local' (the player, default), 'remote' (the
 * account document), 'storage' (another tab), so the account sync only
 * uploads the player's own changes.
 * @param {{ storage?: Storage | null, window?: { addEventListener: Function } | null }} [o]
 */
export function createRegistry({ storage = defaultStorage(), window: win = null } = {}) {
  let values;
  let open;
  let storageOk = true;
  const listeners = new Set();

  const load = () => {
    const text = readKey(storage, REGISTRY_KEY);
    let stored = null;
    if (text !== null) {
      try {
        stored = JSON.parse(text);
      } catch {
        stored = null; // corrupt: the legacy keys if any are left, else defaults
      }
    }
    if (isPlainObject(stored)) {
      ({ values, open } = normalizeValues(stored));
      return [];
    }
    const legacy = migrateLegacy(storage);
    ({ values, open } = normalizeValues(legacy.raw));
    return legacy.found;
  };

  const save = () => {
    if (!storage) return false;
    try {
      const text = JSON.stringify(toDocument(values, open));
      storage.setItem(REGISTRY_KEY, text);
      storageOk = storage.getItem(REGISTRY_KEY) === text;
    } catch {
      storageOk = false; // quota or blocked: changes last for this page
    }
    return storageOk;
  };

  const migrated = load();
  if (migrated.length && save()) {
    // The registry holds everything now: the old keys go, so they never come back stale.
    for (const key of migrated) {
      try {
        storage.removeItem?.(key);
      } catch {
        // Left behind: harmless, the registry key wins from now on.
      }
    }
  }

  const emit = (changes, origin) => {
    if (!changes.length) return;
    for (const fn of [...listeners]) {
      try {
        fn(changes, origin);
      } catch (err) {
        report(err);
      }
    }
  };

  /** Apply `{ group: { key: value } }` (known settings only; values normalized). */
  const apply = (patch, origin) => {
    const changes = [];
    for (const [group, entries] of Object.entries(patch)) {
      for (const [key, value] of Object.entries(entries)) {
        const spec = specOf(group, key);
        if (!spec) throw new Error(`Unknown setting "${group}.${key}"`);
        const next = normalizeValue(spec, value);
        if (JSON.stringify(next) === JSON.stringify(values[group][key])) continue;
        const from = values[group][key];
        values[group][key] = next;
        changes.push({ group, key, from: clone(from), to: clone(next) });
      }
    }
    if (changes.length && origin !== 'storage') save();
    emit(changes, origin);
    return changes;
  };

  /** Known settings of a document as a patch, and its open keys taken over. */
  const takeDocument = (doc) => {
    const next = normalizeValues(doc);
    const patch = {};
    for (const [group, entries] of Object.entries(doc)) {
      if (!Object.hasOwn(GROUPS, group) || !isPlainObject(entries)) continue;
      for (const key of Object.keys(entries)) if (specOf(group, key)) (patch[group] ??= {})[key] = next.values[group][key];
    }
    for (const [group, keys] of Object.entries(next.open)) open[group] = keys;
    return patch;
  };

  // Another tab changed the settings: take its values (they are already saved).
  win?.addEventListener?.('storage', (e) => {
    if (e.key !== REGISTRY_KEY || e.newValue === null) return;
    try {
      const doc = JSON.parse(e.newValue);
      if (isPlainObject(doc)) apply(takeDocument(doc), 'storage');
    } catch {
      // Unreadable: keep ours.
    }
  });

  const check = (group, key) => {
    if (!specOf(group, key)) throw new Error(`Unknown setting "${group}.${key}"`);
  };

  return {
    /** Whether the last save reached storage (false: private mode, quota, blocked). */
    get persistent() {
      return !!storage && storageOk;
    },
    /** Keys migrated from the old per-module storage when this registry loaded. */
    migrated,
    get(group, key) {
      check(group, key);
      return clone(values[group][key]);
    },
    /** All settings of a group (a copy). */
    group(group) {
      if (!Object.hasOwn(GROUPS, group)) throw new Error(`Unknown settings group "${group}"`);
      return clone(values[group]);
    },
    /** Change one setting; returns the stored (normalized) value. */
    set(group, key, value, { origin = 'local' } = {}) {
      check(group, key);
      apply({ [group]: { [key]: value } }, origin);
      return clone(values[group][key]);
    },
    /** Change several settings of a group at once (one notification). */
    patch(group, patch, { origin = 'local' } = {}) {
      for (const key of Object.keys(patch)) check(group, key);
      apply({ [group]: patch }, origin);
      return clone(values[group]);
    },
    reset(group, key, opts) {
      check(group, key);
      return this.set(group, key, defaultOf(specOf(group, key)), opts);
    },
    /** The settings document for the account (docs/accounts-api.md 5.8). */
    document() {
      return toDocument(values, open);
    },
    /** Every known setting, `{ group: { key: value } }` (a copy). */
    values() {
      return clone(values);
    },
    /**
     * Take a document from the account (origin 'remote'): its settings are
     * normalized and applied; settings it leaves out keep their value here.
     * Returns the changes.
     */
    applyDocument(doc, { origin = 'remote' } = {}) {
      if (!isPlainObject(doc)) return [];
      const changes = apply(takeDocument(doc), origin);
      if (!changes.length && origin !== 'storage') save(); // open keys may have changed
      return changes;
    },
    /**
     * subscribe(fn): fn(changes, origin) for every change, changes being
     * `[{ group, key, from, to }]`.
     * subscribe(group, fn): fn(groupValues, changes, origin) when that group changes.
     * Returns a function that unsubscribes.
     */
    subscribe(groupOrFn, fn) {
      let listener;
      if (typeof groupOrFn === 'function') listener = groupOrFn;
      else {
        if (!Object.hasOwn(GROUPS, groupOrFn)) throw new Error(`Unknown settings group "${groupOrFn}"`);
        listener = (changes, origin) => {
          const mine = changes.filter((c) => c.group === groupOrFn);
          if (mine.length) fn(clone(values[groupOrFn]), mine, origin);
        };
      }
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

let shared = null;

/** The registry of this page over localStorage (created on first use). */
export function defaultRegistry() {
  shared ??= createRegistry({ window: globalThis.window ?? null });
  return shared;
}
