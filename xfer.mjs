// claude-jam file transfers, the client's half (v0.12 export, v0.13 files). fs lives here so
// lib.mjs stays pure and both renderers share this. v0.32 W0: the clipboard and the desktop
// notification moved to platform.mjs — this file spawns nothing at all now.
//
// Everything written by a client lands in ITS OWN cwd: the transcript beside it as
// `jam-session-<id>.jsonl`, an offered file under `./jam-downloads/`. Mode 0644, never
// executable, and nothing here ever runs or opens what it just wrote.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UPLOAD_MAX, safeBaseName, humanBytes, exportFileName, wslTranslatePath } from './lib.mjs';
import { wslInfo } from './platform.mjs';

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
  // v0.32 W2: a guest inside WSL2 pastes the Windows spelling of a path as readily as the host
  // does. This reads the TYPER's own filesystem either way, so translating the spelling reaches
  // nothing typing `/mnt/c/...` would not have reached; an untranslatable one is refused by name.
  const win = wslInfo().wsl ? wslTranslatePath(raw, wslInfo()) : { path: raw };
  if (win.refuse) throw new Error(win.refuse);
  const abs = path.resolve(win.path.startsWith('~/') ? path.join(os.homedir(), win.path.slice(2)) : win.path);
  let st;
  try { st = fs.statSync(abs); } catch { throw new Error(`no such file: ${abs}`); }
  if (!st.isFile()) throw new Error(`${abs} is not a file`);
  if (st.size > UPLOAD_MAX) throw new Error(`${humanBytes(st.size)} is over the ${humanBytes(UPLOAD_MAX)} upload cap`);
  if (!safeBaseName(path.basename(abs))) throw new Error(`${path.basename(abs)} is not a name the host will write`);
  return { name: path.basename(abs), data: fs.readFileSync(abs), path: abs };
}
