import { useRef, useState } from 'react';

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

function OperationResult({ operation, replayed, onDismiss }) {
  const [filter, setFilter] = useState('all');
  const [showAll, setShowAll] = useState(false);
  const { summary } = operation;
  const matching = filter === 'all' ? operation.results : operation.results.filter((result) => result.outcome === filter);
  const visible = showAll ? matching : matching.slice(0, RESULT_PREVIEW_ROWS);

  return (
    <section className="panel" aria-labelledby="result-heading" data-testid="operation-result">
      <div className="panel-header">
        <div>
          <h2 id="result-heading">
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

export default function BulkIssuePage({ api, actor }) {
  const courses = useQuery((signal) => api.listCourses(signal), [api]);
  const operations = useQuery((signal) => api.listOperations(signal), [api]);

  const [courseId, setCourseId] = useState('');
  const [rosterPage, setRosterPage] = useState(1);
  const roster = useQuery(
    (signal) => (courseId ? api.getRoster(courseId, rosterPage, signal) : Promise.resolve(null)),
    [api, courseId, rosterPage],
  );

  // run: idle | submitting | succeeded | failed. `attempt` = { courseId, courseTitle, key }.
  const [run, setRun] = useState({ status: 'idle' });
  const inFlight = useRef(false);
  const [viewed, setViewed] = useState({ status: 'idle' }); // a past operation opened from the history

  const selectedCourse = courses.data?.find((course) => String(course.id) === courseId) ?? null;
  const rosterData = roster.status !== 'error' && roster.data?.course.id === selectedCourse?.id ? roster.data : null;
  const eligible = rosterData?.summary.eligible ?? 0;
  const submitting = run.status === 'submitting';
  const awaitingRetryDecision = run.status === 'failed' && run.error.retryable;

  async function submit(attempt) {
    // The ref closes the gap between the click and React disabling the button: a double click
    // (or Enter + click) can never start two requests. Should a duplicate still reach the server
    // (e.g. a retry after a timeout), the idempotency key makes it harmless.
    if (inFlight.current) return;
    inFlight.current = true;
    setViewed({ status: 'idle' });
    setRun({ status: 'submitting', attempt });
    try {
      const { operation, replayed } = await api.bulkIssue(attempt.courseId, attempt.key);
      setRun({ status: 'succeeded', attempt, operation, replayed });
    } catch (error) {
      setRun({ status: 'failed', attempt, error });
    } finally {
      inFlight.current = false;
      roster.reload();
      operations.reload();
    }
  }

  function startIssue() {
    if (!selectedCourse) return;
    submit({ courseId: selectedCourse.id, courseTitle: selectedCourse.title, key: newIdempotencyKey() });
  }

  function changeCourse(nextId) {
    setCourseId(nextId);
    setRosterPage(1);
    setViewed({ status: 'idle' });
    if (!submitting) setRun({ status: 'idle' });
  }

  async function viewOperation(id) {
    setViewed({ status: 'loading', id });
    try {
      setViewed({ status: 'success', id, operation: await api.getOperation(id) });
    } catch (error) {
      setViewed({ status: 'error', id, error });
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
                disabled={courses.status === 'loading' || submitting}
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
                disabled={!rosterData || eligible === 0 || submitting || awaitingRetryDecision || roster.status === 'loading'}
                data-testid="issue-button"
              >
                {submitting ? (
                  <Spinner label="Issuing…" />
                ) : rosterData && eligible === 0 ? (
                  'No eligible learners'
                ) : rosterData ? (
                  `Issue ${eligible.toLocaleString('en-US')} certificate${eligible === 1 ? '' : 's'}`
                ) : (
                  'Issue certificates'
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
          {run.status === 'failed' ? (
            <div className="state state-error" role="alert">
              <div className="state-icon" aria-hidden="true">
                !
              </div>
              <div className="state-body">
                <strong>
                  {run.error.code === 'database_busy'
                    ? `The bulk issue for ${run.attempt.courseTitle} has not run yet`
                    : run.error.retryable
                      ? `The bulk issue for ${run.attempt.courseTitle} may or may not have gone through`
                      : `The bulk issue for ${run.attempt.courseTitle} was rejected`}
                </strong>
                <p>{run.error.message}</p>
                {run.error.retryable ? (
                  <p className="muted small">
                    Retrying is safe: the request is repeated with the same idempotency key, so learners are never
                    certified twice.
                  </p>
                ) : null}
              </div>
              <div className="state-actions">
                {run.error.retryable ? (
                  <button type="button" className="btn btn-primary" onClick={() => submit(run.attempt)} data-testid="retry-button">
                    Retry safely
                  </button>
                ) : null}
                <button type="button" className="btn" onClick={() => setRun({ status: 'idle' })}>
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
              <div className="table-wrap" aria-busy={roster.status === 'loading'}>
                <table className={roster.status === 'loading' ? 'data-table is-refreshing' : 'data-table'}>
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
                disabled={roster.status === 'loading'}
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
          onDismiss={() => setRun({ status: 'idle' })}
        />
      ) : null}

      {viewed.status === 'loading' ? (
        <section className="panel">
          <Spinner label={`Loading operation #${viewed.id}…`} />
        </section>
      ) : null}
      {viewed.status === 'error' ? (
        <section className="panel">
          <ErrorState title={`Operation #${viewed.id} could not be loaded`} error={viewed.error} onRetry={() => viewOperation(viewed.id)} />
        </section>
      ) : null}
      {viewed.status === 'success' ? (
        <OperationResult key={`viewed-${viewed.id}`} operation={viewed.operation} replayed={false} onDismiss={() => setViewed({ status: 'idle' })} />
      ) : null}

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
