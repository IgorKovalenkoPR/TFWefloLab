# Onboarding — **TF**Weflo**Lab** (Testfort Webflow Laboratory)

A 5-minute quickstart for QA engineers who just opened this folder.
Built by the [TestFort](https://testfort.com/) team.

---

## TL;DR

```bash
npm install                 # one-time
npm run install:browsers    # one-time (downloads Chromium / Firefox / WebKit)
npm run check               # validates the whole setup
npm run dashboard           # opens http://localhost:3000
```

Then in the dashboard:

1. **Sites tab** → enter your site URL → press **Discover pages →** → pick which pages to test → **Save**
2. **Run tab** → tick **Site audit (crawler-style report)** → press **Run tests**
3. After the run finishes — open the Reports tab to see the audit, or download CSV / XLSX / PDF.

That's it. The rest of this document explains the moving parts.

---

## 1. What this tool actually does

It bundles **eight different kinds of checks** behind one dashboard. You pick
which ones to run; each maps to a real-world QA concern:

| What you tick on the dashboard          | What kind of testing is that?                  | When to run it                                    |
|------------------------------------------|------------------------------------------------|---------------------------------------------------|
| **Site audit (crawler-style report)**    | Site-wide audit (Screaming Frog / Netpeak)     | First thing on every release — gives the big picture |
| Functional                               | Functional smoke tests                         | Sanity check that pages load + critical landmarks   |
| Responsive UI/UX                         | UI testing across 10 viewport widths           | Catch layout breakage at edge widths                |
| Site exploration (deep interactions)     | E2E user-flow simulation (forms, pagination, redirects, menus, dropdowns, social links, CTAs) | The closest thing to a real user clicking around   |
| Visual regression                        | Pixel-diff against committed baselines         | After intentional UI changes (with **Update baselines** ON) and on every PR |
| Accessibility                            | Automated a11y (axe-core, WCAG 2.1 AA) + keyboard | Required for compliance; quick to run               |
| SEO / metadata                           | Static SEO checks (title, OG, canonical, etc.) | Before publishing                                   |
| Broken links                             | HTTP probes against every same-origin link     | Catches dead URLs / 404s                            |
| Performance (Lighthouse)                 | Web Vitals / scores                            | Before publishing; budgets in `.env`                |

How this maps to traditional testing levels:

- **Unit / Integration** — there isn't much "code" in the typical sense; this
  tool tests the *deployed website*, not source code. The dashboard server
  itself is exercised by `npm run check` (which boots it and pings endpoints).
- **Functional** — `tests/functional.spec.js` covers smoke functional checks.
- **End-to-end (E2E)** — `tests/exploration.spec.js` is the E2E suite. It
  drives the page like a real user.
- **UI / UX** — `tests/responsive.spec.js`, `tests/visual.spec.js`,
  `tests/accessibility.spec.js`.

---

## 2. Set up the project (10 min, once)

```bash
# 1. Install JS dependencies
npm install

# 2. Install Playwright's browser engines (~600 MB, one-time)
npm run install:browsers

# 3. (Optional) Set BrowserStack credentials for real-device testing.
#    Copy .env.example → .env, then edit:
#       BROWSERSTACK_USERNAME=...
#       BROWSERSTACK_ACCESS_KEY=...

# 4. Verify everything is in place
npm run check
```

`npm run check` will tell you in green / yellow / red:

```
Environment
  ✓ Node.js v22.x
  ✓ .env present  3 key(s)
Dependencies
  ✓ @playwright/test installed
  ✓ exceljs installed
  …
Playwright browsers
  ✓ playwright CLI    Version 1.48.x
  ✓ browser cache present  C:\Users\you\AppData\Local\ms-playwright
Configs
  ✓ config/urls.json  3 site(s)
  ✓ playwright.config.js  11 project(s)
  ✓ playwright.browserstack.config.js  10 project(s)
Test specs
  ✓ tests/functional.spec.js
  ✓ tests/exploration.spec.js
  …
BrowserStack
  ✓ credentials valid  user=…, parallel=5, running=0
Dashboard server
  ✓ boots cleanly + /api/health 200
```

If anything is red, the message tells you what to do (usually
`npm install` or `npm run install:browsers`).

---

## 3. Day-to-day workflow

### A) Start the dashboard

```bash
npm run dashboard
```

A line `Webflow Tests dashboard:  http://localhost:3000` appears. Open it.

### B) Add the URLs you want tested

The dashboard has a **Sites tab**. There are two ways to populate it:

**Option 1 (recommended) — auto-discover from sitemap.xml**

1. Sites tab → enter your site URL into the **Discover pages** field
2. Press **Discover pages →** → the tool reads `sitemap.xml`
3. Tick the pages you want to test → **+ Add selected to sites** → **Save**

**Option 2 — manual**

Add a row, type Name + URL, press **Save**.

> The site list on the **Run tab** is just a *selector* — checkboxes for
> which configured sites to include in this run. To **add** or **edit** URLs
> always use the Sites tab.

### C) Pick what to run (Run tab)

Three groups of choices:

1. **Sites** — which sites this run covers (checkboxes).
2. **Test types** — which checks to perform.
3. **Browsers / devices** — only used for non-audit test types.

> **Special case: Site audit.** When you tick *Site audit*, all the other
> options are automatically disabled — audit is a self-contained crawler
> with its own headless Chromium and doesn't use the browser/device picker
> or the other test types. The dashboard greys those out and shows a banner
> explaining this so you don't get confused.

Press **▶ Run tests**. The Log pane streams stdout/stderr in real time.

### D) Read the results

When the run finishes, three things happen:

1. The **summary pills** at the top change to green/red counts.
2. A new tab appears in the result panel: **Failures (N)** — click it to see
   each failure as a bug-report card with project, scenario, expected vs.
   received, and inline screenshots (click any thumbnail to enlarge).
3. **Download buttons** appear: ↓ CSV, ↓ XLSX, ↓ PDF.
   - **CSV** is plain failures (Excel-compatible, UTF-8 BOM included).
   - **XLSX** is a structured *Bug Report* sheet with hyperlinks to screenshots.
   - **PDF** opens a print-friendly bug report — Ctrl+P → Save as PDF.

For Site audit specifically, the **Reports** tab shows the interactive
crawler report (Screaming Frog–style — filter by severity / category / page,
sort columns, click rows to expand with screenshots).

---

## 4. Working with BrowserStack

To test on real macOS Safari / real iPhones / real Android devices:

1. Get an Automate account at [browserstack.com/automate](https://www.browserstack.com/automate).
2. Copy `.env.example` → `.env`, fill in:
   ```
   BROWSERSTACK_USERNAME=your_username
   BROWSERSTACK_ACCESS_KEY=your_access_key
   ```
3. Restart `npm run dashboard`.
4. On the Run tab, switch **Config → BrowserStack (real devices)**.
5. The banner now shows **✓ Connected**. Click **Test connection** to confirm
   credentials and see your active plan limits (parallel sessions, running).
6. Tick the BS projects you want, hit Run. Watch live in
   [BrowserStack Live](https://automate.browserstack.com/dashboard/v2)
   (link in the banner). Sessions are recorded — you can replay them after.

> **Note**: *Headed (show browser)* is automatically disabled in BrowserStack
> mode because the browser runs on a cloud machine. Use BS Live for visual
> debugging.

---

## 5. Common tasks

| Task | How |
|------|-----|
| Test only the homepage of one site | Sites tab → just one entry. Run tab → tick that site only. |
| Test the entire site (all pages) | Sites tab → Discover pages → Save. Run tab → Site audit. |
| First visual-regression run (no baselines) | Run tab → tick **Visual regression** + **Update visual baselines** → Run. Future runs without that checkbox compare against these baselines. |
| Add a new test type | Drop a `*.spec.js` into `tests/`, register in `server/server.js` `TEST_TYPES`, restart dashboard. |
| Run a single spec from CLI | `npx playwright test tests/exploration.spec.js --project="Desktop Chrome (Windows 11)"` |
| Update Playwright | `npm install -D @playwright/test@latest && npx playwright install --with-deps` |
| Re-run only failed tests | `npx playwright test --last-failed` |
| Open last Playwright report | `npm run report` |

---

## 6. Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| `'C:\Program' is not recognized` | Was a Windows path-quoting bug — fixed in current code. Just restart the dashboard. |
| `Cannot find module '@playwright/test'` | Run `npm install` |
| Browsers fail to launch | Run `npm run install:browsers` |
| BrowserStack: "credentials rejected" | Double-check `.env` (no extra quotes or spaces around the `=`); restart the dashboard. |
| Audit crawls all sites instead of selected one | Was a bug — fixed; the dashboard now passes `--sites` to the audit script. |
| Visual tests all fail on first run | Expected — there are no baselines yet. Re-run with **Update visual baselines** ticked. |
| Tests hang on a slow page | Default Playwright timeout is 60s. Edit `timeout` in `playwright.config.js`. |
| Dashboard port 3000 is busy | Set a different port: `PORT=3001 npm run dashboard` (or in `.env`). |

---

## 7. Project layout (one paragraph each)

```
.
├── audit/
│   ├── audit.js              ← Site audit crawler (Screaming Frog–style)
│   └── render-report.js      ← interactive HTML report renderer
├── browserstack/
│   └── connector.js          ← builds wsEndpoint URL with caps
├── config/
│   └── urls.json             ← list of sites to test (managed via Sites tab)
├── lighthouse/
│   └── audit.js              ← Lighthouse runner (desktop + mobile per URL)
├── playwright.config.js      ← local emulation projects
├── playwright.browserstack.config.js ← real-device projects via BS
├── scripts/
│   └── self-check.js         ← `npm run check` — validates whole setup
├── server/
│   ├── server.js             ← Express dashboard backend (SSE, exports, BS check)
│   └── public/               ← dashboard HTML/CSS/JS
├── tests/
│   ├── functional.spec.js    ← smoke functional checks
│   ├── responsive.spec.js    ← 10 viewports per page
│   ├── exploration.spec.js   ← E2E user-flow simulation
│   ├── visual.spec.js        ← screenshot regression
│   ├── accessibility.spec.js ← axe-core + keyboard nav
│   ├── seo.spec.js           ← title / OG / canonical / robots
│   └── broken-links.spec.js  ← link probes
├── utils/
│   ├── helpers.js            ← waits, overflow detector, link collectors
│   └── discovery.js          ← sitemap.xml + homepage crawler
├── ONBOARDING.md             ← this file
└── README.md                 ← reference
```

---

## 8. What "all good" looks like

Run `npm run check`. You should see:

- All ✓ in green
- Zero ✗ in red
- (Yellow `!` warnings are OK — typically about optional things like `.env`.)

Then in the dashboard, run **Site audit** on one of your sites. A healthy
site looks like:

- ~5–30 pages crawled (depends on the sitemap)
- A small handful of low-severity findings (e.g. *missing og:image*,
  *meta description too long*, etc.)
- No Critical / High severity findings (broken links, missing titles,
  HTTP errors)

If you see a lot of Critical / High findings — the audit is doing its job;
those are real issues to triage.

---

## 9. Where things came from

This is not a real "framework", it's a thin wrapper around three industry tools:

- **Playwright** — drives the browsers and runs all the spec-style tests
- **axe-core** — accessibility scanning
- **Lighthouse** — performance / Web Vitals

The audit script and the dashboard are bespoke glue around them.
