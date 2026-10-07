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

export const CURSORS = {
  select: cursor(ARROW, 3, 2, 'default'),
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
  repair: cursor(
    `<g transform="rotate(45 16 16)"><rect x="13.5" y="9" width="5" height="20" rx="2" fill="#7fd0ff" stroke="${OUTLINE}" stroke-width="2"/>` +
      `<path d="M9 3 A7 7 0 1 0 23 3 L19.5 3 L19.5 8 L12.5 8 L12.5 3 Z" fill="#7fd0ff" stroke="${OUTLINE}" stroke-width="2" stroke-linejoin="round"/></g>`,
    16,
    16,
    'alias',
  ),
  rally: cursor(
    `<line x1="8" y1="3" x2="8" y2="29" stroke="${OUTLINE}" stroke-width="4" stroke-linecap="round"/>` +
      `<line x1="8" y1="3" x2="8" y2="29" stroke="#e8e8e8" stroke-width="2" stroke-linecap="round"/>` +
      `<path d="M9 4 L26 9.5 L9 15 Z" fill="#5fe36a" stroke="${OUTLINE}" stroke-width="2" stroke-linejoin="round"/>`,
    8,
    29,
    'pointer',
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

/** Cursor for a smart action code from Game.cursor_action (0 none ... 5 repair). */
export const ACTION_CURSORS = [CURSORS.select, CURSORS.move, CURSORS.attack, CURSORS.harvest, CURSORS.dock, CURSORS.repair];

/** Smart action codes, matching SmartAction in sim/src/world.rs. */
export const ACTION = { NONE: 0, MOVE: 1, ATTACK: 2, HARVEST: 3, DOCK: 4, REPAIR: 5 };
