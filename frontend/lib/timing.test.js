// Unit tests for the shared timing helpers, using the Node test runner's
// mock timers so we don't wait on real wall-clock delays.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

import { debounce, throttle } from './timing.js';

test('debounce: fires once, trailing, after the quiet window', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let calls = 0;
    const fn = debounce(() => { calls++; }, 100);
    fn(); fn(); fn();
    mock.timers.tick(99);
    assert.equal(calls, 0);          // still within the window
    mock.timers.tick(1);
    assert.equal(calls, 1);          // one trailing call for the burst
  } finally {
    mock.timers.reset();
  }
});

test('debounce: passes the most recent arguments', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let seen = null;
    const fn = debounce((x) => { seen = x; }, 50);
    fn('a'); fn('b'); fn('c');
    mock.timers.tick(50);
    assert.equal(seen, 'c');
  } finally {
    mock.timers.reset();
  }
});

test('debounce: cancel() drops a pending invocation', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let calls = 0;
    const fn = debounce(() => { calls++; }, 100);
    fn();
    fn.cancel();
    mock.timers.tick(200);
    assert.equal(calls, 0);
  } finally {
    mock.timers.reset();
  }
});

test('throttle: leading-edge, then gated for the interval', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    let calls = 0;
    const fn = throttle(() => { calls++; }, 100);
    fn();                  // runs immediately
    assert.equal(calls, 1);
    fn(); fn();            // gated
    assert.equal(calls, 1);
    mock.timers.tick(100);
    fn();                  // gate reopened
    assert.equal(calls, 2);
  } finally {
    mock.timers.reset();
  }
});
