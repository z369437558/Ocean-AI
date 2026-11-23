import { useEffect, useMemo, useState } from 'react';

import { createApi, fetchActors } from './api.js';
import BulkIssuePage from './components/BulkIssuePage.jsx';
import CertificatesPage from './components/CertificatesPage.jsx';
import { ErrorState, Spinner } from './components/ui.jsx';
import { navigate, useHashRoute, useQuery } from './hooks.js';

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

export default function App() {
  const actors = useQuery((signal) => fetchActors(signal), []);
  const [selectedEmail, setSelectedEmail] = useState(readStoredActor);
  const route = useHashRoute();

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
    // Ids are tenant-specific: never carry an open certificate over to another tenant.
    navigate(route.view === 'bulk-issue' ? '/bulk-issue' : '/certificates');
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
      <header className="topbar">
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

      {/* Keyed by actor: switching tenants discards every piece of page state (search, selection, results). */}
      <main className="content" key={actor.email}>
        {route.view === 'bulk-issue' ? (
          <BulkIssuePage api={api} actor={actor} />
        ) : (
          <CertificatesPage api={api} actor={actor} selectedCertificateId={route.certificateId} />
        )}
      </main>
    </div>
  );
}
