// Error reports of the game and the website (js/telemetry/index.js) and
// engine failures as errors that say what happened (js/sim/engine-error.js,
// engine/src/panic_report.rs): nothing without a DSN, the player's switch
// honoured before the SDK loads and live, scrubbing of what the SDK would
// send, the engine panic hook end to end, and the CSP. A fake SDK stands in
// for @sentry/browser: nothing is ever sent. Run after `npm run build:wasm`.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { initSync, Game, take_panic, version } from '../pkg/webra_sim.js';
import {
  CONSENT_KEY,
  DATA_COLLECTION,
  ErrorBudget,
  ERRORS_PER_MINUTE,
  SAME_ERROR_MAX,
  active,
  connectRegistry,
  initTelemetry,
  noteUserText,
  readConsent,
  reportError,
  reportMessage,
  resetTelemetry,
  sdkOptions,
  setConsent,
  setTags,
  TRACING_OPTIONS,
} from '../js/telemetry/index.js';
import { TELEMETRY_CONFIG } from '../js/telemetry/config.js';
import { EngineError, engineError, reviveError, serializeError } from '../js/sim/engine-error.js';
import { SimCore } from '../js/sim/core.js';
import { createRegistry } from '../js/registry.js';
import { createSettings } from '../js/settings.js';
import { MENU_HELP_KEYS, MENU_SETTINGS } from '../js/gamemenu.js';
import { HELP } from '../js/help.js';
import { SITE_HEADERS } from '../../server/src/static-headers.js';
import { connectSources, sentryBuildConfig } from '../../../tools/sentry-config.mjs';
import { buildSentryBundle } from '../../../tools/vendor-sentry.mjs';
import { WASM_PATH } from './sim-fixtures.mjs';

initSync({ module: readFileSync(WASM_PATH) });

const CONFIG = Object.freeze({ dsn: 'https://0123456789abcdef0123456789abcdef@sentry.invalid/1', environment: 'test', release: 'webra@0.0.0+test', tracesSampleRate: 0.05 });

/** A fake @sentry/browser: records init options and every capture. */
function fakeSdk() {
  const sdk = {
    options: null,
    captured: [],
    tags: {},
    init(options) {
      sdk.options = options;
    },
    captureException(err, hint) {
      sdk.captured.push({ kind: 'exception', err, hint });
    },
    captureMessage(message, hint) {
      sdk.captured.push({ kind: 'message', message, hint });
    },
    setTags(tags) {
      Object.assign(sdk.tags, tags);
    },
    browserTracingIntegration: (o) => ({ name: 'BrowserTracing', o }),
    withStaticSpan: (fn) => Object.assign(fn, { static: true }),
    sent: [],
    makeFetchTransport: () => ({ send: async (envelope) => (sdk.sent.push(envelope), { statusCode: 200 }), flush: async () => true }),
  };
  return sdk;
}

/** A Web Storage stand-in over a Map. */
function memoryStorage(doc = null) {
  const data = new Map(doc ? [[CONSENT_KEY, JSON.stringify(doc)]] : []);
  return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, String(v)), removeItem: (k) => data.delete(k) };
}

/** A window stand-in with addEventListener / dispatch. */
function fakeWindow() {
  const listeners = new Map();
  return {
    addEventListener: (type, fn) => listeners.set(type, [...(listeners.get(type) ?? []), fn]),
    removeEventListener: (type, fn) => listeners.set(type, (listeners.get(type) ?? []).filter((f) => f !== fn)),
    dispatch: (type, e) => (listeners.get(type) ?? []).forEach((fn) => fn({ type, ...e })),
  };
}

afterEach(() => resetTelemetry());

// ---- Without a DSN nothing happens --------------------------------------------------------

test('the repository build has no DSN: init, reports and tags do nothing and the SDK never loads', async () => {
  assert.equal(TELEMETRY_CONFIG.dsn, '');
  let loads = 0;
  const r = await initTelemetry({ surface: 'game', storage: memoryStorage(), win: fakeWindow(), loadSdk: async () => (loads++, fakeSdk()) });
  assert.deepEqual(r, { enabled: false, reason: 'no DSN in this build' });
  reportError(new Error('boom'));
  reportMessage('desync');
  setConsent(false);
  setConsent(true);
  setTags({ mode: 'skirmish' });
  assert.equal(loads, 0);
  assert.equal(active(), false);
});

test('no build has a DSN unless SENTRY_DSN is set, production builds included', () => {
  assert.equal(sentryBuildConfig({}).dsn, '');
  assert.equal(sentryBuildConfig({ NODE_ENV: 'test' }).dsn, '');
  assert.equal(sentryBuildConfig({ WEBRA_ENV: 'production' }).dsn, '');
  assert.equal(sentryBuildConfig({ WEBRA_ENV: 'production', SENTRY_DSN: 'off' }).dsn, '');
  assert.equal(sentryBuildConfig({ WEBRA_ENV: 'production', SENTRY_DSN: CONFIG.dsn }).dsn, CONFIG.dsn);
});

// ---- The player's switch ------------------------------------------------------------------

test('switched off before the page loads: the SDK is not loaded; switching on later loads it', async () => {
  let loads = 0;
  const sdk = fakeSdk();
  const loadSdk = async () => (loads++, sdk);
  const storage = memoryStorage({ schema: 1, privacy: { errorReports: false } });
  assert.equal(readConsent(storage), false);
  const win = fakeWindow();
  const r = await initTelemetry({ surface: 'game', config: CONFIG, storage, win, loadSdk });
  assert.deepEqual(r, { enabled: false, reason: 'switched off by the player' });
  reportError(new Error('not sent'));
  win.dispatch('error', { error: new Error('thrown while off') });
  assert.equal(loads, 0);
  // Another tab (or the website's privacy page) switches it on.
  storage.setItem(CONSENT_KEY, JSON.stringify({ schema: 1, privacy: { errorReports: true } }));
  win.dispatch('storage', { key: CONSENT_KEY });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(loads, 1);
  assert.equal(active(), true);
  assert.equal(sdk.captured.length, 0, 'what happened while off is never sent');
});

test('the setting is read without the registry: default on, garbage on', () => {
  assert.equal(readConsent(null), true);
  assert.equal(readConsent(memoryStorage()), true);
  assert.equal(readConsent(memoryStorage({ privacy: { errorReports: true } })), true);
  assert.equal(readConsent({ getItem: () => '{not json' }), true);
  assert.equal(readConsent({ getItem: () => { throw new Error('blocked'); } }), true);
});

test('switching off while running drops every event, transaction and breadcrumb at once (the registry, live)', async () => {
  const sdk = fakeSdk();
  await initTelemetry({ surface: 'game', config: CONFIG, storage: memoryStorage(), win: fakeWindow(), loadSdk: async () => sdk });
  const registry = createRegistry({ storage: null });
  connectRegistry(registry);
  const o = sdk.options;
  assert.ok(o.beforeSend({ message: 'x' }, {}));
  assert.ok(o.beforeBreadcrumb({ category: 'ui.click', message: 'button' }));
  // The game menu's switch (js/settings.js `errorReports`) writes the registry.
  createSettings(registry).set('errorReports', false);
  assert.equal(o.beforeSend({ message: 'x' }, {}), null);
  assert.equal(o.beforeSendTransaction({ type: 'transaction' }), null);
  assert.equal(o.beforeBreadcrumb({ category: 'ui.click', message: 'button' }), null);
  reportError(new Error('not sent'));
  reportMessage('not sent');
  assert.equal(sdk.captured.length, 0);
  // An account sync switches it back on.
  registry.applyDocument({ privacy: { errorReports: true } });
  assert.ok(o.beforeSend({ message: 'x' }, {}));
});

test('error budget: a few reports of one error per page, and a cap per minute over all errors', async () => {
  let t = 1_000_000;
  resetTelemetry({ budget: { now: () => t } });
  const sdk = fakeSdk();
  await initTelemetry({ surface: 'game', config: CONFIG, storage: memoryStorage(), win: fakeWindow(), loadSdk: async () => sdk });
  const o = sdk.options;
  const ev = (value, type = 'TypeError') => ({ exception: { values: [{ type, value }] } });
  // A render loop throwing every frame: SAME_ERROR_MAX reports, then nothing for the rest of the page.
  const sent = Array.from({ length: 50 }, () => o.beforeSend(ev('x is undefined'), {})).filter(Boolean).length;
  assert.equal(sent, SAME_ERROR_MAX);
  t += 10 * 60 * 1000;
  assert.equal(o.beforeSend(ev('x is undefined'), {}), null, 'per page load, not per minute');
  // Another type with the same text is another error; messages count by their text.
  assert.ok(o.beforeSend(ev('x is undefined', 'RangeError'), {}));
  assert.ok(o.beforeSend({ message: 'Lockstep desync' }, {}));
  // Many different errors: at most ERRORS_PER_MINUTE in any minute.
  let n = 2;
  for (let i = 0; i < 40; i++) if (o.beforeSend(ev(`error ${i}`), {})) n++;
  assert.equal(n, ERRORS_PER_MINUTE);
  t += 59 * 1000;
  assert.equal(o.beforeSend(ev('later'), {}), null);
  t += 1000;
  assert.ok(o.beforeSend(ev('later'), {}), 'a minute after, the next report goes');
});

test('error budget keys: exception type and message, else the message, cut short', () => {
  assert.equal(ErrorBudget.keyOf({ exception: { values: [{ type: 'Error', value: 'boom' }] } }), 'Error: boom');
  assert.equal(ErrorBudget.keyOf({ message: 'desync' }), 'desync');
  assert.equal(ErrorBudget.keyOf({ logentry: { message: 'log' } }), 'log');
  assert.equal(ErrorBudget.keyOf({ message: 'm'.repeat(1000) }).length, 200);
  const b = new ErrorBudget({ sameMax: 1, perMinute: 100, now: () => 0 });
  assert.equal(b.take({ message: 'a' }), true);
  assert.equal(b.take({ message: 'a' }), false);
  assert.equal(b.take({ message: 'b' }), true);
});

test('the switch is in the settings registry, the account document, the game menu (with help) and kept by Defaults', async () => {
  const registry = createRegistry({ storage: null });
  assert.equal(registry.get('privacy', 'errorReports'), true);
  const { validateSettingsDocument } = await import('../js/protocol.js');
  assert.deepEqual(validateSettingsDocument({ privacy: { errorReports: false } }), { privacy: { errorReports: false } });
  assert.throws(() => validateSettingsDocument({ privacy: { errorReports: 'no' } }), /true or false/);
  assert.throws(() => validateSettingsDocument({ privacy: { tracking: true } }), /Unknown setting/);
  assert.ok(MENU_HELP_KEYS.includes('errorReports'));
  assert.ok(HELP['settings.errorReports'].includes('sentry.vitrion.dev'));
  assert.equal(MENU_SETTINGS.includes('errorReports'), false, 'Defaults never switch reports back on');
  // The switch covers this browser; the server's own reports hold no player data.
  assert.match(HELP['settings.errorReports'], /covers this browser/);
  assert.match(HELP['settings.errorReports'], /server then reports its own errors either way/);
  assert.match(HELP['settings.errorReports'], /operator has turned error reporting on/);
  const privacy = readFileSync(new URL('../../website/privacy.html', import.meta.url), 'utf8');
  assert.match(privacy, /The switch covers this browser/);
  assert.match(privacy, /Error reporting is currently off/);
  assert.match(privacy, /WebRA's server reports its own errors whatever the switch says/);
  assert.match(privacy, /reports from your browser also tell Sentry not to take it\s+from the connection/);
});

// ---- What the SDK is told -----------------------------------------------------------------

test('SDK options: errors and sampled page loads only, nothing collected, no sessions, no tracing headers', async () => {
  const sdk = fakeSdk();
  setTags({ mode: 'menu' });
  await initTelemetry({ surface: 'website', config: CONFIG, storage: memoryStorage(), win: fakeWindow(), loadSdk: async () => sdk });
  const o = sdk.options;
  assert.equal(o.dsn, CONFIG.dsn);
  assert.equal(o.release, 'webra@0.0.0+test');
  assert.equal(o.environment, 'test');
  assert.equal(o.tracesSampleRate, 0.05);
  assert.deepEqual(o.tracePropagationTargets, []);
  assert.equal(o.dataCollection, DATA_COLLECTION);
  for (const [k, v] of Object.entries(DATA_COLLECTION)) {
    if (k === 'httpBodies') assert.deepEqual(v, []);
    else if (typeof v === 'object') assert.ok(Object.values(v).every((x) => x === false), k);
    else assert.equal(v, false, k);
  }
  const integrations = o.integrations([{ name: 'GlobalHandlers' }, { name: 'BrowserSession' }, { name: 'CultureContext' }, { name: 'Breadcrumbs' }]);
  assert.deepEqual(
    integrations.map((i) => i.name),
    ['GlobalHandlers', 'Breadcrumbs', 'BrowserTracing'],
  );
  // No INP (a span sent on its own, named after the element clicked), no long tasks, no request spans.
  assert.deepEqual(integrations[2].o, { traceFetch: false, traceXHR: false, enableInp: false, enableLongTask: false, enableLongAnimationFrame: false });
  assert.deepEqual(integrations[2].o, { ...TRACING_OPTIONS });
  assert.equal(o.traceLifecycle, 'static');
  // Every span is scrubbed, also one sent on its own.
  assert.equal(o.beforeSendSpan.static, true);
  noteUserText({ name: 'Remove Tanya' });
  assert.deepEqual(o.beforeSendSpan({ description: 'ui.interaction.click: button[title="Remove Tanya"]', data: { 'browser.web_vital.inp.target': 'div > button.kick[aria-label="Remove Tanya"]', 'url.full': 'https://webra.sherin.dev/play/?join=x', 'user_agent.original': 'UA' } }), {
    description: 'ui.interaction.click: button[title="[redacted]"]',
    data: { 'browser.web_vital.inp.target': 'div > button.kick[aria-label="[redacted]"]', 'url.full': 'https://webra.sherin.dev/play/?join=[Filtered]' },
  });
  assert.deepEqual(o.initialScope.tags, { surface: 'website', protocol: o.initialScope.tags.protocol, mode: 'menu' });
  assert.match(o.initialScope.tags.protocol, /^\d+$/);
  // No traces at all with a rate of 0.
  assert.deepEqual(
    sdkOptions(sdk, { ...CONFIG, tracesSampleRate: 0 })
      .integrations([{ name: 'Dedupe' }])
      .map((i) => i.name),
    ['Dedupe'],
  );
  setTags({ mode: 'online', renderer: 'webgpu', original_content: 'off' });
  assert.deepEqual(sdk.tags, { mode: 'online', renderer: 'webgpu', original_content: 'off' });
});

test('the transport sends nothing while reports are off, whatever produced the envelope', async () => {
  const sdk = fakeSdk();
  await initTelemetry({ surface: 'game', config: CONFIG, storage: memoryStorage(), win: fakeWindow(), loadSdk: async () => sdk });
  const transport = sdk.options.transport({ url: 'https://sentry.invalid' });
  await transport.send(['event']);
  assert.equal(sdk.sent.length, 1);
  setConsent(false);
  // A span sent on its own (the SDK's standalone spans) passes no beforeSend hook: the transport drops it.
  await transport.send([{}, [[{ type: 'span' }, { name: 'click' }]]]);
  assert.equal(sdk.sent.length, 1);
  setConsent(true);
  await transport.send(['event']);
  assert.equal(sdk.sent.length, 2);
  assert.equal(await transport.flush(10), true);
});

test('the real bundled SDK: reports go through the consent transport, requests get no tracing headers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'webra-sdk-'));
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), headers: Object.fromEntries(new Headers(init?.headers ?? undefined)) });
    return new Response('{}');
  };
  try {
    const file = join(dir, 'sentry.js');
    await buildSentryBundle(file);
    const real = await import(pathToFileURL(file).href);
    const sent = [];
    const sdk = { ...real, makeFetchTransport: () => ({ send: async (e) => (sent.push(e), { statusCode: 200 }), flush: async () => true }) };
    const r = await initTelemetry({ surface: 'game', config: { ...CONFIG, tracesSampleRate: 1 }, storage: memoryStorage(), win: fakeWindow(), loadSdk: async () => sdk });
    assert.equal(r.enabled, true);
    await fetch('https://webra.sherin.dev/api/sessions');
    await fetch('/api/maps');
    for (const s of seen) {
      assert.equal(s.headers['sentry-trace'], undefined, s.url);
      assert.equal(s.headers.baggage, undefined, s.url);
    }
    reportError(new Error('sent'));
    await new Promise((res) => setTimeout(res, 50));
    const items = () => sent.flatMap((env) => env[1].map(([h, p]) => ({ type: h.type, p })));
    assert.equal(items().filter((i) => i.type === 'event').length, 1);
    assert.equal(items().find((i) => i.type === 'event').p.sdk.settings.infer_ip, 'never', 'Sentry takes no address from the connection');
    setConsent(false);
    real.captureMessage('dropped while off');
    await new Promise((res) => setTimeout(res, 50));
    assert.equal(items().filter((i) => i.type === 'event').length, 1);
  } finally {
    globalThis.fetch = realFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('beforeSend scrubs chat, names, member keys, cookies, headers and URLs with tokens', async () => {
  const sdk = fakeSdk();
  await initTelemetry({ surface: 'game', config: CONFIG, storage: memoryStorage(), win: fakeWindow(), loadSdk: async () => sdk });
  // What js/net.js and js/account/api.js see: a chat line, a lobby, the account.
  noteUserText({ t: 'chat', from: 1, name: 'Tanya Adams', text: 'meet me at the bridge' });
  noteUserText({ sessions: [{ id: 'a'.repeat(64), name: 'Friday night ops', map: { title: 'Arctic Circle' } }] });
  noteUserText({ user: { id: 7, username: 'tanya', displayName: 'Tanya A', email: 'tanya@example.com' } });
  const member = `3.${'k'.repeat(40)}`;
  const event = {
    message: 'chat failed: meet me at the bridge',
    user: { id: 7, ip_address: '203.0.113.9' },
    request: {
      url: `https://webra.sherin.dev/play/?join=${'a'.repeat(64)}&instances=gpu#join=${'a'.repeat(64)}`,
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0 Chrome/140', Cookie: '__Host-webra_session=secret', 'X-WebRA-Member': member, Referer: 'https://webra.sherin.dev/account/' },
      cookies: { session: 'secret' },
      query_string: 'join=x',
      data: '{"password":"hunter2"}',
    },
    exception: {
      values: [
        {
          type: 'Error',
          value: `Lobby "Friday night ops" on Arctic Circle by Tanya Adams failed for tanya@example.com (member ${member})`,
          stacktrace: { frames: [{ filename: 'https://webra.sherin.dev/play/js/online.js?v=1', abs_path: 'https://webra.sherin.dev/play/js/online.js?token=abc', vars: { text: 'x' } }] },
        },
      ],
    },
    breadcrumbs: [
      { category: 'console', level: 'warning', message: 'Tanya Adams: meet me at the bridge', data: { arguments: ['Tanya Adams', { text: 'meet me at the bridge' }], logger: 'console' } },
      { category: 'ui.click', message: 'div.lobby-row > button.join[title="Friday night ops"][aria-label="Join Friday night ops"]' },
      { category: 'fetch', data: { url: `/api/sessions/${'a'.repeat(64)}/map?hash=${'b'.repeat(64)}`, method: 'GET', status_code: 200 } },
      { category: 'navigation', data: { from: '/play/', to: `/play/?join=${'a'.repeat(64)}` } },
    ],
    contexts: { culture: { timezone: 'Europe/Amsterdam' }, browser: { name: 'Chrome' } },
    extra: { rejoinKey: 'k'.repeat(40), note: 'player tanya' },
  };
  const err = new EngineError('EnginePanic', 'index out of bounds', { context: { engine: '0.9.0+test', mode: 'online', tick: 1200, hashes: [[1175, '00000000deadbeef']] } });
  const out = sdk.options.beforeSend(structuredClone(event), { originalException: err });
  const text = JSON.stringify(out);
  for (const secret of ['meet me at the bridge', 'Tanya', 'tanya', 'Friday night ops', 'Arctic Circle', 'example.com', 'k'.repeat(40), 'a'.repeat(64), 'b'.repeat(64), 'hunter2', '__Host-webra_session', 'X-WebRA-Member', '203.0.113.9', 'Europe/Amsterdam', 'token=abc', 'Referer']) {
    assert.equal(text.includes(secret), false, `leaks ${secret}`);
  }
  assert.equal(out.user, undefined);
  assert.deepEqual(out.request, { url: 'https://webra.sherin.dev/play/?join=[Filtered]&instances=[Filtered]#[Filtered]', method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0 Chrome/140' } });
  assert.equal(out.message, 'chat failed: [redacted]');
  assert.equal(out.exception.values[0].stacktrace.frames[0].filename, 'https://webra.sherin.dev/play/js/online.js?v=[Filtered]', 'file names stay for the source match');
  assert.equal(out.exception.values[0].stacktrace.frames[0].abs_path, 'https://webra.sherin.dev/play/js/online.js?token=[Filtered]');
  assert.equal(out.exception.values[0].stacktrace.frames[0].vars, undefined);
  assert.equal(out.breadcrumbs[0].data.arguments, undefined);
  assert.equal(out.breadcrumbs[1].message, 'div.lobby-row > button.join[title][aria-label]');
  assert.equal(out.breadcrumbs[2].data.url, '/api/sessions/[Filtered]/map?hash=[Filtered]');
  assert.equal(out.breadcrumbs[2].data.status_code, 200);
  assert.deepEqual(out.contexts.browser, { name: 'Chrome' });
  // The engine facts of the error.
  assert.deepEqual(out.contexts.engine, { engine: '0.9.0+test', mode: 'online', tick: 1200, hashes: [[1175, '00000000deadbeef']] });
  assert.equal(out.extra.rejoinKey, undefined);
});

test('errors thrown or reported while the SDK loads are kept and sent once it runs', async () => {
  const sdk = fakeSdk();
  let release;
  const gate = new Promise((r) => (release = r));
  const win = fakeWindow();
  const init = initTelemetry({ surface: 'game', config: CONFIG, storage: memoryStorage(), win, loadSdk: () => gate.then(() => sdk) });
  reportError(new Error('early'), { source: 'sim-worker' });
  win.dispatch('error', { error: new TypeError('uncaught while loading') });
  win.dispatch('unhandledrejection', { reason: new RangeError('rejected while loading') });
  release();
  await init;
  assert.deepEqual(
    sdk.captured.map((c) => c.err.message),
    ['early', 'uncaught while loading', 'rejected while loading'],
  );
  reportError(reviveError(serializeError(new Error('later'))), { source: 'sim-worker' });
  assert.deepEqual(sdk.captured[3].hint, { tags: { source: 'sim-worker' } });
  win.dispatch('error', { error: new Error('the SDK handles these itself now') });
  assert.equal(sdk.captured.length, 4);
  reportMessage('Lockstep desync', { context: { tick: 50, desyncTick: 50 } });
  assert.deepEqual(sdk.captured[4], { kind: 'message', message: 'Lockstep desync', hint: { level: 'warning', contexts: { engine: { tick: 50, desyncTick: 50 } } } });
});

test('a failed SDK load turns reports off without throwing', async () => {
  const r = await initTelemetry({ surface: 'game', config: CONFIG, storage: memoryStorage(), win: fakeWindow(), loadSdk: async () => Promise.reject(new Error('blocked by an extension')) });
  assert.deepEqual(r, { enabled: false, reason: 'the SDK did not load' });
  reportError(new Error('dropped'));
  assert.equal(active(), false);
});

// ---- Engine panics ------------------------------------------------------------------------

test('an engine panic becomes an EnginePanic with its message, location and tick (the real wasm hook)', () => {
  const g = Game.new_stress(1, 10, 64);
  let trap;
  try {
    g.fog_ptr(99); // no player 99: the engine panics on the index
  } catch (err) {
    trap = err;
  }
  assert.ok(trap instanceof WebAssembly.RuntimeError);
  const err = engineError(trap, { takePanic: take_panic, context: () => ({ engine: version(), mode: 'stress', tick: 0, hashes: [] }) });
  assert.ok(err instanceof EngineError);
  assert.equal(err.name, 'EnginePanic');
  assert.match(err.message, /^index out of bounds: the len is \d+ but the index is 99 at engine\/src\/[a-z_/]+\.rs:\d+:\d+$/);
  assert.equal(err.cause, trap);
  assert.deepEqual(err.webraContext, { engine: version(), mode: 'stress', tick: 0, hashes: [], panicTick: 0 });
  assert.equal(take_panic(), undefined, 'taken once');
});

test('traps without a panic message, and ordinary errors', () => {
  const trap = new WebAssembly.RuntimeError('memory access out of bounds');
  const err = engineError(trap, { takePanic: () => undefined, context: () => ({ mode: 'skirmish' }) });
  assert.equal(err.name, 'EngineTrap');
  assert.equal(err.message, 'memory access out of bounds');
  assert.deepEqual(err.webraContext, { mode: 'skirmish' });
  const plain = new TypeError('not a function');
  assert.equal(engineError(plain, { takePanic: () => undefined }), plain);
  assert.equal(engineError(err), err);
  // A context that throws never hides the error.
  assert.equal(engineError(trap, { context: () => { throw new Error('x'); } }).webraContext, null);
});

test('SimCore: a panic stops the game, is reported once with the mode, tick and newest hashes, and every later call throws it', () => {
  const failures = [];
  const core = new SimCore({ Game, memory: () => null, engine: { version, takePanic: take_panic }, onFailure: (e) => failures.push(e) });
  core.start({ kind: 'stress', seed: 3, units: 10, size: 64, tickMs: 40 });
  core.noteHash(25, '0000000000000019');
  core.noteHash(50, '0000000000000032');
  assert.deepEqual(core.command('report'), { engine: version(), mode: 'stress', tick: 0, hashes: [[25, '0000000000000019'], [50, '0000000000000032']] });
  assert.throws(() => core.query('fog_bytes', [99]), (err) => err.name === 'EnginePanic' && /index is 99/.test(err.message));
  assert.equal(failures.length, 1);
  assert.equal(failures[0].webraContext.mode, 'stress');
  assert.deepEqual(failures[0].webraContext.hashes, [[25, '0000000000000019'], [50, '0000000000000032']]);
  assert.throws(() => core.step({ dt: 40, view: 0, rect: [0, 0, 1, 1] }), (err) => err === failures[0]);
  assert.throws(() => core.command('tick'), (err) => err === failures[0]);
  assert.equal(failures.length, 1);
  // Bad requests are not engine failures.
  const ok = new SimCore({ Game, memory: () => null, engine: { version, takePanic: take_panic } });
  assert.throws(() => ok.command('nope'), /unknown simulation command/);
  assert.equal(ok.failure, null);
});

test('worker errors cross postMessage as data and come back with name, stack and context', () => {
  const err = new EngineError('EnginePanic', 'boom at engine/src/world.rs:1:1', { context: { mode: 'online', tick: 9 } });
  const data = serializeError(err);
  assert.deepEqual(structuredClone(data), data);
  const back = reviveError(data);
  assert.equal(back.name, 'EnginePanic');
  assert.equal(back.message, err.message);
  assert.equal(back.stack, err.stack);
  assert.deepEqual(back.webraContext, { mode: 'online', tick: 9 });
  assert.equal(serializeError('a string').message, 'a string');
  assert.equal(serializeError(new Error('x'.repeat(5000))).message.length, 1000);
});

// ---- CSP ----------------------------------------------------------------------------------

test('the CSP lets the game and the website reach sentry.vitrion.dev and nothing else new', () => {
  const headers = readFileSync(new URL('../../website/_headers', import.meta.url), 'utf8');
  assert.deepEqual(connectSources(headers), ["'self'", 'wss://webra.sherin.dev', 'https://sentry.vitrion.dev']);
  assert.ok(SITE_HEADERS['Content-Security-Policy'].includes("connect-src 'self' wss://webra.sherin.dev https://sentry.vitrion.dev;"));
  assert.equal(sentryBuildConfig({ SENTRY_DSN: 'https://0123456789abcdef0123456789abcdef@sentry.vitrion.dev/121' }).origin, 'https://sentry.vitrion.dev');
  // Scripts still come from this origin only: the SDK is vendored, never a CDN.
  assert.ok(SITE_HEADERS['Content-Security-Policy'].includes("script-src 'self' 'wasm-unsafe-eval';"));
  for (const page of ['../index.html', '../editor/index.html']) {
    const html = readFileSync(new URL(page, import.meta.url), 'utf8');
    const boot = html.indexOf('src="js/telemetry/boot.js"');
    assert.ok(boot > 0 && boot < html.search(/src="(js\/main\.js|editor\/editor\.js)"/), `${page}: reports start before the game's modules`);
    assert.equal(/<meta[^>]+Content-Security-Policy/i.test(html), false);
  }
});
