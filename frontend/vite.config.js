import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The kind of run decides NODE_ENV, not whatever the shell happens to export:
// - the UI tests need React's development build (the production build has no act(), which every
//   test relies on), so a shell with NODE_ENV=production must not turn them into a production run;
// - `vite build` (part of `npm start`) always produces the production bundle, also in a shell
//   with NODE_ENV=development.
// The dev server keeps Vite's own default (development).
if (process.env.VITEST) process.env.NODE_ENV = 'test';
else if (process.argv.includes('build')) process.env.NODE_ENV = 'production';

// `npm start` serves the production build from the API server (one port, no proxy needed).
// `npm run dev` runs Vite separately and forwards /api to the backend.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': process.env.API_URL || 'http://localhost:3000',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  // `npm test` (Vitest): the real <App /> in a simulated DOM, with `fetch` answered from recorded
  // API responses (test/support/fakeServer.js). No backend, no browser and no network involved.
  test: {
    environment: 'happy-dom',
    include: ['test/**/*.test.{js,jsx}'],
    setupFiles: ['test/setup.js'],
    restoreMocks: true,
    unstubGlobals: true,
  },
});
