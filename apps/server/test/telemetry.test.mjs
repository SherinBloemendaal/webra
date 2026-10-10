// Error reports of the Worker (src/telemetry.js) with the real
// @sentry/cloudflare SDK and a fake transport: a thrown error and a 5xx are
// reported, without request bodies, cookies, Authorization, member or auth
// headers, rejoin keys, query strings or addresses; nothing without a DSN.
// The fake transport keeps every envelope: nothing reaches a Sentry server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createTransport } from '@sentry/cloudflare';
import { DATA_COLLECTION, dsnOf, instrumentSession, logError, reportHttpError, sentryOptions, withTelemetry } from '../src/telemetry.js';
import { HttpError } from '../src/http.js';

const DSN = 'https://0123456789abcdef0123456789abcdef@sentry.invalid/1';
const MEMBER = `2.${'k'.repeat(43)}`;

/** A transport factory that records the items of every envelope it is given. */
function fakeTransport() {
  const items = [];
  const transport = (options) =>
    createTransport(options, async (request) => {
      const lines = (typeof request.body === 'string' ? request.body : new TextDecoder().decode(request.body)).split('\n').filter(Boolean);
      for (let i = 1; i < lines.length; i += 2) items.push({ header: JSON.parse(lines[i]), payload: JSON.parse(lines[i + 1]) });
      return { statusCode: 200 };
    });
  return { transport, items, events: () => items.filter((x) => x.header.type === 'event').map((x) => x.payload) };
}

/** An ExecutionContext whose waitUntil promises the test can await. */
function execContext() {
  const waits = [];
  return { waits, waitUntil: (p) => waits.push(p), passThroughOnException() {}, props: {} };
}

/** A request carrying every secret the Worker sees. */
function secretRequest() {
  return new Request(`https://webra.sherin.dev/api/sessions/${'a'.repeat(64)}/map?hash=${'b'.repeat(64)}&rejoin=${'r'.repeat(40)}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: '__Host-webra_session=s3ssion-secret',
      Authorization: 'Bearer auth-secret',
      'X-WebRA-Member': MEMBER,
      'X-WebRA-Auth': '{"account":{"id":7}}',
      'CF-Connecting-IP': '203.0.113.9',
      'X-Forwarded-For': '203.0.113.9',
      'User-Agent': 'Mozilla/5.0 secret-agent',
    },
    body: JSON.stringify({ password: 'hunter2', text: 'chat body' }),
  });
}

const SECRETS = ['s3ssion-secret', 'auth-secret', MEMBER, 'k'.repeat(43), '"account"', '203.0.113.9', 'secret-agent', 'hunter2', 'chat body', 'r'.repeat(40), 'a'.repeat(64), 'b'.repeat(64)];

function assertClean(value) {
  const text = JSON.stringify(value);
  for (const s of SECRETS) assert.equal(text.includes(s), false, `the report leaks ${s.slice(0, 20)}`);
}

test('a thrown error in fetch reaches the (fake) transport without any request data', async () => {
  const fake = fakeTransport();
  const worker = withTelemetry(
    {
      async fetch() {
        throw new TypeError('boom in the handler');
      },
    },
    { transport: fake.transport },
  );
  const ctx = execContext();
  const env = { SENTRY_DSN: DSN, SENTRY_RELEASE: 'webra@0.9.0+abcdef12', SENTRY_ENVIRONMENT: 'production', SENTRY_TRACES_SAMPLE_RATE: '0' };
  await assert.rejects(worker.fetch(secretRequest(), env, ctx), /boom in the handler/);
  await Promise.all(ctx.waits);
  const [event, ...more] = fake.events();
  assert.equal(more.length, 0);
  assert.equal(event.exception.values[0].type, 'TypeError');
  assert.equal(event.exception.values[0].value, 'boom in the handler');
  assert.equal(event.release, 'webra@0.9.0+abcdef12');
  assert.equal(event.environment, 'production');
  assert.equal(event.tags.surface, 'worker');
  // The SDK leaves the query out (dataCollection.urlQueryParams); the scrubber filters the session id.
  assert.deepEqual(event.request, { url: 'https://webra.sherin.dev/api/sessions/[Filtered]/map', method: 'POST' });
  assert.equal(event.user, undefined);
  assertClean(fake.items);
});

test('a sampled trace is a transaction event without headers, user agents, addresses, queries or bodies', async () => {
  const fake = fakeTransport();
  const worker = withTelemetry({ fetch: async () => new Response('ok') }, { transport: fake.transport });
  const ctx = execContext();
  const r = await worker.fetch(secretRequest(), { SENTRY_DSN: DSN, SENTRY_TRACES_SAMPLE_RATE: '1' }, ctx);
  await r.text();
  await Promise.all(ctx.waits);
  const tx = fake.items.filter((x) => x.header.type === 'transaction').map((x) => x.payload);
  assert.equal(tx.length, 1);
  assert.equal(tx[0].contexts.trace.op, 'http.server');
  assert.match(tx[0].contexts.trace.trace_id, /^[0-9a-f]{32}$/, 'trace ids stay');
  assert.equal(tx[0].contexts.trace.data['url.full'], 'https://webra.sherin.dev/api/sessions/[Filtered]/map');
  assert.equal(tx[0].contexts.trace.data['url.scheme'], 'https:');
  assert.equal(tx[0].transaction, 'POST /api/sessions/[Filtered]/map');
  assert.equal(fake.items.some((x) => x.header.type === 'span'), false, 'no streamed spans past the scrubber');
  assertClean(fake.items);
});

test('a caught failure and a 5xx answer are reported; a 4xx is not', async () => {
  const fake = fakeTransport();
  const worker = withTelemetry(
    {
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === '/caught') {
          logError('api error', new RangeError('D1 went away'));
          return new Response('Internal error.', { status: 500 });
        }
        const err = path === '/busy' ? new HttpError(503, 'unavailable', 'Discord sign-in is not configured on this server.') : new HttpError(404, 'not_found', 'No such API endpoint.');
        reportHttpError(err);
        return new Response(err.message, { status: err.status });
      },
    },
    { transport: fake.transport },
  );
  const errors = console.error;
  console.error = () => {};
  try {
    for (const path of ['/caught', '/busy', '/missing']) {
      const ctx = execContext();
      const r = await worker.fetch(new Request(`https://webra.sherin.dev${path}`, { headers: { Cookie: 'a=s3ssion-secret' } }), { SENTRY_DSN: DSN, SENTRY_TRACES_SAMPLE_RATE: '0' }, ctx);
      await r.text();
      await Promise.all(ctx.waits);
    }
  } finally {
    console.error = errors;
  }
  const events = fake.events();
  assert.equal(events.length, 2);
  assert.equal(events[0].exception.values[0].type, 'RangeError');
  assert.equal(events[0].tags.where, 'api error');
  assert.equal(events[0].level, 'error');
  assert.equal(events[1].exception.values[0].value, 'Discord sign-in is not configured on this server.');
  assert.equal(events[1].level, 'warning');
  assert.deepEqual([events[1].tags.status, events[1].tags.code], ['503', 'unavailable']);
  assertClean(fake.items);
});

test('scheduled: a failing run is reported and still fails', async () => {
  const fake = fakeTransport();
  const worker = withTelemetry(
    {
      fetch: () => new Response('ok'),
      async scheduled() {
        throw new Error('retention failed');
      },
    },
    { transport: fake.transport },
  );
  const ctx = execContext();
  await assert.rejects(worker.scheduled({ cron: '17 3 * * *', scheduledTime: Date.now() }, { SENTRY_DSN: DSN, SENTRY_TRACES_SAMPLE_RATE: '0' }, ctx), /retention failed/);
  await Promise.all(ctx.waits);
  assert.equal(fake.events()[0].exception.values[0].value, 'retention failed');
});

test('without SENTRY_DSN nothing is wrapped and nothing is sent', async () => {
  const fake = fakeTransport();
  const calls = [];
  const handler = {
    async fetch(request, env, ctx) {
      calls.push(ctx);
      logError('api error', new Error('quiet'));
      throw new Error('plain');
    },
  };
  const worker = withTelemetry(handler, { transport: fake.transport });
  const ctx = execContext();
  const errors = console.error;
  console.error = () => {};
  try {
    for (const env of [{}, { SENTRY_DSN: '' }, { SENTRY_DSN: '  ' }]) await assert.rejects(worker.fetch(secretRequest(), env, ctx), /plain/);
  } finally {
    console.error = errors;
  }
  await Promise.all(ctx.waits);
  assert.equal(calls.length, 3);
  assert.ok(calls.every((c) => c === ctx), 'the handler gets the original context, not an instrumented one');
  assert.equal(fake.items.length, 0);
  assert.equal(dsnOf({ SENTRY_DSN: ` ${DSN} ` }), DSN);
});

test('the Durable Object: the plain class without a DSN, an instrumented instance with one', () => {
  class Base {
    constructor(ctx, env) {
      this.ctx = ctx;
      this.env = env;
    }

    ping() {
      return 'pong';
    }
  }
  const Session = instrumentSession(Base);
  const plain = new Session({ storage: {}, waitUntil() {} }, {});
  assert.ok(plain instanceof Base);
  assert.equal(plain.ping(), 'pong');
  const instrumented = new Session({ storage: {}, waitUntil() {}, id: { toString: () => 'x' } }, { SENTRY_DSN: DSN });
  assert.equal(instrumented.ping(), 'pong');
  assert.equal(instrumented.env.SENTRY_DSN, DSN);
});

test('options: nothing collected by the SDK, release and environment from the variables, a bounded sample rate', () => {
  const o = sentryOptions({ SENTRY_DSN: DSN, SENTRY_RELEASE: 'webra@1.0.0+00000000', SENTRY_ENVIRONMENT: 'production', SENTRY_TRACES_SAMPLE_RATE: '0.2' });
  assert.equal(o.dsn, DSN);
  assert.equal(o.release, 'webra@1.0.0+00000000');
  assert.equal(o.tracesSampleRate, 0.2);
  assert.equal(o.dataCollection, DATA_COLLECTION);
  assert.equal(o.dataCollection.cookies, false);
  assert.equal(o.dataCollection.httpHeaders, false);
  assert.deepEqual(o.dataCollection.httpBodies, []);
  assert.equal(o.dataCollection.urlQueryParams, false);
  assert.equal(o.dataCollection.userInfo, false);
  assert.equal(sentryOptions({ SENTRY_TRACES_SAMPLE_RATE: '7' }).tracesSampleRate, 0.05);
  assert.equal(sentryOptions({}).dsn, '');
});

test('wrangler.jsonc: reports off by default (wrangler dev), the DSN is a variable set at deploy, never a secret', () => {
  const config = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, ''));
  assert.equal(config.vars.SENTRY_DSN, '');
  assert.equal(config.vars.SENTRY_ENVIRONMENT, 'dev');
  assert.ok(config.compatibility_flags.includes('nodejs_als'), 'the SDK keeps request scopes in AsyncLocalStorage');
  const deploy = readFileSync(new URL('../../../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  assert.match(deploy, /node \.\.\/\.\.\/tools\/sentry-config\.mjs worker-vars/);
  assert.match(deploy, /if \[ -z "\$SENTRY_AUTH_TOKEN" \]/);
});
