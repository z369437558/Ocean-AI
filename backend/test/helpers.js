/**
 * Test harness. Tests are black-box wherever possible: they start the real server entry point as
 * a child process on a throw-away database file and talk to it over HTTP, the way a client would.
 * A second connection to the same file is used only to count rows (certificates, audit events).
 */
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

export function createTempDir(prefix = 'cert-admin-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function removeTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function runNode(args, { env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: BACKEND_DIR,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve(output);
      else reject(new Error(`node ${args.join(' ')} exited with code ${code}\n${output}`));
    });
  });
}

/** Runs a CLI script from backend/scripts and resolves with its combined output. */
export function runScript(script, args = [], options) {
  return runNode([path.join('scripts', script), ...args], options);
}

/** Starts `src/server.js` on a free port and resolves once it accepts requests. */
export function startServer(dbPath, { env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join('src', 'server.js')], {
      cwd: BACKEND_DIR,
      env: { ...process.env, PORT: '0', DB_PATH: dbPath, LOG_REQUESTS: '0', STATIC_DIR: path.join(BACKEND_DIR, 'no-frontend'), ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
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

/** SQLite's NOCASE collation: ASCII letters fold, everything else compares by code point. */
export function nocaseCompare(a, b) {
  const fold = (text) => text.replace(/[A-Z]/g, (ch) => ch.toLowerCase());
  const x = fold(a);
  const y = fold(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

export async function timed(fn) {
  const started = performance.now();
  const value = await fn();
  return { value, ms: performance.now() - started };
}
