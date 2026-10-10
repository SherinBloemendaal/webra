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
  DEFAULT_SENTRY_DSN,
  DEFAULT_TRACES_SAMPLE_RATE,
  releaseName,
  sentryBuildConfig,
  workerVarArgs,
} from './sentry-config.mjs';
import { buildSentryBundle, SDK_EXPORTS, sdkVersion } from './vendor-sentry.mjs';

const OTHER = 'https://0123456789abcdef0123456789abcdef@errors.example.org/7';

test('production builds report to the default DSN, other builds only when SENTRY_DSN is set', () => {
  assert.deepEqual(sentryBuildConfig({ WEBRA_ENV: 'production' }), {
    dsn: DEFAULT_SENTRY_DSN,
    origin: 'https://sentry.vitrion.dev',
    environment: 'production',
    tracesSampleRate: DEFAULT_TRACES_SAMPLE_RATE,
  });
  // An unset GitHub variable arrives as an empty string.
  assert.equal(sentryBuildConfig({ WEBRA_ENV: 'production', SENTRY_DSN: '', SENTRY_ENVIRONMENT: '', SENTRY_TRACES_SAMPLE_RATE: '' }).dsn, DEFAULT_SENTRY_DSN);
  assert.deepEqual(sentryBuildConfig({}), { dsn: '', origin: null, environment: 'dev', tracesSampleRate: DEFAULT_TRACES_SAMPLE_RATE });
  assert.deepEqual(sentryBuildConfig({ SENTRY_DSN: OTHER, SENTRY_ENVIRONMENT: 'staging', SENTRY_TRACES_SAMPLE_RATE: '0' }), { dsn: OTHER, origin: 'https://errors.example.org', environment: 'staging', tracesSampleRate: 0 });
  assert.equal(sentryBuildConfig({ WEBRA_ENV: 'production', SENTRY_DSN: 'off' }).dsn, '');
  assert.throws(() => sentryBuildConfig({ SENTRY_DSN: 'http://key@host/1' }), /not a Sentry DSN/);
  assert.throws(() => sentryBuildConfig({ SENTRY_TRACES_SAMPLE_RATE: '2' }), /0 to 1/);
  assert.throws(() => sentryBuildConfig({ SENTRY_TRACES_SAMPLE_RATE: 'lots' }), /0 to 1/);
  assert.throws(() => sentryBuildConfig({ SENTRY_ENVIRONMENT: 'a b' }), /SENTRY_ENVIRONMENT/);
});

test('the client config module and the Worker variables carry the same settings and release', async () => {
  const config = sentryBuildConfig({ WEBRA_ENV: 'production' });
  const release = releaseName('0.9.0+abcdef12');
  assert.equal(release, 'webra@0.9.0+abcdef12');
  const text = clientConfigModule(config, release);
  const mod = await import(`data:text/javascript,${encodeURIComponent(text)}`);
  assert.deepEqual(mod.TELEMETRY_CONFIG, { dsn: DEFAULT_SENTRY_DSN, environment: 'production', release, tracesSampleRate: 0.05 });
  assert.ok(Object.isFrozen(mod.TELEMETRY_CONFIG));
  const off = await import(`data:text/javascript,${encodeURIComponent(clientConfigModule(sentryBuildConfig({}), release))}`);
  assert.deepEqual(off.TELEMETRY_CONFIG, { dsn: '', environment: 'dev', release: '', tracesSampleRate: 0 });
  assert.deepEqual(workerVarArgs(config, release), [
    '--var',
    `SENTRY_DSN:${DEFAULT_SENTRY_DSN}`,
    '--var',
    'SENTRY_ENVIRONMENT:production',
    '--var',
    `SENTRY_RELEASE:${release}`,
    '--var',
    'SENTRY_TRACES_SAMPLE_RATE:0.05',
  ]);
  // The repository copy of the client config has no DSN.
  const repo = await import('../apps/game/js/telemetry/config.js');
  assert.equal(repo.TELEMETRY_CONFIG.dsn, '');
});

test('the default DSN host is in the CSP connect-src of the site and the game', () => {
  const headers = readFileSync(new URL('../apps/website/_headers', import.meta.url), 'utf8');
  assert.ok(connectSources(headers).includes(sentryBuildConfig({ WEBRA_ENV: 'production' }).origin));
  assert.deepEqual(connectSources('nothing here'), []);
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
