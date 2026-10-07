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
  sell: cursor(
    `<circle cx="16" cy="16" r="12" fill="#d9b23a" stroke="${OUTLINE}" stroke-width="2.5"/>` +
      `<circle cx="16" cy="16" r="9" fill="none" stroke="#9c7d20" stroke-width="1.5"/>` +
      `<text x="16" y="21.5" text-anchor="middle" font-family="Arial Black, Impact, sans-serif" font-size="15" font-weight="900" fill="${OUTLINE}">$</text>`,
    16,
    16,
    'pointer',
  ),
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

/** Cursor for a smart action code from Game.cursor_action (0 none ... 7 deliver cash). */
export const ACTION_CURSORS = [CURSORS.select, CURSORS.move, CURSORS.attack, CURSORS.harvest, CURSORS.dock, CURSORS.repair, CURSORS.load, CURSORS.deliver];

/** Smart action codes, matching SmartAction in engine/src/world.rs. */
export const ACTION = { NONE: 0, MOVE: 1, ATTACK: 2, HARVEST: 3, DOCK: 4, REPAIR: 5, LOAD: 6, DELIVER_CASH: 7 };

/** Targeting cursor per support power kind (OpenRA trait name). */
export const POWER_CURSORS = {
  ChronoshiftPower: CURSORS.teleport,
  GrantExternalConditionPower: CURSORS.ironCurtain,
  NukePower: CURSORS.nuke,
};
