// The dialogs of the online screens and the friends screen: a modal card
// (`modal`), a yes/no question (`confirmChoice`) and "Join with a code"
// (`joinCodeDialog`, the InviteCode board): six cells that fill as the
// player types, the dash by itself, a pasted link works too; once the code
// is complete it is looked up (js/invites.js) and the lobby shows, or why
// not (unknown, expired, full: then as a spectator).

import { lookupInvite } from './invites.js';
import { inviteInput, inviteResult } from './online-view.js';
import { badge } from './ui/controls.js';

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function button(label, className, onClick) {
  const b = el('button', className ? `online-btn ${className}` : 'online-btn', label);
  b.type = 'button';
  if (onClick) b.addEventListener('click', onClick);
  return b;
}

/**
 * Show a modal built by `build(body, close, dialog)`; resolves with what
 * close() got. Escape cancels (resolves null). `className` adds to the card.
 */
export function modal(title, build, { className = '' } = {}) {
  return new Promise((resolve) => {
    const dialog = el('dialog', `online-dialog${className ? ` ${className}` : ''}`);
    const heading = el('h2', 'online-dialog-title', title);
    heading.id = `online-dialog-${++dialogs}`;
    dialog.setAttribute('aria-labelledby', heading.id);
    dialog.append(heading);
    const body = el('div', 'online-dialog-body');
    dialog.append(body);
    let done = false;
    const close = (value) => {
      if (done) return;
      done = true;
      dialog.close();
      dialog.remove();
      resolve(value);
    };
    dialog.addEventListener('cancel', (e) => {
      e.preventDefault();
      close(null);
    });
    build(body, close, dialog);
    document.body.append(dialog);
    dialog.showModal();
  });
}
let dialogs = 0;

/**
 * A question with two answers; resolves true for `yes`. `danger`: the yes
 * button is the red one (removing, blocking, starting with a poor connection).
 */
export function confirmChoice(title, text, { yes = 'OK', no = 'Cancel', danger = false } = {}) {
  return modal(title, (body, close) => {
    body.append(el('p', 'online-dialog-text', text));
    const row = el('div', 'online-dialog-actions');
    const ok = button(yes, danger ? 'online-btn-danger' : 'online-btn-primary', () => close(true));
    row.append(button(no, null, () => close(false)), ok);
    body.append(row);
    queueMicrotask(() => ok.focus?.());
  }).then((v) => v === true);
}

/** How long typing pauses before a complete code is looked up. */
export const LOOKUP_DELAY_MS = 250;

/**
 * "Join with a code". Resolves `{ session, name, locked, spectate }` for the
 * lobby to join, or null. `initial`: a code from the address bar
 * (`/join/<code>`), looked up at once. `rtt`: the browser's round trip to the
 * server for the lobby card. `lookup`: js/invites.js lookupInvite (tests).
 */
export function joinCodeDialog({ initial = '', version, rtt = null, lookup = lookupInvite, timers = globalThis } = {}) {
  return modal(
    'Join with a code',
    (body, close) => {
      const intro = el('p', 'online-dialog-text', 'Type the six characters a friend gave you. The dash fills in by itself, and a pasted link works too.');
      intro.id = `invite-intro-${dialogs}`;
      // The cells are a picture of the field; the real field lies over them (so a tap opens the keyboard).
      const box = el('div', 'invite-code');
      const cells = el('div', 'invite-code-cells');
      cells.setAttribute('aria-hidden', 'true');
      const cellEls = [];
      for (let i = 0; i < 6; i++) {
        if (i === 3) cells.append(el('span', 'invite-code-dash', '-'));
        const c = el('span', 'invite-code-cell');
        cellEls.push(c);
        cells.append(c);
      }
      const input = el('input', 'invite-code-input');
      input.type = 'text';
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.setAttribute('autocapitalize', 'characters');
      input.setAttribute('aria-label', 'Invite code');
      input.setAttribute('aria-describedby', intro.id);
      input.maxLength = 512;
      box.append(cells, input);

      const card = el('div', 'invite-result');
      card.setAttribute('role', 'status');
      card.setAttribute('aria-live', 'polite');
      const actions = el('div', 'online-dialog-actions');
      const join = button('Join lobby', 'online-btn-primary', () => submit());
      join.disabled = true;
      actions.append(button('Cancel', null, () => close(null)), join);
      body.append(intro, box, card, actions);

      let seq = 0;
      let timer = null;
      let view = inviteResult(null);
      let state = inviteInput('');

      const paintCells = () => {
        const at = state.cells.findIndex((c) => c === '');
        cellEls.forEach((c, i) => {
          c.textContent = state.cells[i] || '';
          c.classList.toggle('is-next', i === at);
          c.classList.toggle('is-filled', !!state.cells[i]);
        });
        box.classList.toggle('is-session', !!state.sessionId);
      };
      const paintCard = () => {
        card.textContent = '';
        card.className = `invite-result invite-result-${view.kind}`;
        join.textContent = view.action ?? 'Join lobby';
        join.disabled = !view.canJoin;
        if (view.kind === 'idle') return;
        if (view.kind === 'busy') {
          card.append(el('span', 'online-muted', 'Looking the code up...'));
          return;
        }
        if (view.kind === 'session') {
          card.append(el('span', 'invite-result-title', 'A session link'), el('span', 'online-muted', 'Joins the session this link names.'));
          return;
        }
        if (view.title) {
          const head = el('div', 'invite-result-head');
          head.append(el('span', 'invite-result-title', view.title));
          if (view.locked) head.append(badge('locked', 'Password'));
          card.append(head, el('span', 'invite-result-sub', view.sub));
        }
        if (view.kind === 'error' || view.kind === 'full') {
          const line = el('p', view.kind === 'full' ? 'invite-result-note' : 'invite-result-error');
          const word = { unknown: 'Unknown', expired: 'Expired', invalid: 'Not a code', rate_limited: 'Wait', offline: 'Offline', version: 'Other version' }[view.reason] ?? 'Full';
          line.append(badge(view.kind === 'full' ? 'warn' : 'bad', word), el('span', null, view.message));
          card.append(line);
        }
      };

      const check = async () => {
        const n = ++seq;
        if (state.sessionId) {
          view = { kind: 'session', canJoin: true, action: 'Join', sessionId: state.sessionId };
          paintCard();
          return;
        }
        if (!state.complete) {
          view = inviteResult(null);
          paintCard();
          return;
        }
        view = { kind: 'busy', canJoin: false, action: 'Join lobby' };
        paintCard();
        let r;
        try {
          r = await lookup(state.code);
        } catch (err) {
          r = { ok: false, reason: 'offline', message: err?.message ?? String(err) };
        }
        if (n !== seq) return;
        view = inviteResult(r, { version, rtt });
        paintCard();
      };

      const onInput = (immediate = false) => {
        state = inviteInput(input.value);
        // A code shows with its dash (also one taken from a pasted link); a long session id or a
        // link still being typed stays as it is.
        if (!state.sessionId && input.value !== state.shown && (state.complete || !/[/?#=]/.test(input.value))) input.value = state.shown;
        paintCells();
        if (timer !== null) timers.clearTimeout(timer);
        timer = null;
        if (immediate || !state.complete) check();
        else timer = timers.setTimeout(check, LOOKUP_DELAY_MS);
      };
      const submit = () => {
        if (!view.canJoin) return;
        if (view.kind === 'session') close({ session: view.sessionId, name: 'Private session', locked: null, spectate: false });
        else close({ session: view.invite.session, name: view.invite.name, locked: !!view.invite.locked, spectate: !!view.spectate });
      };
      input.addEventListener('input', () => onInput());
      input.addEventListener('focus', () => box.classList.add('is-focused'));
      input.addEventListener('blur', () => box.classList.remove('is-focused'));
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          submit();
        }
      });
      input.value = initial;
      onInput(true);
      queueMicrotask(() => input.focus?.());
    },
    { className: 'invite-dialog' },
  );
}
