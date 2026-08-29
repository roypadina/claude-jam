// Pure helpers for claude-jam. No I/O here so test.mjs can import them freely.
import { createHash, timingSafeEqual } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

// A bridged message looks like "[Dana]: hello". Used both to build and to detect.
export const PREFIX_RE = /^\[([^\]]{1,24})\]: /;
export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,23}$/;
export const MAX_TEXT = 20000;

// Shown wherever a join line would go while no token is set.
export const NO_TOKEN_HINT = 'no token set — friends knock, you /accept';

export function validName(name) {
  return typeof name === 'string' && NAME_RE.test(name);
}

// A host-chosen token (`--token`, `/token set`). Narrow charset so it survives a shell
// command line, a chat message and a URL without quoting.
export const TOKEN_VALUE_RE = /^[A-Za-z0-9_-]{8,64}$/;
export function validTokenValue(v) {
  return typeof v === 'string' && TOKEN_VALUE_RE.test(v);
}

// Hash first so lengths always match, then compare without leaking the prefix length.
// `current` is null when no token is set — then nothing matches, so everyone knocks.
export function tokenMatches(given, current) {
  if (typeof given !== 'string' || typeof current !== 'string' || !current) return false;
  return timingSafeEqual(createHash('sha256').update(given).digest(),
    createHash('sha256').update(current).digest());
}

// Attribution is by name, so two live participants cannot share one. Compared
// case-insensitively: "[dana]" and "[Dana]" would read as the same person to the agent.
export function nameTaken(name, taken) {
  const n = String(name).toLowerCase();
  return taken.some((t) => String(t).toLowerCase() === n);
}

// ------------------------------------- v0.15: source vs installed client command ----

// What a friend types to run the client: `jam join …` when the daemon itself is running out of
// a Homebrew install (their `jam join` binary; no `client.mjs` sitting in their cwd), otherwise
// the from-source `node client.mjs …`. `dirname` is the running host/client script's own
// directory (a Cellar path is the one thing a plain `git clone` can never produce); `env` can
// force either way — JAM_INSTALLED is for a bin wrapper to set explicitly, since a future
// formula layout might not put anything under `/Cellar/claude-jam/` at all.
export function clientCommand(dirname, env = {}) {
  if (env.JAM_INSTALLED === '1') return 'jam join';
  if (env.JAM_INSTALLED === '0') return 'node client.mjs';
  return String(dirname ?? '').includes('/Cellar/claude-jam/') ? 'jam join' : 'node client.mjs';
}

// The friend-facing invite command, or null while no token is set — then the host sees
// NO_TOKEN_HINT instead and friends get in by knocking. `clientCmd` is clientCommand()'s answer;
// the default keeps every caller that does not care (most tests) on the from-source form.
export function buildJoinLine(ip, port, token, clientCmd = 'node client.mjs') {
  return token ? `${clientCmd} ws://${ip}:${port} --name <You> --token ${token}` : null;
}

// The read-only browser view of the real claude TUI (ttyd), basic auth baked into the URL
// so one paste is enough. null while there is no view (no ttyd, or --no-view).
export function buildViewUrl(ip, port, key) {
  return key ? `http://jam:${key}@${ip}:${port}` : null;
}

// Everything the host can hand out, same order and wording wherever it is shown: the
// daemon log, the host client's welcome, `/join` and every `/token` reply.
export function joinLines(join, view) {
  const lines = [join ? `invite: ${join}` : NO_TOKEN_HINT];
  if (view) lines.push(`view: ${view}`);
  return lines;
}

// ttyd's basic-auth password: the friend token when there is one, so a friend needs no
// second secret; otherwise a key of our own, so the view is never open. `generate` is
// injected to keep this pure — the caller owns the randomness.
export function resolveViewKey(token, generate) {
  return token || generate();
}

// What the daemon writes to `<state>/token.json` for hooks.sh to read back. Absent
// values stay explicit nulls so the hook can tell "no token" from "not written yet".
// tunnelJoin/tunnelView (v0.11) are null until --tunnel is given and cloudflared resolves.
export function buildTokenFile(token, join, view, tunnelJoin, tunnelView) {
  return {
    token: token || null, join: join || null, viewUrl: view || null,
    tunnelJoin: tunnelJoin || null, tunnelView: tunnelView || null,
  };
}

// How a hello frame gets in. `admit:'token'` → straight to welcome, `admit:'knock'` →
// pending until the host accepts. `host:true` is honoured only from loopback: that
// connection is the client the launcher itself spawned, so it is trusted by construction
// (and admitted even with no token set); anyone else claiming it is just a friend.
export function classifyHello(hello, currentToken, isLoopback) {
  const name = hello?.name;
  if (!validName(name)) return { ok: false, code: 4400, error: 'bad name' };
  const host = hello?.host === true && !!isLoopback;
  const admit = host || tokenMatches(hello?.token, currentToken) ? 'token' : 'knock';
  return { ok: true, name, host, admit };
}

// Session ids (both `claude --session-id` and `--resume`) are UUIDs. Loose check on
// purpose: we only need to catch typos/garbage before shelling out to claude, not
// enforce a specific UUID version.
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(id) {
  return typeof id === 'string' && UUID_RE.test(id);
}

// Strip escape sequences and control chars, keep newlines and tabs. Used on human
// input and on agent text before it is written to somebody else's terminal.
export function stripControl(text) {
  return String(text)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC
    .replace(/\x1b[@-Z\\-_]|\x1b\[[0-9;?]*[ -/]*[@-~]/g, '') // CSI / two-char escapes
    .replace(/\r\n?/g, '\n')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '') // C0 + DEL + 8-bit C1
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g, ''); // zero-width / bidi
}

// Only the daemon may write "[Name]: ". A participant whose own text starts a line
// that way would forge attribution the agent has been told to trust, so bend the
// bracket to a lookalike that PREFIX_RE cannot match.
export function neutralizePrefixes(text) {
  return text.split('\n').map((l) => (PREFIX_RE.test(l) ? '\uff3b' + l.slice(1) : l)).join('\n');
}

// Strip escape sequences and control chars, keep newlines and tabs, cap length.
export function sanitize(text) {
  if (typeof text !== 'string') return { ok: false, error: 'text must be a string' };
  let t = stripControl(text).trim();
  if (!t) return { ok: false, error: 'empty message' };
  if (t.length > MAX_TEXT) t = t.slice(0, MAX_TEXT);
  return { ok: true, text: t };
}

// Wrapper tags Claude Code puts around slash-command plumbing. Same lists as
// transcript.ts: STRIP_TAGS drop tag and contents, KEEP_INNER_TAGS keep the contents.
const STRIP_TAGS = ['command-message', 'command-name', 'system-reminder',
  'local-command-caveat', 'local-command-stdout', 'local-command-stderr'];
const KEEP_INNER_TAGS = ['command-args'];

export function clean(text) {
  let t = text;
  for (const tag of KEEP_INNER_TAGS) {
    t = t.replace(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'g'), '$1');
    t = t.replace(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)$`, 'g'), '$1');
  }
  for (const tag of STRIP_TAGS) {
    t = t.replace(new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${tag}>`, 'g'), '');
    t = t.replace(new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*$`, 'g'), '');
  }
  return t.trim();
}

// One place that knows the Claude Code JSONL shape. Mirrors ClaudeCodeSessionManager's
// transcript.ts. Returns a list of classified entries; unknown/broken lines return [].
// A tool_result's content is a string or a list of text blocks. One line is all a chat log
// can carry — the full output is right there in the host's TUI.
export const TOOL_RESULT_MAX = 100;
export function toolResultText(content) {
  const raw = typeof content === 'string' ? content
    : Array.isArray(content)
      ? content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n')
      : '';
  const line = raw.split('\n').map((l) => l.trim()).find(Boolean) || '';
  return line.length > TOOL_RESULT_MAX ? `${line.slice(0, TOOL_RESULT_MAX - 1)}…` : line;
}

export function parseJsonlLine(line) {
  if (!line || !line.trim()) return [];
  let obj;
  try { obj = JSON.parse(line); } catch { return []; }
  if (!obj || typeof obj !== 'object') return [];

  if (obj.type === 'user') {
    if (obj.isMeta) return [];
    const c = obj.message?.content;
    const texts = [];
    const results = [];
    if (typeof c === 'string') texts.push(c);
    else if (Array.isArray(c)) {
      for (const b of c) {
        if (b?.type === 'text' && typeof b.text === 'string') texts.push(b.text);
        // A tool_result rides in a *user* record but is the agent's own plumbing, never a
        // human turn: it renders as a `⎿` line and the caller must keep it out of the
        // busy/attribution logic (see onTranscript).
        else if (b?.type === 'tool_result') {
          const t = toolResultText(b.content);
          if (t) results.push({ kind: 'tool-result', text: t });
        }
      }
    }
    const said = texts
      .map(clean) // slash-command plumbing cleans to '' and drops out below
      .filter(Boolean)
      .map((text) => {
        const m = PREFIX_RE.exec(text);
        // Bridged messages were already broadcast when they were injected.
        return m ? { kind: 'user', text, bridged: true, from: m[1] } : { kind: 'user', text, bridged: false };
      });
    return [...said, ...results];
  }

  if (obj.type === 'assistant') {
    const blocks = obj.message?.content;
    if (!Array.isArray(blocks)) return [];
    const out = [];
    for (const b of blocks) {
      if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
        out.push({ kind: 'text', text: b.text.trim() });
      } else if (b?.type === 'tool_use') {
        const args = JSON.stringify(b.input ?? {});
        out.push({ kind: 'tool', text: `${b.name ?? '?'}: ${args.slice(0, 120)}` });
      }
      // thinking and everything else: ignored.
    }
    return out;
  }

  return [];
}

// Turns one typed line into a client action. Multi-line continuation: a trailing
// backslash means "keep collecting".
export function parseClientLine(line) {
  if (line.endsWith('\\')) return { kind: 'continue', text: line.slice(0, -1) };
  const t = line.trim();
  if (!t) return { kind: 'noop' };
  if (t === '/quit' || t === '/exit') return { kind: 'quit' };
  if (t === '/who') return { kind: 'who' };
  // Host-only commands below. Whether the caller actually is the host is runtime state
  // parseClientLine doesn't have, so client.mjs makes that call.
  if (t === '/join') return { kind: 'join' };
  if (t === '/accept' || t.startsWith('/accept ')) {
    // No name = admit the only pending knocker; the daemon errors if there are several.
    return { kind: 'accept', name: t.slice(7).trim() || null };
  }
  if (t === '/deny' || t.startsWith('/deny ')) {
    const name = t.slice(5).trim();
    return name ? { kind: 'deny', name } : { kind: 'error', text: 'usage: /deny <name>' };
  }
  if (t === '/token' || t.startsWith('/token ')) {
    const [op, ...rest] = t.slice(6).trim().split(/\s+/);
    if (op === 'new' || op === 'off') return { kind: 'token', op };
    if (op === 'set') {
      const value = rest.join(' ');
      return validTokenValue(value) ? { kind: 'token', op: 'set', value }
        : { kind: 'error', text: 'token must be 8-64 chars of [A-Za-z0-9_-]' };
    }
    return { kind: 'error', text: 'usage: /token new | set <value> | off' };
  }
  // v0.14: the host's answer to a guest's `/command` request. `always` (last word, with or
  // without a name) grants that guest standing approval for the rest of this jam; no name
  // means the only guest currently waiting.
  if (t === '/allow-cmd' || t.startsWith('/allow-cmd ')) {
    return { kind: 'cmd', op: 'allow', ...answerWords(t.slice(10)) };
  }
  if (t === '/deny-cmd' || t.startsWith('/deny-cmd ')) {
    return { kind: 'cmd', op: 'deny', name: t.slice(9).trim() || null, always: false };
  }
  // v0.7: flip between the transcript and a live mirror of the host's real TUI. Same
  // action as F2; the basic client has no mirror and says so.
  if (t === '/mirror') return { kind: 'mirror' };
  // v0.10c: reprint the onboarding block.
  if (t === '/help') return { kind: 'help' };
  // v0.10: `/tools` reprints the last completed turn's tool log; `on|off` switches
  // always-expanded mode (off = collapse to one summary line, the default).
  if (t === '/tools' || t.startsWith('/tools ')) {
    const op = t.slice(6).trim();
    if (!op) return { kind: 'tools', op: null };
    if (op === 'on' || op === 'off') return { kind: 'tools', op };
    return { kind: 'error', text: 'usage: /tools | /tools on | /tools off' };
  }
  if (t === '/c' || t.startsWith('/c ')) {
    const text = t.slice(2).trim();
    return text ? { kind: 'chat', text } : { kind: 'error', text: 'usage: /c <message>' };
  }
  // v0.12: the session transcript, on the host's say-so. Same ladder as /allow-cmd.
  if (t === '/export') return { kind: 'export' };
  if (t === '/allow-export' || t.startsWith('/allow-export ')) {
    return { kind: 'export-ok', op: 'allow', ...answerWords(t.slice(13)) };
  }
  if (t === '/deny-export' || t.startsWith('/deny-export ')) {
    return { kind: 'export-ok', op: 'deny', name: t.slice(12).trim() || null, always: false };
  }
  // v0.13: files. Everything after `/send ` is the path — paths have spaces far more often
  // than a caption is wanted, and `/paste <caption>` covers the captioned case.
  if (t === '/send' || t.startsWith('/send ')) {
    const p = t.slice(5).trim();
    return p ? { kind: 'send', path: p } : { kind: 'error', text: 'usage: /send <path>' };
  }
  if (t === '/paste' || t.startsWith('/paste ')) return { kind: 'paste', caption: t.slice(6).trim() };
  if (t === '/accept-file' || t.startsWith('/accept-file ')) {
    return { kind: 'file-ok', op: 'allow', ...answerWords(t.slice(12)) };
  }
  if (t === '/deny-file' || t.startsWith('/deny-file ')) {
    return { kind: 'file-ok', op: 'deny', name: t.slice(10).trim() || null, always: false };
  }
  if (t === '/get' || t.startsWith('/get ')) return { kind: 'get', name: t.slice(4).trim() || null };
  // v0.14: anything else that looks like a command belongs to claude, not to jam — the host
  // client types it into the real TUI, a guest's becomes a request the host approves.
  if (t.startsWith('/')) {
    const v = validSlashCommand(t);
    return v.ok ? { kind: 'slash', text: v.text } : { kind: 'error', text: v.error };
  }
  return { kind: 'say', text: t };
}

// `Dana K always` → {name:'Dana K', always:true}; `always` alone, or nothing at all, means the
// only request waiting. One parser for all three approval commands (`/allow-cmd`,
// `/allow-export`, `/accept-file`) so their syntax cannot drift apart.
function answerWords(rest) {
  const words = String(rest ?? '').trim().split(/\s+/).filter(Boolean);
  const always = words.at(-1)?.toLowerCase() === 'always';
  return { name: (always ? words.slice(0, -1) : words).join(' ') || null, always };
}

// ------------------------------------------- v0.14: claude slash commands ----

// jam's own commands: everything a client answers itself. Everything else is claude's.
// Kept as data so the client, the daemon and the docs cannot drift apart.
export const JAM_COMMANDS = ['/c', '/who', '/help', '/quit', '/exit', '/mirror', '/tools',
  '/join', '/accept', '/deny', '/token', '/allow-cmd', '/deny-cmd',
  // v0.12 export, v0.13 files.
  '/export', '/allow-export', '/deny-export', '/send', '/paste', '/get',
  '/accept-file', '/deny-file'];

// Session-lifecycle commands: they end or wipe the conversation for EVERYBODY, so they stay
// with the host. Hard list, enforced server-side — no guest request, no `/allow-cmd always`
// standing approval, ever. (`/exit` never reaches here from a client anyway: it means "leave
// my client".)
export const HOST_ONLY_COMMANDS = ['/exit', '/clear', '/resume'];

// `/model opus` → `/model`. Everything before the first space, lowercased: claude's own
// command names are lowercase, and the hard list must not be dodged with `/CLEAR`.
export function slashName(text) {
  return String(text ?? '').trim().split(/\s+/)[0].toLowerCase();
}

// A claude command on its way into the pane. Anything typed into the real TUI is a trust
// boundary, so this is narrow on purpose: one `/name` of letters/digits/`:._-` (MCP and
// plugin commands use `:` and `_`), optional single-line arguments, no control characters,
// no newline that would submit a second line, and a length a pane can actually show.
export const SLASH_RE = /^\/[A-Za-z][A-Za-z0-9_:.-]{0,39}(?: [^\n]{1,300})?$/;
export function validSlashCommand(text) {
  if (typeof text !== 'string') return { ok: false, error: 'command must be a string' };
  const t = stripControl(text).trim();
  if (!SLASH_RE.test(t)) {
    return { ok: false, error: `not a usable command: ${JSON.stringify(String(text).slice(0, 40))}` };
  }
  return { ok: true, text: t };
}

// What happens to a guest's `/command`. `refuse` = the hard host-only list, no approval path
// at all; `run` = this guest already has standing approval (`/allow-cmd always`) for this
// jam; `ask` = default, the host is asked once. Nothing is ever auto-approved.
export function guestSlashDecision(text, alwaysAllowed = false) {
  if (HOST_ONLY_COMMANDS.includes(slashName(text))) return 'refuse';
  return alwaysAllowed ? 'run' : 'ask';
}

// Which `claude` to spawn. PATH is not trustworthy: it can hold a wrapper shim from
// another terminal app, and a shell alias (e.g. `claude --dangerously-skip-permissions`)
// is invisible to a non-interactive spawn. `exists` is injected so this stays pure.
export function resolveClaude(env = {}, exists = () => false) {
  if (env.JAM_CLAUDE) return env.JAM_CLAUDE;
  const local = path.join(env.HOME || os.homedir(), '.local', 'bin', 'claude');
  return exists(local) ? local : 'claude';
}

// Which ttyd to run for the live view. Only the Homebrew path is probed — PATH can hold
// a shim, and `--view-ttyd <path>` covers every other install. null = no live view.
export const TTYD_DEFAULT = '/opt/homebrew/bin/ttyd';
export function resolveTtyd(override, exists = () => false) {
  if (override) return override;
  return exists(TTYD_DEFAULT) ? TTYD_DEFAULT : null;
}

// ------------------------------------------------- v0.4: in-TUI knock approval ----

// The tmux argv for one knock popup. `display-popup -E <cmd> <args…>` hands argv to the
// command verbatim (no shell — verified on tmux 3.7c), so a name with a space needs no
// quoting and a name could not smuggle a shell metacharacter even if NAME_RE allowed one.
// The hook secret rides in the popup's env instead of argv.
// `-c <client>` is not optional in practice (v0.9): a `-t <session>` target alone lets tmux
// pick any client showing that window — and a ttyd viewer sits on a GROUPED session showing
// the same window, so the popup was drawn on the guest's browser instead of the host's
// terminal (observed on tmux 3.7c). The caller passes a client attached to the base session.
// v0.14: the same popup answers both kinds of request — a knock (`kind:'knock'`) and a
// guest's claude command (`kind:'cmd'`, `detail` = the command). Both trail the original
// argv, so an old popup.mjs would still render a knock.
export const POPUP_W = 64;
export const POPUP_H = 7;
export function buildPopupArgs({ session, client, node, script, name, ip, ttlS, port, secret, kind = 'knock', detail = '' }) {
  return ['display-popup', '-t', session, ...(client ? ['-c', client] : []),
    '-w', String(POPUP_W), '-h', String(POPUP_H),
    '-e', `JAM_HOOK_SECRET=${secret}`, '-E',
    node, script, name, String(ip), String(ttlS), String(port), kind, String(detail)];
}

// What the popup says. One line, because a popup is seven rows and four of them are frame.
// v0.12/v0.13 added two more kinds of request to the same popup: the transcript and a file.
export function popupPrompt(kind, name, ip, detail) {
  if (kind === 'cmd') return `⌘ ${name} wants to run ${detail}`;
  if (kind === 'export') return `⇩ ${name} wants the session transcript`;
  if (kind === 'file') return `⇪ ${name} wants to send ${detail}`;
  return `⚑ ${name} wants to join${ip ? ` (${ip})` : ''}`;
}

// The jam session's status line while knocks are pending; null means "put the host's own
// value back".
export function statusRightWaiting(pendingCount) {
  return pendingCount > 0 ? `⚑ ${pendingCount} waiting` : null;
}

// What one keypress in the popup means. Only `a` and `d` answer; `i`, Esc, Ctrl-C, a stray
// arrow key — anything else leaves the knock pending for `/accept` in a client.
export function popupKey(ch) {
  const c = String(ch ?? '').toLowerCase();
  if (c === 'a') return { ok: true };
  if (c === 'd') return { ok: false };
  return null;
}

// ------------------------------------------------ v0.4b: profile (--config-dir) ----

// CLAUDE_CONFIG_DIR for the claude window: `~` expanded, made absolute, trailing slash
// dropped — a trailing slash changes the keychain hash and forces a fresh login.
export function normalizeConfigDir(dir, home = os.homedir()) {
  const d = String(dir ?? '').trim();
  if (!d) return null;
  const abs = d === '~' ? home : d.startsWith('~/') ? path.join(home, d.slice(2)) : d;
  return path.resolve(abs); // resolve also collapses '//' and drops the trailing slash
}

// `--config-dir` wins; otherwise inherit the profile the launcher itself was started with,
// so `CLAUDE_CONFIG_DIR=… jam host` keeps running against that account.
export function resolveConfigDir(flag, env = {}, home = os.homedir()) {
  const raw = flag || env.CLAUDE_CONFIG_DIR;
  return raw ? normalizeConfigDir(raw, home) : null;
}

// Where the transcript can be: always the default profile, plus the selected one when that
// is somewhere else. On the host's own machine the two are usually symlinked together, so
// the caller realpaths the hit and both globs settle on one identity.
export function jsonlGlobs(sessionId, home = os.homedir(), configDir = null) {
  const globs = [path.join(home, '.claude', 'projects', '*', `${sessionId}.jsonl`)];
  const extra = configDir ? path.join(configDir, 'projects', '*', `${sessionId}.jsonl`) : null;
  if (extra && extra !== globs[0]) globs.push(extra);
  return globs;
}

// ------------------------------------- v0.5: client rendering (pure layout bits) ----

// The label column. Every sender's `[Name]` is padded to one width so the glyph and the
// text line up whoever is talking; `Claude` is always in it because the agent has no
// roster entry. Recomputed on every roster change.
export function labelWidth(names = []) {
  return Math.max(...[...names, 'Claude'].map((n) => String(n).length + 2));
}

// Word-wrap to `width`. Explicit newlines stay newlines, leading spaces survive on the
// first line (indented code reads wrong without them), and a word longer than the line
// (a URL, a path) is cut at the margin instead of overflowing. No indent is added — the
// caller owns that, because the first line carries the label and the rest do not.
export function wrapText(text, width) {
  const w = Math.max(8, Math.floor(width) || 8);
  const out = [];
  for (const para of String(text).replace(/\t/g, '  ').split('\n')) {
    const words = para.split(' ').filter(Boolean);
    if (!words.length) { out.push(''); continue; }
    let line = /^ */.exec(para)[0];
    let empty = true;
    for (let word of words) {
      while (word.length > w) {
        if (!empty) { out.push(line); }
        out.push(word.slice(0, w));
        word = word.slice(w);
        line = ''; empty = true;
      }
      if (empty) { line += word; empty = false; }
      else if (line.length + 1 + word.length <= w) line += ` ${word}`;
      else { out.push(line); line = word; }
    }
    out.push(line);
  }
  return out;
}

// Markdown-lite for agent text: **bold** and `code`, markers dropped. Nothing else — full
// markdown in a 9-row pane is noise, and a half-parsed table is worse than none.
// ponytail: neither marker may straddle a newline (the ink client applies this per logical
// line and lets ink wrap after; client-basic.mjs applies it per already-wrapped line, so
// there a soft wrap breaks a span too). Wrap-aware styling means measuring visible width;
// not worth it for two markers.
export const MD = { boldOn: '\x1b[1m', boldOff: '\x1b[22m', codeOn: '\x1b[38;5;216m', codeOff: '\x1b[39m' };
export function mdLite(text) {
  return String(text)
    .replace(/\*\*([^*\n]+)\*\*/g, `${MD.boldOn}$1${MD.boldOff}`)
    .replace(/`([^`\n]+)`/g, `${MD.codeOn}$1${MD.codeOff}`);
}

// Tool results flood a turn (one grep over a repo is 40 of them). Show the first few, then
// a single '…' line, then nothing until the next turn. `n` = how many already went out.
export const TOOL_RESULT_CAP = 5;
export function toolResultAction(n) {
  return n < TOOL_RESULT_CAP ? 'show' : n === TOOL_RESULT_CAP ? 'ellipsis' : 'skip';
}

// Which tmux target is the claude TUI: the `claude` window, which holds exactly one pane —
// so a mirror frame and a ttyd viewer both show Claude Code and nothing else. Named, never
// indexed, so a host with `base-index 1` still hits it.
export function claudeTarget(session) {
  return `${session}:claude`;
}

// ------------------------------------- v0.5.1: rendering feedback round -----------

// Stable per-participant color: hash the name into a curated palette, not join order, so
// colors survive reconnects and roster churn. Self overrides to green and [Claude] stays
// orange in client.mjs — this pool never has to produce either. Blue/teal/cyan/purple/gold
// family, readable on a dark background; excludes claude-orange 208, chat-magenta 213,
// err-red 203, and the dim greys (240/245).
export const COLOR_PALETTE = [39, 44, 78, 81, 110, 141, 178, 183];
export function userColor(name) {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return COLOR_PALETTE[h % COLOR_PALETTE.length];
}

// Which message block an event opens or continues, for the blank-line-between-blocks rule.
// A human say and a /c chat always start a fresh block — even twice in a row from the same
// sender — so every one of them gets its own blank line. An agent event (tool / tool-result
// / text) continues the block only when the block already open is itself an agent turn,
// gluing a turn's tool calls, results and final text into one; interrupted by a say/chat it
// starts a new one. System/knock/error lines never call this, so they neither force a blank
// line of their own nor break an agent turn's gluing.
export function nextBlock(kind, current) {
  if (kind === 'agent' && current?.kind === 'agent') return current;
  return { kind, seq: (current?.seq ?? 0) + 1 };
}

// ------------------------------------------- v0.7: terminal mirror (screen frames) ----

// One captured row on its way to somebody else's terminal. SGR colors are the whole point
// of the mirror, so CSI sequences stay; what goes is everything that reaches outside the
// rendered cells — OSC (window title, clipboard writes), DCS/APC/PM/SOS strings, and the
// C0 controls that would move the guest's cursor out of the frame. A row that carries any
// escape gets a reset appended, or its color bleeds into the row below it.
export const FRAME_ROW_MAX = 2000;
export function sanitizeFrameRow(row) {
  const s = String(row)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, '') // OSC (title, clipboard)
    .replace(/\x1b[P^_X][^\x1b]*(?:\x1b\\)?/g, '') // DCS / PM / APC / SOS
    // C0 except ESC (0x1b) and TAB (0x09), DEL, and the 8-bit C1 range.
    .replace(/[\x00-\x08\x0a-\x1a\x1c-\x1f\x7f-\x9f]/g, '')
    .slice(0, FRAME_ROW_MAX);
  return s.includes('\x1b') ? `${s}\x1b[0m` : s;
}

// Bandwidth guard, all of it in one decision: nothing to send while the screen has not
// changed, and never more than one frame per `minGap` (4/s at the default 250 ms).
export const FRAME_MIN_GAP = 250;
export function framesEqual(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((r, i) => r === b[i]);
}
export function frameDecision({ rows, prev = null, now = 0, lastAt = 0, minGap = FRAME_MIN_GAP }) {
  if (!Array.isArray(rows) || !rows.length) return 'skip';
  if (framesEqual(prev, rows)) return 'skip';
  if (!lastAt) return 'send'; // nothing sent yet: a joiner gets the screen at once
  return now - lastAt < minGap ? 'wait' : 'send';
}

// Rows a client spends on its own chrome in the mirror view: the chat strip (3), the status
// row and the input row. Everything else is frame.
export const MIRROR_CHROME = 5;

// The claude window size that exactly fills a terminal of this size in the mirror view — so
// the host sees the whole TUI with nothing cropped. v0.14: the tmux session is detached, so
// its window size is ours to choose (the launcher sets it, the host client keeps it in step
// on resize). Floors keep a silly terminal from producing an unusable pane.
export function mirrorSize(cols, rows) {
  return {
    w: Math.max(40, Math.min(500, Math.floor(Number(cols) || 80))),
    h: Math.max(10, Math.min(300, Math.floor(Number(rows) || 24) - MIRROR_CHROME)),
  };
}

// What of a host frame fits this terminal. The newest content in a TUI is at the bottom, so
// a guest with fewer rows keeps the LAST ones; width is left to the renderer (it truncates
// ANSI-aware) and only reported here so the client can say the host is wider.
export function fitFrame(frame, cols, terminalRows) {
  const rows = frame?.rows || [];
  const keep = Math.max(4, (Number(terminalRows) || 24) - MIRROR_CHROME);
  return {
    rows: rows.length > keep ? rows.slice(-keep) : rows,
    croppedRows: Math.max(0, rows.length - keep),
    wider: (Number(frame?.w) || 0) > (Number(cols) || 80),
  };
}

// ------------------------------------------------------- v0.10: tool collapse ----

// `Bash: {"command":…}` → `Bash`. The daemon builds that string in parseJsonlLine, so the
// name is everything before the first colon.
export function toolName(text) {
  const m = /^([^:\s]{1,40}):/.exec(String(text ?? ''));
  return m ? m[1] : '?';
}

// One turn's worth of ⚙/⎿ lines → the collapsed summary, or null when the turn had at most
// one tool call and should stay inline exactly as it does today. Counts are in first-seen
// order, so the summary reads in the order the turn actually ran its tools.
export const LIVE_TOOL_ROWS = 4; // how many ⚙/⎿ lines the live region shows while busy
export function toolTurnSummary(tools = []) {
  const calls = tools.filter((t) => t?.kind === 'tool');
  if (calls.length <= 1) return null;
  const counts = new Map();
  for (const c of calls) {
    const n = toolName(c.text);
    counts.set(n, (counts.get(n) || 0) + 1);
  }
  return `${calls.length} tools (${[...counts].map(([n, c]) => `${n} ×${c}`).join(', ')})`;
}

// ------------------------------------------- v0.10b: newline keys in the input ----

// Key sequences the client handles itself, pulled out of the stdin byte stream before ink's
// input machinery can turn them into garbage in the text field. Shift+Enter arrives as
// CSI-u (kitty) or xterm's modifyOtherKeys form, Option/Alt+Enter as ESC CR; F2 has three
// spellings depending on terminfo.
export const KEY_SEQS = [
  ['\x1b[13;2u', 'newline'], // Shift+Enter, kitty / CSI-u
  ['\x1b[27;2;13~', 'newline'], // Shift+Enter, xterm modifyOtherKeys
  ['\x1b\r', 'newline'], // Option/Alt+Enter
  ['\x1b\n', 'newline'], // same, on terminals that send LF
  ['\x1bOQ', 'mirror'], // F2, application mode
  ['\x1b[12~', 'mirror'], // F2, vt220
  ['\x1b[[B', 'mirror'], // F2, linux console
  ...['\x1bOR', '\x1b[13~', '\x1b[[C'].map((s) => [s, 'passthrough']), // F3: SS3 / vt220 / linux
];

// v0.14: while passthrough is on, every byte belongs to the claude TUI — the only key the
// client still keeps for itself is the F3 that turns it back off.
export const PASSTHROUGH_SEQS = KEY_SEQS.filter(([, name]) => name === 'passthrough');

// One stdin chunk on its way to the real TUI, as tmux `send-keys` argument runs. ASCII (which
// is every escape sequence, arrow, Enter and Tab a terminal sends) goes as `-H <hex>`, the
// form tmux documents for an ASCII character; anything above 0x7f goes as one `-l` literal
// run, because `-H` is ASCII-only. Never a shell, never one string tmux could read as a flag
// (`-H` takes hex digits only, and a non-ASCII run cannot start with `-`). The cap is the
// trust boundary: a client cannot make the daemon type a novel into the pane in one frame.
export const KEY_CHUNK_MAX = 512;
export function sendKeyArgs(text) {
  const runs = [];
  for (const ch of [...String(text ?? '')].slice(0, KEY_CHUNK_MAX)) {
    const ascii = ch.codePointAt(0) < 0x80;
    const last = runs.at(-1);
    if (last && last.ascii === ascii) last.chars.push(ch);
    else runs.push({ ascii, chars: [ch] });
  }
  return runs.map(({ ascii, chars }) => (ascii
    ? ['-H', ...chars.map((c) => c.codePointAt(0).toString(16).padStart(2, '0'))]
    : ['-l', chars.join('')]));
}

// Split a stdin chunk into recognised keys and the text that goes on to ink. A tail that
// could still grow into one of the sequences is held back for the next chunk — except a
// lone ESC, which is passed straight through so pressing Escape is never swallowed.
// ponytail: that means a chunk split exactly after the ESC of a real sequence leaks its
// bytes as text. Terminals write a sequence in one go, so it stays theoretical.
export function extractKeys(chunk, seqs = KEY_SEQS) {
  let s = String(chunk ?? '');
  let text = '';
  const keys = [];
  scan: while (s) {
    for (const [seq, name] of seqs) {
      if (s.startsWith(seq)) { keys.push(name); s = s.slice(seq.length); continue scan; }
    }
    if (s.length > 1 && seqs.some(([seq]) => seq.startsWith(s))) return { keys, text, hold: s };
    text += s[0];
    s = s.slice(1);
  }
  return { keys, text, hold: '' };
}

// ------------------------------------------------- v0.10c: guest onboarding ----

// The block every client prints on connect and on `/help`. The host's copy is trimmed: the
// host's own commands are printed by the launcher and the daemon window anyway.
export const ONBOARD_W = 54;
export function onboardingLines(name = 'You', host = false) {
  const head = `── claude-jam ${'─'.repeat(Math.max(3, ONBOARD_W - 14))}`;
  // v0.14: the screen above is the real Claude Code TUI, so both blocks lead with the view
  // keys. The host's copy adds F3 — the one thing only the host can do.
  const rows = host
    ? [`plain line        → claude (attributed [${name}])`,
      '/c <text>         → humans only — claude never sees it',
      'F2                → transcript ⇄ live TUI (this screen)',
      'F3                → type INTO the TUI (permissions, /model)',
      '/model /compact…  → run any claude command in the TUI',
      '/send <path>      → offer a file to everyone · /export',
      '/help /who /join  → this block · participants · invite line']
    : [`plain line        → claude (attributed [${name}])`,
      '/c <text>         → humans only — claude never sees it',
      'F2                → transcript ⇄ live TUI (this screen)',
      '/who /quit        → participants / leave',
      '/send <path>      → give claude a file · /paste · /export',
      'Shift+Enter or \\  → multi-line message · /tools · /help',
      'Lost? just ask claude — e.g. "how does this jam work?",',
      '"how do I chat privately?" — it knows the full manual.'];
  return [head, ...rows, '─'.repeat(ONBOARD_W)];
}

// ------------------------------------------------- v0.11: cloudflared tunnel ----

// `cloudflared tunnel --url …` prints a boxed banner once the quick tunnel is live; only the
// hostname matters, so match just that instead of the box art around it.
export const TRYCLOUDFLARE_RE = /https:\/\/([a-z0-9][a-z0-9-]*\.trycloudflare\.com)\b/;
export function parseTunnelUrl(text) {
  const m = TRYCLOUDFLARE_RE.exec(String(text ?? ''));
  return m ? m[1] : null;
}

// Same shape as buildJoinLine/buildViewUrl, through the tunnel host instead of ip:port —
// wss:// and https://, no port (Cloudflare terminates TLS at the edge and proxies to :443).
// null until the tunnel has resolved a hostname, or (join only) while no token is set — same
// "nothing to hand out while knocking" rule as the LAN line.
export function buildTunnelJoinLine(host, token, clientCmd = 'node client.mjs') {
  return host && token ? `${clientCmd} wss://${host} --name <You> --token ${token}` : null;
}
export function buildTunnelViewUrl(host, key) {
  return host && key ? `https://jam:${key}@${host}` : null;
}

// Console lines for the tunnel, labelled distinctly from the LAN ones (`invite:`/`view:`) so
// a host copying from the log never sends a stranger the wrong URL by mistake.
export function tunnelJoinLines(tunnelJoin, tunnelView) {
  const lines = [];
  if (tunnelJoin) lines.push(`tunnel invite: ${tunnelJoin}`);
  if (tunnelView) lines.push(`tunnel view: ${tunnelView}`);
  return lines;
}

// Everything the host can hand out, in the order it is always shown: the tunnel lines first
// (they are what you send someone who is not on your tailnet), the LAN/Tailscale ones below.
// One helper for the daemon console, the host client's welcome, `/join` and every `/token`
// reply, so those four can never drift — the client used to drop the tunnel lines entirely.
export function inviteLines(info = {}) {
  return [...tunnelJoinLines(info.tunnelJoin, info.tunnelView), ...joinLines(info.join, info.view)];
}

// ------------------------------- v0.12 / v0.13: export and file transfers ----

// One frame carries 64 KB of bytes, base64'd so a PNG survives a JSON text frame. The ws
// server's maxPayload has to clear that plus the envelope: 64 KB → 87.4 KB of base64.
export const XFER_CHUNK = 64 * 1024;
export const XFER_FRAME_MAX = 128 * 1024;
// Caps, enforced on the daemon side (the client checks too, so a typo fails before the host
// is asked): a transcript or an offered file may be 50 MB, an upload from a guest 20 MB.
export const EXPORT_MAX = 50 * 1024 * 1024;
export const UPLOAD_MAX = 20 * 1024 * 1024;
// One transfer in flight per client per direction — a guest cannot start ten uploads at once.
export const XFER_IN_FLIGHT = 1;

// `2.1 MB`, `12 KB` — sizes in approval lines, where an exact byte count means nothing.
export function humanBytes(n) {
  const b = Math.max(0, Math.floor(Number(n) || 0));
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${Math.round(b / 1024)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

// A file name arriving over the wire is a trust boundary: it decides a path on disk. Refuse
// anything with a separator (that is a traversal attempt, not a file name — the sender is
// supposed to send a basename), refuse the dot entries, then reduce what is left to a boring
// charset. null = refuse the transfer, never "guess a name".
export const UPLOAD_NAME_MAX = 80;
export function safeBaseName(name) {
  if (typeof name !== 'string') return null; // a number in the name field is a broken client
  const raw = name.trim();
  if (!raw || raw.length > 255 || /[\\/]/.test(raw) || raw === '.' || raw === '..') return null;
  // Everything outside [A-Za-z0-9._-] becomes '_': no control bytes, no shell metacharacters,
  // no unicode lookalike for a separator. A leading dot goes too — no writing dotfiles.
  let s = raw.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '');
  if (!s) return null;
  if (s.length > UPLOAD_NAME_MAX) {
    const dot = s.lastIndexOf('.');
    const ext = dot > 0 && s.length - dot <= 8 ? s.slice(dot) : '';
    s = s.slice(0, UPLOAD_NAME_MAX - ext.length) + ext;
  }
  return s;
}

// A second photo.png never overwrites the first: photo-1.png, photo-2.png, … `exists` is
// injected so this stays pure. null = give up rather than loop forever.
export function uniqueName(name, exists = () => false, max = 99) {
  if (!exists(name)) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 1; i <= max; i++) if (!exists(`${stem}-${i}${ext}`)) return `${stem}-${i}${ext}`;
  return null;
}

// One transfer as the frames it goes out as. A generator, so a 50 MB export never exists twice
// in memory as base64. A zero-byte file is one `done` frame, not zero frames.
export function* xferFrames(xfer, data, chunk = XFER_CHUNK) {
  const buf = Buffer.from(data);
  for (let off = 0, seq = 0; off < buf.length || seq === 0; off += chunk, seq++) {
    yield {
      t: 'file', xfer, seq, done: off + chunk >= buf.length,
      b64: buf.subarray(off, off + chunk).toString('base64'),
    };
  }
}

// Feed frames out a few per tick: a 20 MB upload is 320 frames, and doing them all in one turn
// of the event loop stalls the sender (the daemon's HTTP endpoints, or the client's UI).
// `alive` stops a transfer whose peer went away mid-stream.
export function pumpFrames(frames, sendOne, alive = () => true, perTick = 8) {
  const tick = () => {
    for (let i = 0; i < perTick; i++) {
      if (!alive()) return;
      const { value, done } = frames.next();
      if (done) return;
      sendOne(value);
    }
    setImmediate(tick);
  };
  tick();
}

// Where claude keeps a session's transcript: the cwd with every non-alphanumeric character
// turned into '-'. Verified against a real ~/.claude/projects (a path with a dot in it lands
// as '--'). Printed for the guest, never used to write anything ourselves.
export function projectSlug(cwd) {
  return String(cwd ?? '').replace(/[^A-Za-z0-9]/g, '-');
}

export function exportFileName(sessionId) {
  return `jam-session-${sessionId}.jsonl`;
}

// What the guest is told after an export lands. `claude --resume` scans projects/*.jsonl, so
// copying the file into the folder for THEIR cwd is the whole trick.
export function resumeInstructions(sessionId, file, cwd) {
  const slug = projectSlug(cwd);
  return [
    `to continue this conversation yourself, from ${cwd}:`,
    `  mkdir -p ~/.claude/projects/${slug}`,
    `  cp ${file} ~/.claude/projects/${slug}/${sessionId}.jsonl`,
    `  claude --resume ${sessionId}`,
    'the folder name is that cwd with every non-alphanumeric character turned into "-" —',
    'a different cwd means a different folder (ls ~/.claude/projects to check).',
    'this transcript holds everything claude saw here: file contents it read, tool output,',
    'and whatever was in its context. The host should run /token new now.',
  ];
}

// Best-effort scrub of OUR OWN join-token block from an exported transcript. hooks.sh writes
// it as one line, so its first and last words identify it; the raw token is replaced too, in
// case the agent quoted it back somewhere in the conversation. Best-effort by design and
// documented as such: a transcript is everything claude saw, and only the join credential is
// worth trying to keep out of a copy that leaves the host.
export const TOKEN_BLOCK_RE = /Join token: [^"\n]{0,800}?tell them to ask the host\./g;
export function stripTokenBlock(text, token = null) {
  let out = String(text).replace(TOKEN_BLOCK_RE, '[jam join-token block removed on export]');
  if (typeof token === 'string' && token.length >= 8) out = out.split(token).join('[token removed]');
  return out;
}

export function buildSettings(hooksPath) {
  const cmd = (arg) => ({ hooks: [{ type: 'command', command: `${hooksPath} ${arg}` }] });
  return {
    hooks: {
      SessionStart: [cmd('session-start')],
      UserPromptSubmit: [cmd('prompt')],
      Stop: [cmd('stop')],
      Notification: [cmd('notification')],
    },
  };
}
