// An R2 bucket binding in memory (the parts src/accounts/replays.js uses:
// put, get, head and delete of one key or a list), so the server tests run
// the Worker's real code without Cloudflare. `failPut` / `failDelete` make
// the next calls throw like an R2 outage.
export class FakeR2 {
  constructor() {
    this.objects = new Map();
    this.failPut = false;
    this.failDelete = false;
    this.deleted = [];
  }

  async put(key, value, { httpMetadata = {}, customMetadata = {} } = {}) {
    if (this.failPut) throw new Error('R2 put failed');
    const bytes = value instanceof Uint8Array ? value.slice() : new Uint8Array(await new Response(value).arrayBuffer());
    this.objects.set(key, { bytes, httpMetadata: { ...httpMetadata }, customMetadata: { ...customMetadata } });
    return { key, size: bytes.byteLength };
  }

  async head(key) {
    const o = this.objects.get(key);
    return o ? { key, size: o.bytes.byteLength, httpMetadata: o.httpMetadata, customMetadata: o.customMetadata } : null;
  }

  async get(key) {
    const o = this.objects.get(key);
    if (!o) return null;
    return {
      key,
      size: o.bytes.byteLength,
      httpMetadata: o.httpMetadata,
      customMetadata: o.customMetadata,
      body: new Blob([o.bytes]).stream(),
      arrayBuffer: async () => o.bytes.slice().buffer,
    };
  }

  async delete(keys) {
    if (this.failDelete) throw new Error('R2 delete failed');
    const list = Array.isArray(keys) ? keys : [keys];
    if (list.length > 1000) throw new Error('R2 deletes at most 1000 keys at once');
    for (const k of list) {
      this.objects.delete(k);
      this.deleted.push(k);
    }
  }

  /** Test helper: the stored keys under a prefix. */
  keys(prefix = '') {
    return [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
}
