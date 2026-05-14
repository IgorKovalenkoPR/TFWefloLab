#!/usr/bin/env node
// @ts-check
/**
 * Site Audit — a Screaming Frog–style crawler that runs a battery of
 * checks against every page of every configured site and emits a single
 * structured report (JSON + HTML).
 *
 * Output:
 *   audit/reports/<runId>/audit.json          machine-readable findings
 *   audit/reports/<runId>/index.html          interactive report
 *   audit/reports/<runId>/screenshots/*.png   per-page screenshots
 *
 * Usage:
 *   node audit/audit.js                       # crawl every configured site
 *   node audit/audit.js --limit 30            # cap to 30 pages per site
 *   node audit/audit.js --device desktop|mobile
 *
 * Each finding has:
 *   {
 *     type, severity, category,
 *     page, pageTitle,
 *     selector?, message,
 *     expected?, actual?,
 *     screenshot?
 *   }
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const URLS_PATH = path.join(ROOT, 'config', 'urls.json');
const REPORTS_ROOT = path.join(__dirname, 'reports');

// ---- CLI args ----
const args = process.argv.slice(2);
function argVal(flag, defVal) {
  const i = args.indexOf(flag);
  if (i === -1) return defVal;
  return args[i + 1];
}
// Page limit per site. 0 / missing / non-positive = no limit (crawl every page
// found via sitemap.xml). Pass `--limit 30` on the CLI to cap if needed.
const PAGE_LIMIT = (() => {
  const n = Number(argVal('--limit', 0));
  return Number.isFinite(n) && n > 0 ? n : Infinity;
})();
const DEVICE_PROFILE = String(argVal('--device', 'desktop')).toLowerCase();
// Comma-separated list of site NAMES (matching config/urls.json names) to
// audit. When omitted, every configured site is crawled. Set by the
// dashboard from the user's checkbox selection.
const SITES_FILTER = String(argVal('--sites', ''))
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-').replace(/[Tt]/, '_').slice(0, 19);
const REPORT_DIR = path.join(REPORTS_ROOT, RUN_ID);
const SHOTS_DIR = path.join(REPORT_DIR, 'screenshots');

fs.mkdirSync(SHOTS_DIR, { recursive: true });

// ---- Severity / category dictionaries ----
const SEVERITY = { CRITICAL: 'Critical', HIGH: 'High', MEDIUM: 'Medium', LOW: 'Low', INFO: 'Info' };
const CATEGORY = {
  ERRORS: 'Errors / Console',
  HTTP: 'HTTP / Links',
  SEO: 'SEO / Metadata',
  A11Y: 'Accessibility',
  CONTENT: 'Content',
  IMAGES: 'Images',
  LAYOUT: 'Layout / Responsive',
  SECURITY: 'Security',
  PERF: 'Performance',
};

function shortHash(s) {
  return crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 12);
}

function loadSites() {
  const j = JSON.parse(fs.readFileSync(URLS_PATH, 'utf8'));
  return (j.sites || []).filter((s) => s && s.url);
}

// ---- Discover URLs (sitemap-first, falls back to homepage crawl) ----
const { discoverSiteUrls } = require('../utils/discovery');

// ---- Per-page checks ----
async function auditPage(page, url, ctx) {
  const findings = [];
  const consoleErrors = [];
  const pageErrors = [];
  const responses = [];

  const consoleHandler = (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  };
  const pageErrorHandler = (err) => pageErrors.push(String(err.message || err));
  const responseHandler = (r) => responses.push({ url: r.url(), status: r.status(), type: r.request().resourceType() });

  page.on('console', consoleHandler);
  page.on('pageerror', pageErrorHandler);
  page.on('response', responseHandler);

  let response;
  try {
    response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  } catch (e) {
    findings.push({
      type: 'navigation-failed',
      severity: SEVERITY.CRITICAL,
      category: CATEGORY.HTTP,
      message: `Navigation to page failed: ${e.message}`,
    });
    return finalize(findings, { status: 0, title: '', url });
  } finally {
    // detach listeners later, after harvesting
  }

  const httpStatus = response ? response.status() : 0;
  if (httpStatus >= 400) {
    findings.push({
      type: 'http-error',
      severity: SEVERITY.CRITICAL,
      category: CATEGORY.HTTP,
      message: `Page returned HTTP ${httpStatus}`,
      actual: String(httpStatus),
      expected: '< 400',
    });
  }

  // Wait for the page to settle a bit so lazy stuff loads.
  try {
    await page.waitForLoadState('networkidle', { timeout: 10_000 });
  } catch {}
  // Trigger lazy-load of every image by scrolling once.
  try {
    await page.evaluate(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      let prev = -1;
      while (window.scrollY !== prev) {
        prev = window.scrollY;
        window.scrollBy(0, window.innerHeight);
        await sleep(120);
      }
      window.scrollTo(0, 0);
      await sleep(150);
    });
  } catch {}

  const meta = await page.evaluate(() => {
    const get = (sel, attr = 'content') => {
      const el = document.querySelector(sel);
      return el ? el.getAttribute(attr) : null;
    };
    const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6')).map((h) => ({
      level: Number(h.tagName.substring(1)),
      text: (h.textContent || '').trim().slice(0, 200),
    }));
    const imagesInfo = Array.from(document.images).map((img) => ({
      src: img.src,
      alt: img.alt,
      hasAlt: img.hasAttribute('alt'),
      width: img.naturalWidth,
      height: img.naturalHeight,
      lazy: img.loading === 'lazy',
    }));
    const internalLinks = [];
    const externalLinks = [];
    const origin = location.origin;
    document.querySelectorAll('a[href]').forEach((a) => {
      try {
        const u = new URL(a.href, location.href);
        if (!/^https?:/.test(u.protocol)) return;
        const text = (a.textContent || '').trim().slice(0, 80);
        if (u.origin === origin) {
          internalLinks.push({ href: u.toString(), text });
        } else {
          externalLinks.push({
            href: u.toString(),
            text,
            target: a.getAttribute('target') || '',
            rel: a.getAttribute('rel') || '',
          });
        }
      } catch {}
    });
    const formsInfo = Array.from(document.querySelectorAll('form')).map((f) => ({
      action: f.action || '',
      method: (f.method || 'get').toLowerCase(),
      inputCount: f.querySelectorAll('input,select,textarea').length,
      requiredCount: f.querySelectorAll('[required]').length,
      requiredWithoutLabel: Array.from(f.querySelectorAll('[required]')).filter((el) => {
        const id = el.id;
        if (id && document.querySelector(`label[for="${CSS.escape(id)}"]`)) return false;
        if (el.closest('label')) return false;
        if (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby')) return false;
        return true;
      }).length,
    }));
    return {
      title: document.title,
      description: get('meta[name="description"]'),
      canonical: get('link[rel="canonical"]', 'href'),
      viewport: get('meta[name="viewport"]'),
      robots: get('meta[name="robots"]'),
      ogTitle: get('meta[property="og:title"]'),
      ogDescription: get('meta[property="og:description"]'),
      ogImage: get('meta[property="og:image"]'),
      twCard: get('meta[name="twitter:card"]'),
      htmlLang: document.documentElement.getAttribute('lang'),
      h1Count: document.querySelectorAll('h1').length,
      headings,
      imagesInfo,
      internalLinks,
      externalLinks,
      formsInfo,
      bodyTextLen: (document.body && document.body.textContent ? document.body.textContent.trim().length : 0),
    };
  });

  // ---------- SEO / metadata ----------
  if (!meta.title || !meta.title.trim()) {
    findings.push({ type: 'missing-title', severity: SEVERITY.HIGH, category: CATEGORY.SEO, message: 'Page is missing a <title>.', expected: 'A unique 30-65 char title', actual: meta.title || '' });
  } else if (meta.title.length > 65) {
    findings.push({ type: 'title-too-long', severity: SEVERITY.LOW, category: CATEGORY.SEO, message: `<title> is ${meta.title.length} chars (recommended ≤ 65).`, actual: meta.title });
  } else if (meta.title.length < 20) {
    findings.push({ type: 'title-too-short', severity: SEVERITY.LOW, category: CATEGORY.SEO, message: `<title> is only ${meta.title.length} chars (recommended ≥ 20).`, actual: meta.title });
  }

  if (!meta.description) {
    findings.push({ type: 'missing-description', severity: SEVERITY.HIGH, category: CATEGORY.SEO, message: 'Page is missing <meta name="description">.', expected: '<meta name="description" content="...">' });
  } else if (meta.description.length > 165) {
    findings.push({ type: 'description-too-long', severity: SEVERITY.LOW, category: CATEGORY.SEO, message: `Meta description is ${meta.description.length} chars (recommended ≤ 165).`, actual: meta.description });
  } else if (meta.description.length < 70) {
    findings.push({ type: 'description-too-short', severity: SEVERITY.LOW, category: CATEGORY.SEO, message: `Meta description is only ${meta.description.length} chars (recommended ≥ 70).`, actual: meta.description });
  }

  if (!meta.canonical) {
    findings.push({ type: 'missing-canonical', severity: SEVERITY.MEDIUM, category: CATEGORY.SEO, message: 'Page is missing <link rel="canonical">.' });
  }
  if (!meta.viewport || !/width=device-width/i.test(meta.viewport)) {
    findings.push({ type: 'missing-viewport', severity: SEVERITY.HIGH, category: CATEGORY.SEO, message: 'Page is missing a mobile viewport meta tag.', expected: '<meta name="viewport" content="width=device-width, initial-scale=1">', actual: meta.viewport });
  }
  if (meta.robots && /noindex/i.test(meta.robots)) {
    findings.push({ type: 'noindex', severity: SEVERITY.HIGH, category: CATEGORY.SEO, message: 'Page is marked noindex.', actual: meta.robots });
  }
  if (!meta.ogTitle) findings.push({ type: 'missing-og-title', severity: SEVERITY.LOW, category: CATEGORY.SEO, message: 'Missing <meta property="og:title">.' });
  if (!meta.ogDescription) findings.push({ type: 'missing-og-description', severity: SEVERITY.LOW, category: CATEGORY.SEO, message: 'Missing <meta property="og:description">.' });
  if (!meta.ogImage) findings.push({ type: 'missing-og-image', severity: SEVERITY.MEDIUM, category: CATEGORY.SEO, message: 'Missing <meta property="og:image"> — links shared on social media will not have a preview image.' });
  if (!meta.twCard) findings.push({ type: 'missing-twitter-card', severity: SEVERITY.LOW, category: CATEGORY.SEO, message: 'Missing <meta name="twitter:card">.' });

  // ---------- Headings ----------
  if (meta.h1Count === 0) {
    findings.push({ type: 'no-h1', severity: SEVERITY.HIGH, category: CATEGORY.CONTENT, message: 'Page has no <h1>.' });
  } else if (meta.h1Count > 1) {
    findings.push({ type: 'multiple-h1', severity: SEVERITY.MEDIUM, category: CATEGORY.CONTENT, message: `Page has ${meta.h1Count} <h1> tags. Recommended: exactly one.`, actual: String(meta.h1Count) });
  }
  let prev = 0;
  for (const h of meta.headings) {
    if (prev !== 0 && h.level > prev + 1) {
      findings.push({
        type: 'heading-level-skipped',
        severity: SEVERITY.LOW,
        category: CATEGORY.A11Y,
        message: `Heading level skipped: <h${prev}> → <h${h.level}> ("${h.text}").`,
      });
      break;
    }
    prev = h.level;
  }

  // ---------- HTML lang ----------
  if (!meta.htmlLang) {
    findings.push({ type: 'missing-html-lang', severity: SEVERITY.MEDIUM, category: CATEGORY.A11Y, message: 'Missing <html lang="…"> attribute.', expected: '<html lang="en">' });
  }

  // ---------- Images ----------
  const noAlt = meta.imagesInfo.filter((img) => !img.hasAlt && img.src && !img.src.startsWith('data:'));
  if (noAlt.length) {
    findings.push({
      type: 'images-missing-alt',
      severity: SEVERITY.HIGH,
      category: CATEGORY.A11Y,
      message: `${noAlt.length} image${noAlt.length === 1 ? '' : 's'} missing alt attribute.`,
      actual: noAlt.slice(0, 5).map((i) => i.src).join('\n'),
    });
  }
  const broken = meta.imagesInfo.filter((img) => img.src && !img.src.startsWith('data:') && img.width === 0);
  if (broken.length) {
    findings.push({
      type: 'images-broken',
      severity: SEVERITY.HIGH,
      category: CATEGORY.IMAGES,
      message: `${broken.length} image${broken.length === 1 ? '' : 's'} failed to load.`,
      actual: broken.slice(0, 5).map((i) => i.src).join('\n'),
    });
  }

  // ---------- External-link security ----------
  const insecureExt = meta.externalLinks.filter((l) => l.target === '_blank' && !/noopener/.test(l.rel));
  if (insecureExt.length) {
    findings.push({
      type: 'external-link-noopener',
      severity: SEVERITY.LOW,
      category: CATEGORY.SECURITY,
      message: `${insecureExt.length} external link${insecureExt.length === 1 ? '' : 's'} open in a new tab without rel="noopener".`,
      actual: insecureExt.slice(0, 5).map((l) => `${l.href} ("${l.text || ''}")`).join('\n'),
    });
  }

  // ---------- HTTP status of internal links (sample) ----------
  const internalSample = meta.internalLinks
    .map((l) => l.href)
    .filter((u, i, a) => a.indexOf(u) === i)
    .slice(0, 25);
  for (const u of internalSample) {
    try {
      let r = await ctx.request.fetch(u, { method: 'HEAD', timeout: 10_000, maxRedirects: 5 });
      if (r.status() === 405 || r.status() === 501) {
        r = await ctx.request.fetch(u, { method: 'GET', timeout: 10_000, maxRedirects: 5, headers: { Range: 'bytes=0-1023' } });
      }
      if (r.status() >= 400) {
        findings.push({
          type: 'broken-internal-link',
          severity: SEVERITY.HIGH,
          category: CATEGORY.HTTP,
          message: `Internal link returns HTTP ${r.status()}: ${u}`,
          actual: String(r.status()),
        });
      }
    } catch (e) {
      findings.push({
        type: 'broken-internal-link',
        severity: SEVERITY.HIGH,
        category: CATEGORY.HTTP,
        message: `Internal link unreachable: ${u}`,
        actual: String(e && e.message ? e.message : e),
      });
    }
  }

  // ---------- HTTP status of resource responses captured during page load ----------
  const failedResources = responses.filter((r) => r.status >= 400);
  for (const r of failedResources.slice(0, 20)) {
    findings.push({
      type: 'broken-resource',
      severity: SEVERITY.MEDIUM,
      category: CATEGORY.HTTP,
      message: `Resource returned HTTP ${r.status} (${r.type}): ${r.url}`,
      actual: String(r.status),
    });
  }

  // ---------- Mixed content ----------
  if (url.startsWith('https:')) {
    const httpRes = responses.filter((r) => /^http:/.test(r.url));
    if (httpRes.length) {
      findings.push({
        type: 'mixed-content',
        severity: SEVERITY.HIGH,
        category: CATEGORY.SECURITY,
        message: `${httpRes.length} resource${httpRes.length === 1 ? '' : 's'} loaded over HTTP on an HTTPS page.`,
        actual: httpRes.slice(0, 5).map((r) => r.url).join('\n'),
      });
    }
  }

  // ---------- Console / page errors ----------
  if (pageErrors.length) {
    findings.push({
      type: 'js-uncaught-error',
      severity: SEVERITY.CRITICAL,
      category: CATEGORY.ERRORS,
      message: `${pageErrors.length} uncaught JavaScript error${pageErrors.length === 1 ? '' : 's'} on the page.`,
      actual: pageErrors.slice(0, 5).join('\n'),
    });
  }
  if (consoleErrors.length) {
    findings.push({
      type: 'console-error',
      severity: SEVERITY.MEDIUM,
      category: CATEGORY.ERRORS,
      message: `${consoleErrors.length} console error${consoleErrors.length === 1 ? '' : 's'} during page load.`,
      actual: consoleErrors.slice(0, 8).join('\n'),
    });
  }

  // ---------- Layout overflow at current viewport ----------
  const overflow = await page.evaluate(() => {
    const root = document.documentElement;
    const docW = root.clientWidth;
    const offenders = [];
    document.querySelectorAll('body *').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      const cs = getComputedStyle(el);
      if (cs.position === 'fixed' || cs.position === 'sticky') return;
      if (r.right > docW + 1) {
        offenders.push({
          tag: el.tagName.toLowerCase(),
          id: el.id || null,
          cls: typeof el.className === 'string' ? el.className.slice(0, 80) : null,
          right: Math.round(r.right),
          docW,
        });
      }
    });
    return { docOverflow: root.scrollWidth - root.clientWidth, offenders: offenders.slice(0, 5) };
  });
  if (overflow.docOverflow > 1) {
    findings.push({
      type: 'horizontal-overflow',
      severity: SEVERITY.HIGH,
      category: CATEGORY.LAYOUT,
      message: `Document scrolls horizontally by ${overflow.docOverflow}px at the current viewport.`,
      actual: `Document width over by ${overflow.docOverflow}px. Offenders: ` +
        overflow.offenders.map((o) => `<${o.tag}${o.id ? '#' + o.id : ''}>`).join(', '),
    });
  }

  // ---------- Tablet-class bug patterns (learned from real soft2bet bugs) ----------
  // Reuse the helpers from utils/helpers.js so spec + audit stay in lock-step.
  const {
    findClippedText: _findClipped,
    findIconFontFallbacks: _findTofu,
    findHeaderNavOverflow: _findNavOver,
  } = require('../utils/helpers');

  const clipped = await _findClipped(page).catch(() => []);
  for (const c of clipped.slice(0, 8)) {
    findings.push({
      type: 'text-clipped',
      severity: SEVERITY.MEDIUM,
      category: CATEGORY.LAYOUT,
      message: `Text clipped inside <${c.tag}> — "${(c.text || '').slice(0, 60)}" overflows by ${c.clippedBy}px (no text-overflow:ellipsis).`,
      actual: `box=${c.rect.w}×${c.rect.h}px, scrollWidth=${c.scrollW}, clientWidth=${c.clientW}, class="${c.cls || ''}"`,
    });
  }

  const tofu = await _findTofu(page).catch(() => []);
  for (const t of tofu.slice(0, 5)) {
    findings.push({
      type: 'icon-font-fallback',
      severity: SEVERITY.MEDIUM,
      category: CATEGORY.IMAGES,
      message: `Suspected icon-font fallback character "${t.char}" visible in UI — the icon font likely failed to load.`,
      actual: `code points: ${t.codePoints}; font-family: ${t.fontFamily}; inside <${t.tag}.${t.cls || ''}> — parent text: "${(t.parentText || '').slice(0, 60)}"`,
    });
  }

  const navOver = await _findNavOver(page).catch(() => []);
  for (const n of navOver.slice(0, 3)) {
    findings.push({
      type: 'header-nav-overflow',
      severity: SEVERITY.MEDIUM,
      category: CATEGORY.LAYOUT,
      message: `Header navigation overflows its container by ${n.overBy}px — items don't fit horizontally at this viewport.`,
      actual: `<${n.tag}.${n.cls}> scrollWidth=${n.scrollW}, clientWidth=${n.clientW}`,
    });
  }

  // ---------- Forms ----------
  for (const f of meta.formsInfo) {
    if (f.requiredWithoutLabel > 0) {
      findings.push({
        type: 'form-required-no-label',
        severity: SEVERITY.MEDIUM,
        category: CATEGORY.A11Y,
        message: `${f.requiredWithoutLabel} required field${f.requiredWithoutLabel === 1 ? '' : 's'} on this form lack a <label> / aria-label.`,
        actual: `Form action="${f.action || '(none)'}" method=${f.method}`,
      });
    }
  }

  // ---------- Body content emptiness ----------
  if (meta.bodyTextLen < 200) {
    findings.push({
      type: 'thin-content',
      severity: SEVERITY.MEDIUM,
      category: CATEGORY.CONTENT,
      message: `Page has only ${meta.bodyTextLen} chars of body text — looks like a near-empty page.`,
    });
  }

  // ---------- Take screenshot ----------
  let screenshotName = null;
  try {
    screenshotName = shortHash(url) + '.png';
    await page.screenshot({
      path: path.join(SHOTS_DIR, screenshotName),
      fullPage: true,
      timeout: 12_000,
    });
  } catch {
    screenshotName = null;
  }

  page.off('console', consoleHandler);
  page.off('pageerror', pageErrorHandler);
  page.off('response', responseHandler);

  return finalize(findings, { status: httpStatus, title: meta.title || '', url, screenshot: screenshotName, meta });

  function finalize(items, info) {
    items.forEach((it) => {
      it.page = info.url;
      it.pageTitle = info.title;
      if (info.screenshot) it.screenshot = `screenshots/${info.screenshot}`;
    });
    return { ...info, findings: items };
  }
}

// ---------- Main ----------
async function main() {
  let sites = loadSites();
  if (!sites.length) {
    console.error('[audit] No sites configured in config/urls.json');
    process.exit(1);
  }
  if (SITES_FILTER.length) {
    const lower = new Set(SITES_FILTER.map((s) => s.toLowerCase()));
    const filtered = sites.filter((s) => lower.has(String(s.name || '').toLowerCase()));
    if (!filtered.length) {
      console.error(
        `[audit] None of the requested sites (${SITES_FILTER.join(', ')}) match config/urls.json. ` +
          `Available: ${sites.map((s) => s.name).join(', ')}`
      );
      process.exit(1);
    }
    sites = filtered;
    console.log(`[audit] Filtering to ${sites.length} requested site(s): ${sites.map((s) => s.name).join(', ')}`);
  }

  // Use @playwright/test's chromium import — playwright.config.js already has it.
  const { chromium, devices } = require('@playwright/test');
  const deviceProfile =
    DEVICE_PROFILE === 'mobile'
      ? { ...devices['Pixel 7'] }
      : DEVICE_PROFILE === 'tablet'
        ? { ...devices['iPad Pro 11'] }
        : { viewport: { width: 1366, height: 800 }, userAgent: undefined };

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ ...deviceProfile, ignoreHTTPSErrors: true });

  const startedAt = Date.now();
  const allPages = [];
  const visited = new Set();

  const limitLabel = PAGE_LIMIT === Infinity ? 'unlimited' : String(PAGE_LIMIT);
  console.log(`[audit] Page limit per site: ${limitLabel}`);

  for (const site of sites) {
    process.stdout.write(`\n[audit] Site: ${site.name} (${site.url})\n`);
    const discovery = await discoverSiteUrls(site.url, { maxPages: PAGE_LIMIT }).catch(() => ({ urls: [site.url], method: 'home-only' }));
    const urls = (discovery.urls || [site.url]).filter((u) => !visited.has(u)).slice(0, PAGE_LIMIT);
    process.stdout.write(`[audit] discovered ${urls.length} page(s) via ${discovery.method}\n`);

    for (let i = 0; i < urls.length; i++) {
      const u = urls[i];
      visited.add(u);
      process.stdout.write(`[audit] (${i + 1}/${urls.length}) ${u}\n`);
      const page = await ctx.newPage();
      try {
        const result = await auditPage(page, u, { request: ctx.request });
        result.site = site.name;
        allPages.push(result);
        process.stdout.write(`         ${result.findings.length} issue${result.findings.length === 1 ? '' : 's'}\n`);
      } catch (e) {
        allPages.push({
          url: u,
          site: site.name,
          status: 0,
          title: '',
          findings: [{
            type: 'audit-error',
            severity: SEVERITY.CRITICAL,
            category: CATEGORY.ERRORS,
            message: `Audit threw: ${String(e && e.message ? e.message : e)}`,
            page: u,
          }],
        });
      } finally {
        await page.close().catch(() => {});
      }
    }
  }

  await browser.close();

  // Aggregate report
  const allIssues = [];
  for (const p of allPages) for (const f of p.findings) allIssues.push(f);
  const byCategory = {};
  const bySeverity = {};
  const byType = {};
  for (const f of allIssues) {
    byCategory[f.category] = (byCategory[f.category] || 0) + 1;
    bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1;
    byType[f.type] = (byType[f.type] || 0) + 1;
  }

  const report = {
    runId: RUN_ID,
    started: new Date(startedAt).toISOString(),
    ended: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    deviceProfile: DEVICE_PROFILE,
    pageLimit: PAGE_LIMIT,
    totals: {
      sites: sites.length,
      pages: allPages.length,
      issues: allIssues.length,
      byCategory,
      bySeverity,
      byType,
    },
    pages: allPages,
  };

  fs.writeFileSync(path.join(REPORT_DIR, 'audit.json'), JSON.stringify(report, null, 2));
  const { renderReportHtml } = require('./render-report');
  fs.writeFileSync(path.join(REPORT_DIR, 'index.html'), renderReportHtml(report));

  console.log('\n[audit] Done.');
  console.log(`[audit] Pages crawled: ${allPages.length}`);
  console.log(`[audit] Total issues:  ${allIssues.length}`);
  for (const [sev, n] of Object.entries(bySeverity)) console.log(`         ${sev.padEnd(10)} ${n}`);
  console.log(`\n[audit] Report: audit/reports/${RUN_ID}/index.html`);
}

main().catch((e) => {
  console.error('[audit] Fatal:', e);
  process.exit(1);
});
