# TFWefloLab — code audit & Webflow-focus check

> Walking every file and answering: **is it referenced, is it Webflow-relevant,
> can it be dropped without losing value?** Performed at the rebrand from
> "Webflow Tests Suite" → **TF**Weflo**Lab** (Testfort Webflow Laboratory).

## Verdict

**No dead code found.** Every file is referenced; every helper function is
used in 2+ places; every npm script invokes an existing entry point.
Every test type ships a Webflow-specific tweak (selector, expectation, or
content-shape assumption) — see "Webflow-relevance" column below.

| Removed | Reason |
|---------|--------|
| _(nothing)_ | Suite is tight already. |

---

## File-by-file inventory

### Test specs (`tests/`)

| File | Purpose | Webflow-relevance | Used by |
|------|---------|-------------------|---------|
| `tests/webflow.spec.js` | `.w-form` validation states, `.w-tabs` click, `.w-dropdown` open, `.w-slider` arrows, `.w-lightbox`, IX2 fingerprint, anchor smooth-scroll, custom 404 | **Webflow-specific** — every test gated on Webflow markup; skips on non-Webflow pages instead of failing | Dashboard `webflow` test type, `npm run test:webflow` |
| `tests/exploration.spec.js` | 10 E2E tests: scroll w/ visible cursor, mobile hamburger (`.w-nav-button`), desktop dropdowns (`.w-dropdown-toggle`), header/footer link probes, socials, CTAs (`.w-button`), nav navigation, forms, pagination, redirects | **Heavily Webflow-aware** — uses Webflow's `.w-*` class conventions throughout, with generic fallbacks (`nav`, `header`, `[role]`) | Dashboard `exploration` test type |
| `tests/visual.spec.js` | Full-page screenshot regression at 5 viewports with masking of cookie banners / iframes / dynamic timestamps | Critical for Webflow's designer-driven workflow — small CSS regressions are easy to ship in Webflow Designer | Dashboard `visual` test type |
| `tests/responsive.spec.js` | 10-viewport sweep: overflow detection, body font-size, mobile menu visibility, clipped button text | Webflow's responsive editor gives plenty of opportunity for cross-breakpoint slips | Dashboard `responsive` test type |
| `tests/functional.spec.js` | HTTP 200, title, h1, smoke selectors (or per-site override), no console / pageerror, forms have `name`+`required`. `window.Webflow` detection is informational, not a fail | General smoke — fits Webflow as well as any framework | Dashboard `functional` test type |
| `tests/accessibility.spec.js` | axe-core WCAG 2.1 AA + keyboard navigation | Marketing sites (Webflow's bread and butter) need a11y compliance | Dashboard `a11y` test type |
| `tests/seo.spec.js` | Title length, meta description, canonical, viewport, OG, twitter card, html lang, h1, heading order, sitemap.xml + robots.txt reachable | Webflow sites are typically content-marketing — SEO is critical; sitemap check ties into our discovery flow | Dashboard `seo` test type |
| `tests/broken-links.spec.js` | Same-origin link probes (parallel pool, HEAD with GET fallback), resource (img/css/video) probes | Webflow CMS-collection links can rot when items are deleted; this catches it | Dashboard `links` test type |

### Standalone scripts (not Playwright Test)

| File | Purpose | Webflow-relevance |
|------|---------|-------------------|
| `audit/audit.js` | Site-wide crawler (sitemap.xml first), 20+ checks per page, structured findings | **Webflow-specific** — sitemap-first discovery exploits Webflow's auto-published sitemap; produces Screaming-Frog-style HTML report |
| `audit/render-report.js` | Interactive filterable HTML report (severity / category / page filters, sortable, per-page screenshots, lightbox) | Self-contained — readable offline / by email |
| `lighthouse/audit.js` | Desktop + mobile Lighthouse runs against every configured site; configurable score + CWV budgets | Webflow's hosting can be performant; this verifies it on every release |
| `scripts/self-check.js` | `npm run check` — validates Node, deps, browsers, configs, every spec, BS creds, dashboard boot | Universal — runs in CI |
| `scripts/dashboard-test.js` | `npm run test:dashboard` — boots dashboard in-process and hits every REST endpoint | Regression net for the dashboard itself |

### Configs

| File | Purpose | Why kept |
|------|---------|----------|
| `playwright.config.js` | Local emulation — 11 device profiles (Win11/macOS desktop, Pixel 7, iPhone 14, iPad Pro) | Daily fast path, free |
| `playwright.realdevice.config.js` | DevTools-grade emulation — 13 devices, network throttling, geolocation, video on every test, slowMo via PWT_SLOWMO env | The recommended path for mobile/tablet (BS Playwright doesn't support real mobile) |
| `playwright.browserstack.config.js` | 7 real desktop machines (Win10/11, macOS Sonoma/Ventura × Chromium/Firefox/WebKit) via BS Web Automate | Pixel-perfect real-Safari verification |
| `browserstack/connector.js` | Builds `wss://cdp.browserstack.com/playwright?caps=…` URL with video + debug + visualLogs enabled | Used by browserstack config; standalone for reuse |
| `config/urls.json` | List of sites under test | Dashboard reads & writes via Sites tab |
| `.env.example` | Template for BS credentials + Lighthouse thresholds + port | Documentation by example |

### Dashboard

| File | Purpose | Notes |
|------|---------|-------|
| `server/server.js` | Express + SSE backend — 21 API endpoints (sites, projects, runs, reports, exports, BS check + diagnose, audit, env-status, health) | 100% used by the frontend |
| `server/public/index.html` | 5 tabs: Run / Reports / History / Sites / Guide | Wordmark rebranded to **TF**Weflo**Lab** |
| `server/public/app.js` | All UI logic — checkbox lists, presets, progress, failure cards, passes, exports, lightbox, BS catalog | No legacy paths; previous `loadReports` rewrite cleaned up the dead branch |
| `server/public/style.css` | Dark theme — palette now built around `--tf-blue: #4DD0FF` matching TestFort branding | TF-pulse animation on brand dot |

### Helpers

| Function in `utils/helpers.js` | Used in (file count) |
|--------------------------------|---------------------|
| `loadSites` | 11 |
| `siteSlug` | 2 |
| `waitForVisuallyReady` | 9 |
| `freezeAnimations` | 3 |
| `findHorizontalOverflow` | 2 |
| `collectSameOriginLinks` | 3 |
| `collectResourceUrls` | 2 |
| `isHeadedDemo` | 2 |
| `installCursorVisualizer` | 3 |
| `scrollPageVisible` | 3 |

`utils/discovery.js` — `discoverSiteUrls()` used by `audit/audit.js` and
the dashboard's `/api/sites/discover` endpoint. Sitemap-first, with crawl
fallback. Strips UTM/gclid/fbclid tracking params.

### Docs

| File | Purpose |
|------|---------|
| `README.md` | Full reference (every test type, every CLI script, every config knob) |
| `ONBOARDING.md` | 5-min quickstart + troubleshooting + "what 'all good' looks like" |
| `TEST-RESULTS.md` | Validation methodology — maps test layers (unit / integration / functional / E2E / UI-UX) to specific files & commands |
| `AUDIT.md` | This file |

---

## What makes this Webflow-tuned (not just "Playwright generic")

1. **Sitemap-first discovery** — Webflow auto-publishes `sitemap.xml` for
   every site. `utils/discovery.js` reads it before falling back to crawl,
   so test runs cover every CMS-rendered page without manual URL listing.
2. **`.w-*` selectors throughout** — exploration + Webflow specs use
   Webflow's class conventions (`.w-form`, `.w-tabs`, `.w-dropdown`,
   `.w-slider`, `.w-lightbox`, `.w-nav-button`, `[data-w-id]`) with generic
   semantic fallbacks. Gated on component presence so non-Webflow markup
   skips, not fails.
3. **IX2 detection** — `tests/webflow.spec.js` fingerprints
   `[data-w-id]` style attributes before / after scroll to verify IX2
   scroll-triggered animations actually fire.
4. **Webflow form lifecycle** — `.w-form-done` / `.w-form-fail` siblings
   are inspected to verify Webflow's success / error states render in DOM.
5. **AI-component compatibility** — Webflow AI / Webflow Components render
   as standard HTML with `w-*` classes; all our selectors are content-based
   (CSS classes, ARIA roles), so AI-generated DOM is tested transparently.
6. **`window.Webflow` runtime detection** — **informational only**, never
   fails the test. (We learned the hard way: hard-failing on this gave 75/91
   false-fails on a single edge-case build.)
7. **Marketing-site SEO emphasis** — title-length budgets, OG fields,
   sitemap.xml + robots.txt reachability — all critical for Webflow's
   primary use case (marketing / brand sites).
8. **Visual regression weighted highly** — Webflow Designer's drag-and-drop
   makes small visual regressions easy to ship; the visual spec sweeps 5
   viewports per page on every project.

---

## What's deliberately NOT in TFWefloLab

- **Native mobile testing** — Webflow exports web only; Appium isn't needed.
- **API contract testing** — Webflow sites typically don't expose REST APIs.
- **Database fixtures / seed scripts** — Webflow CMS is managed in the
  Designer, not via SQL fixtures.
- **Auth flows / session management** — Webflow Memberships is a separate
  concern; if your site uses it, add a `tests/memberships.spec.js`.
- **Visual A/B testing comparison** — outside scope; Webflow itself doesn't
  ship A/B tooling.
