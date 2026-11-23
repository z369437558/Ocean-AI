import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, vi } from 'vitest';

import App from '../../src/App.jsx';
import { ALICE, startFakeServer } from './fakeServer.js';

/**
 * Mounts the real <App /> on top of the fake server, the way a browser tab would open it:
 * `actor` is the admin remembered from the last visit, `hash` the deep link.
 */
export function openConsole({ actor = ALICE, hash = '', server = startFakeServer(), strict = false } = {}) {
  window.localStorage.setItem('cert-admin.actor', actor);
  if (hash) window.history.replaceState(null, '', hash);
  const user = userEvent.setup();
  const view = render(<App />, { reactStrictMode: strict });
  return { server, user, ...view };
}

/**
 * The body rows of the certificate table, cell by cell, once the list has finished loading.
 * (While a reload is running the table keeps showing the previous rows, so "has rows" is not enough.)
 */
export function loadedRows() {
  return waitFor(() => {
    const list = screen.getByTestId('certificate-list');
    expect(list.getAttribute('data-state')).toBe('success');
    return tableRows(list);
  });
}

export function tableRows(container) {
  return [...container.querySelectorAll('tbody tr')].map((row) => [...row.querySelectorAll('td')].map((cell) => cell.textContent.trim()));
}

export const serials = (rows) => rows.map((cells) => cells[0]);

/** The tab links in the top bar. */
export const openTab = (user, name) => user.click(within(screen.getByRole('navigation', { name: 'Sections' })).getByRole('link', { name }));

/** Lets everything that is already in motion (answers, renders, effects) come to rest. */
export const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 20)));

/**
 * Stands in for the browser's "save as": records every file the page saves instead of navigating
 * to a blob: URL. Returns the list of saved files as { fileName, blob }.
 */
export function captureDownloads() {
  const blobs = new Map();
  const saved = [];
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
    const url = `blob:test/${blobs.size + 1}`;
    blobs.set(url, blob);
    return url;
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function saveFile() {
    saved.push({ fileName: this.download, blob: blobs.get(this.getAttribute('href')) });
  });
  return saved;
}

// --- Bulk issue page -----------------------------------------------------------------------------

/** Opens the console on the Bulk issue tab and waits for the page. */
export async function openBulkIssue(options) {
  const view = openConsole({ hash: '#/bulk-issue', ...options });
  await screen.findByRole('heading', { name: 'Bulk issue certificates' });
  return view;
}

/** Picks a course by its title and waits for the roster preview. */
export async function chooseCourse(user, title) {
  const select = screen.getByTestId('course-select');
  await waitFor(() => expect(select.disabled).toBe(false)); // the courses have loaded
  await user.selectOptions(select, title);
  await rosterLoaded();
}

/** The roster preview is on screen and not being refreshed. */
export function rosterLoaded() {
  return waitFor(() => {
    expect(screen.getByTestId('roster-summary')).toBeTruthy();
    expect(document.querySelector('.is-refreshing')).toBeNull();
  });
}

export const operationStatus = () => screen.getByTestId('operation-status');
export const bulkIssuePosts = (server) => server.sent('POST', '/api/bulk-issues');
export const idempotencyKeys = (server) => bulkIssuePosts(server).map((request) => request.headers['idempotency-key']);
