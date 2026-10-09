// Passkeys (WebAuthn) for the account forms: the server sends options as
// JSON with base64url binary members and wants credentials back in the
// same form (docs/accounts-api.md 4.4), the format of
// PublicKeyCredential.parse*OptionsFromJSON and credential.toJSON(). Newer
// browsers do the conversion themselves; for the others it is done here.

/** base64url (no padding) of bytes. */
export function toBase64url(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Bytes of a base64url string (padding optional); throws on other characters. */
export function fromBase64url(text) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]*={0,2}$/.test(text)) throw new Error('not base64url');
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const descriptors = (list) => (list ?? []).map((c) => ({ ...c, id: fromBase64url(c.id) }));

/** Options for navigator.credentials.create from the server's JSON. */
export function creationOptions(json, PKC = globalThis.PublicKeyCredential) {
  if (typeof PKC?.parseCreationOptionsFromJSON === 'function') return PKC.parseCreationOptionsFromJSON(json);
  return {
    ...json,
    challenge: fromBase64url(json.challenge),
    user: { ...json.user, id: fromBase64url(json.user.id) },
    excludeCredentials: descriptors(json.excludeCredentials),
  };
}

/** Options for navigator.credentials.get from the server's JSON. */
export function requestOptions(json, PKC = globalThis.PublicKeyCredential) {
  if (typeof PKC?.parseRequestOptionsFromJSON === 'function') return PKC.parseRequestOptionsFromJSON(json);
  return { ...json, challenge: fromBase64url(json.challenge), allowCredentials: descriptors(json.allowCredentials) };
}

/** A credential as the server wants it (RegistrationCredential or AuthenticationCredential JSON). */
export function credentialJSON(cred) {
  if (typeof cred?.toJSON === 'function') return cred.toJSON();
  const r = cred.response;
  const response = { clientDataJSON: toBase64url(r.clientDataJSON) };
  if (r.attestationObject) {
    response.attestationObject = toBase64url(r.attestationObject);
    response.transports = typeof r.getTransports === 'function' ? r.getTransports() : [];
  } else {
    response.authenticatorData = toBase64url(r.authenticatorData);
    response.signature = toBase64url(r.signature);
    if (r.userHandle) response.userHandle = toBase64url(r.userHandle);
  }
  const out = { id: cred.id, rawId: toBase64url(cred.rawId), type: cred.type, response, clientExtensionResults: cred.getClientExtensionResults?.() ?? {} };
  if (cred.authenticatorAttachment) out.authenticatorAttachment = cred.authenticatorAttachment;
  return out;
}

/** Whether this browser offers passkeys at all. */
export function passkeysAvailable(win = globalThis.window) {
  return !!(win?.PublicKeyCredential && win.navigator?.credentials?.create && win.navigator.credentials.get);
}

/** A cancelled or timed out passkey prompt (not an error worth a red message). */
export const isCancel = (err) => err?.name === 'NotAllowedError' || err?.name === 'AbortError';

/**
 * Create a passkey: `options` is the server's `{ challengeId, publicKey }`.
 * Returns `{ challengeId, credential }` for the server.
 */
export async function createPasskey(options, credentials = globalThis.navigator?.credentials) {
  const cred = await credentials.create({ publicKey: creationOptions(options.publicKey) });
  return { challengeId: options.challengeId, credential: credentialJSON(cred) };
}

/** Sign in or re-authenticate with a passkey: `options` is `{ challengeId, publicKey }`. */
export async function getPasskey(options, credentials = globalThis.navigator?.credentials) {
  const cred = await credentials.get({ publicKey: requestOptions(options.publicKey) });
  return { challengeId: options.challengeId, credential: credentialJSON(cred) };
}
