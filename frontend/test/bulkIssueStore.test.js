import { describe, expect, it, vi } from 'vitest';

import { ApiError, writeOutcome } from '../src/api.js';
import { createBulkIssueStore } from '../src/bulkIssueStore.js';
import { ALICE, BOB, deferred } from './support/fakeServer.js';

const attempt = { courseId: 1, courseTitle: 'Safety 101', key: 'key-1' };
const operation = { id: 1, summary: { total: 5, issued: 2, skipped: 3, failed: 0 } };

/** An api whose bulkIssue stays pending until the test settles it. */
function pendingApi(actor = ALICE) {
  const calls = [];
  return {
    actor,
    calls,
    bulkIssue: vi.fn((courseId, key) => {
      const call = deferred();
      calls.push({ courseId, key, ...call });
      return call.promise;
    }),
  };
}

describe('bulkIssueStore (item A)', () => {
  it('starts idle for every actor', () => {
    const store = createBulkIssueStore();
    expect(store.read(ALICE)).toEqual({ run: { status: 'idle' }, settled: 0 });
    expect(store.read(ALICE)).toBe(store.read(ALICE)); // a stable snapshot for useSyncExternalStore
  });

  it('item A: locks synchronously - a second submit while one is in flight sends nothing', async () => {
    const store = createBulkIssueStore();
    const api = pendingApi();

    store.submit(api, attempt);
    store.submit(api, attempt); // double click
    store.submit(api, { ...attempt, key: 'key-2' }); // or a click on a page that was mounted again
    expect(api.bulkIssue).toHaveBeenCalledTimes(1);
    expect(api.bulkIssue).toHaveBeenCalledWith(1, 'key-1');
    expect(store.read(ALICE)).toEqual({ run: { status: 'submitting', attempt }, settled: 0 });

    api.calls[0].resolve({ operation, replayed: false });
    await vi.waitFor(() => expect(store.read(ALICE).run.status).toBe('succeeded'));
    expect(store.read(ALICE)).toEqual({ run: { status: 'succeeded', attempt, operation, replayed: false }, settled: 1 });
  });

  it('keeps the attempt of a failed run, so a retry sends the same course and key', async () => {
    const store = createBulkIssueStore();
    const api = pendingApi();
    const lost = new Error('no answer');

    store.submit(api, attempt);
    api.calls[0].reject(lost);
    await vi.waitFor(() => expect(store.read(ALICE).run.status).toBe('failed'));
    expect(store.read(ALICE)).toEqual({ run: { status: 'failed', attempt, error: lost }, settled: 1 });

    store.submit(api, store.read(ALICE).run.attempt);
    expect(api.bulkIssue).toHaveBeenLastCalledWith(1, 'key-1');
    api.calls[1].resolve({ operation, replayed: true });
    await vi.waitFor(() => expect(store.read(ALICE).run.status).toBe('succeeded'));
    expect(store.read(ALICE)).toMatchObject({ run: { replayed: true }, settled: 2 });
  });

  it('item A: keeps one entry per actor - an operation of one tenant is never read by another', async () => {
    const store = createBulkIssueStore();
    const alice = pendingApi(ALICE);
    const bob = pendingApi(BOB);

    store.submit(alice, attempt);
    expect(store.read(BOB)).toEqual({ run: { status: 'idle' }, settled: 0 });

    store.submit(bob, { courseId: 4, courseTitle: 'Safety 101', key: 'key-bob' }); // Bob is not blocked by Alice
    expect(bob.bulkIssue).toHaveBeenCalledWith(4, 'key-bob');
    // ... and his submission leaves her pending attempt alone: still locked, same key
    expect(store.read(ALICE)).toEqual({ run: { status: 'submitting', attempt }, settled: 0 });
    store.submit(alice, { ...attempt, key: 'key-2' });
    expect(alice.bulkIssue).toHaveBeenCalledTimes(1);

    alice.calls[0].resolve({ operation, replayed: false });
    await vi.waitFor(() => expect(store.read(ALICE).run.status).toBe('succeeded'));
    expect(store.read(BOB).run.status).toBe('submitting');
    expect(store.read(BOB).settled).toBe(0);
  });

  it('dismisses a finished run but never a request in flight', async () => {
    const store = createBulkIssueStore();
    const api = pendingApi();

    store.submit(api, attempt);
    store.dismiss(ALICE);
    expect(store.read(ALICE).run.status).toBe('submitting');

    api.calls[0].resolve({ operation, replayed: false });
    await vi.waitFor(() => expect(store.read(ALICE).run.status).toBe('succeeded'));
    store.dismiss(ALICE);
    expect(store.read(ALICE)).toEqual({ run: { status: 'idle' }, settled: 1 }); // `settled` only ever grows
  });

  it('notifies subscribers of every change until they unsubscribe', async () => {
    const store = createBulkIssueStore();
    const api = pendingApi();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    store.submit(api, attempt);
    expect(listener).toHaveBeenCalledTimes(1);
    api.calls[0].resolve({ operation, replayed: false });
    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(2));
    store.dismiss(ALICE);
    expect(listener).toHaveBeenCalledTimes(3);
    store.dismiss(ALICE); // nothing to dismiss: no change, no notification
    expect(listener).toHaveBeenCalledTimes(3);

    unsubscribe();
    store.submit(api, attempt);
    expect(listener).toHaveBeenCalledTimes(3);
  });
});

/**
 * A full page load ends the store's life while a request may still be on its way. What the next
 * page needs to carry on safely - the course and above all the key - is kept in the tab's storage.
 */
describe('bulkIssueStore: attempts without a known outcome survive a page load', () => {
  /** Stands in for window.sessionStorage: it outlives the store, like the tab outlives the page. */
  function tabStorage(initial = {}) {
    const items = new Map(Object.entries(initial));
    return {
      items,
      getItem: (name) => (items.has(name) ? items.get(name) : null),
      setItem: (name, value) => items.set(name, String(value)),
      removeItem: (name) => items.delete(name),
    };
  }

  it('brings a request that was in flight back as an unknown outcome with the same course and key', () => {
    const storage = tabStorage();
    createBulkIssueStore(storage).submit(pendingApi(), attempt); // never answered: the page is reloaded first

    const afterReload = createBulkIssueStore(storage);
    const { run, settled } = afterReload.read(ALICE);
    expect(run.status).toBe('failed');
    expect(run.attempt).toEqual(attempt);
    expect(run.error).toBeInstanceOf(ApiError);
    expect(run.error.message).toBe('The page was reloaded or left before the answer from the server arrived.');
    expect(writeOutcome(run.error)).toBe('unknown'); // "may or may not have gone through", with "Retry safely"
    expect(settled).toBe(0);
    expect(afterReload.read(BOB)).toEqual({ run: { status: 'idle' }, settled: 0 });

    // the retry from the new page re-sends the same key
    const api = pendingApi();
    afterReload.submit(api, run.attempt);
    expect(api.bulkIssue).toHaveBeenCalledWith(1, 'key-1');
  });

  it.each([
    ['a lost answer', new ApiError(0, 'network_error', 'The server could not be reached.'), 'unknown'],
    ['an HTTP 500', new ApiError(500, 'internal_error', 'Unexpected server error'), 'unknown'],
    ['a busy database', new ApiError(503, 'database_busy', 'The database is busy; retry the request shortly'), 'not_run'],
    ['an unexpected exception', new TypeError('x is undefined'), 'unknown'],
  ])('brings the retry prompt after %s back as it was', async (_case, error, outcome) => {
    const storage = tabStorage();
    const before = createBulkIssueStore(storage);
    const api = pendingApi();
    before.submit(api, attempt);
    api.calls[0].reject(error);
    await vi.waitFor(() => expect(before.read(ALICE).run.status).toBe('failed'));

    const { run } = createBulkIssueStore(storage).read(ALICE);
    expect(run).toMatchObject({ status: 'failed', attempt });
    expect(run.error.message).toBe(error.message);
    expect(writeOutcome(run.error)).toBe(outcome);
  });

  it('keeps nothing once the outcome is known: a result, a rejection, a dismissed prompt', async () => {
    const storage = tabStorage();
    const store = createBulkIssueStore(storage);
    const api = pendingApi();

    store.submit(api, attempt);
    expect(storage.items.size).toBe(1); // on its way: kept
    api.calls[0].resolve({ operation, replayed: false });
    await vi.waitFor(() => expect(store.read(ALICE).run.status).toBe('succeeded'));
    expect(storage.items.size).toBe(0);
    expect(createBulkIssueStore(storage).read(ALICE).run.status).toBe('idle');

    store.dismiss(ALICE);
    store.submit(api, attempt);
    api.calls[1].reject(new ApiError(409, 'idempotency_key_reused', 'reused'));
    await vi.waitFor(() => expect(store.read(ALICE).run.status).toBe('failed'));
    expect(storage.items.size).toBe(0); // rejected: nothing was written, the next attempt is a new operation

    store.dismiss(ALICE);
    store.submit(api, attempt);
    api.calls[2].reject(new ApiError(0, 'network_error', 'offline'));
    await vi.waitFor(() => expect(store.read(ALICE).run.status).toBe('failed'));
    expect(storage.items.size).toBe(1); // waits for the retry: kept
    store.dismiss(ALICE); // the admin gives the attempt up
    expect(storage.items.size).toBe(0);
    expect(createBulkIssueStore(storage).read(ALICE).run.status).toBe('idle');
  });

  it('keeps the attempts of two actors apart, also across the page load', async () => {
    const storage = tabStorage();
    const before = createBulkIssueStore(storage);
    const alice = pendingApi(ALICE);
    const bob = pendingApi(BOB);
    const bobsAttempt = { courseId: 4, courseTitle: 'Safety 101', key: 'key-bob' };
    before.submit(alice, attempt);
    before.submit(bob, bobsAttempt);
    bob.calls[0].resolve({ operation, replayed: false }); // Bob's is answered before the reload
    await vi.waitFor(() => expect(before.read(BOB).run.status).toBe('succeeded'));

    const afterReload = createBulkIssueStore(storage);
    expect(afterReload.read(ALICE).run).toMatchObject({ status: 'failed', attempt });
    expect(afterReload.read(BOB).run.status).toBe('idle');
  });

  it.each([
    ['text that is not JSON', '{"alice@east.test":'],
    ['JSON of another shape', '[1,2,3]'],
    ['null', 'null'],
    ['a record without a key', JSON.stringify({ [ALICE]: { attempt: { courseId: 1, courseTitle: 'Safety 101' } } })],
    ['a record that is not an object', JSON.stringify({ [ALICE]: 'pending' })],
  ])('starts empty when the storage holds %s', (_case, content) => {
    const storage = tabStorage({ 'cert-admin.bulk-issue.unsettled': content });
    const store = createBulkIssueStore(storage);
    expect(store.read(ALICE)).toEqual({ run: { status: 'idle' }, settled: 0 });

    const api = pendingApi(); // and it works normally from there
    store.submit(api, attempt);
    expect(api.bulkIssue).toHaveBeenCalledTimes(1);
    expect(JSON.parse(storage.items.get('cert-admin.bulk-issue.unsettled'))).toEqual({ [ALICE]: { attempt } });
  });

  it('works without a storage, and with one that refuses every access', async () => {
    const refusing = {
      getItem: () => {
        throw new DOMException('denied', 'SecurityError');
      },
      setItem: () => {
        throw new DOMException('full', 'QuotaExceededError');
      },
      removeItem: () => {
        throw new DOMException('denied', 'SecurityError');
      },
    };
    for (const storage of [null, refusing]) {
      const store = createBulkIssueStore(storage);
      const api = pendingApi();
      store.submit(api, attempt);
      store.submit(api, attempt);
      expect(api.bulkIssue).toHaveBeenCalledTimes(1);
      api.calls[0].resolve({ operation, replayed: false });
      await vi.waitFor(() => expect(store.read(ALICE).run.status).toBe('succeeded'));
      store.dismiss(ALICE);
      expect(store.read(ALICE).run.status).toBe('idle');
    }
  });

  it('uses the sessionStorage of the tab unless told otherwise', () => {
    createBulkIssueStore().submit(pendingApi(), attempt);
    expect(JSON.parse(window.sessionStorage.getItem('cert-admin.bulk-issue.unsettled'))).toEqual({ [ALICE]: { attempt } });
    expect(window.localStorage.length).toBe(0); // per tab, and gone when the tab is closed
    expect(createBulkIssueStore().read(ALICE).run).toMatchObject({ status: 'failed', attempt });
  });
});
