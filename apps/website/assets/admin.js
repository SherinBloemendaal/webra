// The admin dashboard (/admin.html): overview, users (search, filters,
// sorting, pages, bulk approve and reject, a detail drawer with profile,
// status, role, flags, login methods, sessions, IP history, bans and the
// settings document), IP bans, site settings and the audit log
// (docs/accounts-api.md 8). Moderators see only what their role allows.
// The server checks every action again.

import { AccountApi, AccountError, errorText, formatDateTime } from '/play/js/account/api.js';
import {
  AUDIT_ACTIONS,
  BAN_PRESETS,
  FLAGS,
  ROLES,
  SETTABLE_STATUSES,
  SORTS,
  STATUSES,
  STATUS_LABELS,
  UsersTable,
  apiQuery,
  auditFilter,
  auditParams,
  banExpiry,
  canBan,
  localInputValue,
  looksLikeCidr,
  parseView,
  permissions,
  viewHash,
} from '/play/js/account/admin-state.js';
import { buildSettingsForm } from '/play/js/account/admin-forms.js';
import { checkDocument } from '/play/js/registry.js';
import { BAN_REASON_MAX, DISPLAY_NAME_MAX, EMAIL_MAX, MOTD_MAX, USERNAME_MAX } from '/play/protocol/accounts.js';
import { el, field, checkbox, statusLine, openDialog, confirmDialog, busy } from './ui.js';

const TABS = [
  ['overview', 'Overview', 'stats'],
  ['users', 'Users', 'users'],
  ['ip-bans', 'IP bans', 'ipBans'],
  ['site', 'Site settings', 'site'],
  ['audit', 'Audit log', 'audit'],
];

const statusBadge = (status) => el('span', { class: `badge badge-status badge-${status}`, text: STATUS_LABELS[status] ?? status });

/**
 * Build the dashboard into `root`.
 * @param {HTMLElement} root
 * @param {{ api?: AccountApi, location?: Location, history?: History, now?: () => number }} [deps]
 */
export async function mountAdmin(root, deps = {}) {
  const api = deps.api ?? new AccountApi();
  const loc = deps.location ?? globalThis.location;
  const hist = deps.history ?? globalThis.history;
  const now = deps.now ?? (() => Date.now());

  let me;
  try {
    me = (await api.me()).user;
  } catch (err) {
    root.replaceChildren(el('p', { class: 'notice notice-error', role: 'alert', text: errorText(err) }));
    return null;
  }
  if (!me) {
    root.replaceChildren(el('div', { class: 'notice' }, el('p', { text: 'Sign in with a moderator or admin account to use the dashboard.' }), el('a', { class: 'btn btn-primary', href: '/account/', text: 'Sign in' })));
    return null;
  }
  const can = permissions(me.role);
  if (!can.dashboard) {
    root.replaceChildren(el('p', { class: 'notice notice-error', role: 'alert', text: 'This page is for moderators and admins.' }));
    return null;
  }

  const tabs = TABS.filter(([, , need]) => can[need]);
  const tabList = el('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Dashboard' });
  const panel = el('div', { class: 'tab-panel', role: 'tabpanel', tabindex: '-1' });
  const who = el('p', { class: 'form-help admin-who' }, el('span', { text: `Signed in as ${me.username} (${me.role}). ` }), el('a', { href: '/account/', text: 'Your account' }));
  root.replaceChildren(who, tabList, panel);

  let view = parseView(loc.hash);
  const table = new UsersTable(view.query);
  /** Reload the users table (after an action in the drawer), while it is shown. */
  let reloadUsers = null;
  let audit = view.audit ?? auditFilter({});
  let drawer = null;

  const setHash = () => {
    const h = viewHash({ tab: view.tab, user: view.user, query: table.query, audit });
    if (loc.hash !== h) hist.replaceState(null, '', `${loc.pathname}${loc.search}${h}`);
  };

  function show(tab, { focus = false } = {}) {
    if (!tabs.some(([k]) => k === tab)) tab = tabs[0][0];
    view.tab = tab;
    tabList.replaceChildren(
      ...tabs.map(([key, label]) => {
        const b = el('button', { type: 'button', role: 'tab', class: 'tab', id: `admin-tab-${key}`, 'aria-selected': String(key === tab), 'aria-controls': 'admin-panel', tabindex: key === tab ? '0' : '-1', text: label });
        b.addEventListener('click', () => show(key, { focus: true }));
        b.addEventListener('keydown', (e) => {
          const i = tabs.findIndex(([k]) => k === key);
          const next = e.key === 'ArrowRight' ? tabs[(i + 1) % tabs.length] : e.key === 'ArrowLeft' ? tabs[(i - 1 + tabs.length) % tabs.length] : null;
          if (next) {
            e.preventDefault();
            show(next[0]);
            tabList.querySelector(`#admin-tab-${next[0]}`)?.focus();
          }
        });
        return b;
      }),
    );
    panel.id = 'admin-panel';
    panel.setAttribute('aria-labelledby', `admin-tab-${tab}`);
    if (tab !== 'users') reloadUsers = null;
    ({ overview: renderOverview, users: renderUsers, 'ip-bans': renderIpBans, site: renderSite, audit: renderAudit })[tab]();
    setHash();
    if (focus) panel.focus();
  }

  // ---- Overview --------------------------------------------------------------------------
  async function renderOverview() {
    const status = statusLine();
    panel.replaceChildren(status.node, el('p', { class: 'status-line', text: 'Loading...' }));
    try {
      const s = await api.stats();
      const tile = (label, value, href) => {
        const v = el('strong', { class: 'stat-value', text: String(value) });
        const body = href ? el('a', { href, class: 'stat-link' }, v, el('span', { class: 'stat-label', text: label })) : el('div', {}, v, el('span', { class: 'stat-label', text: label }));
        return el('li', { class: 'panel stat' }, body);
      };
      const pending = s.users.byStatus.pending_approval ?? 0;
      panel.replaceChildren(
        status.node,
        el(
          'ul',
          { class: 'stats', 'aria-label': 'Overview' },
          tile('Users', s.users.total, '#users'),
          tile('Waiting for approval', pending, '#users?status=pending_approval'),
          tile('Email not verified', s.users.byStatus.pending_email ?? 0, '#users?status=pending_email'),
          tile('Active', s.users.byStatus.active ?? 0, '#users?status=active'),
          tile('Banned', s.users.byStatus.banned ?? 0, '#users?status=banned'),
          tile('New in 7 days', s.users.newLast7Days),
          tile('Signed-in sessions', s.sessions.active),
          tile('Open lobbies', s.games.lobbies),
          tile('Running games', s.games.running),
          tile('Maps', s.maps.total),
          tile('IP bans', s.bans.ips),
        ),
        el(
          'p',
          { class: 'form-help' },
          el('span', { text: `Roles: ${s.users.byRole.admin} admin, ${s.users.byRole.moderator} moderator, ${s.users.byRole.user} user. ` }),
          el('span', { text: `Email sending: ${s.services.email ? 'available' : 'not available (needs the email plan)'}. Discord: ${s.services.discord ? 'configured' : 'not configured'}.` }),
        ),
      );
      for (const a of panel.querySelectorAll('a.stat-link')) {
        a.addEventListener('click', (e) => {
          e.preventDefault();
          const v = parseView(a.getAttribute('href'));
          table.filter(v.query);
          show('users', { focus: true });
        });
      }
    } catch (err) {
      panel.replaceChildren(el('p', { class: 'notice notice-error', role: 'alert', text: errorText(err) }));
    }
  }

  // ---- Users ---------------------------------------------------------------------------------
  function renderUsers() {
    const status = statusLine();
    const q = field('Search', el('input', { type: 'search', value: table.query.q, maxlength: '100', placeholder: can.fullDetail ? 'Username, display name or email' : 'Username or display name' }));
    const select = (label, options, value, all = 'All') => {
      const s = el('select', {}, el('option', { value: '', text: all }), ...options.map(([v, t]) => el('option', { value: v, text: t })));
      s.value = value;
      return field(label, s);
    };
    const st = select('Status', STATUSES.map((s) => [s, STATUS_LABELS[s]]), table.query.status);
    const role = select('Role', ROLES.map((r) => [r, r]), table.query.role);
    const flag = select('Flag', Object.entries(FLAGS), table.query.flag);
    const limit = select('Per page', [10, 25, 50, 100].map((n) => [String(n), String(n)]), String(table.query.limit), '25');
    let timer = null;
    q.input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => (table.filter({ q: q.input.value.trim() }), load()), 250);
    });
    st.input.addEventListener('change', () => (table.filter({ status: st.input.value }), load()));
    role.input.addEventListener('change', () => (table.filter({ role: role.input.value }), load()));
    flag.input.addEventListener('change', () => (table.filter({ flag: flag.input.value }), load()));
    limit.input.addEventListener('change', () => (table.filter({ limit: Number(limit.input.value) }), load()));

    const bulkApprove = el('button', { type: 'button', class: 'btn btn-small', text: 'Approve selected' });
    const bulkReject = el('button', { type: 'button', class: 'btn btn-small btn-danger', text: 'Reject selected' });
    const bulkInfo = el('span', { class: 'form-help', 'aria-live': 'polite' });
    const bulk = el('div', { class: 'bulk-bar' }, bulkInfo, bulkApprove, bulkReject);
    bulk.hidden = !can.approve;
    const syncBulk = () => {
      const n = table.selected.size;
      bulkInfo.textContent = n ? `${n} selected. ` : 'Select pending accounts to approve or reject them together. ';
      bulkApprove.disabled = !table.selectedFor('approve').length;
      bulkReject.disabled = !table.selectedFor('reject').length;
    };
    const runBulk = async (action, button) => {
      const rows = table.selectedFor(action);
      if (!rows.length) return;
      if (action === 'reject' && !(await confirmDialog('Reject accounts', `Reject ${rows.length} pending account${rows.length === 1 ? '' : 's'}? They are deleted.`, { confirmText: 'Reject', danger: true }))) return;
      await busy(button, status, async () => {
        const results = await Promise.allSettled(rows.map((u) => (action === 'approve' ? api.approveUser(u.id) : api.rejectUser(u.id))));
        const failed = results.filter((r) => r.status === 'rejected');
        status.show(failed.length ? `${rows.length - failed.length} done, ${failed.length} failed: ${errorText(failed[0].reason)}` : `${rows.length} account${rows.length === 1 ? '' : 's'} ${action === 'approve' ? 'approved' : 'rejected'}.`, failed.length ? 'error' : 'ok');
        table.toggleAll(false);
        await load();
      }, errorText);
    };
    bulkApprove.addEventListener('click', () => runBulk('approve', bulkApprove));
    bulkReject.addEventListener('click', () => runBulk('reject', bulkReject));

    const tbody = el('tbody');
    const all = el('input', { type: 'checkbox', 'aria-label': 'Select all shown users' });
    all.addEventListener('change', () => {
      table.toggleAll(all.checked);
      drawRows();
    });
    const sortButton = (column, label) => {
      const active = table.query.sort === column;
      const b = el('button', { type: 'button', class: 'sort', text: label });
      const th = el('th', { scope: 'col', 'aria-sort': active ? (table.query.order === 'asc' ? 'ascending' : 'descending') : 'none' }, b);
      b.addEventListener('click', () => {
        table.sortBy(column);
        renderUsers();
      });
      return th;
    };
    const head = el(
      'tr',
      {},
      can.approve ? el('th', { scope: 'col', class: 'col-check' }, all) : null,
      sortButton('username', SORTS.username),
      el('th', { scope: 'col', text: 'Status' }),
      el('th', { scope: 'col', text: 'Role' }),
      el('th', { scope: 'col', text: 'Email' }),
      sortButton('created', SORTS.created),
      sortButton('lastSeen', SORTS.lastSeen),
      el('th', { scope: 'col', text: 'Actions' }),
    );
    const range = el('span', { class: 'form-help', 'aria-live': 'polite' });
    const prev = el('button', { type: 'button', class: 'btn btn-small', text: 'Previous' });
    const next = el('button', { type: 'button', class: 'btn btn-small', text: 'Next' });
    prev.addEventListener('click', () => (table.goTo(table.query.page - 1), load()));
    next.addEventListener('click', () => (table.goTo(table.query.page + 1), load()));

    function drawRows() {
      tbody.replaceChildren(
        ...table.users.map((u) => {
          const pick = el('input', { type: 'checkbox', 'aria-label': `Select ${u.username}`, checked: table.selected.has(u.id) });
          pick.addEventListener('change', () => (table.toggle(u.id, pick.checked), syncBulk()));
          const open = el('button', { type: 'button', class: 'link-button', text: u.username });
          open.addEventListener('click', () => openUser(u.id));
          const actions = el('td', { class: 'row-actions' });
          if (can.approve && (u.status === 'pending_approval' || u.status === 'pending_email')) {
            const approve = el('button', { type: 'button', class: 'btn btn-small', text: 'Approve' });
            approve.addEventListener('click', () => busy(approve, status, async () => (await api.approveUser(u.id), status.show(`${u.username} approved.`, 'ok'), load()), errorText));
            actions.append(approve);
          }
          const details = el('button', { type: 'button', class: 'btn btn-small', text: 'Details' });
          details.addEventListener('click', () => openUser(u.id));
          actions.append(details);
          return el(
            'tr',
            { class: table.selected.has(u.id) ? 'selected' : null },
            can.approve ? el('td', { class: 'col-check' }, pick) : null,
            el('th', { scope: 'row' }, open, u.displayName && u.displayName !== u.username ? el('span', { class: 'form-help', text: ` ${u.displayName}` }) : null),
            el('td', {}, statusBadge(u.status), u.flags?.length ? el('span', { class: 'badge badge-flag', title: u.flags.join(', '), text: 'Flags' }) : null),
            el('td', { text: u.role }),
            el('td', { class: 'col-email', text: u.email ?? '' }),
            el('td', { text: formatDateTime(u.createdAt) }),
            el('td', { text: formatDateTime(u.lastSeenAt) }),
            actions,
          );
        }),
      );
      if (!table.users.length) tbody.append(el('tr', {}, el('td', { colspan: '8', class: 'form-help', text: 'No users match.' })));
      all.checked = table.users.length > 0 && table.users.every((u) => table.selected.has(u.id));
      range.textContent = table.rangeText();
      prev.disabled = table.query.page <= 1;
      next.disabled = table.query.page >= table.pages;
      syncBulk();
    }

    async function load() {
      setHash();
      try {
        table.setResult(await api.users(apiQuery(table.query)));
        if (table.query.page > table.pages) {
          table.goTo(table.pages);
          table.setResult(await api.users(apiQuery(table.query)));
        }
        drawRows();
      } catch (err) {
        status.show(errorText(err), 'error');
      }
    }

    reloadUsers = load;
    panel.replaceChildren(
      el('div', { class: 'controls admin-filters' }, el('div', { class: 'field-grow' }, q.row), st.row, role.row, flag.row, limit.row),
      status.node,
      bulk,
      el('div', { class: 'table-wrap' }, el('table', { class: 'data-table' }, el('caption', { class: 'visually-hidden', text: 'Users' }), el('thead', {}, head), tbody)),
      el('div', { class: 'pager' }, prev, range, next),
    );
    load();
    if (view.user) openUser(view.user);
  }

  // ---- User detail drawer ----------------------------------------------------------------------
  async function openUser(id) {
    view.user = id;
    setHash();
    drawer?.remove();
    const titleId = `user-title-${id}`;
    const body = el('div', { class: 'drawer-body' }, el('p', { class: 'status-line', text: 'Loading...' }));
    const close = el('button', { type: 'button', class: 'btn btn-small', text: 'Close' });
    const aside = el('aside', { class: 'panel drawer', role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': titleId }, el('div', { class: 'dialog-head' }, el('h2', { id: titleId, text: 'User' }), close), body);
    const opener = document.activeElement;
    const shut = () => {
      aside.remove();
      drawer = null;
      view.user = null;
      setHash();
      if (opener?.isConnected) opener.focus?.();
    };
    close.addEventListener('click', shut);
    aside.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') shut();
    });
    drawer = aside;
    root.append(aside);
    close.focus();
    await fillUser(id, body, aside.querySelector(`#${titleId}`));
  }

  async function fillUser(id, body, title) {
    let d;
    try {
      d = await api.user(id);
    } catch (err) {
      body.replaceChildren(el('p', { class: 'notice notice-error', role: 'alert', text: errorText(err) }));
      return;
    }
    const u = d.user;
    title.textContent = u.username;
    const status = statusLine();
    const reload = () => fillUser(id, body, title);
    const parts = [status.node, el('p', {}, statusBadge(u.status), el('span', { class: 'badge', text: u.role }), ...(u.flags ?? []).map((f) => el('span', { class: 'badge badge-flag', text: FLAGS[f] ?? f })))];

    // Facts
    parts.push(
      el(
        'dl',
        { class: 'detail-facts' },
        ...[
          ['Display name', u.displayName],
          ['Email', u.email ? `${u.email}${u.emailVerified ? ' (verified)' : ' (not verified)'}` : 'none'],
          ['Created', formatDateTime(u.createdAt)],
          ['Last seen', formatDateTime(u.lastSeenAt)],
          ['Approved', u.approvedAt ? `${formatDateTime(u.approvedAt)}` : 'no'],
          ['Login methods', [u.methods.password ? 'password' : null, u.methods.passkeys ? `${u.methods.passkeys} passkey${u.methods.passkeys === 1 ? '' : 's'}` : null, u.methods.discord ? `Discord (${u.methods.discord.username})` : null].filter(Boolean).join(', ') || 'none'],
          ['Ban', u.ban ? `${u.ban.reason} (until ${u.ban.expiresAt ? formatDateTime(u.ban.expiresAt) : 'lifted'})` : 'none'],
          ...(u.deletedAt ? [['Deleted', formatDateTime(u.deletedAt)]] : []),
        ].flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { text: String(v) })]),
      ),
    );

    // Actions
    const actions = el('div', { class: 'form-actions' });
    const act = (label, fn, { danger = false, confirm = null } = {}) => {
      const b = el('button', { type: 'button', class: danger ? 'btn btn-small btn-danger' : 'btn btn-small', text: label });
      b.addEventListener('click', async () => {
        if (confirm && !(await confirmDialog(label, confirm, { confirmText: label, danger }))) return;
        await busy(b, status, async () => {
          const msg = await fn();
          if (msg) status.show(msg, 'ok');
          await reload();
          refreshTable();
        }, errorText);
      });
      actions.append(b);
    };
    const pending = u.storedStatus === 'pending_approval' || u.storedStatus === 'pending_email';
    if (can.approve && pending && !u.ban) {
      act('Approve', async () => (await api.approveUser(u.id), `${u.username} is approved.`));
      act('Reject', async () => (await api.rejectUser(u.id), `${u.username} is rejected.`), { danger: true, confirm: `Reject ${u.username}? The account is deleted.` });
    }
    if (canBan(me, u)) {
      if (u.ban) act('Lift ban', async () => (await api.unbanUser(u.id), 'The ban is lifted.'));
      else {
        const b = el('button', { type: 'button', class: 'btn btn-small btn-danger', text: 'Ban' });
        b.addEventListener('click', async () => {
          if (await banDialog(u)) {
            await reload();
            refreshTable();
          }
        });
        actions.append(b);
      }
    }
    if (can.sessions) act('Sign out everywhere', async () => (await api.logoutUser(u.id), 'Every session is signed out.'), { confirm: `Sign ${u.username} out on every device?` });
    if (can.resetLink) {
      const b = el('button', { type: 'button', class: 'btn btn-small', text: 'Password reset link' });
      b.addEventListener('click', () => resetLinkDialog(u));
      actions.append(b);
    }
    if (can.delete && u.id !== me.id) {
      if (u.status === 'deleted') {
        act('Restore', async () => (await api.restoreUser(u.id), 'Restored.'));
        const purge = el('button', { type: 'button', class: 'btn btn-small btn-danger', text: 'Purge now' });
        purge.addEventListener('click', async () => {
          const typed = await typeToConfirm('Purge account', `This removes ${u.username} and everything stored about it now. Type the username to confirm.`, u.username);
          if (!typed) return;
          await busy(purge, status, async () => {
            await api.purgeUser(u.id, typed);
            drawer?.remove();
            drawer = null;
            view.user = null;
            setHash();
            refreshTable();
          }, errorText);
        });
        actions.append(purge);
      } else act('Delete', async () => (await api.deleteUser(u.id), 'Deleted. It can be restored for 30 days.'), { danger: true, confirm: `Delete ${u.username}? It is signed out everywhere and can be restored for 30 days.` });
    }
    parts.push(actions);

    // Edit (admins)
    if (can.edit) parts.push(editForm(u, status, reload));

    // Sessions, IP history (admins)
    if (d.sessions) {
      parts.push(
        detailsBlock(
          `Sessions (${d.sessions.length})`,
          d.sessions.length
            ? el(
                'ul',
                { class: 'item-list' },
                ...d.sessions.map((s) => {
                  const revoke = el('button', { type: 'button', class: 'btn btn-small btn-danger', text: 'Revoke' });
                  revoke.addEventListener('click', () => busy(revoke, status, async () => (await api.revokeUserSession(u.id, s.id), reload()), errorText));
                  return el('li', { class: 'item' }, el('strong', { text: s.deviceLabel }), el('span', { class: 'form-help', text: ` ${s.userAgent}, last used ${formatDateTime(s.lastUsedAt)}, expires ${formatDateTime(s.expiresAt)}` }), revoke);
                }),
              )
            : el('p', { class: 'form-help', text: 'Not signed in anywhere.' }),
        ),
      );
    }
    if (d.ips) {
      parts.push(
        detailsBlock(
          `IP history (${d.ips.length})`,
          d.ips.length
            ? el(
                'ul',
                { class: 'item-list' },
                ...d.ips.map((ip) => {
                  const ban = el('button', { type: 'button', class: 'btn btn-small btn-danger', text: 'Ban this address' });
                  ban.addEventListener('click', () => ipBanDialog(ip.ip, `Address of ${u.username}`));
                  return el('li', { class: 'item' }, el('code', { text: ip.ip }), el('span', { class: 'form-help', text: ` seen ${ip.count} times, first ${formatDateTime(ip.firstSeen)}, last ${formatDateTime(ip.lastSeen)}` }), can.ipBans ? ban : null);
                }),
              )
            : el('p', { class: 'form-help', text: 'No addresses recorded.' }),
        ),
      );
    }
    parts.push(
      detailsBlock(
        `Bans (${d.bans?.length ?? 0})`,
        d.bans?.length
          ? el('ul', { class: 'item-list' }, ...d.bans.map((b) => el('li', { class: 'item', text: `${formatDateTime(b.createdAt)}: ${b.reason} (until ${b.expiresAt ? formatDateTime(b.expiresAt) : 'lifted'}${b.revokedAt ? `, lifted ${formatDateTime(b.revokedAt)}` : ''})` })))
          : el('p', { class: 'form-help', text: 'Never banned.' }),
      ),
    );
    if (Array.isArray(d.passkeys) && d.passkeys.length) {
      parts.push(detailsBlock(`Passkeys (${d.passkeys.length})`, el('ul', { class: 'item-list' }, ...d.passkeys.map((p) => el('li', { class: 'item', text: `${p.name}, added ${formatDateTime(p.createdAt)}, last used ${formatDateTime(p.lastUsedAt)}${p.counterError ? ' (counter error: may be cloned)' : ''}` })))));
    }
    if (can.settings) parts.push(settingsEditor(u));
    body.replaceChildren(...parts);
  }

  function detailsBlock(title, content) {
    return el('details', { class: 'detail-block' }, el('summary', { text: title }), content);
  }

  function editForm(u, status, reload) {
    const username = field('Username', el('input', { type: 'text', value: u.username, maxlength: String(USERNAME_MAX) }));
    const displayName = field('Display name', el('input', { type: 'text', value: u.displayName ?? '', maxlength: String(DISPLAY_NAME_MAX) }));
    const email = field('Email', el('input', { type: 'email', value: u.email ?? '', maxlength: String(EMAIL_MAX) }), { help: 'Empty removes it.' });
    const verified = checkbox('Email verified', { checked: u.emailVerified });
    const color = field('Colour', el('input', { type: 'color', value: u.avatarColor ?? '#4a82c4' }));
    const statusSel = el('select', {}, ...SETTABLE_STATUSES.map((s) => el('option', { value: s, text: STATUS_LABELS[s] })));
    statusSel.value = SETTABLE_STATUSES.includes(u.storedStatus) ? u.storedStatus : 'active';
    statusSel.disabled = u.storedStatus === 'deleted';
    const st = field('Status', statusSel, { help: 'Bans and deletion have their own buttons.' });
    const roleSel = el('select', {}, ...ROLES.map((r) => el('option', { value: r, text: r })));
    roleSel.value = u.role;
    roleSel.disabled = u.id === me.id;
    const role = field('Role', roleSel, { help: u.id === me.id ? 'You cannot change your own role.' : 'A role change signs the account out everywhere.' });
    const flags = Object.entries(FLAGS).map(([f, label]) => [f, checkbox(label, { checked: u.flags?.includes(f) })]);
    const save = el('button', { type: 'submit', class: 'btn btn-primary', text: 'Save changes' });
    const form = el('form', { class: 'form-grid', novalidate: true }, username.row, displayName.row, email.row, verified.row, color.row, st.row, role.row, el('fieldset', { class: 'check-group' }, el('legend', { text: 'Flags' }), ...flags.map(([, c]) => c.row)), el('div', { class: 'form-actions' }, save));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const patch = {};
      if (username.input.value.trim() !== u.username) patch.username = username.input.value.trim();
      if (displayName.input.value.trim() !== (u.displayName ?? '')) patch.displayName = displayName.input.value.trim();
      const mail = email.input.value.trim();
      if (mail !== (u.email ?? '')) patch.email = mail || null;
      if (verified.input.checked !== u.emailVerified) patch.emailVerified = verified.input.checked;
      if (color.input.value.toLowerCase() !== u.avatarColor) patch.avatarColor = color.input.value.toLowerCase();
      if (!statusSel.disabled && statusSel.value !== u.storedStatus) patch.status = statusSel.value;
      if (!roleSel.disabled && roleSel.value !== u.role) patch.role = roleSel.value;
      const nextFlags = flags.filter(([, c]) => c.input.checked).map(([f]) => f);
      if (JSON.stringify([...nextFlags].sort()) !== JSON.stringify([...(u.flags ?? [])].sort())) patch.flags = nextFlags;
      if (!Object.keys(patch).length) return status.show('Nothing changed.', 'info');
      if (patch.role && !(await confirmDialog('Change role', `Make ${u.username} ${patch.role}? They are signed out everywhere.`, { confirmText: 'Change role' }))) return;
      await busy(save, status, async () => {
        await api.updateUser(u.id, patch);
        status.show('Saved.', 'ok');
        await reload();
        refreshTable();
      }, errorText);
    });
    return detailsBlock('Edit profile, status, role and flags', form);
  }

  function banDialog(u) {
    return openDialog(`Ban ${u.username}`, (body, close) => {
      const status = statusLine();
      const reason = field('Reason', el('textarea', { rows: '3', maxlength: String(BAN_REASON_MAX), required: true }), { help: `Shown to the player. At most ${BAN_REASON_MAX} characters.` });
      const until = field('Until', el('input', { type: 'datetime-local' }), { help: 'Empty: permanent.' });
      const presets = el(
        'div',
        { class: 'form-actions' },
        ...BAN_PRESETS.map(([label, ms]) => {
          const b = el('button', { type: 'button', class: 'btn btn-small', text: label });
          b.addEventListener('click', () => (until.input.value = ms ? localInputValue(now() + ms) : ''));
          return b;
        }),
      );
      const submit = el('button', { type: 'submit', class: 'btn btn-danger', text: 'Ban' });
      const form = el('form', { class: 'form-stack', novalidate: true }, status.node, reason.row, until.row, presets, el('div', { class: 'form-actions' }, submit));
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const text = reason.input.value.trim();
        if (!text) return status.show('Give a reason.', 'error');
        const exp = banExpiry(until.input.value, now());
        if (exp.error) return status.show(exp.error, 'error');
        await busy(submit, status, async () => {
          await api.banUser(u.id, text, exp.expiresAt);
          close(true);
        }, errorText);
      });
      body.append(el('p', { text: 'A ban signs the account out everywhere and drops it from running games.' }), form);
    });
  }

  function resetLinkDialog(u) {
    return openDialog(`Password reset link for ${u.username}`, (body) => {
      const status = statusLine();
      const out = el('div', { class: 'form-stack' });
      const make = (send) => {
        const b = el('button', { type: 'button', class: send ? 'btn' : 'btn btn-primary', text: send ? 'Create and email it' : 'Create link' });
        b.addEventListener('click', () =>
          busy(b, status, async () => {
            const r = await api.resetLink(u.id, send);
            const input = el('input', { type: 'text', value: r.url, readonly: true, 'aria-label': 'Reset link' });
            out.replaceChildren(input, el('p', { class: 'form-help', text: `Valid until ${formatDateTime(r.expiresAt)}.${r.sent ? ' It was emailed too.' : ' Send it to the player yourself.'}` }));
            input.focus();
            input.select?.();
          }, errorText),
        );
        return b;
      };
      body.append(status.node, el('div', { class: 'form-actions' }, make(false), u.email ? make(true) : null), out);
    });
  }

  function typeToConfirm(title, message, expected) {
    return openDialog(title, (body, close) => {
      const f = field('Username', el('input', { type: 'text', autocomplete: 'off' }));
      const ok = el('button', { type: 'submit', class: 'btn btn-danger', text: title });
      const form = el('form', { class: 'form-stack', novalidate: true }, el('p', { text: message }), f.row, el('div', { class: 'form-actions' }, ok));
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        close(f.input.value === expected ? expected : null);
      });
      body.append(form);
    });
  }

  // ---- Settings editor -------------------------------------------------------------------------
  function settingsEditor(u) {
    const box = el('div', { class: 'form-stack' }, el('p', { class: 'status-line', text: 'Loading...' }));
    const block = detailsBlock('Settings', box);
    let loaded = false;
    block.addEventListener('toggle', () => {
      if (block.open && !loaded) {
        loaded = true;
        load();
      }
    });
    async function load() {
      const status = statusLine();
      let current;
      try {
        current = await api.userSettings(u.id);
      } catch (err) {
        box.replaceChildren(el('p', { class: 'notice notice-error', text: errorText(err) }));
        return;
      }
      let version = current.version;
      let form = buildSettingsForm(current.settings ?? {});
      const formBox = el('div', {}, form.node);
      const raw = el('textarea', { rows: '16', spellcheck: 'false', class: 'code', 'aria-label': 'Settings document as JSON' });
      const rawErrors = el('ul', { class: 'form-status form-status-error', role: 'alert', hidden: true });
      const rawBox = el('div', { class: 'form-stack', hidden: true }, el('p', { class: 'form-help', text: 'The whole document. It is checked as you type; unknown settings are refused, except in "extra".' }), raw, rawErrors);
      const formMode = el('button', { type: 'button', 'aria-pressed': 'true', text: 'Form' });
      const rawMode = el('button', { type: 'button', 'aria-pressed': 'false', text: 'JSON' });
      const mode = el('div', { class: 'segmented', role: 'group', 'aria-label': 'Editor' }, formMode, rawMode);
      const showRawErrors = (errors) => {
        rawErrors.replaceChildren(...errors.map((e) => el('li', { text: `${e.path || 'document'} ${e.message}` })));
        rawErrors.hidden = !errors.length;
      };
      /** The JSON editor's document when it is valid, else null (problems shown). */
      const checkRaw = () => {
        let parsed;
        try {
          parsed = JSON.parse(raw.value);
        } catch (err) {
          showRawErrors([{ path: '', message: `is not valid JSON: ${err.message}` }]);
          return null;
        }
        const r = checkDocument(parsed);
        showRawErrors(r.errors);
        return r.ok ? parsed : null;
      };
      const setMode = (json) => {
        formMode.setAttribute('aria-pressed', String(!json));
        rawMode.setAttribute('aria-pressed', String(json));
        formBox.hidden = json;
        rawBox.hidden = !json;
      };
      rawMode.addEventListener('click', () => {
        const r = form.read();
        if (r.errors.length) return status.show('Fix the settings marked in the form first.', 'error');
        raw.value = JSON.stringify(r.document, null, 2);
        showRawErrors([]);
        setMode(true);
      });
      formMode.addEventListener('click', () => {
        const parsed = checkRaw();
        if (!parsed) return status.show('Fix the JSON first.', 'error');
        form = buildSettingsForm(parsed);
        formBox.replaceChildren(form.node);
        status.clear();
        setMode(false);
      });
      raw.addEventListener('input', () => checkRaw());
      const save = el('button', { type: 'button', class: 'btn btn-primary', text: 'Save settings' });
      const meta = el('p', { class: 'form-help', text: `Version ${version}${current.updatedAt ? `, saved ${formatDateTime(current.updatedAt)}` : ', nothing stored yet'}.` });
      save.addEventListener('click', async () => {
        let next;
        if (!rawBox.hidden) {
          next = checkRaw();
          if (!next) return status.show('Fix the problems in the JSON first.', 'error');
        } else {
          const r = form.read();
          if (r.errors.length) return status.show(`Fix ${r.errors.length} setting${r.errors.length === 1 ? '' : 's'} first.`, 'error');
          next = r.document;
        }
        await busy(save, status, async () => {
          try {
            const res = await api.putUserSettings(u.id, version, next);
            version = res.version;
            meta.textContent = `Version ${version}, saved ${formatDateTime(res.updatedAt)}.`;
            status.show('Saved. The player gets them on their next sync.', 'ok');
          } catch (err) {
            if (err instanceof AccountError && err.code === 'version_conflict') {
              const cur = err.detail.current;
              const choice = await openDialog('Settings changed meanwhile', (b, close) => {
                const keep = el('button', { type: 'button', class: 'btn btn-danger', text: 'Save mine over them' });
                const take = el('button', { type: 'button', class: 'btn btn-primary', text: 'Load the new version' });
                keep.addEventListener('click', () => close('overwrite'));
                take.addEventListener('click', () => close('reload'));
                b.append(el('p', { text: `The player's settings changed (now version ${cur.version}) while you were editing.` }), el('div', { class: 'form-actions' }, take, keep));
              });
              if (choice === 'overwrite') {
                const res = await api.putUserSettings(u.id, cur.version, next);
                version = res.version;
                status.show('Saved over the newer version.', 'ok');
              } else if (choice === 'reload') {
                load();
              }
              return;
            }
            throw err;
          }
        }, errorText);
      });
      box.replaceChildren(meta, mode, status.node, formBox, rawBox, el('div', { class: 'form-actions' }, save));
    }
    return block;
  }

  function refreshTable() {
    if (view.tab === 'users') reloadUsers?.();
  }

  // ---- IP bans -----------------------------------------------------------------------------------
  function ipBanDialog(cidr = '', reasonText = '') {
    return openDialog('Ban an address or range', (body, close) => {
      const status = statusLine();
      const range = field('Address or range', el('input', { type: 'text', value: cidr, spellcheck: 'false', placeholder: '203.0.113.7 or 203.0.113.0/24' }), { help: 'IPv4 from /8, IPv6 from /16. You cannot ban your own address.' });
      const reason = field('Reason', el('input', { type: 'text', value: reasonText, maxlength: String(BAN_REASON_MAX) }));
      const until = field('Until', el('input', { type: 'datetime-local' }), { help: 'Empty: permanent.' });
      const submit = el('button', { type: 'submit', class: 'btn btn-danger', text: 'Ban' });
      const form = el('form', { class: 'form-stack', novalidate: true }, status.node, range.row, reason.row, until.row, el('div', { class: 'form-actions' }, submit));
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!looksLikeCidr(range.input.value)) return status.show('Enter an IPv4 or IPv6 address, or a range such as 203.0.113.0/24.', 'error');
        if (!reason.input.value.trim()) return status.show('Give a reason.', 'error');
        const exp = banExpiry(until.input.value, now());
        if (exp.error) return status.show(exp.error, 'error');
        await busy(submit, status, async () => {
          await api.createIpBan({ cidr: range.input.value.trim(), reason: reason.input.value.trim(), expiresAt: exp.expiresAt });
          close(true);
          if (view.tab === 'ip-bans') renderIpBans();
        }, errorText);
      });
      body.append(form);
    });
  }

  async function renderIpBans() {
    const status = statusLine();
    const add = el('button', { type: 'button', class: 'btn btn-danger', text: 'Ban an address or range' });
    add.addEventListener('click', () => ipBanDialog());
    const activeOnly = checkbox('Only bans in effect', { checked: true });
    const list = el('tbody');
    const load = async () => {
      try {
        const r = await api.ipBans(activeOnly.input.checked ? { active: 1 } : {});
        list.replaceChildren(
          ...r.bans.map((b) => {
            const lift = el('button', { type: 'button', class: 'btn btn-small', text: 'Remove' });
            lift.addEventListener('click', async () => {
              if (!(await confirmDialog('Remove IP ban', `Remove the ban of ${b.cidr}?`, { confirmText: 'Remove' }))) return;
              await busy(lift, status, async () => (await api.deleteIpBan(b.id), load()), errorText);
            });
            const edit = el('button', { type: 'button', class: 'btn btn-small', text: 'Edit' });
            edit.addEventListener('click', async () => {
              const changed = await openDialog(`Edit ban of ${b.cidr}`, (body, close) => {
                const s = statusLine();
                const reason = field('Reason', el('input', { type: 'text', value: b.reason, maxlength: String(BAN_REASON_MAX) }));
                const until = field('Until', el('input', { type: 'datetime-local', value: b.expiresAt ? localInputValue(b.expiresAt) : '' }), { help: 'Empty: permanent.' });
                const ok = el('button', { type: 'submit', class: 'btn btn-primary', text: 'Save' });
                const form = el('form', { class: 'form-stack', novalidate: true }, s.node, reason.row, until.row, el('div', { class: 'form-actions' }, ok));
                form.addEventListener('submit', async (e) => {
                  e.preventDefault();
                  const exp = banExpiry(until.input.value, now());
                  if (exp.error) return s.show(exp.error, 'error');
                  await busy(ok, s, async () => (await api.updateIpBan(b.id, { reason: reason.input.value.trim(), expiresAt: exp.expiresAt }), close(true)), errorText);
                });
                body.append(form);
              });
              if (changed) load();
            });
            return el('tr', {}, el('th', { scope: 'row' }, el('code', { text: b.cidr })), el('td', { text: b.reason }), el('td', { text: formatDateTime(b.createdAt) }), el('td', { text: b.expiresAt ? formatDateTime(b.expiresAt) : 'never' }), el('td', {}, b.active ? el('span', { class: 'badge badge-open', text: 'In effect' }) : el('span', { class: 'badge', text: 'Ended' })), el('td', { class: 'row-actions' }, edit, lift));
          }),
        );
        if (!r.bans.length) list.append(el('tr', {}, el('td', { colspan: '6', class: 'form-help', text: 'No IP bans.' })));
      } catch (err) {
        status.show(errorText(err), 'error');
      }
    };
    activeOnly.input.addEventListener('change', load);
    panel.replaceChildren(
      el('div', { class: 'controls' }, add, activeOnly.row),
      status.node,
      el(
        'div',
        { class: 'table-wrap' },
        el(
          'table',
          { class: 'data-table' },
          el('caption', { class: 'visually-hidden', text: 'IP bans' }),
          el('thead', {}, el('tr', {}, ...['Range', 'Reason', 'Created', 'Until', 'State', 'Actions'].map((t) => el('th', { scope: 'col', text: t })))),
          list,
        ),
      ),
    );
    load();
  }

  // ---- Site settings -----------------------------------------------------------------------------
  async function renderSite() {
    const status = statusLine();
    panel.replaceChildren(status.node, el('p', { class: 'status-line', text: 'Loading...' }));
    let site;
    try {
      site = await api.adminSite();
    } catch (err) {
      panel.replaceChildren(el('p', { class: 'notice notice-error', role: 'alert', text: errorText(err) }));
      return;
    }
    const s = site.settings;
    const svc = site.services ?? {};
    const eff = site.effective ?? {};
    const unavailable = (on, ok, why) => (on && !ok ? el('span', { class: 'badge badge-warn', text: why }) : null);
    const toggle = (label, checked, help, badge) => {
      const c = checkbox(label, { checked, help });
      if (badge) c.row.append(badge);
      return c;
    };
    const open = toggle('Registration open', s.registration.open, 'New players can sign up (every method).');
    const approval = toggle('Approval required (closed beta)', s.registration.approvalRequired, 'Off: open beta, new accounts are active at once.');
    const verify = toggle('Email verification required', s.registration.emailVerification, 'Only in effect while email sending is available.', unavailable(s.registration.emailVerification, eff.registration?.emailVerificationRequired, 'Not in effect: no email'));
    const loginPw = toggle('Password sign-in', s.login.password);
    const loginEmail = toggle('Email (verification, reset and change links)', s.login.email, null, unavailable(s.login.email, svc.email, 'Unavailable until the email plan is upgraded'));
    const loginDiscord = toggle('Discord sign-in', s.login.discord, null, unavailable(s.login.discord, svc.discord, 'Unavailable: Discord is not configured'));
    const loginPasskey = toggle('Passkeys', s.login.passkey);
    const online = toggle('Online play needs an account', s.onlineRequiresAccount, 'Off: anonymous players can host and join (IP bans still apply).');
    const relay = toggle('One-click content relay', s.contentRelay, 'Only for accounts with the one-click flag, and admins.');
    const motd = field('Message of the day', el('textarea', { rows: '3', maxlength: String(MOTD_MAX) }), { help: `Plain text, shown on the start screen and the account page. At most ${MOTD_MAX} characters.` });
    motd.input.value = s.motd ?? '';
    const save = el('button', { type: 'submit', class: 'btn btn-primary', text: 'Save site settings' });
    const form = el(
      'form',
      { class: 'form-stack', novalidate: true },
      el('fieldset', { class: 'check-group' }, el('legend', { text: 'Registration' }), open.row, approval.row, verify.row),
      el('fieldset', { class: 'check-group' }, el('legend', { text: 'Sign-in methods' }), loginPw.row, loginEmail.row, loginDiscord.row, loginPasskey.row),
      el('fieldset', { class: 'check-group' }, el('legend', { text: 'Play' }), online.row, relay.row),
      motd.row,
      el('div', { class: 'form-actions' }, save),
    );
    let version = site.version;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const patch = {
        registration: { open: open.input.checked, approvalRequired: approval.input.checked, emailVerification: verify.input.checked },
        login: { password: loginPw.input.checked, email: loginEmail.input.checked, discord: loginDiscord.input.checked, passkey: loginPasskey.input.checked },
        onlineRequiresAccount: online.input.checked,
        contentRelay: relay.input.checked,
        motd: motd.input.value.replace(/\r\n/g, '\n').slice(0, MOTD_MAX),
      };
      if (!patch.login.password && !patch.login.passkey && !(patch.login.discord && svc.discord)) {
        if (!(await confirmDialog('No sign-in method', 'With these settings nobody can sign in (also you). Save anyway?', { confirmText: 'Save anyway', danger: true }))) return;
      }
      await busy(save, status, async () => {
        try {
          const r = await api.patchSite(version, patch);
          version = r.settings?.version ?? version + 1;
          status.show('Saved.', 'ok');
          renderSite();
        } catch (err) {
          if (err instanceof AccountError && err.code === 'version_conflict') {
            status.show('Another admin changed the site settings meanwhile. They are loaded again: check and save once more.', 'error');
            setTimeout(renderSite, 0);
            return;
          }
          throw err;
        }
      }, errorText);
    });
    panel.replaceChildren(
      status.node,
      el('p', { class: 'form-help', text: `Email sending: ${svc.email ? 'available' : 'not available (needs the email plan)'}. Discord: ${svc.discord ? 'configured' : 'not configured'}.` }),
      form,
    );
  }

  // ---- Audit log ------------------------------------------------------------------------------------
  async function renderAudit() {
    const status = statusLine();
    const action = el('select', {}, el('option', { value: '', text: 'All actions' }), ...AUDIT_ACTIONS.map((a) => el('option', { value: a, text: a })));
    action.value = audit.action;
    const actor = field('Actor id', el('input', { type: 'text', value: audit.actor, spellcheck: 'false', maxlength: '32' }));
    const target = field('Target id', el('input', { type: 'text', value: audit.target, spellcheck: 'false', maxlength: '32' }));
    const since = field('From', el('input', { type: 'date', value: audit.since }));
    const until = field('To', el('input', { type: 'date', value: audit.until }));
    const apply = el('button', { type: 'submit', class: 'btn', text: 'Filter' });
    const form = el('form', { class: 'controls', novalidate: true }, field('Action', action).row, actor.row, target.row, since.row, until.row, apply);
    const list = el('ol', { class: 'audit-list' });
    const range = el('span', { class: 'form-help' });
    const prev = el('button', { type: 'button', class: 'btn btn-small', text: 'Newer' });
    const next = el('button', { type: 'button', class: 'btn btn-small', text: 'Older' });
    const load = async () => {
      setHash();
      try {
        const r = await api.audit(auditParams(audit));
        list.replaceChildren(
          ...r.entries.map((e) =>
            el(
              'li',
              { class: 'audit-entry' },
              el('div', {}, el('strong', { text: e.action }), el('span', { class: 'form-help', text: ` ${formatDateTime(e.at)} by ${e.actor ? e.actor.username : 'the system'}` })),
              el('div', { text: `${e.target?.type ?? ''} ${e.target?.label ?? e.target?.id ?? ''}${e.reason ? `. Reason: ${e.reason}` : ''}` }),
              e.before || e.after ? el('details', {}, el('summary', { text: 'Before and after' }), el('pre', { class: 'code', text: JSON.stringify({ before: e.before, after: e.after }, null, 2) })) : null,
            ),
          ),
        );
        if (!r.entries.length) list.append(el('li', { class: 'form-help', text: 'No entries match.' }));
        const pages = Math.max(1, Math.ceil(r.total / (r.limit || 25)));
        range.textContent = `Page ${audit.page} of ${pages} (${r.total} entries)`;
        prev.disabled = audit.page <= 1;
        next.disabled = audit.page >= pages;
      } catch (err) {
        status.show(errorText(err), 'error');
      }
    };
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const f = auditFilter({ action: action.value, actor: actor.input.value.trim(), target: target.input.value.trim(), since: since.input.value, until: until.input.value });
      if (actor.input.value.trim() && !f.actor) return status.show('The actor is a user id: 32 lower case hex characters.', 'error');
      if (target.input.value.trim() && !f.target) return status.show('The target is an id: lower case letters and digits.', 'error');
      audit = f;
      status.clear();
      load();
    });
    prev.addEventListener('click', () => ((audit = { ...audit, page: audit.page - 1 }), load()));
    next.addEventListener('click', () => ((audit = { ...audit, page: audit.page + 1 }), load()));
    panel.replaceChildren(form, status.node, list, el('div', { class: 'pager' }, prev, range, next));
    load();
  }

  show(view.user ? 'users' : view.tab);
  return { table, show, openUser };
}

const root = globalThis.document?.getElementById?.('admin-root');
if (root) mountAdmin(root);
