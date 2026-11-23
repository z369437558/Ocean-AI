/**
 * Test harness. Tests are black-box wherever possible: they start the real server entry point as
 * a child process on a throw-away database file and talk to it over HTTP, the way a client would.
 * A second connection to the same file is used only to count rows (certificates, audit events).
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDatabase } from '../src/db/sqlite.js';

const BACKEND_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const ALICE = 'alice@east.test';
export const BOB = 'bob@west.test';

/** Ids of the quick-start rows (a fresh database always assigns the same ones). */
export const SEED = Object.freeze({
  east: { safety101: 1, firstAid: 2, forklift: 3, alexLeeCertificate: 1, revokedCertificate: 2, certificateCount: 7 },
  west: { safety101: 4, heights: 5, manualHandling: 6, alexLeeCertificate: 8, certificateCount: 4 },
});

// Temporary directories are removed by the suites themselves; this is the safety net for a run
// that is interrupted (Ctrl+C, a test runner timeout) before their `after` hooks get the chance.
const tempDirs = new Set();
process.on('exit', () => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => process.exit(signal === 'SIGINT' ? 130 : 143)); // runs the exit handler above
}

export function createTempDir(prefix = 'cert-admin-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.add(dir);
  return dir;
}

export function removeTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  tempDirs.delete(dir);
}

/**
 * Runs a node entry point of the backend to completion: `{ code, output }` (stdout + stderr).
 * A process that is still running after `timeoutMs` is killed and reported with `code: null`.
 */
function runNodeToExit(args, { env = {}, timeoutMs = 180_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: BACKEND_DIR,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

/** Runs a CLI script from backend/scripts and resolves with its combined output; rejects on a non-zero exit. */
export async function runScript(script, args = [], options) {
  const { code, output } = await runScriptToExit(script, args, options);
  if (code !== 0) throw new Error(`node scripts/${script} ${args.join(' ')} exited with code ${code}\n${output}`);
  return output;
}

/** Like `runScript`, for scripts that are expected to fail: resolves with `{ code, output }`. */
export function runScriptToExit(script, args = [], options) {
  return runNodeToExit([path.join('scripts', script), ...args], options);
}

// Everything a server under test depends on is pinned here, so settings exported in the
// developer's shell (HOST, EXPORT_...) cannot change what the tests observe. SQLITE_DRIVER and
// DB_BUSY_TIMEOUT_MS are inherited on purpose: the suite is meant to be run with either driver.
const serverEnv = (dbPath, env) => ({
  PORT: '0',
  HOST: '127.0.0.1',
  DB_PATH: dbPath,
  LOG_REQUESTS: '0',
  STATIC_DIR: path.join(BACKEND_DIR, 'no-frontend'),
  EXPORT_MAX_CONCURRENT: '',
  EXPORT_IDLE_TIMEOUT_MS: '',
  ...env,
});

const EXIT_WITH_PARENT = path.join('test', 'support', 'exit-with-parent.mjs');

/** For start-ups that are expected to fail: runs `src/server.js` until it exits, `{ code, output }`. */
export function runServerToExit(dbPath, { env = {} } = {}) {
  return runNodeToExit([path.join('src', 'server.js')], { env: serverEnv(dbPath, env), timeoutMs: 20_000 });
}

/** Starts `src/server.js` on a free port and resolves once it accepts requests. */
export function startServer(dbPath, { env = {} } = {}) {
  return new Promise((resolve, reject) => {
    // stdin is a pipe held by this process: see test/support/exit-with-parent.mjs.
    const child = spawn(process.execPath, ['--import', `./${EXIT_WITH_PARENT.replaceAll(path.sep, '/')}`, path.join('src', 'server.js')], {
      cwd: BACKEND_DIR,
      env: { ...process.env, ...serverEnv(dbPath, env) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin.on('error', () => {}); // the server may already be gone when the pipe is closed
    let output = '';
    let settled = false;
    const timer = setTimeout(() => fail(new Error(`Server did not start in time:\n${output}`)), 20_000);

    function fail(err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      reject(err);
    }
    function onData(chunk) {
      output += chunk;
      const match = output.match(/listening on (http:\/\/localhost:\d+)/);
      if (match && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve({
          baseUrl: match[1].replace('localhost', '127.0.0.1'),
          output: () => output,
          stop: () =>
            new Promise((done) => {
              if (child.exitCode !== null) return done();
              child.once('exit', () => done());
              child.kill('SIGTERM');
              setTimeout(() => child.kill('SIGKILL'), 3000).unref();
            }),
        });
      }
    }
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', fail);
    child.on('exit', (code) => fail(new Error(`Server exited early with code ${code}:\n${output}`)));
  });
}

/** Fresh database + server in one go. `close()` stops the server and deletes the files. */
export async function startFreshServer(options) {
  const dir = createTempDir();
  const dbPath = path.join(dir, 'test.sqlite');
  const server = await startServer(dbPath, options);
  return {
    ...server,
    dir,
    dbPath,
    /** Row-counting connection for assertions. */
    openDb: () => openDatabase(dbPath),
    close: async () => {
      await server.stop();
      removeTempDir(dir);
    },
  };
}

/**
 * Minimal HTTP client bound to one actor.
 * Responses: `{ status, headers, text, json }` (json is null for non-JSON bodies).
 */
export function clientFor(baseUrl, actorEmail) {
  async function request(method, urlPath, { body, headers = {}, rawBody } = {}) {
    const init = { method, headers: { ...headers } };
    if (actorEmail) init.headers['X-Actor-Email'] = actorEmail;
    if (rawBody !== undefined) {
      init.body = rawBody;
    } else if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const response = await fetch(baseUrl + urlPath, init);
    const text = await response.text();
    let json = null;
    if ((response.headers.get('content-type') ?? '').includes('application/json')) json = JSON.parse(text);
    return { status: response.status, headers: response.headers, text, json };
  }
  return {
    get: (urlPath, options) => request('GET', urlPath, options),
    post: (urlPath, body, options = {}) => request('POST', urlPath, { body, ...options }),
    bulkIssue: (courseId, idempotencyKey, extra = {}) =>
      request('POST', '/api/bulk-issues', {
        body: { courseId, ...extra },
        headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {},
      }),
  };
}

/** RFC 4180 parser (quoted fields, doubled quotes, embedded separators and newlines). */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Counts used by "nothing was written" assertions. */
export function countRows(db, tenantId) {
  const scope = tenantId ? ' WHERE tenant_id = @tenantId' : '';
  const params = tenantId ? { tenantId } : undefined;
  const count = (table) => db.get(`SELECT COUNT(*) AS n FROM ${table}${scope}`, params).n;
  return {
    certificates: count('certificates'),
    auditEvents: count('audit_events'),
    operations: count('bulk_issue_operations'),
  };
}

/**
 * Streaming GET built on node:http so a test can stop reading mid-download.
 * Resolves as soon as the first body bytes arrive, with the response paused:
 *   { status, headers, bytesSoFar(), finished(), resume(): Promise<string> }
 */
export function openStream(baseUrl, urlPath, actorEmail) {
  return new Promise((resolve, reject) => {
    const req = http.get(baseUrl + urlPath, { headers: { 'X-Actor-Email': actorEmail } }, (res) => {
      const chunks = [];
      let bytes = 0;
      let ended = false;
      let finish;
      const whole = new Promise((done, failed) => {
        finish = done;
        res.on('error', failed);
      });
      res.on('end', () => {
        ended = true;
        finish(Buffer.concat(chunks).toString('utf8'));
      });
      res.on('data', (chunk) => {
        chunks.push(chunk);
        bytes += chunk.length;
      });
      res.once('data', () => {
        res.pause();
        resolve({
          status: res.statusCode,
          headers: res.headers,
          bytesSoFar: () => bytes,
          finished: () => ended,
          resume: () => {
            res.resume();
            return whole;
          },
          /** Simulates a client that walks away mid-download. */
          abort: () => {
            whole.catch(() => {});
            req.destroy();
          },
        });
      });
    });
    req.on('error', reject);
  });
}

/**
 * What search and sort are expected to make of a name: case and accents do not count. Written
 * independently of the application's own folding (src/lib/text.js) so the two can disagree.
 */
export function referenceFold(text) {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

/** Order of two names when sorted ignoring case and accents. */
export function foldedCompare(a, b) {
  const x = referenceFold(a);
  const y = referenceFold(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * Fails with a short, readable message when two row lists differ. (assert.deepEqual on thousands
 * of rows spends minutes and gigabytes on rendering the difference.)
 */
export function assertSameRows(actual, expected, label) {
  const render = (row) => JSON.stringify(row);
  if (actual.length !== expected.length) {
    const known = new Set(expected.map(render));
    const extra = actual.filter((row) => !known.has(render(row))).slice(0, 3);
    throw new assert.AssertionError({
      message: `${label}: ${actual.length} rows instead of ${expected.length}${extra.length ? `; unexpected, for example: ${extra.map(render).join(' ')}` : ''}`,
    });
  }
  for (let i = 0; i < expected.length; i += 1) {
    if (render(actual[i]) !== render(expected[i])) {
      throw new assert.AssertionError({
        message: `${label}: row ${i} differs\n  actual:   ${render(actual[i])}\n  expected: ${render(expected[i])}`,
      });
    }
  }
}

/**
 * Starts test/support/hold-lock.mjs and resolves once it holds the write lock on `file` (a new
 * database in rollback-journal mode). It releases the lock by itself after `holdMs`.
 * Resolves with `{ exited: Promise<number> }`.
 */
export function holdRollbackJournalLock(file, holdMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join('test', 'support', 'hold-lock.mjs'), file, String(holdMs)], {
      cwd: BACKEND_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const exited = new Promise((done) => child.on('close', (code) => done(code)));
    child.stderr.on('data', (chunk) => (output += chunk));
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.includes('locked')) resolve({ exited });
    });
    child.on('error', reject);
    exited.then((code) => reject(new Error(`hold-lock exited with code ${code} before taking the lock:\n${output}`)));
  });
}

/** Resolves to true when `promise` has neither fulfilled nor rejected after `ms` milliseconds. */
export function stillPending(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(true), ms);
  });
  const settled = promise.then(
    () => false,
    () => false,
  );
  return Promise.race([settled, timeout]).finally(() => clearTimeout(timer));
}

/** Waits until `predicate()` holds; fails with `label` when it still does not after `timeoutMs`. */
export async function until(predicate, { timeoutMs = 5_000, label = 'the expected state' } = {}) {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() > deadline) throw new assert.AssertionError({ message: `Timed out after ${timeoutMs} ms waiting for ${label}` });
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export async function timed(fn) {
  const started = performance.now();
  const value = await fn();
  return { value, ms: performance.now() - started };
}
