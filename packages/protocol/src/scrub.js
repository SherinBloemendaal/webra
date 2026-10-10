// What error reports must not carry (docs/security.md, "Error reports"):
// players' text (chat, names, lobby and map names), tokens and keys in URLs,
// email addresses, cookies, request headers and bodies, network addresses.
// The game and the website (apps/game/js/telemetry/index.js) and the Worker
// (apps/server/src/telemetry.js) run every event and breadcrumb through here
// before their Sentry SDK sends it.
//
// Players' text cannot be recognized by its shape, so the game tells the
// Redactor the text it receives and sends (js/net.js, js/account/api.js,
// the lobby's map files) with `noteUserText`; any later occurrence in an
// error message, a breadcrumb or a context is replaced by "[redacted]".
//
// No DOM, no SDK: the Node tests check it directly.

export const REDACTED = '[redacted]';
export const FILTERED = '[Filtered]';

/** Keys of received or sent JSON whose text values are players' text. */
const USER_TEXT_KEYS = new Set(['name', 'text', 'title', 'author', 'description', 'username', 'displayName', 'login', 'email', 'reason', 'motd', 'label']);
/** Keys whose values are never kept anywhere in a report (credentials and their kin). */
const SECRET_KEY = /pass(word|phrase)?|secret|token|key|auth|cookie|session|member|rejoin|credential|signature|csrf/i;
const URL_IN_TEXT = /\b(?:https?|wss?):\/\/[^\s"'<>)]+/gi;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
/** Long runs of token characters (session ids, keys, signed values). Hex state hashes (16) and short ids stay. */
const TOKEN = /\b[A-Za-z0-9_-]{32,}\b/g;
/** CSS attribute selectors of DOM breadcrumbs: `[title="..."]`, `[aria-label="..."]`. */
const ATTRIBUTE_VALUE = /\[([a-zA-Z-]+)=("[^"]*"|'[^']*'|[^\]]*)\]/g;
/** Keys whose string values are URLs (breadcrumb and span data). */
const URL_KEY = /^(from|to|href)$|url$/i;
/** How deep `scrubValue` walks objects. */
const MAX_DEPTH = 6;

/**
 * Players' text seen by this page, to be cut out of reports. Holds the
 * newest `max` values of at least `minLength` characters; numbers alone are
 * skipped (they are not personal and would cut up every tick and id).
 */
export class Redactor {
  constructor({ max = 1000, minLength = 3 } = {}) {
    this.max = max;
    this.minLength = minLength;
    /** value -> true, oldest first. */
    this.values = new Map();
    this.pattern = null;
  }

  /** Remember one text. */
  add(value) {
    if (typeof value !== 'string') return;
    const v = value.trim();
    if (v.length < this.minLength || /^[\d\s.,:-]+$/.test(v)) return;
    this.values.delete(v);
    this.values.set(v, true);
    while (this.values.size > this.max) this.values.delete(this.values.keys().next().value);
    this.pattern = null;
  }

  /**
   * Remember the players' text in a received or sent JSON value: strings
   * under USER_TEXT_KEYS, at any depth (lists and objects).
   */
  harvest(value, depth = 0) {
    if (depth > MAX_DEPTH || value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const v of value) this.harvest(v, depth + 1);
      return;
    }
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === 'string') {
        if (USER_TEXT_KEYS.has(k)) this.add(v);
      } else this.harvest(v, depth + 1);
    }
  }

  /** `text` with every remembered value replaced. */
  scrub(text) {
    if (!this.values.size || typeof text !== 'string' || !text) return text;
    this.pattern ??= new RegExp(
      [...this.values.keys()]
        .sort((a, b) => b.length - a.length)
        .map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('|'),
      'g',
    );
    return text.replace(this.pattern, REDACTED);
  }
}

/** Only the query string and fragment of `text` replaced. */
function cutQuery(text) {
  return text.replace(/\?[^#]*/, `?${FILTERED}`).replace(/#.*$/, `#${FILTERED}`);
}

/**
 * A URL without anything personal: no user info, query values replaced
 * (the names stay), no fragment, long token-like path segments
 * replaced. Paths (`/api/...`) stay paths; data: and blob: URLs keep only
 * their scheme; other values (a stack frame's "<anonymous>", "index.js")
 * only lose a query string or fragment.
 */
export function scrubUrl(url) {
  if (typeof url !== 'string' || !url) return url;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1].toLowerCase() ?? null;
  if (scheme === 'data' || scheme === 'blob') return `${scheme}:${FILTERED}`;
  const web = scheme === 'http' || scheme === 'https' || scheme === 'ws' || scheme === 'wss';
  const relative = scheme === null && url.startsWith('/') && !url.startsWith('//');
  if (!web && !relative) return cutQuery(url);
  let u;
  try {
    u = new URL(url, 'https://relative.invalid');
  } catch {
    return scrubTokens(cutQuery(url));
  }
  u.username = '';
  u.password = '';
  const params = [...u.searchParams.keys()];
  if (params.length) {
    const kept = new URLSearchParams();
    for (const k of params) kept.append(k, FILTERED);
    u.search = kept.toString().replaceAll(encodeURIComponent(FILTERED), FILTERED);
  }
  u.hash = u.hash ? FILTERED : '';
  u.pathname = u.pathname
    .split('/')
    // File names have a dot and stay (stack frames are matched to sources by them).
    .map((seg) => (/^[A-Za-z0-9_~%-]{24,}$/.test(seg) ? FILTERED : seg))
    .join('/');
  const out = u.href.replace(/#%5BFiltered%5D$/, `#${FILTERED}`).replaceAll('%5BFiltered%5D', FILTERED);
  return relative ? out.replace('https://relative.invalid', '') : out;
}

function scrubTokens(text) {
  return text.replace(TOKEN, FILTERED);
}

/** Text without URLs' secrets, email addresses, long tokens or remembered players' text. */
export function scrubText(text, redactor = null) {
  if (typeof text !== 'string' || !text) return text;
  let out = text.replace(URL_IN_TEXT, (u) => scrubUrl(u));
  out = out.replace(EMAIL, '[email]');
  out = scrubTokens(out);
  return redactor ? redactor.scrub(out) : out;
}

/**
 * Any JSON-like value with its strings scrubbed and secret-named keys
 * dropped; deeper than MAX_DEPTH becomes "[...]".
 */
export function scrubValue(value, redactor = null, depth = 0) {
  if (typeof value === 'string') return scrubText(value, redactor);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[...]';
  if (Array.isArray(value)) return value.map((v) => scrubValue(v, redactor, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (SECRET_KEY.test(k)) continue;
    out[k] = URL_KEY.test(k) && typeof v === 'string' ? scrubUrl(v) : scrubValue(v, redactor, depth + 1);
  }
  return out;
}

/**
 * A breadcrumb fit to send, or null: console messages only for warnings and
 * errors and without their arguments (the message stays, scrubbed), DOM
 * selectors without attribute values, URLs scrubbed.
 */
export function scrubBreadcrumb(crumb, redactor = null) {
  if (!crumb || typeof crumb !== 'object') return crumb;
  const out = { ...crumb };
  const category = String(out.category ?? '');
  if (category === 'console' && out.level !== 'warning' && out.level !== 'error') return null;
  if (typeof out.message === 'string') {
    let m = out.message;
    if (category.startsWith('ui.')) m = m.replace(ATTRIBUTE_VALUE, '[$1]');
    out.message = scrubText(m, redactor);
  }
  if (out.data && typeof out.data === 'object') {
    const data = { ...out.data };
    if (category === 'console') delete data.arguments;
    for (const k of ['url', 'from', 'to']) if (typeof data[k] === 'string') data[k] = scrubUrl(data[k]);
    out.data = scrubValue(data, redactor);
  }
  return out;
}

/** A span description such as "GET /api/maps?x=1": URLs scrubbed, any query string replaced. */
function scrubDescription(text, redactor) {
  if (typeof text !== 'string') return text;
  return scrubText(text, redactor).replace(/\?[^\s]*/g, `?${FILTERED}`);
}

/** Span attributes that hold a URL or a path. */
const SPAN_URL_KEY = /^(url\.full|url\.path|url|http\.url|http\.target|http\.route)$/;

/** Span or transaction data: URL attributes scrubbed, headers, addresses, user agents, queries and bodies dropped. */
function scrubSpanData(data, redactor) {
  if (!data || typeof data !== 'object') return data;
  const out = {};
  for (const [k, v] of Object.entries(data)) {
    if (/header|cookie|client\.address|user_agent|\.ip$|^ip$|body|query|fragment/i.test(k)) continue;
    out[k] = typeof v === 'string' && SPAN_URL_KEY.test(k) ? scrubUrl(v) : scrubValue(v, redactor);
  }
  return out;
}

/**
 * An event (error or transaction) fit to send. Drops the user, request
 * headers (but the User-Agent with `userAgent`), cookies, query strings and
 * bodies; scrubs exception messages, the message, breadcrumbs, contexts,
 * extras, frame URLs and spans.
 */
export function scrubEvent(event, redactor = null, { userAgent = false } = {}) {
  if (!event || typeof event !== 'object') return event;
  const out = { ...event };
  delete out.user;
  delete out.server_name;
  if (out.request) {
    const r = {};
    if (typeof out.request.url === 'string') r.url = scrubUrl(out.request.url);
    if (typeof out.request.method === 'string') r.method = out.request.method;
    const headers = out.request.headers ?? {};
    const ua = Object.entries(headers).find(([k]) => k.toLowerCase() === 'user-agent')?.[1];
    if (userAgent && typeof ua === 'string') r.headers = { 'User-Agent': ua };
    out.request = r;
  }
  if (typeof out.message === 'string') out.message = scrubText(out.message, redactor);
  if (out.logentry) out.logentry = { ...out.logentry, message: scrubText(out.logentry.message, redactor), params: undefined };
  if (typeof out.transaction === 'string') out.transaction = scrubDescription(out.transaction, redactor);
  if (out.exception?.values) {
    out.exception = {
      ...out.exception,
      values: out.exception.values.map((ex) => ({
        ...ex,
        value: scrubText(ex.value, redactor),
        stacktrace: ex.stacktrace?.frames
          ? {
              ...ex.stacktrace,
              frames: ex.stacktrace.frames.map((f) => {
                const frame = { ...f, filename: scrubUrl(f.filename), abs_path: scrubUrl(f.abs_path) };
                delete frame.vars;
                return frame;
              }),
            }
          : ex.stacktrace,
      })),
    };
  }
  if (Array.isArray(out.breadcrumbs)) out.breadcrumbs = out.breadcrumbs.map((b) => scrubBreadcrumb(b, redactor)).filter(Boolean);
  if (out.extra) out.extra = scrubValue(out.extra, redactor);
  if (out.contexts) {
    const { trace, culture: _culture, ...rest } = out.contexts;
    const contexts = scrubValue(rest, redactor);
    // The trace context keeps its ids (they are random) and loses what its data must not carry.
    if (trace) contexts.trace = { ...trace, ...(trace.data ? { data: scrubSpanData(trace.data, redactor) } : {}) };
    out.contexts = contexts;
  }
  if (Array.isArray(out.spans)) {
    out.spans = out.spans.map((s) => ({ ...s, description: scrubDescription(s.description, redactor), data: scrubSpanData(s.data, redactor) }));
  }
  return out;
}
