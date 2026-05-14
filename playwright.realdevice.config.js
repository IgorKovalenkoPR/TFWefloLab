// @ts-check
/**
 * "Real Device Emulation" config — the recommended replacement for real-mobile
 * BrowserStack testing (which BS Playwright Web Automate does not support).
 *
 * Combines everything that Chrome DevTools' Device Mode + a slow real device
 * does, but in Playwright (which means it's headless-able, parallelisable, and
 * runs in CI):
 *
 *   - Real device descriptor (viewport, DPR, touch, mobile UA) from
 *     Playwright's `devices` registry — same data Chrome DevTools uses
 *   - 4G LTE network throttling (configurable to 3G via env)
 *   - 4× CPU slowdown (mid-range Android-like)
 *   - Reduced-motion preference (so animations don't mess up assertions)
 *   - prefers-color-scheme: light (set explicitly for determinism)
 *   - Geolocation (Kyiv default; override via env)
 *   - Permissions for geolocation + clipboard
 *   - Video recording of every test (so you can replay what the "device" saw)
 *   - Real Chrome / Edge installation when available, with channel:'chrome'
 *     (closer to user's actual browser than Chromium open-source)
 *
 * Run:
 *   npm run test:realdevice                          # full matrix
 *   npm run test:realdevice -- --project='RD iPhone 14'
 *   THROTTLE=3g npm run test:realdevice              # slower network
 */
const { defineConfig, devices } = require('@playwright/test');

// `PWT_SLOWMO` is injected by the dashboard server when "Headed (show browser)"
// is enabled. It throttles every Playwright action (click / fill / hover /
// scroll) so a human can actually see them in real time. Defaults to 0
// (no throttle) for headless runs.
const SLOW_MO_MS = Number(process.env.PWT_SLOWMO || 0);
const _launchOpts = SLOW_MO_MS > 0 ? { launchOptions: { slowMo: SLOW_MO_MS } } : {};

// Network throttling profiles (matches Chrome DevTools presets)
const THROTTLES = {
  '4g':   { downloadKbps:  4096, uploadKbps:  3072, latencyMs:  20 },
  'lte':  { downloadKbps: 12000, uploadKbps: 12000, latencyMs:  10 },
  '3g':   { downloadKbps:  1638, uploadKbps:   768, latencyMs: 300 },
  '2g':   { downloadKbps:   240, uploadKbps:   240, latencyMs: 800 },
  'none': null,
};
const throttle = THROTTLES[String(process.env.THROTTLE || '4g').toLowerCase()] || THROTTLES['4g'];

// Geolocation default — Kyiv, Ukraine. Override via env.
const geolocation = {
  latitude: Number(process.env.GEO_LAT || 50.4501),
  longitude: Number(process.env.GEO_LON || 30.5234),
};

/**
 * Wrap a Playwright device descriptor with our Real-Device-Emulation extras.
 */
function rd(deviceName, extra = {}) {
  const d = devices[deviceName];
  if (!d) throw new Error(`Unknown device: ${deviceName}`);
  return {
    ...d,
    ...extra,
    ..._launchOpts,
    geolocation,
    permissions: ['geolocation', 'clipboard-read'],
    colorScheme: 'light',
    reducedMotion: 'reduce',
    locale: process.env.LOCALE || 'uk-UA',
    timezoneId: process.env.TZ || 'Europe/Kiev',
  };
}

const projects = [
  // ---------- Mobile phones (real DevTools-grade emulation) ----------
  { name: 'RD iPhone 14',          use: rd('iPhone 14') },
  { name: 'RD iPhone 14 Pro Max',  use: rd('iPhone 14 Pro Max') },
  { name: 'RD iPhone SE',          use: rd('iPhone SE') },
  { name: 'RD Pixel 7',            use: rd('Pixel 7') },
  { name: 'RD Pixel 5',            use: rd('Pixel 5') },
  { name: 'RD Galaxy S9+',         use: rd('Galaxy S9+') },

  // ---------- Tablets ----------
  { name: 'RD iPad Pro 11',        use: rd('iPad Pro 11') },
  { name: 'RD iPad Mini',          use: rd('iPad Mini') },
  { name: 'RD Galaxy Tab S4',      use: rd('Galaxy Tab S4') },

  // ---------- Desktop with realistic conditions ----------
  // Real Chrome (channel) — runs your installed Chrome, not Chromium open-source.
  {
    name: 'RD Desktop Chrome (1920×1080)',
    use: {
      ...devices['Desktop Chrome'],
      ..._launchOpts,
      channel: 'chrome',
      viewport: { width: 1920, height: 1080 },
      geolocation,
      permissions: ['geolocation', 'clipboard-read'],
      locale: process.env.LOCALE || 'uk-UA',
      timezoneId: process.env.TZ || 'Europe/Kiev',
    },
  },
  // Real Edge channel
  {
    name: 'RD Desktop Edge (1920×1080)',
    use: {
      ...devices['Desktop Edge'],
      ..._launchOpts,
      channel: 'msedge',
      viewport: { width: 1920, height: 1080 },
    },
  },
  // Real Safari (WebKit)
  {
    name: 'RD Desktop Safari (1440×900)',
    use: {
      ...devices['Desktop Safari'],
      ..._launchOpts,
      viewport: { width: 1440, height: 900 },
    },
  },
  // Real Firefox
  {
    name: 'RD Desktop Firefox (1920×1080)',
    use: {
      ...devices['Desktop Firefox'],
      ..._launchOpts,
      viewport: { width: 1920, height: 1080 },
    },
  },
];

module.exports = defineConfig({
  testDir: './tests',
  snapshotPathTemplate: '{testDir}/__screenshots__/{testFilePath}/{arg}-{projectName}-rd{ext}',
  fullyParallel: true,
  workers: process.env.CI ? 2 : undefined,
  retries: process.env.CI ? 1 : 0,
  // Global per-test budget. Slow Webflow sites with many internal links
  // (exploration spec probes header/footer/nav) can take real time over 4G
  // throttled connections; 3 minutes covers the worst legitimate case.
  // Individual tests can lower this with test.setTimeout() when appropriate.
  timeout: 180_000,
  reporter: [
    ['html', { open: 'never', outputFolder: 'playwright-report' }],
    ['list'],
    ['json', { outputFile: 'test-results/results.json' }],
  ],
  expect: {
    timeout: 12_000,
    toHaveScreenshot: { maxDiffPixelRatio: 0.02, threshold: 0.2, animations: 'disabled' },
  },
  use: {
    actionTimeout: 20_000,
    navigationTimeout: 45_000,
    // Force EVERY test to produce a video + trace + final-state screenshot,
    // not just failures. That way the Reports tab always has something to
    // show, even when tests pass — and "no failures" doesn't look like
    // "nothing happened".
    trace: 'on',
    video: 'on',
    screenshot: 'on',
    ignoreHTTPSErrors: true,
  },
  projects,
});

// Network throttling values are exported via env so the (optional) global
// setup file `tests/_realdevice-setup.js` can apply them via CDP at the start
// of each test. See that file for details.
process.env.RD_THROTTLE_DOWN = String(throttle ? throttle.downloadKbps : 0);
process.env.RD_THROTTLE_UP   = String(throttle ? throttle.uploadKbps : 0);
process.env.RD_THROTTLE_LAT  = String(throttle ? throttle.latencyMs : 0);
