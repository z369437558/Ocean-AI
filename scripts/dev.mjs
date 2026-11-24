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

const children = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code; // also when the process ends by itself, once the children are gone
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 500).unref();
}
function run(args, options) {
  const child = spawn(process.execPath, args, options);
  child.on('exit', (code) => stop(code ?? 0));
  children.push(child);
  return child;
}

// The API comes first, and its output passes through here: Vite is only started once the API is
// listening, and a first start that fails - a setting, the port, the database - ends the command
// with the API's own one-line message. Left to itself `node --watch` would report the failure and
// wait for a file to change, with a dev server next to it that has nothing to talk to.
// Once the API has been up, failures are the ordinary business of watch mode (a typo while
// editing) and are left to it.
const api = run(['--watch', 'src/server.js'], {
  cwd: path.join(root, 'backend'),
  stdio: ['inherit', 'pipe', 'pipe'],
  env: { ...process.env, PORT: apiPort },
});
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
    run([viteBin], {
      cwd: path.join(root, 'frontend'),
      stdio: 'inherit',
      env: { ...process.env, API_URL: apiUrl },
    });
  }
}
api.stdout.on('data', (chunk) => passOn(process.stdout, chunk));
api.stderr.on('data', (chunk) => passOn(process.stderr, chunk));

process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
