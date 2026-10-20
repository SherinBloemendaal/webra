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
import { initWebgpuCheck } from './webgpu-check.js';
import { betaBadge, releaseTag } from './site-data.js';
import { INVITE_MESSAGES, formatInviteCode, inviteSummary, invitePath, lookupInvite, normalizeInviteCode, typedInviteCode } from './invite.js';

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

// ---- Home: hero battlefield and the beta badge -------------------------------

/**
 * The hero's battlefield is an inline SVG animated with SMIL, so it plays
 * without script and without the game's sprites. Visitors who ask for less
 * motion get a still copy of it (site.css shows it instead, without
 * script); everyone else gets a Pause button (moving pictures longer than
 * five seconds must be stoppable), and the animation rests while the hero
 * is off screen.
 */
function initHeroArt() {
  const svg = document.querySelector('.hero-live');
  if (!svg || typeof svg.pauseAnimations !== 'function') return;
  const button = document.querySelector('[data-hero-pause]');
  const reduce = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
  let paused = !!reduce?.matches;
  let visible = true;
  const apply = () => {
    if (paused || !visible) svg.pauseAnimations();
    else svg.unpauseAnimations();
    if (button) {
      button.setAttribute('aria-pressed', String(paused));
      button.textContent = paused ? 'Play' : 'Pause';
      button.setAttribute('aria-label', paused ? 'Play the battle animation' : 'Pause the battle animation');
    }
  };
  if (button) {
    button.hidden = false;
    button.addEventListener('click', () => {
      paused = !paused;
      apply();
    });
  }
  reduce?.addEventListener?.('change', () => {
    paused = reduce.matches;
    apply();
  });
  if (typeof IntersectionObserver === 'function') {
    new IntersectionObserver((entries) => {
      visible = entries.some((e) => e.isIntersecting);
      apply();
    }).observe(svg);
  }
  apply();
}

async function initBeta() {
  const badge = document.querySelector('[data-beta]');
  const [site, info] = await Promise.all([getJson('/api/site', { timeoutMs: 5000 }).catch(() => null), siteVersion()]);
  const b = betaBadge(site, info);
  if (badge && b.text) {
    badge.querySelector('[data-beta-text]').textContent = b.text;
    badge.dataset.kind = b.kind;
    badge.hidden = false;
  }
  for (const a of document.querySelectorAll('[data-signup]')) {
    if (b.signup) a.textContent = b.signup;
    // Signing up is closed: the account page still signs people in.
    else {
      a.textContent = 'Sign in';
      a.setAttribute('href', '/account/');
    }
  }
  const note = document.querySelector('[data-signup-note]');
  if (note && b.note) note.textContent = b.note;
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
  const sortSlot = document.querySelector('[data-sort]');
  let maps = null;
  let sortKey = 'newest';

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
    const key = sortKey;
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
  // The design system's select (the shared controls, /lib/js/ui/controls.js).
  try {
    const { selectPlate } = await import('/lib/js/ui/controls.js');
    const sort = selectPlate({
      id: 'map-sort',
      labelledBy: 'map-sort-label',
      options: [
        { value: 'newest', label: 'Newest' },
        { value: 'downloads', label: 'Most played' },
        { value: 'name', label: 'Name' },
      ],
      value: sortKey,
      block: true,
      onChange: (v) => {
        sortKey = v;
        render();
      },
    });
    sortSlot?.replaceChildren(sort.root);
  } catch (err) {
    console.warn('webra: the sort control could not load', err);
    sortSlot?.closest('.field')?.setAttribute('hidden', '');
  }
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

  initJoinCode();

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

/**
 * "Join with a code" (the board "Invite codes"): the six characters a friend
 * gave, or a pasted link. The dash fills in by itself; a whole code is
 * looked up at once and the lobby shown; Join opens /join/<code>, which the
 * Worker sends into the game (through the sign-in when needed).
 */
function initJoinCode() {
  const form = document.querySelector('[data-join-code]');
  if (!form) return;
  const input = form.querySelector('input');
  const result = form.querySelector('[data-join-result]');
  const submit = form.querySelector('button[type="submit"]');
  let looked = null; // { code, r }
  let timer = 0;
  let seq = 0;
  const show = (r) => {
    result.replaceChildren();
    result.dataset.state = r ? (r.ok ? (r.full ? 'warn' : 'ok') : 'bad') : '';
    if (!r) return;
    const lamp = el('span', { class: 'lamp', 'aria-hidden': 'true' });
    if (r.ok) {
      noteUserText(r.invite);
      const name = typeof r.invite.name === 'string' && r.invite.name ? r.invite.name : 'Unnamed game';
      result.append(lamp, el('span', { class: 'join-code-text' }, el('strong', { text: name }), el('span', { text: inviteSummary(r.invite) }), r.message ? el('span', { text: r.message }) : null));
    } else {
      const word = { invalid: 'Not a code', unknown: 'Unknown', expired: 'Expired', rate_limited: 'Too many tries', offline: 'No connection' }[r.reason] ?? 'Error';
      result.append(lamp, el('span', { class: 'join-code-text' }, el('strong', { text: word }), el('span', { text: r.message })));
    }
  };
  const check = async (code) => {
    const mine = ++seq;
    result.dataset.state = 'busy';
    result.replaceChildren(el('span', { class: 'join-code-text', text: 'Looking up the code...' }));
    const r = await lookupInvite(code);
    if (mine !== seq) return;
    looked = { code, r };
    show(r);
  };
  input.addEventListener('input', () => {
    const shown = typedInviteCode(input.value);
    if (shown !== input.value) input.value = shown;
    const code = normalizeInviteCode(shown);
    clearTimeout(timer);
    looked = null;
    seq++;
    if (!code) {
      show(null);
      return;
    }
    timer = setTimeout(() => check(code), 250);
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = normalizeInviteCode(input.value);
    if (!code) {
      show({ ok: false, reason: 'invalid', message: INVITE_MESSAGES.invalid });
      input.focus();
      return;
    }
    clearTimeout(timer);
    if (looked?.code !== code) {
      submit.disabled = true;
      await check(code);
      submit.disabled = false;
    }
    if (looked?.r.ok) location.assign(invitePath(formatInviteCode(code)));
  });
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

/**
 * One release as on the Release notes board: "Version 0.16.0" with its
 * date, then per kind of change (New, Fixed, ...) and part of the game a
 * tagged heading and its entries.
 */
function releaseArticle(r, scopes, liveVersion) {
  const id = `v${r.version}`;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(r.date ?? '') ? new Date(`${r.date}T00:00:00Z`) : null;
  const live = r.version === liveVersion;
  const head = el(
    'header',
    { class: 'release-head' },
    el(
      'div',
      { class: 'release-title' },
      el('span', { class: 'release-kicker', text: live ? 'Live now' : 'Release' }),
      el('h2', { class: 'release-version', id: `${id}-title` }, el('a', { href: `#${id}`, text: `Version ${r.version}` })),
    ),
    live ? el('span', { class: 'badge badge-open badge-live', title: 'The version webra.sherin.dev runs now', text: 'Live' }) : null,
    date && !Number.isNaN(date.getTime()) ? el('time', { class: 'release-date', datetime: r.date, text: releaseDateFormat.format(date) }) : null,
  );
  const article = el('article', { class: 'panel release', id, 'aria-labelledby': `${id}-title` }, head);
  const sections = Array.isArray(r.sections) ? r.sections.filter((s) => s && isText(s.title) && Array.isArray(s.entries)) : [];
  if (!sections.length) article.append(el('p', { class: 'release-empty', text: 'Maintenance release without player-facing changes.' }));
  const body = el('div', { class: 'release-body' });
  for (const section of sections) {
    const type = /^[a-z0-9-]+$/.test(section.type ?? '') ? section.type : 'other';
    const tag = releaseTag(type, section.title);
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
      body.append(
        el(
          'section',
          { class: `release-group release-${type}` },
          el('h3', {}, el('span', { class: `release-tag release-tag-${tag.kind}`, text: tag.text }), el('span', { text: name })),
          ul,
        ),
      );
    }
  }
  if (body.childNodes.length) article.append(body);
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
  home: () => Promise.all([initHeroArt(), initBeta(), initGallery(), initFactions(), initWebgpuCheck()]),
  maps: initMaps,
  multiplayer: initLobbies,
  changelog: initChangelog,
  privacy: initPrivacy,
};

initNav();
initBuildInfo();
const playLinks = initPlayLinks();
PAGES[document.body.dataset.page]?.();
