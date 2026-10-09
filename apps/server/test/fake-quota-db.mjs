// The quota statements of src/quota.js (read, then upsert by an amount)
// against a Map, for relay tests that need no full D1.
import assert from 'node:assert/strict';

export class FakeQuotaDb {
  constructor() {
    this.rows = new Map();
    this.writes = 0;
  }
  prepare(sql) {
    const db = this;
    return {
      bind(key, win, amount = 1) {
        return {
          async first() {
            if (/^SELECT win, count FROM rate_limits/.test(sql)) return db.rows.get(key) ?? null;
            assert.match(sql, /INSERT INTO rate_limits/);
            db.writes++;
            const row = db.rows.get(key);
            const count = row && row.win === win ? row.count + amount : amount;
            db.rows.set(key, { win, count });
            return { count };
          },
        };
      },
    };
  }
}
