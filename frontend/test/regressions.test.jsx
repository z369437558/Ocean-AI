/**
 * Regression tests for the audited defects that are not part of one workflow file:
 * item C ("View outcomes"), item D (malformed answers, error boundary), item F (control characters
 * in the search) and item G (export in flight when its page goes away).
 * Items A and B live in bulk-issue.test.jsx, item E in detail-revoke.test.jsx.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import {
  captureDownloads,
  chooseCourse,
  loadedRows,
  openBulkIssue,
  openConsole,
  openTab,
  settle,
  tableRows,
} from './support/app.jsx';
import { expectConsoleError } from './support/console.js';
import { ALICE, BOB, deferred, json, networkError, recorded, startFakeServer } from './support/fakeServer.js';

describe('"View outcomes" shows the operation selected last (item C)', () => {
  const resultHeadings = () => screen.getAllByTestId('operation-result').map((panel) => within(panel).getByRole('heading').textContent);
  const viewOutcomes = (operationId) => {
    const row = [...screen.getByTestId('operation-history').querySelectorAll('tbody tr')].find((tr) => tr.cells[0].textContent === `#${operationId}`);
    return within(row).getByRole('button', { name: 'View outcomes' });
  };

  it('item C: a slow answer for an earlier choice never replaces the operation that was opened last', async () => {
    const server = startFakeServer();
    server.bulkIssue(ALICE, 1, 'earlier-run-1');
    server.bulkIssue(ALICE, 1, 'earlier-run-2');
    const gate = deferred();
    server.on('GET', '/api/bulk-issues/1', async (_request, respond) => {
      await gate.promise; // operation #1 answers slowly
      return respond();
    });
    const { user } = await openBulkIssue({ server });
    await screen.findByTestId('operation-history');

    await user.click(viewOutcomes(1));
    expect(await screen.findByText('Loading operation #1…')).toBeTruthy();
    await user.click(viewOutcomes(2));
    await waitFor(() => expect(resultHeadings()).toEqual(['Operation #2 · Safety 101']));

    gate.resolve(); // now the outdated answer for #1 arrives
    await settle();
    expect(resultHeadings()).toEqual(['Operation #2 · Safety 101']);
    expect(screen.getByTestId('summary-skipped').textContent).toBe('5');
    expect(server.sent('GET', '/api/bulk-issues/1').map((request) => request.aborted)).toEqual([true]);
  });

  it('item C: opening the operation whose result is already on screen renders no second panel', async () => {
    const { user } = await openBulkIssue();
    await chooseCourse(user, 'Safety 101');
    await user.click(screen.getByTestId('issue-button'));
    await screen.findByTestId('operation-result');
    await screen.findByTestId('operation-history');

    await user.click(viewOutcomes(1)); // the run that was just made
    await settle();
    expect(resultHeadings()).toEqual(['Operation #1 · Safety 101']);
    expect(document.querySelectorAll('#result-heading')).toHaveLength(1);
    expect(screen.queryByText('Loading operation #1…')).toBeNull();

    // dismissing the result does not bring a hidden copy to the surface
    await user.click(within(screen.getByTestId('operation-result')).getByRole('button', { name: 'Dismiss' }));
    await settle();
    expect(screen.queryByTestId('operation-result')).toBeNull();
  });

  it('item C: a past operation shown below a run result does not repeat the id "result-heading"', async () => {
    const server = startFakeServer();
    server.bulkIssue(ALICE, 1, 'earlier-run-1'); // operation #1 exists; the UI will now run #2
    // The preview still offers two learners, as if it had been loaded before that run; the second
    // run then skips everyone, which is exactly what the real backend answered in the recording.
    server.tenant(ALICE).rosters[1] = recorded.tenants[ALICE].rosters[1];
    const { user } = await openBulkIssue({ server });
    await chooseCourse(user, 'Safety 101');
    await user.click(screen.getByTestId('issue-button'));
    await waitFor(() => expect(resultHeadings()).toEqual(['Operation #2 · Safety 101']));

    await user.click(viewOutcomes(1));
    await waitFor(() => expect(resultHeadings()).toEqual(['Operation #2 · Safety 101', 'Operation #1 · Safety 101']));
    const panels = screen.getAllByTestId('operation-result');
    expect(panels.map((panel) => within(panel).getByRole('heading').id)).toEqual(['result-heading', 'viewed-result-heading']);
    expect(panels.map((panel) => panel.getAttribute('aria-labelledby'))).toEqual(['result-heading', 'viewed-result-heading']);
    expect(document.querySelectorAll('#result-heading')).toHaveLength(1);

    // selecting the run's own operation takes the other panel away again
    await user.click(viewOutcomes(2));
    await waitFor(() => expect(resultHeadings()).toEqual(['Operation #2 · Safety 101']));

    // and a past operation on its own carries the usual id
    await user.click(within(screen.getByTestId('operation-result')).getByRole('button', { name: 'Dismiss' }));
    await user.click(viewOutcomes(1));
    await waitFor(() => expect(resultHeadings()).toEqual(['Operation #1 · Safety 101']));
    expect(within(screen.getByTestId('operation-result')).getByRole('heading').id).toBe('result-heading');
  });

  it('item C: after switching to another operation, the one opened before is not rendered again - not even once', async () => {
    const server = startFakeServer();
    server.bulkIssue(ALICE, 1, 'earlier-run-1');
    server.bulkIssue(ALICE, 1, 'earlier-run-2');
    const { user } = await openBulkIssue({ server });
    await screen.findByTestId('operation-history');
    await user.click(viewOutcomes(1));
    await waitFor(() => expect(resultHeadings()).toEqual(['Operation #1 · Safety 101']));

    // every result panel that enters the page from here on, however briefly
    const rendered = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          const panels = node.matches('[data-testid="operation-result"]') ? [node] : [...node.querySelectorAll('[data-testid="operation-result"]')];
          rendered.push(...panels.map((panel) => panel.querySelector('h2').textContent));
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    try {
      await user.click(viewOutcomes(2));
      await waitFor(() => expect(resultHeadings()).toEqual(['Operation #2 · Safety 101']));
      await settle();
    } finally {
      observer.disconnect();
    }
    expect(rendered).toEqual(['Operation #2 · Safety 101']);
  });

  it('item C: an operation opened while the retry that returns it is in flight does not pop up when the result is dismissed', async () => {
    const server = startFakeServer();
    server.once('POST', '/api/bulk-issues', (_request, respond) => {
      respond(); // operation #1 exists on the server ...
      throw networkError(); // ... but the console does not know its outcome yet
    });
    const { user } = await openBulkIssue({ server });
    await chooseCourse(user, 'Safety 101');
    await user.click(screen.getByTestId('issue-button'));
    await screen.findByTestId('retry-button');
    await screen.findByTestId('operation-history'); // the history already lists #1

    const replay = deferred();
    server.once('POST', '/api/bulk-issues', async (_request, respond) => {
      await replay.promise;
      return respond();
    });
    await user.click(screen.getByTestId('retry-button'));
    await user.click(viewOutcomes(1)); // opened from the history while the retry is on its way
    await waitFor(() => expect(resultHeadings()).toEqual(['Operation #1 · Safety 101']));

    replay.resolve(); // the retry returns the same operation as the result of the run
    await screen.findByTestId('operation-replayed');
    expect(resultHeadings()).toEqual(['Operation #1 · Safety 101']); // one panel, not two
    expect(document.querySelectorAll('#result-heading')).toHaveLength(1);

    await user.click(within(screen.getByTestId('operation-result')).getByRole('button', { name: 'Dismiss' }));
    await settle();
    expect(screen.queryByTestId('operation-result')).toBeNull(); // the copy from the history does not take its place
    expect(screen.queryByText('Loading operation #1…')).toBeNull();
  });

  it('item C: starting a bulk issue closes the past operation that was open, so only the new result is shown', async () => {
    const server = startFakeServer();
    server.bulkIssue(ALICE, 1, 'earlier-run-1');
    server.tenant(ALICE).rosters[1] = recorded.tenants[ALICE].rosters[1]; // the preview still offers two learners
    const gate = deferred();
    server.on('POST', '/api/bulk-issues', async (_request, respond) => {
      await gate.promise;
      return respond();
    });
    const { user } = await openBulkIssue({ server });
    await chooseCourse(user, 'Safety 101');
    await screen.findByTestId('operation-history');
    await user.click(viewOutcomes(1));
    await waitFor(() => expect(resultHeadings()).toEqual(['Operation #1 · Safety 101']));

    await user.click(screen.getByTestId('issue-button'));
    expect(screen.queryByTestId('operation-result')).toBeNull(); // closed as soon as the run starts
    gate.resolve();
    await waitFor(() => expect(resultHeadings()).toEqual(['Operation #2 · Safety 101']));
    await settle();
    expect(resultHeadings()).toEqual(['Operation #2 · Safety 101']);
  });

  it('item C: "View outcomes" for the result that is already on screen moves the focus to its heading', async () => {
    const scrolled = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function scrollIntoView(options) {
      scrolled.push([this.id, options]);
    };
    try {
      const { user } = await openBulkIssue();
      await chooseCourse(user, 'Safety 101');
      await user.click(screen.getByTestId('issue-button'));
      await screen.findByTestId('operation-result');
      await screen.findByTestId('operation-history');

      // An ordinary click on the heading text does not put the focus (and with it the outline) there.
      const heading = within(screen.getByTestId('operation-result')).getByRole('heading');
      await user.click(heading);
      expect(heading.hasAttribute('tabindex')).toBe(false);
      expect(document.activeElement).not.toBe(heading);

      const button = viewOutcomes(1);
      await user.click(button);
      expect(within(screen.getByTestId('operation-result')).getByRole('heading')).toBe(heading);
      expect(document.activeElement).toBe(heading); // perceivable: announced, and outlined by the stylesheet
      expect(document.activeElement).not.toBe(button);
      expect(heading.getAttribute('tabindex')).toBe('-1'); // reachable by script, not a Tab stop
      expect(scrolled).toEqual([['result-heading', { block: 'nearest' }]]);
      expect(resultHeadings()).toEqual(['Operation #1 · Safety 101']);

      // Once the focus moves on, the heading is an ordinary heading again.
      await user.click(button);
      expect(document.activeElement).toBe(heading);
      await user.click(screen.getByTestId('course-select'));
      expect(document.activeElement).not.toBe(heading);
      expect(heading.hasAttribute('tabindex')).toBe(false);
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });
});

describe.each([
  ['an object of another shape', { foo: 1 }],
  ['null', null],
  ['a list instead of an object', []],
])('A 200 answer with unexpected JSON ends in the error state (item D): %s', (_shape, body) => {
  const MESSAGE = 'The server sent an answer that this console does not understand.';
  const tryAgain = (user, alert) => user.click(within(alert).getByRole('button', { name: 'Try again' }));

  it('item D: certificate list', async () => {
    const server = startFakeServer();
    server.once('GET', '/api/certificates', () => json(200, body));
    const { user } = openConsole({ server });

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Certificates could not be loaded');
    expect(alert.textContent).toContain(MESSAGE);
    expect(screen.getByTestId('certificate-list').getAttribute('data-state')).toBe('error');
    await tryAgain(user, alert);
    expect(await loadedRows()).toHaveLength(7);
  });

  it('item D: certificate list, while rows are on screen', async () => {
    const { server, user } = openConsole();
    await loadedRows();
    server.once('GET', '/api/certificates', () => json(200, body));
    await user.selectOptions(screen.getByTestId('status-filter'), 'active');

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(MESSAGE);
    expect(screen.getByRole('heading', { name: 'Certificates' })).toBeTruthy(); // the page is still there
    await tryAgain(user, alert);
    expect(await loadedRows()).toHaveLength(6);
  });

  it('item D: certificate detail', async () => {
    const server = startFakeServer();
    server.once('GET', '/api/certificates/1', () => json(200, body));
    const { user } = openConsole({ server, hash: '#/certificates/1' });

    const alert = await within(await screen.findByTestId('certificate-detail')).findByRole('alert');
    expect(alert.textContent).toContain('The certificate could not be loaded');
    expect(alert.textContent).toContain(MESSAGE);
    await tryAgain(user, alert);
    expect((await screen.findByTestId('detail-serial')).textContent).toBe('EAST-0000001');
  });

  it('item D: courses', async () => {
    const server = startFakeServer();
    server.once('GET', '/api/courses', () => json(200, body));
    const { user } = await openBulkIssue({ server });

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Courses could not be loaded');
    expect(alert.textContent).toContain(MESSAGE);
    await tryAgain(user, alert);
    await chooseCourse(user, 'Safety 101');
  });

  it('item D: roster', async () => {
    const server = startFakeServer();
    server.once('GET', '/api/courses/1/enrollments', () => json(200, body));
    const { user } = await openBulkIssue({ server });
    const select = screen.getByTestId('course-select');
    await waitFor(() => expect(select.disabled).toBe(false));
    await user.selectOptions(select, 'Safety 101');

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('The course roster could not be loaded');
    expect(alert.textContent).toContain(MESSAGE);
    expect(screen.getByTestId('issue-button').disabled).toBe(true);
    await tryAgain(user, alert);
    await waitFor(() => expect(screen.getByTestId('issue-button').textContent).toBe('Issue 2 certificates'));
  });

  it('item D: operation history', async () => {
    const server = startFakeServer();
    server.bulkIssue(ALICE, 1, 'earlier-run-1');
    server.once('GET', '/api/bulk-issues', () => json(200, body));
    const { user } = await openBulkIssue({ server });

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Operations could not be loaded');
    expect(alert.textContent).toContain(MESSAGE);
    await tryAgain(user, alert);
    expect(tableRows(await screen.findByTestId('operation-history'))).toHaveLength(1);
  });

  it('item D: a single operation', async () => {
    const server = startFakeServer();
    server.bulkIssue(ALICE, 1, 'earlier-run-1');
    server.once('GET', '/api/bulk-issues/1', () => json(200, body));
    const { user } = await openBulkIssue({ server });
    await user.click(await screen.findByRole('button', { name: 'View outcomes' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Operation #1 could not be loaded');
    expect(alert.textContent).toContain(MESSAGE);
    await tryAgain(user, alert);
    expect(within(await screen.findByTestId('operation-result')).getByRole('heading').textContent).toBe('Operation #1 · Safety 101');
  });

  it('item D: actor list', async () => {
    const server = startFakeServer();
    server.once('GET', '/api/actors', () => json(200, body));
    const { user } = openConsole({ server });

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('The console could not start');
    expect(alert.textContent).toContain(MESSAGE);
    await tryAgain(user, alert);
    expect(await loadedRows()).toHaveLength(7);
  });
});

describe('Answers that are almost right (item D)', () => {
  it.each([
    ['items is not a list', { items: 'none', total: 0, totalPages: 1 }],
    ['an item is not an object', { items: [null], total: 1, totalPages: 1 }],
    ['the totals are missing', { items: [] }],
  ])('item D: certificate list where %s', async (_case, body) => {
    const server = startFakeServer();
    server.once('GET', '/api/certificates', () => json(200, body));
    openConsole({ server });
    expect((await screen.findByRole('alert')).textContent).toContain('Certificates could not be loaded');
  });

  it('item D: an actor without a tenant, a certificate without an audit trail, a roster without totals', async () => {
    const server = startFakeServer();
    server.once('GET', '/api/actors', () => json(200, { items: [{ email: ALICE }] }));
    const { user } = openConsole({ server, hash: '#/certificates/1' });
    const startUp = await screen.findByRole('alert');
    expect(startUp.textContent).toContain('The console could not start');

    const { auditEvents, ...withoutAuditTrail } = recorded.tenants[ALICE].details[1];
    server.once('GET', '/api/certificates/1', () => json(200, withoutAuditTrail));
    await user.click(within(startUp).getByRole('button', { name: 'Try again' }));
    const drawerAlert = await within(await screen.findByTestId('certificate-detail')).findByRole('alert');
    expect(drawerAlert.textContent).toContain('The certificate could not be loaded');

    const { summary, ...withoutTotals } = recorded.tenants[ALICE].rosters[1];
    server.once('GET', '/api/courses/1/enrollments', () => json(200, withoutTotals));
    await openTab(user, 'Bulk issue');
    const select = await screen.findByTestId('course-select');
    await waitFor(() => expect(select.disabled).toBe(false));
    await user.selectOptions(select, 'Safety 101');
    expect((await screen.findByRole('alert')).textContent).toContain('The course roster could not be loaded');
  });
});

describe('A well-formed answer about another record (item D)', () => {
  const MESSAGE = 'The server sent an answer that this console does not understand.';

  it.each([
    ['whose course has no id', (roster) => ({ ...roster, course: { title: roster.course.title } })],
    ['of another course', (roster) => ({ ...roster, course: { ...roster.course, id: 3 } })],
    ['whose course id is text instead of a number', (roster) => ({ ...roster, course: { ...roster.course, id: '1' } })],
  ])('item D: a roster %s ends in the error state instead of loading for ever', async (_case, spoil) => {
    const server = startFakeServer();
    server.once('GET', '/api/courses/1/enrollments', async (_request, respond) => json(200, spoil(await respond().json())));
    const { user } = await openBulkIssue({ server });
    const select = screen.getByTestId('course-select');
    await waitFor(() => expect(select.disabled).toBe(false));
    await user.selectOptions(select, 'Safety 101');

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('The course roster could not be loaded');
    expect(alert.textContent).toContain(MESSAGE);
    expect(screen.queryByText('Loading learners…')).toBeNull();
    expect(screen.getByTestId('issue-button').disabled).toBe(true);
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByTestId('issue-button').textContent).toBe('Issue 2 certificates'));
  });

  it('item D: a course list whose ids are text ends in the error state - no roster could ever match such a course', async () => {
    const server = startFakeServer();
    server.once('GET', '/api/courses', async (_request, respond) => {
      const { items } = await respond().json();
      return json(200, { items: items.map((course) => ({ ...course, id: String(course.id) })) });
    });
    const { user } = await openBulkIssue({ server });

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Courses could not be loaded');
    expect(alert.textContent).toContain(MESSAGE);
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await chooseCourse(user, 'Safety 101');
    expect(screen.getByTestId('issue-button').textContent).toBe('Issue 2 certificates');
  });

  it('item D: an operation answered with another id ends in the error state instead of loading for ever', async () => {
    const server = startFakeServer();
    server.bulkIssue(ALICE, 1, 'earlier-run-1');
    server.once('GET', '/api/bulk-issues/1', async (_request, respond) => json(200, { ...(await respond().json()), id: 7 }));
    const { user } = await openBulkIssue({ server });
    await user.click(await screen.findByRole('button', { name: 'View outcomes' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Operation #1 could not be loaded');
    expect(alert.textContent).toContain(MESSAGE);
    expect(screen.queryByText('Loading operation #1…')).toBeNull();
    expect(screen.queryByTestId('operation-result')).toBeNull(); // and operation #7 is not shown in its place
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(within(await screen.findByTestId('operation-result')).getByRole('heading').textContent).toBe('Operation #1 · Safety 101');
  });
});

describe('Top-level error boundary (item D)', () => {
  it('item D: an unexpected render exception shows an error panel with a reload action, not an empty page', async () => {
    const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => {});
    expectConsoleError(/Objects are not valid as a React child/); // React reports what the boundary caught
    expectConsoleError(/error boundary/i);

    // Passes every shape check and still cannot be displayed: a learner name that is an object.
    const server = startFakeServer();
    server.on('GET', '/api/certificates', async (_request, respond) => {
      const page = await respond().json();
      page.items[0].learnerName = { first: 'Tom', last: 'Walker' };
      return json(200, page);
    });
    const { user, container } = openConsole({ server });

    const panel = await screen.findByTestId('app-crashed');
    expect(panel.getAttribute('role')).toBe('alert');
    expect(panel.textContent).toContain('The console ran into an unexpected problem');
    expect(panel.textContent).toContain('This page could not be displayed. Reload the console to continue.');
    expect(container.textContent).not.toBe('');
    expect(screen.queryByTestId('certificate-list')).toBeNull();

    // what the runtime reported is there for whoever investigates, but folded away
    const details = panel.querySelector('details');
    expect(details.open).toBe(false);
    expect(details.querySelector('summary').textContent).toBe('Technical details');
    expect(details.textContent).toContain('Objects are not valid as a React child');
    expect(panel.textContent.replace(details.textContent, '')).not.toContain('React');

    // the list itself failed: there is nowhere better to send the admin
    expect(within(panel).getAllByRole('button').map((button) => button.textContent)).toEqual(['Reload the console']);
    await user.click(within(panel).getByRole('button', { name: 'Reload the console' }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('item D: on a deep link that cannot be displayed the panel also leads back to the certificate list', async () => {
    const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => {});
    expectConsoleError(/Objects are not valid as a React child/);
    expectConsoleError(/error boundary/i);

    // The record behind this link is what cannot be displayed: reloading the link fails every time.
    const server = startFakeServer();
    server.on('GET', '/api/certificates/1', async (_request, respond) => json(200, { ...(await respond().json()), learnerName: { first: 'Alex', last: 'Lee' } }));
    const { user } = openConsole({ server, hash: '#/certificates/1' });

    const panel = await screen.findByTestId('app-crashed');
    expect(panel.textContent).toContain(
      'This page could not be displayed. Reload the console to continue. If the problem comes back, go to the certificate list instead.',
    );
    expect(within(panel).getAllByRole('button').map((button) => button.textContent)).toEqual(['Reload the console', 'Go to the certificate list']);

    await user.click(within(panel).getByRole('button', { name: 'Go to the certificate list' }));
    expect(window.location.hash).toBe('#/certificates'); // away from the record, then a fresh start
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe('Control characters in the search text (item F)', () => {
  const listRequests = (server) => server.sent('GET', '/api/certificates');

  it('item F: a pasted tab is searched (and exported) as a single space instead of failing with HTTP 400', async () => {
    const saved = captureDownloads();
    const { server, user } = openConsole();
    await loadedRows();

    await user.click(screen.getByTestId('search-input'));
    await user.paste('Alex Lee\tSafety 101'); // two spreadsheet cells
    await user.keyboard('{Enter}');

    expect(await loadedRows()).toEqual([]);
    expect(listRequests(server).at(-1).query.q).toBe('Alex Lee Safety 101');
    expect(listRequests(server).filter((request) => /[\u0000-\u001f\u007f]/.test(request.query.q ?? ''))).toEqual([]); // not even one
    expect(screen.getByTestId('certificate-list').getAttribute('data-state')).toBe('success');
    expect(screen.getByText('Nothing found for “Alex Lee Safety 101”. Search looks at learner names and serial numbers.')).toBeTruthy();
    expect(screen.queryByText(/contains characters that are not allowed/)).toBeNull();

    await user.click(screen.getByTestId('export-button'));
    await screen.findByTestId('export-done');
    expect(server.sent('GET', '/api/certificates/export.csv')[0].query.q).toBe('Alex Lee Safety 101');
    expect(saved).toHaveLength(1);
  });

  it('item F: Enter sends the cleaned text at once - before the debounce could repair anything', async () => {
    const { server } = openConsole();
    await loadedRows();
    const answers = [];
    server.on('GET', '/api/certificates', (_request, respond) => {
      const answer = respond();
      answers.push(answer.status);
      return answer;
    });

    const input = screen.getByTestId('search-input');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fireEvent.change(input, { target: { value: 'Tom\tWalker' } });
    fireEvent.submit(input.closest('form')); // Enter in the search field
    vi.useRealTimers(); // the debounce timer is dropped with the fake clock: it never fires in this test

    expect((await loadedRows()).map((cells) => cells[1])).toEqual(['Tom Walker']);
    expect(listRequests(server).map((request) => request.query.q)).toEqual([undefined, 'Tom Walker']);
    expect(answers).toEqual([200]); // no HTTP 400 on the way
    expect(screen.queryByText(/contains characters that are not allowed/)).toBeNull();
  });

  it('item F: line breaks and other control characters become single spaces too, also through the debounce', async () => {
    const { server } = openConsole();
    await loadedRows();

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fireEvent.change(screen.getByTestId('search-input'), { target: { value: '\u0000 Alex \r\n\t Lee\u007f\n' } });
    act(() => vi.advanceTimersByTime(300));
    vi.useRealTimers();

    expect(await loadedRows()).toEqual([['EAST-0000001', 'Alex Lee', 'Safety 101', '2026-01-11 00:30', 'Active']]);
    expect(listRequests(server).at(-1).query.q).toBe('Alex Lee');
    expect(listRequests(server).filter((request) => /[\u0000-\u001f\u007f]/.test(request.query.q ?? ''))).toEqual([]);
  });

  it('item F: Export clicked right after pasting sends the cleaned text as well', async () => {
    captureDownloads();
    const { server } = openConsole();
    await loadedRows();

    fireEvent.change(screen.getByTestId('search-input'), { target: { value: 'Tom\tWalker' } });
    fireEvent.click(screen.getByTestId('export-button'));
    await screen.findByTestId('export-done');
    expect(server.sent('GET', '/api/certificates/export.csv')[0].query.q).toBe('Tom Walker');
    expect((await loadedRows()).map((cells) => cells[1])).toEqual(['Tom Walker']);
  });
});

describe('An export in flight when its page goes away (item G)', () => {
  const holdExport = (server) => {
    const gate = deferred();
    server.on('GET', '/api/certificates/export.csv', async (_request, respond) => {
      await gate.promise;
      return respond();
    });
    return gate;
  };

  it('item G: switching the actor aborts the export - no file of tenant A is saved while acting as tenant B', async () => {
    const saved = captureDownloads();
    const server = startFakeServer();
    const gate = holdExport(server);
    const { user } = openConsole({ server });
    await loadedRows();

    await user.click(screen.getByTestId('export-button'));
    expect(screen.getByTestId('export-button').textContent).toBe('Exporting…');
    await user.selectOptions(screen.getByTestId('actor-select'), BOB);
    expect((await loadedRows()).every((cells) => cells[0].startsWith('WEST-'))).toBe(true);
    expect(screen.getByTestId('tenant-name').textContent).toBe('West');
    expect(server.sent('GET', '/api/certificates/export.csv').map((request) => [request.actor, request.aborted])).toEqual([[ALICE, true]]);

    gate.resolve(); // the East file would be ready now
    await settle();
    expect(saved).toEqual([]);
    expect(screen.queryByTestId('export-done')).toBeNull();
    expect(screen.queryByText(/Export failed/)).toBeNull();
    expect(screen.getByTestId('export-button').textContent).toBe('Export CSV');
    expect(screen.getByTestId('export-button').disabled).toBe(false);
  });

  it('item G: leaving the Certificates tab aborts the export as well, and nothing is saved later', async () => {
    const saved = captureDownloads();
    const server = startFakeServer();
    const gate = holdExport(server);
    const { user } = openConsole({ server });
    await loadedRows();

    await user.click(screen.getByTestId('export-button'));
    await openTab(user, 'Bulk issue');
    await screen.findByRole('heading', { name: 'Bulk issue certificates' });
    expect(server.sent('GET', '/api/certificates/export.csv')[0].aborted).toBe(true);

    gate.resolve();
    await settle();
    await openTab(user, 'Certificates');
    await loadedRows();
    expect(saved).toEqual([]);
    expect(screen.queryByTestId('export-done')).toBeNull();
    expect(screen.getByTestId('export-button').disabled).toBe(false);
  });

  it('item G: opening and closing the detail drawer does not cancel a running export', async () => {
    const saved = captureDownloads();
    const server = startFakeServer();
    const gate = holdExport(server);
    const { user } = openConsole({ server });
    await loadedRows();

    await user.click(screen.getByTestId('export-button'));
    await user.click(screen.getByText('Priya Sharma'));
    await screen.findByTestId('detail-serial');
    await user.keyboard('{Escape}');

    gate.resolve();
    await screen.findByTestId('export-done');
    expect(saved).toHaveLength(1);
    expect(server.sent('GET', '/api/certificates/export.csv')[0].aborted).toBe(false);
  });
});

describe('What the browser scrolls into view is not parked under the sticky top bar', () => {
  // The real stylesheet. (Vitest hands out CSS imports empty.)
  const STYLES = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/styles.css'), 'utf8');
  const reportedHeight = () => document.documentElement.style.getPropertyValue('--topbar-height');

  it('tells the stylesheet how high the bar is while it sticks, 0 where it scrolls away, and nothing once the console is gone', async () => {
    const sheet = document.createElement('style');
    sheet.textContent = STYLES;
    document.head.append(sheet);
    // The simulated DOM has no layout, so the bar is given a height - with a fraction, as on a zoomed screen.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function measure() {
      const height = this.classList.contains('topbar') ? 69.4 : 0;
      return { x: 0, y: 0, top: 0, left: 0, right: 1024, bottom: height, width: 1024, height };
    });
    try {
      const view = openConsole();
      await loadedRows();
      const bar = document.querySelector('.topbar');
      expect(getComputedStyle(bar).position).toBe('sticky');
      expect(reportedHeight()).toBe('70px'); // rounded up: not even a sliver of the focused control under the bar
      // ... which is what the browser keeps clear at the top when it scrolls a control or a heading into view
      expect(getComputedStyle(document.documentElement).scrollPaddingTop).toBe('calc(70px + 0.75rem)');

      bar.style.position = 'static'; // what the stylesheet does on a small window, where the bar scrolls away
      act(() => {
        window.dispatchEvent(new Event('resize'));
      });
      expect(reportedHeight()).toBe('0px');

      view.unmount();
      expect(reportedHeight()).toBe('');
    } finally {
      sheet.remove();
    }
  });
});
