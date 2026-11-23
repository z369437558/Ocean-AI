import { useEffect, useRef, useState } from 'react';

import { navigate, useDebouncedValue, useQuery } from '../hooks.js';
import CertificateDetail from './CertificateDetail.jsx';
import { EmptyState, ErrorState, Pagination, Spinner, StatusBadge } from './ui.jsx';

const COLUMNS = [
  { field: 'serial', label: 'Serial number', defaultOrder: 'asc' },
  { field: 'learner', label: 'Learner', defaultOrder: 'asc' },
  { field: 'course', label: 'Course', defaultOrder: 'asc' },
  { field: 'issued', label: 'Issued', defaultOrder: 'desc' },
  { field: 'status', label: 'Status', defaultOrder: 'asc' },
];

const SORT_OPTIONS = [
  { value: 'issued:desc', label: 'Issue date – newest first' },
  { value: 'issued:asc', label: 'Issue date – oldest first' },
  { value: 'learner:asc', label: 'Learner – A to Z' },
  { value: 'learner:desc', label: 'Learner – Z to A' },
  { value: 'course:asc', label: 'Course – A to Z' },
  { value: 'course:desc', label: 'Course – Z to A' },
  { value: 'serial:asc', label: 'Serial number – ascending' },
  { value: 'serial:desc', label: 'Serial number – descending' },
  { value: 'status:asc', label: 'Status – active first' },
  { value: 'status:desc', label: 'Status – revoked first' },
];

const PAGE_SIZES = [10, 25, 50, 100];

/**
 * The search text as it is sent to the server. Pasted text easily carries tabs or line breaks
 * (two spreadsheet cells, a line of an e-mail) and the server rejects control characters with a
 * 400, so every run of them - together with the spaces around it - becomes a single space.
 */
function toSearchQuery(text) {
  return text.replace(/ *[\u0000-\u001f\u007f][\u0000-\u001f\u007f ]*/g, ' ').trim();
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default function CertificatesPage({ api, actor, selectedCertificateId }) {
  const [searchText, setSearchText] = useState('');
  const [search, setSearch] = useDebouncedValue(toSearchQuery(searchText), 300);
  const [status, setStatus] = useState('all');
  const [sort, setSort] = useState({ field: 'issued', order: 'desc' });
  const [pageSize, setPageSize] = useState(25);

  // The page number belongs to one particular search/sort. Whenever those change, the list starts
  // over at page 1 in the same render - no extra request for a page of the previous result set.
  const filterKey = JSON.stringify([search, status, sort.field, sort.order, pageSize]);
  const [pageState, setPageState] = useState({ key: filterKey, page: 1 });
  const page = pageState.key === filterKey ? pageState.page : 1;
  const setPage = (next) => setPageState({ key: filterKey, page: next });

  const filters = { q: search, status, sort: sort.field, order: sort.order };
  const list = useQuery((signal) => api.listCertificates({ ...filters, page, pageSize }, signal), [api, filterKey, page]);
  const { data } = list;

  // If rows disappeared underneath us (the last page no longer exists), step back to the last page.
  useEffect(() => {
    if (list.status === 'success' && data.items.length === 0 && data.total > 0 && page > data.totalPages) {
      setPageState({ key: filterKey, page: data.totalPages });
    }
  }, [list.status, data, page, filterKey]);

  const [exportState, setExportState] = useState({ status: 'idle' });
  // The export belongs to this page. When the page goes away - another tab, another actor - a
  // download still in flight is cancelled; otherwise the file would be saved later with nothing on
  // screen to explain it, possibly a file of tenant A while the console is acting as tenant B.
  const exportAbort = useRef(null);
  useEffect(() => () => exportAbort.current?.abort(), []);

  async function handleExport() {
    if (exportState.status === 'running') return; // one export at a time per window
    const q = toSearchQuery(searchText);
    setSearch(q); // apply pending keystrokes now, so the table and the file show the same rows
    setExportState({ status: 'running' });
    const controller = new AbortController();
    exportAbort.current = controller;
    try {
      const result = await api.exportCsv({ q, status, sort: sort.field, order: sort.order }, controller.signal);
      setExportState({ status: 'done', ...result });
    } catch (error) {
      if (controller.signal.aborted) return; // the page is gone: nothing to report, nobody to tell
      setExportState({ status: 'error', error });
    }
  }

  function sortBy(column) {
    setSort((current) =>
      current.field === column.field
        ? { field: column.field, order: current.order === 'asc' ? 'desc' : 'asc' }
        : { field: column.field, order: column.defaultOrder },
    );
  }

  function clearFilters() {
    setSearchText('');
    setSearch('');
    setStatus('all');
  }

  const hasFilters = search !== '' || status !== 'all';
  const isFirstLoad = list.status === 'loading' && !data;
  const isRefreshing = list.status === 'loading' && Boolean(data);

  return (
    <>
      <section className="panel" aria-labelledby="certificates-heading">
        <div className="panel-header">
          <div>
            <h1 id="certificates-heading">Certificates</h1>
            <p className="muted">
              Tenant <strong>{actor.tenant.name}</strong> · issue dates are shown in {actor.tenant.timezone} local time
            </p>
          </div>
          <div className="panel-actions">
            <button
              type="button"
              className="btn"
              onClick={handleExport}
              disabled={exportState.status === 'running'}
              data-testid="export-button"
            >
              {exportState.status === 'running' ? <Spinner label="Exporting…" /> : 'Export CSV'}
            </button>
          </div>
        </div>

        <form
          className="toolbar"
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            setSearch(toSearchQuery(searchText));
          }}
        >
          <label className="field field-grow">
            <span className="field-label">Search</span>
            <input
              type="search"
              value={searchText}
              maxLength={100}
              placeholder="Learner name or serial number"
              onChange={(event) => setSearchText(event.target.value)}
              data-testid="search-input"
            />
          </label>
          <label className="field">
            <span className="field-label">Status</span>
            <select value={status} onChange={(event) => setStatus(event.target.value)} data-testid="status-filter">
              <option value="all">All</option>
              <option value="active">Active</option>
              <option value="revoked">Revoked</option>
            </select>
          </label>
          <label className="field">
            <span className="field-label">Sort by</span>
            <select
              value={`${sort.field}:${sort.order}`}
              onChange={(event) => {
                const [field, order] = event.target.value.split(':');
                setSort({ field, order });
              }}
              data-testid="sort-select"
            >
              {SORT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field-label">Rows per page</span>
            <select value={pageSize} onChange={(event) => setPageSize(Number(event.target.value))} data-testid="page-size">
              {PAGE_SIZES.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </label>
        </form>

        <div className="export-status" aria-live="polite">
          {exportState.status === 'running' ? (
            <p className="note">
              Preparing the export for the current search and sort order. Large exports can take a moment; you can keep
              working meanwhile. Leaving this page cancels the export.
            </p>
          ) : null}
          {exportState.status === 'done' ? (
            <p className="note note-success" data-testid="export-done">
              Export saved as <strong>{exportState.fileName}</strong> ({formatBytes(exportState.bytes)}).{' '}
              <button type="button" className="link" onClick={() => setExportState({ status: 'idle' })}>
                Dismiss
              </button>
            </p>
          ) : null}
          {exportState.status === 'error' ? (
            <p className="note note-error" role="alert">
              Export failed: {exportState.error.message}{' '}
              <button type="button" className="link" onClick={handleExport}>
                Try again
              </button>
            </p>
          ) : null}
        </div>

        <div className="table-wrap" aria-busy={list.status === 'loading'} data-testid="certificate-list" data-state={list.status}>
          {list.status === 'error' ? (
            <ErrorState title="Certificates could not be loaded" error={list.error} onRetry={list.reload} />
          ) : isFirstLoad ? (
            <div className="state state-loading" data-testid="list-loading">
              <Spinner label="Loading certificates…" />
            </div>
          ) : data.items.length === 0 && !isRefreshing ? (
            hasFilters ? (
              <EmptyState
                title="No certificates match your search"
                action={
                  <button type="button" className="btn" onClick={clearFilters}>
                    Clear search and filters
                  </button>
                }
              >
                {search ? `Nothing found for “${search}”` : 'Nothing found'}
                {status !== 'all' ? ` with status ${status}` : ''}. Search looks at learner names and serial numbers.
              </EmptyState>
            ) : (
              <EmptyState
                title="No certificates yet"
                action={
                  <a className="btn btn-primary" href="#/bulk-issue">
                    Go to bulk issue
                  </a>
                }
              >
                Certificates appear here once they have been issued for a course.
              </EmptyState>
            )
          ) : (
            <table className={isRefreshing ? 'data-table is-refreshing' : 'data-table'}>
              <thead>
                <tr>
                  {COLUMNS.map((column) => {
                    const active = sort.field === column.field;
                    return (
                      <th
                        key={column.field}
                        scope="col"
                        aria-sort={active ? (sort.order === 'asc' ? 'ascending' : 'descending') : 'none'}
                      >
                        <button type="button" className="th-button" onClick={() => sortBy(column)} title={`Sort by ${column.label.toLowerCase()}`}>
                          {column.label}
                          {column.field === 'issued' ? <span className="th-hint"> ({actor.tenant.timezone})</span> : null}
                          <span className="sort-arrow" aria-hidden="true">
                            {active ? (sort.order === 'asc' ? '▲' : '▼') : '↕'}
                          </span>
                        </button>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {data.items.map((certificate) => (
                  <tr
                    key={certificate.id}
                    className={certificate.id === selectedCertificateId ? 'row-link row-selected' : 'row-link'}
                    onClick={() => navigate(`/certificates/${certificate.id}`)}
                  >
                    <td>
                      <a
                        href={`#/certificates/${certificate.id}`}
                        className="mono"
                        onClick={(event) => event.stopPropagation()}
                      >
                        {certificate.serialNumber}
                      </a>
                    </td>
                    <td>{certificate.learnerName}</td>
                    <td>{certificate.courseTitle}</td>
                    <td className="nowrap" title={`${certificate.issuedAt} (UTC)`}>
                      {certificate.issuedLocal}
                    </td>
                    <td>
                      <StatusBadge status={certificate.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {isRefreshing ? (
            <div className="refreshing" data-testid="list-refreshing">
              <Spinner label="Loading…" />
            </div>
          ) : null}
        </div>

        {data && list.status !== 'error' ? (
          <Pagination
            page={page}
            totalPages={data.totalPages}
            total={data.total}
            pageSize={pageSize}
            itemCount={data.items.length}
            disabled={list.status === 'loading'}
            onPageChange={setPage}
          />
        ) : null}
      </section>

      {selectedCertificateId !== null ? (
        <CertificateDetail
          key={selectedCertificateId}
          api={api}
          certificateId={selectedCertificateId}
          onClose={() => navigate('/certificates')}
          onChanged={list.reload}
        />
      ) : null}
    </>
  );
}
