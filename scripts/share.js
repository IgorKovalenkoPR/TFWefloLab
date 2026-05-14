// @ts-check
/**
 * Expose the local TFWefloLab dashboard to the internet via a public HTTPS
 * tunnel, so QA teammates working from elsewhere can reach it.
 *
 *   1. Start the dashboard in one terminal:   npm run dashboard
 *   2. Start the tunnel  in another terminal: npm run share
 *
 * Pre-flight checks (refuses to expose anything unsafe):
 *   * TFWEFLOLAB_PASS must be set in .env. Without it the dashboard has no
 *     auth — putting that on the internet would be irresponsible.
 *   * The dashboard must already be listening on PORT (we ping /api/health
 *     to verify).
 *
 * Tunnel back-ends, in order of preference:
 *   1. cloudflared (Cloudflare Tunnel) — gives a free *.trycloudflare.com
 *      URL with zero signup. Recommended.
 *   2. ngrok                          — falls back if cloudflared is missing.
 *
 * If neither tool is installed we print clean, copy-pasteable install
 * instructions for Windows / macOS / Linux and exit.
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const ENV_PATH = path.join(ROOT, '.env');
const PORT = Number(process.env.PORT || 3000);

const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;

function fail(msg, hint) {
  console.error(`\n  ${red('×')} ${msg}`);
  if (hint) console.error(`    ${dim(hint)}`);
  console.error('');
  process.exit(1);
}

// ── .env preload (same shape as server/server.js loadEnvFile) ──────────
function loadEnvFile() {
  if (!fs.existsSync(ENV_PATH)) return;
  const lines = fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined || process.env[key] === '') {
      process.env[key] = val;
    }
  }
}
loadEnvFile();

// ── 1. Auth must be set ────────────────────────────────────────────────
function checkAuth() {
  const pass = process.env.TFWEFLOLAB_PASS;
  const off  = process.env.TFWEFLOLAB_NO_AUTH === '1';
  if (off) {
    fail(
      'TFWEFLOLAB_NO_AUTH=1 is set — auth is disabled.',
      'Cannot expose an unauthenticated dashboard to the internet. Remove the flag from .env and restart the dashboard.'
    );
  }
  if (!pass) {
    fail(
      'TFWEFLOLAB_PASS is not set — auth is disabled.',
      'Open .env, set TFWEFLOLAB_PASS=<your-password>, restart `npm run dashboard`, then re-run `npm run share`.'
    );
  }
  console.log(`  ${green('✓')} Auth is enabled (user: ${bold(process.env.TFWEFLOLAB_USER || 'tfweflolab')})`);
}

// ── 2. Dashboard must be running ───────────────────────────────────────
function checkDashboard() {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${PORT}/api/health`, { timeout: 1500 }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => {
        if (res.statusCode === 200 && body.includes('"ok":true')) {
          console.log(`  ${green('✓')} Dashboard is up on localhost:${PORT}`);
          resolve(true);
        } else {
          resolve(false);
        }
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

// ── 3. Locate a tunnel tool ────────────────────────────────────────────
function which(cmd) {
  // Cross-platform "is this binary on PATH". We try both with and without
  // the .exe / .cmd suffix that Windows uses.
  const exts = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
  const sep  = process.platform === 'win32' ? ';' : ':';
  const dirs = (process.env.PATH || '').split(sep);
  for (const dir of dirs) {
    for (const ext of exts) {
      const full = path.join(dir, cmd + ext);
      try { if (fs.existsSync(full)) return full; } catch {}
    }
  }
  return null;
}

function printInstallInstructions() {
  console.log(`\n  ${yellow('!')} No tunnel tool is installed yet. Pick one:\n`);
  console.log(`  ${bold('Cloudflare Tunnel')} ${dim('(recommended — free, no signup for quick tunnels)')}`);
  console.log(`    ${cyan('Windows')}  winget install --id Cloudflare.cloudflared`);
  console.log(`    ${cyan('macOS')}    brew install cloudflared`);
  console.log(`    ${cyan('Linux')}    https://pkg.cloudflare.com/  (apt / yum repos available)\n`);
  console.log(`  ${bold('ngrok')} ${dim('(fallback — requires free signup at ngrok.com)')}`);
  console.log(`    ${cyan('Windows')}  winget install --id Ngrok.Ngrok`);
  console.log(`    ${cyan('macOS')}    brew install ngrok/ngrok/ngrok`);
  console.log(`    ${cyan('Linux')}    https://ngrok.com/download`);
  console.log(`    ${dim('then once:')}  ngrok config add-authtoken <your-token>\n`);
  console.log(`  After installing, re-run ${cyan('npm run share')}.\n`);
}

// ── 4. Supervised spawn — auto-restart on unexpected exit ──────────────
// All three tunnel back-ends (cloudflared, ngrok, localtunnel) lose their
// connection from time to time: idle WebSockets drop, DNS hiccups, free
// tunnel services rotate servers, etc. Manually re-running `npm run share`
// after every drop is annoying, so we wrap the child in a supervisor:
//
//   * on graceful Ctrl+C    → exit cleanly, no restart
//   * on unexpected exit    → wait `backoff(attempts)` ms, then respawn
//   * on URL-printed event  → reset the attempt counter (we know the
//                              tunnel reached "healthy")
//   * after N attempts      → give up so a hopeless config doesn't spin
//                              forever in a tight respawn loop
//
// Backoff is exponential, capped at 30 s. After the tunnel runs healthy
// for >2 min, the counter resets — so a single drop after a long uptime
// doesn't push us toward the give-up limit.
function superviseSpawn(opts) {
  // opts: {
  //   label:     string   — tool name for messages
  //   makeArgs:  () => ({ bin, args, shell? })
  //   parseUrl:  (txt) => string | null
  //   deadHint?: string   — printed if the child dies before a URL
  //   extraNote?: string  — passed to printShareBox (localtunnel warning)
  // }
  let currentProc = null;
  let userStopping = false;
  let attempts = 0;
  let lastStartedAt = 0;
  // Keep-alive pinger lifetime is coupled to this single spawn. We store
  // its stop-function here so we can cancel it on respawn or Ctrl+C —
  // otherwise pings to a dead URL would keep firing in the background.
  let stopKeepAlive = null;
  const MAX_ATTEMPTS = 12;

  const start = () => {
    lastStartedAt = Date.now();
    const { bin, args, shell = false } = opts.makeArgs();
    currentProc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], shell });

    let urlPrinted = false;
    const handle = (chunk) => {
      const txt = chunk.toString();
      if (!urlPrinted) {
        const url = opts.parseUrl(txt);
        if (url) {
          urlPrinted = true;
          // Reset attempts here — once we have a working URL, we know the
          // tool authenticated / negotiated / etc. successfully. Future
          // drops are "tunnel was healthy then lost connection", which is
          // exactly the case we want to absorb.
          attempts = 0;
          printShareBox(url, { extraNote: opts.extraNote });
          // Start the keep-alive pinger. Sends an authenticated request
          // every 60 s to keep loca.lt's idle-disconnect timer from firing,
          // and force-kills the child after 5 consecutive ping failures so
          // the supervisor respawns it (handles the "process alive but
          // tunnel dead" failure mode, which `exit` never catches).
          stopKeepAlive = keepAlivePing(url, () => {
            if (currentProc) currentProc.kill('SIGTERM');
          });
          return; // swallow the banner line we just absorbed
        }
      }
      // Stream raw output dim-colored so the user sees progress / errors
      // without it competing with our own banners.
      process.stdout.write(dim(txt));
    };
    currentProc.stdout.on('data', handle);
    currentProc.stderr.on('data', handle);

    currentProc.on('exit', (code) => {
      const exited = currentProc;
      currentProc = null;
      // Stop pinging a URL that's about to become stale. The next spawn
      // will start a fresh pinger after its own URL is detected.
      if (stopKeepAlive) { stopKeepAlive(); stopKeepAlive = null; }
      if (userStopping) {
        // Ctrl+C path: exit with the child's code, no restart.
        process.exit(code || 0);
        return;
      }
      // If the child ran "healthy" for >2 min before dying, treat this as
      // a single-event drop and reset the counter so a hopeless start
      // earlier doesn't poison a long-running session.
      const ranFor = Date.now() - lastStartedAt;
      if (ranFor > 120_000) attempts = 0;
      attempts++;

      if (attempts > MAX_ATTEMPTS) {
        console.error(`\n  ${red('×')} ${opts.label} kept exiting — ${MAX_ATTEMPTS} consecutive failures.`);
        if (opts.deadHint) console.error(`    ${dim(opts.deadHint)}`);
        console.error(`    ${dim('Press Ctrl+C and investigate, then re-run `npm run share`.')}\n`);
        process.exit(code || 1);
      }

      // Exponential backoff: 1, 2, 4, 8, 16, 30, 30, … (capped 30 s).
      const wait = Math.min(30_000, 1000 * Math.pow(2, Math.min(attempts - 1, 5)));
      const reason = urlPrinted
        ? `tunnel dropped (was healthy for ${Math.round(ranFor / 1000)} s)`
        : `${opts.label} exited (code ${code}) before producing a URL`;
      console.log(
        `\n  ${yellow('↻')} ${reason} — reconnecting in ${Math.round(wait / 1000)} s ` +
        `${dim(`(attempt ${attempts}/${MAX_ATTEMPTS})`)}\n`
      );
      setTimeout(start, wait);
    });
  };

  // ONE pair of signal handlers, owned by the supervisor. Each respawn
  // uses currentProc as the live target so signals always hit the right
  // child even after restarts.
  const onStop = (sig) => {
    userStopping = true;
    // Cancel any pending keep-alive pings so Node can exit cleanly even
    // if a fetch is in flight.
    if (stopKeepAlive) { stopKeepAlive(); stopKeepAlive = null; }
    if (currentProc) currentProc.kill(sig);
    else process.exit(0);
  };
  process.on('SIGINT',  () => onStop('SIGINT'));
  process.on('SIGTERM', () => onStop('SIGTERM'));

  start();
}

// ── 4a. Cloudflare quick-tunnel ────────────────────────────────────────
function runCloudflared(bin) {
  console.log(`\n  ${green('▶')} Starting cloudflared quick-tunnel to localhost:${PORT}…`);
  console.log(`  ${dim('(this can take 5–15 s — Cloudflare needs to assign a subdomain)')}`);
  console.log(`  ${dim('Auto-restart is on: if the tunnel drops, it will reconnect automatically.')}\n`);
  // cloudflared mentions trycloudflare.com twice in its log:
  //   1. api.trycloudflare.com               — control endpoint, NOT the user URL
  //   2. <random-words>.trycloudflare.com    — the actual public URL
  // Match only #2 (subdomain must contain a hyphen; api.* is excluded via negative lookahead).
  const URL_RE = /https:\/\/(?!api\.)([a-z0-9]+(?:-[a-z0-9]+)+)\.trycloudflare\.com/i;
  superviseSpawn({
    label: 'cloudflared',
    makeArgs: () => ({ bin, args: ['tunnel', '--url', `http://localhost:${PORT}`] }),
    parseUrl: (txt) => { const m = txt.match(URL_RE); return m ? m[0] : null; },
    deadHint: 'Common cause: no internet, or cloudflared was killed by the OS.',
  });
}

// ── 4b. ngrok ──────────────────────────────────────────────────────────
function runNgrok(bin, subdomain) {
  console.log(`\n  ${green('▶')} Starting ngrok tunnel to localhost:${PORT}…`);
  console.log(`  ${dim('Auto-restart is on: if the tunnel drops, it will reconnect automatically.')}\n`);
  if (subdomain) {
    console.log(`  ${yellow('!')} ${dim('Custom subdomains require a paid ngrok plan; free accounts will error.')}\n`);
  }
  superviseSpawn({
    label: 'ngrok',
    makeArgs: () => {
      const args = ['http', String(PORT), '--log=stdout'];
      if (subdomain) args.push(`--subdomain=${subdomain}`);
      return { bin, args };
    },
    parseUrl: (txt) => {
      const m = txt.match(/url=(https:\/\/[a-z0-9-]+\.ngrok[a-z0-9.-]*\.[a-z]+)/i);
      return m ? m[1] : null;
    },
    deadHint: 'Common cause: missing authtoken — run `ngrok config add-authtoken <token>` once.',
  });
}

// ── Banner with the public URL ────────────────────────────────────────
function printShareBox(url, opts = {}) {
  const user = process.env.TFWEFLOLAB_USER || 'tfweflolab';
  const pass = process.env.TFWEFLOLAB_PASS || '(none)';
  console.log('');
  console.log('  ┌─────────────────────────────────────────────────────────────────────┐');
  console.log(`  │  ${green('TFWefloLab is now reachable on the internet')}                          │`);
  console.log('  ├─────────────────────────────────────────────────────────────────────┤');
  console.log(`  │  Public URL:   ${bold(url.padEnd(53))}│`);
  console.log(`  │  Login user:   ${bold(user.padEnd(53))}│`);
  console.log(`  │  Login pass:   ${bold(pass.padEnd(53))}│`);
  console.log('  ├─────────────────────────────────────────────────────────────────────┤');
  console.log(`  │  ${dim('Share both the URL and the password with your teammate.')}             │`);
  console.log(`  │  ${dim('Press Ctrl+C in this window to tear the tunnel down.')}                │`);
  console.log('  └─────────────────────────────────────────────────────────────────────┘');
  if (opts.extraNote) {
    // Word-wrap the note at ~70 chars so it stays inside the terminal width.
    const lines = wrap(opts.extraNote, 70);
    console.log(`  ${yellow('!')} ${bold('Note for teammates:')}`);
    for (const l of lines) console.log(`    ${dim(l)}`);
  }
  console.log('');
}

function wrap(text, width) {
  const out = [];
  const words = String(text).split(/\s+/);
  let line = '';
  for (const w of words) {
    if (line.length + w.length + 1 > width) { out.push(line); line = w; }
    else line = line ? line + ' ' + w : w;
  }
  if (line) out.push(line);
  return out;
}

// ── Keep-alive pinger ──────────────────────────────────────────────────
// Free tunnel services (loca.lt in particular) drop idle WebSocket
// connections after ~60–120 s of no traffic. The next real request from
// a teammate then hits a "warming up" path that returns HTTP 408 from the
// tunnel edge, even though the tunnel process is still running. The user
// then has to hit Reload, which is bad UX.
//
// This pinger sends a single authenticated request every 60 s, starting
// 30 s after the first URL is published. The request is identical to
// what a real teammate would send (Basic Auth + bypass-tunnel-reminder
// for loca.lt), so the tunnel edge keeps the WebSocket alive end-to-end.
//
// We also use the ping responses as a passive health-check: 5 consecutive
// failures (≈ 5 minutes of broken tunnel even though the process is alive)
// triggers `onPersistentFailure`, which the supervisor uses to SIGTERM the
// tunnel child — that exit then triggers the normal respawn path.
function keepAlivePing(url, onPersistentFailure) {
  const user = process.env.TFWEFLOLAB_USER || 'tfweflolab';
  const pass = process.env.TFWEFLOLAB_PASS || '';
  const basicAuth = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
  let consecutiveFailures = 0;
  let intervalHandle = null;
  let initialHandle = null;
  let stopped = false;

  const ping = async () => {
    if (stopped) return;
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 10_000);
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          'Authorization': basicAuth,
          // Tells loca.lt "skip the anti-bot warning page for this request"
          // so the ping reaches our local server instead of getting an HTML
          // warning page back. Cloudflare / ngrok ignore unknown headers.
          'bypass-tunnel-reminder': '1',
          'User-Agent': 'TFWefloLab-KeepAlive/1.0',
        },
        signal: ctl.signal,
      }).finally(() => clearTimeout(timer));
      // Anything that came back over HTTP — even 401, 404, 408, 5xx — means
      // the tunnel pipe is alive end-to-end EXCEPT the 408/5xx range which
      // signal a tunnel-edge-can-not-reach-origin condition.
      if (res.status === 408 || (res.status >= 500 && res.status < 600)) {
        throw new Error(`status ${res.status}`);
      }
      consecutiveFailures = 0;
    } catch {
      consecutiveFailures++;
      if (consecutiveFailures >= 5 && onPersistentFailure) {
        console.log(
          `\n  ${yellow('↻')} keep-alive ping failed 5 times in a row — ` +
          `forcing tunnel restart\n`
        );
        consecutiveFailures = 0;
        try { onPersistentFailure(); } catch {}
      }
    }
  };

  // First ping at t=30 s (gives the tunnel time to warm up after spawn).
  // After that, ping every 60 s for the lifetime of this tunnel session.
  initialHandle = setTimeout(() => {
    ping();
    intervalHandle = setInterval(ping, 60_000);
  }, 30_000);

  // Return a cancel function the caller invokes on respawn / Ctrl+C.
  return () => {
    stopped = true;
    if (initialHandle) clearTimeout(initialHandle);
    if (intervalHandle) clearInterval(intervalHandle);
  };
}

// ── 4c. localtunnel via npx ────────────────────────────────────────────
// localtunnel is the "blocked-by-corporate-firewall escape hatch": uses
// *.loca.lt (random AWS IPs), no signup, no binary install. Invoked via
// npx so users don't need `npm i -g` — npx downloads it on first run.
// loca.lt's free tier is the most prone to dropping idle connections,
// so the auto-restart supervisor above carries most of its weight here.
function runLocaltunnel(subdomain) {
  console.log(`\n  ${green('▶')} Starting localtunnel to localhost:${PORT}…`);
  console.log(`  ${dim('(npx will download localtunnel on first run — takes ~15 s)')}`);
  console.log(`  ${dim('Auto-restart is on: if the tunnel drops, it will reconnect automatically.')}\n`);
  const npxBin = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  if (subdomain) {
    console.log(`  ${dim(`requesting subdomain: ${subdomain}.loca.lt (falls back to random if taken)`)}\n`);
  }
  superviseSpawn({
    label: 'localtunnel',
    makeArgs: () => {
      const args = ['localtunnel', '--port', String(PORT)];
      // Optional stable subdomain → URL becomes https://<subdomain>.loca.lt
      // and stays the same across restarts (including the auto-restarts
      // performed by the supervisor on connection drops).
      if (subdomain) args.push('--subdomain', subdomain);
      return { bin: npxBin, args, shell: process.platform === 'win32' };
    },
    parseUrl: (txt) => {
      const m = txt.match(/https?:\/\/[a-z0-9-]+\.loca\.lt/i);
      return m ? m[0] : null;
    },
    deadHint: 'Common cause: no internet, or loca.lt is down.',
    extraNote:
      'Teammates will see a one-time "tunnel warning" page on loca.lt — they click "Continue" once. ' +
      'On the page is a "Tunnel Password" field — teammates enter the host machine\'s public IP ' +
      "(it's shown on the same page).",
  });
}

// ── 6. Parse CLI args ────────────────────────────────────────────────
// Supported flags:
//   --tool=cloudflared|ngrok|localtunnel  force a specific tunnel back-end
//   --subdomain=NAME                      request a stable subdomain
//                                         (localtunnel: best-effort free;
//                                          ngrok: requires paid plan;
//                                          cloudflared quick: unsupported)
function parseArgs() {
  const out = { tool: null, subdomain: null };
  for (const a of process.argv.slice(2)) {
    const mt = a.match(/^--tool=(.+)$/);
    if (mt) { out.tool = mt[1].toLowerCase(); continue; }
    const ms = a.match(/^--subdomain=(.+)$/);
    if (ms) { out.subdomain = ms[1].trim(); continue; }
  }
  // Validate subdomain shape — localtunnel rejects anything outside
  // [a-z0-9-], cap length to 63 chars (DNS label limit).
  if (out.subdomain) {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(out.subdomain)) {
      fail(
        `Invalid --subdomain="${out.subdomain}"`,
        'Subdomain must be 1–63 chars, lowercase letters / digits / hyphens, no leading or trailing hyphen.'
      );
    }
    out.subdomain = out.subdomain.toLowerCase();
  }
  return out;
}

// ── Main ───────────────────────────────────────────────────────────────
(async function main() {
  console.log(`\n${bold(cyan('TFWefloLab — internet share'))}\n`);
  checkAuth();
  const up = await checkDashboard();
  if (!up) {
    fail(
      `Dashboard is NOT running on localhost:${PORT}.`,
      'Open another terminal and run `npm run dashboard` first. Then come back and re-run `npm run share`.'
    );
  }

  // Manual tool override + optional subdomain:
  //   `npm run share -- --tool=localtunnel --subdomain=tfweflolab`
  // (npm forwards everything after `--` as argv to the script).
  const { tool: forced, subdomain } = parseArgs();

  if (forced) {
    if (forced === 'localtunnel' || forced === 'lt') return runLocaltunnel(subdomain);
    if (forced === 'cloudflared' || forced === 'cf') {
      if (subdomain) {
        console.log(`  ${yellow('!')} ${dim('cloudflared quick-tunnels cannot use custom subdomains — ignoring --subdomain. (Use a named tunnel + Cloudflare account for a stable URL.)')}\n`);
      }
      const cf = which('cloudflared');
      if (!cf) fail('cloudflared is not installed.', 'winget install --id Cloudflare.cloudflared');
      return runCloudflared(cf);
    }
    if (forced === 'ngrok') {
      const ng = which('ngrok');
      if (!ng) fail('ngrok is not installed.', 'winget install --id Ngrok.Ngrok');
      return runNgrok(ng, subdomain);
    }
    fail(`Unknown --tool="${forced}".`, 'Valid: cloudflared, ngrok, localtunnel');
  }

  // Auto-select in order of preference.
  const cf = which('cloudflared');
  if (cf) {
    if (subdomain) {
      console.log(`  ${yellow('!')} ${dim('cloudflared quick-tunnels cannot use custom subdomains — ignoring --subdomain.')}\n`);
    }
    return runCloudflared(cf);
  }
  const ng = which('ngrok');
  if (ng) return runNgrok(ng, subdomain);
  // No binary installed — offer install instructions AND mention localtunnel
  // as the no-install option for blocked networks.
  printInstallInstructions();
  console.log(`  ${bold('Or no-install option')} ${dim('(handy if corporate firewall blocks cloudflared / ngrok):')}`);
  console.log(`    ${cyan('npm run share -- --tool=localtunnel')}\n`);
  process.exit(2);
})();
