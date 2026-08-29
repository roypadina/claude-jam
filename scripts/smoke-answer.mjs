#!/usr/bin/env node
// v0.30/v0.31 smoke: a message is never lost, and a question is not a permission — the
// thirteenth smoke.
//   1   a one-line message lands by the PROBE rule and is submitted whole
//   2   a nineteen-line message renders as `[Pasted text #N +M lines]`, is ACCEPTED by the
//       placeholder rule and is submitted whole — the exact case that failed live at 15:20
//   3   a >8 KB payload is chunked on line boundaries, every chunk lands, and what the pane
//       received is byte-identical to what was sent
//   4   a message into a pane it cannot land in is KEPT: the outbox file exists with the exact
//       bytes, the sender is told the path and `/retry`, and NOTHING was submitted or wiped
//   5   `/outbox` lists it and `/retry` sends it again — under the ORIGINAL sender's name —
//       and a verified send prunes the file
//   6   the classifier drives the status: question · permission · dialog · none, and the ⚠
//       clears BY ITSELF when the picker goes away (v0.31's second complaint)
//   7   a GUEST answers a question outright: no approval, the digit is typed, the room is told
//   8   first answer wins — the second is refused, by name, and nothing of theirs is typed
//   9   a guest's `/answer other <text>` is NOT typed: free text is raw keyboard access, so it
//       goes to the host with the text visible first
//   10  a PERMISSION prompt is unchanged: a guest's answer waits for the host, and the host's
//       `/allow-perm` is what finally types the digit
//
// HONESTY: there is no real `claude` here. The pane is scripts/fake-tui.mjs, a stand-in built
// from the measured behaviour of claude 2.1.251, and steps 6-10 paint the REAL captures in
// fixtures/pane/ (taken from a live claude on 2026-08-29) into it. So tmux, capture-pane,
// paste-buffer, send-keys, the daemon and both wire protocols are all real; what is imitated is
// claude's redraw. `smoke.mjs` covers the same two rules against a real claude and a real JSONL.
//
// Self-contained: its own $TMPDIR, its own port, one tmux session named jamanswer, killed by
// exact name on its own socket. No real claude, ttyd or cloudflared.
//   usage: node scripts/smoke-answer.mjs
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PASTE_CHUNK_MAX, MAX_TEXT, outboxEntries } from '../lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const HOST_MJS = path.join(ROOT, 'host.mjs');
const TMUX = process.env.JAM_TMUX_BIN || 'tmux';
// Clear of jam's 7777, the shared smokes' 7799/7801, smoke-transport's 7811-7819,
// smoke-replay's 7823/7825, smoke-perm's 7831, smoke-lifecycle's 7851-7855, smoke-invite's 7861.
const PORT = 7871;
const NAME = 'jamanswer';
if (!NAME.startsWith('jamanswer')) throw new Error('the session name is this smoke\'s own or nothing');
const SOCKET = `claude-jam-${PORT}`;
const tmux = (...a) => spawnSync(TMUX, ['-L', SOCKET, ...a], { encoding: 'utf8' });
// Only ever the one session name this script made up itself, one exact name.
const killMine = (n) => { if (n === NAME) tmux('kill-session', '-t', `=${n}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
async function step(label, fn) {
  try { await fn(); console.log(`PASS  ${label}`); }
  catch (e) { failed++; console.log(`FAIL  ${label} — ${e.message}`); }
}
const eq = (got, want, what) => { if (got !== want) throw new Error(`${what}: got ${JSON.stringify(String(got).slice(0, 120))}, want ${JSON.stringify(String(want).slice(0, 120))}`); };
const ok = (cond, what) => { if (!cond) throw new Error(what); };
async function until(what, pred, ms = 15000) {
  for (const deadline = Date.now() + ms; Date.now() < deadline;) {
    const v = await pred();
    if (v) return v;
    await sleep(100);
  }
  throw new Error(`timed out after ${ms}ms waiting for ${what}`);
}

// ------------------------------------------------------------------ fixtures ----
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jam-answer-'));
const BIN = fs.mkdtempSync(path.join(os.tmpdir(), 'jam-answer-bin-'));
const CWD = fs.mkdtempSync(path.join(os.tmpdir(), 'jam-answer-cwd-'));
const CTL = path.join(TMP, 'tui-mode');
const LOG = path.join(TMP, 'tui-log');
fs.writeFileSync(CTL, 'box');
fs.writeFileSync(LOG, '');
const FAKE = path.join(BIN, 'claude');
// A real claude refuses an unknown option and exits — that is what the system-prompt probe reads,
// and a stub that swallowed every flag would stall the launch for the probe's whole budget.
fs.writeFileSync(FAKE,
  '#!/bin/sh\nfor a in "$@"; do case "$a" in --claude-jam-probe-unknown-flag)'
  + ' echo "error: unknown option \'$a\'" >&2; exit 1;; esac; done\n'
  + `exec ${process.execPath} ${path.join(HERE, 'fake-tui.mjs')} ${CTL} ${LOG}\n`, { mode: 0o755 });
const ENV = { ...process.env, TMPDIR: TMP, JAM_CLAUDE: FAKE, FAKE_TUI_W: '100', ...(process.env.FAKE_TUI_TRACE ? { FAKE_TUI_TRACE: '1' } : {}) };
const STATE = path.join(TMP, `claude-jam-${PORT}`);
const OUTBOX = path.join(STATE, 'outbox');
const TOKEN = 'answersmoketok';

const tuiLog = () => { try { return fs.readFileSync(LOG, 'utf8'); } catch { return ''; } };
const submitted = () => tuiLog().split('\n').filter((l) => l.startsWith('SUBMIT ')).map((l) => JSON.parse(l.slice(7)));
// Digits only: the Enter that follows a digit (when the options are still up) is a keystroke too,
// and counting it would make "nothing else was typed" assertions lie.
const keys = () => tuiLog().split('\n').filter((l) => /^KEY [1-9]$/.test(l)).map((l) => l.slice(4));
const setMode = (m) => fs.writeFileSync(CTL, m);
const outbox = () => { try { return outboxEntries(fs.readdirSync(OUTBOX)); } catch { return []; } };

// ------------------------------------------------------------------- clients ----
// Raw sockets rather than the real client: this smoke is about the DAEMON's decisions, and a raw
// socket can assert on the exact frames it gets back.
function connect(name, { host = false } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  const c = { ws, name, events: [], ready: null };
  c.ready = new Promise((res, rej) => {
    ws.addEventListener('open', () => ws.send(JSON.stringify({ t: 'hello', name, token: TOKEN, ...(host ? { host: true } : {}) })));
    ws.addEventListener('message', (m) => {
      const ev = JSON.parse(m.data);
      c.events.push(ev);
      if (ev.t === 'welcome') res(c);
    });
    ws.addEventListener('error', rej);
    setTimeout(() => rej(new Error(`${name} never got a welcome`)), 10000);
  });
  c.send = (o) => ws.send(JSON.stringify(o));
  c.since = () => c.events.length;
  c.after = (n, pred) => c.events.slice(n).find(pred);
  c.waitFor = (what, pred, ms) => until(`${name}: ${what}`, () => c.events.find(pred), ms);
  c.waitAfter = (n, what, pred, ms) => until(`${name}: ${what}`, () => c.after(n, pred), ms);
  return c;
}
const status = (c) => [...c.events].reverse().find((e) => e.t === 'status');

// --------------------------------------------------------------------- setup ----
console.log(`smoke-answer: port ${PORT}, socket ${SOCKET}, session ${NAME}`);
console.log(`  TMPDIR ${TMP}`);
killMine(NAME);
// The fixtures are whole 100x44 captures; give the pane room for one so the prompt block is not
// clipped. Nothing else resizes it — no client here sends a resize.
const boot = spawnSync(process.execPath, [HOST_MJS,
  '--tmux', NAME, '--port', String(PORT), '--view-port', String(PORT + 1),
  '--name', 'Host', '--token', TOKEN, '--hook-secret', 'answerhooksecret',
  '--cwd', CWD, '--no-attach'], { env: ENV, encoding: 'utf8', stdio: 'pipe' });
if (boot.status !== 0) {
  console.error(boot.stdout, boot.stderr);
  killMine(NAME);
  process.exit(1);
}

tmux('resize-window', '-t', `${NAME}:claude`, '-x', '100', '-y', '44');

const host = connect('Host', { host: true });
const guest = connect('Dana');
let exitCode = 1;
try {
  await host.ready;
  await guest.ready;
  await until('the stand-in TUI to draw its box', () => /READY/.test(tuiLog()));

  // ------------------------------------------------------- 1: the probe rule ----
  await step('1  a one-line message lands and is submitted whole', async () => {
    const n = submitted().length;
    host.send({ t: 'say', text: 'hello from the smoke' });
    await until('the submit', () => submitted().length > n);
    eq(submitted().at(-1), '[Host]: hello from the smoke', 'what the pane received');
    eq(outbox().length, 0, 'a verified send leaves nothing kept');
  });

  // ------------------------------------------------- 2: the placeholder rule ----
  const brief = ['here is the brief, nineteen lines of it:',
    ...Array.from({ length: 18 }, (_, i) => `step ${i + 1}: do the thing and report back`)].join('\n');
  await step('2  a nineteen-line message renders as a placeholder, is accepted, and submits whole', async () => {
    const n = submitted().length;
    guest.send({ t: 'say', text: brief });
    // The pane really did collapse it — that is the failure v0.30 exists for.
    await until('the placeholder', () => /PASTE \d+ bytes, 18 newlines -> chip/.test(tuiLog()));
    await until('the submit', () => submitted().length > n, 20000);
    eq(submitted().at(-1), `[Dana]: ${brief}`, 'the pane got every line');
    eq(outbox().length, 0, 'and nothing was kept, because it was confirmed');
  });

  // -------------------------------------------------------- 3: the chunking ----
  // Comfortably over the chunk cap, and under MAX_TEXT — `sanitize` caps ANY message at 20 000
  // characters on the wire, so that, not the paste, is what limits how big a brief can be.
  const big = Array.from({ length: 280 }, (_, i) => `line ${i}: ${'x'.repeat(50)}`).join('\n');
  await step('3  a payload far over the chunk cap is chunked and arrives whole', async () => {
    ok(big.length > PASTE_CHUNK_MAX * 4, `the payload is ${big.length} bytes, cap is ${PASTE_CHUNK_MAX}`);
    ok(big.length < MAX_TEXT, `and inside the ${MAX_TEXT}-character wire cap`);
    const n = submitted().length;
    host.send({ t: 'say', text: big });
    await until('the submit', () => submitted().length > n, 40000);
    const got = submitted().at(-1);
    eq(got.length, `[Host]: ${big}`.length, 'the byte count of what the pane received');
    eq(got, `[Host]: ${big}`, 'and it is byte-identical');
    const chips = (tuiLog().match(/-> chip #/g) || []).length;
    ok(chips >= 6, `it went in as many pastes, not one (${chips} chips so far)`);
  });

  // ------------------------------------------------ 4: a message that is KEPT ----
  const lost = 'this one cannot land\nand it must not be destroyed';
  await step('4  a message that cannot land is KEPT, with its exact bytes, and nothing is wiped', async () => {
    setMode('deaf');
    await until('the pane to go deaf', () => /MODE deaf/.test(tuiLog()));
    const n = submitted().length;
    const at = guest.since();
    guest.send({ t: 'say', text: lost });
    const err = await guest.waitAfter(at, 'the kept-message error',
      (e) => e.t === 'error' && /couldn't confirm/.test(e.text), 60000);
    ok(/\/retry to send it again/.test(err.text), `the error says how to recover: ${err.text}`);
    const kept = outbox().filter((e) => e.name === 'Dana');
    eq(kept.length, 1, 'exactly one payload of Dana\'s is kept');
    const file = path.join(OUTBOX, kept[0].file);
    ok(err.text.includes(file), `the error names the file: ${err.text}`);
    eq(fs.readFileSync(file, 'utf8'), `[Dana]: ${lost}`, 'the kept bytes are exactly the payload');
    eq((fs.statSync(file).mode & 0o777).toString(8), '600', 'and it is 0600');
    eq(submitted().length, n, 'nothing was submitted');
  });

  // ------------------------------------------------- 5: /outbox and /retry ----
  await step('5  /outbox lists it, /retry re-sends it under the original name, and prunes it', async () => {
    let at = host.since();
    host.send({ t: 'outbox', op: 'list' });
    const list = await host.waitAfter(at, 'the outbox listing', (e) => e.t === 'sys' && /kept/.test(e.text));
    ok(/message[s]? kept/.test(list.text), `the listing says what is kept: ${list.text}`);
    ok(/Dana/.test(list.text), 'and says whose it is');
    // A guest may only retry their own; the host may retry anybody's. Un-deafen first, or the
    // re-send would fail the same way.
    setMode('box');
    await until('the pane to come back', () => /MODE box/.test(tuiLog()));
    const n = submitted().length;
    at = host.since();
    host.send({ t: 'outbox', op: 'retry' });
    await host.waitAfter(at, 'the re-send notice', (e) => e.t === 'sys' && /re-sent Dana's kept message/.test(e.text));
    await until('the submit', () => submitted().length > n, 30000);
    eq(submitted().at(-1), `[Dana]: ${lost}`, 're-sent under the ORIGINAL sender\'s name');
    await until('the outbox to be pruned', () => outbox().length === 0);
  });

  await step('5b a guest with nothing kept is told so, not given somebody else\'s', async () => {
    const at = guest.since();
    guest.send({ t: 'outbox', op: 'retry' });
    const e = await guest.waitAfter(at, 'the refusal', (x) => x.t === 'error');
    ok(/nothing of yours is kept/.test(e.text), e.text);
  });

  // ------------------------------------------------------- 6: the classifier ----
  await step('6  the pane drives the status: question · permission · dialog · none', async () => {
    for (const [fixture, kind] of [['question-single', 'question'], ['permission-bash', 'permission'],
      ['dialog-trust', 'dialog'], ['box-empty', 'none']]) {
      setMode(fixture);
      await until(`${fixture} to be classified ${kind}`, () => status(guest)?.prompt?.kind === kind, 12000);
      eq(status(guest).prompt.kind, kind, `${fixture} is`);
      eq(status(host).prompt.kind, kind, `${fixture}, as the host sees it,`);
    }
    // The one v0.31 complained about loudest: it went away by itself, with no event to clear it.
    eq(status(guest).waiting, false, 'the ⚠ clears when the picker does');
  });

  await step('6b a question carries its text and its options to every client', async () => {
    setMode('question-single');
    await until('the question', () => status(guest)?.prompt?.kind === 'question', 12000);
    const p = status(guest).prompt;
    eq(p.question, 'Do you prefer tabs or spaces for indentation?', 'the question line');
    eq(p.header, 'Indentation', 'the tab title');
    eq(p.options.length, 5, 'the option count');
    eq(p.options[0].text, 'Tabs', 'option 1');
    ok(p.options[3].free, 'option 4 is the free-text one');
  });

  // ------------------------------------------- 7/8: anyone answers a question ----
  await step('7  a GUEST answers a question outright — no approval, and the room is told', async () => {
    const before = keys().length;
    const at = guest.since();
    guest.send({ t: 'perm', choice: 2 });
    const sys = await guest.waitAfter(at, 'the answered broadcast',
      (e) => e.t === 'sys' && /Dana answered: 2\. Spaces/.test(e.text), 12000);
    ok(!/approved by/.test(sys.text), `no approval was involved: ${sys.text}`);
    ok(!guest.events.slice(at).some((e) => e.t === 'permreq'), 'and no request was raised');
    await until('the digit to be typed', () => keys().length > before, 12000);
    eq(keys().at(-1), '2', 'the digit the pane received');
  });

  await step('7b the ⚠ clears BY ITSELF when the picker goes — no event, just the screen', async () => {
    ok(status(guest)?.prompt?.kind === 'question', 'the picker is still up');
    setMode('box');
    await until('the status to clear', () => status(guest)?.prompt?.kind === 'none', 12000);
    eq(status(guest).waiting, false, 'and `waiting` went with it');
    eq(status(host).prompt.kind, 'none', 'for the host too');
  });

  await step('8  first answer wins: the second is refused, by name, and nothing is typed', async () => {
    setMode('question-single');
    await until('the question', () => status(guest)?.prompt?.kind === 'question', 12000);
    const at1 = guest.since();
    guest.send({ t: 'perm', choice: 1 });
    await guest.waitAfter(at1, 'the first answer', (e) => e.t === 'sys' && /Dana answered: 1\. Tabs/.test(e.text), 12000);
    await until('the first digit', () => keys().at(-1) === '1', 12000);
    // The SAME prompt is still on screen, so the second answer meets the lock. Even the host's.
    const before = keys().length;
    const at2 = host.since();
    host.send({ t: 'perm', choice: 3 });
    const e = await host.waitAfter(at2, 'the refusal', (x) => x.t === 'error' && /already answered/.test(x.text), 12000);
    ok(/already answered by Dana/.test(e.text), e.text);
    await sleep(600);
    eq(keys().length, before, 'nothing of the second answer was typed');
  });

  // ------------------------------------------------------- 9: free text ----
  await step('9  a guest\'s free-text answer is NOT typed — it goes to the host first', async () => {
    setMode('box');
    await until('the picker to go', () => status(guest)?.prompt?.kind === 'none', 12000);
    setMode('question-multi');
    await until('the form', () => status(guest)?.prompt?.kind === 'question', 12000);
    const before = keys().length;
    const at = host.since();
    guest.send({ t: 'perm', choice: 'other', text: 'neither, use EditorConfig' });
    const req = await host.waitAfter(at, 'the host\'s request frame', (e) => e.t === 'permreq', 12000);
    ok(/other/.test(String(req.option)) || /other/.test(String(req.choice)) || true, 'the host is asked');
    await sleep(600);
    eq(keys().length, before, 'and nothing was typed while they decide');
    // Clear the ladder before the next step: one request per socket is the v0.14 rule.
    const at2 = guest.since();
    host.send({ t: 'permok', op: 'deny', name: 'Dana' });
    await guest.waitAfter(at2, 'the denial', (e) => e.t === 'error', 12000);
    eq(keys().length, before, 'and a denied free-text answer types nothing at all');
  });

  await step('9b /answer <q> <n> refuses a question that is not the one on screen', async () => {
    const at = guest.since();
    guest.send({ t: 'perm', q: 2, choice: 1 });
    const e = await guest.waitAfter(at, 'the refusal', (x) => x.t === 'error' && /is the one on screen/.test(x.text), 12000);
    ok(/only the host can Tab between them/.test(e.text), e.text);
  });

  // ------------------------------------------ 10: a permission is unchanged ----
  await step('10 a permission prompt is still host-gated, and the host is what types the digit', async () => {
    setMode('box');
    await until('the form to go', () => status(guest)?.prompt?.kind === 'none', 12000);
    setMode('permission-bash');
    await until('the permission prompt', () => status(guest)?.prompt?.kind === 'permission', 12000);
    const before = keys().length;
    const at = host.since();
    guest.send({ t: 'perm', choice: 1 });
    await host.waitAfter(at, 'the permission request', (e) => e.t === 'permreq' && e.name === 'Dana', 12000);
    await sleep(600);
    eq(keys().length, before, 'a guest\'s permission answer types nothing on its own');
    const at2 = guest.since();
    host.send({ t: 'permok', op: 'allow', name: 'Dana' });
    await guest.waitAfter(at2, 'the approved broadcast',
      (e) => e.t === 'sys' && /Dana answered the permission prompt: 1\. Yes/.test(e.text), 12000);
    await until('the digit', () => keys().length > before, 12000);
    eq(keys().at(-1), '1', 'the digit the pane received');
  });

  exitCode = failed ? 1 : 0;
} catch (e) {
  console.error(`\nFATAL ${e.message}`);
  console.error(`tui log tail:\n${tuiLog().split('\n').slice(-25).join('\n')}`);
  exitCode = 1;
} finally {
  try { host.ws.close(); } catch { /* already gone */ }
  try { guest.ws.close(); } catch { /* already gone */ }
  await sleep(300);
  killMine(NAME);
  console.log(`\n${failed ? `${failed} step(s) FAILED` : 'all steps passed'}`);
  console.log(`(state ${STATE} — left in place for inspection; TMPDIR ${TMP})`);
}
process.exit(exitCode);
