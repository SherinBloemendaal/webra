// The game's frame loop (js/frameloop.js, used by js/main.js runGame): a
// frame that throws still asks for the next one, and a presentation part
// that throws is reported once while the rest of the frame goes on. Before
// the first frame is drawn the throw goes on, so the loading screen fails
// the start (js/loadingscreen.js FirstFrameGuard). No DOM.
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { UiGuard, createFrameLoop } from '../js/frameloop.js';

/** A fake requestAnimationFrame: the frames asked for, run one by one. */
function frames() {
  const queue = [];
  let id = 0;
  return {
    request: (fn) => {
      queue.push(fn);
      return ++id;
    },
    pending: () => queue.length,
    next(now = 16) {
      const fn = queue.shift();
      fn(now);
    },
  };
}

test('frame loop: a frame that throws still asks for the next one; the error is not swallowed; stopped ends it', () => {
  const raf = frames();
  let stopped = false;
  let throwIn = null;
  const ran = [];
  const ids = [];
  const frame = createFrameLoop({
    run: (now) => {
      ran.push(now);
      if (throwIn === now) throw new Error('engine query broke');
    },
    request: raf.request,
    stopped: () => stopped,
    onRequest: (id) => ids.push(id),
  });
  frame(0);
  assert.equal(raf.pending(), 1);
  throwIn = 16;
  assert.throws(() => raf.next(16), /engine query broke/, 'the error reaches the page (logged, reported)');
  assert.equal(raf.pending(), 1, 'and the next frame is asked for anyway');
  raf.next(32);
  assert.deepEqual(ran, [0, 16, 32]);
  assert.deepEqual(ids, [1, 2, 3], 'the id of each request is kept (cancelAnimationFrame)');
  stopped = true;
  raf.next(48);
  assert.equal(raf.pending(), 0, 'stopped: no more frames');
  assert.deepEqual(ran, [0, 16, 32]);
});

test('frame loop: a start that fails before its first frame stops the loop (FirstFrameGuard)', () => {
  const raf = frames();
  let stopped = false;
  // As js/loadingscreen.js FirstFrameGuard.run: before the first frame a throw fails the screen and stops the loop.
  const guard = { drawn: false, run: (fn) => { try { return fn(); } catch { stopped = true; return undefined; } } };
  const frame = createFrameLoop({ run: () => guard.run(() => { throw new Error('no GPU'); }), request: raf.request, stopped: () => stopped });
  frame(0);
  assert.equal(stopped, true);
  assert.equal(raf.pending(), 0);
});

test('UI guard: a throwing part is reported once per name, the frame goes on, later frames skip only that part; strict throws', () => {
  const reports = [];
  const logs = [];
  let strict = true;
  const guard = new UiGuard({ report: (err, name) => reports.push([name, err.message]), log: (message) => logs.push(message), strict: () => strict });
  const boom = () => {
    throw new TypeError("Failed to execute 'setTimeout' on 'Window': Illegal invocation");
  };
  // Before the first frame: the loading screen's error path.
  assert.throws(() => guard.run('tour', boom), /Illegal invocation/);
  assert.deepEqual(reports, []);
  strict = false;
  const done = [];
  for (let f = 0; f < 3; f++) {
    guard.run('tour', boom);
    done.push(guard.run('sidebar', () => `frame ${f}`));
  }
  assert.deepEqual(done, ['frame 0', 'frame 1', 'frame 2'], 'the other parts keep running');
  assert.deepEqual(reports, [['tour', "Failed to execute 'setTimeout' on 'Window': Illegal invocation"]], 'reported once, not every frame');
  assert.equal(logs.length, 1);
  assert.match(logs[0], /tour/);
  guard.run('guide', boom);
  assert.deepEqual(reports.map(([n]) => n), ['tour', 'guide'], 'another part is its own report');
  // A report that fails does not stop the frame either.
  const quiet = new UiGuard({ report: () => { throw new Error('no network'); }, log: () => {} });
  assert.equal(quiet.run('hud', boom), undefined);
});

test('frame loop with the UI guard: a throwing UI callback does not stop the next frame being asked for', () => {
  const raf = frames();
  const guard = new UiGuard({ log: () => {} });
  let steps = 0;
  const frame = createFrameLoop({
    run: () => {
      steps++; // host.step: the simulation goes on
      guard.run('tour', () => {
        throw new Error('tour broke');
      });
    },
    request: raf.request,
    stopped: () => false,
  });
  frame(0);
  for (let i = 1; i <= 5; i++) raf.next(i * 16);
  assert.equal(steps, 6);
  assert.equal(raf.pending(), 1);
  assert.deepEqual([...guard.failed], ['tour']);
});

test('main.js: the loop is createFrameLoop and the guide, the tour and the other screen parts run through the guard', () => {
  const main = readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
  assert.match(main, /const frame = createFrameLoop\(\{/);
  assert.equal((main.match(/rafId = requestAnimationFrame\(frame\)/g) ?? []).length, 1, 'only the first frame is asked for by hand');
  assert.match(main, /strict: \(\) => !firstFrame\.drawn/);
  for (const call of ['guideTracker?.onEvents(events)', 'guideTracker?.onState(', 'tour?.refresh()', 'commandBar.update()', 'commandBar.frame()', 'pings.onEvents(', 'audio?.frame(']) {
    const at = main.indexOf(call);
    assert.ok(at > 0, call);
    assert.match(main.slice(Math.max(0, at - 40), at), /safe\('[a-z ]+', \(\) =>\s*$/, `${call} runs through safe()`);
  }
});
