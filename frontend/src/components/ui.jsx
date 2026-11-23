import { useEffect, useRef } from 'react';

export function Spinner({ label }) {
  return (
    <span className="spinner-wrap" role="status">
      <span className="spinner" aria-hidden="true" />
      {label ? <span>{label}</span> : <span className="sr-only">Loading</span>}
    </span>
  );
}

const STATUS_LABELS = { active: 'Active', revoked: 'Revoked' };

export function StatusBadge({ status }) {
  return <span className={`badge badge-${status}`}>{STATUS_LABELS[status] ?? status}</span>;
}

const OUTCOME_LABELS = { issued: 'Issued', skipped: 'Skipped', failed: 'Failed' };

export function OutcomeBadge({ outcome }) {
  return <span className={`badge badge-${outcome}`}>{OUTCOME_LABELS[outcome] ?? outcome}</span>;
}

/** Error panel with the server's message and, when it makes sense, a way to try again. */
export function ErrorState({ title = 'Something went wrong', error, onRetry, retryLabel = 'Try again' }) {
  return (
    <div className="state state-error" role="alert">
      <div className="state-icon" aria-hidden="true">
        !
      </div>
      <div className="state-body">
        <strong>{title}</strong>
        <p>{error?.message ?? 'Unexpected error'}</p>
        {error?.status ? <p className="muted small">HTTP {error.status}{error.code ? ` · ${error.code}` : ''}</p> : null}
      </div>
      {onRetry ? (
        <button type="button" className="btn" onClick={onRetry}>
          {retryLabel}
        </button>
      ) : null}
    </div>
  );
}

export function EmptyState({ title, children, action }) {
  return (
    <div className="state state-empty">
      <div className="state-body">
        <strong>{title}</strong>
        {children ? <p>{children}</p> : null}
      </div>
      {action}
    </div>
  );
}

export function Pagination({ page, totalPages, total, pageSize, itemCount, disabled, onPageChange, noun = 'certificates' }) {
  const first = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const last = total === 0 ? 0 : first + itemCount - 1;
  const format = (n) => n.toLocaleString('en-US');
  return (
    <nav className="pagination" aria-label="Pagination">
      <span className="muted" aria-live="polite">
        {total === 0 ? `No ${noun}` : `${format(first)}–${format(last)} of ${format(total)} ${noun}`}
      </span>
      <div className="pagination-buttons">
        <button type="button" className="btn btn-small" disabled={disabled || page <= 1} onClick={() => onPageChange(1)}>
          « First
        </button>
        <button type="button" className="btn btn-small" disabled={disabled || page <= 1} onClick={() => onPageChange(page - 1)}>
          ‹ Previous
        </button>
        <span className="pagination-page">
          Page {format(page)} of {format(totalPages)}
        </span>
        <button
          type="button"
          className="btn btn-small"
          disabled={disabled || page >= totalPages}
          onClick={() => onPageChange(page + 1)}
        >
          Next ›
        </button>
        <button
          type="button"
          className="btn btn-small"
          disabled={disabled || page >= totalPages}
          onClick={() => onPageChange(totalPages)}
        >
          Last »
        </button>
      </div>
    </nav>
  );
}

/**
 * Modal layer used for the certificate drawer and the revoke confirmation.
 * Escape and a click on the backdrop close it (unless `locked`, e.g. while a request is running);
 * focus moves into the dialog on open and returns to the previously focused element on close.
 */
export function Dialog({ title, onClose, locked = false, variant = 'modal', children, labelledBy, describedBy }) {
  const panelRef = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const lockedRef = useRef(locked);
  lockedRef.current = locked;

  useEffect(() => {
    const panel = panelRef.current;
    const previouslyFocused = document.activeElement;
    panel?.focus();
    const onKeyDown = (event) => {
      if (event.key !== 'Escape' || lockedRef.current) return;
      // Only the top-most dialog reacts, so Escape closes the confirmation before the drawer.
      const dialogs = document.querySelectorAll('[role="dialog"]');
      if (dialogs[dialogs.length - 1] === panelRef.current) {
        event.stopPropagation();
        onCloseRef.current();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      if (previouslyFocused instanceof HTMLElement && document.contains(previouslyFocused)) {
        previouslyFocused.focus();
        return;
      }
      // The element that opened this dialog no longer exists (the Revoke button of a certificate
      // that is revoked now). The focus would then drop to <body>, behind a dialog that is still
      // open, and the next Tab would leave it: hand the focus to the top-most remaining dialog.
      const remaining = [...document.querySelectorAll('[role="dialog"]')].filter((dialog) => dialog !== panel);
      remaining[remaining.length - 1]?.focus();
    };
  }, []);

  return (
    <div
      className={`overlay overlay-${variant}`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !locked) onClose();
      }}
    >
      <div
        ref={panelRef}
        className={`dialog dialog-${variant}`}
        role="dialog"
        aria-modal="true"
        aria-label={labelledBy ? undefined : title}
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        tabIndex={-1}
      >
        {children}
      </div>
    </div>
  );
}
