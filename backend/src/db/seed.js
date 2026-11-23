/**
 * Quick-start demo data: two tenants, one admin each, a handful of courses and learners.
 *
 * Both tenants have a "Safety 101" course whose roster covers every bulk-issue outcome
 * (already certified, completed and eligible, incomplete), and both have a learner called
 * "Alex Lee" who holds a Safety 101 certificate issued at 2026-01-10T13:30:00Z - an instant that
 * falls on different calendar days in Sydney (AEDT, +11:00) and Perth (AWST, +08:00).
 *
 * All timestamps are fixed, so a freshly seeded database is identical on every machine.
 */
import { isValidTimeZone } from '../lib/time.js';
import { issueCertificate, revokeCertificate } from '../services/ledger.js';

export const DEMO_REFERENCE_INSTANT = '2026-01-10T13:30:00.000Z';

const SEEDED_AT = '2026-01-05T00:00:00.000Z';

/** Enrollment shorthand: [learner, status, completedAt?, certificate?] */
const DEMO_TENANTS = [
  {
    name: 'East',
    code: 'EAST',
    timezone: 'Australia/Sydney',
    admin: { email: 'alice@east.test', displayName: 'Alice (East admin)' },
    learners: ['Alex Lee', 'Priya Sharma', "Marcus O'Connor", 'Mei Chen', 'Tom Walker', 'Sofia Rossi', 'José Álvarez'],
    courses: [
      {
        title: 'Safety 101',
        enrollments: [
          // already certified - the DST reference certificate (Sydney: 2026-01-11 00:30)
          ['Alex Lee', 'completed', '2026-01-09T04:10:00.000Z', { issuedAt: DEMO_REFERENCE_INSTANT }],
          ['Priya Sharma', 'completed', '2026-11-17T23:40:00.000Z'], // eligible
          ["Marcus O'Connor", 'completed', '2026-11-19T02:05:00.000Z'], // eligible
          ['Mei Chen', 'in_progress'], // incomplete
          ['Tom Walker', 'not_started'], // incomplete
        ],
      },
      {
        title: 'First Aid Refresher',
        enrollments: [
          ['Alex Lee', 'completed', '2026-11-12T05:30:00.000Z'], // eligible
          [
            'Mei Chen',
            'completed',
            '2026-02-13T03:00:00.000Z',
            {
              issuedAt: '2026-02-14T22:15:00.000Z',
              revoked: { at: '2026-03-02T01:00:00.000Z', reason: 'Issued in error: assessment was not signed off' },
            },
          ],
          // These two straddle the end of daylight saving in Sydney (2026-04-05 03:00 AEDT -> 02:00 AEST):
          // one hour apart in UTC, yet both read "2026-04-05 02:30" on the wall clock.
          ['Sofia Rossi', 'completed', '2026-04-03T06:00:00.000Z', { issuedAt: '2026-04-04T15:30:00.000Z' }],
          ['José Álvarez', 'completed', '2026-04-03T07:20:00.000Z', { issuedAt: '2026-04-04T16:30:00.000Z' }],
          ['Priya Sharma', 'in_progress'],
        ],
      },
      {
        title: 'Forklift Operations',
        enrollments: [
          ['Alex Lee', 'in_progress'], // incomplete
          ['Priya Sharma', 'completed', '2026-06-12T01:00:00.000Z', { issuedAt: '2026-06-15T02:00:00.000Z' }],
          // ...and these two straddle the start of daylight saving (2026-10-04 02:00 AEST -> 03:00 AEDT).
          ["Marcus O'Connor", 'completed', '2026-10-01T03:30:00.000Z', { issuedAt: '2026-10-03T15:30:00.000Z' }],
          ['Tom Walker', 'completed', '2026-10-02T00:45:00.000Z', { issuedAt: '2026-10-03T16:30:00.000Z' }],
          ['Sofia Rossi', 'not_started'],
        ],
      },
    ],
  },
  {
    name: 'West',
    code: 'WEST',
    timezone: 'Australia/Perth',
    admin: { email: 'bob@west.test', displayName: 'Bob (West admin)' },
    learners: ['Alex Lee', 'Jordan Smith', 'Emily Davis', 'Noah Wilson', 'Grace Kim', 'Liam Brown'],
    courses: [
      {
        title: 'Safety 101',
        enrollments: [
          // already certified - same UTC instant as East's Alex Lee (Perth: 2026-01-10 21:30)
          ['Alex Lee', 'completed', '2026-01-09T06:00:00.000Z', { issuedAt: DEMO_REFERENCE_INSTANT }],
          ['Jordan Smith', 'completed', '2026-11-16T07:15:00.000Z'], // eligible
          ['Emily Davis', 'completed', '2026-11-18T03:50:00.000Z'], // eligible
          ['Noah Wilson', 'in_progress'], // incomplete
          ['Grace Kim', 'not_started'], // incomplete
        ],
      },
      {
        title: 'Working at Heights',
        enrollments: [
          ['Alex Lee', 'completed', '2026-11-10T02:00:00.000Z'], // eligible
          ['Liam Brown', 'completed', '2026-03-19T08:00:00.000Z', { issuedAt: '2026-03-20T17:45:00.000Z' }],
          [
            'Grace Kim',
            'completed',
            '2026-07-30T05:00:00.000Z',
            {
              issuedAt: '2026-08-01T03:00:00.000Z',
              revoked: { at: '2026-08-20T06:30:00.000Z', reason: 'Practical assessment failed on review' },
            },
          ],
          ['Jordan Smith', 'in_progress'],
        ],
      },
      {
        title: 'Manual Handling',
        enrollments: [
          ['Alex Lee', 'in_progress'], // incomplete
          ['Emily Davis', 'completed', '2026-09-11T04:00:00.000Z', { issuedAt: '2026-09-12T10:20:00.000Z' }],
          ['Noah Wilson', 'not_started'],
        ],
      },
    ],
  },
];

export function isSeeded(db) {
  return db.get('SELECT COUNT(*) AS n FROM tenants').n > 0;
}

function insertDemoTenant(db, spec) {
  if (!isValidTimeZone(spec.timezone)) throw new Error(`Unknown IANA time zone "${spec.timezone}" for tenant ${spec.name}`);
  const tenantId = db.run(
    'INSERT INTO tenants (name, code, timezone, created_at) VALUES (@name, @code, @timezone, @createdAt)',
    { name: spec.name, code: spec.code, timezone: spec.timezone, createdAt: SEEDED_AT },
  ).lastInsertRowid;
  const tenant = { id: tenantId, code: spec.code, timezone: spec.timezone };

  const adminId = db.run(
    'INSERT INTO admins (tenant_id, email, display_name, created_at) VALUES (@tenantId, @email, @displayName, @createdAt)',
    { tenantId, email: spec.admin.email, displayName: spec.admin.displayName, createdAt: SEEDED_AT },
  ).lastInsertRowid;
  const actor = { adminId, email: spec.admin.email };

  const learners = new Map();
  for (const name of spec.learners) {
    const id = db.run(
      'INSERT INTO learners (tenant_id, full_name, email, created_at) VALUES (@tenantId, @name, @email, @createdAt)',
      {
        tenantId,
        name,
        email: `${name.toLowerCase().normalize('NFD').replace(/[^a-z ]/g, '').trim().replace(/ +/g, '.')}@${spec.name.toLowerCase()}.test`,
        createdAt: SEEDED_AT,
      },
    ).lastInsertRowid;
    learners.set(name, { id, name });
  }

  const pendingCertificates = [];
  for (const courseSpec of spec.courses) {
    const courseId = db.run(
      'INSERT INTO courses (tenant_id, title, created_at) VALUES (@tenantId, @title, @createdAt)',
      { tenantId, title: courseSpec.title, createdAt: SEEDED_AT },
    ).lastInsertRowid;
    const course = { id: courseId, title: courseSpec.title };

    for (const [learnerName, status, completedAt = null, certificate = null] of courseSpec.enrollments) {
      const learner = learners.get(learnerName);
      if (!learner) throw new Error(`Seed refers to unknown learner "${learnerName}"`);
      const enrollmentId = db.run(
        `INSERT INTO enrollments (tenant_id, course_id, learner_id, status, completed_at, created_at)
         VALUES (@tenantId, @courseId, @learnerId, @status, @completedAt, @createdAt)`,
        { tenantId, courseId, learnerId: learner.id, status, completedAt, createdAt: SEEDED_AT },
      ).lastInsertRowid;
      if (certificate) pendingCertificates.push({ course, learner, enrollmentId, ...certificate });
    }
  }

  // Issue in chronological order so serial numbers and ids follow the timeline, as they would in real use.
  pendingCertificates.sort((a, b) => a.issuedAt.localeCompare(b.issuedAt));
  for (const pending of pendingCertificates) {
    const { id } = issueCertificate(db, {
      tenant,
      actor,
      course: pending.course,
      learner: pending.learner,
      enrollmentId: pending.enrollmentId,
      issuedAt: pending.issuedAt,
      auditDetails: { source: 'demo-seed' },
    });
    if (pending.revoked) {
      revokeCertificate(db, {
        tenantId,
        certificateId: id,
        actor,
        revokedAt: pending.revoked.at,
        reason: pending.revoked.reason,
      });
    }
  }
}

/** Inserts the demo dataset. Call only on an empty (freshly migrated) database. */
export function seedDemoData(db) {
  db.transaction(() => {
    if (isSeeded(db)) throw new Error('Database already contains data; refusing to seed twice');
    for (const tenant of DEMO_TENANTS) insertDemoTenant(db, tenant);
  });
}
