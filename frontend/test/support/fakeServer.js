/**
 * A stand-in for the backend, installed as the global `fetch`. No server, no network.
 *
 * It answers from responses recorded from the real backend (../fixtures/recorded.json) and keeps
 * just enough state to behave like it across a workflow: list filters, sorting and paging, a
 * revocation that shows up in list and detail, a bulk issue that executes once per idempotency
 * key and replays afterwards. Anything beyond the recording fails loudly instead of inventing data.
 *
 * Tests steer single answers with `server.on(...)` / `server.once(...)`:
 *
 *   const gate = deferred();
 *   server.on('POST', '/api/bulk-issues', async (request, respond) => {
 *     await gate.promise;           // hold the request
 *     return respond();             // then answer like the backend would
 *   });
 *
 * A handler returns a Response, or throws `networkError()` for a request that got no answer.
 * `respond()` executes the request on the fake state, so "the server did it, but the answer was
 * lost" is: `respond(); throw networkError();`.
 */
import { vi } from 'vitest';

import recorded from '../fixtures/recorded.json';

export { recorded };
export const ALICE = 'alice@east.test';
export const BOB = 'bob@west.test';

const copy = (value) => JSON.parse(JSON.stringify(value));

// --- Building answers -------------------------------------------------------------------------

export function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });
}

/** A recorded error answer, e.g. `errorAnswer(recorded.errors.databaseBusy)`. */
export const errorAnswer = ({ status, body, headers }) => json(status, body, headers);

/** What the backend's error handler sends for an unexpected exception (app.js). */
export const internalError = () => json(500, { error: { code: 'internal_error', message: 'Unexpected server error' } });

/** What `fetch` rejects with when the request gets no answer at all. */
export const networkError = () => new TypeError('Failed to fetch');

/** A response whose status line arrives but whose body cannot be read (connection cut after the headers). */
export function unreadableBody(status, headers = {}) {
  const fail = async () => {
    throw new TypeError('Failed to fetch');
  };
  return { ok: status >= 200 && status < 300, status, headers: new Headers(headers), json: fail, blob: fail, text: fail };
}

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const abortError = () => new DOMException('The operation was aborted.', 'AbortError');

// --- The backend's rules, as far as the UI can observe them --------------------------------------

class HttpError extends Error {
  constructor(answer) {
    super(answer.body.error.message);
    this.answer = answer;
  }
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

const SORT_KEYS = {
  issued: (certificate) => [certificate.issuedLocalDate, certificate.issuedAt],
  learner: (certificate) => [certificate.learnerName.toLowerCase()],
  course: (certificate) => [certificate.courseTitle.toLowerCase()],
  serial: (certificate) => [certificate.serialNumber],
  status: (certificate) => [certificate.status],
};

function compareKeys(a, b) {
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/** Filter + order shared by the list and the export, like the backend's parseListQuery/buildFilter. */
function matchingCertificates(tenant, query) {
  const q = (query.q ?? '').trim();
  if (CONTROL_CHARS.test(q)) throw new HttpError(recorded.errors.invalidSearch);
  const status = query.status ?? 'all';
  const sort = query.sort ?? 'issued';
  const order = query.order ?? (sort === 'issued' ? 'desc' : 'asc');
  const needle = q.toLowerCase();
  const rows = tenant.certificates
    .filter((certificate) => status === 'all' || certificate.status === status)
    .filter((certificate) => certificate.learnerName.toLowerCase().includes(needle) || certificate.serialNumber.toLowerCase().includes(needle))
    .sort((a, b) => compareKeys([...SORT_KEYS[sort](a), a.id], [...SORT_KEYS[sort](b), b.id]));
  if (order === 'desc') rows.reverse();
  return { rows, q, status, sort, order };
}

export function startFakeServer() {
  const tenantInfo = Object.fromEntries(recorded.actors.items.map((actor) => [actor.email, actor.tenant]));
  const tenants = {};
  for (const [email, data] of Object.entries(copy(recorded.tenants))) {
    tenants[email] = { ...data, bulkIssue: copy(recorded.bulkIssues[email]), runsDone: 0, keys: new Map() };
  }

  const requests = [];
  const overrides = [];

  function tenantOf(request) {
    const tenant = tenants[request.actor];
    if (!tenant) {
      const error = request.actor
        ? { code: 'unknown_actor', message: `No admin account matches X-Actor-Email "${request.actor}"` }
        : { code: 'actor_required', message: 'Missing X-Actor-Email header' };
      throw new HttpError({ status: 401, body: { error } });
    }
    return tenant;
  }

  /** Revokes like the backend: idempotent, and visible in list and detail afterwards. */
  function revoke(email, id, reason) {
    const tenant = tenants[email];
    const detail = tenant.details[id];
    if (!detail) throw new HttpError(recorded.errors.notFound);
    if (detail.status === 'revoked') return { ...copy(detail), alreadyRevoked: true };

    // The recording holds the real answer for one certificate; the same change applies to any other.
    const { revokedAt, revokedLocal, auditEvents } = recorded.revoke.response;
    const revokedEvent = auditEvents.at(-1);
    const text = typeof reason === 'string' && reason.trim() ? reason.trim() : null;
    const updated = {
      ...detail,
      status: 'revoked',
      revokedAt,
      revokedLocal,
      revokedBy: email,
      revocationReason: text,
      auditEvents: [
        ...detail.auditEvents,
        {
          ...revokedEvent,
          actorEmail: email,
          certificateId: id,
          details: { ...revokedEvent.details, serialNumber: detail.serialNumber, reason: text },
        },
      ],
    };
    tenant.details[id] = updated;
    tenant.certificates = tenant.certificates.map((certificate) => (certificate.id === id ? { ...certificate, status: 'revoked' } : certificate));
    return { ...copy(updated), alreadyRevoked: false };
  }

  /** Executes once per idempotency key; a repeat replays the stored body, a changed request is a 409. */
  function bulkIssue(email, courseId, key) {
    const tenant = tenants[email];
    const stored = tenant.keys.get(key);
    if (stored) {
      if (stored.courseId !== courseId) throw new HttpError(recorded.errors.keyReused);
      return { body: stored.body, replayed: true };
    }
    const { runs, operationsAfter, rosterAfter, certificatesAfter } = tenant.bulkIssue;
    const run = courseId === tenant.bulkIssue.courseId ? runs[tenant.runsDone] : undefined;
    if (!run) throw new Error(`fakeServer: no recorded bulk issue (left) for course ${courseId} of ${email}`);

    const body = { ...copy(run), idempotencyKey: key };
    const historyEntry = operationsAfter.find((operation) => operation.id === run.id);
    tenant.keys.set(key, { courseId, body });
    tenant.runsDone += 1;
    tenant.operations = [{ ...copy(historyEntry), idempotencyKey: key }, ...tenant.operations];
    tenant.rosters[courseId] = copy(rosterAfter);
    // Keep revocations made in this test when the newly issued certificates join the list.
    const known = new Map(tenant.certificates.map((certificate) => [certificate.id, certificate]));
    tenant.certificates = copy(certificatesAfter).map((certificate) => known.get(certificate.id) ?? certificate);
    return { body, replayed: false };
  }

  function route(request) {
    const { method, path, query } = request;
    if (method === 'GET' && path === '/api/actors') return json(200, recorded.actors);

    const tenant = tenantOf(request);
    const id = Number(/\/(\d+)(?:\/[a-z]+)?$/.exec(path)?.[1]);

    if (method === 'GET' && path === '/api/certificates') {
      const { rows, ...applied } = matchingCertificates(tenant, query);
      const page = Number(query.page ?? 1);
      const pageSize = Number(query.pageSize ?? 25);
      return json(200, {
        items: rows.slice((page - 1) * pageSize, page * pageSize),
        page,
        pageSize,
        total: rows.length,
        totalPages: Math.max(1, Math.ceil(rows.length / pageSize)),
        ...applied,
        tenant: tenantInfo[request.actor],
      });
    }
    if (method === 'GET' && path === '/api/certificates/export.csv') {
      matchingCertificates(tenant, query); // same validation as the list; the recorded file is sent as is
      return new Response(tenant.exportCsv.body, {
        status: 200,
        headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': tenant.exportCsv.contentDisposition },
      });
    }
    if (method === 'GET' && /^\/api\/certificates\/[^/]+$/.test(path)) {
      if (!tenant.details[id]) throw new HttpError(recorded.errors.notFound);
      return json(200, tenant.details[id]);
    }
    if (method === 'POST' && /^\/api\/certificates\/\d+\/revoke$/.test(path)) {
      return json(200, revoke(request.actor, id, request.body?.reason));
    }
    if (method === 'GET' && path === '/api/courses') return json(200, { items: tenant.courses });
    if (method === 'GET' && /^\/api\/courses\/\d+\/enrollments$/.test(path)) return json(200, tenant.rosters[id]);
    if (method === 'GET' && path === '/api/bulk-issues') return json(200, { items: tenant.operations });
    if (method === 'GET' && /^\/api\/bulk-issues\/\d+$/.test(path)) {
      const stored = [...tenant.keys.values()].find((entry) => entry.body.id === id);
      if (!stored) throw new HttpError({ status: 404, body: { error: { code: 'not_found', message: 'Bulk issue operation not found' } } });
      return json(200, stored.body);
    }
    if (method === 'POST' && path === '/api/bulk-issues') {
      const { body, replayed } = bulkIssue(request.actor, request.body.courseId, request.headers['idempotency-key']);
      return json(201, body, { 'Idempotent-Replayed': String(replayed) });
    }
    throw new HttpError({ status: 404, body: { error: { code: 'not_found', message: `No route for ${method} ${path}` } } });
  }

  function respondNormally(request) {
    try {
      return route(request);
    } catch (err) {
      if (err instanceof HttpError) return errorAnswer(err.answer);
      throw err;
    }
  }

  async function answer(request) {
    await null; // a real answer never arrives in the same tick as the request
    const override = overrides.find((entry) => entry.matches(request));
    if (!override) return respondNormally(request);
    if (override.once) overrides.splice(overrides.indexOf(override), 1);
    return override.handler(request, () => respondNormally(request));
  }

  async function fakeFetch(input, init = {}) {
    const url = new URL(String(input), 'http://localhost');
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]));
    const request = {
      method: (init.method ?? 'GET').toUpperCase(),
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      actor: headers['x-actor-email'] ?? null,
      headers,
      body: init.body === undefined ? undefined : JSON.parse(init.body),
      aborted: false,
    };
    requests.push(request);

    const { signal } = init;
    if (!signal) return answer(request);
    if (signal.aborted) {
      request.aborted = true;
      throw abortError();
    }
    // Like the real fetch: aborting rejects the pending call, whatever the server does meanwhile.
    return new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => {
        request.aborted = true;
        reject(abortError());
      });
      answer(request).then(resolve, reject);
    });
  }

  const matcher = (method, path) => (request) =>
    request.method === method && (path instanceof RegExp ? path.test(request.path) : request.path === path);

  function addOverride(method, path, handler, once) {
    const entry = { matches: matcher(method, path), handler, once };
    overrides.unshift(entry); // the newest override wins
    return () => {
      const index = overrides.indexOf(entry);
      if (index !== -1) overrides.splice(index, 1);
    };
  }

  vi.stubGlobal('fetch', fakeFetch);

  return {
    /** Every request so far, in order: { method, path, query, actor, headers, body, aborted }. */
    requests,
    /** The requests for one route, e.g. `server.sent('POST', '/api/bulk-issues')`. */
    sent: (method, path) => requests.filter(matcher(method, path)),
    /** Replaces the answer for a route until the returned function is called. */
    on: (method, path, handler) => addOverride(method, path, handler, false),
    /** Replaces the answer for the next matching request only. */
    once: (method, path, handler) => addOverride(method, path, handler, true),
    /** The mutable data of one tenant: certificates, details, courses, rosters, operations. */
    tenant: (email) => tenants[email],
    revoke,
    bulkIssue,
  };
}
