// Error report configuration of a build (docs/deploy.md and docs/security.md,
// "Error reports"), from the environment:
//
//   SENTRY_DSN                 the project's DSN (public client key). Unset or
//                              empty: the default below in production builds
//                              (WEBRA_ENV=production, set by the deploy
//                              workflow), none otherwise. "off": none.
//   SENTRY_ENVIRONMENT         default "production" in production builds, else "dev"
//   SENTRY_TRACES_SAMPLE_RATE  share of page loads and requests traced, 0 to 1 (default 0.05)
//
// tools/build-dist.mjs writes it into the client (js/telemetry/config.js);
// the deploy workflow passes it to the Worker as variables:
//
//   node tools/sentry-config.mjs worker-vars   # --var SENTRY_DSN:... for wrangler deploy
//   node tools/sentry-config.mjs release       # webra@<version>+<commit> of dist/version.json
//   node tools/sentry-config.mjs environment   # the Sentry environment
//
// Without a DSN nothing is reported: tests and local builds send nothing.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_SENTRY_DSN = 'https://<public key>@sentry.vitrion.dev/121';
export const DEFAULT_TRACES_SAMPLE_RATE = 0.05;
/** A Sentry DSN: https, a 32 hex public key, a host and a numeric project id. */
const DSN_RE = /^https:\/\/[0-9a-f]{32}@([a-z0-9.-]+(?::\d{1,5})?)\/\d+$/;

/** The release name for a build id (dist/version.json `build`): `webra@<version>+<commit>`. */
export const releaseName = (build) => `webra@${build}`;

/**
 * The configuration for this environment. Throws on a malformed DSN or
 * sample rate. `origin` is the DSN's origin (for the CSP), or null.
 * @returns {{ dsn: string, origin: string | null, environment: string, tracesSampleRate: number }}
 */
export function sentryBuildConfig(env = process.env) {
  const production = env.WEBRA_ENV === 'production';
  const raw = (env.SENTRY_DSN ?? '').trim();
  const dsn = raw === 'off' ? '' : raw || (production ? DEFAULT_SENTRY_DSN : '');
  const m = dsn ? DSN_RE.exec(dsn) : null;
  if (dsn && !m) throw new Error('SENTRY_DSN is not a Sentry DSN (https://<32 hex key>@<host>/<project id>)');
  const rateRaw = (env.SENTRY_TRACES_SAMPLE_RATE ?? '').trim();
  const tracesSampleRate = rateRaw === '' ? DEFAULT_TRACES_SAMPLE_RATE : Number(rateRaw);
  if (!Number.isFinite(tracesSampleRate) || tracesSampleRate < 0 || tracesSampleRate > 1) {
    throw new Error('SENTRY_TRACES_SAMPLE_RATE must be a number from 0 to 1');
  }
  const environment = (env.SENTRY_ENVIRONMENT ?? '').trim() || (production ? 'production' : 'dev');
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(environment)) throw new Error('SENTRY_ENVIRONMENT must be 1 to 64 letters, digits, "_", "." or "-"');
  return { dsn, origin: m ? `https://${m[1]}` : null, environment, tracesSampleRate };
}

/** The client's js/telemetry/config.js for a configuration and release. */
export function clientConfigModule({ dsn, environment, tracesSampleRate }, release) {
  const config = { dsn, environment, release: dsn ? release : '', tracesSampleRate: dsn ? tracesSampleRate : 0 };
  return (
    '// Error report settings of this build, written by tools/build-dist.mjs\n' +
    '// (tools/sentry-config.mjs; docs/security.md, "Error reports").\n' +
    `export const TELEMETRY_CONFIG = Object.freeze(${JSON.stringify(config, null, 2)});\n`
  );
}

/**
 * The Content-Security-Policy `connect-src` sources of apps/website/_headers
 * (the `/*` rule), to check that the DSN's host may be reached.
 */
export function connectSources(headersText) {
  const m = /Content-Security-Policy:[^\n]*?connect-src ([^;\n]+)/.exec(headersText);
  return m ? m[1].trim().split(/\s+/) : [];
}

/** wrangler deploy arguments that set the Worker's variables (apps/server/src/telemetry.js). */
export function workerVarArgs({ dsn, environment, tracesSampleRate }, release) {
  return ['--var', `SENTRY_DSN:${dsn}`, '--var', `SENTRY_ENVIRONMENT:${environment}`, '--var', `SENTRY_RELEASE:${release}`, '--var', `SENTRY_TRACES_SAMPLE_RATE:${tracesSampleRate}`];
}

function main(argv) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const release = () => releaseName(JSON.parse(readFileSync(join(root, 'dist/version.json'), 'utf8')).build);
  const [command] = argv;
  if (command === 'release') return release();
  if (command === 'worker-vars') return workerVarArgs(sentryBuildConfig(), release()).join(' ');
  if (command === 'environment') return sentryBuildConfig().environment;
  throw new Error('usage: node tools/sentry-config.mjs release | worker-vars | environment');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    console.log(main(process.argv.slice(2)));
  } catch (err) {
    console.error(`sentry-config: ${err.message}`);
    process.exit(1);
  }
}
