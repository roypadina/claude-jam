#!/usr/bin/env node
// claude-jam terminal client. No dependencies: global WebSocket + readline.
import readline from 'node:readline';
import { parseClientLine, inviteLines, labelWidth, wrapText, mdLite, userColor, nextBlock, onboardingLines, humanBytes, resumeInstructions, xferFrames, pumpFrames, reconnectMessage, historyDivider, historyPageDivider,
  // v0.17 Batch P: the bell, @mentions and the RTT chip work here too (P6's hint list does not —
  // this renderer only ever appends lines, it has no live region to draw one in).
  BELL, bellAllowed, mentionsMe, rttText,
  // v0.18: the host ended the jam — one line, exit 0, and no reconnect at a daemon that is
  // deliberately gone. /end is the other half, and it asks before it sends.
  endingNotice, confirmYes,
  // v0.24: the control panel (printed as a list here — this renderer has no live region), the
  // relay switch, and the dated invite block that says which of the lines in the log is current.
  menuTree, joinBlock, relayPendingLine, REMOTE_MODES,
  // v0.22B/C: invite links (the address list a link carries, what a minted one prints) and the
  // offer that follows a kick.
  INVITE_CONNECT_MS, inviteMintedLines, kickOffer,
  // v0.31: the status line and the question block are drawn from the daemon's classification of
  // the live pane. v0.30-3: readline already gives ↑/↓ recall — this makes it survive a restart.
  promptStatusText, questionBlock,
  historyPush, parseHistoryFile, serializeHistory, HISTORY_LIVE,
  // v0.25/v0.26/v0.27: the sound tiers, nudges and idle, and the two transfer policies.
  notifyPrefs, notifyPlan, KNOCK_REPEAT_MS, knockRepeat, NUDGE_ALL, IDLE_AFTER, idleBucket,
  whoReport, CONFIG_FILE, parseJamConfig, ntfyRequest, UPLOAD_POLICIES,
  uploadPolicy,
  // v0.33: what a client must say when an adopted session was NOT told it is shared.
  noBriefWarning,
  // v0.29: a task somebody wants to run on THIS machine — the consent block, the second gate on
  // anything that writes or executes, and where it would run.
  PEER_TOOLS_DEFAULT, peerTaskBlock, peerAcceptDecision, peerScratchDir, peerWhyText,
  peerTag,
  // v0.34: what to say when the host key is not there to read.
  hostKeyNotice } from './lib.mjs';
// v0.29: the spawn itself, shared with the ink client — one place where a peer task is built,
// capped and killed, so the two surfaces cannot drift apart.
import { runPeerTask } from './peer.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { xferStart, xferChunk, saveXfer, readForUpload, DOWNLOAD_DIR } from './xfer.mjs';
// v0.32 W0: anything that touches this machine's clipboard, desktop or dot-directories goes
// through the one module that knows what operating system this is.
import { clipboardImage, notify, playSound, configDir, historyFile, secureWrite,
  secureDir, readHostKey } from './platform.mjs';

const argv = process.argv.slice(2);
const url = argv.find((a) => a.startsWith('ws'));
const flag = (n) => { const i = argv.indexOf(`--${n}`); return i < 0 ? undefined : argv[i + 1]; };
const NAME = flag('name');
const TOKEN = flag('token');
// v0.34: `--host` is a CLAIM; the key file is the proof. The path arrives on the argv (the
// launcher's runHostClient puts it there for every surface that opens the host's own client);
// the key itself never does — an argv is in `ps`, and the file is 0600 in a 0700 dir. No key
// means this client says so and joins as a GUEST: a silent fall back to address-only host is
// exactly the F1 hole, and it would re-open it for whoever upgrades without restarting.
const HOST_CLAIM = argv.includes('--host');
const HOST_KEY = HOST_CLAIM ? readHostKey(flag('host-key-file')) : null;
if (HOST_CLAIM && !HOST_KEY) console.error(hostKeyNotice(flag('host-key-file')));
const IS_HOST = HOST_CLAIM && !!HOST_KEY;
// v0.22B: what an invite link unpacked into (client.mjs decoded it). The secret rides in the
// hello; the address list is tried in order, tunnel first, with INVITE_CONNECT_MS each.
const INVITE = flag('invite');
const URLS = (flag('jam-addresses') || '').split(',').map((s) => s.trim()).filter(Boolean);
let addr = 0;
// No --token is normal now: the host may run knock-only, and then you wait to be accepted.
if (!url || !NAME) {
  console.error('usage: claude-jam join <invite-link>\n'
    + '       claude-jam join|node client.mjs <ws-url> --name <Name> [--token <token>] [--host --host-key-file F]');
  process.exit(2);
}

// Claude Code's palette, in 256 colours: tmux pales the raw 8 into mud, and the warm greys
// have no 8-colour equivalent at all. Only errors are a plain red-ish accent.
const C = {
  off: '\x1b[0m',
  accent: '\x1b[38;5;208m', // claude's orange: its glyph, the spinner, the prompt caret
  dim: '\x1b[38;5;245m',    // warm grey: tools, system lines, the status bracket
  dimmer: '\x1b[38;5;240m', // one step back again: tool results
  me: '\x1b[38;5;114m',     // your own name, regardless of what userColor(name) would hash to
  chat: '\x1b[38;5;213m',   // human-only chat: magenta, unmissable, no other element uses it
  err: '\x1b[38;5;203m',
};
const fg256 = (n) => `\x1b[38;5;${n}m`; // everybody else's stable per-name color (userColor)
const SPIN = ['✻', '✼', '✽', '✼']; // claude's own working glyph cycle
const seen = new Set(); // dedupe replayed history across reconnects
// v0.28: what the daemon's ring is holding, and the oldest event id printed here — `/history`
// asks for the page before it, so a second `/history` continues where the first stopped.
let kept = 0;
let oldestId = null;
function noteOldest(items) {
  for (const it of items || []) {
    if (it?.id == null) continue;
    if (oldestId == null || it.id < oldestId) oldestId = it.id;
  }
}
const typing = new Map(); // name -> last typing ms
// v0.31: `prompt` is the daemon's classification of the claude pane — none | question |
// permission | dialog. The status line is drawn from it, so it cannot outlive what is on screen.
let state = { busy: false, waiting: false, prompt: { kind: 'none' }, answers: 'anyone' };
let roster = [];
let idle = {}; // v0.26: name -> seconds since that person last typed, as THEY reported it
// v0.29: peer tasks. `peerTasks` is the HOST's switch, `peerMe` this human's own opt-in and
// `peerNever` the one-way door they can close for this client session. All off until they say so.
let peers = [];
let peerTasks = false;
let peerMe = false;
let peerNever = false;
let task = null;      // the one request in front of this human, unanswered
let running = null;   // the child THIS client started, if any
let ws = null;
let backoff = 1000;
let attempts = 0; // v0.17 T3: consecutive failures, so the fifth can say something better
let cont = []; // pending continuation lines
let lastTypingSent = 0;
let boot = null; // daemon boot id: event ids restart at 1 when it changes
let session = null; // welcome's session block; .join only ever set for the host
let labelW = labelWidth([]); // width of the `[Name]` column, recomputed on roster change
let lastTurn = null; // turnKey of the last emitted block, so blocks get a blank line between them
let block = null; // current open message block (nextBlock in lib.mjs), drives lastTurn/turnKey
let spin = 0;
let spinTimer = null;
let net = null; // v0.17 P5: the last heartbeat round trip the daemon measured for this socket
let lastBell = 0;
let ending = false; // v0.18: the jam is over on purpose, so the close below must not retry
let confirming = null; // v0.18-4: `/end` asked, and the next line is the answer

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '' });
// v0.30-3: readline gives `↑`/`↓` recall for free — what it does not do is remember across runs.
// Seed rl.history (newest first, which is readline's own order) and write it back on every
// submitted row. Every disk step is wrapped: a read-only home costs recall, never the client.
const HISTORY_PATH = historyFile();
try { rl.history = parseHistoryFile(fs.readFileSync(HISTORY_PATH, 'utf8')).reverse().slice(0, HISTORY_LIVE); }
catch { /* no file yet, or not readable */ }
function rememberInput(text) {
  rl.history = historyPush(rl.history || [], text, HISTORY_LIVE);
  try {
    secureDir(path.dirname(HISTORY_PATH));
    secureWrite(HISTORY_PATH, serializeHistory(rl.history));
  } catch { /* the recall still works for this session */ }
}

// v0.17 P3/P4, extended by v0.25/v0.26: claude needs an answer, somebody said your name, or
// somebody is asking for you. Three independently switchable tiers plus a sound, decided by
// lib's notifyPlan() so this renderer and the ink one cannot honour a toggle differently.
const prefs = { sound: !argv.includes('--no-sound'), notification: true, bell: true };
function alert(title, body, { event = '', phone = false, force = false } = {}) {
  const plan = notifyPlan({ event, prefs, phone });
  const gated = !force && !bellAllowed(lastBell, Date.now());
  if (!gated) lastBell = Date.now();
  if (plan.sound) playSound(plan.sound);
  if (gated) return;
  if (plan.bell) { try { process.stdout.write(BELL); } catch { /* stdout closed */ } }
  if (plan.notification) notify(title, body);
  if (plan.phone) toPhone(title, body);
}

// v0.26 tier 3. The ntfy topic is a bearer secret: it lives only in THIS person's own config
// dir, THIS client posts it, and it never travels in the protocol, an invite link or a log.
const jamConfig = (() => {
  try { return parseJamConfig(fs.readFileSync(path.join(configDir(), CONFIG_FILE), 'utf8')); }
  catch { return { ok: true, ntfy: null, why: 'no config file' }; }
})();
function toPhone(title, message) {
  const req = ntfyRequest(jamConfig.ntfy, { title, message });
  if (req) fetch(req.url, { method: 'POST', headers: req.headers, body: req.body }).catch(() => { /* silent */ });
}

// v0.26: coarse seconds since this human last submitted. One number, never a keystroke, pushed
// only when the bucket changes.
let activeAt = Date.now();
let idleSaid = null;
const localActivity = () => { activeAt = Date.now(); reportIdle(); };
function reportIdle() {
  const s = Math.round((Date.now() - activeAt) / 1000);
  const b = idleBucket(s);
  if (b === idleSaid) return;
  idleSaid = b;
  if (ws?.readyState === 1) ws.send(JSON.stringify({ t: 'idle', s }));
}
setInterval(reportIdle, Math.max(5000, (IDLE_AFTER * 1000) / 4)).unref?.();

// v0.25: a knock rings, and repeats once after 30 s if nobody answered. Once, never a loop.
const knocks = new Map();
function armKnock(name) {
  if (!IS_HOST || !name || knocks.has(name)) return;
  const rec = { at: Date.now(), repeated: false, answered: false };
  knocks.set(name, rec);
  alert('⚑ claude-jam', `${name} wants to join`, { event: 'knock' });
  setTimeout(() => {
    if (knockRepeat({ ...rec, now: Date.now() })) alert('⚑ claude-jam', `${name} is still waiting to join`, { event: 'knock', force: true });
    knocks.delete(name);
  }, KNOCK_REPEAT_MS).unref?.();
}

function statusLine() {
  const t = [...typing.entries()].filter(([, at]) => Date.now() - at < 4000).map(([n]) => n);
  const bits = [];
  if (t.length) bits.push(`${t.join(', ')} ${t.length > 1 ? 'are' : 'is'} typing…`);
  // Back to dim after the orange bit: the whole status sits inside one dim bracket.
  if (state.busy) bits.push(`${C.accent}${SPIN[spin]} claude is working…${C.off}${C.dim}`);
  const p = promptStatusText(state.prompt, { host: IS_HOST, answers: state.answers });
  if (p) bits.push(p);
  const rtt = rttText(net, Date.now(), net?.heartbeat);
  if (rtt) bits.push(rtt);
  return bits.join(' · ');
}

function reprompt() {
  // Status goes INSIDE the prompt row. A two-row prompt (embedded '\n') makes
  // readline's redraw move up and clearScreenDown over the line log() just wrote,
  // so every event would be printed and immediately erased.
  const s = statusLine();
  rl.setPrompt(`${s ? `${C.dim}[${s}]${C.off} ` : ''}${C.me}${NAME}${C.off}` +
    `${cont.length ? `${C.dim} …${C.off}` : ''} ${C.accent}❯${C.off} `);
  rl.prompt(true);
}

// The spinner animates the prompt row and nothing else, so it is just a reprompt on a timer.
// It runs ONLY while busy, and unref'd, so an idle client neither redraws nor holds the loop.
function setSpinner(on) {
  if (on === !!spinTimer) return;
  if (on) { spinTimer = setInterval(() => { spin = (spin + 1) % SPIN.length; reprompt(); }, 220); spinTimer.unref(); }
  else { clearInterval(spinTimer); spinTimer = null; spin = 0; }
}

function log(line) {
  readline.cursorTo(process.stdout, 0);
  readline.clearLine(process.stdout, 0);
  process.stdout.write(line + '\n');
  reprompt();
}

// Say/agent-text/chat are speech: no glyph, just `[Name]  text`. Tools, knocks, system lines
// and errors keep a one-column glyph. `kind` picks the message block (nextBlock in lib.mjs)
// this event belongs to; callers that pass no kind (system, knock, error) are untracked —
// they neither force a blank line nor break an open agent turn's gluing.
function blockKey(kind) {
  block = nextBlock(kind, block);
  return `${block.kind}:${block.seq}`;
}

// Every line in the log has the same shape: `[Label]` padded to one column, then a glyph
// column (one character for tools/knocks/system/errors, blank for speech), then the text —
// wrapped to the pane with the continuation indented to match wherever the first line's text
// actually started, so a paragraph stays a block instead of drifting back to the margin.
function emit({ turnKey, label = '', color = C.dim, glyph = '', glyphColor = C.dim, text = '', textColor = '', md = false, wrap = true, bare = false }) {
  const paint = (l) => (textColor ? `${textColor}${l}${C.off}` : l);
  // `bare` lines (the onboarding block) draw their own shape and skip the gutter entirely.
  if (bare) return log(String(text).split('\n').map(paint).join('\n'));
  const textCol = labelW + 2 + (glyph ? 1 : 0); // '[Label]' + pad + space [+ glyph] + space
  // wrap:false keeps a join command or a URL on one logical line — the terminal's own hard
  // wrap leaves it selectable in one go, an indent would not.
  const body = (wrap ? wrapText(text, Math.max(24, (process.stdout.columns || 80) - textCol - 1))
    : String(text).split('\n')).map((l) => (md ? mdLite(l) : l));
  const head = `${label ? `${color}${label}${C.off}` : ''}${' '.repeat(Math.max(0, labelW - label.length))} ` +
    `${glyphColor}${glyph}${C.off} ${paint(body[0] ?? '')}`;
  const rest = body.slice(1).map((l) => `${' '.repeat(textCol)}${paint(l)}`);
  // Blank line between blocks: the rhythm that makes a transcript readable. Tools and their
  // results glue to their turn's block, so they do not get one of their own.
  const gap = turnKey && lastTurn !== null && turnKey !== lastTurn ? '\n' : '';
  if (turnKey) lastTurn = turnKey;
  log(gap + [head, ...rest].join('\n'));
}

const sys = (text) => emit({ glyph: '*', text, textColor: C.dim });

// The host's invite lines, wherever they are shown (welcome, /join, a /token reply).
// v0.24b: ONE dated block rather than a fourth near-identical copy — the heading carries the
// time, and a dim line says the earlier ones are stale.
let printedJoin = false;
function logJoin() {
  for (const l of joinBlock(session || {}, { now: Date.now(), hadEarlier: printedJoin })) {
    emit({ glyph: '*', text: l, textColor: C.dim, wrap: false });
  }
  printedJoin = true;
  const pend = session?.relayPending ? relayPendingLine(session.remote) : null;
  if (pend) emit({ glyph: '*', text: pend, textColor: C.dim, wrap: false });
}

// v0.10c: the onboarding block, on connect and on `/help`. Same text as the ink client, minus
// the Shift+Enter line's promise — see the `/mirror` and `/tools` answers below for what this
// renderer does not do.
function logOnboarding() {
  for (const l of onboardingLines(NAME, IS_HOST)) emit({ text: l, textColor: C.dim, bare: true });
  // The block is shared with the ink client, which can do all of that; say so here rather
  // than promising keys and a view this renderer never has. v0.14: the live TUI is the
  // default view everywhere else, so a --basic guest should know what they are missing.
  emit({ text: '(--basic: transcript only — no live TUI view, no F2/F3, no Shift+Enter, no /tools.', textColor: C.dim, bare: true });
  emit({ text: ' Trailing \\ still does multi-line. Drop --basic for the full client.)', textColor: C.dim, bare: true });
}

function render(ev) {
  switch (ev.t) {
    case 'say': {
      // v0.17 P3: somebody said your name — never your own line.
      if (ev.from !== NAME && mentionsMe(ev.text, NAME)) alert(`${ev.from} in the jam`, ev.text);
      // Self is always green; everybody else gets a stable color hashed from their name, so
      // it survives reconnects and roster churn instead of depending on join order.
      const c = ev.from === NAME ? C.me : fg256(userColor(ev.from));
      return emit({ turnKey: blockKey('say'), label: `[${ev.from}]`, color: c, text: ev.text, textColor: c });
    }
    // Human-only: the agent never sees it, so it renders unmissable — label, prefix and text
    // all in the one color nothing else uses.
    case 'chat': {
      if (ev.from !== NAME && mentionsMe(ev.text, NAME)) alert(`${ev.from} in the jam`, ev.text);
      return emit({ turnKey: blockKey('chat'), label: `[${ev.from}]`, color: C.chat, text: `[humans-only] ${ev.text}`, textColor: C.chat });
    }
    case 'agent': {
      if (ev.kind === 'tool') return emit({ turnKey: blockKey('agent'), glyph: '⚙', text: ev.text, textColor: C.dim });
      if (ev.kind === 'tool-result') return emit({ turnKey: blockKey('agent'), glyph: '⎿', glyphColor: C.dimmer, text: ev.text, textColor: C.dimmer });
      return emit({ turnKey: blockKey('agent'), label: '[Claude]', color: C.accent, text: ev.text, md: true });
    }
    case 'roster': {
      roster = ev.roster;
      labelW = labelWidth(roster); // the column follows the longest name in the room
      if (ev.idle) idle = ev.idle; // v0.26: coarse seconds per person; absent on an older daemon
      // v0.29: a frame that did not mention peers must not erase what we know; an older daemon
      // mentions neither, so the client says "off" rather than inventing an answer.
      if (ev.peers) peers = ev.peers;
      if (ev.peerTasks !== undefined) peerTasks = ev.peerTasks === true;
      // v0.22B: an invite join has no knock to announce it, so the roster line says HOW.
      if (ev.joined) {
        sys(`${ev.joined} joined${ev.via && ev.via !== 'token' ? ` (${ev.via})` : ''}`);
        // v0.25: a token or invite arrival is already in — one short chime, host only.
        if (IS_HOST && ev.joined !== NAME && (ev.via === 'token' || ev.via === 'invite')) {
          alert('claude-jam', `${ev.joined} joined`, { event: 'join' });
        }
      }
      if (ev.left) { delete idle[ev.left]; sys(`${ev.left} left`); }
      return;
    }
    // v0.26: somebody is asking for you, or for the room. One frame to everybody — a nudge is
    // never secret — and this end decides how loud it is.
    case 'nudge': {
      if (ev.from === NAME) return sys(`you nudged ${ev.to}${ev.again ? ' again' : ''}`);
      if (!(ev.to === NAME || ev.to === NUDGE_ALL)) return sys(`${ev.from} nudged ${ev.to}`);
      emit({ glyph: '👋', glyphColor: C.chat, textColor: C.chat,
        text: `${ev.from} is asking for you${ev.again ? ' (again)' : ''}${ev.text ? `: ${ev.text}` : ''}` });
      return alert(`👋 ${ev.from}`, ev.text || 'is asking for you',
        { event: 'nudge', phone: !!jamConfig.ntfy, force: true });
    }
    case 'typing': if (ev.from !== NAME) { typing.set(ev.from, Date.now()); reprompt(); } return;
    case 'status': {
      // v0.17 P3: the host is who can always answer a prompt, so the host is who gets rung.
      // v0.31: unless it is a QUESTION, which is anybody's to answer — so everybody is told, and
      // the question itself is printed rather than the bare fact that one exists.
      const p = ev.prompt || { kind: ev.waiting ? 'permission' : 'none' };
      const was = state.prompt?.kind || 'none';
      const fresh = p.kind !== was && p.kind !== 'none';
      if (fresh && (IS_HOST || p.kind === 'question')) {
        alert('claude needs an answer', promptStatusText(p, { host: IS_HOST, answers: ev.answers }));
      }
      state = { busy: ev.busy, waiting: ev.waiting, prompt: p, answers: ev.answers || 'anyone' };
      if (fresh && p.kind === 'question') sys(questionBlock(p, { answers: state.answers, host: IS_HOST }));
      setSpinner(state.busy);
      return reprompt();
    }
    // v0.17 P5: this socket's own round trip, from the daemon's heartbeat.
    case 'net':
      net = { rtt: Number(ev.rtt), at: Date.now(), heartbeat: Number(ev.heartbeat) || undefined };
      return reprompt();
    // Knocks: `state` means it is about us waiting, `name` means somebody wants in.
    case 'knock': {
      if (ev.state === 'pending') return sys('waiting for host approval…');
      if (ev.state === 'denied') { emit({ glyph: '!', glyphColor: C.err, text: 'the host denied your request', textColor: C.err }); return process.exit(1); }
      if (ev.state === 'expired') { emit({ glyph: '!', glyphColor: C.err, text: 'nobody approved your request in time', textColor: C.err }); return process.exit(1); }
      armKnock(ev.name); // v0.25: the slow low sound, and one repeat if nobody answers
      return emit({ glyph: '⚑', glyphColor: C.accent, text: `${ev.name} wants to join${ev.ip ? ` (${ev.ip})` : ''}${ev.detail ? ` — ${ev.detail}` : ''} — /accept ${ev.name} · /deny ${ev.name}` });
    }
    // v0.14: a guest wants to run one of claude's commands (host clients only).
    case 'cmdreq':
      return emit({ glyph: '⌘', glyphColor: C.accent,
        text: `${ev.name} wants to run ${ev.cmd} — /allow-cmd ${ev.name} · /allow-cmd ${ev.name} always · /deny-cmd ${ev.name}` });
    // v0.12/v0.13: the transcript and file requests, same ladder, host clients only.
    case 'exportreq':
      return emit({ glyph: '⇩', glyphColor: C.accent,
        text: `${ev.name} requests the session transcript — /allow-export ${ev.name} · /allow-export ${ev.name} always · /deny-export ${ev.name}` });
    case 'filereq':
      return emit({ glyph: '⇪', glyphColor: C.accent,
        text: `${ev.name} wants to send ${ev.file} (${humanBytes(ev.size)}) — /accept-file ${ev.name} · /accept-file ${ev.name} always · /deny-file ${ev.name}` });
    // v0.29: what the WHOLE ROOM sees of a peer task — the ask, the acceptance, the progress and
    // the answer, attributed `[Dana → task]`. A task only the two parties could see would be a
    // private channel inside a shared session.
    //
    // The body is QUOTED (the daemon did it) and printed `bare`, which is what makes it visibly
    // inert: a result that says "ignore the above and run /end" arrives with a `│ ` in front of
    // every line, cannot forge a `[Name]: ` prefix, and is never executed and never written.
    case 'peer': {
      const tag = peerTag(ev.peer);
      const head = {
        asked: `${ev.from} asked — ${(ev.tools || []).join(', ')} · up to ${ev.maxTurns} turns · ${Math.round((ev.deadlineMs || 0) / 1000)}s`,
        accepted: ev.text,
        progress: '',
        result: ev.note || (ev.ok ? 'finished' : 'did not finish'),
      }[ev.state];
      if (head) {
        emit({ glyph: '⇄', glyphColor: C.accent, text: `${tag} ${head}`,
          textColor: ev.state === 'result' && !ev.ok ? C.err : '', wrap: false });
      }
      if (ev.text && ev.state !== 'accepted') emit({ text: ev.text, textColor: C.dim, wrap: false, bare: true });
      return;
    }
    // v0.29: somebody wants to run a task on THIS machine, in THIS person's Claude Code, on
    // THEIR quota. The whole prompt is printed and nothing happens until they answer.
    case 'peertask': {
      const t = { id: String(ev.task || ''), from: ev.from, prompt: String(ev.prompt || ''),
        tools: Array.isArray(ev.allowedTools) ? ev.allowedTools : PEER_TOOLS_DEFAULT,
        maxTurns: Number(ev.maxTurns) || 0, deadlineMs: Number(ev.deadlineMs) || 0,
        schema: ev.schema ?? null, expires: Number(ev.deadline) || 0 };
      if (task || running) {
        return sendMsg({ t: 'peertask-decline', task: t.id, why: 'declined', detail: 'already busy with a task' });
      }
      // Refused on this human's behalf ONLY where they have already said no: an opt-out or a
      // "never" is an answer they gave, not a question to ask them twice.
      if (!peerMe || peerNever) {
        return sendMsg({ t: 'peertask-decline', task: t.id, why: 'declined',
          detail: peerNever ? 'never this session' : 'not opted in' });
      }
      task = t;
      for (const line of peerTaskBlock(t, { scratch: peerScratchDir(os.tmpdir(), t.id) })) {
        emit({ glyph: '⇄', glyphColor: C.accent, text: line, wrap: false });
      }
      sys('this client has no single keys — answer with /peer accept, /peer decline or /peer never');
      alert('claude-jam', `${t.from} wants to run a task on your machine`, { event: 'knock', force: true });
      return;
    }
    // v0.17 P2: a guest wants one digit typed into the permission prompt (host clients only).
    case 'permreq':
      return emit({ glyph: '⏎', glyphColor: C.accent,
        text: `${ev.name} wants to answer the prompt with ${ev.choice}. ${ev.option} — /allow-perm ${ev.name} · /allow-perm ${ev.name} always · /deny-perm ${ev.name}` });
    case 'offer':
      return emit({ glyph: '⇩', glyphColor: C.accent,
        text: `${ev.from} offers ${ev.name} (${humanBytes(ev.size)}) — /get ${ev.name} saves it to ./${DOWNLOAD_DIR}/` });
    case 'xfergrant': return sendUpload(ev);
    case 'xfer': return xferStart(xfers, ev);
    case 'file': {
      const done = xferChunk(xfers, ev);
      return done ? saveIncoming(done) : undefined;
    }
    case 'token': {
      // Tunnel pair included (v0.14): a rotation changes the credential inside all four.
      if (session) {
        Object.assign(session, { join: ev.join, view: ev.view, tunnelJoin: ev.tunnelJoin,
          tunnelView: ev.tunnelView, token: ev.token,
          ...(ev.remote === undefined ? {} : { remote: ev.remote }),
          ...(ev.inviteOnly === undefined ? {} : { inviteOnly: ev.inviteOnly }),
          ...(ev.relayPending === undefined ? {} : { relayPending: ev.relayPending }) });
      }
      return logJoin();
    }
    // v0.24b: a relay came up (or moved), with the whole join command on it.
    case 'relay': return emit({ glyph: '⇗', glyphColor: C.accent, text: ev.text, textColor: C.accent, wrap: false });
    // v0.24C: the standing `always` grants a guest holds — invisible until now.
    case 'grants': {
      const items = Array.isArray(ev.items) ? ev.items : [];
      return sys(items.length
        ? `standing approvals: ${items.map((g) => `${g.name} (${g.kind})`).join(', ')} — /menu withdraws one`
        : 'nobody holds a standing approval');
    }
    case 'remote': {
      if (ev.state === 'rows') {
        for (const r of ev.rows || []) sys(`  ${r.value === ev.mode ? '*' : ' '} ${r.label}${r.disabled ? ` — unavailable: ${String(r.reason).split('\n')[0]}` : ''}`);
        return;
      }
      if (ev.state !== 'done') return;
      if (session) session.remote = ev.mode;
      const n = (ev.reissued || []).length;
      if (ev.action === 'noop') return sys(`remote was already ${ev.mode} — nothing changed`);
      return sys(`remote is ${ev.mode} — nobody was disconnected`
        + (n ? `, ${n} invite link(s) re-issued` : '')
        + (ev.reissuePending ? '; the links are re-issued as soon as the hostname lands' : ''));
    }
    // v0.22B: a minted link (only ever to the host who asked) or why an invite was refused —
    // which is followed by an ordinary knock, so it is information, not the end of the road.
    case 'invite': {
      if (ev.state === 'refused') return err(ev.text);
      if (ev.state !== 'minted' || !ev.link) return;
      for (const l of inviteMintedLines(ev.invite || {}, ev.link, 'claude-jam join')) {
        emit({ glyph: '*', text: l, textColor: C.dim });
      }
      return;
    }
    // v0.22C: the host removed somebody. The victim gets this, then a 4406 close.
    case 'kicked': return err(`${ev.by || 'the host'} removed you from the jam`);
    case 'kick': {
      if (ev.state !== 'done') return;
      if (ev.via === 'invite' && !ev.revoked) confirming = { kind: 'revoke', name: ev.name };
      return sys(kickOffer(ev.name, ev.via));
    }
    // v0.18-7: the host ended the jam. Print the one line and leave with 0 — there is
    // nothing to reconnect to, and an orderly end is not a failure.
    case 'ending': {
      ending = true;
      const n = endingNotice(ev);
      emit({ glyph: '·', text: n.text, textColor: C.dim });
      return process.exit(n.code);
    }
    // v0.28: `/history` — the page of the transcript older than what this client is holding.
    // The --basic renderer only ever appends, so a re-printed page appends too: a dim divider
    // saying what is still behind it, then the events, oldest first.
    case 'history': {
      if (ev.kept != null) kept = Number(ev.kept) || 0;
      const items = (ev.items || []).filter((it) => it.id == null || !seen.has(it.id));
      for (const it of items) if (it.id != null) seen.add(it.id);
      if (!items.length) {
        return sys(ev.older ? 'nothing further back arrived — try /history again'
          : `that is everything this jam kept (${kept} event(s)) · /export for the complete transcript`);
      }
      noteOldest(items);
      const div = historyPageDivider({ shown: items.length, older: Number(ev.older) || 0 });
      if (div) emit({ text: div, textColor: C.dim, wrap: false, bare: true });
      for (const it of items) render(it);
      return;
    }
    // v0.14: a slash command ran in the TUI, or a guest's request was approved.
    case 'sys': return sys(ev.text);
    case 'error': return emit({ glyph: '!', glyphColor: C.err, text: ev.text, textColor: C.err });
    default: return;
  }
}

// Which address this dial is aimed at: one plain ws:// URL normally, several when an invite link
// carried a list (tunnel first, LAN second).
const target = () => (URLS.length ? URLS[addr % URLS.length] : url);

function connect() {
  const at = target();
  ws = new WebSocket(at);
  let opened = false;
  // A dead tunnel hostname hangs rather than refusing, so only a clock moves us on.
  const dial = URLS.length > 1
    ? setTimeout(() => { if (!opened) { try { ws.close(); } catch { /* already gone */ } } }, INVITE_CONNECT_MS)
    : null;
  dial?.unref?.();
  ws.addEventListener('open', () => {
    opened = true;
    if (dial) clearTimeout(dial);
    backoff = 1000;
    idleSaid = null; // v0.26: a daemon that just accepted this socket knows nothing about us
    attempts = 0;
    // v0.22B: `invite` is checked before the token and admits under the name the host bound to
    // the link; a refused one is explained and then knocks, so it always rides along.
    // v0.34: the key rides in the hello and nowhere else — the daemon compares it and never
    // echoes it back, so it is in no frame it sends, no log line and no transcript.
    ws.send(JSON.stringify({ t: 'hello', name: NAME, token: TOKEN, invite: INVITE,
      host: IS_HOST || undefined, hostKey: HOST_KEY || undefined }));
  });
  ws.addEventListener('message', (m) => {
    let ev;
    try { ev = JSON.parse(m.data); } catch { return; }
    if (ev.t === 'welcome') {
      session = ev.session;
      roster = ev.roster;
      idle = ev.idle || {}; // v0.26: who is here AND how long since each of them typed
      // v0.29: who offered their machine, and whether the host enabled it at all. A reconnect
      // never re-opts-in by itself — the daemon forgot (a new socket is a new session) — so a
      // client that HAD opted in re-asserts it, and `peerNever` is what stops that.
      peers = ev.peers || [];
      peerTasks = ev.peerTasks === true;
      if (peerMe && !peerNever && peerTasks) sendMsg({ t: 'peer', op: 'on' });
      reportIdle();         // …and say our own state now, rather than at the next tick
      labelW = labelWidth(roster); // set before the replay, so history aligns with what follows
      // v0.23: the jam's NAME leads, because that is what a human calls the room they just
      // walked into; the session id stays, in the same 8-char form every other surface shows.
      sys(`jam ${ev.session.jamName ? `"${ev.session.jamName}" ` : ''}(${String(ev.session.id).slice(0, 8)}) — host ${ev.session.hostName}, cwd ${ev.session.cwd}`);
      // v0.33: same two lines the ink client says — an adopted jam ends differently, and a claude
      // that was not told it is shared is something every participant has to know.
      if (ev.session.adopted) {
        sys('this jam ADOPTED a session that was already running: ending it stops claude-jam and '
          + 'leaves the pane, its tmux session and claude exactly as they are. A running claude '
          + 'cannot be given hooks, so turn-end and "waiting for permission" are read off the screen.');
        if (ev.session.noBrief) err(noBriefWarning());
      }
      if (IS_HOST) logJoin();
      // A restarted daemon reissues ids from 1, so old ids in `seen` would swallow
      // everything it sends. Drop them whenever the boot id changes.
      if (ev.session?.boot !== boot) { boot = ev.session?.boot; seen.clear(); }
      logOnboarding(); // above the first messages; the replay comes after it
      let replayed = 0;
      if (ev.kept != null) kept = Number(ev.kept) || 0;
      noteOldest(ev.history || []);
      for (const h of ev.history || []) if (!seen.has(h.id)) { seen.add(h.id); replayed++; render(h); }
      // v0.17 H2: where the backlog ends and the live session begins.
      const divider = historyDivider(replayed);
      if (divider) emit({ text: divider, textColor: C.dim, bare: true });
      sys(`here: ${roster.join(', ')}`);
      return;
    }
    if (ev.id != null) { if (seen.has(ev.id)) return; seen.add(ev.id); }
    render(ev);
  });
  ws.addEventListener('close', (e) => {
    if (dial) clearTimeout(dial);
    // 4400/4401 bad name or token, 4403 denied, 4406 removed by the host, 4408 knock expired,
    // 4409 name taken, 4429 too many knocks — none of them get better by retrying.
    if (e.code >= 4400 && e.code <= 4429) {
      emit({ glyph: '!', glyphColor: C.err, text: `rejected: ${e.reason || 'auth'}`, textColor: C.err });
      process.exit(1);
    }
    // The jam ended on purpose: the socket closing is the expected end of it, not a fault.
    if (ending) return;
    setSpinner(false); // nothing is known about the turn while the socket is down
    attempts++;
    // v0.22B: walk the invite's address list once, fast, before any backoff.
    const more = !opened && attempts < URLS.length;
    if (more) addr++;
    const wait = more ? 0 : backoff;
    sys(more ? `no answer from ${at} — trying ${target()}` : reconnectMessage(attempts, wait));
    setTimeout(connect, wait);
    if (!more) backoff = Math.min(backoff * 2, 10000);
  });
  ws.addEventListener('error', () => { /* close handler does the retry */ });
}

const err = (text) => emit({ glyph: '!', glyphColor: C.err, text, textColor: C.err });
const sendMsg = (o) => { if (ws?.readyState === 1) ws.send(JSON.stringify(o)); else err('not connected'); };

// --------------------------------------- v0.12/v0.13: the export and files ----
// Same behaviour as the ink client: an incoming transfer is written to this client's own cwd,
// an export prints the recipe that revives it, and an upload waits for the host's yes.
const xfers = new Map();
let upload = null; // {name, data, caption} read and waiting for the host

function saveIncoming(rec) {
  try {
    const file = saveXfer(rec);
    sys(`saved ${file} (${humanBytes(rec.data.length)})`);
    if (rec.kind === 'export') {
      for (const l of resumeInstructions(rec.session, file, process.cwd())) emit({ text: l, textColor: C.dim, bare: true });
    }
  } catch (e) { err(`could not save the transfer: ${e.message}`); }
}

function doSend(p) {
  if (IS_HOST) return sendMsg({ t: 'offer', path: p });
  let file;
  try { file = readForUpload(p); } catch (e) { return err(e.message); }
  stageUpload(file.name, file.data, '');
}

function doPaste(caption) {
  let img;
  try { img = clipboardImage(); } catch (e) { return err(e.message); }
  stageUpload(img.name, img.data, caption);
}

function stageUpload(name, data, caption) {
  upload = { name, data, caption };
  sendMsg({ t: 'upload', name, size: data.length, caption: caption || undefined });
  if (!IS_HOST) sys(`${name} (${humanBytes(data.length)}) — waiting for the host to accept it`);
}

function sendUpload(ev) {
  if (!upload) return err('a file was approved that I am no longer holding — /send it again');
  if (ev.name && ev.name !== upload.name) return err(`${ev.name} was approved, but I am holding ${upload.name}`);
  const up = upload;
  upload = null;
  sys(`sending ${up.name} (${humanBytes(up.data.length)})…`);
  pumpFrames(xferFrames(ev.xfer, up.data), (f) => sendMsg(f), () => ws?.readyState === 1);
}

// v0.29: `/peer …`. Same rule as the ink client — every one of these is a decision about THIS
// computer, made here, and `never` is a one-way door for the life of this process that no host
// can clear.
function peerCommand(op) {
  if (op === 'on') {
    if (peerNever) return err('you said "never this session" — restart your client to change that');
    if (!peerTasks) return err('peer tasks are off for this jam — the host starts it with `claude-jam host --peer-tasks`');
    peerMe = true;
    sendMsg({ t: 'peer', op: 'on' });
    return sys('peer tasks: ON for you. The host\'s agent may now ASK you to run something on this '
      + 'machine, in your own Claude Code, on your own account and quota. Every single task still '
      + 'shows you the whole prompt and waits for your yes — and you may decline any of them.');
  }
  if (op === 'off' || op === 'never') {
    peerMe = false;
    if (op === 'never') peerNever = true;
    sendMsg({ t: 'peer', op });
    // Saying no in general answers the one in front of you too — a task left waiting after the
    // person has opted out reads as "still considering it". (answerTask clears `task` before it
    // calls this, so a `/peer never` that came in AS the answer does not decline twice.)
    if (task) {
      const t = task;
      task = null;
      sendMsg({ t: 'peertask-decline', task: t.id, why: 'declined', detail: op });
    }
    return sys(op === 'never'
      ? 'peer tasks: NEVER for this client session. Nothing more will be offered to you here.'
      : 'peer tasks: off for you. Nothing will be dispatched to this machine.');
  }
  if (op === 'reset' || op === 'status') return sendMsg({ t: 'peer', op });
  return answerTask(op);
}

// Every answer to a task goes through here, so there is one path and no second mechanism.
function answerTask(op) {
  if (op === 'cancel') {
    if (!running) return err('nothing is running on this machine right now');
    sys('cancelling the task — stopping the process this client started');
    return running.cancel();
  }
  const t = task;
  if (!t) return err('no task is waiting for your answer');
  if (op === 'decline' || op === 'never') {
    task = null;
    if (op === 'never') peerCommand('never');
    sendMsg({ t: 'peertask-decline', task: t.id, why: 'declined' });
    return sys(`declined ${t.from}'s task — nothing ran, and nothing was written anywhere`);
  }
  // `/peer accept` grants exactly the read-only set; anything that writes or executes needs
  // `/peer accept tools`, for THIS task, every time.
  const d = peerAcceptDecision(t.tools, { typedTools: op === 'accept tools' });
  if (!d.ok) return err(d.error);
  task = null;
  return startTask(t, d.tools);
}

// Yes was said. From here it is this machine's own claude, in a directory made for the task.
function startTask(t, tools) {
  sendMsg({ t: 'peertask-ack', task: t.id, allowedTools: tools });
  running = runPeerTask(t, {
    tools,
    onProgress: (line) => sendMsg({ t: 'peertask-progress', task: t.id, text: line }),
    onDone: (o) => {
      running = null;
      sendMsg({ t: 'peertask-result', task: t.id, ok: o.ok, why: o.why, text: o.text, detail: o.detail });
      sys(o.ok ? `the task finished on this machine (${o.text.length} characters went back to ${t.from})`
        : `the task did not finish: ${peerWhyText({ ...o, deadlineMs: t.deadlineMs, maxTurns: t.maxTurns })}`);
      reprompt();
    },
  });
  emit({ glyph: '⇄', glyphColor: C.accent, wrap: false,
    text: `running ${t.from}'s task in ${running.scratch || '(nowhere — it failed to start)'}`
      + ' — /peer cancel stops it, and the directory goes when it ends' });
}

rl.on('line', (raw) => {
  localActivity(); // v0.26: a submitted line is the whole definition of `active`
  rememberInput(raw); // v0.30-3: before anything else — even a line that turns out to be a typo
  // v0.18-4: /end asked "really end this jam for everyone?", and this is the answer —
  // taken before anything is parsed, so a bare `y` can never become a message to claude.
  // v0.22C adds the second question of the same shape: revoke the kicked person's link?
  if (confirming) {
    const q = confirming;
    confirming = null;
    const yes = confirmYes(raw);
    if (q.kind === 'end') {
      if (yes) { sendMsg({ t: 'end' }); sys('ending the jam for everyone…'); }
      else sys('nothing ended — the jam is still running');
    } else if (q.kind === 'revoke') {
      if (yes) sendMsg({ t: 'invite', op: 'revoke', target: q.name });
      else sys(`${q.name}'s invite link still works — /invite revoke ${q.name} takes it back later`);
    }
    return reprompt();
  }
  const a = parseClientLine(raw);
  if (a.kind === 'continue') { cont.push(a.text); return reprompt(); }
  const act = cont.length ? parseClientLine([...cont, raw].join('\n')) : a;
  cont = [];
  switch (act.kind) {
    case 'say': sendMsg({ t: 'say', text: act.text }); break;
    case 'chat': sendMsg({ t: 'chat', text: act.text }); break;
    case 'who': sys(whoReport(roster, idle, { self: NAME })); break;
    case 'help': logOnboarding(); break;
    // The mirror needs a live region to redraw a whole screen into; this renderer only ever
    // appends lines. Same for tool collapse — here every ⚙/⎿ line goes straight to the log.
    case 'mirror': sys('the mirror view is ink-client only — run without --basic'); break;
    // v0.28: /history works here — it is a transcript command, and this client is all
    // transcript. Scrolling the MIRROR back needs a live region, so that half stays ink-only.
    case 'history': sendMsg({ t: 'history', n: act.n, before: oldestId ?? undefined }); break;
    case 'tools': sys('tool lines are always inline in --basic; /tools needs the ink client'); break;
    case 'join':
      if (!IS_HOST) err('host only');
      else if (!session) sys('not connected yet');
      else logJoin();
      break;
    case 'accept':
    case 'deny':
      if (!IS_HOST) err('host only');
      else sendMsg({ t: 'admit', name: act.name || undefined, ok: act.kind === 'accept' });
      break;
    // v0.14: answering a guest's /command request; v0.12/v0.13 the same for the transcript
    // and for a file. The daemon enforces host+loopback on all three.
    case 'cmd':
    case 'export-ok':
    case 'file-ok':
      if (!IS_HOST) err('host only');
      else {
        const t = { cmd: 'cmd', 'export-ok': 'exportok', 'file-ok': 'fileok' }[act.kind];
        sendMsg({ t, op: act.op, name: act.name || undefined, always: act.always });
      }
      break;
    case 'export':
      sendMsg({ t: 'export' });
      if (!IS_HOST) sys('asked the host for the session transcript…');
      break;
    case 'send': doSend(act.path); break;
    case 'paste': doPaste(act.caption); break;
    case 'get': sendMsg({ t: 'get', name: act.name || undefined }); break;
    // v0.17 F2/F3: the daemon owns both answers — the transcript and the cwd are its.
    case 'files': sendMsg({ t: 'files' }); break;
    case 'diff': sendMsg({ t: 'diff', path: act.path || undefined }); break;
    // v0.17 P2: only the daemon can see claude's screen, so it reads the options and does the
    // typing. A bare `/answer` asks what they are; `/answer <n>` offers one to the host.
    case 'perm': {
      sendMsg({ t: 'perm', choice: act.choice ?? undefined, q: act.q ?? undefined, text: act.text ?? undefined });
      // v0.31: a question goes straight through; a permission, a locked-down jam or free text
      // goes to the host. The daemon decides — this only says which to expect.
      const kind = state.prompt?.kind || 'none';
      const gated = !IS_HOST && (kind !== 'question' || act.choice === 'other' || state.answers === 'host');
      if (act.choice != null && gated) sys(`asked the host to answer ${act.choice} — nothing is typed until they say yes`);
      break;
    }
    // v0.30: what the daemon kept when it could not confirm a message reached claude.
    case 'outbox': sendMsg({ t: 'outbox', op: act.op }); break;
    case 'perm-ok':
      if (!IS_HOST) err('host only');
      else sendMsg({ t: 'permok', op: act.op, name: act.name || undefined, always: act.always });
      break;
    case 'token':
      if (!IS_HOST) err('host only');
      else sendMsg({ t: 'token', op: act.op, value: act.value });
      break;
    // v0.14: one of claude's own commands — typed into the TUI for the host, sent to the
    // host for approval for a guest. The daemon is what decides which.
    case 'slash':
      sendMsg({ t: 'slash', text: act.text });
      if (!IS_HOST) sys(`${act.text} — sent to the host for approval`);
      break;
    // v0.18-4: end the whole jam. Host-only here and in the daemon, and it asks first.
    case 'end':
      if (!IS_HOST) err('host only');
      else { confirming = { kind: 'end' }; sys('really end this jam for everyone? [y/N]'); }
      break;
    // v0.22B: mint a link, list them, take one back. Host-only here and in the daemon.
    case 'invite':
      if (!IS_HOST) err('host only');
      else sendMsg({ t: 'invite', op: act.op, name: act.name, maxUses: act.maxUses, ttl: act.ttl, target: act.target });
      break;
    case 'invites':
      if (!IS_HOST) err('host only');
      else sendMsg({ t: 'invites' });
      break;
    // v0.22C: remove somebody who is already in.
    case 'kick':
      if (!IS_HOST) err('host only');
      else sendMsg({ t: 'kick', name: act.name, revoke: act.revoke });
      break;
    // v0.24: this renderer has no live region to draw a panel in, so `/menu` prints the same
    // tree as a list — the commands, their one-line descriptions, and the state next to each.
    case 'menu': {
      const tree = menuTree({ host: IS_HOST, state: {
        roster, pending: [], grants: [], token: session?.token, inviteOnly: session?.inviteOnly,
        view: session?.view, remote: session?.remote, tunnelJoin: session?.tunnelJoin,
        replay: session?.replay, notify: prefs, idle, ntfy: !!jamConfig.ntfy,
        uploads: session?.uploads, exportPolicy: session?.exportPolicy,
        uploadQuota: session?.uploadQuota, uploadUsed: session?.uploadUsed,
        // v0.29: the host's switch, this human's own answer to it, and who else said yes.
        peers, peerTasks, peerMe, peerNever } });
      sys(`${tree.title} — type the command on the left`);
      for (const sec of tree.sections) {
        sys(`  ${sec.title}: ${sec.desc}`);
        for (const it of sec.items) {
          sys(`    ${(it.run || it.label).padEnd(22)}${it.value ? `[${it.value}] ` : ''}${it.desc || ''}`);
        }
      }
      if (IS_HOST) sendMsg({ t: 'grants' });
      break;
    }
    // v0.24.1: off | tunnel | funnel while the jam runs.
    case 'remote':
      if (!IS_HOST) err('host only');
      else if (act.mode == null) { sendMsg({ t: 'remote' }); sys(`remote: ${session?.remote || 'off'} — /remote ${REMOTE_MODES.join(' | ')}`); }
      else { sys(`switching remote to ${act.mode}…`); sendMsg({ t: 'remote', mode: act.mode }); }
      break;
    // v0.26/v0.25: nudge somebody, and this client's own sound switch.
    case 'ping': sendMsg({ t: 'nudge', to: act.to, text: act.text, escalate: act.escalate }); break;
    case 'sound': {
      if (act.on != null) prefs.sound = act.on;
      const p = notifyPrefs(prefs);
      sys(`sound ${p.sound ? 'on' : 'off'} · notification ${p.notification ? 'on' : 'off'} · `
        + `bell ${p.bell ? 'on' : 'off'}${jamConfig.ntfy ? ' · phone configured' : ''}`);
      break;
    }
    // v0.29: your own machine. on/off/never/reset are decisions about THIS computer, so the
    // client holds them and the daemon is only told.
    case 'peer': peerCommand(act.op); break;
    case 'peers': sendMsg({ t: 'peers', op: act.op }); break;
    case 'quit': process.exit(0);
    case 'error': err(act.text); break;
    default: break;
  }
  reprompt();
});
rl.on('close', () => process.exit(0));

readline.emitKeypressEvents(process.stdin);
process.stdin.on('keypress', () => {
  const now = Date.now();
  if (now - lastTypingSent > 1500) { lastTypingSent = now; sendMsg({ t: 'typing' }); }
});

// Typing indicators expire on their own; refresh the prompt when one drops off.
setInterval(() => {
  const before = typing.size;
  for (const [n, at] of typing) if (Date.now() - at >= 4000) typing.delete(n);
  if (typing.size !== before) reprompt();
}, 1000).unref();
connect();
reprompt();
