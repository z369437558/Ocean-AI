import { describe, expect, it, vi } from 'vitest';

import { ApiError, createApi, fetchActors, writeOutcome } from '../src/api.js';
import { captureDownloads } from './support/app.jsx';
import { ALICE, BOB, deferred, errorAnswer, json, networkError, recorded, startFakeServer, unreadableBody } from './support/fakeServer.js';

const failure = (promise) => promise.then(() => expect.unreachable('the call should have failed'), (error) => error);

describe('api.js: requests', () => {
  it('names the actor on every call and never sends a tenant', async () => {
    const server = startFakeServer();
    const api = createApi(BOB);
    await api.listCertificates({ q: 'lee', status: 'all', sort: 'issued', order: 'desc', page: 1, pageSize: 25 });
    await api.getCertificate(8);
    await api.listCourses();
    await api.getRoster(4, 1);
    await api.listOperations();
    await api.bulkIssue(4, 'key-1');
    await api.getOperation(3);
    await api.revokeCertificate(8, 'Issued in error');

    expect(server.requests.map((request) => request.actor)).toEqual(Array(8).fill(BOB));
    expect(server.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      'GET /api/certificates',
      'GET /api/certificates/8',
      'GET /api/courses',
      'GET /api/courses/4/enrollments',
      'GET /api/bulk-issues',
      'POST /api/bulk-issues',
      'GET /api/bulk-issues/3',
      'POST /api/certificates/8/revoke',
    ]);
    expect(JSON.stringify(server.requests)).not.toMatch(/tenant/i);
    expect(server.requests[5].headers['idempotency-key']).toBe('key-1');
  });

  it('leaves empty filters out of the query string', async () => {
    const server = startFakeServer();
    await createApi(ALICE).listCertificates({ q: '', status: 'all', sort: 'issued', order: 'desc', page: 1, pageSize: 25 });
    expect(server.requests[0].query).toEqual({ status: 'all', sort: 'issued', order: 'desc', page: '1', pageSize: '25' });
  });

  it('asks for the actor list without an actor', async () => {
    const server = startFakeServer();
    expect(await fetchActors()).toEqual(recorded.actors.items);
    expect(server.requests[0].actor).toBeNull();
  });

  it('reports whether a bulk issue was replayed', async () => {
    startFakeServer();
    const api = createApi(ALICE);
    const first = await api.bulkIssue(1, 'key-1');
    const again = await api.bulkIssue(1, 'key-1');
    expect(first.replayed).toBe(false);
    expect(again.replayed).toBe(true);
    expect(again.operation).toEqual(first.operation);
  });
});

describe('api.js: failures', () => {
  it('turns an error answer into an ApiError with the server\'s code and message', async () => {
    const server = startFakeServer();
    server.once('POST', '/api/bulk-issues', () => errorAnswer(recorded.errors.keyReused));
    const error = await failure(createApi(ALICE).bulkIssue(1, 'key-1'));
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409, code: 'idempotency_key_reused', details: { operationId: 1 }, retryable: false });
    expect(error.message).toContain('was already used for a different request');
  });

  it('copes with an error answer that is not JSON', async () => {
    const server = startFakeServer();
    server.once('GET', '/api/courses', () => new Response('<h1>Bad gateway</h1>', { status: 502 }));
    const error = await failure(createApi(ALICE).listCourses());
    expect(error).toMatchObject({ status: 502, code: 'http_error', message: 'The server answered with HTTP 502', retryable: true });
  });

  it('reports a request without an answer as status 0 / network_error', async () => {
    const server = startFakeServer();
    server.once('GET', '/api/courses', () => {
      throw networkError();
    });
    const error = await failure(createApi(ALICE).listCourses());
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 0, code: 'network_error', retryable: true });
  });

  it.each([
    ['truncated JSON', () => new Response('{"id":1,"status":"comp', { status: 201 })],
    ['a body that is not JSON', () => new Response('<html>ok</html>', { status: 201 })],
    ['a connection cut after the headers', () => unreadableBody(201)],
  ])('item B: a 2xx answer with %s becomes ApiError(0, network_error) - retryable, like a lost answer', async (_case, answer) => {
    const server = startFakeServer();
    server.once('POST', '/api/bulk-issues', answer);
    const error = await failure(createApi(ALICE).bulkIssue(1, 'key-1'));
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 0, code: 'network_error', retryable: true });
    expect(error.message).toBe('The answer from the server could not be read: the connection was interrupted or the response was incomplete.');
    expect(writeOutcome(error)).toBe('unknown');
  });

  it('item B: an abort while the body of a 2xx answer is being read still surfaces as an abort', async () => {
    const server = startFakeServer();
    const abort = new DOMException('The operation was aborted.', 'AbortError');
    server.once('GET', '/api/certificates', () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => {
        throw abort;
      },
    }));
    const error = await failure(createApi(ALICE).listCertificates({}, new AbortController().signal));
    expect(error).toBe(abort);
    expect(error).not.toBeInstanceOf(ApiError);
  });

  it('surfaces an aborted request as an AbortError', async () => {
    const server = startFakeServer();
    server.on('GET', '/api/certificates', () => new Promise(() => {})); // never answers
    const controller = new AbortController();
    const pending = failure(createApi(ALICE).listCertificates({}, controller.signal));
    controller.abort();
    expect((await pending).name).toBe('AbortError');
  });

  it.each([
    ['listCertificates', (api) => api.listCertificates({}), '/api/certificates'],
    ['getCertificate', (api) => api.getCertificate(1), '/api/certificates/1'],
    ['listCourses', (api) => api.listCourses(), '/api/courses'],
    ['getRoster', (api) => api.getRoster(1, 1), '/api/courses/1/enrollments'],
    ['listOperations', (api) => api.listOperations(), '/api/bulk-issues'],
    ['getOperation', (api) => api.getOperation(1), '/api/bulk-issues/1'],
  ])('item D: %s rejects a 200 answer of the wrong shape with ApiError(0, invalid_response)', async (_name, call, path) => {
    for (const body of [{ foo: 1 }, null, [], 'text', 42]) {
      const server = startFakeServer();
      server.once('GET', path, () => json(200, body));
      const error = await failure(call(createApi(ALICE)));
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({ status: 0, code: 'invalid_response', retryable: true });
    }
  });

  it.each([
    ['a roster whose course has no id', (api) => api.getRoster(1, 1), '/api/courses/1/enrollments', (body) => ({ ...body, course: { title: 'Safety 101' } })],
    ['the roster of another course', (api) => api.getRoster(1, 1), '/api/courses/1/enrollments', (body) => ({ ...body, course: { ...body.course, id: 2 } })],
    ['a roster whose course id is text', (api) => api.getRoster(1, 1), '/api/courses/1/enrollments', (body) => ({ ...body, course: { ...body.course, id: '1' } })],
    ['another operation', (api) => api.getOperation(1), '/api/bulk-issues/1', (body) => ({ ...body, id: 2 })],
    ['a course list whose ids are text', (api) => api.listCourses(), '/api/courses', (body) => ({ items: body.items.map((course) => ({ ...course, id: String(course.id) })) })],
  ])('item D: %s is rejected with ApiError(0, invalid_response): the pages could not use it', async (_case, call, path, spoil) => {
    const server = startFakeServer();
    server.bulkIssue(ALICE, 1, 'key-1');
    server.once('GET', path, async (_request, respond) => json(200, spoil(await respond().json())));
    const error = await failure(call(createApi(ALICE)));
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 0, code: 'invalid_response', retryable: true });
    await expect(call(createApi(ALICE))).resolves.toBeTruthy(); // the genuine answer is accepted
  });

  it('item D: an id may be asked for as a number or as text (a <select> hands out text)', async () => {
    const server = startFakeServer();
    server.bulkIssue(ALICE, 1, 'key-1');
    const api = createApi(ALICE);
    await expect(api.getRoster('1', 1)).resolves.toMatchObject({ course: { id: 1 } });
    await expect(api.getRoster(1, 1)).resolves.toMatchObject({ course: { id: 1 } });
    await expect(api.getOperation('1')).resolves.toMatchObject({ id: 1 });
  });

  it('item D: the writes check their answers too, and treat a wrong shape as an unknown outcome', async () => {
    const server = startFakeServer();
    server.once('POST', '/api/bulk-issues', () => json(201, { foo: 1 }));
    server.once('POST', '/api/certificates/4/revoke', () => json(200, null));
    const api = createApi(ALICE);
    expect(writeOutcome(await failure(api.bulkIssue(1, 'key-1')))).toBe('unknown');
    expect(writeOutcome(await failure(api.revokeCertificate(4)))).toBe('unknown');
  });

  it('item D: accepts every answer of the real backend (the shape checks reject nothing that was recorded)', async () => {
    const server = startFakeServer();
    server.on('GET', '/api/actors', () => json(200, recorded.actors));
    await expect(fetchActors()).resolves.toHaveLength(2);

    for (const actor of [ALICE, BOB]) {
      const api = createApi(actor);
      const tenant = recorded.tenants[actor];
      const { courseId, runs, rosterAfter, operationsAfter } = recorded.bulkIssues[actor];
      const answers = [
        [() => api.getRoster(courseId, 1), rosterAfter],
        [() => api.listOperations(), { items: operationsAfter }],
        ...Object.values(tenant.details).map((certificate) => [() => api.getCertificate(certificate.id), certificate]),
        ...Object.values(tenant.rosters).map((roster) => [() => api.getRoster(roster.course.id, 1), roster]),
        ...runs.map((operation) => [() => api.getOperation(operation.id), operation]),
        [() => api.revokeCertificate(4), recorded.revoke.response],
        [() => api.revokeCertificate(4), recorded.revoke.repeat],
      ];
      for (const [call, body] of answers) {
        server.once(body === recorded.revoke.response || body === recorded.revoke.repeat ? 'POST' : 'GET', /./, () => json(200, body));
        await expect(call()).resolves.toBeTruthy();
      }
      // list pages come out of the fake server built from the recorded rows
      await expect(api.listCertificates({ pageSize: 100 })).resolves.toMatchObject({ total: tenant.certificates.length });
    }
  });
});

describe('api.js: writeOutcome', () => {
  it.each([
    ['a 503 database_busy', new ApiError(503, 'database_busy', 'busy'), 'not_run'],
    ['a 400', new ApiError(400, 'invalid_request', 'bad'), 'rejected'],
    ['a 404', new ApiError(404, 'not_found', 'gone'), 'rejected'],
    ['a 409', new ApiError(409, 'idempotency_key_reused', 'reused'), 'rejected'],
    ['no answer', new ApiError(0, 'network_error', 'offline'), 'unknown'],
    ['an answer that was not understood', new ApiError(0, 'invalid_response', 'odd'), 'unknown'],
    ['a 500', new ApiError(500, 'internal_error', 'oops'), 'unknown'],
    ['a 502', new ApiError(502, 'http_error', 'gateway'), 'unknown'],
    ['another 503', new ApiError(503, 'http_error', 'unavailable'), 'unknown'],
    ['a TypeError', new TypeError('x is undefined'), 'unknown'],
    ['a thrown string', 'boom', 'unknown'],
  ])('classifies %s', (_case, error, outcome) => {
    expect(writeOutcome(error)).toBe(outcome);
  });
});

describe('api.js: exportCsv', () => {
  const params = { q: 'lee', status: 'all', sort: 'learner', order: 'asc' };

  it('saves the file under the name the server chose', async () => {
    const saved = captureDownloads();
    const server = startFakeServer();
    const result = await createApi(ALICE).exportCsv(params);
    expect(server.requests[0].query).toEqual({ q: 'lee', status: 'all', sort: 'learner', order: 'asc' });
    expect(saved.map((file) => file.fileName)).toEqual([result.fileName]);
    expect(result.fileName).toMatch(/^certificates-east-\d{8}-\d{4}\.csv$/);
    expect(result.bytes).toBe(new TextEncoder().encode(recorded.tenants[ALICE].exportCsv.body).length);
    expect(document.querySelector('a[download]')).toBeNull(); // the helper link is removed again
  });

  it('item G: passes the signal on, so aborting cancels the download', async () => {
    const saved = captureDownloads();
    const server = startFakeServer();
    const gate = deferred();
    server.on('GET', '/api/certificates/export.csv', async (_request, respond) => {
      await gate.promise;
      return respond();
    });
    const controller = new AbortController();
    const pending = failure(createApi(ALICE).exportCsv(params, controller.signal));
    await vi.waitFor(() => expect(server.requests).toHaveLength(1));
    controller.abort();

    expect((await pending).name).toBe('AbortError');
    expect(server.requests[0].aborted).toBe(true);
    gate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(saved).toEqual([]);
  });

  it('item G: saves nothing when the abort comes after the file has arrived', async () => {
    const saved = captureDownloads();
    startFakeServer();
    const controller = new AbortController();
    const body = deferred();
    // A network layer that no longer reacts to the signal: the answer is complete, only the body
    // is handed over a moment later - after the page that asked for it has gone away.
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'Content-Disposition': recorded.tenants[ALICE].exportCsv.contentDisposition }),
      blob: () => body.promise,
    }));
    const pending = failure(createApi(ALICE).exportCsv(params, controller.signal));
    controller.abort();
    body.resolve(new Blob([recorded.tenants[ALICE].exportCsv.body]));

    expect((await pending).name).toBe('AbortError');
    expect(saved).toEqual([]);
  });

  it('item B: reports a download that breaks off as ApiError(0, network_error)', async () => {
    const saved = captureDownloads();
    const server = startFakeServer();
    server.once('GET', '/api/certificates/export.csv', () => unreadableBody(200));
    const error = await failure(createApi(ALICE).exportCsv(params));
    expect(error).toMatchObject({ status: 0, code: 'network_error' });
    expect(saved).toEqual([]);
  });
});
