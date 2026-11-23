import { useSyncExternalStore } from 'react';

import { ApiError, writeOutcome } from './api.js';

/**
 * Bulk-issue attempts, kept above the routed pages.
 *
 * The Bulk issue page is unmounted whenever the admin opens another tab or follows a serial link.
 * If the attempt lived in that page, coming back while the request is still on its way would show
 * an idle form and offer a fresh submission under a new idempotency key - a second operation for
 * one intention. So the attempt (course + key), its status and the in-flight lock live here
 * instead, one entry per actor e-mail:
 *
 * - a page that mounts again re-attaches to the attempt of its actor (lock, status, key);
 * - a request that finishes while nobody is looking still records its result or its failure;
 * - an actor only ever reads its own entry, so one tenant's operation is never shown while acting
 *   as another tenant, and it is still there when the admin switches back.
 *
 * App creates one store for its lifetime. A full page load (reload, or leaving the site and coming
 * back) ends that lifetime while a request may still be on its way, so every attempt whose outcome
 * is not known yet is also written to the tab's sessionStorage and picked up again by the next
 * store - see `restore` below.
 */

const IDLE = Object.freeze({ status: 'idle' });
const NOTHING_YET = Object.freeze({ run: IDLE, settled: 0 });

const STORAGE_KEY = 'cert-admin.bulk-issue.unsettled';

/** The storage of this browser tab, or null where the browser refuses access to it. */
function tabStorage() {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

const isAttempt = (attempt) =>
  typeof attempt === 'object' &&
  attempt !== null &&
  (Number.isInteger(attempt.courseId) || typeof attempt.courseId === 'string') &&
  typeof attempt.courseTitle === 'string' &&
  typeof attempt.key === 'string' &&
  attempt.key !== '';

/**
 * The attempts a previous page left without a known outcome, as store entries.
 *
 * Each one comes back as a failed run with an unknown (or "has not run yet") outcome, i.e. as the
 * prompt to retry safely: the page that sent the request is gone and nobody will ever see its
 * answer, but the key is still known, and repeating the request with that key is how to find out
 * what happened without issuing twice.
 */
function restore(storage) {
  const entries = new Map();
  let saved;
  try {
    saved = JSON.parse(storage?.getItem(STORAGE_KEY) ?? 'null');
  } catch {
    return entries; // unreadable or not ours: start empty rather than fail to start at all
  }
  if (typeof saved !== 'object' || saved === null) return entries;
  for (const [email, record] of Object.entries(saved)) {
    if (!isAttempt(record?.attempt)) continue;
    const { courseId, courseTitle, key } = record.attempt;
    const failure = record.failure;
    const error =
      typeof failure === 'object' && failure !== null
        ? new ApiError(Number(failure.status) || 0, String(failure.code), String(failure.message))
        : new ApiError(0, 'interrupted', 'The page was reloaded or left before the answer from the server arrived.');
    entries.set(email, { run: { status: 'failed', attempt: { courseId, courseTitle, key }, error }, settled: 0 });
  }
  return entries;
}

export function createBulkIssueStore(storage = tabStorage()) {
  // actor e-mail -> { run, settled }
  //   run:     { status: 'idle' }
  //          | { status: 'submitting', attempt }
  //          | { status: 'succeeded', attempt, operation, replayed }
  //          | { status: 'failed', attempt, error }      with attempt = { courseId, courseTitle, key }
  //   settled: number of requests of this actor that have finished; pages refetch what a bulk
  //            issue changes (roster, history) whenever it moves.
  const entries = restore(storage);
  const listeners = new Set();

  const read = (email) => entries.get(email) ?? NOTHING_YET;

  function write(email, entry) {
    entries.set(email, entry);
    save();
    for (const listener of listeners) listener();
  }

  /**
   * Mirrors into the tab's storage what must outlive this page: the attempts that are on their way
   * or wait for a retry, with their keys. A result, a rejection (4xx: nothing was written and the
   * next attempt is a new operation) and a dismissed run are settled and are not kept.
   */
  function save() {
    const unsettled = {};
    for (const [email, { run }] of entries) {
      if (run.status === 'submitting') {
        unsettled[email] = { attempt: run.attempt };
      } else if (run.status === 'failed' && writeOutcome(run.error) !== 'rejected') {
        const { status = 0, code = 'unexpected_error', message = '' } = run.error ?? {};
        unsettled[email] = { attempt: run.attempt, failure: { status, code, message: message || 'Unexpected error' } };
      }
    }
    try {
      if (Object.keys(unsettled).length > 0) storage?.setItem(STORAGE_KEY, JSON.stringify(unsettled));
      else storage?.removeItem(STORAGE_KEY);
    } catch {
      // storage full or blocked: the attempt then lives as long as this page, as it did before
    }
  }

  return {
    read,

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /**
     * Sends `attempt` on behalf of the actor of `api`, unless that actor already has a request on
     * its way. Checking and locking happen synchronously, before anything is rendered: a double
     * click (or Enter + click) cannot start two requests, on whichever page instance it lands.
     * Should a duplicate reach the server after all (e.g. a retry after a timeout), the
     * idempotency key makes it harmless. Passing the attempt of a failed run again is the safe
     * retry: same course, same key.
     */
    async submit(api, attempt) {
      const email = api.actor;
      const { run, settled } = read(email);
      if (run.status === 'submitting') return;
      write(email, { run: { status: 'submitting', attempt }, settled });

      let next;
      try {
        const { operation, replayed } = await api.bulkIssue(attempt.courseId, attempt.key);
        next = { status: 'succeeded', attempt, operation, replayed };
      } catch (error) {
        next = { status: 'failed', attempt, error };
      }
      // Nothing else can have touched the entry meanwhile: submit and dismiss both back off while
      // a request is in flight.
      write(email, { run: next, settled: settled + 1 });
    },

    /** Forgets a finished run (result or failure). A request in flight cannot be dismissed. */
    dismiss(email) {
      const { run, settled } = read(email);
      if (run.status === 'submitting' || run.status === 'idle') return;
      write(email, { run: IDLE, settled });
    },
  };
}

/** The bulk-issue state of one actor: `{ run, settled }`, re-rendering the caller when it changes. */
export function useBulkIssue(store, email) {
  return useSyncExternalStore(store.subscribe, () => store.read(email));
}
