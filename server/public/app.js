// @ts-check
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const state = {
  sites: [],
  testTypes: [],
  projects: [],
  configFile: 'local',
  currentRun: null,
  evtSource: null,
};

// -------- Tabs --------
$$('.tabs button').forEach((btn) => {
  btn.addEventListener('click', () => {
    $$('.tabs button').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.tab;
    $$('.tab').forEach((t) => t.classList.remove('visible'));
    $(`#tab-${tab}`).classList.add('visible');
    if (tab === 'history') loadHistory();
    if (tab === 'reports') loadReports();
    if (tab === 'sites')   renderSitesEditor();
  });
});

// -------- Helpers --------
function checkboxList(container, items, getId, getLabel) {
  container.innerHTML = '';
  for (const item of items) {
    const id = getId(item);
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = id;
    input.dataset.kind = container.id;
    label.appendChild(input);
    label.append(' ' + getLabel(item));
    container.appendChild(label);
  }
}
function checkedValues(containerId) {
  return $$(`#${containerId} input:checked`).map((i) => i.value);
}
function setAll(containerId, value) {
  $$(`#${containerId} input`).forEach((i) => (i.checked = value));
}
function setMatching(containerId, predicate) {
  $$(`#${containerId} input`).forEach((i) => (i.checked = predicate(i.value)));
}

/**
 * Tiny utility: turn an HTML string into a live element node. Used by
 * renderBugs (clean-run state) and other places that want to inject a
 * structured block without manually constructing each element.
 */
function buildHtmlBlock(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = String(html).trim();
  return tpl.content.firstElementChild || document.createElement('div');
}

// -------- Initial loaders --------
async function loadSites() {
  const r = await fetch('/api/sites');
  state.sites = await r.json();
  checkboxList($('#sites-list'), state.sites, (s) => s.name, (s) => `${s.name} — ${s.url}`);
  // No defaults — user picks consciously which sites to test.
}

async function loadTestTypes() {
  const r = await fetch('/api/test-types');
  state.testTypes = await r.json();
  checkboxList($('#types-list'), state.testTypes, (t) => t.id, (t) => t.label);
  // No defaults — user picks consciously.
  // Wire each test-type checkbox to refresh the audit-exclusivity gate
  // and the Options-section context.
  $$('#types-list input').forEach((i) => {
    i.addEventListener('change', () => {
      applyAuditExclusivity();
      applyOptionsContext();
    });
  });
  applyAuditExclusivity();
  applyOptionsContext();
}

/**
 * Site Audit is a self-contained crawler — when it's selected, the rest of the
 * Run-tab options (other test types, browsers/devices, config, headed,
 * update-snapshots) don't apply. Disable them so the user can't accidentally
 * pick incompatible settings, and surface a banner explaining why.
 */
function applyAuditExclusivity() {
  const auditBox = $$('#types-list input').find((i) => i.value === 'audit');
  if (!auditBox) return;

  const auditOnly = auditBox.checked;

  // (a) Other test-type checkboxes
  $$('#types-list input').forEach((i) => {
    if (i.value === 'audit') return;
    i.disabled = auditOnly;
    if (auditOnly) i.checked = false;
    i.parentElement?.classList.toggle('disabled', auditOnly);
  });

  // (b) Browsers / devices section
  $('#config-select').disabled = auditOnly;
  $$('#projects-list input').forEach((i) => {
    i.disabled = auditOnly;
    i.parentElement?.classList.toggle('disabled', auditOnly);
  });
  ['btn-select-all-projects', 'btn-clear-projects', 'btn-preset-desktop', 'btn-preset-mobile', 'btn-preset-tablet']
    .forEach((id) => { const el = $('#' + id); if (el) el.disabled = auditOnly; });

  // (c) Options
  $('#opt-headed').disabled = auditOnly || state.configFile === 'browserstack';
  $('#opt-update-snapshots').disabled = auditOnly;
  $('#opt-headed-label')?.classList.toggle('disabled', auditOnly);
  $('#opt-update-snapshots-label')?.classList.toggle('disabled', auditOnly);

  // (d) Banner
  let banner = $('#audit-exclusive-banner');
  if (auditOnly) {
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'audit-exclusive-banner';
      banner.className = 'banner banner-good';
      banner.innerHTML =
        '<strong>Site audit mode</strong> — runs as a standalone crawler with its own headless Chromium. ' +
        'The other test types, browser/device picker, and options below are <strong>not used</strong> for this run and have been disabled. ' +
        'Audit will crawl <em>every page found via sitemap.xml</em> for each selected site.';
      // Insert directly under the Test types list
      const typesList = $('#types-list');
      typesList.parentNode.insertBefore(banner, typesList.nextSibling);
    }
    banner.hidden = false;
  } else if (banner) {
    banner.hidden = true;
  }
}

async function loadProjects() {
  const r = await fetch(`/api/projects?config=${state.configFile}`);
  const data = await r.json();
  state.projects = data.projects;
  if (!data.available) {
    $('#projects-list').innerHTML =
      `<div class="muted" style="padding: 12px;">Config <code>playwright.${state.configFile === 'browserstack' ? 'browserstack.' : ''}config.js</code> not available.${data.error ? '<br>' + data.error : ''}</div>`;
    return;
  }
  checkboxList($('#projects-list'), state.projects, (p) => p, (p) => p);
  // No defaults — user picks consciously which browsers/devices to run on.
}

$('#config-select').addEventListener('change', (e) => {
  state.configFile = e.target.value;
  loadProjects();
  refreshCredsBanner();
  applyOptionsContext();
});

/**
 * Update the Options section (Headed checkbox + Update-baselines checkbox)
 * so it reflects which choices actually do something for the current
 * Config + Test types selection. Disable irrelevant checkboxes and rewrite
 * the hint text instead of leaving the user guessing.
 */
function applyOptionsContext() {
  const config = state.configFile;
  const testIds = checkedValues('types-list');
  const auditOnly = testIds.length === 1 && testIds[0] === 'audit';
  const hasVisual = testIds.includes('visual');
  const hasNoTests = testIds.length === 0;

  // ----- Headed (show browser) -----
  const headed = $('#opt-headed');
  const headedLabel = $('#opt-headed-label');
  const headedHint = $('#opt-headed-hint');
  if (!headed) return;

  let headedDisabled = false;
  let headedHintText = '';

  if (auditOnly) {
    headedDisabled = true;
    headedHintText = 'Disabled — Site audit runs as a standalone crawler with its own headless Chromium; there is no Playwright browser window to show.';
  } else if (config === 'browserstack') {
    headedDisabled = true;
    headedHintText =
      'Disabled for BrowserStack runs — browsers run on cloud machines (Windows / macOS), not on your computer. Watch sessions live in the ' +
      `<a href="${BS_DASHBOARD_URL}" target="_blank" rel="noopener">BrowserStack Live dashboard ↗</a>.`;
  } else if (config === 'realdevice') {
    headedDisabled = false;
    headedHintText =
      '<strong>Recommended for Real Device Emulation</strong> — opens a browser window for EACH selected device ' +
      '<em>sequentially, one at a time</em> (so the screen never gets cluttered). Each window runs in slow-motion ' +
      '(<strong>200 ms per action</strong>) so you can watch clicks / scrolls / fills happen in real time.';
  } else {
    headedDisabled = false;
    headedHintText =
      'Opens a real browser window for each selected project, running them <strong>one at a time</strong> ' +
      '(<code>--workers=1</code>) with <strong>200 ms slow-motion</strong> per action — slower than headless, but you see every step.';
  }

  headed.disabled = headedDisabled;
  if (headedDisabled) headed.checked = false;
  if (headedLabel) headedLabel.classList.toggle('disabled', headedDisabled);
  if (headedHint) headedHint.innerHTML = headedHintText;

  // ----- Update visual baselines -----
  const upd = $('#opt-update-snapshots');
  const updLabel = $('#opt-update-snapshots-label');
  const updHint = updLabel?.nextElementSibling;
  if (!upd) return;

  let updDisabled = false;
  let updHintText = '';

  if (auditOnly || hasNoTests) {
    updDisabled = true;
    updHintText = auditOnly
      ? 'Not used by Site audit — only applies to the Visual regression test type.'
      : 'Pick at least one test type. This option only matters when Visual regression is selected.';
  } else if (!hasVisual) {
    updDisabled = true;
    updHintText = 'Only applies to Visual regression — tick that test type first to enable.';
  } else {
    updDisabled = false;
    updHintText =
      '<strong>First-run with Visual regression?</strong> Tick this — Playwright will <em>create</em> the baseline screenshots ' +
      'instead of comparing against (non-existent) ones. Re-run without it on subsequent passes; it will then compare and ' +
      'fail only on real visual changes.';
  }

  upd.disabled = updDisabled;
  if (updDisabled) upd.checked = false;
  if (updLabel) updLabel.classList.toggle('disabled', updDisabled);
  if (updHint && updHint.classList.contains('hint')) updHint.innerHTML = updHintText;
}

// -------- BrowserStack creds banner + Headed option gating --------
const BS_DASHBOARD_URL = 'https://automate.browserstack.com/dashboard/v2';

async function refreshCredsBanner() {
  const banner = $('#bs-creds-banner');
  const isBs = state.configFile === 'browserstack';
  // Headed / update-baselines context is now centralised in
  // applyOptionsContext(); refreshCredsBanner delegates so that switching
  // Config also re-evaluates the Options section.
  applyOptionsContext();

  if (!banner) return;
  if (!isBs) {
    banner.hidden = true;
    return;
  }
  try {
    const r = await fetch('/api/env-status');
    const env = await r.json();
    const ok = env.browserstack.hasUsername && env.browserstack.hasAccessKey;
    if (ok) {
      banner.hidden = false;
      banner.classList.remove('banner-warn');
      banner.classList.add('banner-good');
      banner.innerHTML =
        `BrowserStack credentials detected${env.envFileLoaded ? ' (loaded from <code>.env</code>)' : ''}. ` +
        `Plays back on real <strong>Windows / macOS desktop browsers</strong> via BS Web Automate. ` +
        `<br><span class="muted" style="font-size: 11px;">⚠ Real iOS / Android phones are not supported on Playwright Web Automate (BS limitation) — switch to <strong>Real Device Emulation</strong> for mobile/tablet.</span>` +
        `<br><a href="${BS_DASHBOARD_URL}" target="_blank" rel="noopener">BrowserStack Live ↗</a> · ` +
        `<button class="link" id="btn-bs-check" type="button">REST check</button> · ` +
        `<button class="link" id="btn-bs-connect-test" type="button">Diagnose connection</button> ` +
        `<div id="bs-check-result" class="muted" style="margin-top: 6px; font-size: 12px;"></div>`;
      // Wire the Test connection button (re-bound on every render).
      $('#btn-bs-check')?.addEventListener('click', async () => {
        const out = $('#bs-check-result');
        out.textContent = 'REST API check…';
        out.style.color = 'var(--muted)';
        try {
          const r = await fetch('/api/browserstack/check');
          const d = await r.json();
          if (d.ok) {
            out.innerHTML =
              ` ✓ REST: connected as <strong>${escapeHtml(d.username)}</strong>` +
              (d.parallelSessionsMax != null ? ` (max ${d.parallelSessionsMax} parallel, ${d.sessionsRunning ?? 0} running)` : '');
            out.style.color = 'var(--good)';
          } else {
            out.innerHTML = ' ✗ REST: ' + escapeHtml(d.message || 'Unknown error');
            out.style.color = 'var(--bad)';
          }
        } catch (e) {
          out.textContent = ' ✗ ' + e.message;
          out.style.color = 'var(--bad)';
        }
      });
      $('#btn-bs-connect-test')?.addEventListener('click', async () => {
        const out = $('#bs-check-result');
        out.style.color = 'var(--muted)';
        out.innerHTML = 'Spinning up a real BrowserStack session… (uses 1 parallel slot, ~20–40s)';
        try {
          const r = await fetch('/api/browserstack/connect-test');
          const d = await r.json();
          if (d.ok) {
            out.style.color = 'var(--good)';
            out.innerHTML =
              ` ✓ <strong>${escapeHtml(d.project)}</strong> — ${escapeHtml(d.message)} ` +
              `<span class="muted">(${d.durationMs}ms)</span>` +
              `<br><span class="muted">Username ${d.diagnostics.usernameLength} chars (${escapeHtml(d.diagnostics.usernameStart)}${escapeHtml(d.diagnostics.usernameEnd)}), key ${d.diagnostics.keyLength} chars.</span>`;
          } else {
            out.style.color = 'var(--bad)';
            const hint = d.hint ? `<pre class="banner-snippet" style="margin-top:6px;">${escapeHtml(d.hint)}</pre>` : '';
            const diag = d.diagnostics
              ? `<div class="muted" style="margin-top:4px;font-size:11px;">Project: ${escapeHtml(d.diagnostics.project)} · ` +
                `username ${d.diagnostics.usernameLength} chars${d.diagnostics.usernameHasWhitespace ? ' <strong style="color:var(--bad)">⚠ has whitespace</strong>' : ''}` +
                ` · key ${d.diagnostics.keyLength} chars${d.diagnostics.keyHasWhitespace ? ' <strong style="color:var(--bad)">⚠ has whitespace</strong>' : ''}` +
                `<br>Endpoint: <code style="font-size:10px;">${escapeHtml(d.diagnostics.maskedEndpoint)}</code></div>`
              : '';
            out.innerHTML = ` ✗ ${escapeHtml(d.error || d.message || 'Unknown error')} ${diag}${hint}`;
          }
        } catch (e) {
          out.style.color = 'var(--bad)';
          out.textContent = ' ✗ ' + e.message;
        }
      });
    } else {
      banner.hidden = false;
      banner.classList.add('banner-warn');
      banner.classList.remove('banner-good');
      banner.innerHTML = `
        BrowserStack credentials not detected. Add them to <code>.env</code> in the project root:
        <pre class="banner-snippet">BROWSERSTACK_USERNAME=your_user
BROWSERSTACK_ACCESS_KEY=your_key</pre>
        Then restart <code>npm run dashboard</code>.`;
    }
  } catch {
    banner.hidden = true;
  }
}

// -------- Cross-tab shortcuts --------
function gotoTab(name) {
  document.querySelector(`.tabs button[data-tab="${name}"]`).click();
}
$('#btn-go-sites').addEventListener('click', (e) => { e.preventDefault(); gotoTab('sites'); });
$('#link-sites-tab').addEventListener('click', (e) => { e.preventDefault(); gotoTab('sites'); });

// -------- Filter shortcuts --------
$('#btn-select-all-sites').addEventListener('click', () => setAll('sites-list', true));
$('#btn-clear-sites').addEventListener('click', () => setAll('sites-list', false));
$('#btn-select-all-types').addEventListener('click', () => setAll('types-list', true));
$('#btn-clear-types').addEventListener('click', () => setAll('types-list', false));
$('#btn-select-all-projects').addEventListener('click', () => setAll('projects-list', true));
$('#btn-clear-projects').addEventListener('click', () => setAll('projects-list', false));
/**
 * Classify a Playwright project name into desktop / mobile / tablet by its
 * device hint, not by a fixed prefix. Works across all three configs:
 *   Local        — "Desktop Chrome (Windows 11)" / "Mobile Safari (iPhone 14)" / "Tablet Safari (iPad Pro 11)"
 *   RD (Real Dev Emulation) — "RD iPhone 14" / "RD iPad Pro 11" / "RD Desktop Chrome (1920×1080)"
 *   BrowserStack — "BS Chromium (Windows 11)" / "BS Safari / WebKit (macOS Sonoma)" (all desktop)
 */
function classifyProject(name) {
  const n = String(name).toLowerCase();
  // Tablet keywords win over mobile (e.g. "Galaxy Tab" must not match "galaxy s")
  if (/ipad|galaxy tab|surface go|\btab s\d|\btablet\b/.test(n)) return 'tablet';
  if (/iphone|\bpixel\b|pixel \d|galaxy s\d|galaxy fold|nokia|moto|huawei|xiaomi|oneplus|\bmobile\b|\bphone\b/.test(n)) return 'mobile';
  return 'desktop';
}

function applyPreset(category) {
  setMatching('projects-list', (n) => classifyProject(n) === category);
  // If the preset matched zero projects (e.g. "mobile" on a BS-only config
  // which is desktop-only), surface a hint instead of letting the user guess.
  const matched = $$('#projects-list input:checked').length;
  if (matched === 0) {
    const cfgLabel = $('#config-select').selectedOptions[0]?.textContent || state.configFile;
    alert(
      `No "${category}" projects in the current config (${cfgLabel}).\n\n` +
      (category === 'mobile' || category === 'tablet'
        ? 'Tip: BrowserStack Playwright Web Automate doesn\'t support real mobile/tablet — switch Config to "Real Device Emulation (DevTools-grade)" for mobile/tablet projects.'
        : 'The current config only has mobile/tablet projects. Pick "Local (emulation)" or "BrowserStack" for desktop browsers.')
    );
  }
}

$('#btn-preset-desktop').addEventListener('click', () => applyPreset('desktop'));
$('#btn-preset-mobile').addEventListener('click', () => applyPreset('mobile'));
$('#btn-preset-tablet').addEventListener('click', () => applyPreset('tablet'));

// -------- Run --------
$('#btn-run').addEventListener('click', async () => {
  const sites = checkedValues('sites-list');
  const testIds = checkedValues('types-list');
  const projects = checkedValues('projects-list');

  if (testIds.length === 0) {
    alert('Select at least one test type from the "Test types" section.\n\nIf you\'re new, start with "Site audit (crawler-style report)" — it gives the broadest overview.');
    return;
  }
  if (sites.length === 0) {
    alert('Select at least one site to test in the "Sites" section.\n\nNo URLs configured? Open the Sites tab and use "Discover pages →" to import them from sitemap.xml.');
    return;
  }
  // Site audit ignores the projects checkboxes (it has its own headless
  // Chromium), so only require projects for the other test types.
  const auditOnly = testIds.length === 1 && testIds[0] === 'audit';
  if (!auditOnly && projects.length === 0) {
    alert('Select at least one browser / device in the "Browsers / devices" section.\n\nTip: try the "desktop" / "mobile" / "tablet" preset links to bulk-tick a category.');
    return;
  }
  if (testIds.includes('visual') && !$('#opt-update-snapshots').checked) {
    // Friendly hint for first-run users — visual regression with no baseline = all fails.
    if (!state._visualSeen) {
      const ok = confirm(
        'Visual regression compares against committed baseline screenshots.\n\n' +
        'On the FIRST run there are no baselines yet, so every test will fail. ' +
        'Tick "Update visual baselines" to create them, run, then turn it off for future runs.\n\n' +
        'Continue without baselines anyway?'
      );
      state._visualSeen = true;
      if (!ok) return;
    }
  }

  $('#run-log').textContent = '';
  setRunStatus('running', 'Starting…');
  $('#run-summary').innerHTML = '';
  $('#btn-run').disabled = true;

  const payload = {
    sites,
    testIds,
    projects,
    configFile: state.configFile,
    headed: $('#opt-headed').checked,
    updateSnapshots: $('#opt-update-snapshots')?.checked || false,
  };

  try {
    const r = await fetch('/api/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${r.status}`);
    }
    const { runId } = await r.json();
    state.currentRun = runId;
    streamRun(runId);
  } catch (e) {
    setRunStatus('failed', `Error: ${e.message}`);
    $('#btn-run').disabled = false;
  }
});

function setRunStatus(status, label) {
  const h = $('#run-title');
  h.classList.remove('running', 'passed', 'failed');
  h.classList.add(status);
  h.textContent = label;
}

// -------- Live progress UI --------
let _progressTimer = null;
let _progressState = null;
function showProgress(p) {
  const root = $('#run-progress');
  const fill = $('#run-progress-fill');
  const counts = $('#run-progress-counts');
  const eta = $('#run-progress-eta');
  if (!root) return;
  root.hidden = false;
  _progressState = p;

  function tick() {
    if (!_progressState) return;
    const { total, done, passed, failed, skipped, startedAt } = _progressState;
    const elapsedMs = Date.now() - startedAt;
    const elapsed = formatDuration(elapsedMs);

    if (total && done > 0) {
      const pct = Math.min(100, Math.round((done / total) * 100));
      fill.style.width = pct + '%';
      fill.classList.remove('indeterminate');
      const perTestMs = elapsedMs / done;
      const remainingMs = perTestMs * (total - done);
      eta.textContent = `elapsed ${elapsed} · ETA ~${formatDuration(remainingMs)} (${pct}%)`;
    } else {
      // Indeterminate — we don't know the total yet (or it's audit running)
      fill.classList.add('indeterminate');
      eta.textContent = `elapsed ${elapsed} · counting tests…`;
    }
    let line = total ? `${done} / ${total}` : `${done} done`;
    if (passed) line += ` · ✓ ${passed}`;
    if (failed) line += ` · ✗ ${failed}`;
    if (skipped) line += ` · - ${skipped}`;
    counts.textContent = line;
  }
  tick();
  if (_progressTimer) clearInterval(_progressTimer);
  _progressTimer = setInterval(tick, 1000);
}
function hideProgress() {
  if (_progressTimer) { clearInterval(_progressTimer); _progressTimer = null; }
  _progressState = null;
  // Keep the bar visible at 100% for 2 seconds, then hide
  setTimeout(() => { const r = $('#run-progress'); if (r) r.hidden = true; }, 2000);
}
function formatDuration(ms) {
  if (!ms || ms < 0) return '0s';
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m + 'm ' + (r < 10 ? '0' : '') + r + 's';
}

function streamRun(runId) {
  if (state.evtSource) state.evtSource.close();
  const es = new EventSource(`/api/runs/${runId}/stream`);
  state.evtSource = es;

  const log = $('#run-log');
  let autoscroll = true;
  log.addEventListener('scroll', () => {
    autoscroll = log.scrollTop + log.clientHeight >= log.scrollHeight - 10;
  });

  es.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'replay') {
      log.textContent = msg.log || '';
    } else if (msg.type === 'log') {
      log.append(msg.text);
    } else if (msg.type === 'start') {
      setRunStatus('running', 'Running…');
      log.append(`\n$ ${msg.cmd}\n`);
      showProgress({ total: null, done: 0, passed: 0, failed: 0, skipped: 0, startedAt: Date.now() });
    } else if (msg.type === 'progress') {
      showProgress(msg.progress);
    } else if (msg.type === 'end') {
      const ok = msg.exitCode === 0;
      setRunStatus(ok ? 'passed' : 'failed', ok ? 'Passed' : 'Failed');
      $('#btn-run').disabled = false;
      renderSummary(msg.summary);
      hideProgress();
      es.close();
    }
    if (autoscroll) log.scrollTop = log.scrollHeight;
  };
  es.onerror = () => {
    es.close();
    $('#btn-run').disabled = false;
  };
}

function renderSummary(summary) {
  const root = $('#run-summary');
  root.innerHTML = '';
  if (!summary) return;

  if (typeof summary.total === 'number') {
    root.appendChild(pill('total ' + summary.total));
    root.appendChild(pill('passed ' + summary.passed, 'good'));
    if (summary.failed) root.appendChild(pill('failed ' + summary.failed, 'bad'));
    if (summary.skipped) root.appendChild(pill('skipped ' + summary.skipped, 'warn'));
    if (summary.flaky) root.appendChild(pill('flaky ' + summary.flaky, 'warn'));
    const open = document.createElement('button');
    open.className = 'link';
    open.textContent = 'open Playwright report →';
    open.addEventListener('click', () => {
      gotoTab('reports');
      $('#report-frame').src = '/reports/playwright/index.html?_=' + Date.now();
    });
    root.appendChild(open);
    root.appendChild(makeExportButtons(state.currentRun));
  } else if (summary.reports) {
    root.appendChild(pill('lighthouse ' + summary.reports.length));
    const open = document.createElement('button');
    open.className = 'link';
    open.textContent = 'open report →';
    open.addEventListener('click', () => {
      gotoTab('reports');
      loadReports();
    });
    root.appendChild(open);
  } else if (summary.kind === 'audit' && summary.totals) {
    root.appendChild(pill('pages ' + (summary.totals.pages ?? 0)));
    root.appendChild(pill('issues ' + (summary.totals.issues ?? 0), summary.totals.issues ? 'bad' : 'good'));
    const sev = summary.totals.bySeverity || {};
    if (sev.Critical) root.appendChild(pill('critical ' + sev.Critical, 'bad'));
    if (sev.High)     root.appendChild(pill('high ' + sev.High, 'bad'));
    if (sev.Medium)   root.appendChild(pill('medium ' + sev.Medium, 'warn'));
    if (sev.Low)      root.appendChild(pill('low ' + sev.Low, 'warn'));
    const open = document.createElement('button');
    open.className = 'link';
    open.textContent = 'open audit report →';
    open.addEventListener('click', () => {
      gotoTab('reports');
      $('#report-frame').src = summary.reportUrl + '?_=' + Date.now();
    });
    root.appendChild(open);
    root.appendChild(makeExportButtons(state.currentRun));
  }

  renderFailures(summary);
  renderPasses(summary);
  renderWalkthroughs(summary);
  renderBugs(summary);
}

// -------- "Bugs" tab — deduplicated bug-report view --------
// Uses `summary.dedupedBugs` from the server: one card per UNIQUE defect with
// a list of affected devices and an expandable per-device screenshot strip.
// Falls back to flattening per-device if the server didn't ship dedupedBugs
// (older summary shape — keeps the UI working through hot-reloads).
function renderBugs(summary) {
  const cont = $('#run-bugs');
  const tabBtn = document.querySelector('#run-tabs button[data-result-tab="bugs"]');
  const countEl = $('#bugs-count');
  if (!cont) return;
  cont.innerHTML = '';
  const walkthroughs = (summary && summary.walkthroughs) || [];

  // Prefer server-side deduped list. If absent, build it client-side so we
  // never regress to the per-device flat list users complained about.
  let bugs = (summary && summary.dedupedBugs) || null;
  if (!bugs) {
    const map = new Map();
    for (const w of walkthroughs) {
      for (const f of (w.findings || [])) {
        const key = [f.severity, f.area, String(f.message || '').replace(/\(\d+\s+nodes?\)/gi, '(N nodes)'), f.element].join('|');
        if (!map.has(key)) {
          map.set(key, { ...f, devices: [], perDevice: [] });
        }
        const e = map.get(key);
        if (!e.devices.includes(w.project)) e.devices.push(w.project);
        e.perDevice.push({ device: w.project, screenshotUrl: f.screenshotUrl || null });
        if (!e.screenshotUrl && f.screenshotUrl) e.screenshotUrl = f.screenshotUrl;
      }
    }
    const order = { Critical: 0, High: 1, Medium: 2, Low: 3, Info: 4 };
    bugs = Array.from(map.values()).sort((a, b) =>
      (order[a.severity] - order[b.severity]) || (b.devices.length - a.devices.length)
    );
  }

  // Hide Bugs tab ONLY when no walkthroughs ran at all.
  if (!walkthroughs.length) {
    cont.hidden = true;
    if (tabBtn) tabBtn.style.display = 'none';
    if (countEl) countEl.textContent = '';
    return;
  }
  if (tabBtn) tabBtn.style.display = '';
  if (countEl) countEl.textContent = bugs.length || '✓';

  // Zero-bug clean-run state
  if (!bugs.length) {
    cont.appendChild(buildHtmlBlock(
      `<div class="bugs-clean">` +
        `<div class="bugs-clean-icon">🎉</div>` +
        `<h3>No bugs found across ${walkthroughs.length} device${walkthroughs.length === 1 ? '' : 's'}</h3>` +
        `<p class="muted">The QA walkthrough ran on every selected device and didn't surface any Critical / High / Medium / Low findings. Check the <strong>Findings</strong> tab for the full walkthrough recording per device, or the <strong>Log</strong> tab for raw output.</p>` +
      `</div>`
    ));
    showResultPane('bugs');
    return;
  }

  const sevColors = { Critical: '#ff2d55', High: '#ff8a00', Medium: '#ffc83a', Low: '#9eb1d8', Info: '#79e29c' };
  const counts = bugs.reduce((acc, b) => ((acc[b.severity] = (acc[b.severity] || 0) + 1), acc), {});
  const totalDeviceHits = bugs.reduce((acc, b) => acc + (b.devices ? b.devices.length : 1), 0);

  const header = document.createElement('div');
  header.className = 'bugs-header';
  header.innerHTML =
    `<h3>${bugs.length} unique bug${bugs.length === 1 ? '' : 's'} across ${walkthroughs.length} device${walkthroughs.length === 1 ? '' : 's'}` +
      ` <span class="muted" style="font-size:13px;font-weight:400;">(${totalDeviceHits} total device hit${totalDeviceHits === 1 ? '' : 's'} — same defect on multiple devices is one card)</span></h3>` +
    `<p class="muted">Each card is one unique defect: clear summary, the page URL where it happens, the broken element selector, the devices where it reproduces, and an annotated screenshot (red box + arrow).</p>` +
    `<div class="bugs-filters">` +
      `<button class="bug-filter active" data-bug-sev="">All (${bugs.length})</button>` +
      ['Critical', 'High', 'Medium', 'Low', 'Info']
        .filter((s) => counts[s])
        .map((s) =>
          `<button class="bug-filter" data-bug-sev="${s}" style="border-color:${sevColors[s]};">` +
          `<span class="bug-filter-dot" style="background:${sevColors[s]}"></span>${s} (${counts[s]})</button>`
        ).join('') +
    `</div>`;
  cont.appendChild(header);

  const list = document.createElement('div');
  list.className = 'bugs-list';
  cont.appendChild(list);

  function renderList(sevFilter) {
    list.innerHTML = '';
    const filtered = sevFilter ? bugs.filter((b) => b.severity === sevFilter) : bugs;
    if (!filtered.length) {
      list.innerHTML = `<p class="muted" style="padding: 20px; text-align: center;">No bugs match this severity.</p>`;
      return;
    }
    filtered.forEach((b, i) => list.appendChild(renderBugCard(b, i + 1, sevColors)));
  }
  renderList('');

  cont.querySelectorAll('.bug-filter').forEach((btn) => {
    btn.addEventListener('click', () => {
      cont.querySelectorAll('.bug-filter').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      renderList(btn.dataset.bugSev);
    });
  });

  showResultPane('bugs');
}

function renderBugCard(bug, idx, sevColors) {
  const card = document.createElement('article');
  card.className = 'bug-card sev-' + (bug.severity || 'Info').toLowerCase();
  const sevColor = sevColors[bug.severity] || '#888';
  const devices = bug.devices || (bug.device ? [bug.device] : []);
  const perDevice = (bug.perDevice || []).filter((p) => p.screenshotUrl);

  // Header: bug-id + severity badge + device count badge
  const head = document.createElement('header');
  head.className = 'bug-head';
  const devCountBadge = devices.length > 1
    ? `<span class="bug-device-count" title="Affected devices">Found on ${devices.length} devices</span>`
    : devices.length === 1
    ? `<span class="bug-device">${escapeHtml(devices[0])}</span>`
    : '';
  head.innerHTML =
    `<span class="bug-id">#${String(idx).padStart(3, '0')}</span>` +
    `<span class="bug-sev" style="background:${sevColor};">${escapeHtml(bug.severity || 'Info')}</span>` +
    devCountBadge;
  card.appendChild(head);

  // Summary (the human-readable bug title)
  const title = document.createElement('h4');
  title.className = 'bug-title';
  title.textContent = bug.message || '(no description)';
  card.appendChild(title);

  // User-impact line — describes what visitors / customers will experience,
  // in plain English, so a non-developer reviewer can read the report.
  if (bug.userImpact) {
    const impact = document.createElement('div');
    impact.className = 'bug-impact';
    impact.innerHTML =
      `<span class="bug-impact-label">What this means for visitors</span>` +
      `<p>${escapeHtml(bug.userImpact)}</p>`;
    card.appendChild(impact);
  }

  // Metadata table
  const meta = document.createElement('div');
  meta.className = 'bug-meta';
  const rows = [];
  if (bug.url) rows.push(`<div><strong>Page</strong><a href="${escapeAttr(bug.url)}" target="_blank" rel="noopener">${escapeHtml(bug.url)}</a></div>`);
  if (bug.element) rows.push(`<div><strong>Element</strong><code>${escapeHtml(bug.element)}</code></div>`);
  if (bug.snippet) rows.push(`<div><strong>HTML</strong><code class="bug-snippet">${escapeHtml(bug.snippet)}</code></div>`);
  if (bug.page) rows.push(`<div><strong>Step</strong>${escapeHtml(bug.page)}</div>`);
  if (bug.area) rows.push(`<div><strong>Area</strong>${escapeHtml(bug.area)}</div>`);
  meta.innerHTML = rows.join('');
  card.appendChild(meta);

  // Device chips — one per device the bug was seen on
  if (devices.length) {
    const chips = document.createElement('div');
    chips.className = 'bug-devices';
    chips.innerHTML =
      `<strong>Devices</strong>` +
      devices.map((d) => `<span class="bug-device-chip">${escapeHtml(d)}</span>`).join('');
    card.appendChild(chips);
  }

  // Suggested fix — pre-line preserves newlines from axe failureSummary
  if (bug.fixHint) {
    const fix = document.createElement('div');
    fix.className = 'bug-fix';
    fix.innerHTML = `<strong>Suggested fix</strong><div style="white-space:pre-line;">${escapeHtml(bug.fixHint)}</div>`;
    card.appendChild(fix);
  }

  // Developer details — raw error / stack trace / axe rule ID, hidden behind
  // a disclosure so a QA / PM / designer reader doesn't have to wade through
  // it. Opens to a monospaced block for developers debugging the issue.
  if (bug.devDetail) {
    const det = document.createElement('details');
    det.className = 'bug-dev-detail';
    const sum = document.createElement('summary');
    sum.textContent = 'Developer details (raw error / stack trace)';
    det.appendChild(sum);
    const pre = document.createElement('pre');
    pre.textContent = bug.devDetail;
    det.appendChild(pre);
    card.appendChild(det);
  }

  // Headline screenshot
  if (bug.screenshotUrl) {
    const shot = document.createElement('figure');
    shot.className = 'bug-shot';
    const img = document.createElement('img');
    img.src = bug.screenshotUrl;
    img.alt = bug.message || '';
    img.loading = 'lazy';
    img.addEventListener('click', () => openLightbox(bug.screenshotUrl, bug.message || ''));
    const cap = document.createElement('figcaption');
    cap.textContent = devices.length > 1
      ? `Red box marks the broken element · annotated screenshot from ${devices[0]} · click to enlarge`
      : 'Red box marks the broken element · red arrow points to it · click to enlarge';
    shot.appendChild(img);
    shot.appendChild(cap);
    card.appendChild(shot);
  }

  // Per-device screenshot accordion (only when the bug reproduces on 2+ devices
  // AND we have multiple distinct screenshots — visual evidence that the bug
  // looks similar/different across viewports).
  if (perDevice.length > 1) {
    const details = document.createElement('details');
    details.className = 'bug-per-device';
    const sum = document.createElement('summary');
    sum.textContent = `See annotated screenshot from each of the ${perDevice.length} affected devices`;
    details.appendChild(sum);
    const grid = document.createElement('div');
    grid.className = 'bug-per-device-grid';
    for (const p of perDevice) {
      const fig = document.createElement('figure');
      fig.className = 'bug-per-device-shot';
      const img = document.createElement('img');
      img.src = p.screenshotUrl;
      img.alt = p.device;
      img.loading = 'lazy';
      img.addEventListener('click', () => openLightbox(p.screenshotUrl, p.device));
      const cap = document.createElement('figcaption');
      cap.textContent = p.device;
      fig.appendChild(img);
      fig.appendChild(cap);
      grid.appendChild(fig);
    }
    details.appendChild(grid);
    card.appendChild(details);
  }

  return card;
}

// -------- Walkthrough findings — the primary "what real QA would see" view --------
function renderWalkthroughs(summary) {
  const cont = $('#run-walkthrough');
  const tabBtn = document.querySelector('#run-tabs button[data-result-tab="walkthrough"]');
  const countEl = $('#walk-count');
  if (!cont) return;
  cont.innerHTML = '';
  const list = (summary && summary.walkthroughs) || [];
  if (!list.length) {
    cont.hidden = true;
    if (tabBtn) tabBtn.style.display = 'none';
    if (countEl) countEl.textContent = '';
    return;
  }
  if (tabBtn) tabBtn.style.display = '';
  const totalFindings = list.reduce((acc, w) => acc + (w.totals?.total || 0), 0);
  if (countEl) countEl.textContent = totalFindings || '';

  const header = document.createElement('div');
  header.className = 'failures-header';
  header.innerHTML =
    `<h3 style="color: var(--tf-blue)">${list.length} QA walkthrough${list.length === 1 ? '' : 's'} · ${totalFindings} finding${totalFindings === 1 ? '' : 's'}</h3>` +
    `<p class="muted" style="margin: 4px 0 0; font-size: 12px;">Each card below is ONE end-to-end session on ONE device. The video is the full recording. Findings are grouped by severity; click any annotated screenshot to enlarge.</p>`;
  cont.appendChild(header);

  for (const w of list) {
    cont.appendChild(renderWalkthroughCard(w));
  }
  showResultPane('walkthrough');
}

function renderWalkthroughCard(w) {
  const card = document.createElement('div');
  card.className = 'failure-card walkthrough-card';
  const sevColors = { Critical: '#ff2d55', High: '#ff8a00', Medium: '#ffc83a', Low: '#9eb1d8', Info: '#79e29c' };
  const sev = w.totals?.bySeverity || {};

  // Header
  const head = document.createElement('div');
  head.className = 'walk-head';
  head.innerHTML =
    `<div class="walk-project">${escapeHtml(w.project)}</div>` +
    `<div class="walk-pills">` +
    ['Critical', 'High', 'Medium', 'Low', 'Info']
      .filter((s) => sev[s])
      .map((s) => `<span class="walk-pill" style="background:${sevColors[s]};">${s} ${sev[s]}</span>`).join('') +
    (w.totals?.total === 0 ? `<span class="walk-pill" style="background:var(--good);color:#051018;">No issues ✓</span>` : '') +
    `</div>`;
  card.appendChild(head);

  // Video — the linear walkthrough recording, if attached.
  // We accept both webm (default Playwright) and mp4 (some headed-Chromium /
  // BS configurations write mp4). Earlier we only matched 'video/webm' which
  // is why the video pane was blank for some runs.
  const video = (w.attachments || []).find((a) => /^video\//.test(a.contentType || '') || /\.(webm|mp4)$/i.test(a.name || ''));
  if (video) {
    const wrap = document.createElement('div');
    wrap.className = 'walk-video-wrap';
    const v = document.createElement('video');
    v.src = video.url;
    v.controls = true;
    v.preload = 'metadata';
    v.playsInline = true;
    v.className = 'walk-video';
    // Diagnostic overlay shown if the video can't be decoded — without this
    // the user just sees a blank box and has no idea what went wrong.
    const status = document.createElement('div');
    status.className = 'walk-video-status';
    status.hidden = true;
    v.addEventListener('error', () => {
      const err = v.error;
      const code = err ? err.code : '?';
      const msg = { 1: 'aborted', 2: 'network', 3: 'decode', 4: 'src-unsupported' }[code] || 'unknown';
      status.hidden = false;
      status.innerHTML =
        `<strong>Video failed to load</strong> · code ${code} (${msg})<br>` +
        `<a href="${escapeAttr(video.url)}" target="_blank" rel="noopener">Open ${escapeHtml(video.name || 'recording')} in a new tab</a> to inspect.`;
    });
    v.addEventListener('loadedmetadata', () => {
      // Mark when metadata loads — if duration is 0 the recording is empty.
      if (!isFinite(v.duration) || v.duration === 0) {
        status.hidden = false;
        status.textContent = `Video metadata loaded but duration is 0:00 — Playwright wrote an empty recording for this test. This usually means the test crashed before the first frame was captured.`;
      }
    });
    wrap.appendChild(v);
    wrap.appendChild(status);
    // Direct-download link below so the user can always get the raw file
    const dl = document.createElement('div');
    dl.className = 'walk-video-meta';
    dl.innerHTML = `<a href="${escapeAttr(video.url)}" download="${escapeAttr(video.name || 'walkthrough.webm')}" target="_blank" rel="noopener">⤓ Download recording (${escapeHtml(video.name || 'walkthrough')})</a>`;
    wrap.appendChild(dl);
    card.appendChild(wrap);
  } else {
    // No video at all — tell the user instead of leaving a silent blank.
    const note = document.createElement('p');
    note.className = 'muted';
    note.style.fontSize = '12px';
    note.style.margin = '6px 0 0';
    note.textContent = 'No video recording was attached for this device. The test may have completed too fast for Playwright to flush the recording, or the run was in a config that doesn\'t record video.';
    card.appendChild(note);
  }

  // Findings grouped by area
  const byArea = {};
  for (const f of (w.findings || [])) {
    (byArea[f.area] = byArea[f.area] || []).push(f);
  }
  const areas = Object.keys(byArea).sort();
  if (!areas.length) {
    const ok = document.createElement('p');
    ok.className = 'muted';
    ok.style.marginTop = '12px';
    ok.textContent = 'No issues recorded during the walkthrough on this device.';
    card.appendChild(ok);
    return card;
  }

  for (const area of areas) {
    const grp = document.createElement('details');
    grp.className = 'walk-area';
    grp.open = true;
    const sum = document.createElement('summary');
    sum.innerHTML = `<strong>${escapeHtml(area)}</strong> <span class="muted">— ${byArea[area].length}</span>`;
    grp.appendChild(sum);
    for (const f of byArea[area]) {
      const row = document.createElement('div');
      row.className = 'walk-finding sev-' + (f.severity || 'Info').toLowerCase();
      row.innerHTML =
        `<div class="walk-line">` +
          `<span class="walk-sev" style="background:${sevColors[f.severity] || '#888'};">${escapeHtml(f.severity || 'Info')}</span> ` +
          `<span class="walk-msg">${escapeHtml(f.message || '')}</span>` +
        `</div>` +
        (f.url ? `<div class="walk-url"><strong>Page:</strong> <a href="${escapeAttr(f.url)}" target="_blank" rel="noopener">${escapeHtml(f.url)}</a></div>` : '') +
        (f.element ? `<div class="walk-el"><strong>Element:</strong> <code>${escapeHtml(f.element)}</code></div>` : '') +
        (f.page ? `<div class="walk-page muted">Step: ${escapeHtml(f.page)}</div>` : '') +
        (f.fixHint ? `<div class="walk-fix"><strong>Suggested fix:</strong> ${escapeHtml(f.fixHint)}</div>` : '');
      // Inline annotated screenshot of THIS specific bug (red-box overlay)
      if (f.screenshotUrl) {
        const fig = document.createElement('figure');
        fig.className = 'walk-shot';
        const img = document.createElement('img');
        img.src = f.screenshotUrl;
        img.alt = f.message || '';
        img.loading = 'lazy';
        img.addEventListener('click', () => openLightbox(f.screenshotUrl, f.message || ''));
        const cap = document.createElement('figcaption');
        cap.textContent = 'Click to enlarge';
        fig.appendChild(img);
        fig.appendChild(cap);
        row.appendChild(fig);
      }
      grp.appendChild(row);
    }
    card.appendChild(grp);
  }

  // Attached screenshots strip
  const imgs = (w.attachments || []).filter((a) => (a.contentType || '').startsWith('image/'));
  if (imgs.length) {
    const strip = document.createElement('div');
    strip.className = 'attachment-strip';
    for (const a of imgs.slice(0, 12)) {
      const fig = document.createElement('figure');
      fig.className = 'attachment-thumb';
      const img = document.createElement('img');
      img.src = a.url;
      img.loading = 'lazy';
      img.alt = a.name;
      img.addEventListener('click', () => openLightbox(a.url, `${a.name} — ${w.project}`));
      fig.appendChild(img);
      const cap = document.createElement('figcaption');
      cap.textContent = a.name.replace(/\.png$/, '');
      fig.appendChild(cap);
      strip.appendChild(fig);
    }
    card.appendChild(strip);
  }
  return card;
}

function renderPasses(summary) {
  const cont = $('#run-passes');
  const tabBtn = document.querySelector('#run-tabs button[data-result-tab="passes"]');
  const countEl = $('#pass-count');
  if (!cont) return;
  cont.innerHTML = '';
  const passes = (summary && summary.passes) || [];
  if (passes.length === 0) {
    cont.hidden = true;
    if (tabBtn) tabBtn.style.display = 'none';
    if (countEl) countEl.textContent = '';
    return;
  }
  if (tabBtn) tabBtn.style.display = '';
  if (countEl) countEl.textContent = passes.length;

  // Group by project, mirror the failures layout
  const byProject = groupBy(passes, (p) => p.project || '(no project)');
  const header = document.createElement('div');
  header.className = 'failures-header';
  header.innerHTML =
    `<h3 style="color: var(--good)">${passes.length} test${passes.length === 1 ? '' : 's'} passed</h3>` +
    `<p class="muted" style="margin: 4px 0 0; font-size: 12px;">Each successful test has a recorded video + final-state screenshot. Click any thumbnail to enlarge.</p>`;
  cont.appendChild(header);

  for (const proj of Object.keys(byProject).sort()) {
    const group = document.createElement('details');
    group.className = 'failure-group';
    group.open = false; // collapse passing groups by default
    const list = byProject[proj];
    const sum = document.createElement('summary');
    sum.innerHTML =
      `<span class="project-name">${escapeHtml(proj)}</span>` +
      `<span class="muted">— ${list.length} passed</span>`;
    group.appendChild(sum);
    for (const p of list) group.appendChild(renderPassCard(p));
    cont.appendChild(group);
  }
}

function renderPassCard(p) {
  const card = document.createElement('div');
  card.className = 'failure-card';
  card.style.borderLeftColor = 'var(--good)';
  card.style.background = 'rgba(121,226,156,0.04)';

  const title = document.createElement('div');
  title.className = 'failure-title';
  title.textContent = '✓ ' + (p.title || '(unnamed)');
  title.style.color = 'var(--good)';
  card.appendChild(title);

  if (p.file) {
    const file = document.createElement('div');
    file.className = 'failure-file';
    file.textContent = p.file + ' · ' + Math.round((p.duration || 0)) + 'ms';
    card.appendChild(file);
  }

  const imgs = (p.attachments || []).filter((a) => (a.contentType || '').startsWith('image/'));
  const videos = (p.attachments || []).filter((a) => a.contentType === 'video/webm');

  if (imgs.length || videos.length) {
    const strip = document.createElement('div');
    strip.className = 'attachment-strip';
    for (const a of imgs) {
      const fig = document.createElement('figure');
      fig.className = 'attachment-thumb';
      const img = document.createElement('img');
      img.src = a.url;
      img.alt = a.name;
      img.loading = 'lazy';
      img.addEventListener('click', () => openLightbox(a.url, `${a.name} — ${p.project} — ${p.title}`));
      fig.appendChild(img);
      const cap = document.createElement('figcaption');
      cap.textContent = a.name || 'screenshot';
      fig.appendChild(cap);
      strip.appendChild(fig);
    }
    for (const a of videos) {
      const v = document.createElement('video');
      v.src = a.url;
      v.controls = true;
      v.className = 'attachment-video';
      strip.appendChild(v);
    }
    card.appendChild(strip);
  }
  return card;
}

function pill(text, mod = '') {
  const span = document.createElement('span');
  span.className = `pill ${mod}`.trim();
  span.textContent = text;
  return span;
}

// -------- Export buttons (CSV / XLSX / PDF) --------
function makeExportButtons(runId) {
  const wrap = document.createElement('span');
  wrap.className = 'export-buttons';
  wrap.style.marginLeft = '8px';
  if (!runId) return wrap;

  const formats = [
    { format: 'csv',  label: 'CSV',  title: 'Download failures as CSV' },
    { format: 'xlsx', label: 'XLSX', title: 'Download as Excel workbook (Summary + Failures sheets)' },
    { format: 'pdf',  label: 'PDF',  title: 'Open print-friendly view (Ctrl+P → Save as PDF)' },
  ];
  for (const f of formats) {
    const btn = document.createElement('button');
    btn.className = 'link export-btn';
    btn.textContent = '↓ ' + f.label;
    btn.title = f.title;
    btn.addEventListener('click', () => {
      const url = `/api/runs/${runId}/export?format=${f.format}`;
      if (f.format === 'pdf') {
        window.open(url, '_blank', 'noopener');
      } else {
        const a = document.createElement('a');
        a.href = url;
        a.download = '';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      }
    });
    wrap.appendChild(btn);
  }
  return wrap;
}

// -------- Failure cards with inline screenshots --------
function renderFailures(summary) {
  const cont = $('#run-failures');
  const tabs = $('#run-tabs');
  const count = $('#failure-count');
  if (!cont) return;
  cont.innerHTML = '';

  const failures = (summary && summary.failures) || [];
  if (failures.length === 0) {
    cont.hidden = true;
    if (tabs) tabs.hidden = true;
    showResultPane('log');
    return;
  }
  if (tabs) tabs.hidden = false;
  if (count) count.textContent = failures.length;

  // Group by project (if backend didn't provide it, build it client-side).
  const byProject = summary.byProject || groupBy(failures, (f) => f.project || '(no project)');

  // Header
  const header = document.createElement('div');
  header.className = 'failures-header';
  header.innerHTML =
    `<h3>${failures.length} failure${failures.length === 1 ? '' : 's'} grouped by project</h3>` +
    `<p class="muted" style="margin: 4px 0 0; font-size: 12px;">Click any thumbnail to enlarge. For visual regression: <span class="legend-dot good"></span>expected · <span class="legend-dot accent"></span>actual · <span class="legend-dot bad"></span>diff.</p>`;
  cont.appendChild(header);

  const projects = Object.keys(byProject).sort();
  for (const proj of projects) {
    const group = document.createElement('details');
    group.className = 'failure-group';
    group.open = true;
    const projFails = byProject[proj];

    const sum = document.createElement('summary');
    sum.innerHTML =
      `<span class="project-name">${escapeHtml(proj)}</span>` +
      `<span class="muted">— ${projFails.length} failure${projFails.length === 1 ? '' : 's'}</span>`;
    group.appendChild(sum);

    for (const f of projFails) group.appendChild(renderFailureCard(f));
    cont.appendChild(group);
  }

  // Auto-switch to the Failures pane so the user sees them right away.
  showResultPane('failures');
}

function renderFailureCard(f) {
  const card = document.createElement('div');
  card.className = 'failure-card';

  const title = document.createElement('div');
  title.className = 'failure-title';
  title.textContent = f.title || '(unnamed test)';
  card.appendChild(title);

  if (f.file) {
    const file = document.createElement('div');
    file.className = 'failure-file';
    file.textContent = f.file;
    card.appendChild(file);
  }

  // Most useful single line for a tester: which page / which selector.
  // Surface it before the stack-trace so it doesn't get buried.
  const ctxBits = [];
  if (f.pageUrl) ctxBits.push(`<strong>Page:</strong> <a href="${escapeAttr(f.pageUrl)}" target="_blank" rel="noopener">${escapeHtml(f.pageUrl)}</a>`);
  if (f.viewport) ctxBits.push(`<strong>Viewport:</strong> ${escapeHtml(f.viewport)}`);
  if (f.failingStep) ctxBits.push(`<strong>Where it broke:</strong> ${escapeHtml(f.failingStep)}`);
  if (f.failingLocator) ctxBits.push(`<strong>Selector:</strong> <code>${escapeHtml(f.failingLocator)}</code>`);
  if (ctxBits.length) {
    const ctx = document.createElement('div');
    ctx.className = 'failure-context';
    ctx.innerHTML = ctxBits.join(' &nbsp;·&nbsp; ');
    card.appendChild(ctx);
  }

  // If the failure has parsed findings (walkthrough spec), render them
  // INLINE as a bug-report-style list BEFORE the raw stack trace. Each
  // finding gets its annotated screenshot inline (when available) so it
  // reads as a real bug card: severity + summary + page + element + fix +
  // visual proof.
  if (f.parsedFindings && Array.isArray(f.parsedFindings.findings) && f.parsedFindings.findings.length) {
    const wrap = document.createElement('div');
    wrap.className = 'failure-findings';
    const sevColors = { Critical: '#ff2d55', High: '#ff8a00', Medium: '#ffc83a', Low: '#9eb1d8', Info: '#79e29c' };
    const sev = f.parsedFindings.bySeverity || {};
    const header = document.createElement('div');
    header.className = 'failure-findings-header';
    header.innerHTML =
      `<strong>${f.parsedFindings.total} finding${f.parsedFindings.total === 1 ? '' : 's'} from this walkthrough</strong> &nbsp; ` +
      ['Critical', 'High', 'Medium', 'Low', 'Info']
        .filter((s) => sev[s])
        .map((s) => `<span class="fc-pill" style="background:${sevColors[s]};">${s} ${sev[s]}</span>`)
        .join('') +
      (f.parsedFindings.findingsFileUrl
        ? ` &nbsp; <a class="fc-download" href="${escapeAttr(f.parsedFindings.findingsFileUrl)}" target="_blank" rel="noopener" download="findings.json">↓ Download findings.json</a>`
        : '');
    wrap.appendChild(header);

    // Group by area
    const byArea = {};
    for (const fnd of f.parsedFindings.findings) (byArea[fnd.area] = byArea[fnd.area] || []).push(fnd);
    for (const area of Object.keys(byArea).sort()) {
      const grp = document.createElement('details');
      grp.className = 'failure-findings-group';
      grp.open = true;
      const sum = document.createElement('summary');
      sum.innerHTML = `<strong>${escapeHtml(area)}</strong> <span class="muted">(${byArea[area].length})</span>`;
      grp.appendChild(sum);
      for (const fnd of byArea[area]) {
        const row = document.createElement('div');
        row.className = 'fc-finding';
        // Bug card: severity badge + summary + meta block + inline screenshot
        let html =
          `<div class="fc-line">` +
            `<span class="fc-sev" style="background:${sevColors[fnd.severity] || '#888'};">${escapeHtml(fnd.severity || 'Info')}</span> ` +
            `<span class="fc-msg">${escapeHtml(fnd.message || '')}</span>` +
          `</div>` +
          (fnd.url ? `<div class="fc-meta"><strong>Page:</strong> <a href="${escapeAttr(fnd.url)}" target="_blank" rel="noopener">${escapeHtml(fnd.url)}</a></div>` : '') +
          (fnd.element ? `<div class="fc-meta"><strong>Element:</strong> <code>${escapeHtml(fnd.element)}</code></div>` : '') +
          (fnd.page ? `<div class="fc-meta muted">Step: ${escapeHtml(fnd.page)}</div>` : '') +
          (fnd.fixHint ? `<div class="fc-fix"><strong>Suggested fix:</strong> ${escapeHtml(fnd.fixHint)}</div>` : '');
        row.innerHTML = html;
        // Append the annotated screenshot (red-box overlay) inline if we have one
        if (fnd.screenshotUrl) {
          const fig = document.createElement('figure');
          fig.className = 'fc-shot';
          const img = document.createElement('img');
          img.src = fnd.screenshotUrl;
          img.alt = fnd.message || 'bug screenshot';
          img.loading = 'lazy';
          img.addEventListener('click', () => openLightbox(fnd.screenshotUrl, fnd.message || ''));
          const cap = document.createElement('figcaption');
          cap.textContent = 'Click to enlarge';
          fig.appendChild(img);
          fig.appendChild(cap);
          row.appendChild(fig);
        }
        grp.appendChild(row);
      }
      wrap.appendChild(grp);
    }
    card.appendChild(wrap);
  }

  if (f.error) {
    const err = document.createElement('pre');
    err.className = 'failure-error';
    err.textContent = f.error;
    card.appendChild(err);
  }

  const imgAttachments = (f.attachments || []).filter(
    (a) => a.contentType && a.contentType.startsWith('image/')
  );
  const videoAttachments = (f.attachments || []).filter((a) => a.contentType === 'video/webm');

  if (imgAttachments.length) {
    const strip = document.createElement('div');
    strip.className = 'attachment-strip';
    // Sort so visual-regression images appear in expected → actual → diff order.
    const sortKey = (a) => /expected/i.test(a.name) ? 0 : /actual/i.test(a.name) ? 1 : /diff/i.test(a.name) ? 2 : 3;
    imgAttachments.sort((a, b) => sortKey(a) - sortKey(b));

    for (const a of imgAttachments) {
      const fig = document.createElement('figure');
      fig.className = 'attachment-thumb';
      if (/expected/i.test(a.name)) fig.classList.add('att-expected');
      else if (/actual/i.test(a.name)) fig.classList.add('att-actual');
      else if (/diff/i.test(a.name)) fig.classList.add('att-diff');

      const img = document.createElement('img');
      img.src = a.url;
      img.alt = a.name;
      img.loading = 'lazy';
      img.addEventListener('click', () =>
        openLightbox(a.url, `${a.name} — ${f.project} — ${f.title}`)
      );
      fig.appendChild(img);

      const caption = document.createElement('figcaption');
      caption.textContent = a.name || 'screenshot';
      fig.appendChild(caption);

      strip.appendChild(fig);
    }
    card.appendChild(strip);
  }

  if (videoAttachments.length) {
    const vstrip = document.createElement('div');
    vstrip.className = 'attachment-strip';
    for (const a of videoAttachments) {
      const v = document.createElement('video');
      v.src = a.url;
      v.controls = true;
      v.className = 'attachment-video';
      vstrip.appendChild(v);
    }
    card.appendChild(vstrip);
  }

  return card;
}

function groupBy(arr, keyFn) {
  const out = {};
  for (const item of arr) {
    const k = keyFn(item) || '(unknown)';
    (out[k] = out[k] || []).push(item);
  }
  return out;
}

// -------- Result tabs (Bugs / Walkthrough / Log / Failures / Passes) --------
function showResultPane(which) {
  $('#run-log').hidden = which !== 'log';
  $('#run-failures').hidden = which !== 'failures' || !$('#run-failures').children.length;
  const passesEl = $('#run-passes');
  if (passesEl) passesEl.hidden = which !== 'passes' || !passesEl.children.length;
  const walkEl = $('#run-walkthrough');
  if (walkEl) walkEl.hidden = which !== 'walkthrough' || !walkEl.children.length;
  const bugsEl = $('#run-bugs');
  if (bugsEl) bugsEl.hidden = which !== 'bugs' || !bugsEl.children.length;
  document.querySelectorAll('#run-tabs button').forEach((b) => {
    b.classList.toggle('active', b.dataset.resultTab === which);
  });
}
document.querySelectorAll('#run-tabs button').forEach((b) => {
  b.addEventListener('click', () => showResultPane(b.dataset.resultTab));
});

// -------- Lightbox --------
function openLightbox(url, caption) {
  const lb = document.createElement('div');
  lb.className = 'lightbox';
  lb.innerHTML =
    `<div class="lightbox-inner">` +
    `<button class="lightbox-close" aria-label="Close">×</button>` +
    `<img src="${escapeAttr(url)}" alt="" />` +
    `<div class="lightbox-caption">${escapeHtml(caption || '')}</div>` +
    `</div>`;
  function close() {
    try { document.body.removeChild(lb); } catch {}
    document.removeEventListener('keydown', keyHandler);
  }
  function keyHandler(e) { if (e.key === 'Escape') close(); }
  lb.addEventListener('click', (e) => {
    if (e.target === lb || e.target.classList.contains('lightbox-close')) close();
  });
  document.addEventListener('keydown', keyHandler);
  document.body.appendChild(lb);
}
function escapeAttr(s) { return String(s).replace(/"/g, '&quot;'); }

// -------- Reports --------
async function loadReports() {
  const r = await fetch('/api/reports');
  const data = await r.json();
  const controls = $('#reports-controls');
  controls.innerHTML = '';

  // Build a unified, time-sorted list. The most recent run goes first, audit
  // entries get site + issue-count chips, all rows show "X min ago".
  const rows = [];
  if (data.playwright) {
    rows.push({ kind: 'playwright', label: 'Playwright HTML report', url: data.playwright, time: data.playwrightTime || 0 });
  }
  for (const a of data.audit || []) {
    rows.push({
      kind: 'audit',
      label: 'Site audit',
      site: (a.sites || []).join(', ') || a.name,
      issueCount: a.totalIssues,
      pageCount: a.totalPages,
      url: a.url,
      time: a.time,
      raw: a.name,
    });
  }
  for (const lh of data.lighthouse || []) {
    rows.push({ kind: 'lighthouse', label: 'Lighthouse', site: lh.name, url: lh.url, time: lh.time || 0 });
  }
  rows.sort((a, b) => b.time - a.time);

  if (rows.length === 0) {
    controls.innerHTML = '<span class="muted">No reports yet — run something on the Run tab.</span>';
    $('#report-frame').src = 'about:blank';
    return;
  }

  // Group by site for audit + lighthouse; Playwright is global (one report per project root).
  const grouped = new Map(); // siteKey → array
  for (const row of rows) {
    const key = row.site || (row.kind === 'playwright' ? '_playwright' : '_other');
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }

  for (const [siteKey, list] of grouped) {
    const group = document.createElement('div');
    group.className = 'reports-group';
    const heading = document.createElement('div');
    heading.className = 'reports-group-title';
    heading.textContent = siteKey === '_playwright' ? 'Playwright (all projects)' : siteKey === '_other' ? 'Other' : siteKey;
    group.appendChild(heading);

    for (const row of list) {
      const btn = document.createElement('button');
      btn.className = 'report-row';
      const ago = row.time ? ` <span class="muted">· ${formatAgo(row.time)}</span>` : '';
      const detail =
        row.kind === 'audit'
          ? ` <span class="muted">· ${row.pageCount ?? '?'} pages, ${row.issueCount ?? '?'} issues</span>`
          : '';
      btn.innerHTML = `<strong>${escapeHtml(row.label)}</strong>${detail}${ago}`;
      if (row.kind === 'audit') {
        btn.classList.add('report-row-audit');
      }
      btn.addEventListener('click', () => {
        $('#report-frame').src = row.url + '?_=' + Date.now();
        document.querySelectorAll('.report-row.active').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
      });
      group.appendChild(btn);
    }
    controls.appendChild(group);
  }

  // Auto-load the most recent report (top of the sorted list).
  const newest = rows[0];
  $('#report-frame').src = newest.url + '?_=' + Date.now();
  const firstBtn = controls.querySelector('.report-row');
  if (firstBtn) firstBtn.classList.add('active');
}

// "5m ago" / "2h ago" / "3 days ago" — short relative time.
function formatAgo(ts) {
  if (!ts) return '';
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86_400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86_400) + 'd ago';
}
$('#btn-refresh-reports').addEventListener('click', loadReports);

// -------- History --------
async function loadHistory() {
  const r = await fetch('/api/runs');
  const runs = await r.json();
  const tbody = $('#history-rows');
  tbody.innerHTML = '';
  for (const run of runs) {
    const tr = document.createElement('tr');
    const when = new Date(run.started).toLocaleString();
    const dur = run.ended ? Math.round((run.ended - run.started) / 1000) + 's' : 'running…';
    tr.innerHTML = `
      <td>${when}<br><span class="muted">${dur}</span></td>
      <td>${(run.testIds || []).join(', ')}</td>
      <td>${(run.sites || []).join(', ') || '<span class="muted">all</span>'}</td>
      <td><span class="muted">${(run.projects || []).length} project(s)</span></td>
      <td><span class="pill ${run.status === 'passed' ? 'good' : run.status === 'failed' ? 'bad' : 'warn'}">${run.status}</span></td>
      <td><button class="link" data-id="${run.id}">view log</button></td>
    `;
    tr.querySelector('button').addEventListener('click', () => {
      document.querySelector('[data-tab="run"]').click();
      streamRun(run.id);
    });
    tbody.appendChild(tr);
  }
}
$('#btn-refresh-history').addEventListener('click', loadHistory);

// -------- Sites editor --------
function renderSitesEditor() {
  const tbody = $('#sites-rows');
  tbody.innerHTML = '';
  for (const s of state.sites) addSiteRow(s);
}
function addSiteRow(s = { name: '', url: '', expectedTitleIncludes: '', smokeSelectors: [] }) {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><input type="text" data-k="name"  value="${escapeHtml(s.name || '')}" /></td>
    <td><input type="url"  data-k="url"   value="${escapeHtml(s.url || '')}" /></td>
    <td><input type="text" data-k="title" value="${escapeHtml(s.expectedTitleIncludes || '')}" /></td>
    <td><input type="text" data-k="sel"   value="${escapeHtml((s.smokeSelectors || []).join(', '))}" /></td>
    <td><button class="link" type="button">remove</button></td>
  `;
  tr.querySelector('button').addEventListener('click', () => tr.remove());
  $('#sites-rows').appendChild(tr);
}
$('#btn-add-site').addEventListener('click', () => addSiteRow());

// -------- Discover pages from sitemap --------
$('#btn-discover').addEventListener('click', async () => {
  const url = $('#discover-url').value.trim();
  const results = $('#discover-results');
  if (!url) { alert('Enter a homepage URL first.'); return; }
  results.hidden = false;
  results.innerHTML = '<div class="muted" style="padding: 8px 0;">Reading sitemap…</div>';
  try {
    const r = await fetch('/api/sites/discover', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    renderDiscovery(data, url);
  } catch (e) {
    results.innerHTML = `<div class="banner banner-warn" style="display: block;">Failed to discover: ${escapeHtml(e.message)}</div>`;
  }
});

function renderDiscovery(data, baseUrl) {
  const results = $('#discover-results');
  const urls = data.urls || [];
  if (urls.length === 0) {
    results.innerHTML = '<div class="muted">No URLs found.</div>';
    return;
  }
  const methodLabel = data.method === 'sitemap'
    ? `Found <strong>${urls.length}</strong> pages via <code>sitemap.xml</code>`
    : data.method === 'crawl-homepage'
      ? `Sitemap unavailable; found <strong>${urls.length}</strong> links from the homepage`
      : `Only the homepage URL is available`;

  let html = `
    <div class="discover-result-header">
      ${methodLabel}.
      <button class="link" id="btn-discover-toggle-all">toggle all</button>
    </div>
    <div class="discover-list">`;
  for (const u of urls) {
    const slug = guessName(u, baseUrl);
    html += `
      <label class="discover-row">
        <input type="checkbox" checked data-url="${escapeHtml(u)}" data-name="${escapeHtml(slug)}" />
        <span class="discover-name">${escapeHtml(slug)}</span>
        <span class="discover-url muted">${escapeHtml(u)}</span>
      </label>`;
  }
  html += `</div>
    <div class="control-row" style="margin-top: 12px;">
      <button class="primary" id="btn-discover-add" style="width: auto; margin: 0;">+ Add selected to sites</button>
      <span id="discover-status" class="muted"></span>
    </div>`;
  results.innerHTML = html;

  $('#btn-discover-toggle-all').addEventListener('click', () => {
    const inputs = results.querySelectorAll('input[type=checkbox]');
    const someUnchecked = Array.from(inputs).some((i) => !i.checked);
    inputs.forEach((i) => (i.checked = someUnchecked));
  });
  $('#btn-discover-add').addEventListener('click', () => {
    const picks = Array.from(results.querySelectorAll('input[type=checkbox]:checked')).map((i) => ({
      name: i.dataset.name,
      url: i.dataset.url,
    }));
    // Avoid duplicates with existing rows
    const existingUrls = new Set(
      $$('#sites-rows input[data-k="url"]').map((i) => i.value.trim()).filter(Boolean)
    );
    let added = 0;
    for (const p of picks) {
      if (existingUrls.has(p.url)) continue;
      addSiteRow({ name: p.name, url: p.url });
      added++;
    }
    $('#discover-status').textContent = `Added ${added} new site${added === 1 ? '' : 's'}. Press Save to persist.`;
  });
}

function guessName(url, baseUrl) {
  try {
    const u = new URL(url);
    const base = new URL(baseUrl);
    if (u.pathname === '/' || u.pathname === '') return 'Home';
    const seg = u.pathname.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
    const last = seg[seg.length - 1] || 'page';
    return last
      .replace(/[-_]+/g, ' ')
      .replace(/\.[a-z]{2,4}$/i, '')
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .slice(0, 60);
  } catch {
    return url.slice(-60);
  }
}
$('#btn-save-sites').addEventListener('click', async () => {
  const rows = $$('#sites-rows tr').map((tr) => {
    const get = (k) => tr.querySelector(`input[data-k="${k}"]`).value.trim();
    const sel = get('sel');
    return {
      name: get('name'),
      url: get('url'),
      expectedTitleIncludes: get('title') || undefined,
      smokeSelectors: sel ? sel.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
    };
  }).filter((s) => s.name && s.url);
  const r = await fetch('/api/sites', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sites: rows }),
  });
  if (r.ok) {
    $('#save-status').textContent = 'saved ✓';
    state.sites = rows;
    // Re-render the Run-tab Sites checkbox list with no defaults.
    checkboxList($('#sites-list'), state.sites, (s) => s.name, (s) => `${s.name} — ${s.url}`);
    setTimeout(() => ($('#save-status').textContent = ''), 2000);
  } else {
    $('#save-status').textContent = 'save failed';
  }
});
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

// -------- Guide tab — card / hero / step actions --------
function _scrollIntoView(sel) {
  const el = typeof sel === 'string' ? $(sel) : sel;
  if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
function _flash(sel) {
  const el = typeof sel === 'string' ? $(sel) : sel;
  if (!el) return;
  el.classList.add('flash-highlight');
  setTimeout(() => el.classList.remove('flash-highlight'), 1600);
}

const GUIDE_ACTIONS = {
  quickstart: () => {
    gotoTab('sites');
    setTimeout(() => {
      const f = $('#discover-url');
      f?.focus();
      _scrollIntoView('.discover-block');
      _flash('.discover-block');
    }, 150);
  },
  audit: () => {
    gotoTab('run');
    setTimeout(() => {
      setMatching('types-list', (id) => id === 'audit');
      applyAuditExclusivity();
      applyOptionsContext();
      _scrollIntoView('#types-list');
      _flash('#types-list');
    }, 120);
  },
  types: () => {
    // Scroll to the actual Test types checkbox list on the Run tab, not the raw API JSON.
    gotoTab('run');
    setTimeout(() => { _scrollIntoView('#types-list'); _flash('#types-list'); }, 120);
  },
  'local-vs-bs': () => {
    gotoTab('run');
    setTimeout(() => {
      $('#config-select')?.focus();
      _scrollIntoView('#config-select');
      _flash('#config-select');
    }, 120);
  },
  'bs-catalog': () => {
    const panel = $('#bs-catalog-panel');
    if (panel) {
      panel.hidden = false;
      setTimeout(() => _scrollIntoView(panel), 120);
      if (!$('#bs-catalog-list').dataset.loaded) loadBsCatalog();
    }
  },
  webflow: () => {
    gotoTab('run');
    setTimeout(() => {
      setMatching('types-list', (id) => id === 'webflow');
      applyAuditExclusivity();
      applyOptionsContext();
      _scrollIntoView('#types-list');
      _flash('#types-list');
    }, 120);
  },
  reports: () => gotoTab('reports'),
  'bs-creds': () => {
    gotoTab('run');
    setTimeout(() => {
      const sel = $('#config-select');
      if (sel) {
        sel.value = 'browserstack';
        state.configFile = 'browserstack';
        loadProjects();
        refreshCredsBanner();
        _scrollIntoView('#bs-creds-banner');
        _flash('#bs-creds-banner');
      }
    }, 120);
  },
  'self-check': () => alert(
    'In your terminal, from the project root, run:\n\n' +
    '    npm run check\n\n' +
    'You will see green ✓ / yellow ! / red ✗ for each part of the setup (Node version, deps, Playwright browsers, configs, every spec file, BrowserStack credentials, dashboard boot).'
  ),
  docs: () => {
    // Open the Markdown viewer in a new tab — it loads ONBOARDING.md by default.
    window.open('/docs/', '_blank', 'noopener');
  },
};

// Bind EVERY element with data-action inside the Guide tab — hero buttons,
// numbered-step "→" links AND the capability cards. Earlier we only caught
// .guide-card elements, so hero CTAs and step links did nothing on click.
document.querySelectorAll('#tab-guide [data-action]').forEach((el) => {
  el.addEventListener('click', (e) => {
    e.preventDefault();
    const fn = GUIDE_ACTIONS[el.dataset.action];
    if (fn) fn();
  });
});

// -------- BrowserStack catalog (live from REST API) --------
async function loadBsCatalog() {
  const list = $('#bs-catalog-list');
  const status = $('#bs-catalog-status');
  status.textContent = 'loading…';
  list.innerHTML = '';
  try {
    const r = await fetch('/api/browserstack/devices');
    const data = await r.json();
    if (!data.ok) { status.textContent = '✗ ' + (data.message || 'error'); return; }
    list.dataset.loaded = '1';
    status.textContent = `${data.entries.length} combinations available`;
    state.bsCatalog = data.entries;
    renderBsCatalog();
  } catch (e) {
    status.textContent = '✗ ' + e.message;
  }
}
function renderBsCatalog() {
  const list = $('#bs-catalog-list');
  const filter = $('#bs-catalog-filter').value.toLowerCase();
  const rows = (state.bsCatalog || [])
    .filter((e) => !filter || JSON.stringify(e).toLowerCase().includes(filter))
    .slice(0, 500); // cap for sanity
  list.innerHTML = rows.map((e) => `
    <div class="bs-catalog-row">
      <span class="bs-os">${escapeHtml(e.os || '—')} ${escapeHtml(e.os_version || '')}</span>
      <span class="bs-device">${escapeHtml(e.device || '(desktop)')}</span>
      <span class="bs-version">${escapeHtml(e.browser || '')} ${escapeHtml(e.browser_version || '')}</span>
      <span class="bs-real">${e.real_mobile ? 'real device' : ''}</span>
    </div>
  `).join('');
}
$('#bs-catalog-filter')?.addEventListener('input', renderBsCatalog);
$('#btn-load-bs-catalog')?.addEventListener('click', loadBsCatalog);

// -------- Back-to-top floating button --------
// Result panes (Bugs / Findings / Failures) can grow long after a multi-device
// run, so we surface a small fixed-position FAB once the user scrolls past ~one
// viewport. Clicking it smooth-scrolls back to the very top. Threshold and
// behavior intentionally simple — no on-scroll throttling library, just a
// passive listener and a CSS class toggle.
(function installBackToTop() {
  const btn = $('#back-to-top');
  if (!btn) return;

  // Reveal once the user has scrolled past this many pixels. A bit less than
  // a typical viewport so the button shows up early on long reports.
  const THRESHOLD = 400;

  function update() {
    const y = window.scrollY || document.documentElement.scrollTop || 0;
    if (y > THRESHOLD) {
      btn.hidden = false;            // unhide so the transition can run
      // Defer the class flip one frame so the browser registers the
      // "from hidden" state before transitioning into is-visible.
      requestAnimationFrame(() => btn.classList.add('is-visible'));
    } else {
      btn.classList.remove('is-visible');
      // Wait for the fade-out transition (~220ms) before re-hiding.
      setTimeout(() => {
        if (!btn.classList.contains('is-visible')) btn.hidden = true;
      }, 260);
    }
  }

  window.addEventListener('scroll', update, { passive: true });
  window.addEventListener('resize', update);

  btn.addEventListener('click', () => {
    // Use smooth scroll when supported; fall back to instant for older
    // browsers without the option-object form of scrollTo.
    try {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch {
      window.scrollTo(0, 0);
    }
    // Optimistic hide — the scroll listener will reconcile.
    btn.classList.remove('is-visible');
  });

  // Initial check in case the page loaded already scrolled (e.g. after a
  // hash navigation or browser-restored scroll position).
  update();
})();

// -------- Boot --------
(async function init() {
  await loadSites();
  await loadTestTypes();
  await loadProjects();
  refreshCredsBanner();
})();
