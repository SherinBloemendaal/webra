// Custom mouse cursors, drawn as small SVGs in the flat 1996 style: bold
// shapes, dark outlines, one strong colour per order type.

const OUTLINE = '#101010';

function cursor(svg, hx, hy, fallback) {
  const body = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">${svg}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(body)}") ${hx} ${hy}, ${fallback}`;
}

/** Four chevrons pointing at the centre (move here). */
function chevrons(color) {
  const one = (r) =>
    `<g transform="rotate(${r} 16 16)"><path d="M11 3 L16 9 L21 3" fill="none" stroke="${OUTLINE}" stroke-width="5" stroke-linejoin="round" stroke-linecap="round"/>` +
    `<path d="M11 3 L16 9 L21 3" fill="none" stroke="${color}" stroke-width="2.6" stroke-linejoin="round" stroke-linecap="round"/></g>`;
  return [0, 90, 180, 270].map(one).join('') + `<circle cx="16" cy="16" r="2.4" fill="${color}" stroke="${OUTLINE}" stroke-width="1.2"/>`;
}

/** Targeting reticle: ring with four ticks and a centre dot. */
function reticle(color, extra = '') {
  const ticks = [
    [16, 1, 16, 8],
    [16, 24, 16, 31],
    [1, 16, 8, 16],
    [24, 16, 31, 16],
  ]
    .map(([x0, y0, x1, y1]) => `<line x1="${x0}" y1="${y0}" x2="${x1}" y2="${y1}" stroke="${OUTLINE}" stroke-width="5" stroke-linecap="round"/><line x1="${x0}" y1="${y0}" x2="${x1}" y2="${y1}" stroke="${color}" stroke-width="2.4" stroke-linecap="round"/>`)
    .join('');
  return (
    `<circle cx="16" cy="16" r="9.5" fill="none" stroke="${OUTLINE}" stroke-width="5"/>` +
    `<circle cx="16" cy="16" r="9.5" fill="none" stroke="${color}" stroke-width="2.4"/>` +
    ticks +
    `<circle cx="16" cy="16" r="2" fill="${color}" stroke="${OUTLINE}" stroke-width="1"/>` +
    extra
  );
}

const ARROW =
  `<path d="M3 2 L3 24 L9 18.5 L13.5 28 L17.5 26 L13 17 L21 17 Z" fill="#d9b23a" stroke="${OUTLINE}" stroke-width="2" stroke-linejoin="round"/>` +
  `<path d="M5.5 7 L5.5 18.5 L9.5 15" fill="none" stroke="#fff3c0" stroke-width="1.2" stroke-linecap="round"/>`;

/** Corner brackets around the centre: where the building goes (footprint drawn by the game). */
const PLACE = (() => {
  const corner = (r) =>
    `<g transform="rotate(${r} 16 16)"><path d="M4 11 L4 4 L11 4" fill="none" stroke="${OUTLINE}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>` +
    `<path d="M4 11 L4 4 L11 4" fill="none" stroke="#5fe36a" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></g>`;
  return [0, 90, 180, 270].map(corner).join('') + `<path d="M16 11 L16 21 M11 16 L21 16" stroke="${OUTLINE}" stroke-width="4" stroke-linecap="round"/><path d="M16 11 L16 21 M11 16 L21 16" stroke="#e8e8e8" stroke-width="1.8" stroke-linecap="round"/>`;
})();

/** Edge scroll directions, clockwise from north, with their (dx, dy). */
export const SCROLL_DIRS = [
  ['N', 0, -1],
  ['NE', 1, -1],
  ['E', 1, 0],
  ['SE', 1, 1],
  ['S', 0, 1],
  ['SW', -1, 1],
  ['W', -1, 0],
  ['NW', -1, -1],
];

/**
 * Edge scroll arrow (Red Alert / OpenRA scroll cursors): a bold arrow pointing
 * off the screen, hotspot on its tip. Blocked (the view cannot move further
 * that way) is the same arrow in grey with a red bar across the tip.
 */
function scrollArrow(angle, blocked) {
  const fill = blocked ? '#8a8a7a' : '#d9b23a';
  const shine = blocked ? '#c4c4b4' : '#fff3c0';
  const bar = blocked
    ? `<path d="M9 6 L23 6" stroke="${OUTLINE}" stroke-width="5" stroke-linecap="round"/><path d="M9 6 L23 6" stroke="#ff4a3a" stroke-width="2.6" stroke-linecap="round"/>`
    : '';
  const svg =
    `<g transform="rotate(${angle} 16 16)">` +
    `<path d="M16 2 L27 13 L20.5 13 L20.5 27 L11.5 27 L11.5 13 L5 13 Z" fill="${fill}" stroke="${OUTLINE}" stroke-width="2" stroke-linejoin="round"/>` +
    `<path d="M16 5.5 L9.5 11.5 M14 15 L14 24.5" fill="none" stroke="${shine}" stroke-width="1.2" stroke-linecap="round"/>` +
    bar +
    `</g>`;
  // Hotspot: the tip (16, 2) turned around the centre, kept inside the image.
  const rad = (angle * Math.PI) / 180;
  const hx = Math.min(31, Math.max(0, Math.round(16 + 14 * Math.sin(rad))));
  const hy = Math.min(31, Math.max(0, Math.round(16 - 14 * Math.cos(rad))));
  return cursor(svg, hx, hy, blocked ? 'not-allowed' : 'move');
}

function scrollCursors() {
  const out = {};
  SCROLL_DIRS.forEach(([dir], i) => {
    out[`scroll${dir}`] = scrollArrow(i * 45, false);
    out[`scroll${dir}Blocked`] = scrollArrow(i * 45, true);
  });
  return out;
}

/** Wrench (the repair cursor of the sidebar's Repair mode, OpenRA "repair"). */
const WRENCH = (fill) =>
  `<g transform="rotate(45 16 16)"><rect x="13.5" y="9" width="5" height="20" rx="2" fill="${fill}" stroke="${OUTLINE}" stroke-width="2"/>` +
  `<path d="M9 3 A7 7 0 1 0 23 3 L19.5 3 L19.5 8 L12.5 8 L12.5 3 Z" fill="${fill}" stroke="${OUTLINE}" stroke-width="2" stroke-linejoin="round"/></g>`;

/** Power symbol (the sidebar's Power down mode, OpenRA "powerdown"). */
const POWER = (fill) =>
  `<path d="M10.5 8.5 A10 10 0 1 0 21.5 8.5" fill="none" stroke="${OUTLINE}" stroke-width="6" stroke-linecap="round"/>` +
  `<path d="M10.5 8.5 A10 10 0 1 0 21.5 8.5" fill="none" stroke="${fill}" stroke-width="3" stroke-linecap="round"/>` +
  `<path d="M16 3 L16 15" stroke="${OUTLINE}" stroke-width="6" stroke-linecap="round"/><path d="M16 3 L16 15" stroke="${fill}" stroke-width="3" stroke-linecap="round"/>`;

/** A red bar across a cursor: the mode has nothing to do here (OpenRA "*-blocked"). */
const BAR =
  `<line x1="6" y1="26" x2="26" y2="6" stroke="${OUTLINE}" stroke-width="6" stroke-linecap="round"/>` +
  `<line x1="6" y1="26" x2="26" y2="6" stroke="#ff4a3a" stroke-width="3" stroke-linecap="round"/>`;

const COIN = (fill, ring) =>
  `<circle cx="16" cy="16" r="12" fill="${fill}" stroke="${OUTLINE}" stroke-width="2.5"/>` +
  `<circle cx="16" cy="16" r="9" fill="none" stroke="${ring}" stroke-width="1.5"/>` +
  `<text x="16" y="21.5" text-anchor="middle" font-family="Arial Black, Impact, sans-serif" font-size="15" font-weight="900" fill="${OUTLINE}">$</text>`;

/** Beacon: an arrow pointing down at a ring on the ground (OpenRA's "ability" cursor for beacons). */
const BEACON =
  `<ellipse cx="16" cy="25" rx="10" ry="4.5" fill="none" stroke="${OUTLINE}" stroke-width="5"/>` +
  `<ellipse cx="16" cy="25" rx="10" ry="4.5" fill="none" stroke="#7fd0ff" stroke-width="2.4"/>` +
  `<path d="M16 3 L16 19 M10 13 L16 19 L22 13" fill="none" stroke="${OUTLINE}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>` +
  `<path d="M16 3 L16 19 M10 13 L16 19 L22 13" fill="none" stroke="#7fd0ff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>`;

export const CURSORS = {
  select: cursor(ARROW, 3, 2, 'default'),
  // Building placement: valid spot (an invalid one shows `blocked`).
  place: cursor(PLACE, 16, 16, 'crosshair'),
  ...scrollCursors(),
  move: cursor(chevrons('#5fe36a'), 16, 16, 'pointer'),
  attack: cursor(reticle('#ff4a3a'), 16, 16, 'crosshair'),
  attackMove: cursor(
    reticle('#ffa030', `<path d="M22 26 L30 26 M26.5 22.5 L30 26 L26.5 29.5" fill="none" stroke="${OUTLINE}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M22 26 L30 26 M26.5 22.5 L30 26 L26.5 29.5" fill="none" stroke="#ffa030" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`),
    16,
    16,
    'crosshair',
  ),
  harvest: cursor(
    `<path d="M16 3 L16 17 M10 11 L16 17 L22 11" fill="none" stroke="${OUTLINE}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>` +
      `<path d="M16 3 L16 17 M10 11 L16 17 L22 11" fill="none" stroke="#f2c94c" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>` +
      [[9, 24], [16, 26], [23, 24], [12.5, 29], [19.5, 29]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="3" fill="#e0a92c" stroke="${OUTLINE}" stroke-width="1.4"/>`).join(''),
    16,
    16,
    'cell',
  ),
  dock: cursor(
    `<rect x="5" y="15" width="22" height="13" rx="2" fill="#3d4a3a" stroke="${OUTLINE}" stroke-width="2"/>` +
      `<path d="M16 2 L16 20 M10 14 L16 20 L22 14" fill="none" stroke="${OUTLINE}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>` +
      `<path d="M16 2 L16 20 M10 14 L16 20 L22 14" fill="none" stroke="#5fe36a" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>`,
    16,
    16,
    'copy',
  ),
  repair: cursor(WRENCH('#7fd0ff'), 16, 16, 'alias'),
  rally: cursor(
    `<line x1="8" y1="3" x2="8" y2="29" stroke="${OUTLINE}" stroke-width="4" stroke-linecap="round"/>` +
      `<line x1="8" y1="3" x2="8" y2="29" stroke="#e8e8e8" stroke-width="2" stroke-linecap="round"/>` +
      `<path d="M9 4 L26 9.5 L9 15 Z" fill="#5fe36a" stroke="${OUTLINE}" stroke-width="2" stroke-linejoin="round"/>`,
    8,
    29,
    'pointer',
  ),
  sell: cursor(COIN('#d9b23a', '#9c7d20'), 16, 16, 'pointer'),
  // Sidebar modes (OpenRA sell-blocked, repair, repair-blocked, powerdown,
  // powerdown-blocked, and the beacon's ability cursor).
  sellBlocked: cursor(COIN('#8a8a7a', '#6a6a5a') + BAR, 16, 16, 'not-allowed'),
  repairMode: cursor(WRENCH('#f2c94c'), 16, 16, 'pointer'),
  repairBlocked: cursor(WRENCH('#8a8a7a') + BAR, 16, 16, 'not-allowed'),
  powerDown: cursor(POWER('#ffd23a'), 16, 16, 'pointer'),
  powerDownBlocked: cursor(POWER('#8a8a7a') + BAR, 16, 16, 'not-allowed'),
  beacon: cursor(BEACON, 16, 25, 'crosshair'),
  deploy: cursor(
    [[0, -1], [1, 0], [0, 1], [-1, 0]]
      .map(([dx, dy]) => {
        const x = 16 + dx * 8;
        const y = 16 + dy * 8;
        const r = Math.atan2(dy, dx) * (180 / Math.PI);
        return `<g transform="rotate(${r} ${x} ${y})"><path d="M${x - 4} ${y - 4} L${x + 3} ${y} L${x - 4} ${y + 4}" fill="none" stroke="${OUTLINE}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>` +
          `<path d="M${x - 4} ${y - 4} L${x + 3} ${y} L${x - 4} ${y + 4}" fill="none" stroke="#7fd0ff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></g>`;
      })
      .join('') + `<rect x="12" y="12" width="8" height="8" fill="#7fd0ff" stroke="${OUTLINE}" stroke-width="1.5"/>`,
    16,
    16,
    'pointer',
  ),
  // Enter a transport: a chevron diving into an open hatch.
  load: cursor(
    `<path d="M4 14 L4 28 L28 28 L28 14" fill="#3d4a3a" stroke="${OUTLINE}" stroke-width="2" stroke-linejoin="round"/>` +
      `<rect x="9" y="20" width="14" height="8" fill="#1d241c" stroke="${OUTLINE}" stroke-width="1.5"/>` +
      `<path d="M9 4 L16 12 L23 4 M9 10 L16 18 L23 10" fill="none" stroke="${OUTLINE}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>` +
      `<path d="M9 4 L16 12 L23 4 M9 10 L16 18 L23 10" fill="none" stroke="#5fe36a" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>`,
    16,
    16,
    'pointer',
  ),
  // Supply truck: a coin dropping into a structure.
  deliver: cursor(
    `<rect x="5" y="16" width="22" height="12" rx="2" fill="#5a5f66" stroke="${OUTLINE}" stroke-width="2"/>` +
      `<rect x="11" y="20" width="10" height="3" fill="#1d241c"/>` +
      `<circle cx="16" cy="9" r="6.5" fill="#d9b23a" stroke="${OUTLINE}" stroke-width="2"/>` +
      `<text x="16" y="12.5" text-anchor="middle" font-family="Arial Black, Impact, sans-serif" font-size="9" font-weight="900" fill="${OUTLINE}">$</text>`,
    16,
    16,
    'copy',
  ),
  // Minelayer: Ctrl + drag a minefield.
  mine: cursor(
    `<ellipse cx="16" cy="20" rx="11" ry="6" fill="#4a4a32" stroke="${OUTLINE}" stroke-width="2"/>` +
      `<ellipse cx="16" cy="18" rx="6" ry="3" fill="#77775a" stroke="${OUTLINE}" stroke-width="1.5"/>` +
      `<path d="M16 2 L16 11 M12 7 L16 11 L20 7" fill="none" stroke="${OUTLINE}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>` +
      `<path d="M16 2 L16 11 M12 7 L16 11 L20 7" fill="none" stroke="#f2c94c" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
    16,
    18,
    'crosshair',
  ),
  // Chrono tank teleport and Chronosphere targets: a cyan vortex.
  teleport: cursor(
    `<circle cx="16" cy="16" r="12" fill="none" stroke="${OUTLINE}" stroke-width="5"/>` +
      `<circle cx="16" cy="16" r="12" fill="none" stroke="#7fe8ff" stroke-width="2.4" stroke-dasharray="6 3"/>` +
      `<circle cx="16" cy="16" r="6" fill="none" stroke="${OUTLINE}" stroke-width="4"/>` +
      `<circle cx="16" cy="16" r="6" fill="none" stroke="#c8f6ff" stroke-width="2"/>` +
      `<circle cx="16" cy="16" r="2" fill="#ffffff" stroke="${OUTLINE}" stroke-width="1"/>`,
    16,
    16,
    'crosshair',
  ),
  // Iron Curtain target: a red shield.
  ironCurtain: cursor(
    `<path d="M16 3 L27 7 L26 17 Q24 25 16 29 Q8 25 6 17 L5 7 Z" fill="#c8281e" stroke="${OUTLINE}" stroke-width="2.2" stroke-linejoin="round"/>` +
      `<path d="M16 7 L23 9.5 L22.3 17 Q21 22 16 25" fill="none" stroke="#ff9a8a" stroke-width="1.6" stroke-linecap="round"/>`,
    16,
    16,
    'crosshair',
  ),
  // Atom bomb target: radiation reticle.
  nuke: cursor(
    reticle(
      '#ffd23a',
      [0, 120, 240]
        .map((r) => `<path d="M16 16 L16 9 A7 7 0 0 1 22.06 12.5 Z" transform="rotate(${r} 16 16)" fill="#ffd23a" stroke="${OUTLINE}" stroke-width="1"/>`)
        .join(''),
    ),
    16,
    16,
    'crosshair',
  ),
  blocked: cursor(
    `<circle cx="16" cy="16" r="11" fill="none" stroke="${OUTLINE}" stroke-width="6"/>` +
      `<circle cx="16" cy="16" r="11" fill="none" stroke="#ff4a3a" stroke-width="3"/>` +
      `<line x1="8.5" y1="23.5" x2="23.5" y2="8.5" stroke="${OUTLINE}" stroke-width="6" stroke-linecap="round"/>` +
      `<line x1="8.5" y1="23.5" x2="23.5" y2="8.5" stroke="#ff4a3a" stroke-width="3" stroke-linecap="round"/>`,
    16,
    16,
    'not-allowed',
  ),
};

/**
 * The OpenRA cursor name of each cursor kind (mods/ra/cursors.yaml): with
 * the original graphics installed a kind shows that cursor from Red Alert's
 * mouse.shp (content/cursors.js, setCursorArt); kinds whose OpenRA cursor
 * Red Alert has no art for keep WebRA's.
 */
export const CURSOR_NAMES = {
  select: 'default',
  // OpenRA shows the default cursor while placing; the footprint shows the cells.
  place: 'default',
  ...Object.fromEntries(
    SCROLL_DIRS.flatMap(([dir], i) => {
      const name = `scroll-${['t', 'tr', 'r', 'br', 'b', 'bl', 'l', 'tl'][i]}`;
      return [
        [`scroll${dir}`, name],
        [`scroll${dir}Blocked`, `${name}-blocked`],
      ];
    }),
  ),
  move: 'move',
  attack: 'attack',
  attackMove: 'attackmove',
  harvest: 'harvest',
  dock: 'enter',
  repair: 'enter',
  rally: 'ability',
  sell: 'sell',
  sellBlocked: 'sell-blocked',
  repairMode: 'repair',
  repairBlocked: 'repair-blocked',
  powerDown: 'powerdown',
  powerDownBlocked: 'powerdown-blocked',
  beacon: 'ability',
  deploy: 'deploy',
  load: 'enter',
  deliver: 'enter',
  mine: 'ability',
  teleport: 'chrono-target',
  ironCurtain: 'ability',
  nuke: 'nuke',
  blocked: 'generic-blocked',
};

/** OpenRA cursor names of the command bar's armed modes (js/commandbar.js COMMAND_CURSORS). */
export const COMMAND_CURSOR_NAMES = { attackGround: 'attack', guard: 'guard', waypoint: 'move' };

/** Cursor tables whose values setCursorArt replaces: [table, kind -> OpenRA name, built-in values]. */
const TABLES = [];

/**
 * Let setCursorArt replace the cursors of `table` (kind -> CSS value) by
 * their OpenRA cursor names in `names` (kind -> name), like CURSORS.
 */
export function registerCursors(table, names) {
  TABLES.push([table, names, { ...table }]);
}
registerCursors(CURSORS, CURSOR_NAMES);

/** Animated cursors in use: [table, kind, frames, fps]. */
let animated = [];

/**
 * Cursors from other art (content/cursors.js originalCursors): `art` maps
 * OpenRA cursor names to { frames: [CSS value], fps }; every kind whose
 * name it has shows those frames, every other kind its built-in cursor.
 * `null` restores the built-in cursors everywhere.
 */
export function setCursorArt(art) {
  animated = [];
  for (const [table, names, builtIn] of TABLES) {
    for (const kind of Object.keys(builtIn)) {
      const c = art?.get(names[kind]);
      table[kind] = c?.frames.length ? c.frames[0] : builtIn[kind];
      if (c && c.frames.length > 1) animated.push([table, kind, c.frames, c.fps]);
    }
  }
}

/** Step animated cursors to `timeMs` (OpenRA's cursors animate); returns whether any changed. */
export function tickCursors(timeMs) {
  let changed = false;
  for (const [table, kind, frames, fps] of animated) {
    const value = frames[Math.floor((Math.max(0, timeMs) / 1000) * fps) % frames.length];
    if (table[kind] !== value) {
      table[kind] = value;
      changed = true;
    }
  }
  return changed;
}

/** An array or object whose entries read `CURSORS` when used (so replaced cursors show everywhere). */
function live(target, keys) {
  for (const [k, kind] of Object.entries(keys)) {
    Object.defineProperty(target, k, { get: () => (Array.isArray(kind) ? kind.map((c) => CURSORS[c]) : CURSORS[kind]), enumerable: true });
  }
  return target;
}

/** Cursor for a smart action code from Game.cursor_action (0 none ... 7 deliver cash). */
export const ACTION_CURSORS = live(new Array(8), ['select', 'move', 'attack', 'harvest', 'dock', 'repair', 'load', 'deliver']);

/** Smart action codes, matching SmartAction in engine/src/world.rs. */
export const ACTION = { NONE: 0, MOVE: 1, ATTACK: 2, HARVEST: 3, DOCK: 4, REPAIR: 5, LOAD: 6, DELIVER_CASH: 7 };

/** Targeting cursor per support power kind (OpenRA trait name). */
export const POWER_CURSORS = live({}, {
  ChronoshiftPower: 'teleport',
  GrantExternalConditionPower: 'ironCurtain',
  NukePower: 'nuke',
});

/** Edge scroll cursor for a scroll direction (dx, dy in -1..1), or null when not scrolling. */
export function scrollCursor(dx, dy, blocked = false) {
  const d = SCROLL_DIRS.find(([, x, y]) => x === Math.sign(dx) && y === Math.sign(dy));
  return d ? CURSORS[`scroll${d[0]}${blocked ? 'Blocked' : ''}`] : null;
}

/** Cursor of a sidebar mode (js/input.js `mode`) over a spot where it can act or not. */
export const MODE_CURSORS = live({}, {
  sell: ['sell', 'sellBlocked'],
  repair: ['repairMode', 'repairBlocked'],
  powerDown: ['powerDown', 'powerDownBlocked'],
  beacon: ['beacon', 'beacon'],
});
