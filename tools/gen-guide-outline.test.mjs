// tools/gen-guide-outline.mjs: packages/protocol/src/guide-outline.js is the
// game's guide (apps/game/js/help.js GUIDE) without its texts, and in sync
// with it (CI regenerates it too).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CONTENT, guideContent } from '../apps/game/js/guide.js';
import { guideOutline, OUTLINE_PATH, outlineSource } from './gen-guide-outline.mjs';
import { GUIDE_OUTLINE } from '../packages/protocol/src/guide-outline.js';

test('the committed outline is what the generator writes now (run node tools/gen-guide-outline.mjs after changing the guide)', () => {
  assert.equal(readFileSync(OUTLINE_PATH, 'utf8'), outlineSource());
  assert.deepEqual(JSON.parse(JSON.stringify(GUIDE_OUTLINE)), guideOutline());
});

test('the outline: chapters in guide order, the tour order, resolved since and after, flags; no texts', () => {
  const o = guideOutline();
  assert.deepEqual(o.tourOrder, CONTENT.tourChapters.map((c) => c.id));
  assert.equal(o.version, CONTENT.version);
  const steps = o.chapters.flatMap((c) => c.steps);
  assert.deepEqual(steps.map((s) => s.id), [...CONTENT.stepIds]);
  for (const s of steps) {
    assert.deepEqual(Object.keys(s), ['id', 'since', 'after', 'parallel', 'passive', 'outside'], s.id);
    assert.equal(s.since, CONTENT.steps.get(s.id).since);
    assert.deepEqual(s.after, [...CONTENT.steps.get(s.id).after]);
  }
  // A small guide: a step without its own since takes the chapter's, `after` the previous step that is not parallel.
  const small = guideOutline(
    guideContent([
      { id: 'one', since: '0.18.0', title: 'One', steps: [{ id: 'one.a', title: 'A', text: '' }, { id: 'one.b', parallel: true, passive: true, title: 'B', text: '' }, { id: 'one.c', since: '0.19.0', outside: true, title: 'C', text: '' }] },
    ]),
  );
  assert.deepEqual(small.chapters[0].steps, [
    { id: 'one.a', since: '0.18.0', after: [], parallel: false, passive: false, outside: false },
    { id: 'one.b', since: '0.18.0', after: ['one.a'], parallel: true, passive: true, outside: false },
    { id: 'one.c', since: '0.19.0', after: ['one.a'], parallel: false, passive: false, outside: true },
  ]);
  assert.equal(small.version, '0.19.0');
  assert.doesNotMatch(outlineSource(), /"title"|"text"|"tour"/);
});
