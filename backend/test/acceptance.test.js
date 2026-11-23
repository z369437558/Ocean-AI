/**
 * Acceptance tests A1-A5 and A7 (A6 lives in scale.test.js). Each suite gets its own freshly seeded
 * database and server process, so suites are independent and can run in any order.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { createApp } from '../src/app.js';
import { openInitializedDatabase } from '../src/bootstrap.js';
import { openDatabase } from '../src/db/sqlite.js';
import { issueCertificate } from '../src/services/ledger.js';
import {
  ALICE,
  BOB,
  SEED,
  clientFor,
  countRows,
  createTempDir,
  nocaseCompare,
  parseCsv,
  removeTempDir,
  runScript,
  runScriptToExit,
  runServerToExit,
  startFreshServer,
  startServer,
  stillPending,
  timed,
} from './helpers.js';

const EAST = 1;
const WEST = 2;

/** Certificates and issuance audit events per learner for one course, straight from the database. */
function issuanceLedger(db, courseId) {
  return db
    .all(
      `SELECT e.learner_id,
              (SELECT COUNT(*) FROM certificates c WHERE c.course_id = e.course_id AND c.learner_id = e.learner_id) AS certificates,
              (SELECT COUNT(*) FROM audit_events a
                 JOIN certificates c ON c.id = a.certificate_id
                WHERE c.course_id = e.course_id AND c.learner_id = e.learner_id AND a.action = 'certificate.issued') AS issued_events
         FROM enrollments e WHERE e.course_id = @courseId ORDER BY e.learner_id`,
      { courseId },
    )
    .map((row) => ({ ...row }));
}

describe('actor context', () => {
  let ctx;
  before(async () => {
    ctx = await startFreshServer();
  });
  after(() => ctx.close());

  it('lists the seeded admins for the actor switcher', async () => {
    const res = await clientFor(ctx.baseUrl, null).get('/api/actors');
    assert.equal(res.status, 200);
    assert.deepEqual(
      res.json.items.map((a) => [a.email, a.tenant.name, a.tenant.timezone]),
      [
        [ALICE, 'East', 'Australia/Sydney'],
        [BOB, 'West', 'Australia/Perth'],
      ],
    );
  });

  it('rejects requests without a known actor', async () => {
    for (const urlPath of ['/api/certificates', '/api/certificates/1', '/api/certificates/export.csv', '/api/courses', '/api/me']) {
      const anonymous = await clientFor(ctx.baseUrl, null).get(urlPath);
      assert.equal(anonymous.status, 401, urlPath);
      assert.equal(anonymous.json.error.code, 'actor_required');
      const stranger = await clientFor(ctx.baseUrl, 'mallory@nowhere.test').get(urlPath);
      assert.equal(stranger.status, 401, urlPath);
      assert.equal(stranger.json.error.code, 'unknown_actor');
    }
    const anonymousIssue = await clientFor(ctx.baseUrl, null).bulkIssue(SEED.east.safety101, 'anon-key');
    assert.equal(anonymousIssue.status, 401);
  });

  it('binds each admin to their own tenant and matches e-mail case-insensitively', async () => {
    const alice = await clientFor(ctx.baseUrl, 'Alice@East.TEST').get('/api/me');
    assert.equal(alice.status, 200);
    assert.deepEqual(alice.json.tenant, { id: EAST, name: 'East', code: 'EAST', timezone: 'Australia/Sydney' });
    const bob = await clientFor(ctx.baseUrl, BOB).get('/api/me');
    assert.deepEqual(bob.json.tenant, { id: WEST, name: 'West', code: 'WEST', timezone: 'Australia/Perth' });
  });
});

describe('A1 - tenant isolation', () => {
  let ctx;
  let db;
  let alice;
  let bob;
  before(async () => {
    ctx = await startFreshServer();
    db = ctx.openDb();
    alice = clientFor(ctx.baseUrl, ALICE);
    bob = clientFor(ctx.baseUrl, BOB);
  });
  after(async () => {
    db.close();
    await ctx.close();
  });

  it('list: each admin sees only their own tenant, whatever the query says', async () => {
    const east = await alice.get('/api/certificates?pageSize=100');
    assert.equal(east.json.total, SEED.east.certificateCount);
    assert.ok(east.json.items.every((c) => c.serialNumber.startsWith('EAST-')));

    for (const query of ['', '&tenant=East', '&tenantId=1', '&tenant_id=1', '&q=EAST', '&q=Alex%20Lee']) {
      const west = await bob.get(`/api/certificates?pageSize=100${query}`);
      assert.equal(west.status, 200, query);
      assert.ok(west.json.items.every((c) => c.serialNumber.startsWith('WEST-')), `leak with "${query}"`);
      assert.equal(west.json.tenant.name, 'West');
    }
    assert.equal((await bob.get('/api/certificates?pageSize=100')).json.total, SEED.west.certificateCount);
    assert.equal((await bob.get('/api/certificates?q=EAST')).json.total, 0);

    // Both tenants have an "Alex Lee"; each admin finds only their own.
    const westAlex = await bob.get('/api/certificates?q=Alex%20Lee');
    assert.deepEqual(westAlex.json.items.map((c) => c.id), [SEED.west.alexLeeCertificate]);
    const eastAlex = await alice.get('/api/certificates?q=Alex%20Lee');
    assert.deepEqual(eastAlex.json.items.map((c) => c.id), [SEED.east.alexLeeCertificate]);
  });

  it('detail: another tenant\'s certificate is a 404, indistinguishable from a missing one', async () => {
    const crossTenant = await bob.get(`/api/certificates/${SEED.east.alexLeeCertificate}`);
    const missing = await bob.get('/api/certificates/999999');
    assert.equal(crossTenant.status, 404);
    assert.equal(missing.status, 404);
    assert.deepEqual(crossTenant.json, missing.json);
    assert.ok(!crossTenant.text.includes('EAST'));

    assert.equal((await alice.get(`/api/certificates/${SEED.west.alexLeeCertificate}`)).status, 404);
    assert.equal((await alice.get(`/api/certificates/${SEED.east.alexLeeCertificate}`)).status, 200);
    assert.equal((await bob.get(`/api/certificates/${SEED.west.alexLeeCertificate}`)).status, 200);
  });

  it('bulk issue: another tenant\'s course is rejected and nothing is written', async () => {
    const beforeCounts = countRows(db);
    const eastLedger = issuanceLedger(db, SEED.east.safety101);

    for (const key of [undefined, 'bob-cross-tenant-1']) {
      const res = await bob.bulkIssue(SEED.east.safety101, key);
      assert.equal(res.status, 404);
      assert.equal(res.json.error.code, 'not_found');
      assert.ok(!res.text.includes('Safety 101'), 'response must not describe the foreign course');
    }
    // Retrying the rejected request does not change the answer either.
    assert.equal((await bob.bulkIssue(SEED.east.safety101, 'bob-cross-tenant-1')).status, 404);

    assert.deepEqual(countRows(db), beforeCounts, 'no certificates, audit events or operations were created');
    assert.deepEqual(issuanceLedger(db, SEED.east.safety101), eastLedger);
    assert.equal((await bob.get(`/api/courses/${SEED.east.safety101}/enrollments`)).status, 404);
  });

  it('export: contains only the caller\'s tenant', async () => {
    const west = await bob.get('/api/certificates/export.csv?q=&tenant=East&tenantId=1');
    assert.equal(west.status, 200);
    const rows = parseCsv(west.text);
    assert.equal(rows.length - 1, SEED.west.certificateCount);
    assert.ok(rows.slice(1).every((r) => r[2].startsWith('WEST-')));
    assert.ok(!west.text.includes('EAST-'));

    assert.equal(parseCsv((await bob.get('/api/certificates/export.csv?q=EAST-')).text).length, 1, 'header only');
    const alex = parseCsv((await bob.get('/api/certificates/export.csv?q=Alex%20Lee')).text);
    assert.deepEqual(alex.slice(1), [['Alex Lee', 'Safety 101', 'WEST-0000001', '2026-01-10 21:30']]);
  });

  it('revoke: another tenant\'s certificate is a 404 and stays untouched', async () => {
    const beforeCounts = countRows(db);
    const res = await bob.post(`/api/certificates/${SEED.east.alexLeeCertificate}/revoke`, { reason: 'not mine' });
    assert.equal(res.status, 404);
    assert.deepEqual(countRows(db), beforeCounts);
    assert.equal((await alice.get(`/api/certificates/${SEED.east.alexLeeCertificate}`)).json.status, 'active');
  });

  it('operations, audit trail and courses are tenant-scoped too', async () => {
    const operation = await alice.bulkIssue(SEED.east.forklift, 'alice-isolation-1');
    assert.equal(operation.status, 201);

    assert.equal((await bob.get(`/api/bulk-issues/${operation.json.id}`)).status, 404);
    assert.deepEqual((await bob.get('/api/bulk-issues')).json.items, []);
    assert.equal((await alice.get(`/api/bulk-issues/${operation.json.id}`)).status, 200);

    const westAudit = await bob.get('/api/audit-events?pageSize=100');
    assert.ok(westAudit.json.total > 0);
    const westCertificateIds = new Set((await bob.get('/api/certificates?pageSize=100')).json.items.map((c) => c.id));
    assert.ok(westAudit.json.items.every((e) => westCertificateIds.has(e.certificateId) && e.actorEmail === BOB));
    assert.equal((await bob.get(`/api/audit-events?certificateId=${SEED.east.alexLeeCertificate}`)).json.total, 0);

    const westCourses = (await bob.get('/api/courses')).json.items.map((c) => c.id).sort();
    assert.deepEqual(westCourses, [SEED.west.safety101, SEED.west.heights, SEED.west.manualHandling]);
  });

  it('idempotency keys are scoped to the actor: Bob can neither replay nor block Alice\'s key', async () => {
    const key = 'shared-key-123';
    const first = await alice.bulkIssue(SEED.east.safety101, key);
    assert.equal(first.status, 201);
    const westBefore = countRows(db, WEST);

    // Same key + same body from Bob: not a replay of Alice's response, just "no such course".
    const crossTenant = await bob.bulkIssue(SEED.east.safety101, key);
    assert.equal(crossTenant.status, 404);
    assert.deepEqual(countRows(db, WEST), westBefore);

    // The key is still free for Bob's own work...
    const own = await bob.bulkIssue(SEED.west.safety101, key);
    assert.equal(own.status, 201);
    assert.equal(own.json.tenant.name, 'West');
    assert.ok(own.json.results.every((r) => !String(r.serialNumber ?? 'WEST-').startsWith('EAST-')));
    // ...and Alice's replay still returns her original result.
    const replay = await alice.bulkIssue(SEED.east.safety101, key);
    assert.equal(replay.text, first.text);
  });
});

describe('A2 - retry safety / idempotency', () => {
  describe('sequential retries', () => {
    let ctx;
    let db;
    let alice;
    before(async () => {
      ctx = await startFreshServer();
      db = ctx.openDb();
      alice = clientFor(ctx.baseUrl, ALICE);
    });
    after(async () => {
      db.close();
      await ctx.close();
    });

    it('executes once and replays the stored outcome', async () => {
      const before = countRows(db, EAST);
      const first = await alice.bulkIssue(SEED.east.safety101, 'retry-seq-1');
      assert.equal(first.status, 201);
      assert.equal(first.headers.get('idempotent-replayed'), 'false');
      assert.equal(first.json.summary.issued, 2);
      const afterFirst = countRows(db, EAST);
      assert.deepEqual(afterFirst, {
        certificates: before.certificates + 2,
        auditEvents: before.auditEvents + 2,
        operations: before.operations + 1,
      });

      for (let attempt = 0; attempt < 3; attempt += 1) {
        const retry = await alice.bulkIssue(SEED.east.safety101, 'retry-seq-1');
        assert.equal(retry.status, first.status);
        assert.equal(retry.headers.get('idempotent-replayed'), 'true');
        assert.equal(retry.text, first.text, 'replay is byte-identical');
        assert.equal(retry.headers.get('location'), first.headers.get('location'));
      }
      assert.deepEqual(countRows(db, EAST), afterFirst, 'retries wrote nothing');
      assert.ok(issuanceLedger(db, SEED.east.safety101).every((l) => l.certificates <= 1 && l.issued_events === l.certificates));
    });

    it('keeps returning the original outcome even after the data moved on', async () => {
      const original = await alice.bulkIssue(SEED.east.safety101, 'retry-seq-1');
      const issued = original.json.results.find((r) => r.outcome === 'issued');
      assert.equal((await alice.post(`/api/certificates/${issued.certificateId}/revoke`, {})).status, 200);

      const replay = await alice.bulkIssue(SEED.east.safety101, 'retry-seq-1');
      assert.equal(replay.text, original.text);
      assert.equal((await alice.get(`/api/bulk-issues/${original.json.id}`)).text, original.text);
    });

    it('without a key a repeat is a new operation, but still cannot issue twice', async () => {
      const before = countRows(db, EAST);
      const repeat = await alice.bulkIssue(SEED.east.safety101);
      assert.equal(repeat.status, 201);
      assert.equal(repeat.json.idempotencyKey, null);
      assert.deepEqual(repeat.json.summary, { total: 5, issued: 0, skipped: 5, failed: 0 });
      assert.deepEqual(countRows(db, EAST), { ...before, operations: before.operations + 1 });
    });

    it('rejects malformed idempotency keys', async () => {
      for (const key of ['has space', 'x'.repeat(201), 'tab\tkey']) {
        const res = await alice.bulkIssue(SEED.east.firstAid, key);
        assert.equal(res.status, 400, JSON.stringify(key));
      }
      assert.equal((await alice.get(`/api/courses/${SEED.east.firstAid}/enrollments`)).json.summary.eligible, 1);
    });
  });

  describe('concurrent identical requests', () => {
    let ctx;
    let db;
    before(async () => {
      ctx = await startFreshServer();
      db = ctx.openDb();
    });
    after(async () => {
      db.close();
      await ctx.close();
    });

    it('25 simultaneous requests are one logical operation with one shared outcome', async () => {
      const alice = clientFor(ctx.baseUrl, ALICE);
      const before = countRows(db, EAST);

      const responses = await Promise.all(
        Array.from({ length: 25 }, () => alice.bulkIssue(SEED.east.safety101, 'concurrent-1')),
      );

      assert.deepEqual([...new Set(responses.map((r) => r.status))], [201]);
      assert.equal(new Set(responses.map((r) => r.text)).size, 1, 'every caller received the same body');
      assert.equal(responses.filter((r) => r.headers.get('idempotent-replayed') === 'false').length, 1, 'executed exactly once');

      const outcome = responses[0].json;
      assert.deepEqual(outcome.summary, { total: 5, issued: 2, skipped: 3, failed: 0 });
      assert.deepEqual(countRows(db, EAST), {
        certificates: before.certificates + 2,
        auditEvents: before.auditEvents + 2,
        operations: before.operations + 1,
      });
      for (const learner of issuanceLedger(db, SEED.east.safety101)) {
        assert.ok(learner.certificates <= 1, `learner ${learner.learner_id} has ${learner.certificates} certificates`);
        assert.equal(learner.issued_events, learner.certificates);
      }
      for (const result of outcome.results.filter((r) => r.outcome === 'issued')) {
        const detail = await alice.get(`/api/certificates/${result.certificateId}`);
        assert.equal(detail.json.auditEvents.filter((e) => e.action === 'certificate.issued').length, 1);
      }
    });

    it('holds across processes: two servers sharing the database still execute once', async () => {
      const second = await startServer(ctx.dbPath);
      try {
        const before = countRows(db, WEST);
        const clients = [clientFor(ctx.baseUrl, BOB), clientFor(second.baseUrl, BOB)];
        const responses = await Promise.all(
          Array.from({ length: 20 }, (_, i) => clients[i % 2].bulkIssue(SEED.west.safety101, 'concurrent-2')),
        );

        assert.deepEqual([...new Set(responses.map((r) => r.status))], [201]);
        assert.equal(new Set(responses.map((r) => r.text)).size, 1);
        assert.equal(responses.filter((r) => r.headers.get('idempotent-replayed') === 'false').length, 1);
        assert.deepEqual(countRows(db, WEST), {
          certificates: before.certificates + 2,
          auditEvents: before.auditEvents + 2,
          operations: before.operations + 1,
        });
        assert.ok(issuanceLedger(db, SEED.west.safety101).every((l) => l.certificates <= 1 && l.issued_events === l.certificates));
      } finally {
        await second.stop();
      }
    });

    it('different keys racing for the same course still issue each certificate once', async () => {
      const alice = clientFor(ctx.baseUrl, ALICE);
      const responses = await Promise.all(
        Array.from({ length: 10 }, (_, i) => alice.bulkIssue(SEED.east.firstAid, `race-${i}`)),
      );
      assert.ok(responses.every((r) => r.status === 201));
      assert.equal(responses.reduce((sum, r) => sum + r.json.summary.issued, 0), 1, 'the one eligible learner was issued once in total');
      assert.ok(issuanceLedger(db, SEED.east.firstAid).every((l) => l.certificates <= 1 && l.issued_events === l.certificates));
    });
  });
});

describe('A2 - while another process holds the database write lock', () => {
  // `locker` plays another process in the middle of a long write (the load-test generator, a
  // reset, ...). While it holds the lock no request can write, which makes "these two requests
  // overlap" a certainty instead of a matter of timing.
  let ctx;
  let second;
  let db;
  let locker;
  let servers;
  const PROMPT_MS = 1500;

  before(async () => {
    ctx = await startFreshServer();
    second = await startServer(ctx.dbPath);
    db = ctx.openDb();
    locker = ctx.openDb();
    servers = [ctx.baseUrl, second.baseUrl];
  });
  after(async () => {
    locker.close(); // rolls back if a failed test left the lock behind
    db.close();
    await second.stop();
    await ctx.close();
  });

  /** Runs `fn` while the write lock is held; `release()` gives it up early (with a COMMIT). */
  async function whileLocked(fn) {
    locker.exec('BEGIN IMMEDIATE');
    let held = true;
    const release = () => {
      if (held) locker.exec('COMMIT');
      held = false;
    };
    try {
      return await fn(release);
    } finally {
      if (held) locker.exec('ROLLBACK');
    }
  }

  async function assertReadsAreServed(label) {
    for (const baseUrl of servers) {
      const list = await timed(() => clientFor(baseUrl, BOB).get('/api/certificates?pageSize=5'));
      assert.equal(list.value.status, 200);
      assert.ok(list.ms < PROMPT_MS, `${label}: list took ${Math.round(list.ms)} ms on ${baseUrl}`);
    }
  }

  it('identical requests to two servers overlap for certain and still execute exactly once', async () => {
    const before = countRows(db, WEST);

    const responses = await whileLocked(async (release) => {
      const requests = servers.map((baseUrl) => clientFor(baseUrl, BOB).bulkIssue(SEED.west.safety101, 'overlap-1'));
      // Neither request can finish while the lock is held, so from here on both are in flight...
      assert.equal(await stillPending(Promise.race(requests), 400), true, 'both requests wait for the lock');
      // ...and neither server is frozen by its waiting request.
      await assertReadsAreServed('while a bulk issue waits');
      assert.deepEqual(countRows(db, WEST), before, 'nothing is written before the lock is free');
      assert.equal(await stillPending(Promise.race(requests), 50), true);

      release();
      return Promise.all(requests);
    });

    assert.deepEqual(responses.map((r) => r.status), [201, 201]);
    assert.equal(responses[0].text, responses[1].text, 'both callers received the same outcome');
    assert.deepEqual(responses.map((r) => r.headers.get('idempotent-replayed')).sort(), ['false', 'true'], 'one execution, one replay');
    assert.deepEqual(responses[0].json.summary, { total: 5, issued: 2, skipped: 3, failed: 0 });
    assert.deepEqual(countRows(db, WEST), {
      certificates: before.certificates + 2,
      auditEvents: before.auditEvents + 2,
      operations: before.operations + 1,
    });
    assert.ok(issuanceLedger(db, SEED.west.safety101).every((l) => l.certificates <= 1 && l.issued_events === l.certificates));
  });

  it('one key with two payloads on two servers: one executes, the other is a 409', async () => {
    const before = countRows(db, WEST);
    const responses = await whileLocked(async (release) => {
      const requests = [
        clientFor(servers[0], BOB).bulkIssue(SEED.west.heights, 'overlap-2'),
        clientFor(servers[1], BOB).bulkIssue(SEED.west.manualHandling, 'overlap-2'),
      ];
      assert.equal(await stillPending(Promise.race(requests), 400), true);
      release();
      return Promise.all(requests);
    });

    assert.deepEqual(responses.map((r) => r.status).sort(), [201, 409]);
    const winner = responses.find((r) => r.status === 201);
    const loser = responses.find((r) => r.status === 409);
    assert.equal(loser.json.error.code, 'idempotency_key_reused');
    assert.equal(loser.json.error.details.operationId, winner.json.id);
    assert.deepEqual(countRows(db, WEST), {
      certificates: before.certificates + winner.json.summary.issued,
      auditEvents: before.auditEvents + winner.json.summary.issued,
      operations: before.operations + 1,
    });
    // The stored result belongs to the winner and is what every later retry of it gets.
    const retry = await clientFor(servers[1], BOB).bulkIssue(winner.json.course.id, 'overlap-2');
    assert.equal(retry.text, winner.text);
  });

  it('a key that already ran needs no lock: replays, conflicts and rejections are answered at once', async () => {
    const alice = clientFor(ctx.baseUrl, ALICE);
    const original = await alice.bulkIssue(SEED.east.safety101, 'stored-1');
    assert.equal(original.status, 201);
    const settled = countRows(db);

    await whileLocked(async () => {
      const prompt = async (label, send) => {
        const res = await timed(send);
        assert.ok(res.ms < PROMPT_MS, `${label} took ${Math.round(res.ms)} ms`);
        return res.value;
      };
      for (const baseUrl of servers) {
        const client = clientFor(baseUrl, ALICE);
        const replay = await prompt('replay', () => client.bulkIssue(SEED.east.safety101, 'stored-1'));
        assert.equal(replay.status, 201);
        assert.equal(replay.headers.get('idempotent-replayed'), 'true');
        assert.equal(replay.text, original.text);

        const conflict = await prompt('conflict', () => client.bulkIssue(SEED.east.firstAid, 'stored-1'));
        assert.equal(conflict.status, 409);

        const garbled = await prompt('unreadable body', () =>
          client.post('/api/bulk-issues', undefined, { rawBody: '{"courseId":', headers: { 'Idempotency-Key': 'stored-1' } }),
        );
        assert.equal(garbled.status, 409);

        // Requests that are wrong on their face do not queue for the lock either.
        assert.equal((await prompt('unknown course', () => client.bulkIssue(999999, 'fresh-1'))).status, 404);
        assert.equal((await prompt("another tenant's course", () => client.bulkIssue(SEED.west.safety101, 'fresh-1'))).status, 404);
        assert.equal((await prompt('invalid body', () => client.post('/api/bulk-issues', {}, { headers: { 'Idempotency-Key': 'fresh-1' } }))).status, 400);

        const repeatRevoke = await prompt('repeat revoke', () => client.post(`/api/certificates/${SEED.east.revokedCertificate}/revoke`, {}));
        assert.equal(repeatRevoke.status, 200);
        assert.equal(repeatRevoke.json.alreadyRevoked, true);
        assert.equal((await prompt('revoke of a missing certificate', () => client.post('/api/certificates/999999/revoke', {}))).status, 404);
      }
    });
    assert.deepEqual(countRows(db), settled, 'none of it wrote anything');
  });

  it('a new revocation waits for the lock, then takes effect once', async () => {
    const id = SEED.west.alexLeeCertificate;
    const before = countRows(db, WEST);
    const responses = await whileLocked(async (release) => {
      const requests = servers.map((baseUrl) => clientFor(baseUrl, BOB).post(`/api/certificates/${id}/revoke`, { reason: 'Lock test' }));
      assert.equal(await stillPending(Promise.race(requests), 400), true, 'both revocations wait for the lock');
      await assertReadsAreServed('while a revocation waits');
      assert.equal((await clientFor(ctx.baseUrl, BOB).get(`/api/certificates/${id}`)).json.status, 'active');
      release();
      return Promise.all(requests);
    });

    assert.deepEqual(responses.map((r) => r.status), [200, 200]);
    assert.deepEqual(responses.map((r) => r.json.alreadyRevoked).sort(), [false, true]);
    assert.equal(responses[0].json.revokedAt, responses[1].json.revokedAt);
    assert.deepEqual(countRows(db, WEST), { ...before, auditEvents: before.auditEvents + 1 });
  });

  it('answers 503 with Retry-After when the lock is not released in time, and the retry then runs', async () => {
    const impatient = await startServer(ctx.dbPath, { env: { DB_BUSY_TIMEOUT_MS: '300' } });
    try {
      const alice = clientFor(impatient.baseUrl, ALICE);
      const before = countRows(db, EAST);
      const activeCertificate = 5;

      await whileLocked(async () => {
        for (const [label, send] of [
          ['bulk issue', () => alice.bulkIssue(SEED.east.firstAid, 'busy-1')],
          ['revoke', () => alice.post(`/api/certificates/${activeCertificate}/revoke`, { reason: 'busy' })],
        ]) {
          const res = await timed(send);
          assert.equal(res.value.status, 503, label);
          assert.equal(res.value.json.error.code, 'database_busy', label);
          assert.equal(res.value.headers.get('retry-after'), '1', label);
          assert.ok(res.ms >= 250 && res.ms < 5000, `${label} gave up after ${Math.round(res.ms)} ms`);
        }
        assert.equal((await alice.get('/api/certificates?pageSize=5')).status, 200, 'reads are unaffected');
      });
      assert.deepEqual(countRows(db, EAST), before, 'a 503 wrote nothing');

      // The 503 did not burn the key: the retry is the first (and only) execution.
      const retry = await alice.bulkIssue(SEED.east.firstAid, 'busy-1');
      assert.equal(retry.status, 201);
      assert.equal(retry.headers.get('idempotent-replayed'), 'false');
      assert.equal(retry.json.summary.issued, 1);
      const revoked = await alice.post(`/api/certificates/${activeCertificate}/revoke`, { reason: 'busy' });
      assert.equal(revoked.status, 200);
      assert.equal(revoked.json.alreadyRevoked, false);
    } finally {
      await impatient.stop();
    }
  });
});

describe('A3 - idempotency key misuse', () => {
  let ctx;
  let db;
  let alice;
  before(async () => {
    ctx = await startFreshServer();
    db = ctx.openDb();
    alice = clientFor(ctx.baseUrl, ALICE);
  });
  after(async () => {
    db.close();
    await ctx.close();
  });

  it('same key with a different course is a 409 and executes nothing', async () => {
    const first = await alice.bulkIssue(SEED.east.safety101, 'misuse-1');
    assert.equal(first.status, 201);
    const settled = countRows(db);
    const firstAidLedger = issuanceLedger(db, SEED.east.firstAid);

    const conflict = await alice.bulkIssue(SEED.east.firstAid, 'misuse-1');
    assert.equal(conflict.status, 409);
    assert.equal(conflict.json.error.code, 'idempotency_key_reused');
    assert.equal(conflict.headers.get('idempotent-replayed'), null);

    assert.deepEqual(countRows(db), settled, 'no second operation ran');
    assert.deepEqual(issuanceLedger(db, SEED.east.firstAid), firstAidLedger, 'the other course is untouched');

    // The first result was not overwritten: the honest retry still gets it back verbatim.
    const replay = await alice.bulkIssue(SEED.east.safety101, 'misuse-1');
    assert.equal(replay.status, 201);
    assert.equal(replay.text, first.text);
    assert.equal((await alice.get(`/api/bulk-issues/${first.json.id}`)).text, first.text);
  });

  it('same key with a changed payload is a 409 as well', async () => {
    const settled = countRows(db);
    for (const body of [
      { courseId: SEED.east.safety101, note: 'changed payload' },
      { courseId: String(SEED.east.safety101) },
      { courseId: 999999 },
      {},
    ]) {
      const res = await alice.post('/api/bulk-issues', body, { headers: { 'Idempotency-Key': 'misuse-1' } });
      assert.equal(res.status, 409, JSON.stringify(body));
      assert.equal(res.json.error.code, 'idempotency_key_reused');
    }
    assert.deepEqual(countRows(db), settled);
  });

  it('key order and formatting of the JSON body do not count as a different payload', async () => {
    const key = 'misuse-format';
    const first = await alice.post('/api/bulk-issues', undefined, {
      headers: { 'Idempotency-Key': key, 'Content-Type': 'application/json' },
      rawBody: '{"courseId":3,"note":"a"}',
    });
    assert.equal(first.status, 201);
    const reordered = await alice.post('/api/bulk-issues', undefined, {
      headers: { 'Idempotency-Key': key, 'Content-Type': 'application/json' },
      rawBody: '{\n  "note": "a",\n  "courseId": 3\n}',
    });
    assert.equal(reordered.status, 201);
    assert.equal(reordered.headers.get('idempotent-replayed'), 'true');
    assert.equal(reordered.text, first.text);
  });

  it('a concurrent pair with one key and two payloads yields one execution and one conflict', async () => {
    const before = countRows(db, WEST);
    const bob = clientFor(ctx.baseUrl, BOB);
    const responses = await Promise.all([
      bob.bulkIssue(SEED.west.safety101, 'misuse-race'),
      bob.bulkIssue(SEED.west.heights, 'misuse-race'),
    ]);
    assert.deepEqual(responses.map((r) => r.status).sort(), [201, 409]);
    const winner = responses.find((r) => r.status === 201);
    assert.deepEqual(countRows(db, WEST), {
      certificates: before.certificates + winner.json.summary.issued,
      auditEvents: before.auditEvents + winner.json.summary.issued,
      operations: before.operations + 1,
    });
  });

  /** Requests whose body never becomes a JSON object, with the status they get when the key is unused. */
  const UNREADABLE_BODIES = [
    { label: 'truncated JSON', rawBody: '{"courseId": ', status: 400 },
    { label: 'not JSON at all', rawBody: 'courseId=1', status: 400 },
    { label: 'a bare JSON string', rawBody: '"1"', status: 400 },
    { label: 'a JSON array', rawBody: '[1]', status: 400 },
    { label: 'no body', rawBody: undefined, status: 400 },
    { label: 'an oversized body', rawBody: JSON.stringify({ courseId: 1, padding: 'x'.repeat(150_000) }), status: 413 },
    { label: 'an unsupported charset', rawBody: '{"courseId":1}', headers: { 'Content-Type': 'application/json; charset=latin1' }, status: 415 },
    { label: 'an unsupported content encoding', rawBody: '{"courseId":1}', headers: { 'Content-Encoding': 'x-unknown' }, status: 415 },
    { label: 'a corrupt compressed body', rawBody: 'not gzip', headers: { 'Content-Encoding': 'gzip' }, status: 400 },
  ];
  const sendRaw = (key, { rawBody, headers = {} }) =>
    alice.post('/api/bulk-issues', undefined, {
      rawBody,
      headers: { 'Content-Type': 'application/json', ...headers, 'Idempotency-Key': key },
    });

  it('a body the server cannot even read is still a 409 once the key has been used', async () => {
    const original = await alice.bulkIssue(SEED.east.safety101, 'misuse-1');
    assert.equal(original.status, 201);
    const settled = countRows(db);

    for (const unreadable of UNREADABLE_BODIES) {
      const res = await sendRaw('misuse-1', unreadable);
      assert.equal(res.status, 409, unreadable.label);
      assert.equal(res.json.error.code, 'idempotency_key_reused', unreadable.label);
      assert.equal(res.json.error.details.operationId, original.json.id, unreadable.label);
    }
    assert.deepEqual(countRows(db), settled, 'nothing ran');
    assert.equal((await alice.bulkIssue(SEED.east.safety101, 'misuse-1')).text, original.text, 'the stored result is intact');
  });

  it('with an unused key the same bodies are ordinary client errors that leave the key usable', async () => {
    const settled = countRows(db);
    for (const [index, unreadable] of UNREADABLE_BODIES.entries()) {
      const res = await sendRaw(`unreadable-${index}`, unreadable);
      assert.equal(res.status, unreadable.status, unreadable.label);
      assert.notEqual(res.json.error.code, 'idempotency_key_reused', unreadable.label);
    }
    assert.deepEqual(countRows(db), settled, 'no operation and no idempotency record was stored');

    const ok = await alice.bulkIssue(SEED.east.safety101, 'unreadable-0');
    assert.equal(ok.status, 201);
    assert.equal(ok.headers.get('idempotent-replayed'), 'false');
  });

  it('deeply nested JSON is a payload like any other, never a server error', async () => {
    const send = (key, depth) =>
      sendRaw(key, { rawBody: `{"courseId":${SEED.east.forklift},"extra":${'['.repeat(depth)}${']'.repeat(depth)}}` });

    const first = await send('deep-1', 20_000);
    assert.equal(first.status, 201);
    const retry = await send('deep-1', 20_000);
    assert.equal(retry.status, 201);
    assert.equal(retry.headers.get('idempotent-replayed'), 'true');
    assert.equal(retry.text, first.text);

    assert.equal((await send('deep-1', 20_001)).status, 409, 'one level deeper is a different payload');
    assert.equal((await send('misuse-1', 20_000)).status, 409);
    assert.equal((await alice.post(`/api/certificates/${SEED.east.revokedCertificate}/revoke`, undefined, {
      rawBody: `{"reason":${'['.repeat(20_000)}${']'.repeat(20_000)}}`,
    })).status, 400);
  });

  it('a rejected request does not burn the key', async () => {
    const key = 'misuse-validation';
    assert.equal((await alice.bulkIssue(999999, key)).status, 404);
    assert.equal((await alice.post('/api/bulk-issues', {}, { headers: { 'Idempotency-Key': key } })).status, 400);
    const ok = await alice.bulkIssue(SEED.east.firstAid, key);
    assert.equal(ok.status, 201);
    assert.equal(ok.headers.get('idempotent-replayed'), 'false');
  });
});

describe('A4 - per-learner outcomes', () => {
  let ctx;
  let db;
  let alice;
  before(async () => {
    ctx = await startFreshServer();
    db = ctx.openDb();
    alice = clientFor(ctx.baseUrl, ALICE);
  });
  after(async () => {
    db.close();
    await ctx.close();
  });

  it('issues to completed learners only and explains every skip', async () => {
    const preview = await alice.get(`/api/courses/${SEED.east.safety101}/enrollments`);
    assert.deepEqual(preview.json.summary, { enrolled: 5, completed: 3, incomplete: 2, certified: 1, revoked: 0, eligible: 2 });

    const res = await alice.bulkIssue(SEED.east.safety101, 'outcomes-1');
    assert.equal(res.status, 201);
    assert.equal(res.json.status, 'completed');
    assert.deepEqual(res.json.course, { id: SEED.east.safety101, title: 'Safety 101' });
    assert.deepEqual(res.json.summary, { total: 5, issued: 2, skipped: 3, failed: 0 });

    const byLearner = Object.fromEntries(res.json.results.map((r) => [r.learnerName, r]));
    assert.deepEqual(Object.keys(byLearner).sort(), ['Alex Lee', "Marcus O'Connor", 'Mei Chen', 'Priya Sharma', 'Tom Walker']);

    assert.equal(byLearner['Alex Lee'].outcome, 'skipped');
    assert.equal(byLearner['Alex Lee'].reason, 'already_certified');
    assert.equal(byLearner['Alex Lee'].serialNumber, 'EAST-0000001');
    for (const name of ['Mei Chen', 'Tom Walker']) {
      assert.equal(byLearner[name].outcome, 'skipped');
      assert.equal(byLearner[name].reason, 'not_completed');
      assert.equal(byLearner[name].certificateId, undefined);
    }
    assert.match(byLearner['Mei Chen'].message, /in progress/);
    assert.match(byLearner['Tom Walker'].message, /not started/);
    assert.ok(res.json.results.filter((r) => r.outcome === 'skipped').every((r) => r.message.length > 0));

    for (const name of ['Priya Sharma', "Marcus O'Connor"]) {
      const issued = byLearner[name];
      assert.equal(issued.outcome, 'issued');
      assert.match(issued.serialNumber, /^EAST-\d{7}$/);
      const detail = await alice.get(`/api/certificates/${issued.certificateId}`);
      assert.equal(detail.status, 200);
      assert.equal(detail.json.status, 'active');
      assert.equal(detail.json.learnerName, name);
      assert.equal(detail.json.courseTitle, 'Safety 101');
      assert.equal(detail.json.issuedBy, ALICE);
      assert.equal(detail.json.bulkOperationId, res.json.id);
      assert.deepEqual(detail.json.auditEvents.map((e) => [e.action, e.actorEmail, e.bulkOperationId]), [
        ['certificate.issued', ALICE, res.json.id],
      ]);
    }
    assert.equal(new Set(res.json.results.map((r) => r.serialNumber).filter(Boolean)).size, 3, 'serial numbers are unique');

    // Exactly one audit event per issued certificate, none for skipped learners.
    assert.equal((await alice.get(`/api/audit-events?bulkOperationId=${res.json.id}`)).json.total, 2);
  });

  it('a later run finds nobody left to certify', async () => {
    const again = await alice.bulkIssue(SEED.east.safety101, 'outcomes-2');
    assert.deepEqual(again.json.summary, { total: 5, issued: 0, skipped: 5, failed: 0 });
    assert.deepEqual(
      again.json.results.map((r) => r.reason).sort(),
      ['already_certified', 'already_certified', 'already_certified', 'not_completed', 'not_completed'],
    );
  });

  it('does not silently re-issue a revoked certificate', async () => {
    const res = await alice.bulkIssue(SEED.east.firstAid, 'outcomes-3');
    const byLearner = Object.fromEntries(res.json.results.map((r) => [r.learnerName, r]));
    assert.equal(byLearner['Alex Lee'].outcome, 'issued');
    assert.equal(byLearner['Mei Chen'].outcome, 'skipped');
    assert.equal(byLearner['Mei Chen'].reason, 'certificate_revoked');
    assert.equal(byLearner['Sofia Rossi'].reason, 'already_certified');
    assert.equal(byLearner['Priya Sharma'].reason, 'not_completed');
    assert.deepEqual(res.json.summary, { total: 5, issued: 1, skipped: 4, failed: 0 });
  });

  it('validates its input', async () => {
    const before = countRows(db);
    assert.equal((await alice.post('/api/bulk-issues', {})).status, 400);
    assert.equal((await alice.post('/api/bulk-issues', { courseId: 'abc' })).status, 400);
    assert.equal((await alice.post('/api/bulk-issues', { courseId: -1 })).status, 400);
    assert.equal((await alice.post('/api/bulk-issues', [1])).status, 400);
    assert.equal((await alice.post('/api/bulk-issues', undefined, { rawBody: '{oops' })).status, 400);
    assert.equal((await alice.post('/api/bulk-issues', { courseId: 424242 })).status, 404);
    assert.deepEqual(countRows(db), before);
  });
});

describe('A4 - a failing learner does not take the others down', () => {
  let dir;
  let db;
  let server;
  let alice;
  let failFor = new Set();

  before(async () => {
    dir = createTempDir();
    const dbPath = path.join(dir, 'failed.sqlite');
    db = openInitializedDatabase(dbPath);
    const app = createApp({
      db,
      openReader: () => openDatabase(dbPath, { queryOnly: true }),
      logger: { log() {}, error() {} }, // the failure below is intentional; keep the test output clean
      hooks: {
        beforeIssue: ({ learner }) => {
          if (failFor.has(learner.name)) throw new Error('simulated storage failure');
        },
      },
    });
    server = await new Promise((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    alice = clientFor(`http://127.0.0.1:${server.address().port}`, ALICE);
  });
  after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    db.close();
    removeTempDir(dir);
  });

  it('reports the learner as failed, issues the rest, and leaves no partial writes', async () => {
    failFor = new Set(['Priya Sharma']);
    const before = countRows(db, EAST);
    const res = await alice.bulkIssue(SEED.east.safety101, 'failed-1');
    assert.equal(res.status, 201);
    assert.deepEqual(res.json.summary, { total: 5, issued: 1, skipped: 3, failed: 1 });

    const byLearner = Object.fromEntries(res.json.results.map((r) => [r.learnerName, r]));
    assert.equal(byLearner['Priya Sharma'].outcome, 'failed');
    assert.match(byLearner['Priya Sharma'].message, /simulated storage failure/);
    assert.equal(byLearner['Priya Sharma'].certificateId, undefined);
    assert.equal(byLearner["Marcus O'Connor"].outcome, 'issued');

    assert.deepEqual(countRows(db, EAST), {
      certificates: before.certificates + 1,
      auditEvents: before.auditEvents + 1,
      operations: before.operations + 1,
    });
    // The failed attempt did not consume a serial number either.
    assert.equal(db.get('SELECT last_serial FROM tenants WHERE id = 1').last_serial, SEED.east.certificateCount + 1);

    // Retrying with the same key replays the recorded outcome (including the failure)...
    const replay = await alice.bulkIssue(SEED.east.safety101, 'failed-1');
    assert.equal(replay.text, res.text);

    // ...while a new operation picks up exactly the learner that failed.
    failFor = new Set();
    const retry = await alice.bulkIssue(SEED.east.safety101, 'failed-2');
    assert.deepEqual(retry.json.summary, { total: 5, issued: 1, skipped: 4, failed: 0 });
    assert.equal(retry.json.results.find((r) => r.learnerName === 'Priya Sharma').outcome, 'issued');
  });
});

describe('A5 - daylight saving and tenant-local dates', () => {
  let ctx;
  let db;
  let alice;
  let bob;
  before(async () => {
    ctx = await startFreshServer();
    db = ctx.openDb();
    alice = clientFor(ctx.baseUrl, ALICE);
    bob = clientFor(ctx.baseUrl, BOB);
  });
  after(async () => {
    db.close();
    await ctx.close();
  });

  it('shows 2026-01-10T13:30:00Z as 2026-01-11 00:30 in East and 2026-01-10 21:30 in West', async () => {
    const east = (await alice.get(`/api/certificates/${SEED.east.alexLeeCertificate}`)).json;
    assert.equal(east.issuedAt, '2026-01-10T13:30:00.000Z');
    assert.equal(east.issuedLocal, '2026-01-11 00:30');
    assert.equal(east.issuedLocalDate, '2026-01-11');
    assert.equal(east.issuedUtcOffset, '+11:00');
    assert.equal(east.tenant.timezone, 'Australia/Sydney');

    const west = (await bob.get(`/api/certificates/${SEED.west.alexLeeCertificate}`)).json;
    assert.equal(west.issuedAt, '2026-01-10T13:30:00.000Z');
    assert.equal(west.issuedLocal, '2026-01-10 21:30');
    assert.equal(west.issuedLocalDate, '2026-01-10');
    assert.equal(west.issuedUtcOffset, '+08:00');
    assert.equal(west.tenant.timezone, 'Australia/Perth');
  });

  it('uses the same local values in the list and in the CSV export', async () => {
    const eastRow = (await alice.get('/api/certificates?q=EAST-0000001')).json.items[0];
    assert.equal(eastRow.issuedLocal, '2026-01-11 00:30');
    assert.equal(eastRow.issuedLocalDate, '2026-01-11');
    const westRow = (await bob.get('/api/certificates?q=WEST-0000001')).json.items[0];
    assert.equal(westRow.issuedLocal, '2026-01-10 21:30');

    const eastCsv = await alice.get('/api/certificates/export.csv?q=EAST-0000001');
    assert.match(eastCsv.headers.get('content-type'), /^text\/csv/);
    assert.deepEqual(parseCsv(eastCsv.text), [
      ['Learner Name', 'Course Title', 'Serial Number', 'Issue Date (Australia/Sydney)'],
      ['Alex Lee', 'Safety 101', 'EAST-0000001', '2026-01-11 00:30'],
    ]);
    const westCsv = await bob.get('/api/certificates/export.csv?q=WEST-0000001');
    assert.deepEqual(parseCsv(westCsv.text), [
      ['Learner Name', 'Course Title', 'Serial Number', 'Issue Date (Australia/Perth)'],
      ['Alex Lee', 'Safety 101', 'WEST-0000001', '2026-01-10 21:30'],
    ]);
  });

  it('keeps wall-clock times correct across both DST transitions', async () => {
    const items = (await alice.get('/api/certificates?pageSize=100&sort=issued&order=asc')).json.items;
    const local = Object.fromEntries(items.map((c) => [c.issuedAt, c.issuedLocal]));
    assert.equal(local['2026-04-04T15:30:00.000Z'], '2026-04-05 02:30'); // still AEDT (+11)
    assert.equal(local['2026-04-04T16:30:00.000Z'], '2026-04-05 02:30'); // already AEST (+10)
    assert.equal(local['2026-10-03T15:30:00.000Z'], '2026-10-04 01:30'); // AEST (+10)
    assert.equal(local['2026-10-03T16:30:00.000Z'], '2026-10-04 03:30'); // AEDT (+11)
    assert.equal(local['2026-06-15T02:00:00.000Z'], '2026-06-15 12:00');
  });

  it('sorts list and export by the tenant-local calendar date, not the UTC date', async () => {
    // Two certificates issued on the same UTC day (1 May) that fall on different Sydney days.
    // "late" is inserted first, so sorting by UTC date with an id tie-break would put it first;
    // sorting by the tenant-local calendar date must put "early" (1 May local) before it (2 May local).
    const tenant = { id: EAST, code: 'EAST', timezone: 'Australia/Sydney' };
    const actor = { adminId: 1, email: ALICE };
    const course = { id: SEED.east.safety101, title: 'Safety 101' };
    const issue = (learnerName, issuedAt) =>
      db.transaction(() => {
        const learnerId = db.run(
          "INSERT INTO learners (tenant_id, full_name, created_at) VALUES (1, @name, '2026-01-01T00:00:00.000Z')",
          { name: learnerName },
        ).lastInsertRowid;
        return issueCertificate(db, { tenant, actor, course, learner: { id: learnerId, name: learnerName }, issuedAt });
      });
    const late = issue('Zz Late', '2026-05-01T14:01:00Z'); // Sydney: 2026-05-02 00:01
    const early = issue('Zz Early', '2026-05-01T13:59:00Z'); // Sydney: 2026-05-01 23:59
    assert.ok(late.id < early.id);

    const asc = (await alice.get('/api/certificates?q=Zz&sort=issued&order=asc')).json.items;
    assert.deepEqual(asc.map((c) => [c.learnerName, c.issuedLocalDate, c.issuedLocal]), [
      ['Zz Early', '2026-05-01', '2026-05-01 23:59'],
      ['Zz Late', '2026-05-02', '2026-05-02 00:01'],
    ]);
    const desc = (await alice.get('/api/certificates?q=Zz&sort=issued&order=desc')).json.items;
    assert.deepEqual(desc.map((c) => c.learnerName), ['Zz Late', 'Zz Early']);

    const csv = parseCsv((await alice.get('/api/certificates/export.csv?q=Zz&sort=issued&order=asc')).text);
    assert.deepEqual(csv.slice(1), [
      ['Zz Early', 'Safety 101', early.serialNumber, '2026-05-01 23:59'],
      ['Zz Late', 'Safety 101', late.serialNumber, '2026-05-02 00:01'],
    ]);

    // Whole tenant: local dates are monotonic in both directions and the export follows the list.
    for (const order of ['asc', 'desc']) {
      const list = (await alice.get(`/api/certificates?pageSize=100&sort=issued&order=${order}`)).json.items;
      const dates = list.map((c) => c.issuedLocalDate);
      assert.deepEqual(dates, [...dates].sort((a, b) => (order === 'asc' ? a.localeCompare(b) : b.localeCompare(a))));
      const exported = parseCsv((await alice.get(`/api/certificates/export.csv?sort=issued&order=${order}`)).text).slice(1);
      assert.deepEqual(exported.map((r) => r[2]), list.map((c) => c.serialNumber));
      assert.deepEqual(exported.map((r) => r[3]), list.map((c) => c.issuedLocal));
    }
  });

  it('stamps newly issued certificates with the tenant-local date of "now"', async () => {
    const res = await bob.bulkIssue(SEED.west.safety101, 'dst-now');
    const issued = res.json.results.find((r) => r.outcome === 'issued');
    const detail = (await bob.get(`/api/certificates/${issued.certificateId}`)).json;
    const perthNow = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Perth' }).format(new Date(detail.issuedAt));
    assert.equal(detail.issuedLocalDate, perthNow);
    assert.ok(detail.issuedLocal.startsWith(perthNow));
    assert.equal(detail.issuedUtcOffset, '+08:00');
  });
});

describe('A7 - revocation and its audit trail', () => {
  let ctx;
  let db;
  let alice;
  const revokeEvents = (certificateId) =>
    db.get("SELECT COUNT(*) AS n FROM audit_events WHERE certificate_id = @certificateId AND action = 'certificate.revoked'", {
      certificateId,
    }).n;

  before(async () => {
    ctx = await startFreshServer();
    db = ctx.openDb();
    alice = clientFor(ctx.baseUrl, ALICE);
  });
  after(async () => {
    db.close();
    await ctx.close();
  });

  it('revokes a valid certificate and writes exactly one audit event', async () => {
    const id = SEED.east.alexLeeCertificate;
    const before = countRows(db);
    assert.equal((await alice.get(`/api/certificates/${id}`)).json.status, 'active');

    const res = await alice.post(`/api/certificates/${id}/revoke`, { reason: '  Issued to the wrong learner  ' });
    assert.equal(res.status, 200);
    assert.equal(res.json.status, 'revoked');
    assert.equal(res.json.alreadyRevoked, false);
    assert.equal(res.json.revokedBy, ALICE);
    assert.equal(res.json.revocationReason, 'Issued to the wrong learner');
    assert.ok(!Number.isNaN(Date.parse(res.json.revokedAt)));
    assert.match(res.json.revokedLocal, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    assert.deepEqual(res.json.auditEvents.map((e) => e.action), ['certificate.issued', 'certificate.revoked']);
    const event = res.json.auditEvents[1];
    assert.equal(event.actorEmail, ALICE);
    assert.equal(event.details.reason, 'Issued to the wrong learner');
    assert.equal(event.details.serialNumber, 'EAST-0000001');

    assert.deepEqual(countRows(db), { ...before, auditEvents: before.auditEvents + 1 });
    assert.equal(revokeEvents(id), 1);
    assert.equal((await alice.get(`/api/certificates/${id}`)).json.status, 'revoked');
    assert.equal((await alice.get('/api/certificates?q=EAST-0000001')).json.items[0].status, 'revoked');
  });

  it('repeating the request is a no-op: same state, no second audit event', async () => {
    const id = SEED.east.alexLeeCertificate;
    const first = (await alice.get(`/api/certificates/${id}`)).json;
    const before = countRows(db);

    for (const body of [{ reason: 'a different reason' }, {}, undefined]) {
      const again = await alice.post(`/api/certificates/${id}/revoke`, body);
      assert.equal(again.status, 200);
      assert.equal(again.json.alreadyRevoked, true);
      assert.equal(again.json.status, 'revoked');
      assert.equal(again.json.revokedAt, first.revokedAt, 'original revocation is preserved');
      assert.equal(again.json.revocationReason, 'Issued to the wrong learner');
      assert.equal(again.json.auditEvents.length, 2);
    }
    assert.deepEqual(countRows(db), before);
    assert.equal(revokeEvents(id), 1);
  });

  it('concurrent revocations still produce a single audit event', async () => {
    const id = 3; // Sofia Rossi, First Aid Refresher
    const before = countRows(db);
    const responses = await Promise.all(
      Array.from({ length: 12 }, (_, i) => alice.post(`/api/certificates/${id}/revoke`, { reason: `attempt ${i}` })),
    );
    assert.ok(responses.every((r) => r.status === 200 && r.json.status === 'revoked'));
    assert.equal(responses.filter((r) => r.json.alreadyRevoked === false).length, 1);
    assert.equal(new Set(responses.map((r) => r.json.revokedAt)).size, 1);
    assert.equal(new Set(responses.map((r) => r.json.revocationReason)).size, 1);
    assert.equal(revokeEvents(id), 1);
    assert.deepEqual(countRows(db), { ...before, auditEvents: before.auditEvents + 1 });
  });

  it('treats a certificate revoked long ago the same way', async () => {
    const before = countRows(db);
    const res = await alice.post(`/api/certificates/${SEED.east.revokedCertificate}/revoke`, {});
    assert.equal(res.status, 200);
    assert.equal(res.json.alreadyRevoked, true);
    assert.equal(res.json.revokedAt, '2026-03-02T01:00:00.000Z');
    assert.deepEqual(countRows(db), before);
  });

  it('rejects unknown certificates and invalid input without side effects', async () => {
    const before = countRows(db);
    assert.equal((await alice.post('/api/certificates/999999/revoke', {})).status, 404);
    assert.equal((await alice.post('/api/certificates/not-a-number/revoke', {})).status, 404);
    assert.equal((await alice.post('/api/certificates/4/revoke', { reason: 'x'.repeat(501) })).status, 400);
    assert.equal((await alice.post('/api/certificates/4/revoke', { reason: 42 })).status, 400);
    assert.equal((await alice.post('/api/certificates/4/revoke', undefined, { rawBody: '{"reason": ' })).status, 400);
    for (const reason of ['nul\u0000byte', 'bell\u0007', 'escape\u001b[31m', 'delete\u007f', 'lone \ud800 surrogate', '\udc00 trailing half']) {
      const res = await alice.post('/api/certificates/4/revoke', { reason });
      assert.equal(res.status, 400, JSON.stringify(reason));
      assert.equal(res.json.error.code, 'invalid_request');
    }
    assert.equal((await alice.get('/api/certificates/4')).json.status, 'active');
    assert.deepEqual(countRows(db), before);
  });

  it('stores a multi-line, non-ASCII reason exactly as written', async () => {
    const reason = 'Line one\nLine two\twith a tab\r\nJosé 李 😀';
    const res = await alice.post('/api/certificates/5/revoke', { reason: `  ${reason}  ` });
    assert.equal(res.status, 200);
    assert.equal(res.json.revocationReason, reason);
    assert.equal(res.json.auditEvents.at(-1).details.reason, reason);
    assert.equal((await alice.get('/api/certificates/5')).json.revocationReason, reason);
  });
});

describe('certificate list: search, sort, pagination', () => {
  let ctx;
  let alice;
  before(async () => {
    ctx = await startFreshServer();
    alice = clientFor(ctx.baseUrl, ALICE);
  });
  after(() => ctx.close());

  const ids = async (query) => (await alice.get(`/api/certificates?pageSize=100&${query}`)).json.items.map((c) => c.id);

  it('searches by learner name or serial number, case-insensitively and by substring', async () => {
    assert.deepEqual(await ids('q=alex%20lee'), [1]);
    assert.deepEqual(await ids('q=ALEX'), [1]);
    assert.deepEqual((await ids('q=o%27connor')).sort(), [6]);
    assert.deepEqual(await ids('q=east-0000003'), [3]);
    assert.deepEqual(await ids('q=0000003'), [3]);
    assert.deepEqual((await ids('q=EAST-')).length, SEED.east.certificateCount);
    assert.deepEqual(await ids('q=nobody-by-this-name'), []);
  });

  it('treats LIKE wildcards in the search text literally', async () => {
    assert.deepEqual(await ids('q=%25'), []);
    assert.deepEqual(await ids('q=_'), []);
    assert.deepEqual(await ids('q=A%25Lee'), []);
  });

  it('filters by status', async () => {
    assert.deepEqual(await ids('status=revoked'), [SEED.east.revokedCertificate]);
    assert.equal((await ids('status=active')).length, SEED.east.certificateCount - 1);
  });

  it('sorts by every column in both directions with id as the tie-breaker', async () => {
    const all = (await alice.get('/api/certificates?pageSize=100')).json.items;
    const plain = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
    const keys = {
      issued: (a, b) => plain(a.issuedLocalDate, b.issuedLocalDate) || plain(a.issuedAt, b.issuedAt),
      learner: (a, b) => nocaseCompare(a.learnerName, b.learnerName),
      course: (a, b) => nocaseCompare(a.courseTitle, b.courseTitle),
      serial: (a, b) => plain(a.serialNumber, b.serialNumber),
      status: (a, b) => plain(a.status, b.status),
    };
    for (const [sort, compare] of Object.entries(keys)) {
      const expectedAsc = [...all].sort((a, b) => compare(a, b) || a.id - b.id).map((c) => c.id);
      assert.deepEqual(await ids(`sort=${sort}&order=asc`), expectedAsc, `${sort} asc`);
      assert.deepEqual(await ids(`sort=${sort}&order=desc`), [...expectedAsc].reverse(), `${sort} desc`);
    }
    // Duplicate sort values really occur here (three courses, seven certificates).
    assert.ok(new Set(all.map((c) => c.courseTitle)).size < all.length);
  });

  it('paginates without gaps or repeats', async () => {
    const seen = [];
    for (let page = 1; page <= 4; page += 1) {
      const res = (await alice.get(`/api/certificates?sort=course&pageSize=3&page=${page}`)).json;
      assert.equal(res.total, SEED.east.certificateCount);
      assert.equal(res.totalPages, 3);
      assert.equal(res.page, page);
      seen.push(...res.items.map((c) => c.id));
      if (page === 4) assert.deepEqual(res.items, []);
    }
    assert.deepEqual(seen, await ids('sort=course'));
    assert.equal(new Set(seen).size, SEED.east.certificateCount);
  });

  it('rejects malformed list parameters with a 400', async () => {
    for (const query of [
      'sort=password',
      'order=up',
      'status=gone',
      'page=0',
      'page=abc',
      'pageSize=1000',
      // property names every JavaScript object has are not sort columns
      'sort=constructor',
      'sort=constructor&order=asc',
      'sort=-constructor',
      'sort=__proto__&order=asc',
      'sort=-toString',
      'sort=hasOwnProperty&order=asc',
      // control characters in the search text
      'q=a%00b',
      'q=%1B%5B31m',
      'q=line%0Abreak',
    ]) {
      const res = await alice.get(`/api/certificates?${query}`);
      assert.equal(res.status, 400, query);
      assert.equal(res.json.error.code, 'invalid_request');
      const exported = await alice.get(`/api/certificates/export.csv?${query}`);
      if (!query.startsWith('page')) {
        assert.equal(exported.status, 400, `export ${query}`);
        assert.equal(exported.json.error.code, 'invalid_request', `export ${query}`);
      }
    }
    // Bytes that are not valid UTF-8 simply match nothing.
    const undecodable = await alice.get('/api/certificates?q=%ED%A0%80');
    assert.equal(undecodable.status, 200);
    assert.equal(undecodable.json.total, 0);
  });

  it('exports exactly what the list shows for the same search and sort', async () => {
    for (const query of ['', 'q=a&sort=learner&order=desc', 'sort=course&order=asc&status=active', 'q=EAST-000000&sort=serial']) {
      const list = (await alice.get(`/api/certificates?pageSize=100&${query}`)).json.items;
      const res = await alice.get(`/api/certificates/export.csv?${query}`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-disposition'), /^attachment; filename="certificates-east-\d{8}-\d{4}\.csv"$/);
      const [header, ...rows] = parseCsv(res.text);
      assert.deepEqual(header, ['Learner Name', 'Course Title', 'Serial Number', 'Issue Date (Australia/Sydney)']);
      assert.deepEqual(rows, list.map((c) => [c.learnerName, c.courseTitle, c.serialNumber, c.issuedLocal]), query);
    }
  });

  it('escapes awkward learner names in the export', async () => {
    const db = ctx.openDb();
    try {
      const tenant = { id: EAST, code: 'EAST', timezone: 'Australia/Sydney' };
      const names = ['Reyes, Dana "DJ"', '=HYPERLINK("http://evil.test","click")', 'Multi\nLine'];
      db.transaction(() => {
        for (const name of names) {
          const learnerId = db.run(
            "INSERT INTO learners (tenant_id, full_name, created_at) VALUES (1, @name, '2026-01-01T00:00:00.000Z')",
            { name },
          ).lastInsertRowid;
          issueCertificate(db, {
            tenant,
            actor: { adminId: 1, email: ALICE },
            course: { id: SEED.east.forklift, title: 'Forklift Operations' },
            learner: { id: learnerId, name },
            issuedAt: '2026-07-01T00:00:00Z',
          });
        }
      });
      const rows = parseCsv((await alice.get('/api/certificates/export.csv?sort=serial&order=desc')).text);
      assert.deepEqual(rows.slice(1, 4).map((r) => r[0]).reverse(), [
        'Reyes, Dana "DJ"',
        '\'=HYPERLINK("http://evil.test","click")',
        'Multi\nLine',
      ]);
      assert.ok(rows.every((r) => r.length === 4), 'every record still has exactly four columns');
    } finally {
      db.close();
    }
  });
});

describe('start-up and maintenance commands', () => {
  let dir;
  before(() => {
    dir = createTempDir('cert-admin-ops-');
  });
  after(() => removeTempDir(dir));

  const totals = (db) =>
    ({
      ...db.get(
        `SELECT (SELECT COUNT(*) FROM tenants) AS tenants, (SELECT COUNT(*) FROM admins) AS admins,
                (SELECT COUNT(*) FROM courses) AS courses, (SELECT COUNT(*) FROM certificates) AS certificates,
                (SELECT COUNT(*) FROM audit_events) AS auditEvents, (SELECT COUNT(*) FROM bulk_issue_operations) AS operations`,
      ),
    });
  const PRISTINE = { tenants: 2, admins: 2, courses: 6, certificates: 11, auditEvents: 13, operations: 0 };

  it('servers started at the same moment on a new database file all come up, with one copy of the demo data', async () => {
    for (let round = 0; round < 4; round += 1) {
      const dbPath = path.join(dir, `simultaneous-${round}.sqlite`);
      const started = await Promise.allSettled([startServer(dbPath), startServer(dbPath), startServer(dbPath)]);
      const servers = started.filter((result) => result.status === 'fulfilled').map((result) => result.value);
      try {
        const failures = started.filter((result) => result.status === 'rejected').map((result) => String(result.reason?.message));
        assert.deepEqual(failures, [], `round ${round}`);
        for (const server of servers) {
          const list = await clientFor(server.baseUrl, ALICE).get('/api/certificates');
          assert.equal(list.json.total, SEED.east.certificateCount);
        }
        const db = openDatabase(dbPath);
        try {
          assert.deepEqual(totals(db), PRISTINE, `round ${round}`);
        } finally {
          db.close();
        }
      } finally {
        await Promise.all(servers.map((server) => server.stop()));
      }
    }
  });

  it('a port that is already taken is reported in one line, not as a crash', async () => {
    const dbPath = path.join(dir, 'port.sqlite');
    const first = await startServer(dbPath);
    try {
      const port = new URL(first.baseUrl).port;
      const { code, output } = await runServerToExit(dbPath, { env: { PORT: port } });
      assert.equal(code, 1);
      assert.match(output, new RegExp(`Port ${port} is already in use`));
      assert.doesNotMatch(output, /TypeError|^\s+at /m, 'no stack trace');
      assert.equal((await clientFor(first.baseUrl, ALICE).get('/api/me')).status, 200, 'the running server is unaffected');
    } finally {
      await first.stop();
    }
  });

  it('invalid settings and unusable database files are reported the same way', async () => {
    const badPort = await runServerToExit(path.join(dir, 'unused.sqlite'), { env: { PORT: 'eighty' } });
    assert.equal(badPort.code, 1);
    assert.match(badPort.output, /PORT must be an integer/);
    assert.doesNotMatch(badPort.output, /^\s+at /m);

    const notADatabase = path.join(dir, 'not-a-database.sqlite');
    fs.writeFileSync(notADatabase, 'this is not an SQLite file, just some text that is long enough to look like one\n'.repeat(64));
    const corrupt = await runServerToExit(notADatabase);
    assert.equal(corrupt.code, 1);
    assert.match(corrupt.output, /Could not open the database/);
    assert.doesNotMatch(corrupt.output, /^\s+at /m);
  });

  it('a database from another schema version is refused with instructions; db:reset recreates it', async () => {
    const dbPath = path.join(dir, 'old-schema.sqlite');
    const old = openDatabase(dbPath);
    old.exec('CREATE TABLE leftovers (id INTEGER PRIMARY KEY)');
    old.exec('PRAGMA user_version = 1');
    old.close();

    const refused = await runServerToExit(dbPath);
    assert.equal(refused.code, 1);
    assert.match(refused.output, /schema version 1 is not supported/);
    assert.match(refused.output, /npm run db:reset/);
    assert.doesNotMatch(refused.output, /^\s+at /m);

    assert.match(await runScript('init-db.js', ['--reset', '--db', dbPath]), /recreating it/);
    const server = await startServer(dbPath);
    try {
      assert.equal((await clientFor(server.baseUrl, ALICE).get('/api/certificates')).json.total, SEED.east.certificateCount);
    } finally {
      await server.stop();
    }
  });

  it('db:reset restores the quick-start data in place, underneath a running server', async () => {
    const dbPath = path.join(dir, 'reset.sqlite');
    const server = await startServer(dbPath);
    const db = openDatabase(dbPath);
    try {
      const alice = clientFor(server.baseUrl, ALICE);
      const issued = await alice.bulkIssue(SEED.east.safety101, 'before-reset');
      assert.equal(issued.json.summary.issued, 2);
      assert.equal((await alice.post(`/api/certificates/${SEED.east.alexLeeCertificate}/revoke`, { reason: 'x' })).status, 200);
      assert.notDeepEqual(totals(db), PRISTINE);

      assert.match(await runScript('init-db.js', ['--reset', '--db', dbPath]), /Demo data restored/);

      // The server kept its connection and now serves the pristine dataset, ids included.
      assert.deepEqual(totals(db), PRISTINE);
      const alex = (await alice.get(`/api/certificates/${SEED.east.alexLeeCertificate}`)).json;
      assert.deepEqual([alex.learnerName, alex.serialNumber, alex.status], ['Alex Lee', 'EAST-0000001', 'active']);
      assert.equal((await alice.get(`/api/courses/${SEED.east.safety101}/enrollments`)).json.summary.eligible, 2);
      assert.deepEqual((await alice.get('/api/bulk-issues')).json.items, []);

      // The old idempotency record went with the old data: the same key now starts a fresh operation.
      const again = await alice.bulkIssue(SEED.east.safety101, 'before-reset');
      assert.equal(again.status, 201);
      assert.equal(again.headers.get('idempotent-replayed'), 'false');
      assert.deepEqual(again.json.results.filter((r) => r.outcome === 'issued').map((r) => r.serialNumber), ['EAST-0000008', 'EAST-0000009']);
    } finally {
      db.close();
      await server.stop();
    }
  });

  it('db:reset changes nothing while another process is in the middle of a write', async () => {
    const dbPath = path.join(dir, 'reset-busy.sqlite');
    const server = await startServer(dbPath);
    const db = openDatabase(dbPath);
    const locker = openDatabase(dbPath);
    try {
      const alice = clientFor(server.baseUrl, ALICE);
      assert.equal((await alice.bulkIssue(SEED.east.safety101, 'kept')).json.summary.issued, 2);
      const before = totals(db);

      locker.exec('BEGIN IMMEDIATE');
      const { code, output } = await runScriptToExit('init-db.js', ['--reset', '--db', dbPath], { env: { DB_BUSY_TIMEOUT_MS: '300' } });
      locker.exec('ROLLBACK');

      assert.equal(code, 1);
      assert.match(output, /database is busy/i);
      assert.match(output, /Nothing was changed/);
      assert.ok(fs.existsSync(dbPath), 'the database file is still there');
      assert.deepEqual(totals(db), before);
      const replay = await alice.bulkIssue(SEED.east.safety101, 'kept');
      assert.equal(replay.headers.get('idempotent-replayed'), 'true', 'the server still sees everything it wrote');
    } finally {
      locker.close();
      db.close();
      await server.stop();
    }
  });
});
