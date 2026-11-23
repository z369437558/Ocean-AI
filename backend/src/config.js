import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const REPO_ROOT = path.resolve(here, '..', '..');
export const DEFAULT_DB_PATH = path.join(REPO_ROOT, 'data', 'cert-admin.sqlite');
export const DEFAULT_STATIC_DIR = path.join(REPO_ROOT, 'frontend', 'dist');

/**
 * Relative paths mean "relative to where the command was typed". npm runs workspace scripts from
 * the package folder, but records the original directory in INIT_CWD.
 */
export function resolveUserPath(value, env = process.env) {
  return path.resolve(env.INIT_CWD || process.cwd(), value);
}

function integerSetting(env, name, { fallback, min, max }) {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max} (got "${raw}")`);
  }
  return value;
}

/**
 * Runtime configuration, all optional: PORT, HOST, DB_PATH, STATIC_DIR, LOG_REQUESTS,
 * EXPORT_MAX_CONCURRENT, EXPORT_IDLE_TIMEOUT_MS. Throws an Error with a one-line message for a
 * value that cannot be used.
 * (The database layer reads two more settings itself: SQLITE_DRIVER and DB_BUSY_TIMEOUT_MS; see
 * checkDatabaseSettings in db/sqlite.js.)
 */
export function loadConfig(env = process.env) {
  return {
    port: integerSetting(env, 'PORT', { fallback: 3000, min: 0, max: 65535 }),
    host: env.HOST || undefined, // undefined = all interfaces
    dbPath: env.DB_PATH ? resolveUserPath(env.DB_PATH, env) : DEFAULT_DB_PATH,
    staticDir: env.STATIC_DIR ? resolveUserPath(env.STATIC_DIR, env) : DEFAULT_STATIC_DIR,
    logRequests: env.LOG_REQUESTS !== '0',
    // CSV exports reading at the same time; further requests wait for a free slot.
    maxConcurrentExports: integerSetting(env, 'EXPORT_MAX_CONCURRENT', { fallback: 4, min: 1, max: 64 }),
    // A download whose client accepts no data for this long is dropped (0 = never).
    exportIdleTimeoutMs: integerSetting(env, 'EXPORT_IDLE_TIMEOUT_MS', { fallback: 30_000, min: 0, max: 3_600_000 }),
  };
}
