// Plays "another process that has a brand-new database file open and is writing to it":
// creates <file> in SQLite's default rollback-journal mode, takes the write lock, prints "locked",
// keeps the lock for <ms> milliseconds, commits and exits.
//
//   node test/support/hold-lock.mjs <file> <ms>
//
// Uses whichever SQLite driver is available, directly - the app's own database layer would switch
// the file to WAL mode, and the point of this script is a file that is not in WAL mode yet.
const [file, ms] = process.argv.slice(2);

let open;
try {
  const { default: Database } = await import('better-sqlite3');
  new Database(':memory:').close();
  open = (path) => new Database(path);
} catch {
  process.removeAllListeners('warning'); // node:sqlite announces itself as experimental
  const { DatabaseSync } = await import('node:sqlite');
  open = (path) => new DatabaseSync(path);
}

const db = open(file);
db.exec('PRAGMA journal_mode = DELETE');
db.exec('BEGIN IMMEDIATE');
db.exec('CREATE TABLE IF NOT EXISTS filler (id INTEGER PRIMARY KEY)');
process.stdout.write('locked\n');
setTimeout(() => {
  db.exec('COMMIT');
  db.close();
}, Number(ms));
