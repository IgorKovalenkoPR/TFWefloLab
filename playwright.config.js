// @ts-check
const { defineConfig, devices } = require('@playwright/test');

/**
 * Playwright configuration for Webflow sites testing.
 *
 * Covers the environments required:
 *   Web:
 *     - macOS: Chrome, Safari
 *     - Windows 11: Chrome, Firefox, Edge
 *   Mobile web:
 *     - Android: Chrome (Pixel 7)
 *     - iOS: Safari, Chrome (iPhone 14 — iOS Chrome uses WebKit under the hood)
 *   Tablet:
 *     - Apple: Safari, Chrome (iPad Pro 11)
 *     - Android: Chrome (Galaxy Tab S4)
 *
 * Different resolutions for mobile/tablet are covered both by the device descriptors
 * here AND by tests/responsive.spec.js which iterates an additional matrix of viewports.
 */
module.exports = defineConfig({
  testDir: './tests',
  // Visual regression snapshots are stored next to the spec, OS-tagged.
  snapshotPathTemplate: '{testDir}/__screenshots__/{testFilePath}/{arg}-{projectName}{ext}',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: [
    ['html', { open: 'never', outputFolder: 'playwright-report' }],
    ['list'],
    ['json', { outputFile: 'test-results/results.json' }],
  ],
  timeout: 180_000, // 3 min — covers slow Webflow sites + parallel link probes
  expect: {
    timeout: 10_000,
    toHaveScreenshot: {
      // Tolerate small antialiasing/font diffs across OSes.
      maxDiffPixelRatio: 0.02,
      threshold: 0.2,
      animations: 'disabled',
      caret: 'hide',
    },
  },
  use: {
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    // Always record so reports are populated whether tests pass or fail.
    // Storage cost is bounded by the run size; the value to QA is huge.
    trace: 'on',
    screenshot: 'on',
    video: 'on',
    ignoreHTTPSErrors: true,
  },

  projects: [
    // ---------------- Desktop ----------------
    {
      name: 'Desktop Chrome (Windows 11)',
      use: {
        ...devices['Desktop Chrome'],
        channel: 'chrome',
        viewport: { width: 1920, height: 1080 },
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      },
    },
    {
      name: 'Desktop Firefox (Windows 11)',
      use: {
        ...devices['Desktop Firefox'],
        viewport: { width: 1920, height: 1080 },
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
      },
    },
    {
      name: 'Desktop Edge (Windows 11)',
      use: {
        ...devices['Desktop Edge'],
        channel: 'msedge',
        viewport: { width: 1920, height: 1080 },
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0',
      },
    },
    {
      name: 'Desktop Chrome (macOS)',
      use: {
        ...devices['Desktop Chrome'],
        channel: 'chrome',
        viewport: { width: 1440, height: 900 },
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      },
    },
    {
      name: 'Desktop Safari (macOS)',
      use: {
        ...devices['Desktop Safari'],
        viewport: { width: 1440, height: 900 },
      },
    },

    // ---------------- Mobile ----------------
    {
      name: 'Mobile Chrome (Android - Pixel 7)',
      use: { ...devices['Pixel 7'] },
    },
    {
      name: 'Mobile Safari (iPhone 14)',
      use: { ...devices['iPhone 14'] },
    },
    {
      // iOS Chrome is WebKit-based (Apple policy). We emulate iPhone 14 viewport with a Chrome iOS UA.
      name: 'Mobile Chrome (iOS - iPhone 14)',
      use: {
        ...devices['iPhone 14'],
        userAgent:
          'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/124.0.0.0 Mobile/15E148 Safari/604.1',
      },
    },

    // ---------------- Tablet ----------------
    {
      name: 'Tablet Safari (iPad Pro 11)',
      use: { ...devices['iPad Pro 11'] },
    },
    {
      // Same caveat — iPadOS Chrome is WebKit-based.
      name: 'Tablet Chrome (iPad Pro 11)',
      use: {
        ...devices['iPad Pro 11'],
        userAgent:
          'Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/124.0.0.0 Mobile/15E148 Safari/604.1',
      },
    },
    {
      name: 'Tablet Chrome (Android - Galaxy Tab S4)',
      use: { ...devices['Galaxy Tab S4'] },
    },
  ],
});
