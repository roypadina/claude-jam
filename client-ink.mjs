#!/usr/bin/env node
// claude-jam ink client (v0.6, extended by v0.7 mirror / v0.10 tool collapse / v0.10b
// newline keys / v0.10c onboarding / v0.14 unified mirror-first view). Reached through
// client.mjs; `--basic` picks client-basic.mjs.
//
// v0.14: this is the ONE surface — host and guests both run it, and the default view is the
// live mirror of the real claude TUI, with the transcript one F2 away. The host additionally
// gets F3 (raw keys into the TUI) and slash passthrough; the daemon enforces both, so this
// file's `--host` flag decides what to render, never what is allowed.
//
// The socket and every piece of state live in `store`, plain JS — React owns none of it, so a
// frame arriving before the first render just lands in the array and shows up when ink mounts.
// ink only renders: <Static> for the transcript (append-only, so history is never re-drawn and
// scrollback stays the terminal's own), then the live region (mirror frame / in-progress tool
// lines), the chat strip, a status row, and the input row.
//
// Visual rules are v0.5/v0.5.1 verbatim; what changed is who does the wrapping. A <Static>
// item is laid out with no width constraint (ink renders it in its own container), so the
// hanging indent needs an explicit width on the text Box — with one, ink wraps and aligns the
// continuation to the text column by itself and lib.mjs's wrapText is not needed here.
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import React from 'react';
import { Box, Text, Static, render as inkRender } from 'ink';
import TextInput from 'ink-text-input';
import { parseClientLine, inviteLines, labelWidth, mdLite, userColor, nextBlock, extractKeys, KEY_SEQS, PASSTHROUGH_SEQS, onboardingLines, fitFrame, toolTurnSummary, LIVE_TOOL_ROWS, humanBytes, resumeInstructions, xferFrames, pumpFrames } from './lib.mjs';
import { xferStart, xferChunk, saveXfer, readForUpload, clipboardPng, DOWNLOAD_DIR } from './xfer.mjs';

const h = React.createElement;

const argv = process.argv.slice(2);
const url = argv.find((a) => a.startsWith('ws'));
const flag = (n) => { const i = argv.indexOf(`--${n}`); return i < 0 ? undefined : argv[i + 1]; };
const NAME = flag('name');
const TOKEN = flag('token');
const IS_HOST = argv.includes('--host');
// No --token is normal now: the host may run knock-only, and then you wait to be accepted.
if (!url || !NAME) {
  console.error('usage: node client.mjs <ws-url> --name <Name> [--token <token>] [--host] [--basic]');
  process.exit(2);
}

// Claude Code's palette, in 256 colours: tmux pales the raw 8 into mud, and the warm greys
// have no 8-colour equivalent at all. Only errors are a plain red-ish accent. ink's own
// `ansi256(n)` colour form emits exactly the same bytes the readline client wrote by hand.
const C = {
  accent: 'ansi256(208)', // claude's orange: its label, the spinner, the prompt caret
  dim: 'ansi256(245)',    // warm grey: tools, system lines, the status row
  dimmer: 'ansi256(240)', // one step back again: tool results
  me: 'ansi256(114)',     // your own name, regardless of what userColor(name) would hash to
  chat: 'ansi256(213)',   // human-only chat: magenta, unmissable, no other element uses it
  err: 'ansi256(203)',
};
const fg256 = (n) => `ansi256(${n})`; // everybody else's stable per-name color (userColor)
const SPIN = ['✻', '✼', '✽', '✼']; // claude's own working glyph cycle
const NO_WRAP_W = 4096; // wider than any terminal: ink leaves the line alone, the terminal
// soft-wraps it, and an invite command stays one selectable run instead of gaining a newline.
const STRIP_ROWS = 3; // rows of chat/system lines kept under the mirror (v0.14 chat strip)

// ------------------------------------------------------------------- state ----
// One store, no React. `entries` is append-only: <Static> renders each item exactly once.
const store = {
  entries: [],
  labelW: labelWidth([]), // width of the `[Name]` column, recomputed on roster change
  roster: [],
  status: { busy: false, waiting: false },
  typing: new Map(), // name -> last typing ms
  cont: [], // pending lines of a multi-line message (trailing `\`, Shift+Enter, Alt+Enter)
  session: null, // welcome's session block; .join only ever set for the host
  // v0.14: the mirror of the real TUI is THE view — everyone, host included, opens on it.
  // F2 (or /mirror) flips to the transcript, which is where the full history lives.
  mirror: true,
  passthrough: false, // v0.14 F3 (host only): keys go straight to the claude TUI
  frame: null, // latest {rows, w, h} screen frame
  deferred: [], // entries that arrived while the mirror was up; flushed back on the way out
  tools: [], // v0.10: this turn's ⚙/⎿ lines, still collapsible
  toolsExpanded: false, // `/tools on` — never collapse
  lastTools: [], // the last completed turn's full tool log, for `/tools`
  xfers: new Map(), // v0.12/v0.13: incoming transfers, xfer id -> assembling record
  upload: null, // a file read and waiting for the host's yes: {name, data, caption}
  offers: new Map(), // v0.13: what the host has offered, name -> {from, size}
  listeners: new Set(),
};
const touch = () => { for (const l of store.listeners) l(); };

const seen = new Set(); // dedupe replayed history across reconnects
let ws = null;
let backoff = 1000;
let boot = null; // daemon boot id: event ids restart at 1 when it changes
let lastTypingSent = 0;
let seq = 0; // <Static> keys
let toTranscript = 0; // >0: emit() writes to the transcript even in mirror view (connect block)
let block = null; // current open message block (nextBlock in lib.mjs)
let lastTurn = null; // turnKey of the last emitted block, so blocks get a blank line between
let app = null; // ink instance, once mounted

// Leaving is unmount-then-print: ink clears its own two rows on unmount, so anything written
// afterwards is guaranteed to survive on screen instead of being erased by the next redraw.
// Deferred by a tick because `/quit` calls this from inside a React event handler, and
// unmounting the reconciler mid-commit wedges it instead of exiting.
function leave(code, text) {
  setImmediate(() => {
    try { app?.unmount(); } catch { /* never mounted, or already gone */ }
    if (text) process.stdout.write(`${text}\n`);
    process.exit(code);
  });
}

// ------------------------------------------------------------- key filter ----
// v0.7 / v0.10b: F2 and the Shift/Alt+Enter spellings are pulled out of the byte stream
// BEFORE ink sees it, or ink's input machinery turns them into `[13;2u` in the text field.
// ink reads from the PassThrough below and never touches the real tty except through the
// setRawMode proxy, so raw mode, Ctrl-C and unmount all keep working.
const keys = new EventEmitter();
const inkStdin = new PassThrough();
inkStdin.isTTY = true;
inkStdin.setRawMode = (on) => { try { process.stdin.setRawMode?.(on); } catch { /* not a tty */ } return inkStdin; };
inkStdin.ref = () => inkStdin;
inkStdin.unref = () => inkStdin;
{
  const dec = new StringDecoder('utf8'); // a chunk can land mid-codepoint
  let hold = '';
  process.stdin.on('data', (buf) => {
    // v0.14: in passthrough mode the keyboard belongs to the claude TUI, so only F3 (the way
    // back) is still ours — everything else, escape sequences included, goes on the wire
    // untouched. ink never sees a byte of it, so nothing lands in the text field either.
    const r = extractKeys(hold + dec.write(buf), store.passthrough ? PASSTHROUGH_SEQS : KEY_SEQS);
    hold = r.hold;
    for (const k of r.keys) keys.emit(k);
    if (!r.text) return;
    if (store.passthrough) sendKeys(r.text);
    else inkStdin.write(r.text);
  });
  process.stdin.resume();
}

// ---------------------------------------------------------------- emitting ----
// Say/agent-text/chat are speech: no glyph, just `[Name]  text`. Tools, knocks, system lines
// and errors keep a one-column glyph. `kind` picks the message block (nextBlock in lib.mjs)
// this event belongs to; callers that pass no kind (system, knock, error) are untracked —
// they neither force a blank line nor break an open agent turn's gluing.
function blockKey(kind) {
  block = nextBlock(kind, block);
  return `${block.kind}:${block.seq}`;
}

// One transcript line: `[Label]` padded to one column, then a glyph column (one character for
// tools/knocks/system/errors, blank for speech), then the text. Each entry freezes the label
// width and the terminal width it was built at, because <Static> never re-renders it.
// `bare` skips the label/glyph gutter entirely (the onboarding block draws its own box).
function emit({ turnKey, label = '', color = C.dim, glyph = '', glyphColor = C.dim, text = '', textColor, md = false, wrap = true, bare = false, strip = false }) {
  // Blank line between blocks: the rhythm that makes a transcript readable. Tools and their
  // results glue to their turn's block, so they do not get one of their own.
  const gap = !!turnKey && lastTurn !== null && turnKey !== lastTurn;
  if (turnKey) lastTurn = turnKey;
  const entry = {
    key: ++seq, gap, label, color, glyph, glyphColor, md, wrap, bare,
    // `strip`: worth a row of the chat strip in mirror view. The mirror already shows
    // everything claude sees — its own output and the `[Name]:` messages typed into it — so
    // the strip is for what it cannot: humans-only chat, knocks, system lines and errors.
    strip,
    text: String(text), textColor,
    labelW: store.labelW, cols: process.stdout.columns || 80,
  };
  // While the mirror is up the transcript is not on screen, so new lines wait in `deferred`
  // (the last few show as an overlay) and are flushed into the transcript, in order, when
  // the guest flips back. A NEW array, never a push: <Static> memoizes its slice on the
  // items reference, so an in-place mutation is silently dropped and the line never renders.
  // `toTranscript` is the one exception: the connect block (welcome, onboarding, history
  // replay) is printed once, above the mirror, or a first-time guest would open on a bare
  // screen with the instructions hidden behind F2.
  if (store.mirror && !toTranscript) store.deferred = [...store.deferred, entry];
  else store.entries = [...store.entries, entry];
  touch();
}

const sys = (text) => emit({ glyph: '*', text, textColor: C.dim, strip: true });
const err = (text) => emit({ glyph: '!', glyphColor: C.err, text, textColor: C.err, strip: true });

// The host's invite lines, wherever they are shown (welcome, /join, a /token reply) —
// including the `--tunnel` pair, which used to reach only the daemon log and token.json.
function logJoin() {
  for (const l of inviteLines(store.session || {})) {
    emit({ glyph: '*', text: l, textColor: C.dim, wrap: false, strip: true });
  }
}

// v0.10c: what a client prints on connect and on `/help`. Dim, gutter-less, ≤10 rows.
function logOnboarding() {
  for (const l of onboardingLines(NAME, IS_HOST)) emit({ text: l, textColor: C.dim, wrap: false, bare: true });
}

// ---------------------------------------------------- v0.10: tool collapse ----
const emitTool = (t) => (t.kind === 'tool-result'
  ? emit({ turnKey: blockKey('agent'), glyph: '⎿', glyphColor: C.dimmer, text: t.text, textColor: C.dimmer })
  : emit({ turnKey: blockKey('agent'), glyph: '⚙', text: t.text, textColor: C.dim }));

// The turn ended (busy went false, or claude started talking again): fold this turn's tool
// lines into one summary, or — for a single tool call — print them inline as they always were.
function flushTools() {
  if (!store.tools.length) return;
  const tools = store.tools;
  store.tools = [];
  store.lastTools = tools;
  const summary = toolTurnSummary(tools);
  if (summary) emit({ turnKey: blockKey('agent'), glyph: '⚙', text: summary, textColor: C.dim });
  else for (const t of tools) emitTool(t);
}

function render(ev) {
  switch (ev.t) {
    case 'say': {
      // Self is always green; everybody else gets a stable color hashed from their name, so
      // it survives reconnects and roster churn instead of depending on join order.
      const c = ev.from === NAME ? C.me : fg256(userColor(ev.from));
      return emit({ turnKey: blockKey('say'), label: `[${ev.from}]`, color: c, text: ev.text, textColor: c });
    }
    // Human-only: the agent never sees it, so it renders unmissable — label, prefix and text
    // all in the one color nothing else uses.
    case 'chat': return emit({ turnKey: blockKey('chat'), label: `[${ev.from}]`, color: C.chat, text: `[humans-only] ${ev.text}`, textColor: C.chat, strip: true });
    case 'agent': {
      if (ev.kind === 'tool' || ev.kind === 'tool-result') {
        // Collapse mode (default): the turn's tool lines live in the live region until the
        // turn ends. `/tools on` prints them straight into the transcript, as v0.6 did.
        if (store.toolsExpanded) return emitTool({ kind: ev.kind, text: ev.text });
        store.tools = [...store.tools, { kind: ev.kind, text: ev.text }];
        return touch();
      }
      flushTools(); // a new text block ends the tool run before it
      return emit({ turnKey: blockKey('agent'), label: '[Claude]', color: C.accent, text: ev.text, md: true });
    }
    case 'roster': {
      store.roster = ev.roster;
      store.labelW = labelWidth(ev.roster); // the column follows the longest name in the room
      if (ev.joined) sys(`${ev.joined} joined`);
      if (ev.left) sys(`${ev.left} left`);
      return touch();
    }
    case 'typing': if (ev.from !== NAME) { store.typing.set(ev.from, Date.now()); touch(); } return;
    case 'status':
      store.status = { busy: ev.busy, waiting: ev.waiting };
      if (!ev.busy) flushTools(); // the turn is over: collapse what it ran
      return touch();
    // v0.7: the host's real screen. Live state, never transcript — the newest frame replaces
    // the previous one and nothing is kept.
    case 'screen': store.frame = { rows: ev.rows || [], w: ev.w, h: ev.h }; return touch();
    // Knocks: `state` means it is about us waiting, `name` means somebody wants in.
    case 'knock': {
      if (ev.state === 'pending') return sys('waiting for host approval…');
      if (ev.state === 'denied') return leave(1, '! the host denied your request');
      if (ev.state === 'expired') return leave(1, '! nobody approved your request in time');
      return emit({ glyph: '⚑', glyphColor: C.accent, text: `${ev.name} wants to join${ev.ip ? ` (${ev.ip})` : ''} — /accept ${ev.name} · /deny ${ev.name}`, strip: true });
    }
    // v0.14: a guest wants to run one of claude's commands. Host clients only — and the
    // wording is the answer, so the host never has to remember the syntax.
    case 'cmdreq':
      return emit({
        glyph: '⌘',
        glyphColor: C.accent,
        text: `${ev.name} wants to run ${ev.cmd} — /allow-cmd ${ev.name} · /allow-cmd ${ev.name} always · /deny-cmd ${ev.name}`,
        strip: true,
      });
    // v0.12: a guest wants the transcript. Host clients only, and the line is the answer.
    case 'exportreq':
      return emit({
        glyph: '⇩',
        glyphColor: C.accent,
        text: `${ev.name} requests the session transcript — /allow-export ${ev.name} · /allow-export ${ev.name} always · /deny-export ${ev.name}`,
        strip: true,
      });
    // v0.13: a guest wants to send a file in. Host clients only.
    case 'filereq':
      return emit({
        glyph: '⇪',
        glyphColor: C.accent,
        text: `${ev.name} wants to send ${ev.file} (${humanBytes(ev.size)}) — /accept-file ${ev.name} · /accept-file ${ev.name} always · /deny-file ${ev.name}`,
        strip: true,
      });
    // v0.13: the host offered a file to everyone; `/get` pulls it.
    case 'offer': {
      store.offers.set(ev.name, { from: ev.from, size: ev.size });
      return emit({
        glyph: '⇩',
        glyphColor: C.accent,
        text: `${ev.from} offers ${ev.name} (${humanBytes(ev.size)}) — /get ${ev.name} saves it to ./${DOWNLOAD_DIR}/`,
        strip: true,
      });
    }
    // v0.13: the host said yes — send the bytes we are holding.
    case 'xfergrant': return sendUpload(ev);
    // v0.12/v0.13: an incoming transfer — its header, then its chunks.
    case 'xfer': { xferStart(store.xfers, ev); return touch(); }
    case 'file': {
      const done = xferChunk(store.xfers, ev);
      return done ? saveIncoming(done) : undefined;
    }
    case 'token': {
      // Every invite string the daemon knows, tunnel pair included: a `/token` rotation
      // changes the credential inside all four.
      if (store.session) Object.assign(store.session, { join: ev.join, view: ev.view, tunnelJoin: ev.tunnelJoin, tunnelView: ev.tunnelView });
      return logJoin();
    }
    // v0.14: something happened to the session everybody should know about — a slash command
    // was run in the TUI, a guest's request was approved.
    case 'sys': return sys(ev.text);
    case 'error': return err(ev.text);
    default: return;
  }
}

// ------------------------------------------------------------------ socket ----
function connect() {
  ws = new WebSocket(url);
  ws.addEventListener('open', () => {
    backoff = 1000;
    // `mirror` in the hello subscribes from the very first frame — including through a knock,
    // where the welcome only comes when the host accepts. A reconnect repeats it: the daemon
    // knows nothing about the socket that died.
    ws.send(JSON.stringify({
      t: 'hello', name: NAME, token: TOKEN, host: IS_HOST || undefined, mirror: store.mirror,
    }));
  });
  ws.addEventListener('message', (m) => {
    let ev;
    try { ev = JSON.parse(m.data); } catch { return; }
    if (ev.t === 'welcome') {
      store.session = ev.session;
      store.roster = ev.roster;
      store.labelW = labelWidth(ev.roster); // set before the replay, so history aligns
      toTranscript++; // the whole connect block goes on screen, mirror view or not
      sys(`jam ${ev.session.id} — host ${ev.session.hostName}, cwd ${ev.session.cwd}`);
      if (IS_HOST) logJoin();
      logOnboarding(); // above the first messages; the replay comes after it
      // A restarted daemon reissues ids from 1, so old ids in `seen` would swallow
      // everything it sends. Drop them whenever the boot id changes.
      if (ev.session?.boot !== boot) { boot = ev.session?.boot; seen.clear(); }
      for (const hist of ev.history || []) if (!seen.has(hist.id)) { seen.add(hist.id); render(hist); }
      sys(`here: ${store.roster.join(', ')}`);
      toTranscript--;
      sendResize(); // host only: fit the claude window to this terminal
      return;
    }
    // Screen frames are a live view at 4/s: they must never enter the dedupe set (it would
    // grow without bound) and there is nothing to dedupe — only the newest one matters.
    if (ev.t !== 'screen' && ev.id != null) { if (seen.has(ev.id)) return; seen.add(ev.id); }
    render(ev);
  });
  ws.addEventListener('close', (e) => {
    // 4400/4401 bad name or token, 4403 denied, 4408 knock expired, 4409 name taken,
    // 4429 too many knocks — none of them get better by retrying.
    // `leave` is deferred a tick, so this must return: otherwise the retry below is scheduled
    // and a "disconnected, retrying" line lands on top of the rejection first.
    if (e.code >= 4400 && e.code <= 4429) return leave(1, `! rejected: ${e.reason || 'auth'}`);
    store.status = { busy: false, waiting: false }; // nothing is known while the socket is down
    sys(`disconnected, retrying in ${backoff / 1000}s`);
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 10000);
  });
  ws.addEventListener('error', () => { /* close handler does the retry */ });
}

const sendMsg = (o) => { if (ws?.readyState === 1) ws.send(JSON.stringify(o)); else err('not connected'); };

// v0.14: nothing is attached to the host's tmux session, so the claude window is exactly as
// big as this terminal says it should be. Host only (the daemon enforces it too) — a guest
// must never reshape the screen everybody else is watching. Silent when the socket is down:
// the reconnect sends it again.
function sendResize() {
  if (!IS_HOST || ws?.readyState !== 1) return;
  ws.send(JSON.stringify({ t: 'resize', w: process.stdout.columns || 80, h: process.stdout.rows || 24 }));
}

// v0.14 F3: hand the keyboard to the real TUI (permission prompts, the trust dialog, an
// interactive /model or /compact picker) and take it back. Host only — the daemon refuses
// `key` frames from anyone else, so this check is courtesy, not the boundary. Turning it on
// forces the mirror view: typing blind into a transcript would be absurd.
function sendKeys(text) {
  if (ws?.readyState !== 1) return;
  ws.send(JSON.stringify({ t: 'key', b64: Buffer.from(text, 'utf8').toString('base64') }));
}

function togglePassthrough(on) {
  const next = on ?? !store.passthrough;
  if (next === store.passthrough) return;
  if (next && !IS_HOST) return err('F3 TUI control is the host\'s — ask them, or send a /command for approval');
  store.passthrough = next;
  if (next) toggleMirror(true);
  // Ordinary system line: it shows in the chat strip now and lands in the transcript in the
  // order it happened. The status and input rows are what actually announce TUI control.
  sys(next ? 'TUI control ON — every key goes to claude\'s screen (Ctrl-C too). F3 hands it back.'
    : 'TUI control off — typing goes to the jam again.');
  touch();
}

// v0.7/v0.14: flip between the live TUI (the default view) and the transcript. F2 and
// `/mirror` are the same call; going back to the transcript flushes everything that arrived
// while the mirror was up, in order, so nothing is lost.
function toggleMirror(on) {
  const next = on ?? !store.mirror;
  if (next === store.mirror) return;
  store.mirror = next;
  sendMsg({ t: 'mirror', on: next });
  if (next) {
    store.frame = null;
  } else {
    store.entries = [...store.entries, ...store.deferred];
    store.deferred = [];
    sys('transcript — F2 goes back to the live TUI');
  }
  touch();
}

// ------------------------------------------ v0.12/v0.13: the export and files ----
// A finished incoming transfer: write it, say where it went, and — for an export — print the
// recipe that revives it. Forced into the transcript (`toTranscript`) so it is readable while
// the live TUI fills the screen: nobody wants their instructions hidden behind an F2.
function saveIncoming(rec) {
  toTranscript++;
  try {
    const file = saveXfer(rec);
    sys(`saved ${file} (${humanBytes(rec.data.length)})`);
    if (rec.kind === 'export') {
      for (const l of resumeInstructions(rec.session, file, process.cwd())) {
        emit({ text: l, textColor: C.dim, wrap: false, bare: true });
      }
    }
  } catch (e) { err(`could not save the transfer: ${e.message}`); }
  toTranscript--;
}

// `/send <path>`: the host OFFERS the file to everyone (each guest pulls it with `/get`); a
// guest UPLOADS it, and the host has to accept before a byte moves.
function doSend(p) {
  if (IS_HOST) return sendMsg({ t: 'offer', path: p });
  let file;
  try { file = readForUpload(p); } catch (e) { return err(e.message); }
  stageUpload(file.name, file.data, '');
}

// `/paste`: the clipboard's image, the same upload path — for the host too, since a clipboard
// image has no path claude could be pointed at instead.
function doPaste(caption) {
  let img;
  try { img = clipboardPng(); } catch (e) { return err(e.message); }
  stageUpload(img.name, img.data, caption);
}

function stageUpload(name, data, caption) {
  store.upload = { name, data, caption };
  sendMsg({ t: 'upload', name, size: data.length, caption: caption || undefined });
  if (!IS_HOST) sys(`${name} (${humanBytes(data.length)}) — waiting for the host to accept it`);
}

// The grant names the file it is for, so a stale buffer (an earlier `/send` the host refused)
// can never go out under a later approval.
function sendUpload(ev) {
  const up = store.upload;
  if (!up) return err('a file was approved that I am no longer holding — /send it again');
  if (ev.name && ev.name !== up.name) return err(`${ev.name} was approved, but I am holding ${up.name}`);
  store.upload = null;
  sys(`sending ${up.name} (${humanBytes(up.data.length)})…`);
  pumpFrames(xferFrames(ev.xfer, up.data), (f) => sendMsg(f), () => ws?.readyState === 1);
}

// One submitted input row. Identical dispatch to the readline client, including the
// continuation buffer: a trailing `\` collects, the first line without one flushes.
function submit(raw) {
  const a = parseClientLine(raw);
  if (a.kind === 'continue') { store.cont.push(a.text); return touch(); }
  const act = store.cont.length ? parseClientLine([...store.cont, raw].join('\n')) : a;
  store.cont = [];
  switch (act.kind) {
    case 'say': sendMsg({ t: 'say', text: act.text }); break;
    case 'chat': sendMsg({ t: 'chat', text: act.text }); break;
    case 'who': sys(`here: ${store.roster.join(', ')}`); break;
    case 'help': logOnboarding(); break;
    case 'mirror': toggleMirror(); break;
    case 'tools':
      if (act.op) {
        store.toolsExpanded = act.op === 'on';
        if (store.toolsExpanded && store.tools.length) { const t = store.tools; store.tools = []; for (const x of t) emitTool(x); }
        sys(`tool lines ${store.toolsExpanded ? 'always expanded' : 'collapsed to one summary line per turn'}`);
      } else if (store.lastTools.length) {
        sys(`last turn's tools (${store.lastTools.filter((t) => t.kind === 'tool').length}):`);
        for (const t of store.lastTools) emitTool(t);
      } else sys('no completed tool calls yet');
      break;
    case 'join':
      if (!IS_HOST) err('host only');
      else if (!store.session) sys('not connected yet');
      else logJoin();
      break;
    case 'accept':
    case 'deny':
      if (!IS_HOST) err('host only');
      else sendMsg({ t: 'admit', name: act.name || undefined, ok: act.kind === 'accept' });
      break;
    // v0.14: answering a guest's /command request. v0.12/v0.13: the same ladder for the
    // transcript and for a file — the daemon enforces host+loopback on all three.
    case 'cmd':
    case 'export-ok':
    case 'file-ok':
      if (!IS_HOST) err('host only');
      else {
        const t = { cmd: 'cmd', 'export-ok': 'exportok', 'file-ok': 'fileok' }[act.kind];
        sendMsg({ t, op: act.op, name: act.name || undefined, always: act.always });
      }
      break;
    // v0.12: ask for the session transcript (the host is asked first, unless it IS the host).
    case 'export':
      sendMsg({ t: 'export' });
      if (!IS_HOST) sys('asked the host for the session transcript…');
      break;
    // v0.13: a file out (host: an offer; guest: an upload the host must accept), the
    // clipboard's image, and taking something the host offered.
    case 'send': doSend(act.path); break;
    case 'paste': doPaste(act.caption); break;
    case 'get': sendMsg({ t: 'get', name: act.name || undefined }); break;
    case 'token':
      if (!IS_HOST) err('host only');
      else sendMsg({ t: 'token', op: act.op, value: act.value });
      break;
    // v0.14: not a jam command, so it is one of claude's. The host's client types it into
    // the real TUI; a guest's goes to the host for approval (the daemon decides — this
    // client's `--host` flag is a label, not a permission).
    case 'slash':
      sendMsg({ t: 'slash', text: act.text });
      if (!IS_HOST) sys(`${act.text} — sent to the host for approval`);
      break;
    case 'quit': return leave(0);
    case 'error': err(act.text); break;
    default: break;
  }
  touch();
}

// --------------------------------------------------------------- rendering ----
function useStore() {
  const [, bump] = React.useState(0);
  React.useEffect(() => {
    const l = () => bump((v) => v + 1);
    store.listeners.add(l);
    return () => { store.listeners.delete(l); };
  }, []);
  return store;
}

function Entry({ e }) {
  const gutter = e.labelW + 2 + (e.glyph ? 1 : 0); // '[Label]' + pad + space [+ glyph] + space
  const body = e.md ? e.text.split('\n').map(mdLite).join('\n') : e.text;
  // The block gap is a row of the entry itself, so it flushes with it and can never end up
  // separated from the line it belongs to. A single space, not '': ink measures an empty
  // Text as zero rows and the blank line disappears.
  const gap = e.gap ? h(Text, null, ' ') : null;
  if (e.bare) {
    return h(Box, { flexDirection: 'column' }, gap,
      h(Box, { width: NO_WRAP_W, flexShrink: 0 }, h(Text, { color: e.textColor }, body)));
  }
  return h(Box, { flexDirection: 'column' }, gap,
    h(Box, null,
      h(Box, { width: gutter, flexShrink: 0 },
        h(Text, { color: e.color, wrap: 'truncate' }, e.label),
        e.glyph
          ? h(Text, { color: e.glyphColor }, `${' '.repeat(Math.max(0, e.labelW - e.label.length) + 1)}${e.glyph}`)
          : null),
      // wrap:false keeps a join command or a URL on one logical line: an oversized Box means
      // ink adds no newline of its own and the terminal's soft wrap leaves it selectable.
      h(Box, e.wrap ? { width: Math.max(24, e.cols - gutter - 1) } : { width: NO_WRAP_W, flexShrink: 0 },
        h(Text, { color: e.textColor }, body))));
}

// v0.7: the host pane's own cells. Each row is printed verbatim (SGR intact, truncated
// ANSI-aware by ink) — no colors of our own, or they would fight the captured ones.
function Mirror({ frame }) {
  const cols = process.stdout.columns || 80;
  if (!frame) return h(Text, { color: C.dim }, 'waiting for the host\'s screen…');
  const fit = fitFrame(frame, cols, process.stdout.rows);
  const hints = [
    fit.wider ? `host pane is ${frame.w} cols wide, yours is ${cols}` : '',
    fit.croppedRows ? `${fit.croppedRows} row(s) above cut off` : '',
  ].filter(Boolean).join(' · ');
  return h(Box, { flexDirection: 'column' },
    fit.rows.map((r, i) => h(Text, { key: i, wrap: 'truncate' }, r === '' ? ' ' : r)),
    hints ? h(Text, { color: C.dim }, `— mirror: ${hints}`) : null);
}

function StatusBar({ status, typing, spin, mirror, passthrough }) {
  const now = Date.now();
  const who = [...typing.entries()].filter(([, at]) => now - at < 4000).map(([n]) => n);
  const right = who.length ? `${who.join(', ')} ${who.length > 1 ? 'are' : 'is'} typing…` : '';
  // Which view you are in is always on screen: the mirror IS the default (v0.14), so the
  // chip's job is to make the F2 alternate discoverable long after the onboarding block
  // has scrolled away.
  const view = mirror ? '⧉ live TUI' : '≡ transcript';
  // A permission prompt is the one moment the host must leave the jam layer, so the status
  // row says which key does it. Guests are told who to wait for instead.
  const waiting = `⚠ waiting for permission${IS_HOST ? ' — F3 to answer' : ' — the host answers'}`;
  return h(Box, { minHeight: 1 },
    h(Box, { flexGrow: 1 },
      passthrough
        ? h(Text, { color: C.accent }, '⌨ TUI control — F3 returns')
        : h(React.Fragment, null,
          h(Text, { color: C.dimmer }, `${view}  `),
          status.busy ? h(Text, { color: C.accent }, `${SPIN[spin]} claude is working…`) : null,
          status.busy && status.waiting ? h(Text, { color: C.dim }, ' · ') : null,
          status.waiting ? h(Text, { color: C.accent }, waiting) : null)),
    right ? h(Text, { color: C.dim }, right) : null);
}

function App() {
  const s = useStore();
  const [input, setInput] = React.useState('');
  const [spin, setSpin] = React.useState(0);

  // The spinner runs ONLY while busy, and unref'd, so an idle client neither redraws nor
  // holds the loop open.
  React.useEffect(() => {
    if (!s.status.busy) { setSpin(0); return; }
    const t = setInterval(() => setSpin((i) => (i + 1) % SPIN.length), 220);
    t.unref?.();
    return () => clearInterval(t);
  }, [s.status.busy]);

  // v0.14: raw mode is held by ink's TextInput, and passthrough hides the input row — so
  // unmounting it put the tty back into canonical mode, where the terminal echoed every key
  // and released nothing until Enter (observed: `zz^[` printed into the client's own row
  // while claude got nothing). Passthrough holds raw mode itself. This effect runs after the
  // unmount's cleanup in the same commit, so it wins; F3 back remounts TextInput, which
  // takes over again.
  React.useEffect(() => {
    if (!s.passthrough) return;
    try { process.stdin.setRawMode?.(true); } catch { /* not a tty */ }
  }, [s.passthrough]);

  // Typing indicators expire on their own; this only needs to redraw the status row.
  React.useEffect(() => {
    const t = setInterval(() => {
      const before = s.typing.size;
      for (const [n, at] of s.typing) if (Date.now() - at >= 4000) s.typing.delete(n);
      if (s.typing.size !== before) touch();
    }, 1000);
    t.unref?.();
    return () => clearInterval(t);
  }, [s]);

  // v0.10b: Shift+Enter / Alt+Enter push the row into the pending buffer instead of
  // submitting it — exactly where a trailing `\` puts it, so submit() needs no new path.
  // v0.7: F2 is the mirror toggle. Both come from the key filter above, never from ink.
  React.useEffect(() => {
    const onNewline = () => { store.cont.push(input); setInput(''); touch(); };
    const onMirror = () => toggleMirror();
    const onPassthrough = () => togglePassthrough();
    keys.on('newline', onNewline);
    keys.on('mirror', onMirror);
    keys.on('passthrough', onPassthrough);
    return () => {
      keys.off('newline', onNewline);
      keys.off('mirror', onMirror);
      keys.off('passthrough', onPassthrough);
    };
  }, [input]);

  const onChange = (v) => {
    setInput(v);
    const now = Date.now();
    if (v && now - lastTypingSent > 1500) { lastTypingSent = now; sendMsg({ t: 'typing' }); }
  };

  // Live region, in order: the mirror frame (or the in-progress turn's tool lines), the
  // 3-row chat strip of what the mirror cannot show, the status row, the pending lines of a
  // multi-line message, and the input row.
  const liveTools = s.mirror || s.toolsExpanded ? [] : s.tools.slice(-LIVE_TOOL_ROWS);
  const strip = s.mirror ? s.deferred.filter((e) => e.strip).slice(-STRIP_ROWS) : [];
  return h(Box, { flexDirection: 'column' },
    h(Static, { items: s.entries }, (e) => h(Entry, { key: e.key, e })),
    s.mirror ? h(Mirror, { frame: s.frame }) : null,
    liveTools.length
      // Index keys on purpose: this region is redrawn every render (never <Static>), and two
      // identical tool lines in one turn are perfectly normal.
      ? h(Box, { flexDirection: 'column' }, liveTools.map((t, i) => h(Entry, {
        key: `live-${i}`,
        e: {
          gap: false, label: '', color: C.dim, glyph: t.kind === 'tool-result' ? '⎿' : '⚙',
          glyphColor: t.kind === 'tool-result' ? C.dimmer : C.dim, md: false, wrap: true, bare: false,
          text: t.text, textColor: t.kind === 'tool-result' ? C.dimmer : C.dim,
          labelW: s.labelW, cols: process.stdout.columns || 80,
        },
      })))
      : null,
    s.mirror && strip.length
      ? h(Box, { flexDirection: 'column' },
        strip.map((e) => h(Entry, { key: `strip-${e.key}`, e: { ...e, gap: false } })))
      : null,
    h(StatusBar, { status: s.status, typing: s.typing, spin, mirror: s.mirror, passthrough: s.passthrough }),
    s.cont.length && !s.passthrough
      ? h(Box, { flexDirection: 'column' },
        s.cont.map((l, i) => h(Text, { key: `cont-${i}`, color: C.dim }, l === '' ? ' ' : l)))
      : null,
    // While the keyboard belongs to the TUI there is nothing to type here, and a live prompt
    // would invite exactly the mistake F3 exists to prevent. Same one row either way.
    s.passthrough
      ? h(Box, null, h(Text, { color: C.dim }, '⌨ your keys are going to claude\'s screen — F3 to type in the jam again'))
      : h(Box, null,
        h(Text, { color: C.me }, NAME),
        s.cont.length ? h(Text, { color: C.dim }, ' …') : null,
        h(Text, { color: C.accent }, ' ❯ '),
        h(TextInput, { value: input, onChange, onSubmit: (v) => { setInput(''); submit(v); } })));
}

// Ctrl-C in the terminal is ink's own (exitOnCtrlC): it unmounts, waitUntilExit resolves and
// the exit below runs. These are for a signal from outside, where ink sees nothing.
process.on('SIGINT', () => leave(0));
process.on('SIGTERM', () => leave(0));
// Terminal resized: ink relays out on its own, and the host's claude window follows along.
process.stdout.on('resize', sendResize);
app = inkRender(h(App), { patchConsole: false, stdin: inkStdin });
connect();
await app.waitUntilExit();
process.exit(0);
