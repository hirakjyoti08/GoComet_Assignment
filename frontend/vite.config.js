import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': 'http://localhost:4000' } },
  test: {
    environment: 'jsdom',
    globals: true, // lets Testing Library auto-cleanup between tests
    include: ['src/**/*.test.{js,jsx}'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{js,jsx}'],
      exclude: ['src/**/*.test.*', 'src/main.jsx'],
      reporter: ['text', 'lcov'],
      // Unit tests target the logic modules; full pages are covered by the Playwright E2E suite.
      thresholds: {
        'src/format.js': { lines: 95, functions: 85, branches: 90 },
        'src/components/ui.jsx': { lines: 60, functions: 50, branches: 60 },
      },
    },
  },
});
