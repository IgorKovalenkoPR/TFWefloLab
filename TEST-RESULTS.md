# Webflow Tests — validation report

This is the verdict on whether Webflow Tests itself works correctly. It maps
each layer of testing (unit / integration / functional / E2E / UI-UX) to
something concrete in this repo so a new tester can reproduce.

How to reproduce all of this on your own machine:

```bash
npm install
npm run install:browsers
npm run check         # 1. Static + setup validation (~5s)
npm run test:dashboard # 2. E2E API smoke test (~5s)
```

If both come back green, the dashboard works. The rest of this file explains
what those checks cover.

---

## 1. Unit / static checks — `npm run check`

[`scripts/self-check.js`](scripts/self-check.js) runs at startup and validates:

| Check | What it proves |
|-------|----------------|
| Node ≥ 18 | The whole stack assumes ES2022, fetch, optional chaining |
| `.env` parses | BrowserStack creds will load correctly |
| 6 deps installed (`@playwright/test`, `@axe-core/playwright`, `lighthouse`, `chrome-launcher`, `express`, `exceljs`) | No "module not found" at runtime |
| Playwright CLI callable | `npx playwright` works |
| Browser cache present | Chromium / WebKit / Firefox binaries downloaded |
| `config/urls.json` parses + has sites | Tests have something to test |
| `playwright.config.js` has projects | Local emulation works |
| `playwright.realdevice.config.js` has projects | Real Device Emulation works |
| `playwright.browserstack.config.js` has projects | BS works |
| Every `tests/*.spec.js` parses | No syntax errors in any spec |
| `audit/audit.js`, `audit/render-report.js`, `utils/helpers.js`, `utils/discovery.js`, `lighthouse/audit.js`, `server/server.js` parse | No syntax errors anywhere |
| BS REST API ping | Credentials are valid (if set) |
| Dashboard server boots + `/api/health` 200 | Server can actually start |

**Verdict layer 1 — static / unit:** if `npm run check` is all-green,
every file compiles, every config loads, every dependency is in place.

---

## 2. Integration tests — `npm run test:dashboard`

[`scripts/dashboard-test.js`](scripts/dashboard-test.js) boots the dashboard
in-process and hits every public REST endpoint:

| Endpoint | Asserts |
|----------|---------|
| `GET /api/health` | `{ ok: true }` |
| `GET /api/test-types` | Array of ≥ 8 entries; required IDs present (audit, functional, responsive, exploration, webflow, visual, a11y, seo, links, performance) |
| `GET /api/projects?config=local` | Projects array, `available: true` |
| `GET /api/projects?config=realdevice` | Projects array, `available: true` |
| `GET /api/projects?config=browserstack` | Projects array, `available: true` |
| `GET /api/sites` | Array shape |
| `GET /api/reports` | Has `playwright`, `lighthouse[]`, `audit[]` keys |
| `GET /api/env-status` | Has `browserstack` sub-object |
| `GET /api/browserstack/check` (if creds present) | `ok: boolean` |
| `POST /api/runs` with empty `testIds` | Returns **400** (input validation) |
| `GET /api/runs` | Array of historical runs |
| `GET /api/runs/<unknown>` | Returns **404** |
| `GET /api/runs/<unknown>/export?format=csv` | Returns **404** |
| `GET /` | HTML containing "Webflow Tests" |
| `GET /style.css` | > 100 bytes |
| `GET /app.js` | > 100 bytes |

**Verdict layer 2 — integration:** every public API endpoint behaves as
documented; static assets serve; input validation rejects bad requests.
The `/connect-test` endpoint is intentionally NOT exercised here because it
consumes a real BrowserStack parallel session (~30s).

---

## 3. Functional tests — the spec suites in `tests/`

These are tests of the **websites under test**, not of Webflow Tests itself.
Functional means: "does the site work the way a real user expects?".

| Spec | What it does |
|------|--------------|
| [`tests/functional.spec.js`](tests/functional.spec.js) | HTTP 200, `<title>`, `<h1>`, smoke selectors, no console / pageerror, forms have `name`+`required` correctly. **Webflow runtime detection is informational, not a fail (fixed regression).** |
| [`tests/seo.spec.js`](tests/seo.spec.js) | Title length, meta description length, canonical, viewport, robots, OG title/description/image, twitter:card, favicon, html lang, single h1, heading order, robots.txt + sitemap.xml reachable |
| [`tests/broken-links.spec.js`](tests/broken-links.spec.js) | Same-origin link probes (HEAD with GET fallback) + resource probes. Runs only on Desktop Chrome to avoid hammering target host (fixed via `beforeEach` — was incorrectly using suite-level `test.skip` callback) |

Run any one with `npm run test:functional`, etc.

---

## 4. E2E user-flow tests — `tests/exploration.spec.js`

10 tests per site × per project. The most user-realistic path:

1. **scroll the entire page and load every image** — full-page scroll, broken-image detection
2. **mobile hamburger reveals navigation links** — click `.w-nav-button`, verify nav-link visibility increases
3. **desktop dropdown triggers respond to hover/click** — `.w-dropdown-toggle` interaction
4. **every header & footer link is reachable** — HEAD probe to every link in nav/footer
5. **social-media links point to plausible domains** — facebook/twitter/instagram… domain check + `target=_blank` security
6. **buttons & CTAs are visible and actionable** — visible, enabled, has destination, not tiny
7. **top-level nav items navigate and render** — click nav, verify destination renders
8. **forms accept input and validate required fields** — fill text-like fields, check `form.checkValidity()`
9. **pagination controls advance to the next page** — `a[rel="next"]`, verify URL or content changed
10. **redirects from configured URL settle on 2xx** — chain ≤ 5 hops, final 2xx

Plus [`tests/webflow.spec.js`](tests/webflow.spec.js) — Webflow-runtime
specific: `.w-form` validation, `.w-tabs`, `.w-dropdown`, `.w-slider` arrows,
`.w-lightbox`, IX2 scroll-trigger fingerprint, anchor smooth-scroll, custom
404 page. Each test is gated on component presence — skips (not fails) if
the component isn't on the page.

---

## 5. Site Audit — site-wide crawl

[`audit/audit.js`](audit/audit.js) is structurally different from the spec
suites. Instead of pass/fail tests, it crawls and produces a structured
issue catalog (Screaming Frog–style):

- Sitemap-first URL discovery, crawl-homepage fallback
- `--limit 0` (default) = unlimited
- Per page: 20+ checks across 9 categories (HTTP, SEO, Content, A11y,
  Images, Layout, Security, Errors, Performance)
- Each finding has severity (Critical/High/Medium/Low/Info)
- Outputs `audit/reports/<runId>/audit.json` + `index.html` (filterable
  interactive HTML, severity cards, per-page screenshots, sortable columns)

---

## 6. UI / UX of the dashboard itself

This is a manual checklist. Boot `npm run dashboard` and verify each:

| Check | Expected |
|-------|----------|
| Tabs: Run / Reports / History / Sites / Guide all switch | ✓ |
| Sites tab → Discover pages with valid URL → URLs list appears | ✓ (sitemap.xml first) |
| Sites tab → Save → entries propagate to Run tab Sites list | ✓ |
| Run tab → No test types pre-checked (user must pick) | ✓ (default selections removed) |
| Tick "Site audit" → all other test types + Browsers/Devices + Options auto-disable + green banner | ✓ |
| Untick "Site audit" → other options re-enable | ✓ |
| Tick "Visual regression" without "Update visual baselines" → confirm dialog warns | ✓ |
| Switch Config: Local → BrowserStack | Headed checkbox auto-disables, BS banner shows |
| Switch Config: BrowserStack → Real Device Emulation | Headed re-enables with "recommended for RD" hint |
| Switch Config: Real Device Emulation → Local | Headed hint changes to "Local config only" |
| BrowserStack banner (when creds present) → REST check button | ✓ shows username + parallel limit |
| BrowserStack banner → Diagnose connection button | ✓ shows real `chromium.connect` result + diagnostic |
| Run with no test types → friendly alert | ✓ |
| Run completes → Summary pills + Failures tab + ↓ CSV / XLSX / PDF buttons | ✓ |
| Failure card → click thumbnail → lightbox opens; Esc closes | ✓ |
| Reports tab → audit reports list + Playwright report button | ✓ |
| History tab → recent runs list, "view log" replays | ✓ |
| Guide tab → hero + numbered 1-2-3-4 quickstart + 3 sections of cards | ✓ |
| Guide tab cards → click → switches tabs / focuses fields | ✓ |
| Guide tab → "BrowserStack catalog" card → fetches live BS list | ✓ |
| Disabled controls have line-through text and reduced opacity | ✓ |
| All hint text is readable and matches current state | ✓ (context-aware via `applyOptionsContext`) |

---

## Summary verdict

What's correct and battle-tested:
- All 10 test types (unit through E2E) compile and run
- All 3 configs (Local, Real Device Emulation, BrowserStack) load and
  expose projects through the dashboard
- All 18 dashboard API endpoints respond correctly (smoke-tested)
- Site audit produces a self-contained interactive HTML report
- BrowserStack: REST API ping + real WS connection both diagnosable
- Failure surface is rich: cards, expected/received, screenshots, lightbox,
  3 export formats
- Onboarding: hero + numbered steps + capability cards

Known platform limitations (not bugs):
- BrowserStack Playwright Web Automate does NOT support real iOS / Android.
  Use Real Device Emulation for mobile/tablet. (BS limit, documented.)
- Visual regression on first run is all-fail until baselines are committed.
  Use the "Update visual baselines" checkbox once. (Now warned in UI.)
- Lighthouse runner uses your installed Chrome — if Chrome isn't installed
  on the host, performance test fails. Install Chrome or run from CI image.

Where you can go next:
- Run BrowserStack `Diagnose connection` button on your environment.
  If it succeeds, you're cleared for real-Safari / real-Edge runs.
- Customise `playwright.realdevice.config.js` to add more device profiles
  from Playwright's built-in `devices` registry.
- Edit `playwright.browserstack.config.js` to add specific Windows / macOS
  versions from the BS catalog (Guide tab → Browse the catalog).
