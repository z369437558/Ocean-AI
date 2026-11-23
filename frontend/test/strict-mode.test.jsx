/**
 * main.jsx mounts the app in <StrictMode>, where React (in development) runs every effect twice:
 * mount, clean up, mount again. These tests repeat the stateful flows under StrictMode to make
 * sure nothing relies on an effect running once - one request per action, no state lost.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  bulkIssuePosts,
  captureDownloads,
  chooseCourse,
  idempotencyKeys,
  loadedRows,
  openBulkIssue,
  openConsole,
  openTab,
  operationStatus,
  settle,
} from './support/app.jsx';
import { ALICE, BOB, deferred, networkError, startFakeServer } from './support/fakeServer.js';

describe('Under StrictMode', () => {
  it('loads the list; the request of the discarded first mount is cancelled and never rendered', async () => {
    const { server } = openConsole({ strict: true });
    expect(await loadedRows()).toHaveLength(7);
    const requests = server.sent('GET', '/api/certificates');
    expect(requests.map((request) => request.aborted)).toEqual([true, false]); // really mounted twice
  });

  it('item A: one POST per bulk issue, and the pending attempt survives a tab round trip', async () => {
    const server = startFakeServer();
    const gate = deferred();
    server.on('POST', '/api/bulk-issues', async (_request, respond) => {
      await gate.promise;
      return respond();
    });
    const { user } = await openBulkIssue({ server, strict: true });
    await chooseCourse(user, 'Safety 101');
    await user.dblClick(screen.getByTestId('issue-button'));
    expect(bulkIssuePosts(server)).toHaveLength(1);

    await openTab(user, 'Certificates');
    await loadedRows();
    await openTab(user, 'Bulk issue');
    await screen.findByRole('heading', { name: 'Bulk issue certificates' });
    expect(operationStatus().getAttribute('data-state')).toBe('submitting');
    expect(screen.getByTestId('issue-button').disabled).toBe(true);
    await waitFor(() => expect(screen.getByTestId('course-select').value).toBe('1'));
    fireEvent.click(screen.getByTestId('issue-button'));

    gate.resolve();
    await screen.findByTestId('operation-result');
    await waitFor(() => expect(screen.getByTestId('issue-button').textContent).toBe('No eligible learners'));
    expect(bulkIssuePosts(server)).toHaveLength(1);
  });

  it('item A: an attempt interrupted by a page reload comes back once, with its key', async () => {
    const server = startFakeServer();
    server.once('POST', '/api/bulk-issues', () => new Promise(() => {})); // no answer before the reload
    const first = await openBulkIssue({ server, strict: true });
    await chooseCourse(first.user, 'Safety 101');
    await first.user.click(screen.getByTestId('issue-button'));
    first.unmount(); // the reload

    const { user } = await openBulkIssue({ server, strict: true });
    expect(operationStatus().textContent).toContain('The bulk issue for Safety 101 may or may not have gone through');
    await waitFor(() => expect(screen.getByTestId('course-select').value).toBe('1'));
    await user.dblClick(screen.getByTestId('retry-button'));
    await screen.findByTestId('operation-result');
    expect(idempotencyKeys(server)).toHaveLength(2); // the interrupted request and one retry
    expect(new Set(idempotencyKeys(server)).size).toBe(1);
    expect(window.sessionStorage.length).toBe(0); // settled: nothing left to bring back
  });

  it('item B: a lost answer is retried with the same key', async () => {
    const server = startFakeServer();
    server.once('POST', '/api/bulk-issues', (_request, respond) => {
      respond();
      throw networkError();
    });
    const { user } = await openBulkIssue({ server, strict: true });
    await chooseCourse(user, 'Safety 101');
    await user.click(screen.getByTestId('issue-button'));
    await user.click(await screen.findByTestId('retry-button'));
    await screen.findByTestId('operation-replayed');
    expect(idempotencyKeys(server)).toHaveLength(2);
    expect(new Set(idempotencyKeys(server)).size).toBe(1);
  });

  it('item E: one POST per confirmed revocation; an unknown outcome refreshes drawer and list', async () => {
    const server = startFakeServer();
    const gate = deferred();
    server.once('POST', '/api/certificates/4/revoke', async (_request, respond) => {
      await gate.promise;
      respond();
      throw networkError();
    });
    const { user } = openConsole({ server, strict: true, hash: '#/certificates/4' });
    await user.click(await screen.findByTestId('revoke-button'));
    const reload = deferred(); // keeps the outcome unknown until the test has looked at it
    server.on('GET', '/api/certificates/4', async (_request, respond) => {
      await reload.promise;
      return respond();
    });
    await user.dblClick(screen.getByTestId('revoke-confirm'));
    expect(server.sent('POST', '/api/certificates/4/revoke')).toHaveLength(1);
    gate.resolve();

    const dialog = screen.getByRole('dialog', { name: 'Revoke this certificate?' });
    expect((await within(dialog).findByRole('alert')).textContent).toContain('The certificate may or may not have been revoked.');
    expect(screen.getByTestId('detail-status').textContent).toBe('Checking the current status…');
    expect(screen.queryByTestId('revoke-button')).toBeNull();
    expect(server.sent('POST', '/api/certificates/4/revoke')).toHaveLength(1);

    reload.resolve();
    await waitFor(() => expect(screen.getByTestId('detail-status').textContent).toBe('Revoked'));
    await screen.findByRole('dialog', { name: 'Certificate revoked' }); // settled: nothing left to retry
    expect(screen.queryByTestId('revoke-confirm')).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('revoke-close'))); // moved by an effect
    await user.click(screen.getByTestId('revoke-close'));
    expect(screen.queryByTestId('revoke-dialog')).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('dialog', { name: 'Certificate details' })));
    await waitFor(() => expect(screen.getByTestId('certificate-list').textContent).toContain('EAST-0000004José ÁlvarezFirst Aid Refresher2026-04-05 02:30Revoked'));
    expect(server.sent('POST', '/api/certificates/4/revoke')).toHaveLength(1);
  });

  it('item E: a repeat while the outcome is unknown is one more POST, answered "already revoked"', async () => {
    const server = startFakeServer();
    server.once('POST', '/api/certificates/4/revoke', (_request, respond) => {
      respond();
      throw networkError();
    });
    const { user } = openConsole({ server, strict: true, hash: '#/certificates/4' });
    await user.click(await screen.findByTestId('revoke-button'));
    server.on('GET', '/api/certificates/4', () => new Promise(() => {})); // the reload gets no answer in this test
    await user.click(screen.getByTestId('revoke-confirm'));
    const dialog = screen.getByRole('dialog', { name: 'Revoke this certificate?' });
    expect((await within(dialog).findByRole('alert')).textContent).toContain('Trying again is safe');

    await user.dblClick(screen.getByTestId('revoke-confirm')); // "Try again"
    expect((await screen.findByTestId('revoke-result')).textContent).toBe('This certificate had already been revoked; nothing was changed.');
    expect(screen.getByTestId('detail-status').textContent).toBe('Revoked');
    expect(server.sent('POST', '/api/certificates/4/revoke')).toHaveLength(2);
  });

  it('item G: one export per click, saved once; an actor switch still cancels an export in flight', async () => {
    const saved = captureDownloads();
    const server = startFakeServer();
    const { user } = openConsole({ server, strict: true });
    await loadedRows();

    await user.click(screen.getByTestId('export-button'));
    await screen.findByTestId('export-done');
    expect(server.sent('GET', '/api/certificates/export.csv')).toHaveLength(1);
    expect(saved).toHaveLength(1);

    const gate = deferred();
    server.on('GET', '/api/certificates/export.csv', async (_request, respond) => {
      await gate.promise;
      return respond();
    });
    await user.click(screen.getByTestId('export-button'));
    await user.selectOptions(screen.getByTestId('actor-select'), BOB);
    await loadedRows();
    gate.resolve();
    await settle();
    expect(saved).toHaveLength(1); // nothing new
    expect(server.sent('GET', '/api/certificates/export.csv').map((request) => [request.actor, request.aborted])).toEqual([
      [ALICE, false],
      [ALICE, true],
    ]);
  });
});
