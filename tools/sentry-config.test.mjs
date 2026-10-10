// Error report configuration of builds (tools/sentry-config.mjs) and the
// vendored browser SDK (tools/vendor-sentry.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clientConfigModule,
  connectSources,
  DEFAULT_TRACES_SAMPLE_RATE,
  privacySections,
  releaseName,
  sentryBuildConfig,
  workerVarArgs,
} from './sentry-config.mjs';
import { buildSentryBundle, SDK_EXPORTS, sdkVersion } from './vendor-sentry.mjs';

const OTHER = 'https://0123456789abcdef0123456789abcdef@errors.example.org/7';
/** A DSN of the operator's host (made-up key: the real DSN is only in docs/deploy.md). */
const OPERATOR = 'https://0123456789abcdef0123456789abcdef@sentry.vitrion.dev/121';

test('reports are opt-in: no build has a DSN unless SENTRY_DSN is set, production builds included', () => {
  assert.deepEqual(sentryBuildConfig({ WEBRA_ENV: 'production' }), { dsn: '', origin: null, environment: 'production', tracesSampleRate: DEFAULT_TRACES_SAMPLE_RATE });
  // An unset GitHub variable arrives as an empty string.
  assert.equal(sentryBuildConfig({ WEBRA_ENV: 'production', SENTRY_DSN: '', SENTRY_ENVIRONMENT: '', SENTRY_TRACES_SAMPLE_RATE: '' }).dsn, '');
  assert.deepEqual(sentryBuildConfig({ WEBRA_ENV: 'production', SENTRY_DSN: OPERATOR }), {
    dsn: OPERATOR,
    origin: 'https://sentry.vitrion.dev',
    environment: 'production',
    tracesSampleRate: DEFAULT_TRACES_SAMPLE_RATE,
  });
  // No DSN is built in anywhere in the code.
  for (const file of ['./sentry-config.mjs', './build-dist.mjs', '../apps/game/js/telemetry/config.js', '../apps/server/wrangler.jsonc', '../.github/workflows/deploy.yml']) {
    assert.doesNotMatch(readFileSync(new URL(file, import.meta.url), 'utf8'), /https:\/\/[0-9a-f]{32}@/, file);
  }
  assert.deepEqual(sentryBuildConfig({}), { dsn: '', origin: null, environment: 'dev', tracesSampleRate: DEFAULT_TRACES_SAMPLE_RATE });
  assert.deepEqual(sentryBuildConfig({ SENTRY_DSN: OTHER, SENTRY_ENVIRONMENT: 'staging', SENTRY_TRACES_SAMPLE_RATE: '0' }), { dsn: OTHER, origin: 'https://errors.example.org', environment: 'staging', tracesSampleRate: 0 });
  assert.equal(sentryBuildConfig({ WEBRA_ENV: 'production', SENTRY_DSN: 'off' }).dsn, '');
  assert.throws(() => sentryBuildConfig({ SENTRY_DSN: 'http://key@host/1' }), /not a Sentry DSN/);
  assert.throws(() => sentryBuildConfig({ SENTRY_TRACES_SAMPLE_RATE: '2' }), /0 to 1/);
  assert.throws(() => sentryBuildConfig({ SENTRY_TRACES_SAMPLE_RATE: 'lots' }), /0 to 1/);
  assert.throws(() => sentryBuildConfig({ SENTRY_ENVIRONMENT: 'a b' }), /SENTRY_ENVIRONMENT/);
});

test('the client config module and the Worker variables carry the same settings and release', async () => {
  const config = sentryBuildConfig({ WEBRA_ENV: 'production', SENTRY_DSN: OPERATOR });
  const release = releaseName('0.9.0+abcdef12');
  assert.equal(release, 'webra@0.9.0+abcdef12');
  const text = clientConfigModule(config, release);
  const mod = await import(`data:text/javascript,${encodeURIComponent(text)}`);
  assert.deepEqual(mod.TELEMETRY_CONFIG, { dsn: OPERATOR, environment: 'production', release, tracesSampleRate: 0.05 });
  assert.ok(Object.isFrozen(mod.TELEMETRY_CONFIG));
  const off = await import(`data:text/javascript,${encodeURIComponent(clientConfigModule(sentryBuildConfig({}), release))}`);
  assert.deepEqual(off.TELEMETRY_CONFIG, { dsn: '', environment: 'dev', release: '', tracesSampleRate: 0 });
  assert.deepEqual(workerVarArgs(config, release), [
    '--var',
    `SENTRY_DSN:${OPERATOR}`,
    '--var',
    'SENTRY_ENVIRONMENT:production',
    '--var',
    `SENTRY_RELEASE:${release}`,
    '--var',
    'SENTRY_TRACES_SAMPLE_RATE:0.05',
  ]);
  // Without a DSN the Worker gets an empty one (its wrapper does nothing).
  assert.equal(workerVarArgs(sentryBuildConfig({ WEBRA_ENV: 'production' }), release)[1], 'SENTRY_DSN:');
  // The repository copy of the client config has no DSN.
  const repo = await import('../apps/game/js/telemetry/config.js');
  assert.equal(repo.TELEMETRY_CONFIG.dsn, '');
});

test('the operator\'s Sentry host is in the CSP connect-src of the site and the game', () => {
  const headers = readFileSync(new URL('../apps/website/_headers', import.meta.url), 'utf8');
  assert.ok(connectSources(headers).includes(sentryBuildConfig({ SENTRY_DSN: OPERATOR }).origin));
  assert.deepEqual(connectSources('nothing here'), []);
});

test('the privacy notice says reporting is off without a DSN, and describes it with one', () => {
  const html = readFileSync(new URL('../apps/website/privacy.html', import.meta.url), 'utf8');
  const off = privacySections(html, false);
  const on = privacySections(html, true);
  for (const page of [off, on]) assert.doesNotMatch(page, /error-reports:(on|off)/);
  assert.match(off, /Error reporting is currently off/);
  assert.doesNotMatch(off, /sentry\.vitrion\.dev|error-reports-switch|A report holds/);
  assert.match(on, /A report holds/);
  assert.match(on, /id="error-reports-switch"/);
  assert.doesNotMatch(on, /Error reporting is currently off/);
  // Both keep the heading the game and README link to.
  for (const page of [off, on]) assert.match(page, /<h2 id="error-reports">Error reports<\/h2>/);
  assert.throws(() => privacySections('<p>no sections</p>', true), /needs exactly one/);
  assert.throws(() => privacySections(`${html}<!-- error-reports:on -->x<!-- /error-reports:on -->`, true), /needs exactly one/);
});

test('the vendored SDK is one ES module exporting what js/telemetry uses, with a source map and its license', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'webra-sentry-'));
  try {
    const out = join(dir, 'vendor/sentry.js');
    const bytes = await buildSentryBundle(out);
    const code = readFileSync(out, 'utf8');
    assert.ok(bytes > code.length, 'the size counts the source map too');
    assert.ok(code.startsWith(`/*! @sentry/browser ${sdkVersion()} | MIT License`));
    assert.match(code, /\/\/# sourceMappingURL=sentry\.js\.map\s*$/);
    const map = JSON.parse(readFileSync(`${out}.map`, 'utf8'));
    assert.ok(map.sources.some((s) => s.includes('@sentry/core')));
    // No bare imports left (browsers could not resolve them), and the exports js/telemetry calls.
    assert.doesNotMatch(code, /\bimport\s*[^(]*from\s*["']/);
    const exported = /export\{([^}]*)\}/.exec(code)[1].split(',').map((e) => e.trim().split(/\s+as\s+/)[1]);
    assert.deepEqual(exported.sort(), [...SDK_EXPORTS].sort());
    // Session replay and user feedback are not in it.
    assert.deepEqual(map.sources.filter((s) => /@sentry\/(replay|replay-canvas|feedback)\//.test(s)), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
