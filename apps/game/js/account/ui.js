// Account UI in the game: the account entry on the start screen (sign in,
// who is signed in, the account state, settings sync, message of the day),
// the sign-in dialog (password, passkey, Discord; sign up and the rest on
// the account page /account/), and the settings conflict choice.
//
// Text from the server only goes in with textContent.

import { errorText } from './api.js';
import { accountState, signInMethods } from './session.js';
import { getPasskey, isCancel, passkeysAvailable } from './passkey.js';
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

/**
 * A modal dialog on the theme (menu-card): `build(body, close)` fills it;
 * resolves with what close() got (Escape and the backdrop give null). Keys
 * typed in it do not reach the game; focus comes back to where it was.
 */
export function modal(title, build, { className = '' } = {}) {
  return new Promise((resolve) => {
    const id = `account-dialog-${++uid}`;
    const body = el('div', { class: 'account-dialog-body' });
    const closeButton = el('button', { type: 'button', class: 'audio-close', 'aria-label': 'Close', text: 'Close' });
    const card = el(
      'div',
      { class: `menu-card account-dialog ${className}`.trim(), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': id },
      el('div', { class: 'audio-head' }, el('h1', { id, text: title }), closeButton),
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
 * The sign-in dialog. Resolves with the signed-in user, or null.
 * @param {import('./session.js').AccountSession} session
 * @param {{ reason?: string, returnTo?: string, navigate?: (url: string) => void }} [o]
 */
export function openSignIn(session, { reason = '', returnTo = '/play/', navigate = (url) => globalThis.location.assign(url) } = {}) {
  const methods = signInMethods(session.site, { passkeys: passkeysAvailable() });
  return modal('Sign in', (body, close) => {
    const error = el('p', { class: 'account-error', role: 'alert', hidden: true });
    const showError = (err) => {
      error.textContent = typeof err === 'string' ? err : errorText(err);
      error.hidden = false;
    };
    const done = async (res) => {
      await session.setUser(res.user ?? null);
      close(res.user ?? null);
    };
    if (reason) body.append(el('p', { class: 'audio-local', text: reason }));
    if (session.site?.motd) body.append(el('p', { class: 'account-motd', text: session.site.motd }));
    body.append(error);

    if (methods.password) {
      const login = el('input', { type: 'text', id: 'account-login', name: 'username', autocomplete: 'username webauthn', required: true, maxlength: String(EMAIL_MAX) });
      const password = el('input', { type: 'password', id: 'account-password', name: 'password', autocomplete: 'current-password', required: true, maxlength: String(ACCOUNT_PASSWORD_MAX) });
      const submit = el('button', { type: 'submit', class: 'primary', text: 'Sign in' });
      const form = el(
        'form',
        { class: 'account-form', novalidate: true },
        el('label', { for: 'account-login', text: 'Username or email' }),
        login,
        el('label', { for: 'account-password', text: 'Password' }),
        password,
        submit,
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
    }
    const others = el('div', { class: 'audio-buttons account-methods' });
    if (methods.passkey) {
      const b = el('button', { type: 'button', text: 'Sign in with a passkey' });
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
      others.append(b);
    }
    if (methods.discord) {
      const b = el('button', { type: 'button', class: 'account-discord', text: 'Sign in with Discord' });
      b.addEventListener('click', async () => {
        b.disabled = true;
        try {
          const { url } = await session.api.discordStart({ mode: 'login', returnTo });
          navigate(url);
        } catch (err) {
          showError(err);
          b.disabled = false;
        }
      });
      others.append(b);
    }
    if (others.childNodes.length) body.append(others);
    if (!methods.password && !methods.passkey && !methods.discord) body.append(el('p', { class: 'audio-note', text: 'Signing in is switched off right now.' }));
    const links = el('p', { class: 'audio-note' });
    if (methods.signup) links.append(el('span', { text: 'No account yet? ' }), el('a', { href: `${ACCOUNT_URL}#signup`, text: 'Create one' }), el('span', { text: '. ' }));
    links.append(el('a', { href: ACCOUNT_URL, text: 'More on the account page' }), el('span', { text: '.' }));
    body.append(links);
  });
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
    const state = accountState(user);
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
