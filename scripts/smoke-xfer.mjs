#!/usr/bin/env node
// v0.12/v0.13 smoke: the session export and file transfers, over the wire, against a real
// daemon and the real claude TUI. Scripted peers only (a host on loopback, a guest), plus the
// client's own xfer.mjs for the receiving half — so what is proved is the shipped code path:
//   /export denied · approved (sha256 == the real JSONL, token block gone) · `always` skips
//   the prompt · an upload the host accepts lands in jam-uploads with a sanitized name and
//   claude is told about it · a traversal name, an oversized file, over-announced bytes and a
//   second concurrent upload all refused server-side · host /send → guest /get →
//   ./jam-downloads/ · and a clipboard PNG claude actually reads.
// usage: node scripts/smoke-xfer.mjs <ws-url> <token> <tmux-session> [hook-secret]
//   the hook secret is optional: with it, the last step also answers both new request kinds
//   through the in-TUI popup's endpoint (POST /admit), the way a key in the popup would.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { xferFrames, stripTokenBlock, jsonlGlobs, humanBytes, UPLOAD_MAX } from '../lib.mjs';
import { xferStart, xferChunk, saveXfer, readForUpload, DOWNLOAD_DIR } from '../xfer.mjs';
import { clipboardImage } from '../platform.mjs';

const [url, token, session, hookSecret] = process.argv.slice(2);
if (!url || !token || !session) {
  console.error('usage: node scripts/smoke-xfer.mjs <ws-url> <token> <tmux-session>');
  process.exit(2);
}
const TMUX = process.env.JAM_TMUX_BIN || 'tmux';
// v0.20: jam's tmux lives on a socket of its own, named per port. `JAM_SOCKET` overrides it for
// a host started with `--tmux-socket <name>`.
const SOCKET = process.env.JAM_SOCKET || `claude-jam-${new URL(url).port || 7777}`;
const TMUX_ARGS = ['-L', SOCKET];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (b) => createHash('sha256').update(b).digest('hex');
const pane = () => (spawnSync(TMUX, [...TMUX_ARGS, 'capture-pane', '-p', '-S', '-400', '-t', `${session}:claude`], { encoding: 'utf8' }).stdout || '');
// Where a receiving client would write: its own cwd. A temp dir of ours, so ./jam-downloads/
// is created and asserted exactly where a guest would find it.
const GUEST_CWD = fs.mkdtempSync(path.join(os.tmpdir(), 'jam-xfer-smoke-'));

let failed = 0;
async function step(label, fn) {
  try { await fn(); console.log(`PASS  ${label}`); }
  catch (e) { failed++; console.log(`FAIL  ${label} — ${e.message}`); }
}
async function until(what, pred, ms = 30000) {
  for (const deadline = Date.now() + ms; Date.now() < deadline;) {
    const v = pred();
    if (v) return v;
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${what}`);
}
const eq = (got, want, what) => { if (got !== want) throw new Error(`${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); };

function peer(hello) {
  const p = { frames: [], xfers: new Map(), saved: [], closeCode: null };
  const ws = new WebSocket(url);
  ws.addEventListener('open', () => ws.send(JSON.stringify({ t: 'hello', ...hello })));
  ws.addEventListener('message', (m) => {
    let ev;
    try { ev = JSON.parse(m.data); } catch { return; }
    // The receiving half is the client's own code, not a copy of it.
    if (ev.t === 'xfer') xferStart(p.xfers, ev);
    else if (ev.t === 'file') {
      const done = xferChunk(p.xfers, ev);
      if (done) p.saved.push({ ...done, file: saveXfer(done, GUEST_CWD) });
      return;
    }
    p.frames.push(ev);
  });
  ws.addEventListener('close', (e) => { p.closeCode = e.code; });
  ws.addEventListener('error', () => { /* the assertions carry the verdict */ });
  p.send = (o) => ws.send(JSON.stringify(o));
  p.close = () => ws.close();
  p.want = async (what, pred, ms = 30000) => {
    for (const deadline = Date.now() + ms; Date.now() < deadline;) {
      const hit = p.frames.find(pred);
      if (hit) return hit;
      await sleep(60);
    }
    throw new Error(`no ${what} (saw: ${[...new Set(p.frames.map((f) => f.t))].join(',') || 'nothing'})`);
  };
  p.never = async (what, pred, ms = 3000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const hit = p.frames.find(pred);
      if (hit) throw new Error(`${what}: ${JSON.stringify(hit).slice(0, 140)}`);
      await sleep(60);
    }
  };
  // Everything this peer sends as an upload: request, wait for the grant, stream the chunks.
  p.upload = async (name, data, caption) => {
    p.send({ t: 'upload', name, size: data.length, caption });
    const grant = await p.want(`the grant for ${name}`, (f) => f.t === 'xfergrant' && f.name === name);
    for (const f of xferFrames(grant.xfer, data)) p.send(f);
    return grant;
  };
  return p;
}

// A real 64x64 red PNG, encoded here so the image test needs no fixture on disk.
const CRC = [...Array(256).keys()].map((n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function redPng(w = 64, h = 64) {
  const row = Buffer.concat([Buffer.from([0]), ...Array(w).fill(Buffer.from([220, 20, 20]))]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour RGB
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(Buffer.concat(Array(h).fill(row)))),
    pngChunk('IEND', Buffer.alloc(0))]);
}

// A fresh guest name per run: `/allow-export always` is per name and lives as long as the
// daemon, so re-running under one name would skip the very prompts the first steps assert on.
const GUEST = `Guest${Date.now() % 10000}`;
const host = peer({ name: 'XferHost', host: true, token });
const guest = peer({ name: GUEST, token });
let cwd = null; // the daemon's cwd, from the welcome frame: where jam-uploads/ lives
let sessionId = null;
let jsonl = null;

await step('a loopback host and a token guest are both in', async () => {
  const w = await host.want('welcome', (f) => f.t === 'welcome');
  await guest.want('welcome', (f) => f.t === 'welcome');
  cwd = w.session.cwd;
  sessionId = w.session.id;
  jsonl = jsonlGlobs(sessionId, os.homedir()).flatMap((g) => fs.globSync(g))[0];
  if (!jsonl) throw new Error(`no transcript on disk for ${sessionId}`);
  console.log(`      cwd ${cwd}\n      transcript ${jsonl}\n      guest cwd ${GUEST_CWD}`);
});

// --- v0.12: the session export -------------------------------------------------

await step('a guest\'s /export is refused when the host says no — and no bytes move', async () => {
  guest.send({ t: 'export' });
  const req = await host.want('exportreq', (f) => f.t === 'exportreq' && f.name === GUEST);
  eq(req.name, GUEST, 'exportreq.name');
  host.send({ t: 'exportok', op: 'deny', name: GUEST });
  const no = await guest.want('the refusal', (f) => f.t === 'error' && /did not share the transcript/.test(f.text));
  console.log(`      ${JSON.stringify(no.text)}`);
  if (guest.saved.length) throw new Error(`${guest.saved.length} transfer(s) arrived after a denial`);
});

await step('approved: the guest gets the real JSONL byte for byte, minus our token block', async () => {
  // The transcript must actually contain the token, or the strip below proves nothing.
  const before = fs.readFileSync(jsonl, 'utf8');
  if (!before.includes(`Join token: ${token}`)) {
    throw new Error('the transcript has no token block — token-in-context off? nothing to strip');
  }
  let ok = false;
  for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
    const had = guest.saved.length;
    guest.send({ t: 'export' });
    await host.want('exportreq', (f) => f.t === 'exportreq' && f.name === GUEST);
    host.send({ t: 'exportok', op: 'allow', name: GUEST });
    const got = await until('the transfer to land', () => guest.saved[had], 30000);
    const want = Buffer.from(stripTokenBlock(fs.readFileSync(jsonl, 'utf8'), token), 'utf8');
    ok = sha(got.data) === sha(want);
    console.log(`      attempt ${attempt}: ${got.file} ${humanBytes(got.data.length)} sha ${sha(got.data).slice(0, 16)} vs ${sha(want).slice(0, 16)}${ok ? ' ✓' : ' (file grew mid-export, retrying)'}`);
    if (!ok) continue;
    eq(path.basename(got.file), `jam-session-${sessionId}.jsonl`, 'the file the client wrote');
    // The token, its join command and the whole "reveal only to the host" block are gone.
    const text = got.data.toString('utf8');
    if (text.includes(token)) throw new Error('the join token survived the export');
    if (/Join token:/.test(text)) throw new Error('the token block survived the export');
    if (!text.includes('[claude-jam join-token block removed on export]')) throw new Error('nothing was stripped');
    // And it is still the transcript: same line count, still parseable JSON.
    const lines = text.split('\n').filter(Boolean);
    JSON.parse(lines[0]);
    console.log(`      ${lines.length} JSONL lines, token block replaced, first line parses`);
  }
  if (!ok) throw new Error('the exported bytes never matched the file on disk');
});

await step('/allow-export always: the next /export needs no prompt at all', async () => {
  // Frames are never removed, so count them — an "is there an exportreq?" predicate would
  // match the one from two steps ago and prove nothing.
  const before = host.frames.filter((f) => f.t === 'exportreq').length;
  guest.send({ t: 'export' });
  await until('one more exportreq', () => host.frames.filter((f) => f.t === 'exportreq').length > before, 15000);
  const asks = host.frames.filter((f) => f.t === 'exportreq').length;
  host.send({ t: 'exportok', op: 'allow', name: GUEST, always: true });
  await until('the standing-approval transfer', () => guest.saved.length >= 2, 30000);
  // From here the host is not asked again.
  const had = guest.saved.length;
  guest.send({ t: 'export' });
  await until('a transfer with nobody asked', () => guest.saved.length > had, 30000);
  eq(host.frames.filter((f) => f.t === 'exportreq').length, asks, 'exportreq count after `always`');
  console.log(`      ${asks} prompts in total, ${guest.saved.length} transcripts received`);
});

// --- v0.13: uploads ------------------------------------------------------------

await step('a traversal name is refused server-side, and writes nothing anywhere', async () => {
  for (const name of ['../../evil', '/etc/passwd', 'sub/evil.txt', '..']) {
    guest.send({ t: 'upload', name, size: 4 });
    const e = await guest.want(`the refusal of ${name}`, (f) => f.t === 'error' && /is not a file name I will write/.test(f.text));
    guest.frames.splice(guest.frames.indexOf(e), 1); // so the next name matches its own refusal
    console.log(`      ${JSON.stringify(name)} → ${JSON.stringify(e.text.slice(0, 72))}`);
  }
  await host.never('a filereq for a traversal name', (f) => f.t === 'filereq');
  for (const p of [path.join(cwd, 'jam-uploads', 'evil'), path.resolve(cwd, '../../evil'), '/etc/evil']) {
    if (fs.existsSync(p)) throw new Error(`something was written to ${p}`);
  }
});

await step('an oversized upload is refused before the host is even asked', async () => {
  guest.send({ t: 'upload', name: 'huge.bin', size: UPLOAD_MAX + 1 });
  const e = await guest.want('the cap refusal', (f) => f.t === 'error' && /over the 20\.0 MB upload cap/.test(f.text));
  console.log(`      ${JSON.stringify(e.text)}`);
  await host.never('a filereq for an oversized file', (f) => f.t === 'filereq');
});

await step('two uploads at once from one client: the second is refused, not queued', async () => {
  guest.send({ t: 'upload', name: 'first.txt', size: 4 });
  await host.want('the first filereq', (f) => f.t === 'filereq' && f.file === 'first.txt');
  guest.send({ t: 'upload', name: 'second.txt', size: 4 });
  const e = await guest.want('the one-at-a-time refusal', (f) => f.t === 'error' && /still waiting for the host — one file at a time/.test(f.text));
  console.log(`      ${JSON.stringify(e.text)}`);
  await host.never('a filereq for the second file', (f) => f.t === 'filereq' && f.file === 'second.txt');
  host.send({ t: 'fileok', op: 'deny', name: GUEST });
  await guest.want('the denial', (f) => f.t === 'error' && /first\.txt was refused by/.test(f.text));
});

await step('more bytes than announced: the transfer is dropped, nothing is written', async () => {
  guest.send({ t: 'upload', name: 'liar.txt', size: 4 });
  await host.want('filereq', (f) => f.t === 'filereq' && f.file === 'liar.txt');
  host.send({ t: 'fileok', op: 'allow', name: GUEST });
  const grant = await guest.want('the grant', (f) => f.t === 'xfergrant' && f.name === 'liar.txt');
  for (const f of xferFrames(grant.xfer, Buffer.from('far more than four bytes'))) guest.send(f);
  const e = await guest.want('the abort', (f) => f.t === 'error' && /upload dropped: more bytes than/.test(f.text));
  console.log(`      ${JSON.stringify(e.text)}`);
  if (fs.existsSync(path.join(cwd, 'jam-uploads', 'liar.txt'))) throw new Error('the liar was written anyway');
});

await step('an accepted upload lands in jam-uploads with a sanitized name, and claude is told', async () => {
  const data = Buffer.from(`smoke upload ${Date.now()}\nsecond line\n`);
  // A stamp so re-running this smoke does not collide with the last run's file, and a name
  // full of characters that have no business in a path.
  const sent = `My Report (final) ${Date.now()}.txt`;
  const want = sent.replace(/[^A-Za-z0-9._-]/g, '_'); // the rule, restated independently
  guest.send({ t: 'upload', name: sent, size: data.length, caption: 'have a look' });
  const req = await host.want('filereq', (f) => f.t === 'filereq' && /My_Report/.test(f.file));
  // The name is sanitized before the host is even asked, so the approval line names the file
  // that will actually exist.
  eq(req.file, want, 'the sanitized name in the request');
  console.log(`      request: ${req.name} wants ${req.file} (${humanBytes(req.size)})`);
  host.send({ t: 'fileok', op: 'allow', name: GUEST });
  const grant = await guest.want('the grant', (f) => f.t === 'xfergrant' && f.name === req.file);
  for (const f of xferFrames(grant.xfer, data)) guest.send(f);
  const file = path.join(cwd, 'jam-uploads', want);
  await until(`${file} on disk`, () => fs.existsSync(file), 15000);
  eq(sha(fs.readFileSync(file)), sha(data), 'the bytes on disk');
  const mode = fs.statSync(file).mode & 0o777;
  if (mode !== 0o644) throw new Error(`mode is ${mode.toString(8)}, want 644`);
  // Everybody sees the transfer, and claude is told, in one line: the file arrives as an
  // attributed message, so the agent can Read it and knows who sent it.
  const line = `sent a file: jam-uploads/${want} have a look`;
  const said = await guest.want('the transfer line', (f) => f.t === 'say' && f.from === GUEST && f.text === line);
  console.log(`      [${said.from}] ${JSON.stringify(said.text)} · mode 644 · sha ${sha(data).slice(0, 16)}`);
  await until('the injected line in the transcript',
    () => fs.readFileSync(jsonl, 'utf8').includes(`[${GUEST}]: ${line}`), 30000);
  console.log(`      transcript has [${GUEST}]: ${line}`);
});

// --- v0.13: the host offers a file out ----------------------------------------

await step('host /send offers a file, and the guest\'s /get writes it to ./jam-downloads/', async () => {
  const src = path.join(cwd, `jam-offer-${Date.now()}.md`);
  const body = Buffer.from(`# offered by the smoke\n${'x'.repeat(5000)}\n`);
  fs.writeFileSync(src, body);
  try {
    host.send({ t: 'offer', path: src });
    const offer = await guest.want('the offer', (f) => f.t === 'offer' && f.name === path.basename(src));
    eq(offer.from, 'XferHost', 'offer.from');
    eq(offer.size, body.length, 'offer.size');
    console.log(`      offer: ${offer.from} offers ${offer.name} (${humanBytes(offer.size)})`);
    const had = guest.saved.length;
    guest.send({ t: 'get', name: offer.name });
    const got = await until('the download', () => guest.saved[had], 20000);
    eq(got.file, path.join(GUEST_CWD, DOWNLOAD_DIR, offer.name), 'where the client wrote it');
    eq(sha(got.data), sha(body), 'the downloaded bytes');
    eq(fs.statSync(got.file).mode & 0o777, 0o644, 'the mode of the downloaded file');
    console.log(`      saved ${got.file} (${humanBytes(got.data.length)}) sha ${sha(got.data).slice(0, 16)} ✓`);
    // A name nobody offered is refused, and never read off the host's disk.
    guest.send({ t: 'get', name: 'passwd' });
    const e = await guest.want('the refusal', (f) => f.t === 'error' && /is not on offer/.test(f.text));
    console.log(`      ${JSON.stringify(e.text.slice(0, 80))}`);
  } finally { fs.rmSync(src, { force: true }); }
});

// --- v0.13: an image, end to end ---------------------------------------------

await step('a clipboard PNG round-trips, and claude reads the image it landed in', async () => {
  const png = redPng();
  const tmp = path.join(GUEST_CWD, 'red.png');
  fs.writeFileSync(tmp, png);
  const pngpaste = (spawnSync('/bin/sh', ['-c', 'command -v pngpaste'], { encoding: 'utf8' }).stdout || '').trim();
  console.log(`      pngpaste: ${pngpaste || 'not installed (osascript fallback)'}`);
  // Put the image on the real clipboard, then read it back the way /paste does.
  const set = spawnSync('osascript', ['-e', `set the clipboard to (read (POSIX file "${tmp}") as «class PNGf»)`], { encoding: 'utf8' });
  if (set.status !== 0) {
    console.log(`      SKIP: could not set the clipboard (${(set.stderr || '').trim().split('\n')[0]})`);
    return;
  }
  let img;
  try { img = clipboardImage(); } catch (e) {
    console.log(`      SKIP: no clipboard image path on this machine (${e.message})`);
    return;
  }
  if (img.data.subarray(1, 4).toString() !== 'PNG') throw new Error('the clipboard did not come back as a PNG');
  console.log(`      /paste grabbed ${img.name} (${humanBytes(img.data.length)})`);
  const caption = 'Read this image and reply with ONE word: its dominant colour.';
  guest.send({ t: 'upload', name: img.name, size: img.data.length, caption });
  const req = await host.want('the image filereq', (f) => f.t === 'filereq' && f.file === img.name);
  host.send({ t: 'fileok', op: 'allow', name: GUEST });
  const grant = await guest.want('the grant', (f) => f.t === 'xfergrant' && f.name === req.file);
  for (const f of xferFrames(grant.xfer, img.data)) guest.send(f);
  const landed = path.join(cwd, 'jam-uploads', img.name);
  await until(`${landed} on disk`, () => fs.existsSync(landed), 15000);
  eq(sha(fs.readFileSync(landed)), sha(img.data), 'the PNG bytes on disk');
  console.log(`      ${landed} ${humanBytes(img.data.length)} sha ${sha(img.data).slice(0, 16)} ✓`);
  // The proof that a file is usable, not just present: claude opens it and describes it.
  const answer = await guest.want('claude\'s answer about the image',
    (f) => f.t === 'agent' && f.kind === 'text' && /red|crimson|maroon/i.test(f.text), 120000);
  console.log(`      claude: ${JSON.stringify(answer.text.slice(0, 120))}`);
  if (!/Read/.test(pane())) console.log('      (note: no Read tool line visible in the pane scrollback)');
});

// --- the in-TUI popup answers the two new kinds too (optional: needs the hook secret) ---

await step('POST /admit kind=export|file — the popup path answers both new requests', async () => {
  if (!hookSecret) { console.log('      SKIP: no hook secret given (4th argument)'); return; }
  const port = new URL(url).port || 80;
  const admit = async (body) => {
    const res = await fetch(`http://127.0.0.1:${port}/admit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-jam-secret': hookSecret },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  // A fresh name, so no standing approval from the steps above can short-circuit the ask.
  const popped = peer({ name: `Pop${Date.now() % 10000}`, token });
  try {
    const w = await popped.want('welcome', (f) => f.t === 'welcome');
    // The transcript, answered the way a key in the popup answers it.
    popped.send({ t: 'export' });
    await host.want('exportreq', (f) => f.t === 'exportreq' && f.name === w.you);
    eq((await admit({ kind: 'export', name: w.you, ok: true })).status, 200, 'POST /admit kind=export');
    await until('the transcript to land', () => popped.saved.length, 30000);
    console.log(`      export via /admit → ${path.basename(popped.saved[0].file)} (${humanBytes(popped.saved[0].data.length)})`);
    // And a file.
    const data = Buffer.from(`popup upload ${Date.now()}\n`);
    const name = `popup-${Date.now()}.txt`;
    popped.send({ t: 'upload', name, size: data.length });
    await host.want('filereq', (f) => f.t === 'filereq' && f.file === name);
    eq((await admit({ kind: 'file', name: w.you, ok: true })).status, 200, 'POST /admit kind=file');
    const grant = await popped.want('the grant', (f) => f.t === 'xfergrant' && f.name === name);
    for (const f of xferFrames(grant.xfer, data)) popped.send(f);
    const file = path.join(cwd, 'jam-uploads', name);
    await until(`${file} on disk`, () => fs.existsSync(file), 15000);
    eq(sha(fs.readFileSync(file)), sha(data), 'the bytes the popup let through');
    console.log(`      file via /admit → ${file} sha ${sha(data).slice(0, 16)} ✓`);
    // A wrong secret admits nothing (same guard as /hook).
    popped.send({ t: 'export' });
    await host.want('a second exportreq', (f) => f.t === 'exportreq' && f.name === w.you);
    const bad = await fetch(`http://127.0.0.1:${port}/admit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-jam-secret': 'wrong-secret' },
      body: JSON.stringify({ kind: 'export', name: w.you, ok: true }),
    });
    eq(bad.status, 403, 'POST /admit with a wrong secret');
    console.log('      a wrong x-jam-secret is 403 for the new kinds too');
  } finally { popped.close(); }
});

host.close();
guest.close();
// v0.21.2 (campaign F10): the guest-side directory goes with a passing run. It used to be handed
// back as "yours to delete", which nobody ever did — $TMPDIR was found holding 158 `jam-*`
// directories. A FAILING run still keeps it, since the files it received are the evidence.
// Exactly the one path mkdtempSync handed this process: never a pattern, never a sweep of
// $TMPDIR, and never the host jam's own cwd, which is not this smoke's to touch.
if (failed) {
  console.log(`\nguest-side files left in ${GUEST_CWD} (yours to delete)`);
} else {
  try { fs.rmSync(GUEST_CWD, { recursive: true, force: true }); } catch { /* best effort */ }
  console.log(`\n(cleaned up: ${GUEST_CWD})`);
}
console.log(`--- RESULT --- ${failed ? `${failed} step(s) FAILED` : 'all steps passed'}`);
process.exit(failed ? 1 : 0);
