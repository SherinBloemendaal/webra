// Account UI in the game: the account entry on the start screen (sign in,
// who is signed in, the account state, settings sync, message of the day),
// the sign-in dialog (password, passkey, Discord; sign up and the rest on
// the account page /account/), and the settings conflict choice.
//
// Text from the server only goes in with textContent.

import { errorText } from './api.js';
import { accountState, signInMethods } from './session.js';
import { getPasskey, isCancel, passkeysAvailable } from './passkey.js';
import { probePlayAccess } from './gate.js';
import { led } from '../ui/controls.js';
import { GROUPS } from '../registry.js';
import { ACCOUNT_PASSWORD_MAX, EMAIL_MAX } from '../../protocol/accounts.js';

/** The account page (sign up, verify, reset, profile, passkeys, sessions, data). */
export const ACCOUNT_URL = '/account/';

export function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (v === true) e.setAttribute(k, '');
    else if (v !== false && v !== null && v !== undefined) e.setAttribute(k, v);
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) e.append(c);
  return e;
}

let uid = 0;

/** The emblem (brand/favicon.svg, the mark without its plate) next to a dialog title. */
const EMBLEM_URL = new URL('../../brand/favicon.svg', import.meta.url).href;

/**
 * A modal dialog on the theme (menu-card with a hazard stripe): `build(body,
 * close)` fills it; resolves with what close() got (Escape and the backdrop
 * give null). Keys typed in it do not reach the game; focus comes back to
 * where it was. `emblem`: the WebRA emblem before the title (sign-in).
 * `lamp`: a lamp state (LED_STATES) before the title, for a dialog about a
 * state (its title says the state in words).
 */
export function modal(title, build, { className = '', emblem = false, lamp = null } = {}) {
  return new Promise((resolve) => {
    const id = `account-dialog-${++uid}`;
    const body = el('div', { class: 'account-dialog-body' });
    const closeButton = el('button', { type: 'button', class: 'audio-close', 'aria-label': 'Close', text: 'Close' });
    const heading = el('h1', { id }, emblem ? el('img', { class: 'account-emblem', src: EMBLEM_URL, alt: '', width: '34', height: '34' }) : null, lamp ? led(lamp) : null, el('span', { class: 'account-title-text', text: title }));
    const card = el(
      'div',
      { class: `menu-card account-dialog ${className}`.trim(), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': id },
      el('div', { class: 'audio-head' }, heading, closeButton),
      body,
    );
    const overlay = el('section', { class: 'account-overlay' }, card);
    const opener = document.activeElement;
    let done = false;
    const close = (value = null) => {
      if (done) return;
      done = true;
      overlay.remove();
      if (opener && typeof opener.focus === 'function' && opener.isConnected) opener.focus();
      resolve(value);
    };
    closeButton.addEventListener('click', () => close(null));
    overlay.addEventListener('pointerdown', (e) => {
      if (e.target === overlay) close(null);
    });
    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') close(null);
      e.stopPropagation();
    });
    build(body, close);
    document.body.append(overlay);
    (body.querySelector('input, button') ?? closeButton).focus();
  });
}

/**
 * The sign-in dialog (SignIn board): a passkey first where the site and the
 * browser offer it, then the password form, Discord next to its button,
 * "Forgot your password?" when the site sends email. With a `reason` (the
 * sign-in ended while playing) it is titled "Sign in again" and says what
 * keeps running. Resolves with the signed-in user, or null.
 * @param {import('./session.js').AccountSession} session
 * @param {{ reason?: string, returnTo?: string, navigate?: (url: string) => void }} [o]
 */
export function openSignIn(session, { reason = '', returnTo = '/play/', navigate = (url) => globalThis.location.assign(url) } = {}) {
  const methods = signInMethods(session.site, { passkeys: passkeysAvailable() });
  return modal(
    reason ? 'Sign in again' : 'Sign in',
    (body, close) => {
      const error = el('p', { class: 'account-error', role: 'alert', hidden: true });
      const showError = (err) => {
        error.textContent = typeof err === 'string' ? err : errorText(err);
        error.hidden = false;
      };
      const done = async (res) => {
        await session.setUser(res.user ?? null);
        close(res.user ?? null);
      };
      if (reason) body.append(el('p', { class: 'account-reason', text: reason }));
      if (session.site?.motd) body.append(el('p', { class: 'account-motd', text: session.site.motd }));
      body.append(error);

      // The passkey is the main way when it is offered (no password typed).
      if (methods.passkey) {
        const b = el('button', { type: 'button', class: 'primary account-passkey', text: 'Sign in with a passkey' });
        b.addEventListener('click', async () => {
          b.disabled = true;
          try {
            const options = await session.api.passkeyOptions();
            const { challengeId, credential } = await getPasskey(options);
            await done(await session.api.passkeyLogin(challengeId, credential));
          } catch (err) {
            if (!isCancel(err)) showError(err);
          } finally {
            b.disabled = false;
          }
        });
        body.append(b);
        if (methods.password || methods.discord) body.append(el('p', { class: 'account-or', 'aria-hidden': 'true' }, el('span', { text: 'or' })));
      }
      const discord = methods.discord ? el('button', { type: 'button', class: 'account-discord', text: 'Sign in with Discord' }) : null;
      discord?.addEventListener('click', async () => {
        discord.disabled = true;
        try {
          const { url } = await session.api.discordStart({ mode: 'login', returnTo });
          navigate(url);
        } catch (err) {
          showError(err);
          discord.disabled = false;
        }
      });
      if (methods.password) {
        const login = el('input', { type: 'text', id: 'account-login', name: 'username', autocomplete: 'username webauthn', required: true, maxlength: String(EMAIL_MAX) });
        const password = el('input', { type: 'password', id: 'account-password', name: 'password', autocomplete: 'current-password', required: true, maxlength: String(ACCOUNT_PASSWORD_MAX) });
        // Without a passkey the password is the main way: the red button.
        const submit = el('button', { type: 'submit', class: methods.passkey ? 'account-submit' : 'primary account-submit', text: 'Sign in' });
        const form = el(
          'form',
          { class: 'account-form', novalidate: true },
          el('label', { for: 'account-login', text: 'Username or email' }),
          login,
          el('label', { for: 'account-password', text: 'Password' }),
          password,
          el('div', { class: 'audio-buttons account-actions' }, submit, discord),
        );
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          if (!login.value.trim() || !password.value) return showError('Enter your username or email and your password.');
          submit.disabled = true;
          try {
            await done(await session.api.login({ login: login.value.trim(), password: password.value }));
          } catch (err) {
            showError(err);
            password.value = '';
          } finally {
            submit.disabled = false;
          }
        });
        body.append(form);
        if (methods.email) body.append(el('p', { class: 'audio-note' }, el('a', { href: `${ACCOUNT_URL}#forgot`, text: 'Forgot your password?' })));
      } else if (discord) body.append(el('div', { class: 'audio-buttons account-methods' }, discord));
      if (!methods.password && !methods.passkey && !methods.discord) body.append(el('p', { class: 'audio-note', text: 'Signing in is switched off right now.' }));
      const links = el('p', { class: 'audio-note' });
      if (methods.signup) links.append(el('span', { text: 'No account yet? ' }), el('a', { href: `${ACCOUNT_URL}#signup`, text: 'Create one' }), el('span', { text: '. ' }));
      links.append(el('a', { href: ACCOUNT_URL, text: 'More on the account page' }), el('span', { text: '.' }));
      body.append(links);
    },
    { className: 'account-signin-dialog', emblem: true },
  );
}

/**
 * What the game tells the player when the play gate (account/gate.js
 * probePlayAccess) refuses the game files or cannot be reached, besides an
 * ended sign-in (the sign-in dialog): `forbidden` with the account's own
 * state (account/session.js accountState: waiting for approval, verify
 * your email, banned), `offline` and `error`. Returns `{ state, led,
 * title, text, action }`; `action` is `retry` (ask the gate again) or
 * `account` (the account page says why).
 */
export function accessProblem(state, user = null, site = null) {
  const keeps = ' What runs now keeps running.';
  if (state === 'offline') return { state, led: 'off', title: 'No connection', text: `The game files could not be reached.${keeps}`, action: 'retry' };
  if (state === 'error') return { state, led: 'warn', title: 'Server problem', text: `The server could not answer just now.${keeps} Try again in a moment.`, action: 'retry' };
  const a = accountState(user, site);
  if (a.kind === 'pending_approval' || a.kind === 'pending_email') return { state, led: 'warn', title: a.label, text: `${a.text}${keeps}`, action: 'retry' };
  if (a.kind === 'banned') return { state, led: 'bad', title: 'Account not allowed', text: `${a.text} Contact the admins if you think this is wrong.`, action: 'account' };
  return { state, led: 'bad', title: 'Account not allowed', text: `This account or network may not play right now. The account page says why; contact the admins if you think this is wrong.${keeps}`, action: 'account' };
}

const ACTION_LABELS = { retry: { offline: 'Try again', error: 'Try again', forbidden: 'Check again' }, account: 'Account page' };

/**
 * The dialog for accessProblem: its lamp and title, the text, and one
 * action: "Try again" / "Check again" asks the gate again (`probe`): the
 * game files are back (resolves 'ok'), the sign-in ended (resolves
 * 'signin': the caller opens the sign-in dialog), or another problem
 * (the dialog shows that one). "Account page" goes there. It never blocks
 * a running game: closing it leaves everything as it was (resolves null).
 * By design it only opens where game files load (js/main.js playAccess: a
 * start, the lobby, saves and replays, online play's module), never in the
 * middle of a lockstep game, whose files are all in memory already.
 * @param {import('./session.js').AccountSession | null} session
 * @param {'forbidden' | 'offline' | 'error'} state
 * @param {{ probe?: () => Promise<string>, navigate?: (url: string) => void }} [o]
 */
export function openAccessProblem(session, state, { probe = () => probePlayAccess(), navigate = (url) => globalThis.location.assign(url) } = {}) {
  const first = accessProblem(state, session?.user ?? null, session?.site ?? null);
  let offHints = null;
  const done = modal(
    first.title,
    (body, close) => {
      const heading = body.closest?.('.account-dialog')?.querySelector('h1');
      const text = el('p', { class: 'account-reason' });
      const status = el('p', { class: 'audio-note account-check', role: 'status' });
      const action = el('button', { type: 'button', class: 'primary' });
      const later = el('button', { type: 'button', text: 'Close' });
      later.addEventListener('click', () => close(null));
      let shown = first;
      const show = (p) => {
        shown = p;
        if (heading) {
          heading.querySelector('.ui-led')?.replaceWith(led(p.led));
          heading.querySelector('.account-title-text').textContent = p.title;
        }
        text.textContent = p.text;
        action.textContent = p.action === 'retry' ? ACTION_LABELS.retry[p.state] : ACTION_LABELS.account;
      };
      const check = async () => {
        action.disabled = true;
        status.textContent = 'Checking...';
        try {
          // A waiting account may have been approved meanwhile: its state comes from the server.
          if (shown.state === 'forbidden') await session?.refresh?.().catch(() => {});
          const now = await probe();
          if (now === 'ok' || now === 'signin') {
            close(now);
            return;
          }
          const same = now === shown.state;
          show(accessProblem(now, session?.user ?? null, session?.site ?? null));
          status.textContent = same ? 'Still the same. You can try again later.' : '';
        } finally {
          action.disabled = false;
        }
      };
      action.addEventListener('click', async () => {
        if (shown.action === 'account') {
          navigate(ACCOUNT_URL);
          close(null);
          return;
        }
        await check();
      });
      // The account changed (approved, unbanned: a realtime hint): check at once, as the button does.
      offHints =
        session?.realtime?.subscribe?.('account', (e) => {
          if ((e.batch ?? [e]).some((x) => x.kind === 'status') && shown.state === 'forbidden' && !action.disabled) check();
        }) ?? null;
      body.append(text, status, el('div', { class: 'audio-buttons account-actions' }, action, later));
      show(first);
    },
    { className: 'account-problem-dialog', lamp: first.led },
  );
  return done.finally(() => offHints?.());
}

/** Label of a setting for people: "Sound: Master volume". */
export function settingLabel(group, key) {
  const g = GROUPS[group];
  return `${g?.label ?? group}: ${g?.settings[key]?.label ?? key}`;
}

/** Short text of a setting value. */
export function valueText(group, key, value) {
  const spec = GROUPS[group]?.settings[key];
  if (spec?.labels && Object.hasOwn(spec.labels, value)) return spec.labels[value];
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  if (value === null || value === undefined) return 'not set';
  if (typeof value === 'object') return Array.isArray(value) ? `${value.length} items` : `${Object.keys(value).length} entries`;
  return String(value);
}

/**
 * Settings changed both here (while offline) and on another device: which
 * values to keep. Resolves 'local' or 'remote' (closing the dialog keeps the
 * account's, the safe default).
 */
export async function askConflict({ conflicts }) {
  const choice = await modal('Settings changed on two devices', (body, close) => {
    body.append(
      el('p', { class: 'audio-note', text: 'You changed these settings on this device while it was offline, and they were changed on another device too. Which values do you want to keep?' }),
      el(
        'ul',
        { class: 'account-conflicts' },
        ...conflicts.map((c) => el('li', {}, el('strong', { text: settingLabel(c.group, c.key) }), el('span', { text: ` here: ${valueText(c.group, c.key, c.local)}; account: ${valueText(c.group, c.key, c.remote)}` }))),
      ),
    );
    const mine = el('button', { type: 'button', class: 'primary', text: "Keep this device's" });
    const theirs = el('button', { type: 'button', text: "Use the account's" });
    mine.addEventListener('click', () => close('local'));
    theirs.addEventListener('click', () => close('remote'));
    body.append(el('div', { class: 'audio-buttons' }, mine, theirs));
  });
  return choice === 'local' ? 'local' : 'remote';
}

const SYNC_TEXT = { syncing: 'Syncing settings...', synced: 'Settings synced', offline: 'Offline: settings will sync later', error: 'Settings not synced' };

/**
 * The account entry on the start screen (index.html #account-entry): the
 * message of the day, and who is signed in or a Sign in button.
 * @param {HTMLElement} host
 * @param {import('./session.js').AccountSession} session
 * @param {{ onSignIn?: () => void }} [o]
 */
export function mountAccountEntry(host, session, { onSignIn = () => openSignIn(session) } = {}) {
  host.classList.add('account-entry');
  const render = () => {
    const user = session.user;
    const state = accountState(user, session.site);
    const parts = [];
    if (session.site?.motd) parts.push(el('p', { class: 'account-motd', role: 'note', text: session.site.motd }));
    if (!user) {
      const b = el('button', { type: 'button', class: 'account-signin', text: session.ready ? 'Sign in' : 'Account' });
      b.disabled = !session.ready;
      b.addEventListener('click', () => onSignIn());
      parts.push(el('div', { class: 'account-row' }, b));
    } else {
      const dot = el('span', { class: `account-avatar account-avatar-${user.avatarColor && /^#[0-9a-f]{6}$/.test(user.avatarColor) ? 'set' : 'none'}`, 'aria-hidden': 'true', text: user.username.slice(0, 1).toUpperCase() });
      const name = el('a', { class: 'account-name', href: ACCOUNT_URL, title: 'Your account', text: user.displayName || user.username });
      const out = el('button', { type: 'button', class: 'account-signout', text: 'Sign out' });
      out.addEventListener('click', () => session.signOut().catch(() => {}));
      const row = el('div', { class: 'account-row' }, dot, name, out);
      parts.push(row);
      if (state.kind !== 'active') parts.push(el('p', { class: `account-state account-state-${state.kind}`, role: 'status' }, el('strong', { text: `${state.label}. ` }), el('span', { text: state.text })));
      const sync = session.syncStatus;
      if (sync.status !== 'idle') parts.push(el('p', { class: `account-sync account-sync-${sync.status}`, title: sync.detail || '', text: SYNC_TEXT[sync.status] ?? '' }));
    }
    host.replaceChildren(...parts);
    host.hidden = false;
    // The avatar colour comes from the account: set through the CSSOM (the CSP allows no style attributes).
    const avatar = host.querySelector('.account-avatar-set');
    if (avatar?.style?.setProperty) avatar.style.setProperty('--avatar', user.avatarColor);
  };
  session.onChange(render);
  render();
  return { render };
}

/** Text for an online play refusal (protocol 5 and API error codes), and whether signing in helps. */
export function onlineRefusal(code, message = '') {
  switch (code) {
    case 'unauthenticated':
    case 'account_required':
      return { text: 'Online play needs a WebRA account. Sign in or create one, then try again.', signIn: true };
    case 'account_inactive':
      return { text: 'Your account is not active yet: verify your email or wait for approval (see your account page).', signIn: false };
    case 'banned':
      return { text: message || 'Your account is banned from online play.', signIn: false };
    case 'ip_banned':
      return { text: 'Online play is blocked from your network.', signIn: false };
    default:
      return null;
  }
}
