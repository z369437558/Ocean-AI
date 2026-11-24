/**
 * HTTP layer: routing, actor context and error mapping. Business rules live in ./services.
 */
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import querystring from 'node:querystring';

import express from 'express';

import { isBusyError } from './db/sqlite.js';
import { sendChunks } from './lib/download.js';
import { HttpError } from './lib/errors.js';
import { LimiterFullError, createLimiter } from './lib/limiter.js';
import { pathId } from './lib/params.js';
import { ACTOR_HEADER, describeActor, listActors, requireActor } from './services/actors.js';
import {
  IDEMPOTENCY_HEADER,
  bulkIssue,
  getBulkOperation,
  listBulkOperations,
  parseIdempotencyKey,
  rejectReusedKeyWithUnreadableBody,
} from './services/bulkIssue.js';
import {
  buildExportPlan,
  exportFileName,
  getCertificate,
  listAuditEvents,
  listCertificates,
  parseListQuery,
  revoke,
  streamCsvExport,
} from './services/certificates.js';
import { getCourseRoster, listCourses } from './services/courses.js';

/** Exports that may queue for a slot; beyond this the server answers 503 instead of piling them up. */
const MAX_WAITING_EXPORTS = 32;

/**
 * @param {object} deps
 * @param {import('./db/sqlite.js').Connection} deps.db          main connection (all request/response work)
 * @param {() => import('./db/sqlite.js').Connection} deps.openReader  opens a dedicated read-only connection (exports)
 * @param {string|null} [deps.staticDir]   built frontend to serve, if any
 * @param {boolean} [deps.logRequests]
 * @param {number} [deps.maxConcurrentExports]  exports that read at the same time; further ones wait
 * @param {number} [deps.exportIdleTimeoutMs]   drop a download that makes no progress for this long (0 = never)
 * @param {() => Date} [deps.now]          clock (tests)
 * @param {object} [deps.hooks]            test seams, see services/bulkIssue.js
 * @param {Pick<Console, 'log' | 'error'>} [deps.logger]
 */
export function createApp({
  db,
  openReader,
  staticDir = null,
  logRequests = false,
  maxConcurrentExports = 4,
  exportIdleTimeoutMs = 300_000,
  now = () => new Date(),
  hooks = {},
  logger = console,
}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);
  // Flat key/value parsing, and ALL parameters: node:querystring drops everything after the
  // 1000th by default, and a filter that is silently ignored is worse than a long query. (Node
  // caps the request line plus headers at 16 KiB, so "all" is still a small number.)
  app.set('query parser', (text) => querystring.parse(text, '&', '=', { maxKeys: 0 }));

  if (logRequests) {
    app.use((req, res, next) => {
      if (!req.path.startsWith('/api/')) return next();
      const started = process.hrtime.bigint();
      res.on('finish', () => {
        const ms = Number(process.hrtime.bigint() - started) / 1e6;
        const actor = req.actor ? ` [${req.actor.email}]` : '';
        logger.log(`${req.method} ${req.originalUrl} -> ${res.statusCode} (${ms.toFixed(1)} ms)${actor}`);
      });
      return next();
    });
  }

  const api = express.Router();
  api.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  api.get('/health', (_req, res) => {
    res.json({ status: 'ok', database: db.driver });
  });

  // Demo-only helper for the actor switcher (there is no login in this console).
  api.get('/actors', (_req, res) => {
    res.json({ header: ACTOR_HEADER, items: listActors(db) });
  });

  // Everything below runs on behalf of an admin and is scoped to that admin's tenant.
  api.use(requireActor(db));

  // Bodies are always JSON; do not make callers fail on a forgotten Content-Type header.
  const jsonBody = express.json({ limit: '100kb', type: () => true });

  // Bulk issue: a body that cannot be read as JSON (malformed, too large, wrong encoding) is still
  // "a different payload" once its Idempotency-Key has been used, so it gets the 409 that key
  // misuse calls for rather than a 400/413. With an unused key the body error is reported as is.
  function bulkIssueBody(req, res, next) {
    jsonBody(req, res, (bodyError) => {
      if (!bodyError) return next();
      try {
        rejectReusedKeyWithUnreadableBody(db, req.actor, parseIdempotencyKey(req.get(IDEMPOTENCY_HEADER)));
      } catch (keyError) {
        // 409 for a reused key. A malformed key (400) is no worse than the unreadable body, which
        // is reported instead; anything else is a genuine failure and must not be papered over.
        if (keyError.status !== 400) return next(keyError);
      }
      return next(bodyError);
    });
  }

  api.get('/me', (req, res) => {
    res.json(describeActor(req.actor));
  });

  api.get('/courses', (req, res) => {
    res.json({ items: listCourses(db, req.actor) });
  });

  api.get('/courses/:courseId/enrollments', (req, res) => {
    res.json(getCourseRoster(db, req.actor, pathId(req.params.courseId), req.query));
  });

  api.get('/certificates', (req, res) => {
    res.json(listCertificates(db, req.actor, parseListQuery(req.query)));
  });

  // Exports are the one expensive kind of request: each holds its own database connection and a
  // read snapshot for as long as the download lasts. Only a few read at a time; the others wait
  // their turn, so memory and open snapshots stay bounded however many exports are requested.
  const exportSlots = createLimiter(maxConcurrentExports, { maxWaiting: MAX_WAITING_EXPORTS });
  app.locals.exportSlots = exportSlots; // `active` and `waiting` counts, for diagnostics and tests

  const connectionWatchers = new WeakMap(); // socket -> callbacks to run when it closes

  /**
   * An AbortSignal that fires when the request's connection closes, plus `stop()` to end the watch
   * (which fires the signal as well: either way nobody is waiting for this request any more).
   *
   * The connection is watched rather than the response, because a response is not always told.
   * When a client sends several requests without waiting for the answers (HTTP pipelining), the
   * later responses queue behind the earlier ones, and before Node 24 a queued response never
   * gets a 'close' event when the connection goes away. The connection itself always does.
   */
  function watchConnection(req) {
    const socket = req.socket;
    const closed = new AbortController();
    const onClose = () => closed.abort();

    // One 'close' listener per connection, shared by all of its requests: a pipelining client can
    // have dozens of them waiting on the same connection.
    let watchers = connectionWatchers.get(socket);
    if (!watchers) {
      watchers = new Set();
      connectionWatchers.set(socket, watchers);
      socket.once('close', () => {
        for (const notify of [...watchers]) notify();
      });
    }
    watchers.add(onClose);
    if (socket.destroyed) closed.abort();

    return {
      signal: closed.signal,
      stop() {
        watchers.delete(onClose); // connections are reused (keep-alive): do not pile up watchers
        closed.abort();
      },
    };
  }

  /**
   * Resolves when `res` may write to its connection: at once, unless it is queued behind earlier
   * responses of a pipelining client. An export only starts when its response can actually send -
   * a queued one would hold a slot and a snapshot without being able to deliver a byte.
   * Rejects when `signal` fires first.
   */
  async function responseTurn(res, signal) {
    signal.throwIfAborted();
    if (!res.socket) await once(res, 'socket', { signal });
  }

  async function* startingWith(first, rest) {
    for (let next = first; !next.done; next = await rest.next()) yield next.value;
  }

  api.get('/certificates/export.csv', async (req, res) => {
    const plan = buildExportPlan(req.actor, parseListQuery(req.query, { paginate: false }));
    const downloadHeaders = {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${exportFileName(req.actor, now())}"`,
      'X-Tenant-Timezone': req.actor.timezone,
    };
    if (req.method === 'HEAD') {
      res.status(200).set(downloadHeaders).end(); // what a download would announce, without running one
      return;
    }

    const connection = watchConnection(req);
    let release = null;
    let chunks = null;
    try {
      // Pull the first chunk (header + first rows) before committing to a 200: if the export
      // cannot even start, the client still gets a proper JSON error instead of a truncated file.
      let first;
      try {
        await responseTurn(res, connection.signal);
        release = await exportSlots.acquire({ signal: connection.signal });
        // The export opens a connection of its own (and with it its own read snapshot) and closes it again.
        chunks = streamCsvExport(openReader, plan, { signal: connection.signal });
        first = await chunks.next();
      } catch (err) {
        if (connection.signal.aborted) {
          // The client left: nobody to answer. A failure that has nothing to do with that still
          // belongs in the log.
          if (err?.name !== 'AbortError') logger.error('[export] failed to start:', err);
          return;
        }
        if (err instanceof LimiterFullError) {
          res.set('Retry-After', '5');
          throw new HttpError(503, 'export_busy', 'Too many exports are running or waiting; try again in a moment');
        }
        throw err;
      }
      if (connection.signal.aborted) return;

      // The download itself. A client that stops reading must not keep the connection, the
      // snapshot and the slot for ever: see sendChunks for what counts as "stopped".
      //
      // A download that cannot be completed is never ended quietly: the connection is reset. A
      // quiet end would look like the end of the file to a client without chunk framing
      // (HTTP/1.0), which would take half an export for a whole one. That includes the client
      // that closes its sending side while it is still reading: Node answers that by ending the
      // response, which cannot be told from the client having left - so this listener gets in
      // first, for as long as the download runs.
      const socket = req.socket;
      const cutOff = () => socket.resetAndDestroy();
      socket.prependOnceListener('end', cutOff);
      res.status(200).set(downloadHeaders);
      let outcome;
      try {
        outcome = await sendChunks(startingWith(first, chunks), res, {
          idleTimeoutMs: exportIdleTimeoutMs,
          signal: connection.signal,
          abandon: cutOff,
        });
      } finally {
        socket.off('end', cutOff);
      }
      if (outcome.stalled) {
        logger.log(`[export] download dropped: the client took no more data for ${exportIdleTimeoutMs} ms`);
      } else if (!outcome.completed && outcome.error.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
        logger.error('[export] stream failed:', outcome.error);
      }
    } finally {
      // However the request ended: stop the export if it is still reading (closing its snapshot
      // and connection), and only then let the next waiting export in.
      connection.stop();
      await chunks?.return(undefined).catch(() => {});
      release?.();
    }
  });

  api.get('/certificates/:certificateId', (req, res) => {
    res.json(getCertificate(db, req.actor, pathId(req.params.certificateId)));
  });

  api.post('/certificates/:certificateId/revoke', jsonBody, async (req, res) => {
    res.json(await revoke(db, req.actor, pathId(req.params.certificateId), req.body, { now }));
  });

  api.post('/bulk-issues', bulkIssueBody, async (req, res) => {
    const idempotencyKey = parseIdempotencyKey(req.get(IDEMPOTENCY_HEADER));
    const result = await bulkIssue(db, req.actor, { body: req.body, idempotencyKey }, { now, hooks, logger });
    res
      .status(result.status)
      .set({
        'Content-Type': 'application/json; charset=utf-8',
        Location: `/api/bulk-issues/${result.operationId}`,
        'Idempotent-Replayed': String(result.replayed),
      })
      .send(result.body);
  });

  api.get('/bulk-issues', (req, res) => {
    res.json({ items: listBulkOperations(db, req.actor) });
  });

  api.get('/bulk-issues/:operationId', (req, res) => {
    res.type('application/json; charset=utf-8').send(getBulkOperation(db, req.actor, pathId(req.params.operationId)));
  });

  api.get('/audit-events', (req, res) => {
    res.json(listAuditEvents(db, req.actor, req.query));
  });

  api.use((req) => {
    throw new HttpError(404, 'not_found', `No route for ${req.method} ${req.baseUrl}${req.path}`);
  });

  app.use('/api', api);

  // Built single-page frontend (when present). Unknown non-API paths fall back to index.html.
  const indexHtml = staticDir ? path.join(staticDir, 'index.html') : null;
  if (indexHtml && fs.existsSync(indexHtml)) {
    app.use(express.static(staticDir, { index: false, maxAge: '1h' }));
    app.use((req, res, next) => {
      const isPageRequest = (req.method === 'GET' || req.method === 'HEAD') && !path.extname(req.path);
      if (!isPageRequest) return next(); // a missing asset stays a 404 instead of becoming HTML
      res.set('Cache-Control', 'no-cache');
      // Relative to its directory: given the full path, Express would refuse the file wherever a
      // directory above it has a name that starts with a dot (a checkout below ~/.local, say).
      return res.sendFile('index.html', { root: staticDir });
    });
  } else {
    app.get('/', (_req, res) => {
      res
        .type('text/plain')
        .send(
          'The API is running, but this server has no built UI to serve. "npm start" from the repository root builds it ' +
            'into frontend/dist; if STATIC_DIR is set, it has to name the directory with the built UI. ' +
            "(The server's start-up output names the directory it looked in.)\n",
        );
    });
  }

  // Express identifies error handlers by their four-parameter signature, so `_next` must stay.
  app.use((err, req, res, _next) => {
    if (res.headersSent) {
      // Too late for an error document (streaming response): just drop the connection.
      res.destroy(err);
      return;
    }
    let status = 500;
    let payload = { code: 'internal_error', message: 'Unexpected server error' };

    if (err instanceof HttpError) {
      status = err.status;
      payload = { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) };
    } else if (err?.type === 'entity.parse.failed') {
      status = 400;
      payload = { code: 'invalid_json', message: 'Request body is not valid JSON' };
    } else if (err?.type === 'entity.too.large') {
      status = 413;
      payload = { code: 'payload_too_large', message: 'Request body is too large' };
    } else if (isBusyError(err)) {
      status = 503;
      res.set('Retry-After', '1');
      payload = { code: 'database_busy', message: 'The database is busy; retry the request shortly' };
    } else if (Number.isInteger(err?.status) && err.status >= 400 && err.status < 500) {
      status = err.status;
      payload = { code: 'invalid_request', message: err.expose ? err.message : 'Invalid request' };
    } else {
      logger.error(`[error] ${req.method} ${req.originalUrl}:`, err);
    }
    res.status(status).json({ error: payload });
  });

  return app;
}
