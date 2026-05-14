// @ts-check
/**
 * Accessibility (a11y) suite — runs axe-core against every URL on every project.
 *
 * Covers WCAG 2.1 A & AA rule packs. Fails on `serious` and `critical` violations;
 * `moderate`/`minor` are reported as annotations so the team can triage them.
 */
const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const { loadSites, waitForVisuallyReady } = require('../utils/helpers');

const sites = loadSites();

for (const site of sites) {
  test.describe(`A11y — ${site.name}`, () => {
    test(`axe-core scan @${site.name}`, async ({ page }, testInfo) => {
      await page.goto(site.url, { waitUntil: 'domcontentloaded' });
      await waitForVisuallyReady(page);

      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'])
        // Webflow markup commonly trips colour-contrast inside designer-managed components;
        // we keep the rule on but log moderate findings for triage.
        .analyze();

      const byImpact = (impact) =>
        results.violations.filter((v) => v.impact === impact);

      const critical = byImpact('critical');
      const serious = byImpact('serious');
      const moderate = byImpact('moderate');
      const minor = byImpact('minor');

      // Attach the full report for the HTML report viewer.
      await testInfo.attach('axe-violations.json', {
        body: JSON.stringify(results.violations, null, 2),
        contentType: 'application/json',
      });

      testInfo.annotations.push({
        type: 'a11y-summary',
        description: `critical=${critical.length} serious=${serious.length} moderate=${moderate.length} minor=${minor.length}`,
      });

      const blocking = [...critical, ...serious].map((v) => ({
        id: v.id,
        impact: v.impact,
        help: v.help,
        nodes: v.nodes.length,
      }));

      expect(
        blocking,
        `Blocking a11y violations:\n${JSON.stringify(blocking, null, 2)}`
      ).toEqual([]);

      // Soft-fail moderate/minor by emitting them as annotations only.
      [...moderate, ...minor].forEach((v) =>
        testInfo.annotations.push({
          type: `a11y-${v.impact}`,
          description: `${v.id}: ${v.help} (${v.nodes.length} node${v.nodes.length === 1 ? '' : 's'})`,
        })
      );
    });

    test(`keyboard-only navigation reaches main content @${site.name}`, async ({ page }) => {
      await page.goto(site.url, { waitUntil: 'domcontentloaded' });
      await waitForVisuallyReady(page);

      // Tab a handful of times and confirm focus actually moves through interactive elements.
      const focusTrail = [];
      for (let i = 0; i < 15; i++) {
        await page.keyboard.press('Tab');
        const info = await page.evaluate(() => {
          const el = document.activeElement;
          if (!el || el === document.body) return null;
          return {
            tag: el.tagName.toLowerCase(),
            role: el.getAttribute('role') || null,
            visible: !!(el && el.getClientRects().length),
          };
        });
        if (info) focusTrail.push(info);
      }
      expect(focusTrail.length, 'tab key should move focus through the page').toBeGreaterThan(0);
      const visibleFocus = focusTrail.filter((f) => f.visible).length;
      expect(visibleFocus, 'most focusable elements should be visible').toBeGreaterThan(focusTrail.length / 2);
    });
  });
}
