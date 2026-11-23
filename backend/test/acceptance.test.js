/**
 * Acceptance tests A1-A5 and A7 (A6 lives in scale.test.js). Each suite gets its own freshly seeded
 * database and server process, so suites are independent and can run in any order.
 */
import './support/pin-settings.mjs'; // must stay first: see the file

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { after, before, describe } from 'node:test';

import { createApp } from '../src/app.js';
import { openInitializedDatabase } from '../src/bootstrap.js';
import { TransactionAbortedError, openDatabase } from '../src/db/sqlite.js';
import { findActorByEmail } from '../src/services/actors.js';
import { bulkIssue as bulkIssueElsewhere } from '../src/services/bulkIssue.js';
import { revoke as revokeElsewhere } from '../src/services/certificates.js';
import { issueCertificate } from '../src/services/ledger.js';
import {
  ALICE,
  BOB,
  SEED,
  assertSameRows,
  clientFor,
  countRows,
  createTempDir,
  foldedCompare,
  insertCourse,
  insertLearner,
  it,
  openStream,
  parseCsv,
  referenceFold,
  removeTempDir,
  runScript,
  runScriptToExit,
  runServerToExit,
  sendPipelined,
  startFreshServer,
  startServer,
  stillPending,
  timed,
  until,
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

  it('naming another tenant in the query, the body or a header changes nothing, on any endpoint', async () => {
    const beforeCounts = countRows(db);
    const eastId = SEED.east.alexLeeCertificate;
    const claims = ['tenantId=1', 'tenant_id=1', 'tenant=East', 'tenantId=1&tenant_id=1&tenant=East'];
    const headers = { 'X-Tenant-Id': '1', 'X-Tenant': 'East' };

    for (const claim of claims) {
      assert.equal((await bob.get(`/api/certificates/${eastId}?${claim}`, { headers })).status, 404, `detail ${claim}`);
      assert.equal((await bob.get(`/api/courses/${SEED.east.safety101}/enrollments?${claim}`, { headers })).status, 404, `roster ${claim}`);
      assert.equal((await bob.get(`/api/audit-events?certificateId=${eastId}&${claim}`, { headers })).json.total, 0, `audit ${claim}`);
      assert.equal((await bob.post(`/api/certificates/${eastId}/revoke?${claim}`, { reason: 'x', tenantId: 1, tenant_id: 1, tenant: 'East' }, { headers })).status, 404, `revoke ${claim}`);
      const issue = await bob.post(`/api/bulk-issues?${claim}`, { courseId: SEED.east.safety101, tenantId: 1, tenant_id: 1, tenant: 'East' }, { headers });
      assert.equal(issue.status, 404, `bulk issue ${claim}`);
      // His own data is what he gets, whatever he claims.
      const own = await bob.get(`/api/certificates/${SEED.west.alexLeeCertificate}?${claim}`, { headers });
      assert.equal(own.json.tenant.name, 'West', claim);
    }
    assert.deepEqual(countRows(db), beforeCounts, 'nothing was written');
    assert.equal((await alice.get(`/api/certificates/${eastId}`)).json.status, 'active');
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

  it('idempotency keys belong to one admin - also within a tenant - and are compared exactly', async () => {
    db.run(
      "INSERT INTO admins (tenant_id, email, display_name, created_at) VALUES (1, 'carol@east.test', 'Carol (East admin)', '2026-01-05T00:00:00.000Z')",
    );
    const carol = clientFor(ctx.baseUrl, 'carol@east.test');

    // Same tenant, same key, same body, another admin: her own operation, not a replay of Alice's.
    const aliceRun = await alice.bulkIssue(SEED.east.firstAid, 'per-admin-1');
    assert.equal(aliceRun.json.summary.issued, 1);
    const carolRun = await carol.bulkIssue(SEED.east.firstAid, 'per-admin-1');
    assert.equal(carolRun.status, 201);
    assert.equal(carolRun.headers.get('idempotent-replayed'), 'false');
    assert.notEqual(carolRun.json.id, aliceRun.json.id);
    assert.equal(carolRun.json.requestedBy, 'carol@east.test');
    assert.equal(carolRun.json.summary.issued, 0, 'Alice has issued it already');
    // Same key with another body: a conflict only with her own earlier use of the key, never with Alice's.
    assert.equal((await alice.bulkIssue(SEED.east.safety101, 'per-admin-2')).status, 201);
    assert.equal((await carol.bulkIssue(SEED.east.forklift, 'per-admin-2')).status, 201);
    assert.equal((await carol.bulkIssue(SEED.east.forklift, 'per-admin-1')).status, 409);
    // Each of them still gets her own stored result back.
    assert.equal((await alice.bulkIssue(SEED.east.firstAid, 'per-admin-1')).text, aliceRun.text);
    assert.equal((await carol.bulkIssue(SEED.east.firstAid, 'per-admin-1')).text, carolRun.text);

    // Keys that differ only in letter case are different keys.
    const upper = await alice.bulkIssue(SEED.east.forklift, 'Case-Key');
    const lower = await alice.bulkIssue(SEED.east.firstAid, 'case-key');
    assert.equal(upper.status, 201);
    assert.equal(lower.status, 201, 'not a 409: "case-key" was never used');
    assert.equal(lower.headers.get('idempotent-replayed'), 'false');
    assert.notEqual(lower.json.id, upper.json.id);
    const shouted = await alice.bulkIssue(SEED.east.forklift, 'CASE-KEY');
    assert.equal(shouted.headers.get('idempotent-replayed'), 'false', 'not a replay of "Case-Key"');
    assert.notEqual(shouted.json.id, upper.json.id);
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
      await alice.bulkIssue(SEED.east.safety101, 'retry-seq-1'); // the course has been issued (a replay when run after the tests above)
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
  let elsewhere;
  let servers;
  const PROMPT_MS = 1500;

  before(async () => {
    ctx = await startFreshServer();
    second = await startServer(ctx.dbPath);
    db = ctx.openDb();
    locker = ctx.openDb();
    elsewhere = ctx.openDb();
    servers = [ctx.baseUrl, second.baseUrl];
  });
  after(async () => {
    locker.close(); // rolls back if a failed test left the lock behind
    elsewhere.close();
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
      // Three per server: requests queue behind the lock inside one process as well as across the two.
      const requests = servers.flatMap((baseUrl) =>
        Array.from({ length: 3 }, () => clientFor(baseUrl, BOB).bulkIssue(SEED.west.safety101, 'overlap-1')),
      );
      // None of them can finish while the lock is held, so from here on all six are in flight...
      assert.equal(await stillPending(Promise.race(requests), 400), true, 'every request waits for the lock');
      // ...and neither server is frozen by its waiting request.
      await assertReadsAreServed('while a bulk issue waits');
      assert.deepEqual(countRows(db, WEST), before, 'nothing is written before the lock is free');
      assert.equal(await stillPending(Promise.race(requests), 50), true);

      release();
      return Promise.all(requests);
    });

    assert.deepEqual(responses.map((r) => r.status), [201, 201, 201, 201, 201, 201]);
    assert.equal(new Set(responses.map((r) => r.text)).size, 1, 'every caller received the same outcome');
    assert.deepEqual(
      responses.map((r) => r.headers.get('idempotent-replayed')).sort(),
      ['false', 'true', 'true', 'true', 'true', 'true'],
      'one execution, five replays',
    );
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
      const requests = servers.flatMap((baseUrl) =>
        Array.from({ length: 3 }, (_, i) => clientFor(baseUrl, BOB).post(`/api/certificates/${id}/revoke`, { reason: `Lock test ${i}` })),
      );
      assert.equal(await stillPending(Promise.race(requests), 400), true, 'every revocation waits for the lock');
      await assertReadsAreServed('while a revocation waits');
      assert.equal((await clientFor(ctx.baseUrl, BOB).get(`/api/certificates/${id}`)).json.status, 'active');
      release();
      return Promise.all(requests);
    });

    assert.deepEqual(responses.map((r) => r.status), [200, 200, 200, 200, 200, 200]);
    assert.deepEqual(responses.map((r) => r.json.alreadyRevoked).sort(), [false, true, true, true, true, true]);
    assert.equal(new Set(responses.map((r) => r.json.revokedAt)).size, 1);
    assert.equal(new Set(responses.map((r) => r.json.revocationReason)).size, 1, 'everyone sees the one revocation that took effect');
    assert.deepEqual(countRows(db, WEST), { ...before, auditEvents: before.auditEvents + 1 });
  });

  it('queued bulk issues are answered once a request with their key has completed elsewhere, however long the lock stays taken', async () => {
    // "Elsewhere" is another process that shares the database - played here by this test process
    // calling the same service code on its own connection - followed by an unrelated long write.
    const bobActor = findActorByEmail(elsewhere, BOB);
    const request = { body: { courseId: SEED.west.heights }, idempotencyKey: 'answered-while-waiting' };
    const before = countRows(db, WEST);

    locker.exec('BEGIN IMMEDIATE');
    try {
      // Two requests queue for the lock under one key: the same payload on one server, another
      // course on the other.
      const queuedSame = timed(() => clientFor(servers[0], BOB).bulkIssue(request.body.courseId, request.idempotencyKey));
      const queuedOther = timed(() => clientFor(servers[1], BOB).bulkIssue(SEED.west.manualHandling, request.idempotencyKey));
      assert.equal(await stillPending(Promise.race([queuedSame, queuedOther]), 400), true, 'both requests are queueing for the lock');

      // The lock changes hands without a pause: first to a request with that key, then to the long write.
      locker.exec('COMMIT');
      const other = bulkIssueElsewhere(elsewhere, bobActor, request).then(
        (done) => ({ status: done.status, text: done.body, replayed: done.replayed }),
        (err) => ({ status: err.status, conflictWith: err.details?.operationId }),
      );
      locker.exec('BEGIN IMMEDIATE');

      const elsewhereAnswer = await other;
      assert.equal(await stillPending(Promise.all([queuedSame, queuedOther]), PROMPT_MS), false, 'both are answered although the write lock is still taken');
      const viaHttp = ({ value }) => ({
        status: value.status,
        text: value.text,
        replayed: value.headers.get('idempotent-replayed') === 'true',
        conflictWith: value.json?.error?.details?.operationId,
        code: value.json?.error?.code,
      });
      const same = viaHttp(await queuedSame);
      const otherCourse = viaHttp(await queuedOther);

      // Whichever request got the lock first executed - almost always the one "elsewhere". Its
      // payload wins the key: the callers that sent that payload share one outcome, and the
      // request for the other course is a 409 that names the operation it collided with.
      const winners = elsewhereAnswer.status === 201 ? [elsewhereAnswer, same] : [otherCourse];
      const losers = elsewhereAnswer.status === 201 ? [otherCourse] : [elsewhereAnswer, same];
      const operation = JSON.parse(winners[0].text);
      for (const winner of winners) {
        assert.equal(winner.status, 201);
        assert.equal(winner.text, winners[0].text, 'the same outcome for every caller with that payload');
      }
      assert.equal(winners.filter((winner) => !winner.replayed).length, 1, 'executed once, replayed to the rest');
      for (const loser of losers) {
        assert.equal(loser.status, 409);
        assert.equal(loser.conflictWith, operation.id);
        if (loser !== elsewhereAnswer) assert.equal(loser.code, 'idempotency_key_reused');
      }
      assert.deepEqual(countRows(db, WEST), {
        certificates: before.certificates + operation.summary.issued,
        auditEvents: before.auditEvents + operation.summary.issued,
        operations: before.operations + 1,
      });
    } finally {
      locker.exec('ROLLBACK');
    }
  });

  it('a queued revocation is answered once somebody else has revoked the certificate, however long the lock stays taken', async () => {
    const bobActor = findActorByEmail(elsewhere, BOB);
    const id = 9; // Liam Brown, Working at Heights
    assert.equal((await clientFor(servers[0], BOB).get(`/api/certificates/${id}`)).json.status, 'active');
    const before = countRows(db, WEST);

    locker.exec('BEGIN IMMEDIATE');
    try {
      const queued = timed(() => clientFor(servers[1], BOB).post(`/api/certificates/${id}/revoke`, { reason: 'queued' }));
      assert.equal(await stillPending(queued, 400), true, 'the revocation is queueing for the lock');

      locker.exec('COMMIT');
      const other = revokeElsewhere(elsewhere, bobActor, id, { reason: 'elsewhere' });
      locker.exec('BEGIN IMMEDIATE');

      const first = await other;
      assert.equal(await stillPending(queued, PROMPT_MS), false, 'answered although the write lock is still taken');
      const { value: answer } = await queued;
      assert.equal(answer.status, 200);
      assert.equal(answer.json.status, 'revoked');
      assert.deepEqual([answer.json.alreadyRevoked, first.alreadyRevoked].sort(), [false, true], 'one of them revoked, the other found it done');
      assert.equal(answer.json.revokedAt, first.revokedAt);
      assert.equal(answer.json.revocationReason, first.revocationReason);
      assert.deepEqual(countRows(db, WEST), { ...before, auditEvents: before.auditEvents + 1 });
    } finally {
      locker.exec('ROLLBACK');
    }
  });

  it('a queued revocation is answered once the certificate has disappeared, however long the lock stays taken', async () => {
    // A certificate of its own for this test, removed again "elsewhere" (as the load-test
    // generator does with its certificates) while the revocation queues.
    const tenant = { id: WEST, code: 'WEST', timezone: 'Australia/Perth' };
    const learnerId = insertLearner(elsewhere, WEST, 'Gone Tomorrow');
    const { id } = elsewhere.transaction(() =>
      issueCertificate(elsewhere, {
        tenant,
        actor: { adminId: 2, email: BOB },
        course: { id: SEED.west.heights, title: 'Working at Heights' },
        learner: { id: learnerId, name: 'Gone Tomorrow' },
        issuedAt: '2026-08-05T00:00:00Z',
      }),
    );
    assert.equal((await clientFor(servers[0], BOB).get(`/api/certificates/${id}`)).json.status, 'active');

    locker.exec('BEGIN IMMEDIATE');
    try {
      const queued = timed(() => clientFor(servers[0], BOB).post(`/api/certificates/${id}/revoke`, { reason: 'queued' }));
      assert.equal(await stillPending(queued, 400), true, 'the revocation is queueing for the lock');

      locker.exec('COMMIT');
      elsewhere.transaction(() => {
        elsewhere.run('DELETE FROM audit_events WHERE certificate_id = @id', { id });
        elsewhere.run('DELETE FROM certificates WHERE id = @id', { id });
      });
      locker.exec('BEGIN IMMEDIATE');

      assert.equal(await stillPending(queued, PROMPT_MS), false, 'answered although the write lock is still taken');
      const { value: answer } = await queued;
      // 404 once the certificate is gone - unless the queued request got the lock in the instant
      // between the two writers, in which case it revoked the certificate before it was removed.
      assert.ok(answer.status === 404 || (answer.status === 200 && answer.json.alreadyRevoked === false), `status ${answer.status}`);
      if (answer.status === 404) assert.equal(answer.json.error.code, 'not_found');
      assert.equal((await clientFor(servers[1], BOB).get(`/api/certificates/${id}`)).status, 404);
    } finally {
      locker.exec('ROLLBACK');
    }
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
    assert.equal((await alice.bulkIssue(SEED.east.safety101, 'misuse-1')).status, 201); // the key is in use
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
    assert.equal((await alice.bulkIssue(SEED.east.safety101, 'misuse-1')).status, 201); // the key is in use

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
    assert.equal((await alice.bulkIssue(SEED.east.safety101, 'outcomes-1')).status, 201); // the first run (replayed when it ran above)
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

describe('bulk issue with injected failures (A2 atomicity, A4 per-learner isolation)', () => {
  let dir;
  let db;
  let server;
  let alice;
  let bob;
  /** Learner names for which issuing fails: before anything is written / after the learner's rows are written / fatally. */
  let failBefore = new Set();
  let failAfter = new Set();
  let abortAfter = new Set();
  /** What the app logged as errors: the text of each call, and whether it came with the Error itself (stack trace and all). */
  const logged = [];
  const loggedInFull = [];

  const lastSerial = (tenantId) => db.get('SELECT last_serial FROM tenants WHERE id = @tenantId', { tenantId }).last_serial;
  const certificatesOf = (courseId, learnerName) =>
    db.get('SELECT COUNT(*) AS n FROM certificates WHERE course_id = @courseId AND learner_name = @learnerName', { courseId, learnerName }).n;

  before(async () => {
    dir = createTempDir();
    const dbPath = path.join(dir, 'failed.sqlite');
    db = openInitializedDatabase(dbPath);
    const app = createApp({
      db,
      openReader: () => openDatabase(dbPath, { queryOnly: true }),
      // The failures below are intentional: keep them out of the test output, but remember them.
      logger: {
        log() {},
        error: (...args) => {
          logged.push(args.map(String).join(' '));
          loggedInFull.push(args.some((arg) => arg instanceof Error));
        },
      },
      hooks: {
        beforeIssue: ({ learner }) => {
          if (failBefore.has(learner.name)) throw new Error('simulated storage failure: CHECK constraint failed: secret_internal_detail');
        },
        afterIssue: ({ learner }) => {
          if (failAfter.has(learner.name)) throw new Error('simulated failure after the certificate was written');
          // What SQLite does on "disk full": the whole transaction is gone, not just this learner's part.
          if (abortAfter.has(learner.name)) throw new TransactionAbortedError(new Error('simulated disk full'));
        },
      },
    });
    server = await new Promise((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    alice = clientFor(baseUrl, ALICE);
    bob = clientFor(baseUrl, BOB);
  });
  after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    db.close();
    removeTempDir(dir);
  });

  it('an operation that fails as a whole leaves nothing behind - not even its idempotency key', async () => {
    // Roster order is Alex Lee (certified), Marcus O'Connor, Mei Chen, Priya Sharma, Tom Walker:
    // Marcus has been issued by the time the transaction dies on Priya.
    abortAfter = new Set(['Priya Sharma']);
    const before = countRows(db, EAST);

    const res = await alice.bulkIssue(SEED.east.safety101, 'atomic-1');
    assert.equal(res.status, 500);
    assert.equal(res.json.error.code, 'internal_error');
    assert.ok(!res.text.includes('disk full'), 'internal details stay in the server log');

    assert.deepEqual(countRows(db, EAST), before, 'no certificate, no audit event, no operation row');
    assert.equal(certificatesOf(SEED.east.safety101, "Marcus O'Connor"), 0, 'the certificate issued before the failure is gone too');
    assert.equal(lastSerial(EAST), SEED.east.certificateCount, 'no serial number was consumed');
    assert.deepEqual((await alice.get('/api/bulk-issues')).json.items, [], 'the operation does not show up in the history');
    assert.equal((await alice.get(`/api/courses/${SEED.east.safety101}/enrollments`)).json.summary.eligible, 2);

    // The key was not burned: the retry is the first execution, and its result is what gets stored.
    abortAfter = new Set();
    const retry = await alice.bulkIssue(SEED.east.safety101, 'atomic-1');
    assert.equal(retry.status, 201);
    assert.equal(retry.headers.get('idempotent-replayed'), 'false');
    assert.deepEqual(retry.json.summary, { total: 5, issued: 2, skipped: 3, failed: 0 });
    assert.deepEqual(retry.json.results.filter((r) => r.outcome === 'issued').map((r) => r.serialNumber), ['EAST-0000008', 'EAST-0000009']);
    assert.equal((await alice.bulkIssue(SEED.east.safety101, 'atomic-1')).text, retry.text);
  });

  it('a learner who fails before anything is written is reported as failed; the others are issued', async () => {
    failBefore = new Set(['Alex Lee']);
    const before = countRows(db, EAST);
    const serialBefore = lastSerial(EAST);
    const res = await alice.bulkIssue(SEED.east.firstAid, 'failed-1');
    assert.equal(res.status, 201);
    assert.deepEqual(res.json.summary, { total: 5, issued: 0, skipped: 4, failed: 1 });

    const failed = res.json.results.find((r) => r.learnerName === 'Alex Lee');
    assert.equal(failed.outcome, 'failed');
    assert.equal(failed.reason, 'issue_failed');
    assert.equal(failed.certificateId, undefined);
    assert.match(failed.message, /could not be issued/i);
    // The cause is for the operator, not for the API client.
    assert.ok(!res.text.includes('simulated') && !res.text.includes('CHECK constraint') && !res.text.includes('secret_internal_detail'));
    assert.ok(logged.some((line) => line.includes('secret_internal_detail') && line.includes(`operation ${res.json.id}`)), 'the server log has it');

    assert.deepEqual(countRows(db, EAST), { ...before, operations: before.operations + 1 });
    assert.equal(lastSerial(EAST), serialBefore);

    // Retrying with the same key replays the recorded outcome (including the failure)...
    const replay = await alice.bulkIssue(SEED.east.firstAid, 'failed-1');
    assert.equal(replay.text, res.text);

    // ...while a new operation picks up exactly the learner that failed.
    failBefore = new Set();
    const retry = await alice.bulkIssue(SEED.east.firstAid, 'failed-2');
    assert.deepEqual(retry.json.summary, { total: 5, issued: 1, skipped: 4, failed: 0 });
    assert.equal(retry.json.results.find((r) => r.learnerName === 'Alex Lee').outcome, 'issued');
  });

  it('a learner who fails after their certificate was written leaves no partial writes', async () => {
    // West, Safety 101: Emily Davis and Jordan Smith are eligible, in that order. Jordan's failure
    // comes after his serial number was reserved and his certificate and audit event were inserted.
    failAfter = new Set(['Jordan Smith']);
    const before = countRows(db, WEST);
    const res = await bob.bulkIssue(SEED.west.safety101, 'failed-after-1');
    assert.equal(res.status, 201);
    assert.deepEqual(res.json.summary, { total: 5, issued: 1, skipped: 3, failed: 1 });

    const byLearner = Object.fromEntries(res.json.results.map((r) => [r.learnerName, r]));
    assert.equal(byLearner['Jordan Smith'].outcome, 'failed');
    assert.equal(byLearner['Jordan Smith'].certificateId, undefined);
    assert.equal(byLearner['Emily Davis'].outcome, 'issued');
    assert.equal(byLearner['Emily Davis'].serialNumber, 'WEST-0000005');

    assert.deepEqual(countRows(db, WEST), {
      certificates: before.certificates + 1,
      auditEvents: before.auditEvents + 1,
      operations: before.operations + 1,
    });
    assert.equal(certificatesOf(SEED.west.safety101, 'Jordan Smith'), 0, 'his certificate was rolled back');
    assert.equal(db.get("SELECT COUNT(*) AS n FROM audit_events WHERE tenant_id = 2 AND details LIKE '%Jordan Smith%'").n, 0, 'and so was its audit event');
    assert.equal(lastSerial(WEST), SEED.west.certificateCount + 1, 'the serial number he had reserved is free again');
    assert.equal((await bob.get(`/api/courses/${SEED.west.safety101}/enrollments`)).json.summary.eligible, 1, 'he is still eligible');

    failAfter = new Set();
    const retry = await bob.bulkIssue(SEED.west.safety101, 'failed-after-2');
    assert.deepEqual(retry.json.summary, { total: 5, issued: 1, skipped: 4, failed: 0 });
    const jordan = retry.json.results.find((r) => r.learnerName === 'Jordan Smith');
    assert.equal(jordan.outcome, 'issued');
    assert.equal(jordan.serialNumber, 'WEST-0000006', 'no gap in the serial numbers');
  });

  it('when many learners of one operation fail, the cause is logged in full once and in one line for each of the others', async () => {
    const names = ['Fail One', 'Fail Two', 'Fail Three', 'Fail Four'];
    let courseId;
    db.transaction(() => {
      courseId = insertCourse(db, EAST, 'Everybody fails');
      for (const name of names) {
        db.run(
          `INSERT INTO enrollments (tenant_id, course_id, learner_id, status, completed_at, created_at)
           VALUES (@tenantId, @courseId, @learnerId, 'completed', '2026-08-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')`,
          { tenantId: EAST, courseId, learnerId: insertLearner(db, EAST, name) },
        );
      }
    });
    failBefore = new Set(names);
    const firstLine = logged.length;
    const res = await alice.bulkIssue(courseId, 'all-failed-1');
    failBefore = new Set();
    assert.equal(res.status, 201);
    assert.deepEqual(res.json.summary, { total: 4, issued: 0, skipped: 0, failed: 4 });

    const lines = logged.slice(firstLine);
    assert.equal(lines.length, 4, 'one log entry per failed learner');
    for (const line of lines) {
      assert.match(line, new RegExp(`^\\[bulk-issue\\] operation ${res.json.id}: learner \\d+ failed: .*secret_internal_detail`), 'operation, learner and cause');
      assert.ok(!line.includes('\n'), 'on a single line');
    }
    assert.deepEqual(loggedInFull.slice(firstLine), [true, false, false, false], 'the stack trace is logged once, not once per learner');
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
        const learnerId = insertLearner(db, EAST, learnerName);
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

  it('shows every other time in the tenant zone as well: revocation, audit trail, roster, bulk-issue results', async () => {
    // West (Perth, UTC+8 all year): Grace Kim's certificate, issued 2026-08-01T03:00Z, revoked 2026-08-20T06:30Z.
    const west = (await bob.get('/api/certificates/10')).json;
    assert.equal(west.learnerName, 'Grace Kim');
    assert.equal(west.issuedLocal, '2026-08-01 11:00');
    assert.equal(west.revokedLocal, '2026-08-20 14:30');
    assert.deepEqual(west.auditEvents.map((e) => [e.action, e.createdLocal]), [
      ['certificate.issued', '2026-08-01 11:00'],
      ['certificate.revoked', '2026-08-20 14:30'],
    ]);
    // East (Sydney, UTC+11 in February and early March): Mei Chen's revoked certificate.
    const east = (await alice.get(`/api/certificates/${SEED.east.revokedCertificate}`)).json;
    assert.equal(east.issuedLocal, '2026-02-15 09:15');
    assert.equal(east.revokedLocal, '2026-03-02 12:00');
    assert.deepEqual(east.auditEvents.map((e) => e.createdLocal), ['2026-02-15 09:15', '2026-03-02 12:00']);

    const westAudit = (await bob.get('/api/audit-events?certificateId=10')).json.items; // newest first
    assert.deepEqual(westAudit.map((e) => e.createdLocal), ['2026-08-20 14:30', '2026-08-01 11:00']);

    // Roster: Jordan Smith completed Safety 101 at 2026-11-16T07:15Z = 15:15 in Perth.
    const roster = (await bob.get(`/api/courses/${SEED.west.safety101}/enrollments`)).json.items;
    assert.equal(roster.find((r) => r.learnerName === 'Jordan Smith').completedLocal, '2026-11-16 15:15');

    // A bulk issue right now: its result rows, the operation history and the audit trail agree with
    // Perth time, computed here without the application's own time code.
    const perth = (iso) => new Date(Date.parse(iso) + 8 * 3_600_000).toISOString().slice(0, 16).replace('T', ' ');
    const res = (await bob.bulkIssue(SEED.west.heights, 'local-times')).json;
    const issued = res.results.find((r) => r.outcome === 'issued');
    assert.equal(issued.issuedLocal, perth(issued.issuedAt));
    const history = (await bob.get('/api/bulk-issues')).json.items.find((o) => o.id === res.id);
    assert.equal(history.createdLocal, perth(history.createdAt));
    const detail = (await bob.get(`/api/certificates/${issued.certificateId}`)).json;
    assert.equal(detail.auditEvents[0].createdLocal, perth(issued.issuedAt));
    const revoked = (await bob.post(`/api/certificates/${issued.certificateId}/revoke`, {})).json;
    assert.equal(revoked.revokedLocal, perth(revoked.revokedAt));
    assert.equal(revoked.auditEvents[1].createdLocal, perth(revoked.revokedAt));
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
    await alice.post(`/api/certificates/${id}/revoke`, { reason: 'Issued to the wrong learner' }); // revoked (a no-op after the test above)
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

  it('finds accented names however they are typed: case and accents do not count', async () => {
    const JOSE = 4; // José Álvarez, First Aid Refresher
    for (const typed of ['José Álvarez', 'josé álvarez', 'JOSÉ ÁLVAREZ', 'jose alvarez', 'ALVAREZ', 'álvarez', 'Álvarez', 'JOSÉ', 'jose', 'Jose\u0301', 'ｊｏｓｅ', 'é á']) {
      assert.deepEqual(await ids(`q=${encodeURIComponent(typed)}`), [JOSE], typed);
    }
    assert.deepEqual(await ids(`q=${encodeURIComponent('Sofía')}`), [3], 'an accent typed where the name has none');
    assert.deepEqual(await ids('q=josee'), []);

    // The export uses the same filter.
    const csv = parseCsv((await alice.get(`/api/certificates/export.csv?q=${encodeURIComponent('álvarez')}`)).text);
    assert.deepEqual(csv.slice(1).map((r) => r[0]), ['José Álvarez']);

    // Text that is accents only has nothing to look for: no match, rather than every row.
    const onlyAccent = await alice.get('/api/certificates?q=%CC%81');
    assert.equal(onlyAccent.status, 200);
    assert.equal(onlyAccent.json.total, 0);
    assert.equal(parseCsv((await alice.get('/api/certificates/export.csv?q=%CC%81')).text).length, 1, 'header only');

    // The same goes for an accent that is a character of its own, as many keyboards produce it. It
    // must not turn into a space - every "first last" name contains one of those.
    for (const accent of ['´', '¨', '¯', '¸', '˜', '΄']) {
      const res = await alice.get(`/api/certificates?q=${encodeURIComponent(accent)}`);
      assert.deepEqual([res.status, res.json.total, res.json.items.length], [200, 0, 0], `q=${accent}`);
    }
    assert.equal(parseCsv((await alice.get('/api/certificates/export.csv?q=%C2%B4')).text).length, 1, 'header only');
    assert.equal((await alice.get('/api/certificates?q=%C2%B4&status=revoked')).json.total, 0);
    // Next to a letter it is ignored like any other accent.
    assert.deepEqual(await ids(`q=${encodeURIComponent('Jose´')}`), [JOSE]);
    assert.deepEqual(await ids(`q=${encodeURIComponent('´Alvarez')}`), [JOSE]);
  });

  it('searches learner names and serial numbers only', async () => {
    assert.deepEqual(await ids('q=Safety'), [], 'course titles are not searched');
    assert.deepEqual(await ids('q=forklift'), []);
    assert.deepEqual(await ids('q=active'), []);
    assert.deepEqual(await ids('q=2026'), []);
  });

  it('treats %, _ and other pattern characters in the search text literally', async () => {
    assert.deepEqual(await ids('q=%25'), []);
    assert.deepEqual(await ids('q=_'), []);
    assert.deepEqual(await ids('q=A%25Lee'), []);
    assert.deepEqual(await ids('q=EAST_0000001'), [], 'an underscore is not "any character" in a serial number either');
    assert.deepEqual(await ids('q=EAST%250001'), []);
    assert.deepEqual(await ids('q=EAST-0000001'), [1]);
    assert.deepEqual(await ids('q=%5C'), []);
    assert.deepEqual(await ids('q=%5Ce'), [], 'a backslash does not turn the next character into a match on its own ("e" is in every serial number)');
    assert.deepEqual(await ids('q=%5C0'), []);
    assert.deepEqual(await ids('q=EAST%5C-0000001'), []);
    assert.deepEqual(await ids('q=*'), []);
    assert.deepEqual(await ids('q=%5B'), []);
  });

  it('filters by status', async () => {
    assert.deepEqual(await ids('status=revoked'), [SEED.east.revokedCertificate]);
    assert.deepEqual(await ids('status=REVOKED'), [SEED.east.revokedCertificate], 'in any letter case');
    assert.equal((await ids('status=active')).length, SEED.east.certificateCount - 1);
  });

  it('sorts by every column in both directions with id as the tie-breaker', async () => {
    const all = (await alice.get('/api/certificates?pageSize=100')).json.items;
    const plain = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
    const keys = {
      issued: (a, b) => plain(a.issuedLocalDate, b.issuedLocalDate) || plain(a.issuedAt, b.issuedAt),
      learner: (a, b) => foldedCompare(a.learnerName, b.learnerName),
      course: (a, b) => foldedCompare(a.courseTitle, b.courseTitle),
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

  it('counts pages correctly, also when the total is an exact multiple of the page size', async () => {
    const pages = async (query) => (await alice.get(`/api/certificates?${query}`)).json.totalPages;
    assert.equal(await pages('pageSize=7'), 1);
    assert.equal(await pages('pageSize=1'), 7);
    assert.equal(await pages('pageSize=6'), 2);
    assert.equal(await pages('pageSize=100'), 1);
    assert.equal(await pages('pageSize=7&q=nobody-by-this-name'), 1, 'an empty result still has its (empty) first page');
    const beyond = (await alice.get('/api/certificates?pageSize=7&page=2')).json;
    assert.deepEqual([beyond.items.length, beyond.total, beyond.totalPages], [0, 7, 1]);
  });

  it('rejects malformed list parameters with a 400', async () => {
    for (const query of [
      'sort=password',
      // near misses of real names are rejected, not guessed at
      'sort=issued!!!',
      'sort=l-e-a-r-n-e-r',
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

  it('a blank parameter counts as not given, and no parameter is ever dropped silently', async () => {
    const first = async (query) => {
      const res = (await alice.get(`/api/certificates?${query}`)).json;
      return [res.sort, res.order, res.items[0].learnerName];
    };
    assert.deepEqual(await first('sort=-learner'), ['learner', 'desc', 'Tom Walker']);
    assert.deepEqual(await first('sort=-learner&order='), ['learner', 'desc', 'Tom Walker']);
    assert.deepEqual(await first('sort=&sortBy=course&order=desc'), ['course', 'desc', 'Alex Lee']);
    assert.deepEqual(await first('sort=&order=&status=&q=&page=&pageSize='), ['issued', 'desc', 'Tom Walker']);

    // A filter stays in force however many other parameters come before it.
    const junk = Array.from({ length: 1_200 }, (_, i) => `p${i}=1`).join('&');
    const filtered = await alice.get(`/api/certificates?${junk}&q=nobody-by-this-name&status=revoked`);
    assert.equal(filtered.status, 200);
    assert.deepEqual([filtered.json.total, filtered.json.q, filtered.json.status], [0, 'nobody-by-this-name', 'revoked']);
    assert.equal((await alice.get(`/api/certificates?${junk}&status=gone`)).status, 400);
    const exported = await alice.get(`/api/certificates/export.csv?${junk}&q=nobody-by-this-name`);
    assert.equal(parseCsv(exported.text).length, 1, 'header only');
  });

  it('audit events: filters are validated like everything else', async () => {
    const events = async (query) => (await alice.get(`/api/audit-events?pageSize=100&${query}`)).json;
    assert.equal((await events('')).total, SEED.east.certificateCount + 1, 'seven issued, one revoked');
    assert.deepEqual((await events('action=certificate.revoked')).items.map((e) => e.certificateId), [SEED.east.revokedCertificate]);
    assert.equal((await events('action=certificate.issued')).total, SEED.east.certificateCount);
    assert.equal((await events('action=')).total, SEED.east.certificateCount + 1);
    assert.equal((await events(`certificateId=${SEED.east.revokedCertificate}`)).total, 2);
    assert.equal((await events('certificateId=1234567890')).total, 0, 'a large id is a valid id that matches nothing');
    assert.equal((await events('bulkOperationId=999999999999999')).total, 0);

    for (const query of ['action=bogus', 'action=CERTIFICATE.REVOKED', 'certificateId=0', 'certificateId=abc', 'certificateId=1.5', 'certificateId=99999999999999999', 'bulkOperationId=-1']) {
      const res = await alice.get(`/api/audit-events?${query}`);
      assert.equal(res.status, 400, query);
      assert.equal(res.json.error.code, 'invalid_request', query);
    }
    assert.match((await alice.get('/api/audit-events?action=bogus')).json.error.message, /certificate\.issued, certificate\.revoked/);
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
          const learnerId = insertLearner(db, EAST, name);
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

  it('sorts names ignoring case and accents, and finds special characters as themselves', async () => {
    const db = ctx.openDb();
    try {
      const tenant = { id: EAST, code: 'EAST', timezone: 'Australia/Sydney' };
      const names = ['Élodie Durand', 'alvarez', 'ALVAREZ', 'Álvarez', 'Zoë Zimmer', 'eloise', 'Back\\slash Barry', '100% Pure_Name'];
      db.transaction(() => {
        for (const name of names) {
          const learnerId = insertLearner(db, EAST, name);
          issueCertificate(db, {
            tenant,
            actor: { adminId: 1, email: ALICE },
            course: { id: SEED.east.safety101, title: 'Safety 101' },
            learner: { id: learnerId, name },
            issuedAt: '2026-08-01T00:00:00Z',
          });
        }
      });

      const listed = async (query) => (await alice.get(`/api/certificates?pageSize=100&${query}`)).json.items;
      const ascending = (await listed('sort=learner&order=asc')).map((c) => c.learnerName);
      // The three spellings of "alvarez" sort together (in id order), the accented E's among the e's,
      // and nothing accented is pushed behind "z".
      const position = (name) => ascending.indexOf(name);
      assert.deepEqual(ascending.slice(position('alvarez'), position('alvarez') + 3), ['alvarez', 'ALVAREZ', 'Álvarez']);
      assert.ok(position('Alex Lee') < position('alvarez') && position('Álvarez') < position('Back\\slash Barry'));
      assert.ok(position('Élodie Durand') < position('eloise') && position('eloise') < position('José Álvarez'));
      assert.equal(ascending.at(-1), 'Zoë Zimmer');
      assert.ok(position('Tom Walker') < position('Zoë Zimmer'));
      // Against an independent reference, in both directions, and the export agrees.
      const all = await listed('');
      const expected = [...all].sort((a, b) => foldedCompare(a.learnerName, b.learnerName) || a.id - b.id).map((c) => c.id);
      assert.deepEqual((await listed('sort=learner&order=asc')).map((c) => c.id), expected);
      assert.deepEqual((await listed('sort=learner&order=desc')).map((c) => c.id), [...expected].reverse());
      const csv = parseCsv((await alice.get('/api/certificates/export.csv?sort=learner&order=asc')).text).slice(1);
      assert.deepEqual(csv.map((r) => r[2]), (await listed('sort=learner&order=asc')).map((c) => c.serialNumber));

      const found = async (text) => (await listed(`q=${encodeURIComponent(text)}`)).map((c) => c.learnerName).sort();
      assert.deepEqual(await found('ELODIE'), ['Élodie Durand']);
      assert.deepEqual(await found('zoe z'), ['Zoë Zimmer']);
      assert.deepEqual(await found('alvarez'), ['ALVAREZ', 'José Álvarez', 'alvarez', 'Álvarez'].sort());
      assert.deepEqual(await found('\\'), ['Back\\slash Barry']);
      assert.deepEqual(await found('%'), ['100% Pure_Name']);
      assert.deepEqual(await found('_'), ['100% Pure_Name']);
      assert.deepEqual(await found('% pure_'), ['100% Pure_Name']);
      assert.deepEqual(await found('k\\s'), ['Back\\slash Barry']);
      assert.deepEqual(await found('k_s'), [], 'an underscore stands for itself, not for any character');
    } finally {
      db.close();
    }
  });

  it('finds and sorts the Latin letters that have no accent to drop (ø, ł, ß, ı ...) by their plain spelling', async () => {
    const db = ctx.openDb();
    try {
      const tenant = { id: EAST, code: 'EAST', timezone: 'Australia/Sydney' };
      const names = ['Łukasz Żółć', 'Øystein Ødegård', 'Straße Groß', 'Işık Yıldız'];
      db.transaction(() => {
        for (const name of names) {
          issueCertificate(db, {
            tenant,
            actor: { adminId: 1, email: ALICE },
            course: { id: SEED.east.forklift, title: 'Forklift Operations' },
            learner: { id: insertLearner(db, EAST, name), name },
            issuedAt: '2026-08-02T00:00:00Z',
          });
        }
      });
      const listed = async (query) => (await alice.get(`/api/certificates?pageSize=100&${query}`)).json.items;
      const found = async (text) => (await listed(`q=${encodeURIComponent(text)}`)).map((c) => c.learnerName);

      for (const typed of ['lukasz', 'LUKASZ ZOLC', 'Łukasz', 'łukasz żółć']) assert.deepEqual(await found(typed), ['Łukasz Żółć'], typed);
      for (const typed of ['odegard', 'OYSTEIN', 'ødegård', 'Øystein Ødegård']) assert.deepEqual(await found(typed), ['Øystein Ødegård'], typed);
      for (const typed of ['strasse', 'STRASSE GROSS', 'straße', 'Groß', 'GROSS']) assert.deepEqual(await found(typed), ['Straße Groß'], typed);
      for (const typed of ['isik', 'IŞIK', 'ışık', 'Işık', 'YILDIZ', 'yıldız', 'yildiz']) assert.deepEqual(await found(typed), ['Işık Yıldız'], typed);

      // They sort where their plain spelling belongs, not behind "z".
      const ascending = (await listed('sort=learner&order=asc')).map((c) => c.learnerName);
      const position = (name) => {
        assert.ok(ascending.includes(name), name);
        return ascending.indexOf(name);
      };
      assert.ok(position('Işık Yıldız') < position('José Álvarez'), 'i before j');
      assert.ok(position('José Álvarez') < position('Łukasz Żółć') && position('Łukasz Żółć') < position("Marcus O'Connor"), 'l between j and m');
      assert.ok(position("Marcus O'Connor") < position('Øystein Ødegård') && position('Øystein Ødegård') < position('Priya Sharma'), 'o between m and p');
      assert.ok(position('Sofia Rossi') < position('Straße Groß') && position('Straße Groß') < position('Tom Walker'), '"strasse" between "sofia" and "tom"');
      const csv = parseCsv((await alice.get('/api/certificates/export.csv?sort=learner&order=asc')).text).slice(1);
      assert.deepEqual(csv.map((row) => row[2]), (await listed('sort=learner&order=asc')).map((c) => c.serialNumber), 'the export agrees');
    } finally {
      db.close();
    }
  });

  it('sorts course titles the same way - in the certificate list, the export and the course picker', async () => {
    const db = ctx.openDb();
    try {
      const tenant = { id: EAST, code: 'EAST', timezone: 'Australia/Sydney' };
      const titles = ['Zebra crossing', 'École de sécurité', 'ecole 2', 'ÉCOLE 3', 'ångström B', 'Ångström handling', 'safety 102', 'SAFETY 100'];
      db.transaction(() => {
        const learner = { id: insertLearner(db, EAST, 'Course Tester'), name: 'Course Tester' };
        for (const title of titles) {
          issueCertificate(db, {
            tenant,
            actor: { adminId: 1, email: ALICE },
            course: { id: insertCourse(db, EAST, title), title },
            learner,
            issuedAt: '2026-08-03T00:00:00Z',
          });
        }
      });
      const listed = async (query) => (await alice.get(`/api/certificates?pageSize=100&${query}`)).json.items;

      const all = await listed('');
      const expected = [...all].sort((a, b) => foldedCompare(a.courseTitle, b.courseTitle) || a.id - b.id);
      const ascending = await listed('sort=course&order=asc');
      assert.deepEqual(ascending.map((c) => c.id), expected.map((c) => c.id));
      assert.deepEqual((await listed('sort=course&order=desc')).map((c) => c.id), expected.map((c) => c.id).reverse());
      const distinct = [...new Set(ascending.map((c) => c.courseTitle))];
      assert.deepEqual(distinct, [
        'ångström B',
        'Ångström handling',
        'ecole 2',
        'ÉCOLE 3',
        'École de sécurité',
        'First Aid Refresher',
        'Forklift Operations',
        'SAFETY 100',
        'Safety 101',
        'safety 102',
        'Zebra crossing',
      ]);
      for (const order of ['asc', 'desc']) {
        const csv = parseCsv((await alice.get(`/api/certificates/export.csv?sort=course&order=${order}`)).text).slice(1);
        assert.deepEqual(csv.map((row) => row[2]), (await listed(`sort=course&order=${order}`)).map((c) => c.serialNumber), `export, ${order}`);
      }

      // The course picker of the bulk-issue page lists the same titles in the same order.
      const picker = (await alice.get('/api/courses')).json.items;
      assert.deepEqual(picker.map((course) => course.title), distinct);
    } finally {
      db.close();
    }
  });

  it('lists a course roster - and with it the outcomes of a bulk issue - by name, ignoring case and accents', async () => {
    const db = ctx.openDb();
    let courseId;
    try {
      const names = ['Zadie Smith', 'Émile Zola', 'emil zatopek', 'Ödön von Horváth', 'oscar wilde', 'ÉMILE ZOLA', 'Øyvind', 'Adam Smith'];
      db.transaction(() => {
        courseId = insertCourse(db, EAST, 'Roster order');
        for (const name of names) {
          db.run(
            `INSERT INTO enrollments (tenant_id, course_id, learner_id, status, completed_at, created_at)
             VALUES (@tenantId, @courseId, @learnerId, 'completed', '2026-08-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')`,
            { tenantId: EAST, courseId, learnerId: insertLearner(db, EAST, name) },
          );
        }
      });
    } finally {
      db.close();
    }
    const roster = (await alice.get(`/api/courses/${courseId}/enrollments`)).json.items;
    // Accented and unaccented spellings mix, equal names keep the order they were added in, and
    // nothing accented is pushed behind "z".
    assert.deepEqual(
      roster.map((row) => row.learnerName),
      ['Adam Smith', 'emil zatopek', 'Émile Zola', 'ÉMILE ZOLA', 'Ödön von Horváth', 'oscar wilde', 'Øyvind', 'Zadie Smith'],
    );
    // Pages are cut from the same order.
    const paged = [];
    for (const page of [1, 2, 3]) paged.push(...(await alice.get(`/api/courses/${courseId}/enrollments?pageSize=3&page=${page}`)).json.items);
    assert.deepEqual(paged.map((row) => row.learnerName), roster.map((row) => row.learnerName));

    const issued = await alice.bulkIssue(courseId, 'roster-order-1');
    assert.equal(issued.status, 201);
    assert.deepEqual(issued.json.results.map((result) => result.learnerName), roster.map((row) => row.learnerName));
  });
});

describe('export plumbing: connections, slots and stalled downloads', () => {
  let dir;
  let dbPath;
  let db;
  const apps = [];

  before(() => {
    dir = createTempDir();
    dbPath = path.join(dir, 'export.sqlite');
    db = openInitializedDatabase(dbPath);
  });
  after(async () => {
    for (const app of apps) await app.close();
    db.close();
    removeTempDir(dir);
  });

  /**
   * Stands in for a reader connection on a table that never ends, so that a download can be made
   * to stall. With `matching` false no row passes the request's filter: the export reads on and on
   * without ever having anything to send.
   */
  function endlessReader({ matching = true } = {}) {
    const row = {
      learner_name: 'x'.repeat(200),
      course_title: 'Endless',
      serial_number: 'E-1',
      issued_at: '2026-01-10T13:30:00.000Z',
      matches: matching ? 1 : 0,
    };
    const reader = {
      open: true,
      exec() {},
      iterate: () => ({ next: () => ({ done: false, value: row }), return: () => ({ done: true, value: undefined }) }),
      close() {
        reader.open = false;
      },
    };
    return reader;
  }

  /** The real app, in this process, with every export connection it opens on record. */
  async function startApp(options = {}) {
    const state = { readers: [], logged: [], endless: false, failToOpen: false };
    const app = createApp({
      db,
      openReader: () => {
        if (state.failToOpen) throw new Error('simulated failure to open the export connection');
        const reader = state.endless ? endlessReader({ matching: state.endless !== 'without matches' }) : openDatabase(dbPath, { queryOnly: true });
        state.readers.push(reader);
        return reader;
      },
      logger: { log: (...args) => state.logged.push(args.join(' ')), error: (...args) => state.logged.push(args.join(' ')) },
      ...options,
    });
    const server = await new Promise((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    state.baseUrl = `http://127.0.0.1:${server.address().port}`;
    state.slots = app.locals.exportSlots;
    state.close = async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    };
    apps.push(state);
    return state;
  }

  const allClosed = (app) => app.readers.every((reader) => reader.open === false);

  it('every export closes its connection: after a complete download and after an abandoned one', async () => {
    const app = await startApp();
    const complete = await clientFor(app.baseUrl, ALICE).get('/api/certificates/export.csv?sort=learner');
    assert.equal(complete.status, 200);
    assert.equal(parseCsv(complete.text).length - 1, SEED.east.certificateCount);
    assert.equal(app.readers.length, 1, 'one dedicated connection per export');
    await until(() => allClosed(app), { label: 'the connection of the finished export to be closed' });

    app.endless = true;
    const download = await openStream(app.baseUrl, '/api/certificates/export.csv', ALICE);
    assert.equal(app.readers.length, 2);
    assert.equal(app.readers[1].open, true, 'still streaming');
    download.abort(); // the client walks away mid-download
    await until(() => allClosed(app), { label: 'the connection of the abandoned export to be closed' });

    // A request that fails validation never opens one.
    assert.equal((await clientFor(app.baseUrl, ALICE).get('/api/certificates/export.csv?sort=bogus')).status, 400);
    assert.equal(app.readers.length, 2);
  });

  it('a download whose client stops reading is dropped after the idle timeout; one that keeps reading is not', async () => {
    const app = await startApp({ exportIdleTimeoutMs: 250 });
    app.endless = true;

    // Keeps reading for three times the timeout: must still be streaming.
    let received = 0;
    const reading = http.get(`${app.baseUrl}/api/certificates/export.csv`, { headers: { 'X-Actor-Email': ALICE } }, (res) => {
      res.on('data', (chunk) => (received += chunk.length));
      res.on('error', () => {});
    });
    reading.on('error', () => {});
    await new Promise((resolve) => setTimeout(resolve, 750));
    assert.equal(app.readers.length, 1);
    assert.equal(app.readers[0].open, true, 'a client that keeps reading is left alone');
    assert.ok(received > 1_000_000, `data kept flowing (${received} bytes)`);
    assert.deepEqual(app.logged, []);
    reading.destroy();
    await until(() => allClosed(app));

    // Stops reading after the first bytes: dropped, its connection closed, and the event logged.
    const stalled = await openStream(app.baseUrl, '/api/certificates/export.csv', ALICE);
    assert.equal(app.readers[1].open, true);
    await until(() => allClosed(app), { label: 'the stalled download to be dropped' });
    assert.ok(app.logged.some((line) => /\[export\] download dropped: the client took no more data for 250 ms/.test(line)), app.logged.join('\n'));
    await assert.rejects(stalled.resume(), 'the client sees a broken download, not a complete file');
  });

  it('only so many exports read at a time: the others wait their turn, and a full queue answers 503', async () => {
    const app = await startApp({ maxConcurrentExports: 1, exportIdleTimeoutMs: 0 });
    const alice = clientFor(app.baseUrl, ALICE);
    const exportUrl = `${app.baseUrl}/api/certificates/export.csv`;
    const headers = { 'X-Actor-Email': ALICE };

    app.endless = true;
    const holder = await openStream(app.baseUrl, '/api/certificates/export.csv', ALICE); // takes the only slot and stalls
    app.endless = false;

    const next = timed(() => alice.get('/api/certificates/export.csv?q=Alex%20Lee'));
    await until(() => app.slots.waiting === 1, { label: 'the second export to queue up' });
    assert.equal(await stillPending(next, 300), true, 'the second export waits for the slot');
    assert.deepEqual([app.slots.active, app.slots.waiting], [1, 1]);
    assert.equal(app.readers.length, 1, 'and holds no database connection while it waits');
    // Nothing else waits: other requests are served, and an invalid export is rejected straight away.
    assert.equal((await alice.get('/api/certificates')).status, 200);
    assert.equal((await alice.get('/api/certificates/export.csv?sort=bogus')).status, 400);

    // Fill the queue (32 may wait); the request after that is turned away instead of piling up.
    const giveUp = new AbortController();
    const queued = Array.from({ length: 31 }, () => fetch(exportUrl, { headers, signal: giveUp.signal }).catch((err) => err));
    await until(() => app.slots.waiting === 32, { label: 'the queue to fill up' });
    const turnedAway = fetch(exportUrl, { headers });
    turnedAway.catch(() => {}); // asserted on below
    assert.equal(await stillPending(turnedAway, 5_000), false, 'a request beyond the queue limit is answered, not queued');
    const overflow = await turnedAway;
    assert.equal(overflow.status, 503);
    assert.equal(overflow.headers.get('retry-after'), '5');
    assert.equal((await overflow.json()).error.code, 'export_busy');
    assert.deepEqual([app.slots.active, app.slots.waiting], [1, 32], 'the request that was turned away is not in the queue');

    // Waiting clients that give up leave the queue...
    giveUp.abort();
    assert.ok((await Promise.all(queued)).every((result) => result instanceof Error));
    await until(() => app.slots.waiting === 1, { label: 'the withdrawn requests to leave the queue' });
    // ...and when the slot is released, the export that waited longest gets it.
    holder.abort();
    assert.equal(await stillPending(next, 5_000), false, 'the waiting export is served once the slot is free');
    const { value: served } = await next;
    assert.equal(served.status, 200);
    assert.deepEqual(parseCsv(served.text).slice(1).map((row) => row[0]), ['Alex Lee']);

    const afterwards = alice.get('/api/certificates/export.csv');
    assert.equal(await stillPending(afterwards, 5_000), false, 'no slot is left occupied');
    assert.equal((await afterwards).status, 200);
    await until(() => allClosed(app));
    assert.equal(app.readers.length, 3, 'the turned-away and withdrawn requests never opened a connection');
    await until(() => app.slots.active === 0 && app.slots.waiting === 0, { label: 'every slot to be free again' });
    assert.deepEqual(app.logged, [], 'clients that leave the queue are not errors');
  });

  it('requests sent ahead on one connection (pipelining) hold no slot until they can be answered, and nothing once the connection is gone', async () => {
    const app = await startApp({ exportIdleTimeoutMs: 0 });
    assert.equal(app.slots.active, 0);

    // Five exports in one go; the client reads nothing, so the first answer stays in flight.
    app.endless = true;
    const impatient = await sendPipelined(app.baseUrl, Array(5).fill('/api/certificates/export.csv'), ALICE);
    await until(() => app.readers.length === 1, { label: 'the first of the five exports to start' });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(
      [app.slots.active, app.slots.waiting, app.readers.length],
      [1, 0, 1],
      'only the export that can actually send holds a slot and a connection; the four behind it hold nothing',
    );
    // ...so everybody else still gets served.
    app.endless = false;
    const somebodyElse = clientFor(app.baseUrl, ALICE).get('/api/certificates/export.csv');
    assert.equal(await stillPending(somebodyElse, 5_000), false);
    assert.equal((await somebodyElse).status, 200);

    impatient.close(); // with the first answer still in flight and four requests never answered
    await until(() => app.slots.active === 0 && app.slots.waiting === 0 && allClosed(app), {
      label: 'everything the closed connection held to be released',
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(app.readers.length, 2, 'the four queued exports never started');
    assert.deepEqual([app.slots.active, app.slots.waiting], [0, 0]);
    assert.deepEqual(app.logged, []);
  });

  it('pipelined requests that are read get their answers one after the other, each complete', async () => {
    const app = await startApp();
    const alice = clientFor(app.baseUrl, ALICE);
    const paths = [
      '/api/certificates/export.csv?sort=learner',
      '/api/certificates/export.csv?q=Alex%20Lee',
      '/api/certificates?pageSize=2&sort=serial',
      '/api/certificates/export.csv?status=revoked&sort=serial',
      '/api/certificates/export.csv?sort=bogus',
    ];
    const expected = [];
    for (const urlPath of paths) expected.push(await alice.get(urlPath));

    const client = await sendPipelined(app.baseUrl, paths, ALICE);
    const answers = await client.responses(paths.length);
    client.close();
    assert.deepEqual(answers.map((answer) => answer.status), [200, 200, 200, 200, 400]);
    assert.deepEqual(answers.map((answer) => answer.body), expected.map((answer) => answer.text));
    await until(() => app.slots.active === 0 && allClosed(app));
    assert.equal(app.readers.length, 6, 'three exports each time, one connection each');
  });

  it('a pipelining client that never reads is dropped after the idle timeout, with everything it held', async () => {
    const app = await startApp({ exportIdleTimeoutMs: 250 });
    app.endless = true;
    const silent = await sendPipelined(app.baseUrl, Array(3).fill('/api/certificates/export.csv'), ALICE);
    await until(() => app.readers.length === 1);
    await until(() => app.slots.active === 0 && app.slots.waiting === 0 && allClosed(app), {
      label: 'the silent connection to be dropped and its export closed',
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(app.readers.length, 1, 'the exports queued behind the stalled one never started');
    assert.equal(app.logged.filter((line) => line.includes('download dropped')).length, 1, app.logged.join('\n'));
    silent.close();
  });

  it('an export nobody is waiting for any more stops reading, even when it has nothing to send', async () => {
    const app = await startApp({ maxConcurrentExports: 1, exportIdleTimeoutMs: 0 });
    // No row matches the search: after the header the export scans on without producing a chunk.
    app.endless = 'without matches';
    const download = await openStream(app.baseUrl, '/api/certificates/export.csv?q=no-such-learner', ALICE);
    assert.equal(download.status, 200);
    assert.deepEqual([app.slots.active, app.readers[0].open], [1, true], 'still scanning');

    download.abort();
    await until(() => allClosed(app) && app.slots.active === 0, { label: 'the abandoned scan to stop and free the only slot' });
    app.endless = false;
    assert.equal((await clientFor(app.baseUrl, ALICE).get('/api/certificates/export.csv')).status, 200);
  });

  it('HEAD announces the download without running it', async () => {
    const app = await startApp({ maxConcurrentExports: 1, exportIdleTimeoutMs: 0 });
    const exportUrl = `${app.baseUrl}/api/certificates/export.csv`;
    const head = (url, headers = { 'X-Actor-Email': ALICE }) => fetch(url, { method: 'HEAD', headers });

    app.endless = true;
    const holder = await openStream(app.baseUrl, '/api/certificates/export.csv', ALICE); // the only slot is taken
    app.endless = false;

    const announced = head(`${exportUrl}?q=Alex%20Lee&sort=learner`);
    assert.equal(await stillPending(announced, 5_000), false, 'answered although no slot is free');
    const res = await announced;
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/csv; charset=utf-8');
    assert.match(res.headers.get('content-disposition'), /^attachment; filename="certificates-east-\d{8}-\d{4}\.csv"$/);
    assert.equal(res.headers.get('x-tenant-timezone'), 'Australia/Sydney');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(await res.text(), '');
    assert.deepEqual([app.slots.active, app.slots.waiting, app.readers.length], [1, 0, 1], 'no slot, no queue, no connection');

    // It is checked like the download itself.
    assert.equal((await head(`${exportUrl}?sort=bogus`)).status, 400);
    assert.equal((await head(exportUrl, {})).status, 401);

    holder.abort();
    await until(() => allClosed(app) && app.slots.active === 0);
  });

  it('an export that cannot even start gives its slot back and answers with a proper error', async () => {
    const app = await startApp({ maxConcurrentExports: 1, exportIdleTimeoutMs: 0 });
    const alice = clientFor(app.baseUrl, ALICE);

    app.failToOpen = true;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const failed = alice.get('/api/certificates/export.csv');
      assert.equal(await stillPending(failed, 5_000), false, `attempt ${attempt + 1} is answered`);
      const res = await failed;
      assert.equal(res.status, 500);
      assert.equal(res.json.error.code, 'internal_error', 'a JSON error, not a truncated CSV');
      assert.ok(!res.text.includes('simulated'), 'without internal details');
    }
    assert.ok(app.logged.some((line) => line.includes('simulated failure to open the export connection')), 'the cause is in the server log');

    assert.deepEqual([app.slots.active, app.slots.waiting], [0, 0], 'the only slot was not left occupied by the failures');

    app.failToOpen = false;
    const ok = alice.get('/api/certificates/export.csv');
    assert.equal(await stillPending(ok, 5_000), false);
    assert.equal((await ok).status, 200);
    await until(() => allClosed(app));
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

      // The address is claimed before the database is opened: a start that fails on the port
      // says so in one line and does not leave a new database file behind.
      const neverCreated = path.join(dir, 'port-never-created.sqlite');
      const second = await runServerToExit(neverCreated, { env: { PORT: port } });
      assert.equal(second.code, 1);
      assert.equal(second.output.trim(), `Port ${port} is already in use. Stop the other process or run with PORT=<free port>.`);
      assert.equal(fs.existsSync(neverCreated), false);
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

  it('every setting is checked before anything starts, each with its own one-line message', async () => {
    const dbPath = path.join(dir, 'never-created.sqlite');
    for (const [name, value, message] of [
      ['DB_BUSY_TIMEOUT_MS', 'abc', /^DB_BUSY_TIMEOUT_MS must be an integer between 0 and 600000 milliseconds \(got "abc"\)$/m],
      ['DB_BUSY_TIMEOUT_MS', '-1', /^DB_BUSY_TIMEOUT_MS must be an integer/m],
      ['SQLITE_DRIVER', 'postgres', /^Unsupported SQLITE_DRIVER "postgres"/m],
      ['EXPORT_MAX_CONCURRENT', '0', /^EXPORT_MAX_CONCURRENT must be an integer between 1 and 64 \(got "0"\)$/m],
      ['EXPORT_IDLE_TIMEOUT_MS', 'never', /^EXPORT_IDLE_TIMEOUT_MS must be an integer/m],
      // numbers are plain decimal digits: nothing that merely converts to a number is accepted
      ['PORT', '0x1F90', /^PORT must be an integer between 0 and 65535 \(got "0x1F90"\)$/m],
      ['PORT', '0b1', /^PORT must be an integer/m],
      ['DB_BUSY_TIMEOUT_MS', '1e3', /^DB_BUSY_TIMEOUT_MS must be an integer/m],
      ['EXPORT_MAX_CONCURRENT', '2.0', /^EXPORT_MAX_CONCURRENT must be an integer/m],
    ]) {
      const { code, output } = await runServerToExit(dbPath, { env: { [name]: value } });
      assert.equal(code, 1, `${name}=${value}`);
      assert.match(output, message, `${name}=${value}`);
      assert.doesNotMatch(output, /^\s+at |node:internal|Node\.js v/m, `${name}=${value}: no stack trace`);
      assert.equal(output.trim().split('\n').length, 1, `${name}=${value}: one line, got:\n${output}`);
    }
    assert.equal(fs.existsSync(dbPath), false, 'nothing was created along the way');

    // A setting that is present but blank means "not set" - every one of them.
    const blank = await startServer(dbPath, {
      env: { SQLITE_DRIVER: '', DB_BUSY_TIMEOUT_MS: ' ', EXPORT_MAX_CONCURRENT: '', EXPORT_IDLE_TIMEOUT_MS: '', LOG_REQUESTS: '' },
    });
    try {
      assert.equal((await clientFor(blank.baseUrl, ALICE).get('/api/certificates')).json.total, SEED.east.certificateCount);
    } finally {
      await blank.stop();
    }
  });

  it('the command-line scripts report mistakes briefly, without a stack trace, and change nothing', async () => {
    const dbPath = path.join(dir, 'cli.sqlite');
    await runScript('init-db.js', ['--db', dbPath]);
    const pristine = fs.readFileSync(dbPath);
    const notADatabase = path.join(dir, 'cli-not-a-database.sqlite');
    fs.writeFileSync(notADatabase, 'plain text, not SQLite\n'.repeat(200));
    const fallbackDb = path.join(dir, 'cli-fallback.sqlite');
    const emptyFile = path.join(dir, 'cli-empty.sqlite'); // e.g. left behind by "touch": a database yet to be created
    fs.writeFileSync(emptyFile, '');

    for (const [script, args, env, message] of [
      ['generate-certificates.js', ['--db', dbPath, '--bogus'], {}, /Unknown option '--bogus'[\s\S]*Usage: /],
      ['generate-certificates.js', ['--db', dbPath, 'stray'], {}, /Usage: /],
      ['generate-certificates.js', ['--db', dbPath, '--count', '-5'], {}, /--count[\s\S]*Usage: /],
      ['generate-certificates.js', ['--db', dbPath, '--count', '0'], {}, /^--count must be a whole number between 1 and 2,000,000 \(got "0"\)$/m],
      ['generate-certificates.js', ['--db', dbPath, '--count', '2000001'], {}, /^--count must be a whole number between 1 and 2,000,000/m],
      ['generate-certificates.js', ['--db', dbPath, '--count', 'lots'], {}, /^--count must be a whole number/m],
      ['generate-certificates.js', ['--db', dbPath, '--seed', 'x'], {}, /--seed must be an integer/],
      ['generate-certificates.js', ['--db', dbPath, '--tenant', 'North'], {}, /Unknown tenant "North"/],
      ['generate-certificates.js', ['--db', dir], {}, /Could not open the database at /],
      ['generate-certificates.js', ['--db', notADatabase], {}, /Could not open the database at /],
      ['generate-certificates.js', ['--db', dbPath], { DB_BUSY_TIMEOUT_MS: 'abc' }, /^DB_BUSY_TIMEOUT_MS must be an integer/m],
      ['init-db.js', ['--db', dbPath, '--bogus'], {}, /Unknown option '--bogus'[\s\S]*Usage: /],
      ['init-db.js', ['--db', notADatabase], {}, /Could not open the database at /],
      ['init-db.js', ['--db', dbPath], { SQLITE_DRIVER: 'postgres' }, /^Unsupported SQLITE_DRIVER/m],
      // An empty --db (an unset shell variable, typically) is a mistake, not "use the default database".
      ['generate-certificates.js', ['--db', '', '--clear'], {}, /^--db needs a path/m],
      ['generate-certificates.js', ['--db='], {}, /^--db needs a path/m],
      ['init-db.js', ['--db', '', '--reset'], {}, /^--db needs a path/m],
      ['init-db.js', ['--db=  '], {}, /^--db needs a path/m],
      // Mistakes that are noticed before a database that does not exist yet would be created.
      ['generate-certificates.js', ['--db', path.join(dir, 'cli-new-1.sqlite'), '--tenant', 'North'], {}, /^Unknown tenant "North" \(a new database has the tenants East and West\)$/m],
      ['generate-certificates.js', ['--db', path.join(dir, 'cli-new-2.sqlite'), '--count', '2000001'], {}, /^--count must be a whole number/m],
      ['generate-certificates.js', ['--db', path.join(dir, 'cli-new-3.sqlite'), '--clear', '--tenant', 'Nowhere'], {}, /^Unknown tenant "Nowhere"/m],
      ['generate-certificates.js', ['--db', emptyFile, '--tenant', 'North'], {}, /^Unknown tenant "North" \(a new database/m],
    ]) {
      const label = `${script} ${args.slice(2).join(' ')} ${JSON.stringify(env)}`;
      // DB_PATH names the file the scripts would fall back to; none of these mistakes may reach it.
      const { code, output } = await runScriptToExit(script, args, { env: { DB_PATH: fallbackDb, ...env } });
      assert.equal(code, 1, label);
      assert.match(output, message, label);
      assert.doesNotMatch(output, /^\s+at |node:internal|Node\.js v/m, `${label}: no stack trace`);
      assert.ok(output.trim().split('\n').length <= 4, `${label}: brief, got:\n${output}`);
    }
    assert.ok(fs.readFileSync(dbPath).equals(pristine), 'the database file is byte for byte what it was');
    assert.deepEqual(
      fs.readdirSync(dir).filter((name) => name.startsWith('cli-new-') || name.startsWith('cli-fallback')),
      [],
      'and no new database file was created for a command that was refused',
    );
    assert.equal(fs.statSync(emptyFile).size, 0, 'nor was the empty file turned into one');
    assert.match(await runScript('generate-certificates.js', ['--help']), /^Usage: /);
  });

  it('the load-test generator leaves every quick-start row alone - serial counters included - and repeats itself exactly', async () => {
    const dbPath = path.join(dir, 'generator.sqlite');
    await runScript('init-db.js', ['--db', dbPath]);
    const db = openDatabase(dbPath);
    const TABLES = ['tenants', 'admins', 'courses', 'learners', 'enrollments', 'bulk_issue_operations', 'certificates', 'audit_events'];
    const dump = () => Object.fromEntries(TABLES.map((table) => [table, db.all(`SELECT * FROM ${table} ORDER BY id`).map((row) => ({ ...row }))]));
    const assertSameDatabase = (actual, expected, label) => {
      for (const table of TABLES) assertSameRows(actual[table], expected[table], `${label}: ${table}`);
    };
    const quickStartRows = (all) => {
      const courses = new Set(all.courses.filter((c) => c.is_generated === 0).map((c) => c.id));
      const certificates = all.certificates.filter((c) => courses.has(c.course_id));
      const certificateIds = new Set(certificates.map((c) => c.id));
      return {
        ...all,
        courses: all.courses.filter((c) => c.is_generated === 0),
        learners: all.learners.filter((l) => l.is_generated === 0),
        enrollments: all.enrollments.filter((e) => courses.has(e.course_id)),
        certificates,
        audit_events: all.audit_events.filter((e) => certificateIds.has(e.certificate_id)),
      };
    };
    /** The generated rows without the ids SQLite hands out (those move on when a set is replaced). */
    const generatedContent = () =>
      db
        .all(
          `SELECT serial_number, learner_name, course_title, learner_name_key, course_title_key, status, issued_at,
                  issued_local_date, revoked_at, revocation_reason
             FROM certificates WHERE serial_number LIKE 'EAST-LT-%' ORDER BY id`,
        )
        .map((row) => ({ ...row }));
    try {
      const pristine = dump();
      assert.deepEqual(pristine.tenants.map((t) => [t.name, t.last_serial]), [['East', 7], ['West', 4]]);

      await runScript('generate-certificates.js', ['--db', dbPath, '--count', '300']);
      const first = generatedContent();
      assert.equal(first.length, 300);
      assert.deepEqual([first[0].serial_number, first[299].serial_number], ['EAST-LT-0000001', 'EAST-LT-0000300']);
      assert.equal(new Set(first.map((row) => row.serial_number)).size, 300);
      assertSameDatabase(quickStartRows(dump()), pristine, 'after generating');

      // Generated names are stored with their folded form, like every other name.
      for (const row of first) {
        assert.equal(row.learner_name_key, referenceFold(row.learner_name), row.serial_number);
        assert.equal(row.course_title_key, referenceFold(row.course_title), row.serial_number);
      }
      const generatedNames = db.all(
        `SELECT full_name AS name, name_key AS key FROM learners WHERE is_generated = 1
         UNION ALL SELECT title, title_key FROM courses WHERE is_generated = 1`,
      );
      assert.ok(generatedNames.length > 30);
      for (const { name, key } of generatedNames) assert.equal(key, referenceFold(name), name);

      // A second run replaces the set with the very same rows, serial numbers included.
      await runScript('generate-certificates.js', ['--db', dbPath, '--count', '300']);
      assertSameRows(generatedContent(), first, 'second run');
      assert.equal(db.get('SELECT COUNT(*) AS n FROM certificates').n, 11 + 300);
      // Another seed gives other rows; West is never touched.
      await runScript('generate-certificates.js', ['--db', dbPath, '--count', '300', '--seed', '7']);
      assert.notDeepEqual(generatedContent().map((row) => row.learner_name), first.map((row) => row.learner_name));
      assertSameDatabase(quickStartRows(dump()), pristine, 'after three runs');

      // With the load-test data in place the app still hands out the serial number the README promises.
      const server = await startServer(dbPath);
      try {
        const alice = clientFor(server.baseUrl, ALICE);
        assert.equal((await alice.get('/api/certificates')).json.total, 7 + 300);
        const issued = (await alice.bulkIssue(SEED.east.firstAid, 'next-serial')).json.results.find((r) => r.outcome === 'issued');
        assert.equal(issued.serialNumber, 'EAST-0000008');
        assert.equal((await alice.get('/api/certificates?q=east-lt-0000300')).json.total, 1);
      } finally {
        await server.stop();
      }

      // --clear takes the database back to exactly the quick-start rows (plus what the app itself wrote since).
      const beforeClear = quickStartRows(dump());
      assert.match(await runScript('generate-certificates.js', ['--db', dbPath, '--clear']), /Removed 300 generated certificates/);
      assertSameDatabase(dump(), beforeClear, 'after --clear');
      assert.equal(db.get('SELECT last_serial FROM tenants WHERE id = 1').last_serial, 8, 'only the certificate issued through the app moved the counter');
    } finally {
      db.close();
    }
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

  it('db:reset says so when a reader keeps the files from shrinking for the moment', async () => {
    const dbPath = path.join(dir, 'reset-reader.sqlite');
    await runScript('init-db.js', ['--db', dbPath]);
    await runScript('generate-certificates.js', ['--db', dbPath, '--count', '3000']);
    const reader = openDatabase(dbPath, { queryOnly: true });
    const certificates = () => reader.get('SELECT COUNT(*) AS n FROM certificates').n;
    try {
      reader.exec('BEGIN'); // what a download in progress does: it reads from one snapshot until it is done
      assert.equal(certificates(), 3011);

      const output = await runScript('init-db.js', ['--reset', '--db', dbPath]);
      assert.match(output, /Demo data restored/);
      assert.match(output, /still reads the old data; the files shrink with the next writes after it has finished/);
      assert.equal(certificates(), 3011, 'the reader keeps its snapshot');
      reader.exec('COMMIT');
      assert.equal(certificates(), 11, 'and sees the restored data afterwards');
    } finally {
      reader.close();
    }
    assert.doesNotMatch(await runScript('init-db.js', ['--reset', '--db', dbPath]), /shrink/, 'no such remark when nothing is in the way');
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
