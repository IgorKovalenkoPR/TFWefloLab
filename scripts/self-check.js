#!/usr/bin/env node
// @ts-check
/**
 * Self-check — quickly validate that the whole testing setup is healthy.
 *   npm run check
 *
 * Verifies:
 *   1. Node version
 *   2. Required dependencies installed (express, exceljs, @playwright/test, axe, lighthouse, chrome-launcher)
 *   3. Playwright browser binaries available (chromium, firefox, webkit)
 *   4. config/urls.json parses and has at least one site
 *   5. .env loads cleanly (if present)
 *   6. BrowserStack credentials valid (if configured) — REST ping
 *   7. Spec files parse (no syntax errors)
 *   8. Dashboard server can boot and respond on /api/health
 *
 * Exits non-zero on any failed check so it's CI-friendly.
 */

const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const checks = [];
let failures = 0;

function ok(label, detail = '') { console.log(`  \x1b[32m✓\x1b[0m ${label}${detail ? '  ' + detail : ''}`); checks.push({ label, ok: true, detail }); }
function fail(label, detail = '') { console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? '  ' + detail : ''}`); checks.push({ label, ok: false, detail }); failures++; }
function warn(label, detail = '') { console.log(`  \x1b[33m!\x1b[0m ${label}${detail ? '  ' + detail : ''}`); checks.push({ label, ok: 'warn', detail }); }
function header(s) { console.log(`\n\x1b[1m${s}\x1b[0m`); }

// ---------- 1. Node version ----------
header('Environment');
const nodeMaj = Number(process.versions.node.split('.')[0]);
if (nodeMaj >= 18) ok(`Node.js ${process.version}`);
else fail(`Node.js ${process.version}`, 'requires v18+');

// ---------- .env detection ----------
const envPath = path.join(ROOT, '.env');
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf8').split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'));
  ok('.env present', `${lines.length} key(s)`);
  // Side-load into process.env for downstream checks
  for (const l of lines) {
    const m = l.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/i);
    if (m) {
      let val = m[2].trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
      if (process.env[m[1]] === undefined) process.env[m[1]] = val;
    }
  }
} else {
  warn('.env not found', '(optional — only needed for BrowserStack)');
}

// ---------- 2. Dependencies ----------
header('Dependencies');
const requiredDeps = [
  '@playwright/test',
  '@axe-core/playwright',
  'lighthouse',
  'chrome-launcher',
  'express',
  'exceljs',
];
for (const dep of requiredDeps) {
  try {
    require.resolve(dep, { paths: [ROOT] });
    ok(`${dep} installed`);
  } catch {
    fail(`${dep} missing`, `run: npm install`);
  }
}

// ---------- 3. Playwright browser binaries ----------
header('Playwright browsers');
try {
  const out = execSync('npx playwright --version', { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  ok('playwright CLI', out);
} catch (e) {
  fail('playwright CLI not callable', String(e.message || e).split('\n')[0]);
}
// We can't easily verify browser binaries without launching one. Warn the user
// to run `npm run install:browsers` if they haven't already.
const cacheGuess = process.env.PLAYWRIGHT_BROWSERS_PATH ||
  (process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA || '', 'ms-playwright')
    : process.platform === 'darwin' ? path.join(process.env.HOME || '', 'Library/Caches/ms-playwright')
    : path.join(process.env.HOME || '', '.cache/ms-playwright'));
if (fs.existsSync(cacheGuess) && fs.readdirSync(cacheGuess).length) {
  ok('browser cache present', cacheGuess);
} else {
  warn('browser cache empty or missing', 'run: npm run install:browsers');
}

// ---------- 4. Configs parse ----------
header('Configs');
const urlsPath = path.join(ROOT, 'config', 'urls.json');
try {
  const j = JSON.parse(fs.readFileSync(urlsPath, 'utf8'));
  const n = (j.sites || []).filter((s) => s && s.url).length;
  if (n > 0) ok('config/urls.json', `${n} site(s)`);
  else fail('config/urls.json', 'has no sites — open the Sites tab and add URLs');
} catch (e) {
  fail('config/urls.json', `parse error: ${e.message}`);
}

const playwrightCfgs = [
  path.join(ROOT, 'playwright.config.js'),
  path.join(ROOT, 'playwright.browserstack.config.js'),
];
for (const cfg of playwrightCfgs) {
  if (!fs.existsSync(cfg)) { fail(path.basename(cfg), 'not found'); continue; }
  try {
    delete require.cache[require.resolve(cfg)];
    const c = require(cfg);
    const projN = (c.projects || []).length;
    ok(path.basename(cfg), `${projN} project(s)`);
  } catch (e) {
    fail(path.basename(cfg), e.message.split('\n')[0]);
  }
}

// ---------- 5. Spec files parse ----------
header('Test specs');
const specs = fs.readdirSync(path.join(ROOT, 'tests')).filter((f) => f.endsWith('.spec.js'));
for (const f of specs) {
  try {
    execSync(`node --check "${path.join(ROOT, 'tests', f)}"`, { stdio: ['ignore', 'pipe', 'pipe'] });
    ok('tests/' + f);
  } catch (e) {
    fail('tests/' + f, String(e.message || e).split('\n').slice(-3, -1).join(' '));
  }
}

// audit + helpers
for (const rel of ['audit/audit.js', 'audit/render-report.js', 'utils/helpers.js', 'utils/discovery.js', 'lighthouse/audit.js', 'server/server.js']) {
  const full = path.join(ROOT, rel);
  if (!fs.existsSync(full)) { fail(rel, 'missing'); continue; }
  try {
    execSync(`node --check "${full}"`, { stdio: ['ignore', 'pipe', 'pipe'] });
    ok(rel);
  } catch (e) {
    fail(rel, String(e.message || e).split('\n').slice(-3, -1).join(' '));
  }
}

// ---------- 6. BrowserStack creds (optional) ----------
header('BrowserStack');
if (!process.env.BROWSERSTACK_USERNAME || !process.env.BROWSERSTACK_ACCESS_KEY) {
  warn('credentials not set', 'BrowserStack mode disabled (set BROWSERSTACK_USERNAME / BROWSERSTACK_ACCESS_KEY in .env)');
} else {
  await new Promise((resolve) => {
    const https = require('https');
    const auth = Buffer.from(`${process.env.BROWSERSTACK_USERNAME}:${process.env.BROWSERSTACK_ACCESS_KEY}`).toString('base64');
    const req = https.get(
      'https://api.browserstack.com/automate/plan.json',
      { headers: { Authorization: 'Basic ' + auth, 'User-Agent': 'webflow-tests-self-check/1.0' }, timeout: 10_000 },
      (resp) => {
        let body = '';
        resp.on('data', (c) => (body += c));
        resp.on('end', () => {
          if (resp.statusCode === 200) {
            try {
              const plan = JSON.parse(body);
              ok('credentials valid', `user=${process.env.BROWSERSTACK_USERNAME}, parallel=${plan.parallel_sessions_max_allowed}, running=${plan.parallel_sessions_running}`);
            } catch { ok('credentials valid', 'plan info: <unparseable>'); }
          } else if (resp.statusCode === 401 || resp.statusCode === 403) {
            fail('credentials rejected', `HTTP ${resp.statusCode} from BrowserStack`);
          } else {
            warn('plan endpoint returned', `HTTP ${resp.statusCode}`);
          }
          resolve();
        });
      }
    );
    req.on('error', (e) => { warn('connection error', e.message); resolve(); });
    req.on('timeout', () => { req.destroy(); warn('connection timeout', '> 10s'); resolve(); });
  });
}

// ---------- 7. Dashboard server boots ----------
header('Dashboard server');
const port = 3789;
const child = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stderr = '';
child.stderr.on('data', (c) => (stderr += c.toString()));
await new Promise((r) => setTimeout(r, 1500)); // give it a moment
const health = await new Promise((resolve) => {
  const req = http.get(`http://127.0.0.1:${port}/api/health`, { timeout: 5000 }, (resp) => {
    let body = '';
    resp.on('data', (c) => (body += c));
    resp.on('end', () => resolve({ status: resp.statusCode, body }));
  });
  req.on('error', (e) => resolve({ status: 0, error: e.message }));
  req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'timeout' }); });
});
try { child.kill(); } catch {}
if (health.status === 200) {
  ok('boots cleanly + /api/health 200');
} else {
  fail('boot failed', `health=${health.status} ${health.error || ''}; stderr: ${stderr.slice(0, 300)}`);
}

// ---------- Summary ----------
header('Summary');
const total = checks.length;
const passed = checks.filter((c) => c.ok === true).length;
const warned = checks.filter((c) => c.ok === 'warn').length;
console.log(`  ${passed}/${total} passed${warned ? `, ${warned} warning(s)` : ''}${failures ? `, \x1b[31m${failures} failed\x1b[0m` : ''}`);
if (failures) {
  console.log('\nNext steps:');
  for (const c of checks.filter((x) => x.ok === false)) console.log(`  - ${c.label}: ${c.detail}`);
  process.exit(1);
}
console.log('\nAll critical checks passed.\n');
