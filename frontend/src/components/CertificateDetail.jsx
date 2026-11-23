import { useEffect, useRef, useState } from 'react';

import { writeOutcome } from '../api.js';
import { useQuery } from '../hooks.js';
import { Dialog, ErrorState, Spinner, StatusBadge } from './ui.jsx';

const ACTION_LABELS = {
  'certificate.issued': 'Certificate issued',
  'certificate.revoked': 'Certificate revoked',
};

const MAX_REASON_LENGTH = 500;

/**
 * Confirmation step for revoking: nothing is sent until the admin explicitly confirms.
 *
 * A failed request is reported for what it says about the server (see writeOutcome in api.js):
 *
 * - A definite "no" (4xx, busy database) means the certificate is as it was.
 * - An unknown outcome leaves open whether the server carried the request out. `onOutcomeUnknown`
 *   then makes the drawer ask the server, and the drawer remembers it as `outcomeOpen`. While that
 *   is set the dialog no longer claims "was not revoked" for a later attempt either, however
 *   definite its failure: the earlier request may have gone through, or may yet (the server can
 *   keep a request waiting for the database longer than a gateway waits for the server).
 * - `revokedOnServer` reports that the drawer found the certificate revoked. That settles the
 *   matter, whatever happened to the requests: the question and the retry give way to the
 *   confirmed statement and a plain "Close".
 */
function RevokeDialog({ api, certificate, outcomeOpen, revokedOnServer, onCancel, onRevoked, onOutcomeUnknown }) {
  const [reason, setReason] = useState('');
  // outcome: what the failed attempt means - 'unknown' | 'rejected' | 'not_run' (writeOutcome).
  const [state, setState] = useState({ status: 'idle', error: null, outcome: null });
  const submitting = useRef(false);
  const bodyRef = useRef(null);
  const messageRef = useRef(null);
  const confirmRef = useRef(null);
  const closeRef = useRef(null);

  // Revoking cannot be undone, so "revoked" stays true once the server has said it - also if a
  // later reload of the drawer fails and leaves it without a certificate to show.
  const [knownRevoked, setKnownRevoked] = useState(false);
  if (revokedOnServer && !knownRevoked) setKnownRevoked(true);

  const busy = state.status === 'submitting';
  // While a retry is on its way the form stays as it is; its answer decides what is shown next.
  const settled = knownRevoked && !busy;

  async function confirm() {
    if (submitting.current) return; // ignore double clicks while the request is on its way
    submitting.current = true;
    setState({ status: 'submitting', error: null, outcome: null });
    let updated;
    try {
      updated = await api.revokeCertificate(certificate.id, reason.trim() || undefined);
    } catch (error) {
      submitting.current = false;
      // Only a 4xx or a busy database (503, nothing was written) is a definite "no".
      const outcome = writeOutcome(error);
      setState({ status: 'error', error, outcome });
      // Ask the server - also after a definite "no" while an earlier outcome is still open: the
      // reload may settle that one meanwhile.
      if (outcome === 'unknown' || outcomeOpen) onOutcomeUnknown();
      return;
    }
    onRevoked(updated);
  }

  useEffect(() => {
    if (state.status !== 'error' && !settled) return;
    if (settled) {
      // The form, and with it whatever had the focus, has just been replaced.
      closeRef.current?.focus();
    } else if (!bodyRef.current?.closest('[role="dialog"]')?.contains(document.activeElement)) {
      // The buttons were disabled while the request was on its way, and a browser takes the focus
      // away from a disabled button (to <body>, i.e. behind this dialog): bring it back.
      confirmRef.current?.focus();
    }
    // On a short screen the dialog scrolls inside; what was just reported must not stay below the fold.
    messageRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [state, settled]);

  return (
    <Dialog onClose={onCancel} locked={busy} labelledBy="revoke-title" describedBy={settled ? 'revoke-confirmed' : undefined}>
      {settled ? (
        <div className="dialog-body" ref={bodyRef} data-testid="revoke-dialog">
          <h2 id="revoke-title">Certificate revoked</h2>
          <div className="dialog-scroll">
            <p>
              <span className="mono">{certificate.serialNumber}</span> was issued to <strong>{certificate.learnerName}</strong> for{' '}
              <strong>{certificate.courseTitle}</strong>.
            </p>
            <p className="note note-success" role="status" id="revoke-confirmed" ref={messageRef} data-testid="revoke-confirmed">
              Checked with the server: this certificate is revoked now. Nothing more needs to be done.
            </p>
            {state.status === 'error' && state.outcome !== 'unknown' ? (
              <p className="muted small">The last attempt was not carried out: {state.error.message}</p>
            ) : null}
          </div>
          <div className="dialog-actions">
            <button type="button" className="btn btn-primary" onClick={onCancel} ref={closeRef} data-testid="revoke-close">
              Close
            </button>
          </div>
        </div>
      ) : (
        <form
          className="dialog-body"
          ref={bodyRef}
          onSubmit={(event) => {
            event.preventDefault();
            confirm();
          }}
          data-testid="revoke-dialog"
        >
          <h2 id="revoke-title">Revoke this certificate?</h2>
          {/* Only this part scrolls when the screen is too short; title and buttons stay in reach. */}
          <div className="dialog-scroll">
            <p>
              <span className="mono">{certificate.serialNumber}</span> was issued to <strong>{certificate.learnerName}</strong> for{' '}
              <strong>{certificate.courseTitle}</strong>. After revocation it is no longer valid. This cannot be undone, and
              the action is recorded in the audit trail.
            </p>
            <label className="field">
              <span className="field-label">Reason (optional)</span>
              <textarea
                rows={3}
                maxLength={MAX_REASON_LENGTH}
                value={reason}
                disabled={busy}
                placeholder="e.g. Issued in error"
                onChange={(event) => setReason(event.target.value)}
                data-testid="revoke-reason"
              />
            </label>
            {state.status === 'error' ? (
              <p className="note note-error" role="alert" ref={messageRef}>
                {state.outcome === 'unknown' ? (
                  <>
                    <strong>The certificate may or may not have been revoked.</strong>{' '}
                    {state.error?.message || 'Unexpected error'}
                    <br />
                    Trying again is safe: a certificate that is already revoked is left unchanged.
                  </>
                ) : outcomeOpen ? (
                  <>
                    <strong>The certificate may or may not have been revoked.</strong> This attempt was not carried out:{' '}
                    {state.error.message}
                    <br />
                    An earlier attempt got no clear answer and may have gone through all the same. Trying again is safe: a
                    certificate that is already revoked is left unchanged.
                  </>
                ) : (
                  <>The certificate was not revoked: {state.error.message}</>
                )}
              </p>
            ) : null}
          </div>
          <div className="dialog-actions">
            <button type="button" className="btn" onClick={onCancel} disabled={busy}>
              Cancel
            </button>
            <button type="submit" className="btn btn-danger" disabled={busy} ref={confirmRef} data-testid="revoke-confirm">
              {busy ? <Spinner label="Revoking…" /> : state.status === 'error' ? 'Try again' : 'Revoke certificate'}
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

function Field({ label, children }) {
  return (
    <div className="detail-field">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export default function CertificateDetail({ api, certificateId, onClose, onChanged }) {
  const detail = useQuery((signal) => api.getCertificate(certificateId, signal), [api, certificateId]);
  const [revoked, setRevoked] = useState(null); // server state returned by a successful revoke
  // The certificate the open confirmation is about. The dialog keeps this copy: while it is open
  // the drawer may be reloading, or may have failed to reload, underneath it.
  const [confirming, setConfirming] = useState(null);
  // The copy that was on screen when a revocation ended with an unknown outcome. It may be wrong
  // in exactly the point that matters, so until the reload has replaced it (or has failed) its
  // status is not shown as current and it does not offer to revoke.
  const [unverified, setUnverified] = useState(null);
  const onScreen = useRef(null);
  onScreen.current = detail.data;
  // A revoke request made from this drawer ended without a known outcome (see RevokeDialog).
  const [outcomeOpen, setOutcomeOpen] = useState(false);
  const certificate = revoked ?? detail.data;
  const verifying = revoked === null && unverified !== null && detail.data === unverified;

  // When the confirmation closes, its own clean-up hands the focus back to the element that opened
  // it - if that very element still exists. After a reload behind the dialog the Revoke button is
  // a new element, so it is looked up again here. (No button any more: the drawer keeps the focus.)
  const revokeButtonRef = useRef(null);
  const wasConfirming = useRef(false);
  useEffect(() => {
    if (wasConfirming.current && confirming === null) revokeButtonRef.current?.focus();
    wasConfirming.current = confirming !== null;
  }, [confirming]);

  function handleRevoked(updated) {
    setRevoked(updated);
    setConfirming(null);
    onChanged();
  }

  // The revocation may or may not have happened: ask the server instead of showing our old copy,
  // which would otherwise keep saying "Active" (with a Revoke button) for a revoked certificate.
  function handleOutcomeUnknown() {
    setOutcomeOpen(true);
    setUnverified(onScreen.current); // read through the ref: this runs long after it was rendered
    detail.reload();
    onChanged();
  }

  return (
    <>
    <Dialog title="Certificate details" variant="drawer" onClose={onClose}>
      <div className="drawer-header">
        <h2>Certificate</h2>
        <button type="button" className="btn btn-small" onClick={onClose} aria-label="Close details">
          Close ✕
        </button>
      </div>

      <div className="drawer-body" aria-busy={verifying} data-testid="certificate-detail">
        {!certificate && detail.status === 'loading' ? (
          <div className="state state-loading">
            <Spinner label="Loading certificate…" />
          </div>
        ) : !certificate ? (
          detail.error?.status === 404 ? (
            <ErrorState
              title="Certificate not found"
              error={{ message: 'It does not exist in this tenant. It may belong to another tenant or the link may be outdated.' }}
            />
          ) : (
            <ErrorState title="The certificate could not be loaded" error={detail.error} onRetry={detail.reload} />
          )
        ) : (
          <>
            {revoked ? (
              <p className="note note-success" role="status" data-testid="revoke-result">
                {revoked.alreadyRevoked
                  ? 'This certificate had already been revoked; nothing was changed.'
                  : 'The certificate has been revoked.'}
              </p>
            ) : null}

            <div className="detail-title">
              <span className="mono detail-serial" data-testid="detail-serial">
                {certificate.serialNumber}
              </span>
              <span data-testid="detail-status">
                {verifying ? <Spinner label="Checking the current status…" /> : <StatusBadge status={certificate.status} />}
              </span>
            </div>

            <dl className="detail-grid">
              <Field label="Learner">{certificate.learnerName}</Field>
              <Field label="Course">{certificate.courseTitle}</Field>
              <Field label={`Issue date (${certificate.tenant.timezone})`}>
                <span data-testid="detail-issued-local">{certificate.issuedLocal}</span>
                <span className="muted small"> UTC{certificate.issuedUtcOffset}</span>
                <div className="muted small">UTC: {certificate.issuedAt}</div>
              </Field>
              <Field label="Issued by">
                {certificate.issuedBy ?? '—'}
                {certificate.bulkOperationId ? <span className="muted small"> · bulk operation #{certificate.bulkOperationId}</span> : null}
              </Field>
              {certificate.status === 'revoked' ? (
                <>
                  <Field label={`Revoked (${certificate.tenant.timezone})`}>
                    {certificate.revokedLocal}
                    <div className="muted small">UTC: {certificate.revokedAt}</div>
                  </Field>
                  <Field label="Revoked by">{certificate.revokedBy ?? '—'}</Field>
                  <Field label="Revocation reason">{certificate.revocationReason ?? 'No reason given'}</Field>
                </>
              ) : null}
            </dl>

            {certificate.status === 'active' && !verifying ? (
              <div className="detail-actions">
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={() => setConfirming(certificate)}
                  ref={revokeButtonRef}
                  data-testid="revoke-button"
                >
                  Revoke certificate…
                </button>
              </div>
            ) : null}

            <h3>Audit trail</h3>
            <ol className="audit-list" data-testid="audit-trail">
              {certificate.auditEvents.map((event) => (
                <li key={event.id}>
                  <div>
                    <strong>{ACTION_LABELS[event.action] ?? event.action}</strong>
                    <span className="muted"> by {event.actorEmail}</span>
                  </div>
                  <div className="muted small">
                    {event.createdLocal} ({certificate.tenant.timezone})
                    {event.details?.reason ? ` · reason: ${event.details.reason}` : ''}
                    {event.bulkOperationId ? ` · bulk operation #${event.bulkOperationId}` : ''}
                  </div>
                </li>
              ))}
            </ol>
          </>
        )}
      </div>
    </Dialog>

      {confirming !== null ? (
        <RevokeDialog
          api={api}
          certificate={confirming}
          outcomeOpen={outcomeOpen}
          revokedOnServer={certificate?.status === 'revoked'}
          onCancel={() => setConfirming(null)}
          onRevoked={handleRevoked}
          onOutcomeUnknown={handleOutcomeUnknown}
        />
      ) : null}
    </>
  );
}
