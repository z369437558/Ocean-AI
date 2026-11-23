/**
 * Certificate queries: list, detail, revocation and the streaming CSV export.
 *
 * The list endpoint and the export share one filter + ordering builder, so an export always
 * contains exactly the rows (and the order) the admin is looking at.
 */
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';

import { csvRow } from '../lib/csv.js';
import { badRequest, notFound } from '../lib/errors.js';
import { assertPlainText, queryInteger, queryString } from '../lib/params.js';
import { foldText } from '../lib/text.js';
import { createLocalDateTimeFormatter, localDateTime, utcOffset } from '../lib/time.js';
import { AUDIT_ACTIONS, revokeCertificate } from './ledger.js';

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
 *
 * "learner" and "course" sort by the folded name (lib/text.js), i.e. ignoring case and accents:
 * "álvarez", "Alvarez" and "ALVAREZ" sort together instead of the accented one landing after "z".
 */
const SORTS = {
  issued: (dir) => `c.issued_local_date ${dir}, c.issued_at ${dir}, c.id ${dir}`,
  learner: (dir) => `c.learner_name_key ${dir}, c.id ${dir}`,
  course: (dir) => `c.course_title_key ${dir}, c.id ${dir}`,
  serial: (dir) => `c.serial_number ${dir}, c.id ${dir}`,
  status: (dir) => `c.status ${dir}, c.id ${dir}`,
};

/**
 * The index that already stores each ordering. List and export name it explicitly (INDEXED BY),
 * so SQLite always walks the index in order - it can stop after one page, and an export starts
 * streaming immediately instead of first sorting the whole tenant, whatever the planner statistics say.
 */
const SORT_INDEXES = {
  issued: 'idx_certificates_issued',
  learner: 'idx_certificates_learner',
  course: 'idx_certificates_course',
  serial: 'idx_certificates_serial',
  status: 'idx_certificates_status',
};

/** Accepted names of each sort key: exactly these, in camelCase, snake_case or kebab-case, any letter case. */
const SORT_NAMES = {
  issued: ['issued', 'issuedAt', 'issueDate', 'issuedDate', 'issuedLocal', 'issuedLocalDate', 'date'],
  learner: ['learner', 'learnerName', 'name'],
  course: ['course', 'courseTitle'],
  serial: ['serial', 'serialNumber'],
  status: ['status'],
};

// A Map, not a plain object: "constructor" or "toString" must not look like known names.
const SORT_ALIASES = new Map();
for (const [sort, names] of Object.entries(SORT_NAMES)) {
  for (const name of names) {
    const words = name.replace(/[A-Z]/g, (letter) => ` ${letter.toLowerCase()}`).split(' ');
    for (const separator of ['', '_', '-']) SORT_ALIASES.set(words.join(separator), sort);
  }
}

const DEFAULT_ORDER = { issued: 'desc', learner: 'asc', course: 'asc', serial: 'asc', status: 'asc' };
const STATUSES = ['all', 'active', 'revoked'];
const KNOWN_AUDIT_ACTIONS = Object.values(AUDIT_ACTIONS);

/**
 * Validates list/export query parameters. Unknown values are rejected rather than silently
 * ignored; a parameter that is present but blank counts as not given.
 */
export function parseListQuery(query, { paginate = true } = {}) {
  const q = queryString(query, ['q', 'search'], { maxLength: 100 }) ?? '';

  const status = (queryString(query, ['status']) ?? 'all').toLowerCase();
  if (!STATUSES.includes(status)) throw badRequest(`"status" must be one of: ${STATUSES.join(', ')}`);

  let sortText = (queryString(query, ['sort', 'sortBy']) ?? 'issued').toLowerCase();
  let order = queryString(query, ['order', 'dir', 'direction', 'sortOrder'])?.toLowerCase();
  if (sortText.startsWith('-')) {
    sortText = sortText.slice(1);
    order ??= 'desc';
  }
  const sort = SORT_ALIASES.get(sortText);
  if (!sort) throw badRequest(`"sort" must be one of: ${Object.keys(SORTS).join(', ')}`);
  order ??= DEFAULT_ORDER[sort];
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

/**
 * The filter shared by list, count and export, in two parts:
 *   - `tenant`: the tenant predicate. It comes from the actor and is always present; nothing the
 *     client sends can widen it.
 *   - `narrowing`: what the search text and the status filter add (possibly nothing).
 *
 * The search looks for the text anywhere in the learner name or the serial number, ignoring case
 * and accents: the stored name key and the search text are folded the same way (lib/text.js), so a
 * plain substring test on the key does the job. Serial numbers are ASCII, for which LIKE is
 * case-insensitive by itself; "%" and "_" in the search text are escaped and stand for themselves.
 */
const escapeLike = (text) => text.replace(/[\\%_]/g, (ch) => `\\${ch}`);

function buildFilter(actor, { q, status }) {
  const tenant = 'c.tenant_id = @tenantId';
  const params = { tenantId: actor.tenantId };
  const narrowing = [];
  if (q) {
    const needle = foldText(q);
    if (needle) {
      narrowing.push("(instr(c.learner_name_key, @needle) > 0 OR c.serial_number LIKE @serialPattern ESCAPE '\\')");
      params.needle = needle;
      params.serialPattern = `%${escapeLike(needle)}%`;
    } else {
      narrowing.push('0'); // nothing searchable is left of the text (it was accents only): no row matches
    }
  }
  if (status !== 'all') {
    narrowing.push('c.status = @status');
    params.status = status;
  }
  return { tenant, narrowing, searching: Boolean(q), where: [tenant, ...narrowing].join(' AND '), params };
}

const orderBy = ({ sort, order }) => SORTS[sort](order === 'desc' ? 'DESC' : 'ASC');
const orderedSource = ({ sort }) => `certificates c INDEXED BY ${SORT_INDEXES[sort]}`;

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
  const { where, params, searching } = buildFilter(actor, options);
  const { page, pageSize } = options;
  // A search has to look at every certificate of the tenant to count its matches. The learner
  // index holds all the columns the filter reads, so the count never touches the table itself.
  const countSource = searching ? `certificates c INDEXED BY ${SORT_INDEXES.learner}` : 'certificates c';

  // Count and page are read inside one snapshot so "total" always matches the rows returned.
  const { total, rows } = db.transaction(
    () => ({
      total: db.get(`SELECT COUNT(*) AS n FROM ${countSource} WHERE ${where}`, params).n,
      rows: db.all(
        `SELECT c.id, c.serial_number, c.learner_id, c.learner_name, c.course_id, c.course_title,
                c.status, c.issued_at, c.issued_local_date
           FROM ${orderedSource(options)}
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
  assertPlainText(reason, '"reason"', { allowLineBreaks: true });
  const text = reason.trim();
  if (text.length > MAX_REASON_LENGTH) throw badRequest(`"reason" must be at most ${MAX_REASON_LENGTH} characters`);
  return text || null;
}

/**
 * Revokes a certificate. Idempotent: revoking an already revoked certificate succeeds, changes
 * nothing and writes no audit event (`alreadyRevoked: true` tells the caller it was a no-op).
 */
export async function revoke(db, actor, certificateId, body, { now = () => new Date() } = {}) {
  const reason = parseRevocationReason(body);

  // Already revoked: there is nothing to write, so the answer needs no write lock. Returns
  // undefined while the certificate is still active.
  const answerIfAlreadyRevoked = () => {
    const current =
      certificateId === null
        ? undefined
        : db.get('SELECT status FROM certificates WHERE id = @certificateId AND tenant_id = @tenantId', {
            certificateId,
            tenantId: actor.tenantId,
          });
    if (!current) throw notFound('Certificate');
    return current.status === 'revoked' ? { ...getCertificate(db, actor, certificateId), alreadyRevoked: true } : undefined;
  };

  const settled = answerIfAlreadyRevoked();
  if (settled) return settled;

  return db.writeTransaction(
    () => {
      // The conditional UPDATE inside decides under the lock; a racing revoke simply finds nothing to change.
      const changed = revokeCertificate(db, {
        tenantId: actor.tenantId,
        certificateId,
        actor,
        revokedAt: now(),
        reason,
      });
      return { ...getCertificate(db, actor, certificateId), alreadyRevoked: !changed };
    },
    // Someone else may revoke the certificate while this request is still queueing for the lock;
    // from then on the answer is known, however long the lock stays taken.
    { whileWaiting: answerIfAlreadyRevoked },
  );
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
  const action = queryString(query, ['action'], { maxLength: 64 });
  if (action !== undefined) {
    if (!KNOWN_AUDIT_ACTIONS.includes(action)) throw badRequest(`"action" must be one of: ${KNOWN_AUDIT_ACTIONS.join(', ')}`);
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

/** Rows the export looks at between two visits to the event loop (matching the filter or not). */
export const EXPORT_BATCH_ROWS = 500;

/**
 * Query + metadata for an export of everything the given list filters match (no pagination).
 *
 * Unlike the list query, the search/status filter is not part of WHERE: it is returned as a
 * column (`matches`) next to every row of the tenant, in the requested order. See
 * streamCsvExport for the reason.
 */
export function buildExportPlan(actor, options) {
  const { tenant, narrowing, params } = buildFilter(actor, options);
  const filtered = narrowing.length > 0;
  return {
    sql: `SELECT c.learner_name, c.course_title, c.serial_number, c.issued_at${filtered ? `, (${narrowing.join(' AND ')}) AS matches` : ''}
            FROM ${orderedSource(options)}
           WHERE ${tenant}
           ORDER BY ${orderBy(options)}`,
    params,
    filtered,
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
 * SQLite calls are synchronous, so the export must never do much in one go. It walks the tenant's
 * rows in the requested order and hands control back to the event loop after every `batchRows`
 * rows it has LOOKED AT. That is why the filter is evaluated as a column instead of in WHERE: with
 * a filter in WHERE, fetching "the next matching row" can mean scanning the rest of the table in
 * a single call when few rows match, and every other request would wait for that scan. This way
 * the work between two visits to the event loop is the same small amount whether the filter
 * matches every row or none.
 *
 * Memory stays flat: nothing but the current batch is ever buffered, and the consumer's
 * back-pressure decides how fast the next batch is fetched.
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
        if (plan.filtered && !row.matches) continue;
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
