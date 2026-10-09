// State of the admin dashboard without DOM (apps/website/assets/admin.js):
// what a role may do (docs/accounts-api.md 2.3), the users table (search,
// filters, sorting, pages, selection for bulk actions) and the audit log
// filters, kept in the address fragment so a view can be shared and reloaded.

export const STATUSES = Object.freeze(['pending_email', 'pending_approval', 'active', 'banned', 'deleted']);
export const ROLES = Object.freeze(['user', 'moderator', 'admin']);
export const FLAGS = Object.freeze({ content_autoinstall: 'One-click content install' });
export const SORTS = Object.freeze({ created: 'Created', lastSeen: 'Last seen', username: 'Username' });
export const AUDIT_ACTIONS = Object.freeze([
  'user.update',
  'user.approve',
  'user.reject',
  'user.ban',
  'user.unban',
  'user.logout',
  'user.session_revoke',
  'user.password_reset_link',
  'user.delete',
  'user.restore',
  'user.purge',
  'user.settings_update',
  'ipban.create',
  'ipban.update',
  'ipban.delete',
  'site.update',
]);

export const STATUS_LABELS = Object.freeze({
  pending_email: 'Email not verified',
  pending_approval: 'Waiting for approval',
  active: 'Active',
  banned: 'Banned',
  deleted: 'Deleted',
});

/**
 * What a signed-in staff member may do (2.3). The server checks again;
 * this decides what the dashboard shows.
 */
export function permissions(role) {
  const admin = role === 'admin';
  const staff = admin || role === 'moderator';
  return {
    dashboard: staff,
    stats: staff,
    users: staff,
    approve: staff,
    /** Ban and unban: moderators only plain users. */
    ban: staff,
    banStaff: admin,
    fullDetail: admin,
    edit: admin,
    sessions: admin,
    resetLink: admin,
    delete: admin,
    settings: admin,
    ipBans: admin,
    site: admin,
    audit: admin,
  };
}

/** Whether `viewer` may ban or unban `target` (never self; staff targets need an admin). */
export function canBan(viewer, target) {
  if (!viewer || !target || viewer.id === target.id) return false;
  const p = permissions(viewer.role);
  if (!p.ban) return false;
  return target.role === 'user' || p.banStaff;
}

export const DEFAULT_QUERY = Object.freeze({ q: '', status: '', role: '', flag: '', sort: 'created', order: 'desc', page: 1, limit: 25 });

/** A valid users query from anything (the fragment, a form). */
export function normalizeQuery(raw = {}) {
  const q = { ...DEFAULT_QUERY };
  if (typeof raw.q === 'string') q.q = raw.q.slice(0, 100);
  if (STATUSES.includes(raw.status)) q.status = raw.status;
  if (ROLES.includes(raw.role)) q.role = raw.role;
  if (Object.hasOwn(FLAGS, raw.flag)) q.flag = raw.flag;
  if (Object.hasOwn(SORTS, raw.sort)) q.sort = raw.sort;
  if (raw.order === 'asc' || raw.order === 'desc') q.order = raw.order;
  const page = Number(raw.page);
  if (Number.isInteger(page) && page >= 1 && page <= 100000) q.page = page;
  const limit = Number(raw.limit);
  if ([10, 25, 50, 100].includes(limit)) q.limit = limit;
  return q;
}

/** The API query of a table state: only what differs from the server's defaults is sent. */
export function apiQuery(q) {
  const out = {};
  for (const k of ['q', 'status', 'role', 'flag']) if (q[k]) out[k] = q[k];
  if (q.sort !== 'created') out.sort = q.sort;
  if (q.order !== 'desc') out.order = q.order;
  if (q.page !== 1) out.page = q.page;
  if (q.limit !== 25) out.limit = q.limit;
  return out;
}

/**
 * The users table: query, results and selection. Every change returns a new
 * query; changing a filter or the search goes back to page 1, and the
 * selection keeps only rows still shown.
 */
export class UsersTable {
  constructor(query = DEFAULT_QUERY) {
    this.query = normalizeQuery(query);
    this.users = [];
    this.total = 0;
    this.selected = new Set();
  }

  /** Change filters or the search (back to page 1). */
  filter(patch) {
    this.query = normalizeQuery({ ...this.query, ...patch, page: 1 });
    return this.query;
  }

  /** Sort by a column; the same column again flips the order. */
  sortBy(column) {
    if (!Object.hasOwn(SORTS, column)) return this.query;
    const order = this.query.sort === column ? (this.query.order === 'asc' ? 'desc' : 'asc') : column === 'username' ? 'asc' : 'desc';
    this.query = normalizeQuery({ ...this.query, sort: column, order, page: 1 });
    return this.query;
  }

  goTo(page) {
    this.query = normalizeQuery({ ...this.query, page: Math.max(1, Math.min(this.pages, page)) });
    return this.query;
  }

  get pages() {
    return Math.max(1, Math.ceil(this.total / this.query.limit));
  }

  /** Take an answer of GET /api/admin/users. */
  setResult({ users = [], total = 0 } = {}) {
    this.users = users;
    this.total = total;
    const shown = new Set(users.map((u) => u.id));
    for (const id of [...this.selected]) if (!shown.has(id)) this.selected.delete(id);
  }

  toggle(id, on = !this.selected.has(id)) {
    if (on) this.selected.add(id);
    else this.selected.delete(id);
  }

  toggleAll(on) {
    this.selected = on ? new Set(this.users.map((u) => u.id)) : new Set();
  }

  /** Selected users that a bulk action applies to (approve and reject: pending ones). */
  selectedFor(action) {
    const rows = this.users.filter((u) => this.selected.has(u.id));
    if (action === 'approve' || action === 'reject') return rows.filter((u) => u.status === 'pending_approval' || u.status === 'pending_email');
    return rows;
  }

  /** "26 to 50 of 132" */
  rangeText() {
    if (!this.total) return 'No users';
    const from = (this.query.page - 1) * this.query.limit + 1;
    const to = Math.min(this.total, from + this.users.length - 1);
    return `${from} to ${to} of ${this.total}`;
  }
}

/** The dashboard view in the fragment: `#users?status=pending_approval&page=2`, `#user=<id>`, `#site`. */
export function parseView(hash) {
  const h = String(hash ?? '').replace(/^#/, '');
  const [name, rest = ''] = h.split('?');
  const params = Object.fromEntries(new URLSearchParams(rest));
  const m = /^user=([0-9a-f]{8,64})$/.exec(name);
  if (m) return { tab: 'users', user: m[1], query: normalizeQuery(params) };
  const tab = ['overview', 'users', 'ip-bans', 'site', 'audit'].includes(name) ? name : 'overview';
  return { tab, user: null, query: normalizeQuery(params), audit: auditFilter(params) };
}

/** The fragment of a view. */
export function viewHash({ tab, user = null, query = DEFAULT_QUERY, audit = null }) {
  const auditFields = audit ? Object.fromEntries(Object.entries(audit).filter(([k, v]) => v && !(k === 'page' && v === 1))) : {};
  const params = new URLSearchParams(tab === 'audit' ? auditFields : tab === 'users' || user ? apiQuery(query) : {}).toString();
  const name = user ? `user=${user}` : tab;
  return `#${name}${params ? `?${params}` : ''}`;
}

/** Audit log filters (8.9): actor and target ids, action, a date range (YYYY-MM-DD), page. */
export function auditFilter(raw = {}) {
  const id = (v) => (typeof v === 'string' && /^[0-9a-f]{1,64}$/.test(v) ? v : '');
  const day = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) ? v : '');
  const page = Number(raw.page);
  return {
    actor: id(raw.actor),
    target: id(raw.target),
    action: AUDIT_ACTIONS.includes(raw.action) ? raw.action : '',
    since: day(raw.since),
    until: day(raw.until),
    page: Number.isInteger(page) && page >= 1 ? page : 1,
  };
}

/** API query of audit filters: dates become Unix milliseconds (until: the end of that day, UTC). */
export function auditParams(f) {
  const out = {};
  if (f.actor) out.actor = f.actor;
  if (f.target) out.target = f.target;
  if (f.action) out.action = f.action;
  if (f.since) out.since = Date.parse(`${f.since}T00:00:00Z`);
  if (f.until) out.until = Date.parse(`${f.until}T23:59:59.999Z`);
  if (f.page > 1) out.page = f.page;
  return out;
}

/**
 * A ban end from the form: '' (permanent) or a date and time in the
 * future (datetime-local text, read as local time). Returns `{ expiresAt }`
 * or `{ error }`.
 */
export function banExpiry(text, now = Date.now()) {
  if (!text) return { expiresAt: null };
  const t = new Date(text).getTime();
  if (!Number.isFinite(t)) return { error: 'The end date is not valid.' };
  if (t <= now) return { error: 'The end must be in the future.' };
  return { expiresAt: t };
}

/** Quick ban lengths for the ban form. */
export const BAN_PRESETS = Object.freeze([
  ['1 hour', 3_600_000],
  ['1 day', 86_400_000],
  ['7 days', 7 * 86_400_000],
  ['30 days', 30 * 86_400_000],
  ['Permanent', null],
]);

/** A datetime-local value (local time, minutes) for Unix milliseconds. */
export function localInputValue(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** A rough check of an IP address or CIDR range before the server checks it for real. */
export function looksLikeCidr(text) {
  const t = String(text ?? '').trim();
  const v4 = /^(\d{1,3})(\.\d{1,3}){3}(\/(\d{1,2}))?$/.exec(t);
  if (v4) return t.split('/')[0].split('.').every((o) => Number(o) <= 255) && (v4[4] === undefined || (Number(v4[4]) >= 8 && Number(v4[4]) <= 32));
  const v6 = /^([0-9a-f:]+)(\/(\d{1,3}))?$/i.exec(t);
  return !!v6 && v6[1].includes(':') && (v6[3] === undefined || (Number(v6[3]) >= 16 && Number(v6[3]) <= 128));
}
