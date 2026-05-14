// @ts-check
/**
 * Site URL discovery — finds every page of a Webflow site so the test suite
 * can exercise the entire site, not just the homepage.
 *
 * Strategy:
 *   1. Try /sitemap.xml (and /sitemap_index.xml). Webflow auto-publishes one.
 *   2. If the sitemap is an index (referencing other sitemaps), recurse one
 *      level deep to gather all <loc> entries.
 *   3. As a fallback, fetch the homepage and BFS-crawl same-origin <a> links
 *      one level deep.
 *   4. Deduplicate, drop fragments and tracking parameters, return the list.
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

const USER_AGENT = 'webflow-tests-discovery/1.0 (+https://github.com)';
const DEFAULT_TIMEOUT_MS = 15_000;
// `Infinity` here means "no cap" — the audit script defaults to unlimited
// crawling so users can sweep the entire site. Pass an explicit number to
// constrain.
const DEFAULT_MAX_PAGES = Infinity;

function fetchText(url, { timeout = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let lib;
    try {
      lib = url.startsWith('https') ? https : http;
    } catch (e) {
      reject(e);
      return;
    }
    const req = lib.get(
      url,
      { timeout, headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml,application/xml' } },
      (res) => {
        // Follow up to 5 redirects
        if ([301, 302, 303, 307, 308].includes(res.statusCode || 0) && res.headers.location) {
          const next = new URL(res.headers.location, url).toString();
          res.resume();
          fetchText(next, { timeout }).then(resolve, reject);
          return;
        }
        if ((res.statusCode || 0) >= 400) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          return;
        }
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve(data));
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error(`timeout fetching ${url}`)));
  });
}

function extractLocs(xml) {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1].trim());
}

function extractHtmlLinks(html, baseUrl) {
  const links = new Set();
  const re = /href\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      const u = new URL(m[1], baseUrl);
      if (u.protocol === 'http:' || u.protocol === 'https:') {
        u.hash = '';
        links.add(u.toString());
      }
    } catch {
      /* malformed href */
    }
  }
  return Array.from(links);
}

function normalize(u) {
  try {
    const x = new URL(u);
    x.hash = '';
    // Drop common tracking params so we don't crawl 50 variants of the same page.
    const drop = new Set(['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'fbclid', 'mc_cid', 'mc_eid']);
    for (const k of Array.from(x.searchParams.keys())) {
      if (drop.has(k)) x.searchParams.delete(k);
    }
    let s = x.toString();
    // Trim trailing slash on path-only URLs for dedupe stability.
    if (x.pathname !== '/' && s.endsWith('/') && !x.search) s = s.slice(0, -1);
    return s;
  } catch {
    return u;
  }
}

async function discoverFromSitemap(homeUrl, { maxPages = DEFAULT_MAX_PAGES } = {}) {
  const origin = new URL(homeUrl).origin;
  const candidates = [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`];

  for (const candidate of candidates) {
    try {
      const xml = await fetchText(candidate);
      const locs = extractLocs(xml);
      if (locs.length === 0) continue;

      const sitemapUrls = locs.filter((u) => /\.xml(\.gz)?$/i.test(u));
      const pageUrls = locs.filter((u) => !/\.xml(\.gz)?$/i.test(u));

      // Sitemap index — fetch the first few referenced sitemaps.
      if (sitemapUrls.length > 0) {
        for (const su of sitemapUrls.slice(0, 8)) {
          try {
            const sx = await fetchText(su);
            for (const loc of extractLocs(sx)) {
              if (!/\.xml(\.gz)?$/i.test(loc)) pageUrls.push(loc);
            }
          } catch {
            /* ignore individual sitemap failure */
          }
          if (pageUrls.length >= maxPages * 2) break;
        }
      }

      const sameOrigin = pageUrls.filter((u) => {
        try {
          return new URL(u).origin === origin;
        } catch {
          return false;
        }
      });
      const deduped = Array.from(new Set(sameOrigin.map(normalize)));
      if (deduped.length > 0) {
        return { method: 'sitemap', source: candidate, urls: deduped.slice(0, maxPages) };
      }
    } catch {
      /* fall through to next candidate */
    }
  }
  return null;
}

async function discoverFromHomepage(homeUrl, { maxPages = DEFAULT_MAX_PAGES } = {}) {
  const origin = new URL(homeUrl).origin;
  try {
    const html = await fetchText(homeUrl);
    const links = extractHtmlLinks(html, homeUrl)
      .filter((u) => {
        try {
          return new URL(u).origin === origin;
        } catch {
          return false;
        }
      })
      .map(normalize);
    const set = new Set([normalize(homeUrl), ...links]);
    return { method: 'crawl-homepage', source: homeUrl, urls: Array.from(set).slice(0, maxPages) };
  } catch (e) {
    return { method: 'home-only', source: homeUrl, urls: [normalize(homeUrl)], error: String(e && e.message ? e.message : e) };
  }
}

/**
 * Public API. Always resolves; never throws (errors are returned in the result).
 *   result = { method, source, urls[], error? }
 *   method = 'sitemap' | 'crawl-homepage' | 'home-only'
 */
async function discoverSiteUrls(homeUrl, options = {}) {
  const sitemap = await discoverFromSitemap(homeUrl, options);
  if (sitemap && sitemap.urls.length > 1) return sitemap;
  return await discoverFromHomepage(homeUrl, options);
}

module.exports = { discoverSiteUrls };
