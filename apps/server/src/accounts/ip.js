// IP addresses and CIDR ranges (IPv4 and IPv6) for IP bans and the IP
// history. Pure functions. Addresses are compared as fixed-width hex strings
// (8 digits for IPv4, 32 for IPv6), so D1 can range-match them with plain
// string comparisons. IPv4-mapped IPv6 addresses (::ffff:a.b.c.d) count as
// IPv4.

/** Shortest prefixes an IP ban may use. */
export const MIN_PREFIX = { 4: 8, 6: 16 };
/**
 * Prefix for an IPv6 address given without one: /64, the block a single
 * network (one home, one phone) gets, where privacy addresses rotate within.
 */
export const DEFAULT_V6_PREFIX = 64;

function parseV4(s) {
  const parts = s.split('.');
  if (parts.length !== 4) return null;
  let n = 0n;
  for (const p of parts) {
    // No leading zeros: "010" is octal in some parsers and decimal in others.
    if (!/^(0|[1-9][0-9]{0,2})$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = (n << 8n) | BigInt(v);
  }
  return n;
}

function parseV6(s) {
  if (s.length > 45 || s.includes('%')) return null;
  let tail = [];
  // An embedded IPv4 address at the end (::ffff:1.2.3.4, 64:ff9b::1.2.3.4).
  const lastColon = s.lastIndexOf(':');
  if (s.indexOf('.', lastColon) >= 0) {
    const v4 = parseV4(s.slice(lastColon + 1));
    if (v4 === null) return null;
    tail = [Number(v4 >> 16n), Number(v4 & 0xffffn)];
    s = s.slice(0, lastColon + 1);
    // Drop the separator before the IPv4 part unless it belongs to "::".
    if (!s.endsWith('::')) s = s.slice(0, -1);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const group = (g) => (/^[0-9a-fA-F]{1,4}$/.test(g) ? parseInt(g, 16) : null);
  const side = (h) => (h === '' ? [] : h.split(':').map(group));
  const head = side(halves[0]);
  const rest = halves.length === 2 ? side(halves[1]) : [];
  if (head.includes(null) || rest.includes(null)) return null;
  const total = head.length + rest.length + tail.length;
  let groups;
  if (halves.length === 2) {
    if (total > 7) return null;
    groups = [...head, ...new Array(8 - total).fill(0), ...rest, ...tail];
  } else {
    if (total !== 8) return null;
    groups = [...head, ...tail];
  }
  let n = 0n;
  for (const g of groups) n = (n << 16n) | BigInt(g);
  return n;
}

const MAPPED_PREFIX = 0xffffn << 32n;

/**
 * Parse an address. Returns { v: 4 | 6, n: BigInt } or null. IPv4-mapped
 * IPv6 addresses come back as IPv4.
 */
export function parseIp(text) {
  if (typeof text !== 'string' || text.length === 0 || text.length > 45) return null;
  const s = text.trim().replace(/^\[(.*)\]$/, '$1');
  if (s.includes(':')) {
    const n = parseV6(s);
    if (n === null) return null;
    if (n >> 32n === 0xffffn && (n & ~((1n << 32n) - 1n)) === MAPPED_PREFIX) return { v: 4, n: n & 0xffffffffn };
    return { v: 6, n };
  }
  const n = parseV4(s);
  return n === null ? null : { v: 4, n };
}

const BITS = { 4: 32n, 6: 128n };
const WIDTH = { 4: 8, 6: 32 };

export function toHex({ v, n }) {
  return n.toString(16).padStart(WIDTH[v], '0');
}

/** Canonical text: dotted quad, or RFC 5952 IPv6 (lower case, longest zero run compressed). */
export function formatIp({ v, n }) {
  if (v === 4) return [24n, 16n, 8n, 0n].map((s) => String((n >> s) & 0xffn)).join('.');
  const groups = [];
  for (let i = 7; i >= 0; i--) groups.push(Number((n >> BigInt(i * 16)) & 0xffffn));
  let best = -1;
  let bestLen = 1;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > bestLen) {
      best = i;
      bestLen = j - i;
    }
    i = j;
  }
  const hex = groups.map((g) => g.toString(16));
  if (best < 0) return hex.join(':');
  return `${hex.slice(0, best).join(':')}::${hex.slice(best + bestLen).join(':')}`;
}

/** Address text to { ip, v, hex } for storage, or null when it is not an address. */
export function ipRecord(text) {
  const p = parseIp(text);
  return p ? { ip: formatIp(p), v: p.v, hex: toHex(p) } : null;
}

/**
 * The network an address belongs to, for rate limits that should cover one
 * home rather than one device: an IPv4 address itself (a household shares
 * it behind NAT), or the /64 of an IPv6 address (DEFAULT_V6_PREFIX: privacy
 * addresses rotate inside it). Text that is not an address comes back as is.
 */
export function networkOf(text) {
  const p = parseIp(text);
  if (!p) return String(text);
  if (p.v === 4) return formatIp(p);
  const host = 128n - BigInt(DEFAULT_V6_PREFIX);
  return `${formatIp({ v: 6, n: (p.n >> host) << host })}/${DEFAULT_V6_PREFIX}`;
}

/**
 * Parse a ban range: an address or address/prefix. Returns { cidr, v, start,
 * end, prefix } (start and end as fixed-width hex) or an error string.
 */
export function parseCidr(text, { minPrefix = MIN_PREFIX } = {}) {
  if (typeof text !== 'string' || text.length > 64) return { error: 'Not an IP address or CIDR range.' };
  const [addr, len, extra] = text.trim().split('/');
  if (extra !== undefined) return { error: 'Not an IP address or CIDR range.' };
  const p = parseIp(addr);
  if (!p) return { error: 'Not an IP address or CIDR range.' };
  const bits = BITS[p.v];
  let prefix = p.v === 6 ? DEFAULT_V6_PREFIX : Number(bits);
  if (len !== undefined) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(len)) return { error: 'The prefix length is malformed.' };
    prefix = Number(len);
    // A mapped IPv6 range (::ffff:0:0/104) is an IPv4 range of prefix - 96.
    if (addr.includes(':') && p.v === 4) prefix -= 96;
    if (prefix < 0 || prefix > Number(bits)) return { error: 'The prefix length is out of range.' };
  }
  if (prefix < minPrefix[p.v]) return { error: `Ranges wider than /${minPrefix[p.v]} are not allowed for IPv${p.v}.` };
  const hostBits = bits - BigInt(prefix);
  const mask = ((1n << bits) - 1n) ^ ((1n << hostBits) - 1n);
  const start = p.n & mask;
  const end = start | ((1n << hostBits) - 1n);
  const base = formatIp({ v: p.v, n: start });
  return {
    cidr: prefix === Number(bits) ? base : `${base}/${prefix}`,
    v: p.v,
    prefix,
    start: toHex({ v: p.v, n: start }),
    end: toHex({ v: p.v, n: end }),
  };
}

/** Whether `ip` (text) lies in a parsed range ({ v, start, end }). */
export function inRange(ip, range) {
  const p = parseIp(ip);
  if (!p || p.v !== range.v) return false;
  const hex = toHex(p);
  return hex >= range.start && hex <= range.end;
}
