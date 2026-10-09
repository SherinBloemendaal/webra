// Small monochrome icons for the game's chrome (sidebar buttons, production
// tabs). Drawn as inline SVG paths on a 16 x 16 grid, built with DOM calls
// (no innerHTML, no files to fetch) and coloured by CSS through currentColor.

/** Cog outline: `teeth` teeth around a ring, with a hole (even-odd fill). */
function cogPath(teeth = 8, outer = 7.4, inner = 5.4, hole = 2.3) {
  const pts = [];
  const step = (Math.PI * 2) / teeth;
  for (let i = 0; i < teeth; i++) {
    const a = i * step - Math.PI / 2;
    // Each tooth: rise, flat top, fall; then the valley along the inner ring.
    for (const [da, r] of [
      [-0.3, inner],
      [-0.2, outer],
      [0.2, outer],
      [0.3, inner],
    ]) {
      const t = a + da * step * 1.25;
      pts.push(`${(8 + Math.cos(t) * r).toFixed(2)} ${(8 + Math.sin(t) * r).toFixed(2)}`);
    }
  }
  const ring = `M${pts.join('L')}Z`;
  const h = hole.toFixed(2);
  return `${ring}M${(8 - hole).toFixed(2)} 8a${h} ${h} 0 1 0 ${(hole * 2).toFixed(2)} 0a${h} ${h} 0 1 0 -${(hole * 2).toFixed(2)} 0Z`;
}

/** Path data per icon name (16 x 16 view box). */
export const ICON_PATHS = {
  // Production tabs, in queue order (engine QueueType).
  buildings: 'M1 15V8l4 2.5V8l4 2.5V3h2V1h2v2h2v12Z',
  defense: 'M8 1l6 2.5V8c0 3.6-2.6 6.4-6 7.5C4.6 14.4 2 11.6 2 8V3.5Z',
  infantry: 'M8 1.2a2.3 2.3 0 1 1 0 4.6a2.3 2.3 0 1 1 0-4.6ZM4.4 7h7.2l-1.1 4.6H9.3L8.9 15H7.1l-.4-3.4H5.5Z',
  vehicles: 'M4 4h6v4H4ZM10 5.3h5v1.4h-5ZM1 9h14l-1.6 4.5H2.6Z',
  aircraft:
    'M8 1c.8 0 1.2.8 1.2 2v3.2L15 9.5v1.6l-5.8-1.8v3l1.8 1.3V15L8 14.2L5 15v-1.4l1.8-1.3v-3L1 11.1V9.5l5.8-3.3V3C6.8 1.8 7.2 1 8 1Z',
  naval:
    'M8 1a2 2 0 0 1 .8 3.84V6H11v1.6H8.8v5.8a4.6 4.6 0 0 0 3.6-3.2l-1.4-.4l3-2.2l.6 3.6l-1.3-.5A6.4 6.4 0 0 1 8 15a6.4 6.4 0 0 1-5.3-4.3l-1.3.5l.6-3.6l3 2.2l-1.4.4a4.6 4.6 0 0 0 3.6 3.2V7.6H5V6h2.2V4.84A2 2 0 0 1 8 1ZM8 2.3a.7.7 0 1 0 0 1.4a.7.7 0 1 0 0-1.4Z',
  // Sidebar command buttons.
  sell: 'M7.2 1h1.6v1.6c1.6.2 2.8 1 3.2 2.4l-1.6.6c-.3-.9-1.1-1.4-2.4-1.4c-1.4 0-2.2.6-2.2 1.4c0 .9.8 1.2 2.6 1.6c2.2.5 3.8 1.2 3.8 3.2c0 1.6-1.2 2.7-3.2 3V15H7.2v-1.6c-1.8-.2-3-1.1-3.4-2.6l1.6-.6c.3 1 1.2 1.6 2.6 1.6c1.5 0 2.4-.6 2.4-1.5c0-.9-.8-1.2-2.7-1.7C5.6 8.1 4.2 7.4 4.2 5.6c0-1.5 1.2-2.6 3-2.9Z',
  deploy:
    'M1 1h5L4.3 2.7L6.6 5L5 6.6L2.7 4.3L1 6ZM15 1v5l-1.7-1.7L11 6.6L9.4 5l2.3-2.3L10 1ZM1 15v-5l1.7 1.7L5 9.4L6.6 11l-2.3 2.3L6 15ZM15 15h-5l1.7-1.7L9.4 11L11 9.4l2.3 2.3L15 10Z',
  options: cogPath(),
  power: 'M9.5 1L3 9h4l-1.5 6L13 6.5H8.8Z',
  // OpenRA's Red Alert top row: beacon, repair, power down.
  beacon: 'M7 1h2v5.5h2.6L8 10.2L4.4 6.5H7ZM2 12.6c0-.9 2.7-1.6 6-1.6s6 .7 6 1.6s-2.7 1.6-6 1.6s-6-.7-6-1.6ZM4.4 12.6c0 .3 1.6.6 3.6.6s3.6-.3 3.6-.6s-1.6-.6-3.6-.6s-3.6.3-3.6.6Z',
  repair: 'M10.5 1a4.5 4.5 0 0 0-4.2 6.1L1.4 12a1.6 1.6 0 0 0 2.3 2.3l4.9-4.9a4.5 4.5 0 0 0 6.2-5.8l-2.6 2.6l-2.1-.5l-.5-2.1l2.6-2.6A4.5 4.5 0 0 0 10.5 1Z',
  powerDown: 'M7 1h2v7H7ZM4.3 3.2l1.2 1.6a4.5 4.5 0 1 0 5 0l1.2-1.6a6.5 6.5 0 1 1-7.4 0Z',
};

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * An icon as an <svg> element, hidden from screen readers (the button that
 * holds it carries the accessible name).
 * @param {keyof ICON_PATHS} name
 */
export function icon(name, doc = globalThis.document) {
  const d = ICON_PATHS[name];
  if (!d) throw new Error(`unknown icon: ${name}`);
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', `ui-icon ui-icon-${name}`);
  const path = doc.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill-rule', 'evenodd');
  svg.append(path);
  return svg;
}
