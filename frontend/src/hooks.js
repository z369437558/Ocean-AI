import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Loads data and tracks its lifecycle: { status: 'loading' | 'success' | 'error', data, error }.
 *
 * - A newer request cancels the previous one, so a slow, outdated answer can never overwrite
 *   fresher data (important while typing in a search box).
 * - While reloading, the previous data stays available (`data` + status 'loading') so the screen
 *   does not flash empty; after a failure the stale data is dropped so the error is unmistakable.
 */
export function useQuery(fetcher, deps) {
  const [state, setState] = useState({ status: 'loading', data: null, error: null });
  const [attempt, setAttempt] = useState(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    const controller = new AbortController();
    setState((previous) => ({ status: 'loading', data: previous.data, error: null }));
    fetcherRef.current(controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setState({ status: 'success', data, error: null });
      },
      (error) => {
        if (controller.signal.aborted || error?.name === 'AbortError') return;
        setState({ status: 'error', data: null, error });
      },
    );
    return () => controller.abort();
    // The caller's `deps` decide when to refetch; the fetcher itself is always read from the ref.
  }, [...deps, attempt]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  return { ...state, reload };
}

/** Returns `value` once it has stopped changing for `delayMs`. */
export function useDebouncedValue(value, delayMs) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return [debounced, setDebounced];
}

function parseHash(hash) {
  const segments = hash.replace(/^#/, '').split('?')[0].split('/').filter(Boolean);
  if (segments[0] === 'bulk-issue') return { view: 'bulk-issue', certificateId: null };
  const certificateId = segments[0] === 'certificates' && /^[1-9]\d*$/.test(segments[1] ?? '') ? Number(segments[1]) : null;
  return { view: 'certificates', certificateId };
}

/** Minimal hash router: #/certificates, #/certificates/:id, #/bulk-issue. */
export function useHashRoute() {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

export function navigate(path) {
  window.location.hash = path;
}
