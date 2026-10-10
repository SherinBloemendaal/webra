// Error reports of the game and the website to WebRA's own Sentry
// (sentry.vitrion.dev; docs/security.md, "Error reports").
//
//   initTelemetry({ surface: 'game' });           // js/telemetry/boot.js, before the game loads
//   connectRegistry(defaultRegistry());           // the "Send error reports" setting, live
//   setTags({ renderer: 'webgpu', mode: 'skirmish', original_content: 'off' });
//   reportError(err);                             // an error the game caught but wants reported
//   noteUserText(message);                        // players' text to cut out of reports
//
// Nothing happens without a DSN (tests, local builds: js/telemetry/config.js)
// or while the player has switched reports off (`privacy.errorReports`,
// default on): the SDK is not even loaded then. Switching reports off later
// drops everything from then on; switching them on loads the SDK.
//
// The SDK (@sentry/browser, bundled by tools/build-dist.mjs into
// vendor/sentry.js next to js/, no third-party CDN) sends errors only, plus
// a small share of page load traces (`tracesSampleRate`): no session replay,
// no sessions, no user, no cookies or headers, nothing sent with requests
// to the API. Every event and breadcrumb goes through protocol/scrub.js.
//
// The simulation worker has no SDK: it sends its errors to the main thread
// (js/sim/worker.js `error` messages), which reports them here.

import { TELEMETRY_CONFIG } from './config.js';
import { PROTOCOL_VERSION } from '../../protocol/constants.js';
import { Redactor, scrubBreadcrumb, scrubEvent } from '../../protocol/scrub.js';

/** localStorage key and place of the setting (js/registry.js REGISTRY_KEY, group `privacy`). */
export const CONSENT_KEY = 'webra.prefs.v1';
export const CONSENT_GROUP = 'privacy';
export const CONSENT_SETTING = 'errorReports';
/** Errors kept while the SDK loads (thrown before it could listen). */
const EARLY_MAX = 10;
/** Breadcrumbs kept per event. */
const MAX_BREADCRUMBS = 50;

/**
 * Every category of data the SDK could collect by itself is off
 * (@sentry/core `dataCollection`, which replaced `sendDefaultPii`).
 */
export const DATA_COLLECTION = Object.freeze({
  userInfo: false,
  cookies: false,
  httpHeaders: false,
  httpBodies: [],
  urlQueryParams: false,
  graphQL: { document: false, variables: false },
  genAI: { inputs: false, outputs: false },
  databaseQueryData: false,
  queues: false,
  stackFrameVariables: false,
});

/** Default integrations left out (see sdkOptions). */
const DROPPED_INTEGRATIONS = new Set(['BrowserSession', 'CultureContext', 'ConversationId']);

/** The vendored SDK (tools/build-dist.mjs): dist/play/vendor/sentry.js or dist/lib/vendor/sentry.js. */
const SDK_URL = new URL('../../vendor/sentry.js', import.meta.url).href;
const defaultLoader = () => import(SDK_URL);

function freshState() {
  return {
    config: TELEMETRY_CONFIG,
    surface: null,
    consent: true,
    /** The SDK module once loaded and initialized. */
    sdk: null,
    /** The SDK while it loads. */
    loading: null,
    loader: defaultLoader,
    tags: {},
    early: [],
    offs: [],
    redactor: new Redactor(),
  };
}

let state = freshState();

/** Whether this build has a DSN at all. */
export function configured(config = state.config) {
  return typeof config?.dsn === 'string' && config.dsn.length > 0;
}

/** The player's choice as stored by the settings registry (default on), read without loading the registry. */
export function readConsent(storage = defaultStorage()) {
  try {
    const doc = JSON.parse(storage?.getItem(CONSENT_KEY) ?? 'null');
    return doc?.[CONSENT_GROUP]?.[CONSENT_SETTING] !== false;
  } catch {
    return true;
  }
}

function defaultStorage() {
  try {
    return globalThis.window?.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Whether reports are sent right now. */
export function active() {
  return configured() && state.consent && !!state.sdk;
}

/**
 * Start error reports for this page. `surface` is 'game' or 'website'.
 * Resolves with `{ enabled, reason }`; never throws.
 * @param {{ surface: string, config?: object, storage?: Storage | null, win?: any, loadSdk?: () => Promise<any> }} o
 */
export async function initTelemetry({ surface, config = TELEMETRY_CONFIG, storage = defaultStorage(), win = globalThis.window ?? null, loadSdk = defaultLoader }) {
  state.config = config;
  state.surface = surface;
  state.loader = loadSdk;
  if (!configured(config)) return { enabled: false, reason: 'no DSN in this build' };
  state.consent = readConsent(storage);
  // Another tab (or the website's privacy page) changed the setting.
  if (win?.addEventListener) {
    const onStorage = (e) => {
      if (e.key === CONSENT_KEY) setConsent(readConsent(storage));
    };
    win.addEventListener('storage', onStorage);
    state.offs.push(() => win.removeEventListener('storage', onStorage));
    // Errors thrown while the SDK loads (never while reports are off).
    const early = (e) => {
      if (state.sdk || !state.consent || state.early.length >= EARLY_MAX) return;
      state.early.push(e.type === 'unhandledrejection' ? e.reason : (e.error ?? new Error(e.message)));
    };
    win.addEventListener('error', early);
    win.addEventListener('unhandledrejection', early);
    state.offs.push(() => {
      win.removeEventListener('error', early);
      win.removeEventListener('unhandledrejection', early);
    });
  }
  if (!state.consent) return { enabled: false, reason: 'switched off by the player' };
  return start();
}

/** Load and initialize the SDK (once). */
async function start() {
  if (state.sdk) return { enabled: true, reason: 'running' };
  state.loading ??= (async () => {
    const sdk = await state.loader();
    sdk.init(sdkOptions(sdk));
    state.sdk = sdk;
    const early = state.early.splice(0);
    for (const err of early) reportError(err, { source: 'early' });
  })();
  try {
    await state.loading;
    return { enabled: true, reason: 'running' };
  } catch (err) {
    state.loading = null;
    console.warn('Error reports are unavailable:', err?.message ?? err);
    return { enabled: false, reason: 'the SDK did not load' };
  }
}

/** The SDK's options: errors only, a share of page load traces, everything scrubbed. */
export function sdkOptions(sdk, config = state.config) {
  const rate = Number(config.tracesSampleRate) || 0;
  return {
    dsn: config.dsn,
    release: config.release || undefined,
    environment: config.environment || 'production',
    dataCollection: DATA_COLLECTION,
    // Sessions (release health) are not wanted, nor the time zone and locale
    // (CultureContext); replays are not in the bundle at all.
    integrations: (defaults) => [
      ...defaults.filter((i) => !DROPPED_INTEGRATIONS.has(i.name)),
      // No tracing headers on requests to the API or anywhere else.
      ...(rate > 0 && sdk.browserTracingIntegration ? [sdk.browserTracingIntegration({ traceFetch: false, traceXHR: false })] : []),
    ],
    tracesSampleRate: rate,
    // Traces as transaction events, so they pass beforeSendTransaction (the
    // default streams spans past it).
    traceLifecycle: 'static',
    tracePropagationTargets: [],
    sendClientReports: false,
    maxBreadcrumbs: MAX_BREADCRUMBS,
    initialScope: { tags: baseTags() },
    // The browser's user agent stays: it says which browser and GPU stack failed.
    beforeSend: (event, hint) => (state.consent ? scrubEvent(withContext(event, hint), state.redactor, { userAgent: true }) : null),
    beforeSendTransaction: (event) => (state.consent ? scrubEvent(event, state.redactor, { userAgent: true }) : null),
    beforeBreadcrumb: (crumb) => (state.consent ? scrubBreadcrumb(crumb, state.redactor) : null),
  };
}

function baseTags() {
  return { surface: state.surface ?? 'unknown', protocol: String(PROTOCOL_VERSION), ...state.tags };
}

/** The engine facts an error carries (js/sim/engine-error.js `webraContext`), as the `engine` context. */
function withContext(event, hint) {
  const context = hint?.originalException?.webraContext;
  if (!context || typeof context !== 'object') return event;
  return { ...event, contexts: { ...event.contexts, engine: { ...context } } };
}

/** Switch reports on or off (the setting changed). */
export function setConsent(on) {
  const next = on !== false;
  if (next === state.consent) return;
  state.consent = next;
  if (next && configured() && !state.sdk) start();
}

/**
 * Follow the "Send error reports" setting of a settings registry
 * (js/registry.js): its value now, and every change (this page, other
 * tabs, the account's settings). Returns a function that stops.
 */
export function connectRegistry(registry) {
  setConsent(registry.get(CONSENT_GROUP, CONSENT_SETTING));
  // The player's own name (the lobby name when not signed in) is cut out of reports too.
  noteUserText(registry.get('lobby', 'name'));
  const offs = [
    registry.subscribe(CONSENT_GROUP, (values) => setConsent(values[CONSENT_SETTING])),
    registry.subscribe('lobby', (values) => noteUserText(values.name)),
  ];
  const off = () => offs.forEach((f) => f());
  state.offs.push(off);
  return off;
}

/**
 * Tags on every later report: `mode` (menu, skirmish, mission, online,
 * replay, stress), `renderer` (webgpu or unavailable), `original_content`
 * (on or off). Values are short words, never players' text or file names.
 */
export function setTags(tags) {
  for (const [k, v] of Object.entries(tags)) state.tags[k] = String(v);
  state.sdk?.setTags?.({ ...tags });
}

/** Report an error the page caught. `source` says where it came from (a tag). */
export function reportError(err, { source = null, context = null } = {}) {
  if (!configured() || !state.consent) return;
  if (!state.sdk) {
    if (state.loading && state.early.length < EARLY_MAX) state.early.push(err);
    return;
  }
  const error = err instanceof Error ? err : new Error(String(err));
  if (context && !error.webraContext) error.webraContext = context;
  state.sdk.captureException(error, source ? { tags: { source } } : undefined);
}

/** Report something that is not an exception (a desync, for example), with engine facts. */
export function reportMessage(message, { level = 'warning', context = null } = {}) {
  if (!active()) return;
  state.sdk.captureMessage(message, { level, ...(context ? { contexts: { engine: { ...context } } } : {}) });
}

/** Players' text this page received or sent (any JSON value): cut out of every later report. */
export function noteUserText(value) {
  if (typeof value === 'string') state.redactor.add(value);
  else state.redactor.harvest(value);
}

/** Forget everything (tests). */
export function resetTelemetry() {
  for (const off of state.offs) off();
  state = freshState();
}
