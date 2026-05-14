#!/usr/bin/env node
/**
 * Lighthouse audit runner.
 * Runs Lighthouse against every URL from config/urls.json on both desktop and
 * mobile form factors, asserts minimum thresholds, and writes HTML + JSON
 * reports under ./lighthouse/reports/.
 *
 * Usage:
 *   npm run test:performance
 *
 * Thresholds can be overridden via env, e.g.:
 *   LH_MIN_PERF=80 LH_MIN_A11Y=95 npm run test:performance
 */
const fs = require('fs');
const path = require('path');
const url = require('url');

const REPORTS_DIR = path.resolve(__dirname, 'reports');
const URLS_PATH = path.resolve(__dirname, '..', 'config', 'urls.json');

const THRESHOLDS = {
  performance: Number(process.env.LH_MIN_PERF || 70),
  accessibility: Number(process.env.LH_MIN_A11Y || 90),
  'best-practices': Number(process.env.LH_MIN_BP || 85),
  seo: Number(process.env.LH_MIN_SEO || 90),
};

const VITALS_BUDGETS = {
  // Per Google CWV recommendations.
  'largest-contentful-paint': 2500,   // ms
  'cumulative-layout-shift': 0.1,
  'total-blocking-time': 200,         // ms (lab proxy for INP)
  'first-contentful-paint': 1800,     // ms
};

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

async function runOne(targetUrl, formFactor, chromeFlags) {
  const lighthouse = (await import('lighthouse')).default;
  const chromeLauncher = await import('chrome-launcher');
  const chrome = await chromeLauncher.launch({ chromeFlags });

  try {
    const opts = {
      logLevel: 'error',
      output: ['html', 'json'],
      onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'],
      port: chrome.port,
      formFactor,
      screenEmulation:
        formFactor === 'mobile'
          ? { mobile: true, width: 412, height: 823, deviceScaleFactor: 1.75, disabled: false }
          : { mobile: false, width: 1920, height: 1080, deviceScaleFactor: 1, disabled: false },
      throttling:
        formFactor === 'mobile'
          ? { rttMs: 150, throughputKbps: 1638.4, cpuSlowdownMultiplier: 4 }
          : { rttMs: 40, throughputKbps: 10240, cpuSlowdownMultiplier: 1 },
    };

    const runnerResult = await lighthouse(targetUrl, opts);
    return runnerResult;
  } finally {
    await chrome.kill();
  }
}

function summarize(lhr) {
  const cat = (id) => Math.round((lhr.categories[id]?.score ?? 0) * 100);
  const audit = (id) => lhr.audits[id]?.numericValue ?? null;
  return {
    scores: {
      performance: cat('performance'),
      accessibility: cat('accessibility'),
      'best-practices': cat('best-practices'),
      seo: cat('seo'),
    },
    metrics: {
      'first-contentful-paint': audit('first-contentful-paint'),
      'largest-contentful-paint': audit('largest-contentful-paint'),
      'cumulative-layout-shift': audit('cumulative-layout-shift'),
      'total-blocking-time': audit('total-blocking-time'),
      'speed-index': audit('speed-index'),
    },
  };
}

function checkThresholds(siteName, formFactor, summary) {
  const failures = [];
  for (const [k, min] of Object.entries(THRESHOLDS)) {
    if (summary.scores[k] < min) {
      failures.push(`${k} ${summary.scores[k]} < ${min}`);
    }
  }
  for (const [k, max] of Object.entries(VITALS_BUDGETS)) {
    const v = summary.metrics[k];
    if (v != null && v > max) {
      failures.push(`${k} ${Math.round(v * 1000) / 1000} > ${max}`);
    }
  }
  return failures;
}

async function main() {
  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const config = JSON.parse(fs.readFileSync(URLS_PATH, 'utf8'));
  const sites = (config.sites || []).filter((s) => s && s.url);
  if (sites.length === 0) {
    console.error('[lighthouse] No sites configured in config/urls.json');
    process.exit(1);
  }

  const baseFlags = ['--headless=new', '--no-sandbox', '--disable-gpu'];
  const allFailures = [];

  for (const site of sites) {
    for (const formFactor of ['desktop', 'mobile']) {
      const label = `${site.name || site.url} [${formFactor}]`;
      process.stdout.write(`> Auditing ${label}\n`);
      let runner;
      try {
        runner = await runOne(site.url, formFactor, baseFlags);
      } catch (e) {
        console.error(`  ! Lighthouse failed: ${e.message}`);
        allFailures.push({ site: label, error: e.message });
        continue;
      }
      const lhr = runner.lhr;
      const summary = summarize(lhr);
      const failures = checkThresholds(site.name, formFactor, summary);

      const base = `${slug(site.name || new URL(site.url).hostname)}-${formFactor}`;
      fs.writeFileSync(path.join(REPORTS_DIR, `${base}.html`), runner.report[0]);
      fs.writeFileSync(path.join(REPORTS_DIR, `${base}.json`), runner.report[1]);
      fs.writeFileSync(
        path.join(REPORTS_DIR, `${base}.summary.json`),
        JSON.stringify({ url: site.url, formFactor, summary, failures }, null, 2)
      );

      const scoreLine = Object.entries(summary.scores)
        .map(([k, v]) => `${k}=${v}`)
        .join(' ');
      const vitalsLine = Object.entries(summary.metrics)
        .map(([k, v]) => `${k}=${v == null ? 'n/a' : Math.round(v * 100) / 100}`)
        .join(' ');
      console.log(`  scores  : ${scoreLine}`);
      console.log(`  metrics : ${vitalsLine}`);

      if (failures.length) {
        console.log(`  FAIL    : ${failures.join('; ')}`);
        allFailures.push({ site: label, failures });
      } else {
        console.log(`  OK`);
      }
    }
  }

  console.log('');
  console.log(`Reports written to ${path.relative(process.cwd(), REPORTS_DIR)}`);
  if (allFailures.length) {
    console.error('\nFailures:');
    console.error(JSON.stringify(allFailures, null, 2));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
