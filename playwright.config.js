import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: 'tests/browser',
  workers: 1,
  fullyParallel: false,
  timeout: 180000,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { trace: 'retain-on-failure' },
  webServer: [
    {
      command: 'npm run demo',
      url: 'http://127.0.0.1:4173/health',
      reuseExistingServer: true,
      timeout: 30000,
    },
    {
      command: 'node demo/server.mjs',
      env: { PORT: '4174' },
      url: 'http://127.0.0.1:4174/advanced',
      reuseExistingServer: false,
      timeout: 30000,
    },
  ],
});
