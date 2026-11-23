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

const BUSY_TIMEOUT_MS = 10_000;

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
  const preference = (process.env.SQLITE_DRIVER ?? 'auto').trim().toLowerCase();
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
  throw new Error(
    'No SQLite driver could be loaded. Use Node.js >= 22.13 (built-in node:sqlite) or make sure the ' +
      `optional "better-sqlite3" dependency installed correctly.\n  - ${failures.join('\n  - ')}`,
  );
}

const driver = await resolveDriver();

export const driverName = driver.name;

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

  close() {
    if (!this.open) return;
    this.open = false;
    this.#statements.clear();
    this.#raw.close();
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
  if (!file || file === ':memory:') {
    throw new Error('A database file path is required (in-memory databases are not supported)');
  }
  const resolved = path.resolve(file);
  if (queryOnly) {
    if (!fs.existsSync(resolved)) throw new Error(`Database file does not exist: ${resolved}`);
  } else {
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
  }

  const connection = new Connection(driver.open(resolved), resolved);
  connection.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  connection.exec('PRAGMA foreign_keys = ON');
  if (queryOnly) {
    connection.exec('PRAGMA query_only = ON');
  } else {
    connection.exec('PRAGMA journal_mode = WAL');
    connection.exec('PRAGMA synchronous = NORMAL');
  }
  return connection;
}

/** Deletes a database file together with its WAL side files. */
export function removeDatabaseFiles(file) {
  const resolved = path.resolve(file);
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(resolved + suffix, { force: true });
  }
}
