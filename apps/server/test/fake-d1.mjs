// A D1 binding over Node's built-in SQLite (node:sqlite), with the real
// migrations applied, so server code runs its actual SQL under `node --test`.
// Mirrors the parts of the D1 API the Worker uses: prepare/bind, first, all,
// run, raw, batch (atomic) and exec. Booleans and undefined are refused like
// D1 refuses unsupported types, so the code under test cannot rely on them.
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';

const MIGRATIONS = new URL('../migrations/', import.meta.url);

function checkArgs(args) {
  for (const a of args) {
    if (a === undefined) throw new Error('D1_TYPE_ERROR: undefined bound');
    if (typeof a === 'boolean') throw new Error('D1_TYPE_ERROR: boolean bound (use 0 or 1)');
  }
  return args;
}

const plain = (row) => (row ? { ...row } : row);

class Statement {
  constructor(db, sql, args = []) {
    this.db = db;
    this.sql = sql;
    this.args = args;
  }

  bind(...args) {
    return new Statement(this.db, this.sql, checkArgs(args));
  }

  stmt() {
    this.db.queries++;
    return this.db.sqlite.prepare(this.sql);
  }

  async first(column) {
    const row = plain(this.stmt().get(...this.args));
    if (row === undefined) return null;
    return column === undefined ? row : (row[column] ?? null);
  }

  async all() {
    return { success: true, results: this.stmt().all(...this.args).map(plain), meta: {} };
  }

  async raw() {
    return this.stmt()
      .all(...this.args)
      .map((r) => Object.values(r));
  }

  async run() {
    return this.exec();
  }

  exec() {
    const st = this.stmt();
    if (/\bRETURNING\b/i.test(this.sql)) {
      const results = st.all(...this.args).map(plain);
      return { success: true, results, meta: { changes: results.length } };
    }
    const r = st.run(...this.args);
    return { success: true, results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
}

export class FakeD1 {
  constructor() {
    this.sqlite = new DatabaseSync(':memory:');
    this.sqlite.exec('PRAGMA foreign_keys = ON');
    this.queries = 0;
    for (const f of readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql')).sort()) {
      this.sqlite.exec(readFileSync(new URL(f, MIGRATIONS), 'utf8'));
    }
  }

  prepare(sql) {
    return new Statement(this, sql);
  }

  async batch(statements) {
    this.sqlite.exec('BEGIN');
    try {
      const out = statements.map((s) => s.exec());
      this.sqlite.exec('COMMIT');
      return out;
    } catch (err) {
      this.sqlite.exec('ROLLBACK');
      throw err;
    }
  }

  async exec(sql) {
    this.sqlite.exec(sql);
    return { count: 1, duration: 0 };
  }

  /** Test helper: synchronous query. */
  rows(sql, ...args) {
    return this.sqlite.prepare(sql).all(...args).map(plain);
  }
}
