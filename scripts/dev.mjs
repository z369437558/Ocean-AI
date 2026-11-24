// Development mode: API with auto-restart on :3000 and the Vite dev server (hot reload) on :5173.
// Not needed to run or evaluate the app - `npm start` serves the production build from one port.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { reachableHost } from '../backend/src/config.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'frontend', 'package.json'));
let viteBin;
try {
  viteBin = path.join(path.dirname(require.resolve('vite/package.json')), 'bin', 'vite.js');
} catch {
  console.error('The dependencies are not installed yet. Run "npm start" once (or "npm install"), then "npm run dev" again.');
  process.exit(1);
}
const apiPort = process.env.PORT?.trim() || '3000'; // blank counts as not set, as everywhere else
// Where Vite finds the API: with HOST set to one address the server answers there and nowhere else.
const apiUrl = `http://${reachableHost(process.env.HOST?.trim())}:${apiPort}`;

// Where the system has process groups, the API gets one of its own. `node --watch` is two
// processes - the watcher and the server it restarts - and a watcher that is caught while it starts
// can survive the signal that should end it. A signal to the group ends both, in whatever state
// the watcher is.
const OWN_GROUP = process.platform !== 'win32';
const started = []; // { child, ownGroup, gone }
let stopping = false;
function send(signal, entry) {
  try {
    if (entry.ownGroup) process.kill(-entry.child.pid, signal);
    else entry.child.kill(signal);
  } catch {
    // gone already
  }
}
/** Ends the command: nothing it started outlives it. */
function exit() {
  for (const entry of started) send('SIGKILL', entry);
  process.exit(process.exitCode ?? 0);
}
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const entry of started) send('SIGTERM', entry);
  setTimeout(exit, 500); // whatever has not ended by then is ended the hard way
}
function run(args, options, { ownGroup = false } = {}) {
  const child = spawn(process.execPath, args, { ...options, detached: ownGroup });
  const entry = { child, ownGroup, gone: false };
  child.on('exit', (code) => {
    entry.gone = true;
    stop(code ?? 0); // one of the two has ended: the other one is of no use alone
    if (started.every((other) => other.gone)) exit();
  });
  started.push(entry);
  return child;
}
// Before anything is started: Ctrl+C, a SIGTERM or a closed terminal at any moment ends whatever
// is running by then.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => stop(0));

// The API comes first, and its output passes through here: Vite is only started once the API is
// listening, and a first start that fails - a setting, the port, the database - ends the command
// with the API's own one-line message. Left to itself `node --watch` would report the failure and
// wait for a file to change, with a dev server next to it that has nothing to talk to.
// Once the API has been up, failures are the ordinary business of watch mode (a typo while
// editing) and are left to it.
const api = run(
  ['--watch', 'src/server.js'],
  {
    cwd: path.join(root, 'backend'),
    stdio: ['ignore', 'pipe', 'pipe'], // a group of its own has no terminal to read from
    env: { ...process.env, PORT: apiPort },
  },
  { ownGroup: OWN_GROUP },
);
let apiHasBeenUp = false;
let firstOutput = '';
function passOn(stream, chunk) {
  if (apiHasBeenUp) {
    stream.write(chunk);
    return;
  }
  firstOutput += chunk;
  if (firstOutput.includes('Failed running')) {
    stop(1); // the API has said why, in the line before; watch mode's "waiting for file changes" is not passed on
    return;
  }
  stream.write(chunk);
  if (firstOutput.includes(' listening on ')) {
    apiHasBeenUp = true;
    if (stopping) return; // the command was stopped while the API came up: start nothing new
    run([viteBin], {
      cwd: path.join(root, 'frontend'),
      stdio: 'inherit',
      env: { ...process.env, API_URL: apiUrl },
    });
  }
}
api.stdout.on('data', (chunk) => passOn(process.stdout, chunk));
api.stderr.on('data', (chunk) => passOn(process.stderr, chunk));
