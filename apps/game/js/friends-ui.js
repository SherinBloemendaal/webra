// The friends screen in the game (the Friends board; docs/accounts-api.md
// 5.11), opened from the start screen's main menu and from the online
// screens: the list by status (in a game, online, offline) with Join,
// Spectate and Invite, adding a friend by username, the requests (accept,
// ignore, withdraw), invites from friends, removing and (un)blocking, and the
// three privacy switches (the `social` settings, which the server applies).
// Signed-in players only. The list loads on every realtime hint and is
// polled as a safety net while the screen shows (js/account/friends.js
// FriendsStore); a request or an invite that arrives while the screen is
// closed shows a toast. `friendsView` works out what to show without the
// DOM, so the tests check it with fixtures.

import { FriendsClient, FriendsStore, PresenceTracker } from './account/friends.js';
import { clockText, mapName, modeName } from './online-view.js';
import { badge, led, toggle } from './ui/controls.js';
import { confirmChoice } from './online-dialog.js';
import { formatInviteCode } from './protocol.js';

// ---- One friends list per page ------------------------------------------------------------

/** The friends store of each account API: the online screens and the friends screen share it. */
const stores = new WeakMap();

/**
 * The page's friends store for `api` (js/account/api.js AccountApi), made on
 * first use; `realtime` (js/account/realtime.js, the account's channel) makes
 * it follow the hints.
 */
export function sharedFriendsStore(api, realtime = null) {
  let store = stores.get(api);
  if (!store) {
    store = new FriendsStore({ client: new FriendsClient(api), realtime });
    stores.set(api, store);
  }
  return store;
}

/**
 * The toast for a realtime friends hint that arrives while the Friends
 * screen is closed: the last request or invite of the batch, or null.
 */
export function hintToastText(event) {
  const shown = (event?.batch ?? [event]).filter((e) => e && typeof e.data?.username === 'string' && (e.kind === 'request' || e.kind === 'invite'));
  const last = shown.at(-1);
  if (!last) return null;
  const name = last.data.username;
  return last.kind === 'request' ? `${name} sent you a friend request. Open Friends to answer.` : `${name} invites you to a lobby. Open Friends to join.`;
}

const users = new WeakMap();

/**
 * A screen that shows the friends list starts the store's polling; the
 * function returned says it is done. The store polls while any screen uses it
 * and stops when the last one is done (so two screens never poll twice, and
 * closing one does not stop the other's list).
 */
export function useFriendsStore(store) {
  users.set(store, (users.get(store) ?? 0) + 1);
  store.start();
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const left = (users.get(store) ?? 1) - 1;
    users.set(store, left);
    if (left <= 0) store.stop();
  };
}

// ---- What to show ------------------------------------------------------------------------

/** "just now", "5 minutes ago", "2 days ago", "3 weeks ago". */
export function agoText(ms) {
  const min = Math.floor(Math.max(0, ms) / 60_000);
  const unit = (n, one) => `${n} ${one}${n === 1 ? '' : 's'} ago`;
  if (min < 1) return 'just now';
  if (min < 60) return unit(min, 'minute');
  const h = Math.floor(min / 60);
  if (h < 24) return unit(h, 'hour');
  const d = Math.floor(h / 24);
  if (d < 14) return unit(d, 'day');
  if (d < 60) return unit(Math.floor(d / 7), 'week');
  return unit(Math.floor(d / 30), 'month');
}

/** A friend's status line and lamp (the word is the second signal next to the lamp's colour). */
export function friendStatus(f, now = Date.now()) {
  const s = f.session ?? null;
  switch (f.status) {
    case 'game': {
      if (!s) return { text: 'In a game', led: 'on', word: 'In game' };
      // The friends list names the mode by id (null for a co-op mission), like the directory's summary.
      const parts = [modeName({ summary: { mode: s.mode } }) || 'Game', mapName(s)];
      if (Number.isFinite(s.playingMs)) parts.push(clockText(s.playingMs));
      return { text: `In game: ${s.name} · ${parts.join(' · ')}`, led: 'on', word: 'In game' };
    }
    case 'lobby':
      return { text: s ? `In lobby: ${s.name} (${s.players}/${s.maxPlayers})` : 'In a lobby', led: 'ok', word: 'In lobby' };
    case 'online':
      return { text: 'In the main menu', led: 'ok', word: 'Online' };
    case 'away': {
      const min = Math.floor((f.awayMs ?? 0) / 60_000);
      return { text: min >= 1 ? `Away for ${min} minute${min === 1 ? '' : 's'}` : 'Away', led: 'warn', word: 'Away' };
    }
    default:
      return { text: f.lastSeenAt ? `Last played ${agoText(now - f.lastSeenAt)}` : 'Offline', led: 'off', word: 'Offline' };
  }
}

const GROUPS = [
  { id: 'game', title: 'In a game', has: (f) => f.status === 'game' },
  { id: 'online', title: 'Online', has: (f) => f.status === 'online' || f.status === 'away' || f.status === 'lobby' },
  { id: 'offline', title: 'Offline', has: (f) => !['game', 'online', 'away', 'lobby'].includes(f.status) },
];

const nameOf = (p) => String(p.displayName || p.username);

/**
 * The friends screen from the list document (js/account/friends.js):
 * `{ summary, groups, incoming, outgoing, invites, blocked, privacy, empty }`.
 * `query` filters friends by name; `lobby` (`{ session, version }` while this
 * player is in an online lobby) offers Invite to friends who are around and
 * not in that lobby yet ("Sent" for those already invited).
 */
export function friendsView(doc, { query = '', now = Date.now(), lobby = null, version = null } = {}) {
  const friends = doc?.friends ?? [];
  const q = query.trim().toLocaleLowerCase();
  const sent = new Map((doc?.sentInvites ?? []).filter((i) => lobby && i.session === lobby.session).map((i) => [i.username, i]));
  const around = friends.filter((f) => f.status !== 'offline').length;
  const playing = friends.filter((f) => f.status === 'game').length;
  const person = (f) => {
    const status = friendStatus(f, now);
    const s = f.session ?? null;
    const actions = [];
    const otherVersion = s && version && s.version !== version;
    if (f.status === 'lobby' && s?.joinable && s.id !== lobby?.session) {
      actions.push({ id: 'join', label: 'Join', primary: true, disabled: !!otherVersion, title: otherVersion ? `Needs game version ${s.version}` : '' });
    }
    if ((f.status === 'lobby' || f.status === 'game') && s?.spectatable && s.id !== lobby?.session) {
      actions.push({ id: 'spectate', label: 'Spectate', primary: false, disabled: !!otherVersion, title: otherVersion ? `Needs game version ${s.version}` : '' });
    }
    if (lobby && f.status !== 'offline' && s?.id !== lobby.session) {
      const was = sent.get(f.username);
      actions.push(was ? { id: 'invite', label: 'Sent', primary: false, disabled: true, title: `Invited ${agoText(now - was.createdAt)}` } : { id: 'invite', label: 'Invite', primary: f.status === 'online', disabled: false, title: '' });
    }
    return {
      username: f.username,
      name: nameOf(f),
      initial: [...nameOf(f)][0]?.toLocaleUpperCase() ?? '?',
      color: f.avatarColor ?? null,
      status: status.text,
      led: status.led,
      word: status.word,
      dim: f.status === 'offline',
      session: s,
      actions,
    };
  };
  const shown = friends.filter((f) => !q || nameOf(f).toLocaleLowerCase().includes(q) || f.username.toLocaleLowerCase().includes(q));
  const groups = GROUPS.map((g) => ({ id: g.id, title: g.title, people: shown.filter(g.has).map(person).sort((a, b) => a.name.localeCompare(b.name)) })).filter((g) => g.people.length);
  return {
    summary: friends.length ? `${around} online · ${playing} in a game` : 'No friends yet',
    groups,
    empty: !friends.length ? 'Add a friend by username: they get a request and appear here once they accept.' : !groups.length ? 'No friend matches.' : '',
    incoming: (doc?.incoming ?? []).map((r) => ({ username: r.username, name: nameOf(r), note: `Asked ${agoText(now - r.createdAt)}` })),
    outgoing: (doc?.outgoing ?? []).map((r) => ({ username: r.username, name: nameOf(r), note: `Sent ${agoText(now - r.createdAt)}, waiting for an answer` })),
    invites: (doc?.invites ?? []).map((i) => ({
      username: i.username,
      session: i.session,
      code: i.code,
      text: `${i.username} invites you to ${i.name}`,
      sub: [`${i.players}/${i.maxPlayers} players`, i.map ? String(i.map) : 'Generated', `code ${formatInviteCode(i.code)}`].join(' · '),
      locked: !!i.locked,
    })),
    blocked: (doc?.blocked ?? []).map((b) => ({ username: b.username, name: nameOf(b) })),
    privacy: doc?.privacy ?? null,
  };
}

// ---- The screen ---------------------------------------------------------------------------

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function btn(label, className, onClick) {
  const b = el('button', `ui-btn ${className ?? ''}`.trim(), label);
  b.type = 'button';
  if (onClick) b.addEventListener('click', onClick);
  return b;
}

/** The privacy switches: the `social` settings (js/registry.js), which the server reads from the synced settings. */
const PRIVACY = [
  ['showOnline', 'Show me as online', 'Friends see when you are around.'],
  ['friendsJoin', 'Friends can join my lobby', 'Without an invite, if there is room.'],
  ['allowSpectate', 'Allow spectators', 'Friends can watch your games.'],
];

export class FriendsScreen {
  /**
   * @param {HTMLElement} root the #friends-root element
   * @param {{
   *   account: import('./account/session.js').AccountSession,
   *   registry: { get(group: string, key: string): any, set(group: string, key: string, v: any): void },
   *   signIn?: (reason: string) => Promise<object | null>,
   *   onClose?: () => void,
   *   onJoin?: (session: { id: string, name: string, locked: boolean | null }, o: { spectate: boolean, code?: string }) => void,
   *   lobby?: () => ({ session: string } | null),  the online lobby this player is in (Invite)
   *   version?: string,
   *   store?: FriendsStore, now?: () => number, clipboard?: { writeText(t: string): Promise<void> },
   * }} ctx
   */
  constructor(root, ctx) {
    this.root = root;
    this.ctx = ctx;
    this.store = ctx.store ?? sharedFriendsStore(ctx.account.api, ctx.account.realtime ?? null);
    this.now = ctx.now ?? (() => Date.now());
    this.query = '';
    this.doc = null;
    this.error = null;
    this.menuFor = null;
    this.shown = false;
    this.offChange = this.store.on('change', (doc) => {
      this.doc = doc;
      this.error = null;
      if (this.shown) this.renderLists();
    });
    this.offError = this.store.on('error', (err) => {
      this.error = err?.message ?? String(err);
      if (this.shown) this.renderLists();
    });
    this.offAccount = ctx.account.onChange(() => {
      if (this.shown) this.render();
    });
    this.onKey = (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      // An open select list takes Esc itself (it closes the list, not the screen); steppers and
      // tabs own only their arrow keys, so Esc from them still closes the screen.
      if (e.target?.closest?.('[role="listbox"], .ui-sp-panel')) return;
      if (this.menuFor) {
        e.preventDefault();
        const name = this.menuFor;
        this.menuFor = null;
        this.renderLists();
        this.byKey(`more:${name}`)?.focus?.();
        return;
      }
      // A dialog (confirm) handles its own Escape.
      if (document.querySelector?.('dialog[open]')) return;
      e.preventDefault();
      this.close();
    };
    this.root.classList.add('friends');
    this.root.setAttribute('aria-label', 'Friends');
  }

  /** Show the screen (`from`: the button that opened it gets the focus back on close). */
  open(from = null) {
    this.from = from;
    this.shown = true;
    this.root.hidden = false;
    this.render();
    this.root.addEventListener('keydown', this.onKey);
    // A store the online screens already poll has the list at hand.
    if (this.store.doc) this.doc = this.store.doc;
    if (this.ctx.account.user) {
      this.release?.();
      this.release = useFriendsStore(this.store);
    }
    queueMicrotask(() => this.root.querySelector('.friends-search')?.focus?.());
  }

  close() {
    if (!this.shown) return;
    this.shown = false;
    this.menuFor = null;
    this.release?.();
    this.release = null;
    this.root.removeEventListener('keydown', this.onKey);
    this.root.hidden = true;
    this.ctx.onClose?.();
    this.from?.focus?.();
  }

  destroy() {
    this.close();
    this.offChange?.();
    this.offError?.();
    this.offAccount?.();
  }

  /** The control with `data-key` (names are matched as text, never put into a selector). */
  byKey(key) {
    return [...this.root.querySelectorAll('[data-key]')].find((e) => e.dataset.key === key) ?? null;
  }

  /** A short line under the header for what an action did (or why it did not). */
  say(text, bad = false) {
    if (!this.status) return;
    this.status.textContent = text;
    this.status.classList.toggle('is-bad', bad);
  }

  async act(fn, done) {
    try {
      await fn();
      if (done) this.say(done);
    } catch (err) {
      this.say(err?.message ?? String(err), true);
    }
  }

  render() {
    const root = this.root;
    root.textContent = '';
    const page = el('div', 'friends-page');
    const head = el('header', 'friends-head');
    const title = el('div', 'friends-title-box');
    title.append(el('h1', 'friends-title', 'Friends'));
    this.summary = el('span', 'friends-summary');
    title.append(this.summary);
    head.append(title);
    const user = this.ctx.account.user;
    if (user) {
      const me = el('div', 'friends-me');
      me.append(el('span', 'friends-me-label', 'Your username'), el('span', 'friends-me-name', user.username));
      const copy = btn('Copy', 'ui-btn-sm', async () => {
        try {
          await (this.ctx.clipboard ?? navigator.clipboard).writeText(user.username);
          this.say(`Copied your username: ${user.username}. A friend adds you with it.`);
        } catch {
          this.say(`Your username is ${user.username}.`);
        }
      });
      copy.setAttribute('aria-label', 'Copy your username');
      me.append(copy);
      head.append(me);
    }
    head.append(btn('Back', 'friends-back', () => this.close()));
    this.status = el('p', 'friends-status');
    this.status.setAttribute('role', 'status');
    page.append(head, this.status);
    if (!user) {
      const note = el('div', 'friends-signin');
      note.append(el('p', null, 'Friends need a WebRA account: sign in to see who is online, join their lobbies and invite them.'));
      if (this.ctx.signIn) note.append(btn('Sign in', 'ui-btn-primary', () => this.ctx.signIn('Sign in to see your friends.')));
      page.append(note);
      root.append(page);
      this.summary.textContent = '';
      return;
    }
    const body = el('div', 'friends-body');
    const list = el('section', 'friends-list ui-panel');
    list.setAttribute('aria-label', 'Friends list');
    const search = el('input', 'online-input friends-search');
    search.type = 'search';
    search.placeholder = 'Search friends';
    search.setAttribute('aria-label', 'Search friends');
    search.value = this.query;
    search.addEventListener('input', () => {
      this.query = search.value;
      this.renderLists();
    });
    this.listBox = el('div', 'friends-groups');
    list.append(search, this.listBox);

    const side = el('div', 'friends-side');
    // Add a friend.
    const add = el('section', 'friends-card ui-panel');
    add.setAttribute('aria-labelledby', 'friends-add-title');
    const addTitle = el('h2', 'friends-card-title', 'Add a friend');
    addTitle.id = 'friends-add-title';
    const form = el('form', 'friends-add');
    const name = el('input', 'online-input');
    name.placeholder = 'Username';
    name.setAttribute('aria-label', 'Username');
    name.autocomplete = 'off';
    name.spellcheck = false;
    name.maxLength = 64;
    const send = btn('Send', 'ui-btn-primary');
    send.type = 'submit';
    form.append(name, send);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const who = name.value.trim();
      if (!who) return;
      this.act(async () => {
        const r = await this.store.request(who);
        name.value = '';
        this.say(r?.friend ? `${who} had asked you already: you are friends now.` : `Request sent to ${who}.`);
      });
    });
    add.append(addTitle, form, el('p', 'friends-hint', 'They get a request and appear in your list once they accept.'));
    this.requestBox = el('section', 'friends-card ui-panel');
    this.requestBox.setAttribute('aria-label', 'Requests');
    this.inviteBox = el('section', 'friends-card ui-panel');
    this.inviteBox.setAttribute('aria-label', 'Invites');
    const privacy = el('section', 'friends-card ui-panel');
    privacy.setAttribute('aria-labelledby', 'friends-privacy-title');
    const privTitle = el('h2', 'friends-card-title', 'Privacy');
    privTitle.id = 'friends-privacy-title';
    privacy.append(privTitle);
    for (const [key, label, hint] of PRIVACY) {
      const t = toggle({
        label,
        hint,
        checked: this.ctx.registry.get('social', key) !== false,
        onChange: (on) => {
          this.ctx.registry.set('social', key, on);
          this.say(`${label}: ${on ? 'on' : 'off'}. Your friends see it once your settings are saved to your account.`);
        },
      });
      privacy.append(t.row);
    }
    this.blockBox = el('div', 'friends-blocked');
    privacy.append(this.blockBox);
    side.append(add, this.inviteBox, this.requestBox, privacy);
    body.append(list, side);
    page.append(body);
    root.append(page);
    this.renderLists();
  }

  /** The parts that change with the polled list. */
  renderLists() {
    if (!this.listBox) return;
    const lobby = this.ctx.lobby?.() ?? null;
    const v = friendsView(this.doc, { query: this.query, now: this.now(), lobby, version: this.ctx.version ?? null });
    this.summary.textContent = this.doc ? v.summary : 'Loading...';
    if (this.error && !this.doc) this.say(this.error, true);

    // The list by status.
    const focusKey = document.activeElement?.dataset?.key ?? null;
    this.listBox.textContent = '';
    if (!this.doc) this.listBox.append(el('p', 'friends-empty', this.error ? 'The friends list could not be loaded.' : 'Loading your friends...'));
    else if (v.empty) this.listBox.append(el('p', 'friends-empty', v.empty));
    for (const g of v.groups) {
      const group = el('div', 'friends-group');
      group.setAttribute('role', 'group');
      const gid = `friends-g-${g.id}`;
      const t = el('h2', 'friends-group-title', g.title);
      t.id = gid;
      group.setAttribute('aria-labelledby', gid);
      group.append(t);
      const ul = el('ul', 'friends-people');
      for (const p of g.people) ul.append(this.personRow(p));
      group.append(ul);
      this.listBox.append(group);
    }

    // Invites from friends.
    this.inviteBox.textContent = '';
    this.inviteBox.hidden = !v.invites.length;
    if (v.invites.length) {
      this.inviteBox.append(el('h2', 'friends-card-title', 'Invites'));
      for (const inv of v.invites) {
        const row = el('div', 'friends-request');
        const text = el('span', 'friends-request-text');
        text.append(el('span', 'friends-request-name', inv.text), el('span', 'friends-request-note', inv.sub));
        row.append(text);
        if (inv.locked) row.append(badge('locked', 'Password'));
        const join = btn('Join', 'ui-btn-primary ui-btn-sm', () => this.join({ id: inv.session, name: inv.text, locked: inv.locked }, { spectate: false, code: inv.code }));
        join.dataset.key = `invite-join:${inv.username}`;
        const dismiss = btn('Dismiss', 'ui-btn-sm', () => this.act(() => this.store.dismissInvite(inv.username)));
        dismiss.dataset.key = `invite-dismiss:${inv.username}`;
        row.append(join, dismiss);
        this.inviteBox.append(row);
      }
    }

    // Requests: incoming with Accept and Ignore, sent ones with Withdraw.
    this.requestBox.textContent = '';
    const reqTitle = el('h2', 'friends-card-title', 'Requests ');
    if (v.incoming.length) reqTitle.append(badge('accent', String(v.incoming.length)));
    this.requestBox.append(reqTitle);
    if (!v.incoming.length && !v.outgoing.length) this.requestBox.append(el('p', 'friends-hint', 'No requests.'));
    for (const r of v.incoming) {
      const row = el('div', 'friends-request');
      const text = el('span', 'friends-request-text');
      text.append(el('span', 'friends-request-name', r.name), el('span', 'friends-request-note', r.note));
      const accept = btn('Accept', 'ui-btn-primary ui-btn-sm', () => this.act(() => this.store.accept(r.username), `${r.name} is your friend now.`));
      accept.dataset.key = `accept:${r.username}`;
      accept.setAttribute('aria-label', `Accept ${r.name}`);
      const ignore = btn('Ignore', 'ui-btn-sm', () => this.act(() => this.store.ignore(r.username), `Ignored ${r.name}'s request.`));
      ignore.dataset.key = `ignore:${r.username}`;
      ignore.setAttribute('aria-label', `Ignore ${r.name}`);
      row.append(text, accept, ignore);
      this.requestBox.append(row);
    }
    for (const r of v.outgoing) {
      const row = el('div', 'friends-request friends-request-sent');
      const text = el('span', 'friends-request-text');
      text.append(el('span', 'friends-request-name', r.name), el('span', 'friends-request-note', r.note));
      const withdraw = btn('Withdraw', 'ui-btn-sm ui-btn-ghost', () => this.act(() => this.store.withdraw(r.username), `Withdrew the request to ${r.name}.`));
      withdraw.dataset.key = `withdraw:${r.username}`;
      withdraw.setAttribute('aria-label', `Withdraw the request to ${r.name}`);
      row.append(text, withdraw);
      this.requestBox.append(row);
    }

    // Blocked players.
    this.blockBox.textContent = '';
    this.blockBox.append(el('p', 'friends-hint', v.blocked.length ? `Blocked players: ${v.blocked.length}. They cannot send you requests, invite you or join your lobby.` : 'Blocked players cannot send you requests, invite you or join your lobby.'));
    if (v.blocked.length) {
      const ul = el('ul', 'friends-blocked-list');
      for (const b of v.blocked) {
        const li = el('li', 'friends-blocked-row');
        const un = btn('Unblock', 'ui-btn-sm ui-btn-ghost', () => this.act(() => this.store.unblock(b.username), `Unblocked ${b.name}.`));
        un.dataset.key = `unblock:${b.username}`;
        un.setAttribute('aria-label', `Unblock ${b.name}`);
        li.append(el('span', null, b.name), un);
        ul.append(li);
      }
      this.blockBox.append(ul);
    }
    if (focusKey) this.byKey(focusKey)?.focus?.();
  }

  /** One friend: avatar letter with a lamp, name and status, the actions and a More menu. */
  personRow(p) {
    const li = el('li', `friends-person${p.dim ? ' is-offline' : ''}`);
    const avatar = el('span', 'friends-avatar', p.initial);
    avatar.setAttribute('aria-hidden', 'true');
    if (p.color) avatar.style.setProperty('--avatar', p.color);
    avatar.append(led(p.led));
    const text = el('span', 'friends-person-text');
    const name = el('span', 'friends-person-name', p.name);
    const status = el('span', `friends-person-status friends-status-${p.led}`, p.status);
    text.append(name, status);
    const actions = el('span', 'friends-actions');
    for (const a of p.actions) {
      const b = btn(a.label, `ui-btn-sm${a.primary ? ' ui-btn-primary' : ''}`, () => this.runAction(p, a.id));
      b.disabled = a.disabled;
      if (a.title) b.title = a.title;
      b.dataset.key = `${a.id}:${p.username}`;
      b.setAttribute('aria-label', `${a.label}: ${p.name}`);
      actions.append(b);
    }
    const more = btn('...', 'ui-btn-sm ui-btn-icon friends-more', () => {
      this.menuFor = this.menuFor === p.username ? null : p.username;
      this.renderLists();
      if (this.menuFor) this.root.querySelector('.friends-menu [role="menuitem"]')?.focus?.();
    });
    more.setAttribute('aria-label', `More for ${p.name}`);
    more.setAttribute('aria-haspopup', 'menu');
    more.setAttribute('aria-expanded', String(this.menuFor === p.username));
    more.dataset.key = `more:${p.username}`;
    actions.append(more);
    li.append(avatar, text, actions);
    // The word next to the lamp (screen readers and forced colours read it in the status line).
    li.setAttribute('aria-label', `${p.name}, ${p.word}: ${p.status}`);
    if (this.menuFor === p.username) li.append(this.menu(p));
    return li;
  }

  /** The More menu: Remove friend and Block, each asked first. */
  menu(p) {
    const menu = el('div', 'friends-menu');
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', `More for ${p.name}`);
    const item = (label, fn) => {
      const b = el('button', 'friends-menu-item', label);
      b.type = 'button';
      b.setAttribute('role', 'menuitem');
      b.addEventListener('click', () => {
        this.menuFor = null;
        fn();
      });
      return b;
    };
    menu.append(
      item('Remove friend', async () => {
        if (await confirmChoice('Remove friend', `Remove ${p.name} from your friends? You can send a new request later.`, { yes: 'Remove', danger: true })) {
          await this.act(() => this.store.remove(p.username), `${p.name} is no longer your friend.`);
        } else this.renderLists();
      }),
      item('Block', async () => {
        if (await confirmChoice('Block player', `Block ${p.name}? They are removed from your friends and can no longer send you requests, invite you or join a lobby you are in.`, { yes: 'Block', danger: true })) {
          await this.act(() => this.store.block(p.username), `Blocked ${p.name}.`);
        } else this.renderLists();
      }),
    );
    menu.addEventListener('keydown', (e) => {
      const items = [...menu.querySelectorAll('[role="menuitem"]')];
      const at = items.indexOf(document.activeElement);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        items[(at + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus?.();
      }
    });
    return menu;
  }

  runAction(p, id) {
    const s = p.session;
    if (id === 'join' && s) this.join({ id: s.id, name: s.name, locked: !!s.locked }, { spectate: false });
    else if (id === 'spectate' && s) this.join({ id: s.id, name: s.name, locked: !!s.locked }, { spectate: true });
    else if (id === 'invite') {
      const lobby = this.ctx.lobby?.();
      if (!lobby) return;
      this.act(() => this.store.invite(p.username, lobby.session), `Invited ${p.name}. They see it in their friends list.`);
    }
  }

  join(session, o) {
    if (!this.ctx.onJoin) return;
    this.close();
    this.ctx.onJoin(session, o);
  }
}

/**
 * The Friends entry of the start screen's main menu (index.html
 * #start-friends): shown while a player is signed in; opens the screen.
 * Also starts the presence heartbeat (js/account/friends.js
 * PresenceTracker) while signed in, so friends see this player around, and
 * `toast`s a friend request or invite that a realtime hint announces while
 * the screen is closed (an open screen shows it in its lists).
 * `cover`: the screens it shows over (hidden meanwhile); `presence`: makes
 * the heartbeat (tests). Returns `{ open(from), close({ restore }) }`.
 */
export function mountFriends({ entry, root, account, registry, signIn, onJoin, lobby, version, cover = [], presence: makePresence, toast = null }) {
  let screen = null;
  let presence = null;
  let offHints = null;
  const onHint = (event) => {
    if (screen?.shown) return;
    const text = hintToastText(event);
    if (text) toast?.(text);
  };
  // The screens under it are hidden while it shows (so they leave the tab order and the reader), then come back.
  let covered = [];
  const onClose = () => {
    for (const e of covered) e.hidden = false;
    covered = [];
  };
  const get = () => (screen ??= new FriendsScreen(root, { account, registry, signIn, onJoin, lobby, version, onClose }));
  const follow = () => {
    const signedIn = !!account.user;
    if (entry) entry.hidden = !signedIn;
    if (signedIn) {
      // start() does nothing while it runs; after a 401 or 403 stopped it, a new sign-in starts it again.
      presence ??= makePresence ? makePresence() : new PresenceTracker({ client: new FriendsClient(account.api) });
      presence.start();
      if (toast && account.realtime) offHints ??= account.realtime.subscribe('friends', onHint);
    } else {
      presence?.stop();
      presence = null;
      offHints?.();
      offHints = null;
    }
    // Signed out while it shows: the screen says so (FriendsScreen follows the account itself).
  };
  account.onChange(follow);
  follow();
  const open = (from = entry) => {
    if (!screen?.shown) covered = cover.filter((e) => e && !e.hidden);
    for (const e of covered) e.hidden = true;
    get().open(from);
  };
  /**
   * Close the screen. `restore: false` leaves what it covered hidden: an
   * online game started behind it, and the online screen hid itself for it.
   */
  const close = ({ restore = true } = {}) => {
    if (!restore) covered = [];
    screen?.close();
  };
  entry?.addEventListener('click', () => open(entry));
  return { open, close, screen: () => screen, presence: () => presence };
}
