// The account page (/account/): sign in, sign up, email verification and
// password reset links, Discord returns, and for a signed-in player the
// profile, password, email, passkeys, Discord, sessions, the replays kept
// in the account, data export and account deletion (docs/accounts-api.md 3
// to 5).
//
// Links from emails land here with the token in the fragment
// (#verify=<token>, #reset=<token>); Discord comes back with #discord=ok or
// #discord=error&code=<code>. The fragment is removed at once.
//
// The play gate (docs/security.md) sends signed-out players here with
// ?returnTo=<game path>: after signing in or up (password, passkey, Discord,
// a reset link) an account that may play goes straight back there.

import { AccountApi, AccountError, errorText, formatDateTime } from '/lib/js/account/api.js';
import { checkInput } from '/lib/js/ui/controls.js';
import { AccountSession, accountState, signInMethods } from '/lib/js/account/session.js';
import { createPasskey, getPasskey, isCancel, passkeysAvailable } from '/lib/js/account/passkey.js';
import { clearQueuedReplays, REPLAY_LINK_RE, replayLine, replayLink, usageText } from '/lib/js/account/replays.js';
import {
  ACCOUNT_PASSWORD_MAX,
  ACCOUNT_PASSWORD_MIN,
  DISPLAY_NAME_MAX,
  EMAIL_MAX,
  USERNAME_MAX,
  USERNAME_MIN,
  validEmail,
  validNewPassword,
  validUsername,
} from '/lib/protocol/accounts.js';
import { el, field, toggle as switchRow, statusLine, openDialog, confirmDialog, busy, saveBlob, present } from './ui.js';
import { FriendsClient, FriendsStore, friendsSummary, groupFriends, socialSettings } from './friends.js';
import { formatInviteCode, invitePath, inviteInPath, inviteSummary, lookupInvite, normalizeInviteCode } from './invite.js';

const TOKEN = /^[A-Za-z0-9_-]{20,200}$/;
export const DEFAULT_RETURN = '/play/';
/** Same rule as the server (apps/server/src/http.js RETURN_PATH_RE): one leading slash, URL characters, at most 200. */
const RETURN_RE = /^\/(?!\/)[A-Za-z0-9\-._~!$&'()*+,;=:@%/?]{0,199}$/;
const BASE = 'https://webra.invalid';
/** A waiting account checks its state this often while the realtime channel is not open. */
const PENDING_POLL_MS = 60_000;

/**
 * Where to go after signing in: the `returnTo` query parameter when it is a
 * path on this site (never another origin, never the API), /play/ when it
 * is anything else, and null without one (stay on the account page).
 */
export function returnTarget(search) {
  let raw;
  try {
    raw = new URLSearchParams(String(search ?? '')).get('returnTo');
  } catch {
    return null;
  }
  if (raw === null) return null;
  if (!RETURN_RE.test(raw) || raw.startsWith('/api/')) return DEFAULT_RETURN;
  try {
    return new URL(raw, BASE).origin === BASE ? raw : DEFAULT_RETURN;
  } catch {
    return DEFAULT_RETURN;
  }
}

/** The Discord return path (4.6): this page, carrying the target along when it fits the server's 200 characters. */
export function discordReturn(target) {
  if (!target) return '/account/';
  const withTarget = `/account/?returnTo=${encodeURIComponent(target)}`;
  return withTarget.length <= 200 ? withTarget : `/account/?returnTo=${encodeURIComponent(DEFAULT_RETURN)}`;
}

/** This tab's sessionStorage, or null when the browser blocks it. */
function sessionStore() {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

/** The message of a protocol check that fails, or null. */
function check(fn) {
  try {
    fn();
    return null;
  } catch (err) {
    return err.message;
  }
}

/** What the fragment asks for: { kind: 'verify' | 'reset' | 'discord' | 'signup' | 'forgot' | null, token?, ok?, code? }. */
export function parseFragment(hash) {
  const h = String(hash ?? '').replace(/^#/, '');
  let m = /^(verify|reset)=([^&]*)$/.exec(h);
  if (m) return TOKEN.test(m[2]) ? { kind: m[1], token: m[2] } : { kind: 'bad-link' };
  m = /^discord=(ok|error)(?:&code=([a-z_]{1,32}))?$/.exec(h);
  if (m) return { kind: 'discord', ok: m[1] === 'ok', code: m[2] ?? null };
  if (h === 'signup' || h === 'forgot' || h === 'signin') return { kind: h };
  return { kind: null };
}

/** Discord return codes in words (4.6). */
export const DISCORD_ERRORS = {
  denied: 'You cancelled the Discord sign-in.',
  invalid_state: 'The Discord sign-in took too long or was started in another browser. Try again.',
  no_account: 'No WebRA account is linked to that Discord account. Sign up with Discord, or sign in another way and link Discord on this page.',
  already_linked: 'That Discord account is already linked to another WebRA account.',
  email_taken: 'The email of that Discord account belongs to another WebRA account. Sign in to that account and link Discord there.',
  email_required: 'Your Discord account has no verified email address. Enter your email above and sign up with Discord again.',
  registration_closed: 'Signing up is closed right now.',
  method_disabled: 'Discord sign-in is switched off right now.',
  banned: 'This account is banned.',
  ip_banned: 'Signing in is blocked from your network.',
  account_inactive: 'This account was deleted.',
  rate_limited: 'Too many sign-ups from your network. Try again later.',
  unavailable: 'Discord could not be reached. Try again later.',
};

/**
 * Build the page into `root`.
 * @param {HTMLElement} root
 * `storage` (sessionStorage) keeps a replay link (`#replay=<id>`, from the
 * game's Watch through the play gate) until the game opens it after sign-in.
 * `realtime` replaces the realtime channel (js/account/realtime.js; tests
 * pass a stand-in), `timers` the timers of the polls.
 * @param {{ api?: AccountApi, location?: Location, history?: History, navigate?: (url: string) => void, storage?: Storage | null, realtime?: object | null, timers?: object }} [deps]
 */
export async function mountAccountPage(root, deps = {}) {
  const api = deps.api ?? new AccountApi();
  const loc = deps.location ?? globalThis.location;
  const hist = deps.history ?? globalThis.history;
  const navigate = deps.navigate ?? ((url) => loc.assign(url));
  const timers = deps.timers ?? globalThis;
  const session = new AccountSession({ api, realtime: deps.realtime });
  /** What the shown account view follows (realtime topics, timers): undone on every new render. */
  let follows = [];
  const unfollow = () => {
    for (const off of follows) off();
    follows = [];
  };
  // Signing out here drops the replays this account left waiting in this browser (js/account/replays.js).
  session.onSignOut((userId) => clearQueuedReplays(userId));
  const notice = statusLine();
  const view = el('div', { class: 'account-view' });
  root.replaceChildren(notice.node, view);

  // A replay to watch (the play gate sent a signed-out player here from /play/#replay=<id>):
  // kept for this tab, so the game opens it after the sign-in.
  if (REPLAY_LINK_RE.test(loc.hash ?? '')) {
    replayLink(loc.hash, deps.storage !== undefined ? deps.storage : sessionStore());
    hist.replaceState(null, '', loc.pathname + loc.search);
  }
  const fragment = parseFragment(loc.hash);
  if (fragment.kind) hist.replaceState(null, '', loc.pathname + loc.search);
  const target = returnTarget(loc.search);
  /** After a sign-in: back to the game when this account may play there. Returns whether it left. */
  const goOn = () => {
    if (!target || !session.user?.canPlay) return false;
    navigate(target);
    return true;
  };

  await session.refresh();
  if (session.error && !session.site) {
    notice.show(errorText(session.error), 'error');
    // No connection (the Sign in again board): say so and offer to try again.
    const again = el('button', { type: 'button', class: 'btn btn-small', text: 'Try again' });
    again.addEventListener('click', () => {
      root.replaceChildren(el('p', { class: 'status-line', text: 'Loading your account...' }));
      mountAccountPage(root, deps);
    });
    root.append(
      el(
        'div',
        { class: 'state-card state-off', role: 'status' },
        el('div', { class: 'state-card-head' }, el('span', { class: 'lamp', 'aria-hidden': 'true' }), el('strong', { text: 'No connection' })),
        el('p', { text: 'The account server could not be reached. What runs in other tabs keeps running.' }),
        el('div', { class: 'form-actions' }, again),
      ),
    );
  }

  // ---- Links from emails and Discord ---------------------------------------------------
  let start = 'signin';
  if (fragment.kind === 'bad-link') notice.show('This link is not complete. Open it again from the email, or ask for a new one.', 'error');
  if (fragment.kind === 'verify') {
    try {
      const r = await api.verifyEmail(fragment.token);
      if (r.user) await session.setUser(r.user);
      else await session.refresh();
      notice.show('Your email is verified.', 'ok');
    } catch (err) {
      notice.show(err instanceof AccountError && err.code === 'bad_credentials' ? 'This verification link is not valid any more. Sign in and send a new one.' : errorText(err), 'error');
    }
  }
  if (fragment.kind === 'discord') {
    if (fragment.ok && session.user && goOn()) return { session, render: () => {} };
    if (fragment.ok) notice.show('Discord: done.', 'ok');
    else notice.show(DISCORD_ERRORS[fragment.code] ?? 'Discord sign-in did not work. Try again.', 'error');
  }
  if (fragment.kind === 'signup' || fragment.kind === 'forgot') start = fragment.kind;

  /** The friends list while the account shows (polls; stopped on every new render). */
  let friendsView = null;
  // This sign-in ended elsewhere (signed out, revoked, banned): show the signed-out page.
  session.realtime?.on('auth', async () => {
    await session.refresh();
    if (session.user) return;
    unfollow();
    friendsView?.stop();
    friendsView = null;
    notice.show('You were signed out.', 'info');
    render();
  });
  const render = () => {
    unfollow();
    friendsView?.stop();
    friendsView = null;
    if (fragment.kind === 'reset' && !fragment.used) return renderReset();
    if (session.user) renderAccount();
    else renderSignedOut(start);
  };

  // ---- Password reset from a link -------------------------------------------------------
  function renderReset() {
    const status = statusLine();
    const password = field('New password', el('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: String(ACCOUNT_PASSWORD_MIN), maxlength: String(ACCOUNT_PASSWORD_MAX) }), {
      help: `At least ${ACCOUNT_PASSWORD_MIN} characters. A long phrase is best.`,
    });
    const again = field('New password again', el('input', { type: 'password', autocomplete: 'new-password', required: true }));
    const submit = el('button', { type: 'submit', class: 'btn btn-primary', text: 'Set password and sign in' });
    const form = el('form', { class: 'panel form-card', novalidate: true }, el('h2', { text: 'Choose a new password' }), status.node, password.row, again.row, el('div', { class: 'form-actions' }, submit));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (password.input.value !== again.input.value) return status.show('The two passwords are not the same.', 'error');
      const problem = check(() => validNewPassword(password.input.value));
      if (problem) return status.show(problem, 'error');
      await busy(submit, status, async () => {
        const r = await api.resetPassword(fragment.token, password.input.value);
        fragment.used = true;
        await session.setUser(r.user);
        if (goOn()) return;
        notice.show('Your password is set and you are signed in.', 'ok');
        render();
      }, (err) => (err.code === 'bad_credentials' ? 'This reset link is not valid any more. Ask for a new one.' : errorText(err)));
    });
    view.replaceChildren(form);
    password.input.focus();
  }

  // ---- Signed out: sign in, sign up, forgot password ----------------------------------------
  function renderSignedOut(tab) {
    const methods = signInMethods(session.site, { passkeys: passkeysAvailable() });
    const tabs = [
      ['signin', 'Sign in'],
      ['signup', 'Create account'],
      ...(methods.email ? [['forgot', 'Forgot password']] : []),
    ];
    if (!tabs.some(([k]) => k === tab)) tab = 'signin';
    const list = el('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Account' });
    const panel = el('div', { class: 'tab-panel', role: 'tabpanel' });
    const buttons = tabs.map(([key, label]) => {
      const b = el('button', { type: 'button', role: 'tab', class: 'tab', id: `tab-${key}`, 'aria-selected': String(key === tab), tabindex: key === tab ? '0' : '-1', text: label });
      b.addEventListener('click', () => renderSignedOut(key));
      b.addEventListener('keydown', (e) => {
        const i = tabs.findIndex(([k]) => k === key);
        const next = e.key === 'ArrowRight' ? tabs[(i + 1) % tabs.length] : e.key === 'ArrowLeft' ? tabs[(i - 1 + tabs.length) % tabs.length] : null;
        if (next) {
          e.preventDefault();
          renderSignedOut(next[0]);
          view.querySelector(`#tab-${next[0]}`)?.focus();
        }
      });
      return b;
    });
    list.append(...buttons);
    panel.setAttribute('aria-labelledby', `tab-${tab}`);
    view.replaceChildren();
    if (target && session.site?.gameRequiresAccount !== false) {
      view.append(
        el(
          'div',
          { class: 'state-card state-on gate-card', role: 'status' },
          el('div', { class: 'state-card-head' }, el('span', { class: 'lamp', 'aria-hidden': 'true' }), el('strong', { text: 'Sign in to play' })),
          el('p', { text: 'The game needs a WebRA account. Sign in, or create one; new accounts may need an admin to approve them first. Your link opens once you are in.' }),
        ),
      );
    }
    const invite = inviteInPath(target);
    if (invite) view.append(inviteCard(invite));
    if (session.site?.motd) view.append(el('p', { class: 'notice', text: session.site.motd }));
    if (tab === 'signin') panel.append(signInForm(methods));
    else if (tab === 'signup') panel.append(signUpForm(methods));
    else panel.append(forgotForm());
    view.append(el('div', { class: 'panel form-card' }, list, panel));
  }

  /**
   * The lobby an invite link names (/join/<code> -> the game -> the play
   * gate -> here with ?returnTo=/play/?invite=<code>): looked up so the
   * player sees where the sign-in leads.
   */
  function inviteCard(code) {
    const card = el(
      'div',
      { class: 'state-card state-off invite-card', role: 'status' },
      el('div', { class: 'state-card-head' }, el('span', { class: 'lamp', 'aria-hidden': 'true' }), el('strong', { text: `Invite code ${formatInviteCode(code)}` })),
      el('p', { text: 'Looking up the lobby...' }),
    );
    lookupInvite(code, { fetchImpl: api.fetchImpl }).then((r) => {
      const [head, text] = [card.querySelector('strong'), card.querySelector('p')];
      if (r.ok) {
        card.className = `state-card ${r.full ? 'state-warn' : 'state-ok'} invite-card`;
        head.textContent = `You are invited: ${typeof r.invite.name === 'string' && r.invite.name ? r.invite.name : 'a lobby'}`;
        text.textContent = [inviteSummary(r.invite), r.message ?? 'Sign in, or create an account, and the game opens the lobby.'].filter(Boolean).join('. ');
      } else {
        card.className = 'state-card state-bad invite-card';
        text.textContent = `${r.message} You can still sign in.`;
      }
    });
    return card;
  }

  /** `email` (signup): reads the typed address, sent along for when Discord reports no verified one. */
  function discordButton(label, mode, status, { privacy, email } = {}) {
    const b = el('button', { type: 'button', class: 'btn btn-discord', text: label });
    b.addEventListener('click', () =>
      busy(b, status, async () => {
        if (privacy && !privacy.checked) throw new Error('Accept the privacy notice first.');
        const typed = email ? email() : '';
        const problem = typed ? check(() => validEmail(typed)) : null;
        if (problem) throw new Error(problem);
        const { url } = await api.discordStart({
          mode,
          returnTo: mode === 'login' || mode === 'signup' ? discordReturn(target) : '/account/',
          ...(mode === 'signup' ? { acceptPrivacy: true } : {}),
          ...(mode === 'signup' && typed ? { email: typed } : {}),
        });
        navigate(url);
      }, errorText),
    );
    return b;
  }

  function signInForm(methods) {
    const status = statusLine();
    const out = el('div', { class: 'form-stack' }, status.node);
    // A passkey first, then "or" and the password (the Sign in again board).
    if (methods.passkey) {
      const b = el('button', { type: 'button', class: 'btn btn-passkey', text: 'Sign in with a passkey' });
      b.addEventListener('click', () =>
        busy(b, status, async () => {
          try {
            const { challengeId, credential } = await getPasskey(await api.passkeyOptions());
            const r = await api.passkeyLogin(challengeId, credential);
            await session.setUser(r.user);
            if (goOn()) return;
            render();
          } catch (err) {
            if (!isCancel(err)) throw err;
          }
        }, errorText),
      );
      out.append(b);
      if (methods.password) out.append(el('div', { class: 'or-rule', 'aria-hidden': 'true' }, el('span', { text: 'or' })));
    }
    if (methods.password) {
      const login = field('Username or email', el('input', { type: 'text', autocomplete: 'username webauthn', required: true, maxlength: String(EMAIL_MAX) }));
      const password = field('Password', el('input', { type: 'password', autocomplete: 'current-password', required: true, maxlength: '128' }));
      const submit = el('button', { type: 'submit', class: 'btn btn-primary', text: 'Sign in' });
      const form = el('form', { class: 'form-stack', novalidate: true }, login.row, password.row, el('div', { class: 'form-actions' }, submit));
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!login.input.value.trim() || !password.input.value) return status.show('Enter your username or email and your password.', 'error');
        await busy(submit, status, async () => {
          const r = await api.login({ login: login.input.value.trim(), password: password.input.value });
          await session.setUser(r.user);
          if (goOn()) return;
          notice.clear();
          render();
        }, (err) => {
          password.input.value = '';
          return errorText(err);
        });
      });
      out.append(form);
    }
    const others = el('div', { class: 'form-actions' });
    if (methods.discord) others.append(discordButton('Sign in with Discord', 'login', status));
    if (others.childNodes.length) out.append(others);
    if (methods.password && methods.email) {
      const forgot = el('button', { type: 'button', class: 'link-button', text: 'Forgot your password?' });
      forgot.addEventListener('click', () => {
        renderSignedOut('forgot');
        view.querySelector('#tab-forgot')?.focus();
      });
      out.append(el('p', { class: 'form-help' }, forgot));
    }
    if (!methods.password && !methods.passkey && !methods.discord) out.append(el('p', { class: 'notice', text: 'Signing in is switched off right now.' }));
    return out;
  }

  function signUpForm(methods) {
    const status = statusLine();
    const site = session.site;
    if (site && site.registration?.open === false) return el('p', { class: 'notice', text: 'Signing up is closed right now. Check back later.' });
    const policy = site?.policy ?? { usernameMin: USERNAME_MIN, usernameMax: USERNAME_MAX, passwordMin: ACCOUNT_PASSWORD_MIN, passwordMax: ACCOUNT_PASSWORD_MAX, displayNameMax: DISPLAY_NAME_MAX };
    const username = field('Username', el('input', { type: 'text', autocomplete: 'username', required: true, minlength: String(policy.usernameMin), maxlength: String(policy.usernameMax), spellcheck: 'false' }), {
      help: `${policy.usernameMin} to ${policy.usernameMax} characters: letters, digits, space, _ - and . Shown in lobbies.`,
    });
    const displayName = field('Display name (optional)', el('input', { type: 'text', autocomplete: 'nickname', maxlength: String(policy.displayNameMax) }));
    // Every new account gives an address (docs/accounts-api.md 4.2).
    const email = field('Email', el('input', { type: 'email', autocomplete: 'email', maxlength: String(EMAIL_MAX), required: true }), {
      help: methods.email
        ? 'We send a link to confirm it. Used for password resets, never shown to other players.'
        : 'Never shown to other players. This server cannot send confirmation links yet; you confirm the address from your account page once it can.',
    });
    const usePasskey = methods.passkey && methods.password ? switchRow('Use a passkey instead of a password') : null;
    const password = field('Password', el('input', { type: 'password', autocomplete: 'new-password', minlength: String(policy.passwordMin), maxlength: String(policy.passwordMax) }), {
      help: `At least ${policy.passwordMin} characters. A long phrase is best.`,
    });
    const privacyUrl = site?.privacyUrl ?? '/privacy.html';
    const privacy = checkInput({ id: 'signup-privacy' });
    privacy.required = true;
    const privacyRow = el(
      'div',
      { class: 'check' },
      privacy,
      el('label', { for: 'signup-privacy' }, el('span', { text: 'I have read the ' }), el('a', { href: privacyUrl, target: '_blank', rel: 'noopener', text: 'privacy notice' }), el('span', { text: '.' })),
    );
    const submit = el('button', { type: 'submit', class: 'btn btn-primary', text: 'Create account' });
    const passkeyOnly = !methods.password && methods.passkey;
    const syncPasswordRow = () => {
      password.row.hidden = passkeyOnly || !!usePasskey?.input.checked;
    };
    usePasskey?.input.addEventListener('change', syncPasswordRow);
    syncPasswordRow();
    const form = el(
      'form',
      { class: 'form-stack', novalidate: true },
      status.node,
      site?.registration?.approvalRequired ? el('p', { class: 'notice', text: 'WebRA is in a closed beta: new accounts wait for an admin to approve them.' }) : null,
      username.row,
      displayName.row,
      email.row,
      usePasskey?.row,
      password.row,
      privacyRow,
      el('div', { class: 'form-actions' }, submit),
    );
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!privacy.checked) return status.show('Accept the privacy notice to create an account.', 'error');
      // The protocol package's checks, as the server makes them (it stays the authority).
      let name;
      try {
        name = validUsername(username.input.value);
      } catch (err) {
        username.input.focus();
        return status.show(err.message, 'error');
      }
      if (!email.input.value.trim()) {
        email.input.focus();
        return status.show('Enter your email address.', 'error');
      }
      const emailProblem = check(() => validEmail(email.input.value.trim()));
      if (emailProblem) {
        email.input.focus();
        return status.show(emailProblem, 'error');
      }
      const withPasskey = passkeyOnly || !!usePasskey?.input.checked;
      const pwProblem = withPasskey ? null : check(() => validNewPassword(password.input.value, { username: name, email: email.input.value.trim() }));
      if (pwProblem) return status.show(pwProblem, 'error');
      const input = { username: name, email: email.input.value.trim(), acceptPrivacy: true };
      if (displayName.input.value.trim()) input.displayName = displayName.input.value.trim();
      await busy(submit, status, async () => {
        if (withPasskey) {
          try {
            const options = await api.passkeySignupOptions({ username: name, ...(input.displayName ? { displayName: input.displayName } : {}) });
            input.passkey = await createPasskey(options);
          } catch (err) {
            if (isCancel(err)) return;
            throw err;
          }
        } else input.password = password.input.value;
        const r = await api.signup(input);
        await session.setUser(r.user);
        if (goOn()) return;
        notice.show(methods.email ? `Your account is created. We sent a link to ${input.email} to confirm it.` : 'Your account is created.', 'ok');
        render();
      }, (err) => {
        if (err.field) form.querySelector(`[name="${err.field}"]`)?.focus?.();
        return errorText(err);
      });
    });
    for (const [f, n] of [
      [username, 'username'],
      [displayName, 'displayName'],
      [email, 'email'],
      [password, 'password'],
    ])
      f.input.setAttribute('name', n);
    const out = el('div', { class: 'form-stack' }, form);
    if (methods.discord) {
      out.append(
        el('p', { class: 'form-help', text: "Or create the account with Discord (accept the privacy notice above first). It uses your Discord account's verified email; without one, enter your email above." }),
        el('div', { class: 'form-actions' }, discordButton('Sign up with Discord', 'signup', status, { privacy, email: () => email.input.value.trim() })),
      );
    }
    return out;
  }

  function forgotForm() {
    const status = statusLine();
    const email = field('Email', el('input', { type: 'email', autocomplete: 'email', required: true, maxlength: String(EMAIL_MAX) }));
    const submit = el('button', { type: 'submit', class: 'btn btn-primary', text: 'Send reset link' });
    const form = el('form', { class: 'form-stack', novalidate: true }, status.node, el('p', { class: 'form-help', text: 'We email a link to choose a new password, if an account has this email.' }), email.row, el('div', { class: 'form-actions' }, submit));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!email.input.value.trim()) return status.show('Enter your email.', 'error');
      await busy(submit, status, async () => {
        await api.forgotPassword(email.input.value.trim());
        status.show('If an account has this email, a reset link is on its way. It works for one hour.', 'ok');
      }, errorText);
    });
    return form;
  }

  // ---- Re-authentication for sensitive actions --------------------------------------------
  /** Run `fn`; when the server wants a recent sign-in proof, ask for one and run it again. */
  async function withReauth(fn) {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof AccountError) || err.code !== 'reauth_required') throw err;
      const ok = await reauthDialog();
      if (!ok) throw new AccountError(403, 'reauth_required', 'Confirming it is you was cancelled.');
      return fn();
    }
  }

  function reauthDialog() {
    const user = session.user;
    return openDialog('Confirm it is you', (body, close) => {
      const status = statusLine();
      body.append(el('p', { text: 'For this change, confirm your sign-in again.' }), status.node);
      if (user.methods?.password) {
        const password = field('Password', el('input', { type: 'password', autocomplete: 'current-password' }));
        const submit = el('button', { type: 'submit', class: 'btn btn-primary', text: 'Confirm' });
        const form = el('form', { class: 'form-stack', novalidate: true }, password.row, el('div', { class: 'form-actions' }, submit));
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          await busy(submit, status, async () => {
            await api.reauth({ password: password.input.value });
            close(true);
          }, errorText);
        });
        body.append(form);
      }
      const others = el('div', { class: 'form-actions' });
      if (user.methods?.passkeys && passkeysAvailable()) {
        const b = el('button', { type: 'button', class: 'btn', text: 'Use a passkey' });
        b.addEventListener('click', () =>
          busy(b, status, async () => {
            try {
              const { challengeId, credential } = await getPasskey(await api.passkeyOptions('reauth'));
              await api.reauth({ passkey: { challengeId, credential } });
              close(true);
            } catch (err) {
              if (!isCancel(err)) throw err;
            }
          }, errorText),
        );
        others.append(b);
      }
      if (user.methods?.discord && signInMethods(session.site).discord) others.append(discordButton('Use Discord', 'reauth', status));
      if (others.childNodes.length) body.append(others);
    });
  }

  // ---- Signed in ---------------------------------------------------------------------------------
  const sectionId = (title) => `section-${title.toLowerCase().replace(/[^a-z]+/g, '-')}`;

  function section(title, ...children) {
    const id = sectionId(title);
    return el('section', { class: 'panel account-section', 'aria-labelledby': id }, el('h2', { id, text: title }), ...children);
  }

  /**
   * One part of a section (a sign-in method): a row with a lamp, the name
   * and a line of detail (the Account board), then its controls. Returns
   * `{ node, setDetail(text, lit) }`.
   */
  function part(title, { lit = false, detail = '' } = {}, ...children) {
    const id = sectionId(title);
    const lamp = el('span', { class: lit ? 'lamp' : 'lamp lamp-off', 'aria-hidden': 'true' });
    const detailEl = el('span', { class: 'part-detail', text: detail });
    const node = el('div', { class: 'account-part', role: 'group', 'aria-labelledby': id }, el('div', { class: 'part-head' }, lamp, el('div', { class: 'part-name' }, el('h3', { id, text: title }), detailEl)), ...present(children));
    return {
      node,
      setDetail(text, on = lit) {
        detailEl.textContent = text;
        lamp.className = on ? 'lamp' : 'lamp lamp-off';
      },
    };
  }

  /** The side menu's entries, in order: those whose section is on the page are shown. */
  const MENU = [
    ['Profile', 'section-profile'],
    ['Sign-in methods', 'section-sign-in-methods'],
    ['Replays', 'section-replays'],
    ['Friends', 'section-friends'],
    ['Devices', 'section-devices'],
    ['Your data', 'section-your-data'],
  ];

  /**
   * The side menu (the Account board): who is signed in with the account's
   * state on a lamp, links to the sections with a lamp each (the section in
   * view is lit and marked aria-current), Play and Sign out.
   */
  function sideMenu(user, state, sections, signOut) {
    const avatar = el('span', { class: 'account-avatar', 'aria-hidden': 'true', text: (user.displayName || user.username || '?').slice(0, 1).toUpperCase() });
    if (/^#[0-9a-f]{6}$/i.test(user.avatarColor ?? '')) avatar.style.setProperty('--avatar', user.avatarColor);
    const stateLed = state.kind === 'active' ? 'ok' : state.kind === 'banned' ? 'bad' : 'warn';
    const who = el(
      'div',
      { class: 'account-who' },
      avatar,
      el(
        'span',
        { class: 'account-who-text' },
        el('strong', { class: 'account-username', text: user.username }),
        user.displayName && user.displayName !== user.username ? el('span', { class: 'account-display', text: user.displayName }) : null,
        el('span', { class: `account-state-word state-${stateLed}` }, el('span', { class: 'lamp', 'aria-hidden': 'true' }), el('span', { text: state.kind === 'active' ? 'Active' : state.label })),
        roleBadge(user.role),
      ),
    );
    const ids = new Set(sections.map((n) => n.getAttribute('aria-labelledby')));
    const links = MENU.filter(([, id]) => ids.has(id)).map(([label, id]) => el('a', { class: 'account-nav-link', href: `#${id}`, 'data-target': id }, el('span', { class: 'lamp', 'aria-hidden': 'true' }), el('span', { text: label })));
    const mark = (id) => {
      for (const a of links) {
        if (a.dataset.target === id) a.setAttribute('aria-current', 'true');
        else a.removeAttribute('aria-current');
      }
    };
    for (const a of links) {
      // Scroll to the section without putting its id in the address (the fragment carries email links).
      a.addEventListener('click', (e) => {
        const heading = view.querySelector(`#${a.dataset.target}`);
        if (!heading) return;
        e.preventDefault();
        heading.closest('section')?.scrollIntoView?.({ block: 'start' });
        mark(a.dataset.target);
      });
    }
    mark(links[0]?.dataset.target);
    const actions = el('div', { class: 'account-nav-actions' }, user.canPlay ? el('a', { class: 'btn btn-primary btn-play', href: target ?? DEFAULT_RETURN, text: 'Play' }) : null, signOut);
    const nav = el('nav', { class: 'account-nav', 'aria-label': 'Account sections' }, who, el('div', { class: 'account-nav-links' }, ...links), actions);
    // The section in view lights its link.
    if (typeof IntersectionObserver === 'function') {
      const shown = new Map();
      const io = new IntersectionObserver(
        (entries) => {
          for (const e of entries) shown.set(e.target.getAttribute('aria-labelledby'), e.isIntersecting);
          const first = MENU.map(([, id]) => id).find((id) => shown.get(id));
          if (first) mark(first);
        },
        { rootMargin: '-80px 0px -45% 0px' },
      );
      for (const n of sections) io.observe(n);
    }
    return nav;
  }

  /**
   * The account's state with what to do about it (the Sign in again board's
   * cards): waiting for approval or an email to confirm, with "Check again"
   * (and "Send the link again"), banned or inactive.
   */
  function stateCard(user, state) {
    const led = state.kind === 'banned' ? 'bad' : state.kind === 'pending_email' || state.kind === 'pending_approval' ? 'warn' : 'off';
    const s = statusLine();
    const box = el(
      'div',
      { class: `state-card state-${led} account-state account-state-${state.kind}`, role: 'status' },
      el('div', { class: 'state-card-head' }, el('span', { class: 'lamp', 'aria-hidden': 'true' }), el('strong', { text: state.label })),
      el('p', { text: state.text }),
    );
    const actions = el('div', { class: 'form-actions' });
    if (state.kind === 'pending_email' && user.email) {
      const resend = el('button', { type: 'button', class: 'btn btn-small', text: 'Send the link again' });
      resend.addEventListener('click', () => busy(resend, s, async () => {
        await api.resendVerification();
        s.show(`A new link is on its way to ${user.email}.`, 'ok');
      }, errorText));
      actions.append(resend);
    }
    if (state.kind === 'pending_approval' || state.kind === 'pending_email') {
      const again = el('button', { type: 'button', class: 'btn btn-small', text: 'Check again' });
      /** Load the account; once it is active, go on (back to the game, or the full page). `quiet`: no "still waiting". */
      const check = async (quiet = false) => {
        const r = await api.account();
        session.user = r.user;
        if (r.user.status !== 'active') {
          if (r.user.status !== user.status) return renderAccount();
          if (!quiet) s.show('Still waiting. You get an email once the account is active.', 'info');
          return;
        }
        if (goOn()) return;
        notice.show('Your account is active.', 'ok');
        render();
      };
      again.addEventListener('click', () => busy(again, s, () => check(), errorText));
      actions.append(again);
      // The approval (or the verified address) lands without a click: a realtime hint, and a
      // check every minute while the tab shows (also with the channel open: it may be quiet).
      const quietly = () => check(true).catch(() => {});
      if (session.realtime) follows.push(session.realtime.subscribe('account', (e) => e.kind !== 'resync' && quietly()));
      let timer = null;
      const poll = () => {
        timer = timers.setTimeout(() => {
          if (globalThis.document?.visibilityState !== 'hidden') quietly();
          poll();
        }, PENDING_POLL_MS);
      };
      poll();
      follows.push(() => timers.clearTimeout(timer));
    }
    if (actions.childNodes.length) box.append(actions);
    box.append(s.node);
    return box;
  }

  async function renderAccount() {
    let user = session.user;
    try {
      user = (await api.account()).user;
      session.user = user;
    } catch (err) {
      if (err.code === 'unauthenticated') {
        await session.setUser(null);
        return render();
      }
      notice.show(errorText(err), 'error');
    }
    const state = accountState(user, session.site);
    unfollow();
    friendsView?.stop();
    friendsView = null;
    const top = [];
    if (session.site?.motd) top.push(el('p', { class: 'notice', text: session.site.motd }));
    const signOut = el('button', { type: 'button', class: 'btn', text: 'Sign out' });
    signOut.addEventListener('click', async () => {
      unfollow();
      friendsView?.stop();
      await session.signOut().catch(() => {});
      notice.show('You are signed out.', 'info');
      render();
    });
    if (state.kind !== 'active') top.push(stateCard(user, state));
    // Friends need an active account (the routes answer 403 otherwise).
    friendsView = user.status === 'active' ? friendsSection(user) : null;
    const sections = present(profileSection(user), signInSection(user), replaysSection(user), friendsView?.node, sessionsSection(), dataSection(user));
    const main = el('div', { class: 'account-main' }, ...top, ...sections);
    view.replaceChildren(el('div', { class: 'account-layout' }, sideMenu(user, state, sections, signOut), main));
    friendsView?.start();
  }

  function roleBadge(role) {
    if (role === 'user') return null;
    const a = el('a', { class: 'badge badge-open', href: '/admin.html', text: role === 'admin' ? 'Admin' : 'Moderator', title: 'Open the admin dashboard' });
    return a;
  }

  function profileSection(user) {
    const status = statusLine();
    const username = field('Username', el('input', { type: 'text', value: user.username, autocomplete: 'username', maxlength: String(USERNAME_MAX), spellcheck: 'false' }), {
      help: user.usernameChangedAt ? `Last changed ${formatDateTime(user.usernameChangedAt)}. You can change it once every 30 days.` : 'You can change it once every 30 days.',
    });
    const displayName = field('Display name', el('input', { type: 'text', value: user.displayName ?? '', maxlength: String(DISPLAY_NAME_MAX), autocomplete: 'nickname' }));
    // Without a colour of its own the game draws the avatar in the accent red (--ui-accent).
    const color = field('Colour', el('input', { type: 'color', value: user.avatarColor ?? '#e0301f' }));
    const save = el('button', { type: 'submit', class: 'btn btn-primary', text: 'Save profile' });
    const form = el('form', { class: 'form-grid', novalidate: true }, username.row, displayName.row, color.row, el('div', { class: 'form-actions' }, save));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const patch = {};
      if (username.input.value.trim() !== user.username) patch.username = username.input.value.trim();
      if (displayName.input.value.trim() !== (user.displayName ?? '')) patch.displayName = displayName.input.value.trim();
      if (color.input.value.toLowerCase() !== user.avatarColor) patch.avatarColor = color.input.value.toLowerCase();
      if (!Object.keys(patch).length) return status.show('Nothing changed.', 'info');
      await busy(save, status, async () => {
        const r = await api.updateProfile(patch);
        session.user = r.user;
        status.show('Saved.', 'ok');
      }, errorText);
    });
    return section('Profile', el('p', { class: 'form-help', text: `Account created ${formatDateTime(user.createdAt)}.` }), status.node, form, emailSection(user));
  }

  function emailSection(user) {
    const status = statusLine();
    const methods = signInMethods(session.site);
    const current = user.email
      ? el('p', {}, el('span', { text: user.email }), el('span', { class: user.emailVerified ? 'badge badge-open' : 'badge badge-warn', text: user.emailVerified ? 'Verified' : 'Not verified' }))
      : el('p', { class: 'form-help', text: 'No email on this account yet. Add one for password resets.' });
    const pending = user.pendingEmail ? el('p', { class: 'form-help', text: `Waiting for you to follow the link sent to ${user.pendingEmail}.` }) : null;
    // Without email sending an unverified address can still be set (it claims nothing), a verified one stays until links work.
    const unavailable = !methods.email && user.email && !user.emailVerified ? el('p', { class: 'form-help', text: 'Verification email is not available on this server yet. You can confirm your address once it is.' }) : null;
    const canChange = methods.email || !user.emailVerified;
    const email = field(user.email ? 'New email' : 'Email', el('input', { type: 'email', autocomplete: 'email', maxlength: String(EMAIL_MAX) }));
    const save = el('button', { type: 'submit', class: 'btn', text: user.email ? 'Change email' : 'Add email' });
    const form = canChange
      ? el('form', { class: 'form-grid', novalidate: true }, email.row, el('div', { class: 'form-actions' }, save))
      : el('p', { class: 'form-help', text: 'Your confirmed address can be changed once this server sends verification email.' });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const next = email.input.value.trim();
      if (!next) return status.show('Enter the new email.', 'error');
      const problem = check(() => validEmail(next));
      if (problem) return status.show(problem, 'error');
      await busy(save, status, async () => {
        const r = await withReauth(() => api.changeEmail(next));
        session.user = r.user;
        await renderAccount();
        if (r.user.pendingEmail) notice.show(`Follow the link we sent to ${r.user.pendingEmail} to finish the change.`, 'ok');
        else if (methods.email && !r.user.emailVerified) notice.show(`Saved. Follow the link we sent to ${r.user.email} to confirm it.`, 'ok');
        else notice.show('Saved.', 'ok');
      }, errorText);
    });
    const actions = el('div', { class: 'form-actions' });
    if (user.email && !user.emailVerified && methods.email) {
      const resend = el('button', { type: 'button', class: 'btn btn-small', text: 'Send verification link' });
      resend.addEventListener('click', () => busy(resend, status, async () => {
        await api.resendVerification();
        status.show(`A new link is on its way to ${user.email}. It works once, for 24 hours.`, 'ok');
      }, errorText));
      actions.append(resend);
    }
    return part('Email', { lit: !!user.email && user.emailVerified, detail: user.email ? (user.emailVerified ? 'Verified' : 'Not verified') : 'Not set' }, current, pending, unavailable, status.node, form, actions.childNodes.length ? actions : null).node;
  }

  function passwordSection(user) {
    const status = statusLine();
    const has = !!user.methods?.password;
    const next = field(has ? 'New password' : 'Password', el('input', { type: 'password', autocomplete: 'new-password', minlength: String(ACCOUNT_PASSWORD_MIN), maxlength: String(ACCOUNT_PASSWORD_MAX) }));
    const save = el('button', { type: 'submit', class: 'btn', text: has ? 'Change password' : 'Set a password' });
    // The server asks for a fresh confirmation first (withReauth shows the dialog).
    const form = el('form', { class: 'form-grid', novalidate: true }, next.row, el('div', { class: 'form-actions' }, save));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const problem = check(() => validNewPassword(next.input.value, { username: user.username, email: user.email }));
      if (problem) return status.show(problem, 'error');
      await busy(save, status, async () => {
        const r = await withReauth(() => api.changePassword({ newPassword: next.input.value }));
        session.user = r.user;
        status.show('Password saved. Your other devices are signed out.', 'ok');
        form.reset?.();
      }, errorText);
    });
    const remove = has ? el('button', { type: 'button', class: 'btn btn-small btn-danger', text: 'Remove password' }) : null;
    remove?.addEventListener('click', async () => {
      if (!(await confirmDialog('Remove password', 'You then sign in with a passkey or Discord only.', { confirmText: 'Remove', danger: true }))) return;
      await busy(remove, status, async () => {
        await withReauth(() => api.removePassword());
        renderAccount();
      }, errorText);
    });
    const detail = !has ? 'Not set' : user.passwordChangedAt ? `Changed ${formatDateTime(user.passwordChangedAt)}` : 'Set';
    return part('Password', { lit: has, detail }, status.node, form, remove ? el('div', { class: 'form-actions' }, remove) : null).node;
  }

  function passkeySection(user) {
    const status = statusLine();
    const count = Number(user.methods?.passkeys) || 0;
    const block = part('Passkeys', { lit: count > 0, detail: count ? `${count} ${count === 1 ? 'passkey' : 'passkeys'}` : 'None yet' });
    const list = el('ul', { class: 'item-list', 'aria-label': 'Passkeys' }, el('li', { class: 'form-help', text: 'Loading...' }));
    const load = async () => {
      try {
        const { passkeys } = await api.passkeys();
        block.setDetail(passkeys.length ? `${passkeys.length} ${passkeys.length === 1 ? 'passkey' : 'passkeys'}: ${passkeys.map((p) => p.name).join(', ')}` : 'None yet', passkeys.length > 0);
        if (!passkeys.length) return list.replaceChildren(el('li', { class: 'form-help', text: 'No passkeys yet.' }));
        list.replaceChildren(
          ...passkeys.map((p) => {
            const rename = el('button', { type: 'button', class: 'btn btn-small', text: 'Rename' });
            const del = el('button', { type: 'button', class: 'btn btn-small btn-danger', text: 'Remove' });
            rename.addEventListener('click', async () => {
              const name = await promptText('Rename passkey', 'Name', p.name, 40);
              if (name) await busy(rename, status, async () => (await api.renamePasskey(p.id, name), load()), errorText);
            });
            del.addEventListener('click', async () => {
              if (!(await confirmDialog('Remove passkey', `Remove "${p.name}"? You cannot sign in with it any more.`, { confirmText: 'Remove', danger: true }))) return;
              await busy(del, status, async () => (await withReauth(() => api.deletePasskey(p.id)), load()), errorText);
            });
            return el(
              'li',
              { class: 'item' },
              el('div', {}, el('strong', { text: p.name }), el('span', { class: 'form-help', text: ` Added ${formatDateTime(p.createdAt)}, last used ${formatDateTime(p.lastUsedAt)}.` })),
              p.counterError ? el('p', { class: 'form-status form-status-error', text: 'This passkey reported a sign-in counter that went backwards: it may have been copied. Remove it if you do not recognise this.' }) : null,
              el('div', { class: 'form-actions' }, rename, del),
            );
          }),
        );
      } catch (err) {
        list.replaceChildren(el('li', { class: 'form-status form-status-error', text: errorText(err) }));
      }
    };
    load();
    const add = el('button', { type: 'button', class: 'btn', text: 'Add a passkey' });
    add.hidden = !passkeysAvailable() || !signInMethods(session.site).passkey;
    add.addEventListener('click', () =>
      busy(add, status, async () => {
        const name = await promptText('New passkey', 'Name', 'My device', 40);
        if (!name) return;
        try {
          await withReauth(async () => {
            const { challengeId, credential } = await createPasskey(await api.newPasskeyOptions());
            await api.addPasskey(challengeId, name, credential);
          });
          status.show('Passkey added.', 'ok');
          load();
        } catch (err) {
          if (!isCancel(err)) throw err;
        }
      }, errorText),
    );
    block.node.append(el('p', { class: 'form-help', text: 'Sign in with your fingerprint, face or device PIN instead of a password.' }), status.node, list, el('div', { class: 'form-actions' }, add));
    return block.node;
  }

  function discordSection(user) {
    const status = statusLine();
    const linked = user.methods?.discord;
    const available = signInMethods(session.site).discord;
    if (!linked && !available) return null;
    const parts = [status.node];
    if (linked) {
      parts.push(el('p', { text: `Linked to ${linked.username} since ${formatDateTime(linked.linkedAt)}.` }));
      const unlink = el('button', { type: 'button', class: 'btn btn-small btn-danger', text: 'Unlink Discord' });
      unlink.addEventListener('click', async () => {
        if (!(await confirmDialog('Unlink Discord', 'You then cannot sign in with Discord.', { confirmText: 'Unlink', danger: true }))) return;
        await busy(unlink, status, async () => {
          await withReauth(() => api.unlinkDiscord());
          renderAccount();
        }, errorText);
      });
      parts.push(el('div', { class: 'form-actions' }, unlink));
    } else {
      const link = el('button', { type: 'button', class: 'btn btn-discord', text: 'Link Discord' });
      link.addEventListener('click', () =>
        busy(link, status, async () => {
          const { url } = await withReauth(() => api.discordStart({ mode: 'link', returnTo: '/account/' }));
          navigate(url);
        }, errorText),
      );
      parts.push(el('p', { class: 'form-help', text: 'Then you can sign in with Discord too.' }), el('div', { class: 'form-actions' }, link));
    }
    return part('Discord', { lit: !!linked, detail: linked ? `Linked to ${linked.username}` : 'Not linked' }, ...parts).node;
  }

  /** Password, passkeys and Discord under one heading (the Account board's "Sign-in methods"). */
  function signInSection(user) {
    return section('Sign-in methods', passwordSection(user), passkeySection(user), discordSection(user));
  }

  function sessionsSection() {
    const status = statusLine();
    const list = el('ul', { class: 'item-list', 'aria-label': 'Signed-in devices' }, el('li', { class: 'form-help', text: 'Loading...' }));
    const load = async () => {
      try {
        const { sessions } = await api.sessions();
        list.replaceChildren(
          ...sessions.map((s) => {
            const label = el('strong', { text: s.deviceLabel });
            const rename = el('button', { type: 'button', class: 'btn btn-small', text: 'Rename' });
            const revoke = el('button', { type: 'button', class: 'btn btn-small btn-danger', text: s.current ? 'Sign out here' : 'Sign out' });
            rename.addEventListener('click', async () => {
              const name = await promptText('Rename device', 'Name', s.deviceLabel, 40);
              if (name) await busy(rename, status, async () => (await api.renameSession(s.id, name), load()), errorText);
            });
            revoke.addEventListener('click', () =>
              busy(revoke, status, async () => {
                await api.revokeSession(s.id);
                if (s.current) {
                  await session.setUser(null);
                  render();
                } else load();
              }, errorText),
            );
            return el(
              'li',
              { class: 'item' },
              el('div', {}, label, s.current ? el('span', { class: 'badge badge-open', text: 'This device' }) : null),
              el('p', { class: 'form-help', text: `${s.userAgent}. Signed in ${formatDateTime(s.createdAt)}, last used ${formatDateTime(s.lastUsedAt)}, expires ${formatDateTime(s.expiresAt)}.` }),
              el('div', { class: 'form-actions' }, rename, revoke),
            );
          }),
        );
      } catch (err) {
        list.replaceChildren(el('li', { class: 'form-status form-status-error', text: errorText(err) }));
      }
    };
    load();
    const others = el('button', { type: 'button', class: 'btn', text: 'Sign out everywhere else' });
    others.addEventListener('click', () =>
      busy(others, status, async () => {
        await api.revokeOtherSessions();
        status.show('All other devices are signed out.', 'ok');
        load();
      }, errorText),
    );
    return section('Devices', status.node, list, el('div', { class: 'form-actions' }, others));
  }

  /**
   * Replays kept in the account (docs/accounts-api.md 5.10): the switch
   * `privacy.cloudReplays` of the settings document (the game follows it),
   * what the account uses, and each replay with Watch (in the game),
   * Download and Delete.
   */
  function replaysSection(user) {
    if (session.site?.services?.replays === false) return null;
    const status = statusLine();
    const usage = el('p', { class: 'form-help usage-text', text: 'Loading...' });
    // How full the account's replay space is (a bar as on the Account board; the words above say the same).
    const meter = el('div', { class: 'usage-meter', role: 'meter', 'aria-label': 'Replay space used', 'aria-valuemin': '0', 'aria-valuemax': '100', hidden: true }, el('span', { class: 'usage-fill' }));
    const list = el('ul', { class: 'item-list', 'aria-label': 'Replays' });
    const toggleRow = switchRow('Save replays to my account', {
      help: 'While you are signed in, the game uploads the replay of every game you finish or leave. Online replays hold the other players\' names and the chat.',
    });
    toggleRow.input.disabled = true;
    // The switch lives in the account's settings document: read it, and write it with the version read.
    let doc = null;
    const loadSetting = async () => {
      try {
        doc = await api.settings();
        toggleRow.input.checked = doc.settings?.privacy?.cloudReplays !== false;
        toggleRow.input.disabled = false;
      } catch (err) {
        status.show(errorText(err), 'error');
      }
    };
    const saveSetting = async (on, attempt = 0) => {
      const settings = { ...(doc.settings ?? {}), privacy: { ...(doc.settings?.privacy ?? {}), cloudReplays: on } };
      try {
        const r = await api.putSettings(doc.version, settings);
        doc = r;
        status.show(on ? 'New games are saved to your account.' : 'New games are no longer saved to your account.', 'ok');
      } catch (err) {
        // Changed on another device meanwhile: apply the switch to the newer document.
        if (err instanceof AccountError && err.code === 'version_conflict' && err.detail?.current && attempt < 2) {
          doc = err.detail.current;
          return saveSetting(on, attempt + 1);
        }
        throw err;
      }
    };
    toggleRow.input.addEventListener('change', () =>
      busy(toggleRow.input, status, async () => {
        try {
          await saveSetting(toggleRow.input.checked);
        } catch (err) {
          toggleRow.input.checked = !toggleRow.input.checked;
          throw err;
        }
      }, errorText),
    );
    const load = async () => {
      try {
        const data = await api.replays();
        const share = data.limits?.bytes > 0 ? Math.min(1, Math.max(0, (Number(data.usage?.bytes) || 0) / data.limits.bytes)) : 0;
        meter.hidden = !(data.limits?.bytes > 0);
        meter.setAttribute('aria-valuenow', String(Math.round(share * 100)));
        meter.setAttribute('aria-valuetext', usageText(data.usage, data.limits));
        meter.style.setProperty('--fill', `${(share * 100).toFixed(1)}%`);
        usage.textContent = `${usageText(data.usage, data.limits)}. Each replay is kept for ${Math.round(data.limits.retentionMs / 86400000)} days; when a new one does not fit, the oldest go first.`;
        if (!data.replays.length) return list.replaceChildren(el('li', { class: 'form-help', text: 'No replays yet.' }));
        list.replaceChildren(
          ...data.replays.map((r) => {
            // Watch opens the game, which loads the replay from the account (#replay=<id>).
            const watch = user.canPlay ? el('a', { class: 'btn btn-small btn-primary', href: `/play/#replay=${r.id}`, text: 'Watch' }) : null;
            const download = el('button', { type: 'button', class: 'btn btn-small', text: 'Download' });
            const del = el('button', { type: 'button', class: 'btn btn-small btn-danger', text: 'Delete' });
            download.addEventListener('click', () =>
              busy(download, status, async () => {
                const { text, name } = await api.downloadReplay(r.id);
                saveBlob(new Blob([text], { type: 'application/json' }), name);
              }, errorText),
            );
            del.addEventListener('click', async () => {
              if (!(await confirmDialog('Delete replay', `Delete the replay "${r.title}" from your account?`, { confirmText: 'Delete', danger: true }))) return;
              await busy(del, status, async () => (await api.deleteReplay(r.id), load()), errorText);
            });
            return el(
              'li',
              { class: 'item' },
              el('div', {}, el('strong', { text: r.title }), el('span', { class: 'form-help', text: ` WebRA ${r.engine}` })),
              el('p', { class: 'form-help', text: `${replayLine(r)}.` }),
              el('div', { class: 'form-actions' }, watch, download, del),
            );
          }),
        );
      } catch (err) {
        usage.textContent = '';
        list.replaceChildren(el('li', { class: 'form-status form-status-error', text: errorText(err) }));
      }
    };
    loadSetting();
    load();
    // Added or deleted in the game or another tab, or the switch changed there (realtime hints).
    if (session.realtime) follows.push(session.realtime.subscribe('replays', () => load()), session.realtime.subscribe('settings', () => loadSetting()));
    return section('Replays', toggleRow.row, status.node, usage, meter, list);
  }

  /**
   * Friends (docs/accounts-api.md 5.11, the Friends board): who is in a
   * game, in a lobby, online or offline, with Join and Spectate where the
   * friend allows it; requests and lobby invites; adding and blocking by
   * username; and the three privacy switches (settings `social.*`, which the
   * server applies). The game's FriendsStore keeps the list: it loads on
   * every realtime hint and polls as a safety net while the tab is visible
   * (js/account/friends.js). Returns `{ node, start, stop, refresh }`; a
   * server without the routes (404) gets a line saying so.
   */
  function friendsSection(user) {
    const client = deps.friends ?? new FriendsClient(api);
    const store = new FriendsStore({ client, timers: deps.timers ?? globalThis, realtime: session.realtime });
    const status = statusLine();
    let doc = null;
    let settingsDoc = null;
    let offs = [];

    const friendError = (err) => {
      if (err instanceof AccountError) {
        if (err.code === 'not_found') return 'No player with this name.';
        if (err.code === 'blocked') return 'You blocked this player. Unblock them first.';
        if (err.code === 'conflict') return 'You are friends already, or you asked already.';
        if (err.code === 'limit') return 'You reached the most friends or open requests.';
        if (err.code === 'rate_limited') return 'Too many requests. Try again in an hour.';
      }
      return errorText(err);
    };
    /** Run an action, then load the list again; resolves with the action's answer. */
    const act = (fn) => store.act(fn);
    const button = (text, cls, onClick, label) => {
      const b = el('button', { type: 'button', class: `btn btn-small ${cls}`.trim(), text, 'aria-label': label });
      b.addEventListener('click', () => busy(b, status, onClick, friendError));
      return b;
    };
    const avatar = (p) => {
      const a = el('span', { class: 'friend-avatar', 'aria-hidden': 'true', text: (p.displayName || p.username || '?').slice(0, 1).toUpperCase() });
      if (/^#[0-9a-f]{6}$/i.test(p.avatarColor ?? '')) a.style.setProperty('--avatar', p.avatarColor);
      return a;
    };
    const nameOf = (p) => (p.displayName && p.displayName !== p.username ? `${p.displayName} (${p.username})` : p.username);
    const nameForm = (label, buttonText, buttonClass, run) => {
      const f = field(label, el('input', { type: 'text', autocomplete: 'off', spellcheck: 'false', maxlength: String(USERNAME_MAX) }));
      const b = el('button', { type: 'submit', class: `btn ${buttonClass}`, text: buttonText });
      const form = el('form', { class: 'friends-add', novalidate: true }, f.row, b);
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = f.input.value.trim();
        if (!name) return status.show(`Enter the username of the player to ${buttonText.toLowerCase()}.`, 'error');
        await busy(b, status, async () => {
          await run(name);
          f.input.value = '';
        }, friendError);
      });
      return form;
    };

    // Who you are (friends add you by this name).
    const summary = el('span', { class: 'friends-summary ui-num', text: 'Loading...' });
    const copy = el('button', { type: 'button', class: 'btn btn-small', text: 'Copy', 'aria-label': 'Copy your username' });
    copy.addEventListener('click', async () => {
      try {
        await globalThis.navigator.clipboard.writeText(user.username);
        status.show('Your username is copied. Friends add you with it.', 'ok');
      } catch {
        status.show(`Your username is ${user.username}.`, 'info');
      }
    });
    const head = el('div', { class: 'friends-head' }, summary, el('span', { class: 'friends-me' }, el('span', { class: 'part-detail', text: 'Your username' }), el('strong', { text: user.username }), copy));

    const search = el('input', { type: 'search', class: 'friends-search', 'aria-label': 'Search friends', placeholder: 'Search friends', autocomplete: 'off' });
    search.addEventListener('input', () => paint());
    const list = el('div', { class: 'friends-list' });
    const invites = el('div', { class: 'friends-block', hidden: true });
    const requests = el('div', { class: 'friends-block' });
    const blocked = el('div', { class: 'friends-block' });
    const addForm = nameForm('Username', 'Send request', 'btn-primary', async (name) => {
      const r = await act(() => client.request(name));
      status.show(r?.friend ? `You and ${r.friend.username} are friends now.` : `Request sent to ${name}. They see it next time they look.`, 'ok');
    });
    const blockForm = nameForm('Block a player', 'Block', 'btn-danger', async (name) => {
      await act(() => client.block(name));
      status.show(`${name} is blocked.`, 'info');
    });

    function friendRow({ friend: f, status: st }) {
      const sess = f.session && typeof f.session.id === 'string' ? f.session : null;
      const actions = el('span', { class: 'friend-actions' });
      if (user.canPlay && sess?.joinable) actions.append(el('a', { class: 'btn btn-small btn-primary', href: `/play/?join=${encodeURIComponent(sess.id)}`, text: 'Join', 'aria-label': `Join ${f.username}'s lobby` }));
      if (user.canPlay && sess?.spectatable) actions.append(el('a', { class: 'btn btn-small', href: `/play/?join=${encodeURIComponent(sess.id)}`, text: 'Spectate', 'aria-label': `Watch ${f.username}'s game` }));
      actions.append(
        el(
          'details',
          { class: 'friend-more' },
          el('summary', { class: 'btn btn-small', 'aria-label': `More for ${f.username}`, text: 'More' }),
          el(
            'span',
            { class: 'friend-more-actions' },
            button('Remove', '', async () => {
              if (!(await confirmDialog('Remove friend', `Remove ${f.username} from your friends? Invites between you end too.`, { confirmText: 'Remove' }))) return;
              await act(() => client.remove(f.username));
              status.show(`${f.username} is no longer your friend.`, 'info');
            }, `Remove ${f.username}`),
            button('Block', 'btn-danger', async () => {
              if (!(await confirmDialog('Block player', `Block ${f.username}? They can no longer send you requests or invites, or join your lobby.`, { confirmText: 'Block', danger: true }))) return;
              await act(() => client.block(f.username));
              status.show(`${f.username} is blocked.`, 'info');
            }, `Block ${f.username}`),
          ),
        ),
      );
      return el(
        'li',
        { class: `friend-row friend-${st.group}` },
        avatar(f),
        el('span', { class: 'friend-text' }, el('strong', { text: nameOf(f) }), el('span', { class: `friend-status state-${st.led}` }, el('span', { class: 'lamp', 'aria-hidden': 'true' }), el('span', { text: st.text }))),
        actions,
      );
    }

    const blockTitle = (text, n) => el('h3', { class: 'friends-block-title' }, el('span', { text }), n ? el('span', { class: 'count', text: String(n) }) : null);
    const personRow = (p, detail, ...buttons) => el('li', { class: 'friend-row' }, avatar(p), el('span', { class: 'friend-text' }, el('strong', { text: nameOf(p) }), detail ? el('span', { class: 'part-detail', text: detail }) : null), el('span', { class: 'friend-actions' }, ...buttons));

    function paint() {
      if (!doc) return;
      const friends = Array.isArray(doc.friends) ? doc.friends : [];
      summary.textContent = friends.length ? friendsSummary(friends) : 'No friends yet';
      const groups = groupFriends(friends, search.value);
      if (!friends.length) list.replaceChildren(el('p', { class: 'form-help', text: 'Add a friend by username, or accept a request.' }));
      else if (!groups.length) list.replaceChildren(el('p', { class: 'form-help', text: 'No friend matches your search.' }));
      else list.replaceChildren(...groups.map((g) => el('div', { class: 'friend-group' }, el('h3', { class: 'friend-group-title', text: `${g.title} (${g.people.length})` }), el('ul', { class: 'friend-rows' }, ...g.people.map(friendRow)))));

      // Lobby invites from friends: Join opens the lobby by its code (/join/<code>).
      const got = Array.isArray(doc.invites) ? doc.invites : [];
      invites.hidden = !got.length;
      invites.replaceChildren(
        blockTitle('Invites', got.length),
        el(
          'ul',
          { class: 'friend-rows' },
          ...got.map((i) => {
            const code = normalizeInviteCode(String(i.code ?? ''));
            const what = [typeof i.name === 'string' && i.name ? i.name : 'a lobby', inviteSummary(i)].filter(Boolean).join(' · ');
            return el(
              'li',
              { class: 'friend-row' },
              el('span', { class: 'lamp', 'aria-hidden': 'true' }),
              el('span', { class: 'friend-text' }, el('strong', { text: `${i.username} invites you` }), el('span', { class: 'part-detail', text: what })),
              el(
                'span',
                { class: 'friend-actions' },
                ...present(
                  user.canPlay && code ? el('a', { class: 'btn btn-small btn-primary', href: invitePath(code), text: 'Join', 'aria-label': `Join ${i.username}'s lobby by invite` }) : null,
                  button('Dismiss', '', async () => act(() => client.dismissInvite(i.username)), `Dismiss the invite from ${i.username}`),
                ),
              ),
            );
          }),
        ),
      );

      // Requests: incoming with Accept and Ignore; sent ones with Withdraw.
      const incoming = Array.isArray(doc.incoming) ? doc.incoming : [];
      const outgoing = Array.isArray(doc.outgoing) ? doc.outgoing : [];
      requests.replaceChildren(
        ...present(
          blockTitle('Requests', incoming.length),
          incoming.length
            ? el(
                'ul',
                { class: 'friend-rows' },
                ...incoming.map((r) =>
                  personRow(
                    r,
                    `Asked ${formatDateTime(r.createdAt)}`,
                    button('Accept', 'btn-primary', async () => {
                      await act(() => client.accept(r.username));
                      status.show(`You and ${r.username} are friends now.`, 'ok');
                    }, `Accept ${r.username}`),
                    button('Ignore', '', async () => {
                      await act(() => client.ignore(r.username));
                      status.show(`The request from ${r.username} is hidden.`, 'info');
                    }, `Ignore ${r.username}`),
                  ),
                ),
              )
            : el('p', { class: 'form-help', text: 'No requests waiting.' }),
          outgoing.length ? el('ul', { class: 'friend-rows', 'aria-label': 'Sent requests' }, ...outgoing.map((r) => personRow(r, 'Sent, waiting for an answer', button('Withdraw', '', async () => act(() => client.withdraw(r.username)), `Withdraw the request to ${r.username}`)))) : null,
        ),
      );

      // Blocked players with Unblock (the form to block by name stays, so typing survives a poll).
      const blocks = Array.isArray(doc.blocked) ? doc.blocked : [];
      blocked.replaceChildren(
        ...present(
          blockTitle('Blocked players', blocks.length),
          el('p', { class: 'form-help', text: 'Blocked players cannot send you requests or invites, or join a lobby you are in.' }),
          blocks.length ? el('ul', { class: 'friend-rows' }, ...blocks.map((b) => personRow(b, null, button('Unblock', '', async () => act(() => client.unblock(b.username)), `Unblock ${b.username}`)))) : null,
        ),
      );
    }

    // Privacy: the social settings of the account's settings document (the server applies them).
    const switches = [
      ['showOnline', 'Show me as online', 'Friends see when you are around. Off: you look offline to them.'],
      ['friendsJoin', 'Friends can join my lobby', 'Without an invite, if there is room.'],
      ['allowSpectate', 'Allow spectators', 'Friends can watch your games.'],
    ].map(([key, label, help]) => {
      const row = switchRow(label, { help });
      row.input.disabled = true;
      row.input.addEventListener('change', () =>
        busy(row.input, status, async () => {
          try {
            await saveSocial(key, row.input.checked);
            status.show('Saved.', 'ok');
          } catch (err) {
            row.input.checked = !row.input.checked;
            throw err;
          }
        }, errorText),
      );
      return [key, row];
    });
    const loadSocial = async () => {
      try {
        settingsDoc = await api.settings();
        const social = socialSettings(settingsDoc.settings);
        for (const [key, row] of switches) {
          row.input.checked = social[key];
          row.input.disabled = false;
        }
      } catch (err) {
        status.show(errorText(err), 'error');
      }
    };
    const saveSocial = async (key, on, attempt = 0) => {
      const settings = { ...(settingsDoc.settings ?? {}), social: { ...(settingsDoc.settings?.social ?? {}), [key]: on } };
      try {
        settingsDoc = await api.putSettings(settingsDoc.version, settings);
      } catch (err) {
        // Changed on another device meanwhile: apply the switch to the newer document.
        if (err instanceof AccountError && err.code === 'version_conflict' && err.detail?.current && attempt < 2) {
          settingsDoc = err.detail.current;
          return saveSocial(key, on, attempt + 1);
        }
        throw err;
      }
    };

    const node = section(
      'Friends',
      head,
      status.node,
      el(
        'div',
        { class: 'friends-grid' },
        el('div', { class: 'friends-col' }, search, list),
        el(
          'div',
          { class: 'friends-col' },
          invites,
          requests,
          el('div', { class: 'friends-block' }, blockTitle('Add a friend'), addForm),
          el('div', { class: 'friends-block friends-privacy' }, blockTitle('Privacy'), ...switches.map(([, r]) => r.row)),
          el('div', { class: 'friends-block' }, blocked, blockForm),
        ),
      ),
    );

    const onError = (err) => {
      if (err instanceof AccountError && err.status === 404) {
        // A server without friends yet: say so and stop asking.
        store.stop();
        summary.textContent = 'Not available';
        list.replaceChildren(el('p', { class: 'form-help', text: 'Friends are not available on this server yet.' }));
        return;
      }
      status.show(errorText(err), 'error');
    };

    return {
      node,
      start() {
        if (store.running) return;
        offs = [
          store.on('change', (d) => {
            doc = d;
            paint();
          }),
          store.on('error', onError),
          // The privacy switches changed in another tab or the game.
          session.realtime?.subscribe('settings', () => loadSocial()) ?? (() => {}),
        ];
        store.start();
        loadSocial();
      },
      stop() {
        store.stop();
        for (const off of offs) off();
        offs = [];
      },
      refresh: () => store.refresh(),
    };
  }

  function dataSection(user) {
    const status = statusLine();
    const exportButton = el('button', { type: 'button', class: 'btn', text: 'Download my data' });
    exportButton.addEventListener('click', () =>
      busy(exportButton, status, async () => {
        const { blob, name } = await withReauth(() => api.exportData());
        saveBlob(blob, name);
        status.show('Your data is downloaded.', 'ok');
      }, errorText),
    );
    // The striped danger button of the design system (the word on a well); the dialog still asks for the username.
    const del = el('button', { type: 'button', class: 'btn btn-hazard' }, el('span', { text: 'Delete my account' }));
    del.addEventListener('click', async () => {
      const typed = await promptText('Delete account', `Type your username (${user.username}) to delete your account. It is removed for good after 30 days.`, '', 24, 'Delete');
      if (typed === null) return;
      if (typed !== user.username) return status.show('The username did not match. Nothing was deleted.', 'error');
      await busy(del, status, async () => {
        await withReauth(() => api.deleteAccount(typed));
        await session.setUser(null);
        notice.show('Your account is deleted. Goodbye, commander.', 'info');
        render();
      }, errorText);
    });
    return section(
      'Your data',
      el('p', { class: 'form-help' }, el('span', { text: 'What we keep and why: ' }), el('a', { href: session.site?.privacyUrl ?? '/privacy.html', text: 'privacy notice' }), el('span', { text: '.' })),
      status.node,
      el('div', { class: 'form-actions' }, exportButton, del),
    );
  }

  function promptText(title, label, value = '', max = 40, confirmText = 'Save') {
    return openDialog(title, (body, close) => {
      const f = field(label, el('input', { type: 'text', value, maxlength: String(max) }));
      const ok = el('button', { type: 'submit', class: 'btn btn-primary', text: confirmText });
      const form = el('form', { class: 'form-stack', novalidate: true }, f.row, el('div', { class: 'form-actions' }, ok));
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        close(f.input.value.trim());
      });
      body.append(form);
    });
  }

  render();
  return { session, render };
}

const root = globalThis.document?.getElementById?.('account-root');
if (root) mountAccountPage(root);
