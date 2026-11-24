/**
 * API client. Every call is made on behalf of the selected actor (`X-Actor-Email`); the server
 * derives the tenant from it, so the UI never sends a tenant id.
 */

export const ACTOR_HEADER = 'X-Actor-Email';

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'ApiError';
    // 0 = there is no usable answer: the request never got one (network failure), or the answer
    // could not be read or understood. Either way the server may have carried the request out.
    this.status = status;
    this.code = code;
    this.details = details;
  }

  /** True when the outcome is unknown or transient, i.e. repeating the same request makes sense. */
  get retryable() {
    return this.status === 0 || this.status >= 500;
  }
}

/**
 * What a failed write (bulk issue, revoke) says about the state on the server:
 *
 * - 'not_run':  503 database_busy - the server gave up before it started; nothing was written.
 * - 'rejected': any other definite "no" (4xx) - nothing was written either.
 * - 'unknown':  everything else - no answer, an answer that could not be read, another 5xx, or
 *               an unexpected exception on our side. The request may or may not have been carried
 *               out, so the UI must not claim that it failed. Repeating it is safe: the server
 *               deduplicates bulk issues by idempotency key, and revoking is idempotent.
 */
export function writeOutcome(error) {
  if (!(error instanceof ApiError)) return 'unknown';
  if (error.code === 'database_busy') return 'not_run';
  return error.retryable ? 'unknown' : 'rejected';
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

/**
 * Reads the body of a successful response. The status line says the server did its part, but the
 * answer can still get lost on the way: the connection drops after the headers, the JSON arrives
 * truncated. For the caller that is the same situation as no answer at all, so it is reported the
 * same way (status 0, retryable) and never as "the server said no".
 */
async function readBody(response, read) {
  try {
    return await read(response);
  } catch (err) {
    if (err?.name === 'AbortError') throw err; // cancelled by us, not a failure
    throw new ApiError(
      0,
      'network_error',
      'The answer from the server could not be read: the connection was interrupted or the response was incomplete.',
    );
  }
}

// --- Response shapes ---------------------------------------------------------------------------
// The components dereference these structures while rendering. A 2xx answer of another shape (a
// misbehaving proxy, an incompatible server version) must end in the regular error state with
// "Try again", not in a render exception, so the structure every screen relies on is checked here.

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const isList = (value) => Array.isArray(value) && value.every(isRecord);
const isCount = (value) => Number.isInteger(value) && value >= 0;

const isActorList = (data) =>
  isRecord(data) && isList(data.items) && data.items.every((actor) => typeof actor.email === 'string' && isRecord(actor.tenant));

const isCertificatePage = (data) => isRecord(data) && isList(data.items) && isCount(data.total) && isCount(data.totalPages);

const isCertificate = (data) => isRecord(data) && isCount(data.id) && isRecord(data.tenant) && isList(data.auditEvents);

const isItemList = (data) => isRecord(data) && isList(data.items);

const isCourseList = (data) => isItemList(data) && data.items.every((course) => isCount(course.id));

const isRoster = (data) =>
  isRecord(data) &&
  isRecord(data.course) &&
  isCount(data.course.id) &&
  isRecord(data.summary) &&
  [data.summary.enrolled, data.summary.completed, data.summary.certified, data.summary.eligible].every(isCount) &&
  isList(data.items) &&
  [data.page, data.pageSize, data.total, data.totalPages].every(isCount);

const isOperationSummary = (operation) => isCount(operation.id) && isRecord(operation.course) && isRecord(operation.summary);

const isOperationList = (data) => isItemList(data) && data.items.every(isOperationSummary);

const isOperation = (data) => isRecord(data) && isOperationSummary(data) && isList(data.results);

// A well-formed answer about another record than the one that was asked for is just as unusable.
// The pages show a roster or an operation only when it is the selected one (the ids must be equal,
// which is also why the checks above insist on ids being numbers), so such an answer would leave
// them waiting for ever ("Loading…") with no error and nothing to retry. The requested id is a
// number in one place and the text of a <select> value in another, hence the comparison as text.
const isAbout = (id, requestedId) => String(id) === String(requestedId);

async function readJson(response, hasExpectedShape) {
  const data = await readBody(response, (res) => res.json());
  if (!hasExpectedShape(data)) {
    // Status 0 like an unreadable answer: for a write this is an unknown outcome as well.
    throw new ApiError(0, 'invalid_response', 'The server sent an answer that this console does not understand.');
  }
  return data;
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
  return (await readJson(response, isActorList)).items;
}

export function createApi(actor) {
  const json = async (path, hasExpectedShape, options) => readJson(await send(path, { actor, ...options }), hasExpectedShape);

  return {
    actor,

    listCertificates: (params, signal) => json(`/certificates${toQueryString(params)}`, isCertificatePage, { signal }),

    getCertificate: (id, signal) => json(`/certificates/${id}`, isCertificate, { signal }),

    revokeCertificate: (id, reason) => json(`/certificates/${id}/revoke`, isCertificate, { method: 'POST', body: { reason } }),

    listCourses: (signal) => json('/courses', isCourseList, { signal }).then((data) => data.items),

    getRoster: (courseId, page, signal) =>
      json(`/courses/${courseId}/enrollments${toQueryString({ page })}`, (data) => isRoster(data) && isAbout(data.course.id, courseId), { signal }),

    listOperations: (signal) => json('/bulk-issues', isOperationList, { signal }).then((data) => data.items),

    getOperation: (id, signal) => json(`/bulk-issues/${id}`, (data) => isOperation(data) && isAbout(data.id, id), { signal }),

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
        operation: await readJson(response, isOperation),
        replayed: response.headers.get('Idempotent-Replayed') === 'true',
      };
    },

    /**
     * Downloads the CSV for the given search/sort (same parameters as the list) and saves it.
     * Aborting `signal` cancels the download; once it is aborted, no file is saved any more.
     */
    async exportCsv(params, signal) {
      const response = await send(`/certificates/export.csv${toQueryString(params)}`, { actor, signal });
      // Checked like every other answer before it is used: a 200 that is not the export (the page
      // of a gateway in front of the console, say) must not be saved as a .csv and reported as done.
      if (!/^text\/csv\b/i.test(response.headers.get('Content-Type') ?? '')) {
        throw new ApiError(0, 'invalid_response', 'The server sent an answer that is not a CSV export.');
      }
      const blob = await readBody(response, (res) => res.blob());
      // Whoever asked for this file may be gone by now (the page was left, the actor was switched).
      // The download itself can no longer be cancelled at this point, but saving it still can.
      signal?.throwIfAborted();
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
