/**
 * Thin, synchronous SQLite access layer.
 *
 * Two interchangeable drivers are supported behind one small interface:
 *   - `better-sqlite3` (preferred when its native binding is installed), and
 *   - `node:sqlite`, the driver built into Node.js >= 22.13 (zero-install fallback).
 *
 * Both are synchronous, which is what makes the write paths easy to reason about: a
 * transaction callback runs to completion without ever yielding to the event loop.
 * Cross-process safety does not depend on that, though - every write transaction is
 * `BEGIN IMMEDIATE`, so SQLite itself serialises writers.
 *
 * Set SQLITE_DRIVER=better-sqlite3 | node to force a specific driver.
 */
import fs from 'node:fs';
import path from 'node:path';

import { integerSetting } from '../config.js';

/**
 * How long to wait for a lock held by another process (the load-test generator, a reset, a second
 * server) before giving up: CLI scripts block for that long, request handlers wait asynchronously
 * and then answer 503. DB_BUSY_TIMEOUT_MS overrides the default of 10 seconds.
 */
function lockWaitFromEnv(env = process.env) {
  return integerSetting(env, 'DB_BUSY_TIMEOUT_MS', { fallback: 10_000, min: 0, max: 600_000, unit: 'milliseconds' });
}

// The two settings of this module are read when it loads, but a bad value must not make the import
// itself fail: entry points report configuration problems in one line (checkDatabaseSettings).
let settingsError = null;
let LOCK_WAIT_MS = 10_000;
try {
  LOCK_WAIT_MS = lockWaitFromEnv();
} catch (err) {
  settingsError = err;
}

const WAL_SIZE_LIMIT_BYTES = 16 * 1024 * 1024;
const READER_CACHE_KIB = 1024;

/** Elapsed-time clock for deadlines: it does not jump when the system clock is set, as the wall clock does. */
const monotonicNow = () => performance.now();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Blocks the thread briefly. Only used while a database is being opened, never while serving requests. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** True when SQLite refused an operation because another connection holds the lock it needs. */
export function isBusyError(err) {
  if (!err) return false;
  if (typeof err.code === 'string' && err.code.startsWith('SQLITE_BUSY')) return true; // better-sqlite3
  if (typeof err.errcode === 'number' && (err.errcode & 0xff) === 5) return true; // node:sqlite (extended codes too)
  return /database is locked/i.test(String(err.message ?? ''));
}

async function loadBetterSqlite() {
  const mod = await import('better-sqlite3');
  const Database = mod.default ?? mod;
  new Database(':memory:').close(); // the native binding loads lazily; fail here, not on first use
  return {
    name: 'better-sqlite3',
    open: (file) => new Database(file),
  };
}

async function loadNodeSqlite() {
  // `node:sqlite` announces itself with an ExperimentalWarning on first import. It is a
  // deliberate, tested choice here, so keep that one notice out of the server log.
  const emitWarning = process.emitWarning;
  process.emitWarning = function patchedEmitWarning(warning, ...rest) {
    const type = typeof rest[0] === 'string' ? rest[0] : rest[0]?.type;
    const text = typeof warning === 'string' ? warning : warning?.message;
    if (type === 'ExperimentalWarning' && /sqlite/i.test(String(text))) return undefined;
    return emitWarning.call(process, warning, ...rest);
  };
  try {
    const { DatabaseSync } = await import('node:sqlite');
    return {
      name: 'node:sqlite',
      open: (file) => new DatabaseSync(file),
    };
  } finally {
    process.emitWarning = emitWarning;
  }
}

async function resolveDriver() {
  // Unset or blank means "whichever loads", like every other setting that is left blank.
  const preference = (process.env.SQLITE_DRIVER ?? '').trim().toLowerCase() || 'auto';
  const wantBetter = preference === 'auto' || preference === 'better-sqlite3';
  const wantNode = preference === 'auto' || preference === 'node' || preference === 'node:sqlite';
  if (!wantBetter && !wantNode) {
    throw new Error(`Unsupported SQLITE_DRIVER "${preference}" (use "better-sqlite3" or "node")`);
  }

  const failures = [];
  if (wantBetter) {
    try {
      return await loadBetterSqlite();
    } catch (err) {
      failures.push(`better-sqlite3: ${err.message}`);
    }
  }
  if (wantNode) {
    try {
      return await loadNodeSqlite();
    } catch (err) {
      failures.push(`node:sqlite: ${err.message}`);
    }
  }
  // The native module is built for one Node.js version: after switching versions "npm install"
  // sees nothing to do, and only a rebuild helps.
  const builtForAnotherNode = failures.some((failure) => failure.includes('NODE_MODULE_VERSION'));
  throw new Error(
    (builtForAnotherNode
      ? 'No SQLite driver could be loaded: "better-sqlite3" was installed with another Node.js version. Run "npm rebuild better-sqlite3" (or use Node.js >= 22.13, which has node:sqlite built in).'
      : 'No SQLite driver could be loaded. Use Node.js >= 22.13 (built-in node:sqlite) or make sure the optional "better-sqlite3" dependency installed correctly.') +
      `\n  - ${failures.join('\n  - ')}`,
  );
}

let driver = null;
try {
  driver = await resolveDriver();
} catch (err) {
  settingsError ??= err;
}

export const driverName = driver?.name ?? null;

/**
 * Throws if SQLITE_DRIVER or DB_BUSY_TIMEOUT_MS is unusable (or no SQLite driver could be loaded).
 * openDatabase() checks this too; entry points call it first to report the problem on its own line.
 */
export function checkDatabaseSettings() {
  if (settingsError) throw settingsError;
}

/** Marks errors after which SQLite has already rolled the whole transaction back. */
export class TransactionAbortedError extends Error {
  constructor(cause) {
    super(`SQLite aborted the surrounding transaction: ${cause?.message ?? cause}`, { cause });
    this.name = 'TransactionAbortedError';
  }
}

export class Connection {
  #raw;
  #statements = new Map();
  #depth = 0;

  constructor(raw, file) {
    this.#raw = raw;
    this.file = file;
    this.driver = driver.name;
    this.open = true;
  }

  exec(sql) {
    this.#raw.exec(sql);
  }

  /**
   * Throws when the database cannot be written to (a file of another user, a read-only volume).
   * It only asks: nothing is changed, and a writer that is busy right now is not waited for - that
   * the lock is taken is proof enough that the file can be written.
   */
  assertWritable() {
    const { user_version: version } = this.get('PRAGMA user_version');
    this.exec('PRAGMA busy_timeout = 0');
    try {
      this.exec('BEGIN IMMEDIATE');
      try {
        // Taking the write lock is not enough: on a database that can only be read SQLite quietly
        // turns BEGIN IMMEDIATE into a read transaction. A write statement is what fails there -
        // this one writes the value that is already stored, and is rolled back all the same.
        this.exec(`PRAGMA user_version = ${version}`);
      } finally {
        this.exec('ROLLBACK');
      }
    } catch (err) {
      if (!isBusyError(err)) throw new Error(`the database cannot be written to (${err.message})`);
    } finally {
      this.exec(`PRAGMA busy_timeout = ${LOCK_WAIT_MS}`);
    }
  }

  #statement(sql) {
    let statement = this.#statements.get(sql);
    if (!statement) {
      statement = this.#raw.prepare(sql);
      this.#statements.set(sql, statement);
    }
    return statement;
  }

  /**
   * Parameters are always a single object of named values (`@name` in SQL). Pass exactly the
   * names the statement uses: the two drivers disagree on how lenient to be about extras or
   * omissions, so being exact keeps behaviour identical on both.
   */
  get(sql, params) {
    const statement = this.#statement(sql);
    return params === undefined ? statement.get() : statement.get(params);
  }

  all(sql, params) {
    const statement = this.#statement(sql);
    return params === undefined ? statement.all() : statement.all(params);
  }

  run(sql, params) {
    const statement = this.#statement(sql);
    const info = params === undefined ? statement.run() : statement.run(params);
    return { changes: Number(info.changes), lastInsertRowid: Number(info.lastInsertRowid) };
  }

  /** Lazily steps through a result set. Uses a private statement so it never clashes with the cache. */
  iterate(sql, params) {
    const statement = this.#raw.prepare(sql);
    return params === undefined ? statement.iterate() : statement.iterate(params);
  }

  get inTransaction() {
    return this.#depth > 0;
  }

  /**
   * Runs `fn` atomically. The outermost call opens a transaction (IMMEDIATE by default, so the
   * write lock is taken up front and readers-turned-writers can never deadlock); nested calls
   * become SAVEPOINTs, which lets a caller contain the failure of one unit of work and carry on.
   */
  transaction(fn, { immediate = true } = {}) {
    const outermost = this.#depth === 0;
    const savepoint = `sp_${this.#depth}`;
    this.exec(outermost ? (immediate ? 'BEGIN IMMEDIATE' : 'BEGIN') : `SAVEPOINT ${savepoint}`);
    this.#depth += 1;

    let result;
    try {
      result = fn();
      if (result && typeof result.then === 'function') {
        throw new TypeError('Transaction callbacks must be synchronous');
      }
    } catch (err) {
      this.#depth -= 1;
      if (outermost) {
        try {
          this.exec('ROLLBACK');
        } catch {
          // SQLite already rolled back on its own (e.g. disk full); nothing left to undo.
        }
        throw err;
      }
      try {
        this.exec(`ROLLBACK TO ${savepoint}`);
        this.exec(`RELEASE ${savepoint}`);
      } catch (rollbackError) {
        // The savepoint is gone, which means the whole transaction is: do not let callers continue.
        throw err instanceof TransactionAbortedError ? err : new TransactionAbortedError(err ?? rollbackError);
      }
      throw err;
    }

    this.#depth -= 1;
    try {
      this.exec(outermost ? 'COMMIT' : `RELEASE ${savepoint}`);
    } catch (err) {
      if (outermost) {
        try {
          this.exec('ROLLBACK');
        } catch {
          // already rolled back
        }
        throw err;
      }
      throw new TransactionAbortedError(err);
    }
    return result;
  }

  /**
   * `transaction()` for request handlers: takes the write lock WITHOUT blocking the event loop.
   *
   * SQLite's own busy handler sleeps on the calling thread, which in Node is the thread that
   * serves every request. If another process holds the write lock (the load-test generator, a
   * reset, a second server), a plain BEGIN IMMEDIATE would therefore freeze all requests - reads
   * included - until it gets the lock. Here the lock is only ever *tried*; while it is taken, the
   * request waits asynchronously and the process keeps answering everything else. Once the lock is
   * held, `fn` runs synchronously to COMMIT exactly as in `transaction()`.
   *
   * `whileWaiting` (optional, synchronous) is called every time the lock turns out to be taken.
   * If it returns anything but undefined, the wait is over and that value is the result; `fn`
   * does not run. It is for callers whose outcome can become known through someone else's commit
   * while they queue - an identical request served by another process, typically - so that they
   * answer from it right away instead of waiting on, or timing out behind, an unrelated writer.
   */
  async writeTransaction(fn, { timeoutMs = LOCK_WAIT_MS, whileWaiting } = {}) {
    const deadline = monotonicNow() + timeoutMs;
    let delay = 4;
    for (;;) {
      if (this.#depth !== 0) throw new Error('writeTransaction cannot start inside another transaction');
      let busy;
      this.exec('PRAGMA busy_timeout = 0'); // try once, do not sleep inside SQLite
      try {
        this.exec('BEGIN IMMEDIATE');
        break;
      } catch (err) {
        if (!isBusyError(err)) throw err;
        busy = err;
      } finally {
        this.exec(`PRAGMA busy_timeout = ${LOCK_WAIT_MS}`);
      }
      if (whileWaiting) {
        const settled = whileWaiting();
        if (settled !== undefined) return settled;
      }
      const remaining = deadline - monotonicNow();
      if (remaining <= 0) throw busy;
      await sleep(Math.min(delay, remaining)); // the last attempt lands on the deadline
      delay = Math.min(delay * 2, 100);
    }

    this.#depth = 1;
    let result;
    try {
      result = fn();
      if (result && typeof result.then === 'function') {
        throw new TypeError('Transaction callbacks must be synchronous');
      }
    } catch (err) {
      this.#depth = 0;
      try {
        this.exec('ROLLBACK');
      } catch {
        // SQLite already rolled back on its own
      }
      throw err;
    }
    this.#depth = 0;
    try {
      this.exec('COMMIT');
    } catch (err) {
      try {
        this.exec('ROLLBACK');
      } catch {
        // already rolled back
      }
      throw err;
    }
    return result;
  }

  close() {
    if (!this.open) return;
    this.open = false;
    this.#statements.clear();
    this.#raw.close();
  }
}

/**
 * `mkdir -p`, one level at a time. (Node's own recursive mkdir never returns for a path below a
 * directory that refuses new entries without saying why, such as /proc: it retries for ever.)
 */
function createDirectory(dir) {
  const missing = [];
  for (let current = dir; !fs.existsSync(current); current = path.dirname(current)) {
    missing.unshift(current);
    if (path.dirname(current) === current) break;
  }
  for (const level of missing) {
    try {
      fs.mkdirSync(level);
    } catch (err) {
      if (err.code !== 'EEXIST') throw err; // somebody else created it in the meantime
    }
  }
}

/**
 * Opens (and creates, if needed) the database file.
 *
 * WAL journaling is what lets a long CSV export hold a consistent read snapshot while list
 * requests and writes keep flowing: readers never block the writer and vice versa.
 *
 * `queryOnly` connections are used for exports; they cannot modify the database.
 */
export function openDatabase(file, { queryOnly = false } = {}) {
  checkDatabaseSettings();
  if (!file || file === ':memory:') {
    throw new Error('A database file path is required (in-memory databases are not supported)');
  }
  const resolved = path.resolve(file);
  if (queryOnly) {
    if (!fs.existsSync(resolved)) throw new Error(`Database file does not exist: ${resolved}`);
  } else {
    createDirectory(path.dirname(resolved));
  }

  const connection = new Connection(driver.open(resolved), resolved);
  connection.exec(`PRAGMA busy_timeout = ${LOCK_WAIT_MS}`);
  connection.exec('PRAGMA foreign_keys = ON');
  if (queryOnly) {
    connection.exec('PRAGMA query_only = ON');
    // An export walks one index from end to end and never comes back to a page, so a large page
    // cache buys nothing - but it would be filled (16 MB with better-sqlite3's default) and that
    // memory kept by the process for every export that has ever run at the same time.
    connection.exec(`PRAGMA cache_size = -${READER_CACHE_KIB}`);
  } else {
    try {
      enableWal(connection);
    } catch (err) {
      connection.close();
      throw err;
    }
    connection.exec('PRAGMA synchronous = NORMAL');
    // A large transaction (the load-test generator) grows the WAL file to its size; without a
    // limit the file would stay that large for as long as any process keeps the database open.
    connection.exec(`PRAGMA journal_size_limit = ${WAL_SIZE_LIMIT_BYTES}`);
  }
  return connection;
}

/**
 * Switches the file to WAL journaling (a no-op once it is in that mode).
 *
 * The switch needs an exclusive lock on a brand-new file. When several processes open the same
 * new file at the same moment, SQLite answers "busy" straight away instead of waiting - it cannot
 * tell that situation from a deadlock - so the busy timeout does not help here. The losers simply
 * try again: as soon as one process has made the switch, it succeeds for everyone else.
 */
export function enableWal(connection, { timeoutMs = LOCK_WAIT_MS } = {}) {
  const deadline = monotonicNow() + timeoutMs;
  for (let delay = 5; ; delay = Math.min(delay * 2, 100)) {
    let mode;
    try {
      mode = connection.get('PRAGMA journal_mode = WAL')?.journal_mode;
      if (mode === 'wal') return;
    } catch (err) {
      if (!isBusyError(err) || monotonicNow() >= deadline) throw err;
    }
    if (mode !== undefined && monotonicNow() >= deadline) {
      throw new Error(`Could not switch the database to WAL journaling (journal mode is "${mode}")`);
    }
    sleepSync(delay);
  }
}

/** Deletes a database file together with its WAL side files. */
export function removeDatabaseFiles(file) {
  const resolved = path.resolve(file);
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(resolved + suffix, { force: true });
  }
}
