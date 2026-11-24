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

/**
 * The host name to print in the start-up line: one that actually leads to this server. Listening
 * on all interfaces (the default, or a wildcard address) includes localhost; a specific HOST is
 * the only address that answers.
 */
export function reachableHost(host) {
  if (!host || host === '0.0.0.0' || host === '::') return 'localhost';
  return host.includes(':') ? `[${host}]` : host;
}

/** A text setting without surrounding white space; unset or blank is undefined ("not set"). */
function textSetting(env, name) {
  return env[name]?.trim() || undefined;
}

/**
 * A whole number from the environment, written in plain decimal digits ("3000", not "3e3" or
 * "0xBB8"). Unset or blank means the fallback; anything else that cannot be used is an Error with
 * a one-line message.
 */
export function integerSetting(env, name, { fallback, min, max, unit = '' }) {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
  if (!(value >= min && value <= max)) {
    throw new Error(`${name} must be an integer between ${min} and ${max}${unit && ` ${unit}`} (got "${raw}")`);
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
  const host = textSetting(env, 'HOST');
  const dbPath = textSetting(env, 'DB_PATH');
  const staticDir = textSetting(env, 'STATIC_DIR');
  const logRequests = textSetting(env, 'LOG_REQUESTS') ?? '1';
  if (logRequests !== '0' && logRequests !== '1') {
    throw new Error(`LOG_REQUESTS must be 0 (off) or 1 (on) (got "${env.LOG_REQUESTS}")`);
  }
  return {
    port: integerSetting(env, 'PORT', { fallback: 3000, min: 0, max: 65535 }),
    host, // undefined = all interfaces
    dbPath: dbPath ? resolveUserPath(dbPath, env) : DEFAULT_DB_PATH,
    staticDir: staticDir ? resolveUserPath(staticDir, env) : DEFAULT_STATIC_DIR,
    logRequests: logRequests === '1',
    // CSV exports reading at the same time; further requests wait for a free slot.
    maxConcurrentExports: integerSetting(env, 'EXPORT_MAX_CONCURRENT', { fallback: 4, min: 1, max: 64 }),
    // A download that makes no progress for this long is dropped (0 = never).
    exportIdleTimeoutMs: integerSetting(env, 'EXPORT_IDLE_TIMEOUT_MS', { fallback: 300_000, min: 0, max: 3_600_000 }),
  };
}
