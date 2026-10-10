// Monochrome icons of the map editor's tools and commands, on the 16 x 16
// grid of the game's chrome icons (js/ui-icons.js): SVG paths built with DOM
// calls (the CSP allows no inline markup), coloured through currentColor.

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Path data per icon (16 x 16 view box, even-odd fill). */
export const EDITOR_ICONS = {
  select: 'M3 1l9 8.5-4 .4 2.6 4.6-1.8 1-2.6-4.7L3 13.5Z',
  region: 'M1 1h4v2H3v2H1Zm6 0h2v2H7Zm4 0h4v4h-2V3h-2ZM1 7h2v2H1Zm12 0h2v2h-2ZM1 11h2v2h2v2H1Zm12 0h2v4h-4v-2h2ZM7 13h2v2H7Z',
  brush: 'M14.5 1.5c.7.7-4.6 7.3-6 8.4L6.1 7.5c1.1-1.4 7.7-6.7 8.4-6ZM5.3 8.4l2.3 2.3c-.4 2.6-2.4 4.3-6.6 3.8 1.6-1 1.1-2.6 1.8-4.4.5-1.1 1.5-1.7 2.5-1.7Z',
  fill: 'M7 1l6 6-5.5 5.5L2 7Zm0 2.1L4.1 6h5.8ZM13.5 9.5s1.5 2 1.5 3a1.5 1.5 0 0 1-3 0c0-1 1.5-3 1.5-3Z',
  line: 'M2.4 14.6 1.4 13.6 13.6 1.4l1 1Z',
  rect: 'M1 3h14v10H1Zm2 2v6h10V5Z',
  ellipse: 'M8 2c3.9 0 7 2.7 7 6s-3.1 6-7 6-7-2.7-7-6 3.1-6 7-6Zm0 2C5.2 4 3 5.8 3 8s2.2 4 5 4 5-1.8 5-4-2.2-4-5-4Z',
  ore: 'M2 12l3-6 3 3 2-5 4 8Zm4.5-9a1.5 1.5 0 1 1 0 .1Z',
  gems: 'M4 2h8l3 4-7 8-7-8Zm1 1.5L3.3 6h3.2Zm6 0L9.5 6h3.2ZM6.3 7.5 8 12l1.7-4.5Z',
  eraser: 'M9.5 1.5 15 7l-7 7H4L1 11Zm-3.8 6L3 10.2 5 12.2h2.2l1.5-1.5Z',
  spawn: 'M3 1h2v1h8l-2 3 2 3H5v7H3Z',
  actor: 'M2 9V6l3-2h6l3 2v3l-1 1v3h-2v-2H5v2H3v-3Zm3-3v2h6V6Z',
  eyedropper: 'M12.2 1.3a1.9 1.9 0 0 1 2.5 2.5l-2 2 .8.8-1.4 1.4-.8-.8-6.1 6.1H3l-1.5 1.4-.6-.6L2.3 13v-2.2l6.1-6.1-.8-.8L9 2.5l.8.8Zm-2.6 4.3L4 11.2V12h.8l5.6-5.6Z',
  paste: 'M5 1h6v2h2v12H3V3h2Zm1 1v2h4V2Zm-1 4v7h6V6Z',
  undo: 'M5 4V1L0 6l5 5V8c4 0 7 1 9 5 0-5-3-9-9-9Z',
  redo: 'M11 4V1l5 5-5 5V8c-4 0-7 1-9 5 0-5 3-9 9-9Z',
  zoomIn: 'M6.5 1a5.5 5.5 0 0 1 4.4 8.8l4.1 4.1-1.1 1.1-4.1-4.1A5.5 5.5 0 1 1 6.5 1Zm0 1.5a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM6 4h1v2h2v1H7v2H6V7H4V6h2Z',
  zoomOut: 'M6.5 1a5.5 5.5 0 0 1 4.4 8.8l4.1 4.1-1.1 1.1-4.1-4.1A5.5 5.5 0 1 1 6.5 1Zm0 1.5a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM4 6h5v1H4Z',
  fit: 'M1 1h5v2H3v3H1Zm9 0h5v5h-2V3h-3ZM1 10h2v3h3v2H1Zm12 0h2v5h-5v-2h3Z',
  play: 'M3 1.5v13L14 8Z',
  upload: 'M8 1l5 5h-3v5H6V6H3ZM2 13h12v2H2Z',
  panels: 'M1 2h14v12H1Zm2 2v8h6V4Zm8 0v2h2V4Zm0 4v2h2V8Z',
  menu: 'M1 3h14v2H1Zm0 4h14v2H1Zm0 4h14v2H1Z',
  help: 'M8 1a7 7 0 1 1 0 14A7 7 0 0 1 8 1Zm0 9.5a1 1 0 1 0 0 2 1 1 0 0 0 0-2ZM8 4C6.3 4 5.2 5 5 6.4l1.6.3c.1-.6.6-1.1 1.4-1.1.8 0 1.3.5 1.3 1.1 0 .9-1.9 1.2-1.9 3h1.6c0-1.2 2-1.5 2-3.1C11.1 5.1 9.8 4 8 4Z',
};

/** An editor icon element (aria-hidden; the button names itself). */
export function editorIcon(name, doc = globalThis.document) {
  const d = EDITOR_ICONS[name];
  if (!d) throw new Error(`unknown editor icon: ${name}`);
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', `ed-icon ed-icon-${name}`);
  const path = doc.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill-rule', 'evenodd');
  svg.append(path);
  return svg;
}
