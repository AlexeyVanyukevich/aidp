import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests/ui',
  testMatch: '**/*.spec.ts',
  globalSetup: './tests/ui/global-setup.ts',
  // One database, one server, one runner: the journeys share them.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 120_000,
  // The json report lands in test-results/, which Playwright empties at the start of each run;
  // `./run check:all` reads it for the flaky journeys.
  reporter: [['list'], ['json', { outputFile: 'test-results/report.json' }]],
  use: { trace: 'retain-on-failure' },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
  ],
})
