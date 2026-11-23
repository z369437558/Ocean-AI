/**
 * Low-level write primitives shared by the API, the demo seed and the load-test generator.
 * All of them expect to run inside a transaction owned by the caller.
 */
import { localDate, toUtcIso } from '../lib/time.js';

export const AUDIT_ACTIONS = Object.freeze({
  ISSUED: 'certificate.issued',
  REVOKED: 'certificate.revoked',
});

export function formatSerial(tenantCode, sequence) {
  return `${tenantCode}-${String(sequence).padStart(7, '0')}`;
}

/** Reserves `count` consecutive serial numbers for a tenant and returns the first sequence value. */
export function reserveSerials(db, tenantId, count = 1) {
  const { changes } = db.run('UPDATE tenants SET last_serial = last_serial + @count WHERE id = @tenantId', {
    count,
    tenantId,
  });
  if (changes !== 1) throw new Error(`Unknown tenant ${tenantId}`);
  const { last_serial: last } = db.get('SELECT last_serial FROM tenants WHERE id = @tenantId', { tenantId });
  return last - count + 1;
}

export function recordAuditEvent(db, event) {
  return db.run(
    `INSERT INTO audit_events (tenant_id, actor_admin_id, actor_email, action, certificate_id, bulk_operation_id, details, created_at)
     VALUES (@tenantId, @actorAdminId, @actorEmail, @action, @certificateId, @bulkOperationId, @details, @createdAt)`,
    {
      tenantId: event.tenantId,
      actorAdminId: event.actorAdminId ?? null,
      actorEmail: event.actorEmail,
      action: event.action,
      certificateId: event.certificateId,
      bulkOperationId: event.bulkOperationId ?? null,
      details: JSON.stringify(event.details ?? {}),
      createdAt: event.createdAt,
    },
  ).lastInsertRowid;
}

/**
 * Issues one certificate and writes its `certificate.issued` audit event.
 *
 * `tenant` is `{ id, code, timezone }`, `actor` is `{ adminId, email }`.
 * Throws if the learner already has a certificate for the course (UNIQUE constraint).
 */
export function issueCertificate(db, { tenant, actor, course, learner, enrollmentId, issuedAt, bulkOperationId = null, auditDetails = {} }) {
  const issuedAtIso = toUtcIso(issuedAt);
  const serialNumber = formatSerial(tenant.code, reserveSerials(db, tenant.id, 1));
  const certificateId = db.run(
    `INSERT INTO certificates (tenant_id, course_id, learner_id, enrollment_id, serial_number, learner_name, course_title,
                               status, issued_at, issued_local_date, issued_by_admin_id, bulk_operation_id)
     VALUES (@tenantId, @courseId, @learnerId, @enrollmentId, @serialNumber, @learnerName, @courseTitle,
             'active', @issuedAt, @issuedLocalDate, @issuedByAdminId, @bulkOperationId)`,
    {
      tenantId: tenant.id,
      courseId: course.id,
      learnerId: learner.id,
      enrollmentId: enrollmentId ?? null,
      serialNumber,
      learnerName: learner.name,
      courseTitle: course.title,
      issuedAt: issuedAtIso,
      issuedLocalDate: localDate(issuedAtIso, tenant.timezone),
      issuedByAdminId: actor.adminId ?? null,
      bulkOperationId,
    },
  ).lastInsertRowid;

  recordAuditEvent(db, {
    tenantId: tenant.id,
    actorAdminId: actor.adminId,
    actorEmail: actor.email,
    action: AUDIT_ACTIONS.ISSUED,
    certificateId,
    bulkOperationId,
    createdAt: issuedAtIso,
    details: {
      serialNumber,
      learnerId: learner.id,
      learnerName: learner.name,
      courseId: course.id,
      courseTitle: course.title,
      ...auditDetails,
    },
  });

  return { id: certificateId, serialNumber, issuedAt: issuedAtIso };
}

/**
 * Revokes an active certificate and writes its `certificate.revoked` audit event.
 * Returns false (and writes nothing) when the certificate is not active any more, which is what
 * makes repeated or racing revoke requests harmless.
 */
export function revokeCertificate(db, { tenantId, certificateId, actor, revokedAt, reason = null }) {
  const revokedAtIso = toUtcIso(revokedAt);
  const { changes } = db.run(
    `UPDATE certificates
        SET status = 'revoked', revoked_at = @revokedAt, revoked_by_admin_id = @adminId, revocation_reason = @reason
      WHERE id = @certificateId AND tenant_id = @tenantId AND status = 'active'`,
    { revokedAt: revokedAtIso, adminId: actor.adminId ?? null, reason, certificateId, tenantId },
  );
  if (changes !== 1) return false;

  const { serial_number: serialNumber } = db.get('SELECT serial_number FROM certificates WHERE id = @certificateId', {
    certificateId,
  });
  recordAuditEvent(db, {
    tenantId,
    actorAdminId: actor.adminId,
    actorEmail: actor.email,
    action: AUDIT_ACTIONS.REVOKED,
    certificateId,
    createdAt: revokedAtIso,
    details: { serialNumber, reason, previousStatus: 'active' },
  });
  return true;
}
