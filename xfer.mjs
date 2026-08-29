// claude-jam file transfers, the client's half (v0.12 export, v0.13 files). fs, the clipboard
// and the one shell-free spawn live here so lib.mjs stays pure and both renderers share this.
//
// Everything written by a client lands in ITS OWN cwd: the transcript beside it as
// `jam-session-<id>.jsonl`, an offered file under `./jam-downloads/`. Mode 0644, never
// executable, and nothing here ever runs or opens what it just wrote.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { UPLOAD_MAX, safeBaseName, humanBytes, exportFileName } from './lib.mjs';

export const DOWNLOAD_DIR = 'jam-downloads';

// ---------------------------------------------------------------- incoming ----
// A transfer is a `{t:'xfer'}` header, then `{t:'file', xfer, seq, done, b64}` chunks. The
// state is a plain Map the caller owns, so a client can have one of each direction in flight.
export function xferStart(state, ev) {
  state.set(ev.xfer, {
    kind: ev.kind, name: ev.name, size: Number(ev.size) || 0, session: ev.session,
    parts: [], got: 0,
  });
}

// Returns the finished transfer when its last chunk lands, else null.
export function xferChunk(state, ev) {
  const rec = state.get(ev.xfer);
  if (!rec) return null; // a chunk for a transfer we never got the header for
  const buf = Buffer.from(typeof ev.b64 === 'string' ? ev.b64 : '', 'base64');
  rec.parts.push(buf);
  rec.got += buf.length;
  if (ev.done !== true) return null;
  state.delete(ev.xfer);
  return { ...rec, data: Buffer.concat(rec.parts) };
}

// The name the sender chose decides a path on this machine, so it goes through the same
// sanitizer the daemon uses — a client is not more trusting of the host than the other way.
export function saveXfer(rec, cwd = process.cwd()) {
  const name = rec.kind === 'export' ? exportFileName(rec.session || 'unknown') : safeBaseName(rec.name);
  if (!name) throw new Error(`refusing to write ${JSON.stringify(String(rec.name).slice(0, 40))}`);
  const file = rec.kind === 'export'
    ? path.resolve(cwd, name)
    : path.resolve(cwd, DOWNLOAD_DIR, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rec.data, { mode: 0o644 });
  return file;
}

// ---------------------------------------------------------------- outgoing ----
// `/send <path>`: read it whole (the cap is 20 MB) so the file cannot change between the
// host's approval and the bytes going out. Throws with a message the client prints as-is.
export function readForUpload(p) {
  const raw = String(p ?? '').trim();
  if (!raw) throw new Error('usage: /send <path>');
  const abs = path.resolve(raw.startsWith('~/') ? path.join(os.homedir(), raw.slice(2)) : raw);
  let st;
  try { st = fs.statSync(abs); } catch { throw new Error(`no such file: ${abs}`); }
  if (!st.isFile()) throw new Error(`${abs} is not a file`);
  if (st.size > UPLOAD_MAX) throw new Error(`${humanBytes(st.size)} is over the ${humanBytes(UPLOAD_MAX)} upload cap`);
  if (!safeBaseName(path.basename(abs))) throw new Error(`${path.basename(abs)} is not a name the host will write`);
  return { name: path.basename(abs), data: fs.readFileSync(abs), path: abs };
}

// `/paste`: the clipboard as a PNG. pngpaste when it is installed, else osascript — every mac
// has it, and `«class PNGf»` is the clipboard type an image lands on. macOS only by nature:
// no other platform has that clipboard class, so elsewhere this says so and stops.
const OSASCRIPT_PNG = [
  'set f to (open for access (POSIX file "%FILE%") with write permission)',
  'try',
  '  write (the clipboard as «class PNGf») to f',
  '  close access f',
  'on error e',
  '  try',
  '    close access f',
  '  end try',
  '  error e',
  'end try',
].join('\n');

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');

export function clipboardPng() {
  if (process.platform !== 'darwin') {
    throw new Error('/paste reads a PNG off the macOS clipboard — on this platform use /send <path>');
  }
  // mkdtemp, so the path is ours and has no character AppleScript or a shell could read as
  // anything but a path (there is no shell here either: spawnSync with an argv).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jam-paste-'));
  const file = path.join(dir, `paste-${stamp()}.png`);
  try {
    const png = spawnSync('pngpaste', [file], { encoding: 'utf8' });
    if (png.error || png.status !== 0) {
      const as = spawnSync('osascript', ['-e', OSASCRIPT_PNG.replace('%FILE%', file)], { encoding: 'utf8' });
      if (as.error || as.status !== 0) {
        const why = (as.stderr || png.stderr || '').trim().split('\n')[0] || 'nothing to paste';
        throw new Error(`no image on the clipboard (${why})`);
      }
    }
    const data = fs.readFileSync(file);
    if (!data.length) throw new Error('the clipboard image came back empty');
    if (data.length > UPLOAD_MAX) throw new Error(`${humanBytes(data.length)} is over the ${humanBytes(UPLOAD_MAX)} upload cap`);
    return { name: path.basename(file), data };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
