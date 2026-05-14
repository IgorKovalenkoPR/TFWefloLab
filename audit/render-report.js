// @ts-check
/**
 * Renders a self-contained Screaming Frog-style HTML report from the
 * structured JSON produced by audit.js.
 *
 * The report has:
 *   - Top: pages crawled, total issues, by-severity / by-category breakdowns
 *   - Filterable issues table (severity, category, type, page, free-text)
 *   - Per-page detail panel with screenshot + per-page findings
 *
 * No external dependencies — everything is inlined so the report works
 * standalone (you can email it).
 */

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderReportHtml(report) {
  const sevOrder = { Critical: 0, High: 1, Medium: 2, Low: 3, Info: 4 };
  const sevColor = {
    Critical: '#c62828',
    High: '#ef6c00',
    Medium: '#fbc02d',
    Low: '#8e8e8e',
    Info: '#1976d2',
  };

  // Flat list of issues with page reference for filtering
  const allIssues = [];
  report.pages.forEach((p, pi) => {
    p.findings.forEach((f, fi) => {
      allIssues.push({ ...f, pageIndex: pi, issueIndex: fi });
    });
  });
  allIssues.sort((a, b) => (sevOrder[a.severity] - sevOrder[b.severity]) || a.category.localeCompare(b.category));

  // Build sets for filter dropdowns
  const allCategories = Array.from(new Set(allIssues.map((i) => i.category))).sort();
  const allTypes = Array.from(new Set(allIssues.map((i) => i.type))).sort();
  const allPages = report.pages.map((p) => p.url);

  // ---------- Embed report data so client-side JS can filter ----------
  const dataJson = JSON.stringify({
    pages: report.pages.map((p) => ({
      url: p.url,
      title: p.title,
      site: p.site,
      status: p.status,
      screenshot: p.screenshot,
      issueCount: p.findings.length,
      issues: p.findings.map((f) => ({
        type: f.type,
        severity: f.severity,
        category: f.category,
        message: f.message,
        expected: f.expected,
        actual: f.actual,
        selector: f.selector,
      })),
    })),
    totals: report.totals,
    sevColor,
    sevOrder,
  })
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e');

  // ---------- Top cards ----------
  const sevCards = ['Critical', 'High', 'Medium', 'Low', 'Info']
    .map((sev) => {
      const n = report.totals.bySeverity[sev] || 0;
      return `
        <div class="card sev-card" data-sev="${esc(sev)}">
          <div class="card-num" style="color: ${sevColor[sev]};">${n}</div>
          <div class="card-label">${sev}</div>
        </div>`;
    })
    .join('');

  const categoryRows = Object.entries(report.totals.byCategory || {})
    .sort((a, b) => b[1] - a[1])
    .map(
      ([cat, n]) => `
      <tr><td>${esc(cat)}</td><td class="num">${n}</td></tr>`
    )
    .join('');

  const typeRows = Object.entries(report.totals.byType || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .map(([t, n]) => `<tr><td>${esc(t)}</td><td class="num">${n}</td></tr>`)
    .join('');

  // ---------- Inline CSS ----------
  const css = `
    *, *::before, *::after { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      color: #1c1f26; background: #f7f8fb; margin: 0; padding: 24px 32px;
    }
    h1 { font-size: 24px; margin: 0 0 4px; }
    h2 { font-size: 16px; margin: 24px 0 10px; color: #374151; }
    .meta { color: #5e6470; font-size: 13px; margin-bottom: 20px; }

    .top-grid {
      display: grid;
      grid-template-columns: 2fr 1.2fr 1.4fr;
      gap: 16px;
      margin-bottom: 20px;
    }
    .panel { background: white; border: 1px solid #e1e4eb; border-radius: 10px; padding: 14px 16px; }
    .panel h3 { margin: 0 0 8px; font-size: 12px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.05em; }

    .cards { display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px; }
    .card { padding: 10px; text-align: center; border-radius: 8px; background: #f3f4f6; cursor: pointer; transition: transform 0.1s ease; }
    .card:hover { transform: translateY(-2px); }
    .card.active { outline: 2px solid #1976d2; }
    .card-num { font-size: 28px; font-weight: 700; }
    .card-label { font-size: 11px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.05em; }

    table.mini { width: 100%; border-collapse: collapse; font-size: 13px; }
    table.mini td { padding: 4px 8px; border-bottom: 1px solid #f1f3f7; }
    table.mini td.num { text-align: right; font-variant-numeric: tabular-nums; color: #4b5563; font-weight: 600; }

    .toolbar {
      display: flex; gap: 10px; flex-wrap: wrap; align-items: center;
      background: white; border: 1px solid #e1e4eb; border-radius: 10px;
      padding: 10px 14px; margin-bottom: 12px;
    }
    .toolbar label { font-size: 12px; color: #6b7280; display: flex; align-items: center; gap: 6px; }
    .toolbar select, .toolbar input[type=text] {
      padding: 5px 8px; border: 1px solid #d1d5db; border-radius: 5px; font-size: 13px;
    }
    .toolbar input[type=text] { min-width: 200px; }
    .toolbar .clear { background: transparent; border: none; color: #1976d2; cursor: pointer; font-size: 12px; }
    .toolbar .count { margin-left: auto; color: #6b7280; font-size: 12px; }

    table.issues { width: 100%; border-collapse: collapse; font-size: 13px; background: white; border: 1px solid #e1e4eb; border-radius: 10px; overflow: hidden; }
    table.issues thead th { background: #f9fafb; padding: 10px; text-align: left; font-size: 12px; color: #4b5563; text-transform: uppercase; letter-spacing: 0.05em; cursor: pointer; user-select: none; border-bottom: 1px solid #e1e4eb; }
    table.issues tbody td { padding: 10px; border-bottom: 1px solid #f1f3f7; vertical-align: top; }
    table.issues tbody tr:hover { background: #f9fafb; }
    table.issues tbody tr.expanded { background: #eef6ff; }
    table.issues tbody tr.expanded td { background: #eef6ff; }

    .sev-pill { display: inline-block; padding: 2px 8px; border-radius: 4px; color: white; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }
    .cat-pill { display: inline-block; padding: 2px 8px; border-radius: 4px; background: #eef2f7; color: #4b5563; font-size: 11px; }
    .url-cell { font-family: ui-monospace, monospace; font-size: 12px; color: #1976d2; word-break: break-all; max-width: 380px; }
    .type-cell { font-family: ui-monospace, monospace; font-size: 12px; color: #6b7280; }
    pre.expand { background: #fafafa; border: 1px solid #e5e7eb; border-radius: 4px; padding: 8px 10px; margin: 4px 0 0; font-family: ui-monospace, monospace; font-size: 11.5px; white-space: pre-wrap; word-break: break-word; max-height: 240px; overflow: auto; }
    pre.expand.expected { background: #f1f8e9; border-color: #c5e1a5; color: #2e7d32; }
    pre.expand.actual   { background: #ffebee; border-color: #ef9a9a; color: #c62828; }

    .detail-row td { padding: 0 !important; }
    .detail { display: grid; grid-template-columns: 220px 1fr; gap: 12px; padding: 12px 14px; background: #fbfbfd; border-top: 1px solid #f1f3f7; }
    .detail .shot img { width: 220px; border: 1px solid #e1e4eb; border-radius: 4px; cursor: zoom-in; background: white; }
    .detail .info h4 { margin: 0 0 4px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; color: #6b7280; }

    .lightbox { position: fixed; inset: 0; background: rgba(0,0,0,0.85); display: flex; align-items: center; justify-content: center; z-index: 999; padding: 24px; }
    .lightbox img { max-width: 95vw; max-height: 95vh; box-shadow: 0 20px 60px rgba(0,0,0,0.6); border-radius: 6px; background: white; }
    .lightbox .close-x { position: absolute; top: 16px; right: 24px; color: white; font-size: 32px; cursor: pointer; background: none; border: none; }

    @media print {
      body { padding: 0 12px; background: white; }
      .toolbar { display: none; }
      table.issues thead th { cursor: default; }
      .detail-row { display: none; } /* keep print compact */
    }
  `;

  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" />
<title>Site Audit — ${esc(report.runId)}</title>
<style>${css}</style>
</head><body>
  <h1>Site Audit Report</h1>
  <div class="meta">
    <strong>Run:</strong> <code>${esc(report.runId)}</code> ·
    <strong>Started:</strong> ${esc(report.started)} ·
    <strong>Pages crawled:</strong> ${report.totals.pages} ·
    <strong>Issues found:</strong> ${report.totals.issues} ·
    <strong>Profile:</strong> ${esc(report.deviceProfile)} ·
    <strong>Duration:</strong> ${(report.durationMs / 1000).toFixed(1)}s
  </div>

  <div class="top-grid">
    <div class="panel">
      <h3>Severity breakdown</h3>
      <div class="cards">${sevCards}</div>
    </div>
    <div class="panel">
      <h3>By category</h3>
      <table class="mini"><tbody>${categoryRows || '<tr><td>No issues 🎉</td></tr>'}</tbody></table>
    </div>
    <div class="panel">
      <h3>Top issue types</h3>
      <table class="mini"><tbody>${typeRows || '<tr><td>No issues</td></tr>'}</tbody></table>
    </div>
  </div>

  <h2>All issues</h2>
  <div class="toolbar">
    <label>Severity:
      <select id="filter-sev">
        <option value="">all</option>
        <option>Critical</option><option>High</option><option>Medium</option><option>Low</option><option>Info</option>
      </select>
    </label>
    <label>Category:
      <select id="filter-cat">
        <option value="">all</option>
        ${allCategories.map((c) => `<option>${esc(c)}</option>`).join('')}
      </select>
    </label>
    <label>Type:
      <select id="filter-type">
        <option value="">all</option>
        ${allTypes.map((t) => `<option>${esc(t)}</option>`).join('')}
      </select>
    </label>
    <label>Page:
      <select id="filter-page">
        <option value="">all</option>
        ${allPages.map((u) => `<option value="${esc(u)}">${esc(u)}</option>`).join('')}
      </select>
    </label>
    <input type="text" id="filter-text" placeholder="Search messages…" />
    <button class="clear" id="clear-filters">Clear filters</button>
    <span class="count" id="match-count"></span>
  </div>

  <table class="issues" id="issues-table">
    <thead>
      <tr>
        <th data-sort="severity" style="width: 96px;">Severity</th>
        <th data-sort="category" style="width: 160px;">Category</th>
        <th data-sort="type" style="width: 200px;">Type</th>
        <th>Message</th>
        <th data-sort="page" style="width: 280px;">Page</th>
      </tr>
    </thead>
    <tbody id="issues-tbody"></tbody>
  </table>

  <h2>Pages</h2>
  <table class="issues">
    <thead>
      <tr>
        <th>URL</th>
        <th style="width: 100px;">Status</th>
        <th style="width: 140px;">Issues</th>
        <th>Title</th>
      </tr>
    </thead>
    <tbody>
      ${report.pages
        .map((p) => {
          const sevs = p.findings.reduce((acc, f) => ((acc[f.severity] = (acc[f.severity] || 0) + 1), acc), {});
          const sevStr = ['Critical', 'High', 'Medium', 'Low']
            .filter((s) => sevs[s])
            .map((s) => `<span class="sev-pill" style="background:${sevColor[s]};margin-right:4px;">${s} ${sevs[s]}</span>`)
            .join('');
          const statusOk = p.status >= 200 && p.status < 400;
          return `<tr>
            <td><a href="${esc(p.url)}" target="_blank" rel="noopener" class="url-cell">${esc(p.url)}</a></td>
            <td style="color: ${statusOk ? '#2e7d32' : '#c62828'}; font-weight: 600;">${esc(p.status || '—')}</td>
            <td>${sevStr || '<span style="color:#2e7d32">none ✓</span>'}</td>
            <td style="color:#4b5563; font-size: 12px;">${esc((p.title || '').slice(0, 80))}</td>
          </tr>`;
        })
        .join('')}
    </tbody>
  </table>

  <script>
    const DATA = ${dataJson};
    const tbody = document.getElementById('issues-tbody');
    let sortKey = 'severity';
    let sortAsc = true;

    function flat() {
      const out = [];
      DATA.pages.forEach((p, pi) => {
        p.issues.forEach((iss, ii) => {
          out.push({
            ...iss,
            pageUrl: p.url,
            pageTitle: p.title,
            pageStatus: p.status,
            screenshot: p.screenshot,
            pageIdx: pi,
            issueIdx: ii,
          });
        });
      });
      return out;
    }

    function applyFilters(arr) {
      const sev = document.getElementById('filter-sev').value;
      const cat = document.getElementById('filter-cat').value;
      const typ = document.getElementById('filter-type').value;
      const page = document.getElementById('filter-page').value;
      const text = document.getElementById('filter-text').value.toLowerCase();
      return arr.filter((it) => {
        if (sev && it.severity !== sev) return false;
        if (cat && it.category !== cat) return false;
        if (typ && it.type !== typ) return false;
        if (page && it.pageUrl !== page) return false;
        if (text) {
          const hay = (it.message + ' ' + (it.actual || '') + ' ' + (it.expected || '')).toLowerCase();
          if (!hay.includes(text)) return false;
        }
        return true;
      });
    }

    function sort(arr) {
      arr.sort((a, b) => {
        let av, bv;
        if (sortKey === 'severity') {
          av = DATA.sevOrder[a.severity]; bv = DATA.sevOrder[b.severity];
        } else if (sortKey === 'page') {
          av = a.pageUrl; bv = b.pageUrl;
        } else {
          av = a[sortKey] || ''; bv = b[sortKey] || '';
        }
        if (av < bv) return sortAsc ? -1 : 1;
        if (av > bv) return sortAsc ? 1 : -1;
        return 0;
      });
      return arr;
    }

    function escAttr(s) { return String(s).replace(/"/g, '&quot;'); }
    function escHtml(s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function render() {
      const filtered = sort(applyFilters(flat()));
      document.getElementById('match-count').textContent =
        filtered.length + ' / ' + DATA.totals.issues + ' issues';
      const rows = filtered.map((it, idx) => {
        const sevColor = DATA.sevColor[it.severity] || '#888';
        const expected = it.expected ? '<h4>Expected</h4><pre class="expand expected">' + escHtml(it.expected) + '</pre>' : '';
        const actual   = it.actual   ? '<h4>Actual</h4><pre class="expand actual">' + escHtml(it.actual)   + '</pre>' : '';
        const screenshotEl = it.screenshot
          ? '<div class="shot"><img loading="lazy" src="' + escAttr(it.screenshot) + '" onclick="openLightbox(this.src)" /></div>'
          : '<div class="shot"><div style="width:220px;height:140px;background:#f3f4f6;border:1px solid #e1e4eb;border-radius:4px;display:flex;align-items:center;justify-content:center;color:#9ca3af;font-size:12px;">no screenshot</div></div>';
        return (
          '<tr class="row" data-i="' + idx + '">'
            + '<td><span class="sev-pill" style="background:' + sevColor + ';">' + escHtml(it.severity) + '</span></td>'
            + '<td><span class="cat-pill">' + escHtml(it.category) + '</span></td>'
            + '<td class="type-cell">' + escHtml(it.type) + '</td>'
            + '<td>' + escHtml(it.message) + '</td>'
            + '<td><a class="url-cell" href="' + escAttr(it.pageUrl) + '" target="_blank" rel="noopener">' + escHtml(it.pageUrl) + '</a></td>'
          + '</tr>'
          + '<tr class="detail-row" data-detail="' + idx + '" style="display:none;">'
            + '<td colspan="5"><div class="detail">'
              + screenshotEl
              + '<div class="info">'
                + '<h4>Page</h4><div>' + escHtml(it.pageTitle || '') + '<br><a class="url-cell" href="' + escAttr(it.pageUrl) + '" target="_blank" rel="noopener">' + escHtml(it.pageUrl) + '</a></div>'
                + expected + actual
              + '</div>'
            + '</div></td>'
          + '</tr>'
        );
      }).join('');
      tbody.innerHTML = rows || '<tr><td colspan="5" style="padding:24px;text-align:center;color:#6b7280;">No issues match the current filters.</td></tr>';
      // Wire up row toggles
      tbody.querySelectorAll('tr.row').forEach((row) => {
        row.addEventListener('click', () => {
          const i = row.dataset.i;
          const detail = tbody.querySelector('tr.detail-row[data-detail="' + i + '"]');
          if (detail) {
            const isOpen = detail.style.display !== 'none';
            detail.style.display = isOpen ? 'none' : '';
            row.classList.toggle('expanded', !isOpen);
          }
        });
      });
    }

    // Filter wiring
    ['filter-sev', 'filter-cat', 'filter-type', 'filter-page', 'filter-text'].forEach((id) => {
      document.getElementById(id).addEventListener('input', render);
    });
    document.getElementById('clear-filters').addEventListener('click', () => {
      document.getElementById('filter-sev').value = '';
      document.getElementById('filter-cat').value = '';
      document.getElementById('filter-type').value = '';
      document.getElementById('filter-page').value = '';
      document.getElementById('filter-text').value = '';
      render();
    });

    // Severity card → quick filter
    document.querySelectorAll('.sev-card').forEach((c) => {
      c.addEventListener('click', () => {
        document.getElementById('filter-sev').value = c.dataset.sev;
        document.querySelectorAll('.sev-card').forEach((x) => x.classList.remove('active'));
        c.classList.add('active');
        render();
        document.getElementById('issues-table').scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });

    // Sort wiring
    document.querySelectorAll('table.issues thead th[data-sort]').forEach((th) => {
      th.addEventListener('click', () => {
        const k = th.dataset.sort;
        if (sortKey === k) sortAsc = !sortAsc; else { sortKey = k; sortAsc = true; }
        render();
      });
    });

    // Lightbox
    function openLightbox(src) {
      const lb = document.createElement('div');
      lb.className = 'lightbox';
      lb.innerHTML = '<button class="close-x" aria-label="Close">×</button><img src="' + src + '" />';
      lb.addEventListener('click', (e) => { if (e.target === lb || e.target.classList.contains('close-x')) lb.remove(); });
      document.body.appendChild(lb);
    }
    window.openLightbox = openLightbox;

    render();
  </script>
</body></html>`;

  return html;
}

module.exports = { renderReportHtml };
