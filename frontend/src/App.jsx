import { useEffect, useMemo, useState } from 'react';

import { createApi, fetchActors } from './api.js';
import { createBulkIssueStore } from './bulkIssueStore.js';
import BulkIssuePage from './components/BulkIssuePage.jsx';
import CertificatesPage from './components/CertificatesPage.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import { ErrorState, Spinner } from './components/ui.jsx';
import { useHashRoute, useQuery } from './hooks.js';

const ACTOR_STORAGE_KEY = 'cert-admin.actor';

function readStoredActor() {
  try {
    return window.localStorage.getItem(ACTOR_STORAGE_KEY);
  } catch {
    return null;
  }
}

function storeActor(email) {
  try {
    window.localStorage.setItem(ACTOR_STORAGE_KEY, email);
  } catch {
    // storage unavailable (private mode): the choice simply does not survive a reload
  }
}

/**
 * Tells the stylesheet how much of the top of the window the top bar covers while it sticks there
 * (`--topbar-height` on <html>, 0 where it does not stick). The browser then keeps that strip
 * clear whenever it scrolls something into view - the control that Tab or Shift+Tab lands on, a
 * heading the page points to - instead of parking it underneath the bar. The height is measured
 * because it is not fixed: on a narrow window the bar wraps to two or three rows.
 *
 * A ref callback: React calls it with the element, and the function it returns when the bar goes.
 */
function reportTopbarHeight(bar) {
  if (!bar || typeof ResizeObserver !== 'function') return undefined;
  const root = document.documentElement;
  const report = () => {
    const sticks = window.getComputedStyle(bar).position === 'sticky';
    root.style.setProperty('--topbar-height', `${sticks ? Math.ceil(bar.getBoundingClientRect().height) : 0}px`);
  };
  const observer = new ResizeObserver(report);
  observer.observe(bar);
  window.addEventListener('resize', report); // a window that only gets shorter does not resize the bar
  report();
  return () => {
    observer.disconnect();
    window.removeEventListener('resize', report);
    root.style.removeProperty('--topbar-height');
  };
}

function Console() {
  const actors = useQuery((signal) => fetchActors(signal), []);
  const [selectedEmail, setSelectedEmail] = useState(readStoredActor);
  const [route, go] = useHashRoute();
  // Bulk-issue attempts outlive the Bulk issue page: leaving the tab while a request is pending
  // must not drop its lock, its status or its idempotency key. The store also brings back, from
  // the tab's sessionStorage, attempts that a reload interrupted (see bulkIssueStore.js).
  const [bulkIssues] = useState(() => createBulkIssueStore());

  const actor = useMemo(() => {
    if (!actors.data?.length) return null;
    return actors.data.find((candidate) => candidate.email === selectedEmail) ?? actors.data[0];
  }, [actors.data, selectedEmail]);

  const api = useMemo(() => (actor ? createApi(actor.email) : null), [actor]);

  useEffect(() => {
    document.title = actor ? `Certificates · ${actor.tenant.name}` : 'Certificate Admin Console';
  }, [actor]);

  function switchActor(email) {
    if (email === actor?.email) return;
    storeActor(email);
    setSelectedEmail(email);
    // Ids are tenant-specific: never carry an open certificate over to another tenant. The route
    // changes in the same render as the actor, so the new actor never asks for the old id.
    go(route.view === 'bulk-issue' ? '/bulk-issue' : '/certificates');
  }

  if (!actor) {
    return (
      <div className="boot">
        {actors.status === 'error' ? (
          <ErrorState title="The console could not start" error={actors.error} onRetry={actors.reload} />
        ) : actors.status === 'success' ? (
          <ErrorState title="No admin accounts found" error={{ message: 'The database has no seeded admins. Run "npm run db:reset".' }} />
        ) : (
          <Spinner label="Loading console…" />
        )}
      </div>
    );
  }

  return (
    <div className="app">
      <header className="topbar" ref={reportTopbarHeight}>
        <div className="topbar-brand">
          <span className="brand-mark" aria-hidden="true">
            ✓
          </span>
          <span className="brand-name">Certificate Admin</span>
        </div>

        <nav className="tabs" aria-label="Sections">
          <a href="#/certificates" className={route.view === 'certificates' ? 'tab tab-active' : 'tab'} aria-current={route.view === 'certificates' ? 'page' : undefined}>
            Certificates
          </a>
          <a href="#/bulk-issue" className={route.view === 'bulk-issue' ? 'tab tab-active' : 'tab'} aria-current={route.view === 'bulk-issue' ? 'page' : undefined}>
            Bulk issue
          </a>
        </nav>

        <div className="topbar-actor">
          <div className="tenant-chip" title="All data and actions are limited to this tenant">
            <span className="tenant-name" data-testid="tenant-name">
              {actor.tenant.name}
            </span>
            <span className="tenant-zone">{actor.tenant.timezone}</span>
          </div>
          <label className="actor-select">
            <span>Acting as</span>
            <select value={actor.email} onChange={(event) => switchActor(event.target.value)} data-testid="actor-select">
              {actors.data.map((candidate) => (
                <option key={candidate.email} value={candidate.email}>
                  {candidate.email} ({candidate.tenant.name})
                </option>
              ))}
            </select>
          </label>
        </div>
      </header>

      {/* Keyed by actor: switching tenants discards every piece of page state (search, selection,
          viewed results) and cancels an export in flight. Only bulk-issue attempts are kept, per
          actor, in the store above; the page of another actor never reads them. */}
      <main className="content" key={actor.email}>
        {route.view === 'bulk-issue' ? (
          <BulkIssuePage api={api} actor={actor} bulkIssues={bulkIssues} />
        ) : (
          <CertificatesPage api={api} actor={actor} selectedCertificateId={route.certificateId} />
        )}
      </main>
    </div>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <Console />
    </ErrorBoundary>
  );
}
