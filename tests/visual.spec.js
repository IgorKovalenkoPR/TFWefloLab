// @ts-check
/**
 * Visual regression suite.
 * Captures full-page screenshots per browser/device project AND per the
 * additional viewport widths we care about. Snapshots are stored under
 * tests/__screenshots__/<spec>/<name>-<projectName>.png (set in playwright.config.js).
 *
 * First run (no baseline): `npm run test:visual:update`.
 * Subsequent runs (compare): `npm run test:visual`.
 */
const { test, expect } = require('@playwright/test');
const {
  loadSites,
  siteSlug,
  waitForVisuallyReady,
  freezeAnimations,
} = require('../utils/helpers');

const sites = loadSites();

const VIEWPORTS = [
  { label: 'mobile-360', width: 360, height: 800 },
  { label: 'mobile-390', width: 390, height: 844 },
  { label: 'tablet-768', width: 768, height: 1024 },
  { label: 'tablet-1024', width: 1024, height: 1366 },
  { label: 'desktop-1440', width: 1440, height: 900 },
];

for (const site of sites) {
  test.describe(`Visual — ${site.name}`, () => {
    test.describe.configure({ mode: 'serial' });

    for (const vp of VIEWPORTS) {
      test(`${vp.label} screenshot @${site.name}`, async ({ page, browserName }) => {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await page.goto(site.url, { waitUntil: 'domcontentloaded' });
        await waitForVisuallyReady(page);
        await freezeAnimations(page);

        // Mask common dynamic regions so they don't cause false positives.
        const masks = [
          page.locator('[data-w-id*="cookie"]'),
          page.locator('.cookie, .cookies, .cookie-banner, #cookie, [id*="cookie"]'),
          page.locator('time, [datetime]'),
          page.locator('iframe'),
        ].filter(Boolean);

        await expect(page).toHaveScreenshot(
          `${siteSlug(site)}-${vp.label}.png`,
          {
            fullPage: true,
            mask: masks,
            timeout: 30_000,
          }
        );

        // browserName is captured by snapshot path template, but log it for debugging.
        test.info().annotations.push({ type: 'engine', description: browserName });
      });
    }
  });
}
