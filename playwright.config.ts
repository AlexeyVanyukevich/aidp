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
  reporter: [['list']],
  use: { trace: 'retain-on-failure' },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
  ],
})
