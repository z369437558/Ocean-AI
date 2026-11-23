import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { createApi } from '../src/api.js';
import { createBulkIssueStore } from '../src/bulkIssueStore.js';
import BulkIssuePage from '../src/components/BulkIssuePage.jsx';
import {
  bulkIssuePosts,
  chooseCourse,
  idempotencyKeys,
  loadedRows,
  openBulkIssue,
  openTab,
  operationStatus,
  rosterLoaded,
  settle,
  tableRows,
} from './support/app.jsx';
import {
  ALICE,
  BOB,
  deferred,
  errorAnswer,
  internalError,
  json,
  networkError,
  recorded,
  startFakeServer,
  unreadableBody,
} from './support/fakeServer.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const [eastFirstRun] = recorded.bulkIssues[ALICE].runs;
const [westRunWithFailure] = recorded.bulkIssues[BOB].runs;

const issueButton = () => screen.getByTestId('issue-button');
const resultPanel = () => screen.getByTestId('operation-result');
const summaryCounts = () => ['summary-issued', 'summary-skipped', 'summary-failed'].map((id) => screen.getByTestId(id).textContent);

/** Keeps POST /api/bulk-issues pending until the returned gate is resolved. */
function holdBulkIssue(server) {
  const gate = deferred();
  server.on('POST', '/api/bulk-issues', async (_request, respond) => {
    await gate.promise;
    return respond();
  });
  return gate;
}

/** The server carries the bulk issue out, but its answer never reaches the browser - once. */
function loseAnswerOnce(server, lostAnswer = () => { throw networkError(); }) {
  server.once('POST', '/api/bulk-issues', (_request, respond) => {
    respond();
    return lostAnswer();
  });
}

describe('Bulk issue: preview', () => {
  it('lists the courses of the tenant and asks to choose one', async () => {
    const { server } = await openBulkIssue();
    const select = screen.getByTestId('course-select');
    await waitFor(() => expect(select.disabled).toBe(false));

    expect([...select.options].map((option) => option.textContent)).toEqual([
      'Choose a course…',
      'First Aid Refresher',
      'Forklift Operations',
      'Safety 101',
    ]);
    expect(screen.getByText('Choose a course to review its learners')).toBeTruthy();
    expect(issueButton().textContent).toBe('Issue certificates');
    expect(issueButton().disabled).toBe(true);
    expect(operationStatus().getAttribute('data-state')).toBe('idle');
    expect(await screen.findByText('No bulk issues have been run in this tenant yet')).toBeTruthy();
    expect(server.requests.filter((request) => request.path !== '/api/actors').every((request) => request.actor === ALICE)).toBe(true);
    expect(bulkIssuePosts(server)).toEqual([]);
  });

  it('previews the roster: who is eligible and why the others will be skipped', async () => {
    const { server, user } = await openBulkIssue();
    await chooseCourse(user, 'Safety 101');

    expect(screen.getByTestId('roster-summary').textContent).toBe('5Enrolled3Completed1Certified2Eligible now');
    expect(screen.getByTestId('eligible-count').textContent).toBe('2');
    const roster = tableRows(screen.getByTestId('roster-summary').parentElement);
    expect(roster.map((cells) => [cells[0], cells[2], cells[3]])).toEqual([
      ['Alex Lee', 'EAST-0000001 Active', 'Skipped: Already certified (certificate EAST-0000001)'],
      ["Marcus O'Connor", 'None', 'Will be issued'],
      ['Mei Chen', 'None', 'Skipped: Course not completed (enrollment is in progress)'],
      ['Priya Sharma', 'None', 'Will be issued'],
      ['Tom Walker', 'None', 'Skipped: Course not completed (enrollment is not started)'],
    ]);
    expect(roster[0][1]).toBe(`Completed · ${recorded.tenants[ALICE].rosters[1].items[0].completedLocal}`);
    expect(roster[2][1]).toBe('In progress');
    expect(roster[4][1]).toBe('Not started');
    expect(issueButton().textContent).toBe('Issue 2 certificates');
    expect(issueButton().disabled).toBe(false);

    expect(server.sent('GET', '/api/courses/1/enrollments')).toHaveLength(1);
    expect(server.sent('GET', '/api/courses/1/enrollments')[0].query).toEqual({ page: '1' });
    expect(bulkIssuePosts(server)).toEqual([]); // looking is free: nothing is issued by previewing
  });

  it('offers nothing to issue when nobody is eligible', async () => {
    const { user } = await openBulkIssue();
    await chooseCourse(user, 'Forklift Operations');
    expect(screen.getByTestId('eligible-count').textContent).toBe('0');
    expect(issueButton().textContent).toBe('No eligible learners');
    expect(issueButton().disabled).toBe(true);
  });

  it('shows the error state when the roster cannot be loaded and retries', async () => {
    const server = startFakeServer();
    server.once('GET', '/api/courses/1/enrollments', () => internalError());
    const { user } = await openBulkIssue({ server });
    const select = screen.getByTestId('course-select');
    await waitFor(() => expect(select.disabled).toBe(false));
    await user.selectOptions(select, 'Safety 101');

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('The course roster could not be loaded');
    expect(issueButton().disabled).toBe(true);
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await rosterLoaded();
    expect(issueButton().textContent).toBe('Issue 2 certificates');
  });
});

describe('Bulk issue: a roster of several pages', () => {
  /** Hands the recorded roster out a few learners at a time, the way the backend pages a long one. */
  const servePaged = (server, courseId, pageSize) =>
    server.on('GET', `/api/courses/${courseId}/enrollments`, async (request, respond) => {
      const roster = await respond().json();
      const page = Number(request.query.page);
      return json(200, {
        ...roster,
        items: roster.items.slice((page - 1) * pageSize, page * pageSize),
        page,
        pageSize,
        totalPages: Math.ceil(roster.total / pageSize),
      });
    });
  const rosterNames = () => tableRows(screen.getByTestId('roster-summary').parentElement).map((cells) => cells[0]);
  const pagination = () => screen.getByRole('navigation', { name: 'Pagination' });
  const pagesAskedFor = (server, courseId) => server.sent('GET', `/api/courses/${courseId}/enrollments`).map((request) => request.query.page);

  it('pages through the learners, and starts on page 1 again when another course is chosen', async () => {
    const server = startFakeServer();
    servePaged(server, 1, 2);
    servePaged(server, 2, 2);
    const { user } = await openBulkIssue({ server });
    await chooseCourse(user, 'Safety 101');

    expect(rosterNames()).toEqual(['Alex Lee', "Marcus O'Connor"]);
    expect(pagination().textContent).toContain('1–2 of 5 learners');
    expect(pagination().textContent).toContain('Page 1 of 3');
    expect(screen.getByTestId('eligible-count').textContent).toBe('2'); // the totals are about the whole course

    await user.click(within(pagination()).getByRole('button', { name: 'Next ›' }));
    await waitFor(() => expect(rosterNames()).toEqual(['Mei Chen', 'Priya Sharma']));
    expect(pagination().textContent).toContain('3–4 of 5 learners');
    await user.click(within(pagination()).getByRole('button', { name: 'Last »' }));
    await waitFor(() => expect(rosterNames()).toEqual(['Tom Walker']));
    expect(pagination().textContent).toContain('5–5 of 5 learners');
    expect(pagination().textContent).toContain('Page 3 of 3');
    expect(pagesAskedFor(server, 1)).toEqual(['1', '2', '3']);
    await rosterLoaded();
    expect(issueButton().textContent).toBe('Issue 2 certificates'); // paging changes nothing about what will be issued

    await user.selectOptions(screen.getByTestId('course-select'), 'First Aid Refresher');
    await waitFor(() => expect(rosterNames()).toEqual(['Alex Lee', 'José Álvarez']));
    expect(pagesAskedFor(server, 2)).toEqual(['1']); // not page 3 of a course that was never looked at
    expect(pagination().textContent).toContain('Page 1 of 3');
    expect(bulkIssuePosts(server)).toEqual([]);
  });
});

describe('Bulk issue: one submission, visible status', () => {
  it('sends exactly one POST for a double click and locks the form while the request is in flight', async () => {
    const server = startFakeServer();
    const gate = holdBulkIssue(server);
    const { user } = await openBulkIssue({ server });
    await chooseCourse(user, 'Safety 101');

    await user.dblClick(issueButton());
    fireEvent.click(issueButton()); // a third click while the request is on its way
    expect(bulkIssuePosts(server)).toHaveLength(1);

    expect(issueButton().disabled).toBe(true);
    expect(issueButton().textContent).toBe('Issuing…');
    expect(screen.getByTestId('course-select').disabled).toBe(true);
    expect(operationStatus().getAttribute('data-state')).toBe('submitting');
    expect(operationStatus().textContent).toBe(
      'Issuing certificates for Safety 101… Please wait; the button is locked until the server has answered.',
    );
    expect(screen.queryByTestId('operation-result')).toBeNull();

    gate.resolve();
    await screen.findByTestId('operation-result');
    expect(operationStatus().getAttribute('data-state')).toBe('succeeded');
    expect(screen.getByTestId('course-select').disabled).toBe(false);
    expect(bulkIssuePosts(server)).toHaveLength(1);
  });

  it('sends exactly one POST for Enter followed by a click', async () => {
    const server = startFakeServer();
    const gate = holdBulkIssue(server);
    const { user } = await openBulkIssue({ server });
    await chooseCourse(user, 'Safety 101');

    issueButton().focus();
    await user.keyboard('{Enter}');
    await user.click(issueButton());
    await user.keyboard('{Enter}');
    expect(bulkIssuePosts(server)).toHaveLength(1);
    expect(operationStatus().getAttribute('data-state')).toBe('submitting');

    gate.resolve();
    await screen.findByTestId('operation-result');
    expect(bulkIssuePosts(server)).toHaveLength(1);
  });

  it('sends the course, a fresh idempotency key and the actor', async () => {
    const { server, user } = await openBulkIssue();
    await chooseCourse(user, 'Safety 101');
    await user.click(issueButton());
    await screen.findByTestId('operation-result');

    const [post] = bulkIssuePosts(server);
    expect(post.actor).toBe(ALICE);
    expect(post.body).toEqual({ courseId: 1 });
    expect(post.headers['content-type']).toBe('application/json');
    expect(post.headers['idempotency-key']).toMatch(UUID);
  });
});

describe('Bulk issue: result', () => {
  it('shows the summary and the outcome of every learner: issued, or skipped with its reason', async () => {
    const { server, user } = await openBulkIssue();
    await chooseCourse(user, 'Safety 101');
    await user.click(issueButton());

    const panel = await screen.findByTestId('operation-result');
    expect(within(panel).getByRole('heading').textContent).toBe('Operation #1 · Safety 101');
    expect(panel.textContent).toContain(`requested by ${ALICE} · idempotency key ${idempotencyKeys(server)[0]}`);
    expect(summaryCounts()).toEqual(['2', '3', '0']);
    expect(screen.queryByTestId('operation-replayed')).toBeNull();

    const issued = Object.fromEntries(
      eastFirstRun.results.filter((result) => result.outcome === 'issued').map((result) => [result.learnerName, result]),
    );
    expect(tableRows(panel)).toEqual([
      ['Alex Lee', 'Skipped', 'Already certified (certificate EAST-0000001)'],
      ["Marcus O'Connor", 'Issued', `Certificate EAST-0000008 issued ${issued["Marcus O'Connor"].issuedLocal}`],
      ['Mei Chen', 'Skipped', 'Course not completed (enrollment is in progress)'],
      ['Priya Sharma', 'Issued', `Certificate EAST-0000009 issued ${issued['Priya Sharma'].issuedLocal}`],
      ['Tom Walker', 'Skipped', 'Course not completed (enrollment is not started)'],
    ]);
    expect(within(panel).getByRole('link', { name: 'EAST-0000008' }).getAttribute('href')).toBe(
      `#/certificates/${issued["Marcus O'Connor"].certificateId}`,
    );

    // the roster and the history show the new state
    await waitFor(() => expect(screen.getByTestId('eligible-count').textContent).toBe('0'));
    expect(issueButton().textContent).toBe('No eligible learners');
    expect(issueButton().disabled).toBe(true);
    const history = await screen.findByTestId('operation-history');
    expect(tableRows(history).map((cells) => [cells[0], cells[1], cells[3], cells[4], cells[5], cells[6]])).toEqual([
      ['#1', 'Safety 101', ALICE, '2', '3', '0'],
    ]);
    expect(bulkIssuePosts(server)).toHaveLength(1);
  });

  it('filters the outcomes and can be dismissed', async () => {
    const { user } = await openBulkIssue();
    await chooseCourse(user, 'Safety 101');
    await user.click(issueButton());
    const panel = await screen.findByTestId('operation-result');
    const chip = (name) => within(panel).getByRole('button', { name });

    expect(chip('All (5)').getAttribute('aria-pressed')).toBe('true');
    await user.click(chip('Issued (2)'));
    expect(tableRows(panel).map((cells) => cells[0])).toEqual(["Marcus O'Connor", 'Priya Sharma']);
    await user.click(chip('Skipped (3)'));
    expect(tableRows(panel).map((cells) => cells[1])).toEqual(['Skipped', 'Skipped', 'Skipped']);
    await user.click(chip('Failed (0)'));
    expect(within(panel).getByText('No learners with this outcome')).toBeTruthy();

    await user.click(within(panel).getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByTestId('operation-result')).toBeNull();
    expect(operationStatus().getAttribute('data-state')).toBe('idle');
  });

  it('shows the first 200 outcomes of a long result, and all of them on request', async () => {
    const server = startFakeServer();
    // 250 learners, every one a copy of a recorded outcome: here only the number of rows matters.
    const template = eastFirstRun.results.find((result) => result.outcome === 'skipped');
    const results = Array.from({ length: 250 }, (_, index) => ({ ...template, learnerId: 1000 + index, learnerName: `Learner ${index + 1}` }));
    server.once('POST', '/api/bulk-issues', async (_request, respond) => {
      const operation = await respond().json();
      return json(201, { ...operation, summary: { total: 250, issued: 0, skipped: 250, failed: 0 }, results });
    });
    const { user } = await openBulkIssue({ server });
    await chooseCourse(user, 'Safety 101');
    await user.click(issueButton());

    const panel = await screen.findByTestId('operation-result');
    expect(tableRows(panel)).toHaveLength(200);
    expect(panel.textContent).toContain('Showing the first 200 of 250 learners.');
    await user.click(within(panel).getByRole('button', { name: 'Show all' }));
    expect(tableRows(panel)).toHaveLength(250);
    expect(tableRows(panel).at(-1)[0]).toBe('Learner 250');
    expect(within(panel).queryByRole('button', { name: 'Show all' })).toBeNull();
    expect(panel.textContent).not.toContain('Showing the first');
  });

  it('reports a learner whose certificate could not be issued as failed, next to the others', async () => {
    const { server, user } = await openBulkIssue({ actor: BOB });
    await chooseCourse(user, 'Safety 101'); // West: its recorded run has one failing learner
    expect(issueButton().textContent).toBe('Issue 2 certificates');
    await user.click(issueButton());

    const panel = await screen.findByTestId('operation-result');
    expect(bulkIssuePosts(server)[0].actor).toBe(BOB);
    expect(bulkIssuePosts(server)[0].body).toEqual({ courseId: 4 });
    expect(summaryCounts()).toEqual(['1', '3', '1']);
    expect(tableRows(panel).map((cells) => [cells[0], cells[1]])).toEqual([
      ['Alex Lee', 'Skipped'],
      ['Emily Davis', 'Failed'],
      ['Grace Kim', 'Skipped'],
      ['Jordan Smith', 'Issued'],
      ['Noah Wilson', 'Skipped'],
    ]);
    // what the server said about this learner, word for word (taken from the recording, so that the
    // fixtures can be recorded again when the backend changes its wording)
    const failedLearner = westRunWithFailure.results.find((result) => result.outcome === 'failed');
    expect(failedLearner.message).toMatch(/could not be issued/i);
    expect(tableRows(panel)[1][2]).toBe(failedLearner.message);
    expect(tableRows(panel)[3][2]).toMatch(/^Certificate WEST-0000005 issued \d{4}-\d\d-\d\d \d\d:\d\d$/);
    expect(panel.textContent).toContain(
      '1 learner could not be certified. Everyone else was processed normally; start a new bulk issue to try the failed learner again.',
    );
    expect(westRunWithFailure.summary).toEqual({ total: 5, issued: 1, skipped: 3, failed: 1 }); // what the backend really sent

    await user.click(within(panel).getByRole('button', { name: 'Failed (1)' }));
    expect(tableRows(panel)).toEqual([['Emily Davis', 'Failed', failedLearner.message]]);
    // the failed learner is still eligible afterwards
    await waitFor(() => expect(issueButton().textContent).toBe('Issue 1 certificate'));
  });
});

describe('Bulk issue: when the answer is lost', () => {
  const expectUnknownOutcome = () => {
    expect(operationStatus().getAttribute('data-state')).toBe('failed');
    const alert = within(operationStatus()).getByRole('alert');
    expect(alert.textContent).toContain('The bulk issue for Safety 101 may or may not have gone through');
    expect(alert.textContent).toContain(
      'Retrying is safe: the request is repeated with the same idempotency key, so learners are never certified twice.',
    );
    expect(alert.textContent).not.toContain('was rejected');
    expect(screen.getByTestId('retry-button').textContent).toBe('Retry safely');
    expect(issueButton().disabled).toBe(true); // no second operation next to the undecided one
    return alert;
  };

  const retryAndExpectReplay = async (server, user) => {
    await user.click(screen.getByTestId('retry-button'));
    await screen.findByTestId('operation-result');
    expect(screen.getByTestId('operation-replayed').textContent).toContain(
      'The server recognised this request as a repeat of an earlier one and returned the stored result. Nothing was issued twice.',
    );
    expect(summaryCounts()).toEqual(['2', '3', '0']);
    const keys = idempotencyKeys(server);
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
    expect(bulkIssuePosts(server)[1].body).toEqual(bulkIssuePosts(server)[0].body);
    expect(server.tenant(ALICE).operations).toHaveLength(1); // one operation on the server, not two
  };

  it('network error: says the outcome is unknown, and "Retry safely" re-sends the same Idempotency-Key', async () => {
    const server = startFakeServer();
    loseAnswerOnce(server);
    const { user } = await openBulkIssue({ server });
    await chooseCourse(user, 'Safety 101');
    await user.click(issueButton());

    await waitFor(() => expect(operationStatus().getAttribute('data-state')).toBe('failed'));
    const alert = expectUnknownOutcome();
    expect(alert.textContent).toContain('The server could not be reached. Check that it is running, then try again.');
    await retryAndExpectReplay(server, user);
  });

  it('HTTP 500: unknown outcome, same key on retry, replay note', async () => {
    const server = startFakeServer();
    loseAnswerOnce(server, () => internalError());
    const { user } = await openBulkIssue({ server });
    await chooseCourse(user, 'Safety 101');
    await user.click(issueButton());

    await waitFor(() => expect(operationStatus().getAttribute('data-state')).toBe('failed'));
    expect(expectUnknownOutcome().textContent).toContain('Unexpected server error');
    await retryAndExpectReplay(server, user);
  });

  it('HTTP 502 from a gateway with an HTML body: unknown outcome', async () => {
    const server = startFakeServer();
    loseAnswerOnce(server, () => new Response('<h1>Bad gateway</h1>', { status: 502, headers: { 'Content-Type': 'text/html' } }));
    const { user } = await openBulkIssue({ server });
    await chooseCourse(user, 'Safety 101');
    await user.click(issueButton());

    await waitFor(() => expect(operationStatus().getAttribute('data-state')).toBe('failed'));
    expect(expectUnknownOutcome().textContent).toContain('The server answered with HTTP 502');
    await retryAndExpectReplay(server, user);
  });

  it('item B: a 201 whose JSON arrives truncated is an unknown outcome, never "was rejected"', async () => {
    const server = startFakeServer();
    const cutOff = JSON.stringify(eastFirstRun).slice(0, 60);
    loseAnswerOnce(server, () => new Response(cutOff, { status: 201, headers: { 'Content-Type': 'application/json' } }));
    const { user } = await openBulkIssue({ server });
    await chooseCourse(user, 'Safety 101');
    await user.click(issueButton());

    await waitFor(() => expect(operationStatus().getAttribute('data-state')).toBe('failed'));
    const alert = expectUnknownOutcome();
    expect(alert.textContent).toContain(
      'The answer from the server could not be read: the connection was interrupted or the response was incomplete.',
    );
    await retryAndExpectReplay(server, user);
  });

  it('item B: a 201 whose connection is cut after the headers is an unknown outcome', async () => {
    const server = startFakeServer();
    loseAnswerOnce(server, () => unreadableBody(201));
    const { user } = await openBulkIssue({ server });
    await chooseCourse(user, 'Safety 101');
    await user.click(issueButton());

    await waitFor(() => expect(operationStatus().getAttribute('data-state')).toBe('failed'));
    expect(expectUnknownOutcome().textContent).toContain('The answer from the server could not be read');
    await retryAndExpectReplay(server, user);
  });

  it('item D: a 201 with JSON of an unexpected shape is an unknown outcome as well', async () => {
    const server = startFakeServer();
    loseAnswerOnce(server, () => json(201, { foo: 1 }));
    const { user } = await openBulkIssue({ server });
    await chooseCourse(user, 'Safety 101');
    await user.click(issueButton());

    await waitFor(() => expect(operationStatus().getAttribute('data-state')).toBe('failed'));
    expect(expectUnknownOutcome().textContent).toContain('The server sent an answer that this console does not understand.');
    await retryAndExpectReplay(server, user);
  });

  it('item B: an exception that is not an ApiError is treated as an unknown outcome too', async () => {
    const server = startFakeServer();
    const calls = [];
    // Everything real except the request itself, which fails in a way nobody planned for.
    const api = {
      ...createApi(ALICE),
      bulkIssue: async (courseId, key) => {
        calls.push({ courseId, key });
        throw new TypeError("Cannot read properties of undefined (reading 'get')");
      },
    };
    const actor = recorded.actors.items.find((candidate) => candidate.email === ALICE);
    const user = userEvent.setup();
    render(<BulkIssuePage api={api} actor={actor} bulkIssues={createBulkIssueStore()} />);
    await chooseCourse(user, 'Safety 101');
    await user.click(issueButton());

    await waitFor(() => expect(operationStatus().getAttribute('data-state')).toBe('failed'));
    expect(expectUnknownOutcome().textContent).toContain("Cannot read properties of undefined (reading 'get')");
    await user.click(screen.getByTestId('retry-button'));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]).toEqual(calls[0]); // same course, same key
    expect(server.sent('POST', '/api/bulk-issues')).toEqual([]);
  });

  it('503 database_busy: says the bulk issue has not run yet; the retry keeps the key and then runs for the first time', async () => {
    const server = startFakeServer();
    server.once('POST', '/api/bulk-issues', () => errorAnswer(recorded.errors.databaseBusy));
    const { user } = await openBulkIssue({ server });
    await chooseCourse(user, 'Safety 101');
    await user.click(issueButton());

    await waitFor(() => expect(operationStatus().getAttribute('data-state')).toBe('failed'));
    const alert = within(operationStatus()).getByRole('alert');
    expect(alert.textContent).toContain('The bulk issue for Safety 101 has not run yet');
    expect(alert.textContent).toContain('The database is busy; retry the request shortly');
    expect(alert.textContent).not.toContain('may or may not');
    expect(issueButton().disabled).toBe(true);

    await user.click(screen.getByTestId('retry-button'));
    await screen.findByTestId('operation-result');
    expect(screen.queryByTestId('operation-replayed')).toBeNull(); // it really ran now, for the first time
    expect(summaryCounts()).toEqual(['2', '3', '0']);
    const keys = idempotencyKeys(server);
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
  });

  it('keeps the same key over several retries', async () => {
    const server = startFakeServer();
    server.once('POST', '/api/bulk-issues', () => errorAnswer(recorded.errors.databaseBusy));
    const { user } = await openBulkIssue({ server });
    await chooseCourse(user, 'Safety 101');
    await user.click(issueButton());
    await screen.findByTestId('retry-button');

    loseAnswerOnce(server);
    await user.click(screen.getByTestId('retry-button'));
    await waitFor(() => expect(operationStatus().textContent).toContain('may or may not have gone through'));
    await user.click(screen.getByTestId('retry-button'));
    await screen.findByTestId('operation-replayed');

    expect(new Set(idempotencyKeys(server)).size).toBe(1);
    expect(idempotencyKeys(server)).toHaveLength(3);
    expect(server.tenant(ALICE).operations).toHaveLength(1);
  });

  it.each([
    ['409', () => errorAnswer(recorded.errors.keyReused), 'was already used for a different request'],
    ['400', () => json(400, { error: { code: 'invalid_request', message: '"courseId" is required' } }), '"courseId" is required'],
    ['404', () => json(404, { error: { code: 'not_found', message: 'Course not found' } }), 'Course not found'],
  ])('HTTP %s: says the bulk issue was rejected, offers no retry, and the next attempt uses a new key', async (_status, rejection, message) => {
    const server = startFakeServer();
    server.once('POST', '/api/bulk-issues', rejection);
    const { user } = await openBulkIssue({ server });
    await chooseCourse(user, 'Safety 101');
    await user.click(issueButton());

    await waitFor(() => expect(operationStatus().getAttribute('data-state')).toBe('failed'));
    const alert = within(operationStatus()).getByRole('alert');
    expect(alert.textContent).toContain('The bulk issue for Safety 101 was rejected');
    expect(alert.textContent).toContain(message);
    expect(alert.textContent).not.toContain('Retrying is safe');
    expect(screen.queryByTestId('retry-button')).toBeNull();
    await rosterLoaded();
    expect(issueButton().disabled).toBe(false);

    await user.click(issueButton()); // a new attempt is a new operation
    await screen.findByTestId('operation-result');
    const keys = idempotencyKeys(server);
    expect(keys).toHaveLength(2);
    expect(keys[1]).toMatch(UUID);
    expect(keys[1]).not.toBe(keys[0]);
  });

  it('forgets the retry prompt when it is dismissed; the next attempt is a new operation with a new key', async () => {
    const server = startFakeServer();
    server.once('POST', '/api/bulk-issues', () => errorAnswer(recorded.errors.databaseBusy));
    const { user } = await openBulkIssue({ server });
    await chooseCourse(user, 'Safety 101');
    await user.click(issueButton());
    await screen.findByTestId('retry-button');

    await user.click(within(operationStatus()).getByRole('button', { name: 'Dismiss' }));
    expect(operationStatus().getAttribute('data-state')).toBe('idle');
    await rosterLoaded();
    await user.click(issueButton());
    await screen.findByTestId('operation-result');
    expect(new Set(idempotencyKeys(server)).size).toBe(2);
  });
});

describe('Bulk issue: the attempt survives in-app navigation (item A)', () => {
  const expectLocked = () => {
    expect(operationStatus().getAttribute('data-state')).toBe('submitting');
    expect(operationStatus().textContent).toContain('Issuing certificates for Safety 101…');
    expect(issueButton().disabled).toBe(true);
    expect(issueButton().textContent).toBe('Issuing…');
    expect(screen.getByTestId('course-select').disabled).toBe(true);
  };
  const backToBulkIssue = async (user) => {
    await openTab(user, 'Bulk issue');
    await screen.findByRole('heading', { name: 'Bulk issue certificates' });
  };

  it('item A: leaving the tab and coming back during a pending request keeps the lock, the status, the course and the key', async () => {
    const server = startFakeServer();
    const gate = holdBulkIssue(server);
    const { user } = await openBulkIssue({ server });
    await chooseCourse(user, 'Safety 101');
    await user.click(issueButton());
    expectLocked();

    await openTab(user, 'Certificates');
    await loadedRows();
    expect(screen.queryByTestId('operation-status')).toBeNull();

    await backToBulkIssue(user);
    expectLocked();
    await waitFor(() => expect(screen.getByTestId('course-select').value).toBe('1')); // the course of the attempt
    await rosterLoaded();
    expectLocked();
    fireEvent.click(issueButton()); // there is no way to submit a second time
    expect(bulkIssuePosts(server)).toHaveLength(1);

    gate.resolve();
    await screen.findByTestId('operation-result');
    expect(summaryCounts()).toEqual(['2', '3', '0']);
    expect(screen.getByTestId('course-select').disabled).toBe(false);
    await waitFor(() => expect(issueButton().textContent).toBe('No eligible learners')); // the roster was refreshed
    expect(tableRows(await screen.findByTestId('operation-history'))).toHaveLength(1);
    expect(bulkIssuePosts(server)).toHaveLength(1);
    expect(resultPanel().textContent).toContain(`idempotency key ${idempotencyKeys(server)[0]}`);
  });

  it('item A: a request that finishes while the admin is on another tab shows its result on return', async () => {
    const server = startFakeServer();
    const gate = holdBulkIssue(server);
    const { user } = await openBulkIssue({ server });
    await chooseCourse(user, 'Safety 101');
    await user.click(issueButton());

    await openTab(user, 'Certificates');
    await loadedRows();
    gate.resolve();
    await settle(); // answered while nobody is looking at the Bulk issue page

    await backToBulkIssue(user);
    await screen.findByTestId('operation-result');
    expect(operationStatus().getAttribute('data-state')).toBe('succeeded');
    expect(within(resultPanel()).getByRole('heading').textContent).toBe('Operation #1 · Safety 101');
    expect(summaryCounts()).toEqual(['2', '3', '0']);
    expect(screen.getByTestId('course-select').value).toBe('1');
    await waitFor(() => expect(issueButton().textContent).toBe('No eligible learners'));

    // choosing the same course "again", as a script replaying the old steps would, changes nothing
    await user.selectOptions(screen.getByTestId('course-select'), 'Safety 101');
    fireEvent.change(screen.getByTestId('course-select'), { target: { value: '1' } });
    expect(operationStatus().getAttribute('data-state')).toBe('succeeded');
    expect(screen.getByTestId('operation-result')).toBeTruthy();
    expect(bulkIssuePosts(server)).toHaveLength(1);
  });

  it('item A: a request that fails while the admin is away waits with "Retry safely" and the same key', async () => {
    const server = startFakeServer();
    const gate = deferred();
    server.once('POST', '/api/bulk-issues', async (_request, respond) => {
      await gate.promise;
      respond(); // executed ...
      throw networkError(); // ... but the answer is lost
    });
    const { user } = await openBulkIssue({ server });
    await chooseCourse(user, 'Safety 101');
    await user.click(issueButton());

    await openTab(user, 'Certificates');
    await loadedRows();
    gate.resolve();
    await settle();

    await backToBulkIssue(user);
    expect(operationStatus().textContent).toContain('The bulk issue for Safety 101 may or may not have gone through');
    await waitFor(() => expect(screen.getByTestId('course-select').value).toBe('1'));
    await rosterLoaded();
    expect(issueButton().disabled).toBe(true);

    await user.click(screen.getByTestId('retry-button'));
    await screen.findByTestId('operation-replayed');
    const keys = idempotencyKeys(server);
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
    expect(server.tenant(ALICE).operations).toHaveLength(1);
  });

  it('item A: following a serial link out of the page and coming back keeps the pending attempt', async () => {
    const server = startFakeServer();
    const gate = holdBulkIssue(server);
    const { user } = await openBulkIssue({ server });
    await chooseCourse(user, 'Safety 101');
    await user.click(issueButton());

    await user.click(screen.getByRole('link', { name: 'EAST-0000001' })); // Alex Lee's certificate in the roster
    expect((await screen.findByTestId('detail-serial')).textContent).toBe('EAST-0000001');

    await backToBulkIssue(user);
    expectLocked();
    expect(bulkIssuePosts(server)).toHaveLength(1);
    gate.resolve();
    await screen.findByTestId('operation-result');
    expect(bulkIssuePosts(server)).toHaveLength(1);
  });

  it('item A: a result on screen is still there after a tab round trip, until it is dismissed', async () => {
    const { server, user } = await openBulkIssue();
    await chooseCourse(user, 'Safety 101');
    await user.click(issueButton());
    await screen.findByTestId('operation-result');

    await openTab(user, 'Certificates');
    expect(await loadedRows()).toHaveLength(9); // the two new certificates are in the list
    await backToBulkIssue(user);
    expect(within(await screen.findByTestId('operation-result')).getByRole('heading').textContent).toBe('Operation #1 · Safety 101');

    await user.click(within(resultPanel()).getByRole('button', { name: 'Dismiss' }));
    await openTab(user, 'Certificates');
    await loadedRows();
    await backToBulkIssue(user);
    expect(screen.queryByTestId('operation-result')).toBeNull();
    expect(operationStatus().getAttribute('data-state')).toBe('idle');
    expect(screen.getByTestId('course-select').value).toBe('');
    expect(bulkIssuePosts(server)).toHaveLength(1);
  });

  it("item A: the attempt belongs to its actor - never shown as another tenant, still locked on return", async () => {
    const server = startFakeServer();
    const gate = holdBulkIssue(server);
    const { user } = await openBulkIssue({ server });
    await chooseCourse(user, 'Safety 101');
    await user.click(issueButton());
    expectLocked();

    await user.selectOptions(screen.getByTestId('actor-select'), BOB);
    await waitFor(() => expect(screen.getByTestId('tenant-name').textContent).toBe('West'));
    const select = screen.getByTestId('course-select');
    await waitFor(() => expect(select.disabled).toBe(false));
    expect(operationStatus().getAttribute('data-state')).toBe('idle'); // Bob sees nothing of Alice's operation
    expect(operationStatus().textContent).toBe('');
    expect(select.value).toBe('');
    expect([...select.options].map((option) => option.textContent)).toContain('Working at Heights');

    gate.resolve(); // Alice's request is answered while the console acts as Bob
    await settle();
    expect(screen.queryByTestId('operation-result')).toBeNull();
    expect(operationStatus().getAttribute('data-state')).toBe('idle');
    expect(await screen.findByText('No bulk issues have been run in this tenant yet')).toBeTruthy();

    await user.selectOptions(screen.getByTestId('actor-select'), ALICE);
    await screen.findByTestId('operation-result'); // back as Alice: her result
    expect(within(resultPanel()).getByRole('heading').textContent).toBe('Operation #1 · Safety 101');
    expect(bulkIssuePosts(server).map((request) => request.actor)).toEqual([ALICE]);
  });

  it('item A: switching the actor away and back during a pending request does not unlock the form', async () => {
    const server = startFakeServer();
    const gate = holdBulkIssue(server);
    const { user } = await openBulkIssue({ server });
    await chooseCourse(user, 'Safety 101');
    await user.click(issueButton());

    await user.selectOptions(screen.getByTestId('actor-select'), BOB);
    await waitFor(() => expect(screen.getByTestId('tenant-name').textContent).toBe('West'));
    await user.selectOptions(screen.getByTestId('actor-select'), ALICE);
    await waitFor(() => expect(screen.getByTestId('tenant-name').textContent).toBe('East'));

    expectLocked();
    await rosterLoaded();
    fireEvent.click(issueButton());
    expect(bulkIssuePosts(server)).toHaveLength(1);
    gate.resolve();
    await screen.findByTestId('operation-result');
    expect(bulkIssuePosts(server)).toHaveLength(1);
  });
});

describe('Bulk issue: two actors, each with an operation of their own (item A)', () => {
  it("item A: the other actor's own bulk issue leaves a pending attempt alone - still locked, same key, one POST", async () => {
    const server = startFakeServer();
    const gate = deferred();
    server.on('POST', '/api/bulk-issues', async (request, respond) => {
      if (request.actor === ALICE) await gate.promise; // East's request stays on its way
      return respond();
    });
    const { user } = await openBulkIssue({ server });
    await chooseCourse(user, 'Safety 101');
    await user.click(issueButton());
    expect(operationStatus().getAttribute('data-state')).toBe('submitting');

    // meanwhile, as Bob: a complete bulk issue in the other tenant
    await user.selectOptions(screen.getByTestId('actor-select'), BOB);
    await waitFor(() => expect(screen.getByTestId('tenant-name').textContent).toBe('West'));
    await chooseCourse(user, 'Safety 101');
    await user.click(issueButton());
    await screen.findByTestId('operation-result');
    expect(within(resultPanel()).getByRole('heading').textContent).toBe('Operation #3 · Safety 101');
    expect(summaryCounts()).toEqual(['1', '3', '1']);
    expect(bulkIssuePosts(server).map((request) => [request.actor, request.body.courseId])).toEqual([[ALICE, 1], [BOB, 4]]);

    // back as Alice: her request is still pending, and still hers
    await user.selectOptions(screen.getByTestId('actor-select'), ALICE);
    await waitFor(() => expect(screen.getByTestId('tenant-name').textContent).toBe('East'));
    expect(operationStatus().getAttribute('data-state')).toBe('submitting');
    expect(operationStatus().textContent).toContain('Issuing certificates for Safety 101…');
    expect(screen.queryByTestId('operation-result')).toBeNull(); // nothing of Bob's result here
    await waitFor(() => expect(screen.getByTestId('course-select').value).toBe('1'));
    expect(screen.getByTestId('course-select').disabled).toBe(true);
    await rosterLoaded();
    expect(issueButton().disabled).toBe(true);
    fireEvent.click(issueButton());
    expect(bulkIssuePosts(server)).toHaveLength(2); // no second POST for East

    gate.resolve();
    await screen.findByTestId('operation-result');
    expect(within(resultPanel()).getByRole('heading').textContent).toBe('Operation #1 · Safety 101');
    expect(summaryCounts()).toEqual(['2', '3', '0']);
    const [alicesKey, bobsKey] = idempotencyKeys(server);
    expect(resultPanel().textContent).toContain(`idempotency key ${alicesKey}`);
    expect(bobsKey).not.toBe(alicesKey);
    expect(bulkIssuePosts(server)).toHaveLength(2);

    // and Bob's result is still his when the console acts as Bob again
    await user.selectOptions(screen.getByTestId('actor-select'), BOB);
    await screen.findByTestId('operation-result');
    expect(within(resultPanel()).getByRole('heading').textContent).toBe('Operation #3 · Safety 101');
    expect(resultPanel().textContent).toContain(`idempotency key ${bobsKey}`);
  });
});

describe('Bulk issue: an attempt without a known outcome survives a page reload', () => {
  /** A full page load: everything in memory is gone; the tab, and with it its sessionStorage, is not. */
  const reload = (view, options) => {
    view.unmount();
    return openBulkIssue({ server: view.server, ...options });
  };
  const INTERRUPTED = 'The page was reloaded or left before the answer from the server arrived.';

  it.each([
    ['had carried the request out', true],
    ['had not started on the request yet', false],
  ])('brings a pending request back as "may or may not" with the same key when the server %s', async (_case, executed) => {
    const server = startFakeServer();
    server.once('POST', '/api/bulk-issues', (_request, respond) => {
      if (executed) respond();
      return new Promise(() => {}); // the page is reloaded before any answer arrives
    });
    const first = await openBulkIssue({ server });
    await chooseCourse(first.user, 'Safety 101');
    await first.user.click(issueButton());
    expect(operationStatus().getAttribute('data-state')).toBe('submitting');

    const { user } = await reload(first);
    expect(operationStatus().getAttribute('data-state')).toBe('failed'); // not an idle form
    const alert = within(operationStatus()).getByRole('alert');
    expect(alert.textContent).toContain('The bulk issue for Safety 101 may or may not have gone through');
    expect(alert.textContent).toContain(INTERRUPTED);
    expect(alert.textContent).toContain('Retrying is safe: the request is repeated with the same idempotency key');
    await waitFor(() => expect(screen.getByTestId('course-select').value).toBe('1')); // the course of the attempt
    await rosterLoaded();
    expect(screen.getByTestId('eligible-count').textContent).toBe(executed ? '0' : '2');
    expect(issueButton().disabled).toBe(true); // no new operation next to the undecided one
    fireEvent.click(issueButton());
    expect(bulkIssuePosts(server)).toHaveLength(1);

    await user.click(screen.getByTestId('retry-button'));
    await screen.findByTestId('operation-result');
    expect(summaryCounts()).toEqual(['2', '3', '0']);
    expect(screen.queryByTestId('operation-replayed') !== null).toBe(executed); // a replay only if it had run before
    const keys = idempotencyKeys(server);
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[0]).toMatch(UUID);
    expect(bulkIssuePosts(server)[1].body).toEqual({ courseId: 1 });
    expect(server.tenant(ALICE).operations).toHaveLength(1); // one operation for one intention
  });

  it('brings a retry prompt back with its wording and its key: an unknown outcome', async () => {
    const server = startFakeServer();
    loseAnswerOnce(server);
    const first = await openBulkIssue({ server });
    await chooseCourse(first.user, 'Safety 101');
    await first.user.click(issueButton());
    await screen.findByTestId('retry-button');
    const before = operationStatus().textContent;
    expect(before).toContain('may or may not have gone through');
    expect(before).toContain('The server could not be reached. Check that it is running, then try again.');

    const { user } = await reload(first);
    expect(operationStatus().textContent).toBe(before);
    await user.click(screen.getByTestId('retry-button'));
    await screen.findByTestId('operation-replayed');
    expect(new Set(idempotencyKeys(server)).size).toBe(1);
    expect(idempotencyKeys(server)).toHaveLength(2);
    expect(server.tenant(ALICE).operations).toHaveLength(1);
  });

  it('brings a retry prompt back with its wording and its key: a busy database', async () => {
    const server = startFakeServer();
    server.once('POST', '/api/bulk-issues', () => errorAnswer(recorded.errors.databaseBusy));
    const first = await openBulkIssue({ server });
    await chooseCourse(first.user, 'Safety 101');
    await first.user.click(issueButton());
    await screen.findByTestId('retry-button');

    const { user } = await reload(first);
    const alert = within(operationStatus()).getByRole('alert');
    expect(alert.textContent).toContain('The bulk issue for Safety 101 has not run yet');
    expect(alert.textContent).toContain('The database is busy; retry the request shortly');
    expect(alert.textContent).not.toContain('may or may not');
    await user.click(screen.getByTestId('retry-button'));
    await screen.findByTestId('operation-result');
    expect(screen.queryByTestId('operation-replayed')).toBeNull(); // it ran now, for the first time
    expect(new Set(idempotencyKeys(server)).size).toBe(1);
    expect(idempotencyKeys(server)).toHaveLength(2);
  });

  it('brings nothing back once the outcome is known: a result, a rejection, a dismissed prompt', async () => {
    const server = startFakeServer();
    let view = await openBulkIssue({ server });
    const expectFreshForm = () => {
      expect(operationStatus().getAttribute('data-state')).toBe('idle');
      expect(screen.getByTestId('course-select').value).toBe('');
      expect(screen.queryByTestId('operation-result')).toBeNull();
    };

    await chooseCourse(view.user, 'Safety 101');
    await view.user.click(issueButton());
    await screen.findByTestId('operation-result'); // a result: known
    view = await reload(view);
    expectFreshForm();
    expect(tableRows(await screen.findByTestId('operation-history'))).toHaveLength(1); // it is in the history

    server.once('POST', '/api/bulk-issues', () => json(404, { error: { code: 'not_found', message: 'Course not found' } }));
    server.tenant(ALICE).rosters[1] = recorded.tenants[ALICE].rosters[1]; // two learners to issue, as before the run
    await chooseCourse(view.user, 'Safety 101');
    await view.user.click(issueButton());
    await waitFor(() => expect(operationStatus().textContent).toContain('was rejected')); // a definite no: known
    view = await reload(view);
    expectFreshForm();

    server.once('POST', '/api/bulk-issues', () => errorAnswer(recorded.errors.databaseBusy));
    await chooseCourse(view.user, 'Safety 101');
    await view.user.click(issueButton());
    await screen.findByTestId('retry-button');
    await view.user.click(within(operationStatus()).getByRole('button', { name: 'Dismiss' })); // given up by the admin
    view = await reload(view);
    expectFreshForm();
    expect(window.sessionStorage.length).toBe(0);
  });

  it('brings the attempt back for its own actor only', async () => {
    const server = startFakeServer();
    server.once('POST', '/api/bulk-issues', () => new Promise(() => {}));
    const first = await openBulkIssue({ server });
    await chooseCourse(first.user, 'Safety 101');
    await first.user.click(issueButton());

    const { user } = await reload(first, { actor: BOB }); // the console comes back acting as Bob
    await waitFor(() => expect(screen.getByTestId('tenant-name').textContent).toBe('West'));
    await waitFor(() => expect(screen.getByTestId('course-select').disabled).toBe(false));
    expect(operationStatus().getAttribute('data-state')).toBe('idle'); // nothing of East's attempt as West
    expect(operationStatus().textContent).toBe('');
    expect(screen.getByTestId('course-select').value).toBe('');

    await user.selectOptions(screen.getByTestId('actor-select'), ALICE);
    await waitFor(() => expect(screen.getByTestId('tenant-name').textContent).toBe('East'));
    expect(operationStatus().textContent).toContain('The bulk issue for Safety 101 may or may not have gone through');
    await user.click(screen.getByTestId('retry-button'));
    await screen.findByTestId('operation-result');
    expect(bulkIssuePosts(server).map((request) => request.actor)).toEqual([ALICE, ALICE]);
    expect(new Set(idempotencyKeys(server)).size).toBe(1);
  });
});

describe('Bulk issue: recent operations', () => {
  it('lists earlier runs, newest first, and opens the outcomes of one of them', async () => {
    const server = startFakeServer();
    server.bulkIssue(ALICE, 1, 'earlier-run-1');
    server.bulkIssue(ALICE, 1, 'earlier-run-2');
    const { user } = await openBulkIssue({ server });

    const history = await screen.findByTestId('operation-history');
    expect(tableRows(history).map((cells) => cells.slice(0, 2).concat(cells.slice(4, 7)))).toEqual([
      ['#2', 'Safety 101', '0', '5', '0'],
      ['#1', 'Safety 101', '2', '3', '0'],
    ]);
    expect(within(history).getByRole('columnheader', { name: 'Started (Australia/Sydney)' })).toBeTruthy();

    await user.click(within(history.querySelectorAll('tbody tr')[1]).getByRole('button', { name: 'View outcomes' }));
    const panel = await screen.findByTestId('operation-result');
    expect(within(panel).getByRole('heading').textContent).toBe('Operation #1 · Safety 101');
    expect(panel.textContent).toContain('idempotency key earlier-run-1');
    expect(summaryCounts()).toEqual(['2', '3', '0']);
    expect(screen.queryByTestId('operation-replayed')).toBeNull();

    await user.click(within(panel).getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByTestId('operation-result')).toBeNull();
  });

  it('shows the error state when an operation cannot be loaded and retries', async () => {
    const server = startFakeServer();
    server.bulkIssue(ALICE, 1, 'earlier-run-1');
    server.once('GET', '/api/bulk-issues/1', () => internalError());
    const { user } = await openBulkIssue({ server });

    await user.click(await screen.findByRole('button', { name: 'View outcomes' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Operation #1 could not be loaded');
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(within(await screen.findByTestId('operation-result')).getByRole('heading').textContent).toBe('Operation #1 · Safety 101');
  });
});
