import './support/pin-settings.mjs'; // must stay first: see the file

import assert from 'node:assert/strict';
import path from 'node:path';
import { Writable } from 'node:stream';
import { after, before, describe } from 'node:test';

import { loadConfig } from '../src/config.js';
import { formatGeneratedSerial } from '../src/db/generate.js';
import { SCHEMA_VERSION, migrate } from '../src/db/schema.js';
import { seedDemoData } from '../src/db/seed.js';
import { TransactionAbortedError, enableWal, isBusyError, openDatabase } from '../src/db/sqlite.js';
import { csvCell, csvRow } from '../src/lib/csv.js';
import { sendChunks } from '../src/lib/download.js';
import { canonicalJson, requestFingerprint } from '../src/lib/fingerprint.js';
import { LimiterFullError, createLimiter } from '../src/lib/limiter.js';
import { foldText } from '../src/lib/text.js';
import { localDate, localDateTime, utcOffset } from '../src/lib/time.js';
import { createTurnQueue } from '../src/lib/turns.js';
import { EXPORT_BATCH_ROWS, buildExportPlan, parseListQuery, streamCsvExport } from '../src/services/certificates.js';
import { classifyEnrollment } from '../src/services/courses.js';
import { createTempDir, holdRollbackJournalLock, insertLearner, it, parseCsv, referenceFold, removeTempDir, stillPending } from './helpers.js';

describe('time zones (A5)', () => {
  it('converts the reference instant to each tenant-local wall clock', () => {
    const instant = '2026-01-10T13:30:00Z';
    assert.equal(localDateTime(instant, 'Australia/Sydney'), '2026-01-11 00:30');
    assert.equal(localDateTime(instant, 'Australia/Perth'), '2026-01-10 21:30');
    assert.equal(localDate(instant, 'Australia/Sydney'), '2026-01-11');
    assert.equal(localDate(instant, 'Australia/Perth'), '2026-01-10');
  });

  it('applies daylight saving for Sydney and none for Perth', () => {
    assert.equal(utcOffset('2026-01-10T13:30:00Z', 'Australia/Sydney'), '+11:00'); // AEDT (summer)
    assert.equal(utcOffset('2026-07-10T13:30:00Z', 'Australia/Sydney'), '+10:00'); // AEST (winter)
    assert.equal(localDateTime('2026-07-10T13:30:00Z', 'Australia/Sydney'), '2026-07-10 23:30');
    assert.equal(utcOffset('2026-01-10T13:30:00Z', 'Australia/Perth'), '+08:00');
    assert.equal(utcOffset('2026-07-10T13:30:00Z', 'Australia/Perth'), '+08:00');
  });

  it('handles both daylight-saving transitions of 2026 in Sydney', () => {
    // Clocks go back at 16:00Z on 4 April: 02:30 happens twice.
    assert.equal(localDateTime('2026-04-04T15:30:00Z', 'Australia/Sydney'), '2026-04-05 02:30');
    assert.equal(utcOffset('2026-04-04T15:30:00Z', 'Australia/Sydney'), '+11:00');
    assert.equal(localDateTime('2026-04-04T16:30:00Z', 'Australia/Sydney'), '2026-04-05 02:30');
    assert.equal(utcOffset('2026-04-04T16:30:00Z', 'Australia/Sydney'), '+10:00');
    // Clocks go forward at 16:00Z on 3 October: 02:xx does not exist.
    assert.equal(localDateTime('2026-10-03T15:59:00Z', 'Australia/Sydney'), '2026-10-04 01:59');
    assert.equal(localDateTime('2026-10-03T16:00:00Z', 'Australia/Sydney'), '2026-10-04 03:00');
  });

  it('formats midnight as 00, never 24, and rolls the date over year boundaries', () => {
    assert.equal(localDateTime('2026-06-30T14:00:00Z', 'Australia/Sydney'), '2026-07-01 00:00');
    assert.equal(localDateTime('2026-12-31T13:00:00Z', 'Australia/Sydney'), '2027-01-01 00:00');
    assert.equal(localDateTime('2026-12-31T16:00:00Z', 'Australia/Perth'), '2027-01-01 00:00');
  });

  it('rejects invalid input instead of producing garbage', () => {
    assert.throws(() => localDateTime('not a date', 'Australia/Sydney'), RangeError);
    assert.throws(() => localDateTime('2026-01-10T13:30:00Z', 'Mars/Olympus_Mons'), RangeError);
  });
});

describe('CSV encoding', () => {
  it('quotes separators, quotes and line breaks', () => {
    assert.equal(csvCell('plain'), 'plain');
    assert.equal(csvCell('Reyes, Dana'), '"Reyes, Dana"');
    assert.equal(csvCell('Dana "DJ" Reyes'), '"Dana ""DJ"" Reyes"');
    assert.equal(csvCell('two\nlines'), '"two\nlines"');
    assert.equal(csvCell(null), '');
    assert.equal(csvRow(['a', 'b,c', 3]), 'a,"b,c",3\n');
  });

  it('neutralises spreadsheet formulas', () => {
    assert.equal(csvCell('=HYPERLINK("http://evil.test")'), `"'=HYPERLINK(""http://evil.test"")"`);
    assert.equal(csvCell('+61 400 000 000'), "'+61 400 000 000");
    assert.equal(csvCell('@handle'), "'@handle");
    assert.equal(csvCell('-1'), "'-1");
    assert.equal(csvCell('2026-01-11 00:30'), '2026-01-11 00:30');
  });

  it('round-trips through a CSV parser', () => {
    const cells = ['O\'Connor, "Mac"', 'Line\nbreak', 'Müller', ''];
    assert.deepEqual(parseCsv(csvRow(cells)), [cells]);
  });
});

describe('request fingerprint (A3)', () => {
  it('ignores key order and whitespace but not values', () => {
    assert.equal(canonicalJson({ b: 1, a: [1, { d: 2, c: 3 }] }), '{"a":[1,{"c":3,"d":2}],"b":1}');
    const base = requestFingerprint('POST', '/api/bulk-issues', { courseId: 1, note: 'x' });
    assert.equal(requestFingerprint('post', '/api/bulk-issues', { note: 'x', courseId: 1 }), base);
    assert.notEqual(requestFingerprint('POST', '/api/bulk-issues', { courseId: 2, note: 'x' }), base);
    assert.notEqual(requestFingerprint('POST', '/api/bulk-issues', { courseId: 1 }), base);
    assert.notEqual(requestFingerprint('POST', '/api/bulk-issues', { courseId: '1', note: 'x' }), base);
    assert.notEqual(requestFingerprint('POST', '/api/bulk-issues', undefined), base);
  });

  it('canonical JSON matches a straightforward recursive reference', () => {
    const reference = (value) => {
      if (Array.isArray(value)) return `[${value.map(reference).join(',')}]`;
      if (value !== null && typeof value === 'object') {
        return `{${Object.keys(value)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${reference(value[key])}`)
          .join(',')}}`;
      }
      return JSON.stringify(value) ?? 'null';
    };
    for (const sample of [
      null,
      true,
      0,
      -1.5e-7,
      '',
      'quote " backslash \\ newline \n unicode \u2028 é',
      [],
      {},
      [[], {}, [null, [1, [2, [3]]]]],
      { b: 1, a: { d: [1, { z: null, y: 'x' }], c: {} }, '': 0, 'a b': [true, false] },
      { __proto__: null, constructor: 1, toString: 2 },
    ]) {
      assert.equal(canonicalJson(sample), reference(sample), JSON.stringify(sample));
      assert.deepEqual(JSON.parse(canonicalJson(sample)), JSON.parse(JSON.stringify(sample)));
    }
  });

  it('handles bodies nested far deeper than the call stack allows', () => {
    const depth = 200_000;
    let arrays = [];
    let objects = { leaf: true };
    for (let i = 0; i < depth; i += 1) {
      arrays = [arrays];
      objects = { b: objects, a: i % 2 };
    }
    assert.equal(canonicalJson(arrays), '['.repeat(depth + 1) + ']'.repeat(depth + 1));
    assert.ok(canonicalJson(objects).startsWith('{"a":1,"b":{"a":0,"b":{'));
    assert.match(requestFingerprint('POST', '/api/bulk-issues', { courseId: 1, extra: arrays }), /^[0-9a-f]{64}$/);
    assert.notEqual(
      requestFingerprint('POST', '/api/bulk-issues', { courseId: 1, extra: arrays }),
      requestFingerprint('POST', '/api/bulk-issues', { courseId: 1, extra: [arrays] }),
    );
  });
});

describe('list query parsing', () => {
  it('applies defaults', () => {
    assert.deepEqual(parseListQuery({}), { q: '', status: 'all', sort: 'issued', order: 'desc', page: 1, pageSize: 25 });
    assert.deepEqual(parseListQuery({ sort: 'learner' }).order, 'asc');
  });

  const sortAndOrder = (query) => (({ sort, order }) => ({ sort, order }))(parseListQuery(query));

  it('accepts aliases and a leading minus for descending', () => {
    assert.equal(parseListQuery({ sort: 'serial_number' }).sort, 'serial');
    assert.equal(parseListQuery({ sort: 'serial-number' }).sort, 'serial');
    assert.equal(parseListQuery({ sort: 'SerialNumber' }).sort, 'serial');
    assert.equal(parseListQuery({ sort: 'issuedLocalDate' }).sort, 'issued');
    assert.equal(parseListQuery({ sort: 'course_title' }).sort, 'course');
    assert.equal(parseListQuery({ sort: 'learnerName', order: 'DESC' }).order, 'desc');
    assert.deepEqual(sortAndOrder({ sort: '-issued_at' }), { sort: 'issued', order: 'desc' });
    assert.deepEqual(sortAndOrder({ sort: '-learner' }), { sort: 'learner', order: 'desc' });
    assert.deepEqual(sortAndOrder({ sort: '-learner', order: 'asc' }), { sort: 'learner', order: 'asc' }, 'an explicit order wins');
    assert.equal(parseListQuery({ search: '  lee ' }).q, 'lee');
  });

  it('treats a blank parameter as not given', () => {
    assert.deepEqual(sortAndOrder({ sort: '-learner', order: '' }), { sort: 'learner', order: 'desc' });
    assert.deepEqual(sortAndOrder({ sort: '', sortBy: 'course' }), { sort: 'course', order: 'asc' });
    assert.deepEqual(sortAndOrder({ sort: ' ', order: ' ' }), { sort: 'issued', order: 'desc' });
    assert.equal(parseListQuery({ q: '', search: 'lee' }).q, 'lee');
    assert.equal(parseListQuery({ status: '' }).status, 'all');
    assert.deepEqual((({ page, pageSize }) => ({ page, pageSize }))(parseListQuery({ page: '', pageSize: ' ', limit: '7' })), { page: 1, pageSize: 7 });
  });

  it('rejects values it does not understand', () => {
    for (const query of [
      { sort: 'tenant_id' },
      // near misses of real names are not guessed at
      { sort: 'issued!!!' },
      { sort: 'l-e-a-r-n-e-r' },
      { sort: 'learner name' },
      { sort: 'serial__number' },
      { sort: '--issued' },
      { order: 'sideways' },
      { status: 'deleted' },
      { page: '0' },
      { page: '1.5' },
      { page: '1000001' },
      { page: '99999999999999999999' },
      { pageSize: '101' },
      { pageSize: '-1' },
      { q: 'x'.repeat(101) },
      { q: ['a', 'b'] },
      // names that exist on every object must not pass for sort columns
      { sort: 'constructor' },
      { sort: 'constructor', order: 'asc' },
      { sort: '-constructor' },
      { sort: 'Constructor', order: 'desc' },
      { sort: '__proto__', order: 'asc' },
      { sort: 'toString', order: 'asc' },
      { sort: '-hasOwnProperty' },
      // text that cannot be stored or matched faithfully
      { q: 'a\u0000b' },
      { q: 'tab\there' },
      { q: 'line\nbreak' },
      { q: 'lone \ud800 surrogate' },
    ]) {
      assert.throws(() => parseListQuery(query), (err) => err.status === 400, JSON.stringify(query));
    }
    assert.equal(parseListQuery({ q: ' José 李 😀 ' }).q, 'José 李 😀', 'ordinary Unicode is welcome');
    assert.throws(() => parseListQuery({ sort: 'constructor', order: 'asc' }), /"sort" must be one of: issued, learner, course, serial, status/);
  });

  it('refuses two names of the same parameter instead of ignoring one of them', () => {
    for (const [query, names] of [
      [{ sort: 'learner', sortBy: 'course' }, '"sort" and "sortBy"'],
      [{ sort: 'learner', sortBy: 'learner' }, '"sort" and "sortBy"'],
      [{ q: 'zoe', search: 'alex' }, '"q" and "search"'],
      [{ order: 'asc', dir: 'desc' }, '"order" and "dir"'],
      [{ direction: 'asc', sortOrder: 'asc' }, '"direction" and "sortOrder"'],
      [{ pageSize: '10', limit: '20' }, '"pageSize" and "limit"'],
      [{ page_size: '10', per_page: '10' }, '"page_size" and "per_page"'],
    ]) {
      assert.throws(
        () => parseListQuery(query),
        (err) => err.status === 400 && err.message === `Query parameters ${names} mean the same; send only one of them`,
        JSON.stringify(query),
      );
    }
    // The second name is checked even when it is the one that would have been ignored...
    assert.throws(() => parseListQuery({ pageSize: '10', limit: 'abc' }), (err) => err.status === 400);
    assert.throws(() => parseListQuery({ sort: 'learner', sortBy: ['a', 'b'] }), /"sortBy" must be a single value/);
    // ...while a blank one is no value at all.
    assert.equal(parseListQuery({ sort: 'learner', sortBy: '' }).sort, 'learner');
    assert.equal(parseListQuery({ pageSize: ' ', limit: '7' }).pageSize, 7);
  });

  it('reads status, sort and order in any letter case', () => {
    assert.equal(parseListQuery({ status: 'ACTIVE' }).status, 'active');
    assert.equal(parseListQuery({ status: 'Revoked' }).status, 'revoked');
    assert.equal(parseListQuery({ status: 'ALL' }).status, 'all');
    assert.deepEqual(sortAndOrder({ sort: 'LEARNER', order: 'Desc' }), { sort: 'learner', order: 'desc' });
  });

  it('counts the length of the search text in characters, not in UTF-16 units', () => {
    assert.equal(parseListQuery({ q: '😀'.repeat(100) }).q.length, 200, '100 emoji are 100 characters');
    assert.throws(() => parseListQuery({ q: '😀'.repeat(101) }), /"q" must be at most 100 characters/);
    assert.equal(parseListQuery({ q: 'é'.repeat(100) }).q.length, 100);
    assert.throws(() => parseListQuery({ q: 'é'.repeat(101) }), (err) => err.status === 400);
  });

  it('the export reads the same parameters, minus the paging ones', () => {
    assert.deepEqual(parseListQuery({ q: 'lee', sort: '-learner', page: '3', pageSize: '10' }, { paginate: false }), {
      q: 'lee',
      status: 'all',
      sort: 'learner',
      order: 'desc',
    });
    assert.deepEqual(parseListQuery({ page: 'abc', pageSize: '0' }, { paginate: false }).sort, 'issued', 'it has no pages to get wrong');
  });
});

describe('eligibility rules (A4)', () => {
  const row = (overrides) => ({
    enrollment_status: 'completed',
    certificate_id: null,
    certificate_status: null,
    serial_number: null,
    ...overrides,
  });

  it('is eligible only when completed and never certified', () => {
    assert.equal(classifyEnrollment(row({})).eligible, true);
    assert.equal(classifyEnrollment(row({ enrollment_status: 'in_progress' })).reason, 'not_completed');
    assert.equal(classifyEnrollment(row({ enrollment_status: 'not_started' })).reason, 'not_completed');
    assert.equal(
      classifyEnrollment(row({ certificate_id: 5, certificate_status: 'active', serial_number: 'X-1' })).reason,
      'already_certified',
    );
    assert.equal(
      classifyEnrollment(row({ certificate_id: 5, certificate_status: 'revoked', serial_number: 'X-1' })).reason,
      'certificate_revoked',
    );
  });

  it('explains every skip in words', () => {
    for (const overrides of [
      { enrollment_status: 'in_progress' },
      { certificate_id: 5, certificate_status: 'active', serial_number: 'X-1' },
      { certificate_id: 5, certificate_status: 'revoked', serial_number: 'X-1' },
    ]) {
      const verdict = classifyEnrollment(row(overrides));
      assert.equal(verdict.eligible, false);
      assert.ok(verdict.message.length > 10);
    }
  });
});

describe('database layer', () => {
  let dir;
  let db;

  before(() => {
    dir = createTempDir();
    db = openDatabase(path.join(dir, 'unit.sqlite'));
    migrate(db);
    seedDemoData(db);
  });

  after(() => {
    db.close();
    removeTempDir(dir);
  });

  const tenantCount = () => db.get('SELECT COUNT(*) AS n FROM tenants').n;
  const addTenant = (name) =>
    db.run("INSERT INTO tenants (name, code, timezone, created_at) VALUES (@name, @name, 'UTC', '2026-01-01T00:00:00.000Z')", { name });

  it('refuses in-memory databases (storage must be persistent)', () => {
    assert.throws(() => openDatabase(':memory:'), /file path is required/);
  });

  it('rolls back the whole transaction when the callback throws', () => {
    const before = tenantCount();
    assert.throws(() =>
      db.transaction(() => {
        addTenant('T1');
        throw new Error('boom');
      }),
    );
    assert.equal(tenantCount(), before);
    assert.equal(db.inTransaction, false);
  });

  it('contains a failed nested unit of work in a savepoint', () => {
    const before = tenantCount();
    db.transaction(() => {
      addTenant('KEEP1');
      assert.throws(() =>
        db.transaction(() => {
          addTenant('DROP');
          addTenant('DROP'); // UNIQUE violation
        }),
      );
      addTenant('KEEP2');
    });
    assert.equal(tenantCount(), before + 2);
    assert.equal(db.get("SELECT COUNT(*) AS n FROM tenants WHERE name = 'DROP'").n, 0);
    db.run("DELETE FROM tenants WHERE name IN ('KEEP1', 'KEEP2')");
  });

  it('rejects asynchronous transaction callbacks', () => {
    assert.throws(() => db.transaction(async () => {}), /synchronous/);
    assert.equal(db.inTransaction, false);
  });

  it('reports a transaction that SQLite ended behind a savepoint as aborted, not as an ordinary failure', () => {
    // SQLite rolls the WHOLE transaction back on some errors (disk full, out of memory). Played
    // here by ending the transaction inside the nested unit of work: its savepoint is then gone,
    // and the caller must not carry on as if only that unit had failed.
    const before = tenantCount();
    for (const innerFails of [true, false]) {
      let reachedAfterNested = false;
      assert.throws(
        () =>
          db.transaction(() => {
            addTenant('Outer');
            db.transaction(() => {
              addTenant('Inner');
              db.exec('ROLLBACK');
              if (innerFails) throw new Error('disk full');
            });
            reachedAfterNested = true;
          }),
        (err) => err instanceof TransactionAbortedError && err instanceof Error && (!innerFails || /disk full/.test(err.message)),
      );
      assert.equal(reachedAfterNested, false);
      assert.equal(db.inTransaction, false);
      assert.equal(tenantCount(), before, 'nothing of the aborted transaction survives');
    }
    // The connection is fully usable afterwards.
    db.transaction(() => addTenant('AfterAbort'));
    db.run("DELETE FROM tenants WHERE name = 'AfterAbort'");
  });

  it('takes the write lock without blocking the event loop while another connection holds it', async () => {
    const other = openDatabase(path.join(dir, 'unit.sqlite'));
    let locked = false;
    let write = null;
    try {
      const before = tenantCount();
      other.exec('BEGIN IMMEDIATE');
      locked = true;
      let ticks = 0;
      const ticker = setInterval(() => (ticks += 1), 5);
      write = db.writeTransaction(() => {
        addTenant('Waited');
        return 'committed';
      });
      write.catch(() => {}); // asserted on below
      try {
        assert.equal(await stillPending(write, 300), true, 'the write waits for the lock');
      } finally {
        clearInterval(ticker);
      }
      // A wait inside SQLite would freeze the process: not a single timer could have fired.
      assert.ok(ticks >= 2, `timers kept firing while waiting (${ticks} ticks)`);
      assert.equal(tenantCount(), before, 'reads on the same connection are served meanwhile');
      assert.equal(db.inTransaction, false);

      other.exec('COMMIT');
      locked = false;
      assert.equal(await write, 'committed');
      assert.equal(tenantCount(), before + 1);
    } finally {
      // Whatever happened above, the next test finds the table as this one found it.
      if (locked) other.exec('ROLLBACK');
      await write?.catch(() => {});
      db.run("DELETE FROM tenants WHERE name = 'Waited'");
      other.close();
    }
  });

  it('gives up with a busy error when the lock is not released in time, leaving the connection usable', async () => {
    const other = openDatabase(path.join(dir, 'unit.sqlite'));
    try {
      const before = tenantCount();
      const regularTimeout = db.get('PRAGMA busy_timeout').timeout;
      assert.ok(regularTimeout > 0);
      other.exec('BEGIN IMMEDIATE');
      const started = performance.now();
      await assert.rejects(
        db.writeTransaction(() => addTenant('Never'), { timeoutMs: 150 }),
        (err) => isBusyError(err),
      );
      const waited = performance.now() - started;
      assert.ok(waited >= 140 && waited < 3000, `waited ${waited} ms`);
      other.exec('ROLLBACK');

      assert.equal(db.inTransaction, false);
      assert.equal(db.get('PRAGMA busy_timeout').timeout, regularTimeout, 'the regular busy timeout is back in place');
      assert.equal(await db.writeTransaction(() => tenantCount()), before, 'and the next write goes through');
    } finally {
      other.close();
    }
  });

  it('a waiting write can be answered by what another connection committed meanwhile', async () => {
    const other = openDatabase(path.join(dir, 'unit.sqlite'));
    try {
      const before = tenantCount();
      other.exec('BEGIN IMMEDIATE');

      // Answer known on the third look: the wait ends there, the callback never runs, and the
      // lock holder is not waited for.
      let looks = 0;
      let ran = false;
      const started = performance.now();
      const result = await db.writeTransaction(
        () => {
          ran = true;
          addTenant('NotNeeded');
        },
        { timeoutMs: 30_000, whileWaiting: () => ((looks += 1) >= 3 ? { answeredBy: 'someone else' } : undefined) },
      );
      assert.deepEqual(result, { answeredBy: 'someone else' });
      assert.equal(looks, 3);
      assert.equal(ran, false);
      assert.ok(performance.now() - started < 5_000);
      assert.equal(db.inTransaction, false);

      // null, 0 and false are answers too; only undefined means "keep waiting".
      assert.equal(await db.writeTransaction(() => 'ran', { timeoutMs: 30_000, whileWaiting: () => null }), null);
      assert.equal(await db.writeTransaction(() => 'ran', { timeoutMs: 30_000, whileWaiting: () => false }), false);

      // An error thrown while looking is the outcome as well (a conflict that became visible).
      await assert.rejects(
        db.writeTransaction(() => 'ran', {
          timeoutMs: 30_000,
          whileWaiting: () => {
            throw new Error('conflict found while waiting');
          },
        }),
        /conflict found while waiting/,
      );

      // Without an answer the wait ends as usual - after one last look at the deadline.
      looks = 0;
      await assert.rejects(
        db.writeTransaction(() => 'ran', { timeoutMs: 120, whileWaiting: () => void (looks += 1) }),
        (err) => isBusyError(err),
      );
      assert.ok(looks >= 2, `looked ${looks} times`);
      const looksAtDeadline = looks;
      await assert.rejects(db.writeTransaction(() => 'ran', { timeoutMs: 0, whileWaiting: () => void (looks += 1) }), (err) => isBusyError(err));
      assert.equal(looks, looksAtDeadline + 1, 'even a zero wait looks once before giving up');

      other.exec('ROLLBACK');
      // With the lock free the callback runs and whileWaiting is never consulted.
      looks = 0;
      assert.equal(await db.writeTransaction(() => 'ran', { whileWaiting: () => void (looks += 1) }), 'ran');
      assert.equal(looks, 0);
      assert.equal(tenantCount(), before);
    } finally {
      other.close();
    }
  });

  it('keeps looking at short intervals, however long it has been waiting', async () => {
    const other = openDatabase(path.join(dir, 'unit.sqlite'));
    try {
      other.exec('BEGIN IMMEDIATE');
      // The answer becomes known 1.2 s into the wait. The pauses between two looks grow at first
      // but never beyond a tenth of a second, so it is picked up almost at once.
      const started = performance.now();
      const answer = await db.writeTransaction(() => 'ran', {
        timeoutMs: 30_000,
        whileWaiting: () => (performance.now() - started >= 1_200 ? 'known' : undefined),
      });
      const waited = performance.now() - started;
      assert.equal(answer, 'known');
      assert.ok(waited >= 1_200 && waited < 1_800, `answered ${Math.round(waited - 1_200)} ms after the answer was there`);
      other.exec('ROLLBACK');
    } finally {
      other.close();
    }
  });

  it('measures the lock wait in elapsed time, whatever happens to the system clock', async () => {
    const other = openDatabase(path.join(dir, 'unit.sqlite'));
    const realNow = Date.now;
    try {
      other.exec('BEGIN IMMEDIATE');
      for (const jumpMs of [3_600_000, -3_600_000]) {
        const started = performance.now();
        const attempt = db.writeTransaction(() => 'ran', { timeoutMs: 300 });
        attempt.catch(() => {}); // asserted on below
        setTimeout(() => {
          Date.now = () => realNow() + jumpMs; // somebody sets the clock an hour forward / back
        }, 60);
        const gaveUp = !(await stillPending(attempt, 3_000));
        Date.now = realNow;
        const waited = performance.now() - started;
        assert.equal(gaveUp, true, `clock jump of ${jumpMs} ms: still waiting after ${Math.round(waited)} ms`);
        await assert.rejects(attempt, (err) => isBusyError(err));
        assert.ok(waited >= 280, `clock jump of ${jumpMs} ms: gave up after only ${Math.round(waited)} ms`);
      }
      other.exec('ROLLBACK');
    } finally {
      Date.now = realNow;
      other.close();
    }
  });

  it('write transactions roll back on errors, nest savepoints and refuse async callbacks', async () => {
    const before = tenantCount();
    await assert.rejects(
      db.writeTransaction(() => {
        addTenant('Gone');
        throw new Error('boom');
      }),
      /boom/,
    );
    await assert.rejects(db.writeTransaction(async () => addTenant('Async')), /must be synchronous/);
    assert.equal(tenantCount(), before);

    const names = await db.writeTransaction(() => {
      addTenant('Kept');
      assert.throws(() =>
        db.transaction(() => {
          addTenant('Undone');
          throw new Error('inner');
        }),
      );
      return db.all("SELECT name FROM tenants WHERE name IN ('Kept', 'Undone')").map((row) => row.name);
    });
    assert.deepEqual(names, ['Kept']);
    db.run("DELETE FROM tenants WHERE name = 'Kept'");
    assert.equal(db.inTransaction, false);
  });

  it('retries the switch to WAL journaling while simultaneous openers make SQLite report busy', () => {
    assert.equal(db.get('PRAGMA journal_mode').journal_mode, 'wal');

    // Two processes that open a brand-new file at the same instant collide on this statement, and
    // SQLite reports the loser "busy" at once. The window is far too narrow to hit on demand, so
    // the collision is played by a stand-in connection.
    const busy = Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY', errcode: 5 });
    let attempts = 0;
    const collides = {
      get(sql) {
        assert.equal(sql, 'PRAGMA journal_mode = WAL');
        attempts += 1;
        if (attempts < 4) throw busy;
        return { journal_mode: 'wal' };
      },
    };
    enableWal(collides, { timeoutMs: 5_000 });
    assert.equal(attempts, 4, 'three collisions, then the switch (or the no-op after somebody else made it)');

    const failing = {
      get() {
        throw new Error('disk I/O error');
      },
    };
    assert.throws(() => enableWal(failing, { timeoutMs: 5_000 }), /disk I\/O error/, 'other errors are not retried');

    const stuck = {
      get() {
        throw busy;
      },
    };
    const started = performance.now();
    assert.throws(() => enableWal(stuck, { timeoutMs: 100 }), (err) => isBusyError(err));
    const waited = performance.now() - started;
    assert.ok(waited >= 90 && waited < 3_000, `gave up after ${waited} ms`);

    const refused = { get: () => ({ journal_mode: 'delete' }) };
    assert.throws(() => enableWal(refused, { timeoutMs: 50 }), /WAL journaling.*"delete"/);

    // This wait is measured in elapsed time as well: setting the system clock does not cut it short.
    const realNow = Date.now;
    let tries = 0;
    const collidesWhileTheClockIsSet = {
      get() {
        tries += 1;
        if (tries === 2) Date.now = () => realNow() + 3_600_000;
        if (tries < 6) throw busy;
        return { journal_mode: 'wal' };
      },
    };
    try {
      enableWal(collidesWhileTheClockIsSet, { timeoutMs: 5_000 });
    } finally {
      Date.now = realNow;
    }
    assert.equal(tries, 6, 'kept trying although the wall clock jumped an hour ahead');
  });

  it('opening a new file while another process writes to it waits for the WAL switch instead of failing', async () => {
    // The real thing, deterministically: a second process has created the file, has not switched
    // it to WAL yet and holds the write lock. In that state SQLite refuses the journal-mode
    // switch at once ("database is locked") - the busy timeout does not apply to it.
    const file = path.join(dir, 'contended-new-file.sqlite');
    const holdMs = 400;
    const holder = await holdRollbackJournalLock(file, holdMs);
    const started = performance.now();
    const opened = openDatabase(file); // blocks until the other process lets go
    const waited = performance.now() - started;
    try {
      assert.equal(opened.get('PRAGMA journal_mode').journal_mode, 'wal');
      assert.ok(waited >= holdMs / 4, `the open really had to wait (${Math.round(waited)} ms)`);
      assert.equal(await holder.exited, 0);
      assert.equal(opened.get("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'filler'").n, 1, "the other process's work is intact");
    } finally {
      opened.close();
    }
  });

  it('tells busy errors apart from everything else', () => {
    assert.equal(isBusyError(new Error('UNIQUE constraint failed: tenants.name')), false);
    assert.equal(isBusyError(null), false);
    assert.equal(isBusyError(undefined), false);
    assert.throws(() => addTenant('East'), (err) => /UNIQUE/i.test(err.message) && !isBusyError(err));
  });

  it('enforces tenant boundaries in the schema itself', () => {
    const eastCourse = db.get("SELECT id FROM courses WHERE tenant_id = 1 AND title = 'Safety 101'").id;
    const westLearner = db.get("SELECT id FROM learners WHERE tenant_id = 2 AND full_name = 'Jordan Smith'").id;
    // A West learner cannot be enrolled in - or certified for - an East course, whatever tenant_id says.
    for (const tenantId of [1, 2]) {
      assert.throws(
        () =>
          db.run(
            `INSERT INTO enrollments (tenant_id, course_id, learner_id, status, created_at)
             VALUES (@tenantId, @courseId, @learnerId, 'in_progress', '2026-01-01T00:00:00.000Z')`,
            { tenantId, courseId: eastCourse, learnerId: westLearner },
          ),
        /FOREIGN KEY/i,
      );
      assert.throws(
        () =>
          db.run(
            `INSERT INTO certificates (tenant_id, course_id, learner_id, serial_number, learner_name, course_title,
                                       learner_name_key, course_title_key, issued_at, issued_local_date)
             VALUES (@tenantId, @courseId, @learnerId, 'X-1', 'Jordan Smith', 'Safety 101',
                     'jordan smith', 'safety 101', '2026-01-01T00:00:00.000Z', '2026-01-01')`,
            { tenantId, courseId: eastCourse, learnerId: westLearner },
          ),
        /FOREIGN KEY/i,
      );
    }
  });

  it('refuses references to another tenant\'s enrollment, bulk operation or certificate', () => {
    // East: Priya Sharma completed Safety 101 and has no certificate yet. West: one bulk operation
    // and Alex Lee's certificate. Every statement below is valid except for the row it points at.
    const east = db.get(
      `SELECT e.id AS enrollmentId, e.course_id AS courseId, e.learner_id AS learnerId
         FROM enrollments e JOIN learners l ON l.id = e.learner_id JOIN courses c ON c.id = e.course_id
        WHERE e.tenant_id = 1 AND l.full_name = 'Priya Sharma' AND c.title = 'Safety 101'`,
    );
    const eastAdmin = db.get('SELECT id FROM admins WHERE tenant_id = 1').id;
    const eastCertificate = db.get('SELECT id FROM certificates WHERE tenant_id = 1 ORDER BY id LIMIT 1').id;
    const westEnrollment = db.get('SELECT id FROM enrollments WHERE tenant_id = 2 ORDER BY id LIMIT 1').id;
    const westCertificate = db.get('SELECT id FROM certificates WHERE tenant_id = 2 ORDER BY id LIMIT 1').id;
    const west = db.get('SELECT a.id AS adminId, c.id AS courseId FROM admins a, courses c WHERE a.tenant_id = 2 AND c.tenant_id = 2 LIMIT 1');

    const insertOperation = (tenantId, adminId, courseId) =>
      db.run(
        `INSERT INTO bulk_issue_operations (tenant_id, actor_admin_id, course_id, request_hash, status, created_at)
         VALUES (@tenantId, @adminId, @courseId, 'hash', 'running', '2026-01-01T00:00:00.000Z')`,
        { tenantId, adminId, courseId },
      ).lastInsertRowid;
    const insertCertificate = ({ enrollmentId = null, operationId = null, issuedBy = null, revokedBy = null }) =>
      db.run(
        `INSERT INTO certificates (tenant_id, course_id, learner_id, enrollment_id, bulk_operation_id, serial_number,
                                   learner_name, course_title, learner_name_key, course_title_key, issued_at, issued_local_date,
                                   issued_by_admin_id, status, revoked_at, revoked_by_admin_id)
         VALUES (1, @courseId, @learnerId, @enrollmentId, @operationId, 'X-2', 'Priya Sharma', 'Safety 101',
                 'priya sharma', 'safety 101', '2026-01-01T00:00:00.000Z', '2026-01-01',
                 @issuedBy, @status, @revokedAt, @revokedBy)`,
        {
          courseId: east.courseId,
          learnerId: east.learnerId,
          enrollmentId,
          operationId,
          issuedBy,
          status: revokedBy === null ? 'active' : 'revoked',
          revokedAt: revokedBy === null ? null : '2026-01-02T00:00:00.000Z',
          revokedBy,
        },
      ).lastInsertRowid;
    const insertAuditEvent = ({ certificateId, operationId = null, adminId = eastAdmin }) =>
      db.run(
        `INSERT INTO audit_events (tenant_id, actor_admin_id, actor_email, action, certificate_id, bulk_operation_id, created_at)
         VALUES (1, @adminId, 'alice@east.test', 'certificate.issued', @certificateId, @operationId, '2026-01-01T00:00:00.000Z')`,
        { adminId, certificateId, operationId },
      );

    class Undo extends Error {}
    assert.throws(
      () =>
        db.transaction(() => {
          const westOperation = insertOperation(2, west.adminId, west.courseId);
          const eastOperation = insertOperation(1, eastAdmin, east.courseId);

          assert.throws(() => insertCertificate({ enrollmentId: westEnrollment }), /FOREIGN KEY/i);
          assert.throws(() => insertCertificate({ operationId: westOperation }), /FOREIGN KEY/i);
          assert.throws(() => insertAuditEvent({ certificateId: westCertificate }), /FOREIGN KEY/i);
          assert.throws(() => insertAuditEvent({ certificateId: eastCertificate, operationId: westOperation }), /FOREIGN KEY/i);
          // ...and so are the references to people and courses: an East row cannot name a West admin
          // as its actor, issuer or revoker, and an East operation cannot run on a West course.
          assert.throws(() => insertOperation(1, west.adminId, east.courseId), /FOREIGN KEY/i);
          assert.throws(() => insertOperation(1, eastAdmin, west.courseId), /FOREIGN KEY/i);
          assert.throws(() => insertCertificate({ issuedBy: west.adminId }), /FOREIGN KEY/i);
          assert.throws(() => insertCertificate({ issuedBy: eastAdmin, revokedBy: west.adminId }), /FOREIGN KEY/i);
          assert.throws(() => insertAuditEvent({ certificateId: eastCertificate, adminId: west.adminId }), /FOREIGN KEY/i);
          // moving a row to the other tenant is refused just the same
          assert.throws(() => db.run('UPDATE certificates SET tenant_id = 2 WHERE id = @id', { id: eastCertificate }), /FOREIGN KEY/i);
          assert.throws(() => db.run('UPDATE audit_events SET tenant_id = 2 WHERE certificate_id = @id', { id: eastCertificate }), /FOREIGN KEY/i);

          // The same statements pointing at rows of the right tenant are accepted.
          const certificateId = insertCertificate({
            enrollmentId: east.enrollmentId,
            operationId: eastOperation,
            issuedBy: eastAdmin,
            revokedBy: eastAdmin,
          });
          insertAuditEvent({ certificateId, operationId: eastOperation });
          throw new Undo();
        }),
      Undo,
    );
  });

  it('refuses a database file written by another schema version', () => {
    const old = openDatabase(path.join(dir, 'old-version.sqlite'));
    try {
      old.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
      assert.throws(() => migrate(old), /schema version \d+ is not supported.*db:reset/s);
    } finally {
      old.close();
    }
  });

  it('does not create the schema twice when another process got there first', () => {
    // Stand-in for two processes starting on a new file: this one still read "no schema yet"
    // a moment before the other one finished creating it.
    let staleReads = 0;
    const racing = {
      get(sql, params) {
        if (sql === 'PRAGMA user_version' && staleReads === 0) {
          staleReads += 1;
          return { user_version: 0 };
        }
        return db.get(sql, params);
      },
      exec: (sql) => db.exec(sql),
      transaction: (fn, options) => db.transaction(fn, options),
    };
    migrate(racing);
    assert.equal(staleReads, 1);
    assert.equal(db.get('PRAGMA user_version').user_version, SCHEMA_VERSION);
    assert.equal(db.inTransaction, false);
  });

  it('initialising twice changes nothing', () => {
    const count = () => db.get('SELECT (SELECT COUNT(*) FROM tenants) + (SELECT COUNT(*) FROM certificates) AS n').n;
    const before = count();
    migrate(db);
    assert.equal(seedDemoData(db), false, 'data is already there');
    assert.equal(count(), before);
  });

  it('refuses learners without a name (a certificate could never be issued to them)', () => {
    for (const name of ['', '   ']) {
      assert.throws(
        () => insertLearner(db, 1, name),
        /CHECK/i,
      );
    }
  });

  it('allows at most one certificate per learner and course', () => {
    const existing = db.get('SELECT tenant_id, course_id, learner_id FROM certificates WHERE id = 1');
    assert.throws(
      () =>
        db.run(
          `INSERT INTO certificates (tenant_id, course_id, learner_id, serial_number, learner_name, course_title,
                                     learner_name_key, course_title_key, issued_at, issued_local_date)
           VALUES (@tenant_id, @course_id, @learner_id, 'DUP-1', 'Alex Lee', 'Safety 101',
                   'alex lee', 'safety 101', '2026-01-01T00:00:00.000Z', '2026-01-01')`,
          { tenant_id: existing.tenant_id, course_id: existing.course_id, learner_id: existing.learner_id },
        ),
      /UNIQUE/i,
    );
  });

  it('seeds the quick-start scenario required by the spec', () => {
    const tenants = db.all('SELECT name, timezone FROM tenants ORDER BY id').map((t) => ({ ...t }));
    assert.deepEqual(tenants, [
      { name: 'East', timezone: 'Australia/Sydney' },
      { name: 'West', timezone: 'Australia/Perth' },
    ]);
    const admins = db
      .all('SELECT a.email, t.name AS tenant FROM admins a JOIN tenants t ON t.id = a.tenant_id ORDER BY a.id')
      .map((a) => ({ ...a }));
    assert.deepEqual(admins, [
      { email: 'alice@east.test', tenant: 'East' },
      { email: 'bob@west.test', tenant: 'West' },
    ]);

    for (const tenantId of [1, 2]) {
      const alex = db.all("SELECT id FROM learners WHERE tenant_id = @tenantId AND full_name = 'Alex Lee'", { tenantId });
      assert.equal(alex.length, 1, 'exactly one Alex Lee per tenant');

      const roster = db.all(
        `SELECT e.status, c.id AS certificate_id
           FROM enrollments e
           JOIN courses co ON co.id = e.course_id
           LEFT JOIN certificates c ON c.course_id = e.course_id AND c.learner_id = e.learner_id
          WHERE e.tenant_id = @tenantId AND co.title = 'Safety 101'`,
        { tenantId },
      );
      const certified = roster.filter((r) => r.certificate_id !== null).length;
      const eligible = roster.filter((r) => r.status === 'completed' && r.certificate_id === null).length;
      const incomplete = roster.filter((r) => r.status !== 'completed').length;
      assert.ok(certified >= 1 && eligible >= 1 && incomplete >= 1, 'Safety 101 covers all three enrollment kinds');

      // Alex Lee personally has a certified, a completed-but-uncertified and an incomplete enrollment.
      const alexEnrollments = db.all(
        `SELECT e.status, c.id AS certificate_id
           FROM enrollments e
           LEFT JOIN certificates c ON c.course_id = e.course_id AND c.learner_id = e.learner_id
          WHERE e.learner_id = @learnerId`,
        { learnerId: alex[0].id },
      );
      assert.ok(alexEnrollments.some((e) => e.certificate_id !== null));
      assert.ok(alexEnrollments.some((e) => e.status === 'completed' && e.certificate_id === null));
      assert.ok(alexEnrollments.some((e) => e.status !== 'completed'));
    }

    // Every seeded certificate has exactly one issuance audit event; revoked ones also one revocation.
    const mismatches = db.all(
      `SELECT c.id FROM certificates c
        WHERE (SELECT COUNT(*) FROM audit_events a WHERE a.certificate_id = c.id AND a.action = 'certificate.issued') <> 1
           OR (SELECT COUNT(*) FROM audit_events a WHERE a.certificate_id = c.id AND a.action = 'certificate.revoked')
              <> (c.status = 'revoked')`,
    );
    assert.deepEqual(mismatches, []);
  });

  it('stores every name together with its folded form, which is what gets sorted and searched', () => {
    const names = db.all(
      `SELECT 'learner' AS kind, full_name AS name, name_key AS key FROM learners
       UNION ALL SELECT 'course', title, title_key FROM courses
       UNION ALL SELECT 'certificate learner', learner_name, learner_name_key FROM certificates
       UNION ALL SELECT 'certificate course', course_title, course_title_key FROM certificates`,
    );
    assert.ok(names.length >= 13 + 6 + 2 * 11);
    for (const { kind, name, key } of names) assert.equal(key, foldText(name), `${kind} "${name}"`);
    assert.ok(names.some(({ name, key }) => name === 'José Álvarez' && key === 'jose alvarez'));
    // A name cannot be stored without its key.
    assert.throws(
      () => db.run("INSERT INTO learners (tenant_id, full_name, created_at) VALUES (1, 'No Key', '2026-01-01T00:00:00.000Z')"),
      /NOT NULL/i,
    );
    assert.throws(
      () => db.run("INSERT INTO courses (tenant_id, title, created_at) VALUES (1, 'No Key', '2026-01-01T00:00:00.000Z')"),
      /NOT NULL/i,
    );
  });
});

describe('text folding for search and sort', () => {
  it('ignores case and accents', () => {
    assert.equal(foldText('José Álvarez'), 'jose alvarez');
    assert.equal(foldText('JOSÉ ÁLVAREZ'), 'jose alvarez');
    assert.equal(foldText('jose alvarez'), 'jose alvarez');
    assert.equal(foldText('Zoë Brontë-Müller'), 'zoe bronte-muller');
    assert.equal(foldText('Ngô Thị Ánh Tuyết'), 'ngo thi anh tuyet');
    assert.equal(foldText("O'Connor"), "o'connor");
    assert.equal(foldText('EAST-0000001'), 'east-0000001');
  });

  it('unifies the different ways of writing the same text', () => {
    assert.equal(foldText('Jose\u0301'), foldText('Jos\u00e9'), 'combining accent vs precomposed letter');
    assert.equal(foldText('Ｊｏｓｅ　Ｌｅｅ'), 'jose lee', 'full-width forms');
    assert.equal(foldText('Alex\u00a0Lee'), 'alex lee', 'non-breaking space');
    assert.equal(foldText('ﬁona'), 'fiona', 'ligatures');
    assert.equal(foldText('İstanbul'), 'istanbul');
    assert.equal(foldText('ΟΔΥΣΣΕΥΣ'), foldText('οδυσσευς'), 'both lower-case sigmas');
    assert.ok(foldText('ΟΔΥΣΣΕΥΣ').includes(foldText('ΥΣΣ')), 'a fragment cut out of an upper-case word still matches');
  });

  it('leaves other scripts and symbols as they are', () => {
    assert.equal(foldText('李雷'), '李雷');
    assert.equal(foldText('한글'), '한글', 'Hangul stays composed');
    assert.equal(foldText('की'), 'की', 'vowel signs of other scripts are kept');
    assert.equal(foldText('ガ'), 'ガ', 'and so are kana voicing marks');
    assert.equal(foldText('😀 100%_\\'), '😀 100%_\\');
    assert.equal(foldText(''), '');
  });

  it('drops every combining accent, not just the common ones', () => {
    for (let mark = 0x300; mark <= 0x36f; mark += 1) {
      assert.equal(foldText(`a${String.fromCodePoint(mark)}b`), 'ab', `U+0${mark.toString(16)}`);
    }
    assert.equal(foldText('François Wałęsa'), 'francois walesa', 'cedilla, stroke and ogonek');
    assert.equal(foldText('Dvořák Šimůnek Ţepeş Ğül'), 'dvorak simunek tepes gul');
    assert.equal(foldText('Nguyễn Thị Hằng'), 'nguyen thi hang', 'two accents on one letter');
  });

  it('spells out the Latin letters that have no accent to drop', () => {
    assert.equal(foldText('Søren Łukasz'), 'soren lukasz');
    assert.equal(foldText('ØYSTEIN ØDEGÅRD'), 'oystein odegard');
    assert.equal(foldText('Straße'), 'strasse');
    assert.equal(foldText('STRASSE'), 'strasse');
    assert.equal(foldText('GROẞ'), 'gross', 'capital sharp s');
    assert.equal(foldText('Đorđe Þór Ægir Œuvre Ħal Ŧ Ð'), 'dorde thor aegir oeuvre hal t d');
    assert.equal(foldText('Ǿ ǽ'), 'o ae', 'also underneath an accent');
    for (const written of ['Işık', 'IŞIK', 'ışık', 'isik', 'ISIK', 'İŞİK']) assert.equal(foldText(written), 'isik', written);
  });

  it('drops an accent typed on its own instead of turning it into a space', () => {
    for (const accent of ['´', '¨', '¯', '¸', '˜', '΄', '῾', '‾', '\u0301\u0300', '\u00a0\u0301']) {
      assert.equal(foldText(accent), '', `U+${accent.codePointAt(0).toString(16)}`);
    }
    assert.equal(foldText('e´'), 'e');
    assert.equal(foldText('´l'), 'l');
    assert.equal(foldText('Alex ¨ Lee'), 'alex  lee', 'the spaces that were typed stay');
    assert.equal(foldText('Alex Lee'), 'alex lee');
  });

  it('agrees with an independently written reference on ordinary names', () => {
    for (const name of ['José Álvarez', 'Zoë', 'Élodie Durand', 'ÅSA Öberg', 'Nguyễn Văn A', "Marcus O'Connor", 'alex lee', 'ALEX LEE']) {
      assert.equal(foldText(name), referenceFold(name), name);
    }
  });

  it('is stable: folding twice changes nothing', () => {
    for (const name of ['José Álvarez', 'ΟΔΥΣΣΕΥΣ', 'Ｊｏｓｅ', 'İstanbul', 'ﬁona', '한글', 'Straße', 'Þór Ægir', 'Işık', 'e´ ¨']) {
      assert.equal(foldText(foldText(name)), foldText(name), name);
    }
  });
});

describe('limiter (concurrent exports)', () => {
  it('admits up to the limit and the rest in arrival order', async () => {
    const limiter = createLimiter(2);
    const releaseA = await limiter.acquire();
    const releaseB = await limiter.acquire();
    assert.deepEqual([limiter.active, limiter.waiting], [2, 0]);

    const order = [];
    const c = limiter.acquire().then((release) => (order.push('c'), release));
    const d = limiter.acquire().then((release) => (order.push('d'), release));
    assert.equal(await stillPending(Promise.race([c, d]), 30), true, 'nobody is admitted beyond the limit');
    assert.deepEqual([limiter.active, limiter.waiting], [2, 2]);

    releaseA();
    const releaseC = await c;
    assert.deepEqual(order, ['c']);
    assert.equal(await stillPending(d, 30), true);
    releaseA(); // releasing twice does not free a second slot
    assert.equal(await stillPending(d, 30), true);
    assert.deepEqual([limiter.active, limiter.waiting], [2, 1]);

    releaseB();
    const releaseD = await d;
    assert.deepEqual(order, ['c', 'd']);
    releaseC();
    releaseD();
    assert.deepEqual([limiter.active, limiter.waiting], [0, 0]);
  });

  it('a caller that gives up while waiting leaves the queue without taking a slot', async () => {
    const limiter = createLimiter(1);
    const release = await limiter.acquire();
    const impatient = new AbortController();
    const abandoned = limiter.acquire({ signal: impatient.signal });
    const patient = limiter.acquire();
    assert.equal(limiter.waiting, 2);

    impatient.abort(new Error('client went away'));
    await assert.rejects(abandoned, /client went away/);
    assert.equal(limiter.waiting, 1);

    release();
    const next = await patient;
    assert.deepEqual([limiter.active, limiter.waiting], [1, 0]);
    next();

    const alreadyGone = new AbortController();
    alreadyGone.abort(new Error('never mind'));
    await assert.rejects(limiter.acquire({ signal: alreadyGone.signal }), /never mind/);
    assert.equal(limiter.active, 0);
  });

  it('a signal that fires after its caller was admitted disturbs nobody who is still waiting', async () => {
    const limiter = createLimiter(1);
    const releaseA = await limiter.acquire();
    const finished = new AbortController();
    const b = limiter.acquire({ signal: finished.signal });
    const c = limiter.acquire();
    const d = limiter.acquire();
    releaseA();
    const releaseB = await b;

    // The export route fires its signal when a request is over, long after the slot was granted.
    finished.abort(new Error('request over'));
    assert.deepEqual([limiter.active, limiter.waiting], [1, 2], 'the two behind it are still in the queue');

    releaseB();
    const releaseC = await c;
    assert.equal(await stillPending(d, 30), true, 'and are admitted in order');
    releaseC();
    (await d)();
    assert.deepEqual([limiter.active, limiter.waiting], [0, 0]);
  });

  it('turns callers away once the queue is full', async () => {
    const limiter = createLimiter(1, { maxWaiting: 2 });
    const release = await limiter.acquire();
    const waiting = [limiter.acquire(), limiter.acquire()];
    await assert.rejects(limiter.acquire(), LimiterFullError);
    assert.equal(limiter.waiting, 2);
    release();
    (await waiting[0])();
    (await waiting[1])();
    assert.deepEqual([limiter.active, limiter.waiting], [0, 0]);
    assert.throws(() => createLimiter(0), RangeError);
  });
});

describe('settings', () => {
  it('have sensible defaults', () => {
    const config = loadConfig({});
    assert.deepEqual(
      [config.port, config.host, config.logRequests, config.maxConcurrentExports, config.exportIdleTimeoutMs],
      [3000, undefined, true, 4, 300_000],
    );
    assert.equal(loadConfig({ PORT: '', EXPORT_MAX_CONCURRENT: ' ', EXPORT_IDLE_TIMEOUT_MS: '' }).port, 3000, 'blank means unset');
    assert.equal(loadConfig({ EXPORT_IDLE_TIMEOUT_MS: '0' }).exportIdleTimeoutMs, 0, '0 switches the timeout off');
    assert.equal(loadConfig({ PORT: ' 8080 ' }).port, 8080);
    assert.equal(loadConfig({ EXPORT_MAX_CONCURRENT: '64' }).maxConcurrentExports, 64);
  });

  it('rejects unusable values in one line each', () => {
    for (const [name, value] of [
      ['PORT', 'eighty'],
      ['PORT', '70000'],
      ['PORT', '-1'],
      ['EXPORT_MAX_CONCURRENT', '0'],
      ['EXPORT_MAX_CONCURRENT', '2.5'],
      ['EXPORT_MAX_CONCURRENT', 'many'],
      ['EXPORT_IDLE_TIMEOUT_MS', '-5'],
      ['EXPORT_IDLE_TIMEOUT_MS', 'soon'],
      // numbers, but not written the way a setting is: plain decimal digits only
      ['PORT', '0x1F90'],
      ['PORT', '0b1'],
      ['PORT', '8e3'],
      ['PORT', '+8080'],
      ['EXPORT_MAX_CONCURRENT', '4.0'],
      ['EXPORT_MAX_CONCURRENT', '65'],
      ['EXPORT_IDLE_TIMEOUT_MS', '3600001'],
      ['EXPORT_IDLE_TIMEOUT_MS', '1e4'],
    ]) {
      assert.throws(
        () => loadConfig({ [name]: value }),
        (err) => err.message.startsWith(`${name} must be an integer between `) && err.message.includes(`"${value}"`) && !err.message.includes('\n'),
        `${name}=${value}`,
      );
    }
  });
});

describe('load-test generator', () => {
  it('numbers its certificates in a range of their own', () => {
    assert.equal(formatGeneratedSerial('EAST', 1), 'EAST-LT-0000001');
    assert.equal(formatGeneratedSerial('EAST', 2_000_000), 'EAST-LT-2000000');
  });
});

describe('export stream', () => {
  const actor = { tenantId: 1, timezone: 'Australia/Sydney' };
  const row = (name, matches) => ({ learner_name: name, course_title: 'Course', serial_number: `S-${name}`, issued_at: '2026-01-10T13:30:00.000Z', matches });

  /**
   * A stand-in for the export's own connection that records what the export does with it.
   * `reader.open` is what the export is given: the function that opens the connection.
   */
  function fakeReader(rows, { onFetch = () => {}, onOpen = () => {} } = {}) {
    const reader = {
      opened: 0,
      closed: 0,
      statements: [],
      fetched: 0,
      iteratorReturned: false,
      open() {
        reader.opened += 1;
        onOpen(reader);
        return reader;
      },
      close() {
        reader.closed += 1;
      },
      exec: (sql) => reader.statements.push(sql),
      iterate() {
        let i = 0;
        return {
          next() {
            if (i >= rows.length) return { done: true, value: undefined };
            reader.fetched += 1;
            onFetch(reader);
            return { done: false, value: rows[i++] };
          },
          return() {
            reader.iteratorReturned = true;
            return { done: true, value: undefined };
          },
        };
      },
    };
    return reader;
  }

  it('keeps the filter out of WHERE, so that no single step depends on how many rows match', () => {
    const filtered = buildExportPlan(actor, parseListQuery({ q: 'Lee', status: 'active', sort: 'learner' }, { paginate: false }));
    assert.equal(filtered.filtered, true);
    assert.match(filtered.sql, /AS matches/);
    assert.match(filtered.sql, /WHERE c\.tenant_id = @tenantId\s+ORDER BY/);
    assert.deepEqual(filtered.params, { tenantId: 1, needle: 'lee', serialPattern: '%lee%', status: 'active' });

    const everything = buildExportPlan(actor, parseListQuery({}, { paginate: false }));
    assert.equal(everything.filtered, false);
    assert.doesNotMatch(everything.sql, /matches/);
    assert.deepEqual(everything.params, { tenantId: 1 });
  });

  it('looks at a fixed number of rows per step, whether they match or not', async () => {
    const rows = Array.from({ length: 1_050 }, (_, i) => row(`n${i}`, i === 7 || i === 1_049 ? 1 : 0));
    const reader = fakeReader(rows);
    const plan = { sql: 'SELECT ...', params: {}, filtered: true, timeZone: 'Australia/Sydney', header: ['H'] };
    const stream = streamCsvExport(reader.open, plan, { batchRows: 100 });
    assert.equal(reader.opened, 0, 'nothing is opened before the export is asked for its first chunk');

    const first = await stream.next();
    assert.equal(first.value, 'H\nn7,Course,S-n7,2026-01-11 00:30\n', 'the header travels with the first step');
    assert.equal(reader.fetched, 100, 'the first step stopped after 100 rows although only one matched');

    const second = await stream.next();
    assert.equal(second.value, 'n1049,Course,S-n1049,2026-01-11 00:30\n');
    assert.equal(reader.fetched, 1_050, 'steps without a match produce no chunk; the next match ends the wait');
    assert.deepEqual(await stream.next(), { done: true, value: undefined });
    assert.deepEqual(reader.statements, ['BEGIN', 'ROLLBACK'], 'one read transaction, closed at the end');
    assert.equal(reader.iteratorReturned, true);
    assert.deepEqual([reader.opened, reader.closed], [1, 1], 'one connection, opened and closed by the export itself');
  });

  it('includes every row when there is no filter, and releases the snapshot when abandoned mid-way', async () => {
    const rows = Array.from({ length: 250 }, (_, i) => row(`n${i}`, undefined));
    const reader = fakeReader(rows);
    const plan = { sql: 'SELECT ...', params: {}, filtered: false, timeZone: 'Australia/Sydney', header: ['H'] };
    const stream = streamCsvExport(reader.open, plan, { batchRows: 100 });
    const first = await stream.next();
    assert.equal(first.value.split('\n').length - 1, 101, 'header + 100 rows');
    await stream.return(undefined); // the client went away
    assert.deepEqual(reader.statements, ['BEGIN', 'ROLLBACK']);
    assert.equal(reader.iteratorReturned, true);
    assert.equal(reader.fetched, 100, 'nothing more was read');
    assert.deepEqual([reader.opened, reader.closed], [1, 1], 'and the connection is closed');
  });

  it('reports a connection that cannot be opened as the failure of the first chunk', async () => {
    const plan = { sql: 'SELECT ...', params: {}, filtered: false, timeZone: 'Australia/Sydney', header: ['H'] };
    const stream = streamCsvExport(() => {
      throw new Error('cannot open');
    }, plan);
    await assert.rejects(stream.next(), /cannot open/);
    assert.deepEqual(await stream.next(), { done: true, value: undefined });
  });

  it('takes steps of 500 rows, and all exports together take one step per event-loop iteration', async () => {
    const loop = countIterations();
    const fetchedIn = new Map(); // iteration -> rows fetched in it, per reader
    const openedIn = []; // iteration in which each export opened its connection
    const plan = { sql: 'SELECT ...', params: {}, filtered: false, timeZone: 'Australia/Sydney', header: ['H'] };
    const exportsAtOnce = [0, 1, 2].map((index) => {
      const rows = Array.from({ length: 1_750 }, (_, i) => row(`n${i}`, undefined));
      const reader = fakeReader(rows, {
        onOpen: () => (openedIn[index] = loop.iteration),
        onFetch() {
          const counts = fetchedIn.get(loop.iteration) ?? fetchedIn.set(loop.iteration, [0, 0, 0]).get(loop.iteration);
          counts[index] += 1;
        },
      });
      return (async () => {
        let lines = 0;
        for await (const chunk of streamCsvExport(reader.open, plan)) lines += chunk.split('\n').length - 1;
        return lines;
      })();
    });
    assert.deepEqual(await Promise.all(exportsAtOnce), [1_751, 1_751, 1_751], 'header + every row, for each export');
    loop.stop();

    // Opening a connection is synchronous work like any other: it happens in the export's first
    // step, never for several exports back to back.
    assert.equal(new Set(openedIn).size, 3, `every export opened its connection in an iteration of its own (${openedIn})`);
    assert.deepEqual(openedIn, [...fetchedIn.keys()].slice(0, 3), 'the one in which it took its first step');

    const steps = [...fetchedIn.values()];
    assert.equal(EXPORT_BATCH_ROWS, 500);
    assert.equal(steps.length, 12, 'three exports of four steps each, every step in an iteration of its own');
    for (const counts of steps) {
      assert.equal(counts.filter((n) => n > 0).length, 1, `only one export reads in any one iteration (${counts})`);
      assert.ok(Math.max(...counts) <= 500, `no step looks at more than 500 rows (${counts})`);
    }
    assert.deepEqual(steps.map((counts) => Math.max(...counts)).sort((a, b) => a - b), [250, 250, 250, ...Array(9).fill(500)]);
    assert.deepEqual(
      steps.slice(0, 6).map((counts) => counts.findIndex((n) => n > 0)),
      [0, 1, 2, 0, 1, 2],
      'the exports take turns',
    );
  });

  it('an abandoned export stops before its next step instead of reading to the end', async () => {
    const nothingMatches = Array.from({ length: 100_000 }).fill(row('n', 0));
    const reader = fakeReader(nothingMatches);
    const plan = { sql: 'SELECT ...', params: {}, filtered: true, timeZone: 'Australia/Sydney', header: ['H'] };
    const abandoned = new AbortController();
    const stream = streamCsvExport(reader.open, plan, { batchRows: 100, signal: abandoned.signal });

    assert.deepEqual(await stream.next(), { done: false, value: 'H\n' }, 'the header, after a first step without a match');
    const rest = stream.next(); // no row matches: without the signal this would read all 100,000 rows
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.ok(reader.fetched >= 200 && reader.fetched <= 1_000, `the scan is under way (${reader.fetched} rows)`);

    abandoned.abort();
    assert.deepEqual(await rest, { done: true, value: undefined }, 'it ends quietly');
    assert.ok(reader.fetched <= 1_100, `and stopped within a step (${reader.fetched} rows)`);
    assert.deepEqual(reader.statements, ['BEGIN', 'ROLLBACK'], 'the snapshot is released');
    assert.equal(reader.iteratorReturned, true);
    assert.deepEqual([reader.opened, reader.closed], [1, 1], 'and the connection closed');

    // A signal that has already fired: no connection is even opened.
    const neverStarted = fakeReader(nothingMatches);
    const stillborn = streamCsvExport(neverStarted.open, plan, { signal: abandoned.signal });
    assert.deepEqual(await stillborn.next(), { done: true, value: undefined });
    assert.deepEqual([neverStarted.opened, neverStarted.fetched], [0, 0]);
  });
});

/** Counts event-loop iterations: an immediate that re-arms itself runs exactly once per iteration. */
function countIterations() {
  const loop = { iteration: 0, running: true, stop: () => (loop.running = false) };
  (function tick() {
    loop.iteration += 1;
    if (loop.running) setImmediate(tick);
  })();
  return loop;
}

describe('turn queue (steps of long jobs)', () => {
  it('lets exactly one step through per event-loop iteration, first come first served', async () => {
    const turns = createTurnQueue();
    const loop = countIterations();
    const steps = [];
    const job = async (name) => {
      for (let step = 0; step < 3; step += 1) {
        await turns.next();
        steps.push({ name, iteration: loop.iteration });
      }
    };
    const jobs = [job('a'), job('b'), job('c')];
    assert.equal(turns.waiting, 3);
    await Promise.all(jobs);
    loop.stop();

    assert.equal(steps.map((step) => step.name).join(''), 'abcabcabc', 'round robin, in arrival order');
    const iterations = steps.map((step) => step.iteration);
    assert.equal(new Set(iterations).size, 9, `every step ran in an iteration of its own (${iterations})`);
    assert.equal(turns.waiting, 0);
  });

  it('other work gets its chance between any two steps', async () => {
    const turns = createTurnQueue();
    const events = [];
    const jobs = ['a', 'b'].map(async (name) => {
      for (let step = 0; step < 2; step += 1) {
        await turns.next();
        events.push(name);
        // Stands for anything else that became ready while the step ran (a request, a timer).
        setTimeout(() => events.push('other'), 0);
        const busyUntil = performance.now() + 3;
        while (performance.now() < busyUntil); // the step itself: synchronous work
      }
    });
    await Promise.all(jobs);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(events.join(' '), 'a other b other a other b other');
  });
});

describe('sending a download to a client that may stop reading', () => {
  const BIG = 'x'.repeat(100_000); // larger than any stream buffer: the source feels the destination's pace

  /** A destination that needs `delayMs` per chunk and takes nothing more after `stallAfter` chunks. */
  function destination({ delayMs = 0, stallAfter = Infinity } = {}) {
    const taken = [];
    let writes = 0;
    const writable = new Writable({
      highWaterMark: 1,
      write(chunk, _encoding, callback) {
        writes += 1;
        if (writes > stallAfter) return; // never calls back: this client has stopped reading
        setTimeout(() => {
          taken.push(chunk.length);
          callback();
        }, delayMs);
      },
    });
    writable.taken = taken;
    return writable;
  }

  /** A source of `count` chunks that records whether it was closed properly. */
  function source(count, { chunk = BIG, delayMs = 0, failAt = Infinity } = {}) {
    const state = { produced: 0, closed: false };
    state.chunks = (async function* produce() {
      try {
        for (let i = 0; i < count; i += 1) {
          if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
          if (i === failAt) throw new Error('source failed');
          state.produced += 1;
          yield chunk;
        }
      } finally {
        state.closed = true;
      }
    })();
    return state;
  }

  /** Timers of this process that are still due (the idle timer is one while it is armed). */
  const pendingTimers = () => process.getActiveResourcesInfo().filter((kind) => kind === 'Timeout').length;

  it('hands everything over, at the pace of the destination', async () => {
    const timersBefore = pendingTimers();
    const from = source(5);
    const to = destination({ delayMs: 5 });
    assert.deepEqual(await sendChunks(from.chunks, to, { idleTimeoutMs: 60_000 }), { completed: true });
    assert.deepEqual(to.taken, Array(5).fill(BIG.length));
    assert.equal(to.writableFinished, true, 'and ends the destination');
    assert.equal(from.closed, true);
    assert.equal(pendingTimers(), timersBefore, 'no idle timer is left running once the transfer is over');
  });

  it('gives up on a destination that takes nothing more for the idle timeout', async () => {
    const from = source(50);
    const to = destination({ stallAfter: 2 });
    const started = performance.now();
    const outcome = await sendChunks(from.chunks, to, { idleTimeoutMs: 150 });
    const elapsed = performance.now() - started;
    assert.equal(outcome.completed, false);
    assert.equal(outcome.stalled, true);
    assert.ok(elapsed >= 140 && elapsed < 2_000, `after the timeout, not before (${elapsed.toFixed(0)} ms)`);
    assert.equal(to.destroyed, true, 'the destination is dropped');
    assert.equal(to.taken.length, 2);
    assert.ok(from.produced < 10, `the source was not read ahead (${from.produced} chunks)`);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(from.closed, true, 'and the source is closed');
  });

  it('leaves a slow destination alone as long as it keeps taking data', async () => {
    const from = source(15);
    const to = destination({ delayMs: 40 }); // 15 chunks x 40 ms: far longer in total than the timeout
    const started = performance.now();
    const outcome = await sendChunks(from.chunks, to, { idleTimeoutMs: 400 });
    assert.deepEqual(outcome, { completed: true });
    assert.equal(to.taken.length, 15);
    assert.ok(performance.now() - started >= 500, 'the transfer took longer than the idle timeout');
  });

  it('does not count the time the source needs', async () => {
    const from = source(4, { delayMs: 120 }); // each chunk takes longer to produce than the timeout
    const to = destination();
    assert.deepEqual(await sendChunks(from.chunks, to, { idleTimeoutMs: 60 }), { completed: true });
    assert.equal(to.taken.length, 4);
  });

  it('applies the timeout to the buffered tail as well, after the source has finished', async () => {
    const from = source(3, { chunk: 'tail' }); // small chunks: all three are buffered at once
    const to = destination({ stallAfter: 2 });
    const sending = sendChunks(from.chunks, to, { idleTimeoutMs: 150 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(from.closed, true, 'the source is done; only the destination is behind');
    assert.equal(await stillPending(sending, 3_000), false, 'the transfer does not hang on the last chunk');
    const outcome = await sending;
    assert.equal(outcome.completed, false);
    assert.equal(outcome.stalled, true);
    assert.equal(to.destroyed, true);
  });

  it('waits as long as it takes when the timeout is 0, until the signal ends the transfer', async () => {
    const from = source(50);
    const to = destination({ stallAfter: 1 });
    const gone = new AbortController();
    const sending = sendChunks(from.chunks, to, { idleTimeoutMs: 0, signal: gone.signal });
    assert.equal(await stillPending(sending, 300), true, 'no timeout: still waiting for the destination');
    gone.abort();
    const outcome = await sending;
    assert.equal(outcome.completed, false);
    assert.equal(outcome.stalled, false);
    assert.equal(outcome.error.code, 'ERR_STREAM_PREMATURE_CLOSE');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(from.closed, true);

    // A signal that has already fired ends the transfer before it starts.
    const late = source(3);
    const outcomeLate = await sendChunks(late.chunks, destination(), { signal: gone.signal });
    assert.equal(outcomeLate.completed, false);
  });

  it('reports a failing source as an error, not as a stalled client', async () => {
    const from = source(5, { failAt: 2 });
    const to = destination();
    const outcome = await sendChunks(from.chunks, to, { idleTimeoutMs: 1_000 });
    assert.equal(outcome.completed, false);
    assert.equal(outcome.stalled, false);
    assert.equal(outcome.error.message, 'source failed');
    assert.equal(to.destroyed, true, 'the destination is not left open with half a file');
  });
});
