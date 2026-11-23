#!/usr/bin/env node
/**
 * Records the API responses the UI tests replay (recorded.json, next to this file).
 *
 *   node frontend/test/fixtures/record.mjs
 *
 * The tests never talk to a server: test/support/fakeServer.js answers `fetch` from this
 * recording. Run the script again whenever the API changes shape, so the fixtures keep showing
 * what the real backend sends. It starts its own backend on a random port with a throw-away
 * database in the OS temp directory and removes both afterwards; the app's data is not touched.
 *
 * Besides the plain reads it provokes the answers that are hard to get by hand: a 503 while
 * another connection holds the write lock, an idempotent replay, a 409 for a reused key, a
 * learner whose certificate cannot be written, and the "already revoked" repeat.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateCertificates } from '../../../backend/src/db/generate.js';
import { openDatabase } from '../../../backend/src/db/sqlite.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.resolve(here, '..', '..', '..', 'backend');
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cert-admin-fixtures-'));
const dbFile = path.join(workDir, 'fixtures.sqlite');

const ALICE = 'alice@east.test';
const BOB = 'bob@west.test';

function startServer() {
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: backendDir,
    env: {
      ...process.env,
      PORT: '0',
      DB_PATH: dbFile,
      DB_BUSY_TIMEOUT_MS: '300', // a held write lock turns into a 503 quickly
      LOG_REQUESTS: '0',
      STATIC_DIR: path.join(workDir, 'no-ui'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // The server's log is only of interest when something goes wrong; the provoked failures below
  // (busy database, failing learner) would otherwise fill the terminal with expected errors.
  const log = { text: '' };
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => (log.text += chunk));
  return new Promise((resolve, reject) => {
    child.stdout.on('data', () => {
      const match = /listening on (http:\/\/localhost:\d+)/.exec(log.text);
      if (match) resolve({ child, log, baseUrl: match[1] });
    });
    child.on('exit', (code) => reject(new Error(`The backend exited with code ${code} before it was ready:\n${log.text}`)));
  });
}

const { child, log, baseUrl } = await startServer();
process.on('exit', () => child.kill('SIGTERM')); // also when the script is interrupted or throws early

async function call(actor, method, route, { body, key } = {}) {
  const headers = actor ? { 'X-Actor-Email': actor } : {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (key) headers['Idempotency-Key'] = key;
  const response = await fetch(`${baseUrl}/api${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  const isJson = (response.headers.get('content-type') ?? '').includes('json');
  return { status: response.status, headers: Object.fromEntries(response.headers), body: isJson ? JSON.parse(text) : text };
}

async function expectStatus(promise, status) {
  const result = await promise;
  if (result.status !== status) throw new Error(`Expected HTTP ${status}, got ${result.status}: ${JSON.stringify(result.body)}`);
  return result;
}

const get = async (actor, route) => (await expectStatus(call(actor, 'GET', route), 200)).body;
const allCertificates = async (actor) => (await get(actor, '/certificates?pageSize=100&sort=serial&order=asc')).items;

/** Everything a tenant's screens read, taken from the pristine demo data. */
async function recordTenant(actor) {
  const certificates = await allCertificates(actor);
  const details = {};
  for (const { id } of certificates) details[id] = await get(actor, `/certificates/${id}`);
  const courses = (await get(actor, '/courses')).items;
  const rosters = {};
  for (const { id } of courses) rosters[id] = await get(actor, `/courses/${id}/enrollments`);
  const csv = await expectStatus(call(actor, 'GET', '/certificates/export.csv'), 200);
  return {
    certificates,
    details,
    courses,
    rosters,
    operations: (await get(actor, '/bulk-issues')).items,
    exportCsv: { contentDisposition: csv.headers['content-disposition'], body: csv.body },
  };
}

const answer = ({ status, body }) => ({ status, body });

try {
  const recorded = {
    about: 'Recorded from the real backend by frontend/test/fixtures/record.mjs. Do not edit by hand; run the script again.',
    actors: await get(null, '/actors'),
    tenants: { [ALICE]: await recordTenant(ALICE), [BOB]: await recordTenant(BOB) },
    errors: {},
  };

  // --- Rejections and failures ----------------------------------------------------------------
  recorded.errors.notFound = answer(await expectStatus(call(ALICE, 'GET', '/certificates/8'), 404)); // a West certificate
  recorded.errors.invalidSearch = answer(await expectStatus(call(ALICE, 'GET', '/certificates?q=Alex%09Lee'), 400));

  const db = openDatabase(dbFile);
  db.exec('BEGIN IMMEDIATE'); // hold the write lock: writes now give up after DB_BUSY_TIMEOUT_MS
  const busy = await expectStatus(call(ALICE, 'POST', '/bulk-issues', { body: { courseId: 1 }, key: 'fixture-busy' }), 503);
  await expectStatus(call(ALICE, 'POST', '/certificates/4/revoke', { body: {} }), 503);
  db.exec('ROLLBACK');
  recorded.errors.databaseBusy = { ...answer(busy), headers: { 'Retry-After': busy.headers['retry-after'] } };

  // --- Bulk issue ------------------------------------------------------------------------------
  // What a tenant looks like once its recorded runs have happened.
  const afterBulkIssue = async (actor, courseId, runs) => ({
    courseId,
    runs,
    rosterAfter: await get(actor, `/courses/${courseId}/enrollments`),
    operationsAfter: (await get(actor, '/bulk-issues')).items,
    certificatesAfter: await allCertificates(actor),
  });
  const bulkIssue = (actor, courseId, key) => call(actor, 'POST', '/bulk-issues', { body: { courseId }, key });

  // East, Safety 101 (course 1): the first run issues, a replay returns the stored answer, the
  // key cannot be reused for another course, and a second run (new key) finds nobody left.
  const firstRun = await expectStatus(bulkIssue(ALICE, 1, 'fixture-key-1'), 201);
  const replay = await expectStatus(bulkIssue(ALICE, 1, 'fixture-key-1'), 201);
  if (replay.headers['idempotent-replayed'] !== 'true' || JSON.stringify(replay.body) !== JSON.stringify(firstRun.body)) {
    throw new Error('The replay did not return the stored response');
  }
  recorded.errors.keyReused = answer(await expectStatus(bulkIssue(ALICE, 2, 'fixture-key-1'), 409));
  const secondRun = await expectStatus(bulkIssue(ALICE, 1, 'fixture-key-2'), 201);

  // West, Safety 101 (course 4), with one learner whose audit event cannot be written: that
  // learner is reported as failed, the others are processed normally.
  db.exec(`CREATE TRIGGER fixture_failure BEFORE INSERT ON audit_events
           WHEN NEW.action = 'certificate.issued' AND NEW.details LIKE '%Emily Davis%'
           BEGIN SELECT RAISE(ABORT, 'audit store unavailable'); END`);
  const runWithFailure = await expectStatus(bulkIssue(BOB, 4, 'fixture-key-3'), 201);
  db.exec('DROP TRIGGER fixture_failure');

  recorded.bulkIssues = {
    [ALICE]: await afterBulkIssue(ALICE, 1, [firstRun.body, secondRun.body]),
    [BOB]: await afterBulkIssue(BOB, 4, [runWithFailure.body]),
  };

  // --- Revocation: East certificate 4 ----------------------------------------------------------
  const revoked = await expectStatus(call(ALICE, 'POST', '/certificates/4/revoke', { body: { reason: 'Issued in error' } }), 200);
  const repeat = await expectStatus(call(ALICE, 'POST', '/certificates/4/revoke', { body: {} }), 200);
  recorded.revoke = { actor: ALICE, certificateId: 4, response: revoked.body, repeat: repeat.body };

  // --- A tenant with more than one page of certificates ----------------------------------------
  generateCertificates(db, { tenantName: 'East', count: 20 });
  db.close();
  recorded.manyCertificates = { actor: ALICE, items: await allCertificates(ALICE) };

  const target = path.join(here, 'recorded.json');
  fs.writeFileSync(target, `${JSON.stringify(recorded, null, 2)}\n`);
  console.log(`Wrote ${path.relative(process.cwd(), target)} (${(fs.statSync(target).size / 1024).toFixed(1)} kB)`);
} catch (err) {
  console.error(`Recording failed. Backend log:\n${log.text}`);
  throw err;
} finally {
  child.kill('SIGTERM');
  await new Promise((resolve) => child.once('exit', resolve));
  fs.rmSync(workDir, { recursive: true, force: true });
}
