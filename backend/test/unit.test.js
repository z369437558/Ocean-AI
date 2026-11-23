import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { migrate } from '../src/db/schema.js';
import { seedDemoData } from '../src/db/seed.js';
import { TransactionAbortedError, openDatabase } from '../src/db/sqlite.js';
import { csvCell, csvRow } from '../src/lib/csv.js';
import { canonicalJson, requestFingerprint } from '../src/lib/fingerprint.js';
import { localDate, localDateTime, utcOffset } from '../src/lib/time.js';
import { parseListQuery } from '../src/services/certificates.js';
import { classifyEnrollment } from '../src/services/courses.js';
import { createTempDir, parseCsv, removeTempDir } from './helpers.js';

describe('time zones (A5)', () => {
  it('converts the reference instant to each tenant-local wall clock', () => {
    const instant = '2026-01-10T13:30:00Z';
    assert.equal(localDateTime(instant, 'Australia/Sydney'), '2026-01-11 00:30');
    assert.equal(localDateTime(instant, 'Australia/Perth'), '2026-01-10 21:30');
    assert.equal(localDate(instant, 'Australia/Sydney'), '2026-01-11');
    assert.equal(localDate(instant, 'Australia/Perth'), '2026-01-10');
  });

  it('applies daylight saving for Sydney and none for Perth', () => {
    assert.equal(utcOffset('2026-01-10T13:30:00Z', 'Australia/Sydney'), '+11:00'); // AEDT (summer)
    assert.equal(utcOffset('2026-07-10T13:30:00Z', 'Australia/Sydney'), '+10:00'); // AEST (winter)
    assert.equal(localDateTime('2026-07-10T13:30:00Z', 'Australia/Sydney'), '2026-07-10 23:30');
    assert.equal(utcOffset('2026-01-10T13:30:00Z', 'Australia/Perth'), '+08:00');
    assert.equal(utcOffset('2026-07-10T13:30:00Z', 'Australia/Perth'), '+08:00');
  });

  it('handles both daylight-saving transitions of 2026 in Sydney', () => {
    // Clocks go back at 16:00Z on 4 April: 02:30 happens twice.
    assert.equal(localDateTime('2026-04-04T15:30:00Z', 'Australia/Sydney'), '2026-04-05 02:30');
    assert.equal(utcOffset('2026-04-04T15:30:00Z', 'Australia/Sydney'), '+11:00');
    assert.equal(localDateTime('2026-04-04T16:30:00Z', 'Australia/Sydney'), '2026-04-05 02:30');
    assert.equal(utcOffset('2026-04-04T16:30:00Z', 'Australia/Sydney'), '+10:00');
    // Clocks go forward at 16:00Z on 3 October: 02:xx does not exist.
    assert.equal(localDateTime('2026-10-03T15:59:00Z', 'Australia/Sydney'), '2026-10-04 01:59');
    assert.equal(localDateTime('2026-10-03T16:00:00Z', 'Australia/Sydney'), '2026-10-04 03:00');
  });

  it('formats midnight as 00, never 24, and rolls the date over year boundaries', () => {
    assert.equal(localDateTime('2026-06-30T14:00:00Z', 'Australia/Sydney'), '2026-07-01 00:00');
    assert.equal(localDateTime('2026-12-31T13:00:00Z', 'Australia/Sydney'), '2027-01-01 00:00');
    assert.equal(localDateTime('2026-12-31T16:00:00Z', 'Australia/Perth'), '2027-01-01 00:00');
  });

  it('rejects invalid input instead of producing garbage', () => {
    assert.throws(() => localDateTime('not a date', 'Australia/Sydney'), RangeError);
    assert.throws(() => localDateTime('2026-01-10T13:30:00Z', 'Mars/Olympus_Mons'), RangeError);
  });
});

describe('CSV encoding', () => {
  it('quotes separators, quotes and line breaks', () => {
    assert.equal(csvCell('plain'), 'plain');
    assert.equal(csvCell('Reyes, Dana'), '"Reyes, Dana"');
    assert.equal(csvCell('Dana "DJ" Reyes'), '"Dana ""DJ"" Reyes"');
    assert.equal(csvCell('two\nlines'), '"two\nlines"');
    assert.equal(csvCell(null), '');
    assert.equal(csvRow(['a', 'b,c', 3]), 'a,"b,c",3\n');
  });

  it('neutralises spreadsheet formulas', () => {
    assert.equal(csvCell('=HYPERLINK("http://evil.test")'), `"'=HYPERLINK(""http://evil.test"")"`);
    assert.equal(csvCell('+61 400 000 000'), "'+61 400 000 000");
    assert.equal(csvCell('@handle'), "'@handle");
    assert.equal(csvCell('-1'), "'-1");
    assert.equal(csvCell('2026-01-11 00:30'), '2026-01-11 00:30');
  });

  it('round-trips through a CSV parser', () => {
    const cells = ['O\'Connor, "Mac"', 'Line\nbreak', 'Müller', ''];
    assert.deepEqual(parseCsv(csvRow(cells)), [cells]);
  });
});

describe('request fingerprint (A3)', () => {
  it('ignores key order and whitespace but not values', () => {
    assert.equal(canonicalJson({ b: 1, a: [1, { d: 2, c: 3 }] }), '{"a":[1,{"c":3,"d":2}],"b":1}');
    const base = requestFingerprint('POST', '/api/bulk-issues', { courseId: 1, note: 'x' });
    assert.equal(requestFingerprint('post', '/api/bulk-issues', { note: 'x', courseId: 1 }), base);
    assert.notEqual(requestFingerprint('POST', '/api/bulk-issues', { courseId: 2, note: 'x' }), base);
    assert.notEqual(requestFingerprint('POST', '/api/bulk-issues', { courseId: 1 }), base);
    assert.notEqual(requestFingerprint('POST', '/api/bulk-issues', { courseId: '1', note: 'x' }), base);
    assert.notEqual(requestFingerprint('POST', '/api/bulk-issues', undefined), base);
  });
});

describe('list query parsing', () => {
  it('applies defaults', () => {
    assert.deepEqual(parseListQuery({}), { q: '', status: 'all', sort: 'issued', order: 'desc', page: 1, pageSize: 25 });
    assert.deepEqual(parseListQuery({ sort: 'learner' }).order, 'asc');
  });

  it('accepts aliases and a leading minus for descending', () => {
    assert.equal(parseListQuery({ sort: 'serial_number' }).sort, 'serial');
    assert.equal(parseListQuery({ sort: 'learnerName', order: 'DESC' }).order, 'desc');
    assert.deepEqual(
      (({ sort, order }) => ({ sort, order }))(parseListQuery({ sort: '-issued_at' })),
      { sort: 'issued', order: 'desc' },
    );
    assert.equal(parseListQuery({ search: '  lee ' }).q, 'lee');
  });

  it('rejects values it does not understand', () => {
    for (const query of [
      { sort: 'tenant_id' },
      { order: 'sideways' },
      { status: 'deleted' },
      { page: '0' },
      { page: '1.5' },
      { pageSize: '101' },
      { pageSize: '-1' },
      { q: 'x'.repeat(101) },
      { q: ['a', 'b'] },
    ]) {
      assert.throws(() => parseListQuery(query), (err) => err.status === 400, JSON.stringify(query));
    }
  });
});

describe('eligibility rules (A4)', () => {
  const row = (overrides) => ({
    enrollment_status: 'completed',
    certificate_id: null,
    certificate_status: null,
    serial_number: null,
    ...overrides,
  });

  it('is eligible only when completed and never certified', () => {
    assert.equal(classifyEnrollment(row({})).eligible, true);
    assert.equal(classifyEnrollment(row({ enrollment_status: 'in_progress' })).reason, 'not_completed');
    assert.equal(classifyEnrollment(row({ enrollment_status: 'not_started' })).reason, 'not_completed');
    assert.equal(
      classifyEnrollment(row({ certificate_id: 5, certificate_status: 'active', serial_number: 'X-1' })).reason,
      'already_certified',
    );
    assert.equal(
      classifyEnrollment(row({ certificate_id: 5, certificate_status: 'revoked', serial_number: 'X-1' })).reason,
      'certificate_revoked',
    );
  });

  it('explains every skip in words', () => {
    for (const overrides of [
      { enrollment_status: 'in_progress' },
      { certificate_id: 5, certificate_status: 'active', serial_number: 'X-1' },
      { certificate_id: 5, certificate_status: 'revoked', serial_number: 'X-1' },
    ]) {
      const verdict = classifyEnrollment(row(overrides));
      assert.equal(verdict.eligible, false);
      assert.ok(verdict.message.length > 10);
    }
  });
});

describe('database layer', () => {
  let dir;
  let db;

  before(() => {
    dir = createTempDir();
    db = openDatabase(path.join(dir, 'unit.sqlite'));
    migrate(db);
    seedDemoData(db);
  });

  after(() => {
    db.close();
    removeTempDir(dir);
  });

  const tenantCount = () => db.get('SELECT COUNT(*) AS n FROM tenants').n;
  const addTenant = (name) =>
    db.run("INSERT INTO tenants (name, code, timezone, created_at) VALUES (@name, @name, 'UTC', '2026-01-01T00:00:00.000Z')", { name });

  it('refuses in-memory databases (storage must be persistent)', () => {
    assert.throws(() => openDatabase(':memory:'), /file path is required/);
  });

  it('rolls back the whole transaction when the callback throws', () => {
    const before = tenantCount();
    assert.throws(() =>
      db.transaction(() => {
        addTenant('T1');
        throw new Error('boom');
      }),
    );
    assert.equal(tenantCount(), before);
    assert.equal(db.inTransaction, false);
  });

  it('contains a failed nested unit of work in a savepoint', () => {
    const before = tenantCount();
    db.transaction(() => {
      addTenant('KEEP1');
      assert.throws(() =>
        db.transaction(() => {
          addTenant('DROP');
          addTenant('DROP'); // UNIQUE violation
        }),
      );
      addTenant('KEEP2');
    });
    assert.equal(tenantCount(), before + 2);
    assert.equal(db.get("SELECT COUNT(*) AS n FROM tenants WHERE name = 'DROP'").n, 0);
    db.run("DELETE FROM tenants WHERE name IN ('KEEP1', 'KEEP2')");
  });

  it('rejects asynchronous transaction callbacks', () => {
    assert.throws(() => db.transaction(async () => {}), /synchronous/);
    assert.equal(db.inTransaction, false);
  });

  it('exposes TransactionAbortedError for fatal mid-transaction failures', () => {
    assert.ok(new TransactionAbortedError(new Error('disk full')) instanceof Error);
  });

  it('enforces tenant boundaries in the schema itself', () => {
    const eastCourse = db.get("SELECT id FROM courses WHERE tenant_id = 1 AND title = 'Safety 101'").id;
    const westLearner = db.get("SELECT id FROM learners WHERE tenant_id = 2 AND full_name = 'Jordan Smith'").id;
    // A West learner cannot be enrolled in - or certified for - an East course, whatever tenant_id says.
    for (const tenantId of [1, 2]) {
      assert.throws(
        () =>
          db.run(
            `INSERT INTO enrollments (tenant_id, course_id, learner_id, status, created_at)
             VALUES (@tenantId, @courseId, @learnerId, 'in_progress', '2026-01-01T00:00:00.000Z')`,
            { tenantId, courseId: eastCourse, learnerId: westLearner },
          ),
        /FOREIGN KEY/i,
      );
      assert.throws(
        () =>
          db.run(
            `INSERT INTO certificates (tenant_id, course_id, learner_id, serial_number, learner_name, course_title, issued_at, issued_local_date)
             VALUES (@tenantId, @courseId, @learnerId, 'X-1', 'Jordan Smith', 'Safety 101', '2026-01-01T00:00:00.000Z', '2026-01-01')`,
            { tenantId, courseId: eastCourse, learnerId: westLearner },
          ),
        /FOREIGN KEY/i,
      );
    }
  });

  it('allows at most one certificate per learner and course', () => {
    const existing = db.get('SELECT tenant_id, course_id, learner_id FROM certificates WHERE id = 1');
    assert.throws(
      () =>
        db.run(
          `INSERT INTO certificates (tenant_id, course_id, learner_id, serial_number, learner_name, course_title, issued_at, issued_local_date)
           VALUES (@tenant_id, @course_id, @learner_id, 'DUP-1', 'Alex Lee', 'Safety 101', '2026-01-01T00:00:00.000Z', '2026-01-01')`,
          { tenant_id: existing.tenant_id, course_id: existing.course_id, learner_id: existing.learner_id },
        ),
      /UNIQUE/i,
    );
  });

  it('seeds the quick-start scenario required by the spec', () => {
    const tenants = db.all('SELECT name, timezone FROM tenants ORDER BY id').map((t) => ({ ...t }));
    assert.deepEqual(tenants, [
      { name: 'East', timezone: 'Australia/Sydney' },
      { name: 'West', timezone: 'Australia/Perth' },
    ]);
    const admins = db
      .all('SELECT a.email, t.name AS tenant FROM admins a JOIN tenants t ON t.id = a.tenant_id ORDER BY a.id')
      .map((a) => ({ ...a }));
    assert.deepEqual(admins, [
      { email: 'alice@east.test', tenant: 'East' },
      { email: 'bob@west.test', tenant: 'West' },
    ]);

    for (const tenantId of [1, 2]) {
      const alex = db.all("SELECT id FROM learners WHERE tenant_id = @tenantId AND full_name = 'Alex Lee'", { tenantId });
      assert.equal(alex.length, 1, 'exactly one Alex Lee per tenant');

      const roster = db.all(
        `SELECT e.status, c.id AS certificate_id
           FROM enrollments e
           JOIN courses co ON co.id = e.course_id
           LEFT JOIN certificates c ON c.course_id = e.course_id AND c.learner_id = e.learner_id
          WHERE e.tenant_id = @tenantId AND co.title = 'Safety 101'`,
        { tenantId },
      );
      const certified = roster.filter((r) => r.certificate_id !== null).length;
      const eligible = roster.filter((r) => r.status === 'completed' && r.certificate_id === null).length;
      const incomplete = roster.filter((r) => r.status !== 'completed').length;
      assert.ok(certified >= 1 && eligible >= 1 && incomplete >= 1, 'Safety 101 covers all three enrollment kinds');

      // Alex Lee personally has a certified, a completed-but-uncertified and an incomplete enrollment.
      const alexEnrollments = db.all(
        `SELECT e.status, c.id AS certificate_id
           FROM enrollments e
           LEFT JOIN certificates c ON c.course_id = e.course_id AND c.learner_id = e.learner_id
          WHERE e.learner_id = @learnerId`,
        { learnerId: alex[0].id },
      );
      assert.ok(alexEnrollments.some((e) => e.certificate_id !== null));
      assert.ok(alexEnrollments.some((e) => e.status === 'completed' && e.certificate_id === null));
      assert.ok(alexEnrollments.some((e) => e.status !== 'completed'));
    }

    // Every seeded certificate has exactly one issuance audit event; revoked ones also one revocation.
    const mismatches = db.all(
      `SELECT c.id FROM certificates c
        WHERE (SELECT COUNT(*) FROM audit_events a WHERE a.certificate_id = c.id AND a.action = 'certificate.issued') <> 1
           OR (SELECT COUNT(*) FROM audit_events a WHERE a.certificate_id = c.id AND a.action = 'certificate.revoked')
              <> (c.status = 'revoked')`,
    );
    assert.deepEqual(mismatches, []);
  });
});
