import { createHash } from 'node:crypto';

/** JSON with object keys sorted recursively, so logically equal payloads serialise identically. */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const members = Object.keys(value)
    .sort()
    .filter((key) => value[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
  return `{${members.join(',')}}`;
}

/**
 * Stable hash of a request, used to tell an honest retry (same key, same request) apart from
 * idempotency-key misuse (same key, different request).
 */
export function requestFingerprint(method, route, body) {
  return createHash('sha256')
    .update(`${method.toUpperCase()} ${route}\n${canonicalJson(body ?? null)}`)
    .digest('hex');
}
