/**
 * A6 - export scalability and determinism on 100,000 East certificates.
 *
 * The dataset is produced by the real generator CLI on top of a freshly seeded database, and the
 * server runs as its own process, so timings reflect what a client actually experiences.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { isBusyError, openDatabase } from '../src/db/sqlite.js';
import {
  ALICE,
  BOB,
  SEED,
  clientFor,
  createTempDir,
  nocaseCompare,
  openStream,
  parseCsv,
  removeTempDir,
  runScript,
  startServer,
  timed,
} from './helpers.js';

const GENERATED = 100_000;
const EAST_TOTAL = SEED.east.certificateCount + GENERATED;
const TIME_LIMIT_MS = 60_000;
const plain = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Every quick-start row, i.e. everything that is not flagged as generated. */
function quickStartSnapshot(db) {
  const rows = (sql) => db.all(sql).map((row) => ({ ...row }));
  const seedCourses = 'SELECT id FROM courses WHERE is_generated = 0';
  return {
    tenants: rows('SELECT id, name, code, timezone FROM tenants ORDER BY id'),
    admins: rows('SELECT * FROM admins ORDER BY id'),
    courses: rows('SELECT * FROM courses WHERE is_generated = 0 ORDER BY id'),
    learners: rows('SELECT * FROM learners WHERE is_generated = 0 ORDER BY id'),
    enrollments: rows(`SELECT * FROM enrollments WHERE course_id IN (${seedCourses}) ORDER BY id`),
    certificates: rows(`SELECT * FROM certificates WHERE course_id IN (${seedCourses}) ORDER BY id`),
    auditEvents: rows(
      `SELECT * FROM audit_events WHERE certificate_id IN (SELECT id FROM certificates WHERE course_id IN (${seedCourses})) ORDER BY id`,
    ),
  };
}

describe('A6 - 100,000-certificate export', { timeout: 300_000 }, () => {
  let dir;
  let dbPath;
  let db;
  let server;
  let alice;
  let bob;
  let before100k;
  let generatorOutput;
  /** serial number -> database row, for checking order against the real sort keys. */
  let bySerial;

  before(async () => {
    dir = createTempDir('cert-admin-scale-');
    dbPath = path.join(dir, 'scale.sqlite');
    await runScript('init-db.js', ['--db', dbPath]);
    db = openDatabase(dbPath);
    before100k = quickStartSnapshot(db);

    generatorOutput = await runScript('generate-certificates.js', ['--tenant', 'East', '--count', String(GENERATED), '--db', dbPath]);

    // Writes wait for the generator instead of giving up after the default 10 seconds: one test
    // below re-runs it underneath the server, and how long that takes depends on the machine.
    server = await startServer(dbPath, { env: { DB_BUSY_TIMEOUT_MS: '180000' } });
    alice = clientFor(server.baseUrl, ALICE);
    bob = clientFor(server.baseUrl, BOB);

    bySerial = new Map();
    for (const row of db.iterate(
      'SELECT id, serial_number, learner_name, course_title, status, issued_at, issued_local_date FROM certificates WHERE tenant_id = 1',
    )) {
      bySerial.set(row.serial_number, row);
    }
  });

  after(async () => {
    await server?.stop();
    db?.close();
    removeTempDir(dir);
  });

  it('the generator adds 100,000 East certificates and leaves the quick-start dataset untouched', async (t) => {
    t.diagnostic(generatorOutput.trim().split('\n').slice(-3).join(' | '));
    assert.equal(db.get('SELECT COUNT(*) AS n FROM certificates WHERE tenant_id = 1').n, EAST_TOTAL);
    assert.equal(db.get('SELECT COUNT(*) AS n FROM certificates WHERE tenant_id = 2').n, SEED.west.certificateCount);
    assert.deepEqual(quickStartSnapshot(db), before100k);

    // The demo scenario behaves exactly as before: same roster, same Alex Lee, West unaffected.
    const roster = (await alice.get(`/api/courses/${SEED.east.safety101}/enrollments`)).json;
    assert.deepEqual(roster.summary, { enrolled: 5, completed: 3, incomplete: 2, certified: 1, revoked: 0, eligible: 2 });
    assert.deepEqual((await alice.get('/api/certificates?q=Alex%20Lee')).json.items.map((c) => c.serialNumber), ['EAST-0000001']);
    assert.equal((await alice.get('/api/certificates')).json.total, EAST_TOTAL);
    assert.equal((await bob.get('/api/certificates')).json.total, SEED.west.certificateCount);

    // The data really contains equal sort keys - otherwise tie-breaking would never be exercised.
    const distinct = db.get(
      `SELECT COUNT(DISTINCT learner_name) AS names, COUNT(DISTINCT course_title) AS courses,
              COUNT(DISTINCT issued_local_date) AS dates, COUNT(DISTINCT issued_at) AS instants
         FROM certificates WHERE tenant_id = 1`,
    );
    t.diagnostic(`distinct sort values among ${EAST_TOTAL} rows: ${JSON.stringify({ ...distinct })}`);
    assert.ok(distinct.names < EAST_TOTAL / 10);
    assert.ok(distinct.courses <= 13);
    assert.ok(distinct.dates < EAST_TOTAL / 50);
    assert.ok(distinct.instants < EAST_TOTAL / 10);
  });

  const scenarios = [
    {
      name: 'search "son", sorted by learner name ascending',
      query: 'q=son&sort=learner&order=asc',
      matches: (row) => /son/i.test(row.learner_name) || /son/i.test(row.serial_number),
      compare: (a, b) => nocaseCompare(a.learner_name, b.learner_name) || a.id - b.id,
      sortKey: (row) => row.learner_name.toLowerCase(),
    },
    {
      name: 'search "a" + active only, sorted by issue date descending',
      query: 'q=a&status=active&sort=issued&order=desc',
      matches: (row) => row.status === 'active' && (/a/i.test(row.learner_name) || /a/i.test(row.serial_number)),
      compare: (a, b) =>
        plain(b.issued_local_date, a.issued_local_date) || plain(b.issued_at, a.issued_at) || b.id - a.id,
      sortKey: (row) => row.issued_local_date,
    },
    {
      name: 'search by serial prefix, sorted by course title descending',
      query: 'q=EAST-00&sort=course&order=desc',
      matches: (row) => /EAST-00/i.test(row.learner_name) || /EAST-00/i.test(row.serial_number),
      compare: (a, b) => nocaseCompare(b.course_title, a.course_title) || b.id - a.id,
      sortKey: (row) => row.course_title.toLowerCase(),
    },
  ];

  for (const scenario of scenarios) {
    it(`filtered + sorted export is fast, repeatable and deterministic: ${scenario.name}`, async (t) => {
      const url = `/api/certificates/export.csv?${scenario.query}`;
      const first = await timed(() => alice.get(url));
      const second = await timed(() => alice.get(url));
      t.diagnostic(`${scenario.query}: ${first.ms.toFixed(0)} ms and ${second.ms.toFixed(0)} ms`);

      assert.equal(first.value.status, 200);
      assert.equal(second.value.status, 200);
      assert.ok(first.ms < TIME_LIMIT_MS, `first export took ${first.ms.toFixed(0)} ms`);
      assert.ok(second.ms < TIME_LIMIT_MS, `second export took ${second.ms.toFixed(0)} ms`);
      assert.ok(first.value.text === second.value.text, 'both exports are byte-identical');

      const [header, ...rows] = parseCsv(first.value.text);
      assert.deepEqual(header, ['Learner Name', 'Course Title', 'Serial Number', 'Issue Date (Australia/Sydney)']);

      // Exactly the matching rows: same count as the list reports, same set as the database holds.
      const expected = [...bySerial.values()].filter(scenario.matches).sort(scenario.compare);
      assert.ok(expected.length > 5_000, `scenario should be large (matched ${expected.length})`);
      assert.equal(rows.length, expected.length);
      assert.equal((await alice.get(`/api/certificates?pageSize=1&${scenario.query}`)).json.total, rows.length);

      // Deterministic order: sort key first, id as the tie-breaker, for every single row.
      let firstMismatch = -1;
      for (let i = 0; i < rows.length; i += 1) {
        if (rows[i][2] !== expected[i].serial_number) {
          firstMismatch = i;
          break;
        }
      }
      assert.equal(firstMismatch, -1, `row ${firstMismatch} is out of order`);

      // Equal sort keys are genuinely present, so the tie-breaker is what produced this order.
      const distinctKeys = new Set(expected.map(scenario.sortKey)).size;
      t.diagnostic(`${rows.length} rows, ${distinctKeys} distinct sort keys`);
      assert.ok(distinctKeys < rows.length / 2);

      // Row content matches the stored certificate (local issue time included).
      const sample = rows[Math.floor(rows.length / 2)];
      const stored = bySerial.get(sample[2]);
      assert.equal(sample[0], stored.learner_name);
      assert.equal(sample[1], stored.course_title);
      assert.equal(sample[3].slice(0, 10), stored.issued_local_date);
    });
  }

  it('the export follows the list page for page', async () => {
    const query = 'q=an&sort=learner&order=desc';
    const rows = parseCsv((await alice.get(`/api/certificates/export.csv?${query}`)).text).slice(1);
    const pageSize = 100;
    const lastPage = Math.ceil(rows.length / pageSize);
    for (const page of [1, 2, Math.floor(lastPage / 2), lastPage]) {
      const list = (await alice.get(`/api/certificates?${query}&pageSize=${pageSize}&page=${page}`)).json;
      assert.equal(list.total, rows.length);
      assert.deepEqual(
        list.items.map((c) => [c.learnerName, c.courseTitle, c.serialNumber, c.issuedLocal]),
        rows.slice((page - 1) * pageSize, page * pageSize),
        `page ${page}`,
      );
    }
  });

  it('paging through equal sort keys neither repeats nor skips a certificate', async () => {
    const query = 'q=Anderson&sort=course&order=asc&pageSize=100';
    const first = (await alice.get(`/api/certificates?${query}`)).json;
    assert.ok(first.total > 1_000);
    const seen = new Set();
    for (let page = 1; page <= first.totalPages; page += 1) {
      for (const item of (await alice.get(`/api/certificates?${query}&page=${page}`)).json.items) {
        assert.ok(!seen.has(item.id), `certificate ${item.id} appeared twice`);
        seen.add(item.id);
      }
    }
    assert.equal(seen.size, first.total);
  });

  it('list requests stay responsive while exports are streaming at full speed', async (t) => {
    let exportsRunning = 3;
    const exports = Array.from({ length: exportsRunning }, (_, i) =>
      timed(() => alice.get(`/api/certificates/export.csv?sort=${['learner', 'course', 'issued'][i]}`)).finally(() => {
        exportsRunning -= 1;
      }),
    );

    const latencies = [];
    let page = 1;
    while (exportsRunning > 0) {
      const { value, ms } = await timed(() => alice.get(`/api/certificates?pageSize=25&page=${page}&sort=issued`));
      assert.equal(value.status, 200);
      assert.equal(value.json.items.length, 25);
      if (exportsRunning > 0) latencies.push(ms);
      page += 1;
    }
    const finished = await Promise.all(exports);
    for (const { value, ms } of finished) {
      assert.equal(value.status, 200);
      assert.ok(ms < TIME_LIMIT_MS);
      assert.equal(parseCsv(value.text).length - 1, EAST_TOTAL);
    }

    const worst = Math.max(...latencies);
    t.diagnostic(
      `${latencies.length} list requests answered during ${finished.map((f) => f.ms.toFixed(0)).join('/')} ms exports; ` +
        `slowest ${worst.toFixed(0)} ms, median ${[...latencies].sort((a, b) => a - b)[Math.floor(latencies.length / 2)].toFixed(0)} ms`,
    );
    assert.ok(latencies.length >= 3, 'list requests completed while the exports were still running');
    assert.ok(worst < 2_000, `slowest concurrent list request took ${worst.toFixed(0)} ms`);
  });

  it('a stalled download blocks neither reads nor writes, and keeps its own consistent snapshot', async (t) => {
    // Start a full export and stop reading after the first bytes: the server is now mid-export.
    const download = await openStream(server.baseUrl, '/api/certificates/export.csv?sort=serial&order=asc', ALICE);
    assert.equal(download.status, 200);

    const latencies = [];
    for (let i = 0; i < 20; i += 1) {
      const { value, ms } = await timed(() => alice.get(`/api/certificates?pageSize=50&page=${i + 1}&sort=learner&q=e`));
      assert.equal(value.status, 200);
      latencies.push(ms);
    }
    const parallel = await timed(() =>
      Promise.all([
        alice.get('/api/certificates?q=Alex%20Lee'),
        alice.get(`/api/certificates/${SEED.east.alexLeeCertificate}`),
        alice.get(`/api/courses/${SEED.east.safety101}/enrollments`),
        bob.get('/api/certificates'),
      ]),
    );
    assert.ok(parallel.value.every((r) => r.status === 200));

    // A write in the middle of the export goes straight through as well.
    const issue = await timed(() => alice.bulkIssue(SEED.east.safety101, 'during-export'));
    assert.equal(issue.value.status, 201);
    assert.equal(issue.value.json.summary.issued, 2);

    assert.equal(download.finished(), false, 'the export is still in flight while all of the above completed');
    // Evidence from the server side: frames committed after an open read snapshot cannot be checkpointed,
    // so an incomplete checkpoint means the export's snapshot is still open (reported, not asserted:
    // on a machine with huge socket buffers the server may legitimately have finished writing already).
    const checkpoint = db.get('PRAGMA wal_checkpoint(PASSIVE)');
    t.diagnostic(`export snapshot still open on the server: ${checkpoint.log > checkpoint.checkpointed ? 'yes' : 'no'}`);
    t.diagnostic(
      `while an export was stalled at ${download.bytesSoFar()} bytes: slowest list ${Math.max(...latencies).toFixed(0)} ms, ` +
        `4 parallel reads ${parallel.ms.toFixed(0)} ms, bulk issue ${issue.ms.toFixed(0)} ms`,
    );
    assert.ok(Math.max(...latencies) < 2_000);
    assert.ok(parallel.ms < 2_000);
    assert.ok(issue.ms < 2_000);

    // The stalled export finishes with the data as of its start: the two new certificates are not in it.
    const rows = parseCsv(await download.resume()).slice(1);
    assert.equal(rows.length, EAST_TOTAL);
    const newSerials = issue.value.json.results.filter((r) => r.outcome === 'issued').map((r) => r.serialNumber);
    assert.ok(newSerials.every((serial) => !rows.some((r) => r[2] === serial)));

    // A fresh export does include them.
    const fresh = parseCsv((await alice.get('/api/certificates/export.csv?sort=serial&order=asc')).text).slice(1);
    assert.equal(fresh.length, EAST_TOTAL + 2);
    assert.deepEqual(fresh.slice(-2).map((r) => r[2]), newSerials.sort());
  });

  it('an abandoned download releases its snapshot and connection', async () => {
    const download = await openStream(server.baseUrl, '/api/certificates/export.csv?sort=learner', ALICE);
    download.abort();

    // A leaked export would keep its read snapshot open forever. Commit something newer than that
    // snapshot, then checkpoint: frames written after a still-open snapshot cannot be checkpointed.
    let pinnedFrames = Infinity;
    for (let attempt = 0; attempt < 40 && pinnedFrames !== 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal((await alice.bulkIssue(SEED.east.firstAid)).status, 201);
      const checkpoint = db.get('PRAGMA wal_checkpoint(PASSIVE)');
      pinnedFrames = checkpoint.busy === 0 ? checkpoint.log - checkpoint.checkpointed : Infinity;
    }
    assert.equal(pinnedFrames, 0);
    assert.equal((await alice.get('/api/certificates?pageSize=1')).status, 200);
  });

  it('requests keep flowing while the generator rewrites 100,000 rows; a write sent meanwhile completes afterwards', async (t) => {
    const stored = await bob.bulkIssue(SEED.west.heights, 'before-generate');
    assert.equal(stored.status, 201);
    const eastTotal = (await alice.get('/api/certificates')).json.total;

    const probe = openDatabase(dbPath);
    let generating = true;
    const generator = timed(() =>
      runScript('generate-certificates.js', ['--tenant', 'East', '--count', String(GENERATED), '--db', dbPath]),
    ).finally(() => {
      generating = false;
    });
    generator.catch(() => {}); // awaited (and asserted on) below
    try {
      // The generator's whole run is one write transaction: wait until it has taken the lock.
      let locked = false;
      while (generating && !locked) {
        locked = await probe.writeTransaction(() => false, { timeoutMs: 0 }).catch((err) => {
          if (isBusyError(err)) return true;
          throw err;
        });
        if (!locked) await sleep(5);
      }
      assert.equal(locked, true, 'the generator holds the write lock');

      // A write - here in the other tenant - has to wait for the generator...
      const issue = timed(() => bob.bulkIssue(SEED.west.safety101, 'during-generate'));
      // ...but nothing else does: lists, details and replays of finished operations are answered throughout.
      const latencies = [];
      while (generating) {
        const { value, ms } = await timed(() =>
          Promise.all([
            alice.get('/api/certificates?pageSize=25&sort=learner'),
            alice.get(`/api/certificates/${SEED.east.alexLeeCertificate}`),
            bob.get('/api/certificates'),
            bob.bulkIssue(SEED.west.heights, 'before-generate'),
          ]),
        );
        assert.deepEqual(value.map((r) => r.status), [200, 200, 200, 201]);
        assert.equal(value[0].json.total, eastTotal, 'readers see either all of the old rows or all of the new ones');
        assert.equal(value[3].text, stored.text);
        latencies.push(ms);
        await sleep(20);
      }

      const { ms: generatorMs } = await generator;
      const issued = await issue;
      assert.equal(issued.value.status, 201);
      assert.equal(issued.value.headers.get('idempotent-replayed'), 'false');
      assert.equal(issued.value.json.summary.issued, 2);

      const worst = Math.max(...latencies);
      t.diagnostic(
        `generator ran for ${generatorMs.toFixed(0)} ms; ${latencies.length} rounds of 4 requests answered meanwhile, ` +
          `slowest ${worst.toFixed(0)} ms; the waiting bulk issue completed after ${issued.ms.toFixed(0)} ms`,
      );
      assert.ok(latencies.length >= 5, 'requests were answered while the generator was running');
      assert.ok(worst < 2_000, `slowest round took ${worst.toFixed(0)} ms`);
      assert.equal((await alice.get('/api/certificates')).json.total, eastTotal);
    } finally {
      probe.close();
      await generator.catch(() => {});
    }
  });

  it('re-running the generator replaces its previous rows; --clear removes them', async () => {
    const eastTotal = () => db.get('SELECT COUNT(*) AS n FROM certificates WHERE tenant_id = 1').n;
    const eastQuickStart = db.get(
      'SELECT COUNT(*) AS n FROM certificates WHERE tenant_id = 1 AND course_id IN (SELECT id FROM courses WHERE is_generated = 0)',
    ).n;
    assert.equal(eastTotal(), eastQuickStart + GENERATED);

    await runScript('generate-certificates.js', ['--tenant', 'East', '--count', '2000', '--db', dbPath]);
    assert.equal(eastTotal(), eastQuickStart + 2000);

    await runScript('generate-certificates.js', ['--tenant', 'East', '--clear', '--db', dbPath]);
    assert.equal(eastTotal(), eastQuickStart);
    assert.equal(db.get('SELECT COUNT(*) AS n FROM learners WHERE is_generated = 1').n, 0);
    assert.equal(db.get('SELECT COUNT(*) AS n FROM courses WHERE is_generated = 1').n, 0);
    assert.equal((await alice.get('/api/certificates')).json.total, eastQuickStart);
    assert.equal((await alice.get('/api/certificates?q=load%20test')).json.total, 0);
    assert.ok((await alice.get('/api/courses')).json.items.every((course) => !course.isGenerated));
  });

  it('db:reset underneath the running server restores the quick-start data and gives the disk space back', async (t) => {
    await runScript('generate-certificates.js', ['--tenant', 'East', '--count', String(GENERATED), '--db', dbPath]);
    const megabytes = (file) => (fs.existsSync(file) ? fs.statSync(file).size / 1024 / 1024 : 0);
    const before = { database: megabytes(dbPath), wal: megabytes(`${dbPath}-wal`) };
    assert.ok(before.database > 20, 'the load-test data takes real space');

    const reset = await timed(() => runScript('init-db.js', ['--reset', '--db', dbPath]));
    assert.match(reset.value, /Demo data restored/);

    assert.deepEqual(quickStartSnapshot(db), before100k, 'row for row the dataset of a fresh install');
    assert.equal(db.get('SELECT COUNT(*) AS n FROM certificates').n, SEED.east.certificateCount + SEED.west.certificateCount);
    assert.equal(db.get('SELECT last_serial FROM tenants WHERE id = 1').last_serial, SEED.east.certificateCount);
    assert.equal((await alice.get('/api/certificates')).json.total, SEED.east.certificateCount);
    assert.equal((await alice.bulkIssue(SEED.east.safety101, 'after-reset')).json.summary.issued, 2, 'the server carries on with the fresh data');

    const after = { database: megabytes(dbPath), wal: megabytes(`${dbPath}-wal`) };
    t.diagnostic(
      `reset took ${reset.ms.toFixed(0)} ms; database file ${before.database.toFixed(1)} MB -> ${after.database.toFixed(2)} MB, ` +
        `write-ahead log ${before.wal.toFixed(1)} MB -> ${after.wal.toFixed(2)} MB`,
    );
    assert.ok(after.database < 2, `database file is ${after.database.toFixed(1)} MB after the reset`);
    assert.ok(after.wal < 2, `write-ahead log is ${after.wal.toFixed(1)} MB after the reset`);
  });
});
