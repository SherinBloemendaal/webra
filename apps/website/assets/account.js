// The account page (/account/): sign in, sign up, email verification and
// password reset links, Discord returns, and for a signed-in player the
// profile, password, email, passkeys, Discord, sessions, data export and
// account deletion (docs/accounts-api.md 3 to 5).
//
// Links from emails land here with the token in the fragment
// (#verify=<token>, #reset=<token>); Discord comes back with #discord=ok or
// #discord=error&code=<code>. The fragment is removed at once.

import { AccountApi, AccountError, errorText, formatDateTime } from '/play/js/account/api.js';
import { AccountSession, accountState, signInMethods } from '/play/js/account/session.js';
import { createPasskey, getPasskey, isCancel, passkeysAvailable } from '/play/js/account/passkey.js';
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
} from '/play/protocol/accounts.js';
import { el, field, checkbox, statusLine, openDialog, confirmDialog, busy, saveBlob } from './ui.js';

const TOKEN = /^[A-Za-z0-9_-]{20,200}$/;

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
 * @param {{ api?: AccountApi, location?: Location, history?: History, navigate?: (url: string) => void }} [deps]
 */
export async function mountAccountPage(root, deps = {}) {
  const api = deps.api ?? new AccountApi();
  const loc = deps.location ?? globalThis.location;
  const hist = deps.history ?? globalThis.history;
  const navigate = deps.navigate ?? ((url) => loc.assign(url));
  const session = new AccountSession({ api });
  const notice = statusLine();
  const view = el('div', { class: 'account-view' });
  root.replaceChildren(notice.node, view);

  const fragment = parseFragment(loc.hash);
  if (fragment.kind) hist.replaceState(null, '', loc.pathname + loc.search);

  await session.refresh();
  if (session.error && !session.site) {
    notice.show(errorText(session.error), 'error');
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
    if (fragment.ok) notice.show('Discord: done.', 'ok');
    else notice.show(DISCORD_ERRORS[fragment.code] ?? 'Discord sign-in did not work. Try again.', 'error');
  }
  if (fragment.kind === 'signup' || fragment.kind === 'forgot') start = fragment.kind;

  const render = () => {
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
    if (session.site?.motd) view.replaceChildren(el('p', { class: 'notice', text: session.site.motd }));
    else view.replaceChildren();
    if (tab === 'signin') panel.append(signInForm(methods));
    else if (tab === 'signup') panel.append(signUpForm(methods));
    else panel.append(forgotForm());
    view.append(el('div', { class: 'panel form-card' }, list, panel));
  }

  function discordButton(label, mode, status, { privacy } = {}) {
    const b = el('button', { type: 'button', class: 'btn btn-discord', text: label });
    b.addEventListener('click', () =>
      busy(b, status, async () => {
        if (privacy && !privacy.checked) throw new Error('Accept the privacy notice first.');
        const { url } = await api.discordStart({ mode, returnTo: '/account/', ...(mode === 'signup' ? { acceptPrivacy: true } : {}) });
        navigate(url);
      }, errorText),
    );
    return b;
  }

  function signInForm(methods) {
    const status = statusLine();
    const out = el('div', { class: 'form-stack' }, status.node);
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
    if (methods.passkey) {
      const b = el('button', { type: 'button', class: 'btn', text: 'Sign in with a passkey' });
      b.addEventListener('click', () =>
        busy(b, status, async () => {
          try {
            const { challengeId, credential } = await getPasskey(await api.passkeyOptions());
            const r = await api.passkeyLogin(challengeId, credential);
            await session.setUser(r.user);
            render();
          } catch (err) {
            if (!isCancel(err)) throw err;
          }
        }, errorText),
      );
      others.append(b);
    }
    if (methods.discord) others.append(discordButton('Sign in with Discord', 'login', status));
    if (others.childNodes.length) out.append(others);
    if (!methods.password && !methods.passkey && !methods.discord) out.append(el('p', { class: 'notice', text: 'Signing in is switched off right now.' }));
    return out;
  }

  function signUpForm(methods) {
    const status = statusLine();
    const site = session.site;
    if (site && site.registration?.open === false) return el('p', { class: 'notice', text: 'Signing up is closed right now. Check back later.' });
    const policy = site?.policy ?? { usernameMin: USERNAME_MIN, usernameMax: USERNAME_MAX, passwordMin: ACCOUNT_PASSWORD_MIN, passwordMax: ACCOUNT_PASSWORD_MAX, displayNameMax: DISPLAY_NAME_MAX };
    const emailRequired = !!site?.registration?.emailVerificationRequired;
    const username = field('Username', el('input', { type: 'text', autocomplete: 'username', required: true, minlength: String(policy.usernameMin), maxlength: String(policy.usernameMax), spellcheck: 'false' }), {
      help: `${policy.usernameMin} to ${policy.usernameMax} characters: letters, digits, space, _ - and . Shown in lobbies.`,
    });
    const displayName = field('Display name (optional)', el('input', { type: 'text', autocomplete: 'nickname', maxlength: String(policy.displayNameMax) }));
    const email = field(emailRequired ? 'Email' : 'Email (optional)', el('input', { type: 'email', autocomplete: 'email', maxlength: String(EMAIL_MAX), required: emailRequired }), {
      help: emailRequired ? 'We send a link to verify it.' : 'For password resets. We send a link to confirm it. You can add it later.',
    });
    // Addresses are only taken once they can be confirmed: no email field while this server sends no email.
    email.row.hidden = !methods.email;
    const usePasskey = methods.passkey && methods.password ? checkbox('Use a passkey instead of a password') : null;
    const password = field('Password', el('input', { type: 'password', autocomplete: 'new-password', minlength: String(policy.passwordMin), maxlength: String(policy.passwordMax) }), {
      help: `At least ${policy.passwordMin} characters. A long phrase is best.`,
    });
    const privacyUrl = site?.privacyUrl ?? '/privacy.html';
    const privacy = el('input', { type: 'checkbox', id: 'signup-privacy', required: true });
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
      if (emailRequired && !email.input.value.trim()) return status.show('Enter your email.', 'error');
      const emailProblem = email.input.value.trim() ? check(() => validEmail(email.input.value.trim())) : null;
      if (emailProblem) return status.show(emailProblem, 'error');
      const withPasskey = passkeyOnly || !!usePasskey?.input.checked;
      const pwProblem = withPasskey ? null : check(() => validNewPassword(password.input.value, { username: name, email: email.input.value.trim() || null }));
      if (pwProblem) return status.show(pwProblem, 'error');
      const input = { username: name, acceptPrivacy: true };
      if (displayName.input.value.trim()) input.displayName = displayName.input.value.trim();
      if (email.input.value.trim()) input.email = email.input.value.trim();
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
        notice.show('Your account is created.', 'ok');
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
    if (methods.discord) out.append(el('p', { class: 'form-help', text: 'Or create the account with Discord (accept the privacy notice above first):' }), el('div', { class: 'form-actions' }, discordButton('Sign up with Discord', 'signup', status, { privacy })));
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
  function section(title, ...children) {
    const id = `section-${title.toLowerCase().replace(/[^a-z]+/g, '-')}`;
    return el('section', { class: 'panel account-section', 'aria-labelledby': id }, el('h2', { id, text: title }), ...children);
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
    const state = accountState(user);
    const parts = [];
    if (session.site?.motd) parts.push(el('p', { class: 'notice', text: session.site.motd }));
    const signOut = el('button', { type: 'button', class: 'btn', text: 'Sign out' });
    signOut.addEventListener('click', async () => {
      await session.signOut().catch(() => {});
      notice.show('You are signed out.', 'info');
      render();
    });
    const head = el(
      'div',
      { class: 'panel account-head' },
      el('div', { class: 'account-who' }, el('strong', { class: 'account-username', text: user.username }), user.displayName && user.displayName !== user.username ? el('span', { class: 'account-display', text: user.displayName }) : null, roleBadge(user.role)),
      el('div', { class: 'form-actions' }, el('a', { class: 'btn btn-primary', href: '/play/', text: 'Play' }), signOut),
    );
    parts.push(head);
    if (state.kind !== 'active') {
      const box = el('div', { class: `notice account-state account-state-${state.kind}`, role: 'status' }, el('strong', { text: `${state.label}. ` }), el('span', { text: state.text }));
      if (state.kind === 'pending_email' && user.email) {
        const resend = el('button', { type: 'button', class: 'btn btn-small', text: 'Send the link again' });
        const s = statusLine();
        resend.addEventListener('click', () => busy(resend, s, async () => {
          await api.resendVerification();
          s.show(`A new link is on its way to ${user.email}.`, 'ok');
        }, errorText));
        box.append(el('div', { class: 'form-actions' }, resend), s.node);
      }
      parts.push(box);
    }
    parts.push(profileSection(user), emailSection(user), passwordSection(user), passkeySection(), discordSection(user), sessionsSection(), dataSection(user));
    view.replaceChildren(...parts);
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
    const color = field('Colour', el('input', { type: 'color', value: user.avatarColor ?? '#4a82c4' }));
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
    return section('Profile', el('p', { class: 'form-help', text: `Account created ${formatDateTime(user.createdAt)}.` }), status.node, form);
  }

  function emailSection(user) {
    const status = statusLine();
    const methods = signInMethods(session.site);
    const current = user.email
      ? el('p', {}, el('span', { text: user.email }), el('span', { class: user.emailVerified ? 'badge badge-open' : 'badge badge-warn', text: user.emailVerified ? 'Verified' : 'Not verified' }))
      : el('p', { class: 'form-help', text: 'No email on this account.' });
    const pending = user.pendingEmail ? el('p', { class: 'form-help', text: `Waiting for you to follow the link sent to ${user.pendingEmail}.` }) : null;
    const email = field('New email', el('input', { type: 'email', autocomplete: 'email', maxlength: String(EMAIL_MAX) }));
    const save = el('button', { type: 'submit', class: 'btn', text: user.email ? 'Change email' : 'Add email' });
    // A new address takes effect through its confirmation link, so this needs email sending on the server.
    const form = methods.email
      ? el('form', { class: 'form-grid', novalidate: true }, email.row, el('div', { class: 'form-actions' }, save))
      : el('p', { class: 'form-help', text: 'Email addresses can be added once this server sends email.' });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!email.input.value.trim()) return status.show('Enter the new email.', 'error');
      await busy(save, status, async () => {
        const r = await withReauth(() => api.changeEmail(email.input.value.trim()));
        session.user = r.user;
        status.show('Follow the link we sent to the new address to finish the change.', 'ok');
        renderAccount();
      }, errorText);
    });
    const actions = el('div', { class: 'form-actions' });
    if (user.email && !user.emailVerified && methods.email) {
      const resend = el('button', { type: 'button', class: 'btn btn-small', text: 'Send verification link' });
      resend.addEventListener('click', () => busy(resend, status, async () => {
        await api.resendVerification();
        status.show('A new link is on its way.', 'ok');
      }, errorText));
      actions.append(resend);
    }
    if (user.email && !session.site?.registration?.emailVerificationRequired) {
      const remove = el('button', { type: 'button', class: 'btn btn-small btn-danger', text: 'Remove email' });
      remove.addEventListener('click', async () => {
        if (!(await confirmDialog('Remove email', 'Without an email you cannot reset your password by email.', { confirmText: 'Remove', danger: true }))) return;
        await busy(remove, status, async () => {
          await withReauth(() => api.removeEmail());
          renderAccount();
        }, errorText);
      });
      actions.append(remove);
    }
    return section('Email', current, pending, status.node, form, actions.childNodes.length ? actions : null);
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
    return section('Password', status.node, form, remove ? el('div', { class: 'form-actions' }, remove) : null);
  }

  function passkeySection() {
    const status = statusLine();
    const list = el('ul', { class: 'item-list', 'aria-label': 'Passkeys' }, el('li', { class: 'form-help', text: 'Loading...' }));
    const load = async () => {
      try {
        const { passkeys } = await api.passkeys();
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
    return section('Passkeys', el('p', { class: 'form-help', text: 'Sign in with your fingerprint, face or device PIN instead of a password.' }), status.node, list, el('div', { class: 'form-actions' }, add));
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
    return section('Discord', ...parts);
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
    const del = el('button', { type: 'button', class: 'btn btn-danger', text: 'Delete my account' });
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
