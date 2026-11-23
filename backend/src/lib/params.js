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

/** Length in characters as a person counts them (code points): an emoji is one, not two. */
export function textLength(text) {
  return [...text].length;
}

/**
 * The one of the given names (aliases of the same parameter) that carries a value, with that value
 * trimmed: `{ name, text }`, or undefined when none does. A parameter that is present but blank
 * (`?sort=`) counts as not given. Two aliases with a value each are refused - one of them would
 * have to be ignored, and nothing a client sends is ignored silently.
 */
function givenParameter(query, names, maxLength) {
  let given;
  for (const name of names) {
    const value = query[name];
    if (value === undefined) continue;
    if (typeof value !== 'string') throw badRequest(`Query parameter "${name}" must be a single value`);
    const text = value.trim();
    assertPlainText(text, `Query parameter "${name}"`);
    if (text.length > maxLength && textLength(text) > maxLength) {
      throw badRequest(`Query parameter "${name}" must be at most ${maxLength} characters`);
    }
    if (text === '') continue;
    if (given) throw badRequest(`Query parameters "${given.name}" and "${name}" mean the same; send only one of them`);
    given = { name, text };
  }
  return given;
}

/** The value of a text parameter that may go by several names, or undefined when it is not given. */
export function queryString(query, names, { maxLength = 200 } = {}) {
  return givenParameter(query, names, maxLength)?.text;
}

/**
 * Like queryString, for whole numbers within [min, max]. Both limits must be safely below 2^53:
 * a digit string too long to be converted exactly is then far beyond `max` either way.
 */
export function queryInteger(query, names, { min, max, fallback }) {
  const given = givenParameter(query, names, 200);
  if (!given) return fallback;
  if (!/^\d+$/.test(given.text)) throw badRequest(`Query parameter "${given.name}" must be a whole number`);
  const value = Number(given.text);
  if (value < min || value > max) throw badRequest(`Query parameter "${given.name}" must be between ${min} and ${max}`);
  return value;
}

/** Positive integer id taken from a path segment; anything else is treated as "no such record". */
export function pathId(value) {
  return typeof value === 'string' && /^[1-9]\d{0,14}$/.test(value) ? Number(value) : null;
}
