// @ts-check
/**
 * Broken-links / dead-resource scan.
 * For each configured site:
 *   - Crawls the homepage (single page, depth=0) and gathers same-origin links + referenced static resources.
 *   - Issues HEAD (fallback to GET) to every URL with a small concurrency pool.
 *   - Fails on any 4xx/5xx response.
 *
 * Note: this is a single-page crawl on purpose — keeps runtime predictable.
 * To deepen coverage add the URLs you want tested as separate entries in config/urls.json.
 */
const { test, expect } = require('@playwright/test');
const {
  loadSites,
  waitForVisuallyReady,
  collectSameOriginLinks,
  collectResourceUrls,
} = require('../utils/helpers');

const sites = loadSites();

const CONCURRENCY = 6;
const REQUEST_TIMEOUT = 15_000;

async function checkUrl(request, url) {
  try {
    let res = await request.fetch(url, { method: 'HEAD', timeout: REQUEST_TIMEOUT, maxRedirects: 5 });
    if (res.status() === 405 || res.status() === 501) {
      // HEAD not allowed — fall back to GET (Range trims body).
      res = await request.fetch(url, {
        method: 'GET',
        timeout: REQUEST_TIMEOUT,
        maxRedirects: 5,
        headers: { Range: 'bytes=0-1023' },
      });
    }
    return { url, status: res.status() };
  } catch (e) {
    return { url, status: 0, error: String(e && e.message ? e.message : e) };
  }
}

async function checkAll(request, urls) {
  const out = [];
  let i = 0;
  async function worker() {
    while (i < urls.length) {
      const idx = i++;
      out[idx] = await checkUrl(request, urls[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, urls.length) }, worker));
  return out;
}

for (const site of sites) {
  test.describe(`Links — ${site.name}`, () => {
    // Run only on one Chromium project so we don't hammer the target host with
    // N × HEAD probes. The describe-level `test.skip` callback in Playwright
    // does NOT receive `testInfo`, so we gate via `beforeEach` instead.
    test.beforeEach(async ({}, testInfo) => {
      test.skip(
        !testInfo.project.name.startsWith('Desktop Chrome'),
        'Broken-link probes only run on one project to avoid hammering the host.'
      );
    });

    test(`no broken same-origin links @${site.name}`, async ({ page, request }) => {
      await page.goto(site.url, { waitUntil: 'domcontentloaded' });
      await waitForVisuallyReady(page);

      const links = await collectSameOriginLinks(page);
      const results = await checkAll(request, links);
      const broken = results.filter((r) => r.status === 0 || r.status >= 400);
      expect(broken, `Broken links: ${JSON.stringify(broken, null, 2)}`).toEqual([]);
      test.info().annotations.push({
        type: 'links-checked',
        description: `${links.length} same-origin links validated`,
      });
    });

    test(`no broken resources (images/css/video) @${site.name}`, async ({ page, request }) => {
      await page.goto(site.url, { waitUntil: 'domcontentloaded' });
      await waitForVisuallyReady(page);

      const resources = await collectResourceUrls(page);
      const results = await checkAll(request, resources);
      const broken = results.filter((r) => r.status === 0 || r.status >= 400);
      expect(broken, `Broken resources: ${JSON.stringify(broken, null, 2)}`).toEqual([]);
      test.info().annotations.push({
        type: 'resources-checked',
        description: `${resources.length} resources validated`,
      });
    });
  });
}
