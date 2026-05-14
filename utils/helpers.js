// @ts-check
const fs = require('fs');
const path = require('path');

/**
 * Load the list of sites under test from config/urls.json.
 * Each entry: { name, url, smokeSelectors?: string[], expectedTitleIncludes?: string }
 */
function loadSites() {
  const cfgPath = path.resolve(__dirname, '..', 'config', 'urls.json');
  const raw = fs.readFileSync(cfgPath, 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed.sites || !Array.isArray(parsed.sites) || parsed.sites.length === 0) {
    throw new Error(
      `[urls.json] No sites configured. Add at least one entry under "sites".`
    );
  }
  return parsed.sites.filter((s) => s && s.url);
}

/**
 * Returns a filesystem-safe identifier for a site (used in screenshot names etc.).
 */
function siteSlug(site) {
  const base = site.name || site.url;
  return String(base)
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/**
 * Wait for the page to be visually settled: networkidle + fonts ready + lazy-loaded images decoded.
 * Webflow pages frequently have IX2 animations and lazy images, so we also pause briefly to let them flush.
 */
async function waitForVisuallyReady(page, { timeout = 8000 } = {}) {
  await page.waitForLoadState('domcontentloaded');
  // CRITICAL: `networkidle` NEVER fires on Webflow sites with a chat widget
  // (Intercom, Drift, Tawk.to, …) because they keep a long-poll / WebSocket
  // open. Earlier we waited 20 seconds — multiplied by 5 page visits in the
  // walkthrough that's 100s of pure dead air per test. Cap it tight (4s)
  // and accept that some background traffic may still be in flight; the
  // visible part of the page is ready by then.
  const idleBudget = Math.min(timeout, 4000);
  try {
    await page.waitForLoadState('networkidle', { timeout: idleBudget });
  } catch { /* long-poll connections / analytics never go idle — fine */ }
  await page.evaluate(async () => {
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
    // Trigger lazy-load: bounded scroll loop (max 12 steps, ~720 ms total
    // worst case). Earlier it would loop until the page hit absolute bottom,
    // which on long marketing pages took 30+ iterations × 80 ms = 2.5+ s
    // and could compound per page-visit. Image decode promises that used to
    // be `await Promise.all(...)` are dropped: images load naturally as the
    // viewport scrolls past them, blocking the whole test waiting for every
    // single hero-resolution PNG was wasteful.
    let prev = -1, steps = 0;
    while (window.scrollY !== prev && steps < 12) {
      prev = window.scrollY;
      window.scrollBy(0, window.innerHeight);
      await new Promise((r) => setTimeout(r, 60));
      steps++;
    }
    window.scrollTo(0, 0);
  }).catch(() => {});
  await page.waitForTimeout(180);
}

/**
 * Disable CSS animations / transitions to make visual diffs deterministic.
 */
async function freezeAnimations(page) {
  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        animation-duration: 0s !important;
        animation-delay: 0s !important;
        transition-duration: 0s !important;
        transition-delay: 0s !important;
        scroll-behavior: auto !important;
      }
      html { caret-color: transparent !important; }
    `,
  });
}

/**
 * Check the page for horizontal overflow at the current viewport.
 * Returns the offending elements (useful for responsive tests).
 */
async function findHorizontalOverflow(page) {
  return await page.evaluate(() => {
    const docWidth = document.documentElement.clientWidth;
    const offenders = [];
    const all = document.querySelectorAll('body *');
    for (const el of all) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.right > docWidth + 1) {
        const css = getComputedStyle(el);
        if (css.position === 'fixed' || css.position === 'sticky') continue;
        offenders.push({
          tag: el.tagName.toLowerCase(),
          id: el.id || null,
          cls: el.className && typeof el.className === 'string' ? el.className.slice(0, 80) : null,
          right: Math.round(rect.right),
          docWidth,
        });
      }
    }
    return offenders.slice(0, 10); // cap output
  });
}

/**
 * Collect every same-origin link on the page (so broken-link checks stay local).
 */
async function collectSameOriginLinks(page) {
  return await page.evaluate(() => {
    const origin = location.origin;
    const links = new Set();
    document.querySelectorAll('a[href]').forEach((a) => {
      try {
        const url = new URL(a.getAttribute('href'), location.href);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
        if (url.origin !== origin) return;
        url.hash = '';
        links.add(url.toString());
      } catch {
        /* malformed href */
      }
    });
    return Array.from(links);
  });
}

/**
 * Collect every <img>, <video>, <source>, <link rel="stylesheet"> resource URL on the page.
 */
async function collectResourceUrls(page) {
  return await page.evaluate(() => {
    const out = new Set();
    document.querySelectorAll('img[src]').forEach((n) => out.add(n.src));
    document.querySelectorAll('source[src]').forEach((n) => out.add(n.src));
    document.querySelectorAll('video[src]').forEach((n) => out.add(n.src));
    document.querySelectorAll('link[rel="stylesheet"][href]').forEach((n) => out.add(n.href));
    return Array.from(out).filter((u) => /^https?:/.test(u));
  });
}

/**
 * Are we running in "watch this" mode? PWT_SLOWMO is injected by the
 * dashboard when the Headed (show browser) option is on.
 */
function isHeadedDemo() {
  return Number(process.env.PWT_SLOWMO || 0) > 0;
}

/**
 * Inject a follow-the-mouse cursor highlight + a flash on every click so the
 * user can actually SEE what the test is doing in headed mode. Pure CSS +
 * tiny JS, no external deps. Idempotent.
 */
async function installCursorVisualizer(page) {
  if (!isHeadedDemo()) return;
  await page.addInitScript(() => {
    if (window.__wfCursorInstalled) return;
    window.__wfCursorInstalled = true;
    const css = `
      #__wf-cursor {
        position: fixed; top: 0; left: 0;
        width: 22px; height: 22px;
        margin: -11px 0 0 -11px;
        border: 2px solid #ff3b57;
        border-radius: 50%;
        background: rgba(255, 59, 87, 0.25);
        pointer-events: none;
        z-index: 2147483647;
        transition: transform 0.06s ease-out, opacity 0.15s ease-out;
      }
      #__wf-cursor.click { animation: __wf-click 0.35s ease-out; }
      @keyframes __wf-click {
        0% { transform: scale(1); box-shadow: 0 0 0 0 rgba(255,59,87,0.6); }
        80% { transform: scale(2.2); box-shadow: 0 0 0 30px rgba(255,59,87,0); }
        100% { transform: scale(1); box-shadow: 0 0 0 0 rgba(255,59,87,0); }
      }
    `;
    const install = () => {
      if (document.getElementById('__wf-cursor')) return;
      if (!document.getElementById('__wf-cursor-style')) {
        const style = document.createElement('style');
        style.id = '__wf-cursor-style';
        style.textContent = css;
        (document.head || document.documentElement).appendChild(style);
      }
      const cur = document.createElement('div');
      cur.id = '__wf-cursor';
      (document.body || document.documentElement).appendChild(cur);
    };
    // Track the latest mouse position GLOBALLY (window-level), so the cursor
    // dot picks up the right coordinates even after Webflow IX2 re-renders
    // the body. The position survives DOM rewrites.
    if (!window.__wfMouse) {
      window.__wfMouse = { x: 0, y: 0 };
      const onMove = (e) => {
        window.__wfMouse.x = e.clientX;
        window.__wfMouse.y = e.clientY;
        const c = document.getElementById('__wf-cursor');
        if (c) c.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
      };
      const onClick = () => {
        const c = document.getElementById('__wf-cursor');
        if (!c) return;
        c.classList.remove('click'); void c.offsetWidth; c.classList.add('click');
      };
      window.addEventListener('mousemove', onMove, { passive: true, capture: true });
      window.addEventListener('click', onClick, true);
    }
    if (document.body) install();
    else document.addEventListener('DOMContentLoaded', install);
    // Defence: Webflow's IX2 / framer-motion-style libraries occasionally
    // mutate <body> children and wipe injected overlays. MutationObserver
    // re-installs the dot if it disappears.
    const reinstall = () => {
      if (!document.getElementById('__wf-cursor') && document.body) install();
    };
    new MutationObserver(reinstall).observe(document.documentElement, {
      childList: true, subtree: true,
    });
  });
}

/**
 * Visible, smooth, slow scroll that goes through Playwright's action layer so
 * slowMo applies and the user can actually watch the page scroll in headed
 * mode. Falls back to a fast evaluate-based scroll for headless runs.
 */
async function scrollPageVisible(page, { step = null } = {}) {
  const vp = page.viewportSize() || { width: 1280, height: 800 };
  const dy = step ?? Math.floor(vp.height * 0.7);
  const totalH = await page.evaluate(() => document.documentElement.scrollHeight);

  if (isHeadedDemo()) {
    // Real mouse wheel = slowMo throttled, smooth animation, visible cursor.
    let scrolled = 0;
    while (scrolled < totalH) {
      // Move mouse to centre so the cursor visualizer is visible.
      await page.mouse.move(vp.width / 2, vp.height / 2);
      await page.mouse.wheel(0, dy);
      scrolled += dy;
      await page.waitForTimeout(250);
    }
    // Scroll back to top, also visible.
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
    await page.waitForTimeout(600);
  } else {
    // Headless: fast evaluate-based scroll, lazy images get triggered.
    let y = 0;
    while (y < totalH) {
      await page.evaluate((target) => window.scrollTo({ top: target, behavior: 'instant' }), y);
      await page.waitForTimeout(120);
      y += dy;
    }
    await page.evaluate(() => window.scrollTo(0, 0));
  }
}

/**
 * Detect elements whose text is clipped by overflow:hidden / text-overflow.
 * Catches bugs like "New Jersey, United Sti" or "Business Development" with
 * an icon that pushes the label out — both observed on real Webflow sites.
 */
async function findClippedText(page) {
  return await page.evaluate(() => {
    const out = [];
    // Common interactive containers where Webflow designers use overflow:hidden
    // + a fixed width, which truncates content when copy is longer than expected.
    const sel =
      'button, .w-button, a.button, [role="button"], .pill, .chip, .tag, ' +
      '.filter, .filter-pill, .filter-button, select, .w-dropdown-toggle, ' +
      '[class*="pill" i], [class*="chip" i], [class*="filter" i]';
    document.querySelectorAll(sel).forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      const cs = getComputedStyle(el);
      // Only care if the box actually clips its content
      const clips =
        cs.overflow === 'hidden' || cs.overflowX === 'hidden' || cs.textOverflow === 'ellipsis';
      if (!clips) return;
      const overflowsX = el.scrollWidth > el.clientWidth + 1;
      const overflowsY = el.scrollHeight > el.clientHeight + 1;
      if (!overflowsX && !overflowsY) return;
      const txt = (el.textContent || '').trim();
      if (!txt) return;
      out.push({
        tag: el.tagName.toLowerCase(),
        id: el.id || null,
        cls: typeof el.className === 'string' ? el.className.slice(0, 80) : null,
        text: txt.slice(0, 80),
        rect: { w: Math.round(r.width), h: Math.round(r.height) },
        scrollW: el.scrollWidth,
        clientW: el.clientWidth,
        clippedBy: Math.max(0, el.scrollWidth - el.clientWidth),
        textOverflow: cs.textOverflow,
      });
    });
    return out.slice(0, 25);
  });
}

/**
 * Detect icon-font fallbacks. Webflow components frequently render glyphs via
 * a custom icon font (`.w-icon-*`, `[class^="icon-"]`, `data-icon`). If the
 * font fails to load, browsers render Unicode private-use-area code points as
 * tofu (□) — or, if the CSS uses a single literal char like '#' as fallback,
 * users see the raw character. Both manifest as a one- or two-character text
 * node sitting where an icon should be.
 */
async function findIconFontFallbacks(page) {
  return await page.evaluate(() => {
    const out = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        const t = (n.nodeValue || '').trim();
        if (!t || t.length > 3) return NodeFilter.FILTER_SKIP;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let n;
    while ((n = walker.nextNode())) {
      const t = n.nodeValue.trim();
      if (!t) continue;
      const codes = [...t].map((c) => c.codePointAt(0));
      // Private Use Area or "replacement char" or visible-but-suspicious singletons
      // that consistently appear at end of pills (#, ?, □, ▢, ▮)
      const isPUA = codes.some((cp) => cp >= 0xe000 && cp <= 0xf8ff);
      const looksLikeFallback =
        isPUA || /^[#?□▢▮▯⏵⏷⌃⌄►▼◄▲]$/.test(t);
      if (!looksLikeFallback) continue;
      const el = n.parentElement;
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const cs = getComputedStyle(el);
      out.push({
        char: t,
        codePoints: codes.map((cp) => 'U+' + cp.toString(16).toUpperCase()).join(' '),
        tag: el.tagName.toLowerCase(),
        cls: typeof el.className === 'string' ? el.className.slice(0, 80) : null,
        fontFamily: cs.fontFamily.slice(0, 80),
        parentText: (el.parentElement?.textContent || '').trim().slice(0, 80),
      });
    }
    return out.slice(0, 15);
  });
}

/**
 * Find modal / popup overlays that don't fit the viewport correctly. The
 * canonical Webflow bug: a popup that's full-width on desktop renders at ~50%
 * width on tablet because the breakpoint logic stopped at 'mobile portrait'.
 */
async function findMisplacedModals(page) {
  return await page.evaluate(() => {
    const out = [];
    const vp = { w: window.innerWidth, h: window.innerHeight };
    const selectors = [
      '[role="dialog"]', '[aria-modal="true"]',
      '.modal', '.modal-content', '.modal-dialog',
      '.popup', '.popup-content', '.popup-wrapper',
      '.w-lightbox-container', '.lightbox-content',
      '[class*="modal" i]', '[class*="popup" i]', '[class*="overlay" i][class*="card" i]',
    ];
    const seen = new Set();
    selectors.forEach((sel) => {
      document.querySelectorAll(sel).forEach((el) => {
        if (seen.has(el)) return;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return;
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') return;
        // Only foreground popups (fixed or high z-index)
        const isFloating = cs.position === 'fixed' || Number(cs.zIndex) >= 100;
        if (!isFloating) return;
        seen.add(el);
        const widthPct = (r.width / vp.w) * 100;
        const centerX = r.left + r.width / 2;
        const offCenterPct = (Math.abs(centerX - vp.w / 2) / vp.w) * 100;
        const issues = [];
        if (vp.w <= 1100 && widthPct < 60) issues.push(`width=${widthPct.toFixed(0)}% — modal occupies <60% of tablet/mobile viewport`);
        if (offCenterPct > 12) issues.push(`off-centre by ${offCenterPct.toFixed(0)}% of viewport width`);
        if (r.top < 0 || r.left < 0) issues.push('extends past viewport top/left');
        if (r.bottom > vp.h + 10) issues.push('extends past viewport bottom (cannot scroll inside)');
        if (r.right > vp.w + 10) issues.push('extends past viewport right');
        if (issues.length) {
          out.push({
            sel,
            cls: typeof el.className === 'string' ? el.className.slice(0, 80) : null,
            rect: { w: Math.round(r.width), h: Math.round(r.height), l: Math.round(r.left), t: Math.round(r.top) },
            vp,
            issues,
          });
        }
      });
    });
    return out.slice(0, 10);
  });
}

/**
 * Detect header navigation that overflows its container horizontally — the
 * "cramped tablet header" bug (bug #01 / #07 in our reference set).
 */
async function findHeaderNavOverflow(page) {
  return await page.evaluate(() => {
    const out = [];
    const containers = document.querySelectorAll('header nav, header .w-nav-menu, [role="banner"] nav, .w-nav .w-container');
    containers.forEach((el) => {
      if (el.scrollWidth > el.clientWidth + 2) {
        out.push({
          tag: el.tagName.toLowerCase(),
          cls: typeof el.className === 'string' ? el.className.slice(0, 80) : null,
          scrollW: el.scrollWidth,
          clientW: el.clientWidth,
          overBy: el.scrollWidth - el.clientWidth,
        });
      }
    });
    return out.slice(0, 5);
  });
}

/**
 * Tap-target audit per WCAG 2.5.5 / Apple HIG / Material — interactive
 * elements should be ≥ 44×44 px (or ≥ 24×24 with 24px spacing). On mobile /
 * tablet, anything smaller is a thumb-fail.
 */
async function findTinyTapTargets(page) {
  return await page.evaluate(() => {
    const out = [];
    const sel = 'a, button, [role="button"], input:not([type=hidden]), select, textarea, .w-button';
    document.querySelectorAll(sel).forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return;
      if (r.width < 24 || r.height < 24) {
        out.push({
          tag: el.tagName.toLowerCase(),
          cls: typeof el.className === 'string' ? el.className.slice(0, 60) : null,
          text: (el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 30),
          size: `${Math.round(r.width)}×${Math.round(r.height)}px`,
        });
      }
    });
    return out.slice(0, 20);
  });
}

/**
 * Take a screenshot with a red-box overlay + label drawn over a specific
 * element. This is the difference between "here's the whole page, find the
 * bug yourself" and "here's the exact element that's broken — see for
 * yourself". The overlay is drawn via injected DOM (not as a post-processing
 * step) so it's guaranteed to be aligned with what the browser actually
 * renders, including transforms / scroll offsets.
 */
async function highlightAndScreenshot(page, target, opts = {}) {
  const {
    label = 'BUG',
    boundingRect = null,   // pass to skip the locator-resolve step
    fullPage = false,
    dimBackground = true,
    scrollIntoView = true,
  } = opts;

  let rect = boundingRect;
  let handle = null;

  if (!rect && target) {
    try {
      handle = typeof target === 'string' ? page.locator(target).first() : target;
      if (scrollIntoView) await handle.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
      rect = await handle.boundingBox();
    } catch {}
  }

  // Inject overlay: red BOX around the element + red ARROW pointing INTO
  // the box from above-left. The arrow uses inline SVG (with a marker for
  // the arrowhead) so it renders identically across browsers without
  // depending on font glyphs.
  await page.evaluate(({ r, label, dim }) => {
    document.getElementById('__wf-bug-highlight')?.remove();
    document.getElementById('__wf-bug-arrow')?.remove();
    if (!r) return;

    // --- Red arrow first (so the box renders on top of arrowhead) -------
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // Arrow tip = a point ~24px diagonally above-left of the box top-left
    const tipX = r.x;
    const tipY = r.y - 4;
    // Arrow tail = 110px away from the tip, at 30° above-left
    const tailX = Math.max(20, tipX - 95);
    const tailY = Math.max(20, tipY - 70);

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.id = '__wf-bug-arrow';
    svg.setAttribute('width', String(vw));
    svg.setAttribute('height', String(vh));
    svg.setAttribute('viewBox', `0 0 ${vw} ${vh}`);
    svg.style.cssText = `
      position: fixed; top: 0; left: 0;
      width: 100vw; height: 100vh;
      pointer-events: none;
      z-index: 2147483646;
    `;
    svg.innerHTML = `
      <defs>
        <marker id="__wfArrowHead" viewBox="0 0 12 12" refX="11" refY="6" markerWidth="14" markerHeight="14" orient="auto-start-reverse">
          <path d="M0,0 L12,6 L0,12 Z" fill="#ff2d55" />
        </marker>
      </defs>
      <line x1="${tailX}" y1="${tailY}" x2="${tipX}" y2="${tipY}"
        stroke="#ff2d55" stroke-width="4" stroke-linecap="round"
        marker-end="url(#__wfArrowHead)"
        style="filter: drop-shadow(0 2px 8px rgba(255,45,85,0.6));" />
    `;
    document.body.appendChild(svg);

    // --- Red box around the element -------------------------------------
    const wrap = document.createElement('div');
    wrap.id = '__wf-bug-highlight';
    wrap.style.cssText = `
      position: fixed;
      left: ${r.x - 6}px;
      top: ${r.y - 6}px;
      width: ${r.width + 12}px;
      height: ${r.height + 12}px;
      border: 3px solid #ff2d55;
      border-radius: 6px;
      box-shadow: ${dim ? '0 0 0 9999px rgba(0, 0, 0, 0.55), ' : ''}0 0 24px rgba(255, 45, 85, 0.9);
      z-index: 2147483647;
      pointer-events: none;
      animation: __wfBugPulse 1.2s ease-in-out infinite;
    `;
    // Label badge above the box
    const badge = document.createElement('div');
    badge.textContent = String(label).slice(0, 80);
    badge.style.cssText = `
      position: absolute;
      top: -64px;
      left: 50%;
      transform: translateX(-50%);
      background: linear-gradient(135deg, #ff2d55 0%, #ff6b7a 100%);
      color: white;
      padding: 5px 12px;
      font: 700 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      border-radius: 5px;
      white-space: nowrap;
      box-shadow: 0 4px 16px rgba(255, 45, 85, 0.5);
      letter-spacing: 0.02em;
      max-width: 90vw;
      overflow: hidden;
      text-overflow: ellipsis;
    `;
    wrap.appendChild(badge);
    if (!document.getElementById('__wfBugPulseStyle')) {
      const style = document.createElement('style');
      style.id = '__wfBugPulseStyle';
      style.textContent = `@keyframes __wfBugPulse {
        0%, 100% { box-shadow: ${dim ? '0 0 0 9999px rgba(0,0,0,0.55), ' : ''}0 0 18px rgba(255,45,85,0.7); }
        50% { box-shadow: ${dim ? '0 0 0 9999px rgba(0,0,0,0.55), ' : ''}0 0 36px rgba(255,45,85,1); }
      }`;
      document.head.appendChild(style);
    }
    document.body.appendChild(wrap);
  }, { r: rect, label, dim: dimBackground });

  // Brief delay so animation lands in the screenshot mid-pulse (more visible).
  await page.waitForTimeout(150);

  let buf = null;
  try {
    buf = await page.screenshot({ fullPage, timeout: 6000 });
  } catch {}

  // Remove overlay so subsequent assertions / tests aren't affected.
  await page.evaluate(() => {
    document.getElementById('__wf-bug-highlight')?.remove();
    document.getElementById('__wf-bug-arrow')?.remove();
  }).catch(() => {});

  return buf;
}

/**
 * Convenience: take a regular screenshot and attach it to the test via
 * Playwright's testInfo. Optionally pass `targetSelector` to use the
 * annotated variant.
 */
async function attachAnnotatedFailure(testInfo, page, { label, target, name = 'failure-highlight.png', fullPage = false } = {}) {
  try {
    const buf = target
      ? await highlightAndScreenshot(page, target, { label: label || 'BUG', fullPage })
      : await page.screenshot({ fullPage: fullPage !== false, timeout: 5000 });
    if (buf) await testInfo.attach(name, { body: buf, contentType: 'image/png' });
  } catch {}
}

module.exports = {
  loadSites,
  siteSlug,
  waitForVisuallyReady,
  freezeAnimations,
  findHorizontalOverflow,
  collectSameOriginLinks,
  collectResourceUrls,
  isHeadedDemo,
  installCursorVisualizer,
  scrollPageVisible,
  findClippedText,
  findIconFontFallbacks,
  findMisplacedModals,
  findHeaderNavOverflow,
  findTinyTapTargets,
  highlightAndScreenshot,
  attachAnnotatedFailure,
};
