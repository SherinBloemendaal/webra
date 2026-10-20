// Error reports of the Worker to WebRA's own Sentry (sentry.vitrion.dev;
// docs/security.md, "Error reports"), with @sentry/cloudflare:
//
//   export default withTelemetry({ fetch, scheduled });   // src/index.js
//   export const Session = instrumentSession(SessionObject);
//   logError('api error', err);                            // a caught failure: logged and reported
//
// Variables (wrangler.jsonc `vars`, set for deploys by .github/workflows/deploy.yml
// from tools/sentry-config.mjs): SENTRY_DSN (empty: nothing is wrapped or
// sent, the default for wrangler dev and the tests), SENTRY_ENVIRONMENT,
// SENTRY_RELEASE (`webra@<version>+<commit>`, the same as the game's) and
// SENTRY_TRACES_SAMPLE_RATE.
//
// Reports never hold request bodies, cookies, Authorization, X-WebRA-Member,
// X-WebRA-Auth or any other header, query strings (rejoin keys, OAuth codes),
// network addresses or users: the SDK collects none of it (`dataCollection`)
// and every event, transaction and breadcrumb goes through the protocol
// package's scrubber (packages/protocol/src/scrub.js) as well.

import { captureException, instrumentDurableObjectWithSentry, withSentry, withStaticSpan } from '@sentry/cloudflare';
import { scrubBreadcrumb, scrubEvent, scrubSpan } from '@webra/protocol';

/** Every category of data the SDK could collect by itself is off (it replaced `sendDefaultPii`). */
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

export const DEFAULT_TRACES_SAMPLE_RATE = 0.005;

/**
 * Durable Object handlers that are never traced: the session alarm (every
 * second in a running game) and every WebSocket message (each lockstep frame
 * and ping). At any sample rate they would outnumber all other traces; their
 * errors are still reported.
 */
export const UNTRACED_SPANS = new Set(['alarm', 'webSocketMessage']);

/** The Worker's DSN, or '' (reports off). */
export function dsnOf(env) {
  return typeof env?.SENTRY_DSN === 'string' ? env.SENTRY_DSN.trim() : '';
}

function sampleRate(value) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : DEFAULT_TRACES_SAMPLE_RATE;
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : DEFAULT_TRACES_SAMPLE_RATE;
}

/**
 * The SDK options for `env`. `transport` replaces the SDK's (tests: a fake
 * that records envelopes; nothing reaches a real Sentry).
 * @param {object} env
 * @param {{ transport?: Function }} [o]
 */
export function sentryOptions(env, { transport = null } = {}) {
  const rate = sampleRate(env?.SENTRY_TRACES_SAMPLE_RATE);
  return {
    dsn: dsnOf(env),
    release: typeof env?.SENTRY_RELEASE === 'string' && env.SENTRY_RELEASE ? env.SENTRY_RELEASE : undefined,
    environment: typeof env?.SENTRY_ENVIRONMENT === 'string' && env.SENTRY_ENVIRONMENT ? env.SENTRY_ENVIRONMENT : 'production',
    tracesSampleRate: rate,
    // Per trace: the handlers above never, the rest at the rate (or as the parent decided).
    tracesSampler: ({ name, inheritOrSampleWith }) => (UNTRACED_SPANS.has(name) ? 0 : inheritOrSampleWith(rate)),
    // Traces as transaction events, so they pass beforeSendTransaction (the
    // default streams spans past it).
    traceLifecycle: 'static',
    // No sentry-trace or baggage headers on the Worker's own requests
    // (Discord, the content mirrors, archive.org).
    tracePropagationTargets: [],
    // Sentry must not take an address from the connection (it is
    // Cloudflare's, but the setting says so for every report).
    _metadata: { sdk: { settings: { infer_ip: 'never' } } },
    dataCollection: DATA_COLLECTION,
    sendClientReports: false,
    initialScope: { tags: { surface: 'worker' } },
    beforeSend: (event) => scrubEvent(event),
    beforeSendTransaction: (event) => scrubEvent(event),
    beforeBreadcrumb: (crumb) => scrubBreadcrumb(crumb),
    beforeSendSpan: withStaticSpan((span) => scrubSpan(span)),
    // A test's fake transport: a client per invocation (the SDK otherwise keeps one per isolate).
    ...(transport ? { transport, cacheClient: false } : {}),
  };
}

/**
 * The Worker's handlers with error reports: `fetch` and `scheduled` run
 * under the SDK when the environment has a DSN, as they are otherwise.
 * @param {{ fetch: Function, scheduled?: Function }} handler
 * @param {{ transport?: Function }} [o]
 */
export function withTelemetry(handler, o = {}) {
  const wrapped = withSentry((env) => sentryOptions(env, o), { ...handler });
  const out = {
    fetch: (request, env, ctx) => (dsnOf(env) ? wrapped.fetch(request, env, ctx) : handler.fetch(request, env, ctx)),
  };
  if (handler.scheduled) out.scheduled = (controller, env, ctx) => (dsnOf(env) ? wrapped.scheduled(controller, env, ctx) : handler.scheduled(controller, env, ctx));
  return out;
}

/**
 * A Durable Object class with error reports (fetch, alarms, WebSocket
 * handlers and RPC methods) when its environment has a DSN; without one,
 * instances are the plain class.
 * @param {Function} Base
 * @param {{ transport?: Function }} [o]
 */
export function instrumentSession(Base, o = {}) {
  const Instrumented = instrumentDurableObjectWithSentry((env) => sentryOptions(env, o), Base);
  return new Proxy(Base, {
    construct(target, args, newTarget) {
      return dsnOf(args[1]) ? Reflect.construct(Instrumented, args) : Reflect.construct(target, args, newTarget);
    },
  });
}

/**
 * A failure the Worker caught and answers or skips (a 500, a failed
 * background write): logged as before (name and message only, never request
 * data) and reported with its stack when reports are on.
 * @param {string} label what failed, a fixed text such as "api error"
 * @param {unknown} err
 */
export function logError(label, err) {
  console.error(label, err?.name, err?.message);
  captureException(err, { tags: { where: label } });
}

/**
 * A 5xx answer the Worker gives on purpose (an HttpError: the session did
 * not answer, a mirror is down, the server lacks a setting): reported, an
 * upstream or configuration problem (502, 503) as a warning. Its message
 * is the Worker's own text.
 */
export function reportHttpError(err) {
  if (!(err?.status >= 500)) return;
  captureException(err, { level: err.status >= 502 ? 'warning' : 'error', tags: { status: String(err.status), code: String(err.code) } });
}
