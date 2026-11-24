import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { loadedRows, openConsole, settle, tableRows } from './support/app.jsx';
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

const REVOKE_4 = '/api/certificates/4/revoke';
/**
 * Focus is moved by effects, and React runs those a moment after it has updated the page: once
 * `findBy...` has seen the new content, the focus may still be on its way.
 */
const expectFocusOn = (element) => waitFor(() => expect(document.activeElement).toBe(element()));
// The real stylesheet, for the one test about layout. (Vitest hands out CSS imports empty.)
const STYLES = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/styles.css'), 'utf8');

/** Opens the console on the deep link of a certificate and waits for the drawer. */
async function openCertificate(id, options) {
  const view = openConsole({ hash: `#/certificates/${id}`, ...options });
  await screen.findByRole('dialog', { name: 'Certificate details' });
  return view;
}

const detail = () => screen.getByTestId('certificate-detail');
const detailLoaded = () => screen.findByTestId('detail-serial');
const fields = () =>
  Object.fromEntries(
    [...detail().querySelectorAll('.detail-field')].map((field) => [field.querySelector('dt').textContent, field.querySelector('dd').textContent]),
  );
const auditTrail = () => [...screen.getByTestId('audit-trail').querySelectorAll('li')].map((entry) => entry.textContent);
const confirmation = () => screen.getByRole('dialog', { name: 'Revoke this certificate?' });
const queryConfirmation = () => screen.queryByRole('dialog', { name: 'Revoke this certificate?' });
/** Waits until the list behind the drawer shows `serial` with the given status label. */
const expectStatusInList = (serial, status) =>
  waitFor(() => {
    const row = tableRows(screen.getByTestId('certificate-list')).find((cells) => cells[0] === serial);
    expect(row?.[4]).toBe(status);
  });

/**
 * What a browser does when the focused control gets disabled: the focus drops to <body>. The
 * simulated DOM leaves it on the disabled control, so a test that depends on it says so with this.
 */
function dropFocusToBody() {
  const elsewhere = document.body.appendChild(document.createElement('button'));
  elsewhere.focus();
  elsewhere.blur();
  elsewhere.remove();
  expect(document.activeElement).toBe(document.body);
}

/** Runs `check` with the real stylesheet in place (the simulated DOM has no layout, but it has styles). */
async function withStyles(check) {
  const sheet = document.createElement('style');
  sheet.textContent = STYLES;
  document.head.append(sheet);
  try {
    return await check();
  } finally {
    sheet.remove();
  }
}

/** Opens certificate 4 (active) and the revoke confirmation on top of it. */
async function openRevokeConfirmation(options) {
  const view = await openCertificate(4, options);
  await detailLoaded();
  await view.user.click(screen.getByTestId('revoke-button'));
  return view;
}

describe('Certificate detail', () => {
  it('shows serial number, learner, course, the issue date in the tenant time zone, status and the audit trail', async () => {
    const { server } = await openCertificate(1);
    expect((await detailLoaded()).textContent).toBe('EAST-0000001');
    expect(screen.getByTestId('detail-status').textContent).toBe('Active');
    expect(screen.getByTestId('detail-issued-local').textContent).toBe('2026-01-11 00:30'); // 13:30 UTC on the 10th, in Sydney
    expect(fields()).toEqual({
      Learner: 'Alex Lee',
      Course: 'Safety 101',
      'Issue date (Australia/Sydney)': '2026-01-11 00:30 UTC+11:00UTC: 2026-01-10T13:30:00.000Z',
      'Issued by': ALICE,
    });
    expect(auditTrail()).toEqual([`Certificate issued by ${ALICE}2026-01-11 00:30 (Australia/Sydney)`]);
    expect(screen.getByTestId('revoke-button').textContent).toBe('Revoke certificate…');

    expect(server.sent('GET', '/api/certificates/1')).toHaveLength(1);
    expect(server.sent('GET', '/api/certificates/1')[0].actor).toBe(ALICE);
  });

  it("shows another tenant's certificate in that tenant's time zone", async () => {
    await openCertificate(8, { actor: BOB });
    expect((await detailLoaded()).textContent).toBe('WEST-0000001');
    // the same instant as EAST-0000001, three hours earlier on the clock in Perth
    expect(fields()['Issue date (Australia/Perth)']).toBe('2026-01-10 21:30 UTC+08:00UTC: 2026-01-10T13:30:00.000Z');
    expect(auditTrail()).toEqual([`Certificate issued by ${BOB}2026-01-10 21:30 (Australia/Perth)`]);
  });

  it('shows a revoked certificate with who revoked it, when and why - and without a revoke button', async () => {
    await openCertificate(2);
    expect((await detailLoaded()).textContent).toBe('EAST-0000002');
    expect(screen.getByTestId('detail-status').textContent).toBe('Revoked');
    expect(fields()).toMatchObject({
      'Revoked (Australia/Sydney)': '2026-03-02 12:00UTC: 2026-03-02T01:00:00.000Z',
      'Revoked by': ALICE,
      'Revocation reason': 'Issued in error: assessment was not signed off',
    });
    expect(auditTrail()).toEqual([
      `Certificate issued by ${ALICE}2026-02-15 09:15 (Australia/Sydney)`,
      `Certificate revoked by ${ALICE}2026-03-02 12:00 (Australia/Sydney) · reason: Issued in error: assessment was not signed off`,
    ]);
    expect(screen.queryByTestId('revoke-button')).toBeNull();
    expect(screen.queryByTestId('revoke-result')).toBeNull();
  });

  it('opens from a row of the list and closes again', async () => {
    const { user } = openConsole();
    await loadedRows();

    await user.click(screen.getByText('Priya Sharma'));
    expect(window.location.hash).toBe('#/certificates/5');
    const drawer = await screen.findByRole('dialog', { name: 'Certificate details' });
    expect((await detailLoaded()).textContent).toBe('EAST-0000005');
    expect(document.activeElement).toBe(drawer); // focus moves into the drawer
    expect(screen.getByText('Priya Sharma', { selector: 'td' }).closest('tr').className).toContain('row-selected');

    await user.click(screen.getByRole('button', { name: 'Close details' }));
    expect(window.location.hash).toBe('#/certificates');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    await user.click(screen.getByRole('link', { name: 'EAST-0000003' })); // the serial is a real link
    expect((await detailLoaded()).textContent).toBe('EAST-0000003');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(window.location.hash).toBe('#/certificates');
  });

  it.each([
    ['an unknown id', 999, ALICE],
    ["another tenant's id", 8, ALICE],
    ["another tenant's id (the other way round)", 1, BOB],
  ])('shows "Certificate not found" for %s', async (_case, id, actor) => {
    const { server } = await openCertificate(id, { actor });
    const alert = await within(detail()).findByRole('alert');
    expect(alert.textContent).toBe(
      '!Certificate not foundIt does not exist in this tenant. It may belong to another tenant or the link may be outdated.',
    );
    expect(within(detail()).queryByRole('button')).toBeNull(); // nothing to retry, nothing to revoke
    expect(screen.queryByTestId('detail-serial')).toBeNull();
    expect(server.sent('GET', `/api/certificates/${id}`).map((request) => request.actor)).toEqual([actor]);
  });

  it('opens no drawer for a link that is not a certificate id', async () => {
    openConsole({ hash: '#/certificates/abc' });
    await loadedRows();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows the error state when the certificate cannot be loaded and retries', async () => {
    const server = startFakeServer();
    server.once('GET', '/api/certificates/1', () => internalError());
    const { user } = await openCertificate(1, { server });

    const alert = await within(detail()).findByRole('alert');
    expect(alert.textContent).toContain('The certificate could not be loaded');
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect((await detailLoaded()).textContent).toBe('EAST-0000001');
  });

  it('closes the drawer on an actor switch instead of asking the other tenant for this id', async () => {
    const { server, user } = await openCertificate(1);
    await detailLoaded();
    await user.selectOptions(screen.getByTestId('actor-select'), BOB);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(window.location.hash).toBe('#/certificates');
    expect((await loadedRows()).every((cells) => cells[0].startsWith('WEST-'))).toBe(true);
    // Not even one that is cancelled a moment later: by then the server has been asked, and has
    // logged a lookup of another tenant's id under Bob's name.
    expect(server.sent('GET', '/api/certificates/1').filter((request) => request.actor === BOB)).toEqual([]);
  });
});

describe('Revocation', () => {
  it('asks for confirmation first: opening the dialog, Cancel and Escape send nothing', async () => {
    const { server, user } = await openRevokeConfirmation();
    const dialog = confirmation();
    expect(document.activeElement).toBe(dialog);
    expect(dialog.textContent).toContain(
      'EAST-0000004 was issued to José Álvarez for First Aid Refresher. After revocation it is no longer valid. ' +
        'This cannot be undone, and the action is recorded in the audit trail.',
    );
    expect(screen.getByTestId('revoke-confirm').textContent).toBe('Revoke certificate');

    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(queryConfirmation()).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Certificate details' })).toBeTruthy(); // the drawer stays

    await user.click(screen.getByTestId('revoke-button'));
    await user.type(screen.getByTestId('revoke-reason'), 'first line{Enter}second line'); // Enter is a line break here
    expect(screen.getByTestId('revoke-reason').value).toBe('first line\nsecond line');
    await user.keyboard('{Escape}'); // closes the confirmation only
    expect(queryConfirmation()).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Certificate details' })).toBeTruthy();
    expect(window.location.hash).toBe('#/certificates/4');

    await user.click(screen.getByTestId('revoke-button'));
    fireEvent.mouseDown(confirmation().parentElement); // a click on the backdrop
    expect(queryConfirmation()).toBeNull();

    expect(server.sent('POST', REVOKE_4)).toEqual([]);
    expect(screen.getByTestId('detail-status').textContent).toBe('Active');
    await expectStatusInList('EAST-0000004', 'Active');
  });

  it('revokes after confirming: one POST even for a double click, then drawer and list show the new state', async () => {
    const server = startFakeServer();
    const gate = deferred();
    server.on('POST', REVOKE_4, async (_request, respond) => {
      await gate.promise;
      return respond();
    });
    const { user } = await openRevokeConfirmation({ server });
    await loadedRows();
    const listRequests = server.sent('GET', '/api/certificates').length;

    await user.type(screen.getByTestId('revoke-reason'), '  Issued in error ');
    await user.dblClick(screen.getByTestId('revoke-confirm'));
    fireEvent.submit(screen.getByTestId('revoke-dialog')); // and Enter on top of it
    expect(server.sent('POST', REVOKE_4)).toHaveLength(1);

    // while the request is on its way the dialog is locked
    expect(screen.getByTestId('revoke-confirm').disabled).toBe(true);
    expect(screen.getByTestId('revoke-confirm').textContent).toBe('Revoking…');
    expect(within(confirmation()).getByRole('button', { name: 'Cancel' }).disabled).toBe(true);
    expect(screen.getByTestId('revoke-reason').disabled).toBe(true);
    await user.keyboard('{Escape}');
    expect(queryConfirmation()).not.toBeNull();
    fireEvent.mouseDown(confirmation().parentElement); // nor does a click on the backdrop close it now
    expect(queryConfirmation()).not.toBeNull();

    gate.resolve();
    const result = await screen.findByTestId('revoke-result');
    expect(result.textContent).toBe('The certificate has been revoked.');
    expect(queryConfirmation()).toBeNull();
    expect(screen.getByTestId('detail-status').textContent).toBe('Revoked');
    expect(screen.queryByTestId('revoke-button')).toBeNull();
    expect(fields()).toMatchObject({
      [`Revoked (Australia/Sydney)`]: `${recorded.revoke.response.revokedLocal}UTC: ${recorded.revoke.response.revokedAt}`,
      'Revoked by': ALICE,
      'Revocation reason': 'Issued in error',
    });
    expect(auditTrail()).toEqual([
      `Certificate issued by ${ALICE}2026-04-05 02:30 (Australia/Sydney)`,
      `Certificate revoked by ${ALICE}${recorded.revoke.response.revokedLocal} (Australia/Sydney) · reason: Issued in error`,
    ]);

    const [post] = server.sent('POST', REVOKE_4);
    expect(post.actor).toBe(ALICE);
    expect(post.body).toEqual({ reason: 'Issued in error' }); // trimmed
    expect(server.sent('POST', REVOKE_4)).toHaveLength(1);

    await expectStatusInList('EAST-0000004', 'Revoked');
    expect(server.sent('GET', '/api/certificates')).toHaveLength(listRequests + 1); // the list was reloaded once
  });

  it('shows a reason of several lines with its line breaks, in the drawer and in the audit trail', async () => {
    await withStyles(async () => {
      const { server, user } = await openRevokeConfirmation();
      await user.type(screen.getByTestId('revoke-reason'), 'Issued in error:{Enter}the assessment was not signed off');
      await user.click(screen.getByTestId('revoke-confirm'));
      await screen.findByTestId('revoke-result');
      expect(server.sent('POST', REVOKE_4)[0].body).toEqual({ reason: 'Issued in error:\nthe assessment was not signed off' });

      const shown = [...detail().querySelectorAll('.as-typed')];
      expect(shown.map((element) => element.textContent)).toEqual([
        'Issued in error:\nthe assessment was not signed off', // the "Revocation reason" field
        'Issued in error:\nthe assessment was not signed off', // the audit event
      ]);
      expect(shown[0].closest('.detail-field').querySelector('dt').textContent).toBe('Revocation reason');
      expect(screen.getByTestId('audit-trail').contains(shown[1])).toBe(true);
      // The line break is in the text; this is what makes the browser show it as one.
      for (const element of shown) expect(getComputedStyle(element).whiteSpace).toBe('pre-wrap');
    });
  });

  it('sends no reason when none was given', async () => {
    const { server, user } = await openRevokeConfirmation();
    await user.click(screen.getByTestId('revoke-confirm'));
    await screen.findByTestId('revoke-result');
    expect(server.sent('POST', REVOKE_4)[0].body).toEqual({});
    expect(fields()['Revocation reason']).toBe('No reason given');
  });

  it('says so when the certificate had already been revoked in the meantime', async () => {
    const { server, user } = await openRevokeConfirmation();
    server.revoke(ALICE, 4, 'Revoked from another window'); // someone else was faster
    await user.click(screen.getByTestId('revoke-confirm'));

    expect((await screen.findByTestId('revoke-result')).textContent).toBe('This certificate had already been revoked; nothing was changed.');
    expect(screen.getByTestId('detail-status').textContent).toBe('Revoked');
    expect(fields()['Revocation reason']).toBe('Revoked from another window');
    expect(auditTrail()).toHaveLength(2); // one issued, one revoked - not two
    expect(server.sent('POST', REVOKE_4)).toHaveLength(1);
    await expectStatusInList('EAST-0000004', 'Revoked');
  });

  it('starts afresh for every certificate: what happened to one is not carried over to the next one opened', async () => {
    const { user } = await openRevokeConfirmation();
    await user.click(screen.getByTestId('revoke-confirm'));
    expect((await screen.findByTestId('revoke-result')).textContent).toBe('The certificate has been revoked.');

    // another certificate is opened without closing the drawer first (a link, the Back button)
    act(() => {
      window.location.hash = '#/certificates/5';
    });
    await waitFor(() => expect(screen.getByTestId('detail-serial').textContent).toBe('EAST-0000005'));
    expect(screen.queryByTestId('revoke-result')).toBeNull(); // certificate 5 was not revoked
    expect(screen.getByTestId('detail-status').textContent).toBe('Active');
    expect(fields().Learner).toBe('Priya Sharma');

    // and an open confirmation does not survive the change either
    await user.click(screen.getByTestId('revoke-button'));
    expect(confirmation().textContent).toContain('EAST-0000005 was issued to Priya Sharma');
    act(() => {
      window.location.hash = '#/certificates/1';
    });
    await waitFor(() => expect(screen.getByTestId('detail-serial').textContent).toBe('EAST-0000001'));
    expect(queryConfirmation()).toBeNull();
  });

  const reasonTooLong = { error: { code: 'invalid_request', message: '"reason" must be at most 500 characters' } };
  it.each([
    ['503 database_busy (nothing was written)', () => errorAnswer(recorded.errors.databaseBusy), 'The database is busy; retry the request shortly'],
    ['a 400', () => json(400, reasonTooLong), '"reason" must be at most 500 characters'],
    ['a 404', () => errorAnswer(recorded.errors.notFound), 'Certificate not found'],
  ])('keeps "was not revoked" for a definite failure: %s', async (_case, failure, serverMessage) => {
    const server = startFakeServer();
    server.once('POST', REVOKE_4, failure);
    const { user } = await openRevokeConfirmation({ server });
    await loadedRows();
    const readsBefore = server.requests.filter((request) => request.method === 'GET').length;
    await user.type(screen.getByTestId('revoke-reason'), 'Duplicate');
    await user.click(screen.getByTestId('revoke-confirm'));

    const alert = await within(confirmation()).findByRole('alert');
    expect(alert.textContent).toBe(`The certificate was not revoked: ${serverMessage}`);
    expect(screen.queryByTestId('revoke-confirmed')).toBeNull();
    expect(screen.getByTestId('revoke-reason').value).toBe('Duplicate'); // what was typed is kept
    expect(screen.getByTestId('revoke-confirm').textContent).toBe('Try again');
    await settle();
    // the state is known (unchanged), so nothing is reloaded
    expect(server.requests.filter((request) => request.method === 'GET')).toHaveLength(readsBefore);
    expect(screen.getByTestId('detail-status').textContent).toBe('Active');

    await user.click(screen.getByTestId('revoke-confirm'));
    expect((await screen.findByTestId('revoke-result')).textContent).toBe('The certificate has been revoked.');
    expect(server.sent('POST', REVOKE_4).map((request) => request.body)).toEqual([{ reason: 'Duplicate' }, { reason: 'Duplicate' }]);
  });
});

describe('Revocation with an unknown outcome (item E)', () => {
  const expectUnknownOutcome = async () => {
    const alert = await within(confirmation()).findByRole('alert');
    expect(alert.textContent).toContain('The certificate may or may not have been revoked.');
    expect(alert.textContent).toContain('Trying again is safe: a certificate that is already revoked is left unchanged.');
    expect(alert.textContent).not.toContain('was not revoked');
    expect(screen.getByTestId('revoke-confirm').textContent).toBe('Try again');
    return alert;
  };

  /** The server revokes, but its answer to the next revoke request never arrives. */
  const loseAnswerOnce = (server, lostAnswer = () => { throw networkError(); }) =>
    server.once('POST', REVOKE_4, (_request, respond) => {
      respond();
      return lostAnswer();
    });

  /**
   * Keeps the reloads of certificate 4 waiting, so that a test can look at the console while the
   * outcome is still unknown. To be installed once the drawer has loaded. `release()` lets them through.
   */
  const holdReload = (server) => {
    const gate = deferred();
    server.on('GET', '/api/certificates/4', async (_request, respond) => {
      await gate.promise;
      return respond();
    });
    return { release: gate.resolve };
  };

  /** The dialog once the server has confirmed the revocation: a statement and "Close", nothing to retry. */
  const expectSettled = async () => {
    const dialog = await screen.findByRole('dialog', { name: 'Certificate revoked' });
    expect(screen.getByTestId('revoke-confirmed').textContent).toBe(
      'Checked with the server: this certificate is revoked now. Nothing more needs to be done.',
    );
    expect(dialog.getAttribute('aria-describedby')).toBe(screen.getByTestId('revoke-confirmed').id);
    expect(within(dialog).queryByRole('alert')).toBeNull(); // no "may or may not" next to "is revoked"
    expect(dialog.textContent).not.toContain('may or may not');
    expect(within(dialog).getAllByRole('button').map((button) => button.textContent)).toEqual(['Close']);
    expect(screen.queryByTestId('revoke-confirm')).toBeNull();
    expect(screen.queryByTestId('revoke-reason')).toBeNull();
    return dialog;
  };

  it('item E: a lost answer is reported as unknown, and drawer and list are refreshed to the real state (revoked)', async () => {
    const server = startFakeServer();
    loseAnswerOnce(server);
    const { user } = await openRevokeConfirmation({ server });
    await loadedRows();
    const reload = holdReload(server);
    await user.click(screen.getByTestId('revoke-confirm'));

    const alert = await expectUnknownOutcome();
    expect(alert.textContent).toContain('The server could not be reached. Check that it is running, then try again.');
    expect(screen.queryByTestId('revoke-confirmed')).toBeNull(); // nothing is known yet

    // behind the dialog the console asks the server what is true now
    reload.release();
    await waitFor(() => expect(screen.getByTestId('detail-status').textContent).toBe('Revoked'));
    expect(screen.queryByTestId('revoke-button')).toBeNull(); // no stale "Active" with a Revoke button
    expect(auditTrail()).toHaveLength(2);
    await expectStatusInList('EAST-0000004', 'Revoked');
    expect(server.sent('GET', '/api/certificates/4')).toHaveLength(2);

    // that settles it: the dialog says what is true now and offers nothing to retry
    const dialog = await expectSettled();
    expect(dialog.textContent).toContain('EAST-0000004 was issued to José Álvarez for First Aid Refresher.');
    await expectFocusOn(() => screen.getByTestId('revoke-close'));

    await user.click(screen.getByTestId('revoke-close'));
    expect(screen.queryByTestId('revoke-dialog')).toBeNull();
    expect(screen.getByTestId('detail-status').textContent).toBe('Revoked');
    expect(screen.queryByTestId('revoke-result')).toBeNull(); // that banner is for an answered request
    expect(server.sent('POST', REVOKE_4)).toHaveLength(1);
  });

  it('item E: trying again while the outcome is unknown is safe - the repeat finds the certificate revoked already', async () => {
    const server = startFakeServer();
    loseAnswerOnce(server);
    const { user } = await openRevokeConfirmation({ server });
    const reload = holdReload(server);
    await user.click(screen.getByTestId('revoke-confirm'));
    await expectUnknownOutcome();

    await user.click(screen.getByTestId('revoke-confirm'));
    expect((await screen.findByTestId('revoke-result')).textContent).toBe('This certificate had already been revoked; nothing was changed.');
    expect(queryConfirmation()).toBeNull();
    expect(screen.getByTestId('detail-status').textContent).toBe('Revoked');
    expect(server.sent('POST', REVOKE_4)).toHaveLength(2);
    expect(auditTrail()).toHaveLength(2); // one issued, one revoked - not two

    reload.release(); // the reload that was still on its way changes nothing any more
    await settle();
    expect(screen.getByTestId('revoke-result').textContent).toBe('This certificate had already been revoked; nothing was changed.');
    expect(screen.getByTestId('detail-status').textContent).toBe('Revoked');
    await expectStatusInList('EAST-0000004', 'Revoked');
  });

  it('item E: while the refresh is still running, the old copy is not shown as current - also after Cancel', async () => {
    const server = startFakeServer();
    loseAnswerOnce(server);
    const { user } = await openRevokeConfirmation({ server });
    await loadedRows();
    expect(detail().getAttribute('aria-busy')).toBe('false');
    const reload = holdReload(server);
    await user.click(screen.getByTestId('revoke-confirm'));
    await expectUnknownOutcome();

    const expectUnverified = () => {
      expect(screen.getByTestId('detail-status').textContent).toBe('Checking the current status…'); // not "Active"
      expect(within(screen.getByTestId('detail-status')).getByRole('status')).toBeTruthy();
      expect(screen.queryByTestId('revoke-button')).toBeNull();
      expect(detail().getAttribute('aria-busy')).toBe('true');
    };
    expectUnverified();
    await user.click(within(confirmation()).getByRole('button', { name: 'Cancel' }));
    expect(queryConfirmation()).toBeNull();
    expectUnverified(); // the admin is looking at the drawer now, and the answer is still out
    expect(screen.getByTestId('detail-serial').textContent).toBe('EAST-0000004');

    reload.release();
    await waitFor(() => expect(screen.getByTestId('detail-status').textContent).toBe('Revoked'));
    expect(detail().getAttribute('aria-busy')).toBe('false');
    expect(screen.queryByTestId('revoke-button')).toBeNull();
    expect(fields()['Revoked by']).toBe(ALICE);
    await expectStatusInList('EAST-0000004', 'Revoked');
  });

  it('item E: when the request never reached the server, the refresh shows it is still active and the retry revokes', async () => {
    const server = startFakeServer();
    server.once('POST', REVOKE_4, () => {
      throw networkError(); // nothing happened on the server
    });
    const { user } = await openRevokeConfirmation({ server });
    await user.type(screen.getByTestId('revoke-reason'), 'Wrong course');
    await user.click(screen.getByTestId('revoke-confirm'));

    await expectUnknownOutcome();
    await waitFor(() => expect(server.sent('GET', '/api/certificates/4')).toHaveLength(2));
    await settle();
    expect(screen.getByTestId('detail-status').textContent).toBe('Active');
    expect(detail().getAttribute('aria-busy')).toBe('false');
    expect(screen.getByTestId('revoke-button')).toBeTruthy(); // checked: it can be revoked
    await expectUnknownOutcome(); // still unknown from here; the dialog does not guess
    expect(screen.queryByTestId('revoke-confirmed')).toBeNull();
    expect(screen.getByTestId('revoke-reason').value).toBe('Wrong course');

    await user.click(screen.getByTestId('revoke-confirm'));
    expect((await screen.findByTestId('revoke-result')).textContent).toBe('The certificate has been revoked.');
    expect(fields()['Revocation reason']).toBe('Wrong course');
    await expectStatusInList('EAST-0000004', 'Revoked');
  });

  const UNREADABLE = 'The answer from the server could not be read';
  it.each([
    ['HTTP 500', () => internalError(), 'Unexpected server error'],
    ['a 200 whose body arrives truncated', () => new Response('{"id":4,"serialNumber":"EA', { status: 200 }), UNREADABLE],
    ['a 200 whose connection is cut after the headers', () => unreadableBody(200), UNREADABLE],
    ['a 200 with JSON of an unexpected shape', () => json(200, { foo: 1 }), 'The server sent an answer that this console does not understand.'],
  ])('item E: %s is an unknown outcome as well', async (_case, lostAnswer, message) => {
    const server = startFakeServer();
    loseAnswerOnce(server, lostAnswer);
    const { user } = await openRevokeConfirmation({ server });
    const reload = holdReload(server);
    await user.click(screen.getByTestId('revoke-confirm'));

    expect((await expectUnknownOutcome()).textContent).toContain(message);
    reload.release();
    await waitFor(() => expect(screen.getByTestId('detail-status').textContent).toBe('Revoked'));
    expect(screen.queryByTestId('revoke-button')).toBeNull();
    await expectStatusInList('EAST-0000004', 'Revoked');
    await expectSettled();
  });

  it('item E: when the refresh fails too, the dialog stays open, nothing claims "Active", and the retry still works', async () => {
    const server = startFakeServer();
    const { user } = await openRevokeConfirmation({ server });
    await loadedRows();
    await user.type(screen.getByTestId('revoke-reason'), 'Issued in error');

    // the network goes away: neither the revoke nor the reloads get an answer
    const backOnline = server.on('GET', /^\/api\/certificates/, () => {
      throw networkError();
    });
    server.once('POST', REVOKE_4, () => {
      throw networkError();
    });
    await user.click(screen.getByTestId('revoke-confirm'));

    await expectUnknownOutcome();
    await waitFor(() => expect(within(detail()).getByRole('alert').textContent).toContain('The certificate could not be loaded'));
    expect(screen.queryByTestId('detail-status')).toBeNull(); // no stale "Active" behind the dialog
    expect(screen.queryByTestId('revoke-button')).toBeNull();
    await waitFor(() => expect(screen.getByTestId('certificate-list').getAttribute('data-state')).toBe('error'));
    expect(queryConfirmation()).not.toBeNull(); // the dialog and what was typed survive the failed reload
    expect(screen.getByTestId('revoke-reason').value).toBe('Issued in error');
    expect(confirmation().textContent).toContain('EAST-0000004 was issued to José Álvarez');

    backOnline();
    await user.click(screen.getByTestId('revoke-confirm'));
    expect((await screen.findByTestId('revoke-result')).textContent).toBe('The certificate has been revoked.');
    expect(screen.getByTestId('detail-status').textContent).toBe('Revoked');
    await expectStatusInList('EAST-0000004', 'Revoked');
    expect(server.sent('POST', REVOKE_4).map((request) => request.body)).toEqual([{ reason: 'Issued in error' }, { reason: 'Issued in error' }]);
  });

  const reasonRejected = { error: { code: 'invalid_request', message: '"reason" contains characters that are not allowed' } };
  it.each([
    ['a 400', () => json(400, reasonRejected), '"reason" contains characters that are not allowed'],
    ['503 database_busy', () => errorAnswer(recorded.errors.databaseBusy), 'The database is busy; retry the request shortly'],
  ])('item E: after an unknown outcome, %s for the repeat is not reported as "was not revoked"', async (_case, definiteNo, serverMessage) => {
    const server = startFakeServer();
    loseAnswerOnce(server); // the first attempt revokes; its answer is lost
    const { user } = await openRevokeConfirmation({ server });
    await loadedRows();
    const reload = holdReload(server);
    await user.type(screen.getByTestId('revoke-reason'), 'Issued in error');
    await user.click(screen.getByTestId('revoke-confirm'));
    await expectUnknownOutcome();

    // the admin repeats the request, and this time the server says a definite no
    server.once('POST', REVOKE_4, definiteNo);
    await user.type(screen.getByTestId('revoke-reason'), ' - see page 2');
    await user.click(screen.getByTestId('revoke-confirm'));
    await waitFor(() => expect(within(confirmation()).getByRole('alert').textContent).toContain(serverMessage));

    // what the first attempt did is as open as before
    const alert = await expectUnknownOutcome();
    expect(alert.textContent).toContain(`This attempt was not carried out: ${serverMessage}`);
    expect(alert.textContent).toContain('An earlier attempt got no clear answer and may have gone through all the same.');
    expect(confirmation().textContent).not.toContain('was not revoked');
    expect(screen.getByTestId('detail-status').textContent).not.toBe('Active');
    // and the console asks the server again: the first load, the reload after the lost answer, and now a third
    await waitFor(() => expect(server.sent('GET', '/api/certificates/4')).toHaveLength(3));

    reload.release();
    const dialog = await expectSettled(); // the reload settles it: revoked, by the first attempt
    expect(dialog.textContent).toContain(`The last attempt was not carried out: ${serverMessage}`);
    expect(dialog.textContent).not.toContain('was not revoked');
    expect(screen.getByTestId('detail-status').textContent).toBe('Revoked');
    expect(fields()['Revocation reason']).toBe('Issued in error'); // what the first attempt sent
    await expectStatusInList('EAST-0000004', 'Revoked');
    expect(server.sent('POST', REVOKE_4)).toHaveLength(2);
  });

  it('item E: the outcome stays open when the dialog is closed and opened again - still no "was not revoked"', async () => {
    const server = startFakeServer();
    const queued = deferred();
    server.once('POST', REVOKE_4, async (_request, respond) => {
      queued.promise.then(respond); // the server gets to the request only later (it waits for the database)
      throw networkError(); // while the browser has long given up on the answer
    });
    const { user } = await openRevokeConfirmation({ server });
    await user.click(screen.getByTestId('revoke-confirm'));
    await expectUnknownOutcome();
    await waitFor(() => expect(screen.getByTestId('detail-status').textContent).toBe('Active')); // not carried out yet

    await user.click(within(confirmation()).getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByTestId('revoke-button')); // a new confirmation for the same certificate
    expect(within(confirmation()).queryByRole('alert')).toBeNull();
    queued.resolve(); // now the first request is carried out after all
    server.once('POST', REVOKE_4, () => json(400, reasonRejected));
    const reload = holdReload(server);
    await user.click(screen.getByTestId('revoke-confirm'));

    const alert = await expectUnknownOutcome(); // a 400 for this attempt says nothing about the first one
    expect(alert.textContent).toContain('This attempt was not carried out: "reason" contains characters that are not allowed');
    expect(confirmation().textContent).not.toContain('was not revoked');
    reload.release();
    await expectSettled(); // and the reload it triggers finds the certificate revoked
    expect(screen.getByTestId('detail-status').textContent).toBe('Revoked');
    expect(server.sent('POST', REVOKE_4)).toHaveLength(2);
  });

  it('item E: once the server has said "revoked" the dialog keeps saying so, also when a later reload fails', async () => {
    const server = startFakeServer();
    loseAnswerOnce(server);
    const { user } = await openRevokeConfirmation({ server });
    const reload = holdReload(server);
    await user.click(screen.getByTestId('revoke-confirm'));
    await expectUnknownOutcome();

    // the repeat is still on its way when the reload reports "revoked" ...
    const repeat = deferred();
    server.once('POST', REVOKE_4, async () => {
      await repeat.promise;
      throw networkError(); // ... and then it gets no answer either
    });
    await user.click(screen.getByTestId('revoke-confirm'));
    expect(screen.getByTestId('revoke-confirm').textContent).toBe('Revoking…');
    reload.release();
    await waitFor(() => expect(screen.getByTestId('detail-status').textContent).toBe('Revoked'));
    expect(screen.getByTestId('revoke-confirm').textContent).toBe('Revoking…'); // the form waits for its answer

    server.on('GET', '/api/certificates/4', () => {
      throw networkError(); // from here on the certificate cannot be reloaded
    });
    repeat.resolve();
    await expectSettled();
    await waitFor(() => expect(within(detail()).getByRole('alert').textContent).toContain('The certificate could not be loaded'));
    await expectSettled(); // revoking cannot be undone: a failed reload does not bring the question back
  });
});

describe('Dialogs are modal: only the top-most one can be operated', () => {
  const drawer = () => screen.getByRole('dialog', { name: 'Certificate details' });
  const inert = (element) => element.closest('[inert]') !== null;
  const topBar = () => document.querySelector('.topbar');
  const listPanel = () => screen.getByTestId('certificate-list').closest('section');

  it('keeps Tab and Shift+Tab inside the drawer and takes the page behind it out of reach', async () => {
    const { user } = await openCertificate(4);
    await detailLoaded();
    expect(document.activeElement).toBe(drawer());
    expect(inert(topBar())).toBe(true); // tabs and the actor switcher
    expect(inert(listPanel())).toBe(true); // search, table links, export
    expect(inert(drawer())).toBe(false);
    screen.getByTestId('search-input').focus(); // nothing behind the drawer takes the focus
    expect(document.activeElement).toBe(drawer());

    const close = within(drawer()).getByRole('button', { name: 'Close details' });
    const revoke = screen.getByTestId('revoke-button');
    await user.tab();
    expect(document.activeElement).toBe(close);
    await user.tab();
    expect(document.activeElement).toBe(revoke);
    await user.tab(); // past the last control: around to the first one, not on to the top bar
    expect(document.activeElement).toBe(close);
    await user.tab({ shift: true }); // and backwards: to the last one, not into the table behind
    expect(document.activeElement).toBe(revoke);

    drawer().focus(); // where the focus is right after opening
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(revoke);

    dropFocusToBody(); // wherever the focus got lost to: the next Tab leads back in
    await user.tab();
    expect(document.activeElement).toBe(close);
    dropFocusToBody();
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(revoke);

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.querySelector('[inert]')).toBeNull(); // the page is back in reach
    screen.getByTestId('search-input').focus();
    expect(document.activeElement).toBe(screen.getByTestId('search-input'));
  });

  it('returns the focus to the link that opened the drawer, which is out of reach while the drawer is open', async () => {
    const { user } = openConsole();
    await loadedRows();
    const link = screen.getByRole('link', { name: 'EAST-0000003' });
    await user.click(link);
    await detailLoaded();
    expect(document.activeElement).toBe(drawer());
    expect(inert(link)).toBe(true);

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(inert(link)).toBe(false); // in the same step as the drawer goes
    await expectFocusOn(() => link); // the keyboard continues where it left the list
  });

  it('keeps Tab inside the confirmation; the drawer underneath is out of reach until it closes', async () => {
    const { user } = await openRevokeConfirmation();
    const dialog = confirmation();
    expect(document.activeElement).toBe(dialog);
    expect(inert(drawer())).toBe(true);
    expect(inert(topBar())).toBe(true);
    expect(inert(listPanel())).toBe(true);
    expect(inert(dialog)).toBe(false);

    const reason = screen.getByTestId('revoke-reason');
    const cancel = within(dialog).getByRole('button', { name: 'Cancel' });
    const confirm = screen.getByTestId('revoke-confirm');
    await user.tab();
    expect(document.activeElement).toBe(reason);
    await user.tab();
    expect(document.activeElement).toBe(cancel);
    await user.tab();
    expect(document.activeElement).toBe(confirm);
    await user.tab(); // not on to <body> and the tabs of the page
    expect(document.activeElement).toBe(reason);
    await user.tab({ shift: true }); // not back to the drawer's buttons
    expect(document.activeElement).toBe(confirm);

    await user.keyboard('{Escape}'); // closes the confirmation only
    expect(queryConfirmation()).toBeNull();
    expect(inert(drawer())).toBe(false); // the drawer is the top-most dialog again ...
    expect(document.activeElement).toBe(screen.getByTestId('revoke-button'));
    expect(inert(topBar())).toBe(true); // ... and the page behind it still is not
    expect(inert(listPanel())).toBe(true);
    await user.tab();
    expect(document.activeElement).toBe(within(drawer()).getByRole('button', { name: 'Close details' }));

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.querySelector('[inert]')).toBeNull();
  });

  it('a confirmation whose request is in flight cannot be left or closed from the keyboard, the drawer behind it included', async () => {
    const server = startFakeServer();
    const gate = deferred();
    server.once('POST', REVOKE_4, async (_request, respond) => {
      await gate.promise;
      return respond();
    });
    const { user } = await openRevokeConfirmation({ server });
    await user.click(screen.getByTestId('revoke-confirm'));
    expect(screen.getByTestId('revoke-confirm').disabled).toBe(true);
    dropFocusToBody(); // as in a browser: the button that was clicked is disabled now

    // What used to work: Shift+Tab, Shift+Tab reached "Close details" of the drawer, and Enter
    // pressed it - drawer and confirmation gone, and nobody told how the revocation ended.
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(confirmation()); // every control is disabled: the focus rests on the dialog
    await user.tab({ shift: true });
    await user.keyboard('{Enter}');
    await user.tab();
    await user.tab();
    expect(document.activeElement).toBe(confirmation());
    await user.keyboard('{Enter}');
    await user.keyboard('{Escape}');
    expect(queryConfirmation()).not.toBeNull();
    expect(drawer()).toBeTruthy();
    expect(inert(drawer())).toBe(true);
    expect(window.location.hash).toBe('#/certificates/4');

    gate.resolve();
    expect((await screen.findByTestId('revoke-result')).textContent).toBe('The certificate has been revoked.');
    expect(queryConfirmation()).toBeNull();
    expect(inert(drawer())).toBe(false);
    expect(server.sent('POST', REVOKE_4)).toHaveLength(1);
  });

  it("leaving with the browser's Back button while a revocation is in flight does not cancel it: the list shows how it ended", async () => {
    const server = startFakeServer();
    const gate = deferred();
    server.once('POST', REVOKE_4, async (_request, respond) => {
      await gate.promise;
      return respond();
    });
    await openRevokeConfirmation({ server });
    await loadedRows();
    fireEvent.click(screen.getByTestId('revoke-confirm'));
    expect(screen.getByTestId('revoke-confirm').disabled).toBe(true);
    await expectStatusInList('EAST-0000004', 'Active');

    act(() => {
      window.location.hash = '#/certificates'; // nothing on the page closes the locked confirmation; the browser can
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.querySelector('[inert]')).toBeNull();
    expect(server.sent('POST', REVOKE_4)).toHaveLength(1); // on its way, and not taken back

    gate.resolve();
    await expectStatusInList('EAST-0000004', 'Revoked'); // the list was reloaded when the answer came
    expect(screen.queryByRole('dialog')).toBeNull(); // and nothing pops up again
  });

  it('gives the page back when a deep link is left with both dialogs open - in the same step, not a moment later', async () => {
    await openRevokeConfirmation();
    expect(document.querySelectorAll('[inert]').length).toBeGreaterThan(0);
    // How much of the page is still inert at the moment a dialog leaves it?
    const inertWhenDialogLeft = [];
    const watcher = new MutationObserver((records) => {
      const dialogsRemoved = records.flatMap((record) => [...record.removedNodes]).filter((node) => node.nodeType === 1 && node.querySelector('[role="dialog"]'));
      if (dialogsRemoved.length > 0) inertWhenDialogLeft.push(document.querySelectorAll('[inert]').length);
    });
    watcher.observe(document.body, { childList: true, subtree: true });
    try {
      act(() => {
        window.location.hash = '#/certificates'; // the browser's Back button
      });
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    } finally {
      watcher.disconnect();
    }
    expect(document.querySelector('[inert]')).toBeNull();
    // Once the last dialog is out of the page nothing is inert any more: there is no moment in
    // which the page has no dialog and still refuses every key and click.
    expect(inertWhenDialogLeft.length).toBeGreaterThan(0);
    expect(inertWhenDialogLeft.at(-1)).toBe(0);
  });
});

describe('Revoke dialog: focus and layout', () => {
  const drawer = () => screen.getByRole('dialog', { name: 'Certificate details' });

  it('hands the focus to the drawer when the dialog closes and the button that opened it is gone', async () => {
    const { user } = await openRevokeConfirmation();
    expect(document.activeElement).toBe(confirmation());
    await user.click(screen.getByTestId('revoke-confirm'));
    await screen.findByTestId('revoke-result');

    expect(queryConfirmation()).toBeNull();
    expect(screen.queryByTestId('revoke-button')).toBeNull(); // revoked: nothing to return the focus to
    await expectFocusOn(drawer); // not <body>, from where the next Tab would leave the drawer
  });

  it('returns the focus to the Revoke button when the dialog is cancelled', async () => {
    const { user } = await openRevokeConfirmation();
    await user.keyboard('{Escape}');
    expect(document.activeElement).toBe(screen.getByTestId('revoke-button'));
  });

  it('returns the focus to the Revoke button also when a reload behind the dialog has replaced it', async () => {
    const server = startFakeServer();
    server.once('POST', REVOKE_4, () => {
      throw networkError(); // not carried out: the reload will show the certificate active, with a new button
    });
    const { user } = await openRevokeConfirmation({ server });
    const opener = screen.getByTestId('revoke-button');
    await user.click(screen.getByTestId('revoke-confirm'));
    await within(confirmation()).findByRole('alert');
    await waitFor(() => expect(screen.getByTestId('detail-status').textContent).toBe('Active'));
    expect(screen.getByTestId('revoke-button')).not.toBe(opener); // it was taken away while the status was checked

    await user.keyboard('{Escape}');
    expect(queryConfirmation()).toBeNull();
    await expectFocusOn(() => screen.getByTestId('revoke-button'));
  });

  it('keeps the focus in the drawer when the dialog is cancelled while the status is still being checked', async () => {
    const server = startFakeServer();
    server.once('POST', REVOKE_4, () => {
      throw networkError();
    });
    const { user } = await openRevokeConfirmation({ server });
    const reload = deferred();
    server.on('GET', '/api/certificates/4', async (_request, respond) => {
      await reload.promise;
      return respond();
    });
    await user.click(screen.getByTestId('revoke-confirm'));
    await within(confirmation()).findByRole('alert');
    await user.click(within(confirmation()).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByTestId('revoke-button')).toBeNull(); // nothing to return the focus to yet
    await expectFocusOn(drawer);

    reload.resolve();
    await screen.findByTestId('revoke-button');
    await settle();
    expect(document.activeElement).toBe(drawer()); // and the focus is not moved again behind the admin's back
  });

  it('after an unknown outcome that turned out revoked: focus on "Close", then on the drawer', async () => {
    const server = startFakeServer();
    server.once('POST', REVOKE_4, (_request, respond) => {
      respond();
      return internalError();
    });
    const { user } = await openRevokeConfirmation({ server });
    await user.click(screen.getByTestId('revoke-confirm'));

    await screen.findByRole('dialog', { name: 'Certificate revoked' });
    await expectFocusOn(() => screen.getByTestId('revoke-close'));
    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('revoke-dialog')).toBeNull();
    await expectFocusOn(drawer);
    await user.keyboard('{Escape}'); // and from there Escape closes the drawer as usual
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('brings the focus back into the dialog when a failed request has cost the button its focus', async () => {
    const server = startFakeServer();
    const gate = deferred();
    server.once('POST', REVOKE_4, async () => {
      await gate.promise;
      return json(400, { error: { code: 'invalid_request', message: '"reason" must be at most 500 characters' } });
    });
    const { user } = await openRevokeConfirmation({ server });
    await user.click(screen.getByTestId('revoke-confirm'));
    expect(screen.getByTestId('revoke-confirm').disabled).toBe(true);
    // A browser takes the focus away from a button that gets disabled and leaves it on <body>,
    // behind the dialog.
    dropFocusToBody();

    gate.resolve();
    await within(confirmation()).findByRole('alert');
    await expectFocusOn(() => screen.getByTestId('revoke-confirm')); // "Try again"
  });

  it('leaves the focus where the admin put it inside the dialog', async () => {
    const server = startFakeServer();
    const gate = deferred();
    server.once('POST', REVOKE_4, async () => {
      await gate.promise;
      return json(400, { error: { code: 'invalid_request', message: '"reason" must be at most 500 characters' } });
    });
    const { user } = await openRevokeConfirmation({ server });
    await user.click(screen.getByTestId('revoke-confirm'));
    confirmation().focus(); // e.g. Safari, which does not focus a button on a click
    gate.resolve();
    await within(confirmation()).findByRole('alert');
    await settle(); // whatever was going to move the focus has done so by now
    expect(document.activeElement).toBe(confirmation());
  });

  it('keeps title and buttons outside the part that scrolls, and the dialog inside the screen', async () => {
    // The simulated DOM has no layout, so this pins what the layout is built on: the dialog is never
    // taller than the overlay, and only the middle part - text, field, message - scrolls.
    const sheet = document.createElement('style');
    sheet.textContent = STYLES;
    document.head.append(sheet);
    try {
      const server = startFakeServer();
      server.once('POST', REVOKE_4, () => {
        throw networkError();
      });
      const { user } = await openRevokeConfirmation({ server });
      await user.click(screen.getByTestId('revoke-confirm'));
      const alert = await within(confirmation()).findByRole('alert');

      const dialog = confirmation();
      const scrolling = dialog.querySelector('.dialog-scroll');
      expect(getComputedStyle(dialog).maxHeight).toBe('100%');
      expect(getComputedStyle(dialog).display).toBe('flex');
      expect(getComputedStyle(dialog).flexDirection).toBe('column');
      expect(getComputedStyle(screen.getByTestId('revoke-dialog')).minHeight).toBe('0'); // may shrink, so that ...
      expect(getComputedStyle(scrolling).overflowY).toBe('auto'); // ... this part scrolls
      expect(getComputedStyle(dialog.parentElement).position).toBe('fixed'); // the overlay spans the screen

      expect(scrolling.contains(alert)).toBe(true);
      expect(scrolling.contains(screen.getByTestId('revoke-reason'))).toBe(true);
      expect(scrolling.contains(screen.getByRole('heading', { name: 'Revoke this certificate?' }))).toBe(false);
      for (const button of within(dialog).getAllByRole('button')) expect(scrolling.contains(button)).toBe(false);
    } finally {
      sheet.remove();
    }
  });

  it('scrolls the message of a failed attempt into view', async () => {
    const scrolled = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function scrollIntoView(options) {
      scrolled.push([this.getAttribute('role'), options]);
    };
    try {
      const server = startFakeServer();
      server.once('POST', REVOKE_4, () => json(400, { error: { code: 'invalid_request', message: 'bad reason' } }));
      const { user } = await openRevokeConfirmation({ server });
      await user.click(screen.getByTestId('revoke-confirm'));
      await within(confirmation()).findByRole('alert');
      await waitFor(() => expect(scrolled).toEqual([['alert', { block: 'nearest' }]]));
      await settle();
      expect(scrolled).toHaveLength(1); // once per message, not on every render
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });
});
