/**
 * The tests are only as good as their stand-ins. These checks tie the fake server to the answers
 * recorded from the real backend, and make sure the console guard of test/setup.js works.
 */
import { describe, expect, it } from 'vitest';

import { consoleGuard, expectConsoleError } from './support/console.js';
import { ALICE, BOB, recorded, startFakeServer } from './support/fakeServer.js';

const call = async (actor, method, path, { body, key } = {}) => {
  const headers = { 'X-Actor-Email': actor };
  if (key) headers['Idempotency-Key'] = key;
  const response = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, replayed: response.headers.get('Idempotent-Replayed'), body: await response.json() };
};

describe('fakeServer answers like the recorded backend', () => {
  it('orders the default list like the export the backend produced (newest first, ties by instant)', async () => {
    startFakeServer();
    for (const actor of [ALICE, BOB]) {
      const { body } = await call(actor, 'GET', '/api/certificates');
      const exportedSerials = recorded.tenants[actor].exportCsv.body.trim().split('\n').slice(1).map((line) => line.split(',')[2]);
      expect(body.items.map((certificate) => certificate.serialNumber)).toEqual(exportedSerials);
      expect(body).toMatchObject({ page: 1, pageSize: 25, total: exportedSerials.length, totalPages: 1, sort: 'issued', order: 'desc' });
    }
  });

  it('rejects control characters in the search like the backend', async () => {
    startFakeServer();
    expect(await call(ALICE, 'GET', '/api/certificates?q=Alex%09Lee')).toMatchObject(recorded.errors.invalidSearch);
    expect((await call(ALICE, 'GET', '/api/certificates?q=%20lee%20')).body.total).toBe(1); // surrounding spaces are trimmed
  });

  it('hides the other tenant: its ids do not exist', async () => {
    startFakeServer();
    expect(await call(ALICE, 'GET', '/api/certificates/8')).toMatchObject(recorded.errors.notFound);
    expect((await call(BOB, 'GET', '/api/certificates/8')).status).toBe(200);
    expect((await call('mallory@nowhere.test', 'GET', '/api/certificates')).status).toBe(401);
  });

  it('revokes exactly like the recorded revocation, and is idempotent', async () => {
    const server = startFakeServer();
    const { certificateId, response, repeat } = recorded.revoke;
    const path = `/api/certificates/${certificateId}/revoke`;
    expect((await call(ALICE, 'POST', path, { body: { reason: response.revocationReason } })).body).toEqual(response);
    expect((await call(ALICE, 'POST', path, { body: {} })).body).toEqual(repeat);
    expect((await call(ALICE, 'GET', `/api/certificates/${certificateId}`)).body).toEqual({ ...response, alreadyRevoked: undefined });
    expect(server.tenant(ALICE).certificates.find((certificate) => certificate.id === certificateId).status).toBe('revoked');
  });

  it('executes a bulk issue once per key, replays it, and refuses the key for another request', async () => {
    startFakeServer();
    const { courseId, runs, rosterAfter, operationsAfter } = recorded.bulkIssues[ALICE];
    const first = await call(ALICE, 'POST', '/api/bulk-issues', { body: { courseId }, key: 'k1' });
    expect(first).toEqual({ status: 201, replayed: 'false', body: { ...runs[0], idempotencyKey: 'k1' } });
    expect(await call(ALICE, 'POST', '/api/bulk-issues', { body: { courseId }, key: 'k1' })).toEqual({ ...first, replayed: 'true' });
    expect(await call(ALICE, 'POST', '/api/bulk-issues', { body: { courseId: 2 }, key: 'k1' })).toMatchObject(recorded.errors.keyReused);

    expect((await call(ALICE, 'GET', `/api/courses/${courseId}/enrollments`)).body).toEqual(rosterAfter);
    expect((await call(ALICE, 'GET', '/api/bulk-issues/1')).body).toEqual(first.body);
    const second = await call(ALICE, 'POST', '/api/bulk-issues', { body: { courseId }, key: 'k2' });
    expect(second.body.summary).toEqual(runs[1].summary);
    expect((await call(ALICE, 'GET', '/api/bulk-issues')).body.items).toEqual(
      operationsAfter.map((operation) => ({ ...operation, idempotencyKey: operation.id === 1 ? 'k1' : 'k2' })),
    );
    expect((await call(BOB, 'GET', '/api/bulk-issues')).body.items).toEqual([]); // nothing of this in the other tenant
  });
});

describe('console guard', () => {
  it('collects console.error and console.warn output, except what a test announced', () => {
    expectConsoleError(/^expected:/);
    console.error('expected: this one was announced');
    console.error('unexpected problem', new TypeError('boom'));
    console.warn('unexpected warning');
    expect(consoleGuard.finish()).toEqual(['unexpected problem TypeError: boom', 'unexpected warning']);
    consoleGuard.start(); // what this test provoked on purpose must not fail it
  });
});
