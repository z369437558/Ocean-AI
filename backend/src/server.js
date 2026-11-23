/** Entry point: initialise the database (schema + demo data on first run) and serve API + UI. */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { createApp } from './app.js';
import { openInitializedDatabase } from './bootstrap.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db/sqlite.js';
import { ACTOR_HEADER, listActors } from './services/actors.js';

/** Start-up problems are the operator's to fix: say what is wrong in one line, without a stack trace. */
function exitWith(message) {
  console.error(message);
  process.exit(1);
}

let config;
let db;
try {
  config = loadConfig();
} catch (err) {
  exitWith(err.message);
}
try {
  db = openInitializedDatabase(config.dbPath, { log: console.log });
} catch (err) {
  exitWith(`Could not open the database at ${config.dbPath}: ${err.message}`);
}

const app = createApp({
  db,
  openReader: () => openDatabase(config.dbPath, { queryOnly: true }),
  staticDir: config.staticDir,
  logRequests: config.logRequests,
});

// The error handler is attached before listen(): with app.listen() Express would hand a failed
// bind (port already taken) to the "listening" callback instead.
const server = http.createServer(app);

server.on('error', (err) => {
  db.close();
  if (err.code === 'EADDRINUSE') {
    exitWith(`Port ${config.port} is already in use. Stop the other process or run with PORT=<free port>.`);
  }
  exitWith(`Could not start the HTTP server: ${err.message}`);
});

server.listen(config.port, config.host, () => {
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
    db.close();
    process.exit(0);
  });
  server.closeAllConnections?.();
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
