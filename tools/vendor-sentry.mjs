// The browser SDK for error reports (@sentry/browser, MIT), bundled into one
// ES module with its source map for dist/ (tools/build-dist.mjs): the game
// and the website load it from their own origin, never from a CDN
// (apps/game/js/telemetry/index.js). Only what js/telemetry uses is
// exported, so session replay and user feedback are not in the bundle.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** What js/telemetry/index.js calls on the SDK. */
export const SDK_EXPORTS = Object.freeze(['init', 'captureException', 'captureMessage', 'setTags', 'browserTracingIntegration', 'makeFetchTransport', 'withStaticSpan']);

/** The installed @sentry/browser version (package-lock pins it). */
export function sdkVersion() {
  const require = createRequire(join(root, 'apps/game/package.json'));
  return JSON.parse(readFileSync(require.resolve('@sentry/browser/package.json'), 'utf8')).version;
}

/**
 * Write the bundle to `outfile` (and `outfile`.map). Returns its size in bytes.
 * @param {string} outfile
 */
export async function buildSentryBundle(outfile) {
  const version = sdkVersion();
  const result = await build({
    stdin: { contents: `export { ${SDK_EXPORTS.join(', ')} } from '@sentry/browser';`, resolveDir: join(root, 'apps/game'), loader: 'js', sourcefile: 'sentry-entry.js' },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    // The map names the SDK's files and lines for stack traces; their text
    // stays out (it would make the map eight times larger).
    sourcemap: true,
    sourcesContent: false,
    // The SDK's own debug logging is left out (it is off in production anyway).
    define: { __SENTRY_DEBUG__: 'false' },
    banner: { js: `/*! @sentry/browser ${version} | MIT License | https://github.com/getsentry/sentry-javascript */` },
    outfile,
    metafile: true,
    logLevel: 'warning',
  });
  return Object.values(result.metafile.outputs).reduce((n, o) => n + o.bytes, 0);
}
