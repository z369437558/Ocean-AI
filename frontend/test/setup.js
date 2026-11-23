/**
 * Runs before every test file: a clean browser state per test, and a strict console.
 *
 * React reports its warnings (missing keys, state updates outside act, invalid DOM nesting ...)
 * through console.error. Anything on console.error or console.warn therefore fails the test that
 * caused it, unless the test announced it with `expectConsoleError`.
 */
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, expect, vi } from 'vitest';

import { consoleGuard } from './support/console.js';

beforeEach(() => {
  consoleGuard.start();
});

afterEach(() => {
  cleanup(); // unmount first: nothing may keep reacting while the next test sets up
  vi.useRealTimers();
  window.localStorage.clear();
  window.sessionStorage.clear(); // bulk-issue attempts without a known outcome are kept there
  window.history.replaceState(null, '', '/'); // back to the default route without firing hashchange
  document.title = '';
  expect(consoleGuard.finish(), 'unexpected console.error / console.warn output').toEqual([]);
});
