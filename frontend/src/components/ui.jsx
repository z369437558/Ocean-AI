import { useEffect, useLayoutEffect, useRef } from 'react';

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

const TAB_STOPS = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

/** The elements inside `panel` that the Tab key stops at, in document order. */
function tabStops(panel) {
  return [...panel.querySelectorAll(TAB_STOPS)].filter((element) => !element.closest('[hidden], [inert]'));
}

const comesBefore = (a, b) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

/**
 * Tab and Shift+Tab stay inside `panel`: wherever the browser's own next step would leave it, the
 * focus wraps around to the other end instead. Steps between two stops of the panel are left to
 * the browser.
 */
function keepTabInside(event, panel) {
  const stops = tabStops(panel);
  if (stops.length === 0) {
    // Nothing to stop at (every control is disabled while a request runs): stay on the dialog.
    event.preventDefault();
    panel.focus();
    return;
  }
  const active = document.activeElement;
  const from = panel.contains(active) ? active : null; // null: the focus got lost to somewhere outside
  // The browser's step stays inside when another stop lies in its direction. (From the dialog
  // itself all stops lie ahead: what an element contains counts as coming after it.)
  const leaves = event.shiftKey
    ? from === null || !stops.some((stop) => stop !== from && comesBefore(stop, from))
    : from === null || !stops.some((stop) => stop !== from && comesBefore(from, stop));
  if (!leaves) return;
  event.preventDefault();
  (event.shiftKey ? stops[stops.length - 1] : stops[0]).focus();
}

/**
 * Makes everything around `overlay` inert - out of the Tab order, not clickable, not there for a
 * screen reader - and returns the function that takes exactly that back. "Around" is every sibling
 * of the overlay and of each of its ancestors; what is inert already (the page under a dialog that
 * opened earlier) is left to whoever made it so.
 */
function makeRestInert(overlay) {
  const changed = [];
  for (let node = overlay; node !== document.body && node.parentElement; node = node.parentElement) {
    for (const sibling of node.parentElement.children) {
      if (sibling === node || sibling.hasAttribute('inert')) continue;
      sibling.setAttribute('inert', '');
      changed.push(sibling);
    }
  }
  return () => {
    for (const element of changed) element.removeAttribute('inert');
  };
}

/**
 * What the dialog that is leaving the page in the update that is running would have returned the
 * focus to. A dialog that takes its place in the same update - the drawer of another certificate,
 * after the address changed - finds the focus on <body>, because the old dialog is gone already,
 * and takes this over instead. Set while such an update is applied, empty otherwise.
 */
let openerOfDialogLeaving = null;

/** The dialogs on the page, bottom to top, without `panel`. */
const dialogsBesides = (panel) => [...document.querySelectorAll('[role="dialog"]')].filter((dialog) => dialog !== panel);

/**
 * Modal layer used for the certificate drawer and the revoke confirmation.
 *
 * - Escape and a click on the backdrop close it (unless `locked`, e.g. while a request is running).
 * - The focus moves into the dialog on open and returns to the previously focused element on close.
 * - While it is open it is the only thing that can be operated, as `aria-modal` announces: the rest
 *   of the page - a dialog underneath included - is inert, and Tab cycles through its own controls.
 *   So a dialog that is locked cannot be dismissed through the drawer behind it either.
 */
export function Dialog({ title, onClose, locked = false, variant = 'modal', children, labelledBy, describedBy }) {
  const panelRef = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const lockedRef = useRef(locked);
  lockedRef.current = locked;

  const openerRef = useRef(null); // what had the focus when the dialog opened

  // A layout effect: it runs in the same step in which the dialog enters or leaves the page. The
  // page behind is inert exactly as long as the dialog is there - never a moment later, when the
  // dialog is gone already and the page would still refuse every key and click.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    const focused = document.activeElement; // read first: becoming inert takes the focus away
    const nowhere = !focused || focused === document.body || !document.contains(focused);
    openerRef.current = nowhere && openerOfDialogLeaving ? openerOfDialogLeaving : focused;
    const releaseRest = makeRestInert(panel.parentElement);
    panel.focus();
    const onKeyDown = (event) => {
      // Only the top-most dialog reacts, so Escape closes the confirmation before the drawer.
      const dialogs = document.querySelectorAll('[role="dialog"]');
      if (dialogs[dialogs.length - 1] !== panel) return;
      if (event.key === 'Tab') {
        keepTabInside(event, panel);
      } else if (event.key === 'Escape' && !lockedRef.current) {
        event.stopPropagation();
        onCloseRef.current();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      releaseRest();
      openerOfDialogLeaving = openerRef.current;
      // A dialog underneath that stays open takes the focus at once, when this one had it or it is
      // nowhere (the browser takes it from a control that gets disabled). The effect below then
      // moves it on to the element that opened this dialog, if that is still there - but there is
      // no moment in which the focus sits on <body>, behind a dialog that is open.
      const underneath = dialogsBesides(panel).at(-1);
      const active = document.activeElement;
      if (underneath && (!active || active === document.body || panel.contains(active))) underneath.focus();
    };
  }, []);

  // Where the focus goes once the dialog is gone. An ordinary effect, on purpose: its clean-up
  // runs when the page has been updated as a whole, so "does the element that opened the dialog
  // still exist?" has its final answer. (The update that closes a confirmation can be the one that
  // removes the button which opened it: the Revoke button of a certificate that is revoked now.)
  useEffect(() => {
    const panel = panelRef.current;
    return () => {
      openerOfDialogLeaving = null; // the update is complete: whoever took this dialog's place has it
      const opener = openerRef.current;
      if (opener instanceof HTMLElement && document.contains(opener)) {
        opener.focus(); // (does nothing when a dialog that replaced this one has made it inert)
        return;
      }
      // Without its opener the focus would drop to <body>, behind a dialog that is still open, and
      // the next Tab would start from there: hand it to the top-most remaining dialog instead.
      dialogsBesides(panel).at(-1)?.focus();
    };
  }, []);

  return (
    <div
      className={`overlay overlay-${variant}`}
      onMouseDown={(event) => {
        if (event.target !== event.currentTarget) return;
        // A press on the backdrop is not a press on something that takes the focus: left to the
        // browser, it would move the focus to <body> - right after closing this dialog has handed
        // it back to the button that opened it, or away from a dialog that is locked.
        event.preventDefault();
        if (!locked) onClose();
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
