import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { captureDownloads, loadedRows, openConsole } from './support/app.jsx';
import { ALICE, BOB, deferred, internalError, networkError, recorded, startFakeServer } from './support/fakeServer.js';

const exportRequests = (server) => server.sent('GET', '/api/certificates/export.csv');
const lastListQuery = (server) => server.sent('GET', '/api/certificates').at(-1).query;
const eastFile = /filename="([^"]+)"/.exec(recorded.tenants[ALICE].exportCsv.contentDisposition)[1];
const eastBytes = new TextEncoder().encode(recorded.tenants[ALICE].exportCsv.body).length;

describe('CSV export', () => {
  it('downloads the file for the default view and reports it', async () => {
    const saved = captureDownloads();
    const { server, user } = openConsole();
    await loadedRows();

    await user.click(screen.getByTestId('export-button'));
    const done = await screen.findByTestId('export-done');
    expect(done.textContent).toBe(`Export saved as ${eastFile} (${eastBytes} B). Dismiss`);

    expect(exportRequests(server)).toHaveLength(1);
    expect(exportRequests(server)[0].actor).toBe(ALICE);
    expect(exportRequests(server)[0].query).toEqual({ status: 'all', sort: 'issued', order: 'desc' });
    expect(saved).toHaveLength(1);
    expect(saved[0].fileName).toBe(eastFile); // the name the server chose (Content-Disposition)
    expect(await saved[0].blob.text()).toBe(recorded.tenants[ALICE].exportCsv.body);

    await user.click(within(done).getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByTestId('export-done')).toBeNull();
  });

  it('carries exactly the active search, status filter, sort column and order', async () => {
    const saved = captureDownloads();
    const { server, user } = openConsole();
    await loadedRows();

    await user.type(screen.getByTestId('search-input'), 'lee{Enter}');
    await user.selectOptions(screen.getByTestId('status-filter'), 'active');
    await user.click(screen.getByRole('button', { name: 'Learner' }));
    await user.click(screen.getByRole('button', { name: 'Learner' })); // second click: descending
    await loadedRows();

    await user.click(screen.getByTestId('export-button'));
    await screen.findByTestId('export-done');

    const exported = exportRequests(server)[0].query;
    expect(exported).toEqual({ q: 'lee', status: 'active', sort: 'learner', order: 'desc' });
    // the same filter and order as the rows on screen, minus the paging
    const { page, pageSize, ...shown } = lastListQuery(server);
    expect(exported).toEqual(shown);
    expect(saved).toHaveLength(1);
  });

  it('exports the sort order chosen in the "Sort by" menu', async () => {
    captureDownloads();
    const { server, user } = openConsole();
    await loadedRows();
    await user.selectOptions(screen.getByTestId('sort-select'), 'issued:asc');
    await loadedRows();

    await user.click(screen.getByTestId('export-button'));
    await screen.findByTestId('export-done');
    expect(exportRequests(server)[0].query).toEqual({ status: 'all', sort: 'issued', order: 'asc' });
  });

  it('uses the text in the search box even when Export is clicked before the search debounce has fired', async () => {
    const saved = captureDownloads();
    const { server } = openConsole();
    await loadedRows();
    const listRequestsBefore = server.sent('GET', '/api/certificates').length;

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fireEvent.change(screen.getByTestId('search-input'), { target: { value: ' walker ' } });
    fireEvent.click(screen.getByTestId('export-button')); // no time has passed: the list has not searched yet

    expect(exportRequests(server)).toHaveLength(1);
    expect(exportRequests(server)[0].query).toEqual({ q: 'walker', status: 'all', sort: 'issued', order: 'desc' });
    // ... and the table switches to the exported search at once, so file and screen agree
    expect(server.sent('GET', '/api/certificates')).toHaveLength(listRequestsBefore + 1);
    expect(lastListQuery(server).q).toBe('walker');

    act(() => vi.advanceTimersByTime(1000)); // the debounce firing later changes nothing
    expect(server.sent('GET', '/api/certificates')).toHaveLength(listRequestsBefore + 1);
    vi.useRealTimers();

    await screen.findByTestId('export-done');
    expect(await loadedRows()).toEqual([['EAST-0000007', 'Tom Walker', 'Forklift Operations', '2026-10-04 03:30', 'Active']]);
    expect(saved).toHaveLength(1);
  });

  it('shows that an export is running and locks the button meanwhile', async () => {
    const saved = captureDownloads();
    const server = startFakeServer();
    const gate = deferred();
    server.once('GET', '/api/certificates/export.csv', async (_request, respond) => {
      await gate.promise;
      return respond();
    });
    const { user } = openConsole({ server });
    await loadedRows();

    const button = screen.getByTestId('export-button');
    await user.click(button);
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe('Exporting…');
    expect(screen.getByText(/^Preparing the export for the current search and sort order\./).textContent).toContain(
      'Leaving this page cancels the export.',
    );
    expect(saved).toEqual([]);

    gate.resolve();
    await screen.findByTestId('export-done');
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe('Export CSV');
    expect(saved).toHaveLength(1);
  });

  it('sends one request for a double click', async () => {
    const saved = captureDownloads();
    const server = startFakeServer();
    const gate = deferred();
    server.on('GET', '/api/certificates/export.csv', async (_request, respond) => {
      await gate.promise; // the second click lands while the first export is still running
      return respond();
    });
    const { user } = openConsole({ server });
    await loadedRows();

    await user.dblClick(screen.getByTestId('export-button'));
    fireEvent.click(screen.getByTestId('export-button')); // and one more for good measure
    gate.resolve();
    await screen.findByTestId('export-done');
    expect(exportRequests(server)).toHaveLength(1);
    expect(saved).toHaveLength(1);
  });

  it('reports a failed export and retries it with the same filters', async () => {
    const saved = captureDownloads();
    const { server, user } = openConsole();
    await loadedRows();
    await user.selectOptions(screen.getByTestId('status-filter'), 'revoked');
    await loadedRows();

    server.once('GET', '/api/certificates/export.csv', () => internalError());
    await user.click(screen.getByTestId('export-button'));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Export failed: Unexpected server error Try again');
    expect(saved).toEqual([]);
    expect(screen.getByTestId('export-button').disabled).toBe(false);
    expect(await loadedRows()).toHaveLength(1); // the list is not affected by the failed export

    server.once('GET', '/api/certificates/export.csv', () => {
      throw networkError();
    });
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Export failed: The server could not be reached.'));
    expect(saved).toEqual([]);

    await user.click(within(screen.getByRole('alert')).getByRole('button', { name: 'Try again' }));
    await screen.findByTestId('export-done');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(saved).toHaveLength(1);
    expect(exportRequests(server).map((request) => request.query)).toEqual(Array(3).fill({ status: 'revoked', sort: 'issued', order: 'desc' }));
  });

  it('reports a download that breaks off half-way as failed and saves nothing', async () => {
    const saved = captureDownloads();
    const server = startFakeServer();
    const { user } = openConsole({ server });
    await loadedRows();

    // status 200 and headers arrive, then the connection drops
    server.once('GET', '/api/certificates/export.csv', () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': recorded.tenants[ALICE].exportCsv.contentDisposition }),
      blob: async () => {
        throw new TypeError('network error');
      },
    }));
    await user.click(screen.getByTestId('export-button'));
    expect((await screen.findByRole('alert')).textContent).toContain('Export failed: The answer from the server could not be read');
    expect(saved).toEqual([]);
  });

  it('does not save an answer that is not the export, and says so', async () => {
    const saved = captureDownloads();
    const server = startFakeServer();
    const { user } = openConsole({ server });
    await loadedRows();

    // What a gateway in front of the console might answer in place of the file.
    server.once('GET', '/api/certificates/export.csv', () => new Response('<!doctype html><title>Sign in</title>', { status: 200, headers: { 'Content-Type': 'text/html' } }));
    await user.click(screen.getByTestId('export-button'));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Export failed: The server sent an answer that is not a CSV export.');
    expect(saved).toEqual([]);
    expect(screen.queryByTestId('export-done')).toBeNull();

    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await screen.findByTestId('export-done');
    expect(saved).toHaveLength(1);
  });

  it('starts one export, however quickly the button is pressed again', async () => {
    const saved = captureDownloads();
    const server = startFakeServer();
    openConsole({ server });
    await loadedRows();

    // Five clicks in one go: no render happens between them, so nothing on screen could stop the
    // second one - the page has to remember by itself that an export is under way.
    const button = screen.getByTestId('export-button');
    act(() => {
      for (let i = 0; i < 5; i += 1) button.click();
    });
    await screen.findByTestId('export-done');
    expect(exportRequests(server)).toHaveLength(1);
    expect(saved).toHaveLength(1);

    // ...and is free for the next one afterwards.
    act(() => button.click());
    await waitFor(() => expect(exportRequests(server)).toHaveLength(2));
  });

  it("exports the other tenant's file after an actor switch", async () => {
    const saved = captureDownloads();
    const { server, user } = openConsole();
    await loadedRows();
    await user.selectOptions(screen.getByTestId('actor-select'), BOB);
    await loadedRows();

    await user.click(screen.getByTestId('export-button'));
    expect((await screen.findByTestId('export-done')).textContent).toContain('certificates-west-');
    expect(exportRequests(server).map((request) => request.actor)).toEqual([BOB]);
    expect(await saved[0].blob.text()).toBe(recorded.tenants[BOB].exportCsv.body);
  });
});
