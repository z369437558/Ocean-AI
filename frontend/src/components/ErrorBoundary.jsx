import { Component } from 'react';

import { parseHash } from '../hooks.js';

function goToCertificateList() {
  window.location.hash = '#/certificates';
  window.location.reload(); // a fresh start there, not a re-render of whatever just failed
}

/**
 * Last line of defence. Without a boundary React unmounts the whole tree when rendering throws,
 * leaving a blank page with no explanation. Malformed server answers are already turned into the
 * regular error states by api.js; this catches what nobody anticipated (a bug, or data that passed
 * those checks and still cannot be displayed).
 *
 * Reloading helps when the problem was a passing one. It does not help when the open page itself is
 * what cannot be displayed: a deep link to a record with unusable data fails again after every
 * reload. From such a link the panel therefore also leads back to the certificate list, the place
 * every other page is reached from.
 */
export default class ErrorBoundary extends Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  render() {
    const { error } = this.state;
    if (error === null) return this.props.children;
    const route = parseHash(window.location.hash);
    const onCertificateList = route.view === 'certificates' && route.certificateId === null;
    return (
      <div className="boot">
        <div className="state state-error" role="alert" data-testid="app-crashed">
          <div className="state-icon" aria-hidden="true">
            !
          </div>
          <div className="state-body">
            <strong>The console ran into an unexpected problem</strong>
            <p>
              This page could not be displayed. Reload the console to continue.
              {onCertificateList ? null : ' If the problem comes back, go to the certificate list instead.'}
            </p>
            {/* What the runtime reported is for whoever looks into the problem, not for the admin:
                in a production build it is a minified framework message. */}
            <details className="muted small">
              <summary>Technical details</summary>
              {String(error?.message || error)}
            </details>
          </div>
          <div className="state-actions">
            <button type="button" className="btn" onClick={() => window.location.reload()}>
              Reload the console
            </button>
            {onCertificateList ? null : (
              <button type="button" className="btn" onClick={goToCertificateList}>
                Go to the certificate list
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }
}
