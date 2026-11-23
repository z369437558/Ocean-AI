/** An error that maps directly to an HTTP response: `{ error: { code, message, details? } }`. */
export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message, details) => new HttpError(400, 'invalid_request', message, details);

/**
 * Used for both "does not exist" and "belongs to another tenant" so that responses never reveal
 * whether an id exists outside the caller's tenant.
 */
export const notFound = (what) => new HttpError(404, 'not_found', `${what} not found`);
