import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const REPO_ROOT = path.resolve(here, '..', '..');
export const DEFAULT_DB_PATH = path.join(REPO_ROOT, 'data', 'cert-admin.sqlite');
export const DEFAULT_STATIC_DIR = path.join(REPO_ROOT, 'frontend', 'dist');

/** Runtime configuration, all optional: PORT, HOST, DB_PATH, STATIC_DIR, LOG_REQUESTS. */
export function loadConfig(env = process.env) {
  const port = env.PORT === undefined || env.PORT === '' ? 3000 : Number(env.PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`PORT must be an integer between 0 and 65535 (got "${env.PORT}")`);
  }
  return {
    port,
    host: env.HOST || undefined, // undefined = all interfaces
    dbPath: path.resolve(env.DB_PATH || DEFAULT_DB_PATH),
    staticDir: path.resolve(env.STATIC_DIR || DEFAULT_STATIC_DIR),
    logRequests: env.LOG_REQUESTS !== '0',
  };
}
