/**
 * Database schema.
 *
 * Tenant isolation is enforced twice: every query in the service layer is scoped by the actor's
 * tenant, and the schema itself refuses cross-tenant rows - every reference between tenant-owned
 * tables is a composite `(id, tenant_id)` foreign key, so a certificate in one tenant can never
 * point at a course, learner, enrollment, admin or bulk operation of another, and an audit event
 * can never point at another tenant's certificate.
 */

/** Bump whenever SCHEMA_SQL changes; a database file from another version is refused at start-up. */
export const SCHEMA_VERSION = 4;

const SCHEMA_SQL = `
CREATE TABLE tenants (
  id          INTEGER PRIMARY KEY,
  name        TEXT    NOT NULL UNIQUE,
  code        TEXT    NOT NULL UNIQUE,            -- serial-number prefix, e.g. EAST
  timezone    TEXT    NOT NULL,                   -- IANA zone, e.g. Australia/Sydney
  last_serial INTEGER NOT NULL DEFAULT 0,         -- per-tenant serial counter
  created_at  TEXT    NOT NULL
) STRICT;

CREATE TABLE admins (
  id           INTEGER PRIMARY KEY,
  tenant_id    INTEGER NOT NULL REFERENCES tenants (id),
  email        TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT    NOT NULL,
  created_at   TEXT    NOT NULL,
  UNIQUE (id, tenant_id)
) STRICT;

-- Names are stored twice: as written, and folded for search and sort (case and accents removed,
-- see lib/text.js). SQLite itself only folds ASCII letters, so the folding is done once, in the
-- application, when the row is written; every ordering by name uses the folded column.
CREATE TABLE courses (
  id           INTEGER PRIMARY KEY,
  tenant_id    INTEGER NOT NULL REFERENCES tenants (id),
  title        TEXT    NOT NULL CHECK (length(trim(title)) > 0),
  title_key    TEXT    NOT NULL,                                           -- folded title
  is_generated INTEGER NOT NULL DEFAULT 0 CHECK (is_generated IN (0, 1)),  -- 1 = load-test data
  created_at   TEXT    NOT NULL,
  UNIQUE (tenant_id, title),
  UNIQUE (id, tenant_id)
) STRICT;

CREATE TABLE learners (
  id           INTEGER PRIMARY KEY,
  tenant_id    INTEGER NOT NULL REFERENCES tenants (id),
  full_name    TEXT    NOT NULL CHECK (length(trim(full_name)) > 0),
  name_key     TEXT    NOT NULL,                                           -- folded full_name
  email        TEXT,
  is_generated INTEGER NOT NULL DEFAULT 0 CHECK (is_generated IN (0, 1)),
  created_at   TEXT    NOT NULL,
  UNIQUE (id, tenant_id)
) STRICT;
CREATE INDEX idx_learners_tenant ON learners (tenant_id, is_generated);

CREATE TABLE enrollments (
  id           INTEGER PRIMARY KEY,
  tenant_id    INTEGER NOT NULL,
  course_id    INTEGER NOT NULL,
  learner_id   INTEGER NOT NULL,
  status       TEXT    NOT NULL CHECK (status IN ('not_started', 'in_progress', 'completed')),
  completed_at TEXT,
  created_at   TEXT    NOT NULL,
  UNIQUE (tenant_id, course_id, learner_id),
  UNIQUE (id, tenant_id),
  CHECK ((status = 'completed') = (completed_at IS NOT NULL)),
  FOREIGN KEY (course_id, tenant_id)  REFERENCES courses (id, tenant_id),
  FOREIGN KEY (learner_id, tenant_id) REFERENCES learners (id, tenant_id)
) STRICT;
CREATE INDEX idx_enrollments_learner ON enrollments (learner_id);

-- One row per bulk-issue request that actually executed. It doubles as the idempotency record:
-- response_body is replayed verbatim to every retry that carries the same key and payload.
CREATE TABLE bulk_issue_operations (
  id               INTEGER PRIMARY KEY,
  tenant_id        INTEGER NOT NULL,
  actor_admin_id   INTEGER NOT NULL,
  course_id        INTEGER NOT NULL,
  idempotency_key  TEXT,
  request_hash     TEXT    NOT NULL,
  status           TEXT    NOT NULL CHECK (status IN ('running', 'completed')),
  issued_count     INTEGER NOT NULL DEFAULT 0,
  skipped_count    INTEGER NOT NULL DEFAULT 0,
  failed_count     INTEGER NOT NULL DEFAULT 0,
  response_status  INTEGER,
  response_body    TEXT,
  created_at       TEXT    NOT NULL,
  completed_at     TEXT,
  UNIQUE (id, tenant_id),
  FOREIGN KEY (actor_admin_id, tenant_id) REFERENCES admins (id, tenant_id),
  FOREIGN KEY (course_id, tenant_id)      REFERENCES courses (id, tenant_id)
) STRICT;
CREATE UNIQUE INDEX idx_bulk_ops_idempotency
  ON bulk_issue_operations (tenant_id, actor_admin_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX idx_bulk_ops_tenant ON bulk_issue_operations (tenant_id, id);
CREATE INDEX idx_bulk_ops_course ON bulk_issue_operations (course_id);

CREATE TABLE certificates (
  id                  INTEGER PRIMARY KEY,
  tenant_id           INTEGER NOT NULL,
  course_id           INTEGER NOT NULL,
  learner_id          INTEGER NOT NULL,
  enrollment_id       INTEGER,
  serial_number       TEXT    NOT NULL UNIQUE,
  -- Names are snapshotted: a certificate is an issued document and must not change when the
  -- learner or course is renamed. It also keeps list/search/export free of joins.
  learner_name        TEXT    NOT NULL CHECK (length(trim(learner_name)) > 0),
  course_title        TEXT    NOT NULL CHECK (length(trim(course_title)) > 0),
  -- The same two names folded for search and sort, like courses.title_key and learners.name_key.
  learner_name_key    TEXT    NOT NULL,
  course_title_key    TEXT    NOT NULL,
  status              TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  issued_at           TEXT    NOT NULL,           -- UTC instant, ISO-8601 (source of truth)
  -- Calendar date of issued_at in the tenant's time zone, materialised at issue time so that
  -- "sort by issue date" is index-backed and follows the tenant-local calendar, not UTC.
  issued_local_date   TEXT    NOT NULL CHECK (issued_local_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  issued_by_admin_id  INTEGER,
  bulk_operation_id   INTEGER,
  revoked_at          TEXT,
  revoked_by_admin_id INTEGER,
  revocation_reason   TEXT,
  -- At most one certificate per learner per course, ever. This is the last line of defence
  -- against double issuance, whatever the application layer does.
  UNIQUE (tenant_id, course_id, learner_id),
  UNIQUE (id, tenant_id),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
  FOREIGN KEY (course_id, tenant_id)           REFERENCES courses (id, tenant_id),
  FOREIGN KEY (learner_id, tenant_id)          REFERENCES learners (id, tenant_id),
  FOREIGN KEY (enrollment_id, tenant_id)       REFERENCES enrollments (id, tenant_id),
  FOREIGN KEY (issued_by_admin_id, tenant_id)  REFERENCES admins (id, tenant_id),
  FOREIGN KEY (bulk_operation_id, tenant_id)   REFERENCES bulk_issue_operations (id, tenant_id),
  FOREIGN KEY (revoked_by_admin_id, tenant_id) REFERENCES admins (id, tenant_id)
) STRICT;
-- One index per sort order, each ending in id: the deterministic tie-breaker for equal sort keys.
-- The learner index also carries the other two columns a search or status filter looks at, so
-- counting the matches of a search reads this index alone, without visiting the table.
CREATE INDEX idx_certificates_issued  ON certificates (tenant_id, issued_local_date, issued_at, id);
CREATE INDEX idx_certificates_learner ON certificates (tenant_id, learner_name_key, id, serial_number, status);
CREATE INDEX idx_certificates_course  ON certificates (tenant_id, course_title_key, id);
CREATE INDEX idx_certificates_serial  ON certificates (tenant_id, serial_number, id);
CREATE INDEX idx_certificates_status  ON certificates (tenant_id, status, id);
CREATE INDEX idx_certificates_learner_id ON certificates (learner_id);
CREATE INDEX idx_certificates_enrollment ON certificates (enrollment_id);
CREATE INDEX idx_certificates_bulk_op ON certificates (bulk_operation_id) WHERE bulk_operation_id IS NOT NULL;

-- Append-only audit trail. Exactly one row per certificate issuance and per effective revocation.
CREATE TABLE audit_events (
  id                INTEGER PRIMARY KEY,
  tenant_id         INTEGER NOT NULL REFERENCES tenants (id),
  actor_admin_id    INTEGER,
  actor_email       TEXT    NOT NULL,
  action            TEXT    NOT NULL CHECK (action IN ('certificate.issued', 'certificate.revoked')),
  certificate_id    INTEGER NOT NULL,
  bulk_operation_id INTEGER,
  details           TEXT    NOT NULL DEFAULT '{}',
  created_at        TEXT    NOT NULL,
  FOREIGN KEY (actor_admin_id, tenant_id)    REFERENCES admins (id, tenant_id),
  FOREIGN KEY (certificate_id, tenant_id)    REFERENCES certificates (id, tenant_id),
  FOREIGN KEY (bulk_operation_id, tenant_id) REFERENCES bulk_issue_operations (id, tenant_id)
) STRICT;
CREATE INDEX idx_audit_tenant      ON audit_events (tenant_id, id);
CREATE INDEX idx_audit_certificate ON audit_events (certificate_id, id);
CREATE INDEX idx_audit_bulk_op     ON audit_events (bulk_operation_id) WHERE bulk_operation_id IS NOT NULL;
`;

const readVersion = (db) => db.get('PRAGMA user_version').user_version;

/** Creates the schema on an empty database; a no-op when it is already at the current version. */
export function migrate(db) {
  if (readVersion(db) === SCHEMA_VERSION) return;
  db.transaction(() => {
    // Look again now that the write lock is held: another process starting at the same moment
    // may have created the schema while this one was waiting.
    const version = readVersion(db);
    if (version === SCHEMA_VERSION) return;
    if (version !== 0) {
      throw new Error(
        `Database schema version ${version} is not supported by this build (expected ${SCHEMA_VERSION}). ` +
          'Stop the server and run "npm run db:reset" to recreate the demo database.',
      );
    }
    db.exec(SCHEMA_SQL);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  });
}
