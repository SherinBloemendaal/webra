// Test harness for the Worker's account API: the real Worker entry
// (src/index.js) over a SQLite-backed D1 (fake-d1.mjs), a recording email
// binding, a fake session namespace, a controllable clock and browser-like
// clients with cookie jars.
import { FakeD1 } from './fake-d1.mjs';

globalThis.WEBRA_TEST_REAL_ENGINE = true;
await import('./fake-do.mjs'); // module hooks for cloudflare:workers

const { default: worker } = await import('../src/index.js');

export const ORIGIN = 'https://webra.sherin.dev';

/** Date.now() under test control (restored by `restore`). */
export class Clock {
  constructor(start = Date.UTC(2026, 9, 9, 12, 0, 0)) {
    this.now = start;
    this.real = Date.now;
    Date.now = () => this.now;
  }

  advance(ms) {
    this.now += ms;
  }

  restore() {
    Date.now = this.real;
  }
}

export class FakeEmail {
  constructor() {
    this.sent = [];
    this.fail = false;
  }

  async send(msg) {
    if (this.fail) throw new Error('send failed');
    this.sent.push(msg);
  }

  /** The token of the last link of `kind` (verify or reset) sent to `to`. */
  token(to, kind) {
    for (const m of [...this.sent].reverse()) {
      if (m.to !== to) continue;
      const r = new RegExp(`#${kind}=([A-Za-z0-9_-]{43})`).exec(m.text);
      if (r) return r[1];
    }
    return null;
  }
}

/** Session namespace stand-in: records init, fetch (upgrades) and evict calls. */
export class FakeSessions {
  constructor() {
    this.inits = [];
    this.fetches = [];
    this.evictions = [];
    this.next = 1;
  }

  newUniqueId() {
    const hex = (this.next++).toString(16).padStart(64, '0');
    return { toString: () => hex };
  }

  idFromString(s) {
    if (!/^[0-9a-f]{64}$/.test(s)) throw new Error('bad id');
    return { toString: () => s };
  }

  get(id) {
    return {
      init: async (input) => {
        this.inits.push(input);
        return { hostKey: 'K'.repeat(43) };
      },
      fetch: async (request) => {
        this.fetches.push({ id: id.toString(), request });
        return new Response('upgraded', { status: 200 });
      },
      evict: async (what) => {
        this.evictions.push({ id: id.toString(), ...what });
        return 1;
      },
    };
  }
}

export function makeEnv({ email = true, discord = false, vars = {} } = {}) {
  return {
    DB: new FakeD1(),
    EMAIL: email ? new FakeEmail() : undefined,
    ...(email ? { EMAIL_FROM: 'noreply@webra.sherin.dev' } : {}),
    SESSION: new FakeSessions(),
    ASSETS: { fetch: async () => new Response('asset') },
    IP_HASH_SALT: 'test-ip-hash-salt-not-a-real-secret',
    ...(discord ? { DISCORD_CLIENT_ID: '123456789', DISCORD_CLIENT_SECRET: 'test-secret-not-real' } : {}),
    ...vars,
  };
}

/** Work the Worker finishes after its answers (exec.waitUntil), awaited by `call` like the runtime would. */
const background = [];
const exec = { waitUntil: (p) => background.push(Promise.resolve(p).catch(() => {})), passThroughOnException() {} };

/** One Worker request; resolves once its background work (mail) is done too. */
export async function call(env, method, url, { body, headers = {} } = {}) {
  const init = { method, headers };
  if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body);
  const res = await worker.fetch(new Request(url, init), env, exec);
  while (background.length) await background.shift();
  return res;
}

export async function scheduled(env, time) {
  const waits = [];
  await worker.scheduled({ scheduledTime: time, cron: '17 3 * * *' }, env, { waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
}

/** A browser: cookie jar, same-origin headers, CSRF header, its own IP. */
export class Browser {
  constructor(env, { ip = '198.51.100.7', origin = ORIGIN, ua = 'Mozilla/5.0 (X11; Linux x86_64) Firefox/140.0' } = {}) {
    this.env = env;
    this.ip = ip;
    this.origin = origin;
    this.ua = ua;
    this.jar = new Map();
  }

  cookieHeader() {
    return [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  absorb(res) {
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split(';').map((s) => s.trim());
      const i = pair.indexOf('=');
      const name = pair.slice(0, i);
      const value = pair.slice(i + 1);
      const maxAge = attrs.find((a) => a.toLowerCase().startsWith('max-age='));
      if (maxAge && Number(maxAge.split('=')[1]) <= 0) this.jar.delete(name);
      else this.jar.set(name, value);
    }
  }

  headers(extra = {}, { csrf = true, json = true } = {}) {
    const h = { 'CF-Connecting-IP': this.ip, 'User-Agent': this.ua, Origin: this.origin, 'Sec-Fetch-Site': 'same-origin' };
    if (csrf) h['X-WebRA-CSRF'] = '1';
    if (json) h['Content-Type'] = 'application/json';
    Object.assign(h, extra);
    const cookie = this.cookieHeader();
    if (cookie) h.Cookie = cookie;
    for (const [k, v] of Object.entries(h)) if (v === null) delete h[k];
    return h;
  }

  /** Request; returns { status, body, res }. `opts.headers` values of null remove defaults. */
  async req(method, path, body, opts = {}) {
    const headers = this.headers(opts.headers, opts);
    if (body === undefined && method !== 'GET') delete headers['Content-Type'];
    const res = await call(this.env, method, `${this.origin}${path}`, { body, headers });
    this.absorb(res);
    const textBody = res.status === 204 || res.status === 302 ? '' : await res.text();
    let parsed = null;
    try {
      parsed = textBody ? JSON.parse(textBody) : null;
    } catch {
      parsed = textBody;
    }
    return { status: res.status, body: parsed, res };
  }

  get(path, opts) {
    return this.req('GET', path, undefined, opts);
  }

  post(path, body = {}, opts) {
    return this.req('POST', path, body, opts);
  }

  patch(path, body, opts) {
    return this.req('PATCH', path, body, opts);
  }

  put(path, body, opts) {
    return this.req('PUT', path, body, opts);
  }

  del(path, body, opts) {
    return this.req('DELETE', path, body, opts);
  }

  get signedIn() {
    return [...this.jar.keys()].some((k) => k.endsWith('webra_session'));
  }
}

/** Store site settings directly (tests that need a configuration up front). */
export async function setSite(env, patch) {
  const { mergeSiteSettings } = await import('@webra/protocol');
  const { loadSite, saveSite } = await import('../src/accounts/site.js');
  const site = await loadSite(env.DB);
  const next = mergeSiteSettings(site.settings, patch);
  await saveSite(env.DB, next, site.version, null);
}

export const PASSWORD = 'correct horse battery';

/** Sign up and return the browser (signed in); `email` defaults to <username>@example.com. */
export async function signup(env, username, { email = `${username.toLowerCase().replace(/\s+/g, '.')}@example.com`, ip, password = PASSWORD } = {}) {
  const b = new Browser(env, { ip: ip ?? `198.51.100.${Math.floor(Math.random() * 200) + 10}` });
  const r = await b.post('/api/auth/signup', { username, email, password, acceptPrivacy: true });
  if (r.status !== 201) throw new Error(`signup ${username}: ${r.status} ${JSON.stringify(r.body)}`);
  b.user = r.body.user;
  return b;
}

/** Make a user active with a role directly in D1. */
export function promote(env, userId, role = 'user') {
  env.DB.sqlite
    .prepare("UPDATE users SET role = ?, status = 'active', email_verified = CASE WHEN email IS NULL THEN 0 ELSE 1 END, email_key = lower(email) WHERE id = ?")
    .run(role, userId);
}
