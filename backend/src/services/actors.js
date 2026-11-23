/**
 * Actor context. There is no login in this console: each request names its actor in the
 * `X-Actor-Email` header and the server derives the tenant from that admin record. The tenant is
 * never taken from the URL, query string or body, so a caller cannot ask for someone else's data.
 */
import { HttpError } from '../lib/errors.js';

export const ACTOR_HEADER = 'X-Actor-Email';

const ACTOR_SQL = `
  SELECT a.id AS adminId, a.email AS email, a.display_name AS displayName,
         t.id AS tenantId, t.name AS tenantName, t.code AS tenantCode, t.timezone AS timezone
    FROM admins a
    JOIN tenants t ON t.id = a.tenant_id`;

export function findActorByEmail(db, email) {
  const row = db.get(`${ACTOR_SQL} WHERE a.email = @email`, { email });
  return row ? { ...row } : null;
}

/** Demo convenience for the actor switcher: the seeded admins and the tenant each one is bound to. */
export function listActors(db) {
  return db.all(`${ACTOR_SQL} ORDER BY t.id, a.id`).map((row) => ({
    email: row.email,
    displayName: row.displayName,
    tenant: { name: row.tenantName, timezone: row.timezone },
  }));
}

export function describeActor(actor) {
  return {
    email: actor.email,
    displayName: actor.displayName,
    tenant: { id: actor.tenantId, name: actor.tenantName, code: actor.tenantCode, timezone: actor.timezone },
  };
}

/** Express middleware: resolves `req.actor` or rejects the request with 401. */
export function requireActor(db) {
  return function actorContext(req, _res, next) {
    const email = (req.get(ACTOR_HEADER) ?? '').trim();
    if (!email) {
      throw new HttpError(401, 'actor_required', `Missing ${ACTOR_HEADER} header`);
    }
    const actor = findActorByEmail(db, email);
    if (!actor) {
      throw new HttpError(401, 'unknown_actor', `No admin account matches ${ACTOR_HEADER} "${email.slice(0, 120)}"`);
    }
    req.actor = actor;
    next();
  };
}
