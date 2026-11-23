#!/usr/bin/env node
/**
 * Database initialisation CLI.
 *
 *   node scripts/init-db.js           # create schema + demo data if the database is empty
 *   node scripts/init-db.js --reset   # restore the pristine quick-start dataset
 *
 * `--reset` empties and re-seeds the tables inside one transaction; it never deletes the file of
 * a usable database, so a server that has it open simply sees the fresh data afterwards. If
 * another process is in the middle of a long write, the reset gives up without changing anything.
 */
import fs from 'node:fs';
import { parseArgs } from 'node:util';

import { openInitializedDatabase } from '../src/bootstrap.js';
import { loadConfig, resolveUserPath } from '../src/config.js';
import { SCHEMA_VERSION } from '../src/db/schema.js';
import { seedDemoData } from '../src/db/seed.js';
import { isBusyError, openDatabase, removeDatabaseFiles } from '../src/db/sqlite.js';

const { values } = parseArgs({
  options: { reset: { type: 'boolean', default: false }, db: { type: 'string' } },
});

const dbPath = values.db ? resolveUserPath(values.db) : loadConfig().dbPath;

// Children before parents, so foreign keys stay satisfied at every step.
const TABLES_IN_DELETE_ORDER = [
  'audit_events',
  'certificates',
  'bulk_issue_operations',
  'enrollments',
  'learners',
  'courses',
  'admins',
  'tenants',
];

/** Returns 'done', 'empty' (nothing to reset yet) or 'incompatible' (file from another schema version). */
function resetInPlace() {
  const db = openDatabase(dbPath);
  try {
    const { user_version: version } = db.get('PRAGMA user_version');
    if (version === 0) return 'empty';
    if (version !== SCHEMA_VERSION) return 'incompatible';
    db.transaction(() => {
      for (const table of TABLES_IN_DELETE_ORDER) db.exec(`DELETE FROM ${table}`);
      seedDemoData(db);
    });
    try {
      // Hand the space of removed load-test rows back to the file system: rebuild the file, then
      // fold the write-ahead log into it (which is what actually shrinks both files on disk).
      db.exec('VACUUM');
      db.exec('PRAGMA busy_timeout = 1000');
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      // another connection is busy; the files are merely larger than necessary for now
    }
    return 'done';
  } finally {
    db.close();
  }
}

if (values.reset && fs.existsSync(dbPath)) {
  let outcome;
  try {
    outcome = resetInPlace();
  } catch (err) {
    // Never fall back to deleting the file here: a running server would keep writing to the
    // unlinked file and everything it acknowledged afterwards would be lost.
    if (isBusyError(err)) {
      console.error('The database is busy (another process is writing to it). Nothing was changed; try again in a moment.');
    } else {
      console.error(`Reset failed, nothing was changed: ${err.message}`);
      console.error(`If the file is damaged, stop the server and delete ${dbPath}* to start over.`);
    }
    process.exit(1);
  }
  if (outcome === 'done') {
    console.log(`Demo data restored in ${dbPath}`);
    process.exit(0);
  }
  if (outcome === 'incompatible') {
    console.log('The database file was created by a different version of this app; recreating it.');
    console.log('(If a server is still running on it, restart that server now.)');
    removeDatabaseFiles(dbPath);
  }
}

const db = openInitializedDatabase(dbPath, { log: console.log });
const counts = db.get(
  `SELECT (SELECT COUNT(*) FROM tenants) AS tenants, (SELECT COUNT(*) FROM courses) AS courses,
          (SELECT COUNT(*) FROM learners) AS learners, (SELECT COUNT(*) FROM certificates) AS certificates`,
);
console.log(
  `Database ready at ${dbPath}: ${counts.tenants} tenants, ${counts.courses} courses, ` +
    `${counts.learners} learners, ${counts.certificates} certificates.`,
);
db.close();
