// Per-viewer settings (js/settings.js) with a fake localStorage.
import { test } from 'node:test';
import assert from 'node:assert/strict';

class MemoryStorage {
  constructor() {
    this.items = new Map();
  }
  getItem(k) {
    return this.items.has(k) ? this.items.get(k) : null;
  }
  setItem(k, v) {
    this.items.set(k, String(v));
  }
  removeItem(k) {
    this.items.delete(k);
  }
}

const storage = new MemoryStorage();
globalThis.localStorage = storage;
const settings = await import('../js/settings.js');

test('show unit paths is off by default, persists and notifies', () => {
  assert.equal(settings.get('showUnitPaths'), false);
  const seen = [];
  const off = settings.subscribe((key, value) => seen.push([key, value]));
  settings.set('showUnitPaths', true);
  assert.equal(settings.get('showUnitPaths'), true);
  assert.deepEqual(JSON.parse(storage.getItem(settings.STORAGE_KEY)), { showUnitPaths: true });
  settings.set('showUnitPaths', true);
  assert.deepEqual(seen, [['showUnitPaths', true]], 'no event when nothing changed');
  off();
  settings.set('showUnitPaths', false);
  assert.equal(seen.length, 1, 'unsubscribed');
});

test('stored values are read back, bad ones fall back to the defaults', () => {
  storage.setItem(settings.STORAGE_KEY, JSON.stringify({ showUnitPaths: true, other: 1 }));
  settings.reload();
  assert.equal(settings.get('showUnitPaths'), true);
  storage.setItem(settings.STORAGE_KEY, JSON.stringify({ showUnitPaths: 'yes' }));
  settings.reload();
  assert.equal(settings.get('showUnitPaths'), false);
  storage.setItem(settings.STORAGE_KEY, '{not json');
  settings.reload();
  assert.equal(settings.get('showUnitPaths'), false);
});

test('blocked storage does not break the setting for the session', () => {
  const broken = {
    getItem() {
      throw new Error('blocked');
    },
    setItem() {
      throw new Error('blocked');
    },
  };
  globalThis.localStorage = broken;
  try {
    settings.reload();
    assert.equal(settings.get('showUnitPaths'), false);
    settings.set('showUnitPaths', true);
    assert.equal(settings.get('showUnitPaths'), true);
  } finally {
    globalThis.localStorage = storage;
  }
});

test('unknown keys and wrong types are refused', () => {
  assert.throws(() => settings.get('nope'), /unknown setting/);
  assert.throws(() => settings.set('nope', true), /unknown setting/);
  assert.throws(() => settings.set('showUnitPaths', 1), /boolean/);
});
