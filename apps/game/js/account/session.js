// The signed-in account of this page (the game, the account page, the admin
// page): who is signed in, what the site allows (GET /api/site), and the
// settings sync while someone is signed in. Listeners hear every change.

import { AccountApi } from './api.js';
import { SettingsSync } from './sync.js';

/**
 * What a player can do now, from the account status (docs/accounts-api.md
 * 2.2). `site` (GET /api/site) tells whether the game itself needs an
 * account (`gameRequiresAccount`, on unless the site says otherwise).
 */
export function accountState(user, site = null) {
  const gated = site?.gameRequiresAccount !== false;
  if (!user) {
    return {
      kind: 'signed-out',
      label: 'Not signed in',
      text: gated ? 'Sign in to play, and keep your settings on every device.' : 'Sign in to play online and keep your settings on every device.',
    };
  }
  switch (user.status) {
    case 'active':
      return { kind: 'active', label: 'Signed in', text: '' };
    case 'pending_email':
      return {
        kind: 'pending_email',
        label: 'Verify your email',
        text: gated ? 'Follow the link in the email we sent to activate your account. The game opens once it is active.' : 'Follow the link in the email we sent to activate your account.',
      };
    case 'pending_approval':
      return {
        kind: 'pending_approval',
        label: 'Waiting for approval',
        text: gated
          ? 'WebRA is in a closed beta: an admin will approve your account soon. The game opens for you once it is approved.'
          : 'WebRA is in a closed beta: an admin will approve your account soon. Until then you can play skirmish and change your settings.',
      };
    case 'banned':
      return {
        kind: 'banned',
        label: 'Banned',
        text: `${user.ban?.reason ? `This account is banned. Reason: ${user.ban.reason}` : 'This account is banned.'}${gated ? ' You cannot play while the ban lasts.' : ''}`,
      };
    default:
      return { kind: user.status, label: 'Inactive', text: 'This account cannot be used.' };
  }
}

/**
 * Sign-in methods to offer: on in the site settings and available (the
 * server reports unconfigured ones as off), and passkeys only where the
 * browser has them.
 */
export function signInMethods(site, { passkeys = true } = {}) {
  const login = site?.login ?? { password: true };
  return {
    password: login.password !== false,
    passkey: !!login.passkey && passkeys,
    discord: !!login.discord,
    email: !!login.email,
    signup: site ? site.registration?.open !== false : true,
  };
}

export class AccountSession {
  /**
   * @param {object} o
   * @param {AccountApi} [o.api]
   * @param {object} [o.registry] the settings registry; with it the settings sync runs while signed in
   * @param {Storage | null} [o.storage] for the sync state
   * @param {Function} [o.onConflict] see SettingsSync
   * @param {object} [o.win] for the sync's 'online' event
   */
  constructor({ api = new AccountApi(), registry = null, storage = null, onConflict, win = null } = {}) {
    this.api = api;
    this.site = null;
    this.user = null;
    this.session = null;
    this.ready = false;
    this.listeners = new Set();
    this.signOutListeners = new Set();
    this.syncStatus = { status: 'idle', detail: '' };
    this.sync = registry
      ? new SettingsSync({
          api,
          registry,
          storage,
          onConflict,
          win,
          onStatus: (status, detail = '') => {
            this.syncStatus = { status, detail };
            this.changed();
          },
        })
      : null;
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  changed() {
    for (const fn of [...this.listeners]) {
      try {
        fn(this);
      } catch (err) {
        console.warn('account listener failed:', err);
      }
    }
  }

  get signedIn() {
    return !!this.user;
  }

  get canPlayOnline() {
    if (this.user) return !!this.user.canPlayOnline;
    return this.site ? !this.site.onlineRequiresAccount : true;
  }

  /** Load the site settings and who is signed in. Never rejects (`error` says why). */
  async refresh() {
    this.error = null;
    const [site, me] = await Promise.allSettled([this.api.site(), this.api.me()]);
    if (site.status === 'fulfilled') this.site = site.value;
    if (me.status === 'fulfilled') await this.setUser(me.value.user ?? null, me.value.session ?? null);
    else this.error = me.reason;
    this.ready = true;
    this.changed();
    return this;
  }

  /** After a sign-in (or an answer with `{ user }`): start or stop the settings sync. */
  async setUser(user, session = null) {
    const before = this.user?.id ?? null;
    this.user = user;
    this.session = session;
    this.changed();
    if (!this.sync) return;
    if (!user || user.status === 'banned' || user.status === 'deleted') {
      if (before) this.sync.stop();
      return;
    }
    if (user.id !== before) await this.sync.start(user).catch((err) => console.warn('settings sync failed:', err));
  }

  /** `fn(userId)` runs when the player signs out here (not when a session ends by itself). */
  onSignOut(fn) {
    this.signOutListeners.add(fn);
    return () => this.signOutListeners.delete(fn);
  }

  async signOut() {
    const userId = this.user?.id ?? null;
    try {
      await this.api.logout();
    } finally {
      if (userId) {
        for (const fn of [...this.signOutListeners]) {
          try {
            await fn(userId);
          } catch (err) {
            console.warn('sign-out listener failed:', err);
          }
        }
      }
      await this.setUser(null);
    }
  }
}
