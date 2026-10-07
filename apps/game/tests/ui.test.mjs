// Pure browser modules that do not need a DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CURSORS, ACTION_CURSORS, ACTION } from '../js/cursors.js';

test('every cursor is a valid SVG data URL with a hotspot and fallback', () => {
  for (const [name, css] of Object.entries(CURSORS)) {
    const m = /^url\("data:image\/svg\+xml,(.+)"\) (\d+) (\d+), [a-z-]+$/.exec(css);
    assert.ok(m, `${name}: ${css.slice(0, 60)}`);
    const svg = decodeURIComponent(m[1]);
    assert.match(svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" width="32" height="32"/);
    assert.ok(Number(m[2]) < 32 && Number(m[3]) < 32);
  }
});

test('smart actions map to cursors', () => {
  assert.equal(ACTION_CURSORS.length, 6);
  assert.equal(ACTION_CURSORS[ACTION.ATTACK], CURSORS.attack);
  assert.equal(ACTION_CURSORS[ACTION.REPAIR], CURSORS.repair);
});
