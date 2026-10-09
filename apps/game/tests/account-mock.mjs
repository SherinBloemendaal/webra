// An in-memory server that implements the accounts and admin API contract
// (docs/accounts-api.md) closely enough for client tests: CSRF and content
// type rules, error shapes, sessions (one cookie jar per mock), roles,
// account states, versioned settings documents (ETag, If-Match, 412 with
// `current`), site settings, bans, IP bans, audit log and stats.
//
//   const server = new MockAccountServer();
//   const api = new AccountApi({ fetchImpl: server.fetch });

const hex = (n) => Array.from({ length: n }, (_, i) => ((i * 7 + n) % 16).toString(16)).join('');
let seq = 0;
const newId = (n = 32) => (hex(n - 8) + (++seq).toString(16).padStart(8, '0')).slice(-n);

export class MockAccountServer {
  constructor() {
    this.now = 1_760_000_000_000;
    this.users = new Map();
    this.sessions = new Map(); // id -> { id, userId, createdAt, lastUsedAt, expiresAt, deviceLabel, reauthUntil }
    this.cookie = null; // the session id of "this browser"
    this.settingsDocs = new Map(); // userId -> { version, updatedAt, settings }
    this.ipBans = [];
    this.audit = [];
    this.requests = [];
    this.offline = false;
    this.site = {
      version: 1,
      registration: { open: true, approvalRequired: true, emailVerification: true },
      login: { password: true, email: true, discord: true, passkey: true },
      onlineRequiresAccount: true,
      contentRelay: true,
      motd: '',
    };
    this.services = { email: false, discord: false };
    this.fetch = this.fetch.bind(this);
  }

  // ---- Helpers ----------------------------------------------------------------------------

  addUser(fields) {
    const id = newId();
    const u = {
      id,
      username: fields.username,
      displayName: fields.displayName ?? fields.username,
      email: fields.email ?? null,
      emailVerified: !!fields.emailVerified,
      pendingEmail: null,
      avatarColor: '#c8402a',
      role: fields.role ?? 'user',
      status: fields.status ?? 'active',
      flags: fields.flags ?? [],
      createdAt: this.now - (fields.age ?? 0),
      lastSeenAt: this.now,
      usernameChangedAt: null,
      password: fields.password ?? null,
      passkeys: [],
      discord: null,
      ban: null,
      bans: [],
      ips: [{ ip: '203.0.113.7', firstSeen: this.now, lastSeen: this.now, count: 1 }],
      approvedAt: null,
      approvedBy: null,
      deletedAt: null,
    };
    this.users.set(id, u);
    return u;
  }

  signIn(user) {
    const id = newId(16);
    this.sessions.set(id, { id, userId: user.id, createdAt: this.now, lastUsedAt: this.now, expiresAt: this.now + 30 * 864e5, deviceLabel: 'Firefox on Linux', userAgent: 'Firefox on Linux', reauthUntil: this.now + 600_000 });
    this.cookie = id;
    return id;
  }

  current() {
    const s = this.cookie && this.sessions.get(this.cookie);
    return s ? { session: s, user: this.users.get(s.userId) } : null;
  }

  effectiveStatus(u) {
    return u.ban ? 'banned' : u.status;
  }

  effectiveSite() {
    const email = this.site.login.email && this.services.email;
    return {
      registration: { open: this.site.registration.open, approvalRequired: this.site.registration.approvalRequired, emailVerificationRequired: this.site.registration.emailVerification && email },
      login: { password: this.site.login.password, email, discord: this.site.login.discord && this.services.discord, passkey: this.site.login.passkey },
      services: { ...this.services },
      onlineRequiresAccount: this.site.onlineRequiresAccount,
      contentRelay: this.site.contentRelay,
      motd: this.site.motd,
      passkey: { rpId: 'webra.sherin.dev' },
      policy: { usernameMin: 3, usernameMax: 24, passwordMin: 10, passwordMax: 128, displayNameMax: 32 },
      privacyUrl: '/privacy.html',
    };
  }

  self(u) {
    const status = this.effectiveStatus(u);
    return {
      id: u.id,
      username: u.username,
      displayName: u.displayName,
      email: u.email,
      emailVerified: u.emailVerified,
      pendingEmail: u.pendingEmail,
      avatarColor: u.avatarColor,
      role: u.role,
      status,
      flags: [...u.flags],
      createdAt: u.createdAt,
      lastSeenAt: u.lastSeenAt,
      usernameChangedAt: u.usernameChangedAt,
      methods: { password: !!u.password, discord: u.discord, passkeys: u.passkeys.length },
      ban: u.ban,
      canPlayOnline: status === 'active',
      canUseContentRelay: status === 'active' && this.site.contentRelay && (u.role === 'admin' || u.flags.includes('content_autoinstall')),
    };
  }

  adminUser(u, viewer) {
    const out = {
      id: u.id,
      username: u.username,
      displayName: u.displayName,
      email: u.email,
      emailVerified: u.emailVerified,
      avatarColor: u.avatarColor,
      role: u.role,
      status: this.effectiveStatus(u),
      storedStatus: u.status,
      flags: [...u.flags],
      createdAt: u.createdAt,
      lastSeenAt: u.lastSeenAt,
      approvedAt: u.approvedAt,
      approvedBy: u.approvedBy,
      deletedAt: u.deletedAt,
      methods: { password: !!u.password, discord: u.discord ? { id: '1234', username: u.discord.username } : null, passkeys: u.passkeys.length },
      ban: u.ban,
    };
    if (viewer.role !== 'admin') {
      if (out.email) out.email = out.email.replace(/^(.)[^@]*/, '$1***');
      if (out.methods.discord) delete out.methods.discord.id;
    }
    return out;
  }

  log(actor, action, target, before = null, after = null, reason = null) {
    this.audit.unshift({ id: newId(16), at: this.now, actor: actor ? { id: actor.id, username: actor.username } : null, action, target, before, after, reason });
  }

  // ---- fetch ------------------------------------------------------------------------------

  async fetch(url, init = {}) {
    const method = init.method ?? 'GET';
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    this.requests.push({ method, url, headers, body: init.body });
    if (this.offline) throw new TypeError('Failed to fetch');
    const u = new URL(url, 'https://webra.sherin.dev');
    const path = u.pathname;
    const reply = (status, body, extra = {}) => {
      const h = new Headers({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra });
      return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: h });
    };
    const fail = (status, code, message, more = {}) => reply(status, { error: { code, message, ...more } });
    const needs = method !== 'GET' || /^\/api\/(account|admin)/.test(path);
    if (needs && headers['x-webra-csrf'] !== '1') return fail(403, 'csrf', 'Missing CSRF header.');
    let body = {};
    if (init.body !== undefined) {
      if (headers['content-type'] !== 'application/json') return fail(415, 'bad_message', 'Send JSON.');
      body = JSON.parse(init.body);
    }
    try {
      return await this.route(method, path, u.searchParams, body, headers, { reply, fail });
    } finally {
      this.now += 1000;
    }
  }

  async route(method, path, q, body, headers, { reply, fail }) {
    const cur = this.current();
    const key = `${method} ${path}`;
    const sitePublic = this.effectiveSite();

    // ---- Public and auth
    if (key === 'GET /api/site') return reply(200, sitePublic);
    if (key === 'GET /api/auth/me') {
      if (!cur) return reply(200, { user: null, session: null });
      if (cur.user.ban || cur.user.status === 'deleted') {
        this.sessions.delete(cur.session.id);
        this.cookie = null;
        return reply(200, { user: null, session: null });
      }
      return reply(200, { user: this.self(cur.user), session: { id: cur.session.id, createdAt: cur.session.createdAt, expiresAt: cur.session.expiresAt, reauthUntil: cur.session.reauthUntil } });
    }
    if (key === 'POST /api/auth/signup') {
      if (!this.site.registration.open) return fail(403, 'registration_closed', 'Signup is closed.');
      if (body.acceptPrivacy !== true) return fail(400, 'invalid', 'Accept the privacy notice.', { field: 'acceptPrivacy' });
      if (typeof body.username !== 'string' || body.username.length < 3) return fail(400, 'invalid', 'Username must be 3 to 24 characters.', { field: 'username' });
      if ([...this.users.values()].some((x) => x.username.toLowerCase() === body.username.toLowerCase())) return fail(409, 'conflict', 'That username is taken.', { field: 'username' });
      if (body.password !== undefined && (typeof body.password !== 'string' || body.password.length < 10)) return fail(400, 'invalid', 'Password must be at least 10 characters.', { field: 'password' });
      const status = sitePublic.registration.emailVerificationRequired ? 'pending_email' : this.site.registration.approvalRequired ? 'pending_approval' : 'active';
      const user = this.addUser({ username: body.username, displayName: body.displayName, email: body.email ?? null, password: body.password ?? null, status });
      this.signIn(user);
      return reply(201, { user: this.self(user) });
    }
    if (key === 'POST /api/auth/login') {
      if (!this.site.login.password) return fail(403, 'method_disabled', 'Password sign-in is off.');
      const user = [...this.users.values()].find((x) => (x.username.toLowerCase() === String(body.login).toLowerCase() || x.email === body.login) && x.status !== 'deleted');
      if (!user || user.password !== body.password) return fail(401, 'bad_credentials', 'Wrong login or password.');
      if (user.ban) return fail(403, 'banned', 'This account is banned.', { ban: { reason: user.ban.reason, expiresAt: user.ban.expiresAt } });
      this.signIn(user);
      return reply(200, { user: this.self(user) });
    }
    if (key === 'POST /api/auth/logout') {
      if (cur) this.sessions.delete(cur.session.id);
      this.cookie = null;
      return reply(204);
    }
    if (key === 'POST /api/auth/password/forgot') {
      if (!sitePublic.login.email) return fail(503, 'unavailable', 'Email is not available.');
      return reply(202, {});
    }
    if (key === 'POST /api/auth/password/reset') {
      const user = [...this.users.values()].find((x) => x.resetToken === body.token);
      if (!user) return fail(401, 'bad_credentials', 'This link is not valid any more.');
      user.password = body.password;
      user.resetToken = null;
      for (const [id, s] of this.sessions) if (s.userId === user.id) this.sessions.delete(id);
      this.signIn(user);
      return reply(200, { user: this.self(user) });
    }
    if (key === 'POST /api/auth/email/verify') {
      const user = [...this.users.values()].find((x) => x.verifyToken === body.token);
      if (!user) return fail(401, 'bad_credentials', 'This link is not valid any more.');
      user.emailVerified = true;
      user.verifyToken = null;
      if (user.status === 'pending_email') user.status = this.site.registration.approvalRequired ? 'pending_approval' : 'active';
      return reply(200, { user: cur?.user.id === user.id ? this.self(user) : null });
    }
    if (key === 'POST /api/auth/reauth') {
      if (!cur) return fail(401, 'unauthenticated', 'Sign in first.');
      if (body.password !== cur.user.password) return fail(401, 'bad_credentials', 'Wrong password.');
      cur.session.reauthUntil = this.now + 600_000;
      return reply(200, { reauthUntil: cur.session.reauthUntil });
    }
    if (key === 'POST /api/auth/discord/start') {
      if (!sitePublic.login.discord) return fail(503, 'unavailable', 'Discord is not configured.');
      return reply(200, { url: 'https://discord.com/oauth2/authorize?state=x' });
    }

    // ---- Self service
    if (path.startsWith('/api/account')) {
      if (!cur) return fail(401, 'unauthenticated', 'Sign in first.');
      const me = cur.user;
      if (me.ban) return fail(403, 'banned', 'This account is banned.', { ban: me.ban });
      const reauthed = cur.session.reauthUntil > this.now;
      const needReauth = () => fail(403, 'reauth_required', 'Confirm it is you first.');
      if (key === 'GET /api/account') return reply(200, { user: this.self(me) });
      if (key === 'PATCH /api/account') {
        Object.assign(me, Object.fromEntries(Object.entries(body).filter(([k]) => ['displayName', 'avatarColor', 'username'].includes(k))));
        return reply(200, { user: this.self(me) });
      }
      if (key === 'POST /api/account/password') {
        if (!reauthed && body.currentPassword !== me.password) return fail(401, 'bad_credentials', 'Wrong password.');
        me.password = body.newPassword;
        return reply(200, { user: this.self(me) });
      }
      if (key === 'POST /api/account/email') {
        if (!reauthed) return needReauth();
        me.email = body.email;
        me.emailVerified = false;
        return reply(202, { user: this.self(me) });
      }
      if (key === 'GET /api/account/sessions') {
        const list = [...this.sessions.values()].filter((s) => s.userId === me.id).map((s) => ({ id: s.id, current: s.id === cur.session.id, deviceLabel: s.deviceLabel, userAgent: s.userAgent, createdAt: s.createdAt, lastUsedAt: s.lastUsedAt, expiresAt: s.expiresAt }));
        return reply(200, { sessions: list });
      }
      const sess = /^\/api\/account\/sessions\/([0-9a-f]+)$/.exec(path);
      if (sess && method === 'DELETE') {
        this.sessions.delete(sess[1]);
        if (sess[1] === cur.session.id) this.cookie = null;
        return reply(204);
      }
      if (key === 'DELETE /api/account/sessions') {
        for (const [id, s] of this.sessions) if (s.userId === me.id && id !== cur.session.id) this.sessions.delete(id);
        return reply(204);
      }
      if (key === 'GET /api/account/passkeys') return reply(200, { passkeys: me.passkeys });
      if (key === 'GET /api/account/settings') {
        const doc = this.settingsDocs.get(me.id) ?? { version: 0, updatedAt: 0, settings: {} };
        return reply(200, doc, { ETag: `"v${doc.version}"` });
      }
      if (key === 'PUT /api/account/settings') return this.putSettings(me, body, headers, { reply, fail });
      if (key === 'GET /api/account/export') {
        if (!reauthed) return needReauth();
        return new Response(JSON.stringify({ user: this.self(me) }), { status: 200, headers: { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="webra-account-${me.username}.json"` } });
      }
      if (key === 'DELETE /api/account') {
        if (!reauthed) return needReauth();
        if (body.confirm !== me.username) return fail(400, 'invalid', 'Type your username to confirm.', { field: 'confirm' });
        me.status = 'deleted';
        this.cookie = null;
        return reply(204);
      }
      return fail(404, 'not_found', 'No such endpoint.');
    }

    // ---- Admin
    if (path.startsWith('/api/admin')) {
      if (!cur) return fail(401, 'unauthenticated', 'Sign in first.');
      const me = cur.user;
      const staff = me.role === 'admin' || me.role === 'moderator';
      if (!staff) return fail(403, 'forbidden', 'Not allowed.');
      const admin = me.role === 'admin';
      const adminOnly = () => fail(403, 'forbidden', 'Only admins may do this.');
      if (key === 'GET /api/admin/stats') {
        const all = [...this.users.values()];
        const byStatus = { pending_email: 0, pending_approval: 0, active: 0, banned: 0, deleted: 0 };
        const byRole = { user: 0, moderator: 0, admin: 0 };
        for (const x of all) {
          byStatus[this.effectiveStatus(x)]++;
          byRole[x.role]++;
        }
        return reply(200, {
          users: { total: all.length, byStatus, byRole, newLast7Days: all.length },
          sessions: { active: this.sessions.size },
          games: { lobbies: 2, running: 1 },
          maps: { total: 7 },
          bans: { accounts: all.filter((x) => x.ban).length, ips: this.ipBans.length },
          services: { ...this.services },
        });
      }
      if (key === 'GET /api/admin/users') {
        let list = [...this.users.values()];
        const qs = (q.get('q') ?? '').toLowerCase();
        if (qs) list = list.filter((x) => x.username.toLowerCase().includes(qs) || x.displayName.toLowerCase().includes(qs) || (admin && (x.email ?? '').toLowerCase().includes(qs)));
        if (q.get('status')) list = list.filter((x) => this.effectiveStatus(x) === q.get('status'));
        if (q.get('role')) list = list.filter((x) => x.role === q.get('role'));
        if (q.get('flag')) list = list.filter((x) => x.flags.includes(q.get('flag')));
        const sort = q.get('sort') ?? 'created';
        const field = { created: 'createdAt', lastSeen: 'lastSeenAt', username: 'username' }[sort];
        list.sort((a, b) => (a[field] < b[field] ? -1 : a[field] > b[field] ? 1 : 0));
        if ((q.get('order') ?? 'desc') === 'desc') list.reverse();
        const page = Number(q.get('page') ?? 1);
        const limit = Number(q.get('limit') ?? 25);
        return reply(200, { users: list.slice((page - 1) * limit, page * limit).map((x) => this.adminUser(x, me)), total: list.length, page, limit });
      }
      const m = /^\/api\/admin\/users\/([0-9a-f]+)(?:\/([a-z-]+))?(?:\/([0-9a-f]+))?$/.exec(path);
      if (m) {
        const target = this.users.get(m[1]);
        if (!target) return fail(404, 'not_found', 'No such user.');
        const action = m[2] ?? '';
        const before = this.adminUser(target, { role: 'admin' });
        if (method === 'GET' && !action) {
          const out = { user: this.adminUser(target, me), bans: target.bans, passkeys: target.passkeys };
          if (admin) {
            out.sessions = [...this.sessions.values()].filter((s) => s.userId === target.id).map(({ reauthUntil: _r, userId: _u, ...s }) => s);
            out.ips = target.ips;
            out.settings = this.settingsDocs.get(target.id) ?? { version: 0, updatedAt: 0, settings: {} };
          }
          return reply(200, out);
        }
        if (method === 'PATCH' && !action) {
          if (!admin) return adminOnly();
          if (body.role && target.id === me.id) return fail(403, 'forbidden', 'You cannot change your own role.');
          for (const k of ['username', 'displayName', 'email', 'emailVerified', 'avatarColor', 'status', 'role', 'flags']) if (k in body) target[k] = body[k];
          this.log(me, 'user.update', { type: 'user', id: target.id, label: target.username }, before, this.adminUser(target, me));
          return reply(200, { user: this.adminUser(target, me) });
        }
        if (action === 'approve') {
          if (!['pending_approval', 'pending_email'].includes(target.status)) return fail(409, 'conflict', 'Not pending.');
          target.status = 'active';
          target.approvedAt = this.now;
          target.approvedBy = me.id;
          this.log(me, 'user.approve', { type: 'user', id: target.id, label: target.username });
          return reply(200, { user: this.adminUser(target, me) });
        }
        if (action === 'reject') {
          target.status = 'deleted';
          this.log(me, 'user.reject', { type: 'user', id: target.id, label: target.username }, null, null, body.reason ?? null);
          return reply(200, { user: this.adminUser(target, me) });
        }
        if (action === 'ban' && method === 'POST') {
          if (target.id === me.id) return fail(403, 'forbidden', 'You cannot ban yourself.');
          if (!admin && target.role !== 'user') return adminOnly();
          if (typeof body.reason !== 'string' || !body.reason) return fail(400, 'invalid', 'Give a reason.', { field: 'reason' });
          if (body.expiresAt !== null && !(body.expiresAt > this.now)) return fail(400, 'invalid', 'The end must be in the future.', { field: 'expiresAt' });
          target.ban = { id: newId(16), reason: body.reason, createdAt: this.now, createdBy: me.id, expiresAt: body.expiresAt };
          target.bans.push({ ...target.ban, revokedAt: null, revokedBy: null });
          for (const [id, s] of this.sessions) if (s.userId === target.id) this.sessions.delete(id);
          this.log(me, 'user.ban', { type: 'user', id: target.id, label: target.username }, null, null, body.reason);
          return reply(201, { ban: target.ban, user: this.adminUser(target, me) });
        }
        if (action === 'ban' && method === 'DELETE') {
          if (!target.ban) return fail(404, 'not_found', 'No ban in effect.');
          target.ban = null;
          this.log(me, 'user.unban', { type: 'user', id: target.id, label: target.username });
          return reply(200, { user: this.adminUser(target, me) });
        }
        if (!admin) return adminOnly();
        if (action === 'logout') {
          for (const [id, s] of this.sessions) if (s.userId === target.id) this.sessions.delete(id);
          return reply(204);
        }
        if (action === 'sessions' && method === 'DELETE') {
          this.sessions.delete(m[3]);
          return reply(204);
        }
        if (method === 'DELETE' && !action) {
          target.status = 'deleted';
          target.deletedAt = this.now;
          return reply(200, { user: this.adminUser(target, me) });
        }
        if (action === 'restore') {
          target.status = 'active';
          target.deletedAt = null;
          return reply(200, { user: this.adminUser(target, me) });
        }
        if (action === 'purge') {
          if (target.status !== 'deleted') return fail(409, 'conflict', 'Only deleted accounts can be purged.');
          if (body.confirm !== target.username) return fail(400, 'invalid', 'Type the username to confirm.', { field: 'confirm' });
          this.users.delete(target.id);
          return reply(204);
        }
        if (action === 'password-reset') {
          target.resetToken = 'tok' + newId(40);
          return reply(201, { url: `https://webra.sherin.dev/account/#reset=${target.resetToken}`, expiresAt: this.now + 864e5, sent: false });
        }
        if (action === 'settings' && method === 'GET') {
          const doc = this.settingsDocs.get(target.id) ?? { version: 0, updatedAt: 0, settings: {} };
          return reply(200, doc, { ETag: `"v${doc.version}"` });
        }
        if (action === 'settings' && method === 'PUT') return this.putSettings(target, body, headers, { reply, fail });
        return fail(404, 'not_found', 'No such endpoint.');
      }
      if (!admin) return adminOnly();
      if (key === 'GET /api/admin/ip-bans') return reply(200, { bans: this.ipBans, total: this.ipBans.length, page: 1, limit: 25 });
      if (key === 'POST /api/admin/ip-bans') {
        if (!/^[0-9a-f.:]+(\/\d+)?$/i.test(body.cidr ?? '')) return fail(400, 'invalid', 'Not an address or range.', { field: 'cidr' });
        if (/\/([0-7])$/.test(body.cidr)) return fail(400, 'invalid', 'The range is too wide.', { field: 'cidr' });
        const ban = { id: this.ipBans.length + 1, cidr: body.cidr, reason: body.reason, createdAt: this.now, createdBy: me.id, expiresAt: body.expiresAt ?? null, active: true };
        this.ipBans.push(ban);
        this.log(me, 'ipban.create', { type: 'ipban', id: ban.id, label: ban.cidr });
        return reply(201, { ban });
      }
      const ib = /^\/api\/admin\/ip-bans\/([1-9][0-9]*)$/.exec(path);
      if (ib) {
        const i = this.ipBans.findIndex((b) => String(b.id) === ib[1]);
        if (i < 0) return fail(404, 'not_found', 'No such ban.');
        if (method === 'DELETE') {
          this.ipBans.splice(i, 1);
          return reply(204);
        }
        Object.assign(this.ipBans[i], body);
        return reply(200, { ban: this.ipBans[i] });
      }
      if (key === 'GET /api/admin/site') return reply(200, { settings: this.site, services: this.services, effective: this.effectiveSite() }, { ETag: `"v${this.site.version}"` });
      if (key === 'PATCH /api/admin/site') {
        const m2 = /^"v(\d+)"$/.exec(headers['if-match'] ?? '');
        if (!m2) return fail(428, 'precondition_required', 'If-Match is required.');
        if (Number(m2[1]) !== this.site.version) return fail(412, 'version_conflict', 'Changed meanwhile.', { current: { version: this.site.version, settings: this.site } });
        for (const [k, v] of Object.entries(body)) {
          if (!(k in this.site) || k === 'version') return fail(400, 'invalid', `Unknown setting ${k}.`, { field: k });
          this.site[k] = v && typeof v === 'object' ? { ...this.site[k], ...v } : v;
        }
        this.site.version++;
        this.log(me, 'site.update', { type: 'site', id: 'site', label: 'Site settings' });
        return reply(200, { settings: this.site, services: this.services, effective: this.effectiveSite() }, { ETag: `"v${this.site.version}"` });
      }
      if (key === 'GET /api/admin/audit') {
        let list = this.audit;
        if (q.get('action')) list = list.filter((e) => e.action === q.get('action'));
        if (q.get('actor')) list = list.filter((e) => e.actor?.id === q.get('actor'));
        return reply(200, { entries: list, total: list.length, page: 1, limit: 25 });
      }
      return fail(404, 'not_found', 'No such endpoint.');
    }
    return fail(404, 'not_found', 'No such endpoint.');
  }

  putSettings(user, body, headers, { reply, fail }) {
    const m = /^"v(\d+)"$/.exec(headers['if-match'] ?? '');
    if (!m) return fail(428, 'precondition_required', 'If-Match is required.');
    const doc = this.settingsDocs.get(user.id) ?? { version: 0, updatedAt: 0, settings: {} };
    if (Number(m[1]) !== doc.version) return fail(412, 'version_conflict', 'The settings changed meanwhile.', { current: { version: doc.version, settings: doc.settings } });
    if (!body.settings || typeof body.settings !== 'object') return fail(400, 'invalid', 'Settings must be an object.', { field: 'settings' });
    if (JSON.stringify(body.settings).length > 32 * 1024) return fail(413, 'too_large', 'Too large.');
    const next = { version: doc.version + 1, updatedAt: this.now, settings: body.settings };
    this.settingsDocs.set(user.id, next);
    return reply(200, next, { ETag: `"v${next.version}"` });
  }
}
