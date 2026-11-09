"use strict";

// ============================================================================
// index.js — Builder Crew dashboard + wiring.
// Express dashboard (dark modern style), health/ping/logs/start/stop/tutorial
// routes, self-ping keep-alive, automatic crew boot, and crash-safe handlers.
// ============================================================================

const express = require("express");
const http = require("http");
const https = require("https");
const logger = require("./logger");
const { addLog, getLogs } = logger;
const settings = require("./settings.json");
const { createCrew } = require("./src/crew");
const { createBuilder } = require("./src/builder");
const blueprints = require("./src/blueprints");
const ai = require("./src/ai");

try {
  ai.configure(settings.ai);
} catch (e) {
  addLog(`ai.configure failed (continuing without AI): ${e.message}`, "System");
}

const crew = createCrew(settings, logger);
const builder = createBuilder(crew, settings, blueprints, ai, logger);

const app = express();
app.use(express.json());

const BASE_PORT = Number(
  process.env.PORT || (settings.dashboard && settings.dashboard.port) || 5000,
);
let actualPort = BASE_PORT;
const startTime = Date.now();

// ---- dashboard HTML (dark modern style, preserved from original) ----------
function dashboardHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Builder Crew Dashboard</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
    background: #0d1117; color: #e6edf3; min-height: 100vh; padding: 24px 16px;
  }
  .wrap { max-width: 1100px; margin: 0 auto; }
  header { margin-bottom: 24px; }
  header h1 { font-size: 26px; color: #f0f6fc; line-height: 1.2; }
  header p { font-size: 14px; color: #8b949e; margin-top: 6px; }
  .card {
    background: #161b22; border: 1px solid #21262d; border-radius: 12px;
    padding: 18px; margin-bottom: 16px;
  }
  .card h2 { font-size: 15px; color: #8b949e; text-transform: uppercase;
    letter-spacing: 0.5px; margin-bottom: 14px; font-weight: 600; }
  .bots { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; }
  .bot {
    background: #0d1117; border: 1px solid #21262d; border-radius: 10px;
    padding: 14px; transition: border-color 0.2s;
  }
  .bot .name-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
  .dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
  .dot.online { background: #3fb950; box-shadow: 0 0 6px #3fb950; }
  .dot.offline { background: #da3633; }
  .bot .name { font-weight: 700; font-size: 15px; }
  .bot .foreman-badge {
    font-size: 10px; background: #1f6feb22; color: #58a6ff; border: 1px solid #1f6feb;
    padding: 1px 6px; border-radius: 6px; margin-left: auto;
  }
  .bot .row { font-size: 12px; color: #8b949e; margin-top: 4px; display: flex; justify-content: space-between; }
  .bot .row span:last-child { color: #e6edf3; font-weight: 600; }
  .state-badge { font-size: 11px; padding: 2px 8px; border-radius: 6px; font-weight: 600; }
  .state-IDLE, .state-OFFLINE { background: #21262d; color: #8b949e; }
  .state-CONNECTING, .state-AUTH, .state-MOVING { background: #1f6feb22; color: #58a6ff; border: 1px solid #1f6feb; }
  .state-BUILDING { background: #23863622; color: #3fb950; border: 1px solid #238636; }
  .progress-track { background: #21262d; border-radius: 8px; height: 14px; overflow: hidden; margin: 10px 0 6px; }
  .progress-fill { height: 100%; background: linear-gradient(90deg, #238636, #3fb950); width: 0%; transition: width 0.4s; }
  .progress-meta { font-size: 13px; color: #8b949e; }
  .queue-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
  .chip { font-size: 11px; background: #21262d; color: #c9d1d9; padding: 3px 10px; border-radius: 20px; }
  .btn-row { display: flex; gap: 12px; flex-wrap: wrap; }
  button {
    flex: 1; min-width: 140px; min-height: 52px; border-radius: 10px; font-size: 15px;
    font-weight: 700; cursor: pointer; letter-spacing: 0.3px; font-family: inherit;
    transition: filter 0.2s, opacity 0.2s;
  }
  button:hover { filter: brightness(1.15); } button:active { opacity: 0.85; }
  .btn-start { border: 2px solid #238636; background: #0d2218; color: #3fb950; }
  .btn-stop { border: 2px solid #da3633; background: #200d0d; color: #f85149; }
  .links { display: flex; gap: 12px; margin-top: 14px; flex-wrap: wrap; }
  .links a {
    flex: 1; min-width: 140px; text-align: center; text-decoration: none; min-height: 44px;
    line-height: 44px; border-radius: 10px; border: 1px solid #21262d; background: #161b22;
    color: #8b949e; font-size: 14px; font-weight: 600; transition: background 0.2s, color 0.2s;
  }
  .links a:hover { background: #21262d; color: #c9d1d9; }
  #status-msg { font-size: 13px; color: #8b949e; margin-top: 10px; min-height: 18px; }
  pre.logs {
    background: #0d1117; border: 1px solid #21262d; border-radius: 10px; padding: 12px;
    font-size: 11px; color: #8b949e; max-height: 220px; overflow-y: auto; white-space: pre-wrap;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; line-height: 1.5;
  }
  footer { text-align: center; margin-top: 24px; font-size: 12px; color: #484f58; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>Builder Crew &mdash; 5 Bots (names 1&ndash;5)</h1>
    <p>Cooperative multi-bot building crew for Minecraft. Uptime: <span id="uptime">0s</span></p>
  </header>

  <div class="card">
    <h2>Bots</h2>
    <div class="bots" id="bots"></div>
  </div>

  <div class="card">
    <h2>Current Build</h2>
    <div id="build-name" style="font-size:17px;font-weight:700;">Idle &mdash; waiting for crew</div>
    <div class="progress-track"><div class="progress-fill" id="build-bar"></div></div>
    <div class="progress-meta" id="build-meta">0 / 0 blocks placed</div>
    <div class="queue-chips" id="queue"></div>
  </div>

  <div class="card">
    <h2>Controls</h2>
    <div class="btn-row">
      <button class="btn-start" onclick="postAction('/start', this)">Start Crew</button>
      <button class="btn-stop" onclick="postAction('/stop', this)">Stop Crew</button>
    </div>
    <div id="status-msg"></div>
    <div class="links">
      <a href="/logs" target="_blank">Logs (JSON)</a>
      <a href="/tutorial">Setup Tutorial</a>
    </div>
  </div>

  <div class="card">
    <h2>Recent Logs</h2>
    <pre class="logs" id="logbox">Loading...</pre>
  </div>

  <footer>Builder Crew Dashboard &mdash; auto-refresh every 3s</footer>
</div>

<script>
function setStatus(msg) { document.getElementById('status-msg').textContent = msg; }
function postAction(url, btn) {
  btn.disabled = true;
  fetch(url, { method: 'POST' })
    .then(r => r.json())
    .then(d => { setStatus(d && d.ok ? 'OK' : (d && d.msg || 'done')); refresh(); })
    .catch(e => setStatus('Error: ' + e.message))
    .finally(() => { btn.disabled = false; });
}
function fmtUptime(s) {
  const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), ss = s%60;
  return (h>0?h+'h ':'') + (m>0?m+'m ':'') + ss + 's';
}
function refresh() {
  fetch('/health').then(r => r.json()).then(d => {
    document.getElementById('uptime').textContent = fmtUptime(d.uptime || 0);
    const botsEl = document.getElementById('bots');
    let html = '';
    (d.bots || []).forEach(b => {
      const coords = (b.x==null) ? '&mdash;' : (b.x + ', ' + b.y + ', ' + b.z);
      const isForeman = b.online && b.username === d.foreman;
      html += '<div class="bot">'
        + '<div class="name-row"><span class="dot ' + (b.online?'online':'offline') + '"></span>'
        + '<span class="name">' + b.username + '</span>'
        + (isForeman ? '<span class="foreman-badge">FOREMAN</span>' : '') + '</div>'
        + '<div class="row"><span>Coords</span><span>' + coords + '</span></div>'
        + '<div class="row"><span>State</span><span><span class="state-badge state-' + b.state + '">' + b.state + '</span></span></div>'
        + '<div class="row"><span>Task</span><span style="font-size:11px;max-width:60%;text-align:right;">' + (b.task || '&mdash;') + '</span></div>'
        + '<div class="row"><span>Blocks</span><span>' + (b.blocksPlaced||0) + '</span></div>'
        + '</div>';
    });
    botsEl.innerHTML = html;

    const build = d.build || {};
    document.getElementById('build-name').textContent = build.current ? ('Building: ' + build.current) : 'Idle';
    const pct = build.total ? Math.round(100 * build.placed / build.total) : 0;
    document.getElementById('build-bar').style.width = pct + '%';
    document.getElementById('build-meta').textContent = (build.placed||0) + ' / ' + (build.total||0) + ' blocks placed (' + pct + '%)';
    const q = build.queue || [];
    document.getElementById('queue').innerHTML = q.length
      ? '<span style="font-size:11px;color:#8b949e;align-self:center;">Next up:</span>' + q.map(x => '<span class="chip">' + x + '</span>').join('')
      : '';
  }).catch(() => {});
  fetch('/logs').then(r => r.json()).then(d => {
    const logs = (d.logs || []).slice(-30);
    document.getElementById('logbox').textContent = logs.join('\n') || '(no logs yet)';
    const lb = document.getElementById('logbox');
    lb.scrollTop = lb.scrollHeight;
  }).catch(() => {});
}
refresh();
setInterval(refresh, 3000);
</script>
</body>
</html>`;
}

function tutorialHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Builder Crew — Setup Tutorial</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Inter', -apple-system, sans-serif; background: #0d1117; color: #e6edf3; padding: 24px 16px; }
  .wrap { max-width: 760px; margin: 0 auto; }
  h1 { font-size: 24px; color: #f0f6fc; margin-bottom: 6px; }
  .sub { color: #8b949e; font-size: 14px; margin-bottom: 20px; }
  .card { background: #161b22; border: 1px solid #21262d; border-radius: 12px; padding: 20px; margin-bottom: 14px; }
  h2 { font-size: 15px; color: #58a6ff; margin-bottom: 10px; text-transform: uppercase; letter-spacing: 0.5px; }
  ol, ul { padding-left: 22px; font-size: 14px; line-height: 1.8; color: #c9d1d9; }
  code { background: #0d1117; border: 1px solid #21262d; padding: 1px 6px; border-radius: 5px; font-size: 13px; color: #3fb950; }
  .warn { background: #200d0d; border: 1px solid #da3633; color: #f85149; border-radius: 10px; padding: 12px 14px; font-size: 13px; margin-bottom: 14px; }
  .tip { background: #0d2218; border: 1px solid #238636; color: #3fb950; border-radius: 10px; padding: 12px 14px; font-size: 13px; margin-bottom: 14px; }
  a { color: #58a6ff; }
</style>
</head>
<body>
<div class="wrap">
  <h1>Builder Crew — Setup Tutorial</h1>
  <p class="sub">Get 5 bots building on your server.</p>

  <div class="tip"><strong>Aternos users:</strong> Start your Aternos server from the Aternos panel first. While the server is offline the bots will get connection errors and keep reconnecting with backoff until it comes online — that is expected and safe.</div>

  <div class="card">
    <h2>1. Install</h2>
    <ol>
      <li>Install Node.js 18+.</li>
      <li>Run <code>npm install</code> in this directory.</li>
      <li>Run <code>npm start</code> — the dashboard opens on port 5000.</li>
    </ol>
  </div>

  <div class="card">
    <h2>2. Configure your server</h2>
    <ol>
      <li>Edit <code>settings.json</code> → <code>server.host</code> / <code>server.port</code>. Default points to an Aternos server; replace with yours.</li>
      <li>Leave <code>server.version</code> empty (<code>""</code>) for auto-detection, or set a specific version like <code>"1.20.1"</code>.</li>
      <li>Default bot names are single digits <code>1</code>…<code>5</code>. <strong>Note:</strong> some servers kick single-character names as invalid — if you see an &quot;illegal name&quot;/&quot;invalid name&quot; error, edit <code>settings.json</code> and use 3+ character names like <code>Bot1</code>…<code>Bot5</code> or <code>W_1</code>…<code>W_5</code>.</li>
    </ol>
  </div>

  <div class="card">
    <h2>3. Give bots Creative / OP</h2>
    <ol>
      <li>On your server, OP each bot once: <code>/op 1</code> … <code>/op 5</code> (or set <code>build.allowCreativeCommands: true</code> and give them <code>/gamemode creative</code> via console).</li>
      <li>Creative mode lets bots fetch any block instantly. In survival they must already own the block in their inventory.</li>
      <li>Raise <code>max-connections-per-IP</code> and <code>max-players</code> in <code>server.properties</code> so 5 bots from one IP can join.</li>
    </ol>
  </div>

  <div class="card">
    <h2>4. Auth (optional)</h2>
    <p>If your server runs AuthMe / LoginSecurity, set <code>auth.enabled: true</code> and fill <code>registerPassword</code> / <code>loginPassword</code>. Vanilla/Aternos default: leave it <code>false</code> — bots will not spam <code>/register</code> / <code>/login</code>.</p>
  </div>

  <div class="card">
    <h2>5. Optional AI</h2>
    <p>Set <code>ai.enabled: true</code>, <code>ai.provider</code>, and <code>ai.apiKey</code> to let the crew choose what to build next and reply to in-game chat (only the foreman bot replies, to avoid spam).</p>
  </div>

  <div class="warn"><strong>Note:</strong> Aternos free servers sleep when empty. If the bots cannot connect, wake the server from the Aternos panel — the crew will reconnect automatically.</div>

  <p style="text-align:center;margin-top:20px;"><a href="/">&larr; Back to dashboard</a></p>
</div>
</body>
</html>`;
}

// ---- routes ---------------------------------------------------------------
app.get("/", (req, res) => {
  try {
    res.send(dashboardHTML());
  } catch (e) {
    addLog(`dashboard render error: ${e.message}`, "System");
    res.status(500).send("Dashboard error");
  }
});

app.get("/health", (req, res) => {
  try {
    const fm = crew.foreman();
    res.json({
      ok: true,
      uptime: Math.floor((Date.now() - startTime) / 1000),
      foreman: fm ? fm.username : null,
      bots: crew.getStatus(),
      build: builder.getProgress(),
    });
  } catch (e) {
    addLog(`/health error: ${e.message}`, "System");
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/ping", (req, res) => res.send("pong"));

app.get("/logs", (req, res) => {
  res.json({ logs: getLogs() });
});

app.post("/start", (req, res) => {
  try {
    crew.start();
    builder.start();
    addLog("[Control] Crew + builder started", "System");
    res.json({ ok: true });
  } catch (e) {
    addLog(`/start error: ${e.message}`, "System");
    res.json({ ok: false, msg: e.message });
  }
});

app.post("/stop", (req, res) => {
  try {
    builder.stop();
    crew.stopAll();
    addLog("[Control] Crew + builder stopped", "System");
    res.json({ ok: true });
  } catch (e) {
    addLog(`/stop error: ${e.message}`, "System");
    res.json({ ok: false, msg: e.message });
  }
});

app.get("/tutorial", (req, res) => {
  try {
    res.send(tutorialHTML());
  } catch (e) {
    res.status(500).send("Tutorial error");
  }
});

// ---- listen with EADDRINUSE fallback --------------------------------------
const server = app.listen(BASE_PORT, "0.0.0.0", () => {
  actualPort = server.address().port;
  addLog(`[Server] HTTP dashboard started on port ${actualPort}`, "System");
});
server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    const fallback = BASE_PORT + 1;
    addLog(`[Server] Port ${BASE_PORT} in use — trying port ${fallback}`, "System");
    actualPort = fallback;
    server.listen(fallback, "0.0.0.0");
  } else {
    addLog(`[Server] HTTP server error: ${err.message}`, "System");
  }
});

// ---- self-ping keep-alive (every 10 min) ----------------------------------
const SELF_PING_INTERVAL = 10 * 60 * 1000;
setInterval(() => {
  try {
    http
      .get(`http://localhost:${actualPort}/ping`, (res) => {
        res.resume();
      })
      .on("error", (err) => {
        addLog(`[KeepAlive] Self-ping failed: ${err.message}`, "System");
      });
  } catch (e) {
    addLog(`[KeepAlive] Self-ping error: ${e.message}`, "System");
  }
}, SELF_PING_INTERVAL);
addLog("[KeepAlive] Self-ping system started (every 10 min)", "System");

// ---- crash safety: log only, never exit -----------------------------------
process.on("uncaughtException", (err) => {
  const msg = err && err.message ? err.message : String(err);
  addLog(`[FATAL] Uncaught Exception: ${msg}`, "System");
});
process.on("unhandledRejection", (reason) => {
  addLog(`[FATAL] Unhandled Rejection: ${String(reason)}`, "System");
});

// ---- auto-start crew on boot (staggered connects) -------------------------
addLog(
  `Builder Crew booting — target ${settings.server.host}:${settings.server.port} (version: ${settings.server.version || "auto"}).`,
  "System",
);
addLog(
  "Aternos note: start your server from the Aternos panel first; bots will keep reconnecting until it is online.",
  "System",
);
// Set CREW_NO_AUTOSTART=1 to boot the dashboard only (useful for dev/tests).
if (process.env.CREW_NO_AUTOSTART !== "1") {
  try {
    crew.start();
    builder.start();
  } catch (e) {
    addLog(`auto-start error: ${e.message}`, "System");
  }
} else {
  addLog("CREW_NO_AUTOSTART=1 — dashboard only, crew not started.", "System");
}
