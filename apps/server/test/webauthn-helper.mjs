// A software authenticator for tests: makes WebAuthn registration and
// assertion responses (PublicKeyCredential.toJSON() shape) with WebCrypto
// keys, so the server's ceremonies run against real signatures for EdDSA,
// ES256 and RS256. Also a minimal CBOR encoder.

const enc = new TextEncoder();

export function b64url(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

export function fromB64url(s) {
  return new Uint8Array(Buffer.from(s, 'base64url'));
}

function head(major, n) {
  if (n < 24) return [(major << 5) | n];
  if (n < 0x100) return [(major << 5) | 24, n];
  if (n < 0x10000) return [(major << 5) | 25, n >> 8, n & 0xff];
  return [(major << 5) | 26, (n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/** CBOR for integers, strings, byte strings, arrays, Maps, plain objects, booleans and null. */
export function encodeCbor(v) {
  const out = [];
  const walk = (x) => {
    if (x === null) out.push(0xf6);
    else if (x === true) out.push(0xf5);
    else if (x === false) out.push(0xf4);
    else if (typeof x === 'number') out.push(...(x >= 0 ? head(0, x) : head(1, -1 - x)));
    else if (typeof x === 'string') {
      const b = enc.encode(x);
      out.push(...head(3, b.length), ...b);
    } else if (x instanceof Uint8Array) out.push(...head(2, x.length), ...x);
    else if (Array.isArray(x)) {
      out.push(...head(4, x.length));
      x.forEach(walk);
    } else {
      const entries = x instanceof Map ? [...x.entries()] : Object.entries(x);
      out.push(...head(5, entries.length));
      for (const [k, val] of entries) {
        walk(k);
        walk(val);
      }
    }
  };
  walk(v);
  return new Uint8Array(out);
}

const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

const sha256 = async (data) => new Uint8Array(await crypto.subtle.digest('SHA-256', typeof data === 'string' ? enc.encode(data) : data));

/** Raw r || s (WebCrypto ECDSA) to DER, as authenticators send it. */
export function rawToDer(raw) {
  const int = (b) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    let v = b.slice(i);
    if (v[0] & 0x80) v = concat(new Uint8Array([0]), v);
    return concat(new Uint8Array([0x02, v.length]), v);
  };
  const body = concat(int(raw.slice(0, 32)), int(raw.slice(32)));
  return concat(new Uint8Array([0x30, body.length]), body);
}

export class Authenticator {
  /** @param {'ES256' | 'RS256' | 'EdDSA'} alg */
  static async create(alg = 'ES256') {
    const a = new Authenticator();
    a.alg = alg;
    if (alg === 'ES256') a.keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    else if (alg === 'RS256') {
      a.keys = await crypto.subtle.generateKey(
        { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
        true,
        ['sign', 'verify'],
      );
    } else a.keys = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
    a.credentialId = crypto.getRandomValues(new Uint8Array(32));
    a.counter = 0;
    a.userHandle = null;
    return a;
  }

  get id() {
    return b64url(this.credentialId);
  }

  async coseKey() {
    const jwk = await crypto.subtle.exportKey('jwk', this.keys.publicKey);
    if (this.alg === 'ES256') return new Map([[1, 2], [3, -7], [-1, 1], [-2, fromB64url(jwk.x)], [-3, fromB64url(jwk.y)]]);
    if (this.alg === 'RS256') return new Map([[1, 3], [3, -257], [-1, fromB64url(jwk.n)], [-2, fromB64url(jwk.e)]]);
    return new Map([[1, 1], [3, -8], [-1, 6], [-2, fromB64url(jwk.x)]]);
  }

  async authData(rpId, { flags = 0x05, attested = false, counter = this.counter } = {}) {
    const parts = [await sha256(rpId), new Uint8Array([flags | (attested ? 0x40 : 0)]), new Uint8Array([(counter >>> 24) & 0xff, (counter >> 16) & 0xff, (counter >> 8) & 0xff, counter & 0xff])];
    if (attested) {
      parts.push(new Uint8Array(16), new Uint8Array([this.credentialId.length >> 8, this.credentialId.length & 0xff]), this.credentialId, encodeCbor(await this.coseKey()));
    }
    return concat(...parts);
  }

  /** Response to navigator.credentials.create(options). */
  async register(publicKey, origin, { rpId = publicKey.rp.id, type = 'webauthn.create', flags, fmt = 'none' } = {}) {
    this.userHandle = publicKey.user.id;
    const clientData = enc.encode(JSON.stringify({ type, challenge: publicKey.challenge, origin, crossOrigin: false }));
    const authData = await this.authData(rpId, { attested: true, flags });
    const attestationObject = encodeCbor(new Map([['fmt', fmt], ['attStmt', new Map()], ['authData', authData]]));
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      response: { clientDataJSON: b64url(clientData), attestationObject: b64url(attestationObject), transports: ['internal'] },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }

  /** Response to navigator.credentials.get(options); the counter goes up by one unless given. */
  async assert(publicKey, origin, { rpId = publicKey.rpId, type = 'webauthn.get', counter, flags, userHandle = this.userHandle, challenge = publicKey.challenge } = {}) {
    if (counter === undefined) this.counter += 1;
    else this.counter = counter;
    const clientData = enc.encode(JSON.stringify({ type, challenge, origin }));
    const authData = await this.authData(rpId, { flags, counter: this.counter });
    const signed = concat(authData, await sha256(clientData));
    let signature;
    if (this.alg === 'ES256') signature = rawToDer(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, this.keys.privateKey, signed)));
    else if (this.alg === 'RS256') signature = new Uint8Array(await crypto.subtle.sign({ name: 'RSASSA-PKCS1-v1_5' }, this.keys.privateKey, signed));
    else signature = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, this.keys.privateKey, signed));
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      response: {
        clientDataJSON: b64url(clientData),
        authenticatorData: b64url(authData),
        signature: b64url(signature),
        ...(userHandle ? { userHandle } : {}),
      },
      clientExtensionResults: {},
    };
  }
}
