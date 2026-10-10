// End-to-end smoke test against a running local Worker:
//   cd apps/server && npx wrangler d1 migrations apply webra --local
//   npx wrangler dev --port 8799 --local-upstream localhost:8799 --var WEBRA_DEV_ROUTES:1
//   node test/e2e/smoke.mjs http://localhost:8799
// (--local-upstream keeps the request host `localhost`; without it wrangler
// dev presents requests as the production host, and the test-only route,
// local cookies and the passkey rp id `localhost` are not available.)
// Exercises accounts (signup pending approval, an admin made through the
// test-only /api/dev/promote route that exists only under `wrangler dev`,
// approval through the admin API, sign-in), the HTTP API, a
// password-protected lobby with two signed-in humans, an AI and a spectator,
// start, the lockstep relay, hash checks, desync reporting, a spectator
// refused for sending orders, a player reconnecting with its rejoin key
// (order log, sync, resume), leaving, and the stall drop. The play gate:
// anonymous and pending visitors get no game files, an active account gets
// them with a play pass, signing out clears it. A second, two-player lobby
// shares the host's custom map (a file from before map versions; its
// versioned twin is the same map, a newer format is refused) with the
// session only: the guest installs it by hash (checked with the protocol
// package), the game starts on it, the players save it online, a rematch
// brings both back into the lobby with their rejoin keys, and the save is
// resumed in a new session.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { COOP_MISSIONS, encodeClient, encodeReplay, MAP_FORMAT_VERSION, mapHash, MEMBER_HEADER, parseMap, parseServerMessage, PROTOCOL_VERSION, REPLAY_FORMAT, REPLAY_VERSION, sha256Hex } from '@webra/protocol';

const BASE = process.argv[2] || 'http://localhost:8799';
const ORIGIN = new URL(BASE).origin;
const VERSION = '0.2.0+smoke';
const PASSWORD = 'smoke test passphrase';
/** Unique names per run (the local database keeps accounts between runs). */
const RUN = Date.now().toString(36).slice(-6);

/** Session cookies by account (plain HTTP locally: `webra_session`). */
const cookies = new Map();

async function api(path, init = {}, who = null) {
  const headers = { Origin: ORIGIN, 'Content-Type': 'application/json', 'X-WebRA-CSRF': '1', ...init.headers };
  if (who && cookies.has(who)) headers.Cookie = cookies.get(who);
  const res = await fetch(BASE + path, { ...init, headers });
  if (who) {
    for (const c of res.headers.getSetCookie()) {
      const pair = c.split(';')[0];
      if (/^(__Host-)?webra_session=/.test(pair)) {
        if (/Max-Age=0/.test(c)) cookies.delete(who);
        else cookies.set(who, pair);
      }
    }
  }
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/** Sign up `name` (pending approval with the default site settings). */
async function signupAccount(name) {
  const r = await api('/api/auth/signup', { method: 'POST', body: JSON.stringify({ username: name, password: PASSWORD, acceptPrivacy: true }) }, name);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.user;
}

class Client {
  /** `account`: whose session cookie the WebSocket upgrade carries (null: anonymous). */
  constructor(name, account = null) {
    this.name = name;
    this.account = account;
    this.inbox = [];
    this.waiters = [];
    this.closed = false;
  }

  open(id) {
    const url = `${BASE.replace(/^http/, 'ws')}/api/sessions/${id}/ws`;
    const headers = { Origin: ORIGIN };
    if (this.account) headers.Cookie = cookies.get(this.account);
    this.ws = new WebSocket(url, { headers });
    this.ws.addEventListener('message', (e) => {
      const r = parseServerMessage(e.data);
      assert.ok(r.ok, `${this.name} got an invalid server message: ${r.message}`);
      this.inbox.push(r.msg);
      this.flush();
    });
    this.ws.addEventListener('close', () => {
      this.closed = true;
      if (process.env.DEBUG) console.log(this.name, "closed; inbox:", JSON.stringify(this.inbox).slice(0, 600));
      this.flush();
    });
    return new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
  }

  send(msg) {
    this.ws.send(encodeClient(msg));
  }

  sendRaw(text) {
    this.ws.send(text);
  }

  flush() {
    for (const w of [...this.waiters]) {
      const i = this.inbox.findIndex(w.pred);
      if (i >= 0) {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        w.resolve(this.inbox.splice(i, 1)[0]);
      } else if (this.closed) {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        w.reject(new Error(`${this.name}: closed while waiting (${w.what})`));
      }
    }
  }

  /** Wait for (and consume) the first message matching `pred`. */
  next(pred, what = 'message', ms = 5000) {
    return new Promise((resolve, reject) => {
      const w = { pred, resolve, reject, what };
      this.waiters.push(w);
      this.flush();
      setTimeout(() => reject(new Error(`${this.name}: timeout waiting for ${what}`)), ms).unref();
    });
  }

  type(t, extra = () => true) {
    return this.next((m) => m.t === t && extra(m), t);
  }
}

/** One raw request (the path is sent exactly as given) without cookies: { status, location, body }. */
function rawRequest(method, path, headers = {}) {
  const base = new URL(BASE);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: base.hostname, port: base.port, method, path, headers: { Host: base.host, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location ?? null, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * Spellings of game paths (percent-encoded letters and slashes, double
 * encoding, double slashes, dot segments, case, trailing dots and
 * semicolons, backslashes, overlong UTF-8) with every method and a Range
 * header: none may return a game file without the gate. Static Assets
 * answers non-canonical spellings with a redirect to the canonical path
 * (which the gate refuses, checked by following it); the rest are refused
 * by the gate or are 404 / 405.
 */
async function pathVariants() {
  const VARIANTS = [
    '/%70lay/', '/%70lay/index.html', '/%70lay/js/main.js', '/%70lay/pkg/webra_sim_bg.wasm', '/pl%61y/js/main.js', '/%50LAY/js/main.js',
    '/%2570lay/js/main.js', '/play%2Findex.html', '/play%2fjs%2fmain.js', '/%2fplay/js/main.js', '/%2Fplay%2Fjs%2Fmain.js',
    '//play/', '//play/js/main.js', '///play//js//main.js', '/PLAY/', '/Play/js/main.js', '/pLaY/pkg/webra_sim_bg.wasm',
    '/play/./js/main.js', '/./play/js/main.js', '/x/../play/js/main.js', '/lib/../play/js/main.js', '/lib/%2e%2e/play/js/main.js',
    '/lib/%2E%2E%2Fplay/js/main.js', '/play/..%2fplay/js/main.js', '/api/..%2fplay/js/main.js', '/play.', '/play./js/main.js',
    '/play;x/js/main.js', '/play%3Bx/js/main.js', '/play%20/js/main.js', '/play\\js\\main.js', '/play%5Cjs%5Cmain.js',
    '/play/js/main.js;', '/play/js/main.js.', '/play/js/main.js/', '/%C0%AFplay/js/main.js', '/play%C0%AFjs/main.js',
    '/play/js/main.js%00', '/play/pkg/webra_sim_bg.wasm',
  ];
  const WASM_MAGIC = Buffer.from([0x00, 0x61, 0x73, 0x6d]);
  const gameLike = (body) => body.includes(WASM_MAGIC) || /\bimport\b|<canvas|webra_sim/.test(body.toString('latin1'));
  const counts = {};
  for (const path of VARIANTS) {
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'POST']) {
      for (const headers of [{}, { Range: 'bytes=0-3' }, { 'Sec-Fetch-Mode': 'navigate', Accept: 'text/html' }]) {
        const r = await rawRequest(method, path, headers);
        const what = `${method} ${path} ${JSON.stringify(headers)}`;
        counts[r.status] = (counts[r.status] ?? 0) + 1;
        assert.ok(![200, 206, 304].includes(r.status), `${what}: ${r.status} without the gate`);
        assert.ok(!gameLike(r.body), `${what}: game content in a ${r.status}`);
        if (r.status >= 300 && r.status < 400) {
          const target = new URL(r.location, BASE);
          assert.equal(target.origin, ORIGIN, `${what}: redirect stays on this site`);
          // The gate's own redirect to sign in (a page load): nothing to follow.
          if (target.pathname === '/account/') {
            assert.match(target.search, /^\?returnTo=%2Fplay/, `${what}: sign in, then back to the game`);
            continue;
          }
          // Follow the redirect (twice at most), still without cookies: refused or sent to sign in.
          let next = await rawRequest(method === 'HEAD' ? 'HEAD' : 'GET', target.pathname + target.search, headers);
          if (next.status >= 300 && next.status < 400 && !/^\/account\//.test(next.location ?? '')) {
            const t2 = new URL(next.location, BASE);
            next = await rawRequest('GET', t2.pathname + t2.search, headers);
          }
          assert.ok([302, 401, 403, 404, 405].includes(next.status), `${what} -> ${r.location}: ${next.status}`);
          if (next.status === 302) assert.match(next.location ?? '', /^\/account\/\?returnTo=%2Fplay/, `${what}: the redirect is the sign-in`);
          assert.ok(!gameLike(next.body), `${what} -> ${r.location}: game content`);
        }
      }
    }
  }
  console.log(`  path variants: ${VARIANTS.length} spellings x 4 methods x 3 header sets, statuses ${JSON.stringify(counts)}`);
}

/**
 * The map editor as a browser loads it: every spelling of its URL ends on
 * /play/editor/ (Static Assets redirects the others there), and the page,
 * every file it names (resolved against its <base>), every module its
 * scripts import (followed over HTTP) and the renderer's shaders come
 * through the gate with the account's cookies, with the right types.
 */
async function editorPage(get, cookie, NAV, SUB, securityHeaders) {
  const TYPES = { html: /text\/html/, js: /javascript/, css: /text\/css/, wgsl: /text\/plain|wgsl|octet-stream/, wasm: /application\/wasm/ };
  let checked = 0;
  for (const spelling of ['/play/editor', '/play/editor/', '/play/editor/index.html', '/play/editor?map=abc', '/play/editor/?map=abc', '/play//editor/']) {
    let url = new URL(spelling, BASE);
    let r = await get(url.pathname + url.search, NAV, cookie);
    for (let hops = 0; r.status >= 300 && r.status < 400 && hops < 3; hops++) {
      await r.arrayBuffer();
      url = new URL(r.headers.get('location'), url);
      r = await get(url.pathname + url.search, NAV, cookie);
    }
    assert.equal(r.status, 200, `${spelling} -> ${url.pathname}`);
    assert.equal(url.pathname, '/play/editor/', `${spelling} ends on the canonical URL`);
    securityHeaders(r, `editor ${spelling}`);
    const html = await r.text();
    const base = new URL(html.match(/<base href="([^"]+)"/)[1], url);
    const queue = [...html.matchAll(/(?:href|src)="([^"#]+)"/g)].map((m) => new URL(m[1], base).pathname).filter((p) => p !== '/play/');
    for (const s of ['common', 'terrain', 'sprite', 'fog', 'rect', 'line', 'weather', 'sky', 'heat']) queue.push(`/play/shaders/${s}.wgsl`);
    queue.push('/play/pkg/webra_sim_bg.wasm');
    const seen = new Set();
    while (queue.length) {
      const path = queue.shift();
      if (seen.has(path)) continue;
      seen.add(path);
      const a = await get(path, SUB, cookie);
      assert.equal(a.status, 200, `${spelling}: ${path}`);
      const type = TYPES[path.split('.').pop()];
      if (type) assert.match(a.headers.get('content-type') ?? '', type, `${path} content type`);
      const body = await a.text();
      if (path.endsWith('.js')) {
        for (const m of body.matchAll(/(?:^|\n)\s*(?:import|export)[^'"]*?from\s+'(\.[^']+)'/g)) queue.push(new URL(m[1], new URL(path, BASE)).pathname);
      }
    }
    checked = seen.size;
  }
  console.log(`  map editor: 6 URL spellings, ${checked} files each through the gate`);
}

/** The play gate (src/playgate.js): who gets /play, the pass, sign-out. */
async function playGate(ADMIN, HOST) {
  const site = await api('/api/site');
  assert.equal(site.body.gameRequiresAccount, true, 'the game needs an account by default');
  const NAV = { 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document', Accept: 'text/html' };
  const SUB = { 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty', Accept: '*/*' };
  const WASM = '/play/pkg/webra_sim_bg.wasm';
  // Node's fetch replaces Sec-Fetch-* with its own values (forbidden request
  // headers): requests are sent with node:http, as a browser would send them.
  const get = (path, headers, cookie = null) =>
    new Promise((resolve, reject) => {
      const req = httpRequest(BASE + path, { headers: { ...headers, ...(cookie ? { Cookie: cookie } : {}) } }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const h = new Headers();
          for (const [k, v] of Object.entries(res.headers)) for (const one of [].concat(v)) h.append(k, one);
          resolve(new Response(res.statusCode === 304 || res.statusCode === 204 ? null : Buffer.concat(chunks), { status: res.statusCode, headers: h }));
        });
      });
      req.on('error', reject);
      req.end();
    });
  const passOf = (res) => res.headers.getSetCookie().find((c) => /^webra_play=/.test(c)) ?? null;
  const securityHeaders = (res, what) => {
    assert.match(res.headers.get('content-security-policy') ?? '', /default-src 'self'/, `${what}: CSP`);
    assert.equal(res.headers.get('cross-origin-opener-policy'), 'same-origin', `${what}: COOP`);
    assert.equal(res.headers.get('cross-origin-embedder-policy'), 'require-corp', `${what}: COEP`);
    assert.equal(res.headers.get('cross-origin-resource-policy'), 'same-origin', `${what}: CORP`);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff', `${what}: nosniff`);
  };

  // Anonymous: page loads go to sign in, files are refused without content.
  for (const [path, target] of [
    ['/play/', '/play/'],
    ['/play', '/play'],
    ['/play/editor/', '/play/editor/'],
    ['/play/?join=abc', '/play/?join=abc'],
  ]) {
    const r = await get(path, NAV);
    assert.equal(r.status, 302, path);
    assert.equal(r.headers.get('location'), `/account/?returnTo=${encodeURIComponent(target)}`, path);
    securityHeaders(r, `redirect ${path}`);
  }
  for (const path of [WASM, '/play/js/main.js', '/play/js/sim/worker.js', '/play/protocol/accounts.js', '/play/index.html']) {
    const r = await get(path, SUB);
    assert.equal(r.status, 401, path);
    const body = await r.json();
    assert.equal(body.error.code, 'unauthenticated', path);
    assert.equal(r.headers.get('cache-control'), 'no-store', path);
    securityHeaders(r, `refusal ${path}`);
  }
  await pathVariants();

  // The account page's modules stay public (/lib/), the gated copies do not.
  const lib = await get('/lib/js/account/api.js', SUB);
  assert.equal(lib.status, 200, 'the account client is public under /lib/');
  assert.match(lib.headers.get('content-type') ?? '', /javascript/);
  assert.equal((await get('/lib/js/main.js', SUB)).status, 404, 'nothing of the game itself under /lib/');

  // A pending account: refused.
  const PENDING = `Pending${RUN}`;
  await signupAccount(PENDING);
  const pending = await get(WASM, SUB, cookies.get(PENDING));
  assert.equal(pending.status, 403);
  assert.equal((await pending.json()).error.code, 'account_inactive');
  assert.equal((await get('/play/', NAV, cookies.get(PENDING))).status, 302);

  // An active account: the page and the engine, private, with a pass that then serves without the D1 check.
  const host = cookies.get(HOST);
  const page = await get('/play/', NAV, host);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type') ?? '', /text\/html/);
  assert.match(page.headers.get('cache-control') ?? '', /^private\b/);
  assert.match(page.headers.get('vary') ?? '', /Cookie/i);
  securityHeaders(page, 'game page');
  const passCookie = passOf(page);
  assert.ok(passCookie, 'a play pass is set');
  assert.match(passCookie, /HttpOnly/);
  assert.match(passCookie, /SameSite=Lax/);
  assert.match(passCookie, /Max-Age=600/);
  const pass = passCookie.split(';')[0];
  const wasm = await get(WASM, SUB, `${host}; ${pass}`);
  assert.equal(wasm.status, 200);
  const bytes = new Uint8Array(await wasm.arrayBuffer());
  assert.deepEqual([...bytes.slice(0, 4)], [0x00, 0x61, 0x73, 0x6d], 'the engine itself');
  assert.equal(passOf(wasm), null, 'no new pass while the old one is valid');
  assert.match(wasm.headers.get('cache-control') ?? '', /^private\b/);
  securityHeaders(wasm, 'engine');
  const worker = await get('/play/js/sim/worker.js', SUB, `${host}; ${pass}`);
  assert.equal(worker.status, 200);
  await worker.arrayBuffer();
  // The admin passes too.
  assert.equal((await get(WASM, SUB, cookies.get(ADMIN))).status, 200);
  await editorPage(get, `${host}; ${pass}`, NAV, SUB, securityHeaders);

  // Signing out clears the pass; the old pass alone opens nothing.
  // (The pending account from above, approved: signups are rate limited per address.)
  const LEAVER = PENDING;
  const leaver = (await api('/api/auth/me', {}, LEAVER)).body.user;
  assert.equal((await api(`/api/admin/users/${leaver.id}/approve`, { method: 'POST', body: '{}' }, ADMIN)).status, 200);
  const before = await get('/play/', NAV, cookies.get(LEAVER));
  assert.equal(before.status, 200);
  await before.arrayBuffer();
  const leaverPass = passOf(before).split(';')[0];
  const out = await fetch(`${BASE}/api/auth/logout`, { method: 'POST', headers: { Origin: ORIGIN, 'X-WebRA-CSRF': '1', Cookie: `${cookies.get(LEAVER)}; ${leaverPass}` } });
  assert.equal(out.status, 204);
  assert.match(passOf(out) ?? '', /^webra_play=;.*Max-Age=0/, 'sign-out clears the pass');
  assert.equal((await get(WASM, SUB, leaverPass)).status, 401, 'a pass without its session opens nothing');
  // A client that keeps both cookies after signing out (a browser clears them) keeps the
  // files only for the rest of the pass lifetime: the documented bound (docs/security.md).
  assert.equal((await get(WASM, SUB, `${cookies.get(LEAVER)}; ${leaverPass}`)).status, 200, 'within the pass lifetime');
  assert.equal((await get('/play/js/main.js', SUB, cookies.get(LEAVER))).status, 401, 'without the pass, the signed-out session opens nothing');
}

/**
 * Map sharing (docs/contracts.md section 4, "Lobby maps") and the rematch:
 * the host shares a custom map with a two-player lobby only, the guest
 * installs it by hash and the game starts on it; then both go back to the
 * lobby and return with their keys.
 */
/** A co-op mission online: the host picks Exodus, both people play, orders for its own actor types relay. */
async function coopMissionLobby(HOST, GUEST) {
  const created = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ name: 'Co-op', public: true, maxPlayers: 3, version: VERSION }) }, HOST);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const { id, hostKey } = created.body;
  const host = new Client('coop-host', HOST);
  await host.open(id);
  host.send({ t: 'hello', protocol: PROTOCOL_VERSION, version: VERSION, hostKey });
  const hw = await host.type('welcome');
  const guest = new Client('coop-guest', GUEST);
  await guest.open(id);
  guest.send({ t: 'hello', protocol: PROTOCOL_VERSION, version: VERSION });
  const gw = await guest.type('welcome');
  await host.type('lobby', (m) => m.slots[1].type === 'human');
  const m = COOP_MISSIONS.find((x) => x.id === 'exodus');
  const mission = { id: m.id, hash: m.hash, options: { difficulty: 'easy' } };
  host.send({ t: 'mission', mission });
  const lobby = await guest.type('lobby', (l) => l.mission !== undefined);
  assert.deepEqual(lobby.mission, mission);
  assert.deepEqual(lobby.slots.map((x) => x.type), ['human', 'human', 'closed'], 'the mission has two places');
  const listing = (await api('/api/sessions')).body.find((x) => x.id === id);
  assert.deepEqual(listing.map, { mission: 'exodus', name: 'Exodus', modded: false }, 'listed under the mission title');
  host.send({ t: 'slot', slot: 1, type: 'ai' });
  assert.equal((await host.type('error')).code, 'invalid', 'people only');
  guest.send({ t: 'ready', ready: true, mapHash: null });
  await host.type('lobby', (l) => l.slots[1].ready === true);
  host.send({ t: 'start' });
  const [hs, gs] = await Promise.all([host.type('start'), guest.type('start')]);
  assert.deepEqual(hs, gs);
  assert.deepEqual(hs.mission, mission);
  assert.equal(hs.options.cheats, false);
  const hSeat = hs.players.find((p) => p.client === hw.you).player;
  const gSeat = hs.players.find((p) => p.client === gw.you).player;
  const guestFrames = [];
  for (let tick = 0; tick < 30; tick++) {
    const [, gf] = await Promise.all([host.type('frame', (f) => f.tick === tick), guest.type('frame', (f) => f.tick === tick)]);
    guestFrames.push(gf);
    // A production order for the mission's last actor type (past the engine's own rules).
    host.send({ t: 'orders', tick: tick + 3, orders: tick === 4 ? [{ o: 'start_production', player: hSeat, ty: m.actors - 1, count: 1 }] : [] });
    guest.send({ t: 'orders', tick: tick + 3, orders: [] });
    if (tick > 0 && tick % 25 === 0) {
      host.send({ t: 'hash', tick, hash: 'c0de' });
      guest.send({ t: 'hash', tick, hash: 'c0de' });
    }
  }
  const relayed = guestFrames.find((f) => f.tick === 7);
  assert.deepEqual(relayed.orders, [[hSeat, [{ o: 'start_production', player: hSeat, ty: m.actors - 1, count: 1 }]]]);
  assert.ok(gSeat !== hSeat);
  host.send({ t: 'leave' });
  guest.send({ t: 'leave' });
  console.log('  co-op mission: lobby, start and relay ok');
}

async function sharedMapLobby(HOST, GUEST, WATCHER) {
  // Three places, so the public list shows the lobby (full lobbies are not listed).
  const created = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ name: 'Shared map', public: true, maxPlayers: 3, version: VERSION }) }, HOST);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const { id, hostKey } = created.body;
  const host = new Client('map-host', HOST);
  await host.open(id);
  host.send({ t: 'hello', protocol: PROTOCOL_VERSION, version: VERSION, hostKey });
  const hw = await host.type('welcome');
  const guest = new Client('map-guest', GUEST);
  await guest.open(id);
  guest.send({ t: 'hello', protocol: PROTOCOL_VERSION, version: VERSION });
  const gw = await guest.type('welcome');
  await host.type('lobby', (m) => m.slots[1].type === 'human');
  const member = (w) => ({ [MEMBER_HEADER]: `${w.you}.${w.key}` });

  // The host shares a map made for this run (a custom map nobody else has),
  // as a file from before map versions (no formatVersion: format 1).
  const w = 48;
  const terrain = Buffer.alloc(w * w).toString('base64');
  const custom = { format: 1, name: `Custom <b>${RUN}</b>`, author: `Host ${RUN}`, width: w, height: w, terrain, ore: terrain, spawns: [[3, 3], [44, 44]] };
  const path = `/api/sessions/${id}/map`;
  assert.equal((await api(path, { method: 'POST', body: JSON.stringify(custom), headers: member(gw) }, GUEST)).body.error.code, 'not_host');
  assert.equal((await api(path, { method: 'POST', body: JSON.stringify(custom) }, HOST)).status, 403, 'the member header is required');
  const shared = await api(path, { method: 'POST', body: JSON.stringify(custom), headers: member(hw) }, HOST);
  assert.equal(shared.status, 201, JSON.stringify(shared.body));
  // Map versions: the same map as a versioned file is the same map; a newer format is refused with what to do.
  const versioned = { formatVersion: MAP_FORMAT_VERSION, gameVersion: '0.9.0', ...custom };
  const twin = await api(path, { method: 'POST', body: JSON.stringify(versioned), headers: member(hw) }, HOST);
  assert.equal(twin.status, 200, JSON.stringify(twin.body));
  assert.equal(twin.body.hash, shared.body.hash);
  const newer = await api(path, { method: 'POST', body: JSON.stringify({ ...versioned, formatVersion: MAP_FORMAT_VERSION + 1 }), headers: member(hw) }, HOST);
  assert.equal(newer.status, 422);
  assert.match(newer.body.error.message, /^This map was made with a newer version of WebRA \(0\.9, format \d+; this version reads format \d+\)\. Update the game to play it\.$/);
  const announced = await guest.type('lobby', (m) => m.map !== null);
  const { id: mapId, bytes, ...details } = announced.map;
  assert.equal(mapId, shared.body.id);
  assert.ok(bytes > 0 && bytes < 64 * 1024, `file bytes ${bytes}`);
  assert.deepEqual(details, {
    hash: shared.body.hash,
    name: custom.name,
    modded: false,
    players: 2,
    author: custom.author,
    width: w,
    height: w,
    shared: true,
    // Upgraded to format 2: the game setup's defaults.
    setup: { players: [], options: {}, lockedOptions: [] },
  });
  assert.deepEqual(announced.slots.map((x) => x.mapState), ['installed', 'missing', undefined]);
  // Not public: not listed, not served by id, the session list shows its name only.
  assert.equal((await api('/api/maps')).body.some((m) => m.hash === shared.body.hash), false);
  assert.equal((await api(`/api/maps/${shared.body.id}`)).status, 404);
  const listing = (await api('/api/sessions')).body.find((x) => x.id === id);
  assert.deepEqual(listing.map, { name: custom.name, modded: false, shared: true });
  host.send({ t: 'map', map: { id: shared.body.id, hash: shared.body.hash, name: 'x', modded: false } });
  assert.equal((await host.type('error')).code, 'not_found', 'a shared map cannot be picked by id');

  // Map format version 2: a map's game setup applies to the lobby and its locks hold on the server.
  const setupMap = {
    ...versioned,
    name: `Locked ${RUN}`,
    players: [{ faction: 'england', lock: ['faction'] }, { type: 'open', team: 0 }],
    options: { startingCash: 10000, crates: false },
    lockedOptions: ['startingCash'],
    tags: ['e2e'],
  };
  const lockedShare = await api(path, { method: 'POST', body: JSON.stringify(setupMap), headers: member(hw) }, HOST);
  assert.equal(lockedShare.status, 201, JSON.stringify(lockedShare.body));
  const lockedLobby = await guest.type('lobby', (m) => m.map?.hash === lockedShare.body.hash);
  assert.deepEqual(lockedLobby.map.setup.lockedOptions, ['startingCash']);
  assert.equal(lockedLobby.options.startingCash, 10000, 'the map sets the lobby options');
  assert.equal(lockedLobby.options.crates, false);
  assert.equal(lockedLobby.slots[0].faction, 'england', 'and the slots');
  host.send({ t: 'options', options: { ...lockedLobby.options, startingCash: 5000 } });
  assert.equal((await host.type('error')).code, 'forbidden', 'a locked option cannot change');
  host.send({ t: 'slot', slot: 0, faction: 'russia' });
  assert.equal((await host.type('error')).code, 'forbidden', 'a locked faction cannot change');
  // Back to the custom map (shared again: the same map, the lobby's again).
  const reshared = await api(path, { method: 'POST', body: JSON.stringify(custom), headers: member(hw) }, HOST);
  assert.equal(reshared.body.hash, shared.body.hash);
  await guest.type('lobby', (m) => m.map?.hash === shared.body.hash);

  // The guest cannot be ready or let the game start without the map.
  guest.send({ t: 'ready', ready: true, mapHash: shared.body.hash });
  await host.type('lobby', (m) => m.slots[1].ready === true && m.slots[1].mapState === 'installed');
  guest.send({ t: 'ready', ready: false, mapHash: shared.body.hash });
  await host.type('lobby', (m) => m.slots[1].ready === false);
  guest.send({ t: 'mapstate', hash: shared.body.hash, state: 'declined' });
  await host.type('lobby', (m) => m.slots[1].mapState === 'declined');

  // Install: download from the session by hash, as this member, and check it.
  const get = (who, w2, hash = shared.body.hash) => fetch(`${BASE}${path}?hash=${hash}`, { headers: { Origin: ORIGIN, Cookie: cookies.get(who), ...member(w2) } });
  assert.equal((await get(WATCHER, gw)).status, 403, "another account cannot use the guest's key");
  assert.equal((await get(GUEST, gw, 'f'.repeat(64))).status, 409, 'pinned to the lobby map');
  const dl = await get(GUEST, gw);
  assert.equal(dl.status, 200);
  assert.equal(dl.headers.get('cache-control'), 'private, no-store');
  const text = await dl.text();
  const parsed = parseMap(text);
  assert.ok(parsed.ok, parsed.errors?.join('; '));
  assert.equal(parsed.upgrade, null, 'the lobby serves the current format');
  assert.ok(text.startsWith(`{"formatVersion":${MAP_FORMAT_VERSION},`) && !text.includes('gameVersion'), 'canonical: the format version, never who wrote it');
  assert.equal(await mapHash(parsed.map), shared.body.hash);
  assert.equal(await sha256Hex(text), shared.body.hash, 'the canonical text');
  guest.send({ t: 'mapstate', hash: shared.body.hash, state: 'installed' });
  await host.type('lobby', (m) => m.slots[1].mapState === 'installed');
  guest.send({ t: 'ready', ready: true, mapHash: shared.body.hash });
  await host.type('lobby', (m) => m.slots[1].ready === true);
  host.send({ t: 'start' });
  const [hs, gs] = await Promise.all([host.type('start'), guest.type('start')]);
  assert.deepEqual(hs, gs);
  assert.equal(hs.map.hash, shared.body.hash, 'the game runs on the shared map');
  // Both run ticks like net.js (orders for t + 3 after frame t, a hash every 25 ticks).
  const hSeat = hs.players.find((p) => p.client === hw.you).player;
  const gSeat = hs.players.find((p) => p.client === gw.you).player;
  const played = [];
  let tick = 0;
  const playTo = async (to) => {
    for (; tick < to; tick++) {
      const [hf] = await Promise.all([host.type('frame', (f) => f.tick === tick), guest.type('frame', (f) => f.tick === tick)]);
      if (hf.orders.length) played.push([hf.tick, hf.orders]);
      host.send({ t: 'orders', tick: tick + 3, orders: tick === 4 ? [{ o: 'stop', player: hSeat, ids: [42] }] : [] });
      guest.send({ t: 'orders', tick: tick + 3, orders: tick === 6 ? [{ o: 'stop', player: gSeat, ids: [43] }] : [] });
      if (tick > 0 && tick % 25 === 0) {
        host.send({ t: 'hash', tick, hash: 'e2e0' });
        guest.send({ t: 'hash', tick, hash: 'e2e0' });
      }
    }
  };
  await playTo(10);
  // In the game the map stays available to its members (a reload rejoins with it).
  assert.equal((await get(GUEST, gw)).status, 200);

  // Online save: the guest proposes, the host agrees, both report the hash at the save point.
  guest.send({ t: 'save', accept: true });
  await host.type('save', (m) => m.state === 'open');
  host.send({ t: 'save', accept: true });
  const agreed = await guest.type('save', (m) => m.state === 'agreed');
  await playTo(agreed.tick + 1);
  const [saved] = await Promise.all([host.type('save', (m) => m.state === 'saved'), guest.type('save', (m) => m.state === 'saved')]);
  assert.deepEqual([saved.ticks, saved.hash], [agreed.tick + 1, 'e2e0']);
  // The file each player's browser keeps (js/replay.js Recorder.encodeOnlineSave).
  const saveText = encodeReplay({
    format: REPLAY_FORMAT,
    version: REPLAY_VERSION,
    kind: 'save',
    mode: 'online',
    engine: VERSION,
    createdAt: Date.now(),
    title: 'Shared map',
    options: hs.options,
    map: text,
    mapHash: shared.body.hash,
    player: hSeat,
    ticks: saved.ticks,
    frames: played.filter(([t]) => t < saved.ticks),
    hashes: [[saved.ticks, saved.hash]],
    online: { id: saved.id },
  });

  // Rematch: the host proposes, the guest accepts, both go back to the lobby.
  host.send({ t: 'rematch', accept: true });
  const open = await guest.type('rematch', (m) => m.state === 'open');
  assert.deepEqual(open.waiting, [gw.you]);
  guest.send({ t: 'rematch', accept: true });
  await Promise.all([host.type('rematch', (m) => m.state === 'lobby'), guest.type('rematch', (m) => m.state === 'lobby')]);
  // The pages reload: new connections with the same keys bring both back.
  host.ws.close();
  guest.ws.close();
  const back = [];
  for (const [who, w2] of [[HOST, hw], [GUEST, gw]]) {
    const c = new Client(`${who}-back`, who);
    await c.open(id);
    c.send({ t: 'hello', protocol: PROTOCOL_VERSION, version: VERSION, rejoin: { client: w2.you, key: w2.key } });
    assert.equal((await c.type('welcome')).you, w2.you);
    back.push(c);
  }
  const lobby = await back[1].type('lobby');
  assert.equal(lobby.map.hash, shared.body.hash, 'the same map');
  assert.deepEqual(
    lobby.slots.filter((x) => x.type === 'human').map((x) => [x.client, x.ready, x.mapState]),
    [[hw.you, false, 'installed'], [gw.you, false, 'installed']],
  );
  for (const c of back) c.send({ t: 'leave' });

  // Resume the online save in a new session: the guest comes back by its account,
  // installs the map, both catch up through the saved orders and play on after the save point.
  const again = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ name: 'Resumed', public: false, maxPlayers: 2, version: VERSION }) }, HOST);
  assert.equal(again.status, 201);
  const rhost = new Client('resume-host', HOST);
  await rhost.open(again.body.id);
  rhost.send({ t: 'hello', protocol: PROTOCOL_VERSION, version: VERSION, hostKey: again.body.hostKey });
  const rhw = await rhost.type('welcome');
  const resumePath = `/api/sessions/${again.body.id}/resume`;
  const tampered = saveText.replace('"ids":[42]', '"ids":[41]');
  assert.equal((await api(resumePath, { method: 'POST', body: tampered, headers: member(rhw) }, HOST)).status, 409, 'checked against the record');
  assert.equal((await api(resumePath, { method: 'POST', body: saveText, headers: member(rhw) }, WATCHER)).status, 403, 'another account');
  const loaded = await api(resumePath, { method: 'POST', body: saveText, headers: member(rhw) }, HOST);
  assert.equal(loaded.status, 200, JSON.stringify(loaded.body));
  const rl = await rhost.type('lobby', (m) => m.resume !== undefined);
  assert.deepEqual(rl.resume.waiting, [GUEST]);
  assert.equal(rl.map.hash, shared.body.hash);
  const rguest = new Client('resume-guest', GUEST);
  await rguest.open(again.body.id);
  rguest.send({ t: 'hello', protocol: PROTOCOL_VERSION, version: VERSION });
  const rgw = await rguest.type('welcome');
  await rhost.type('lobby', (m) => m.resume?.waiting.length === 0);
  rguest.send({ t: 'ready', ready: true, mapHash: shared.body.hash });
  await rhost.type('lobby', (m) => m.slots.some((x) => x.client === rgw.you && x.ready));
  rhost.send({ t: 'start' });
  const [rs] = await Promise.all([rhost.type('start'), rguest.type('start')]);
  assert.deepEqual(rs.resume, { ticks: saved.ticks, hash: saved.hash });
  const sync = await rguest.type('sync');
  assert.deepEqual(sync.check, { tick: saved.ticks - 1, hash: saved.hash });
  rhost.send({ t: 'resume' });
  rguest.send({ t: 'resume' });
  await Promise.all([rhost.type('back', (m) => m.client === rgw.you), rguest.type('back', (m) => m.client === rhw.you)]);
  const seatOf = (w) => rs.players.find((p) => p.client === w.you).player;
  const resumed = [];
  for (let t = saved.ticks; t < saved.ticks + 5; t++) {
    const [f] = await Promise.all([rhost.type('frame', (x) => x.tick === t), rguest.type('frame', (x) => x.tick === t)]);
    resumed.push(f);
    rhost.send({ t: 'orders', tick: t + 3, orders: [] });
    rguest.send({ t: 'orders', tick: t + 3, orders: t === saved.ticks ? [{ o: 'stop', player: seatOf(rgw), ids: [44] }] : [] });
  }
  assert.deepEqual(resumed.at(-2).orders.map(([p]) => p), [seatOf(rgw)], 'the resumed game goes on in lockstep');
  rhost.send({ t: 'leave' });
  rguest.send({ t: 'leave' });
  console.log('  shared map lobby, online save, rematch and resume passed');
}

async function main() {
  // ---- Accounts ------------------------------------------------------------------
  const v = await api('/api/version');
  assert.deepEqual(v.body, { version: JSON.parse(readFileSync(new URL('../../package.json', import.meta.url))).version, protocol: PROTOCOL_VERSION });
  const site = await api('/api/site');
  assert.equal(site.status, 200);
  assert.equal(site.body.onlineRequiresAccount, true);
  assert.equal(site.body.registration.approvalRequired, true, 'closed beta by default');
  assert.equal(site.body.services.email, false, 'no email binding under wrangler dev');
  assert.equal(site.body.passkey.rpId, 'localhost');
  const ADMIN = `SmokeAdmin${RUN}`;
  const HOST = `Host${RUN}`;
  const GUEST = `Guest${RUN}`;
  const WATCHER = `Watcher${RUN}`;
  const accounts = {};
  for (const name of [ADMIN, HOST, GUEST, WATCHER]) {
    accounts[name] = await signupAccount(name);
    assert.equal(accounts[name].status, 'pending_approval');
  }
  // Pending accounts cannot play.
  const pendingCreate = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ name: 'Nope', public: false, maxPlayers: 2, version: VERSION }) }, HOST);
  assert.equal(pendingCreate.status, 403);
  assert.equal(pendingCreate.body.error.code, 'account_inactive');
  // The first admin through the test-only route (it exists only under wrangler dev with the variable).
  const promoted = await api('/api/dev/promote', { method: 'POST', body: JSON.stringify({ username: ADMIN, role: 'admin' }) });
  assert.equal(promoted.status, 200, `start wrangler dev with --var WEBRA_DEV_ROUTES:1 (${JSON.stringify(promoted.body)})`);
  assert.equal((await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ login: ADMIN, password: PASSWORD }) }, ADMIN)).status, 200);
  const pending = await api(`/api/admin/users?status=pending_approval&q=${RUN}`, {}, ADMIN);
  assert.deepEqual(pending.body.users.map((u) => u.username).sort(), [GUEST, HOST, WATCHER].sort());
  for (const name of [HOST, GUEST, WATCHER]) {
    const r = await api(`/api/admin/users/${accounts[name].id}/approve`, { method: 'POST', body: '{}' }, ADMIN);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.user.status, 'active');
  }
  // Sign in again (the signup sessions still work too) and check the verdict.
  for (const name of [HOST, GUEST, WATCHER]) {
    const r = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ login: name.toLowerCase(), password: PASSWORD }) }, name);
    assert.equal(r.status, 200);
    assert.equal(r.body.user.canPlayOnline, true);
  }
  await playGate(ADMIN, HOST);
  await sharedMapLobby(HOST, GUEST, WATCHER);
  await coopMissionLobby(HOST, GUEST);

  const stats = await api('/api/admin/stats', {}, ADMIN);
  assert.equal(stats.status, 200);
  assert.equal(stats.body.services.email, false);
  assert.equal((await api('/api/admin/stats', {}, HOST)).status, 403, 'plain users are not staff');

  // ---- HTTP -------------------------------------------------------------------
  assert.equal((await fetch(BASE + '/api/sessions', { method: 'POST', headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await api('/api/nope')).status, 404);
  assert.equal((await api('/api/sessions', { method: 'POST', body: '{"name":""}' }, HOST)).status, 400);
  assert.equal((await api('/api/sessions', { method: 'POST', body: JSON.stringify({ name: 'Anon', public: false, maxPlayers: 2, version: VERSION }) })).status, 401, 'online play needs an account');
  assert.equal((await api('/api/maps/zzzz')).status, 404);
  // Original content relay (src/content.js): only its refusals here, which answer before any
  // upstream request; the mirrors are never contacted from tests (unit tests mock them).
  const content = (init, who = null) => fetch(`${BASE}/api/content/ra-quickinstall`, { ...init, headers: { ...init.headers, ...(who ? { Cookie: cookies.get(who) } : {}) } });
  const anonymous = await content({ headers: { Origin: ORIGIN, 'X-WebRA-Content': '1' } });
  assert.equal(anonymous.status, 401, 'the relay needs an account');
  assert.equal(anonymous.headers.get('cache-control'), 'no-store');
  const noFlag = await content({ headers: { Origin: ORIGIN, 'X-WebRA-Content': '1' } }, HOST);
  assert.equal(noFlag.status, 403);
  assert.equal((await noFlag.json()).error.code, 'relay_forbidden');
  const noHeader = await content({ headers: { Origin: ORIGIN } }, ADMIN);
  assert.equal(noHeader.status, 403, 'admins pass the account gate; the relay checks its header');
  assert.equal((await content({ headers: { Origin: 'https://evil.example', 'X-WebRA-Content': '1' } }, ADMIN)).status, 403);
  assert.equal((await content({ headers: { 'X-WebRA-Content': '1', 'Sec-Fetch-Site': 'cross-site' } }, ADMIN)).status, 403);
  assert.equal((await content({ method: 'POST', headers: { Origin: ORIGIN, 'X-WebRA-Content': '1', 'X-WebRA-CSRF': '1' } }, ADMIN)).status, 405);
  // The music relay (src/cdmusic.js): the same gate, then its Range check, both before any upstream request.
  const music = (init, who = null) => fetch(`${BASE}/api/content/ra-scores`, { ...init, headers: { ...init.headers, ...(who ? { Cookie: cookies.get(who) } : {}) } });
  assert.equal((await music({ headers: { Origin: ORIGIN, 'X-WebRA-Content': '1', Range: 'bytes=0-15' } })).status, 401, 'the music relay needs an account');
  const musicNoFlag = await music({ headers: { Origin: ORIGIN, 'X-WebRA-Content': '1', Range: 'bytes=0-15' } }, HOST);
  assert.equal((await musicNoFlag.json()).error.code, 'relay_forbidden');
  assert.equal((await music({ headers: { Origin: ORIGIN, Range: 'bytes=0-15' } }, ADMIN)).status, 403, 'admins pass the gate; the relay checks its header');
  const musicBadRange = await music({ headers: { Origin: ORIGIN, 'X-WebRA-Content': '1', Range: 'bytes=0-15,20-30' } }, ADMIN);
  assert.equal(musicBadRange.status, 416);
  assert.equal(musicBadRange.headers.get('content-range'), 'bytes */64171360');
  assert.equal((await music({ headers: { Origin: ORIGIN, 'X-WebRA-Content': '1' } }, ADMIN)).status, 416, 'no Range, no fetch');
  assert.equal((await music({ method: 'POST', headers: { Origin: ORIGIN, 'X-WebRA-Content': '1', 'X-WebRA-CSRF': '1' } }, ADMIN)).status, 405);

  const w = 48;
  const terrain = Buffer.alloc(w * w).toString('base64');
  const mapJson = { format: 1, name: `Smoke ${Date.now()}`, author: 'Tester', width: w, height: w, terrain, ore: terrain, spawns: [[2, 2], [40, 40], [2, 40]] };
  assert.equal((await api('/api/maps', { method: 'POST', body: JSON.stringify(mapJson) })).status, 401, 'uploads need an account');
  const up = await api('/api/maps', { method: 'POST', body: JSON.stringify(mapJson) }, HOST);
  assert.equal(up.status, 201, JSON.stringify(up.body));
  const again = await api('/api/maps', { method: 'POST', body: JSON.stringify({ ...mapJson, description: '' }) }, HOST);
  assert.equal(again.status, 200, 'same canonical map is deduplicated');
  assert.equal(again.body.id, up.body.id);
  const bad = await api('/api/maps', { method: 'POST', body: JSON.stringify({ ...mapJson, rules: { actors: { NOPE: { cost: 1 } } } }) }, HOST);
  assert.equal(bad.status, 422);
  const list = await api('/api/maps');
  assert.ok(list.body.some((m) => m.id === up.body.id && m.players === 3 && m.modded === false));
  const dl = await api(`/api/maps/${up.body.id}`);
  assert.equal(dl.body.name, mapJson.name);

  const created = await api('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ name: 'Smoke test', password: 'pw', public: true, maxPlayers: 3, version: VERSION }),
  }, HOST);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const { id, hostKey } = created.body;

  // ---- Lobby --------------------------------------------------------------------
  // Anonymous connections are refused at hello (accounts are required).
  const anon = new Client('anon');
  await anon.open(id);
  anon.send({ t: 'hello', protocol: PROTOCOL_VERSION, version: VERSION, name: 'Nobody', password: 'pw' });
  assert.equal((await anon.type('error')).code, 'account_required');

  const host = new Client('host', HOST);
  await host.open(id);
  host.send({ t: 'hello', protocol: PROTOCOL_VERSION, version: VERSION, name: 'Fake name', hostKey });
  const welcome = await host.type('welcome');
  assert.equal(welcome.hostId, welcome.you);
  assert.equal(welcome.session.locked, true);
  assert.equal(welcome.name, HOST, 'signed in: the username, not the name sent');
  const firstLobby = await host.type('lobby');
  assert.equal(firstLobby.slots[0].account, true);

  const listed = await api('/api/sessions');
  const entry = listed.body.find((s) => s.id === id);
  assert.ok(entry, 'public lobby is listed');
  assert.equal(entry.host, HOST);
  assert.equal(entry.locked, true);

  const intruder = new Client('intruder', GUEST);
  await intruder.open(id);
  intruder.send({ t: 'hello', protocol: PROTOCOL_VERSION, version: VERSION, name: 'Mallory', password: 'nope' });
  assert.equal((await intruder.type('error')).code, 'bad_password');

  const old = new Client('old', GUEST);
  await old.open(id);
  old.send({ t: 'hello', protocol: PROTOCOL_VERSION, version: '0.1.0', name: 'Old', password: 'pw' });
  assert.equal((await old.type('error')).code, 'version_mismatch');

  const guest = new Client('guest', GUEST);
  await guest.open(id);
  guest.send({ t: 'hello', protocol: PROTOCOL_VERSION, version: VERSION, password: 'pw' });
  const gw = await guest.type('welcome');
  assert.equal(gw.hostId, welcome.you);
  assert.equal(gw.role, 'player');
  assert.match(gw.key, /^[A-Za-z0-9_-]{43}$/, 'every member gets a rejoin key');
  await host.type('lobby', (m) => m.slots[1].type === 'human');

  // A spectator place: the host allows one, a watcher takes it (password rules as for players).
  host.send({ t: 'spectators', max: 1 });
  await host.type('lobby', (m) => m.maxSpectators === 1);
  const watcher = new Client('watcher', WATCHER);
  await watcher.open(id);
  watcher.send({ t: 'hello', protocol: PROTOCOL_VERSION, version: VERSION, name: 'Watcher', password: 'nope', spectate: true });
  assert.equal((await watcher.type('error')).code, 'bad_password');
  const watcher2 = new Client('watcher2', WATCHER);
  await watcher2.open(id);
  watcher2.send({ t: 'hello', protocol: PROTOCOL_VERSION, version: VERSION, password: 'pw', spectate: true });
  const ww = await watcher2.type('welcome');
  assert.equal(ww.role, 'spectator');
  await host.type('lobby', (m) => m.spectators.length === 1 && m.spectators[0].name === WATCHER);
  // The same account cannot take a second place (another tab).
  const twin = new Client('twin', GUEST);
  await twin.open(id);
  twin.send({ t: 'hello', protocol: PROTOCOL_VERSION, version: VERSION, password: 'pw', spectate: true });
  assert.equal((await twin.type('error')).code, 'bad_state');

  // Non-host cannot change options or start; garbage is answered with errors.
  guest.send({ t: 'start' });
  assert.equal((await guest.type('error')).code, 'not_host');
  guest.sendRaw('{"t":"slot","slot":0,"faction":"atlantis"}');
  assert.equal((await guest.type('error')).code, 'bad_message');
  // Oversized messages close the connection.
  const big = new Client('big', GUEST);
  await big.open(id);
  big.sendRaw('x'.repeat(9000));
  assert.equal((await big.type('error')).code, 'too_large');

  // Host picks the uploaded map (name from D1, not from the client), adds an AI.
  host.send({ t: 'map', map: { id: up.body.id, hash: up.body.hash, name: 'Fake name', modded: true } });
  const withMap = await host.type('lobby', (m) => m.map !== null);
  assert.equal(withMap.map.name, mapJson.name);
  assert.equal(withMap.map.modded, false);
  assert.equal(withMap.map.players, 3);
  host.send({ t: 'slot', slot: 2, type: 'ai', difficulty: 'easy' });
  await host.type('lobby', (m) => m.slots[2].type === 'ai');
  host.send({ t: 'chat', text: 'gl hf' });
  const chat = await guest.type('chat');
  assert.deepEqual([chat.name, chat.text], [HOST, 'gl hf']);

  host.send({ t: 'start' });
  assert.equal((await host.type('error')).code, 'not_ready');
  guest.send({ t: 'ready', ready: true, mapHash: null });
  assert.equal((await guest.type('error')).code, 'not_ready');
  guest.send({ t: 'ready', ready: true, mapHash: up.body.hash });
  await host.type('lobby', (m) => m.slots[1].ready === true);
  // Spectators need the map too (protocol 6): the start waits for the watcher.
  host.send({ t: 'start' });
  assert.match((await host.type('error')).message, /does not have the map/);
  watcher2.send({ t: 'mapstate', hash: up.body.hash, state: 'installed' });
  await host.type('lobby', (m) => m.spectators[0].mapState === 'installed');
  host.send({ t: 'start' });
  const [hs, gs, ws] = await Promise.all([host.type('start'), guest.type('start'), watcher2.type('start')]);
  assert.deepEqual(hs, gs);
  assert.deepEqual(hs, ws);
  assert.equal(hs.options.players.length, 3);
  assert.ok(hs.options.players.every((p) => !p.faction.startsWith('random')));
  assert.equal(hs.delay, 3);
  const seatOf = (c, you) => hs.players.find((p) => p.client === you).player;
  const hSeat = seatOf(host, welcome.you);
  const gSeat = seatOf(guest, gw.you);
  assert.equal((await api('/api/sessions')).body.some((s) => s.id === id), false, 'started games are not listed');
  assert.equal(hs.players.length, 3, 'the spectator does not play');

  // ---- Lockstep -------------------------------------------------------------------
  // Each client behaves like net.js: after frame T arrives it runs tick T and
  // sends its orders for T + delay.
  const forged = { o: 'stop', player: hSeat, ids: [1, 2] };
  const frames = [];
  for (let t = 0; t < 57; t++) {
    const hf = await host.type('frame', (f) => f.tick === t);
    const gf = await guest.type('frame', (f) => f.tick === t);
    assert.deepEqual(hf, gf);
    frames.push(hf);
    host.send({ t: 'orders', tick: t + 3, orders: [] });
    guest.send({ t: 'orders', tick: t + 3, orders: t + 3 === 5 ? [forged] : [] });
  }
  // The guest forged the host's seat inside its order; the server stamped its real seat.
  const f5 = frames.find((f) => f.tick === 5);
  assert.deepEqual(f5.orders, [[gSeat, [{ ...forged, player: gSeat }]]]);
  assert.ok(frames.filter((f) => f.tick !== 5).every((f) => f.orders.length === 0));
  await host.type('frame', (f) => f.tick === 57);
  await guest.type('frame', (f) => f.tick === 57);

  // Hash reports: matching at tick 25, a mismatch at tick 50 is reported to everyone.
  host.send({ t: 'hash', tick: 25, hash: 'aaaa' });
  guest.send({ t: 'hash', tick: 25, hash: 'aaaa' });
  host.send({ t: 'hash', tick: 50, hash: 'bbbb' });
  guest.send({ t: 'hash', tick: 50, hash: 'cccc' });
  assert.equal((await host.type('desync')).tick, 50);
  assert.equal((await guest.type('desync')).tick, 50);

  // ---- Spectator -------------------------------------------------------------------
  // The spectator got every frame; orders from it are refused and remove it.
  await watcher2.type('frame', (f) => f.tick === 59);
  watcher2.send({ t: 'orders', tick: 60, orders: [] });
  assert.equal((await watcher2.type('error')).code, 'forbidden');
  const wl = await host.type('left', (m) => m.player === null);
  assert.deepEqual([wl.name, wl.reason], [WATCHER, 'removed']);

  // ---- Reconnect ---------------------------------------------------------------------
  // The guest's connection drops: the host is told and plays on without waiting.
  guest.ws.close();
  const gone = await host.type('left', (m) => m.player === gSeat);
  assert.deepEqual([gone.reason, gone.name], ['disconnected', GUEST]);
  for (let t = 60; t < 70; t++) {
    host.send({ t: 'orders', tick: t, orders: t === 64 ? [{ o: 'stop', player: hSeat, ids: [9] }] : [] });
    await host.type('frame', (f) => f.tick === t);
  }
  // A wrong key is refused.
  const thief = new Client('thief', WATCHER);
  await thief.open(id);
  thief.send({ t: 'hello', protocol: PROTOCOL_VERSION, version: VERSION, rejoin: { client: gw.you, key: 'A'.repeat(43) } });
  assert.equal((await thief.type('error')).code, 'forbidden');
  // The right key from another account is refused too (keys are bound to their account).
  const keyThief = new Client('key-thief', WATCHER);
  await keyThief.open(id);
  keyThief.send({ t: 'hello', protocol: PROTOCOL_VERSION, version: VERSION, rejoin: { client: gw.you, key: gw.key } });
  assert.equal((await keyThief.type('error')).code, 'forbidden');
  // The guest comes back with its key: start, the order log, sync, resume.
  const back = new Client('guest-back', GUEST);
  await back.open(id);
  back.send({ t: 'hello', protocol: PROTOCOL_VERSION, version: VERSION, rejoin: { client: gw.you, key: gw.key } });
  const bw = await back.type('welcome');
  assert.deepEqual([bw.you, bw.role, 'key' in bw], [gw.you, 'player', false]);
  assert.deepEqual(await back.type('start'), hs);
  const logged = [];
  let sync;
  while (!sync) {
    const m = await back.next((x) => x.t === 'log' || x.t === 'sync', 'log or sync');
    if (m.t === 'log') logged.push(...m.frames);
    else sync = m;
  }
  assert.deepEqual(logged.map((f) => f[0]), [5, 64], 'the log holds the frames with orders');
  assert.equal(sync.tick, 70);
  assert.deepEqual(sync.check, { tick: 25, hash: 'aaaa' }, 'the last hash the players agreed on');
  back.send({ t: 'resume' });
  const [hb, bb] = await Promise.all([host.type('back'), back.type('back')]);
  assert.deepEqual([hb.player, hb.tick, bb.tick], [gSeat, 73, 73]);
  for (let t = 70; t < 76; t++) host.send({ t: 'orders', tick: t, orders: [] });
  for (let t = 73; t < 76; t++) back.send({ t: 'orders', tick: t, orders: [] });
  for (let t = 70; t < 76; t++) {
    const [a, b] = await Promise.all([host.type('frame', (f) => f.tick === t), back.type('frame', (f) => f.tick === t)]);
    assert.deepEqual(a, b);
  }

  // Guest leaves for good: host is told and frames continue for the host alone.
  back.send({ t: 'leave' });
  const left = await host.type('left', (m) => m.reason === 'left');
  assert.deepEqual([left.player, left.name], [gSeat, GUEST]);
  host.send({ t: 'orders', tick: 76, orders: [] });
  assert.equal((await host.type('frame', (f) => f.tick === 76)).orders.length, 0);

  // Large frames fill a chunk of the order log, which goes to Durable Object
  // storage compressed; a spectator joining now reads it back from there.
  const bigIds = Array.from({ length: 800 }, (_, i) => 1_000_000 + i);
  for (let t = 77; t < 89; t++) {
    host.send({ t: 'orders', tick: t, orders: [{ o: 'stop', player: hSeat, ids: bigIds }] });
    await host.type('frame', (f) => f.tick === t);
  }
  await new Promise((r) => setTimeout(r, 500));
  const lateWatcher = new Client('late-watcher', WATCHER);
  await lateWatcher.open(id);
  lateWatcher.send({ t: 'hello', protocol: PROTOCOL_VERSION, version: VERSION, password: 'pw', spectate: true });
  assert.equal((await lateWatcher.type('welcome')).role, 'spectator');
  await lateWatcher.type('start');
  const lateLog = [];
  let lateSync;
  while (!lateSync) {
    const m = await lateWatcher.next((x) => x.t === 'log' || x.t === 'sync', 'log or sync');
    if (m.t === 'log') lateLog.push(...m.frames);
    else lateSync = m;
  }
  assert.equal(lateSync.tick, 89);
  assert.deepEqual(lateLog.map((f) => f[0]), [5, 64, 77, 78, 79, 80, 81, 82, 83, 84, 85, 86, 87, 88]);
  assert.deepEqual(lateLog.at(-1)[1], [[hSeat, [{ o: 'stop', player: hSeat, ids: bigIds }]]]);
  // The spectator confirms its catch-up (it stops counting against the catch-up limit).
  lateWatcher.send({ t: 'synced' });
  lateWatcher.send({ t: 'synced' });
  assert.equal((await lateWatcher.type('error')).code, 'bad_state', 'confirmed once');

  // Silence: the host stops sending and is dropped after about 10 s.
  const dropped = await host.next((m) => m.t === 'error' && m.code === 'dropped', 'drop', 15000);
  assert.equal(dropped.code, 'dropped');
  // The close frame needs a network round trip, much longer against a deployed Worker.
  for (let i = 0; i < 50 && !host.closed; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(host.closed, true);

  // The session is gone afterwards.
  const late = new Client('late');
  await late.open(id).catch(() => {});
  console.log('smoke test passed');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
