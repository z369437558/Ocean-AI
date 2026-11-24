import { useState } from 'react';

import { writeOutcome } from '../api.js';
import { useBulkIssue } from '../bulkIssueStore.js';
import { useQuery } from '../hooks.js';
import { EmptyState, ErrorState, OutcomeBadge, Pagination, Spinner, StatusBadge } from './ui.jsx';

const ENROLLMENT_LABELS = { not_started: 'Not started', in_progress: 'In progress', completed: 'Completed' };
const RESULT_PREVIEW_ROWS = 200;

/** One key per user-initiated operation; a retry of that operation re-sends the same key. */
function newIdempotencyKey() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // crypto.randomUUID needs a secure context; getRandomValues works on plain http://host:port too.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function OperationResult({ operation, replayed, onDismiss, headingId = 'result-heading' }) {
  const [filter, setFilter] = useState('all');
  const [showAll, setShowAll] = useState(false);
  const { summary } = operation;
  const matching = filter === 'all' ? operation.results : operation.results.filter((result) => result.outcome === filter);
  const visible = showAll ? matching : matching.slice(0, RESULT_PREVIEW_ROWS);

  return (
    <section className="panel" aria-labelledby={headingId} data-testid="operation-result">
      <div className="panel-header">
        <div>
          <h2 id={headingId}>
            Operation #{operation.id} · {operation.course.title}
          </h2>
          <p className="muted">
            <span className="badge badge-active">Completed</span> requested by {operation.requestedBy} · idempotency key{' '}
            <span className="mono small">{operation.idempotencyKey ?? 'none'}</span>
          </p>
        </div>
        <button type="button" className="btn btn-small" onClick={onDismiss}>
          Dismiss
        </button>
      </div>

      {replayed ? (
        <p className="note" data-testid="operation-replayed">
          The server recognised this request as a repeat of an earlier one and returned the stored result. Nothing was
          issued twice.
        </p>
      ) : null}

      <div className="tiles" data-testid="operation-summary">
        <div className="tile tile-issued">
          <span className="tile-value" data-testid="summary-issued">
            {summary.issued}
          </span>
          <span className="tile-label">Issued</span>
        </div>
        <div className="tile tile-skipped">
          <span className="tile-value" data-testid="summary-skipped">
            {summary.skipped}
          </span>
          <span className="tile-label">Skipped</span>
        </div>
        <div className="tile tile-failed">
          <span className="tile-value" data-testid="summary-failed">
            {summary.failed}
          </span>
          <span className="tile-label">Failed</span>
        </div>
      </div>

      {summary.failed > 0 ? (
        <p className="note note-error">
          {summary.failed} learner{summary.failed === 1 ? '' : 's'} could not be certified. Everyone else was processed
          normally; start a new bulk issue to try the failed learner{summary.failed === 1 ? '' : 's'} again.
        </p>
      ) : null}

      <div className="chips" role="group" aria-label="Filter outcomes">
        {[
          ['all', `All (${summary.total})`],
          ['issued', `Issued (${summary.issued})`],
          ['skipped', `Skipped (${summary.skipped})`],
          ['failed', `Failed (${summary.failed})`],
        ].map(([value, label]) => (
          <button
            key={value}
            type="button"
            className={filter === value ? 'chip chip-active' : 'chip'}
            aria-pressed={filter === value}
            onClick={() => setFilter(value)}
          >
            {label}
          </button>
        ))}
      </div>

      {matching.length === 0 ? (
        <EmptyState title="No learners with this outcome" />
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Learner</th>
                <th scope="col">Outcome</th>
                <th scope="col">Details</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((result) => (
                <tr key={result.learnerId} data-outcome={result.outcome}>
                  <td>{result.learnerName}</td>
                  <td>
                    <OutcomeBadge outcome={result.outcome} />
                  </td>
                  <td>
                    {result.outcome === 'issued' ? (
                      <>
                        Certificate{' '}
                        <a className="mono" href={`#/certificates/${result.certificateId}`}>
                          {result.serialNumber}
                        </a>{' '}
                        issued {result.issuedLocal}
                      </>
                    ) : (
                      result.message
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {matching.length > visible.length ? (
        <p className="muted">
          Showing the first {visible.length.toLocaleString('en-US')} of {matching.length.toLocaleString('en-US')} learners.{' '}
          <button type="button" className="link" onClick={() => setShowAll(true)}>
            Show all
          </button>
        </p>
      ) : null}
    </section>
  );
}

export default function BulkIssuePage({ api, actor, bulkIssues }) {
  // run: idle | submitting | succeeded | failed. `attempt` = { courseId, courseTitle, key }.
  // The run, its key and the in-flight lock live in the store above the routed pages, so they are
  // still there when this page is left and opened again (see bulkIssueStore.js).
  const { run, settled } = useBulkIssue(bulkIssues, actor.email);

  const courses = useQuery((signal) => api.listCourses(signal), [api]);
  // `settled` moves whenever a bulk issue of this actor finishes - also one that was started
  // before this page was (re)opened - so the history and the roster below are fetched again.
  const operations = useQuery((signal) => api.listOperations(signal), [api, settled]);

  // Coming back to a run that is pending or still on display: start on the course it is about.
  const [courseId, setCourseId] = useState(() => (run.status === 'idle' ? '' : String(run.attempt.courseId)));
  const [rosterPage, setRosterPage] = useState(1);
  // Every roster is kept together with the value of `settled` it was asked for (not the value at
  // the time its answer arrives): that is how the page tells a roster that reflects the last bulk
  // issue from one that was requested before it finished.
  const roster = useQuery(
    (signal) =>
      courseId
        ? api.getRoster(courseId, rosterPage, signal).then((data) => ({ data, loadedFor: settled }))
        : Promise.resolve(null),
    [api, courseId, rosterPage, settled],
  );

  // A past operation opened from the history. Loading it through useQuery cancels the request of
  // an earlier choice, so a slow answer can never replace the operation that was selected last.
  const [viewedId, setViewedId] = useState(null);
  const viewed = useQuery(
    (signal) => (viewedId === null ? Promise.resolve(null) : api.getOperation(viewedId, signal)),
    [api, viewedId],
  );

  const selectedCourse = courses.data?.find((course) => String(course.id) === courseId) ?? null;
  const rosterLoaded = roster.status !== 'error' && roster.data?.data.course.id === selectedCourse?.id ? roster.data : null;
  const rosterData = rosterLoaded?.data ?? null;
  // The answer to a bulk issue and the roster it has changed do not arrive together: the store
  // reports the result (and moves `settled`) in one render, the roster starts to reload after it.
  // Until that reload is back the numbers on screen describe the time before the run, and a click
  // on "Issue 2 certificates" would send them again as a second operation under a new key.
  const rosterOutdated = rosterLoaded !== null && rosterLoaded.loadedFor !== settled;
  const rosterRefreshing = roster.status === 'loading' || rosterOutdated;
  const eligible = rosterData?.summary.eligible ?? 0;
  const submitting = run.status === 'submitting';
  // Why the run failed decides what may be said about it; only a 4xx is a definite "rejected".
  const failure = run.status === 'failed' ? writeOutcome(run.error) : null;
  const awaitingRetryDecision = failure === 'not_run' || failure === 'unknown';
  // Turning the pages of a roster changes nothing about who is eligible, so that does not lock.
  const canIssue = rosterData !== null && !rosterOutdated && eligible > 0 && !submitting && !awaitingRetryDecision;

  const runResultId = run.status === 'succeeded' ? run.operation.id : null;
  // The result of the run is on screen already: never a second panel for the same operation.
  const showViewed = viewedId !== null && viewedId !== runResultId;
  const viewedOperation = viewed.status === 'success' && viewed.data?.id === viewedId ? viewed.data : null;

  function submit(attempt) {
    setViewedId(null);
    // The store refuses a second request while one is in flight (double click, Enter + click).
    bulkIssues.submit(api, attempt);
  }

  // Only reachable through the Issue button, i.e. while `canIssue` holds: a new key is a new
  // operation, so it is only made for a roster the admin can see is current.
  function startIssue() {
    if (!selectedCourse) return;
    submit({ courseId: selectedCourse.id, courseTitle: selectedCourse.title, key: newIdempotencyKey() });
  }

  function changeCourse(nextId) {
    // Choosing the course that is already selected is not a new choice and must not discard the
    // status on screen. (A browser sends no change event for it; a script driving the page can.)
    if (nextId === courseId) return;
    // An attempt that is on its way, or whose outcome is open, keeps its course: moving on would
    // drop the prompt to retry it and the key that makes the retry safe. The picker is locked in
    // both cases; this is for whatever changes it all the same.
    if (submitting || awaitingRetryDecision) return;
    setCourseId(nextId);
    setRosterPage(1);
    setViewedId(null);
    bulkIssues.dismiss(actor.email); // a result or a rejection on display belongs to the old choice
  }

  function dismissRun() {
    if (viewedId === runResultId) setViewedId(null); // or the hidden copy would pop up in its place
    bulkIssues.dismiss(actor.email);
  }

  /** Takes the admin to the result of the run: scrolls to its heading and puts the focus on it. */
  function showRunResult() {
    const heading = document.getElementById('result-heading');
    if (!heading) return;
    heading.scrollIntoView?.({ block: 'nearest' });
    // Focusable for this one occasion only: a heading that could always take the focus would
    // also be outlined by an ordinary click on its text.
    heading.setAttribute('tabindex', '-1');
    heading.addEventListener('blur', () => heading.removeAttribute('tabindex'), { once: true });
    heading.focus();
  }

  function viewOperation(id) {
    if (id === runResultId) {
      // Its outcomes are on screen as the result of the run: point there instead of opening a copy.
      // Moving the focus is what makes the click perceivable when the panel is in view already:
      // a screen reader announces the heading, and styles.css outlines it.
      setViewedId(null);
      showRunResult();
    } else if (id === viewedId) {
      viewed.reload();
    } else {
      setViewedId(id);
    }
  }

  return (
    <>
      <section className="panel" aria-labelledby="bulk-heading">
        <div className="panel-header">
          <div>
            <h1 id="bulk-heading">Bulk issue certificates</h1>
            <p className="muted">
              Tenant <strong>{actor.tenant.name}</strong> · issues a certificate to every learner who has completed the
              course and is not certified yet
            </p>
          </div>
        </div>

        {courses.status === 'error' ? (
          <ErrorState title="Courses could not be loaded" error={courses.error} onRetry={courses.reload} />
        ) : (
          <div className="toolbar">
            <label className="field field-grow">
              <span className="field-label">Course</span>
              <select
                value={courseId}
                disabled={courses.status === 'loading' || submitting || awaitingRetryDecision}
                aria-describedby={awaitingRetryDecision ? 'course-locked-hint' : undefined}
                onChange={(event) => changeCourse(event.target.value)}
                data-testid="course-select"
              >
                <option value="">{courses.status === 'loading' ? 'Loading courses…' : 'Choose a course…'}</option>
                {(courses.data ?? []).map((course) => (
                  <option key={course.id} value={course.id}>
                    {course.title}
                  </option>
                ))}
              </select>
            </label>
            <div className="field">
              <span className="field-label">&nbsp;</span>
              <button
                type="button"
                className="btn btn-primary"
                onClick={startIssue}
                disabled={!canIssue}
                data-testid="issue-button"
              >
                {submitting ? (
                  <Spinner label="Issuing…" />
                ) : !rosterData || rosterOutdated ? (
                  'Issue certificates' // no number that the roster on its way may contradict
                ) : eligible === 0 ? (
                  'No eligible learners'
                ) : (
                  `Issue ${eligible.toLocaleString('en-US')} certificate${eligible === 1 ? '' : 's'}`
                )}
              </button>
            </div>
          </div>
        )}

        {/* Operation status ------------------------------------------------------------------ */}
        <div aria-live="polite" data-testid="operation-status" data-state={run.status}>
          {run.status === 'submitting' ? (
            <p className="note">
              <Spinner label={`Issuing certificates for ${run.attempt.courseTitle}…`} /> Please wait; the button is locked
              until the server has answered.
            </p>
          ) : null}
          {run.status === 'succeeded' ? (
            // Said here, in the live region, so that the end of the run is announced as its start
            // was - and seen next to the button when the result panel is below a long roster.
            <p className={run.operation.summary.failed > 0 ? 'note' : 'note note-success'} data-testid="operation-announcement">
              Operation #{run.operation.id} for {run.operation.course.title} completed: {run.operation.summary.issued} issued,{' '}
              {run.operation.summary.skipped} skipped, {run.operation.summary.failed} failed.
              {run.replayed ? ' It repeats an earlier request, so nothing was issued twice.' : ''}{' '}
              <button type="button" className="link" onClick={showRunResult}>
                Show outcomes
              </button>
            </p>
          ) : null}
          {run.status === 'failed' ? (
            <div className="state state-error" role="alert">
              <div className="state-icon" aria-hidden="true">
                !
              </div>
              <div className="state-body">
                <strong>
                  {failure === 'not_run'
                    ? `The bulk issue for ${run.attempt.courseTitle} has not run yet`
                    : failure === 'unknown'
                      ? `The bulk issue for ${run.attempt.courseTitle} may or may not have gone through`
                      : `The bulk issue for ${run.attempt.courseTitle} was rejected`}
                </strong>
                <p>{run.error?.message || 'Unexpected error'}</p>
                {awaitingRetryDecision ? (
                  <p className="muted small" id="course-locked-hint">
                    Retrying is safe: the request is repeated with the same idempotency key, so learners are never
                    certified twice. The course stays selected until this attempt has been retried or dismissed.
                  </p>
                ) : null}
              </div>
              <div className="state-actions">
                {awaitingRetryDecision ? (
                  <button type="button" className="btn btn-primary" onClick={() => submit(run.attempt)} data-testid="retry-button">
                    Retry safely
                  </button>
                ) : null}
                <button type="button" className="btn" onClick={dismissRun}>
                  Dismiss
                </button>
              </div>
            </div>
          ) : null}
        </div>

        {/* Roster: what the next bulk issue will do ---------------------------------------------- */}
        {!courseId ? (
          courses.status === 'success' && courses.data.length === 0 ? (
            <EmptyState title="This tenant has no courses yet" />
          ) : (
            <EmptyState title="Choose a course to review its learners">
              You will see who is eligible before anything is issued.
            </EmptyState>
          )
        ) : roster.status === 'error' ? (
          <ErrorState title="The course roster could not be loaded" error={roster.error} onRetry={roster.reload} />
        ) : !rosterData ? (
          <div className="state state-loading">
            <Spinner label="Loading learners…" />
          </div>
        ) : (
          <>
            <div className="tiles" data-testid="roster-summary">
              <div className="tile">
                <span className="tile-value">{rosterData.summary.enrolled.toLocaleString('en-US')}</span>
                <span className="tile-label">Enrolled</span>
              </div>
              <div className="tile">
                <span className="tile-value">{rosterData.summary.completed.toLocaleString('en-US')}</span>
                <span className="tile-label">Completed</span>
              </div>
              <div className="tile">
                <span className="tile-value">{rosterData.summary.certified.toLocaleString('en-US')}</span>
                <span className="tile-label">Certified</span>
              </div>
              <div className="tile tile-issued">
                <span className="tile-value" data-testid="eligible-count">
                  {eligible.toLocaleString('en-US')}
                </span>
                <span className="tile-label">Eligible now</span>
              </div>
            </div>

            {rosterData.items.length === 0 ? (
              <EmptyState title="Nobody is enrolled in this course" />
            ) : (
              <div className="table-wrap" aria-busy={rosterRefreshing}>
                <table className={rosterRefreshing ? 'data-table is-refreshing' : 'data-table'}>
                  <thead>
                    <tr>
                      <th scope="col">Learner</th>
                      <th scope="col">Enrollment</th>
                      <th scope="col">Certificate</th>
                      <th scope="col">Next bulk issue</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rosterData.items.map((item) => (
                      <tr key={item.enrollmentId}>
                        <td className="nowrap">{item.learnerName}</td>
                        <td className="nowrap">
                          {ENROLLMENT_LABELS[item.enrollmentStatus] ?? item.enrollmentStatus}
                          {item.completedLocal ? <span className="muted small"> · {item.completedLocal}</span> : null}
                        </td>
                        <td className="nowrap">
                          {item.certificateId ? (
                            <>
                              <a className="mono" href={`#/certificates/${item.certificateId}`}>
                                {item.serialNumber}
                              </a>{' '}
                              <StatusBadge status={item.certificateStatus} />
                            </>
                          ) : (
                            <span className="muted">None</span>
                          )}
                        </td>
                        <td>
                          {item.eligible ? (
                            <span className="badge badge-issued">Will be issued</span>
                          ) : (
                            <span className="muted">Skipped: {item.message}</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {rosterData.totalPages > 1 ? (
              <Pagination
                page={rosterData.page}
                totalPages={rosterData.totalPages}
                total={rosterData.total}
                pageSize={rosterData.pageSize}
                itemCount={rosterData.items.length}
                disabled={rosterRefreshing}
                onPageChange={setRosterPage}
                noun="learners"
              />
            ) : null}
          </>
        )}
      </section>

      {run.status === 'succeeded' ? (
        <OperationResult
          key={`run-${run.operation.id}-${run.attempt.key}`}
          operation={run.operation}
          replayed={run.replayed}
          onDismiss={dismissRun}
        />
      ) : null}

      {!showViewed ? null : viewed.status === 'error' ? (
        <section className="panel">
          <ErrorState title={`Operation #${viewedId} could not be loaded`} error={viewed.error} onRetry={viewed.reload} />
        </section>
      ) : !viewedOperation ? (
        <section className="panel">
          <Spinner label={`Loading operation #${viewedId}…`} />
        </section>
      ) : (
        <OperationResult
          key={`viewed-${viewedId}`}
          // Shown below the result of a run, it must not repeat that panel's heading id.
          headingId={run.status === 'succeeded' ? 'viewed-result-heading' : 'result-heading'}
          operation={viewedOperation}
          replayed={false}
          onDismiss={() => setViewedId(null)}
        />
      )}

      <section className="panel" aria-labelledby="history-heading">
        <div className="panel-header">
          <h2 id="history-heading">Recent operations</h2>
        </div>
        {operations.status === 'error' ? (
          <ErrorState title="Operations could not be loaded" error={operations.error} onRetry={operations.reload} />
        ) : !operations.data ? (
          <div className="state state-loading">
            <Spinner label="Loading operations…" />
          </div>
        ) : operations.data.length === 0 ? (
          <EmptyState title="No bulk issues have been run in this tenant yet" />
        ) : (
          <div className="table-wrap">
            <table className="data-table" data-testid="operation-history">
              <thead>
                <tr>
                  <th scope="col">Operation</th>
                  <th scope="col">Course</th>
                  <th scope="col">Started ({actor.tenant.timezone})</th>
                  <th scope="col">Requested by</th>
                  <th scope="col">Issued</th>
                  <th scope="col">Skipped</th>
                  <th scope="col">Failed</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {operations.data.map((operation) => (
                  <tr key={operation.id}>
                    <td>#{operation.id}</td>
                    <td>{operation.course.title}</td>
                    <td className="nowrap">{operation.createdLocal}</td>
                    <td>{operation.requestedBy}</td>
                    <td>{operation.summary.issued}</td>
                    <td>{operation.summary.skipped}</td>
                    <td>{operation.summary.failed}</td>
                    <td>
                      <button type="button" className="link" onClick={() => viewOperation(operation.id)}>
                        View outcomes
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
