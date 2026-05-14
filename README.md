# **TF**Weflo**Lab** — Testfort Webflow Laboratory

> A focused, opinionated QA workbench for sites **built on Webflow**.
> Built &amp; maintained by the [TestFort](https://testfort.com/) QA team.

Automated cross-browser, cross-device test suite for Webflow sites with a
**local web dashboard** for non-CLI users. Built on Playwright (Chromium /
WebKit / Firefox), axe-core for accessibility, Lighthouse for performance,
and an optional **BrowserStack** connector for real macOS Safari coverage.

**Why TFWefloLab and not a generic Playwright runner?** Webflow ships a
specific runtime (`webflow.js` → IX2 interactions), a fixed set of CSS class
conventions (`.w-form`, `.w-tabs`, `.w-dropdown`, `.w-slider`, `.w-lightbox`,
`.w-nav-button`, `data-w-id`), an auto-published `sitemap.xml`, and a strong
emphasis on visual design + CMS-driven content. Generic test suites either
miss these or false-positive on them. TFWefloLab is tuned around Webflow's
shape: every test type either targets Webflow's runtime patterns directly
(see `tests/webflow.spec.js`) or is sized for Webflow's typical content
(marketing pages, CMS collections, designer-heavy layouts).

## What gets covered

| Test type                | Spec / script                       | Tooling                |
|--------------------------|--------------------------------------|------------------------|
| **Site audit (crawler)** | `audit/audit.js`                    | Crawler-style report (Screaming Frog–like) |
| Functional smoke         | `tests/functional.spec.js`          | Playwright             |
| Responsive UI/UX         | `tests/responsive.spec.js`          | Playwright (10 viewports) |
| Site exploration         | `tests/exploration.spec.js`         | Playwright (deep interactions) |
| Visual regression        | `tests/visual.spec.js`              | Playwright snapshots   |
| Accessibility (a11y)     | `tests/accessibility.spec.js`       | axe-core (WCAG 2.1 AA) |
| SEO / metadata           | `tests/seo.spec.js`                 | Playwright             |
| Broken links / 404       | `tests/broken-links.spec.js`        | Playwright APIRequest  |
| Performance / CWV        | `lighthouse/audit.js`               | Lighthouse + Chrome    |

**Site audit** (`npm run audit` or the dashboard's "Site audit" test type) is
the closest thing to a Screaming Frog / Netpeak Spider crawl: it visits every
page (sitemap.xml first, falls back to homepage crawl), runs ~20 checks per
page, and produces a single interactive HTML report at
`audit/reports/<run-id>/index.html`. Issues are categorised by severity
(Critical / High / Medium / Low / Info) and category (SEO, Accessibility,
HTTP, Layout, Images, Errors, Security, Content). The report has filterable
issues table, per-page screenshots, sortable columns, and is fully
self-contained (you can email it).

**Site exploration** is the closest thing to a real human poking the site:
full-page scroll with lazy-load verification, mobile hamburger open/close,
hover/click on every desktop dropdown trigger, validation that every
header/footer link returns < 400, that every social-media icon points to a
plausible domain (no localhost / placeholder), that every visible button has
a destination, and that the top-level nav items actually render their
destination pages. For best coverage, expand `config/urls.json` with the
**Sites tab → Discover pages** button (reads the site's `sitemap.xml`).

## Environments

Two configurations are supported:

### 1. Local emulation — `playwright.config.js`

Defaults; runs on your machine.

- Desktop Chrome (Windows 11) — 1920x1080, real Chrome channel
- Desktop Firefox (Windows 11) — 1920x1080
- Desktop Edge (Windows 11) — 1920x1080, real Edge channel
- Desktop Chrome (macOS) — 1440x900
- Desktop Safari (macOS) — 1440x900, WebKit
- Mobile Chrome (Android — Pixel 7)
- Mobile Safari (iPhone 14)
- Mobile Chrome (iOS — iPhone 14)
- Tablet Safari (iPad Pro 11)
- Tablet Chrome (iPad Pro 11)
- Tablet Chrome (Android — Galaxy Tab S4)

`responsive.spec.js` and `visual.spec.js` additionally iterate viewports
320 / 360 / 390 / 414 / 768 / 820 / 1024 / 1280 / 1440 / 1920.

### 2. BrowserStack — real desktop machines (Windows / macOS)

`playwright.browserstack.config.js`

**Important constraint:** BrowserStack's Playwright Web Automate supports
**real desktop machines only** (Windows 10/11, macOS Big Sur — Sonoma, with
Chromium / Firefox / WebKit). **Real mobile devices (iPhone, Pixel, Galaxy)
are not available on Playwright Web Automate** — that's a BrowserStack
product limitation, not ours. (Real mobile is exposed via BS App Automate
for native apps, or via Selenium / Appium — different tools.)

For mobile / tablet web testing, use the **Real Device Emulation** config
(below) instead — it's Chrome-DevTools-grade emulation with real device
descriptors, network throttling, geolocation, video recording, and runs on
your real installed Chrome / Firefox / Edge / Safari.

### 3. Real Device Emulation — `playwright.realdevice.config.js`

The recommended path for mobile / tablet web testing. Equivalent to opening
Chrome DevTools, switching to "Device mode", picking iPhone 14, throttling
to 4G, and clicking around — but automatable, parallelisable, and
CI-friendly.

What it does:
- Real device descriptor (viewport, DPR, touch, mobile UA) from Playwright's
  `devices` registry — same data Chrome DevTools uses
- 4G LTE network throttling (configurable: `THROTTLE=3g`, `lte`, `2g`, `none`)
- Reduced-motion preference + light color scheme (deterministic)
- Geolocation (Kyiv default; override with `GEO_LAT` / `GEO_LON`)
- Permissions (geolocation, clipboard) auto-granted
- Locale + timezone (`uk-UA` / `Europe/Kiev` defaults)
- Video recording of every test
- Real Chrome / Edge / Safari / Firefox channels (not Chromium open-source)

Run: `npm run test:realdevice` (or `:mobile`, `:tablet`).

- BS Chrome (Windows 11)
- BS Firefox (Windows 11)
- BS Edge (Windows 11)
- BS Chrome (macOS Sonoma)
- BS Safari (macOS Sonoma) — **real Safari**
- BS Safari (iPhone 15) — **real device**
- BS Chrome (Pixel 8) — **real device**
- BS Chrome (Galaxy S24) — **real device**
- BS Safari (iPad Pro 12.9 2022) — **real device**
- BS Chrome (Galaxy Tab S9) — **real device**

### Setting BrowserStack credentials — easiest way

The dashboard auto-loads a `.env` file from the project root, so you don't need
to mess with `export` (Linux/Mac) or `$env:` (PowerShell) every time.

1. Copy `.env.example` to `.env`.
2. Fill in your values:

   ```dotenv
   BROWSERSTACK_USERNAME=your_username
   BROWSERSTACK_ACCESS_KEY=your_access_key
   # optional:
   BROWSERSTACK_BUILD=release-2026-05
   BROWSERSTACK_PROJECT=Webflow
   BS_WORKERS=2
   ```

3. Restart `npm run dashboard`. On the **Run** tab pick `Config: BrowserStack`
   — a green banner confirms credentials were loaded; if it's orange, the
   `.env` file wasn't found or one of the keys is missing.

`.env` is already in `.gitignore`, so secrets stay on your machine.

Prefer environment variables instead? Existing `process.env` always wins over
`.env`, so CI secrets continue to work as-is. Examples:

```bash
# bash / zsh
export BROWSERSTACK_USERNAME=...
export BROWSERSTACK_ACCESS_KEY=...
```

```powershell
# Windows PowerShell — set once per shell, then start the dashboard from THAT
# same shell. If you've already started npm run dashboard, stop it first
# (Ctrl+C) and either set the variables or use the .env file.
$env:BROWSERSTACK_USERNAME = "..."
$env:BROWSERSTACK_ACCESS_KEY = "..."
npm run dashboard
```

## Setup

### Easy path — one command (recommended for teammates)

```bash
npm run setup
```

This runs `scripts/team-setup.js`, which:

1. Checks your Node version (≥ 18 required).
2. Runs `npm install` if `node_modules` is missing.
3. Installs Playwright browser binaries (Chromium, WebKit, Firefox).
4. Creates `.env` from `.env.example` with a randomly-generated dashboard
   password (printed at the end of the run — save it).

After it finishes you can immediately run `npm run dashboard` and log in
with the credentials shown.

### Manual path

```bash
# 1. Install all dependencies (incl. Express for the dashboard)
npm install

# 2. Install Playwright browser binaries (Chromium, WebKit, Firefox)
npm run install:browsers

# 3. (Optional) Copy .env.example to .env and edit credentials
cp .env.example .env
# then open .env in your editor and set TFWEFLOLAB_PASS to a real value
```

Make sure Chrome and Edge are installed on the host (the Desktop projects
launch them via the `chrome` / `msedge` channels). On CI you can install
them with `npx playwright install chrome msedge`.

### Sharing with your QA team

The whole tool runs locally on each teammate's machine — there's no central
server to deploy. Each colleague should:

1. **Get the repo** — `git clone` the project (or copy the folder).
2. **Run `npm run setup`** in the project folder.
3. **Note the password** the setup script prints (or replace it in `.env`
   with one the team agreed on — same password for everyone is fine).
4. **Run `npm run dashboard`** and open <http://localhost:3000>.
5. **Log in** with `tfweflolab` / *that password*.

Test runs happen on **the machine where the dashboard is running**, so each
teammate works against their own browsers, their own network, and their own
run history — no contention, no shared state.

If you ever want to expose your dashboard to teammates on the same office
network (so they can watch your runs live), set `TFWEFLOLAB_LAN=1` in your
`.env`. The startup banner will print a `http://<your-IP>:3000` URL you can
share. Keep `TFWEFLOLAB_PASS` set when you do this — it's the only thing
between your dashboard and anyone on the Wi-Fi.

### Share over the internet (remote teammates)

If a teammate is working from home / a different office and needs to reach
**your** running dashboard from anywhere on the internet, run:

```bash
# Terminal 1
npm run dashboard

# Terminal 2 (same machine)
npm run share
```

`npm run share` pre-flights:

* refuses to start if `TFWEFLOLAB_PASS` is empty (won't put an
  unauthenticated dashboard on the public internet);
* refuses to start if the dashboard isn't already running on `PORT`.

Then it boots a public HTTPS tunnel and prints a copy-pasteable URL plus
the login credentials your teammate needs.

Tunnel back-ends, picked automatically in this order:

1. **Cloudflare Tunnel** (`cloudflared tunnel --url …`) — free, no signup
   for quick tunnels. Recommended.
2. **ngrok** — fallback if `cloudflared` isn't installed. Free signup
   required (once per machine).

If neither tool is on `PATH`, the script prints clean install instructions
for Windows / macOS / Linux and exits. Close the tunnel with `Ctrl+C` in
that terminal — the dashboard keeps running.

#### Forcing a specific tunnel back-end

If corporate firewall blocks `cloudflared` (`api.trycloudflare.com` is on
many block-lists), or you simply want a different one, force it:

```bash
npm run share -- --tool=localtunnel    # *.loca.lt — no signup, no binary, npx-launched
npm run share -- --tool=ngrok          # *.ngrok.io / *.ngrok-free.app
npm run share -- --tool=cloudflared    # *.trycloudflare.com (default when installed)
```

`localtunnel` is the "blocked-by-corporate-firewall escape hatch" — it
runs via `npx` (no install) and uses different infra than Cloudflare /
ngrok, so it often passes when the other two are blocked. Heads-up:
visitors see a one-time `loca.lt` warning page where they're asked to
enter the host machine's public IP (shown on that same page).

#### Stable URL across restarts

By default every `npm run share` produces a new random subdomain. Pass
`--subdomain=NAME` to request a stable one:

```bash
npm run share -- --tool=localtunnel --subdomain=tfweflolab
# → https://tfweflolab.loca.lt  (stays the same across restarts)
```

Support per back-end:

* **localtunnel** — best-effort free. If your chosen subdomain is taken
  by someone else, falls back to random.
* **ngrok** — requires a paid plan; free ngrok will reject custom
  subdomains.
* **cloudflare quick-tunnels** — unsupported. The flag is ignored with a
  warning. For a stable `*.example.com` URL you'd need a named tunnel +
  Cloudflare account + DNS configuration (out of scope here).

Subdomain rules: 1–63 chars, lowercase letters / digits / hyphens, no
leading or trailing hyphen.

## The dashboard 🎛️

```bash
npm run dashboard
# → open http://localhost:3000
```

What it gives you:

- **Run tab** — pick which sites + test types + browser/device projects to
  run, switch between *Local* and *BrowserStack* configs, hit **Run tests**,
  and watch the live log stream in. After each run a summary appears with
  pass/fail counts and a button that opens the Playwright HTML report inline.
  *(The site list on this tab is a selector — checkboxes only. To **add** or
  **edit** URLs use the Sites tab.)*
- **Sites tab** — this is where you actually **enter** the URLs you want
  tested. Each row has Name, URL, optional "title contains" and optional
  smoke selectors. Click `+ add row`, fill it in, press **Save** — the
  changes are written to `config/urls.json` and immediately appear in the
  Run tab's site list.
- **Reports tab** — the most recent Playwright report and every Lighthouse
  HTML report rendered in an iframe.
- **History tab** — last 50 runs with "view log" replay.

After a run finishes, the summary panel exposes **download buttons**:
**↓ CSV**, **↓ XLSX** (Summary + Failures sheets via exceljs), **↓ PDF**
(opens a print-friendly view — Ctrl+P / Cmd+P → "Save as PDF").

The dashboard is just a thin wrapper around the same `playwright test` and
`node lighthouse/audit.js` commands, so anything you can do from the CLI works
from the dashboard too.

### Watching tests run visually

There are two distinct cases — they behave differently and the dashboard
makes the difference explicit:

- **Local (emulation)** — turn on the **Headed (show browser)** option on the
  Run tab. Playwright launches a real browser window on your computer and you
  see every click and navigation as it happens. (Slower than headless, but
  great for debugging.)
- **BrowserStack (real devices)** — the *Headed* option is automatically
  disabled because there is nothing local to show: the browser opens on a
  BrowserStack cloud machine (real macOS Safari, real iPhone, real Pixel,
  etc.). To watch it live or replay it afterwards, use the
  [BrowserStack Live dashboard](https://automate.browserstack.com/dashboard/v2)
  — every session has a built-in video recording, console logs, network logs,
  and visual step-by-step logs (we enable all of those by default in
  `browserstack/connector.js`).

## Configure URLs

Either via the **Sites tab** of the dashboard, or directly in
`config/urls.json`:

```json
{
  "sites": [
    {
      "name": "Marketing Home",
      "url": "https://yourdomain.webflow.io/",
      "smokeSelectors": ["nav.w-nav", "footer"],
      "expectedTitleIncludes": "Acme"
    },
    {
      "name": "Pricing",
      "url": "https://yourdomain.webflow.io/pricing"
    }
  ]
}
```

`smokeSelectors` and `expectedTitleIncludes` are optional. Each entry runs in
every project.

## CLI cheat-sheet

```bash
# Local
npm test                            # all tests × all local projects
npm run test:functional             # one spec
npm run test:responsive
npm run test:visual                 # compare to baselines
npm run test:visual:update          # create/refresh baselines
npm run test:a11y
npm run test:seo
npm run test:links
npm run test:desktop                # only desktop browsers
npm run test:mobile
npm run test:tablet
npm run test:performance            # Lighthouse: desktop + mobile, all sites
npm run test:headed
npm run test:ui                     # Playwright's UI mode
npm run report                      # open last HTML report

# BrowserStack
npm run test:bs                     # everything
npm run test:bs:desktop
npm run test:bs:mobile
npm run test:bs:tablet
```

### Visual baselines

Snapshot files are stored at
`tests/__screenshots__/<spec>/<file>.spec.js/<name>-<projectName>.png`
(or `…-bs.png` for BrowserStack). Commit them so CI has a baseline. Re-run
with `--update-snapshots` whenever you intentionally change UI.

### Lighthouse thresholds

`lighthouse/audit.js` defaults:

| Score             | Min |
|-------------------|----:|
| performance       |  70 |
| accessibility     |  90 |
| best-practices    |  85 |
| seo               |  90 |

Plus Core Web Vitals budgets: LCP ≤ 2500 ms, CLS ≤ 0.1, TBT ≤ 200 ms,
FCP ≤ 1800 ms.

Override with env vars: `LH_MIN_PERF=80 npm run test:performance`.

HTML + JSON reports go into `lighthouse/reports/`.

## CI tips

- Set `CI=true` to enable retries and run with 2 workers.
- Cache `~/.cache/ms-playwright` to skip browser re-downloads.
- Run Lighthouse in a separate CI job (it spins up its own Chrome).
- For BrowserStack runs in CI, store `BROWSERSTACK_USERNAME` /
  `BROWSERSTACK_ACCESS_KEY` as secrets and let `BROWSERSTACK_BUILD` default
  to today's date or override with the build number.

## Project layout

```
.
├── browserstack/
│   └── connector.js              # builds BS wsEndpoint URL
├── config/urls.json              # sites under test
├── lighthouse/audit.js           # performance runner
├── playwright.config.js          # local browsers / devices
├── playwright.browserstack.config.js   # real devices via BrowserStack
├── server/
│   ├── server.js                 # Express dashboard backend (SSE)
│   └── public/                   # dashboard HTML/CSS/JS
├── tests/
│   ├── functional.spec.js
│   ├── responsive.spec.js
│   ├── visual.spec.js
│   ├── accessibility.spec.js
│   ├── seo.spec.js
│   └── broken-links.spec.js
├── utils/helpers.js
├── package.json
└── README.md
```
