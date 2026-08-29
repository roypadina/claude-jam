// v0.29 — running one peer task, on THIS machine, after THIS human said yes.
//
// Imported by both clients. Everything here happens on the guest's own computer, in the guest's
// own already-authenticated Claude Code, spending the guest's own quota — which is the entire
// justification for the feature and the reason every default below is the narrow one. Nothing in
// this file can be reached without the guest having answered a specific task; the decision lives
// in the client, and this is only what happens after it.
//
// THE THREE CONFINEMENTS, and each one is asserted by a test rather than promised by a comment:
//   1. cwd is a FRESH directory under $TMPDIR, made 0700 for this task and removed afterwards.
//      Never the guest's repository, never their home, never anywhere they were working.
//   2. `--restricted` ignores the guest's user/project/local settings (so a machine whose own
//      default is `bypassPermissions` does not hand that to work somebody else asked for),
//      refuses bypassPermissions outright, and confines the file tools to that directory.
//   3. `--strict-mcp-config` with no `--mcp-config` at all: zero MCP servers, so nothing the
//      guest has connected — a database, a ticket system, a cloud account — is reachable.
//
// The prompt goes in on STDIN. It is text that arrived over a network and an argv is visible in
// `ps` to every user on this machine.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { peerScratchDir, peerSettings, peerSpawnArgs, peerArgsSafe, peerPermissionMode,
  peerStreamEvent, peerProgressLine, resolveClaude, validPeerId, PEER_RESULT_MAX } from './lib.mjs';

// How long a killed child gets to go away before it is killed harder. Both signals go to a
// process GROUP THIS FUNCTION CREATED (detached:true), by the pid of the child we spawned —
// never by name, never by pattern. The group is what catches a Bash tool's own children, which
// would otherwise outlive the task on somebody's machine.
const KILL_GRACE_MS = 3000;

function killTree(child, sig) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  try { process.kill(-child.pid, sig); }
  catch { try { child.kill(sig); } catch { /* already gone */ } }
}

// Removed on every path out — finished, declined mid-flight, cancelled, timed out, crashed. A
// scratch directory that survives the task is a copy of somebody else's prompt left on disk.
function removeScratch(dir) {
  if (!dir) return;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

// Start one task. Returns a handle with `cancel()` and the scratch path; every ending arrives
// exactly once, through `onDone({ok, why, text, detail})`.
//
// `why` is one of ok | cap | timeout | cancelled | crash — four distinct failures, because a host
// agent that cannot tell them apart will retry the wrong one. Partial output is kept on all of
// them: a task that was cut off at turn nine still did nine turns of work.
export function runPeerTask(task, {
  tools, onProgress = () => {}, onDone = () => {},
  tmpdir = os.tmpdir(), env = process.env, existsSync = fs.existsSync,
} = {}) {
  const fail = (why, detail) => { onDone({ ok: false, why, text: '', detail }); return { cancel() {}, scratch: null }; };
  if (!validPeerId(task?.id)) return fail('crash', 'the task id is not one this client will make a directory out of');
  const scratch = peerScratchDir(tmpdir, task.id);
  const mode = peerPermissionMode(tools);
  let child = null;
  let done = false;
  let turns = 0;
  let out = '';        // what the task finally answered
  let partial = '';    // every line it said on the way, kept for the failure cases
  let stderr = '';
  let killWhy = null;  // set by whoever decided to stop it, so the exit reports THEIR reason
  let hard = null;
  let clock = null;

  const finish = (o) => {
    if (done) return;
    done = true;
    clearTimeout(clock);
    clearTimeout(hard);
    removeScratch(scratch);
    onDone(o);
  };

  const stop = (why) => {
    if (done || !child) return;
    killWhy = why;
    killTree(child, 'SIGTERM');
    hard = setTimeout(() => killTree(child, 'SIGKILL'), KILL_GRACE_MS);
    hard.unref?.();
  };

  try {
    // 0700 and fresh: `mkdirSync` with an existing directory would silently reuse whatever is in
    // it, and a task id is random, so a collision is a bug worth hearing about.
    fs.mkdirSync(scratch, { recursive: false, mode: 0o700 });
  } catch (e) {
    return fail('crash', `could not make the scratch directory: ${e.message}`);
  }

  const settingsFile = path.join(scratch, 'settings.json');
  let argv;
  try {
    fs.writeFileSync(settingsFile, JSON.stringify(peerSettings({ mode, tools }), null, 2), { mode: 0o600 });
    argv = peerSpawnArgs({ tools, mode, settings: settingsFile, scratch, schema: task.schema });
    // The last gate before a process exists. It is checked here, on the argv that is actually
    // about to be used, rather than only where it was built — a future flag, a caller's schema or
    // a paste could add one, and this is the line that would catch it.
    const safe = peerArgsSafe(argv);
    if (!safe.ok) { removeScratch(scratch); return fail('crash', safe.error); }
  } catch (e) {
    removeScratch(scratch);
    return fail('crash', `could not prepare the task: ${e.message}`);
  }

  const bin = resolveClaude(env, existsSync);
  try {
    child = spawn(bin, argv, {
      cwd: scratch,
      // Its own process group, so stopping it stops everything it started — and so that group is
      // one this function created and can name by the pid it was given.
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      // The guest's own environment, minus the two things that would make this run as somebody
      // else's account or read somebody else's config.
      env: { ...env, CLAUDE_CODE_ENTRYPOINT: 'claude-jam-peer' },
    });
  } catch (e) {
    removeScratch(scratch);
    return fail('crash', `${bin}: ${e.message}`);
  }

  // The prompt, on stdin, and then stdin is closed so `-p` knows it has the whole thing.
  try { child.stdin.end(String(task.prompt ?? '')); } catch { /* the spawn already failed */ }

  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      const ev = peerStreamEvent(line);
      if (!ev) continue;
      if (ev.kind === 'turn') {
        turns++;
        const said = peerProgressLine(ev);
        if (said) {
          if (partial.length < PEER_RESULT_MAX) partial += `${said}\n`;
          onProgress(said);
        }
        // The turn cap, enforced HERE rather than by a flag. `--max-turns` does not exist on
        // claude 2.1.251, so a cap that is only asked for is a cap that does not happen — and a
        // turn cap is a proxy for spend, not a spend cap, which the docs say in those words.
        if (turns >= task.maxTurns) stop('cap');
      } else if (ev.kind === 'result') {
        out = ev.text || '';
        if (!ev.ok && !killWhy) killWhy = 'crash';
      }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => { if (stderr.length < 4000) stderr += c; });

  // The wall clock. This is the cap that actually ends things, and it ends them by killing a pid
  // this function spawned.
  clock = setTimeout(() => stop('timeout'), task.deadlineMs);
  clock.unref?.();

  child.on('error', (e) => finish({ ok: false, why: 'crash', text: partial, detail: `${bin}: ${e.message}` }));
  child.on('close', (code, signal) => {
    const text = out || partial;
    if (killWhy && killWhy !== 'crash') return finish({ ok: false, why: killWhy, text });
    if (code === 0 && out) return finish({ ok: true, why: 'ok', text: out });
    return finish({ ok: false, why: 'crash', text,
      detail: (stderr.trim().split('\n').slice(-3).join(' ') || `exit ${code}${signal ? ` (${signal})` : ''}`).slice(0, 400) });
  });

  return { scratch, cancel: () => stop('cancelled'), pid: child.pid };
}
