// @ts-check
/**
 * One-command setup for a fresh teammate machine.
 *
 *   npm run setup
 *
 * What it does:
 *   1. Checks Node version (>=18 required for Playwright 1.48+).
 *   2. Installs npm dependencies if node_modules is missing.
 *   3. Installs Playwright browser binaries (chromium / firefox / webkit).
 *   4. Bootstraps .env from .env.example if .env doesn't exist yet —
 *      generates a random strong default password so the dashboard is
 *      password-protected out of the box (the user can change it later).
 *   5. Prints next-step instructions (which command to run, what to open).
 *
 * Designed to be safe to re-run: every step is idempotent. If npm install or
 * playwright install already happened, the steps skip themselves quickly.
 */

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;

function step(n, total, label) {
  console.log(`\n${cyan(`[${n}/${total}]`)} ${bold(label)}`);
}

function ok(msg) { console.log(`  ${green('✓')} ${msg}`); }
function info(msg) { console.log(`  ${dim('·')} ${dim(msg)}`); }
function warn(msg) { console.log(`  ${yellow('!')} ${msg}`); }

function fail(msg) {
  console.error(`\n  \x1b[31m×\x1b[0m ${msg}\n`);
  process.exit(1);
}

// ── 1. Node version ─────────────────────────────────────────────────────
function checkNode() {
  step(1, 4, 'Node.js version check');
  const v = process.versions.node;
  const major = Number(v.split('.')[0]);
  if (major < 18) {
    fail(`Node ${v} is too old — TFWefloLab needs Node 18 or newer. Install from https://nodejs.org/`);
  }
  ok(`Node v${v}`);
}

// ── 2. npm install ──────────────────────────────────────────────────────
function ensureNodeModules() {
  step(2, 4, 'npm dependencies');
  const nm = path.join(ROOT, 'node_modules');
  if (fs.existsSync(nm) && fs.existsSync(path.join(nm, '@playwright'))) {
    ok('node_modules already populated — skipping npm install');
    return;
  }
  info('running `npm install` — this may take 1–3 minutes…');
  const r = spawnSync('npm', ['install'], { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) fail('npm install failed — fix the error above and re-run `npm run setup`.');
  ok('npm install complete');
}

// ── 3. Playwright browsers ──────────────────────────────────────────────
function ensureBrowsers() {
  step(3, 4, 'Playwright browser binaries');
  // We don't currently have a clean way to check "are browsers installed?"
  // without invoking Playwright itself. Just run the install — it's a no-op
  // if everything is already present, so it's safe to re-run.
  info('running `npx playwright install chromium firefox webkit` — first time downloads ~600 MB');
  const r = spawnSync(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['playwright', 'install', 'chromium', 'firefox', 'webkit'],
    { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' }
  );
  if (r.status !== 0) {
    warn('playwright install reported a non-zero exit code. The dashboard will still start, but some projects may fail until browsers are installed.');
  } else {
    ok('browser binaries ready');
  }
}

// ── 4. .env bootstrap ───────────────────────────────────────────────────
function ensureEnv() {
  step(4, 4, 'Environment configuration (.env)');
  const envPath = path.join(ROOT, '.env');
  if (fs.existsSync(envPath)) {
    ok('.env already exists — leaving it alone');
    return null;
  }
  const examplePath = path.join(ROOT, '.env.example');
  if (!fs.existsSync(examplePath)) {
    warn('.env.example not found — skipping .env bootstrap');
    return null;
  }
  // Generate a short, human-friendly random password (URL-safe characters,
  // ~12 chars) so the new install is auth-protected by default. The user
  // can change it; we surface it in the final instructions.
  const generatedPass = crypto.randomBytes(9).toString('base64').replace(/[+/=]/g, '').slice(0, 12);
  let body = fs.readFileSync(examplePath, 'utf8');
  // Uncomment the auth lines + inject the generated password.
  body = body
    .replace(/^# TFWEFLOLAB_USER=.*$/m, 'TFWEFLOLAB_USER=tfweflolab')
    .replace(/^# TFWEFLOLAB_PASS=.*$/m, `TFWEFLOLAB_PASS=${generatedPass}`);
  fs.writeFileSync(envPath, body);
  ok(`.env created — random password generated`);
  return { user: 'tfweflolab', pass: generatedPass };
}

// ── Done ────────────────────────────────────────────────────────────────
function summary(creds) {
  console.log(
    '\n' +
    '  ┌────────────────────────────────────────────────────────┐\n' +
    '  │  ' + green('Setup complete!') + '                                      │\n' +
    '  └────────────────────────────────────────────────────────┘\n'
  );
  console.log('  Next steps:');
  console.log(`    1. ${cyan('npm run dashboard')}`);
  console.log(`    2. Open ${cyan('http://localhost:3000')} in your browser.`);
  if (creds) {
    console.log(
      `    3. Log in with:` +
      `\n         user:     ${bold(creds.user)}` +
      `\n         password: ${bold(creds.pass)}` +
      `\n       ${dim('(stored in .env — change TFWEFLOLAB_PASS if you want a different one)')}`
    );
  } else {
    console.log(`    3. Log in with the credentials in your ${cyan('.env')} file (TFWEFLOLAB_USER / TFWEFLOLAB_PASS).`);
    console.log(`       ${dim('If TFWEFLOLAB_PASS is empty, the dashboard runs without auth.')}`);
  }
  console.log(
    `\n  ${dim('Share with teammates: send them the repo + the password above. They run')}` +
    `\n  ${dim('`npm run setup` on their machine and use the SAME password to log in.')}\n`
  );
}

(function main() {
  console.log(`\n${bold(cyan('TFWefloLab — team setup'))}\n`);
  checkNode();
  ensureNodeModules();
  ensureBrowsers();
  const creds = ensureEnv();
  summary(creds);
})();
