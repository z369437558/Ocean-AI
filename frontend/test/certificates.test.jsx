import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { loadedRows, openConsole, serials, settle, tableRows } from './support/app.jsx';
import { ALICE, BOB, deferred, internalError, networkError, recorded, startFakeServer } from './support/fakeServer.js';

const listRequests = (server) => server.sent('GET', '/api/certificates');
const lastListRequest = (server) => listRequests(server).at(-1);
const columnHeader = (name) => screen.getByRole('button', { name }).closest('th');
// The "Issued" header also names the time zone; matched by its first word, because DOM emulations
// disagree on the space in front of the zone when they compute the accessible name.
const ISSUED = /^Issued/;

describe('Certificate list', () => {
  it('shows a loading state, then the certificates of the acting tenant', async () => {
    const server = startFakeServer();
    const gate = deferred();
    server.once('GET', '/api/certificates', async (_request, respond) => {
      await gate.promise;
      return respond();
    });
    openConsole({ server });
    expect(screen.getByText('Loading console…')).toBeTruthy();

    const loading = await screen.findByTestId('list-loading');
    expect(loading.textContent).toBe('Loading certificates…');
    const list = screen.getByTestId('certificate-list');
    expect(list.getAttribute('data-state')).toBe('loading');
    expect(list.getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByRole('navigation', { name: 'Pagination' })).toBeNull();

    gate.resolve();
    const rows = await loadedRows();
    expect(screen.queryByTestId('list-loading')).toBeNull();
    expect(list.getAttribute('aria-busy')).toBe('false');
    // newest first, issue dates in the tenant's time zone
    expect(rows).toEqual([
      ['EAST-0000007', 'Tom Walker', 'Forklift Operations', '2026-10-04 03:30', 'Active'],
      ['EAST-0000006', "Marcus O'Connor", 'Forklift Operations', '2026-10-04 01:30', 'Active'],
      ['EAST-0000005', 'Priya Sharma', 'Forklift Operations', '2026-06-15 12:00', 'Active'],
      ['EAST-0000004', 'José Álvarez', 'First Aid Refresher', '2026-04-05 02:30', 'Active'],
      ['EAST-0000003', 'Sofia Rossi', 'First Aid Refresher', '2026-04-05 02:30', 'Active'],
      ['EAST-0000002', 'Mei Chen', 'First Aid Refresher', '2026-02-15 09:15', 'Revoked'],
      ['EAST-0000001', 'Alex Lee', 'Safety 101', '2026-01-11 00:30', 'Active'],
    ]);
    expect(screen.getByTestId('tenant-name').textContent).toBe('East');
    expect(screen.getByText('1–7 of 7 certificates')).toBeTruthy();
    expect(document.title).toBe('Certificates · East');

    expect(listRequests(server)).toHaveLength(1);
    expect(lastListRequest(server).actor).toBe(ALICE);
    expect(lastListRequest(server).query).toEqual({ status: 'all', sort: 'issued', order: 'desc', page: '1', pageSize: '25' });
  });

  it('shows the empty state of a tenant without certificates', async () => {
    const server = startFakeServer();
    server.tenant(ALICE).certificates = [];
    openConsole({ server });

    expect(await loadedRows()).toEqual([]);
    expect(screen.getByText('No certificates yet')).toBeTruthy();
    expect(screen.getByText('Certificates appear here once they have been issued for a course.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Go to bulk issue' }).getAttribute('href')).toBe('#/bulk-issue');
    expect(screen.getByText('No certificates')).toBeTruthy();
  });

  it('shows the empty state of a search without matches and can clear the filters', async () => {
    const { server, user } = openConsole();
    await loadedRows();

    await user.type(screen.getByTestId('search-input'), 'zzz{Enter}');
    expect(await loadedRows()).toEqual([]);
    expect(screen.getByText('No certificates match your search')).toBeTruthy();
    expect(screen.getByText('Nothing found for “zzz”. Search looks at learner names and serial numbers.')).toBeTruthy();

    await user.selectOptions(screen.getByTestId('status-filter'), 'revoked');
    await loadedRows();
    expect(screen.getByText('Nothing found for “zzz” with status revoked. Search looks at learner names and serial numbers.')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Clear search and filters' }));
    expect(await loadedRows()).toHaveLength(7);
    expect(screen.getByTestId('search-input').value).toBe('');
    expect(screen.getByTestId('status-filter').value).toBe('all');
    expect(lastListRequest(server).query).toEqual({ status: 'all', sort: 'issued', order: 'desc', page: '1', pageSize: '25' });
  });

  it('shows the error state for a failed request and loads again on "Try again"', async () => {
    const server = startFakeServer();
    server.once('GET', '/api/certificates', () => internalError());
    const { user } = openConsole({ server });

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Certificates could not be loaded');
    expect(alert.textContent).toContain('Unexpected server error');
    expect(alert.textContent).toContain('HTTP 500 · internal_error');
    expect(screen.getByTestId('certificate-list').getAttribute('data-state')).toBe('error');
    expect(screen.queryByRole('navigation', { name: 'Pagination' })).toBeNull();

    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await loadedRows()).toHaveLength(7);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(listRequests(server)).toHaveLength(2);
  });

  it('drops the rows on screen when a reload fails, and recovers', async () => {
    const { server, user } = openConsole();
    await loadedRows();

    server.once('GET', '/api/certificates', () => {
      throw networkError();
    });
    await user.selectOptions(screen.getByTestId('status-filter'), 'active');
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('The server could not be reached. Check that it is running, then try again.');
    expect(screen.queryByText('EAST-0000007')).toBeNull();

    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await loadedRows()).toHaveLength(6);
    expect(lastListRequest(server).query.status).toBe('active');
  });

  it('searches 300 ms after the last keystroke, with a single request', async () => {
    const { server } = openConsole();
    await loadedRows();
    const input = screen.getByTestId('search-input');

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fireEvent.change(input, { target: { value: 'pri' } });
    act(() => vi.advanceTimersByTime(200));
    fireEvent.change(input, { target: { value: 'priya ' } }); // every keystroke restarts the wait
    act(() => vi.advanceTimersByTime(299));
    expect(listRequests(server)).toHaveLength(1); // nothing but the initial load so far

    act(() => vi.advanceTimersByTime(1));
    expect(listRequests(server)).toHaveLength(2);
    expect(lastListRequest(server).query).toEqual({ q: 'priya', status: 'all', sort: 'issued', order: 'desc', page: '1', pageSize: '25' });
    vi.useRealTimers();

    expect(await loadedRows()).toEqual([['EAST-0000005', 'Priya Sharma', 'Forklift Operations', '2026-06-15 12:00', 'Active']]);
    expect(screen.getByText('1–1 of 1 certificates')).toBeTruthy();
  });

  it('searches at once on Enter and does not repeat the request when the debounce fires', async () => {
    const { server } = openConsole();
    await loadedRows();
    const input = screen.getByTestId('search-input');

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fireEvent.change(input, { target: { value: 'EAST-0000003' } });
    fireEvent.submit(input.closest('form'));
    expect(listRequests(server)).toHaveLength(2);
    expect(lastListRequest(server).query.q).toBe('EAST-0000003');

    act(() => vi.advanceTimersByTime(1000));
    expect(listRequests(server)).toHaveLength(2);
    vi.useRealTimers();

    expect(serials(await loadedRows())).toEqual(['EAST-0000003']); // found by serial number
  });

  it('filters by status', async () => {
    const { server, user } = openConsole();
    await loadedRows();

    await user.selectOptions(screen.getByTestId('status-filter'), 'revoked');
    expect(await loadedRows()).toEqual([['EAST-0000002', 'Mei Chen', 'First Aid Refresher', '2026-02-15 09:15', 'Revoked']]);
    expect(lastListRequest(server).query).toEqual({ status: 'revoked', sort: 'issued', order: 'desc', page: '1', pageSize: '25' });

    await user.selectOptions(screen.getByTestId('status-filter'), 'active');
    expect(serials(await loadedRows())).not.toContain('EAST-0000002');
    expect(lastListRequest(server).query.status).toBe('active');
  });

  it('sorts by a column header and toggles the order on the second click', async () => {
    const { server, user } = openConsole();
    await loadedRows();
    expect(columnHeader(ISSUED).getAttribute('aria-sort')).toBe('descending');
    expect(columnHeader(ISSUED).textContent).toContain('Issued (Australia/Sydney)');
    expect(columnHeader('Learner').getAttribute('aria-sort')).toBe('none');

    await user.click(screen.getByRole('button', { name: 'Learner' }));
    expect((await loadedRows()).map((cells) => cells[1])).toEqual([
      'Alex Lee',
      'José Álvarez',
      "Marcus O'Connor",
      'Mei Chen',
      'Priya Sharma',
      'Sofia Rossi',
      'Tom Walker',
    ]);
    expect(lastListRequest(server).query).toMatchObject({ sort: 'learner', order: 'asc', page: '1' });
    expect(columnHeader('Learner').getAttribute('aria-sort')).toBe('ascending');
    expect(columnHeader(ISSUED).getAttribute('aria-sort')).toBe('none');
    expect(screen.getByTestId('sort-select').value).toBe('learner:asc');

    await user.click(screen.getByRole('button', { name: 'Learner' }));
    expect((await loadedRows())[0][1]).toBe('Tom Walker');
    expect(lastListRequest(server).query).toMatchObject({ sort: 'learner', order: 'desc' });
    expect(columnHeader('Learner').getAttribute('aria-sort')).toBe('descending');
    expect(screen.getByTestId('sort-select').value).toBe('learner:desc');

    // another column starts in its own default order
    await user.click(screen.getByRole('button', { name: ISSUED }));
    await loadedRows();
    expect(lastListRequest(server).query).toMatchObject({ sort: 'issued', order: 'desc' });
  });

  it('sorts through the "Sort by" menu and keeps the column headers in sync', async () => {
    const { server, user } = openConsole();
    await loadedRows();

    await user.selectOptions(screen.getByTestId('sort-select'), 'serial:asc');
    expect(serials(await loadedRows())).toEqual(recorded.tenants[ALICE].certificates.map((certificate) => certificate.serialNumber));
    expect(lastListRequest(server).query).toMatchObject({ sort: 'serial', order: 'asc' });
    expect(columnHeader('Serial number').getAttribute('aria-sort')).toBe('ascending');

    await user.selectOptions(screen.getByTestId('sort-select'), 'status:desc');
    expect((await loadedRows())[0][4]).toBe('Revoked');
    expect(lastListRequest(server).query).toMatchObject({ sort: 'status', order: 'desc' });
    expect(columnHeader('Status').getAttribute('aria-sort')).toBe('descending');

    // a header click continues from what the menu selected
    await user.click(screen.getByRole('button', { name: 'Status' }));
    await loadedRows();
    expect(lastListRequest(server).query).toMatchObject({ sort: 'status', order: 'asc' });
  });

  it('pages through the results', async () => {
    const server = startFakeServer();
    server.tenant(ALICE).certificates = recorded.manyCertificates.items; // 29 certificates
    const { user } = openConsole({ server });
    const pagination = () => screen.getByRole('navigation', { name: 'Pagination' });
    const button = (name) => within(pagination()).getByRole('button', { name });

    expect(await loadedRows()).toHaveLength(25);
    expect(pagination().textContent).toContain('1–25 of 29 certificates');
    expect(pagination().textContent).toContain('Page 1 of 2');

    await user.selectOptions(screen.getByTestId('page-size'), '10');
    const firstPage = serials(await loadedRows());
    expect(firstPage).toHaveLength(10);
    expect(lastListRequest(server).query).toMatchObject({ page: '1', pageSize: '10' });
    expect(pagination().textContent).toContain('1–10 of 29 certificates');
    expect(pagination().textContent).toContain('Page 1 of 3');
    expect(button('« First').disabled).toBe(true);
    expect(button('‹ Previous').disabled).toBe(true);
    expect(button('Next ›').disabled).toBe(false);

    await user.click(button('Next ›'));
    const secondPage = serials(await loadedRows());
    expect(lastListRequest(server).query).toMatchObject({ page: '2', pageSize: '10' });
    expect(pagination().textContent).toContain('11–20 of 29 certificates');
    expect(secondPage.filter((serial) => firstPage.includes(serial))).toEqual([]);

    await user.click(button('Last »'));
    expect(await loadedRows()).toHaveLength(9);
    expect(lastListRequest(server).query.page).toBe('3');
    expect(pagination().textContent).toContain('21–29 of 29 certificates');
    expect(pagination().textContent).toContain('Page 3 of 3');
    expect(button('Next ›').disabled).toBe(true);
    expect(button('Last »').disabled).toBe(true);

    await user.click(button('‹ Previous'));
    expect(serials(await loadedRows())).toEqual(secondPage);
    await user.click(button('« First'));
    expect(serials(await loadedRows())).toEqual(firstPage);
    expect(lastListRequest(server).query.page).toBe('1');
  });

  it('offers 5 rows per page, so that paging can be tried on the demo data as it is', async () => {
    const { server, user } = openConsole();
    const pagination = () => screen.getByRole('navigation', { name: 'Pagination' });
    expect(await loadedRows()).toHaveLength(7);
    expect(pagination().textContent).toContain('Page 1 of 1');
    expect([...screen.getByTestId('page-size').options].map((option) => option.value)).toEqual(['5', '10', '25', '50', '100']);

    await user.selectOptions(screen.getByTestId('page-size'), '5');
    const firstPage = serials(await loadedRows());
    expect(firstPage).toHaveLength(5);
    expect(pagination().textContent).toContain('1–5 of 7 certificates');
    expect(pagination().textContent).toContain('Page 1 of 2');

    await user.click(within(pagination()).getByRole('button', { name: 'Next ›' }));
    const secondPage = serials(await loadedRows());
    expect(lastListRequest(server).query).toMatchObject({ page: '2', pageSize: '5' });
    expect(secondPage).toHaveLength(2);
    expect(pagination().textContent).toContain('6–7 of 7 certificates');
    expect(secondPage.filter((serial) => firstPage.includes(serial))).toEqual([]);
  });

  it('opens a certificate on a click on its row, but not at the end of selecting text in it', async () => {
    const { user } = openConsole();
    await loadedRows();
    const cell = screen.getByText('José Álvarez');

    // Dragging over a name to copy it ends in a click on the row as well.
    const selection = vi.spyOn(window, 'getSelection').mockReturnValue({ toString: () => 'José' });
    await user.click(cell);
    expect(window.location.hash).not.toContain('/certificates/');
    expect(screen.queryByRole('dialog')).toBeNull();

    selection.mockReturnValue({ toString: () => '' });
    await user.click(cell);
    await waitFor(() => expect(window.location.hash).toBe('#/certificates/4'));
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });

  it('starts over at page 1 when the filter or the sort order changes', async () => {
    const server = startFakeServer();
    server.tenant(ALICE).certificates = recorded.manyCertificates.items;
    const { user } = openConsole({ server });
    await loadedRows();
    await user.selectOptions(screen.getByTestId('page-size'), '10');
    await loadedRows();
    await user.click(screen.getByRole('button', { name: 'Next ›' }));
    await loadedRows();
    expect(lastListRequest(server).query.page).toBe('2');

    const before = listRequests(server).length;
    await user.selectOptions(screen.getByTestId('status-filter'), 'active');
    await loadedRows();
    // one request, for page 1 of the new result set - never page 2 of it
    expect(listRequests(server).slice(before).map((request) => request.query)).toEqual([
      { status: 'active', sort: 'issued', order: 'desc', page: '1', pageSize: '10' },
    ]);
    expect(screen.getByRole('navigation', { name: 'Pagination' }).textContent).toContain('Page 1 of 3');

    await user.click(screen.getByRole('button', { name: 'Next ›' }));
    await loadedRows();
    await user.click(screen.getByRole('button', { name: 'Course' }));
    await loadedRows();
    expect(lastListRequest(server).query).toMatchObject({ sort: 'course', order: 'asc', page: '1' });
  });

  it('switches the actor: other X-Actor-Email, other tenant, none of the previous rows', async () => {
    const { server, user } = openConsole();
    expect(serials(await loadedRows()).every((serial) => serial.startsWith('EAST-'))).toBe(true);
    expect(screen.getByTestId('actor-select').value).toBe(ALICE);

    const before = server.requests.length;
    await user.selectOptions(screen.getByTestId('actor-select'), BOB);
    expect(await loadedRows()).toEqual([
      ['WEST-0000004', 'Emily Davis', 'Manual Handling', '2026-09-12 18:20', 'Active'],
      ['WEST-0000003', 'Grace Kim', 'Working at Heights', '2026-08-01 11:00', 'Revoked'],
      ['WEST-0000002', 'Liam Brown', 'Working at Heights', '2026-03-21 01:45', 'Active'],
      ['WEST-0000001', 'Alex Lee', 'Safety 101', '2026-01-10 21:30', 'Active'],
    ]);
    expect(document.body.textContent).not.toContain('EAST-');
    expect(server.requests.slice(before).map((request) => request.actor)).toEqual([BOB]);
    expect(screen.getByTestId('tenant-name').textContent).toBe('West');
    expect(columnHeader(ISSUED).textContent).toContain('Issued (Australia/Perth)'); // the issue dates are Perth time now
    expect(document.title).toBe('Certificates · West');
    expect(window.localStorage.getItem('cert-admin.actor')).toBe(BOB); // remembered for the next visit
  });

  it('starts the other tenant with a fresh page: search, filters and paging do not carry over', async () => {
    const { server, user } = openConsole();
    await loadedRows();
    await user.type(screen.getByTestId('search-input'), 'alex{Enter}');
    await user.selectOptions(screen.getByTestId('status-filter'), 'active');
    await loadedRows();

    await user.selectOptions(screen.getByTestId('actor-select'), BOB);
    expect(await loadedRows()).toHaveLength(4);
    expect(screen.getByTestId('search-input').value).toBe('');
    expect(lastListRequest(server).query).toEqual({ status: 'all', sort: 'issued', order: 'desc', page: '1', pageSize: '25' });
  });

  it("never shows the previous tenant's rows, also when its slow answer arrives after the switch", async () => {
    const server = startFakeServer();
    const gate = deferred();
    server.once('GET', '/api/certificates', async (_request, respond) => {
      await gate.promise; // Alice's list is still on its way ...
      return respond();
    });
    const { user } = openConsole({ server });
    await screen.findByTestId('list-loading');

    await user.selectOptions(screen.getByTestId('actor-select'), BOB); // ... when the admin switches
    expect(serials(await loadedRows())).toEqual(['WEST-0000004', 'WEST-0000003', 'WEST-0000002', 'WEST-0000001']);

    gate.resolve();
    await settle();
    expect(serials(await loadedRows())).toEqual(['WEST-0000004', 'WEST-0000003', 'WEST-0000002', 'WEST-0000001']);
    expect(document.body.textContent).not.toContain('EAST-');
    expect(listRequests(server).map((request) => [request.actor, request.aborted])).toEqual([
      [ALICE, true],
      [BOB, false],
    ]);
  });

  it('falls back to the first admin when the remembered one is unknown', async () => {
    openConsole({ actor: 'nobody@nowhere.test' });
    expect(serials(await loadedRows())[0]).toBe('EAST-0000007');
    expect(screen.getByTestId('actor-select').value).toBe(ALICE);
  });

  it('reports a failed start-up and retries', async () => {
    const server = startFakeServer();
    server.once('GET', '/api/actors', () => {
      throw networkError();
    });
    const { user } = openConsole({ server });

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('The console could not start');
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await loadedRows()).toHaveLength(7);
  });

  it('steps back to the last existing page when the rows of the current page have disappeared', async () => {
    const server = startFakeServer();
    server.tenant(ALICE).certificates = recorded.manyCertificates.items; // 29: page 2 of 2 holds four
    const { user } = openConsole({ server });
    await loadedRows();

    server.once('GET', '/api/certificates', () => internalError());
    await user.click(screen.getByRole('button', { name: 'Next ›' }));
    const alert = await screen.findByRole('alert');

    server.tenant(ALICE).certificates = recorded.manyCertificates.items.slice(0, 20); // meanwhile only 20 are left
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    // page 2 comes back empty, the list asks for page 1 on its own and shows it
    await waitFor(() => expect(tableRows(screen.getByTestId('certificate-list'))).toHaveLength(20));
    expect(screen.getByRole('navigation', { name: 'Pagination' }).textContent).toContain('Page 1 of 1');
    expect(listRequests(server).map((request) => request.query.page)).toEqual(['1', '2', '2', '1']);
  });
});
