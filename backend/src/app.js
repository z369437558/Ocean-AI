/**
 * HTTP layer: routing, actor context and error mapping. Business rules live in ./services.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Readable, pipeline } from 'node:stream';

import express from 'express';

import { isBusyError } from './db/sqlite.js';
import { HttpError } from './lib/errors.js';
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

/**
 * @param {object} deps
 * @param {import('./db/sqlite.js').Connection} deps.db          main connection (all request/response work)
 * @param {() => import('./db/sqlite.js').Connection} deps.openReader  opens a dedicated read-only connection (exports)
 * @param {string|null} [deps.staticDir]   built frontend to serve, if any
 * @param {boolean} [deps.logRequests]
 * @param {() => Date} [deps.now]          clock (tests)
 * @param {object} [deps.hooks]            test seams, see services/bulkIssue.js
 * @param {Pick<Console, 'log' | 'error'>} [deps.logger]
 */
export function createApp({
  db,
  openReader,
  staticDir = null,
  logRequests = false,
  now = () => new Date(),
  hooks = {},
  logger = console,
}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);
  app.set('query parser', 'simple');

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

  api.get('/certificates/export.csv', async (req, res) => {
    const plan = buildExportPlan(req.actor, parseListQuery(req.query, { paginate: false }));

    // The export gets its own connection (and with it its own read snapshot), so the long-running
    // download never ties up the connection that serves every other request.
    async function* exportChunks() {
      const reader = openReader();
      try {
        yield* streamCsvExport(reader, plan);
      } finally {
        reader.close();
      }
    }
    const chunks = exportChunks();
    // Pull the first chunk (header + first rows) before committing to a 200: if the export cannot
    // even start, the client still gets a proper JSON error instead of a truncated file.
    const first = await chunks.next();

    res.status(200).set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${exportFileName(req.actor, now())}"`,
      'X-Tenant-Timezone': req.actor.timezone,
    });
    const body = Readable.from(
      (async function* withHeader() {
        if (!first.done) yield first.value;
        yield* chunks;
      })(),
      { objectMode: false },
    );
    pipeline(body, res, (err) => {
      // Finalises the generator (closing the snapshot and the connection) however the download ended.
      chunks.return(undefined).catch(() => {});
      if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') logger.error('[export] stream failed:', err);
    });
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
      return res.sendFile(indexHtml);
    });
  } else {
    app.get('/', (_req, res) => {
      res
        .type('text/plain')
        .send('The API is running, but the frontend has not been built yet. Run "npm start" from the repository root.\n');
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
