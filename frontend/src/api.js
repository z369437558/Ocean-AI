/**
 * API client. Every call is made on behalf of the selected actor (`X-Actor-Email`); the server
 * derives the tenant from it, so the UI never sends a tenant id.
 */

export const ACTOR_HEADER = 'X-Actor-Email';

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status; // 0 = the request never got an answer (network failure)
    this.code = code;
    this.details = details;
  }

  /** True when the outcome is unknown or transient, i.e. repeating the same request makes sense. */
  get retryable() {
    return this.status === 0 || this.status >= 500;
  }
}

async function toApiError(response) {
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    // not a JSON error document
  }
  return new ApiError(
    response.status,
    payload?.error?.code ?? 'http_error',
    payload?.error?.message ?? `The server answered with HTTP ${response.status}`,
    payload?.error?.details,
  );
}

async function send(path, { actor, method = 'GET', body, headers = {}, signal } = {}) {
  const init = { method, headers: { ...headers }, signal };
  if (actor) init.headers[ACTOR_HEADER] = actor;
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetch(`/api${path}`, init);
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw new ApiError(0, 'network_error', 'The server could not be reached. Check that it is running, then try again.');
  }
  if (!response.ok) throw await toApiError(response);
  return response;
}

function toQueryString(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

/** Seeded admins for the actor switcher (demo helper; needs no actor). */
export async function fetchActors(signal) {
  const response = await send('/actors', { signal });
  return (await response.json()).items;
}

export function createApi(actor) {
  const json = async (path, options) => (await send(path, { actor, ...options })).json();

  return {
    actor,

    listCertificates: (params, signal) => json(`/certificates${toQueryString(params)}`, { signal }),

    getCertificate: (id, signal) => json(`/certificates/${id}`, { signal }),

    revokeCertificate: (id, reason) => json(`/certificates/${id}/revoke`, { method: 'POST', body: { reason } }),

    listCourses: (signal) => json('/courses', { signal }).then((data) => data.items),

    getRoster: (courseId, page, signal) => json(`/courses/${courseId}/enrollments${toQueryString({ page })}`, { signal }),

    listOperations: (signal) => json('/bulk-issues', { signal }).then((data) => data.items),

    getOperation: (id, signal) => json(`/bulk-issues/${id}`, { signal }),

    /**
     * Starts (or safely repeats) a bulk issue. The same `idempotencyKey` must be passed again when
     * retrying after an unknown outcome: the server then answers with the stored result instead of
     * issuing a second time.
     */
    async bulkIssue(courseId, idempotencyKey) {
      const response = await send('/bulk-issues', {
        actor,
        method: 'POST',
        body: { courseId },
        headers: { 'Idempotency-Key': idempotencyKey },
      });
      return {
        operation: await response.json(),
        replayed: response.headers.get('Idempotent-Replayed') === 'true',
      };
    },

    /** Downloads the CSV for the given search/sort (same parameters as the list) and saves it. */
    async exportCsv(params) {
      const response = await send(`/certificates/export.csv${toQueryString(params)}`, { actor });
      const blob = await response.blob();
      const fileName =
        /filename="([^"]+)"/.exec(response.headers.get('Content-Disposition') ?? '')?.[1] ?? 'certificates.csv';

      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      return { fileName, bytes: blob.size };
    },
  };
}
