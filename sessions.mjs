#!/usr/bin/env node
// claude-jam session lifecycle: `jam sessions|ls`, `jam end|kill`, `jam clean`. Also the module
// host.mjs imports, so the launcher's `[e]nd it` and the exit prompt's `e` go down exactly the
// same path as the command line — there is one end, not two.
//
// THE SAFETY RULE (v0.18, and the reason this file is small and boring): jam may end a tmux
// session ONLY when it was named explicitly (or picked out of jam's own verified list) AND its
// `@jam-owned` option resolves to a state dir holding the session.json jam wrote for that exact
// name. So:
//   * nothing here ever runs `tmux list-sessions` — enumeration is over jam's OWN namespace,
//     the `$TMPDIR/claude-jam-<port>` state dirs, and a dir with no session.json of jam's is
//     not listed and not touched;
//   * `kill-session` is only ever reached through killOwned(), which re-verifies the marker
//     immediately before it runs, one exact name at a time;
//   * `has-session`/`kill-session` targets carry tmux's `=` exact-match prefix, because a bare
//     `-t jam` would happily prefix-match somebody's `jamboree`;
//   * there is no name pattern, no glob, no `kill-server`, and `--all` re-verifies every row.
// Other people's tmux sessions live on this machine. They are not ours to end.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import net from 'node:net';
import { OWNED_OPTION, SESSION_FILE, portFromStateDir, parseSessionJson, verifyOwned, classifyJam,
  cleanable, resolveTarget, pickNumber, confirmYes, uptimeText, sessionsTable, sessionsJson,
  // v0.22B: the invite CLI is this file too — it needs exactly what `jam end` needs (find the
  // jam, POST to it on loopback with the secret out of its 0700 state dir).
  parseInviteCommand, invitesReport, inviteMintedLines, inviteRecord } from './lib.mjs';

const TMUX = process.env.JAM_TMUX_BIN || 'tmux';
export const tmux = (...a) => spawnSync(TMUX, a, { encoding: 'utf8' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// tmux target-session resolution is exact → prefix → fnmatch, so a bare name can land on a
// session that merely starts the same way. `=` pins it to an exact match. Measured on tmux
// 3.7c: has-session and kill-session honour the prefix, `show-options -t` does NOT (it answers
// `no such session: =jam`) — so the marker is read with a plain target, always after
// hasSession() has proved the exact name exists, and verifyOwned re-checks the name anyway.
export const hasSession = (name) => !!name && tmux('has-session', '-t', `=${name}`).status === 0;

export function sessionMarker(name) {
  const r = tmux('show-options', '-t', name, '-v', OWNED_OPTION);
  if (r.status !== 0) return null;
  const v = (r.stdout || '').replace(/\n$/, '').trim();
  return v || null;
}

export function readSessionFile(dir) {
  if (!dir) return null;
  try { return parseSessionJson(fs.readFileSync(path.join(dir, SESSION_FILE), 'utf8')); } catch { return null; }
}

// The one question every destructive path asks: is this tmux session jam's own? Returns
// verifyOwned's verdict, or a `missing` refusal when there is no such session at all.
export function ownedSession(name) {
  if (!hasSession(name)) {
    return { ok: false, missing: true, why: `there is no tmux session called "${name}"` };
  }
  const marker = sessionMarker(name);
  return verifyOwned(name, marker, readSessionFile(marker));
}

// The ONLY caller of kill-session in the whole project (`must()` in host.mjs aside, which
// removes the half-built session it created two statements earlier). Verifies again right
// before the kill, because the check that matters is the one nothing can happen between.
// `verdict` is for the one caller that has to verify a moment earlier — the daemon killing its
// OWN session, which cannot re-read a state dir it is about to remove; it passes the verdict it
// just took, and nothing else may.
export function killOwned(name, verdict = null) {
  const v = verdict || ownedSession(name);
  if (!v.ok) return { ok: false, why: v.why };
  if (v.info?.tmux !== name) return { ok: false, why: `verdict is for "${v.info?.tmux}", not "${name}"` };
  const r = tmux('kill-session', '-t', `=${name}`);
  if (r.status !== 0) return { ok: false, why: `tmux kill-session failed: ${(r.stderr || r.stdout || '').trim()}` };
  return { ok: true };
}

// Removing a directory recursively deserves its own belt: only ever a path whose basename is
// jam's own `claude-jam-<port>`, and only one that a verified session.json named.
export function removeStateDir(dir) {
  if (!dir || portFromStateDir(path.basename(dir)) == null) {
    return { ok: false, why: `${dir} is not a claude-jam state dir — not removing it` };
  }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { return { ok: false, why: e.message }; }
  return { ok: true };
}

// ------------------------------------------------------------------- liveness ----
// Is a daemon answering on that port? /health is public (the launcher polls it), so this needs
// no credential; the participant list comes from roster.json instead.
export async function daemonHealth(port, ms = 700) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(ms) });
    const j = await r.json();
    return j?.ok === 'ok' ? j : null;
  } catch { return null; }
}

// Is anything at all listening? Used when auto-naming a second jam: a port whose daemon is dead
// can still be held by something else, and the answer has to be about TCP, not about jam.
export function portBusy(port, ms = 400) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(ms, () => done(false));
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
  });
}

// The daemon's own end: it tells every client `{t:'ending'}`, stops its children, removes the
// state dir and kills its own tmux session. Loopback plus the hook secret, the same gate the
// knock popup's POST /admit uses — and the secret comes out of the 0700 state dir, never off a
// command line.
export async function postEnd(port, secret, ms = 3000) {
  if (!secret) return { ok: false, why: 'no hook secret in session.json' };
  try {
    const r = await fetch(`http://127.0.0.1:${port}/end`, {
      method: 'POST', headers: { 'x-jam-secret': secret }, signal: AbortSignal.timeout(ms),
    });
    const j = await r.json().catch(() => null);
    return j?.ok ? { ok: true } : { ok: false, why: `HTTP ${r.status}${j?.error ? ` ${j.error}` : ''}` };
  } catch (e) { return { ok: false, why: e.message }; }
}

// v0.22B: `jam invite|invites|invite revoke` asking the daemon to mint, list or revoke. Same
// gate as POST /end — loopback plus the hook secret, which only a reader of the 0700 state dir
// has — and the same inviteOp() a `/invite` frame from the client goes through.
export async function postInvite(port, secret, body, ms = 5000) {
  if (!secret) return { ok: false, why: 'no hook secret in session.json' };
  try {
    const r = await fetch(`http://127.0.0.1:${port}/invite`, {
      method: 'POST',
      headers: { 'x-jam-secret': secret, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(ms),
    });
    const j = await r.json().catch(() => null);
    return j?.ok ? { ok: true, ...j } : { ok: false, why: j?.error || `HTTP ${r.status}` };
  } catch (e) { return { ok: false, why: e.message }; }
}

// ------------------------------------------------------------------ the rows ----
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function rosterNames(dir) {
  const r = readJson(path.join(dir, 'roster.json'));
  return Array.isArray(r?.participants) ? r.participants.map((p) => p?.name).filter(Boolean) : [];
}

// Presence only. token.json holds the join line (with the token in it) and the view URL (with
// the view key in it), so a listing says which relays exist and never what they are.
function relays(dir) {
  const t = readJson(path.join(dir, 'token.json')) || {};
  return { view: !!t.viewUrl, tunnel: !!(t.tunnelJoin || t.tunnelView) };
}

// jam's own namespace, enumerated: every `$TMPDIR/claude-jam-<port>` directory that holds a
// session.json jam wrote. Deliberately NOT a walk over `tmux list-sessions` — the sessions this
// finds are the ones jam created, and nothing else can appear in the list by accident.
// ponytail: a jam-owned session whose state dir was deleted by hand is therefore invisible here
// (and so cannot be `jam end`ed by name — `tmux kill-session` is the manual way out). Enumerate
// the tmux side too if that ever actually happens.
export async function listRows(tmpdir = os.tmpdir()) {
  let entries = [];
  try { entries = fs.readdirSync(tmpdir); } catch { return []; }
  const rows = [];
  for (const base of entries.sort()) {
    const port = portFromStateDir(base);
    if (port == null) continue;
    const dir = path.join(tmpdir, base);
    const info = readSessionFile(dir);
    if (!info) continue; // no session.json of jam's: not jam's to list, and never jam's to touch
    const tmuxAlive = hasSession(info.tmux);
    const marker = tmuxAlive ? sessionMarker(info.tmux) : null;
    const owned = tmuxAlive && verifyOwned(info.tmux, marker, readSessionFile(marker)).ok;
    const portAlive = !!(await daemonHealth(port)) || (!tmuxAlive && await portBusy(port));
    rows.push({
      name: tmuxAlive ? info.tmux : null,
      state: classifyJam({ tmuxAlive, owned, portAlive }),
      port,
      viewPort: info.viewPort ?? null,
      cwd: info.cwd || null,
      sessionId: info.sessionId || null,
      createdAt: info.createdAt || null,
      participants: rosterNames(dir),
      ...relays(dir),
      dir,
      info,
    });
  }
  return rows;
}

// ------------------------------------------------------------------ ending one ----
// Every way of ending a jam — `jam end`, the exit prompt's `e`, `[e]nd it and start fresh`,
// `/end` in the client — arrives here. Two gates around one kill.
export async function endJam(row, log = console.log) {
  const info = row?.info || row;
  const name = info?.tmux;
  const pre = ownedSession(name);
  if (!pre.ok) return { ok: false, why: pre.why };
  log(`ending jam "${name}" (port ${info.port}, session ${String(info.sessionId).slice(0, 8)})`);
  // The daemon is the one that can tell the clients, so it gets the first word — and it kills
  // its own session, which is the ordinary path.
  const said = await postEnd(info.port, info.secret);
  log(said.ok
    ? '  daemon told everyone the jam is ending'
    : `  the daemon on :${info.port} did not answer (${said.why}) — finishing from here`);
  for (const deadline = Date.now() + 4000; Date.now() < deadline && hasSession(name);) await sleep(150);
  if (hasSession(name)) {
    const killed = killOwned(name); // re-verified inside, immediately before the kill
    if (!killed.ok) return { ok: false, why: killed.why };
    log(`  killed tmux session ${name}`);
  } else {
    log(`  tmux session ${name} is gone`);
  }
  if (fs.existsSync(info.state)) {
    const gone = removeStateDir(info.state);
    log(gone.ok ? `  removed ${info.state}` : `  ${gone.why}`);
  }
  return { ok: true };
}

// ----------------------------------------------------------------- the prompts ----
async function askLine(prompt) {
  if (!process.stdin.isTTY) return null; // a pipe cannot answer, so nothing destructive happens
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try { return await new Promise((r) => rl.question(prompt, r)); } finally { rl.close(); }
}

// ------------------------------------------------------------------------ CLI ----
function usage() {
  console.error('usage: jam sessions [--json]      list jam\'s own tmux sessions and state dirs\n'
    + '       jam end [name] [--all]     end one jam (or every one, after confirming)\n'
    + '       jam clean [--yes]          remove orphan state dirs and nothing else\n'
    + '       jam invite <Name> [--uses N] [--expires 24h] [--jam NAME]   mint one link\n'
    + '       jam invites [--json] [--jam NAME]                           list them\n'
    + '       jam invite revoke <Name|id> [--jam NAME]                    take one back');
  return 2;
}

async function cmdSessions(argv) {
  const rows = await listRows();
  if (argv.includes('--json')) {
    console.log(JSON.stringify(sessionsJson(rows, Date.now()), null, 2));
    return 0;
  }
  console.log(sessionsTable(rows, Date.now()));
  return 0;
}

async function cmdEnd(argv) {
  const rows = await listRows();
  const name = argv.find((a) => !a.startsWith('-')) ?? null;
  if (argv.includes('--all')) {
    // Even here every row is re-verified by endJam, one exact name at a time.
    const targets = rows.filter((r) => r.name && r.state !== 'foreign');
    if (!targets.length) { console.log('no jam of jam\'s own is running'); return 0; }
    console.log(`this would end ${targets.length} jam(s): ${targets.map((r) => r.name).join(', ')}`);
    if (!confirmYes(argv.includes('--yes') ? 'y' : await askLine('end all of them? [y/N] '))) {
      console.log('nothing ended');
      return 1;
    }
    let bad = 0;
    for (const row of targets) {
      const r = await endJam(row);
      if (!r.ok) { bad++; console.error(`  refused: ${r.why}`); }
    }
    return bad ? 1 : 0;
  }
  let target = resolveTarget(rows, name);
  if (!target.ok && target.choices?.length && name == null) {
    // Several jams and no name: a numbered picker over jam's own verified rows. Nothing is
    // resolved by pattern, and an answer that is not one of the numbers ends nothing.
    console.log(sessionsTable(rows, Date.now()));
    const pick = pickNumber(await askLine(`which jam? [1-${target.choices.length}] `), target.choices);
    if (!pick) { console.log('nothing ended'); return 1; }
    target = { ok: true, row: pick };
  }
  if (!target.ok) {
    console.error(target.why);
    if (rows.some(cleanable)) console.error('(orphan state dirs are `jam clean`, not `jam end`)');
    return 1;
  }
  const r = await endJam(target.row);
  if (!r.ok) { console.error(`refused: ${r.why}`); return 1; }
  return 0;
}

async function cmdClean(argv) {
  const rows = await listRows();
  const doomed = rows.filter(cleanable);
  const others = rows.filter((r) => !cleanable(r));
  if (!doomed.length) {
    console.log(`nothing to clean${others.length ? ` — ${others.length} state dir(s) still belong to a session` : ''}`);
    return 0;
  }
  console.log('these state dirs have no tmux session and nothing listening on their port:');
  const now = Date.now();
  for (const r of doomed) {
    console.log(`  ${r.dir}  (port ${r.port}, session ${String(r.sessionId || '').slice(0, 8) || '?'}`
      + `${r.createdAt ? `, ${uptimeText(now - r.createdAt)} old` : ''})`);
  }
  if (others.length) console.log(`leaving ${others.length} alone: ${others.map((r) => `${r.name || r.port} (${r.state})`).join(', ')}`);
  if (!confirmYes(argv.includes('--yes') || argv.includes('-y') ? 'y' : await askLine(`delete ${doomed.length} state dir(s)? [y/N] `))) {
    console.log('nothing deleted');
    return 1;
  }
  let bad = 0;
  for (const r of doomed) {
    const gone = removeStateDir(r.dir);
    if (gone.ok) console.log(`removed ${r.dir}`);
    else { bad++; console.error(`could not remove ${r.dir}: ${gone.why}`); }
  }
  return bad ? 1 : 0;
}

// v0.22B: `jam invite <Name> [--uses N] [--expires 24h] [--jam NAME]`, `jam invites [--json]`,
// `jam invite revoke <Name|id>`. Everything the client's `/invite` does, from a shell — one
// parser (parseInviteCommand) and one daemon endpoint, so the two surfaces cannot drift.
async function cmdInvite(argv, forced = null) {
  // `--jam <name>` picks which jam when several are running; it is not part of the invite syntax.
  const jamAt = argv.indexOf('--jam');
  const jamName = jamAt >= 0 ? argv[jamAt + 1] : null;
  const json = argv.includes('--json');
  const words = argv.filter((a, i) => i !== jamAt && i !== jamAt + 1 && a !== '--json');
  const v = forced ? { ok: true, op: forced } : parseInviteCommand(words.join(' '));
  if (!v.ok) { console.error(v.error); return 2; }

  const rows = await listRows();
  let target = resolveTarget(rows, jamName);
  if (!target.ok && target.choices?.length && jamName == null) {
    console.log(sessionsTable(rows, Date.now()));
    const pick = pickNumber(await askLine(`which jam? [1-${target.choices.length}] `), target.choices);
    if (!pick) { console.log('nothing done'); return 1; }
    target = { ok: true, row: pick };
  }
  if (!target.ok) { console.error(target.why); return 1; }
  const { info } = target.row;

  const r = await postInvite(info.port, info.secret, v);
  if (!r.ok) { console.error(`refused: ${r.why}`); return 1; }
  if (v.op === 'list') {
    if (json) console.log(JSON.stringify(r.invites || [], null, 2));
    else console.log(r.report || invitesReport(r.invites || []));
    return 0;
  }
  if (v.op === 'revoke') {
    console.log(`revoked ${(r.revoked || []).length} invite link(s): `
      + `${(r.revoked || []).map((h) => `${h.id} (${h.name})`).join(', ')}`);
    return 0;
  }
  for (const l of inviteMintedLines(r.invite || inviteRecord({ name: v.name }), r.link, r.clientCmd || 'jam join')) {
    console.log(l);
  }
  return 0;
}

// Only when this file IS the command being run — host.mjs imports it as a module.
if (path.resolve(process.argv[1] || '') === path.resolve(new URL(import.meta.url).pathname)) {
  const [cmd, ...rest] = process.argv.slice(2);
  const run = {
    list: cmdSessions, sessions: cmdSessions, end: cmdEnd, clean: cmdClean,
    invite: (a) => cmdInvite(a), invites: (a) => cmdInvite(a, 'list'),
  }[cmd];
  process.exit(run ? await run(rest) : usage());
}
