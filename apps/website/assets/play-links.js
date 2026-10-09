// Play links on the website. While the site requires an account for the
// game, the Worker serves /play only to accounts that may play
// (docs/security.md, "The play gate") and sends everyone else to the account
// page. The links say so up front: "Sign in to play" for signed-out
// visitors (to /account/?returnTo=<the game link>), "Check your account"
// for accounts that cannot play yet, and the plain game link otherwise.
// Links added later (map cards, open games) are rewritten when clicked.

export const ACCOUNT_PAGE = '/account/';
const LABELS = { signin: 'Sign in to play', blocked: 'Check your account' };

/** Whether `href` points at the game on this origin (/play or /play/...). */
export function isGameLink(href, origin) {
  try {
    const u = new URL(href, origin);
    return u.origin === origin && (u.pathname === '/play' || u.pathname.startsWith('/play/'));
  } catch {
    return false;
  }
}

/** The account page that sends the visitor on to this game link (path and query only). */
export function signInHref(href, origin) {
  const u = new URL(href, origin);
  return `${ACCOUNT_PAGE}?returnTo=${encodeURIComponent(u.pathname + u.search)}`;
}

async function getJson(fetchImpl, url) {
  const res = await fetchImpl(url, { headers: { accept: 'application/json' }, cache: 'no-store', credentials: 'same-origin' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * Whether this visitor may load the game: 'allowed', 'signin' (signed out
 * and the game needs an account), 'blocked' (signed in, but pending or
 * banned) or 'unknown' (the API did not answer: links stay as they are,
 * the server decides).
 */
export async function playAccess(fetchImpl = (...a) => globalThis.fetch(...a)) {
  try {
    const me = await getJson(fetchImpl, '/api/auth/me');
    if (me?.user) return me.user.canPlay ? 'allowed' : 'blocked';
    const site = await getJson(fetchImpl, '/api/site');
    return site?.gameRequiresAccount === false ? 'allowed' : 'signin';
  } catch {
    return 'unknown';
  }
}

/** The link's visible label: its last text with content (icons and other markup stay). */
function relabel(a, text) {
  const walker = a.ownerDocument.createTreeWalker?.(a, 4 /* NodeFilter.SHOW_TEXT */);
  let last = null;
  if (walker) {
    for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.textContent.trim()) last = n;
  } else {
    for (const n of a.childNodes) if (n.nodeType === 3 && n.textContent.trim()) last = n;
  }
  if (last) last.textContent = last.textContent.replace(/\S[\s\S]*\S|\S/, text);
  else a.textContent = text;
}

/** Point one game link where this visitor can go; plain "Play" buttons get a label that says why. */
export function adjustLink(a, access, origin) {
  if (access !== 'signin' && access !== 'blocked') return;
  const href = a.getAttribute('href');
  if (!href || !isGameLink(href, origin)) return;
  a.setAttribute('href', access === 'signin' ? signInHref(href, origin) : ACCOUNT_PAGE);
  a.dataset.playGate = access;
  if (/^play( now)?$/i.test(a.textContent.trim())) relabel(a, LABELS[access]);
}

/** Apply the verdict to the page's links now, and to game links clicked later. */
export function applyPlayAccess(doc, access, origin) {
  for (const a of doc.querySelectorAll('a[href]')) adjustLink(a, access, origin);
  if (access !== 'signin' && access !== 'blocked') return;
  doc.addEventListener('click', (e) => {
    const a = e.target?.closest?.('a[href]');
    if (a && !a.dataset.playGate) adjustLink(a, access, origin);
  }, true);
}

export async function initPlayLinks({ doc = globalThis.document, origin = globalThis.location?.origin, fetchImpl } = {}) {
  if (!doc || !origin) return 'unknown';
  const access = await playAccess(fetchImpl);
  applyPlayAccess(doc, access, origin);
  return access;
}
