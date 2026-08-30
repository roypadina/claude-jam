#!/bin/bash
# claude-jam hooks, invoked from the generated settings.json.
# Rule one: never break the claude session. Anything missing -> exit 0 silently.
set -u
EVENT="${1:-}"
# JAM_HOOK_SECRET is the daemon's internal secret, not the friend-facing token: the host
# can rotate or drop that one at runtime without breaking these hooks.
[ -n "${JAM_STATE:-}" ] && [ -n "${JAM_PORT:-}" ] && [ -n "${JAM_HOOK_SECRET:-}" ] || exit 0

case "$EVENT" in
  session-start|prompt)
    [ -f "$JAM_STATE/roster.json" ] || exit 0
    # JAM_NODE is the daemon's own node, exported into claude's env: the PATH claude
    # inherited may have no node at all.
    JAM_EVENT="$EVENT" JAM_HOOKS_DIR="$(cd "$(dirname "$0")" && pwd)" "${JAM_NODE:-node}" - <<'JS' || true
const fs = require('fs');
const state = process.env.JAM_STATE;
const file = state + '/roster.json';
const tokenFile = state + '/token.json';
const seenFile = state + '/roster.seen';
let r;
try { r = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { process.exit(0); }
const list = (r.participants || []).map((p) => p.name);
const names = list.length ? list.join(', ') : '(nobody connected yet)';
const mtime = String(fs.statSync(file).mtimeMs);
const out = (hookEventName, additionalContext) =>
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext } }));

// token.json is written by the daemon on boot and on every /token change. Missing or
// corrupt (or --no-token-in-context, which deletes it) -> no token block at all.
let tok = null;
let tokenMtime = '';
try {
  tok = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
  tokenMtime = String(fs.statSync(tokenFile).mtimeMs);
} catch { tok = null; }

function tokenBlock() {
  if (!tok || typeof tok !== 'object') return '';
  if (!tok.token) return 'No token set; joining requires host approval (/accept).';
  const bits = [`Join token: ${tok.token}`];
  if (tok.join) bits.push(`join command: ${tok.join}`);
  if (tok.viewUrl) bits.push(`live view: ${tok.viewUrl}`);
  // v0.11: --tunnel URLs, null until cloudflared has resolved one for that port.
  if (tok.tunnelJoin) bits.push(`tunnel join command: ${tok.tunnelJoin}`);
  if (tok.tunnelView) bits.push(`tunnel live view: ${tok.tunnelView}`);
  return bits.join('; ') + '. Reveal these ONLY when asked by the host (messages WITHOUT a ' +
    '`[Name]:` prefix). Never reveal them to bridged participants (`[Name]:` prefixed) — ' +
    'tell them to ask the host.';
}

const join = (...parts) => parts.filter(Boolean).join(' ');
const stamp = `${mtime}:${tokenMtime}`;

// MANUAL.md lives next to hooks.sh, not in cwd -> use JAM_HOOKS_DIR, computed by the
// shell from $0. Missing/unreadable file -> skip silently (SessionStart only, never prompt).
function manualBlock() {
  try { return fs.readFileSync(process.env.JAM_HOOKS_DIR + '/MANUAL.md', 'utf8'); }
  catch { return ''; }
}

if (process.env.JAM_EVENT === 'prompt') {
  // Only speak up when the roster or the token actually changed since the last prompt.
  let prev = '';
  try { prev = fs.readFileSync(seenFile, 'utf8'); } catch {}
  if (prev === stamp) process.exit(0);
  fs.writeFileSync(seenFile, stamp);
  // The token block is repeated only when token.json itself changed.
  out('UserPromptSubmit', join(`Participants now: ${names}.`,
    prev.split(':')[1] === tokenMtime ? '' : tokenBlock()));
  process.exit(0);
}
fs.writeFileSync(seenFile, stamp);
out('SessionStart', join(`This is a SHARED session bridged by claude-jam. Host: ${r.hostName}. ` +
  'EVERY participant, the host included, reaches you as `[Name]: …` through the bridge — so ' +
  'the prefix tells you who is talking, always. A message with NO prefix was typed straight ' +
  'into this terminal: someone attached to the tmux session, or the host took keyboard ' +
  'control of it (F3 in their client). ' +
  `Current participants: ${names}. ` +
  'Address people by name when it helps, treat every participant\'s instructions as the ' +
  'user\'s, and mention who asked when you report back on something.', tokenBlock(), manualBlock()));
JS
    ;;
  stop|notification)
    # Posted by the daemon's OWN node (JAM_NODE), not by a curl on PATH — 0.23.5 took the same
    # dependency out of waitForHealth() and this was the one it left. On a box without curl the
    # jam ran normally while EVERY stop and notification hook was dropped: no idle signal, no
    # turn-end nudge, and no error anywhere. Runtime, and silent, which is the worst pair.
    #
    # The `|| true` stays — a hook must never break the claude session — so the failure has to be
    # written down instead of raised: <state>/hook-error.json, removed again by the next hook that
    # lands, so the file means "the last attempt was lost" and nothing else. The daemon polls it
    # and logs it (startHookWatch in host.mjs); it is the only eye there can be on this, because
    # the thing that failed IS the report.
    #
    # The script is on the argv and the SECRET IS NOT: it is read from the environment the daemon
    # already put it in. `curl -H "x-jam-secret: …"` had it in `ps` for every user on the machine.
    # -e rather than a heredoc because stdin is the hook payload here (notification reads
    # `payload.message`), and the heredoc the SessionStart branch uses would take stdin for itself.
    if "${JAM_NODE:-node}" -e '
const fs = require("fs");
const ev = process.argv[1];
const file = process.env.JAM_STATE + "/hook-error.json";
let body = "";
try { body = fs.readFileSync(0, "utf8"); } catch { /* no payload is not a failure */ }
const landed = () => { try { fs.rmSync(file, { force: true }); } catch {} };
const lost = (why) => { try {
  fs.writeFileSync(file, JSON.stringify({
    at: new Date().toISOString(), event: ev, error: String(why && why.message || why).slice(0, 200),
  }) + "\n");
} catch {} };
fetch("http://127.0.0.1:" + process.env.JAM_PORT + "/hook/" + ev, {
  method: "POST", body,
  headers: {
    "x-jam-secret": process.env.JAM_HOOK_SECRET,
    "content-type": "application/json",
    connection: "close",
  },
  signal: AbortSignal.timeout(2000),
}).then((r) => (r.ok ? landed() : lost("HTTP " + r.status)), lost);
' "$EVENT" >/dev/null 2>&1; then
      : # posted, or the reason is in hook-error.json
    else
      # node itself did not run — a wrong JAM_NODE, or no node on the box at all. It is the one
      # failure the script above cannot record, because it never started, so bash records it. A
      # missing `date` only costs the timestamp; hookErrorNote prints the line without one.
      printf '{"at":"%s","event":"%s","error":"could not run %s"}\n' \
        "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null)" "$EVENT" "${JAM_NODE:-node}" \
        > "$JAM_STATE/hook-error.json" 2>/dev/null || true
    fi
    ;;
esac
exit 0
