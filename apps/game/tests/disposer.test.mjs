// js/disposer.js: what a game sets up comes down again, newest first, also
// when a step fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Disposer } from '../js/disposer.js';
import { FakeEvent, installDom, uninstallDom } from './dom-fixtures.mjs';

test('dispose runs every step once, newest first, and keeps going after a step throws', () => {
  const errors = [];
  const scope = new Disposer({ onError: (err) => errors.push(err.message) });
  const order = [];
  scope.add(() => order.push('first'));
  scope.add(() => {
    throw new Error('broken part');
  });
  scope.add(() => order.push('last'));
  scope.add(undefined); // a subscription that was not made (no content, no audio)
  assert.equal(scope.size, 3);
  scope.dispose();
  assert.deepEqual(order, ['last', 'first']);
  assert.deepEqual(errors, ['broken part']);
  assert.equal(scope.size, 0);
  scope.dispose();
  assert.deepEqual(order, ['last', 'first'], 'a second dispose does nothing');
  // Added after dispose: runs at once (a part made while the game was going).
  scope.add(() => order.push('late'));
  assert.deepEqual(order, ['last', 'first', 'late']);
});

test('on() removes the listener again; own() ends a part by dispose, destroy or remove', () => {
  const doc = installDom();
  try {
    const el = doc.createElement('div');
    doc.body.append(el);
    const scope = new Disposer();
    let clicks = 0;
    scope.on(el, 'click', () => clicks++);
    el.dispatchEvent(new FakeEvent('click'));
    assert.equal(clicks, 1);
    const ended = [];
    scope.own({ dispose: () => ended.push('dispose') });
    scope.own({ destroy: () => ended.push('destroy') });
    const node = doc.createElement('span');
    doc.body.append(node);
    scope.own(node);
    assert.equal(scope.own(null), null);
    assert.throws(() => scope.own({}), /no dispose/);
    scope.dispose();
    el.dispatchEvent(new FakeEvent('click'));
    assert.equal(clicks, 1, 'the listener is gone');
    assert.equal(el.listeners.get('click').length, 0);
    assert.deepEqual(ended, ['destroy', 'dispose']);
    assert.equal(node.parentNode, null, 'an element is removed');
  } finally {
    uninstallDom();
  }
});

test('timeout() is cleared on dispose', async () => {
  const scope = new Disposer();
  let fired = false;
  scope.timeout(() => (fired = true), 5);
  scope.dispose();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(fired, false);
});
