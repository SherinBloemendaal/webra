// Pure browser modules that do not need a DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CURSORS, ACTION_CURSORS, ACTION, POWER_CURSORS } from '../js/cursors.js';

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
  assert.equal(ACTION_CURSORS.length, 8);
  assert.equal(ACTION_CURSORS[ACTION.ATTACK], CURSORS.attack);
  assert.equal(ACTION_CURSORS[ACTION.REPAIR], CURSORS.repair);
  assert.equal(ACTION_CURSORS[ACTION.LOAD], CURSORS.load);
  assert.equal(ACTION_CURSORS[ACTION.DELIVER_CASH], CURSORS.deliver);
});

test('targeted support powers have their own cursors', () => {
  for (const kind of ['ChronoshiftPower', 'GrantExternalConditionPower', 'NukePower']) assert.ok(POWER_CURSORS[kind], kind);
  for (const name of ['mine', 'teleport', 'ironCurtain', 'nuke', 'deliver']) assert.ok(CURSORS[name], name);
});

test('placement and edge scroll cursors exist for every direction, hotspot on the arrow tip', async () => {
  const { SCROLL_DIRS, scrollCursor } = await import('../js/cursors.js');
  assert.ok(CURSORS.place);
  assert.equal(SCROLL_DIRS.length, 8);
  const hotspot = (css) => /\) (\d+) (\d+), /.exec(css).slice(1).map(Number);
  for (const [dir, dx, dy] of SCROLL_DIRS) {
    for (const blocked of [false, true]) {
      const css = scrollCursor(dx, dy, blocked);
      assert.equal(css, CURSORS[`scroll${dir}${blocked ? 'Blocked' : ''}`], dir);
      const [hx, hy] = hotspot(css);
      // The tip points off the screen: towards the edge the view scrolls to.
      if (dx) assert.equal(Math.sign(hx - 16), dx, `${dir} x`);
      else assert.equal(hx, 16, `${dir} x`);
      if (dy) assert.equal(Math.sign(hy - 16), dy, `${dir} y`);
      else assert.equal(hy, 16, `${dir} y`);
    }
    assert.notEqual(scrollCursor(dx, dy), scrollCursor(dx, dy, true));
  }
  assert.equal(scrollCursor(0, 0), null);
  assert.equal(scrollCursor(-3, 5), CURSORS.scrollSW, 'only the sign counts');
});

test('edge scrolling: direction from the mouse, blocked at the camera limits', async () => {
  const { edgeDirection, cameraBounds, scrollBlocked } = await import('../js/input.js');
  assert.deepEqual(edgeDirection(400, 300, 800, 600), { dx: 0, dy: 0 });
  assert.deepEqual(edgeDirection(0, 0, 800, 600), { dx: -1, dy: -1 });
  assert.deepEqual(edgeDirection(799, 2, 800, 600), { dx: 1, dy: -1 });
  assert.deepEqual(edgeDirection(799, 300, 800, 600), { dx: 1, dy: 0 });
  assert.deepEqual(edgeDirection(799, 599, 800, 600), { dx: 1, dy: 1 });
  assert.deepEqual(edgeDirection(400, 599, 800, 600), { dx: 0, dy: 1 });
  assert.deepEqual(edgeDirection(3, 599, 800, 600), { dx: -1, dy: 1 });
  assert.deepEqual(edgeDirection(3, 300, 800, 600), { dx: -1, dy: 0 });
  const b = cameraBounds(400, 300, 1000, 1000, 48);
  assert.deepEqual(b, { minX: -48, maxX: 648, minY: -48, maxY: 748 });
  assert.equal(scrollBlocked(-1, 0, { x: -48, y: 0 }, b), true, 'at the left limit');
  assert.equal(scrollBlocked(1, 0, { x: -48, y: 0 }, b), false);
  assert.equal(scrollBlocked(-1, -1, { x: -48, y: 10 }, b), false, 'diagonal: one axis can still move');
  assert.equal(scrollBlocked(-1, -1, { x: -48, y: -48 }, b), true, 'corner');
  // A map smaller than the view cannot scroll at all.
  const small = cameraBounds(2000, 2000, 1000, 1000, 48);
  assert.equal(scrollBlocked(1, 1, { x: -48, y: -48 }, small), true);
});
