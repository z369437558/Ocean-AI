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
 *
 * Every problem ends in a short message (no stack trace) and exit code 1.
 */
import fs from 'node:fs';
import { parseArgs } from 'node:util';

import { openInitializedDatabase } from '../src/bootstrap.js';
import { loadConfig, resolveUserPath } from '../src/config.js';
import { SCHEMA_VERSION } from '../src/db/schema.js';
import { seedDemoData } from '../src/db/seed.js';
import { checkDatabaseSettings, isBusyError, openDatabase, removeDatabaseFiles } from '../src/db/sqlite.js';

const USAGE = 'Usage: node scripts/init-db.js [--reset] [--db path]';

function fail(message) {
  console.error(message);
  process.exit(1);
}

let values;
let dbPath;
try {
  ({ values } = parseArgs({
    options: { reset: { type: 'boolean', default: false }, db: { type: 'string' } },
    allowPositionals: false,
  }));
} catch (err) {
  fail(`${err.message}\n${USAGE}`);
}
if (values.db !== undefined && values.db.trim() === '') fail(`--db needs a path (got an empty value)\n${USAGE}`);
try {
  checkDatabaseSettings(); // SQLITE_DRIVER, DB_BUSY_TIMEOUT_MS
  dbPath = values.db !== undefined ? resolveUserPath(values.db) : loadConfig().dbPath;
} catch (err) {
  fail(err.message);
}

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

/**
 * Returns 'done', 'done-not-compacted' (data restored, but another connection kept the files from
 * shrinking yet), 'empty' (nothing to reset yet) or 'incompatible' (file from another schema version).
 */
function resetInPlace() {
  const db = openDatabase(dbPath);
  try {
    const { user_version: version } = db.get('PRAGMA user_version');
    if (version === 0) return 'empty';
    if (version !== SCHEMA_VERSION) return 'incompatible';
    db.transaction(() => {
      for (const table of TABLES_IN_DELETE_ORDER) db.exec(`DELETE FROM ${table}`);
      seedDemoData(db);
      // The load-test generator leaves planner statistics behind (PRAGMA optimize). They describe
      // rows that are gone now; a pristine database has none.
      for (const { name } of db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'sqlite_stat%'")) {
        db.exec(`DROP TABLE ${name}`);
      }
    });
    try {
      // Hand the space of removed load-test rows back to the file system: rebuild the file, then
      // fold the write-ahead log into it (which is what actually shrinks both files on disk).
      db.exec('VACUUM');
      db.exec('PRAGMA busy_timeout = 1000');
      // The pragma reports a checkpoint it could not finish in its "busy" column, not as an error.
      const checkpoint = db.get('PRAGMA wal_checkpoint(TRUNCATE)');
      return checkpoint?.busy ? 'done-not-compacted' : 'done';
    } catch {
      return 'done-not-compacted'; // the data is restored either way
    }
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
  if (outcome === 'done' || outcome === 'done-not-compacted') {
    console.log(`Demo data restored in ${dbPath}`);
    if (outcome === 'done-not-compacted') {
      console.log('(A download or another connection still reads the old data; the files shrink with the next writes after it has finished.)');
    }
    process.exit(0);
  }
  if (outcome === 'incompatible') {
    console.log('The database file was created by a different version of this app; recreating it.');
    console.log('(If a server is still running on it, restart that server now.)');
    removeDatabaseFiles(dbPath);
  }
}

let db;
try {
  db = openInitializedDatabase(dbPath, { log: console.log });
} catch (err) {
  fail(`Could not open the database at ${dbPath}: ${err.message}`);
}
const counts = db.get(
  `SELECT (SELECT COUNT(*) FROM tenants) AS tenants, (SELECT COUNT(*) FROM courses) AS courses,
          (SELECT COUNT(*) FROM learners) AS learners, (SELECT COUNT(*) FROM certificates) AS certificates`,
);
console.log(
  `Database ready at ${dbPath}: ${counts.tenants} tenants, ${counts.courses} courses, ` +
    `${counts.learners} learners, ${counts.certificates} certificates.`,
);
db.close();
