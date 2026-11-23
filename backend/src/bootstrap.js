/** Opens the database and makes sure it holds the schema and the quick-start demo data. */
import { migrate } from './db/schema.js';
import { isSeeded, seedDemoData } from './db/seed.js';
import { openDatabase } from './db/sqlite.js';

export function openInitializedDatabase(dbPath, { log = () => {} } = {}) {
  const db = openDatabase(dbPath);
  try {
    migrate(db);
    if (!isSeeded(db) && seedDemoData(db)) log(`Created demo data in ${dbPath}`);
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}
