import { createHash } from 'node:crypto';

/**
 * JSON with object keys sorted at every level, so logically equal payloads serialise identically.
 * Iterative on purpose: request bodies are attacker-controlled and JSON.parse accepts nesting far
 * deeper than the call stack, so a recursive walk could be made to overflow.
 */
export function canonicalJson(value) {
  const out = [];
  // Work stack of things still to emit: literal strings, or { value } entries to serialise.
  const stack = [{ value }];
  while (stack.length > 0) {
    const item = stack.pop();
    if (typeof item === 'string') {
      out.push(item);
      continue;
    }
    const current = item.value;
    if (current === null || typeof current !== 'object') {
      out.push(JSON.stringify(current) ?? 'null');
    } else if (Array.isArray(current)) {
      stack.push(']');
      for (let i = current.length - 1; i >= 0; i -= 1) {
        stack.push({ value: current[i] });
        if (i > 0) stack.push(',');
      }
      out.push('[');
    } else {
      const keys = Object.keys(current)
        .filter((key) => current[key] !== undefined)
        .sort();
      stack.push('}');
      for (let i = keys.length - 1; i >= 0; i -= 1) {
        stack.push({ value: current[keys[i]] });
        stack.push(`${JSON.stringify(keys[i])}:`);
        if (i > 0) stack.push(',');
      }
      out.push('{');
    }
  }
  return out.join('');
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
