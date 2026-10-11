// Account and admin API entry: routes, the request context and CSRF rules
// for /api/site, /api/auth/*, /api/account/*, /api/admin/* and /api/dev/*.

import { checkCsrf } from '../http.js';
import { RequestContext } from './context.js';
import { registerAccountRoutes } from './routes-account.js';
import { registerAdminRoutes } from './routes-admin.js';
import { registerAuthRoutes } from './routes-auth.js';
import { registerDevRoutes, withDevMail } from './dev.js';
import { registerDiscordRoutes } from './routes-discord.js';
import { Router } from './router.js';

export { RequestContext } from './context.js';
export { scheduled, runRetention } from './cron.js';
export { playVerdict, requirePlay, requireRelay, AUTH_HEADER } from './play.js';

const router = new Router();
registerAuthRoutes(router);
registerDiscordRoutes(router);
registerAccountRoutes(router);
registerAdminRoutes(router);
registerDevRoutes(router);

/** Whether a GET to this path skips the origin checks (the Discord callback navigation). */
export function isNavigationRoute(method, path) {
  try {
    return Boolean(router.match(method, path)?.options.navigation);
  } catch {
    return false;
  }
}

/**
 * Handle an account API request; returns a Response or null for unknown
 * paths. The caller already applied the CSRF rules for state-changing
 * requests; reads of account and admin data also need the CSRF header.
 */
export async function handleAccountApi(ctx) {
  const m = router.match(ctx.request.method, ctx.url.pathname);
  if (!m) return null;
  if (m.options.csrfRead) checkCsrf(ctx.request, { requireOrigin: false });
  return ctx.respond(await m.handler(ctx, m.params));
}

export function newContext(request, env, exec, now) {
  return new RequestContext(request, withDevMail(request, env), exec, now);
}
