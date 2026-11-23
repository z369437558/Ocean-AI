/**
 * Bulk issue: one certificate for every eligible learner of a course, with per-learner outcomes.
 *
 * Retry safety
 * ------------
 * The whole operation - idempotency lookup, eligibility check, certificates, audit events and the
 * stored response - is ONE `BEGIN IMMEDIATE` transaction. SQLite admits a single writer at a time,
 * so identical requests racing each other (in this process or in another one sharing the file) are
 * strictly serialised: the first one executes and commits its response next to the idempotency
 * key, every later one finds that row and replays the stored response byte for byte. There is no
 * observable "in progress" state and therefore no window in which a duplicate could slip through.
 *
 * Waiting for the write lock never blocks the process (see Connection.writeTransaction), and a
 * request that waits keeps looking for the stored response: once an identical request has
 * committed anywhere, every caller gets that same answer without further delay.
 *
 * A crash before COMMIT leaves nothing behind (no certificates, no audit events, no key), so the
 * client's retry simply runs the operation for the first time.
 *
 * Independently of idempotency keys, UNIQUE (tenant_id, course_id, learner_id) on certificates
 * makes a second certificate for the same learner and course impossible.
 */
import { HttpError, badRequest, notFound } from '../lib/errors.js';
import { requestFingerprint } from '../lib/fingerprint.js';
import { pathId } from '../lib/params.js';
import { localDateTime } from '../lib/time.js';
import { TransactionAbortedError } from '../db/sqlite.js';
import { classifyEnrollment, findCourse, loadRoster } from './courses.js';
import { issueCertificate } from './ledger.js';

export const IDEMPOTENCY_HEADER = 'Idempotency-Key';
const ROUTE = '/api/bulk-issues';
const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7E]{1,200}$/;

export function parseIdempotencyKey(headerValue) {
  if (headerValue === undefined) return null;
  const key = String(headerValue).trim();
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw badRequest(`${IDEMPOTENCY_HEADER} must be 1-200 printable ASCII characters without spaces`);
  }
  return key;
}

function parseCourseId(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('Request body must be a JSON object such as {"courseId": 1}');
  }
  const value = body.courseId ?? body.course_id;
  const courseId = Number.isSafeInteger(value) && value > 0 ? value : pathId(typeof value === 'string' ? value : '');
  if (courseId === null) throw badRequest('"courseId" is required and must be a positive integer');
  return courseId;
}

/**
 * What the admin is told about a learner whose certificate could not be issued. The cause is an
 * internal error (it goes to the server log with the operation and learner id); its raw text -
 * constraint names, SQL - does not belong in an API response.
 */
const FAILURE_MESSAGE =
  'The certificate could not be issued because of an unexpected error. Nothing was saved for this learner; ' +
  'the server log has the details. Other learners are not affected.';

/**
 * What an earlier request with this key left behind, if anything: its stored response when the
 * payload is the same, a 409 when it is not. Keys are scoped to (tenant, admin), so one actor can
 * never replay - or collide with - another actor's operation, let alone another tenant's.
 * `requestHash` null means "this request has no readable payload", which can only be a mismatch.
 */
function answerFromStoredKey(db, actor, idempotencyKey, requestHash) {
  if (idempotencyKey === null) return null;
  const previous = db.get(
    `SELECT id, request_hash, response_status, response_body
       FROM bulk_issue_operations
      WHERE tenant_id = @tenantId AND actor_admin_id = @adminId AND idempotency_key = @idempotencyKey`,
    { tenantId: actor.tenantId, adminId: actor.adminId, idempotencyKey },
  );
  if (!previous) return null;
  if (previous.request_hash !== requestHash) {
    throw new HttpError(
      409,
      'idempotency_key_reused',
      `${IDEMPOTENCY_HEADER} "${idempotencyKey}" was already used for a different request. ` +
        'Retry with the original payload, or use a new key for a new operation.',
      { operationId: previous.id },
    );
  }
  return { status: previous.response_status, body: previous.response_body, replayed: true, operationId: previous.id };
}

/**
 * For requests whose body could not even be parsed: if the key has already been used, this is a
 * reuse with a different payload (409); otherwise the caller reports the body error itself.
 */
export function rejectReusedKeyWithUnreadableBody(db, actor, idempotencyKey) {
  answerFromStoredKey(db, actor, idempotencyKey, null);
}

/**
 * Executes (or replays) a bulk issue.
 *
 * @returns {Promise<{ status: number, body: string, replayed: boolean, operationId: number }>}
 *   `body` is the JSON text of the operation; replays return the stored text unchanged.
 */
export async function bulkIssue(db, actor, { body, idempotencyKey }, { now = () => new Date(), hooks = {}, logger = console } = {}) {
  const requestHash = requestFingerprint('POST', ROUTE, body);

  // Fast path: a key that already ran is answered from a plain read (replay or 409). It needs no
  // write lock, so retries are served even while another process is in the middle of a long write.
  const stored = answerFromStoredKey(db, actor, idempotencyKey, requestHash);
  if (stored) return stored;

  // Obviously invalid requests are turned away before queueing for the write lock as well.
  if (!findCourse(db, actor, parseCourseId(body))) throw notFound('Course');

  // While this request queues for the write lock, an identical one may complete elsewhere (another
  // server on the same file). From that moment the answer is known and is given straight away -
  // the same 201 the other caller got - even if the lock stays taken for longer than the wait.
  const whileWaiting = () => answerFromStoredKey(db, actor, idempotencyKey, requestHash) ?? undefined;

  return db.writeTransaction(() => {
    // 1. The decisive idempotency check, now under the write lock: an identical request that was
    //    racing this one has either not started (we execute) or has committed (we replay).
    const raced = answerFromStoredKey(db, actor, idempotencyKey, requestHash);
    if (raced) return raced;

    // 2. Validation. Nothing has been written yet, so a rejected request leaves no trace: no
    //    operation row, no idempotency record, no certificates, no audit events.
    const courseId = parseCourseId(body);
    const course = findCourse(db, actor, courseId);
    if (!course) throw notFound('Course'); // also the answer for another tenant's course

    // 3. Execute.
    const startedAt = now().toISOString();
    const tenant = { id: actor.tenantId, code: actor.tenantCode, timezone: actor.timezone };
    const operationId = db.run(
      `INSERT INTO bulk_issue_operations (tenant_id, actor_admin_id, course_id, idempotency_key, request_hash, status, created_at)
       VALUES (@tenantId, @adminId, @courseId, @idempotencyKey, @requestHash, 'running', @createdAt)`,
      {
        tenantId: actor.tenantId,
        adminId: actor.adminId,
        courseId: course.id,
        idempotencyKey,
        requestHash,
        createdAt: startedAt,
      },
    ).lastInsertRowid;

    const results = [];
    const summary = { total: 0, issued: 0, skipped: 0, failed: 0 };

    for (const row of loadRoster(db, actor.tenantId, course.id)) {
      const base = { learnerId: row.learner_id, learnerName: row.learner_name, enrollmentId: row.enrollment_id };
      const verdict = classifyEnrollment(row);
      summary.total += 1;

      if (!verdict.eligible) {
        summary.skipped += 1;
        const skipped = { ...base, outcome: 'skipped', reason: verdict.reason, message: verdict.message };
        if (row.certificate_id !== null) {
          skipped.certificateId = row.certificate_id;
          skipped.serialNumber = row.serial_number;
        }
        results.push(skipped);
        continue;
      }

      try {
        // Each learner gets a SAVEPOINT: if issuing fails for one of them, only that learner's
        // partial writes are undone and reported as "failed"; everyone else is unaffected.
        // (`hooks` are test seams: they let a test make issuing fail before or after the writes.)
        const certificate = db.transaction(() => {
          const learner = { id: row.learner_id, name: row.learner_name };
          hooks.beforeIssue?.({ learner, course, tenant });
          const issued = issueCertificate(db, {
            tenant,
            actor,
            course,
            learner,
            enrollmentId: row.enrollment_id,
            issuedAt: startedAt,
            bulkOperationId: operationId,
            auditDetails: { enrollmentId: row.enrollment_id, idempotencyKey },
          });
          hooks.afterIssue?.({ learner, course, tenant, certificate: issued });
          return issued;
        });
        summary.issued += 1;
        results.push({
          ...base,
          outcome: 'issued',
          certificateId: certificate.id,
          serialNumber: certificate.serialNumber,
          issuedAt: certificate.issuedAt,
          issuedLocal: localDateTime(certificate.issuedAt, actor.timezone),
        });
      } catch (err) {
        if (err instanceof TransactionAbortedError) throw err; // nothing can be salvaged; fail the request
        // The cause is for the operator: the first failure of an operation is logged in full, every
        // further one in a single line. (When a whole roster fails for the same reason, thousands
        // of identical stack traces would be written while the write lock is held.)
        const failure = `[bulk-issue] operation ${operationId}: learner ${row.learner_id} failed:`;
        if (summary.failed === 0) logger.error(failure, err);
        else logger.error(`${failure} ${err?.message ?? err}`);
        summary.failed += 1;
        results.push({ ...base, outcome: 'failed', reason: 'issue_failed', message: FAILURE_MESSAGE });
      }
    }

    // 4. Store the response with the operation so every retry gets the identical answer.
    const status = 201;
    const completedAt = now().toISOString();
    const responseBody = JSON.stringify({
      id: operationId,
      status: 'completed',
      course,
      idempotencyKey,
      requestedBy: actor.email,
      tenant: { name: actor.tenantName, timezone: actor.timezone },
      createdAt: startedAt,
      completedAt,
      summary,
      results,
    });
    db.run(
      `UPDATE bulk_issue_operations
          SET status = 'completed', issued_count = @issued, skipped_count = @skipped, failed_count = @failed,
              response_status = @status, response_body = @body, completed_at = @completedAt
        WHERE id = @operationId`,
      {
        issued: summary.issued,
        skipped: summary.skipped,
        failed: summary.failed,
        status,
        body: responseBody,
        completedAt,
        operationId,
      },
    );

    return { status, body: responseBody, replayed: false, operationId };
  }, { whileWaiting });
}

/** Stored result of a past operation (same JSON that the POST returned). 404 across tenants. */
export function getBulkOperation(db, actor, operationId) {
  const row =
    operationId === null
      ? undefined
      : db.get(
          `SELECT response_body FROM bulk_issue_operations
            WHERE id = @operationId AND tenant_id = @tenantId AND status = 'completed'`,
          { operationId, tenantId: actor.tenantId },
        );
  if (!row) throw notFound('Bulk issue operation');
  return row.response_body;
}

/** Most recent operations of the tenant, without the per-learner detail. */
export function listBulkOperations(db, actor, { limit = 10 } = {}) {
  return db
    .all(
      `SELECT o.id, o.course_id, c.title AS course_title, o.idempotency_key, o.issued_count, o.skipped_count,
              o.failed_count, o.created_at, a.email AS requested_by
         FROM bulk_issue_operations o
         JOIN courses c ON c.id = o.course_id
         JOIN admins a ON a.id = o.actor_admin_id
        WHERE o.tenant_id = @tenantId AND o.status = 'completed'
        ORDER BY o.id DESC
        LIMIT @limit`,
      { tenantId: actor.tenantId, limit },
    )
    .map((row) => ({
      id: row.id,
      status: 'completed',
      course: { id: row.course_id, title: row.course_title },
      idempotencyKey: row.idempotency_key,
      requestedBy: row.requested_by,
      createdAt: row.created_at,
      createdLocal: localDateTime(row.created_at, actor.timezone),
      summary: {
        total: row.issued_count + row.skipped_count + row.failed_count,
        issued: row.issued_count,
        skipped: row.skipped_count,
        failed: row.failed_count,
      },
    }));
}
