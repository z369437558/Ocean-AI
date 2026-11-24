// Development mode: API with auto-restart on :3000 and the Vite dev server (hot reload) on :5173.
// Not needed to run or evaluate the app - `npm start` serves the production build from one port.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

const children = [
  spawn(process.execPath, ['--watch', 'src/server.js'], {
    cwd: path.join(root, 'backend'),
    stdio: 'inherit',
    env: { ...process.env, PORT: apiPort },
  }),
  spawn(process.execPath, [viteBin], {
    cwd: path.join(root, 'frontend'),
    stdio: 'inherit',
    env: { ...process.env, API_URL: `http://localhost:${apiPort}` },
  }),
];

let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 500).unref();
}

for (const child of children) child.on('exit', (code) => stop(code ?? 0));
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
