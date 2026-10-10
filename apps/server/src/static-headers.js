// The security headers of apps/website/_headers, for responses the Worker
// makes itself on static paths (the play gate in playgate.js: game files,
// redirects and refusals). Workers Static Assets applies _headers only to
// the responses it serves directly, so the Worker sets them again; a test
// (test/playgate.test.mjs) keeps this copy equal to the file.

/** Headers of the `/*` rule. */
export const SITE_HEADERS = Object.freeze({
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' wss://webra.sherin.dev https://sentry.vitrion.dev; worker-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
});

/** Headers of the `/play` and `/play/*` rules (the game is cross-origin isolated). */
export const PLAY_HEADERS = Object.freeze({
  'Cross-Origin-Embedder-Policy': 'require-corp',
});

/**
 * Set the static security headers for a game path on `headers`, plus
 * Cross-Origin-Resource-Policy: game files are for this origin only.
 */
export function applyPlayHeaders(headers) {
  for (const [k, v] of Object.entries(SITE_HEADERS)) headers.set(k, v);
  for (const [k, v] of Object.entries(PLAY_HEADERS)) headers.set(k, v);
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  return headers;
}
