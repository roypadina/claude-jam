#!/usr/bin/env node
// claude-jam host daemon + launcher. Launcher builds the tmux session; the same file
// re-execs itself with --daemon in window 0 to be the actual WS/HTTP server.
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID, randomBytes } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { sanitize, stripControl, neutralizePrefixes, validName, isUuid, parseJsonlLine, buildSettings, resolveClaude, buildJoinLine, buildViewUrl, joinLines, resolveViewKey, resolveTtyd, buildTokenFile, classifyHello, nameTaken, tokenMatches, validTokenValue, buildPopupArgs, statusRightWaiting, resolveConfigDir, jsonlGlobs, claudeTarget, toolResultAction, sanitizeFrameRow, frameDecision, FRAME_MIN_GAP, parseTunnelUrl, buildTunnelJoinLine, buildTunnelViewUrl, tunnelJoinLines } from './lib.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const TMUX = process.env.JAM_TMUX_BIN || 'tmux';
const tmux = (...a) => spawnSync(TMUX, a, { encoding: 'utf8' });

function parseArgs(argv) {
  const o = { port: 7777, host: '0.0.0.0', tmux: 'jam', extra: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { o.extra = argv.slice(i + 1); break; }
    else if (a === '--daemon') o.daemon = true;
    else if (a === '--no-attach') o.noAttach = true;
    // Value-less flags need naming here, or the generic branch below eats the next argument.
    else if (a === '--no-view') o.noView = true;
    else if (a === '--no-popup') o.noPopup = true;
    // v0.14: the host is in the client like everybody else, so the old host-chat layouts
    // (--split pane, cmux split, `chat` window) are gone. The flags stay accepted and do
    // nothing, so an old command line still runs.
    else if (a === '--split' || a === '--no-split' || a === '--no-cmux') o.retiredLayout = a;
    else if (a === '--no-token-in-context') o.noTokenInContext = true;
    else if (a === '--tunnel') o.tunnel = true;
    else if (a.startsWith('--')) o[a.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = argv[++i];
    else throw new Error(`unexpected argument: ${a}`);
  }
  o.port = Number(o.port);
  return o;
}

const opts = parseArgs(process.argv.slice(2));
opts.name ||= 'Host';
opts.cwd = path.resolve(opts.cwd || process.cwd());
opts.state ||= path.join(os.tmpdir(), `claude-jam-${opts.port}`);
// No --token means no token at all: friends knock and the host accepts them. A token that
// was given must survive a join line, a chat message and a URL unquoted.
opts.token ||= null;
if (opts.token && !validTokenValue(opts.token)) { console.error(`bad --token: must be 8-64 chars of [A-Za-z0-9_-]`); process.exit(2); }
// Hooks authenticate with this, not with the friend-facing token: rotating that one must
// never break the Stop/Notification round trip.
opts.hookSecret ||= randomBytes(18).toString('base64url');
if (opts.resume) {
  // A bare `--resume` (no id) would open claude's interactive session picker, which the
  // daemon has no way to drive — require and validate a real id up front. Wins over
  // --session-id if both were given, since it's set right before the fallback below.
  if (!isUuid(opts.resume)) { console.error(`bad --resume: expected a session id (UUID), got "${opts.resume}"`); process.exit(2); }
  opts.sessionId = opts.resume;
}
opts.sessionId ||= randomUUID();
opts.claude ||= resolveClaude(process.env, fs.existsSync); // --claude wins, then JAM_CLAUDE
// Which claude account/profile the TUI runs as. null = whatever claude defaults to.
opts.configDir = resolveConfigDir(opts.configDir, process.env);
if (!validName(opts.name)) { console.error(`bad --name: ${opts.name}`); process.exit(2); }
// v0.11: fail fast, before anything is built — a daemon that started and only then
// discovered cloudflared is missing would strand the host inside `tmux attach`.
if (opts.tunnel && spawnSync('cloudflared', ['--version'], { encoding: 'utf8' }).status !== 0) {
  console.error('cloudflared not found on PATH. --tunnel needs it: brew install cloudflared');
  process.exit(2);
}

// Everything that drives the real TUI — capture-pane, paste-buffer, send-keys — targets the
// claude window, which holds exactly one pane: the TUI. Named, never indexed, so a host with
// `base-index`/`pane-base-index` of 1 is fine. v0.14: nothing else ever lives in that window,
// so pane and window are the same thing — the mirror, and a ttyd viewer, see only Claude Code.
const CLAUDE_PANE = claudeTarget(opts.tmux);
const BOOT = randomUUID(); // clients drop their id-dedupe set when this changes
// The live token, `/token new|set|off` away from the startup value. null = knock-only.
let currentToken = opts.token;

// Live view (ttyd): on by default whenever ttyd is installed. Both the launcher and the
// daemon compute this, so they print the same view line; the launcher hands its key to
// the daemon with --view-key so a knock-only run does not end up with two different keys.
opts.viewPort = Number(opts.viewPort) || opts.port + 1;
const ttyd = opts.noView ? null : resolveTtyd(opts.viewTtyd, fs.existsSync);
let viewKey = ttyd ? resolveViewKey(currentToken, () => opts.viewKey || newToken()) : null;

// ---------------------------------------------------------------- launcher ----
function launch() {
  if (tmux('has-session', '-t', opts.tmux).status === 0) {
    console.error(`tmux session "${opts.tmux}" already exists. Attach with: tmux attach -t ${opts.tmux}\n` +
      `Or run a second jam with --tmux <other-name>.`);
    process.exit(1);
  }
  if (opts.resume) console.log(`resuming session ${opts.resume}`);
  fs.mkdirSync(opts.state, { recursive: true, mode: 0o700 });
  writeRoster([]);
  const hooks = path.join(HERE, 'hooks.sh');
  fs.writeFileSync(path.join(opts.state, 'settings.json'), JSON.stringify(buildSettings(hooks), null, 2));

  const self = new URL(import.meta.url).pathname;
  const common = ['--port', String(opts.port), '--host', opts.host, '--name', opts.name,
    ...(opts.token ? ['--token', opts.token] : []),
    '--hook-secret', opts.hookSecret,
    '--session-id', opts.sessionId, '--cwd', opts.cwd,
    '--tmux', opts.tmux, '--state', opts.state,
    '--view-port', String(opts.viewPort),
    ...(opts.noView ? ['--no-view'] : []),
    ...(opts.viewTtyd ? ['--view-ttyd', opts.viewTtyd] : []),
    ...(viewKey ? ['--view-key', viewKey] : []),
    ...(opts.noTokenInContext ? ['--no-token-in-context'] : []),
    ...(opts.noPopup ? ['--no-popup'] : []),
    ...(opts.tunnel ? ['--tunnel'] : []),
    ...(opts.configDir ? ['--config-dir', opts.configDir] : []), // daemon globs that profile's transcripts too
    ...(opts.resume ? ['--resume', opts.resume] : [])]; // daemon needs this to skip pre-existing JSONL history

  // First window: the daemon (its own window, not a pane — its log is for when something
  // breaks, and it must never eat rows from the TUI).
  must(tmux('new-session', '-d', '-s', opts.tmux, '-c', opts.cwd, '-n', 'daemon',
    process.execPath, self, '--daemon', ...common));
  sessionCreated = true;
  waitForHealth();

  // JAM_NODE: hooks.sh must not depend on whatever PATH tmux/claude inherited.
  const env = ['env', `JAM_STATE=${opts.state}`, `JAM_PORT=${opts.port}`, `JAM_HOOK_SECRET=${opts.hookSecret}`,
    `JAM_HOST_NAME=${opts.name}`, `JAM_NODE=${process.execPath}`,
    // Picks the claude account/profile for this window only; nothing global changes.
    ...(opts.configDir ? [`CLAUDE_CONFIG_DIR=${opts.configDir}`] : [])];
  console.log(`claude binary: ${opts.claude}`);
  if (opts.configDir) console.log(`claude profile: ${opts.configDir}`);
  must(tmux('new-window', '-d', '-t', opts.tmux, '-c', opts.cwd, '-n', 'claude',
    ...env, opts.claude,
    ...(opts.resume ? ['--resume', opts.resume] : ['--session-id', opts.sessionId]),
    '--settings', path.join(opts.state, 'settings.json'), ...opts.extra));
  if (opts.retiredLayout) console.log(`${opts.retiredLayout} is retired in v0.14 — the host uses the same client as everyone (ignored)`);
  console.log(`\nclaude-jam up. session ${opts.sessionId}\n` +
    `  tmux: ${opts.tmux} (windows: daemon, claude) — detached; \`tmux attach -t ${opts.tmux}\` for the raw TUI`);
  // The tunnel dials out from the daemon process (a separate node process from this one), so
  // it has not resolved anything yet by the time this print runs — the daemon window logs the
  // URLs a few seconds later, once cloudflared reports them.
  if (opts.tunnel) console.log('cloudflared tunnel connecting — the join/view URLs land in your client (/join) once it is up');
  printJoin();
  if (opts.noAttach) return;

  // v0.14: nothing attaches to tmux. The host runs the same single-pane client as every
  // guest, full-screen in this terminal, and watches the real TUI through its mirror view —
  // so there is one surface to learn, and no host chrome for a viewer to see. Loopback +
  // `--host` is what makes this client trusted (F3 key passthrough, slash commands, /token).
  const client = spawnSync(process.execPath,
    [path.join(HERE, 'client.mjs'), `ws://127.0.0.1:${opts.port}`,
      '--name', opts.name, ...(opts.token ? ['--token', opts.token] : []), '--host'],
    { stdio: 'inherit' });
  // The client is just a window onto the session: closing it leaves the daemon, the TUI and
  // every guest exactly where they were, so say how to come back and how to actually stop.
  console.log(`\nclient closed — the jam is still running.\n` +
    `  rejoin:  node client.mjs ws://127.0.0.1:${opts.port} --name ${opts.name}` +
    `${currentToken ? ` --token ${currentToken}` : ''} --host\n` +
    `  raw TUI: tmux attach -t ${opts.tmux}\n` +
    `  stop:    tmux kill-session -t ${opts.tmux}\n`);
  if (client.status) process.exitCode = client.status;
}

let sessionCreated = false;
function must(r) {
  if (r.status !== 0) {
    console.error(`tmux failed: ${r.stderr || r.stdout}`);
    // Half-built session is useless and blocks the next `jam host`; remove the exact
    // session name we created a moment ago, nothing else.
    if (sessionCreated) tmux('kill-session', '-t', opts.tmux);
    process.exit(1);
  }
}

function waitForHealth() {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const r = spawnSync('curl', ['-s', '-m', '1', `http://127.0.0.1:${opts.port}/health`], { encoding: 'utf8' });
    if (r.stdout?.includes('"ok"')) return;
    spawnSync('sleep', ['0.3']);
  }
  console.error('daemon did not come up; check the tmux daemon window');
  process.exit(1);
}

function externalIp() {
  const ts = spawnSync('tailscale', ['ip', '-4'], { encoding: 'utf8' });
  const ip = ts.stdout?.trim().split('\n')[0];
  if (ip && /^\d/.test(ip)) return ip;
  for (const list of Object.values(os.networkInterfaces())) {
    for (const n of list || []) if (n.family === 'IPv4' && !n.internal) return n.address;
  }
  return '127.0.0.1';
}

// Shared by launch() and daemon() (same process, re-exec'd with --daemon) and by the
// welcome frame, so both invite lines are built in exactly one place. `join` is null while
// no token is set, `view` while there is no ttyd view. tunnelJoin/tunnelView (v0.11) are
// null until --tunnel is given and cloudflared has resolved a hostname for that port.
function joinInfo() {
  const ip = externalIp();
  return {
    join: buildJoinLine(ip, opts.port, currentToken),
    view: buildViewUrl(ip, opts.viewPort, viewKey),
    tunnelJoin: buildTunnelJoinLine(tunnelHosts.ws, currentToken),
    tunnelView: buildTunnelViewUrl(tunnelHosts.view, viewKey),
  };
}

// What the host is told wherever the invite lines would go. Tunnel lines first — they're
// what you'd copy to a remote friend — the LAN/Tailscale ones stay printed below.
function printJoin() {
  const { join, view, tunnelJoin, tunnelView } = joinInfo();
  const lines = [...tunnelJoinLines(tunnelJoin, tunnelView), ...joinLines(join, view)].map((l) => `  ${l}`).join('\n');
  console.log(join || tunnelJoin ? `\nSend this to a friend:\n${lines}\n` : `\n${lines}\n`);
}

// claude reads this back through hooks.sh, so the host can just ask the agent for the
// token. --no-token-in-context keeps it off disk entirely (a stale file from an earlier
// run on this port would otherwise put the token back into the context).
function writeTokenFile() {
  const file = path.join(opts.state, 'token.json');
  if (opts.noTokenInContext) return fs.rmSync(file, { force: true });
  const { join, view, tunnelJoin, tunnelView } = joinInfo();
  fs.writeFileSync(file, JSON.stringify(buildTokenFile(currentToken, join, view, tunnelJoin, tunnelView), null, 2));
}

function writeRoster(participants) {
  fs.writeFileSync(path.join(opts.state, 'roster.json'),
    JSON.stringify({ hostName: opts.name, sessionId: opts.sessionId, participants }, null, 2));
}

// ------------------------------------------------------------------ daemon ----
const clients = new Map(); // ws -> {name, host, joinedAt, lastTyping}
const pending = new Map(); // ws -> {name, ip, timer} — knockers waiting for the host
const KNOCK_TTL = 120000;
const MAX_PENDING = 10;
const history = [];
let nextId = 1;
const status = { busy: false, waiting: false };
let busyGen = 0; // bumped when a turn starts, so a slow Stop drain cannot clear a newer turn
let toolResults = 0; // `⎿` lines broadcast this turn; capped so a big grep cannot flood

function startTurn() { busyGen++; toolResults = 0; }

function send(ws, ev) { try { ws.send(JSON.stringify(ev)); } catch { /* closing */ } }

// Errors are host->client events too, so they carry id/ts like everything else.
function sendError(ws, text) { send(ws, { t: 'error', id: nextId++, ts: Date.now(), text }); }

// Knock and token frames go to host clients only: friends must not see the token, and
// they stay out of `history`, which is replayed to everyone in `welcome`.
function sendHosts(ev) {
  const full = { ...ev, id: nextId++, ts: Date.now() };
  for (const [ws, c] of clients) if (c.host) send(ws, full);
}

function newToken() { return randomBytes(12).toString('base64url').slice(0, 16); }

function broadcast(ev) {
  const full = { ...ev, id: nextId++, ts: Date.now() };
  if (ev.t !== 'typing') { history.push(full); if (history.length > 300) history.shift(); }
  for (const ws of clients.keys()) send(ws, full);
  if (ev.t !== 'typing') console.log(`[${ev.t}]`, ev.from || ev.kind || '', (ev.text || '').slice(0, 120));
  return full;
}

function names() { return [...clients.values()].map((c) => c.name); }

function pushStatus() { broadcast({ t: 'status', busy: status.busy, waiting: status.waiting }); }

function rosterChanged(extra) {
  writeRoster([...clients.values()].map(({ name, joinedAt }) => ({ name, joinedAt })));
  broadcast({ t: 'roster', roster: names(), ...extra });
}

// ------------------------------------------------------------- live view ----
// ttyd runs this once per browser connection: a tmux session of the viewer's own, grouped
// with the jam session (same live windows) but with its own focus — so the host switching
// windows never yanks a viewer's screen — pinned to the claude window and destroyed the
// moment the browser goes away. The tmux binary and session name are passed as arguments,
// never interpolated into the script.
// v0.9: `status off` on the viewer's OWN session (never the host's), so the browser shows
// the Claude Code screen and nothing else — no window list, no `⚑ N waiting` badge.
const VIEW_SH = 'S="$2-view-$$"; exec "$1" new-session -t "$2" -s "$S" ";" ' +
  'set-option -t "$S" destroy-unattached on ";" set-option -t "$S" status off ";" ' +
  'select-window -t "$S:claude"';

let viewProc = null; // our ttyd child: killed by its own pid, never by pattern

function startView() {
  if (!ttyd || viewProc) return;
  // ttyd >= 1.7 is read-only unless -W is given, so read-only needs no flag of its own.
  const child = spawn(ttyd, ['-p', String(opts.viewPort), '-c', `jam:${viewKey}`,
    'sh', '-c', VIEW_SH, 'jam-view', TMUX, opts.tmux], { stdio: 'ignore' });
  viewProc = child;
  child.on('exit', (code) => {
    if (viewProc === child) viewProc = null;
    if (code) console.log(`live view exited (ttyd code ${code}) — is :${opts.viewPort} taken?`);
  });
  child.on('error', (e) => { if (viewProc === child) viewProc = null; console.log(`live view failed: ${e.message}`); });
  console.log(`live view on :${opts.viewPort} (ttyd pid ${child.pid})`);
}

function stopView() {
  if (!viewProc) return;
  const child = viewProc;
  viewProc = null;
  try { child.kill('SIGTERM'); } catch { /* already gone */ }
}

// ttyd cannot change its basic-auth credentials while running, so a new view key means a
// new child. Wait for the old one to die before respawning, or the port is still bound.
function restartView() {
  if (!ttyd) return;
  if (!viewProc) return startView();
  const child = viewProc;
  viewProc = null;
  child.once('exit', () => startView());
  child.kill('SIGTERM');
}

// ------------------------------------------------------ cloudflared tunnel ----
// v0.11: two quick tunnels, spawned from the daemon so their lifecycle matches ttyd's —
// tracked by the exact pid we spawned, killed on daemon exit, never respawned on their own.
// Cloudflare terminates TLS at the edge, so the guest join line is wss:// with no port.
const TUNNEL_WAIT_MS = 30000;
let tunnelProcs = { ws: null, view: null }; // our own children, killed by pid only
let tunnelHosts = { ws: null, view: null }; // resolved hostnames; null until cloudflared reports one

function spawnTunnel(label, port) {
  const child = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${port}`], { stdio: ['ignore', 'ignore', 'pipe'] });
  tunnelProcs[label] = child;
  console.log(`tunnel (${label}): connecting to cloudflare… (pid ${child.pid})`);
  let buf = '';
  const timer = setTimeout(() => {
    if (!tunnelHosts[label]) console.log(`tunnel (${label}): still no URL after 30s — cloudflared may be stuck or blocked`);
  }, TUNNEL_WAIT_MS);
  timer.unref?.();
  child.stderr.on('data', (chunk) => {
    if (tunnelHosts[label]) return; // already resolved, nothing left to parse for
    buf += chunk;
    if (buf.length > 8192) buf = buf.slice(-8192); // the banner is small; never grow unbounded
    const host = parseTunnelUrl(buf);
    if (!host) return;
    tunnelHosts[label] = host;
    clearTimeout(timer);
    console.log(`tunnel (${label}) up: ${host}`);
    onTunnelChange();
  });
  child.on('exit', (code) => {
    clearTimeout(timer);
    if (tunnelProcs[label] === child) tunnelProcs[label] = null;
    const had = tunnelHosts[label];
    tunnelHosts[label] = null;
    // No auto-restart in v0 (ceiling, documented in README): a flaky tunnel needs a fresh
    // `jam host --tunnel`. Only worth a log line if it had ever come up or was still pending.
    console.log(`tunnel (${label}) exited (cloudflared code ${code}) — its join/view URL is cleared`);
    if (had) onTunnelChange();
  });
  child.on('error', (e) => console.log(`tunnel (${label}) failed to start: ${e.message}`));
}

function startTunnels() {
  if (!opts.tunnel) return;
  spawnTunnel('ws', opts.port);
  // The view tunnel only makes sense when a view server is actually running — same gate
  // startView() itself uses (ttyd installed and --no-view not given).
  if (ttyd && !opts.noView) spawnTunnel('view', opts.viewPort);
}

function stopTunnels() {
  for (const label of Object.keys(tunnelProcs)) {
    const child = tunnelProcs[label];
    if (!child) continue;
    tunnelProcs[label] = null;
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
  }
}

// Whenever a tunnel resolves or dies: token.json (hence claude's context) and the console
// block reflect it right away, and already-connected host clients hear about it on the same
// frame `/token` uses. `/token` rotation itself does NOT call this — it never touches
// tunnelHosts, only the join/view *strings*, which joinInfo() recomputes from the live token.
function onTunnelChange() {
  writeTokenFile();
  printJoin();
  const { join, view, tunnelJoin, tunnelView } = joinInfo();
  sendHosts({ t: 'token', token: currentToken, join, view, tunnelJoin, tunnelView });
}

// -------------------------------------------------------- terminal mirror ----
// v0.7: guests who ask for it get the claude pane's actual cells, escape sequences and all,
// instead of an imitation of them. `capture-pane -e` is only run while somebody is
// subscribed, and only a changed screen is sent — so an idle mirror costs one tmux call per
// tick and zero bytes on the wire. Frames never enter `history`: they are a live view, and
// replaying yesterday's screen to a reconnecting client would be nonsense.
const mirrors = new Set(); // sockets in mirror mode
let frameTimer = null;
let lastFrame = null;
let lastFrameAt = 0;

function captureFrame() {
  const r = tmux('capture-pane', '-e', '-p', '-t', CLAUDE_PANE);
  if (r.status !== 0) return null;
  return (r.stdout || '').replace(/\n$/, '').split('\n').map(sanitizeFrameRow);
}

function pumpMirror() {
  if (!mirrors.size) return;
  const rows = captureFrame();
  if (frameDecision({ rows, prev: lastFrame, now: Date.now(), lastAt: lastFrameAt }) !== 'send') return;
  lastFrame = rows;
  lastFrameAt = Date.now();
  const size = (tmux('display-message', '-p', '-t', CLAUDE_PANE, '#{pane_width} #{pane_height}').stdout || '').trim().split(/\s+/);
  const ev = {
    t: 'screen', id: nextId++, ts: lastFrameAt, rows,
    w: Number(size[0]) || 80, h: Number(size[1]) || rows.length,
  };
  for (const ws of mirrors) if (clients.has(ws)) send(ws, ev);
}

function setMirror(ws, on) {
  if (on) mirrors.add(ws); else mirrors.delete(ws);
  if (mirrors.size && !frameTimer) {
    frameTimer = setInterval(pumpMirror, FRAME_MIN_GAP);
    frameTimer.unref?.();
  } else if (!mirrors.size && frameTimer) {
    clearInterval(frameTimer);
    frameTimer = null;
  }
  // A joiner wants the screen now, not in 250 ms — and it has never seen `lastFrame`.
  if (on) { lastFrame = null; lastFrameAt = 0; pumpMirror(); }
  console.log(`[mirror] ${clients.get(ws)?.name || '?'} ${on ? 'on' : 'off'} (${mirrors.size} watching)`);
}

// ----------------------------------------------------------- knock popups ----
// The host approves a knock without leaving the claude window. Popups land only on clients
// attached to the jam session itself — ttyd viewers sit on grouped sessions and never see
// them. One at a time: the next knock gets its popup when the current one closes, and a
// knock whose popup was ignored keeps waiting for /accept instead of popping again.
let popupProc = null;
let statusRightShown = null; // the '⚑ N waiting' we last wrote, null = the host's own value
let savedStatusRight; // undefined = never read; null = was inherited, so restore with -u

function saveStatusRight() {
  if (opts.noPopup) return;
  // Without -A this prints nothing unless status-right is set on the SESSION, which is
  // exactly the difference between "put the old value back" and "go back to inheriting".
  const set = tmux('show-options', '-t', opts.tmux, 'status-right');
  savedStatusRight = set.status === 0 && set.stdout.trim()
    ? (tmux('show-options', '-t', opts.tmux, '-v', 'status-right').stdout || '').replace(/\n$/, '')
    : null;
}

// Session option only: the host's global tmux config is never touched.
function restoreStatusRight() {
  if (!statusRightShown) return; // we never wrote one, so there is nothing to undo
  statusRightShown = null;
  if (savedStatusRight == null) tmux('set-option', '-u', '-t', opts.tmux, 'status-right');
  else tmux('set-option', '-t', opts.tmux, 'status-right', savedStatusRight);
}

function refreshStatusRight() {
  if (opts.noPopup) return;
  const want = statusRightWaiting(pending.size);
  if (want === statusRightShown) return;
  if (!want) return restoreStatusRight();
  statusRightShown = want;
  tmux('set-option', '-t', opts.tmux, 'status-right', want);
}

// display-popup needs a client attached to the jam session to draw on. With nobody attached
// it does NOT fail: the tmux client blocks forever waiting for one, which would wedge the
// queue and orphan a process. So ask first. `list-clients -t <session>` lists only clients
// attached to the base session — a ttyd viewer sits on a grouped session of its own and is
// not in here, which is exactly who must not see popups. The names are also what `-c` needs:
// without it tmux picks any client showing the window, viewers included (v0.9).
function hostClients() {
  const r = tmux('list-clients', '-t', opts.tmux, '-F', '#{client_name}');
  return r.status === 0 ? (r.stdout || '').split('\n').map((l) => l.trim()).filter(Boolean) : [];
}

function stopPopup() {
  if (!popupProc) return;
  const child = popupProc;
  popupProc = null;
  try { child.kill('SIGTERM'); } catch { /* already gone */ }
}

// Called on every change to `pending`: keeps the status line honest and opens the next popup.
function pumpPopups() {
  refreshStatusRight();
  if (opts.noPopup || popupProc) return;
  const next = [...pending.values()].find((p) => !p.popped);
  if (!next) return;
  next.popped = true;
  // The /accept line logged with the knock itself is still the way in.
  const client = hostClients()[0];
  if (!client) return console.log(`[knock] no client attached — no popup for ${next.name}`);
  const child = spawn(TMUX, buildPopupArgs({
    session: opts.tmux, client, node: process.execPath, script: path.join(HERE, 'popup.mjs'),
    name: next.name, ip: next.ip, ttlS: Math.round(KNOCK_TTL / 1000), port: opts.port,
    secret: opts.hookSecret,
  }), { stdio: ['ignore', 'ignore', 'pipe'] });
  popupProc = child;
  let err = '';
  child.stderr.on('data', (c) => { err += c; });
  // A popup that fails anyway (the client detached between the check and now, tmux gone)
  // must not matter: host clients already have the knock frame and /accept still works.
  child.on('exit', (code) => {
    if (popupProc === child) popupProc = null;
    if (code) console.log(`knock popup failed (tmux exit ${code}): ${err.trim() || 'no output'}`);
    pumpPopups();
  });
  child.on('error', (e) => {
    if (popupProc === child) popupProc = null;
    console.log(`knock popup failed: ${e.message}`);
  });
  console.log(`[knock] popup for ${next.name} on ${client} (tmux pid ${child.pid})`);
}

function daemon() {
  saveStatusRight();
  const http = createServer(onRequest);
  // Frame size is enforced by ws before hello/token, so keep it just above MAX_TEXT
  // instead of the ~100 MB default an unauthenticated peer could throw at us.
  const wss = new WebSocketServer({ server: http, maxPayload: 64 * 1024 });
  wss.on('connection', onSocket);
  http.listen(opts.port, opts.host, () => {
    console.log(`claude-jam daemon on ${opts.host}:${opts.port}, session ${opts.sessionId}`);
    writeTokenFile();
    // Printed by the launcher too, but that copy scrolls away under `tmux attach`; this is
    // the one the host can still read in the daemon window. The globs come with it: a
    // profile on another machine keeps its transcripts somewhere else entirely.
    if (opts.configDir) {
      console.log(`claude profile: ${opts.configDir}`);
      console.log(`tail globs: ${jsonlGlobs(opts.sessionId, os.homedir(), opts.configDir).join('  ')}`);
    }
    if (ttyd) startView();
    else if (!opts.noView) console.log('install ttyd for the live view (brew install ttyd)');
    startTunnels();
    // The launcher's own join-line print happens right before `tmux attach` takes over
    // the screen, so the host never sees it — this is the copy that's actually visible,
    // in the `daemon` tmux window.
    printJoin();
    console.log(`state ${opts.state}`);
  });
  // The ttyd/cloudflared children are ours alone. tmux kill-session hangs up the daemon
  // window, and a SIGHUP would otherwise skip the exit handler and leave them orphaned.
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { stopView(); stopTunnels(); stopPopup(); restoreStatusRight(); process.exit(0); });
  process.on('exit', () => { stopView(); stopTunnels(); stopPopup(); restoreStatusRight(); });
  setInterval(tailJsonl, 300).unref?.();
}

function onRequest(req, res) {
  const reply = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (req.method === 'GET' && req.url === '/health') {
    // Liveness is public (the launcher polls it); real names need the token.
    return reply(200, tokenMatches(req.headers['x-jam-token'], currentToken) ? { ok: 'ok', participants: names() } : { ok: 'ok' });
  }
  // popup.mjs answers a knock through here. Same guard as /hook: loopback plus the
  // internal secret, so a rotated friend token never reaches it.
  if (req.method === 'POST' && req.url === '/admit') {
    if (!isLoopback(req.socket.remoteAddress)) return reply(403, { error: 'loopback only' });
    if (!tokenMatches(req.headers['x-jam-secret'], opts.hookSecret)) return reply(403, { error: 'bad secret' });
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e4) req.destroy(); });
    req.on('end', () => {
      let m;
      try { m = JSON.parse(body); } catch { return reply(400, { error: 'bad JSON' }); }
      // Exactly the path a host client's `admit` frame takes. A knock that expired or was
      // already answered in a client is a 404, and the popup exits silently.
      const err = admit(m?.name, m?.ok === true);
      reply(err ? 404 : 200, err ? { error: err } : { ok: true });
    });
    return;
  }
  const hook = /^\/hook\/(\w[\w-]*)$/.exec(req.url || '');
  if (req.method === 'POST' && hook) {
    if (!isLoopback(req.socket.remoteAddress)) return reply(403, { error: 'loopback only' });
    // Hooks carry the internal secret, so `/token off` and every rotation leave them working.
    if (!tokenMatches(req.headers['x-jam-secret'], opts.hookSecret)) return reply(403, { error: 'bad secret' });
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => { onHook(hook[1], body); reply(200, { ok: true }); });
    return;
  }
  reply(404, { error: 'not found' });
}

function onHook(event, body) {
  let payload = {};
  try { payload = JSON.parse(body); } catch { /* hooks must never break the session */ }
  if (event === 'stop') {
    // Stop fires the instant the turn ends, but claude flushes the turn's last record to
    // the JSONL a beat later (~100 ms measured) and the tail only polls every 300 ms.
    // Drain until the file goes quiet, so the final agent text is broadcast BEFORE
    // busy:false instead of after it.
    status.waiting = false;
    const gen = busyGen;
    drainTail().catch((e) => console.error('drain failed:', e.message)).then(() => {
      if (gen === busyGen) status.busy = false; // a new turn started meanwhile: leave it busy
      pushStatus();
    });
  } else if (event === 'notification') {
    const msg = String(payload.message || '');
    if (/permission|approve|allow/i.test(msg)) { status.waiting = true; pushStatus(); }
  }
}

const isLoopback = (ip) => { const s = String(ip || ''); return s.endsWith('127.0.0.1') || s === '::1'; };

// Both admission paths end here: the same welcome, the same roster broadcast.
function admitSocket(ws, name, host) {
  const me = { name, host, joinedAt: Date.now(), lastTyping: 0 };
  clients.set(ws, me);
  send(ws, {
    t: 'welcome', id: nextId++, ts: Date.now(), you: name, roster: names(),
    history: history.slice(),
    // join is the invite line and view the ttyd URL; only the host client gets them —
    // friends never see the token-bearing command or the view key. null (but present) for
    // the host while no token is set / no view is running.
    session: { id: opts.sessionId, cwd: opts.cwd, hostName: opts.name, boot: BOOT, ...(host ? joinInfo() : {}) },
  });
  rosterChanged({ joined: name });
  send(ws, { t: 'status', id: nextId++, ts: Date.now(), busy: status.busy, waiting: status.waiting });
  // Knocks stay out of `history`, so a host client that connects (or reconnects) while
  // somebody is waiting would otherwise never hear about them.
  if (host) for (const p of pending.values()) send(ws, { t: 'knock', id: nextId++, ts: Date.now(), name: p.name, ip: p.ip });
}

// The one admission decision, shared by `/accept`/`/deny` in a host client ({t:'admit'})
// and by the in-TUI popup (POST /admit). No name = the only pending knocker. Returns null
// when it acted, or the reason nothing happened.
function admit(name, ok) {
  const waiting = [...pending.entries()];
  let hit;
  if (name == null || name === '') {
    if (waiting.length !== 1) {
      return waiting.length ? `${waiting.length} people are waiting — name one` : 'nobody is waiting';
    }
    hit = waiting[0];
  } else {
    hit = waiting.find(([, p]) => nameTaken(name, [p.name]));
    if (!hit) return `nobody named "${name}" is waiting`;
  }
  const [sock, p] = hit;
  clearTimeout(p.timer);
  pending.delete(sock);
  if (ok) {
    admitSocket(sock, p.name, false);
    console.log(`[admit] ${p.name} accepted`);
  } else {
    send(sock, { t: 'knock', id: nextId++, ts: Date.now(), state: 'denied' });
    sock.close(4403, 'denied');
    console.log(`[admit] ${p.name} denied`);
  }
  pumpPopups();
  return null;
}

// `/accept [name]` / `/deny <name>` arrive as {t:'admit', name, ok} from a host client.
function onAdmit(ws, m) {
  const err = admit(m.name, m.ok);
  if (err) sendError(ws, err);
}

// `/token new|set <v>|off` from a host client. Admission is checked only at hello time,
// so rotating never disconnects anyone already in.
function onToken(ws, m) {
  if (m.op === 'new') currentToken = newToken();
  else if (m.op === 'off') currentToken = null;
  else if (m.op === 'set') {
    if (!validTokenValue(m.value)) return sendError(ws, 'token must be 8-64 chars of [A-Za-z0-9_-]');
    currentToken = m.value;
  } else return sendError(ws, `unknown token op: ${m.op}`);
  // The view key follows the token: a fresh generated one whenever the token goes away,
  // so an old key never keeps working. Same key (`/token set` with the current value) is
  // not worth a restart.
  if (ttyd) {
    const next = resolveViewKey(currentToken, newToken);
    if (next !== viewKey) { viewKey = next; restartView(); }
  }
  writeTokenFile();
  // Rotation never respawns cloudflared — tunnelHosts is untouched — but the join command
  // embeds the token and the view URL embeds viewKey, so both tunnel strings still change.
  const { join, view, tunnelJoin, tunnelView } = joinInfo();
  sendHosts({ t: 'token', token: currentToken, join, view, tunnelJoin, tunnelView });
  printJoin();
}

function onSocket(ws, req) {
  const ip = String(req.socket.remoteAddress || '');
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return sendError(ws, 'bad JSON'); }
    const me = clients.get(ws); // set by admitSocket, on either admission path
    if (!me) {
      // A pending knocker can only wait: nothing it sends reaches claude, the roster or
      // the other participants.
      if (pending.has(ws)) return sendError(ws, 'waiting for host approval');
      if (m.t !== 'hello') return sendError(ws, 'say hello first');
      const c = classifyHello(m, currentToken, isLoopback(ip));
      if (!c.ok) { sendError(ws, c.error); return ws.close(c.code, c.error); }
      // Attribution is by name, and a knocker's name is reserved while it waits.
      if (nameTaken(c.name, [...names(), ...[...pending.values()].map((p) => p.name)])) {
        sendError(ws, `the name "${c.name}" is already taken here`);
        return ws.close(4409, 'name taken');
      }
      // `hello {mirror:true}` starts a client straight in mirror mode; the runtime
      // {t:'mirror'} frame (F2 / `/mirror`) is the same switch.
      if (c.admit === 'token') {
        admitSocket(ws, c.name, c.host);
        if (m.mirror === true) setMirror(ws, true);
        return;
      }
      if (pending.size >= MAX_PENDING) {
        sendError(ws, 'too many people are waiting for approval');
        return ws.close(4429, 'too many knocks');
      }
      const timer = setTimeout(() => {
        pending.delete(ws);
        send(ws, { t: 'knock', id: nextId++, ts: Date.now(), state: 'expired' });
        ws.close(4408, 'knock expired');
        pumpPopups();
      }, KNOCK_TTL);
      pending.set(ws, { name: c.name, ip, timer });
      send(ws, { t: 'knock', id: nextId++, ts: Date.now(), state: 'pending' });
      sendHosts({ t: 'knock', name: c.name, ip });
      console.log(`[knock] ${c.name} from ${ip} — /accept ${c.name} | /deny ${c.name}`);
      pumpPopups();
      return;
    }
    if (m.t === 'say') {
      const s = sanitize(m.text);
      if (!s.ok) return sendError(ws, s.error);
      // Check after sanitize: trim() alone leaves a leading zero-width space in place,
      // which would sneak "/exit" past this guard.
      if (s.text.startsWith('/')) return sendError(ws, 'slash commands run only in the host TUI');
      const text = neutralizePrefixes(s.text);
      broadcast({ t: 'say', from: me.name, text });
      status.busy = true; startTurn(); pushStatus();
      enqueueInject(me.name, text, ws);
    } else if (m.t === 'chat') {
      const s = sanitize(m.text);
      if (!s.ok) return sendError(ws, s.error);
      broadcast({ t: 'chat', from: me.name, text: s.text });
    } else if (m.t === 'typing') {
      const now = Date.now();
      if (now - me.lastTyping < 1000) return;
      me.lastTyping = now;
      broadcast({ t: 'typing', from: me.name });
    } else if (m.t === 'mirror') {
      // View-only sugar: everybody may watch, nobody types through it.
      setMirror(ws, m.on !== false);
    } else if (m.t === 'admit') {
      if (!me.host) return sendError(ws, 'host only');
      onAdmit(ws, m);
    } else if (m.t === 'token') {
      if (!me.host) return sendError(ws, 'host only');
      onToken(ws, m);
    } else {
      sendError(ws, `unknown message type: ${m.t}`);
    }
  });
  ws.on('close', () => {
    const p = pending.get(ws);
    if (p) { clearTimeout(p.timer); pending.delete(ws); pumpPopups(); }
    const me = clients.get(ws);
    // Drop the mirror subscription first: the last watcher leaving stops the capture timer.
    if (mirrors.has(ws)) setMirror(ws, false);
    if (me && clients.delete(ws)) rosterChanged({ left: me.name });
  });
  ws.on('error', () => { /* client vanished */ });
}

// --------------------------------------------------------------- injection ----
let queue = Promise.resolve();
let bufN = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function enqueueInject(name, text, ws) {
  queue = queue.then(() => inject(name, text)).catch((e) => {
    console.error('inject failed:', e.message);
    if (ws) sendError(ws, `injection failed: ${e.message}`);
    // Nothing was submitted, so no Stop hook is coming to clear this.
    if (status.busy) { status.busy = false; pushStatus(); }
  });
}

const capture = () => tmux('capture-pane', '-p', '-t', CLAUDE_PANE).stdout || '';

// A fresh cwd makes claude ask "Is this a project you created or one you trust?".
// Nobody is watching this pane, so answer it — and note the highlighted default is
// "No, exit", so a blind Enter would kill the session. Move onto the trust option first.
// Runs before EVERY injection until it succeeds once. A first message can arrive while
// claude is still booting: back when one attempt was enough, an empty pane counted as
// "checked", the paste went nowhere and the dialog that rendered a second later got the
// next message's Enter — i.e. "No, exit". So poll until the input prompt is actually up.
// Once it is, never scan again: capture() is the whole pane, so later on an ordinary
// message containing "trust this folder" would send stray Downs into a live TUI.
let ready = false;
async function ensureReady() {
  if (ready) return;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const lines = capture().split('\n');
    if (lines.some((l) => /trust this folder/i.test(l))) {
      const cursor = lines.find((l) => l.trim().startsWith('❯')) || '';
      if (/trust this folder/i.test(cursor)) {
        tmux('send-keys', '-t', CLAUDE_PANE, 'C-m');
        await sleep(2000); // let the dialog go away before looking again
      } else {
        tmux('send-keys', '-t', CLAUDE_PANE, 'Down');
        await sleep(300);
      }
      continue;
    }
    // No dialog text, so a prompt glyph here is the real input box.
    if (/❯|^> ?$/m.test(lines.slice(-5).join('\n'))) { ready = true; return; }
    await sleep(250);
  }
  // Give up and paste anyway (Claude Code queues input), but stay un-ready so the next
  // injection re-checks instead of assuming a dialog can no longer appear.
}

async function inject(name, text) {
  const payload = `[${name}]: ${text}`;
  await ensureReady();
  // Wait for the input box. Claude Code queues text typed mid-response, so a timeout
  // is not fatal — paste anyway.
  for (let i = 0; i < 8; i++) {
    if (/❯|^> ?$/m.test(capture().split('\n').slice(-5).join('\n'))) break;
    await sleep(250);
  }
  const file = path.join(opts.state, 'inject.txt');
  const buf = `jam${++bufN}`;
  try {
    fs.writeFileSync(file, payload); // never argv, never a shell
    tmux('load-buffer', '-b', buf, file);
    tmux('paste-buffer', '-b', buf, '-d', '-p', '-t', CLAUDE_PANE);
    // Assert it landed before submitting; pressing Enter into a pane that never got the
    // paste would submit whatever was already there.
    // The probe must be ONE visual line: claude indents continuation/wrapped lines, so a
    // probe containing a newline (or wider than the pane) can never match the capture.
    // ponytail: probe is the message's own first chars, so two identical consecutive
    // messages can match a stale echo. Prepend a nonce line (see rr-ctl.sh) if it bites.
    const width = Number(tmux('display-message', '-p', '-t', CLAUDE_PANE, '#{pane_width}').stdout) || 80;
    const probe = payload.split('\n')[0].slice(0, Math.max(8, Math.min(40, width - 12)));
    for (let i = 0; i < 24; i++) {
      if (capture().split('\n').slice(-15).join('\n').includes(probe)) {
        tmux('send-keys', '-t', CLAUDE_PANE, 'C-m');
        return;
      }
      await sleep(250);
    }
    // Leave nothing in the input box, or the next injection submits both messages glued.
    tmux('send-keys', '-t', CLAUDE_PANE, 'C-u');
    throw new Error('pasted text never appeared in the claude pane');
  } finally {
    fs.rmSync(file, { force: true });
    tmux('delete-buffer', '-b', buf);
  }
}

// ------------------------------------------------------------- jsonl tail ----
let jsonlPath = null;
let offset = 0;
let partial = '';
// A poll can land mid-codepoint; StringDecoder holds the trailing bytes for next time.
let decoder = new StringDecoder('utf8');

function findJsonl() {
  for (const glob of jsonlGlobs(opts.sessionId, os.homedir(), opts.configDir)) {
    const hit = fs.globSync(glob)[0];
    // realpath so a --config-dir whose projects/ is symlinked to the default one (the usual
    // case on the host's own machine) settles on the same path either glob found it by.
    if (hit) { try { return fs.realpathSync(hit); } catch { return hit; } }
  }
  return null;
}

// Returns true when it consumed new bytes — drainTail uses that to know it is behind.
function tailJsonl() {
  if (!jsonlPath) {
    jsonlPath = findJsonl();
    if (!jsonlPath) return false;
    console.log('tailing', jsonlPath);
    // On resume the file already has history; start at its current size so old turns
    // are not re-broadcast. ponytail: friends who join after this point still see none
    // of the pre-resume history; add a `--replay N` flag later if that's wanted.
    if (opts.resume) { try { offset = fs.statSync(jsonlPath).size; } catch { /* file just vanished; keep offset 0 */ } }
  }
  let size;
  try { size = fs.statSync(jsonlPath).size; } catch { return false; }
  if (size < offset) { offset = 0; partial = ''; decoder = new StringDecoder('utf8'); }
  if (size === offset) return false;
  const fd = fs.openSync(jsonlPath, 'r');
  const buf = Buffer.alloc(size - offset);
  let read = 0;
  try { read = fs.readSync(fd, buf, 0, buf.length, offset); } finally { fs.closeSync(fd); }
  if (!read) return false;
  offset += read; // only what we actually got, so a short read is retried
  const lines = (partial + decoder.write(buf.subarray(0, read))).split('\n');
  partial = lines.pop() ?? '';
  for (const line of lines) for (const e of parseJsonlLine(line)) onTranscript(e);
  return true;
}

// Read the transcript until it stops growing (two quiet reads) or the budget runs out.
// Called on Stop: the turn is over, so "quiet" really means "we have it all".
async function drainTail(maxMs = 2000) {
  const deadline = Date.now() + maxMs;
  for (let quiet = 0; quiet < 2 && Date.now() < deadline;) {
    quiet = tailJsonl() ? 0 : quiet + 1;
    await sleep(100);
  }
}

function onTranscript(e) {
  // An assistant record (text OR the tool_use that just started running) means the
  // permission prompt was answered. A tool RESULT is deliberately NOT in that set: it rides
  // in a user record but is pure plumbing, and it must not touch busy, waiting or
  // attribution — only produce a `⎿` line.
  if ((e.kind === 'text' || e.kind === 'tool') && status.waiting) { status.waiting = false; pushStatus(); }
  // Agent text lands in everyone's terminal, so strip escapes here too.
  const text = stripControl(e.text);
  if (e.kind === 'user') {
    if (e.bridged) return; // already broadcast at injection time
    broadcast({ t: 'say', from: opts.name, text });
    startTurn();
    if (!status.busy) { status.busy = true; pushStatus(); }
  } else if (e.kind === 'text') {
    broadcast({ t: 'agent', kind: 'text', text });
  } else if (e.kind === 'tool') {
    broadcast({ t: 'agent', kind: 'tool', text });
  } else if (e.kind === 'tool-result') {
    const act = toolResultAction(toolResults++);
    if (act !== 'skip') broadcast({ t: 'agent', kind: 'tool-result', text: act === 'show' ? text : '…' });
  }
}

if (opts.daemon) daemon(); else launch();
