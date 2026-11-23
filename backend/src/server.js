/** Entry point: initialise the database (schema + demo data on first run) and serve API + UI. */
import fs from 'node:fs';
import path from 'node:path';

import { createApp } from './app.js';
import { openInitializedDatabase } from './bootstrap.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db/sqlite.js';

const config = loadConfig();
const db = openInitializedDatabase(config.dbPath, { log: console.log });

const app = createApp({
  db,
  openReader: () => openDatabase(config.dbPath, { queryOnly: true }),
  staticDir: config.staticDir,
  logRequests: config.logRequests,
});

const server = app.listen(config.port, config.host, () => {
  const { port } = server.address();
  const hasFrontend = fs.existsSync(path.join(config.staticDir, 'index.html'));
  console.log(`Database: ${config.dbPath} (${db.driver})`);
  console.log(`Certificate Admin Console listening on http://localhost:${port}`);
  if (!hasFrontend) console.log('Note: frontend build not found - serving the API only.');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${config.port} is already in use. Stop the other process or run with PORT=<free port>.`);
  } else {
    console.error(err);
  }
  process.exit(1);
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
