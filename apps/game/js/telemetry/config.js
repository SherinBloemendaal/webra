// Error report settings of this build (docs/security.md, "Error reports").
// tools/build-dist.mjs writes this file into dist/ with the values of the
// build (tools/sentry-config.mjs: SENTRY_DSN, SENTRY_ENVIRONMENT,
// SENTRY_TRACES_SAMPLE_RATE, the release `webra@<version>+<commit>`). The
// copy in the repository has no DSN: tests and plain local serving of
// apps/game send nothing.
export const TELEMETRY_CONFIG = Object.freeze({
  dsn: '',
  environment: 'dev',
  release: '',
  tracesSampleRate: 0,
});
