#!/usr/bin/env node
/**
 * Database initialisation CLI.
 *
 *   node scripts/init-db.js           # create schema + demo data if the database is empty
 *   node scripts/init-db.js --reset   # restore the pristine quick-start dataset
 *
 * `--reset` empties and re-seeds the tables inside one transaction instead of deleting the file,
 * so it is safe even while the server is running (it simply sees the fresh data afterwards).
 */
import { parseArgs } from 'node:util';

import { openInitializedDatabase } from '../src/bootstrap.js';
import { loadConfig } from '../src/config.js';
import { seedDemoData } from '../src/db/seed.js';
import { openDatabase, removeDatabaseFiles } from '../src/db/sqlite.js';

const { values } = parseArgs({
  options: { reset: { type: 'boolean', default: false }, db: { type: 'string' } },
});

const dbPath = values.db ? loadConfig({ DB_PATH: values.db }).dbPath : loadConfig().dbPath;

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

function resetInPlace() {
  const db = openDatabase(dbPath);
  try {
    const { user_version: version } = db.get('PRAGMA user_version');
    if (version === 0) return false; // empty file: nothing to wipe
    db.transaction(() => {
      for (const table of TABLES_IN_DELETE_ORDER) db.exec(`DELETE FROM ${table}`);
      seedDemoData(db);
    });
    try {
      db.exec('VACUUM'); // hand the space of removed load-test rows back to the file system
    } catch {
      // another connection is busy; the file is merely larger than necessary
    }
    return true;
  } finally {
    db.close();
  }
}

if (values.reset) {
  let done = false;
  try {
    done = resetInPlace();
  } catch (err) {
    console.warn(`In-place reset was not possible (${err.message}); recreating the database file.`);
    removeDatabaseFiles(dbPath);
  }
  if (done) {
    console.log(`Demo data restored in ${dbPath}`);
    process.exit(0);
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
