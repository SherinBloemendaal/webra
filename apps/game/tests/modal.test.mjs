// js/ui/modal.js: an open dialog makes the rest of the page inert and gives
// it back as it was, also with dialogs opened from one another.
//   node --test apps/game/tests/modal.test.mjs
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, uninstallDom } from './dom-fixtures.mjs';
import { holdPage } from '../js/ui/modal.js';

let doc;
beforeEach(() => {
  doc = installDom();
});
afterEach(() => uninstallDom());

const inert = (nodes) => nodes.map((n) => !!n.inert);

test('the siblings of the dialog and of its ancestors go inert, and come back as they were', () => {
  const header = doc.createElement('header');
  const was = doc.createElement('div');
  was.inert = true;
  const main = doc.createElement('main');
  const before = doc.createElement('button');
  const panel = doc.createElement('section');
  const inside = doc.createElement('button');
  panel.append(inside);
  main.append(before, panel);
  doc.body.append(header, was, main);
  const release = holdPage(panel);
  assert.deepEqual(inert([header, was, before, main, panel, inside]), [true, true, true, false, false, false]);
  assert.equal(doc.head.inert, undefined, 'nothing above the body');
  release();
  assert.deepEqual(inert([header, was, before, main, panel, inside]), [false, true, false, false, false, false]);
  release();
  assert.equal(was.inert, true, 'a second release changes nothing');
});

test('overlapping dialogs: the newest one holds the page, in whatever order they close', () => {
  const page = doc.createElement('button');
  const a = doc.createElement('section');
  const b = doc.createElement('section');
  doc.body.append(page, a, b);
  const releaseA = holdPage(a);
  assert.deepEqual(inert([page, a, b]), [true, false, true]);
  const releaseB = holdPage(b);
  assert.deepEqual(inert([page, a, b]), [true, true, false], 'the newer dialog is usable');
  releaseA();
  assert.deepEqual(inert([page, a, b]), [true, true, false], 'still held for the open one');
  releaseB();
  assert.deepEqual(inert([page, a, b]), [false, false, false]);
  const again = holdPage(a);
  const top = holdPage(b);
  top();
  assert.deepEqual(inert([page, a, b]), [true, false, true], 'back to the dialog still open');
  again();
  assert.deepEqual(inert([page, a, b]), [false, false, false]);
});
