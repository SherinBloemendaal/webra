// WebRA website behaviour. Plain ES module, no dependencies, no tracking.
// Each page sets <body data-page="..."> and gets its own init below.
// Errors are reported to WebRA's own Sentry unless the visitor switched that
// off (the game's error reports, /lib/js/telemetry/index.js; docs/security.md,
// "Error reports"); builds without a DSN load nothing for it.
//
// Unit and building art is not shipped as images: the gallery imports the
// game's own procedural sprite code (/play/js/sprites.js) and draws every
// icon live onto a canvas, exactly as the in-game sidebar does. While the
// game needs an account (the play gate, docs/security.md), only visitors who
// may play get that module; the others see a note instead of the art.

import { initPlayLinks } from './play-links.js';

const SPRITES_URL = '/play/js/sprites.js';

/** Error reports (null when the module could not load). Started before anything else. */
const telemetry = import('/lib/js/telemetry/index.js').then(
  (t) => {
    t.initTelemetry({ surface: 'website' });
    return t;
  },
  () => null,
);

/** Players' text this page shows (lobby and map names): cut out of error reports. */
function noteUserText(value) {
  telemetry.then((t) => t?.noteUserText(value));
}

// Same values as TEAM_COLORS in apps/game/js/renderer.js (player 1..8).
const TEAM_COLORS = [
  [0.3, 0.55, 0.95],
  [0.9, 0.25, 0.2],
  [0.95, 0.8, 0.25],
  [0.35, 0.8, 0.4],
  [0.8, 0.45, 0.95],
  [0.95, 0.55, 0.2],
  [0.4, 0.85, 0.85],
  [0.85, 0.85, 0.85],
];
const COLOR_NAMES = ['Blue', 'Red', 'Yellow', 'Green', 'Purple', 'Orange', 'Teal', 'Grey'];
const ALLIES_RGB = TEAM_COLORS[0];
const SOVIET_RGB = TEAM_COLORS[1];
const SHARED_RGB = TEAM_COLORS[7];

// Catalog shown on the site. Ids, names, costs and footprints (in cells) match
// engine/rules.json; `side` is who can build it in OpenRA's tech tree.
const UNITS = [
  ['E1', 'Rifle Infantry', 100, 'infantry', 'Both'],
  ['HARV', 'Ore Truck', 1100, 'vehicle', 'Both'],
  ['MCV', 'Mobile Construction Vehicle', 2000, 'vehicle', 'Both'],
  ['TRUK', 'Supply Truck', 500, 'vehicle', 'Both'],
  ['MNLY', 'Minelayer', 800, 'vehicle', 'Both'],
  ['JEEP', 'Ranger', 500, 'vehicle', 'Allies'],
  ['1TNK', 'Light Tank', 700, 'vehicle', 'Allies'],
  ['2TNK', 'Medium Tank', 850, 'vehicle', 'Allies'],
  ['ARTY', 'Artillery', 850, 'vehicle', 'Allies'],
  ['MRJ', 'Mobile Radar Jammer', 1000, 'vehicle', 'Allies'],
  ['MGG', 'Mobile Gap Generator', 1000, 'vehicle', 'England'],
  ['STNK', 'Phase Transport', 1000, 'vehicle', 'France'],
  ['CTNK', 'Chrono Tank', 1350, 'vehicle', 'Germany'],
  ['APC', 'Armored Personnel Carrier', 850, 'vehicle', 'Soviet'],
  ['FTRK', 'Mobile Flak', 600, 'vehicle', 'Soviet'],
  ['3TNK', 'Heavy Tank', 1150, 'vehicle', 'Soviet'],
  ['4TNK', 'Mammoth Tank', 2000, 'vehicle', 'Soviet'],
  ['V2RL', 'V2 Rocket Launcher', 900, 'vehicle', 'Soviet'],
  ['QTNK', 'MAD Tank', 2000, 'vehicle', 'Soviet'],
  ['TTNK', 'Tesla Tank', 1350, 'vehicle', 'Russia'],
  ['DTRK', 'Demolition Truck', 2500, 'vehicle', 'Ukraine'],
].map(([id, name, cost, kind, side]) => ({ id, name, cost, kind, side }));

const STRUCTURES = [
  ['FACT', 'Construction Yard', 2000, 3, 4, 'Both'],
  ['POWR', 'Power Plant', 300, 2, 3, 'Both'],
  ['APWR', 'Advanced Power Plant', 500, 3, 3, 'Both'],
  ['PROC', 'Ore Refinery', 1400, 3, 4, 'Both'],
  ['SILO', 'Silo', 150, 1, 1, 'Both'],
  ['WEAP', 'War Factory', 2000, 3, 3, 'Both'],
  ['FIX', 'Service Depot', 1200, 3, 3, 'Both'],
  ['DOME', 'Radar Dome', 1500, 2, 3, 'Both'],
  ['BRIK', 'Concrete Wall', 200, 1, 1, 'Both'],
  ['MSLO', 'Missile Silo', 2500, 2, 1, 'Both'],
  ['TENT', 'Allied Barracks', 500, 2, 3, 'Allies'],
  ['HPAD', 'Helipad', 500, 2, 3, 'Allies'],
  ['SYRD', 'Naval Yard', 1000, 3, 3, 'Allies'],
  ['ATEK', 'Allied Tech Center', 1500, 2, 3, 'Allies'],
  ['PDOX', 'Chronosphere', 1500, 2, 2, 'Allies'],
  ['GAP', 'Gap Generator', 800, 1, 1, 'Allies'],
  ['PBOX', 'Pillbox', 600, 1, 1, 'Allies'],
  ['HBOX', 'Camo Pillbox', 750, 1, 1, 'Allies'],
  ['GUN', 'Turret', 800, 1, 1, 'Allies'],
  ['AGUN', 'AA Gun', 800, 1, 1, 'Allies'],
  ['SBAG', 'Sandbag Wall', 30, 1, 1, 'Allies'],
  ['BARR', 'Soviet Barracks', 500, 2, 3, 'Soviet'],
  ['KENN', 'Kennel', 200, 1, 1, 'Soviet'],
  ['AFLD', 'Airfield', 500, 3, 2, 'Soviet'],
  ['SPEN', 'Sub Pen', 800, 3, 3, 'Soviet'],
  ['STEK', 'Soviet Tech Center', 1500, 3, 3, 'Soviet'],
  ['IRON', 'Iron Curtain', 2000, 2, 2, 'Soviet'],
  ['FTUR', 'Flame Tower', 600, 1, 1, 'Soviet'],
  ['TSLA', 'Tesla Coil', 1200, 1, 1, 'Soviet'],
  ['SAM', 'SAM Site', 700, 2, 1, 'Soviet'],
  ['FENC', 'Wire Fence', 30, 1, 1, 'Soviet'],
].map(([id, name, cost, width, height, side]) => ({ id, name, cost, kind: 'building', width, height, side }));

const ACTORS = new Map([...UNITS, ...STRUCTURES].map((a) => [a.id, a]));

const ALLIED_SIDES = new Set(['Allies', 'England', 'France', 'Germany']);
const SOVIET_SIDES = new Set(['Soviet', 'Russia', 'Ukraine']);

function sideRgb(side) {
  if (ALLIED_SIDES.has(side)) return ALLIES_RGB;
  if (SOVIET_SIDES.has(side)) return SOVIET_RGB;
  return SHARED_RGB;
}

// ---- Small helpers --------------------------------------------------------

/** Create an element: el('a', { href, class: 'btn' }, 'text', child). */
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    // Through the CSSOM: the Content-Security-Policy blocks style attributes.
    else if (key === 'style') node.style.cssText = String(value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

const numberFormat = new Intl.NumberFormat('en-US');
const dateFormat = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const timeFormat = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

function formatDate(value) {
  if (value === undefined || value === null || value === '') return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : dateFormat.format(d);
}

/** An error with a message that is safe and useful to show to players. */
class ApiError extends Error {}

/** GET a JSON document with a timeout; throws ApiError with a readable message. */
async function getJson(url, { timeoutMs = 8000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, { headers: { accept: 'application/json' }, signal: controller.signal, cache: 'no-store' });
  } catch (err) {
    throw new ApiError(
      err.name === 'AbortError' ? 'The server took too long to answer.' : 'The server could not be reached.',
    );
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new ApiError(`The server answered with HTTP ${res.status}.`);
  const type = res.headers.get('content-type') ?? '';
  if (!type.includes('json')) throw new ApiError('The server did not answer with JSON (is the API running?).');
  let data;
  try {
    data = await res.json();
  } catch {
    throw new ApiError('The server sent a response that is not valid JSON.');
  }
  noteUserText(data);
  return data;
}

// ---- Shared: navigation and build info -----------------------------------

function initNav() {
  const header = document.querySelector('.site-header');
  const toggle = header?.querySelector('.nav-toggle');
  if (!header || !toggle) return;
  const nav = header.querySelector('.site-nav');
  const setOpen = (open) => {
    toggle.setAttribute('aria-expanded', String(open));
    if (open) header.setAttribute('data-open', '');
    else header.removeAttribute('data-open');
  };
  toggle.addEventListener('click', () => setOpen(toggle.getAttribute('aria-expanded') !== 'true'));
  nav.addEventListener('click', (e) => {
    if (e.target.closest('a')) setOpen(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && header.hasAttribute('data-open')) {
      setOpen(false);
      toggle.focus();
    }
  });
}

let versionPromise = null;
/** dist/version.json written by tools/build-dist.mjs, or null when absent. */
function siteVersion() {
  versionPromise ??= getJson('/version.json', { timeoutMs: 5000 }).catch(() => null);
  return versionPromise;
}

async function initBuildInfo() {
  const slot = document.querySelector('[data-build-info]');
  if (!slot) return;
  const info = await siteVersion();
  if (!info || typeof info.version !== 'string') return;
  const commit = typeof info.commit === 'string' && /^[0-9a-f]{7,40}$/.test(info.commit) ? info.commit : null;
  slot.textContent = '';
  slot.append(`v${info.version}`);
  if (commit) {
    slot.append(' (');
    slot.append(
      el('a', { href: `https://github.com/SherinBloemendaal/webra/commit/${commit}`, text: commit.slice(0, 7) }),
    );
    slot.append(')');
  }
}

// ---- Sprites ----------------------------------------------------------------

let spritesPromise = null;
/** The game's sprite module, or null when /play is not available. */
function loadSprites() {
  spritesPromise ??= playLinks.then((access) => {
    // The play gate refuses the module to visitors who may not play: do not ask.
    if (access === 'signin' || access === 'blocked') return null;
    return import(SPRITES_URL).catch((err) => {
      console.warn('webra: could not load the game sprites', err);
      return null;
    });
  });
  return spritesPromise;
}

/** Draw one actor icon. Returns false when the sprite has no draw routine. */
function paintIcon(sprites, canvas, actor, rgb) {
  try {
    sprites.drawIcon(canvas, actor, rgb);
    return true;
  } catch (err) {
    console.warn(`webra: no icon for ${actor.id}`, err);
    return false;
  }
}

/** Show a notice in place of art when the sprite module is missing (or refused: `access` from play-links.js). */
function spritesUnavailable(container, access) {
  if (access === 'signin' || access === 'blocked') {
    container.replaceChildren(
      el(
        'div',
        { class: 'notice' },
        el(
          'p',
          {},
          'The unit art is drawn by the game itself, and the game is for WebRA accounts. ',
          access === 'signin' ? el('a', { href: '/account/?returnTo=%2Fplay%2F', text: 'Sign in to play' }) : el('a', { href: '/account/', text: 'Check your account' }),
          ' to see it.',
        ),
      ),
    );
    return;
  }
  container.replaceChildren(
    el(
      'div',
      { class: 'notice' },
      el(
        'p',
        {},
        'The unit art is drawn by the game itself, but the game files were not found at ',
        el('code', { text: '/play/' }),
        '. Build the site with ',
        el('code', { text: 'npm run build' }),
        ' and serve ',
        el('code', { text: 'dist/' }),
        ' to see it.',
      ),
    ),
  );
}

// ---- Home: hero battlefield -------------------------------------------------

// A small skirmish drawn with the real sprites, in cells on a 22 x 13 grid that
// is anchored to the right edge of the hero. Angles in degrees (0 = facing up).
const HERO_SCENE = {
  cols: 22,
  rows: 13,
  ore: [[13, 1.4], [14, 1.1], [15, 1.7], [13.6, 2.3], [14.8, 2.6], [16, 2.4], [12.6, 2], [15.6, 3.2], [14.2, 3.4], [16.6, 1.4]],
  trees: [[20.5, 1.2, 0.55], [21.3, 1.9, 0.45], [19.8, 2.1, 0.4], [0.8, 11.6, 0.5], [1.6, 12.3, 0.42], [10.5, 0.6, 0.4]],
  rocks: [[18.2, 4.4], [6.4, 11.6]],
  buildings: [
    ['FACT', 2, 1, 0],
    ['POWR', 5.2, 1, 0],
    ['PROC', 2, 5.2, 0],
    ['WEAP', 5.2, 5.6, 0],
    ['GUN', 8.6, 4, 0],
    ['BARR', 19.4, 8.6, 1],
    ['TSLA', 17.6, 8.2, 1],
    ['POWR', 19.6, 5.2, 1],
  ],
  units: [
    ['HARV', 10, 2.4, 70, 0],
    ['2TNK', 9.6, 7.2, 105, 0],
    ['2TNK', 10.4, 8.8, 95, 0],
    ['1TNK', 8.8, 9.9, 80, 0],
    ['ARTY', 7.2, 10.6, 75, 0],
    ['E1', 11.3, 10.2, 90, 0],
    ['E1', 11.8, 10.8, 90, 0],
    ['E1', 11.2, 11.3, 90, 0],
    ['3TNK', 14.6, 7, 265, 1],
    ['3TNK', 15.4, 8.8, 280, 1],
    ['4TNK', 16.8, 6.4, 255, 1],
    ['V2RL', 17.2, 10.8, 290, 1],
    ['E1', 13.7, 10.6, 270, 1],
    ['E1', 14.2, 11.2, 270, 1],
  ],
  shots: [[10.9, 7.4, 13.9, 7.2], [15.0, 8.6, 11.2, 8.9]],
  bursts: [[13.9, 7.2, 0.7], [11.3, 8.9, 0.45]],
};

function drawHeroScene(sprites, canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = canvas.clientWidth;
  const H = canvas.clientHeight;
  if (!W || !H) return;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const S = Math.max(26, Math.min(46, H / HERO_SCENE.rows));
  const ox = W - HERO_SCENE.cols * S;
  const oy = (H - HERO_SCENE.rows * S) / 2;
  const at = (cx, cy) => [ox + cx * S, oy + cy * S];

  // Ore
  for (const [cx, cy] of HERO_SCENE.ore) {
    const [x, y] = at(cx, cy);
    ctx.fillStyle = '#d9a521';
    ctx.beginPath();
    ctx.arc(x, y, S * 0.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#f2cf5b';
    ctx.beginPath();
    ctx.arc(x - S * 0.05, y - S * 0.05, S * 0.07, 0, Math.PI * 2);
    ctx.fill();
  }
  // Rocks and trees
  ctx.fillStyle = '#6b6457';
  for (const [cx, cy] of HERO_SCENE.rocks) {
    const [x, y] = at(cx, cy);
    ctx.beginPath();
    ctx.moveTo(x - S * 0.6, y);
    ctx.lineTo(x - S * 0.2, y - S * 0.45);
    ctx.lineTo(x + S * 0.5, y - S * 0.3);
    ctx.lineTo(x + S * 0.6, y + S * 0.25);
    ctx.lineTo(x, y + S * 0.4);
    ctx.closePath();
    ctx.fill();
  }
  for (const [cx, cy, r] of HERO_SCENE.trees) {
    const [x, y] = at(cx, cy);
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath();
    ctx.arc(x + S * 0.12, y + S * 0.12, r * S, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#244a1c';
    ctx.beginPath();
    ctx.arc(x, y, r * S, 0, Math.PI * 2);
    ctx.fill();
  }

  const team = [TEAM_COLORS[0], TEAM_COLORS[1]];
  const scratch = document.createElement('canvas');

  for (const [id, cx, cy, owner] of HERO_SCENE.buildings) {
    const a = ACTORS.get(id);
    const w = a.width * S;
    const h = a.height * S;
    scratch.width = Math.round(w * dpr);
    scratch.height = Math.round(h * dpr);
    if (!paintIcon(sprites, scratch, a, team[owner])) continue;
    const [x, y] = at(cx, cy);
    ctx.drawImage(scratch, x, y, w, h);
  }

  // Tracers under the units, bursts on top.
  ctx.lineCap = 'round';
  for (const [x0, y0, x1, y1] of HERO_SCENE.shots) {
    const [ax, ay] = at(x0, y0);
    const [bx, by] = at(x1, y1);
    ctx.strokeStyle = 'rgba(255, 230, 150, 0.85)';
    ctx.lineWidth = Math.max(1.5, S * 0.06);
    ctx.setLineDash([S * 0.35, S * 0.25]);
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  for (const [id, cx, cy, deg, owner] of HERO_SCENE.units) {
    const a = ACTORS.get(id);
    const size = (a.kind === 'infantry' ? 0.75 : 1.5) * S;
    scratch.width = scratch.height = Math.round(size * dpr);
    if (!paintIcon(sprites, scratch, a, team[owner])) continue;
    const [x, y] = at(cx, cy);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate((deg * Math.PI) / 180);
    ctx.drawImage(scratch, -size / 2, -size / 2, size, size);
    ctx.restore();
  }

  for (const [cx, cy, r] of HERO_SCENE.bursts) {
    const [x, y] = at(cx, cy);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r * S);
    g.addColorStop(0, 'rgba(255, 250, 220, 0.95)');
    g.addColorStop(0.35, 'rgba(255, 190, 70, 0.9)');
    g.addColorStop(0.7, 'rgba(226, 80, 40, 0.55)');
    g.addColorStop(1, 'rgba(226, 80, 40, 0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r * S, 0, Math.PI * 2);
    ctx.fill();
  }
}

async function initHeroScene() {
  const canvas = document.querySelector('.hero-scene');
  if (!canvas) return;
  const sprites = await loadSprites();
  if (!sprites) return; // the CSS ground stays as a plain backdrop
  let frame = 0;
  const redraw = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => drawHeroScene(sprites, canvas));
  };
  redraw();
  new ResizeObserver(redraw).observe(canvas);
}

// ---- Home: gallery ----------------------------------------------------------

const ICON_PX = 256; // gallery canvas resolution (CSS size is about 150..200 px)

async function initGallery() {
  const root = document.querySelector('[data-gallery]');
  if (!root) return;
  const list = root.querySelector('.gallery');
  const filterButtons = [...root.querySelectorAll('[data-filter]')];
  const swatchBox = root.querySelector('.swatches');

  const sprites = await loadSprites();
  if (!sprites) {
    spritesUnavailable(list.parentElement, await playLinks);
    root.querySelector('.toolbar')?.setAttribute('hidden', '');
    return;
  }

  // Colour choices: by side (default) or one of the eight player colours.
  const choices = [['side', 'By side', 'linear-gradient(135deg, #4d8cf2 50%, #e6403a 50%)']].concat(
    TEAM_COLORS.map((c, i) => [String(i), COLOR_NAMES[i], `rgb(${c.map((v) => Math.round(v * 255)).join(',')})`]),
  );
  for (const [value, label, css] of choices) {
    const input = el('input', { type: 'radio', name: 'team-colour', value, checked: value === 'side', 'aria-label': label });
    const chip = el('span', { class: 'chip', style: `--c: ${css}`, title: label });
    swatchBox.append(el('label', { class: 'swatch' }, input, chip));
  }

  const items = [...UNITS, ...STRUCTURES].map((actor) => {
    const canvas = el('canvas', { width: ICON_PX, height: ICON_PX, role: 'img', 'aria-label': actor.name });
    const sideLabel = actor.side === 'Both' ? 'All sides' : actor.side;
    const li = el(
      'li',
      { class: 'gallery-item panel', 'data-kind': actor.kind === 'building' ? 'structure' : 'unit' },
      canvas,
      el(
        'div',
        { class: 'caption' },
        el('span', { class: 'name', text: actor.name }),
        el(
          'span',
          { class: 'meta' },
          el('span', { text: sideLabel }),
          el('span', { class: 'cost', text: `$${numberFormat.format(actor.cost)}` }),
        ),
      ),
    );
    return { actor, canvas, li };
  });
  list.replaceChildren(...items.map((i) => i.li));

  const paintAll = () => {
    const choice = swatchBox.querySelector('input:checked')?.value ?? 'side';
    for (const { actor, canvas } of items) {
      const rgb = choice === 'side' ? sideRgb(actor.side) : TEAM_COLORS[Number(choice)];
      paintIcon(sprites, canvas, actor, rgb);
    }
  };
  paintAll();
  swatchBox.addEventListener('change', paintAll);

  for (const button of filterButtons) {
    button.addEventListener('click', () => {
      const filter = button.dataset.filter;
      for (const b of filterButtons) b.setAttribute('aria-pressed', String(b === button));
      for (const { li } of items) li.hidden = filter !== 'all' && li.dataset.kind !== filter;
    });
  }
}

// ---- Home: factions ---------------------------------------------------------

async function initFactions() {
  const canvases = [...document.querySelectorAll('canvas[data-actor]')];
  if (!canvases.length) return;
  const sprites = await loadSprites();
  if (!sprites) {
    for (const c of canvases) c.hidden = true;
    return;
  }
  for (const canvas of canvases) {
    const actor = ACTORS.get(canvas.dataset.actor);
    if (!actor) {
      console.warn(`webra: unknown actor ${canvas.dataset.actor}`);
      continue;
    }
    const rgb = canvas.dataset.team ? TEAM_COLORS[Number(canvas.dataset.team)] : sideRgb(actor.side);
    paintIcon(sprites, canvas, actor, rgb);
  }
}

// ---- Data pages: shared list rendering ---------------------------------------

function renderLoading(list, count = 6) {
  list.setAttribute('aria-busy', 'true');
  list.replaceChildren(...Array.from({ length: count }, () => el('li', { class: 'panel skeleton', 'aria-hidden': 'true' })));
}

function renderProblem(list, title, message, onRetry, extra) {
  list.removeAttribute('aria-busy');
  const retry = el('button', { class: 'btn btn-small', type: 'button', text: 'Try again' });
  retry.addEventListener('click', onRetry);
  list.replaceChildren(
    el(
      'li',
      { class: 'notice notice-error', role: 'alert', style: 'grid-column: 1 / -1' },
      el('h2', { class: 'visually-hidden', text: title }),
      el('p', {}, el('strong', { text: `${title}. ` }), message),
      extra ? el('p', {}, extra) : null,
      el('p', {}, retry),
    ),
  );
}

function renderEmpty(list, title, message, action) {
  list.removeAttribute('aria-busy');
  list.replaceChildren(
    el('li', { class: 'panel empty', style: 'grid-column: 1 / -1' }, el('h2', { text: title }), el('p', { text: message }), action ?? null),
  );
}

const LOCAL_DEV_HINT =
  'Running the site locally without the Worker? The API only exists when the site is served by apps/server (wrangler dev).';

function fact(label, value) {
  return el('div', {}, el('dt', { text: label }), el('dd', { text: value }));
}

const MODDED_TITLE = 'This map changes game rules (costs, damage, speed...). It can be unfair or act as a cheat.';

function moddedBadge() {
  return el('span', { class: 'badge badge-modded', title: MODDED_TITLE, text: 'Modded' });
}

function isMapRecord(m) {
  return m && typeof m === 'object' && typeof m.id === 'string' && typeof m.name === 'string';
}

// ---- Maps page --------------------------------------------------------------

async function initMaps() {
  const list = document.querySelector('[data-maps]');
  const status = document.querySelector('[data-status]');
  const search = document.querySelector('#map-search');
  const sort = document.querySelector('#map-sort');
  let maps = null;

  const render = () => {
    if (!maps) return;
    const q = search.value.trim().toLowerCase();
    const shown = maps.filter(
      (m) =>
        !q ||
        m.name.toLowerCase().includes(q) ||
        String(m.author ?? '').toLowerCase().includes(q) ||
        (Array.isArray(m.tags) && m.tags.some((t) => String(t).includes(q))),
    );
    const key = sort.value;
    shown.sort((a, b) => {
      if (key === 'downloads') return (Number(b.downloads) || 0) - (Number(a.downloads) || 0);
      if (key === 'name') return a.name.localeCompare(b.name);
      return new Date(b.createdAt ?? 0) - new Date(a.createdAt ?? 0);
    });
    status.textContent =
      maps.length === 0
        ? ''
        : q
          ? `${shown.length} of ${maps.length} maps match "${search.value.trim()}"`
          : `${maps.length} community ${maps.length === 1 ? 'map' : 'maps'}`;
    if (maps.length === 0) {
      renderEmpty(
        list,
        'No community maps yet',
        'Build one in the map editor and share it: it will show up here for everyone.',
        el('a', { class: 'btn btn-accent', href: '/play/editor/', text: 'Open the map editor' }),
      );
      return;
    }
    if (shown.length === 0) {
      renderEmpty(list, 'No maps match your search', 'Try another name or author.');
      return;
    }
    list.removeAttribute('aria-busy');
    list.replaceChildren(...shown.map(mapCard));
  };

  const load = async () => {
    renderLoading(list);
    status.textContent = 'Loading maps...';
    try {
      const data = await getJson('/api/maps');
      if (!Array.isArray(data)) throw new ApiError('The server sent an unexpected answer.');
      maps = data.filter(isMapRecord);
      render();
    } catch (err) {
      maps = null;
      status.textContent = '';
      const message = err instanceof ApiError ? err.message : 'Something went wrong.';
      renderProblem(list, 'Could not load the maps', message, load, LOCAL_DEV_HINT);
      if (!(err instanceof ApiError)) console.error(err);
    }
  };

  search.addEventListener('input', render);
  sort.addEventListener('change', render);
  await load();
}

function mapCard(m) {
  const id = encodeURIComponent(m.id);
  const headingId = `map-${m.id.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const added = formatDate(m.createdAt);
  const facts = el('dl', { class: 'facts' });
  if (Number.isFinite(m.width) && Number.isFinite(m.height)) facts.append(fact('Size', `${m.width} x ${m.height}`));
  if (Number.isFinite(m.players)) facts.append(fact('Players', String(m.players)));
  if (Number.isFinite(m.downloads)) facts.append(fact('Downloads', numberFormat.format(m.downloads)));
  if (added) facts.append(fact('Added', added));
  // The thumbnail is drawn by the server from the map data (never from art); only same-site API paths.
  const thumb =
    typeof m.thumbnail === 'string' && m.thumbnail.startsWith('/api/maps/')
      ? el('img', { class: 'map-thumb', src: m.thumbnail, alt: `Overview of ${m.name}`, loading: 'lazy', decoding: 'async', width: m.width, height: m.height })
      : null;
  const tags = Array.isArray(m.tags) && m.tags.length ? el('ul', { class: 'tags', 'aria-label': 'Tags' }, ...m.tags.filter((t) => typeof t === 'string').map((t) => el('li', { text: t }))) : null;
  return el(
    'li',
    { class: 'card panel', 'aria-labelledby': headingId },
    thumb,
    el(
      'div',
      { class: 'card-head' },
      el(
        'div',
        {},
        el('h2', { id: headingId, text: m.name }),
        m.author ? el('p', { class: 'by', text: `by ${m.author}` }) : null,
      ),
      m.modded ? el('div', { class: 'badges' }, moddedBadge()) : null,
    ),
    facts,
    tags,
    el(
      'div',
      { class: 'card-actions' },
      el('a', { class: 'btn btn-accent btn-small', href: `/play/?map=${id}`, 'aria-label': `Play ${m.name}`, text: 'Play' }),
      el('a', {
        class: 'btn btn-small',
        href: `/play/editor/?map=${id}`,
        'aria-label': `Open ${m.name} in the editor`,
        text: 'Open in editor',
      }),
    ),
  );
}

// ---- Multiplayer page -------------------------------------------------------

const LOBBY_REFRESH_MS = 15000;

async function initLobbies() {
  const list = document.querySelector('[data-lobbies]');
  const status = document.querySelector('[data-status]');
  const refresh = document.querySelector('[data-refresh]');
  let timer = 0;
  let loading = false;

  const schedule = () => {
    clearTimeout(timer);
    if (document.visibilityState === 'visible') timer = setTimeout(() => load(false), LOBBY_REFRESH_MS);
  };

  const load = async (showSkeleton) => {
    if (loading) return;
    loading = true;
    refresh.disabled = true;
    if (showSkeleton) renderLoading(list, 3);
    status.textContent = 'Looking for open games...';
    try {
      const [data, info] = await Promise.all([getJson('/api/sessions'), siteVersion()]);
      if (!Array.isArray(data)) throw new ApiError('The server sent an unexpected answer.');
      const sessions = data.filter((s) => s && typeof s === 'object' && typeof s.id === 'string');
      // Sessions report the exact build (version+commit); only identical builds can play together.
      const ourVersion = info && typeof info.build === 'string' ? info.build : null;
      const count = `${sessions.length} open ${sessions.length === 1 ? 'game' : 'games'}`;
      status.textContent = `${count}. Updated ${timeFormat.format(new Date())}.`;
      if (sessions.length === 0) {
        renderEmpty(
          list,
          'No open games right now',
          'Host one yourself and share the link, or check back in a minute. This list refreshes by itself.',
          el('a', { class: 'btn btn-accent', href: '/play/', text: 'Host a game' }),
        );
      } else {
        list.removeAttribute('aria-busy');
        list.replaceChildren(...sessions.map((s) => lobbyCard(s, ourVersion)));
      }
    } catch (err) {
      status.textContent = '';
      const message = err instanceof ApiError ? err.message : 'Something went wrong.';
      renderProblem(list, 'Could not load the game list', message, () => load(true), LOCAL_DEV_HINT);
      if (!(err instanceof ApiError)) console.error(err);
    } finally {
      loading = false;
      refresh.disabled = false;
      schedule();
    }
  };

  refresh.addEventListener('click', () => load(false));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') load(false);
    else clearTimeout(timer);
  });
  await load(true);
}

function lobbyCard(s, ourVersion) {
  const players = Number(s.players) || 0;
  const max = Number(s.maxPlayers) || 0;
  const full = max > 0 && players >= max;
  const otherVersion = Boolean(ourVersion && s.version && s.version !== ourVersion);
  const map = s.map && typeof s.map === 'object' ? s.map : null;
  const name = typeof s.name === 'string' && s.name ? s.name : 'Unnamed game';
  const headingId = `lobby-${s.id.replace(/[^a-zA-Z0-9_-]/g, '')}`;

  const badges = el('div', { class: 'badges' });
  if (s.locked) badges.append(el('span', { class: 'badge badge-locked', title: 'Needs a password to join', text: 'Password' }));
  if (map?.modded) badges.append(moddedBadge());
  if (full) badges.append(el('span', { class: 'badge badge-full', text: 'Full' }));
  else if (otherVersion) badges.append(el('span', { class: 'badge badge-warn', text: `v${s.version}` }));
  else badges.append(el('span', { class: 'badge badge-open', text: 'Open' }));

  const facts = el('dl', { class: 'facts' });
  facts.append(fact('Players', max ? `${players} / ${max}` : String(players)));
  if (map?.name) facts.append(fact('Map', map.name));
  if (s.version) facts.append(fact('Version', String(s.version)));

  let action;
  if (full || otherVersion) {
    const why = full ? 'This game is full.' : `This game runs version ${s.version}; this site runs ${ourVersion}.`;
    action = el('span', { class: 'btn btn-small', 'aria-disabled': 'true', title: why, text: full ? 'Full' : 'Other version' });
  } else {
    action = el('a', {
      class: 'btn btn-primary btn-small',
      href: `/play/?join=${encodeURIComponent(s.id)}`,
      'aria-label': `Join ${name}`,
      text: 'Join',
    });
  }

  return el(
    'li',
    { class: 'card panel', 'aria-labelledby': headingId },
    el(
      'div',
      { class: 'card-head' },
      el(
        'div',
        {},
        el('h2', { id: headingId, text: name }),
        s.host ? el('p', { class: 'by', text: `hosted by ${s.host}` }) : null,
      ),
      badges,
    ),
    facts,
    el('div', { class: 'card-actions' }, action),
  );
}

// ---- Changelog page -----------------------------------------------------------
// dist/release-notes.json, written by tools/build-dist.mjs from CHANGELOG.md.
// The game's "What's new" dialog (apps/game/js/releasenotes-dialog.js) shows
// the same data.

const isHttps = (v) => typeof v === 'string' && /^https:\/\/\S+$/.test(v);
const isText = (v) => typeof v === 'string' && v.trim() !== '';
const releaseDateFormat = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

/** Friendly name of a commit scope, from the names the build wrote. */
function scopeName(scopes, scope) {
  if (!isText(scope)) return 'General';
  const names = [];
  for (const part of scope.split(/[,/]/)) {
    const key = part.trim().toLowerCase();
    if (!key) continue;
    const name = Object.hasOwn(scopes, key) && isText(scopes[key]) ? scopes[key] : key.charAt(0).toUpperCase() + key.slice(1);
    if (!names.includes(name)) names.push(name);
  }
  return names.length ? names.join(', ') : 'General';
}

/** Entries grouped by scope name in order of appearance, General last. */
function groupEntries(scopes, entries) {
  const groups = new Map();
  for (const e of entries) {
    const name = scopeName(scopes, e.scope);
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(e);
  }
  const general = groups.get('General');
  groups.delete('General');
  if (general) groups.set('General', general);
  return [...groups];
}

function changelogLink(href, text, label) {
  return el('a', { href, text, 'aria-label': label, rel: 'noopener' });
}

function releaseArticle(r, scopes, liveVersion) {
  const id = `v${r.version}`;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(r.date ?? '') ? new Date(`${r.date}T00:00:00Z`) : null;
  const head = el(
    'header',
    { class: 'release-head' },
    el('h2', { class: 'release-version' }, el('a', { href: `#${id}`, text: `v${r.version}` })),
    r.version === liveVersion ? el('span', { class: 'badge badge-open', title: 'The version webra.sherin.dev runs now', text: 'Live' }) : null,
    date && !Number.isNaN(date.getTime()) ? el('time', { class: 'release-date', datetime: r.date, text: releaseDateFormat.format(date) }) : null,
  );
  const article = el('article', { class: 'panel release', id, 'aria-labelledby': `${id}-title` }, head);
  head.querySelector('h2').id = `${id}-title`;
  const sections = Array.isArray(r.sections) ? r.sections.filter((s) => s && isText(s.title) && Array.isArray(s.entries)) : [];
  if (!sections.length) article.append(el('p', { class: 'release-empty', text: 'Maintenance release without player-facing changes.' }));
  for (const section of sections) {
    const type = /^[a-z0-9-]+$/.test(section.type ?? '') ? section.type : 'other';
    const block = el('section', { class: `release-section release-${type}` }, el('h3', { text: section.title }));
    const entries = section.entries.filter((e) => e && isText(e.text));
    for (const [name, list] of groupEntries(scopes, entries)) {
      const ul = el('ul', { class: 'release-entries' });
      for (const e of list) {
        const commit = typeof e.commit === 'string' && /^[0-9a-f]{7,40}$/.test(e.commit) ? e.commit : null;
        const refs = Array.isArray(e.refs) ? e.refs.filter((x) => x && isText(x.label) && isHttps(x.url)) : [];
        ul.append(
          el(
            'li',
            {},
            el('span', { text: e.text }),
            commit && isHttps(e.url) ? ' ' : null,
            commit && isHttps(e.url) ? changelogLink(e.url, commit, `Commit ${commit} on GitHub`) : null,
            ...refs.flatMap((x) => [' ', changelogLink(x.url, x.label, `${x.label} on GitHub`)]),
          ),
        );
      }
      block.append(el('div', { class: 'release-group' }, el('h4', { text: name }), ul));
    }
    article.append(block);
  }
  if (isHttps(r.compareUrl)) {
    article.append(el('p', { class: 'release-compare' }, changelogLink(r.compareUrl, 'All changes in this release on GitHub')));
  }
  return article;
}

async function initChangelog() {
  const box = document.querySelector('[data-releases]');
  const status = document.querySelector('[data-status]');
  if (!box || !status) return;
  const load = async () => {
    box.setAttribute('aria-busy', 'true');
    status.textContent = 'Loading the changelog...';
    let doc;
    try {
      doc = await getJson('/release-notes.json');
      if (!doc || !Array.isArray(doc.releases)) throw new ApiError('The changelog data is damaged.');
    } catch (err) {
      box.removeAttribute('aria-busy');
      status.textContent = '';
      const retry = el('button', { class: 'btn btn-small', type: 'button', text: 'Try again' });
      retry.addEventListener('click', load);
      box.replaceChildren(
        el(
          'div',
          { class: 'notice notice-error', role: 'alert' },
          el('p', {}, el('strong', { text: 'The changelog could not be loaded. ' }), err instanceof ApiError ? err.message : 'Unexpected data.'),
          el('p', { text: 'Running the site locally? release-notes.json is written by "npm run build" into dist/.' }),
          el('p', {}, retry, ' ', el('a', { href: 'https://github.com/SherinBloemendaal/webra/blob/main/CHANGELOG.md', text: 'Read CHANGELOG.md on GitHub' })),
        ),
      );
      return;
    }
    const scopes = doc.scopes && typeof doc.scopes === 'object' ? doc.scopes : {};
    const releases = doc.releases.filter((r) => r && typeof r.version === 'string' && /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(r.version));
    const live = (await siteVersion())?.version ?? null;
    box.removeAttribute('aria-busy');
    status.textContent = releases.length === 1 ? '1 release' : `${releases.length} releases`;
    box.replaceChildren(...releases.map((r) => releaseArticle(r, scopes, live)));
    if (!releases.length) box.append(el('div', { class: 'panel empty' }, el('h2', { text: 'No releases yet' }), el('p', { text: 'The first release will show up here.' })));
    // A link to one release (/changelog#v0.3.0) lands on it once the list exists.
    try {
      if (location.hash) document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView();
    } catch {
      // A malformed hash: stay at the top.
    }
  };
  load();
}

// ---- Privacy: the "Send error reports" switch ---------------------------------

/**
 * The privacy notice's switch for error reports: the same setting as the
 * game's (settings registry `privacy.errorReports`, synced with the account
 * when the game or the account page runs signed in).
 */
async function initPrivacy() {
  const box = document.getElementById('error-reports-switch');
  if (!box) return;
  let registry;
  try {
    registry = (await import('/lib/js/registry.js')).defaultRegistry();
  } catch {
    box.textContent = 'The setting could not be loaded here; it is also in the game\'s Settings, under Privacy.';
    return;
  }
  const t = await telemetry;
  const input = box.querySelector('input');
  const state = box.querySelector('[data-state]');
  const show = () => {
    const on = registry.get('privacy', 'errorReports');
    input.checked = on;
    state.textContent = on ? 'Error reports are on in this browser.' : 'Error reports are off in this browser: nothing is sent.';
  };
  input.disabled = false;
  input.addEventListener('change', () => {
    registry.set('privacy', 'errorReports', input.checked);
    t?.setConsent(input.checked);
    show();
  });
  registry.subscribe('privacy', show);
  show();
}

// ---- Boot -------------------------------------------------------------------

const PAGES = {
  home: () => Promise.all([initHeroScene(), initGallery(), initFactions()]),
  maps: initMaps,
  multiplayer: initLobbies,
  changelog: initChangelog,
  privacy: initPrivacy,
};

initNav();
initBuildInfo();
const playLinks = initPlayLinks();
PAGES[document.body.dataset.page]?.();
