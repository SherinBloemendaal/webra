// The website's Play links (apps/website/assets/play-links.js) on a fake DOM:
// "Sign in to play" for signed-out visitors while the game needs an account,
// the account page for accounts that cannot play, the game for the rest.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, uninstallDom, FakeEvent } from './dom-fixtures.mjs';
import { applyPlayAccess, initPlayLinks, isGameLink, playAccess, signInHref } from '../../website/assets/play-links.js';

const ORIGIN = 'https://webra.sherin.dev';
let doc;
beforeEach(() => {
  doc = installDom();
});
afterEach(() => uninstallDom());

/** A fetch that answers /api/auth/me and /api/site. */
function api({ user = null, gameRequiresAccount = true, status = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (status !== 200) return new Response('{}', { status });
    if (url === '/api/auth/me') return Response.json({ user, session: null });
    if (url === '/api/site') return Response.json({ gameRequiresAccount });
    return new Response('{}', { status: 404 });
  };
  return { fetchImpl, calls };
}

function link(href, ...children) {
  const a = doc.createElement('a');
  a.setAttribute('href', href);
  a.append(...children);
  doc.body.append(a);
  return a;
}

test('game links: /play and /play/... on this origin only', () => {
  assert.equal(isGameLink('/play/', ORIGIN), true);
  assert.equal(isGameLink('/play', ORIGIN), true);
  assert.equal(isGameLink('/play/?map=abc', ORIGIN), true);
  assert.equal(isGameLink('/player.html', ORIGIN), false);
  assert.equal(isGameLink('/maps.html', ORIGIN), false);
  assert.equal(isGameLink('https://evil.example/play/', ORIGIN), false);
  assert.equal(signInHref('/play/?join=abc', ORIGIN), '/account/?returnTo=%2Fplay%2F%3Fjoin%3Dabc');
});

test('access: from /api/auth/me, and /api/site only when signed out', async () => {
  let a = api({ user: { canPlay: true } });
  assert.equal(await playAccess(a.fetchImpl), 'allowed');
  assert.deepEqual(a.calls, ['/api/auth/me']);
  a = api({ user: { canPlay: false } });
  assert.equal(await playAccess(a.fetchImpl), 'blocked');
  a = api();
  assert.equal(await playAccess(a.fetchImpl), 'signin');
  assert.deepEqual(a.calls, ['/api/auth/me', '/api/site']);
  a = api({ gameRequiresAccount: false });
  assert.equal(await playAccess(a.fetchImpl), 'allowed');
  a = api({ status: 503 });
  assert.equal(await playAccess(a.fetchImpl), 'unknown');
});

test('signed out: Play buttons say "Sign in to play" and lead to the account page; other links stay', async () => {
  const icon = doc.createElement('svg');
  const hero = link('/play/', icon, '\n  Play now\n');
  const footer = link('/play/', 'Play');
  const editor = link('/play/editor/', 'New map');
  const other = link('/maps.html', 'Maps');
  const access = await initPlayLinks({ doc, origin: ORIGIN, fetchImpl: api().fetchImpl });
  assert.equal(access, 'signin');
  assert.equal(hero.getAttribute('href'), '/account/?returnTo=%2Fplay%2F');
  assert.equal(hero.textContent.trim(), 'Sign in to play');
  assert.equal(hero.childNodes[0], icon, 'the icon stays');
  assert.equal(footer.textContent, 'Sign in to play');
  assert.equal(editor.getAttribute('href'), '/account/?returnTo=%2Fplay%2Feditor%2F');
  assert.equal(editor.textContent, 'New map', 'only plain Play labels change');
  assert.equal(other.getAttribute('href'), '/maps.html');
});

test('links added later (map cards, open games) are rewritten when clicked', () => {
  applyPlayAccess(doc, 'signin', ORIGIN);
  const card = link('/play/?map=abc', 'Play');
  card.dispatchEvent(new FakeEvent('click', { bubbles: true }));
  assert.equal(card.getAttribute('href'), '/account/?returnTo=%2Fplay%2F%3Fmap%3Dabc');
});

test('signed in but not allowed: to the account page; allowed or unknown: unchanged', async () => {
  const a = link('/play/', 'Play now');
  await initPlayLinks({ doc, origin: ORIGIN, fetchImpl: api({ user: { canPlay: false } }).fetchImpl });
  assert.equal(a.getAttribute('href'), '/account/');
  assert.equal(a.textContent, 'Check your account');
  uninstallDom();
  doc = installDom();
  for (const fetchImpl of [api({ user: { canPlay: true } }).fetchImpl, api({ status: 500 }).fetchImpl]) {
    const b = link('/play/', 'Play now');
    await initPlayLinks({ doc, origin: ORIGIN, fetchImpl });
    assert.equal(b.getAttribute('href'), '/play/');
    assert.equal(b.textContent, 'Play now');
  }
});
