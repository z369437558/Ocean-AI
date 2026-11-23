/**
 * Certificate queries: list, detail, revocation and the streaming CSV export.
 *
 * The list endpoint and the export share one filter + ordering builder, so an export always
 * contains exactly the rows (and the order) the admin is looking at.
 */
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';

import { csvRow } from '../lib/csv.js';
import { badRequest, notFound } from '../lib/errors.js';
import { queryInteger, queryString } from '../lib/params.js';
import { createLocalDateTimeFormatter, localDateTime, utcOffset } from '../lib/time.js';
import { revokeCertificate } from './ledger.js';

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;
const MAX_REASON_LENGTH = 500;

/**
 * Sort keys. Every ordering ends in `id`, so rows with equal sort values always come back in the
 * same order - pagination never skips or repeats a row and two exports of the same data are
 * byte-identical.
 *
 * "issued" sorts by the tenant-local calendar date first (not the UTC date), then by the exact
 * instant so a single day reads chronologically, then by id.
 */
const SORTS = {
  issued: (dir) => `c.issued_local_date ${dir}, c.issued_at ${dir}, c.id ${dir}`,
  learner: (dir) => `c.learner_name COLLATE NOCASE ${dir}, c.id ${dir}`,
  course: (dir) => `c.course_title COLLATE NOCASE ${dir}, c.id ${dir}`,
  serial: (dir) => `c.serial_number ${dir}, c.id ${dir}`,
  status: (dir) => `c.status ${dir}, c.id ${dir}`,
};

const SORT_ALIASES = {
  issued: 'issued',
  issuedat: 'issued',
  issuedate: 'issued',
  issueddate: 'issued',
  issuedlocal: 'issued',
  issuedlocaldate: 'issued',
  date: 'issued',
  learner: 'learner',
  learnername: 'learner',
  name: 'learner',
  course: 'course',
  coursetitle: 'course',
  serial: 'serial',
  serialnumber: 'serial',
  status: 'status',
};

const DEFAULT_ORDER = { issued: 'desc', learner: 'asc', course: 'asc', serial: 'asc', status: 'asc' };
const STATUSES = ['all', 'active', 'revoked'];

/** Validates list/export query parameters. Unknown values are rejected rather than silently ignored. */
export function parseListQuery(query, { paginate = true } = {}) {
  const q = queryString(query, ['q', 'search'], { maxLength: 100 }) ?? '';

  const status = (queryString(query, ['status']) ?? 'all').toLowerCase() || 'all';
  if (!STATUSES.includes(status)) throw badRequest(`"status" must be one of: ${STATUSES.join(', ')}`);

  let sortText = (queryString(query, ['sort', 'sortBy']) || 'issued').toLowerCase();
  let order = queryString(query, ['order', 'dir', 'direction', 'sortOrder'])?.toLowerCase();
  if (sortText.startsWith('-')) {
    sortText = sortText.slice(1);
    order ??= 'desc';
  }
  const sort = SORT_ALIASES[sortText.replace(/[^a-z]/g, '')];
  if (!sort) throw badRequest(`"sort" must be one of: ${Object.keys(SORTS).join(', ')}`);
  order ||= DEFAULT_ORDER[sort];
  if (order !== 'asc' && order !== 'desc') throw badRequest('"order" must be "asc" or "desc"');

  const options = { q, status, sort, order };
  if (paginate) {
    options.page = queryInteger(query, ['page'], { min: 1, max: 1_000_000, fallback: 1 });
    options.pageSize = queryInteger(query, ['pageSize', 'page_size', 'per_page', 'limit'], {
      min: 1,
      max: MAX_PAGE_SIZE,
      fallback: DEFAULT_PAGE_SIZE,
    });
  }
  return options;
}

const escapeLike = (text) => text.replace(/[\\%_]/g, (ch) => `\\${ch}`);

/**
 * WHERE clause shared by list, count and export. The tenant predicate comes from the actor and is
 * always present; nothing the client sends can widen it.
 */
function buildFilter(actor, { q, status }) {
  const clauses = ['c.tenant_id = @tenantId'];
  const params = { tenantId: actor.tenantId };
  if (q) {
    clauses.push("(c.learner_name LIKE @pattern ESCAPE '\\' OR c.serial_number LIKE @pattern ESCAPE '\\')");
    params.pattern = `%${escapeLike(q)}%`;
  }
  if (status !== 'all') {
    // The unary plus keeps the planner on the index that matches the requested ORDER BY instead
    // of switching to the low-selectivity status index and sorting the whole tenant in memory.
    clauses.push('+c.status = @status');
    params.status = status;
  }
  return { where: clauses.join(' AND '), params };
}

const orderBy = ({ sort, order }) => SORTS[sort](order === 'desc' ? 'DESC' : 'ASC');

function presentListItem(row, timeZone) {
  return {
    id: row.id,
    serialNumber: row.serial_number,
    learnerId: row.learner_id,
    learnerName: row.learner_name,
    courseId: row.course_id,
    courseTitle: row.course_title,
    status: row.status,
    issuedAt: row.issued_at,
    issuedLocal: localDateTime(row.issued_at, timeZone),
    issuedLocalDate: row.issued_local_date,
  };
}

export function listCertificates(db, actor, options) {
  const { where, params } = buildFilter(actor, options);
  const { page, pageSize } = options;

  // Count and page are read inside one snapshot so "total" always matches the rows returned.
  const { total, rows } = db.transaction(
    () => ({
      total: db.get(`SELECT COUNT(*) AS n FROM certificates c WHERE ${where}`, params).n,
      rows: db.all(
        `SELECT c.id, c.serial_number, c.learner_id, c.learner_name, c.course_id, c.course_title,
                c.status, c.issued_at, c.issued_local_date
           FROM certificates c
          WHERE ${where}
          ORDER BY ${orderBy(options)}
          LIMIT @limit OFFSET @offset`,
        { ...params, limit: pageSize, offset: (page - 1) * pageSize },
      ),
    }),
    { immediate: false },
  );

  return {
    items: rows.map((row) => presentListItem(row, actor.timezone)),
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    sort: options.sort,
    order: options.order,
    q: options.q,
    status: options.status,
    tenant: { name: actor.tenantName, timezone: actor.timezone },
  };
}

function presentAuditEvent(row, timeZone) {
  return {
    id: row.id,
    action: row.action,
    actorEmail: row.actor_email,
    certificateId: row.certificate_id,
    bulkOperationId: row.bulk_operation_id,
    createdAt: row.created_at,
    createdLocal: localDateTime(row.created_at, timeZone),
    details: JSON.parse(row.details),
  };
}

/** Full certificate record including its audit trail; throws 404 for other tenants' certificates. */
export function getCertificate(db, actor, certificateId) {
  const row =
    certificateId === null
      ? undefined
      : db.get(
          `SELECT c.*, issuer.email AS issued_by_email, revoker.email AS revoked_by_email
             FROM certificates c
             LEFT JOIN admins issuer  ON issuer.id  = c.issued_by_admin_id
             LEFT JOIN admins revoker ON revoker.id = c.revoked_by_admin_id
            WHERE c.id = @certificateId AND c.tenant_id = @tenantId`,
          { certificateId, tenantId: actor.tenantId },
        );
  if (!row) throw notFound('Certificate');

  const timeZone = actor.timezone;
  const auditEvents = db.all(
    'SELECT * FROM audit_events WHERE certificate_id = @certificateId AND tenant_id = @tenantId ORDER BY id',
    { certificateId, tenantId: actor.tenantId },
  );

  return {
    id: row.id,
    serialNumber: row.serial_number,
    learnerId: row.learner_id,
    learnerName: row.learner_name,
    courseId: row.course_id,
    courseTitle: row.course_title,
    status: row.status,
    issuedAt: row.issued_at,
    issuedLocal: localDateTime(row.issued_at, timeZone),
    issuedLocalDate: row.issued_local_date,
    issuedUtcOffset: utcOffset(row.issued_at, timeZone),
    issuedBy: row.issued_by_email,
    bulkOperationId: row.bulk_operation_id,
    revokedAt: row.revoked_at,
    revokedLocal: row.revoked_at ? localDateTime(row.revoked_at, timeZone) : null,
    revokedBy: row.revoked_by_email,
    revocationReason: row.revocation_reason,
    tenant: { name: actor.tenantName, timezone: timeZone },
    auditEvents: auditEvents.map((event) => presentAuditEvent(event, timeZone)),
  };
}

function parseRevocationReason(body) {
  if (body === undefined || body === null) return null;
  if (typeof body !== 'object' || Array.isArray(body)) throw badRequest('Request body must be a JSON object');
  const { reason } = body;
  if (reason === undefined || reason === null) return null;
  if (typeof reason !== 'string') throw badRequest('"reason" must be a string');
  const text = reason.trim();
  if (text.length > MAX_REASON_LENGTH) throw badRequest(`"reason" must be at most ${MAX_REASON_LENGTH} characters`);
  return text || null;
}

/**
 * Revokes a certificate. Idempotent: revoking an already revoked certificate succeeds, changes
 * nothing and writes no audit event (`alreadyRevoked: true` tells the caller it was a no-op).
 */
export function revoke(db, actor, certificateId, body, { now = () => new Date() } = {}) {
  const reason = parseRevocationReason(body);
  return db.transaction(() => {
    const row =
      certificateId === null
        ? undefined
        : db.get('SELECT id FROM certificates WHERE id = @certificateId AND tenant_id = @tenantId', {
            certificateId,
            tenantId: actor.tenantId,
          });
    if (!row) throw notFound('Certificate');

    const changed = revokeCertificate(db, {
      tenantId: actor.tenantId,
      certificateId,
      actor,
      revokedAt: now(),
      reason,
    });
    return { ...getCertificate(db, actor, certificateId), alreadyRevoked: !changed };
  });
}

/** Audit events of the actor's tenant, newest first, optionally narrowed down. */
export function listAuditEvents(db, actor, query) {
  const page = queryInteger(query, ['page'], { min: 1, max: 1_000_000, fallback: 1 });
  const pageSize = queryInteger(query, ['pageSize', 'page_size', 'per_page', 'limit'], {
    min: 1,
    max: MAX_PAGE_SIZE,
    fallback: DEFAULT_PAGE_SIZE,
  });
  const clauses = ['tenant_id = @tenantId'];
  const params = { tenantId: actor.tenantId };

  const certificateId = queryInteger(query, ['certificateId', 'certificate_id'], { min: 1, max: 1e15, fallback: null });
  if (certificateId !== null) {
    clauses.push('certificate_id = @certificateId');
    params.certificateId = certificateId;
  }
  const bulkOperationId = queryInteger(query, ['bulkOperationId', 'bulk_operation_id', 'operationId'], {
    min: 1,
    max: 1e15,
    fallback: null,
  });
  if (bulkOperationId !== null) {
    clauses.push('bulk_operation_id = @bulkOperationId');
    params.bulkOperationId = bulkOperationId;
  }
  const action = queryString(query, ['action']);
  if (action) {
    clauses.push('action = @action');
    params.action = action;
  }

  const where = clauses.join(' AND ');
  const total = db.get(`SELECT COUNT(*) AS n FROM audit_events WHERE ${where}`, params).n;
  const rows = db.all(`SELECT * FROM audit_events WHERE ${where} ORDER BY id DESC LIMIT @limit OFFSET @offset`, {
    ...params,
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });
  return {
    items: rows.map((row) => presentAuditEvent(row, actor.timezone)),
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

// ---------------------------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------------------------

export const EXPORT_BATCH_ROWS = 500;

/** Query + metadata for an export of everything the given list filters match (no pagination). */
export function buildExportPlan(actor, options) {
  const { where, params } = buildFilter(actor, options);
  return {
    sql: `SELECT c.learner_name, c.course_title, c.serial_number, c.issued_at
            FROM certificates c
           WHERE ${where}
           ORDER BY ${orderBy(options)}`,
    params,
    timeZone: actor.timezone,
    header: ['Learner Name', 'Course Title', 'Serial Number', `Issue Date (${actor.timezone})`],
  };
}

/**
 * Streams the export as CSV text chunks.
 *
 * `reader` must be a dedicated connection. The whole export runs inside one read transaction on
 * it, i.e. against a single consistent snapshot, while the server's main connection keeps serving
 * other requests (WAL readers never block each other or the writer).
 *
 * Rows are pulled in small batches and control returns to the event loop after every batch, so a
 * 100,000-row export costs concurrent requests a millisecond here and there instead of stalling
 * them until it finishes. Memory stays flat: nothing but the current batch is ever buffered, and
 * the consumer's back-pressure decides how fast the next batch is fetched.
 */
export async function* streamCsvExport(reader, plan, { batchRows = EXPORT_BATCH_ROWS } = {}) {
  const formatIssued = createLocalDateTimeFormatter(plan.timeZone);
  let rows;
  reader.exec('BEGIN');
  try {
    rows = reader.iterate(plan.sql, plan.params);
    // The header travels with the first batch: by the time the first chunk exists the query has
    // run and the snapshot is pinned, so a failure to start can still be reported as a proper error.
    let chunk = csvRow(plan.header);

    for (;;) {
      let done = false;
      for (let i = 0; i < batchRows; i += 1) {
        const next = rows.next();
        if (next.done) {
          done = true;
          break;
        }
        const row = next.value;
        chunk += csvRow([row.learner_name, row.course_title, row.serial_number, formatIssued(row.issued_at)]);
      }
      if (chunk) yield chunk;
      if (done) break;
      chunk = '';
      await yieldToEventLoop();
    }
  } finally {
    // Runs on completion, on error, and when the client disconnects mid-download.
    try {
      rows?.return?.();
    } catch {
      // statement already finished
    }
    try {
      reader.exec('ROLLBACK');
    } catch {
      // no transaction left to close
    }
  }
}

export function exportFileName(actor, now = new Date()) {
  const tenant = actor.tenantName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'tenant';
  const stamp = localDateTime(now, actor.timezone).replace(/[-:]/g, '').replace(' ', '-');
  return `certificates-${tenant}-${stamp}.csv`;
}
