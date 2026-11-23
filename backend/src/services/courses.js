/**
 * Courses and their rosters. The roster view is the "review completions" step: it shows, per
 * learner, exactly what a bulk issue would do, using the same classification the issue path uses.
 */
import { notFound } from '../lib/errors.js';
import { queryInteger } from '../lib/params.js';
import { localDateTime } from '../lib/time.js';

export const SKIP_REASONS = Object.freeze({
  ALREADY_CERTIFIED: 'already_certified',
  CERTIFICATE_REVOKED: 'certificate_revoked',
  NOT_COMPLETED: 'not_completed',
});

const ENROLLMENT_LABELS = { not_started: 'not started', in_progress: 'in progress', completed: 'completed' };

/**
 * Decides what a bulk issue does with one roster row.
 * Eligible = enrollment completed and no certificate has ever been issued for (course, learner).
 */
export function classifyEnrollment(row) {
  if (row.certificate_id !== null && row.certificate_status === 'revoked') {
    return {
      eligible: false,
      reason: SKIP_REASONS.CERTIFICATE_REVOKED,
      message: `Certificate ${row.serial_number} was revoked; revoked certificates are not re-issued automatically`,
    };
  }
  if (row.certificate_id !== null) {
    return {
      eligible: false,
      reason: SKIP_REASONS.ALREADY_CERTIFIED,
      message: `Already certified (certificate ${row.serial_number})`,
    };
  }
  if (row.enrollment_status !== 'completed') {
    return {
      eligible: false,
      reason: SKIP_REASONS.NOT_COMPLETED,
      message: `Course not completed (enrollment is ${ENROLLMENT_LABELS[row.enrollment_status] ?? row.enrollment_status})`,
    };
  }
  return { eligible: true, reason: null, message: 'Completed, not yet certified' };
}

const ROSTER_SQL = `
  SELECT e.id AS enrollment_id, e.status AS enrollment_status, e.completed_at,
         l.id AS learner_id, l.full_name AS learner_name,
         c.id AS certificate_id, c.serial_number, c.status AS certificate_status
    FROM enrollments e
    JOIN learners l ON l.id = e.learner_id AND l.tenant_id = e.tenant_id
    LEFT JOIN certificates c
           ON c.tenant_id = e.tenant_id AND c.course_id = e.course_id AND c.learner_id = e.learner_id
   WHERE e.tenant_id = @tenantId AND e.course_id = @courseId
   ORDER BY l.full_name COLLATE NOCASE, l.id`;

/** Every enrollment of a course with its certificate (if any), in a stable order. */
export function loadRoster(db, tenantId, courseId) {
  return db.all(ROSTER_SQL, { tenantId, courseId });
}

/** Looks a course up inside the actor's tenant only; other tenants' courses do not exist for them. */
export function findCourse(db, actor, courseId) {
  if (courseId === null) return null;
  const row = db.get('SELECT id, title FROM courses WHERE id = @courseId AND tenant_id = @tenantId', {
    courseId,
    tenantId: actor.tenantId,
  });
  return row ? { id: row.id, title: row.title } : null;
}

export function listCourses(db, actor) {
  return db
    .all(
      `SELECT id, title, is_generated FROM courses WHERE tenant_id = @tenantId
        ORDER BY is_generated, title COLLATE NOCASE, id`,
      { tenantId: actor.tenantId },
    )
    .map((row) => ({ id: row.id, title: row.title, isGenerated: row.is_generated === 1 }));
}

/** Roster page plus per-course totals for the bulk-issue screen. */
export function getCourseRoster(db, actor, courseId, query) {
  const page = queryInteger(query, ['page'], { min: 1, max: 1_000_000, fallback: 1 });
  const pageSize = queryInteger(query, ['pageSize', 'page_size', 'per_page', 'limit'], { min: 1, max: 100, fallback: 50 });

  return db.transaction(
    () => {
      const course = findCourse(db, actor, courseId);
      if (!course) throw notFound('Course');

      const params = { tenantId: actor.tenantId, courseId: course.id };
      const totals = db.get(
        `SELECT COUNT(*) AS enrolled,
                COALESCE(SUM(e.status = 'completed'), 0) AS completed,
                COALESCE(SUM(c.status = 'active'), 0) AS certified,
                COALESCE(SUM(c.status = 'revoked'), 0) AS revoked,
                COALESCE(SUM(e.status = 'completed' AND c.id IS NULL), 0) AS eligible
           FROM enrollments e
           LEFT JOIN certificates c
                  ON c.tenant_id = e.tenant_id AND c.course_id = e.course_id AND c.learner_id = e.learner_id
          WHERE e.tenant_id = @tenantId AND e.course_id = @courseId`,
        params,
      );
      const rows = db.all(`${ROSTER_SQL} LIMIT @limit OFFSET @offset`, {
        ...params,
        limit: pageSize,
        offset: (page - 1) * pageSize,
      });

      return {
        course,
        summary: {
          enrolled: totals.enrolled,
          completed: totals.completed,
          incomplete: totals.enrolled - totals.completed,
          certified: totals.certified,
          revoked: totals.revoked,
          eligible: totals.eligible,
        },
        items: rows.map((row) => {
          const verdict = classifyEnrollment(row);
          return {
            learnerId: row.learner_id,
            learnerName: row.learner_name,
            enrollmentId: row.enrollment_id,
            enrollmentStatus: row.enrollment_status,
            completedAt: row.completed_at,
            completedLocal: row.completed_at ? localDateTime(row.completed_at, actor.timezone) : null,
            certificateId: row.certificate_id,
            serialNumber: row.serial_number,
            certificateStatus: row.certificate_status,
            eligible: verdict.eligible,
            reason: verdict.reason,
            message: verdict.message,
          };
        }),
        page,
        pageSize,
        total: totals.enrolled,
        totalPages: Math.max(1, Math.ceil(totals.enrolled / pageSize)),
      };
    },
    { immediate: false },
  );
}
