/**
 * Load-test data generator: adds N certificates (100,000 by default) to one tenant.
 *
 * The quick-start rows are never touched. Generated certificates belong to their own generated
 * courses and learners (flagged `is_generated = 1`) and are numbered in their own serial range
 * (EAST-LT-0000001, ...), so the demo scenario - the "Safety 101" rosters, "Alex Lee", every seeded
 * certificate, the tenant's serial counter - is exactly as before, and the next certificate issued
 * through the app still gets the serial number it would have got without the load-test data.
 * Running the generator again replaces the previous generated set instead of piling up on top of it.
 *
 * The data is deliberately full of equal sort keys, because that is what makes ordering bugs
 * visible: about 2,500 distinct learner names shared by 10,000 learners, 10 course titles, and
 * issue timestamps that come in batches (many certificates carry the very same instant, the way a
 * real bulk issue stamps them), about 150 per calendar day.
 *
 * Everything is derived from a seeded PRNG, so the same arguments always produce the same rows.
 */
import { foldText } from '../lib/text.js';
import { localDate } from '../lib/time.js';
import { AUDIT_ACTIONS } from '../services/ledger.js';

const FIRST_NAMES = [
  'Aaliyah', 'Aiden', 'Amelia', 'Anika', 'Arjun', 'Ava', 'Ben', 'Caleb', 'Charlotte', 'Chloe',
  'Daniel', 'Elena', 'Elijah', 'Emma', 'Ethan', 'Fatima', 'Finn', 'Grace', 'Hannah', 'Harper',
  'Hugo', 'Isaac', 'Isla', 'Jack', 'Jasmine', 'Kai', 'Lachlan', 'Layla', 'Leo', 'Lily',
  'Lucas', 'Maya', 'Mia', 'Mohammed', 'Nina', 'Noah', 'Olivia', 'Oscar', 'Ruby', 'Ryan',
  'Samir', 'Sienna', 'Sophie', 'Tane', 'Thomas', 'Violet', 'William', 'Yuki', 'Zara', 'Zoe',
];

const LAST_NAMES = [
  'Anderson', 'Baker', 'Bennett', 'Campbell', 'Carter', 'Clarke', 'Collins', 'Cooper', 'Edwards', 'Evans',
  'Fraser', 'Gray', 'Green', 'Hall', 'Harris', 'Hughes', 'Jackson', 'James', 'Kelly', 'King',
  'Martin', 'Mitchell', 'Moore', 'Morgan', 'Murphy', 'Nguyen', 'Patel', 'Phillips', 'Reid', 'Roberts',
  'Robinson', 'Ryan', 'Scott', 'Singh', 'Stewart', 'Taylor', 'Thompson', 'Tran', 'Turner', 'Walker',
  'Wang', 'Watson', 'White', 'Williams', 'Wilson', 'Wood', 'Wright', 'Young', 'Zhang', 'Zhou',
];

const COURSE_TITLES = [
  'Asbestos Awareness', 'Chemical Handling', 'Confined Spaces', 'Electrical Safety', 'Emergency Warden',
  'Fire Extinguisher Use', 'Hazard Identification', 'Ladder Safety', 'Noise and Hearing', 'Site Induction',
].map((title) => `${title} (load test)`);

/** Issue instants are spread over this fixed window (kept in the past so the demo data reads naturally). */
const WINDOW_START = Date.parse('2025-01-01T00:00:00.000Z');
const WINDOW_END = Date.parse('2026-10-31T00:00:00.000Z');
const CERTIFICATES_PER_BATCH = 25;
const REVOKED_SHARE = 0.02;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Upper limit of one generator run (about 1.7 GB of database). */
export const MAX_GENERATED_CERTIFICATES = 2_000_000;

/** Small, fast, deterministic PRNG (mulberry32). */
function createRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));

/** Serial numbers of generated certificates: a range of their own, restarted with every run. */
export function formatGeneratedSerial(tenantCode, sequence) {
  return `${tenantCode}-LT-${String(sequence).padStart(7, '0')}`;
}

function findTenant(db, tenantName) {
  const tenant = db.get('SELECT id, name, code, timezone FROM tenants WHERE name = @name COLLATE NOCASE', {
    name: tenantName,
  });
  if (!tenant) throw new Error(`Unknown tenant "${tenantName}"`);
  const admin = db.get('SELECT id, email FROM admins WHERE tenant_id = @tenantId ORDER BY id LIMIT 1', {
    tenantId: tenant.id,
  });
  if (!admin) throw new Error(`Tenant "${tenant.name}" has no admin to attribute the certificates to`);
  return { tenant, admin };
}

function deleteGenerated(db, tenantId) {
  const params = { tenantId };
  const generatedCourses = 'SELECT id FROM courses WHERE tenant_id = @tenantId AND is_generated = 1';
  const generatedCertificates = `SELECT id FROM certificates WHERE tenant_id = @tenantId AND course_id IN (${generatedCourses})`;
  db.run(`DELETE FROM audit_events WHERE tenant_id = @tenantId AND certificate_id IN (${generatedCertificates})`, params);
  const removed = db.run(`DELETE FROM certificates WHERE tenant_id = @tenantId AND course_id IN (${generatedCourses})`, params).changes;
  db.run(`DELETE FROM bulk_issue_operations WHERE tenant_id = @tenantId AND course_id IN (${generatedCourses})`, params);
  db.run(`DELETE FROM enrollments WHERE tenant_id = @tenantId AND course_id IN (${generatedCourses})`, params);
  db.run('DELETE FROM learners WHERE tenant_id = @tenantId AND is_generated = 1', params);
  db.run('DELETE FROM courses WHERE tenant_id = @tenantId AND is_generated = 1', params);
  return removed;
}

/** Removes every generated row of the tenant; the quick-start dataset is left exactly as it was. */
export function clearGeneratedCertificates(db, { tenantName }) {
  const { tenant } = findTenant(db, tenantName);
  const removed = db.transaction(() => deleteGenerated(db, tenant.id));
  return { tenant: tenant.name, removed };
}

/**
 * Generates `count` certificates for the tenant, replacing any previously generated set.
 * Runs in a single transaction: other connections see either none or all of the new rows.
 */
export function generateCertificates(db, { tenantName, count = 100_000, seed = 20260110 }) {
  if (!Number.isInteger(count) || count < 1 || count > MAX_GENERATED_CERTIFICATES) {
    throw new Error(`count must be an integer between 1 and ${MAX_GENERATED_CERTIFICATES.toLocaleString('en-US')}`);
  }
  const { tenant, admin } = findTenant(db, tenantName);
  const random = createRandom(seed);
  const createdAt = new Date(WINDOW_START).toISOString();

  return db.transaction(() => {
    const replaced = deleteGenerated(db, tenant.id);

    // Courses and learners -----------------------------------------------------------------
    const courses = COURSE_TITLES.map((title) => {
      const titleKey = foldText(title);
      const id = db.run(
        `INSERT INTO courses (tenant_id, title, title_key, is_generated, created_at)
         VALUES (@tenantId, @title, @titleKey, 1, @createdAt)`,
        { tenantId: tenant.id, title, titleKey, createdAt },
      ).lastInsertRowid;
      return { id, title, titleKey };
    });

    const learnerCount = Math.ceil(count / courses.length);
    const learners = new Array(learnerCount);
    for (let i = 0; i < learnerCount; i += 1) {
      const name = `${FIRST_NAMES[Math.floor(random() * FIRST_NAMES.length)]} ${LAST_NAMES[Math.floor(random() * LAST_NAMES.length)]}`;
      const nameKey = foldText(name);
      const id = db.run(
        `INSERT INTO learners (tenant_id, full_name, name_key, email, is_generated, created_at)
         VALUES (@tenantId, @name, @nameKey, @email, 1, @createdAt)`,
        { tenantId: tenant.id, name, nameKey, email: `learner${i + 1}@loadtest.${tenant.name.toLowerCase()}.test`, createdAt },
      ).lastInsertRowid;
      learners[i] = { id, name, nameKey };
    }

    // Issue instants: sorted batch timestamps, each shared by ~25 certificates -----------------
    const batchCount = Math.max(1, Math.round(count / CERTIFICATES_PER_BATCH));
    const batchInstants = new Float64Array(batchCount);
    for (let b = 0; b < batchCount; b += 1) {
      batchInstants[b] = WINDOW_START + Math.floor((random() * (WINDOW_END - WINDOW_START)) / 1000) * 1000;
    }
    batchInstants.sort();

    // Visit every (learner, course) pair exactly once, in a scrambled but reproducible order.
    let stride = 7919;
    while (gcd(stride, count) !== 1) stride += 2;

    let revokedCount = 0;
    let previousBatch = -1;
    let issuedAt = '';
    let issuedLocalDate = '';

    // Rows are inserted in chronological order, so ids and serial numbers follow the timeline.
    // (deleteGenerated above removed the previous set, so the numbering can start at 1 again.)
    for (let k = 0; k < count; k += 1) {
      const batch = Math.min(batchCount - 1, Math.floor((k * batchCount) / count));
      if (batch !== previousBatch) {
        previousBatch = batch;
        issuedAt = new Date(batchInstants[batch]).toISOString();
        issuedLocalDate = localDate(issuedAt, tenant.timezone);
      }
      const pair = (k * stride) % count;
      const learner = learners[Math.floor(pair / courses.length)];
      const course = courses[pair % courses.length];
      const serialNumber = formatGeneratedSerial(tenant.code, k + 1);

      const enrollmentId = db.run(
        `INSERT INTO enrollments (tenant_id, course_id, learner_id, status, completed_at, created_at)
         VALUES (@tenantId, @courseId, @learnerId, 'completed', @completedAt, @createdAt)`,
        {
          tenantId: tenant.id,
          courseId: course.id,
          learnerId: learner.id,
          completedAt: new Date(batchInstants[batch] - Math.ceil(random() * 72) * HOUR).toISOString(),
          createdAt,
        },
      ).lastInsertRowid;

      const revokedAt =
        random() < REVOKED_SHARE ? new Date(batchInstants[batch] + Math.ceil(random() * 20) * DAY).toISOString() : null;
      const reason = revokedAt ? 'Generated revocation (load test)' : null;

      const certificateId = db.run(
        `INSERT INTO certificates (tenant_id, course_id, learner_id, enrollment_id, serial_number, learner_name, course_title,
                                   learner_name_key, course_title_key,
                                   status, issued_at, issued_local_date, issued_by_admin_id,
                                   revoked_at, revoked_by_admin_id, revocation_reason)
         VALUES (@tenantId, @courseId, @learnerId, @enrollmentId, @serialNumber, @learnerName, @courseTitle,
                 @learnerNameKey, @courseTitleKey,
                 @status, @issuedAt, @issuedLocalDate, @adminId,
                 @revokedAt, @revokedBy, @reason)`,
        {
          tenantId: tenant.id,
          courseId: course.id,
          learnerId: learner.id,
          enrollmentId,
          serialNumber,
          learnerName: learner.name,
          courseTitle: course.title,
          learnerNameKey: learner.nameKey,
          courseTitleKey: course.titleKey,
          status: revokedAt ? 'revoked' : 'active',
          issuedAt,
          issuedLocalDate,
          adminId: admin.id,
          revokedAt,
          revokedBy: revokedAt ? admin.id : null,
          reason,
        },
      ).lastInsertRowid;

      const audit = (action, at, details) =>
        db.run(
          `INSERT INTO audit_events (tenant_id, actor_admin_id, actor_email, action, certificate_id, details, created_at)
           VALUES (@tenantId, @adminId, @email, @action, @certificateId, @details, @createdAt)`,
          {
            tenantId: tenant.id,
            adminId: admin.id,
            email: admin.email,
            action,
            certificateId,
            details: JSON.stringify(details),
            createdAt: at,
          },
        );
      audit(AUDIT_ACTIONS.ISSUED, issuedAt, {
        serialNumber,
        learnerId: learner.id,
        learnerName: learner.name,
        courseId: course.id,
        courseTitle: course.title,
        source: 'load-test-generator',
      });
      if (revokedAt) {
        revokedCount += 1;
        audit(AUDIT_ACTIONS.REVOKED, revokedAt, { serialNumber, reason, previousStatus: 'active', source: 'load-test-generator' });
      }
    }

    return {
      tenant: tenant.name,
      generated: count,
      replaced,
      revoked: revokedCount,
      courses: courses.length,
      learners: learnerCount,
      distinctIssueInstants: batchCount,
      totalCertificatesInTenant: db.get('SELECT COUNT(*) AS n FROM certificates WHERE tenant_id = @tenantId', {
        tenantId: tenant.id,
      }).n,
    };
  });
}
