// Who may play online, upload maps and use the content relay
// (docs/accounts-api.md, section 7).

import { maskToFlags } from '@webra/protocol';
import { HttpError } from '../http.js';
import { inactiveError, ipBannedError } from './context.js';
import { effectiveStatus } from './users.js';

/** Header the Worker sets on WebSocket upgrades it forwards to a session (clients cannot set it). */
export const AUTH_HEADER = 'X-WebRA-Auth';

/**
 * The verdict for online play: { account: { id, username } | null, refuse:
 * { code, message, error } | null } (code as sent over the WebSocket, error
 * as answered over HTTP). An active account always plays under
 * its username; without one, play is refused when the site requires
 * accounts.
 */
export async function playVerdict(ctx) {
  const refuse = (error, code = error.code) => ({ account: null, refuse: { code, message: error.message, error } });
  if (await ctx.ipBan()) return refuse(ipBannedError());
  const eff = await ctx.eff();
  const { user } = await ctx.auth();
  if (user) {
    const status = effectiveStatus(user);
    if (status === 'active') return { account: { id: user.id, username: user.username }, refuse: null };
    if (eff.onlineRequiresAccount) return refuse(inactiveError(status));
    return { account: null, refuse: null };
  }
  if (eff.onlineRequiresAccount) return refuse(new HttpError(401, 'unauthenticated', 'Sign in to play online.'), 'account_required');
  return { account: null, refuse: null };
}

/** For HTTP routes (session creation, map uploads): the account or null, or throws. */
export async function requirePlay(ctx) {
  const v = await playVerdict(ctx);
  if (v.refuse) throw v.refuse.error;
  return v.account;
}

/** The content relay: an active account with the flag (or admin), the relay switched on. */
export async function requireRelay(ctx) {
  if (await ctx.ipBan()) throw ipBannedError();
  const user = await ctx.requireUser({ active: true });
  const eff = await ctx.eff();
  const allowed = eff.contentRelay && (user.role === 'admin' || maskToFlags(user.flags).includes('content_autoinstall'));
  if (!allowed) {
    throw new HttpError(403, 'relay_forbidden', 'The one-click install is not enabled for your account. Ask an admin, or install the files from your own copy.');
  }
  return user;
}
