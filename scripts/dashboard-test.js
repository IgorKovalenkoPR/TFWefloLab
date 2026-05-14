#!/usr/bin/env node
// @ts-check
/**
 * Dashboard E2E smoke test — boots the dashboard server in-process, hits every
 * REST endpoint, asserts response shapes, and tears down. Fast (~5s) and
 * deterministic; no Playwright browsers needed.
 *
 *   npm run test:dashboard
 *
 * Use this whenever you change anything in `server/server.js` to make sure
 * you didn't regress the API surface.
 */
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PORT = 3987;

let pass = 0;
let fail = 0;
const failures = [];

function ok(label) { console.log(`  \x1b[32m✓\x1b[0m ${label}`); pass++; }
function bad(label, why) {
  console.log(`  \x1b[31m✗\x1b[0m ${label}\n      ${why}`);
  failures.push({ label, why });
  fail++;
}
function header(s) { console.log(`\n\x1b[1m${s}\x1b[0m`); }

function req(method, path, body = null) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(
      { method, hostname: '127.0.0.1', port: PORT, path, timeout: 10_000,
        headers: { Accept: 'application/json', ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) } },
      (resp) => {
        let buf = '';
        resp.on('data', (c) => (buf += c));
        resp.on('end', () => {
          let json = null;
          try { json = JSON.parse(buf); } catch {}
          resolve({ status: resp.statusCode, headers: resp.headers, body: buf, json });
        });
      }
    );
    r.on('error', (e) => resolve({ status: 0, error: e.message }));
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, error: 'timeout' }); });
    if (data) r.write(data);
    r.end();
  });
}

async function main() {
  console.log('\x1b[1mDashboard E2E smoke test\x1b[0m');
  console.log(`  Booting server on http://127.0.0.1:${PORT}…`);

  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (c) => (stderr += c.toString()));
  child.stdout.on('data', () => {}); // discard

  // Wait for /api/health to start responding.
  let booted = false;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 200));
    const h = await req('GET', '/api/health');
    if (h.status === 200) { booted = true; break; }
  }
  if (!booted) {
    bad('server did not boot in 6s', stderr.slice(0, 500));
    try { child.kill(); } catch {}
    process.exit(1);
  }
  ok('server booted on PORT ' + PORT);

  try {
    // ----- Health -----
    header('Health');
    {
      const r = await req('GET', '/api/health');
      if (r.json?.ok === true) ok('GET /api/health returns { ok:true }');
      else bad('GET /api/health', JSON.stringify(r.json || r.body).slice(0, 120));
    }

    // ----- Test types -----
    header('Test types');
    {
      const r = await req('GET', '/api/test-types');
      if (Array.isArray(r.json) && r.json.length >= 8) ok(`GET /api/test-types — ${r.json.length} entries`);
      else bad('GET /api/test-types', `expected array of >= 8, got ${JSON.stringify(r.json).slice(0,80)}`);
      const ids = (r.json || []).map((t) => t.id);
      const must = ['audit', 'functional', 'responsive', 'exploration', 'webflow', 'visual', 'a11y', 'seo', 'links', 'performance'];
      for (const m of must) {
        if (ids.includes(m)) ok(`  has type: ${m}`);
        else bad(`  missing type: ${m}`, `available: ${ids.join(', ')}`);
      }
    }

    // ----- Projects (3 configs) -----
    header('Projects per config');
    for (const cfg of ['local', 'realdevice', 'browserstack']) {
      const r = await req('GET', `/api/projects?config=${cfg}`);
      if (r.json?.available && Array.isArray(r.json.projects) && r.json.projects.length > 0) {
        ok(`config="${cfg}" — ${r.json.projects.length} projects`);
      } else {
        bad(`config="${cfg}"`, `expected projects[], got ${JSON.stringify(r.json).slice(0, 200)}`);
      }
    }

    // ----- Sites CRUD -----
    header('Sites CRUD');
    {
      const r = await req('GET', '/api/sites');
      if (Array.isArray(r.json)) ok(`GET /api/sites — ${r.json.length} configured`);
      else bad('GET /api/sites', JSON.stringify(r.json).slice(0, 120));
    }

    // ----- Reports listing -----
    header('Reports listing');
    {
      const r = await req('GET', '/api/reports');
      if (r.json && 'playwright' in r.json && Array.isArray(r.json.lighthouse) && Array.isArray(r.json.audit)) {
        ok('GET /api/reports — has playwright/lighthouse/audit keys');
      } else {
        bad('GET /api/reports', JSON.stringify(r.json).slice(0, 200));
      }
    }

    // ----- env-status -----
    header('Env status');
    {
      const r = await req('GET', '/api/env-status');
      if (r.json && 'browserstack' in r.json) {
        ok(`GET /api/env-status — envFileLoaded=${r.json.envFileLoaded}, BS user=${r.json.browserstack.hasUsername}, key=${r.json.browserstack.hasAccessKey}`);
      } else {
        bad('GET /api/env-status', JSON.stringify(r.json).slice(0, 120));
      }
    }

    // ----- BrowserStack endpoints (only if creds present) -----
    header('BrowserStack endpoints');
    {
      const e = await req('GET', '/api/env-status');
      if (e.json?.browserstack?.hasUsername && e.json?.browserstack?.hasAccessKey) {
        const r = await req('GET', '/api/browserstack/check');
        if (r.json && (r.json.ok === true || r.json.ok === false)) {
          ok(`GET /api/browserstack/check — ok=${r.json.ok}${r.json.username ? ` user=${r.json.username}` : ''}`);
        } else {
          bad('GET /api/browserstack/check', JSON.stringify(r.json).slice(0, 200));
        }
        // Skip /connect-test (it actually consumes a parallel slot, ~30s)
        ok('  /connect-test not exercised (would burn 1 BS parallel session)');
      } else {
        ok('SKIP — no BS creds in env (set them in .env to enable these checks)');
      }
    }

    // ----- Run kickoff API (smoke — schedules an "audit" run with no sites
    //     so it errors cleanly, proving the request path works.) -----
    header('Run kickoff API');
    {
      const r = await req('POST', '/api/runs', { testIds: [] });
      if (r.status === 400) ok('POST /api/runs with testIds:[] correctly returns 400');
      else bad('POST /api/runs', `expected 400, got ${r.status}: ${JSON.stringify(r.json).slice(0, 120)}`);
    }
    {
      const r = await req('GET', '/api/runs');
      if (Array.isArray(r.json)) ok(`GET /api/runs — ${r.json.length} historical run(s)`);
      else bad('GET /api/runs', JSON.stringify(r.json).slice(0, 120));
    }

    // ----- Static assets -----
    header('Static assets');
    {
      const r = await req('GET', '/');
      if (r.status === 200 && r.body.includes('Webflow Tests')) ok('GET / — index.html served, contains "Webflow Tests"');
      else bad('GET /', `status=${r.status}, body[0..80]=${r.body.slice(0,80)}`);
    }
    {
      const r = await req('GET', '/style.css');
      if (r.status === 200 && r.body.length > 100) ok(`GET /style.css — ${r.body.length} bytes`);
      else bad('GET /style.css', `status=${r.status}`);
    }
    {
      const r = await req('GET', '/app.js');
      if (r.status === 200 && r.body.length > 100) ok(`GET /app.js — ${r.body.length} bytes`);
      else bad('GET /app.js', `status=${r.status}`);
    }

    // ----- Run summary endpoint ----
    header('Run snapshot for unknown id');
    {
      const r = await req('GET', '/api/runs/nonexistent_run_id');
      if (r.status === 404) ok('GET /api/runs/<bad> returns 404');
      else bad('GET /api/runs/<bad>', `expected 404, got ${r.status}`);
    }

    // ----- Export endpoint with no run ----
    header('Export endpoint');
    {
      const r = await req('GET', '/api/runs/nonexistent/export?format=csv');
      if (r.status === 404) ok('GET /api/runs/<bad>/export returns 404');
      else bad('GET /api/runs/<bad>/export', `expected 404, got ${r.status}`);
    }
  } catch (e) {
    bad('runner crashed', e.message);
  }

  // Cleanup
  try { child.kill(); } catch {}
  await new Promise((r) => setTimeout(r, 200));

  // Summary
  console.log(`\n\x1b[1mResult:\x1b[0m ${pass} passed, ${fail} failed.`);
  if (fail) {
    console.log('\nFailures:');
    failures.forEach((f) => console.log(`  - ${f.label}: ${f.why}`));
    process.exit(1);
  }
  console.log('All dashboard endpoints behave as expected.\n');
}

main().catch((e) => { console.error(e); process.exit(1); });
