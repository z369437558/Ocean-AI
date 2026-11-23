/** Small request-parameter parsers that fail with a 400 instead of guessing. */
import { badRequest } from './errors.js';

/** First of the given query parameter names that is present, as a trimmed string. */
export function queryString(query, names, { maxLength = 200 } = {}) {
  for (const name of names) {
    const value = query[name];
    if (value === undefined) continue;
    if (typeof value !== 'string') throw badRequest(`Query parameter "${name}" must be a single value`);
    const text = value.trim();
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
