/** Opens the database and makes sure it holds the schema and the quick-start demo data. */
import { migrate } from './db/schema.js';
import { isSeeded, seedDemoData } from './db/seed.js';
import { openDatabase } from './db/sqlite.js';

export function openInitializedDatabase(dbPath, { log = () => {} } = {}) {
  const db = openDatabase(dbPath);
  try {
    migrate(db);
    if (!isSeeded(db) && seedDemoData(db)) log(`Created demo data in ${dbPath}`);
    // An initialised database is only read while it is opened. Without this check a file that
    // cannot be written would first show as a 500 on the first bulk issue or revocation.
    db.assertWritable();
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}
