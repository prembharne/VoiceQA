// Verify the real built extension against the registered host, without changing registration.
import { chromium } from '@playwright/test';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
await mkdir(resolve('test-results'), { recursive: true });
const folder = await mkdtemp(resolve('test-results/installed-'));
let context;
try {
  context = await chromium.launchPersistentContext(resolve(folder, 'profile'), {
    channel: 'chromium',
    headless: true,
    args: [
      `--disable-extensions-except=${resolve('dist/extension')}`,
      `--load-extension=${resolve('dist/extension')}`,
    ],
    env: {
      ...process.env,
      VOICEQA_DATA_DIR: resolve(folder, 'data'),
      OPENAI_API_KEY: '',
      VOICEQA_TTS_API_KEY: '',
    },
  });
  const worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
  const extensionId = new URL(worker.url()).host;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/panel.html`);
  await page.getByText('Engine connected', { exact: true }).waitFor({ timeout: 15000 });
  await page.setViewportSize({ width: 420, height: 1000 });
  await page.screenshot({ path: resolve('test-results/installed-panel.png'), fullPage: true });
  console.log(`Installed extension ${extensionId}: real native connection passed.`);
} finally {
  await context?.close();
}
