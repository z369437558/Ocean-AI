/** Small request-parameter parsers that fail with a 400 instead of guessing. */
import { badRequest } from './errors.js';

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const CONTROL_CHARS_EXCEPT_LINE_BREAKS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/**
 * Rejects text that could not be stored and read back faithfully: NUL and other control
 * characters, and unpaired surrogates (which are not valid UTF-8 once written to SQLite).
 */
export function assertPlainText(value, label, { allowLineBreaks = false } = {}) {
  const forbidden = allowLineBreaks ? CONTROL_CHARS_EXCEPT_LINE_BREAKS : CONTROL_CHARS;
  if (forbidden.test(value) || !value.isWellFormed()) {
    throw badRequest(`${label} contains characters that are not allowed (control characters or malformed Unicode)`);
  }
}

/** First of the given query parameter names that is present, as a trimmed string. */
export function queryString(query, names, { maxLength = 200 } = {}) {
  for (const name of names) {
    const value = query[name];
    if (value === undefined) continue;
    if (typeof value !== 'string') throw badRequest(`Query parameter "${name}" must be a single value`);
    const text = value.trim();
    assertPlainText(text, `Query parameter "${name}"`);
    if (text.length > maxLength) throw badRequest(`Query parameter "${name}" must be at most ${maxLength} characters`);
    return text;
  }
  return undefined;
}

export function queryInteger(query, names, { min, max, fallback }) {
  for (const name of names) {
    if (query[name] === undefined) continue;
    const text = queryString(query, [name]);
    if (!/^\d{1,9}$/.test(text)) throw badRequest(`Query parameter "${name}" must be a whole number`);
    const value = Number(text);
    if (value < min || value > max) throw badRequest(`Query parameter "${name}" must be between ${min} and ${max}`);
    return value;
  }
  return fallback;
}

/** Positive integer id taken from a path segment; anything else is treated as "no such record". */
export function pathId(value) {
  return typeof value === 'string' && /^[1-9]\d{0,14}$/.test(value) ? Number(value) : null;
}
