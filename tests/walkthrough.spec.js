// @ts-check
/**
 * QA walkthrough — the way a real human tester checks a Webflow site.
 *
 * ONE test per (site × device) that drives the page as a continuous session:
 *   1. Open homepage          — HTTP, title, h1, console hygiene
 *   2. Scroll the full page   — visibly, with cursor on screen; collect broken imgs
 *   3. Open the menu          — hamburger on mobile/tablet, hover dropdowns on desktop
 *   4. Visit 3 internal pages — click each top-level nav item; on each page check
 *                                clipped text, icon-font fallbacks, console errors
 *   5. Scroll to footer       — verify social links go to plausible domains
 *   6. Try the contact form   — fill fields with sample data (don't submit)
 *
 * Findings accumulate into a single structured array, attached as
 * `findings.json`. The test "passes" if no Critical issues are found;
 * High/Medium are reported but don't fail the run (you'll see them in the
 * report). That mirrors a real QA pass: not "stop the world on first issue"
 * but "walk through and write up everything you saw".
 *
 * Designed to run in 3–5 minutes per device, end-to-end, producing ONE
 * linear video you can watch like a screen recording.
 */
const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const {
  loadSites,
  waitForVisuallyReady,
  installCursorVisualizer,
  scrollPageVisible,
  findClippedText,
  findIconFontFallbacks,
  findHeaderNavOverflow,
  findMisplacedModals,
  findTinyTapTargets,
  highlightAndScreenshot,
} = require('../utils/helpers');

const sites = loadSites();

// Severity hierarchy used in findings.
const SEV = { CRITICAL: 'Critical', HIGH: 'High', MEDIUM: 'Medium', LOW: 'Low', INFO: 'Info' };

// ── Noise filter ─────────────────────────────────────────────────────────
// Errors coming from these URL schemes are produced by the browser itself
// (DevTools, extensions, internal Chrome resources) — they are NOT bugs in
// the site under test. Reporting them as site defects is a false positive
// the user explicitly called out: "web-inspector://bootstrap.js" is a Chrome
// internal, not the site's JavaScript.
const NOISE_URL_RE = /\b(web-inspector|chrome-extension|chrome|devtools|edge-extension|moz-extension|safari-extension|safari-web-extension|extension|webkit-masked-url):/i;
const NOISE_MSG_RE =
  /\bResizeObserver loop|\bNon-Error promise rejection captured|\bScript error\.?$/i;
function isErrorNoise(message, frame, stack) {
  const text = `${message || ''} ${frame || ''} ${stack || ''}`;
  if (NOISE_URL_RE.test(text)) return true;
  if (NOISE_MSG_RE.test(message || '')) return true;
  return false;
}

// ── Plain-language translator ────────────────────────────────────────────
// Maps technical JavaScript error messages to a user-friendly title + impact
// statement. The original technical text is kept on the finding as `devDetail`
// for developers, but the headline is something a QA / PM / designer can
// understand without knowing JavaScript.
function humanizeJsError(raw) {
  const m = String(raw || '');
  if (/Cannot read prop(erties)?|of (null|undefined)/i.test(m)) {
    return {
      title: 'A script tried to use a page element that does not exist',
      impact:
        'Any feature wired to that element (clicks, animations, sliders, form steps) will silently fail. Visitors may see a broken interaction but no error message.',
    };
  }
  if (/MutationObserver|IntersectionObserver|ResizeObserver/i.test(m)) {
    return {
      title: 'A script tried to monitor a page element that was not found',
      impact:
        'Likely a Webflow IX2 animation or custom code looking for an element that was renamed or removed in Designer. Animations tied to that element will not trigger.',
    };
  }
  if (/addEventListener|removeEventListener/i.test(m) && /(null|undefined)/i.test(m)) {
    return {
      title: 'A click / scroll handler could not attach — its target element is missing',
      impact:
        'Buttons or triggers tied to that handler will not respond when clicked, scrolled, or hovered.',
    };
  }
  if (/is not a function/i.test(m)) {
    return {
      title: 'A script called something that does not exist',
      impact:
        'Often a third-party library failed to load (network error / blocked by adblock / wrong CDN URL) and any code that depended on it crashed.',
    };
  }
  if (/Failed to fetch|NetworkError|Load failed|ERR_/i.test(m)) {
    return {
      title: 'A network request failed during the page session',
      impact:
        'Forms may not submit, embedded widgets may stay blank, third-party content (chat, analytics, CMS data) may not load.',
    };
  }
  if (/Unexpected token|SyntaxError/i.test(m)) {
    return {
      title: 'A script could not be parsed — broken JavaScript file',
      impact:
        'The entire script that fails to parse stops executing. Anything it was meant to do (interactions, validations, integrations) is dead until the file is fixed.',
    };
  }
  if (/CORS|Cross-Origin/i.test(m)) {
    return {
      title: 'A cross-origin request was blocked by the browser',
      impact:
        'Resources from another domain (images, API calls, embeds) refused to load. Anything depending on that resource is broken.',
    };
  }
  if (/quota|QuotaExceeded/i.test(m)) {
    return {
      title: 'Browser storage is full — the page could not save state',
      impact:
        'Anything relying on localStorage / sessionStorage (cart contents, form drafts, dismissed banners) will reset on every visit.',
    };
  }
  // Generic fallback — still better than the raw stack trace.
  return {
    title: 'A JavaScript error happened during the user journey',
    impact:
      'Whatever the failing script was supposed to do (animations, form logic, dynamic content) is broken on this device.',
  };
}

// Map common axe-core rule IDs to a plain-English impact line so the
// accessibility cards don't read like compliance jargon.
const AXE_IMPACT = {
  'html-has-lang': 'Screen readers cannot pick the right language to announce — text reads in the wrong accent / voice for assistive-tech users.',
  'document-title': 'The browser tab shows nothing useful, and the page can be unfindable in user history / search results.',
  'color-contrast': 'Some users (low-vision, sunlight, older monitors) literally cannot read the text on top of its background.',
  'link-name': 'Screen readers announce the link as "link" or read the raw URL — keyboard / blind users have no idea what it does.',
  'image-alt': 'Screen readers skip the image entirely or read out the filename — visually-impaired users lose the information the image carries.',
  'button-name': 'Screen readers announce just "button" — the user has to guess what tapping it will do.',
  'label': 'Form fields have no spoken / visual label, so users can\'t tell which field is for what (name vs email vs phone).',
  'landmark-one-main': 'Screen-reader keyboard shortcuts ("jump to main content") don\'t work — users have to tab through the menu on every page.',
  'region': 'Page sections aren\'t announced as separate regions, so users can\'t skip the header / footer / sidebar.',
  'aria-required-attr': 'ARIA attributes are incomplete — assistive tech can\'t parse the widget and announces it incorrectly or not at all.',
  'aria-valid-attr-value': 'ARIA attribute has an invalid value — assistive tech treats the widget as broken and skips it.',
  'duplicate-id': 'Two elements share the same id — clicking a label may activate the wrong field, anchor links may scroll to the wrong place.',
  'meta-viewport': 'Mobile users cannot pinch-zoom — small text becomes unreadable for low-vision visitors.',
  'tabindex': 'Tab order is wrong — keyboard users jump around the page unpredictably and can lose track of where they are.',
};
function axeImpact(ruleId, fallback) {
  return AXE_IMPACT[ruleId] || fallback || 'Users relying on assistive technologies (screen readers, keyboard, screen magnifiers) cannot use this part of the page reliably.';
}

function classifyDevice(testInfo, page) {
  const vp = page.viewportSize() || { width: 1280, height: 800 };
  const ua = (testInfo.project.use && testInfo.project.use.userAgent) || '';
  const isMobile = testInfo.project.use && testInfo.project.use.isMobile;
  if (isMobile || vp.width <= 480) return { kind: 'mobile', vp };
  if (vp.width <= 1024) return { kind: 'tablet', vp };
  return { kind: 'desktop', vp };
}

for (const site of sites) {
  test.describe(`QA walkthrough — ${site.name}`, () => {
    // One long test per device, hard cap so we never hit the global timeout.
    test(`full QA walkthrough @${site.name}`, async ({ page, request }, testInfo) => {
      // 8 minutes per device. Most runs finish in 2–4 min; the extra 4 min
      // is headroom for the worst case (mobile-throttled tab, heavy hero
      // video, third-party tracking spinning up). Anything beyond 8 min
      // means the site genuinely isn't usable on that device — which is
      // itself a finding worth reporting.
      test.setTimeout(8 * 60_000);

      const findings = [];
      const note = (severity, area, message, extra = {}) =>
        findings.push({ severity, area, message, ...extra });

      // Cursor visualiser so the recorded video has a visible mouse path.
      // Installed via addInitScript, which auto-applies on EVERY page —
      // including pages we navigate to in Step 4. (Earlier the cursor stopped
      // appearing after the first navigation because Webflow IX2 manipulates
      // <body>; the visualiser's own DOM helper now re-attaches itself.)
      await installCursorVisualizer(page);

      // Track console / page errors across the whole session.
      // For JS errors we capture: message, first stack frame (file + line:col),
      // and the URL of the page where the error fired — without this context
      // the report can only say "5 JS errors" which isn't actionable.
      const consoleErrors = [];
      const pageErrors = [];
      page.on('console', (m) => {
        if (m.type() === 'error') {
          const loc = m.location() || {};
          consoleErrors.push({
            text: m.text(),
            url: loc.url || page.url(),
            line: loc.lineNumber,
            col: loc.columnNumber,
            pageUrl: page.url(),
          });
        }
      });
      page.on('pageerror', (e) => {
        // First stack frame ("    at fn (file.js:42:17)") tells the developer
        // exactly where in their code the throw originated.
        const stack = String(e.stack || '');
        const firstFrame = (stack.match(/\bat\s+.+?\(([^)]+)\)/) || [])[1]
                       || (stack.split('\n').find((l) => /\.js:\d+/.test(l)) || '').trim()
                       || '';
        pageErrors.push({
          message: String(e.message || e),
          stack,
          firstFrame,
          pageUrl: page.url(),
        });
      });

      const device = classifyDevice(testInfo, page);
      testInfo.annotations.push({
        type: 'walkthrough-meta',
        description: `device=${device.kind} viewport=${device.vp.width}×${device.vp.height} project=${testInfo.project.name}`,
      });

      // -------------------------------------------------------------------
      // 1. HOMEPAGE — smoke
      // -------------------------------------------------------------------
      await test.step(`1. Open ${site.url}`, async () => {
        let resp;
        try {
          // 45s on `domcontentloaded` — heavy Webflow marketing pages with
          // hero videos and CMS-loaded content routinely take 25-35s on a
          // throttled mobile profile. 25s was too tight and was the actual
          // cause of the "Critical: could not load homepage" failures.
          resp = await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
        } catch (e) {
          // Soft-fail to commit: try `load` event with another budget rather than
          // giving up. Many sites fire DOMContentLoaded late because of inline
          // scripts but become navigable on `load`.
          try {
            resp = await page.goto(site.url, { waitUntil: 'load', timeout: 30_000 });
          } catch (e2) {
            note(SEV.CRITICAL, 'Loading', `Could not load homepage in 75s: ${e2.message}`, { url: site.url });
            return;
          }
        }
        if (!resp || resp.status() >= 400) {
          note(SEV.CRITICAL, 'HTTP', `Homepage returned ${resp ? resp.status() : 'no response'}`, { url: site.url });
          return;
        }
        await waitForVisuallyReady(page, { timeout: 8_000 });
        const title = await page.title();
        if (!title || !title.trim()) note(SEV.HIGH, 'SEO', 'Homepage is missing <title>', { url: site.url });
        const hasH1 = await page.locator('h1, [role="heading"][aria-level="1"]').first().isVisible().catch(() => false);
        if (!hasH1) note(SEV.HIGH, 'Content', 'Homepage has no visible <h1>', { url: site.url });
      });
      if (findings.some((f) => f.severity === SEV.CRITICAL)) {
        await attachFindings(testInfo, findings);
        expect.soft(findings.filter(f => f.severity === SEV.CRITICAL), 'critical issues on homepage').toEqual([]);
        return;
      }

      // -------------------------------------------------------------------
      // 2. SCROLL FULL PAGE
      // -------------------------------------------------------------------
      await test.step('2. Scroll through entire homepage', async () => {
        try {
          await scrollPageVisible(page);
        } catch (e) {
          note(SEV.MEDIUM, 'Layout', `Scrolling failed: ${e.message}`, { url: page.url() });
        }
        // Walk every <img> on the page; an image with naturalWidth === 0
        // failed to load (404 / network error / CORS / wrong format). For
        // each broken image we now:
        //   1. Emit ONE finding per broken src (no more aggregated "10 images
        //      failed" with no detail)
        //   2. CAPTURE AN ANNOTATED SCREENSHOT of the broken <img> on the
        //      actual page — red box + red arrow pointing at the missing
        //      image slot. The user explicitly asked: "if you say broken
        //      images, attach screenshots so I can see and verify."
        //   3. Use a user-friendly headline instead of a raw CDN URL
        const broken = await page.evaluate(() =>
          Array.from(document.images)
            .filter((img) => img.src && !img.src.startsWith('data:') && img.naturalWidth === 0)
            .map((img) => ({
              src: img.src,
              alt: img.alt || '',
              className: img.className || '',
              parentCls: (img.parentElement && img.parentElement.className) || '',
            }))
            .slice(0, 25)
        );
        for (let i = 0; i < broken.length; i++) {
          const b = broken[i];
          const filename = (() => {
            try { return new URL(b.src).pathname.split('/').pop() || b.src; }
            catch { return b.src.split('/').pop() || b.src; }
          })();
          const userTitle = b.alt
            ? `Broken image on the page — "${b.alt}" did not load (visitors see an empty slot or a broken-image icon)`
            : `Broken image on the page — ${filename} did not load (visitors see an empty slot or a broken-image icon)`;
          // Each annotated screenshot needs a unique filename per device per
          // bug; we tag it with the area + index so the dashboard mapping
          // (screenshotName → URL) lines up.
          const screenshotName = `bug-image-homepage-${i + 1}.png`;
          // Locate the broken <img> on the page and capture it with the
          // red-box + arrow overlay. attachAnnotated swallows errors so a
          // missing element never blocks the run.
          // We escape quotes in the src for the attribute selector.
          const srcEscaped = b.src.replace(/"/g, '\\"');
          await attachAnnotated(page, testInfo, screenshotName, {
            label: `BROKEN IMAGE: ${filename}`,
            selector: `img[src="${srcEscaped}"]`,
          });
          note(SEV.HIGH, 'Images', userTitle, {
            url: page.url(),
            element: b.src,
            page: 'Homepage',
            screenshotName,
            userImpact:
              'Visitors see a broken-image icon, an empty white box, or a layout that jumps when the image fails to load. ' +
              'On marketing pages this directly impacts perceived credibility and conversion.',
            devDetail: `<img src="${b.src}"${b.alt ? ` alt="${b.alt}"` : ''}> · naturalWidth = 0\nIn ${b.parentCls ? `parent .${b.parentCls.split(/\s+/)[0]}` : 'unknown parent'}`,
            fixHint:
              'Open the URL in a new tab. If 404, re-upload the asset to Webflow Assets and reset the image binding. ' +
              'If it loads in a browser tab but not in the page, check the host\'s CORS / hotlink protection or that the path uses the right protocol (http vs https).',
          });
        }
        // Clipped text + icon fallbacks at this viewport
        await collectPageFindings(page, findings, { area: 'Homepage', testInfo });
      });

      // -------------------------------------------------------------------
      // 3. HEADER MENU
      // -------------------------------------------------------------------
      await test.step('3. Inspect the header / menu', async () => {
        await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
        await page.waitForTimeout(400);

        if (device.kind === 'mobile' || device.kind === 'tablet') {
          // Open hamburger menu, verify link visibility
          const burgerSelectors = '.w-nav-button, [aria-label*="menu" i], button[class*="menu" i], button[class*="hamburger" i]';
          const burger = page.locator(burgerSelectors).first();
          if (await burger.count()) {
            const before = await countVisibleNavLinks(page);
            let usedSelector = burgerSelectors;
            try {
              // Read the actual matched selector for the report so the dev
              // knows which trigger the test interacted with.
              usedSelector = await burger.evaluate((el) => {
                const cls = (el.className || '').toString().trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.');
                return `${el.tagName.toLowerCase()}${cls ? '.' + cls : ''}${el.id ? '#' + el.id : ''}`;
              }).catch(() => burgerSelectors);
              const box = await burger.boundingBox();
              if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
              await burger.click({ timeout: 5000 });
              await page.waitForTimeout(700);
            } catch (e) {
              note(SEV.MEDIUM, 'Navigation', `Hamburger trigger ${usedSelector} threw on click: ${e.message}`, {
                url: page.url(),
                element: usedSelector,
                page: 'Homepage',
                fixHint: 'The button may be obscured by another element or its click handler throws. Check IX2 interactions on this element in Webflow Designer.',
              });
            }
            const after = await countVisibleNavLinks(page);
            if (after <= before) {
              note(
                SEV.HIGH,
                'Navigation',
                'The hamburger / mobile menu does not open when tapped',
                {
                  url: page.url(),
                  element: usedSelector,
                  page: 'Homepage',
                  userImpact:
                    `Mobile and tablet visitors cannot reach any page other than the homepage. The icon looks like a working menu but tapping it does nothing — visitors see ${before} link${before === 1 ? '' : 's'} before tap, ${after} after.`,
                  devDetail: `Tapped element: ${usedSelector}\nVisible nav links before click: ${before}\nVisible nav links after click + 700 ms wait: ${after}`,
                  fixHint:
                    'Either the IX2 click interaction is not bound (in Designer → select the button → Interactions panel, confirm there is an "On click" trigger that targets the nav menu), ' +
                    'or the .w-nav-menu element has a CSS override keeping it hidden on this breakpoint (display:none, visibility:hidden, or transform pushing it off-screen).',
                }
              );
            }
          } else {
            note(SEV.LOW, 'Navigation', `No mobile menu trigger matched ${burgerSelectors}. The page has no hamburger button or it uses a non-standard class.`, {
              url: page.url(),
              page: 'Homepage',
              fixHint: 'If the design has a hamburger, ensure its element uses .w-nav-button or carries an aria-label containing "menu".',
            });
          }
        } else {
          // Desktop: check nav overflow + EXPAND every dropdown (hover + click)
          // to make sure each sub-menu opens. Earlier we hovered only the first
          // three, which let visible bugs slip past (closed sub-menus).
          const navOver = await findHeaderNavOverflow(page);
          for (const n of navOver.slice(0, 2)) {
            note(SEV.MEDIUM, 'Layout', `Header nav overflows by ${n.overBy}px at ${device.vp.width}px wide.`, {
              url: page.url(), tag: n.tag, cls: n.cls,
            });
          }
          const dropdowns = page.locator('.w-dropdown-toggle, [aria-haspopup="true"], [aria-haspopup="menu"]');
          const ddCount = await dropdowns.count();
          for (let i = 0; i < Math.min(ddCount, 6); i++) {
            const t = dropdowns.nth(i);
            if (!(await t.isVisible().catch(() => false))) continue;
            const label = (await t.textContent().catch(() => '') || '').trim().slice(0, 30);
            try {
              const box = await t.boundingBox();
              if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 6 });
              await t.hover({ timeout: 2500 });
              await page.waitForTimeout(250);
              // Now actually CLICK to open (some Webflow dropdowns only respond to click)
              await t.click({ trial: false, timeout: 3000 }).catch(() => {});
              await page.waitForTimeout(350);
              const popupVisible = await page.evaluate((idx) => {
                const triggers = document.querySelectorAll('.w-dropdown-toggle, [aria-haspopup="true"], [aria-haspopup="menu"]');
                const tr = triggers[idx];
                if (!tr) return null;
                const dd = tr.closest('.w-dropdown') || tr.parentElement;
                const list = dd && dd.querySelector('.w-dropdown-list, [role="menu"], .dropdown-menu');
                if (!list) return false;
                const r = list.getBoundingClientRect();
                const cs = getComputedStyle(list);
                return r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden';
              }, i);
              if (popupVisible === false) {
                note(SEV.MEDIUM, 'Navigation', `Dropdown "${label}" did not open on click/hover`, { url: page.url() });
              }
              // Close by clicking elsewhere
              await page.keyboard.press('Escape').catch(() => {});
              await page.waitForTimeout(150);
            } catch (e) {
              note(SEV.LOW, 'Navigation', `Dropdown "${label}" interaction failed: ${e.message}`, { url: page.url() });
            }
          }
        }
      });

      // -------------------------------------------------------------------
      // 4. VISIT 3 INTERNAL PAGES
      // -------------------------------------------------------------------
      const internalLinks = await collectInternalLinks(page, site.url, 5);
      for (let i = 0; i < internalLinks.length; i++) {
        const link = internalLinks[i];
        await test.step(`4.${i + 1} Click "${link.text || link.href}"`, async () => {
          // First try a REAL click on the nav link visible on the current page.
          // The cursor visualiser shows the mouse moving to the item and the
          // click flash — which is what a human watching the walkthrough
          // expects to see. `page.goto()` is invisible (URL bar update only),
          // and gave the impression that "nothing happened".
          let clicked = false;
          try {
            const origin = new URL(site.url).origin;
            const relativeHref = link.href.startsWith(origin) ? link.href.slice(origin.length) : null;
            const candidates = [`a[href="${link.href}"]`];
            if (relativeHref) candidates.push(`a[href="${relativeHref}"]`);
            const navLink = page.locator(candidates.join(', ')).first();
            if (await navLink.count() && await navLink.isVisible().catch(() => false)) {
              await navLink.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
              const box = await navLink.boundingBox();
              if (box) {
                // Move the cursor visibly across the screen first (cursor
                // visualiser lights up at every mouse position) and then click.
                await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
                await page.waitForTimeout(120);
              }
              await Promise.all([
                page.waitForLoadState('domcontentloaded', { timeout: 25_000 }).catch(() => {}),
                navLink.click({ timeout: 5_000 }),
              ]);
              clicked = true;
            }
          } catch { /* fall through to goto fallback */ }

          // Fall back to direct navigation if the link wasn't clickable on
          // the current page (sometimes a sub-page has a different header).
          let resp;
          if (!clicked) {
            try {
              resp = await page.goto(link.href, { waitUntil: 'domcontentloaded', timeout: 25_000 });
            } catch (e) {
              note(SEV.HIGH, 'Navigation', `The "${link.text || 'page'}" page does not open after clicking its nav link — the request failed: ${e.message}`, {
                url: link.href,
                fixHint: 'Verify the page is published and the link href in Webflow Designer matches the published slug.',
              });
              return;
            }
            if (!resp || resp.status() >= 400) {
              note(SEV.HIGH, 'HTTP', `The "${link.text || 'page'}" page is not reachable — server returned HTTP ${resp ? resp.status() : 'no response'}.`, {
                url: link.href,
                fixHint: 'Republish the page or remove the dead link from the header navigation.',
              });
              return;
            }
          } else {
            // After a click, verify we actually landed on the expected URL.
            if (!page.url().startsWith(link.href.split('#')[0].split('?')[0])) {
              note(SEV.HIGH, 'Navigation',
                `The "${link.text || 'page'}" page is not opened after clicking the navigation link — the browser landed on "${page.url()}" instead.`,
                {
                  url: link.href,
                  fixHint: 'Check the link\'s href in Webflow Designer; an IX2 click-redirect or external redirect may be overriding it.',
                });
            }
          }
          await waitForVisuallyReady(page, { timeout: 6_000 });
          const h1 = await page.locator('h1, [role="heading"][aria-level="1"]').first().isVisible().catch(() => false);
          const bodyLen = await page.evaluate(() => (document.body.textContent || '').trim().length);
          if (!h1 && bodyLen < 200) {
            note(SEV.MEDIUM, 'Content', `Near-empty page (body=${bodyLen} chars, no h1).`, { url: link.href });
          }
          await collectPageFindings(page, findings, { area: link.text || 'Inner page', testInfo });
          // Quick scroll once to trigger lazy load
          await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }));
          await page.waitForTimeout(500);
          await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
          await page.waitForTimeout(300);
        });
      }

      // -------------------------------------------------------------------
      // 5. FOOTER + SOCIAL LINKS
      // (Webflow footers are CMS-shared across pages — no need to re-navigate
      //  to the homepage. Scroll the CURRENT page to its bottom and read the
      //  footer in place. Saves a full goto + waitForVisuallyReady cycle.)
      // -------------------------------------------------------------------
      await test.step('5. Footer + social-link sanity', async () => {
        try {
          await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }));
          await page.waitForTimeout(700);
        } catch {}
        const socials = await page.evaluate(() => {
          const out = [];
          const re = /(facebook|twitter|x\.com|instagram|linkedin|youtube|youtu\.be|tiktok|github|pinterest|threads|t\.me|telegram|wa\.me|discord|medium|vimeo|reddit)/i;
          document.querySelectorAll('footer a[href], [role="contentinfo"] a[href]').forEach((a) => {
            if (!re.test(a.href || '')) return;
            out.push({
              href: a.href,
              target: a.getAttribute('target') || '',
              rel: a.getAttribute('rel') || '',
              label: (a.getAttribute('aria-label') || a.textContent || '').trim().slice(0, 30),
            });
          });
          return out;
        });
        const bad = /(localhost|127\.0\.0\.1|example\.com|placeholder|tbd|change[-_ ]?me)/i;
        for (const s of socials) {
          try {
            const u = new URL(s.href);
            if (bad.test(u.hostname)) {
              note(SEV.HIGH, 'Footer', `Social link points to placeholder host: ${u.hostname}`, { url: s.href, label: s.label });
            } else if (s.target === '_blank' && !/noopener/.test(s.rel)) {
              note(SEV.LOW, 'Security', `External social link opens in new tab without rel="noopener"`, { url: s.href, label: s.label });
            }
          } catch {
            note(SEV.MEDIUM, 'Footer', `Malformed social link: ${s.href}`, { label: s.label });
          }
        }
      });

      // -------------------------------------------------------------------
      // 5.5 SEARCH FIELD — find and exercise the site search (if any)
      // -------------------------------------------------------------------
      await test.step('5.5 Test the site search field', async () => {
        // First, open the search if it's behind a magnifier toggle.
        const triggerSels = [
          'button[aria-label*="search" i]',
          '[role="button"][aria-label*="search" i]',
          'a[aria-label*="search" i]',
          '.search-toggle, .nav-search, .search-icon, .search-button',
          'button:has(svg[class*="search" i])',
        ];
        for (const sel of triggerSels) {
          const t = page.locator(sel).first();
          if (!(await t.count())) continue;
          if (!(await t.isVisible().catch(() => false))) continue;
          try {
            const box = await t.boundingBox();
            if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 6 });
            await t.click({ timeout: 2500 });
            await page.waitForTimeout(500);
            break; // search overlay should now be open
          } catch { /* keep trying alternatives */ }
        }

        // Find the (now-visible) search input
        const inputCandidates = page.locator(
          'input[type="search"], input[role="searchbox"], ' +
          'input[aria-label*="search" i], input[placeholder*="search" i], ' +
          '[role="search"] input[type="text"], [role="search"] input:not([type])'
        );
        const inputCount = await inputCandidates.count();
        let searchInput = null;
        for (let i = 0; i < inputCount; i++) {
          const c = inputCandidates.nth(i);
          if (await c.isVisible().catch(() => false)) { searchInput = c; break; }
        }
        if (!searchInput) {
          testInfo.annotations.push({ type: 'no-search', description: 'No visible search field on this page.' });
          return;
        }

        // Type a real query and watch for suggestions / results
        try {
          await searchInput.click({ timeout: 2500 });
          await searchInput.fill('test');
          await page.waitForTimeout(1200); // give debounced search a moment

          const observedResult = await page.evaluate(() => {
            // Common suggestion / result containers
            const sels = [
              '[role="listbox"]', '[role="search"] ul', '[role="search"] [aria-label*="result" i]',
              '.search-results', '.search-suggestions', '.search-autocomplete',
              '.autocomplete', '.suggestions', '[aria-expanded="true"] + *',
              '.search-dropdown', '.results-dropdown',
            ];
            for (const sel of sels) {
              const el = document.querySelector(sel);
              if (!el) continue;
              const r = el.getBoundingClientRect();
              const cs = getComputedStyle(el);
              if (r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden') {
                return { found: true, sel, count: el.querySelectorAll('li, a, [role="option"]').length };
              }
            }
            return { found: false };
          });

          if (!observedResult.found) {
            note(
              SEV.MEDIUM,
              'Search',
              `The search field accepts the query "test" but no suggestions or results appear within 1.2s. The search may be broken or not wired to its backend.`,
              {
                url: page.url(),
                element: 'input[type="search"]',
                page: 'Homepage',
                fixHint: 'Check that the search submits to a working endpoint (e.g. Webflow Site Search, Algolia). Verify the dropdown isn\'t hidden by overflow / z-index.',
              }
            );
          } else {
            testInfo.annotations.push({
              type: 'search-ok',
              description: `Search returned a suggestion panel (${observedResult.sel}) with ${observedResult.count} item(s).`,
            });
          }

          // Close: press Escape so the overlay doesn't block subsequent steps
          await page.keyboard.press('Escape').catch(() => {});
          await page.waitForTimeout(200);
        } catch (e) {
          note(SEV.MEDIUM, 'Search', `Search field interaction failed: ${e.message}`, {
            url: page.url(),
            fixHint: 'Verify the search input is focusable and accepts keyboard input.',
          });
        }
      });

      // -------------------------------------------------------------------
      // 6. ALL FORMS on the current page (fill each, don't submit)
      // -------------------------------------------------------------------
      await test.step('6. Fill every form on the page', async () => {
        const forms = page.locator('form.w-form, form').filter({ has: page.locator('input, textarea') });
        const formCount = await forms.count();
        if (formCount === 0) {
          testInfo.annotations.push({ type: 'no-form', description: 'No form on this page.' });
          return;
        }
        for (let fi = 0; fi < Math.min(formCount, 5); fi++) {
          const form = forms.nth(fi);
          if (!(await form.isVisible().catch(() => false))) {
            await form.scrollIntoViewIfNeeded().catch(() => {});
            await page.waitForTimeout(300);
          }
          const inputs = form.locator(
            'input[type=text], input[type=email], input[type=tel], input[type=url], input[type=number], input:not([type]), textarea'
          );
          const n = await inputs.count();
          for (let k = 0; k < Math.min(n, 8); k++) {
            const inp = inputs.nth(k);
            if (!(await inp.isVisible().catch(() => false))) continue;
            if (await inp.isDisabled().catch(() => false)) continue;
            const type = (await inp.getAttribute('type')) || '';
            const sample =
              type === 'email' ? 'qa+test@example.com' :
              type === 'tel'   ? '+10000000000' :
              type === 'url'   ? 'https://example.com' :
              type === 'number' ? '42' : 'QA test';
            try { await inp.fill(sample, { timeout: 2500 }); } catch (e) {
              note(SEV.MEDIUM, 'Forms', `Could not fill input in form #${fi + 1}: ${e.message}`, { url: page.url() });
            }
          }
          // Detect Webflow's success/fail siblings + required validation state
          const wfState = await form.evaluate((el) => {
            const wrap = el.closest('.w-form') || el.parentElement;
            const required = el.querySelectorAll('[required]');
            return {
              required: required.length,
              hasWfDone: !!(wrap && wrap.querySelector('.w-form-done')),
              hasWfFail: !!(wrap && wrap.querySelector('.w-form-fail')),
              action: el.getAttribute('action') || '',
              method: (el.method || 'get').toLowerCase(),
            };
          });
          testInfo.annotations.push({
            type: 'form-state',
            description: `Form #${fi + 1}: action=${wfState.action || '(none)'} method=${wfState.method} required-fields=${wfState.required} done-sibling=${wfState.hasWfDone} fail-sibling=${wfState.hasWfFail}`,
          });
        }
      });

      // -------------------------------------------------------------------
      // 6.5 CTA / button audit — every visible button has a destination
      // -------------------------------------------------------------------
      await test.step('6.5 Verify every CTA on the page is reachable', async () => {
        const issues = await page.evaluate(() => {
          const out = [];
          const els = document.querySelectorAll('button:not([type=hidden]), .w-button, a.button, [role="button"], input[type=submit]');
          els.forEach((el, i) => {
            if (i > 60) return;
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) return;
            const cs = getComputedStyle(el);
            if (cs.visibility === 'hidden' || cs.display === 'none') return;
            const txt = (el.textContent || el.getAttribute('value') || '').trim().slice(0, 30);
            if (el.disabled || el.getAttribute('aria-disabled') === 'true') {
              out.push({ text: txt, reason: 'disabled' });
              return;
            }
            if (el.tagName === 'A') {
              const href = el.getAttribute('href');
              const hasHook = el.hasAttribute('data-w-id') || el.hasAttribute('onclick') || el.hasAttribute('data-modal');
              if ((!href || href === '#' || href === 'javascript:void(0)') && !hasHook) {
                out.push({ text: txt, reason: 'no destination' });
              }
            }
            if (r.width < 24 || r.height < 24) {
              out.push({ text: txt, reason: `tap target ${Math.round(r.width)}×${Math.round(r.height)}px` });
            }
          });
          return out.slice(0, 20);
        });
        for (const it of issues) {
          const sev = it.reason.startsWith('tap target') ? SEV.LOW :
                      it.reason === 'no destination' ? SEV.HIGH : SEV.MEDIUM;
          note(sev, 'CTAs', `"${it.text || '(no text)'}" — ${it.reason}`, { url: page.url() });
        }
      });

      // -------------------------------------------------------------------
      // 7. ACCESSIBILITY — axe-core scan on the current page
      // -------------------------------------------------------------------
      await test.step('7. Accessibility scan (axe-core)', async () => {
        try {
          const a11y = await new AxeBuilder({ page })
            .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
            .analyze();
          const blocking = a11y.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
          for (const v of blocking.slice(0, 8)) {
            const node0 = v.nodes[0];
            const wcag = (v.tags || []).filter((t) => /^wcag\d/.test(t)).join(', ');
            // failureSummary already starts with "Fix..." — perfect for the
            // developer fix-hint. We keep it intact and append WCAG + docs URL.
            const summary = (node0 && node0.failureSummary) || v.description || '';
            const fixHint = [summary, wcag ? `WCAG: ${wcag}` : '', v.helpUrl ? `Docs: ${v.helpUrl}` : '']
              .filter(Boolean).join('\n');
            // User-friendly headline: instead of repeating the axe rule ID
            // ("html-has-lang"), we describe what the user / visitor experiences.
            // Plus a userImpact line from AXE_IMPACT mapping above.
            const userTitle = `${v.help.replace(/\(.+?\)/g, '').trim()} — affects ${v.nodes.length} element${v.nodes.length === 1 ? '' : 's'} on this page`;
            note(
              v.impact === 'critical' ? SEV.HIGH : SEV.MEDIUM,
              'Accessibility',
              userTitle,
              {
                url: page.url(),
                element: (node0 && node0.target && node0.target[0]) || '',
                snippet: (node0 && node0.html) ? node0.html.slice(0, 220) : '',
                userImpact: axeImpact(v.id, v.description),
                devDetail: `axe rule: ${v.id}\nimpact: ${v.impact}\nnodes affected: ${v.nodes.length}\nfirst node selector: ${(node0 && node0.target && node0.target[0]) || '?'}\nfirst node HTML: ${(node0 && node0.html) ? node0.html.slice(0, 220) : ''}`,
                fixHint,
              }
            );
          }
          testInfo.annotations.push({
            type: 'axe-summary',
            description: `axe critical=${a11y.violations.filter((v) => v.impact === 'critical').length} serious=${a11y.violations.filter((v) => v.impact === 'serious').length} moderate=${a11y.violations.filter((v) => v.impact === 'moderate').length} minor=${a11y.violations.filter((v) => v.impact === 'minor').length}`,
          });
        } catch (e) {
          testInfo.annotations.push({ type: 'axe-error', description: e.message });
        }
      });

      // -------------------------------------------------------------------
      // 8. LANDSCAPE ORIENTATION (mobile / tablet only)
      // -------------------------------------------------------------------
      if (device.kind === 'mobile' || device.kind === 'tablet') {
        await test.step('8. Rotate to landscape and re-check layout', async () => {
          const portrait = page.viewportSize();
          if (!portrait) return;
          try {
            await page.setViewportSize({ width: portrait.height, height: portrait.width });
            await page.waitForTimeout(600); // allow CSS @media re-layout
            // Quick re-checks at the new orientation
            await collectPageFindings(page, findings, { area: 'Landscape', testInfo });
            const navOver = await findHeaderNavOverflow(page);
            for (const n of navOver.slice(0, 2)) {
              note(SEV.MEDIUM, 'Layout (landscape)', `Header nav overflows by ${n.overBy}px in landscape ${portrait.height}×${portrait.width}.`, {
                url: page.url(), tag: n.tag, cls: n.cls,
              });
            }
            // Attach a landscape final-state screenshot for the report
            try {
              const buf = await page.screenshot({ fullPage: true, timeout: 5000 });
              await testInfo.attach('landscape-final.png', { body: buf, contentType: 'image/png' });
            } catch {}
          } catch (e) {
            note(SEV.LOW, 'Layout (landscape)', `Landscape rotation failed: ${e.message}`, { url: page.url() });
          } finally {
            // Restore portrait for any subsequent steps
            try { await page.setViewportSize(portrait); } catch {}
          }
        });
      }

      // -------------------------------------------------------------------
      // 7. Final hygiene: console / page errors
      // -------------------------------------------------------------------
      // Emit ONE finding per UNIQUE JS error (de-duplicated by message).
      // Two big changes versus the previous version:
      //   1. Filter NOISE — drop errors thrown from web-inspector://,
      //      chrome-extension://, devtools://, etc. They are produced by the
      //      browser itself or installed extensions, NOT by the site. The
      //      user got false-positive reports like "MutationObserver @
      //      web-inspector://bootstrap.js:621" which is DevTools, not the site.
      //   2. Humanize the headline — convert "Cannot read properties of null"
      //      into "A script tried to use a page element that does not exist"
      //      so QA / PM / designer reviewers can read the report without
      //      knowing JavaScript. The raw error text stays on the finding as
      //      `devDetail` for developers, displayed in a collapsed section.
      const seenJsErr = new Set();
      for (const err of pageErrors) {
        if (isErrorNoise(err.message, err.firstFrame, err.stack)) continue;
        const key = (err.message || '').slice(0, 200);
        if (seenJsErr.has(key)) continue;
        seenJsErr.add(key);
        const h = humanizeJsError(err.message);
        note(SEV.CRITICAL, 'JS', h.title, {
          url: err.pageUrl,
          element: err.firstFrame || '',
          userImpact: h.impact,
          devDetail: `${err.message}${err.firstFrame ? '\n  at ' + err.firstFrame : ''}${err.stack ? '\n\n' + err.stack.split('\n').slice(0, 6).join('\n') : ''}`,
          fixHint:
            'Open the file referenced in the developer details and check the line shown. ' +
            'Webflow custom-code injections (Site Settings → Custom Code, ' +
            'or per-page <head>/<body> custom code) are the most common source ' +
            'of these errors on production.',
        });
      }
      const ignorable = /favicon|google-analytics|googletagmanager|facebook\.net|hotjar|hubspot|intercom|net::ERR_BLOCKED_BY_CLIENT/i;
      const seenConErr = new Set();
      for (const err of consoleErrors) {
        if (ignorable.test(err.text)) continue;
        if (isErrorNoise(err.text, err.url, '')) continue;
        const key = err.text.slice(0, 200);
        if (seenConErr.has(key)) continue;
        seenConErr.add(key);
        const h = humanizeJsError(err.text);
        const where = err.url && /\.js/.test(err.url)
          ? `${err.url}${err.line ? ':' + err.line : ''}${err.col ? ':' + err.col : ''}`
          : '';
        note(SEV.MEDIUM, 'Console', h.title, {
          url: err.pageUrl,
          element: where,
          userImpact: h.impact,
          devDetail: `console.error: ${err.text}${where ? '\n  at ' + where : ''}`,
          fixHint: 'Open browser DevTools console and reproduce the user journey — the same error will fire at the same line:column.',
        });
      }

      // -------------------------------------------------------------------
      // OUTPUT: attach findings.json + soft assertion
      // -------------------------------------------------------------------
      await attachFindings(testInfo, findings);

      // A full-page screenshot of the final state, for the report's "what the
      // tester saw last" picture.
      try {
        const buf = await page.screenshot({ fullPage: true, timeout: 6000 });
        await testInfo.attach('walkthrough-final.png', { body: buf, contentType: 'image/png' });
      } catch {}

      // Hard fail only on Critical. High/Medium/Low are surfaced in the report
      // but don't block the run — the same way a real QA pass would record an
      // issue without stopping.
      const critical = findings.filter((f) => f.severity === SEV.CRITICAL);
      expect(
        critical,
        `${critical.length} critical issue(s) found during the walkthrough — see findings.json attachment.`
      ).toEqual([]);
    });
  });
}

/* ----------------------- helpers used only here ----------------------- */

async function attachFindings(testInfo, findings) {
  // Sort by severity then area so the JSON is readable.
  const order = ['Critical', 'High', 'Medium', 'Low', 'Info'];
  findings.sort(
    (a, b) =>
      order.indexOf(a.severity) - order.indexOf(b.severity) ||
      String(a.area).localeCompare(String(b.area))
  );
  const summary = {
    total: findings.length,
    bySeverity: order.reduce((acc, s) => ((acc[s] = findings.filter((f) => f.severity === s).length), acc), {}),
    byArea: findings.reduce((acc, f) => ((acc[f.area] = (acc[f.area] || 0) + 1), acc), {}),
    findings,
  };
  await testInfo.attach('findings.json', {
    body: Buffer.from(JSON.stringify(summary, null, 2), 'utf8'),
    contentType: 'application/json',
  });
  testInfo.annotations.push({
    type: 'walkthrough-summary',
    description:
      `${findings.length} finding(s) — ` +
      order
        .filter((s) => summary.bySeverity[s])
        .map((s) => `${s}=${summary.bySeverity[s]}`)
        .join(', '),
  });
}

async function collectPageFindings(page, findings, { area, testInfo }) {
  const note = (severity, area, message, extra = {}) =>
    findings.push({ severity, area, message, ...extra });
  const url = page.url();

  // Clipped pill / button text — annotated screenshot per finding so each
  // bug card can show EXACTLY which element is broken (red-box overlay).
  const clipped = await findClippedText(page).catch(() => []);
  for (let i = 0; i < Math.min(clipped.length, 5); i++) {
    const c = clipped[i];
    const screenshotName = `bug-clipped-${slugify(area)}-${i + 1}.png`;
    note(SEV.MEDIUM, 'Text clipping', `"${(c.text || '').slice(0, 60)}" overflows by ${c.clippedBy}px`, {
      url,
      element: `<${c.tag}.${c.cls || ''}>`,
      page: area,
      screenshotName, // ← bridges this finding to its annotated PNG
      fixHint: 'Replace fixed width with min-width, or add text-overflow: ellipsis on the element.',
    });
    await attachAnnotated(page, testInfo, screenshotName, {
      label: `CLIPPED on ${area}: "${(c.text || '').slice(0, 40)}"`,
      cls: c.cls,
      tag: c.tag,
      text: c.text,
    });
  }
  // Icon-font fallback chars — also screenshot
  const tofu = await findIconFontFallbacks(page).catch(() => []);
  for (let i = 0; i < Math.min(tofu.length, 3); i++) {
    const t = tofu[i];
    const screenshotName = `bug-icon-${slugify(area)}-${i + 1}.png`;
    note(SEV.MEDIUM, 'Icon fallback', `Suspicious "${t.char}" character — icon font likely failed to load`, {
      url,
      element: `<${t.tag}.${t.cls || ''}>`,
      page: area,
      screenshotName,
      fixHint: 'Verify the icon font @font-face declaration is reachable; add a system-glyph fallback in CSS.',
    });
    await attachAnnotated(page, testInfo, screenshotName, {
      label: `ICON FALLBACK on ${area}: "${t.char}"`,
      cls: t.cls,
      tag: t.tag,
      text: t.char,
    });
  }
  // Modals open on this page
  const modals = await findMisplacedModals(page).catch(() => []);
  for (let i = 0; i < Math.min(modals.length, 2); i++) {
    const m = modals[i];
    const screenshotName = `bug-modal-${slugify(area)}-${i + 1}.png`;
    note(SEV.MEDIUM, 'Modal layout', `Modal ${m.rect.w}×${m.rect.h}px — ${m.issues.join('; ')}`, {
      url,
      element: `.${m.cls}`,
      page: area,
      screenshotName,
      fixHint: 'Use width: min(92vw, 560px); margin: auto; position: fixed; inset: 0; to keep modals viewport-friendly.',
    });
    // Modal overlay screenshot uses the modal's bounding rect we already have
    try {
      const buf = await highlightAndScreenshot(page, null, {
        label: `MODAL ${m.rect.w}×${m.rect.h}px — ${m.issues[0]}`,
        boundingRect: { x: m.rect.l, y: m.rect.t, width: m.rect.w, height: m.rect.h },
        fullPage: false,
      });
      if (buf) await testInfo.attach(screenshotName, { body: buf, contentType: 'image/png' });
    } catch {}
  }
}

function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'page';
}

async function attachAnnotated(page, testInfo, name, opts = {}) {
  // Accepts either:
  //   { label, cls, tag, text }                  — classic clipped-text path
  //   { label, selector }                        — direct selector path (broken images, etc.)
  //   { label, locator }                         — pre-built Playwright Locator
  // Always returns silently if anything fails — annotated screenshots are
  // nice-to-have, never blocking.
  try {
    const { label, locator } = opts;
    let target = locator;
    if (!target && opts.selector) {
      target = page.locator(opts.selector).first();
    } else if (!target) {
      const firstCls = opts.cls && opts.cls.split(/\s+/).find((x) => x && !/[^a-zA-Z0-9_-]/.test(x));
      const selector = firstCls ? `${opts.tag}.${firstCls}` : opts.tag;
      target = page.locator(selector).filter({ hasText: (opts.text || '').slice(0, 30) }).first();
    }
    const buf = await highlightAndScreenshot(page, target, { label, fullPage: false });
    if (buf) await testInfo.attach(name, { body: buf, contentType: 'image/png' });
  } catch {}
}

async function countVisibleNavLinks(page) {
  return await page.locator('.w-nav-menu a, nav a, [role="navigation"] a').evaluateAll((els) =>
    els.filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }).length
  );
}

async function collectInternalLinks(page, baseUrl, limit) {
  const origin = new URL(baseUrl).origin;
  const list = await page.evaluate(
    ({ origin }) => {
      const out = [];
      // Prefer top-level header nav (real user-flow), fall back to first body links.
      const sel = 'header nav a[href], [role="navigation"] a[href], .w-nav a[href]';
      document.querySelectorAll(sel).forEach((a) => {
        const href = a.href;
        try {
          const u = new URL(href);
          if (u.origin !== origin) return;
          if (u.pathname === '/' || u.pathname === '') return;
          out.push({ href: u.toString(), text: (a.textContent || '').trim().slice(0, 30) });
        } catch {}
      });
      const seen = new Set();
      return out.filter((l) => (seen.has(l.href) ? false : seen.add(l.href)));
    },
    { origin }
  );
  return list.slice(0, limit);
}
