// End-to-end tests: the real app (built frontend served by the real backend on an in-memory
// PostgreSQL) driven through a real browser, with several users in separate browser contexts.
import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT || 4310);
const isCI = !!process.env.CI;

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,          // tests share one server; each creates its own users and RFQs
  workers: 1,
  retries: isCI ? 1 : 0,
  forbidOnly: isCI,
  reporter: isCI ? [['github'], ['html', { open: 'never' }]] : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: isCI ? 'retain-on-failure' : 'off', // needs Playwright's ffmpeg, installed in CI
  },
  projects: [{
    name: 'chromium',
    // Locally you can reuse an installed Chrome instead of downloading browsers: PW_CHANNEL=chrome
    use: { ...devices['Desktop Chrome'], ...(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {}) },
  }],
  webServer: {
    command: 'npm --prefix ../frontend run build && node ../backend/src/server.js',
    url: `http://localhost:${PORT}/api/ready`,
    reuseExistingServer: !isCI,
    timeout: 120_000,
    env: {
      PORT: String(PORT),
      PGLITE_DIR: 'memory://',         // fresh database every run
      RATE_LIMIT_ENABLED: 'false',     // many sign-ups from one IP
      LOG_LEVEL: 'warn',
      STATIC_DIR: '../frontend/dist',
    },
  },
});
