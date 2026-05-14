// @ts-check
/**
 * SEO / metadata suite. Validates the on-page tags Webflow lets you set in
 * page settings:
 *   - <title>
 *   - <meta name="description">
 *   - canonical link
 *   - viewport meta
 *   - charset
 *   - Open Graph (og:title, og:description, og:image, og:url, og:type)
 *   - Twitter card (twitter:card, twitter:title, twitter:description)
 *   - Favicon present
 *   - <html lang="">
 *   - One <h1>, ordered headings
 *   - robots meta does not accidentally noindex
 *   - sitemap.xml + robots.txt reachable on the host
 */
const { test, expect } = require('@playwright/test');
const { loadSites, waitForVisuallyReady } = require('../utils/helpers');

const sites = loadSites();

const MAX_TITLE = 65;
const MAX_DESC = 165;

for (const site of sites) {
  test.describe(`SEO — ${site.name}`, () => {
    test(`metadata tags @${site.name}`, async ({ page }) => {
      await page.goto(site.url, { waitUntil: 'domcontentloaded' });
      await waitForVisuallyReady(page);

      const meta = await page.evaluate(() => {
        const get = (sel, attr = 'content') => {
          const el = document.querySelector(sel);
          return el ? el.getAttribute(attr) : null;
        };
        return {
          title: document.title,
          description: get('meta[name="description"]'),
          canonical: get('link[rel="canonical"]', 'href'),
          viewport: get('meta[name="viewport"]'),
          charset: document.characterSet,
          robots: get('meta[name="robots"]'),
          ogTitle: get('meta[property="og:title"]'),
          ogDescription: get('meta[property="og:description"]'),
          ogImage: get('meta[property="og:image"]'),
          ogUrl: get('meta[property="og:url"]'),
          ogType: get('meta[property="og:type"]'),
          twCard: get('meta[name="twitter:card"]'),
          twTitle: get('meta[name="twitter:title"]'),
          twDescription: get('meta[name="twitter:description"]'),
          favicon: get('link[rel~="icon"]', 'href'),
          htmlLang: document.documentElement.getAttribute('lang'),
          h1Count: document.querySelectorAll('h1').length,
          headings: Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6')).map(
            (h) => Number(h.tagName.substring(1))
          ),
        };
      });

      // Title
      expect(meta.title.trim().length, 'title required').toBeGreaterThan(0);
      expect(meta.title.length, `title <= ${MAX_TITLE} chars`).toBeLessThanOrEqual(MAX_TITLE);

      // Description
      expect(meta.description, 'meta description required').not.toBeNull();
      if (meta.description) {
        expect(meta.description.length, `description <= ${MAX_DESC} chars`).toBeLessThanOrEqual(MAX_DESC);
      }

      // Canonical
      expect(meta.canonical, 'canonical URL required').not.toBeNull();

      // Viewport (mobile-friendliness)
      expect(meta.viewport, 'viewport meta required').not.toBeNull();
      expect(meta.viewport.toLowerCase()).toContain('width=device-width');

      // Charset
      expect(meta.charset.toLowerCase()).toMatch(/utf-8|utf8/);

      // Robots — must not noindex production
      if (meta.robots) {
        expect(meta.robots.toLowerCase(), 'page should not be noindex').not.toMatch(/noindex/);
      }

      // Open Graph
      expect(meta.ogTitle, 'og:title required').not.toBeNull();
      expect(meta.ogDescription, 'og:description required').not.toBeNull();
      expect(meta.ogImage, 'og:image required').not.toBeNull();

      // Twitter card
      expect(meta.twCard, 'twitter:card required').not.toBeNull();

      // Favicon
      expect(meta.favicon, 'favicon required').not.toBeNull();

      // HTML lang
      expect(meta.htmlLang, '<html lang> required').not.toBeNull();

      // Heading structure
      expect(meta.h1Count, 'exactly one <h1>').toBe(1);
      // Headings should not skip levels (e.g. h2 -> h4)
      let prev = 0;
      for (const lvl of meta.headings) {
        if (prev !== 0 && lvl > prev + 1) {
          throw new Error(`Heading level skipped: h${prev} -> h${lvl}`);
        }
        prev = lvl;
      }
    });

    test(`robots.txt + sitemap.xml reachable @${site.name}`, async ({ request, page }) => {
      await page.goto(site.url, { waitUntil: 'domcontentloaded' });
      const origin = new URL(page.url()).origin;

      const robots = await request.get(`${origin}/robots.txt`);
      expect(robots.status(), 'robots.txt should be reachable').toBeLessThan(400);

      const sitemap = await request.get(`${origin}/sitemap.xml`);
      expect(sitemap.status(), 'sitemap.xml should be reachable').toBeLessThan(400);
    });
  });
}
