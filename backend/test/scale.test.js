/**
 * A6 - export scalability and determinism on 100,000 East certificates.
 *
 * The dataset is produced by the real generator CLI on top of a freshly seeded database, and the
 * server runs as its own process, so timings reflect what a client actually experiences.
 */
import './support/pin-settings.mjs'; // must stay first: see the file

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe } from 'node:test';

import { isBusyError, openDatabase } from '../src/db/sqlite.js';
import {
  ALICE,
  BOB,
  SEED,
  assertSameRows,
  clientFor,
  createTempDir,
  foldedCompare,
  it,
  openStream,
  parseCsv,
  referenceFold,
  removeTempDir,
  runScript,
  startServer,
  timed,
  until,
} from './helpers.js';

const GENERATED = 100_000;
const EAST_TOTAL = SEED.east.certificateCount + GENERATED;
const TIME_LIMIT_MS = 60_000;
const plain = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Compares two snapshots table by table (a readable failure instead of a diff of thousands of rows). */
function assertSameSnapshot(actual, expected, label) {
  assert.deepEqual(Object.keys(actual), Object.keys(expected));
  for (const table of Object.keys(expected)) assertSameRows(actual[table], expected[table], `${label}: ${table}`);
}

/** Every quick-start row, i.e. everything that is not flagged as generated - the tenants' serial counters included. */
function quickStartSnapshot(db) {
  const rows = (sql) => db.all(sql).map((row) => ({ ...row }));
  const seedCourses = 'SELECT id FROM courses WHERE is_generated = 0';
  return {
    tenants: rows('SELECT * FROM tenants ORDER BY id'),
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
    assertSameSnapshot(quickStartSnapshot(db), before100k, 'quick-start rows after generating');
    assert.deepEqual(before100k.tenants.map((tenant) => [tenant.name, tenant.last_serial]), [['East', 7], ['West', 4]]);

    // Generated certificates are numbered in a range of their own, 1 to 100,000.
    const serials = db.get(
      `SELECT COUNT(*) AS n, MIN(serial_number) AS first, MAX(serial_number) AS last
         FROM certificates WHERE tenant_id = 1 AND serial_number GLOB 'EAST-LT-[0-9][0-9][0-9][0-9][0-9][0-9][0-9]'`,
    );
    assert.deepEqual({ ...serials }, { n: GENERATED, first: 'EAST-LT-0000001', last: 'EAST-LT-0100000' });

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

  /** The search rule, restated: the text appears somewhere, case and accents aside. */
  const contains = (value, needle) => referenceFold(value).includes(needle);

  const scenarios = [
    {
      name: 'search "SON", sorted by learner name ascending',
      query: 'q=SON&sort=learner&order=asc',
      matches: (row) => contains(row.learner_name, 'son') || contains(row.serial_number, 'son'),
      compare: (a, b) => foldedCompare(a.learner_name, b.learner_name) || a.id - b.id,
      sortKey: (row) => referenceFold(row.learner_name),
    },
    {
      name: 'search "a" + active only, sorted by issue date descending',
      query: 'q=a&status=active&sort=issued&order=desc',
      matches: (row) => row.status === 'active' && (contains(row.learner_name, 'a') || contains(row.serial_number, 'a')),
      compare: (a, b) =>
        plain(b.issued_local_date, a.issued_local_date) || plain(b.issued_at, a.issued_at) || b.id - a.id,
      sortKey: (row) => row.issued_local_date,
    },
    {
      name: 'search by a fragment of the serial number, sorted by course title descending',
      query: 'q=east-lt-000&sort=course&order=desc',
      matches: (row) => contains(row.learner_name, 'east-lt-000') || contains(row.serial_number, 'east-lt-000'),
      compare: (a, b) => foldedCompare(b.course_title, a.course_title) || b.id - a.id,
      sortKey: (row) => referenceFold(row.course_title),
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
    // An export that kept the server busy until it was done would let at most a request or two
    // through in all that time, however fast the machine.
    assert.ok(latencies.length >= 20, `only ${latencies.length} list requests were answered while the exports were running`);
    assert.ok(worst < 1_000, `slowest concurrent list request took ${worst.toFixed(0)} ms`);
  });

  it('an export whose filter matches next to nothing does not hold other requests up either', async (t) => {
    // To find its few rows such an export has to look at every certificate of the tenant. It must
    // do so in small steps: everything else the server has to do fits in between them.
    for (const { query, rows } of [
      { query: 'q=no-such-name-anywhere&sort=learner', rows: 0 },
      { query: 'q=Alex%20Lee&sort=course&order=desc', rows: 1 },
      { query: 'q=east-lt-0099999&status=active&sort=issued', rows: null },
    ]) {
      const measure = async () => {
        let running = true;
        const exported = timed(() => alice.get(`/api/certificates/export.csv?${query}`)).finally(() => {
          running = false;
        });
        const latencies = [];
        while (running) {
          const { value, ms } = await timed(() => alice.get('/api/certificates?pageSize=25'));
          assert.equal(value.status, 200);
          if (running) latencies.push(ms); // started and finished while the export was at work
        }
        const { value, ms } = await exported;
        assert.equal(value.status, 200);
        const exportedRows = parseCsv(value.text).length - 1;
        if (rows !== null) assert.equal(exportedRows, rows, query);
        assert.ok(exportedRows <= 1, query);
        return { ms, exportedRows, latencies, worst: Math.max(0, ...latencies) };
      };
      // Such an export takes a fraction of a second. A server it keeps busy lets one request
      // through in that time, or none - on every try. Fewer than ten, on the other hand, can also
      // mean that the machine was busy with something else at that moment, so the measurement is
      // repeated before it counts: a busy machine gets its ten on another try, a blocked server never.
      let result;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        result = await measure();
        t.diagnostic(
          `${query}: export ${result.ms.toFixed(0)} ms for ${result.exportedRows} row(s); ${result.latencies.length} list requests answered meanwhile, ` +
            `slowest ${result.worst.toFixed(0)} ms${attempt > 1 ? ` (try ${attempt})` : ''}`,
        );
        if (result.latencies.length >= 10) break;
      }
      assert.ok(result.latencies.length >= 10, `${query}: only ${result.latencies.length} list requests were answered during the ${result.ms.toFixed(0)} ms export, on each of three tries`);
      assert.ok(result.worst < 1_000, `${query}: slowest concurrent list request took ${result.worst.toFixed(0)} ms`);
    }
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

    // A fresh export does include them - and they carry the next numbers of the tenant's own
    // series, right after the seven quick-start certificates: the load-test rows did not use any up.
    const fresh = parseCsv((await alice.get('/api/certificates/export.csv?sort=serial&order=asc')).text).slice(1);
    assert.equal(fresh.length, EAST_TOTAL + 2);
    assert.deepEqual(newSerials.sort(), ['EAST-0000008', 'EAST-0000009']);
    assert.deepEqual(fresh.slice(SEED.east.certificateCount, SEED.east.certificateCount + 2).map((r) => r[2]), newSerials);
    assert.equal(fresh[SEED.east.certificateCount + 2][2], 'EAST-LT-0000001');
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

  it('EXPORT_MAX_CONCURRENT and EXPORT_IDLE_TIMEOUT_MS: an export waits for the only slot until the stalled download holding it is dropped', async (t) => {
    // One slot, and half a second of patience with clients that stop reading.
    const impatient = await startServer(dbPath, { env: { EXPORT_MAX_CONCURRENT: '1', EXPORT_IDLE_TIMEOUT_MS: '500', LOG_REQUESTS: '1' } });
    try {
      const client = clientFor(impatient.baseUrl, ALICE);
      const stalled = await openStream(impatient.baseUrl, '/api/certificates/export.csv?sort=serial', ALICE);
      const next = timed(() => client.get('/api/certificates/export.csv?q=Alex%20Lee'));

      // Either the server drops the stalled download, or - on a machine whose socket buffers are
      // large enough to swallow the whole file - it has simply finished sending it.
      const dropped = () => impatient.output().includes('[export] download dropped: the client took no more data for 500 ms');
      const finished = () => /GET \/api\/certificates\/export\.csv\?sort=serial -> 200/.test(impatient.output());
      await until(() => dropped() || finished(), { timeoutMs: 20_000, label: 'the stalled download to be dropped' });
      if (!dropped()) {
        t.diagnostic('the socket buffers of this machine took the whole export; a stalled download cannot be produced here');
        await stalled.resume();
        await next;
        return;
      }

      const { value, ms } = await next;
      assert.equal(value.status, 200);
      const served = parseCsv(value.text).slice(1);
      assert.ok(served.length >= 1 && served.every((row) => row[0] === 'Alex Lee') && served.some((row) => row[2] === 'EAST-0000001'));
      // It was sent the moment the stalled download had started: with a slot to spare it would
      // have been answered in a few milliseconds, not after the half second the idle timeout takes.
      assert.ok(ms >= 400, `the next export had to wait for the slot (${ms.toFixed(0)} ms)`);
      await assert.rejects(stalled.resume(), 'the dropped download ends as a broken transfer, not as a complete file');
      t.diagnostic(`stalled download dropped; the export waiting behind it was served after ${ms.toFixed(0)} ms`);

      // Its snapshot is gone as well: the write-ahead log can be checkpointed completely again.
      let pinnedFrames = Infinity;
      for (let attempt = 0; attempt < 40 && pinnedFrames !== 0; attempt += 1) {
        await sleep(50);
        assert.equal((await client.bulkIssue(SEED.east.firstAid)).status, 201);
        const checkpoint = db.get('PRAGMA wal_checkpoint(PASSIVE)');
        pinnedFrames = checkpoint.busy === 0 ? checkpoint.log - checkpoint.checkpointed : Infinity;
      }
      assert.equal(pinnedFrames, 0);
    } finally {
      await impatient.stop();
    }
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

    const counters = () => db.all('SELECT name, last_serial FROM tenants ORDER BY id').map((tenant) => ({ ...tenant }));
    const countersBefore = counters();
    const generated = () =>
      db
        .all(
          `SELECT serial_number, learner_name, course_title, status, issued_at, issued_local_date, revoked_at
             FROM certificates WHERE tenant_id = 1 AND course_id IN (SELECT id FROM courses WHERE is_generated = 1) ORDER BY id`,
        )
        .map((row) => ({ ...row }));

    await runScript('generate-certificates.js', ['--tenant', 'East', '--count', '2000', '--db', dbPath]);
    assert.equal(eastTotal(), eastQuickStart + 2000);
    const firstRun = generated();
    assert.deepEqual([firstRun[0].serial_number, firstRun.at(-1).serial_number], ['EAST-LT-0000001', 'EAST-LT-0002000']);
    await runScript('generate-certificates.js', ['--tenant', 'East', '--count', '2000', '--db', dbPath]);
    assertSameRows(generated(), firstRun, 'a second run produces the very same rows');
    assert.deepEqual(counters(), countersBefore, 'no run touches the serial counters');

    await runScript('generate-certificates.js', ['--tenant', 'East', '--clear', '--db', dbPath]);
    assert.equal(eastTotal(), eastQuickStart);
    assert.equal(db.get('SELECT COUNT(*) AS n FROM learners WHERE is_generated = 1').n, 0);
    assert.equal(db.get('SELECT COUNT(*) AS n FROM courses WHERE is_generated = 1').n, 0);
    assert.equal((await alice.get('/api/certificates')).json.total, eastQuickStart);
    assert.equal((await alice.get('/api/certificates?q=east-lt-')).json.total, 0);
    assert.ok((await alice.get('/api/courses')).json.items.every((course) => !course.isGenerated));
    assert.deepEqual(counters(), countersBefore);
  });

  it('db:reset underneath the running server restores the quick-start data and gives the disk space back', async (t) => {
    await runScript('generate-certificates.js', ['--tenant', 'East', '--count', String(GENERATED), '--db', dbPath]);
    const megabytes = (file) => (fs.existsSync(file) ? fs.statSync(file).size / 1024 / 1024 : 0);
    const before = { database: megabytes(dbPath), wal: megabytes(`${dbPath}-wal`) };
    assert.ok(before.database > 20, 'the load-test data takes real space');

    const reset = await timed(() => runScript('init-db.js', ['--reset', '--db', dbPath]));
    assert.match(reset.value, /Demo data restored/);

    assertSameSnapshot(quickStartSnapshot(db), before100k, 'after the reset');
    assert.equal(db.get('SELECT COUNT(*) AS n FROM certificates').n, SEED.east.certificateCount + SEED.west.certificateCount);
    // Nothing of the load-test data stays behind, the planner's statistics about it included:
    // the file has the size of a database that never held more than the demo data.
    assert.deepEqual(db.all("SELECT name FROM sqlite_master WHERE name LIKE 'sqlite_stat%'"), []);
    const pristine = path.join(dir, 'pristine.sqlite');
    await runScript('init-db.js', ['--db', pristine]);
    assert.equal(db.get('PRAGMA page_count').page_count, fs.statSync(pristine).size / db.get('PRAGMA page_size').page_size);
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
