import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

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
