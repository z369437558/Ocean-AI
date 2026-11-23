import { vi } from 'vitest';

const render = (args) => args.map((arg) => (arg instanceof Error ? `${arg.name}: ${arg.message}` : String(arg))).join(' ');

let unexpected = [];
let expected = [];

/** Collects console.error / console.warn output per test; see test/setup.js. */
export const consoleGuard = {
  start() {
    unexpected = [];
    expected = [];
    const record = (...args) => {
      const text = render(args);
      if (!expected.some((pattern) => pattern.test(text))) unexpected.push(text);
    };
    vi.spyOn(console, 'error').mockImplementation(record);
    vi.spyOn(console, 'warn').mockImplementation(record);
  },
  finish() {
    return unexpected;
  },
};

/** Declares console output the current test provokes on purpose (e.g. React logging a caught render error). */
export function expectConsoleError(pattern) {
  expected.push(pattern);
}
