import { useRef, useState } from 'react';

import { useQuery } from '../hooks.js';
import { Dialog, ErrorState, Spinner, StatusBadge } from './ui.jsx';

const ACTION_LABELS = {
  'certificate.issued': 'Certificate issued',
  'certificate.revoked': 'Certificate revoked',
};

const MAX_REASON_LENGTH = 500;

/** Confirmation step for revoking: nothing is sent until the admin explicitly confirms. */
function RevokeDialog({ api, certificate, onCancel, onRevoked }) {
  const [reason, setReason] = useState('');
  const [state, setState] = useState({ status: 'idle', error: null });
  const submitting = useRef(false);

  async function confirm() {
    if (submitting.current) return; // ignore double clicks while the request is on its way
    submitting.current = true;
    setState({ status: 'submitting', error: null });
    try {
      onRevoked(await api.revokeCertificate(certificate.id, reason.trim() || undefined));
    } catch (error) {
      submitting.current = false;
      setState({ status: 'error', error });
    }
  }

  const busy = state.status === 'submitting';
  return (
    <Dialog onClose={onCancel} locked={busy} labelledBy="revoke-title">
      <form
        className="dialog-body"
        onSubmit={(event) => {
          event.preventDefault();
          confirm();
        }}
        data-testid="revoke-dialog"
      >
        <h2 id="revoke-title">Revoke this certificate?</h2>
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
          <p className="note note-error" role="alert">
            The certificate was not revoked: {state.error.message}
          </p>
        ) : null}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn btn-danger" disabled={busy} data-testid="revoke-confirm">
            {busy ? <Spinner label="Revoking…" /> : state.status === 'error' ? 'Try again' : 'Revoke certificate'}
          </button>
        </div>
      </form>
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
  const [confirming, setConfirming] = useState(false);
  const certificate = revoked ?? detail.data;

  function handleRevoked(updated) {
    setRevoked(updated);
    setConfirming(false);
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

      <div className="drawer-body" data-testid="certificate-detail">
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
                <StatusBadge status={certificate.status} />
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

            {certificate.status === 'active' ? (
              <div className="detail-actions">
                <button type="button" className="btn btn-danger" onClick={() => setConfirming(true)} data-testid="revoke-button">
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

      {confirming && certificate ? (
        <RevokeDialog api={api} certificate={certificate} onCancel={() => setConfirming(false)} onRevoked={handleRevoked} />
      ) : null}
    </>
  );
}
