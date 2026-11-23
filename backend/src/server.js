/** Entry point: serve API + UI, initialising the database (schema + demo data) on first run. */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { createApp } from './app.js';
import { openInitializedDatabase } from './bootstrap.js';
import { loadConfig } from './config.js';
import { checkDatabaseSettings, openDatabase } from './db/sqlite.js';
import { ACTOR_HEADER, listActors } from './services/actors.js';

/** Start-up problems are the operator's to fix: say what is wrong in one line, without a stack trace. */
function exitWith(message) {
  console.error(message);
  process.exit(1);
}

let config;
try {
  config = loadConfig();
  checkDatabaseSettings(); // SQLITE_DRIVER, DB_BUSY_TIMEOUT_MS
} catch (err) {
  exitWith(err.message);
}

// The address is bound first and the database opened second, so a port that is taken or a host
// that cannot be used is reported before anything is created on disk. Nothing is answered in
// between: the database is opened synchronously in the "listening" callback, and connections that
// arrive meanwhile wait in the listen queue until the app is attached.
// (The error handler is attached before listen(): with app.listen() Express would hand a failed
// bind to the "listening" callback instead.)
const server = http.createServer();
let db = null;

server.on('error', (err) => {
  db?.close();
  if (err.code === 'EADDRINUSE') {
    exitWith(`Port ${config.port} is already in use. Stop the other process or run with PORT=<free port>.`);
  }
  exitWith(`Could not start the HTTP server: ${err.message}`);
});

server.listen(config.port, config.host, () => {
  try {
    db = openInitializedDatabase(config.dbPath, { log: console.log });
  } catch (err) {
    exitWith(`Could not open the database at ${config.dbPath}: ${err.message}`);
  }
  server.on(
    'request',
    createApp({
      db,
      openReader: () => openDatabase(config.dbPath, { queryOnly: true }),
      staticDir: config.staticDir,
      logRequests: config.logRequests,
      maxConcurrentExports: config.maxConcurrentExports,
      exportIdleTimeoutMs: config.exportIdleTimeoutMs,
    }),
  );

  const { port } = server.address();
  const hasFrontend = fs.existsSync(path.join(config.staticDir, 'index.html'));
  console.log(`Database: ${config.dbPath} (${db.driver})`);
  console.log(`Certificate Admin Console listening on http://localhost:${port}`);
  const actors = listActors(db).map((actor) => `${actor.email} (${actor.tenant.name})`);
  console.log(`Actors (${ACTOR_HEADER} header): ${actors.join(', ')}`);
  if (!hasFrontend) console.log('Note: frontend build not found - serving the API only.');
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} received, shutting down`);
  server.close(() => {
    db?.close();
    process.exit(0);
  });
  server.closeAllConnections?.();
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
