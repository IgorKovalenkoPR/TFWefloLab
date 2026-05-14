// @ts-check
/**
 * BrowserStack Playwright config — runs the same test suite on real macOS /
 * Windows machines via BrowserStack Automate (Web Automate / Playwright).
 *
 * IMPORTANT — what BrowserStack Playwright Web Automate supports:
 *   ✅ Real Windows (10, 11) + Chromium, Firefox
 *   ✅ Real macOS (Big Sur — Sonoma) + Chromium, Firefox, WebKit (= real Safari)
 *   ❌ Real mobile devices (iOS / Android phones, tablets) — NOT supported via
 *      Playwright Web Automate. BrowserStack only exposes real mobile devices
 *      to Playwright through their App Automate (native apps) product.
 *      For Playwright web testing on mobile-shaped viewports, use the local
 *      "Real Device Emulation" config (playwright.config.js — Mobile / Tablet
 *      projects) which is Chrome-DevTools-grade emulation.
 *
 * Cap names per BS docs (https://www.browserstack.com/list-of-browsers-and-platforms/playwright):
 *   browser: 'playwright-chromium' | 'playwright-firefox' | 'playwright-webkit'
 *   os:      'Windows' | 'OS X'
 *   os_version: '11' | '10' | 'Sonoma' | 'Ventura' | …
 *
 * Setup:
 *   1. BrowserStack Automate account (https://www.browserstack.com/automate).
 *   2. Put credentials in `.env`:
 *        BROWSERSTACK_USERNAME=…
 *        BROWSERSTACK_ACCESS_KEY=…
 *   3. Verify with: dashboard → Run tab → Config: BrowserStack → Diagnose.
 *   4. Run:
 *        npm run test:bs                     # full BS desktop matrix
 *        npm run test:bs -- --project='BS Safari (macOS Sonoma)'
 */
const { defineConfig } = require('@playwright/test');
const { wsEndpointFor, BUILD_NAME, REQUIRES_CREDS } = require('./browserstack/connector');

if (REQUIRES_CREDS && (!process.env.BROWSERSTACK_USERNAME || !process.env.BROWSERSTACK_ACCESS_KEY)) {
  console.warn(
    '\n[BrowserStack] BROWSERSTACK_USERNAME / BROWSERSTACK_ACCESS_KEY are not set.\n' +
    '              Tests will fail to connect. See playwright.browserstack.config.js.\n'
  );
}

/**
 * Each project maps to one BrowserStack OS/browser combination. We use the
 * `playwright-*` browser caps that BrowserStack expects for Playwright
 * (`chrome`/`edge` are Selenium caps and won't authenticate via the Playwright
 * WebSocket endpoint — that's why they fail with "Invalid username or password").
 */
const PROJECTS = [
  // ---------- Real Windows machines ----------
  {
    name: 'BS Chromium (Windows 11)',
    caps: { browser: 'playwright-chromium', os: 'Windows', os_version: '11' },
  },
  {
    name: 'BS Firefox (Windows 11)',
    caps: { browser: 'playwright-firefox', os: 'Windows', os_version: '11' },
  },
  {
    name: 'BS Chromium (Windows 10)',
    caps: { browser: 'playwright-chromium', os: 'Windows', os_version: '10' },
  },
  // ---------- Real macOS machines ----------
  {
    name: 'BS Chromium (macOS Sonoma)',
    caps: { browser: 'playwright-chromium', os: 'OS X', os_version: 'Sonoma' },
  },
  {
    name: 'BS Firefox (macOS Sonoma)',
    caps: { browser: 'playwright-firefox', os: 'OS X', os_version: 'Sonoma' },
  },
  {
    name: 'BS Safari / WebKit (macOS Sonoma)',
    caps: { browser: 'playwright-webkit', os: 'OS X', os_version: 'Sonoma' },
  },
  {
    name: 'BS Safari / WebKit (macOS Ventura)',
    caps: { browser: 'playwright-webkit', os: 'OS X', os_version: 'Ventura' },
  },
];

const projects = PROJECTS.map(({ name, caps }) => ({
  name,
  use: {
    connectOptions: {
      wsEndpoint: wsEndpointFor({ ...caps, name, build: BUILD_NAME }),
    },
    viewport: { width: 1366, height: 768 },
  },
}));

module.exports = defineConfig({
  testDir: './tests',
  snapshotPathTemplate: '{testDir}/__screenshots__/{testFilePath}/{arg}-{projectName}-bs{ext}',
  fullyParallel: false,
  workers: Number(process.env.BS_WORKERS || 1),
  retries: 1,
  timeout: 120_000,
  reporter: [
    ['html', { open: 'never', outputFolder: 'playwright-report' }],
    ['list'],
    ['json', { outputFile: 'test-results/results.json' }],
  ],
  expect: {
    timeout: 15_000,
    toHaveScreenshot: { maxDiffPixelRatio: 0.05, threshold: 0.25, animations: 'disabled' },
  },
  use: {
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ignoreHTTPSErrors: true,
  },
  projects,
});
