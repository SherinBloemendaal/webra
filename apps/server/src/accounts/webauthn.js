// WebAuthn (passkeys) without external libraries: a strict CBOR decoder, the
// authenticator data and COSE key formats, and the registration and
// authentication checks of the WebAuthn Level 2 specification (sections 7.1
// and 7.2) for the algorithms EdDSA (Ed25519), ES256 and RS256. Attestation:
// `none` is requested; any format is accepted and its statement is not
// verified (no attestation trust, docs/accounts-api.md section 4.4).
//
// Every check failure throws WebAuthnError; callers answer all of them with
// the same generic error.

import { fromBase64Url, sha256Bytes, timingSafeEqual, toBase64Url } from '../crypto.js';

export const ALG_EDDSA = -8;
export const ALG_ES256 = -7;
export const ALG_RS256 = -257;
export const SUPPORTED_ALGS = Object.freeze([ALG_EDDSA, ALG_ES256, ALG_RS256]);
export const CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const PRODUCTION_RP_ID = 'webra.sherin.dev';
const TRANSPORTS = ['usb', 'nfc', 'ble', 'internal', 'hybrid', 'smart-card'];

export class WebAuthnError extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'WebAuthnError';
  }
}

const fail = (reason) => {
  throw new WebAuthnError(reason);
};

// ---- Relying party -------------------------------------------------------------------

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * The rp id for a request: the production host over HTTPS, `localhost` for
 * local development over plain HTTP, otherwise null (passkeys unavailable).
 */
export function rpIdFor(request) {
  const url = new URL(request.url);
  if (url.protocol === 'https:' && url.hostname === PRODUCTION_RP_ID) return PRODUCTION_RP_ID;
  if (url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname)) return 'localhost';
  return null;
}

// ---- CBOR (RFC 8949), the subset authenticators use ------------------------------------

const MAX_DEPTH = 16;

/**
 * Decode one CBOR item from `bytes` at `offset`. Returns { value, offset }.
 * Maps become Map objects (keys are integers or strings), byte strings
 * Uint8Array. Indefinite lengths, tags and big integers are refused.
 */
export function decodeCbor(bytes, offset = 0, depth = 0) {
  if (depth > MAX_DEPTH) fail('cbor: nested too deep');
  const need = (n) => {
    if (offset + n > bytes.length) fail('cbor: truncated');
  };
  need(1);
  const initial = bytes[offset++];
  const major = initial >> 5;
  const info = initial & 31;
  let arg;
  if (info < 24) arg = info;
  else if (info === 24) {
    need(1);
    arg = bytes[offset++];
  } else if (info === 25) {
    need(2);
    arg = (bytes[offset] << 8) | bytes[offset + 1];
    offset += 2;
  } else if (info === 26) {
    need(4);
    arg = ((bytes[offset] << 24) >>> 0) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3];
    offset += 4;
  } else if (info === 27) {
    need(8);
    let big = 0n;
    for (let i = 0; i < 8; i++) big = (big << 8n) | BigInt(bytes[offset + i]);
    offset += 8;
    // Floats never occur in WebAuthn structures.
    if (major === 7) fail('cbor: floats are not supported');
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) fail('cbor: integer too large');
    arg = Number(big);
  } else {
    fail('cbor: indefinite or reserved length');
  }
  switch (major) {
    case 0:
      return { value: arg, offset };
    case 1:
      return { value: -1 - arg, offset };
    case 2:
      need(arg);
      return { value: bytes.slice(offset, offset + arg), offset: offset + arg };
    case 3: {
      need(arg);
      let s;
      try {
        s = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(offset, offset + arg));
      } catch {
        fail('cbor: invalid text');
      }
      return { value: s, offset: offset + arg };
    }
    case 4: {
      if (arg > bytes.length - offset) fail('cbor: array longer than input');
      const out = [];
      for (let i = 0; i < arg; i++) {
        const r = decodeCbor(bytes, offset, depth + 1);
        out.push(r.value);
        offset = r.offset;
      }
      return { value: out, offset };
    }
    case 5: {
      if (arg * 2 > bytes.length - offset) fail('cbor: map longer than input');
      const out = new Map();
      for (let i = 0; i < arg; i++) {
        const k = decodeCbor(bytes, offset, depth + 1);
        if (typeof k.value !== 'number' && typeof k.value !== 'string') fail('cbor: unsupported map key');
        if (out.has(k.value)) fail('cbor: duplicate map key');
        const v = decodeCbor(bytes, k.offset, depth + 1);
        out.set(k.value, v.value);
        offset = v.offset;
      }
      return { value: out, offset };
    }
    case 6:
      fail('cbor: tags are not supported');
      break;
    case 7:
      if (info === 20) return { value: false, offset };
      if (info === 21) return { value: true, offset };
      if (info === 22) return { value: null, offset };
      if (info === 23) return { value: undefined, offset };
      if (info === 25 || info === 26) {
        // Half and single precision floats are not used by WebAuthn structures.
        fail('cbor: unsupported float');
      }
      fail('cbor: unsupported simple value');
  }
  fail('cbor: unknown major type');
}

/** Decode exactly one item spanning all of `bytes`. */
export function decodeCborAll(bytes) {
  const r = decodeCbor(bytes, 0);
  if (r.offset !== bytes.length) fail('cbor: trailing bytes');
  return r.value;
}

// ---- Authenticator data -------------------------------------------------------------------

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_BE = 0x08;
const FLAG_BS = 0x10;
const FLAG_AT = 0x40;
const FLAG_ED = 0x80;

export function parseAuthData(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 37) fail('authData too short');
  const flagsByte = bytes[32];
  const flags = {
    up: (flagsByte & FLAG_UP) !== 0,
    uv: (flagsByte & FLAG_UV) !== 0,
    be: (flagsByte & FLAG_BE) !== 0,
    bs: (flagsByte & FLAG_BS) !== 0,
    at: (flagsByte & FLAG_AT) !== 0,
    ed: (flagsByte & FLAG_ED) !== 0,
  };
  const signCount = ((bytes[33] << 24) >>> 0) + (bytes[34] << 16) + (bytes[35] << 8) + bytes[36];
  const out = { rpIdHash: bytes.slice(0, 32), flags, signCount, attested: null };
  let offset = 37;
  if (flags.at) {
    if (bytes.length < offset + 18) fail('attested credential data truncated');
    const aaguid = bytes.slice(offset, offset + 16);
    const idLen = (bytes[offset + 16] << 8) | bytes[offset + 17];
    offset += 18;
    if (idLen < 16 || idLen > 1023 || bytes.length < offset + idLen) fail('credential id length');
    const credentialId = bytes.slice(offset, offset + idLen);
    offset += idLen;
    const key = decodeCbor(bytes, offset);
    if (!(key.value instanceof Map)) fail('credential public key is not a map');
    out.attested = { aaguid, credentialId, publicKeyBytes: bytes.slice(offset, key.offset), publicKey: key.value };
    offset = key.offset;
  }
  if (flags.ed) {
    const ext = decodeCbor(bytes, offset);
    if (!(ext.value instanceof Map)) fail('extensions are not a map');
    offset = ext.offset;
  }
  if (offset !== bytes.length) fail('authData has trailing bytes');
  return out;
}

// ---- COSE keys --------------------------------------------------------------------------------

function coseBytes(map, label, length) {
  const v = map.get(label);
  if (!(v instanceof Uint8Array) || (length !== undefined && v.length !== length)) fail(`cose: bad parameter ${label}`);
  return v;
}

/**
 * Import a COSE public key (decoded Map). Returns { alg, key } where key is a
 * WebCrypto CryptoKey for verification.
 */
export async function importCoseKey(map) {
  if (!(map instanceof Map)) fail('cose: not a map');
  const kty = map.get(1);
  const alg = map.get(3);
  if (!SUPPORTED_ALGS.includes(alg)) fail('cose: unsupported algorithm');
  try {
    if (alg === ALG_ES256) {
      if (kty !== 2 || map.get(-1) !== 1) fail('cose: ES256 needs an EC2 P-256 key');
      const x = coseBytes(map, -2, 32);
      const y = coseBytes(map, -3, 32);
      const raw = new Uint8Array(65);
      raw[0] = 4;
      raw.set(x, 1);
      raw.set(y, 33);
      const key = await crypto.subtle.importKey('raw', raw, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      return { alg, key };
    }
    if (alg === ALG_RS256) {
      if (kty !== 3) fail('cose: RS256 needs an RSA key');
      const n = coseBytes(map, -1);
      const e = coseBytes(map, -2);
      // At least 2048 bits (leading zero bytes do not count).
      let first = 0;
      while (first < n.length && n[first] === 0) first++;
      if ((n.length - first) * 8 < 2048 || n.length > 1024 || e.length < 1 || e.length > 8) fail('cose: RSA key size');
      const key = await crypto.subtle.importKey(
        'jwk',
        { kty: 'RSA', n: toBase64Url(n.slice(first)), e: toBase64Url(e), alg: 'RS256', ext: true },
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['verify'],
      );
      return { alg, key };
    }
    // EdDSA: Ed25519 only.
    if (kty !== 1 || map.get(-1) !== 6) fail('cose: EdDSA needs an OKP Ed25519 key');
    const x = coseBytes(map, -2, 32);
    const key = await crypto.subtle.importKey('raw', x, { name: 'Ed25519' }, false, ['verify']);
    return { alg, key };
  } catch (err) {
    if (err instanceof WebAuthnError) throw err;
    fail('cose: key could not be imported');
  }
  return null;
}

/** DER ECDSA signature (SEQUENCE of two INTEGERs) to the raw r || s form WebCrypto verifies. */
export function derToRaw(der, size = 32) {
  const bad = () => fail('signature: malformed DER');
  if (der.length < 8 || der[0] !== 0x30) bad();
  let offset = 2;
  if (der[1] & 0x80) bad(); // ECDSA P-256 signatures are always short form
  if (der[1] !== der.length - 2) bad();
  const out = new Uint8Array(size * 2);
  for (let part = 0; part < 2; part++) {
    if (der[offset] !== 0x02) bad();
    const len = der[offset + 1];
    offset += 2;
    if (len < 1 || len > size + 1 || offset + len > der.length) bad();
    let int = der.subarray(offset, offset + len);
    offset += len;
    // Strict DER: positive, minimal (a leading zero only before a high bit), never zero.
    if (int[0] & 0x80) bad();
    if (int.length > 1 && int[0] === 0 && (int[1] & 0x80) === 0) bad();
    if (int.every((b) => b === 0)) bad();
    if (int.length > size) {
      if (int[0] !== 0) bad();
      int = int.subarray(1);
    }
    out.set(int, part * size + (size - int.length));
  }
  if (offset !== der.length) bad();
  return out;
}

async function verifySignature(alg, key, signature, data) {
  if (alg === ALG_ES256) return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, derToRaw(signature), data);
  if (alg === ALG_RS256) return crypto.subtle.verify({ name: 'RSASSA-PKCS1-v1_5' }, key, signature, data);
  if (signature.length !== 64) return false;
  return crypto.subtle.verify({ name: 'Ed25519' }, key, signature, data);
}

// ---- Credential JSON (PublicKeyCredential.toJSON()) ------------------------------------------

function b64(v, what, max, min = 1) {
  if (typeof v !== 'string' || v.length > Math.ceil((max * 4) / 3) + 4) fail(`${what}: missing or too long`);
  const bytes = fromBase64Url(v);
  if (!bytes || bytes.length < min || bytes.length > max) fail(`${what}: malformed`);
  return bytes;
}

function plainObject(v, what) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) fail(`${what}: not an object`);
  return v;
}

function credentialBase(credential) {
  plainObject(credential, 'credential');
  if (credential.type !== 'public-key') fail('credential: type');
  const rawId = b64(credential.rawId ?? credential.id, 'rawId', 1023, 16);
  const id = b64(credential.id, 'id', 1023, 16);
  if (!timingSafeEqual(id, rawId)) fail('credential: id and rawId differ');
  const response = plainObject(credential.response, 'response');
  return { rawId, id: toBase64Url(rawId), response };
}

function parseClientData(bytes, type, challenge, origin) {
  let data;
  try {
    data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    fail('clientData: not JSON');
  }
  plainObject(data, 'clientData');
  if (data.type !== type) fail('clientData: type');
  if (typeof data.challenge !== 'string') fail('clientData: challenge');
  const got = fromBase64Url(data.challenge);
  const want = fromBase64Url(challenge);
  if (!got || !want || !timingSafeEqual(got, want)) fail('clientData: challenge mismatch');
  if (data.origin !== origin) fail('clientData: origin');
  if (data.crossOrigin === true) fail('clientData: cross-origin');
  return data;
}

async function checkRp(authData, rpId) {
  if (!timingSafeEqual(authData.rpIdHash, await sha256Bytes(rpId))) fail('authData: rp id hash');
  if (!authData.flags.up) fail('authData: user not present');
}

/**
 * Verify a registration (`navigator.credentials.create`).
 * @param {{ credential: object, challenge: string, origin: string, rpId: string }} p
 * @returns {Promise<{ credentialId: string, publicKey: string, alg: number, signCount: number,
 *   transports: string[], backedUp: boolean, uv: boolean }>}
 */
export async function verifyRegistration({ credential, challenge, origin, rpId }) {
  const { rawId, id, response } = credentialBase(credential);
  const clientDataJSON = b64(response.clientDataJSON, 'clientDataJSON', 4096);
  const attestationObject = b64(response.attestationObject, 'attestationObject', 32 * 1024);
  parseClientData(clientDataJSON, 'webauthn.create', challenge, origin);
  const att = decodeCborAll(attestationObject);
  if (!(att instanceof Map) || typeof att.get('fmt') !== 'string' || !(att.get('attStmt') instanceof Map) || !(att.get('authData') instanceof Uint8Array)) {
    fail('attestationObject: malformed');
  }
  const authData = parseAuthData(att.get('authData'));
  await checkRp(authData, rpId);
  if (!authData.flags.at || !authData.attested) fail('authData: no attested credential');
  if (!timingSafeEqual(authData.attested.credentialId, rawId)) fail('authData: credential id differs');
  if (authData.flags.bs && !authData.flags.be) fail('authData: backup state without eligibility');
  const { alg } = await importCoseKey(authData.attested.publicKey);
  let transports = [];
  if (response.transports !== undefined) {
    if (!Array.isArray(response.transports) || response.transports.length > 8) fail('transports');
    transports = [...new Set(response.transports.filter((t) => TRANSPORTS.includes(t)))];
  }
  return {
    credentialId: id,
    publicKey: toBase64Url(authData.attested.publicKeyBytes),
    alg,
    signCount: authData.signCount,
    transports,
    backedUp: authData.flags.bs,
    uv: authData.flags.uv,
  };
}

/** The credential id and user handle of an assertion, before the stored key is looked up. */
export function assertionIds(credential) {
  const { id, response } = credentialBase(credential);
  let userHandle = null;
  if (response.userHandle !== undefined && response.userHandle !== null && response.userHandle !== '') {
    userHandle = toBase64Url(b64(response.userHandle, 'userHandle', 64));
  }
  return { credentialId: id, userHandle };
}

/**
 * Verify an assertion (`navigator.credentials.get`) against a stored key.
 * @param {{ credential: object, challenge: string, origin: string, rpId: string,
 *   stored: { publicKey: string, alg: number, signCount: number } }} p
 * @returns {Promise<{ signCount: number, counterError: boolean, uv: boolean, backedUp: boolean }>}
 * Throws on any failure except a counter regression, which is reported as
 * `counterError` (the caller refuses the sign-in and records it).
 */
export async function verifyAuthentication({ credential, challenge, origin, rpId, stored }) {
  const { response } = credentialBase(credential);
  const clientDataJSON = b64(response.clientDataJSON, 'clientDataJSON', 4096);
  const authenticatorData = b64(response.authenticatorData, 'authenticatorData', 4096, 37);
  const signature = b64(response.signature, 'signature', 1024);
  parseClientData(clientDataJSON, 'webauthn.get', challenge, origin);
  const authData = parseAuthData(authenticatorData);
  await checkRp(authData, rpId);
  if (authData.flags.at) fail('authData: unexpected attested data');
  const keyBytes = fromBase64Url(stored.publicKey);
  if (!keyBytes) fail('stored key malformed');
  const { alg, key } = await importCoseKey(decodeCborAll(keyBytes));
  if (alg !== stored.alg) fail('stored key algorithm differs');
  const signed = new Uint8Array(authenticatorData.length + 32);
  signed.set(authenticatorData, 0);
  signed.set(await sha256Bytes(clientDataJSON), authenticatorData.length);
  if (!(await verifySignature(alg, key, signature, signed))) fail('signature does not verify');
  const counterError = (authData.signCount !== 0 || stored.signCount !== 0) && authData.signCount <= stored.signCount;
  return { signCount: authData.signCount, counterError, uv: authData.flags.uv, backedUp: authData.flags.bs };
}
