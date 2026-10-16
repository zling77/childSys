import { defineConfig } from '@playwright/test';

const chromePath = process.env.PLAYWRIGHT_CHROME_PATH
  ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 35_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:5276',
    browserName: 'chromium',
    headless: true,
    launchOptions: { executablePath: chromePath },
    viewport: { width: 1440, height: 1000 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'node scripts/e2e-dev.mjs',
    url: 'http://127.0.0.1:5276',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
