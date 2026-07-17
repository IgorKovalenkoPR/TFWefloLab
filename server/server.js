// @ts-check
/**
 * Local dashboard for the Webflow Sites Testing suite.
 *
 *   npm run dashboard   →   open http://localhost:3000
 *
 * Capabilities:
 *   - Lists sites from config/urls.json (and lets you add/remove inline)
 *   - Lists Playwright projects discovered from playwright.config.js
 *   - Runs any combination of test types × sites × projects
 *   - Streams live stdout / stderr to the browser via Server-Sent Events
 *   - Embeds the Playwright HTML report and Lighthouse reports inline
 *   - Shows a per-run pass/fail summary parsed from Playwright's JSON reporter
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 3000);
const URLS_PATH = path.join(ROOT, 'config', 'urls.json');
const ENV_PATH = path.join(ROOT, '.env');
const PW_REPORT_DIR = path.join(ROOT, 'playwright-report');
const PW_RESULTS = path.join(ROOT, 'test-results', 'results.json');
const LH_DIR = path.join(ROOT, 'lighthouse', 'reports');

/**
 * Load `.env` (KEY=VALUE per line) from the project root if it exists, so
 * users don't have to fiddle with `export` / `$env:` for BrowserStack creds.
 * Existing process env wins, so CI overrides still work.
 */
function loadEnvFile() {
  if (!fs.existsSync(ENV_PATH)) return { loaded: false, keys: [] };
  const lines = fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/);
  const keys = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/i);
    if (!m) continue;
    let [, key, val] = m;
    val = val.trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined || process.env[key] === '') {
      process.env[key] = val;
    }
    keys.push(key);
  }
  return { loaded: true, keys };
}
const ENV_FILE_STATUS = loadEnvFile();
if (ENV_FILE_STATUS.loaded) {
  // eslint-disable-next-line no-console
  console.log(`  Loaded .env (${ENV_FILE_STATUS.keys.length} key${ENV_FILE_STATUS.keys.length === 1 ? '' : 's'})`);
}

// ---- Project list (single source of truth lives in playwright.config.js) ----
function loadProjectNames(configFile) {
  // Require the actual config so the dashboard list is always in sync.
  delete require.cache[require.resolve(configFile)];
  const cfg = require(configFile);
  const projects = (cfg.projects || cfg.default?.projects || []).map((p) => p.name);
  return projects;
}

// Eight focused test types, each with a non-overlapping purpose. Earlier
// suites (functional, responsive, exploration, tablet-bugs) were entirely
// covered by the QA walkthrough and have been retired.
const TEST_TYPES = [
  { id: 'walkthrough', label: '★ QA walkthrough (recommended — full user-flow per device)', spec: 'tests/walkthrough.spec.js' },
  { id: 'audit',       label: 'Site audit (whole-site crawler report)',                     spec: null /* uses audit/audit.js */ },
  { id: 'webflow',     label: 'Webflow components (.w-tabs / .w-slider / .w-lightbox / IX2)', spec: 'tests/webflow.spec.js' },
  { id: 'visual',      label: 'Visual regression (pixel diff vs baselines)',                spec: 'tests/visual.spec.js' },
  { id: 'a11y',        label: 'Accessibility (axe-core WCAG 2.1 AA)',                       spec: 'tests/accessibility.spec.js' },
  { id: 'seo',         label: 'SEO / metadata depth (title, OG, canonical, sitemap)',       spec: 'tests/seo.spec.js' },
  { id: 'links',       label: 'Broken links (HEAD probe every link on a page)',             spec: 'tests/broken-links.spec.js' },
  { id: 'performance', label: 'Performance / Web Vitals (Lighthouse)',                      spec: null /* uses lighthouse/audit.js */ },
];

// ---- In-memory run registry ----
/** @type {Map<string, {id:string, status:string, started:number, ended:number|null, args:string[], log:string[], summary:any|null, type:'playwright'|'lighthouse'}>} */
const runs = new Map();

/** @type {Map<string, Set<express.Response>>} */
const subscribers = new Map();

function publish(runId, event) {
  const subs = subscribers.get(runId);
  if (!subs) return;
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of subs) {
    try { res.write(payload); } catch { /* client gone */ }
  }
}

function ensureDirs() {
  fs.mkdirSync(path.dirname(PW_RESULTS), { recursive: true });
  fs.mkdirSync(LH_DIR, { recursive: true });
}

function readSites() {
  try {
    const raw = fs.readFileSync(URLS_PATH, 'utf8');
    const j = JSON.parse(raw);
    return Array.isArray(j.sites) ? j.sites : [];
  } catch {
    return [];
  }
}

function writeSites(sites) {
  const existing = (() => {
    try { return JSON.parse(fs.readFileSync(URLS_PATH, 'utf8')); } catch { return {}; }
  })();
  const next = { ...existing, sites };
  fs.writeFileSync(URLS_PATH, JSON.stringify(next, null, 2) + '\n');
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---- Build the Playwright command for a run ----
function buildPlaywrightArgs({ testIds, projects, sites, configFile, headed, updateSnapshots }) {
  const args = ['playwright', 'test'];
  if (configFile) args.push('--config', configFile);

  const specs = testIds
    .filter((id) => id !== 'performance')
    .map((id) => TEST_TYPES.find((t) => t.id === id)?.spec)
    .filter(Boolean);
  args.push(...specs);

  // Pass through ALL selected projects. With `--workers=1` (set below when
  // headed=true), Playwright already serialises them — browser windows open
  // ONE AT A TIME, sequentially, so the user can watch the run device-by-
  // device without overlap. An earlier version of this code trimmed the
  // project list to a single entry, but that was over-restrictive and
  // silently dropped 5-of-6 user-selected devices.
  const effectiveProjects = projects || [];
  const trimmedNote =
    headed && effectiveProjects.length > 1
      ? `[dashboard] Headed mode with ${effectiveProjects.length} devices → browsers will open sequentially, ` +
        `one at a time (workers=1). Estimated wall time: ~${Math.ceil(effectiveProjects.length * 3.5)} min for the walkthrough spec.`
      : null;
  for (const proj of effectiveProjects) args.push('--project', proj);

  if (sites && sites.length) {
    const siteNames = sites.map((n) => escapeRegex(`@${n}`)).join('|');
    args.push('--grep', siteNames);
  }

  if (headed) {
    args.push('--headed');
    // Single worker = tests within a project execute sequentially inside ONE
    // browser process (Playwright reuses the browser launch for the worker).
    args.push('--workers=1');
  }
  if (updateSnapshots) args.push('--update-snapshots');

  // Surface the trim notice via a side-channel that spawnRun can pick up.
  return { args, trimmedNote };
}

/**
 * Quote a single argument for cmd.exe so spaces / parentheses / quotes survive
 * the shell parse. Project names like `BS Chrome (Windows 11)` would otherwise
 * be split into multiple tokens by cmd.exe.
 */
function quoteForCmd(arg) {
  const s = String(arg);
  if (!/[\s"&|<>^()`,;%!]/.test(s)) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

function spawnRun(runId, command, args, env = {}) {
  const baseOpts = {
    cwd: ROOT,
    env: { ...process.env, ...env, FORCE_COLOR: '0' },
  };

  let child;
  if (process.platform === 'win32') {
    // On Windows we have to use `shell: true` because `npx` is `npx.cmd`
    // (Node's spawn refuses to run .bat/.cmd files without a shell since
    // CVE-2024-27980). When shell:true, Node passes args verbatim to cmd.exe
    // without quoting, so we must quote EVERY token ourselves — including the
    // command itself. `process.execPath` is e.g. `C:\Program Files\nodejs\node.exe`
    // and cmd.exe would otherwise split it at the space.
    const cmdline = [quoteForCmd(command), ...args.map(quoteForCmd)].join(' ');
    child = spawn(cmdline, { ...baseOpts, shell: true, windowsHide: true });
  } else {
    child = spawn(command, args, baseOpts);
  }

  const run = runs.get(runId);
  run.pid = child.pid;
  // Reset progress for this run.
  run.progress = { total: null, done: 0, passed: 0, failed: 0, skipped: 0, startedAt: Date.now() };
  publish(runId, { type: 'start', cmd: [command, ...args].join(' ') });

  // Throttle progress publishes so we don't flood the SSE.
  let lastProgressPub = 0;
  function maybePublishProgress(force) {
    const now = Date.now();
    if (!force && now - lastProgressPub < 250) return;
    lastProgressPub = now;
    publish(runId, { type: 'progress', progress: run.progress });
  }

  // Parse Playwright list-reporter output line-by-line.
  // We recognise:
  //   - "Running 192 tests using 1 worker"
  //   - "  ✓  1 [Project] › file:line:col › suite › test (1.2s)"
  //   - "  ✘  2 [Project] › ..."   (failed)
  //   - "  -  3 [Project] › ..."   (skipped)
  //   - "  x  4 [Project] › ..."   (alt failed)
  // Plus the audit script's own progress lines: "[audit] (12/45) https://…"
  let stdoutBuf = '';
  function consumeProgress(text) {
    stdoutBuf += text;
    let nl;
    while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
      const line = stdoutBuf.slice(0, nl);
      stdoutBuf = stdoutBuf.slice(nl + 1);

      // Total tests (first reporter line)
      const m1 = line.match(/Running\s+(\d+)\s+tests?\b/i);
      if (m1) {
        run.progress.total = Number(m1[1]);
        maybePublishProgress(true);
        continue;
      }
      // Per-test result line. Symbols: ✓ (pass) ✘/×/x (fail) - (skip).
      const m2 = line.match(/^\s*([✓✗✘×x\-])\s+\d+\s+\[/);
      if (m2) {
        run.progress.done++;
        const sym = m2[1];
        if (sym === '✓') run.progress.passed++;          // ✓
        else if (sym === '-') run.progress.skipped++;
        else run.progress.failed++;                          // ✘ × x
        maybePublishProgress();
        continue;
      }
      // Audit script progress: "[audit] (12/45) https://…"
      const m3 = line.match(/\[audit\]\s+\((\d+)\/(\d+)\)/);
      if (m3) {
        run.progress.done = Number(m3[1]);
        run.progress.total = Number(m3[2]);
        maybePublishProgress();
        continue;
      }
    }
  }

  const append = (chunk) => {
    const text = chunk.toString();
    consumeProgress(text);
    run.log.push(text);
    publish(runId, { type: 'log', text });
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);

  child.on('close', (code) => {
    run.ended = Date.now();
    run.status = code === 0 ? 'passed' : 'failed';
    run.exitCode = code;
    // Try to parse Playwright JSON summary
    if (run.type === 'playwright') {
      try {
        const j = JSON.parse(fs.readFileSync(PW_RESULTS, 'utf8'));
        run.summary = summarizePlaywright(j);
      } catch { /* no summary */ }
    } else if (run.type === 'lighthouse') {
      run.summary = summarizeLighthouse();
    } else if (run.type === 'audit') {
      run.summary = summarizeAudit();
    }
    // Final progress flush
    maybePublishProgress(true);
    publish(runId, { type: 'end', exitCode: code, summary: run.summary });
    // Close any open SSE responses
    const subs = subscribers.get(runId);
    if (subs) for (const r of subs) { try { r.end(); } catch {} }
    subscribers.delete(runId);
  });

  child.on('error', (err) => {
    run.log.push(`[spawn error] ${err.message}\n`);
    publish(runId, { type: 'log', text: `[spawn error] ${err.message}\n` });
  });

  return child;
}

/**
 * Convert an absolute attachment path produced by Playwright into a URL the
 * dashboard can serve via /reports/test-results/.
 */
function attachmentToUrl(absPath) {
  if (!absPath) return null;
  try {
    const trDir = path.join(ROOT, 'test-results');
    const rel = path.relative(trDir, absPath);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return '/reports/test-results/' + rel.split(path.sep).join('/');
  } catch {
    return null;
  }
}

/**
 * Filter out empty / broken video attachments. Playwright sometimes writes a
 * 0-byte .webm or one with no frames (e.g. when the test crashed before any
 * action). Surfacing those to the user as "0:00 / 0:00" players is noise.
 * Heuristic: any video file under 8 KB is almost certainly empty.
 */
function isUsableAttachment(attachment, absPath) {
  if (!attachment.contentType || !attachment.contentType.startsWith('video/')) return true;
  if (!absPath) return true;
  try {
    const st = fs.statSync(absPath);
    return st.size >= 8192; // 8 KB minimum for a real recording
  } catch {
    return false;
  }
}

/**
 * Some specs (notably tests/walkthrough.spec.js) attach `findings.json` — a
 * structured list of issues observed during a single end-to-end user-flow
 * walkthrough. If we find one, parse it and surface the findings on the
 * passing record so the dashboard can render them like a real QA report.
 */
function tryParseFindings(attachments) {
  // Playwright attaches files in two shapes:
  //   1. { name, contentType, path }           — when body is large (file on disk)
  //   2. { name, contentType, body: <Buffer> } — when body is small (inlined)
  // We need to handle BOTH to be reliable. Previously we only handled #1 and
  // the parser returned null for inlined attachments, so the Bugs tab vanished.
  const candidates = (attachments || []).filter((a) => a && a.name === 'findings.json');
  for (const a of candidates) {
    let json = null;
    if (a.path) {
      try { json = JSON.parse(fs.readFileSync(a.path, 'utf8')); } catch {}
    }
    if (!json && a.body) {
      try {
        const buf =
          typeof a.body === 'string'
            ? Buffer.from(a.body, 'base64')
            : Buffer.isBuffer(a.body) ? a.body : Buffer.from(a.body);
        json = JSON.parse(buf.toString('utf8'));
      } catch {}
    }
    if (!json || !Array.isArray(json.findings)) continue;

    // Build name → URL map so each finding gets its annotated screenshot.
    const byName = new Map();
    for (const att of attachments || []) {
      if (!att.name) continue;
      const url = att.path ? attachmentToUrl(att.path) : null;
      if (url) byName.set(att.name, { url, contentType: att.contentType || '' });
    }
    json.findingsFileUrl = a.path ? attachmentToUrl(a.path) : null;
    for (const fnd of json.findings) {
      if (fnd.screenshotName && byName.has(fnd.screenshotName)) {
        fnd.screenshotUrl = byName.get(fnd.screenshotName).url;
      }
    }
    return json;
  }
  return null;
}

function summarizePlaywright(json) {
  // Playwright JSON reporter shape: { suites: [...] }; we count outcomes recursively.
  let total = 0, passed = 0, failed = 0, skipped = 0, flaky = 0;
  const failures = [];
  const passes = []; // collected so we can ALSO show "what worked" in the UI
  const walkthroughs = []; // findings.json attached by walkthrough.spec.js
  const walk = (s) => {
    for (const sp of s.specs || []) {
      for (const t of sp.tests || []) {
        total++;
        const last = t.results?.[t.results.length - 1];
        const status = last?.status || 'skipped';
        // Whatever the outcome, harvest findings.json (walkthrough spec).
        const wt = tryParseFindings(last && last.attachments);
        if (wt) {
          walkthroughs.push({
            title: sp.title,
            project: t.projectName || '',
            file: sp.file,
            status,
            duration: (last && last.duration) || 0,
            totals: { total: wt.total, bySeverity: wt.bySeverity, byArea: wt.byArea },
            findings: wt.findings,
            findingsFileUrl: wt.findingsFileUrl,
            attachments: ((last && last.attachments) || [])
              .filter((a) => isUsableAttachment(a, a.path))
              .map((a) => ({
                name: a.name || '', contentType: a.contentType || '', url: attachmentToUrl(a.path),
              }))
              .filter((a) => a.url),
          });
        }

        if (status === 'passed') {
          passed++;
          if ((t.results || []).length > 1) flaky++;
          // Collect a tiny record of every pass — video + screenshot + URL —
          // so the Reports tab can show "here's what worked" even when there
          // are no failures (otherwise the failure list is empty and the user
          // thinks nothing happened).
          const attachments = ((last && last.attachments) || [])
            .map((a) => ({
              name: a.name || '',
              contentType: a.contentType || '',
              url: attachmentToUrl(a.path),
            }))
            .filter((a) => a.url);
          passes.push({
            title: sp.title,
            file: sp.file,
            project: t.projectName || '',
            duration: (last && last.duration) || 0,
            attachments,
          });
        } else if (status === 'failed' || status === 'timedOut' || status === 'interrupted') {
          failed++;
          // Pull every attachment Playwright recorded — screenshots,
          // expected/actual/diff for visual regression, traces, videos.
          // Skip 0-byte / sub-8KB videos: Playwright sometimes writes those
          // when a test crashed before any frame was captured, and surfacing
          // them as "0:00 / 0:00" players is just noise.
          const attachments = ((last && last.attachments) || [])
            .filter((a) => isUsableAttachment(a, a.path))
            .map((a) => ({
              name: a.name || '',
              contentType: a.contentType || '',
              url: attachmentToUrl(a.path),
            }))
            .filter((a) => a.url);

          const errMsg = (last && last.error && last.error.message) || '';
          // Strip ANSI colour codes Playwright sometimes embeds.
          const clean = errMsg.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '');

          // Pull the page URL out of the page-context.txt attachment (added by
          // afterEach hooks) so the failure card can show "Page: …" directly.
          let pageUrl = null;
          let viewport = null;
          const ctxAttach = ((last && last.attachments) || []).find((a) => a.name === 'page-context.txt' && a.path);
          if (ctxAttach) {
            try {
              const txt = fs.readFileSync(ctxAttach.path, 'utf8');
              const um = txt.match(/^URL:\s*(\S+)/m);
              const vm = txt.match(/^Viewport:\s*(\S+)/m);
              if (um) pageUrl = um[1].trim();
              if (vm) viewport = vm[1].trim();
            } catch {}
          }

          // Try to identify which assertion / locator failed. Playwright
          // typically embeds these patterns in the error message.
          let failingStep = null;
          let failingLocator = null;
          const stepM =
            clean.match(/Test timeout of [\d.]+\w+ exceeded\s*(?:while running\s*"([^"]+)")?/i) ||
            clean.match(/Error:\s*([^\n]{1,140})/i);
          if (stepM) failingStep = (stepM[1] || stepM[0]).trim().slice(0, 200);
          const locM = clean.match(/locator\(['"]([^'"\n]{1,160})['"]\)/i) ||
            clean.match(/getBy\w+\(['"]([^'"\n]{1,160})['"]\)/i);
          if (locM) failingLocator = locM[0];

          // If the test attached findings.json (walkthrough spec), parse it
          // so the failure card can render the structured issue list inline
          // instead of pointing the user at a hidden attachment.
          const parsedFindings = tryParseFindings(last && last.attachments);

          failures.push({
            title: sp.title,
            file: sp.file,
            project: t.projectName || '',
            status,
            duration: (last && last.duration) || 0,
            error: clean.split('\n').slice(0, 6).join('\n'),
            errorFull: clean,
            pageUrl,
            viewport,
            failingStep,
            failingLocator,
            attachments,
            parsedFindings, // null if not a walkthrough test
          });
        } else if (status === 'skipped') skipped++;
      }
    }
    for (const sub of s.suites || []) walk(sub);
  };
  for (const s of json.suites || []) walk(s);

  // Group failures by project so the dashboard can render per-browser/-device sections.
  const byProject = {};
  for (const f of failures) {
    (byProject[f.project] = byProject[f.project] || []).push(f);
  }

  // ---- Cross-device deduplication of bugs --------------------------------
  // A single defect (e.g. `<html lang>` missing) shows up once per device
  // because every device runs the same walkthrough. We collapse those into
  // ONE deduplicated bug card with a list of affected devices, so the user
  // sees 6–9 actionable bugs instead of 56 near-identical rows.
  //
  // Fingerprint = severity + area + normalised-message + element-selector.
  // We also keep, per-device, the annotated screenshot URL so a "see this
  // on each device" accordion is possible in the UI.
  const dedupedBugs = (function () {
    const map = new Map();
    function fingerprint(f) {
      // Normalise dynamic numbers in messages so "(3 nodes)" and "(7 nodes)"
      // collapse: same defect, different DOM-traversal counts on each device.
      const msg = String(f.message || '')
        .replace(/\(\d+\s+nodes?\)/gi, '(N nodes)')
        .replace(/\bvisible\s+\d+\s*[→\-]+\s*\d+\b/gi, 'visible N→N')
        .replace(/\d+(\.\d+)?\s*(ms|s|px|%)/g, 'N$2')
        .replace(/\s+/g, ' ')
        .trim();
      return [
        String(f.severity || ''),
        String(f.area || ''),
        msg,
        String(f.element || '').trim(),
      ].join('|');
    }
    // Walk every walkthrough × every finding.
    for (const w of walkthroughs) {
      for (const f of w.findings || []) {
        const key = fingerprint(f);
        if (!map.has(key)) {
          map.set(key, {
            fingerprint: key,
            severity: f.severity,
            area: f.area,
            message: f.message,
            url: f.url,
            element: f.element,
            page: f.page,
            fixHint: f.fixHint,
            snippet: f.snippet,
            // userImpact and devDetail were added so QA / PM readers see a
            // plain-language description of the bug + developers can still
            // expand the raw stack-trace / axe rule details when needed.
            userImpact: f.userImpact,
            devDetail: f.devDetail,
            // Use the FIRST screenshotUrl we see for the headline image.
            screenshotUrl: f.screenshotUrl || null,
            devices: [],
            perDevice: [], // [{device, screenshotUrl}]
          });
        }
        const entry = map.get(key);
        if (!entry.devices.includes(w.project)) entry.devices.push(w.project);
        entry.perDevice.push({ device: w.project, screenshotUrl: f.screenshotUrl || null });
        if (!entry.screenshotUrl && f.screenshotUrl) entry.screenshotUrl = f.screenshotUrl;
      }
    }
    // Sort by severity (Critical first) then by device count (widely-reproduced bugs first).
    const order = { Critical: 0, High: 1, Medium: 2, Low: 3, Info: 4 };
    return Array.from(map.values()).sort((a, b) =>
      (order[a.severity] - order[b.severity]) ||
      (b.devices.length - a.devices.length) ||
      String(a.area).localeCompare(b.area)
    );
  })();

  return { total, passed, failed, skipped, flaky, failures, byProject, passes, walkthroughs, dedupedBugs };
}

function summarizeAudit() {
  // Find the most recent audit/reports/<runId>/audit.json and surface the
  // top-level totals + a link to the interactive HTML report.
  const auditRoot = path.join(ROOT, 'audit', 'reports');
  if (!fs.existsSync(auditRoot)) return null;
  const dirs = fs
    .readdirSync(auditRoot)
    .map((name) => ({ name, time: fs.statSync(path.join(auditRoot, name)).mtimeMs }))
    .sort((a, b) => b.time - a.time);
  if (!dirs.length) return null;
  const latest = dirs[0].name;
  const jsonPath = path.join(auditRoot, latest, 'audit.json');
  if (!fs.existsSync(jsonPath)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    return {
      kind: 'audit',
      runId: data.runId || latest,
      reportUrl: `/reports/audit/${encodeURIComponent(latest)}/index.html`,
      totals: data.totals,
      pages: (data.pages || []).map((p) => ({
        url: p.url,
        title: p.title,
        status: p.status,
        issueCount: (p.findings || []).length,
      })),
    };
  } catch {
    return null;
  }
}

function summarizeLighthouse() {
  if (!fs.existsSync(LH_DIR)) return null;
  const files = fs.readdirSync(LH_DIR).filter((f) => f.endsWith('.summary.json'));
  const reports = files.map((f) => {
    try { return JSON.parse(fs.readFileSync(path.join(LH_DIR, f), 'utf8')); }
    catch { return null; }
  }).filter(Boolean);
  return { reports };
}

// ---------------------- HTTP API ----------------------
const app = express();
app.use(express.json());

// ─────────────────────────── Basic Auth ────────────────────────────────
// Optional shared-credentials gate so teammates can run this locally with a
// password prompt. Configured via env:
//   TFWEFLOLAB_USER     — username    (default: tfweflolab)
//   TFWEFLOLAB_PASS     — password    (if unset, auth is DISABLED)
//   TFWEFLOLAB_NO_AUTH  — set to "1" to force-disable auth even if PASS is set
//
// Notes:
//   * If TFWEFLOLAB_PASS is empty/unset, the server runs without auth — same
//     as before. This keeps the "I'm just running it locally for myself"
//     workflow zero-friction. Auth is opt-in by setting the password.
//   * We compare using timingSafeEqual to avoid leaking the password length
//     via response timing. Constant-time check is good hygiene even on a
//     local-only tool.
//   * The /api/health endpoint is intentionally UNGATED so monitors / setup
//     scripts can poke the server without credentials.
const AUTH_USER = process.env.TFWEFLOLAB_USER || 'tfweflolab';
const AUTH_PASS = process.env.TFWEFLOLAB_PASS || '';
const AUTH_OFF  = process.env.TFWEFLOLAB_NO_AUTH === '1' || !AUTH_PASS;

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function basicAuthMiddleware(req, res, next) {
  if (AUTH_OFF) return next();
  // Always let the health probe through (used by setup scripts, monitors).
  if (req.path === '/api/health') return next();

  const header = req.headers['authorization'] || '';
  if (!header.toLowerCase().startsWith('basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="TFWefloLab", charset="UTF-8"');
    return res.status(401).send('Authentication required — set up by your TFWefloLab admin.');
  }
  let decoded = '';
  try { decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8'); }
  catch { /* malformed header — fall through to failure */ }
  const sep = decoded.indexOf(':');
  const user = sep >= 0 ? decoded.slice(0, sep) : decoded;
  const pass = sep >= 0 ? decoded.slice(sep + 1) : '';
  const userOk = safeEqual(user, AUTH_USER);
  const passOk = safeEqual(pass, AUTH_PASS);
  if (!userOk || !passOk) {
    // Repeat the WWW-Authenticate header so the browser re-prompts.
    res.set('WWW-Authenticate', 'Basic realm="TFWefloLab", charset="UTF-8"');
    return res.status(401).send('Invalid username or password.');
  }
  // Stash on the request for any audit-log we might add later.
  req.authUser = user;
  next();
}
app.use(basicAuthMiddleware);

// Static dashboard UI
app.use(express.static(path.join(__dirname, 'public')));

// Explicitly set Content-Type for video/audio files so the <video> element
// in the dashboard can decode them. express.static normally falls back to
// application/octet-stream for files Express doesn't know about — Chrome
// then refuses to play the video and the Findings tab shows a blank box.
// This is the silent regression behind the "white video player" bug report.
const staticOpts = {
  setHeaders(res, filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.webm') res.setHeader('Content-Type', 'video/webm');
    else if (ext === '.mp4') res.setHeader('Content-Type', 'video/mp4');
    else if (ext === '.png') res.setHeader('Content-Type', 'image/png');
    else if (ext === '.jpg' || ext === '.jpeg') res.setHeader('Content-Type', 'image/jpeg');
    else if (ext === '.json') res.setHeader('Content-Type', 'application/json; charset=utf-8');
  },
};

// Static reports (Playwright HTML, Lighthouse HTML, Site Audit HTML + screenshots)
app.use('/reports/playwright', express.static(PW_REPORT_DIR, staticOpts));
app.use('/reports/lighthouse', express.static(LH_DIR, staticOpts));
app.use('/reports/audit', express.static(path.join(ROOT, 'audit', 'reports'), staticOpts));
// Snapshot diffs go to test-results/
app.use('/reports/test-results', express.static(path.join(ROOT, 'test-results'), staticOpts));

// API: list sites
app.get('/api/sites', (_req, res) => {
  res.json(readSites());
});

// API: replace site list (used by "Add site" form)
app.put('/api/sites', (req, res) => {
  const { sites } = req.body || {};
  if (!Array.isArray(sites)) return res.status(400).json({ error: 'sites array required' });
  writeSites(sites);
  res.json({ ok: true, sites });
});

// API: discover all pages of a site (sitemap.xml first, then homepage crawl)
app.post('/api/sites/discover', async (req, res) => {
  const { url } = req.body || {};
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'url required' });
  }
  try {
    const { discoverSiteUrls } = require('../utils/discovery');
    const result = await discoverSiteUrls(url, { maxPages: 200 });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// API: list projects from a config file
app.get('/api/projects', (req, res) => {
  const which = (req.query.config || 'local').toString();
  const file =
    which === 'browserstack' ? path.join(ROOT, 'playwright.browserstack.config.js')
    : which === 'realdevice'  ? path.join(ROOT, 'playwright.realdevice.config.js')
    :                            path.join(ROOT, 'playwright.config.js');
  if (!fs.existsSync(file)) return res.json({ projects: [], available: false });
  try {
    const projects = loadProjectNames(file);
    res.json({ projects, available: true });
  } catch (e) {
    res.json({ projects: [], available: false, error: String(e.message || e) });
  }
});

// API: list test types
app.get('/api/test-types', (_req, res) => {
  res.json(TEST_TYPES.map(({ id, label }) => ({ id, label })));
});

// API: kick off a run
app.post('/api/runs', (req, res) => {
  ensureDirs();
  const {
    testIds = [],
    projects = [],
    sites = [],
    configFile = 'local',  // 'local' | 'browserstack'
    headed = false,
    updateSnapshots = false,
  } = req.body || {};

  if (!Array.isArray(testIds) || testIds.length === 0) {
    return res.status(400).json({ error: 'testIds required' });
  }

  const runId = crypto.randomBytes(6).toString('hex');
  const wantsLighthouse = testIds.includes('performance');
  const wantsAudit = testIds.includes('audit');
  const playwrightTests = testIds.filter((t) => t !== 'performance' && t !== 'audit');

  const run = {
    id: runId,
    status: 'running',
    started: Date.now(),
    ended: null,
    args: [],
    log: [],
    summary: null,
    type: playwrightTests.length ? 'playwright' : 'lighthouse',
    sites,
    projects,
    testIds,
    configFile,
  };
  runs.set(runId, run);

  // Run Playwright first (if any), then Lighthouse (if requested), sequentially.
  const queue = [];
  if (playwrightTests.length) {
    const cfgFile =
      configFile === 'browserstack' ? path.join(ROOT, 'playwright.browserstack.config.js')
      : configFile === 'realdevice'  ? path.join(ROOT, 'playwright.realdevice.config.js')
      :                                 path.join(ROOT, 'playwright.config.js');
    const { args, trimmedNote } = buildPlaywrightArgs({
      testIds: playwrightTests,
      projects,
      sites,
      configFile: cfgFile,
      headed,
      updateSnapshots,
    });
    // When the user wants to WATCH the test (headed=true), inject 200ms
    // slow-motion. Earlier 500ms was visible but dragged test runtime past
    // the per-test timeout on slower sites; 200ms is still clearly visible
    // for the human eye while keeping a normal run inside its budget.
    // Override with env PWT_SLOWMO_HEADED if you want a different default.
    const slowMo = process.env.PWT_SLOWMO_HEADED || '200';
    const pwEnv = headed ? { PWT_SLOWMO: slowMo } : {};
    queue.push({ command: 'npx', args, type: 'playwright', env: pwEnv, note: trimmedNote });
  }
  if (wantsLighthouse) {
    queue.push({
      command: process.execPath, // node
      args: [path.join(ROOT, 'lighthouse', 'audit.js')],
      type: 'lighthouse',
    });
  }
  if (wantsAudit) {
    const auditArgs = [path.join(ROOT, 'audit', 'audit.js')];
    // Pass through the user's site selection from the dashboard so audit only
    // crawls the chosen sites (otherwise it iterates ALL of config/urls.json).
    if (Array.isArray(sites) && sites.length) {
      auditArgs.push('--sites', sites.join(','));
    }
    queue.push({
      command: process.execPath, // node
      args: auditArgs,
      type: 'audit',
    });
  }

  // Sequential queue runner
  (async function runAll() {
    for (const job of queue) {
      run.type = job.type;
      // Surface any note built up by buildPlaywrightArgs (e.g. "trimmed to 1
      // project for headed mode") directly into the run log.
      if (job.note) {
        run.log.push(job.note + '\n');
        publish(runId, { type: 'log', text: job.note + '\n' });
      }
      await new Promise((resolve) => {
        const child = spawnRun(runId, job.command, job.args, job.env || {});
        child.on('close', () => resolve());
      });
      if (run.exitCode !== 0) break;
    }
  })();

  res.json({ runId });
});

// API: stream log (SSE)
app.get('/api/runs/:id/stream', (req, res) => {
  const run = runs.get(req.params.id);
  if (!run) return res.status(404).end();

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();

  // Replay buffered log
  res.write(`data: ${JSON.stringify({ type: 'replay', log: run.log.join('') })}\n\n`);

  if (run.ended) {
    res.write(`data: ${JSON.stringify({ type: 'end', exitCode: run.exitCode, summary: run.summary })}\n\n`);
    return res.end();
  }

  if (!subscribers.has(run.id)) subscribers.set(run.id, new Set());
  subscribers.get(run.id).add(res);
  req.on('close', () => {
    subscribers.get(run.id)?.delete(res);
  });
});

// API: run status snapshot (used after page reload)
app.get('/api/runs/:id', (req, res) => {
  const run = runs.get(req.params.id);
  if (!run) return res.status(404).json({ error: 'not found' });
  const { id, status, started, ended, exitCode, summary, sites, projects, testIds, configFile } = run;
  res.json({ id, status, started, ended, exitCode, summary, sites, projects, testIds, configFile });
});

// API: export a run summary as CSV / XLSX / HTML-for-PDF
app.get('/api/runs/:id/export', async (req, res) => {
  const run = runs.get(req.params.id);
  if (!run) return res.status(404).json({ error: 'not found' });
  const format = String(req.query.format || 'csv').toLowerCase();
  const baseName = `webflow-tests-${run.id}`;

  const summary = run.summary || {};
  const failures = summary.failures || [];

  if (format === 'csv') {
    const rows = [
      ['Project', 'Test', 'File', 'Status', 'Duration (ms)', 'Error', 'Attachments'],
    ];
    for (const f of failures) {
      rows.push([
        f.project || '',
        f.title || '',
        f.file || '',
        f.status || 'failed',
        String(f.duration || ''),
        (f.errorFull || f.error || '').replace(/\s+/g, ' ').slice(0, 1000),
        (f.attachments || []).map((a) => `${a.name}=${a.url}`).join(' | '),
      ]);
    }
    const csv = rows
      .map((r) => r.map((cell) => {
        const s = String(cell == null ? '' : cell);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      }).join(','))
      .join('\r\n');
    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${baseName}.csv"`,
    });
    res.send('﻿' + csv); // BOM so Excel auto-detects UTF-8
    return;
  }

  if (format === 'xlsx') {
    let ExcelJS;
    try {
      ExcelJS = require('exceljs');
    } catch (e) {
      return res.status(500).json({
        error: 'exceljs not installed. Run: npm install exceljs',
      });
    }
    const wb = new ExcelJS.Workbook();
    wb.creator = 'webflow-tests-dashboard';
    wb.created = new Date(run.started || Date.now());

    // ----- Summary sheet -----
    const sumWs = wb.addWorksheet('Summary');
    sumWs.columns = [{ header: 'Field', width: 24 }, { header: 'Value', width: 60 }];
    sumWs.addRows([
      ['Run ID', run.id],
      ['Started', new Date(run.started || 0).toISOString()],
      ['Ended', run.ended ? new Date(run.ended).toISOString() : '—'],
      ['Status', run.status],
      ['Exit code', run.exitCode ?? ''],
      ['Config', run.configFile || ''],
      ['Sites', (run.sites || []).join(', ') || '(all)'],
      ['Projects', (run.projects || []).join(', ')],
      ['Test types', (run.testIds || []).join(', ')],
      ['Total', summary.total ?? ''],
      ['Passed', summary.passed ?? ''],
      ['Failed', summary.failed ?? ''],
      ['Skipped', summary.skipped ?? ''],
      ['Flaky', summary.flaky ?? ''],
    ]);
    sumWs.getRow(1).font = { bold: true };

    // ----- Bug Report sheet (one row per failure, structured like a bug log) -----
    const bugsWs = wb.addWorksheet('Bug Report');
    bugsWs.columns = [
      { header: 'Bug ID', key: 'id', width: 18 },
      { header: 'Severity', key: 'severity', width: 14 },
      { header: 'Browser / Device', key: 'project', width: 32 },
      { header: 'Scenario', key: 'scenario', width: 28 },
      { header: 'Test', key: 'title', width: 50 },
      { header: 'Spec file', key: 'file', width: 32 },
      { header: 'What happened', key: 'summary', width: 60 },
      { header: 'Expected', key: 'expected', width: 40 },
      { header: 'Received', key: 'received', width: 40 },
      { header: 'Duration (ms)', key: 'duration', width: 14 },
      { header: 'Screenshot (open while server runs)', key: 'screenshot', width: 50 },
      { header: 'Other attachments', key: 'others', width: 50 },
    ];
    const host = `http://localhost:${PORT}`;
    failures.forEach((f, i) => {
      const c = classifyFailure(f);
      const featuredUrl = c.featured ? host + c.featured.url : '';
      const others = (f.attachments || [])
        .filter((a) => a !== c.featured)
        .map((a) => `${a.name}: ${host}${a.url}`)
        .join('\n');
      const row = bugsWs.addRow({
        id: `${run.id}-${String(i + 1).padStart(3, '0')}`,
        severity: c.severity,
        project: f.project || '—',
        scenario: c.scenario,
        title: f.title || '',
        file: f.file || '',
        summary: c.summary,
        expected: c.expected,
        received: c.received,
        duration: f.duration || 0,
        screenshot: featuredUrl ? 'Open screenshot' : '—',
        others,
      });
      // Make the screenshot cell a clickable hyperlink
      if (featuredUrl) {
        const cell = row.getCell('screenshot');
        cell.value = { text: 'Open screenshot', hyperlink: featuredUrl, tooltip: featuredUrl };
        cell.font = { color: { argb: 'FF1976D2' }, underline: true };
      }
      // Wrap long cells
      ['summary', 'expected', 'received', 'others'].forEach((k) => {
        row.getCell(k).alignment = { wrapText: true, vertical: 'top' };
      });
    });
    bugsWs.getRow(1).font = { bold: true };
    bugsWs.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEEEEE' } };
    bugsWs.autoFilter = { from: 'A1', to: 'L1' };
    bugsWs.views = [{ state: 'frozen', ySplit: 1 }];

    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${baseName}.xlsx"`,
    });
    await wb.xlsx.write(res);
    res.end();
    return;
  }

  if (format === 'pdf' || format === 'html') {
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(buildBugReportHtml(run, summary, failures, format === 'pdf'));
    return;
  }

  res.status(400).json({ error: 'format must be one of: csv, xlsx, pdf, html' });
});

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Heuristically extract the most useful info out of a Playwright failure
 * so we can render it as a structured bug report (rather than a raw stack
 * trace dump).
 */
function classifyFailure(f) {
  const err = f.errorFull || f.error || '';
  const firstLine = err.split('\n').find((l) => l.trim()) || '';

  // Severity from the test status returned by Playwright
  const severity =
    f.status === 'timedOut' ? 'Critical (timeout)' :
    f.status === 'interrupted' ? 'Critical (interrupted)' :
    'High';

  // What the test was checking — derive a friendly scenario name from the spec file.
  const scenario =
    /functional/i.test(f.file)    ? 'Functional smoke check' :
    /responsive/i.test(f.file)    ? 'Responsive layout check' :
    /exploration/i.test(f.file)   ? 'Site exploration / interaction' :
    /visual/i.test(f.file)        ? 'Visual regression (pixel diff)' :
    /accessibility/i.test(f.file) ? 'Accessibility (axe-core / keyboard)' :
    /\bseo\b/i.test(f.file)       ? 'SEO / metadata check' :
    /broken-links/i.test(f.file)  ? 'Broken-link / dead-resource check' :
    'Test';

  // Try to extract Expected / Received from Playwright's assertion error.
  // Common formats:
  //   "Expected: ..."
  //   "Received: ..."
  //   "Expected number of elements: 0  Received number of elements: 3"
  let expected = '';
  let received = '';
  const expM = err.match(/Expected[^\n:]*:\s*([\s\S]*?)(?:\n(?:Received|Actual)|\n\s*at\s|$)/i);
  if (expM) expected = expM[1].trim().slice(0, 600);
  const recM = err.match(/(?:Received|Actual)[^\n:]*:\s*([\s\S]*?)(?:\n\s*at\s|$)/i);
  if (recM) received = recM[1].trim().slice(0, 600);

  // Pick the best screenshot to feature in the report (diff > screenshot > anything).
  const imgs = (f.attachments || []).filter((a) => (a.contentType || '').startsWith('image/'));
  const featured =
    imgs.find((a) => /diff/i.test(a.name)) ||
    imgs.find((a) => /actual/i.test(a.name)) ||
    imgs.find((a) => /screenshot/i.test(a.name)) ||
    imgs[0];

  return {
    severity,
    scenario,
    summary: firstLine.slice(0, 240),
    expected,
    received,
    featured,
    everyImage: imgs,
  };
}

function buildBugReportHtml(run, summary, failures, autoPrint) {
  const cards = failures
    .map((f, i) => {
      const c = classifyFailure(f);
      const imgs = c.everyImage || [];
      const imgRow = imgs
        .map(
          (img) => `
          <figure class="shot ${/expected/i.test(img.name) ? 'shot-expected' : /actual/i.test(img.name) ? 'shot-actual' : /diff/i.test(img.name) ? 'shot-diff' : ''}">
            <img src="${esc(img.url)}" alt="${esc(img.name)}" />
            <figcaption>${esc(img.name || 'screenshot')}</figcaption>
          </figure>`
        )
        .join('');
      return `
        <article class="bug">
          <header class="bug-head">
            <span class="bug-id">#${run.id}-${String(i + 1).padStart(3, '0')}</span>
            <span class="sev">${esc(c.severity)}</span>
            <h3 class="bug-title">${esc(f.title)}</h3>
          </header>
          <table class="bug-meta">
            <tr><th>Browser / device</th><td><strong>${esc(f.project || '—')}</strong></td></tr>
            <tr><th>Scenario</th><td>${esc(c.scenario)}</td></tr>
            <tr><th>Spec file</th><td><code>${esc(f.file || '—')}</code></td></tr>
            <tr><th>Duration</th><td>${esc(f.duration ? f.duration + ' ms' : '—')}</td></tr>
          </table>

          <div class="bug-section">
            <h4>What happened</h4>
            <p class="bug-summary">${esc(c.summary || 'Test assertion failed.')}</p>
          </div>

          ${
            c.expected || c.received
              ? `<div class="bug-section bug-grid">
                   <div><h4>Expected</h4><pre class="ok">${esc(c.expected || '—')}</pre></div>
                   <div><h4>Received</h4><pre class="bad">${esc(c.received || '—')}</pre></div>
                 </div>`
              : ''
          }

          ${
            imgs.length
              ? `<div class="bug-section">
                   <h4>Visual evidence (${imgs.length} attachment${imgs.length === 1 ? '' : 's'})</h4>
                   <div class="shots">${imgRow}</div>
                 </div>`
              : `<div class="bug-section muted-section">
                   <h4>Visual evidence</h4>
                   <p class="muted">No screenshot captured (the failure occurred before the page rendered, or the test did not produce one).</p>
                 </div>`
          }

          <details class="bug-section">
            <summary>Full stack trace</summary>
            <pre class="trace">${esc(f.errorFull || f.error || '(empty)')}</pre>
          </details>
        </article>`;
    })
    .join('');

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" />
<title>Webflow Tests — Bug Report ${esc(run.id)}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: #1c1f26;
    background: #f7f8fb;
    padding: 32px 36px;
    margin: 0;
    line-height: 1.5;
  }
  h1 { font-size: 26px; margin: 0 0 6px; }
  .doc-meta { color: #5e6470; font-size: 13px; margin-bottom: 20px; }
  .pill { display: inline-block; padding: 3px 10px; border-radius: 999px; font-size: 12px; margin-right: 6px; border: 1px solid #ddd; }
  .pill.good { color: #2e7d32; border-color: #c5e1a5; background: #f1f8e9; }
  .pill.bad  { color: #c62828; border-color: #ef9a9a; background: #ffebee; }
  .pill.warn { color: #ef6c00; border-color: #ffcc80; background: #fff8e1; }

  h2 { font-size: 17px; margin: 28px 0 12px; }

  /* Bug card */
  .bug {
    background: white;
    border: 1px solid #e1e4eb;
    border-radius: 10px;
    margin-bottom: 22px;
    padding: 18px 22px;
    page-break-inside: avoid;
    break-inside: avoid;
  }
  .bug-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 8px; }
  .bug-id { font-family: ui-monospace, monospace; font-size: 11px; color: #6b7280; background: #f3f4f6; padding: 2px 8px; border-radius: 4px; }
  .sev {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 2px 8px;
    border-radius: 4px;
    color: white;
    background: #d63031;
  }
  .bug-title { margin: 0; font-size: 16px; flex: 1; }

  table.bug-meta { width: 100%; border-collapse: collapse; margin: 10px 0 14px; font-size: 13px; }
  table.bug-meta th { text-align: left; color: #6b7280; font-weight: 500; width: 160px; padding: 4px 10px 4px 0; vertical-align: top; }
  table.bug-meta td { padding: 4px 0; }
  code { background: #f3f4f6; padding: 1px 6px; border-radius: 4px; font-family: ui-monospace, monospace; font-size: 12px; }

  .bug-section { margin-top: 14px; }
  .bug-section h4 { margin: 0 0 6px; font-size: 13px; color: #4b5563; text-transform: uppercase; letter-spacing: 0.04em; }
  .bug-summary { margin: 0; font-size: 14px; }
  .bug-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  pre {
    background: #fafafa;
    border: 1px solid #e5e7eb;
    border-radius: 6px;
    padding: 10px 12px;
    font-family: ui-monospace, monospace;
    font-size: 12px;
    white-space: pre-wrap;
    word-break: break-word;
    margin: 0;
    max-height: 320px;
    overflow: auto;
  }
  pre.ok  { background: #f1f8e9; border-color: #c5e1a5; color: #2e7d32; }
  pre.bad { background: #ffebee; border-color: #ef9a9a; color: #c62828; }
  pre.trace { font-size: 11px; color: #6b7280; background: #fafafa; max-height: 200px; }

  .shots { display: flex; gap: 14px; flex-wrap: wrap; }
  figure.shot {
    margin: 0;
    background: white;
    border: 1px solid #e1e4eb;
    border-radius: 8px;
    padding: 6px;
    width: 320px;
    page-break-inside: avoid;
  }
  figure.shot img {
    width: 100%;
    max-height: 220px;
    object-fit: contain;
    display: block;
    background: #f3f4f6;
    border-radius: 4px;
  }
  figure.shot figcaption { font-size: 11px; color: #6b7280; text-align: center; margin-top: 4px; text-transform: capitalize; }
  figure.shot.shot-expected { border-left: 3px solid #2e7d32; }
  figure.shot.shot-actual   { border-left: 3px solid #1976d2; }
  figure.shot.shot-diff     { border-left: 3px solid #c62828; }

  details summary { cursor: pointer; color: #6b7280; font-size: 12px; user-select: none; }
  details[open] summary { margin-bottom: 6px; }

  .muted-section .muted { color: #9ca3af; font-size: 12px; margin: 0; }

  @media print {
    body { background: white; padding: 0 12px; }
    .bug { box-shadow: none; }
    .controls { display: none; }
    details { display: none; } /* trace hidden in print to keep PDF tight */
  }

  .controls { margin-bottom: 14px; }
  .controls button {
    padding: 6px 14px;
    border: 1px solid #d1d5db;
    border-radius: 6px;
    background: white;
    cursor: pointer;
    font-size: 13px;
  }
  .controls button:hover { border-color: #1976d2; color: #1976d2; }
</style>
</head><body>
  <div class="controls"><button onclick="window.print()">Print / Save as PDF</button></div>

  <h1>Webflow Tests — Bug Report</h1>
  <div class="doc-meta">
    <strong>Run ID:</strong> <code>${esc(run.id)}</code> ·
    <strong>Started:</strong> ${esc(new Date(run.started).toLocaleString())} ·
    <strong>Config:</strong> ${esc(run.configFile)} ·
    <strong>Test types:</strong> ${esc((run.testIds || []).join(', '))} ·
    <strong>Browsers/devices:</strong> ${esc((run.projects || []).join(', ') || 'all')}
  </div>

  <h2>Summary</h2>
  <span class="pill">total ${summary.total ?? '—'}</span>
  <span class="pill good">passed ${summary.passed ?? 0}</span>
  <span class="pill bad">failed ${summary.failed ?? 0}</span>
  <span class="pill warn">skipped ${summary.skipped ?? 0}</span>
  <span class="pill warn">flaky ${summary.flaky ?? 0}</span>

  <h2>Failures (${failures.length})</h2>
  ${cards || '<p class="muted-section">No failures recorded for this run.</p>'}

  <script>
    ${autoPrint ? 'window.addEventListener("load", () => setTimeout(() => window.print(), 500));' : ''}
  </script>
</body></html>`;
}

// API: list recent runs
app.get('/api/runs', (_req, res) => {
  const list = Array.from(runs.values())
    .map(({ id, status, started, ended, exitCode, testIds, sites, projects, configFile }) => ({
      id, status, started, ended, exitCode, testIds, sites, projects, configFile,
    }))
    .sort((a, b) => b.started - a.started)
    .slice(0, 50);
  res.json(list);
});

// API: latest report URLs
app.get('/api/reports', (_req, res) => {
  const playwrightIndex = path.join(PW_REPORT_DIR, 'index.html');
  const playwrightExists = fs.existsSync(playwrightIndex);
  const playwrightTime = playwrightExists ? fs.statSync(playwrightIndex).mtimeMs : 0;

  // Lighthouse — group with timestamps.
  const lhFiles = fs.existsSync(LH_DIR)
    ? fs
        .readdirSync(LH_DIR)
        .filter((f) => f.endsWith('.html'))
        .map((f) => {
          const full = path.join(LH_DIR, f);
          return {
            name: f.replace(/\.html$/, ''),
            url: `/reports/lighthouse/${encodeURIComponent(f)}`,
            time: fs.statSync(full).mtimeMs,
          };
        })
        .sort((a, b) => b.time - a.time)
    : [];

  // Audit — newest first; enrich with sites + total issues parsed from audit.json.
  const auditRoot = path.join(ROOT, 'audit', 'reports');
  const auditFiles = fs.existsSync(auditRoot)
    ? fs
        .readdirSync(auditRoot)
        .filter((d) => fs.existsSync(path.join(auditRoot, d, 'index.html')))
        .map((d) => {
          const full = path.join(auditRoot, d);
          const meta = { name: d, url: `/reports/audit/${encodeURIComponent(d)}/index.html`, time: fs.statSync(full).mtimeMs };
          try {
            const j = JSON.parse(fs.readFileSync(path.join(full, 'audit.json'), 'utf8'));
            meta.sites = Array.from(new Set((j.pages || []).map((p) => p.site).filter(Boolean)));
            meta.totalIssues = j.totals?.issues ?? 0;
            meta.totalPages = j.totals?.pages ?? 0;
          } catch {}
          return meta;
        })
        .sort((a, b) => b.time - a.time)
        .slice(0, 30)
    : [];

  res.json({
    playwright: playwrightExists ? '/reports/playwright/index.html' : null,
    playwrightTime,
    lighthouse: lhFiles,
    audit: auditFiles,
  });
});

// BrowserStack — actually attempt a Playwright WebSocket connection (the same
// path that test runs use) and surface the real error if it fails. This is
// distinct from /api/browserstack/check (which only pings the REST API).
app.get('/api/browserstack/connect-test', async (req, res) => {
  const user = process.env.BROWSERSTACK_USERNAME;
  const key = process.env.BROWSERSTACK_ACCESS_KEY;
  if (!user || !key) {
    return res.json({ ok: false, message: 'BROWSERSTACK_USERNAME / BROWSERSTACK_ACCESS_KEY not set in .env' });
  }

  // Pick the project to test: query param, or first project from the BS config.
  const wantedName = req.query.project ? String(req.query.project) : null;
  let project, wsEndpoint;
  try {
    const cfgPath = path.join(ROOT, 'playwright.browserstack.config.js');
    delete require.cache[require.resolve(cfgPath)];
    const cfg = require(cfgPath);
    const list = cfg.projects || cfg.default?.projects || [];
    project = wantedName ? list.find((p) => p.name === wantedName) : list[0];
    if (!project) return res.json({ ok: false, message: 'BS project not found: ' + (wantedName || '(none)') });
    wsEndpoint = project.use?.connectOptions?.wsEndpoint;
    if (!wsEndpoint) return res.json({ ok: false, message: 'No wsEndpoint on project: ' + project.name });
  } catch (e) {
    return res.json({ ok: false, message: 'Failed to load BS config: ' + e.message });
  }

  // Mask the secret in any URL we echo back.
  function mask(url) {
    return url
      .replace(new RegExp(encodeURIComponent(JSON.stringify(key)).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '<KEY>')
      .replace(new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '<KEY>')
      .replace(encodeURIComponent(user), '<USER>')
      .replace(user, '<USER>');
  }

  const diagnostics = {
    project: project.name,
    usernameLength: user.length,
    keyLength: key.length,
    usernameStart: user.slice(0, 3) + '…',
    usernameEnd: '…' + user.slice(-3),
    usernameHasWhitespace: /\s/.test(user),
    keyHasWhitespace: /\s/.test(key),
    maskedEndpoint: mask(wsEndpoint).slice(0, 280) + (wsEndpoint.length > 280 ? '…' : ''),
  };

  // Actually attempt the connection.
  try {
    const { chromium } = require('@playwright/test');
    const startedAt = Date.now();
    const browser = await chromium.connect(wsEndpoint, { timeout: 30_000 });
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded', timeout: 20_000 });
    const title = await page.title();
    await page.close();
    await ctx.close();
    await browser.close();
    return res.json({
      ok: true,
      message: `Connected and opened https://example.com/ (got title="${title}").`,
      durationMs: Date.now() - startedAt,
      diagnostics,
    });
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    let hint = null;
    if (/invalid username or password/i.test(msg)) {
      hint =
        'BrowserStack rejected credentials at the WebSocket layer. Common causes:\n' +
        '  • Username/key in .env have stray whitespace or quotes (length above tells you).\n' +
        '  • The browser cap is wrong for Playwright. BS Playwright Web Automate requires\n' +
        '    "playwright-chromium" / "playwright-firefox" / "playwright-webkit" — the names\n' +
        '    "chrome" / "edge" / "safari" are Selenium caps and authenticate differently.\n' +
        '  • Real mobile devices are NOT available on Playwright Web Automate — they are\n' +
        '    only on App Automate. Drop those projects or move to local emulation.';
    } else if (/timed?out/i.test(msg)) {
      hint = 'Connection timed out. Either BS is slow today or your network blocks wss://cdp.browserstack.com.';
    } else if (/parallel/i.test(msg)) {
      hint = 'Plan parallel-session limit reached. Wait for running sessions to finish.';
    }
    return res.json({ ok: false, error: msg, hint, diagnostics });
  }
});

// BrowserStack catalog — fetch the full list of OS / browser / device
// combinations available on the user's plan via BS REST API. Cached for
// 1 hour in memory because the catalog changes rarely.
let _bsCatalogCache = null;
app.get('/api/browserstack/devices', async (_req, res) => {
  const user = process.env.BROWSERSTACK_USERNAME;
  const key = process.env.BROWSERSTACK_ACCESS_KEY;
  if (!user || !key) {
    return res.status(400).json({ ok: false, message: 'BrowserStack credentials not set in .env' });
  }
  if (_bsCatalogCache && Date.now() - _bsCatalogCache.ts < 60 * 60 * 1000) {
    return res.json({ ok: true, entries: _bsCatalogCache.entries, cached: true });
  }
  const https = require('https');
  const auth = Buffer.from(`${user}:${key}`).toString('base64');
  const data = await new Promise((resolve) => {
    const req = https.get(
      'https://api.browserstack.com/automate/browsers.json',
      { headers: { Authorization: 'Basic ' + auth, 'User-Agent': 'webflow-tests-dashboard/1.0' }, timeout: 15_000 },
      (resp) => {
        let body = '';
        resp.on('data', (c) => (body += c));
        resp.on('end', () => resolve({ status: resp.statusCode, body }));
      }
    );
    req.on('error', (err) => resolve({ status: 0, error: String(err.message || err) }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'timeout' }); });
  });
  if (data.status !== 200) {
    return res.json({ ok: false, message: `BrowserStack API HTTP ${data.status}: ${data.error || ''}` });
  }
  let entries = [];
  try { entries = JSON.parse(data.body); } catch (e) {
    return res.json({ ok: false, message: 'Failed to parse BS response: ' + e.message });
  }
  _bsCatalogCache = { ts: Date.now(), entries };
  res.json({ ok: true, entries, cached: false });
});

// Verify BrowserStack credentials by hitting BS Automate REST API.
// This proves the username/access-key pair is valid and a plan is active,
// without spinning a real browser session (which is slow and burns minutes).
app.get('/api/browserstack/check', async (_req, res) => {
  const user = process.env.BROWSERSTACK_USERNAME;
  const key = process.env.BROWSERSTACK_ACCESS_KEY;
  if (!user || !key) {
    return res.status(400).json({
      ok: false,
      reason: 'missing-creds',
      message: 'BROWSERSTACK_USERNAME / BROWSERSTACK_ACCESS_KEY not set. Add them to .env and restart.',
    });
  }
  const https = require('https');
  const auth = Buffer.from(`${user}:${key}`).toString('base64');
  const data = await new Promise((resolve) => {
    const req = https.get(
      'https://api.browserstack.com/automate/plan.json',
      { headers: { Authorization: 'Basic ' + auth, 'User-Agent': 'webflow-tests-dashboard/1.0' }, timeout: 10_000 },
      (resp) => {
        let body = '';
        resp.on('data', (c) => (body += c));
        resp.on('end', () => resolve({ status: resp.statusCode, body }));
      }
    );
    req.on('error', (err) => resolve({ status: 0, error: String(err.message || err) }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'timeout' }); });
  });

  if (data.status === 401 || data.status === 403) {
    return res.json({ ok: false, reason: 'invalid-creds', message: 'BrowserStack rejected the credentials (HTTP ' + data.status + ').' });
  }
  if (data.status !== 200) {
    return res.json({ ok: false, reason: 'http-error', message: `BrowserStack API returned HTTP ${data.status}: ${data.error || ''}` });
  }
  let plan = {};
  try { plan = JSON.parse(data.body); } catch {}
  res.json({
    ok: true,
    username: user,
    plan: plan.automate_plan || plan.parallel_sessions_max_allowed ? plan : { raw: data.body.slice(0, 200) },
    parallelSessionsMax: plan.parallel_sessions_max_allowed,
    sessionsRunning: plan.parallel_sessions_running,
    queuedSessions: plan.queued_sessions,
  });
});

// Env / credentials status (used by the dashboard to warn about missing BrowserStack creds)
app.get('/api/env-status', (_req, res) => {
  res.json({
    envFileLoaded: ENV_FILE_STATUS.loaded,
    envFilePath: ENV_FILE_STATUS.loaded ? ENV_PATH : null,
    browserstack: {
      hasUsername: Boolean(process.env.BROWSERSTACK_USERNAME),
      hasAccessKey: Boolean(process.env.BROWSERSTACK_ACCESS_KEY),
      // Don't echo the credentials themselves; just confirm what was found.
      build: process.env.BROWSERSTACK_BUILD || null,
      project: process.env.BROWSERSTACK_PROJECT || null,
    },
  });
});

// Markdown docs viewer — serves project-root .md files (ONBOARDING / README /
// TEST-RESULTS / AUDIT) as nicely-rendered HTML using marked from a CDN. We
// only serve a whitelisted set; never arbitrary paths.
const DOC_WHITELIST = ['ONBOARDING.md', 'README.md', 'TEST-RESULTS.md', 'AUDIT.md'];
app.get('/docs/', (req, res) => {
  const which = String(req.query.f || 'ONBOARDING.md');
  if (!DOC_WHITELIST.includes(which)) return res.status(404).send('not found');
  const full = path.resolve(ROOT, which);
  if (!full.startsWith(ROOT + path.sep)) return res.status(404).send('not found');
  if (!fs.existsSync(full)) return res.status(404).send('not found');
  const md = fs.readFileSync(full, 'utf8');
  // Render via marked from CDN — keeps server zero-dep on markdown libs.
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" />
<title>TFWefloLab — ${which.replace('.md', '')}</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />
<style>
  :root {
    --tf-blue: #00C2FF;
    --tf-blue-hi: #1AD2FF;
    --tf-glow: rgba(0,194,255,0.25);
    --bg: #07090f;
    --panel: #0e1220;
    --fg: #f1f4fb;
    --muted: #8893b3;
    --border: #232c47;
  }
  body {
    background: var(--bg);
    color: var(--fg);
    font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 14.5px;
    line-height: 1.65;
    max-width: 880px;
    margin: 0 auto;
    padding: 36px 28px 80px;
  }
  .doc-nav {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    margin-bottom: 28px;
    padding-bottom: 16px;
    border-bottom: 1px solid var(--border);
  }
  .doc-nav a {
    background: var(--panel);
    border: 1px solid var(--border);
    color: var(--muted);
    padding: 6px 12px;
    border-radius: 6px;
    text-decoration: none;
    font-size: 12px;
    font-weight: 500;
    transition: all 0.15s;
  }
  .doc-nav a:hover { color: var(--tf-blue); border-color: var(--tf-blue); }
  .doc-nav a.active {
    color: #051018;
    background: linear-gradient(135deg, #00C2FF 0%, #5B8DFF 100%);
    border-color: transparent;
    font-weight: 700;
    box-shadow: 0 4px 16px var(--tf-glow);
  }
  h1 { font-weight: 700; letter-spacing: -0.02em; margin: 0.5em 0 0.4em; font-size: 28px; }
  h1 strong { color: var(--tf-blue); }
  h2 {
    font-weight: 700;
    letter-spacing: -0.01em;
    margin: 1.6em 0 0.5em;
    font-size: 20px;
    color: var(--tf-blue);
    padding-bottom: 0.3em;
    border-bottom: 1px solid var(--border);
  }
  h3 { font-weight: 600; margin: 1.4em 0 0.4em; font-size: 16px; }
  p, ul, ol { margin: 0.7em 0; }
  a { color: var(--tf-blue); }
  a:hover { color: var(--tf-blue-hi); }
  code {
    background: var(--panel);
    border: 1px solid var(--border);
    padding: 1px 7px;
    border-radius: 4px;
    font-family: "JetBrains Mono", ui-monospace, monospace;
    font-size: 12.5px;
    color: var(--tf-blue);
  }
  pre { background: var(--panel); border: 1px solid var(--border); padding: 14px 16px; border-radius: 8px; overflow-x: auto; }
  pre code { background: none; border: none; padding: 0; color: var(--fg); }
  blockquote { border-left: 3px solid var(--tf-blue); padding: 8px 14px; margin: 1em 0; background: rgba(0,194,255,0.04); border-radius: 0 6px 6px 0; }
  table { border-collapse: collapse; width: 100%; margin: 1em 0; font-size: 13px; }
  th, td { border: 1px solid var(--border); padding: 8px 12px; text-align: left; vertical-align: top; }
  th { background: var(--panel); color: var(--tf-blue); font-weight: 600; }
  hr { border: none; border-top: 1px solid var(--border); margin: 2em 0; }
  .footer-fwd {
    text-align: center;
    margin-top: 48px;
    padding: 16px;
    border-top: 1px solid var(--border);
    color: var(--muted);
    font-size: 12px;
  }
</style>
</head><body>
  <nav class="doc-nav">
    ${DOC_WHITELIST.map((f) => `<a href="/docs/?f=${encodeURIComponent(f)}" class="${f === which ? 'active' : ''}">${f.replace('.md', '')}</a>`).join('')}
    <a href="/" style="margin-left: auto;">← Back to TFWefloLab</a>
  </nav>
  <div id="content">Loading…</div>
  <div class="footer-fwd">Source: <code>${which}</code> · Rendered with marked.js · TFWefloLab</div>
  <script src="https://cdn.jsdelivr.net/npm/marked@12.0.0/marked.min.js"></script>
  <script>
    const src = ${JSON.stringify(md)};
    marked.setOptions({ gfm: true, breaks: false });
    document.getElementById('content').innerHTML = marked.parse(src);
    // Open external links in new tab
    document.querySelectorAll('#content a[href^="http"]').forEach((a) => { a.target = '_blank'; a.rel = 'noopener'; });
  </script>
</body></html>`);
});

// Health
app.get('/api/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

// Bind host — defaults to 127.0.0.1 (loopback only, safer). Set
// TFWEFLOLAB_LAN=1 to bind to 0.0.0.0 so teammates on the same Wi-Fi can
// reach the server. The startup banner prints both URLs in that case so
// the user knows what to share.
const BIND_HOST = process.env.TFWEFLOLAB_LAN === '1' ? '0.0.0.0' : '127.0.0.1';

function lanIPv4() {
  // Collect non-internal IPv4 addresses so we can show the LAN URL on boot.
  // os.networkInterfaces() returns multiple interfaces; we filter to the
  // first non-loopback IPv4 (which is what colleagues will use).
  try {
    const os = require('os');
    const ifs = os.networkInterfaces();
    for (const name of Object.keys(ifs)) {
      for (const ni of ifs[name] || []) {
        if (ni && ni.family === 'IPv4' && !ni.internal) return ni.address;
      }
    }
  } catch { /* fall through */ }
  return null;
}

app.listen(PORT, BIND_HOST, () => {
  const ip = BIND_HOST === '0.0.0.0' ? lanIPv4() : null;
  const lanLine = ip
    ? `  │  http://${ip}:${PORT}` + ' '.repeat(Math.max(0, 33 - String(ip).length - String(PORT).length)) + '   │\n  │  ↑ share this with teammates on the same network    │\n'
    : '';
  const authLine = AUTH_OFF
    ? '  │  Auth: \x1b[33mdisabled\x1b[0m (set TFWEFLOLAB_PASS in .env to enable)│\n'
    : `  │  Auth: \x1b[32menabled\x1b[0m · user "${AUTH_USER}"` + ' '.repeat(Math.max(0, 22 - AUTH_USER.length)) + '│\n';
  // eslint-disable-next-line no-console
  console.log(
    '\n' +
    '  ┌─────────────────────────────────────────────────────────┐\n' +
    '  │  \x1b[1m\x1b[36mTF\x1b[0m\x1b[1mWeflo\x1b[0m\x1b[1m\x1b[32mLab\x1b[0m  ·  Testfort Webflow Laboratory       │\n' +
    `  │  http://localhost:${PORT}` + ' '.repeat(Math.max(0, 35 - String(PORT).length)) + '│\n' +
    lanLine +
    authLine +
    '  │  Powered by TestFort · https://testfort.com/            │\n' +
    '  └─────────────────────────────────────────────────────────┘\n'
  );
});
