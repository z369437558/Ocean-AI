/**
 * Test harness. Tests are black-box wherever possible: they start the real server entry point as
 * a child process on a throw-away database file and talk to it over HTTP, the way a client would.
 * A second connection to the same file is used only to count rows (certificates, audit events).
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { it as runnerIt } from 'node:test';
import { fileURLToPath } from 'node:url';

import { openDatabase } from '../src/db/sqlite.js';
import { foldText } from '../src/lib/text.js';

const BACKEND_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * `it` with a time limit of its own, so that a test that hangs is reported instead of stalling
 * the run. The limit is set per test here rather than with the runner's --test-timeout, because
 * before Node 24 that option also limits every test FILE as a whole to the same time: generous
 * for one test, far too tight for a whole file on a slow machine.
 */
export const TEST_TIMEOUT_MS = 180_000;
export function it(name, fn) {
  return runnerIt(name, { timeout: TEST_TIMEOUT_MS }, fn);
}

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
function runNodeToExit(args, { env = {}, timeoutMs = 180_000, launcher = AS_IS } = {}) {
  return new Promise((resolve, reject) => {
    const [command, ...commandArgs] = [...launcher.prefix, process.execPath, ...args];
    const child = spawn(command, commandArgs, {
      cwd: BACKEND_DIR,
      env: { ...inheritedEnv(launcher), ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      ...launcher.spawnOptions,
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

/**
 * How a child process is started: `prefix` goes before the node command, `spawnOptions` to spawn.
 * AS_IS changes nothing; launcherBoundByPermissions (below) returns the other ones.
 */
const AS_IS = { prefix: [], spawnOptions: {} };

/**
 * The environment a child process starts from. A process that runs as another user gets a clean
 * one: what this process inherited - a home directory, certificate bundles, npm settings - points
 * to places that user may not be able to read, and Node.js complains about some of them on stderr.
 */
function inheritedEnv(launcher) {
  return launcher.spawnOptions.uid === undefined ? process.env : { PATH: process.env.PATH };
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
// developer's shell (HOST, DB_BUSY_TIMEOUT_MS, EXPORT_...) cannot change what the tests observe.
// SQLITE_DRIVER alone is inherited, on purpose: the suite is meant to be run with either driver.
// (test/support/pin-settings.mjs does the same for the test process itself.)
const serverEnv = (dbPath, env) => ({
  PORT: '0',
  HOST: '127.0.0.1',
  DB_PATH: dbPath,
  DB_BUSY_TIMEOUT_MS: '',
  LOG_REQUESTS: '0',
  STATIC_DIR: path.join(BACKEND_DIR, 'no-frontend'),
  EXPORT_MAX_CONCURRENT: '',
  EXPORT_IDLE_TIMEOUT_MS: '',
  ...env,
});

const EXIT_WITH_PARENT = path.join('test', 'support', 'exit-with-parent.mjs');

/** For start-ups that are expected to fail: runs `src/server.js` until it exits, `{ code, output }`. */
export function runServerToExit(dbPath, { env = {}, launcher } = {}) {
  return runNodeToExit([path.join('src', 'server.js')], { env: serverEnv(dbPath, env), timeoutMs: 20_000, launcher });
}

/**
 * A way to start processes that file permissions apply to, for tests about files the server may
 * read but not write. Permissions do not apply to root - which is who runs the suite in a typical
 * container - so there another way is needed. In order of preference:
 *
 *   1. "setpriv" (util-linux) starts the process without the one capability that lets root ignore
 *      permissions. It stays root otherwise, so it can read the checkout wherever that lives.
 *   2. The system's unprivileged user "nobody" - if that user can read the checkout, which it
 *      cannot below a directory such as /root.
 *
 * The launcher returned can read the server's sources and `mustRead`, and cannot write
 * `mustNotWrite`; pass it to runServerToExit / startServer. Where no way works the result is
 * `{ unavailable: why }`. For any user but root the first candidate is "as it is".
 */
export function launcherBoundByPermissions({ mustRead = [], mustNotWrite }) {
  const candidates = [];
  if (process.getuid?.() !== 0) {
    candidates.push({ name: 'this user', ...AS_IS });
  } else {
    candidates.push({ name: 'root without CAP_DAC_OVERRIDE (setpriv)', prefix: ['setpriv', '--bounding-set=-dac_override'], spawnOptions: {} });
    const nobody = unprivilegedUser();
    if (nobody) candidates.push({ name: 'the user "nobody"', prefix: [], spawnOptions: nobody });
  }
  const refused = [];
  for (const candidate of candidates) {
    const unreadable = [path.join(BACKEND_DIR, 'src', 'server.js'), ...mustRead].find((file) => !canOpen(file, 'r', candidate));
    if (unreadable) {
      refused.push(`${candidate.name} cannot be used or cannot read ${unreadable}`);
    } else if (canOpen(mustNotWrite, 'r+', candidate)) {
      refused.push(`${candidate.name} can write to a read-only file`);
    } else {
      return candidate;
    }
  }
  return { unavailable: refused.join('; ') };
}

/** uid and gid of the user "nobody", or null where the system has none. */
function unprivilegedUser() {
  let entry;
  try {
    entry = fs.readFileSync('/etc/passwd', 'utf8').split('\n').map((line) => line.split(':')).find(([name]) => name === 'nobody');
  } catch {
    return null;
  }
  const [uid, gid] = [Number(entry?.[2]), Number(entry?.[3])];
  return Number.isInteger(uid) && Number.isInteger(gid) && uid !== 0 ? { uid, gid } : null;
}

/** Whether a process started through `launcher` can open `file` in the given mode ('r', 'r+'). */
function canOpen(file, mode, launcher) {
  const [command, ...commandArgs] = [
    ...launcher.prefix,
    process.execPath,
    '-e',
    'const fs = require("node:fs"); fs.closeSync(fs.openSync(process.argv[1], process.argv[2]))',
    file,
    mode,
  ];
  const probe = spawnSync(command, commandArgs, { ...launcher.spawnOptions, env: inheritedEnv(launcher), cwd: BACKEND_DIR, stdio: 'ignore' });
  return probe.status === 0;
}

/**
 * Starts `src/server.js` on a free port and resolves once it accepts requests. `expectHost` is the
 * host the start-up line is expected to name (serverEnv pins HOST to 127.0.0.1).
 */
export function startServer(dbPath, { env = {}, expectHost = '127.0.0.1', launcher = AS_IS } = {}) {
  return new Promise((resolve, reject) => {
    // stdin is a pipe held by this process: see test/support/exit-with-parent.mjs.
    const [command, ...commandArgs] = [
      ...launcher.prefix,
      process.execPath,
      '--import',
      `./${EXIT_WITH_PARENT.replaceAll(path.sep, '/')}`,
      path.join('src', 'server.js'),
    ];
    const child = spawn(command, commandArgs, {
      cwd: BACKEND_DIR,
      env: { ...inheritedEnv(launcher), ...serverEnv(dbPath, env) },
      stdio: ['pipe', 'pipe', 'pipe'],
      ...launcher.spawnOptions,
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
      // The server prints the address it can be reached at.
      const match = output.match(new RegExp(`listening on (http://${expectHost.replaceAll('.', '\\.')}:\\d+)`));
      if (match && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve({
          baseUrl: match[1],
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

/** No request of the suite takes anywhere near this long; one that does has been left unanswered. */
const REQUEST_TIMEOUT_MS = 60_000;

/**
 * Minimal HTTP client bound to one actor.
 * Responses: `{ status, headers, text, json }` (json is null for non-JSON bodies).
 */
export function clientFor(baseUrl, actorEmail) {
  async function request(method, urlPath, { body, headers = {}, rawBody } = {}) {
    // A server that stops answering fails the test that asked, with the request in the message.
    const init = { method, headers: { ...headers }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) };
    if (actorEmail) init.headers['X-Actor-Email'] = actorEmail;
    if (rawBody !== undefined) {
      init.body = rawBody;
    } else if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    let response;
    let text;
    try {
      response = await fetch(baseUrl + urlPath, init);
      text = await response.text();
    } catch (err) {
      if (err?.name !== 'TimeoutError') throw err;
      throw new Error(`${method} ${urlPath} was not answered within ${REQUEST_TIMEOUT_MS / 1000} s`);
    }
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

/**
 * Adds a learner the way the application's own writers do (the folded name is stored next to the
 * name); returns the new id. Tests use it for names the demo data does not have.
 */
export function insertLearner(db, tenantId, name) {
  return db.run(
    "INSERT INTO learners (tenant_id, full_name, name_key, created_at) VALUES (@tenantId, @name, @nameKey, '2026-01-01T00:00:00.000Z')",
    { tenantId, name, nameKey: foldText(name) },
  ).lastInsertRowid;
}

/** Adds a course, like insertLearner; returns the new id. */
export function insertCourse(db, tenantId, title) {
  return db.run(
    "INSERT INTO courses (tenant_id, title, title_key, created_at) VALUES (@tenantId, @title, @titleKey, '2026-01-01T00:00:00.000Z')",
    { tenantId, title, titleKey: foldText(title) },
  ).lastInsertRowid;
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

/** Splits what a server sent on one connection into its HTTP responses; an incomplete last one is left out. */
function parseResponses(buffer) {
  const responses = [];
  let offset = 0;
  for (;;) {
    const headEnd = buffer.indexOf('\r\n\r\n', offset);
    if (headEnd < 0) return responses;
    const [statusLine, ...headerLines] = buffer.toString('latin1', offset, headEnd).split('\r\n');
    const headers = Object.fromEntries(
      headerLines.map((line) => [line.slice(0, line.indexOf(':')).toLowerCase(), line.slice(line.indexOf(':') + 1).trim()]),
    );
    let position = headEnd + 4;
    const parts = [];
    if (/chunked/i.test(headers['transfer-encoding'] ?? '')) {
      for (;;) {
        const lineEnd = buffer.indexOf('\r\n', position);
        if (lineEnd < 0) return responses;
        const size = Number.parseInt(buffer.toString('latin1', position, lineEnd), 16);
        const dataEnd = lineEnd + 2 + size;
        if (dataEnd + 2 > buffer.length) return responses;
        parts.push(buffer.subarray(lineEnd + 2, dataEnd));
        position = dataEnd + 2;
        if (size === 0) break;
      }
    } else {
      const length = Number(headers['content-length'] ?? 0);
      if (position + length > buffer.length) return responses;
      parts.push(buffer.subarray(position, position + length));
      position += length;
    }
    responses.push({ status: Number(statusLine.split(' ')[1]), headers, body: Buffer.concat(parts).toString('utf8') });
    offset = position;
  }
}

/**
 * Sends several GET requests on one connection without waiting for the answers (HTTP pipelining),
 * which neither fetch nor node:http ever does. Resolves once the requests are on their way; until
 * `responses()` is called the client reads nothing at all.
 *   { responses(count): Promise<[{ status, headers, body }]>, close() }
 */
export function sendPipelined(baseUrl, urlPaths, actorEmail) {
  const { hostname, port } = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(port), hostname);
    socket.pause();
    socket.once('error', reject);
    socket.once('connect', () => {
      socket.on('error', () => {}); // a server that drops the connection is something tests assert on, not a crash
      const requests = urlPaths.map((urlPath) => `GET ${urlPath} HTTP/1.1\r\nHost: ${hostname}\r\nX-Actor-Email: ${actorEmail}\r\n\r\n`);
      socket.write(requests.join(''), () =>
        resolve({
          /** Reads until `count` complete responses have arrived. */
          responses: (count, { timeoutMs = 10_000 } = {}) =>
            new Promise((done, failed) => {
              let received = Buffer.alloc(0);
              const giveUp = (why) =>
                failed(new Error(`${why}: ${parseResponses(received).length} of ${count} pipelined responses arrived`));
              const timer = setTimeout(() => giveUp(`no more data after ${timeoutMs} ms`), timeoutMs);
              socket.on('data', (chunk) => {
                received = Buffer.concat([received, chunk]);
                const parsed = parseResponses(received);
                if (parsed.length < count) return;
                clearTimeout(timer);
                done(parsed);
              });
              socket.once('close', () => {
                clearTimeout(timer);
                giveUp('the connection was closed');
              });
              socket.resume();
            }),
          /** The client walks away, whatever is still outstanding. */
          close: () => socket.destroy(),
        }),
      );
    });
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
