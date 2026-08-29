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

// The friend-facing invite command. Without a token the guest still needs the address — they
// knock and the host accepts — so only the `--token` part is conditional; returning null here
// left a knock-mode host with no URL to send at all. `clientCmd` is clientCommand()'s answer;
// the default keeps every caller that does not care (most tests) on the from-source form.
export function buildJoinLine(ip, port, token, clientCmd = 'node client.mjs') {
  if (!ip || !port) return null;
  const base = `${clientCmd} ws://${ip}:${port} --name <You>`;
  return token ? `${base} --token ${token}` : base;
}

// The read-only browser view of the real claude TUI (ttyd), basic auth baked into the URL
// so one paste is enough. null while there is no view (no ttyd, or --no-view).
export function buildViewUrl(ip, port, key) {
  return key ? `http://jam:${key}@${ip}:${port}` : null;
}

// Everything the host can hand out, same order and wording wherever it is shown: the
// daemon log, the host client's welcome, `/join` and every `/token` reply.
export function joinLines(join, view, token) {
  const lines = join ? [`invite: ${join}`] : [];
  // The address is useful with or without a token; the hint says which way the guest gets in.
  if (!token) lines.push(NO_TOKEN_HINT);
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
  // v0.17 F4: a tool result is file contents and command output — the same class of leak as a
  // tool call's own arguments, so it goes through the same best-effort mask.
  const one = maskSecrets(line);
  return one.length > TOOL_RESULT_MAX ? `${one.slice(0, TOOL_RESULT_MAX - 1)}…` : one;
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
        // v0.17 F1: an Edit/MultiEdit/Write call's own arguments ARE the diff, so render them as
        // one — everything else keeps the truncated-JSON summary. F4 masks either shape, because
        // this is the line that carries file contents to everybody else's terminal.
        // `file` (v0.17 F2) is what `/files` counts; only file-shaped tools have one.
        const name = b.name ?? '?';
        const args = JSON.stringify(b.input ?? {});
        const file = toolFile(name, b.input);
        out.push({
          kind: 'tool',
          ...(file ? { file } : {}),
          text: maskSecrets(toolDiffText(name, b.input) ?? `${name}: ${args.slice(0, 120)}`),
        });
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
    // v0.24: invite-only lives on `/token` because it is the same question — how people get in.
    // One command, one frame, one daemon handler, and the reply is the token frame either way.
    if (op === 'invite-only') {
      const on = rest.join(' ').trim().toLowerCase();
      if (on === 'on' || on === 'off') return { kind: 'token', op: 'invite-only', value: on };
      return { kind: 'error', text: 'usage: /token invite-only on | off' };
    }
    return { kind: 'error', text: 'usage: /token new | set <value> | off | invite-only on|off' };
  }
  // v0.24.1: go remote, or come back, while the jam runs. Same three words as
  // `claude-jam remote <off|tunnel|funnel>`, and the same daemon path.
  if (t === '/remote' || t.startsWith('/remote ')) {
    const mode = t.slice(7).trim().toLowerCase();
    if (!mode) return { kind: 'remote', mode: null };
    return REMOTE_MODES.includes(mode) ? { kind: 'remote', mode }
      : { kind: 'error', text: `usage: /remote ${REMOTE_MODES.join(' | ')}` };
  }
  // v0.24: the live control panel. Everything it does is one of the commands above.
  if (t === '/menu') return { kind: 'menu' };
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
  // v0.17 F2/F3: what the session has touched, and what git says about it. Both are answered by
  // the DAEMON (only it has the transcript and the cwd), so the client just forwards them.
  if (t === '/files') return { kind: 'files' };
  if (t === '/diff' || t.startsWith('/diff ')) {
    const v = validDiffPath(t.slice(5));
    return v.ok ? { kind: 'diff', path: v.path } : { kind: 'error', text: v.error };
  }
  // v0.17 P2 / v0.31: answering whatever claude is showing. Bare `/answer` describes the prompt
  // that is up; `/answer <n>` picks an option; `/answer <q> <n>` picks one on a multi-question
  // form; `/answer other <text>` is the host's free-text answer. A digit is the only thing ever
  // typed into a picker — `other` is the one exception, and it is host-only in the daemon.
  if (t === '/answer' || t.startsWith('/answer ')) {
    const v = parseAnswerCommand(t.slice(7));
    return v.ok ? { kind: 'perm', q: v.q ?? null, choice: v.choice ?? null, text: v.text ?? null }
      : { kind: 'error', text: v.error };
  }
  // v0.30: nothing typed is ever lost. `/outbox` lists what the daemon kept when it could not
  // confirm a message landed; `/retry` sends the newest one again.
  if (t === '/outbox') return { kind: 'outbox', op: 'list' };
  if (t === '/retry') return { kind: 'outbox', op: 'retry' };
  // v0.22B: invite links — mint one, list them, take one back. Host-only (the daemon enforces
  // it): a link is a credential, and minting one is admitting somebody in advance.
  if (t === '/invites') return { kind: 'invites' };
  if (t === '/invite' || t.startsWith('/invite ')) {
    const v = parseInviteCommand(t.slice(7));
    return v.ok ? { kind: 'invite', ...v } : { kind: 'error', text: v.error };
  }
  // v0.22C: remove somebody who is already in — the one thing /deny never could do.
  if (t === '/kick' || t.startsWith('/kick ')) {
    const v = parseKickCommand(t.slice(5));
    return v.ok ? { kind: 'kick', name: v.name, revoke: v.revoke } : { kind: 'error', text: v.error };
  }
  // v0.18-4: end the whole jam — the daemon, the TUI, the tmux session, everyone's client. The
  // one jam command that asks twice (see confirmYes), and host-only both here and in the daemon.
  if (t === '/end') return { kind: 'end' };
  if (t === '/allow-perm' || t.startsWith('/allow-perm ')) {
    return { kind: 'perm-ok', op: 'allow', ...answerWords(t.slice(11)) };
  }
  if (t === '/deny-perm' || t.startsWith('/deny-perm ')) {
    return { kind: 'perm-ok', op: 'deny', name: t.slice(10).trim() || null, always: false };
  }
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
  '/accept-file', '/deny-file',
  // v0.17 F2/F3: the paths this session touched, and git's own answer about them.
  '/files', '/diff',
  // v0.17 P2: the permission relay — a guest asks, the host allows or denies. v0.31: the same
  // command answers a QUESTION outright, because a question is a decision, not a grant.
  '/answer', '/allow-perm', '/deny-perm',
  // v0.30: what the daemon kept when it could not confirm a message landed, and sending it again.
  '/outbox', '/retry',
  // v0.18-4: the host ends the jam for everybody.
  '/end',
  // v0.22B/C: invite links, and removing somebody who is already in.
  '/invite', '/invites', '/kick',
  // v0.24: the live control panel, and the relay switch it drives (also `claude-jam remote`).
  '/menu', '/remote'];

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

// v0.17 P1: claude's own read-only commands. They open a panel and change nothing — no turn, no
// file, no session state — so a guest runs them without waking the host, which removes the single
// most common piece of friction in a jam (checking `/cost`). Three, and deliberately BARE: `/cost`
// is on the list, `/cost --anything` is not, because an argument is behaviour this list has never
// read. Adding to it is a security decision, not a convenience one — anything that can mutate the
// session, spend a turn or touch a file belongs on the ask path.
// Their output lands on the shared screen like any other command, so a guest can put the host's
// `/status` panel in front of everybody; that is the whole cost, and it is documented.
export const GUEST_SAFE_COMMANDS = ['/cost', '/status', '/context'];
export function isSafeGuestCommand(text) {
  const t = String(text ?? '').trim();
  return !/\s/.test(t) && GUEST_SAFE_COMMANDS.includes(t.toLowerCase());
}

// What happens to a guest's `/command`. `refuse` = the hard host-only list, no approval path
// at all; `run` = the read-only allowlist above, or this guest already has standing approval
// (`/allow-cmd always`) for this jam; `ask` = default, the host is asked once. The hard list is
// checked FIRST, so neither the allowlist nor `always` can ever widen into it.
export function guestSlashDecision(text, alwaysAllowed = false) {
  if (HOST_ONLY_COMMANDS.includes(slashName(text))) return 'refuse';
  if (isSafeGuestCommand(text)) return 'run';
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
  // v0.17 P2: the fourth kind. `detail` is already "answer 2: Yes, and don't ask again", built
  // from the options the daemon read off the real screen — never from anything the guest typed.
  if (kind === 'permission') return `⏎ ${name} wants to ${detail}`;
  return `⚑ ${name} wants to join${ip ? ` (${ip})` : ''}`;
}

// The jam session's status line while knocks are pending; null means "put the host's own
// value back".
export function statusRightWaiting(pendingCount) {
  return pendingCount > 0 ? `⚑ ${pendingCount} waiting` : null;
}

// ------------------------------- v0.20: jam's own tmux server, and symmetric F3 ----
// tmux key tables are SERVER-global, so binding F3 on the default server would change every
// other tmux session on the machine. jam therefore runs its own server on a socket of its own,
// which also makes v0.18's ownership rule structural: `list-sessions` on this socket can only
// ever answer with jam's sessions, because nothing else has a reason to be there.
export const TMUX_SOCKET_PREFIX = 'claude-jam-';
export const TMUX_DEFAULT_SOCKET = 'default'; // tmux's own name for the shared server
export function tmuxSocketFor(port, override = null) {
  const o = typeof override === 'string' ? override.trim() : '';
  // A socket name becomes a filename under tmux's own directory, so keep it to a boring charset
  // rather than letting a flag invent a path — and never a leading `-`, which tmux would read as
  // an option rather than a name.
  if (o && /^[A-Za-z0-9._][A-Za-z0-9._-]{0,63}$/.test(o)) return o;
  return `${TMUX_SOCKET_PREFIX}${Number(port) || 0}`;
}

// Every tmux invocation jam makes goes through this. `-L default` IS the shared server (verified
// on tmux 3.7c: the same `/tmp/tmux-<uid>/default` socket path), so the escape hatch needs no
// special case here — only the F3 binding is skipped, because that one would be global.
export function tmuxSocketArgs(socket) {
  return ['-L', String(socket || TMUX_DEFAULT_SOCKET)];
}

// The socket means `tmux attach` alone no longer finds the session, so every line that tells
// somebody how to attach has to carry it. On the default server it is left off: that is the
// line people already know.
export function tmuxAttachLine(socket, session = 'jam', target = null) {
  const s = String(socket || TMUX_DEFAULT_SOCKET);
  const t = target || session;
  return s === TMUX_DEFAULT_SOCKET ? `tmux attach -t ${t}` : `tmux -L ${s} attach -t ${t}`;
}

// v0.20-2: F3 attaches from the client, so F3 has to detach back — otherwise it reads as broken.
// `-T root` is what makes it a bare key rather than a prefixed one, and it is safe here only
// BECAUSE the server is jam's own.
export const F3_BIND_ARGS = ['bind-key', '-T', 'root', 'F3', 'detach-client'];

// v0.20-3: the way home, on the session's own status line. The `⚑ N waiting` badge still wins —
// a pending request is the more urgent thing to say — and `home:false` (an unbound F3, i.e.
// `--tmux-socket default`) goes back to leaving the status line alone.
export const STATUS_RIGHT_HOME = 'F3 or Ctrl-b d → back to jam';
export function statusRightText(pendingCount, { home = true } = {}) {
  return statusRightWaiting(pendingCount) || (home ? STATUS_RIGHT_HOME : null);
}

// What one keypress in the popup means. Only `a` and `d` answer; `i`, Esc, Ctrl-C, a stray
// arrow key — anything else leaves the knock pending for `/accept` in a client.
export function popupKey(ch) {
  const c = String(ch ?? '').toLowerCase();
  if (c === 'a') return { ok: true };
  if (c === 'd') return { ok: false };
  return null;
}

// ------------------------------------- v0.16: the in-client approval bar ----
// Since v0.14 the host's tmux session is detached, so `display-popup` usually has no client to
// draw on and a knock was only a line of text. The bar brings the one-keypress feel into the
// host's own client — same requests, same ladder, same wording as the popup.

// Which jam command one key stands for. The bar answers by running the command the host would
// have typed (see submit() in client-ink.mjs), so there is exactly ONE ladder path and no
// second mechanism to keep in step.
export const APPROVAL_COMMANDS = {
  knock: { allow: '/accept', deny: '/deny' },
  cmd: { allow: '/allow-cmd', deny: '/deny-cmd' },
  export: { allow: '/allow-export', deny: '/deny-export' },
  file: { allow: '/accept-file', deny: '/deny-file' },
  // v0.17 P2: the fourth ladder kind. One key on the bar allows the ONE digit that was asked
  // for, exactly as it allows one command or one file — `always` still needs the typed command.
  permission: { allow: '/allow-perm', deny: '/deny-perm' },
};

// `2:00`, `0:07`, `0:00` — a request's own expiry, counted down live in the bar.
export function countdownText(ms) {
  const s = Math.max(0, Math.ceil((Number(ms) || 0) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// Anything that would land in the input line if it were typed. Control bytes (Enter, Ctrl-C,
// the body of an arrow-key sequence) are not typing and leave the single keys armed.
const VISIBLE_RE = /[^\x00-\x1f\x7f]/;

// What one stdin chunk means while the bar is up. `armed` is single-key mode: it starts on,
// any visible character turns it off (so a message that begins with `d` can never deny
// somebody), and Esc turns it back on. Esc while armed dismisses the bar instead — the
// request stays pending and `/accept` still works. Returns the action plus whatever text
// still has to reach the input line.
export function barKeyAction(chunk, { armed = false, input = '' } = {}) {
  const s = String(chunk ?? '');
  if (s === '\x1b') return { act: armed ? 'ignore' : 'rearm', text: '' };
  // An escape sequence (an arrow, an F-key the client does not claim) is a keypress, not
  // typing: it reaches the input untouched and leaves the single keys armed.
  if (s.startsWith('\x1b')) return { act: null, text: s };
  if (armed && input === '' && [...s].length === 1 && VISIBLE_RE.test(s)) {
    const c = s.toLowerCase();
    if (c === 'a') return { act: 'accept', text: '' };
    if (c === 'd') return { act: 'deny', text: '' };
    if (c === 'i') return { act: 'ignore', text: '' };
  }
  return { act: VISIBLE_RE.test(s) ? 'disarm' : null, text: s };
}

// One pending request as the bar's single line, or null when nothing is waiting. `items` is
// the daemon's whole pending set, newest last; the bar shows the FIRST one and counts the
// rest. Wording comes from popupPrompt, so the bar and the tmux popup cannot drift apart.
export function approvalBar(items = [], now = 0, armed = true) {
  const first = Array.isArray(items) ? items[0] : null;
  if (!first) return null;
  const detail = first.kind === 'file' ? `${first.detail ?? ''} (${humanBytes(first.size)})` : first.detail ?? '';
  const more = Math.max(0, items.length - 1);
  const parts = [
    popupPrompt(first.kind, first.name, first.ip, detail),
    armed ? '[a]ccept  [d]eny  [i]gnore' : 'keys off while you type — Esc re-arms',
    countdownText((Number(first.expires) || 0) - now),
  ];
  if (more) parts.push(`+${more} more`);
  return { text: parts.join('  ·  '), kind: first.kind, name: first.name, armed, more };
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
// orange in client.mjs — this pool never has to produce either. Blue/teal/cyan/purple/gold/rose
// family, readable on a dark background; excludes claude-orange 208, chat-magenta 213,
// err-red 203, and the dim greys (240/245).
// v0.17 P7, the contrast/color-blind pass. Measured (WCAG relative luminance, sRGB): every entry
// clears 6.1:1 on #1e1e1e and 7.7:1 on pure black, so contrast was never the problem and nothing
// moved for it. ONE entry was genuinely weak: **78 `#5FD787` sat ΔE 11.2 (CIE76) from the self
// green 114 `#87D787`** — nearest normal-vision pair in the whole set by a factor of two, and the
// worst possible collision to have, because it makes somebody else's name look like your own.
// It is now 211 `#FF87AF` (rose), a family nothing else here uses: ΔE 36 from its nearest
// neighbour (err-red 203) and the best dichromat separation of any candidate that cleared the
// contrast floor. Everything else stayed: the remaining close pairs (39/141 and 81/183 collapse
// under deuteranopia) are inherent to holding eight fixed hues in a space a dichromat sees in two
// dimensions, and colour here is redundant by construction — the `[Name]` label is always printed
// next to it, so the colour is a hint, never the identity.
// The hash is untouched, so a name's colour is as stable as it ever was; only slot index 2 moved,
// i.e. names whose hash lands there are rose now instead of pale green. The list is deliberately
// NOT re-sorted back into numeric order — that would shift every index and re-colour everybody.
export const COLOR_PALETTE = [39, 44, 211, 81, 110, 141, 178, 183];
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
// v0.17 F4: and the deny-list mask, because a row of the host's screen is the one place a
// secret reaches every guest without anybody choosing to send it. maskSecrets bails on its own
// single hint scan when a row cannot contain any of the shapes, which is nearly every row —
// see the cost note there. Best effort only: a value split across SGR sequences will not match.
export const FRAME_ROW_MAX = 2000;
export function sanitizeFrameRow(row) {
  const s = maskSecrets(String(row)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, '') // OSC (title, clipboard)
    .replace(/\x1b[P^_X][^\x1b]*(?:\x1b\\)?/g, '') // DCS / PM / APC / SOS
    // C0 except ESC (0x1b) and TAB (0x09), DEL, and the 8-bit C1 range.
    .replace(/[\x00-\x08\x0a-\x1a\x1c-\x1f\x7f-\x9f]/g, ''))
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

// --------------------------------------- v0.15: adaptive frame cadence ----

// How often the daemon may look at the pane. Fast while somebody is actually watching AND
// something is happening (a turn running, somebody typing, the screen itself moving), the old
// 250 ms once it goes quiet, and null when nobody is watching at all — then the poll stops
// entirely and an idle jam costs no tmux calls. The fast gap IS the per-client rate cap: one
// frame per 40 ms is 25 frames/s, which is where the spec's cap comes from. Change detection
// (frameDecision) still decides whether a polled frame is worth any bytes.
export const FRAME_FAST_GAP = 40;
export const FRAME_RATE_CAP = Math.round(1000 / FRAME_FAST_GAP); // 25 frames/s/client
export const FRAME_ACTIVE_MS = 2000;
export function frameCadence({ viewers = 0, lastActivityAt = 0, now = 0, activeMs = FRAME_ACTIVE_MS } = {}) {
  if (!(Number(viewers) > 0)) return null;
  // A clock that went backwards counts as active: erring fast for one tick is cheaper than
  // freezing the mirror at 250 ms because Date.now() jumped.
  const since = now - lastActivityAt;
  return lastActivityAt > 0 && since < activeMs ? FRAME_FAST_GAP : FRAME_MIN_GAP;
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
  // v0.30-3: `↑`/`↓` recall what you submitted. Both spellings, because a terminal in application
  // cursor mode sends SS3 and one in normal mode sends CSI. ink's text field does nothing with a
  // vertical arrow, so nothing is taken away by claiming them — and in passthrough mode they are
  // not in PASSTHROUGH_SEQS, so they still go straight to claude's own TUI.
  ['\x1b[A', 'histprev'], ['\x1bOA', 'histprev'],
  ['\x1b[B', 'histnext'], ['\x1bOB', 'histnext'],
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
  // keys. The host's copy adds F3 — the one thing only the host can do — and, since v0.16,
  // the single keys that answer the approval bar.
  const rows = host
    ? [`plain line        → claude (attributed [${name}])`,
      '/c <text>         → humans only — claude never sees it',
      'F2                → transcript ⇄ live TUI (this screen)',
      'F3                → attach the real TUI (Ctrl-b d back)',
      // v0.31: `a`/`d` answer a REQUEST; `/answer <n>` answers claude itself.
      'a / d             → answer the ⚑ bar · /answer <n> answers ⚠',
      '/model /compact…  → run any claude command in the TUI',
      '/send <path>      → offer a file · /export /files /diff',
      // v0.30-3: recall, and the escape hatch for a message that did not land.
      '↑ / ↓             → recall what you sent · /retry · /outbox',
      '/help /who /join  → this block · participants · invite line']
    : [`plain line        → claude (attributed [${name}])`,
      '/c <text>         → humans only — claude never sees it',
      'F2                → transcript ⇄ live TUI (this screen)',
      '/who /files /diff → participants · files · git diff',
      '/send <path>      → give claude a file · /paste · /export',
      // v0.17 P2: a guest CAN answer a permission prompt now, so the block that teaches the
      // client has to say so. v0.31: and a QUESTION needs nobody's approval at all.
      '/answer <n>       → a question: straight through · a tool: host',
      '↑ / ↓             → recall what you sent · /retry · /outbox',
      'Shift+Enter or \\  → multi-line · /tools /help /quit',
      'Lost? just ask claude — it knows this jam\'s whole manual.'];
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
  if (!host) return null;
  const base = `${clientCmd} wss://${host} --name <You>`;
  return token ? `${base} --token ${token}` : base;
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
  return [...tunnelJoinLines(info.tunnelJoin, info.tunnelView),
    ...joinLines(info.join, info.view, info.token)];
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

// ------------------------------- v0.17 T1: relay respawn backoff ----
// A relay child (cloudflared, or `tailscale funnel` in the foreground) that dies takes the
// public URL with it, and v0.11-v0.16 left it dead — documented as a ceiling, and per
// RESEARCH.md §1 the single biggest lever on the "survive two hours" goal, because the
// confirmed failure mode is our own process exiting with nothing bringing it back.
// 1s doubling to a 30s ceiling, unlimited attempts. `attempt` is 1-based (the first respawn
// after a death is attempt 1) and the caller resets it the moment a URL resolves again, so a
// relay that ran for an hour before dying waits 1s, not 30.
export const RESPAWN_MIN_MS = 1000;
export const RESPAWN_MAX_MS = 30000;
export function respawnDelay(attempt, min = RESPAWN_MIN_MS, max = RESPAWN_MAX_MS) {
  const n = Math.floor(Number(attempt));
  if (!Number.isFinite(n) || n < 1) return min;
  // 2**n overflows to Infinity long before it matters; Math.min still picks max.
  return Math.min(min * 2 ** (n - 1), max);
}

// ------------------------------- v0.17 T2: heartbeat liveness ----
// The `ws` README's own "how to detect and close broken connections" pattern, as a decision
// instead of a loop body: every tick, a socket that answered the previous tick's ping is
// pinged again, and one that did not is terminated. 30s is comfortably under Cloudflare's
// documented 100s WebSocket idle cap (RESEARCH.md §1) — which matters precisely because the
// mirror's own change-detection guard can legitimately send zero bytes for minutes.
// `peers` is any iterable of [key, {alive}] — sockets, admitted or still knocking.
export const HEARTBEAT_MS = 30000;
export function heartbeatSweep(peers = []) {
  const ping = [];
  const terminate = [];
  // Strictly true, not merely truthy: a socket whose liveness we cannot vouch for must be
  // terminable, or a garbage record would make a dead peer immortal in the roster.
  for (const [key, rec] of peers) (rec?.alive === true ? ping : terminate).push(key);
  return { ping, terminate };
}

// ------------------------------- v0.17 T3: reconnect UX tiering ----
// The first few failures are a blip and say so in one short line. Once RECONNECT_TIER of them
// have failed in a row (~31s of 1-2-4-8-16 backoff) the real hypothesis is that the host's
// relay handed out a new URL — a cloudflared quick tunnel gets a fresh random hostname every
// respawn — so name it and say how to get the new one instead of repeating "retrying" forever.
export const RECONNECT_TIER = 5;
export function reconnectMessage(attempts, nextMs, tier = RECONNECT_TIER) {
  const inS = `${Number(nextMs) / 1000}s`;
  if (!(Number(attempts) >= tier)) return `disconnected, retrying in ${inS}`;
  return `still retrying (${attempts} failed) in ${inS} — if the host's tunnel restarted the `
    + 'join URL changed: ask them to run /join and send the new line';
}

// ------------------------------- v0.17 T4: Tailscale Funnel ----
// Why a second relay at all: a cloudflared quick tunnel's hostname is random and dies with the
// process, so T1's respawn hands every guest a NEW URL. Funnel's public hostname is the node's
// own MagicDNS name, so it is the same across a respawn, a daemon restart and a reboot — and
// the guest still installs nothing (Funnel terminates TLS at Tailscale's edge for the public
// internet, unlike jam's base LAN mode which needs the guest on the tailnet).
// Funnel only opens three public ports (443, 8443, 10000). 443 for the client, so the join
// line carries no port at all like the cloudflared one; 8443 for the browser view. Two ports
// rather than one port plus --set-path: a path mount would also have to agree with the daemon's
// own /health, /admit and /hook routes, and two funnel targets need no such agreement.
export const FUNNEL_PORTS = { ws: 443, view: 8443 };

// macOS ships the CLI inside the app bundle and puts nothing on PATH, so a bare `tailscale`
// spawn fails on the very machine most likely to have Tailscale running. Same override shape
// as resolveTtyd: the flag wins, then the env var, then the known locations, then PATH.
export const TAILSCALE_PATHS = ['/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  '/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale', '/usr/bin/tailscale'];
export function resolveTailscale(override, env = {}, exists = () => false) {
  if (override) return override;
  if (env.JAM_TAILSCALE) return env.JAM_TAILSCALE;
  return TAILSCALE_PATHS.find(exists) || 'tailscale';
}

// A MagicDNS name (`tailscale status --json` gives it with a trailing dot) plus the public
// funnel port becomes the host half of every URL. 443 is implicit in https/wss, so it is left
// off — which is what makes the funnel join line the same shape as the cloudflared one and lets
// buildTunnelJoinLine/buildTunnelViewUrl serve both relays unchanged.
export function funnelHost(dnsName, port = FUNNEL_PORTS.ws) {
  const host = String(dnsName ?? '').trim().replace(/\.$/, '');
  if (!host) return null;
  return Number(port) === 443 ? host : `${host}:${Number(port)}`;
}

// `tailscale funnel --https=<p> <target>` in the FOREGROUND prints an "Available on the
// internet" banner and holds the funnel open until it exits — the same tracked-pid lifecycle
// cloudflared already has. Only the hostname (with its port, when there is one) matters, so
// match just that, exactly like parseTunnelUrl does for the cloudflared banner.
export const FUNNEL_URL_RE = /https:\/\/([a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)*\.ts\.net(?::\d{1,5})?)/i;
export function parseFunnelUrl(text) {
  const m = FUNNEL_URL_RE.exec(String(text ?? ''));
  return m ? m[1].toLowerCase() : null;
}

// Startup gate, from `tailscale status --json`. Three failures are worth telling apart because
// the fix differs every time: the CLI is not there, the node is not up, or Funnel is not
// enabled for the tailnet (a node attribute an admin grants — the CLI itself will not do it).
// Pure: the caller does the spawn and hands the raw stdout in.
export const FUNNEL_CAP = 'https://tailscale.com/cap/funnel';
export function funnelPrecheck(statusJson) {
  let s;
  try { s = JSON.parse(String(statusJson)); } catch {
    return { ok: false, error: 'tailscale status --json said nothing I could parse — is the Tailscale app running?' };
  }
  if (s?.BackendState && s.BackendState !== 'Running') {
    return { ok: false, error: `tailscale is ${s.BackendState}, not Running — connect it first, then retry --funnel` };
  }
  const dns = funnelHost(s?.Self?.DNSName, 443);
  if (!dns) return { ok: false, error: 'tailscale status --json has no MagicDNS name for this node — enable MagicDNS for the tailnet' };
  if (!(FUNNEL_CAP in (s?.Self?.CapMap || {}))) {
    return {
      ok: false, dns,
      error: `Funnel is not enabled for this tailnet (${dns} has no ${FUNNEL_CAP} node attribute).\n`
        + '  Enable it once, as a tailnet admin: https://login.tailscale.com/admin/acls — add\n'
        + '    "nodeAttrs": [{"target": ["autogroup:member"], "attr": ["funnel"]}]\n'
        + '  then re-run with --funnel. Use --tunnel (cloudflared) meanwhile.',
    };
  }
  return { ok: true, dns };
}

// ------------------------------- v0.17 F4: best-effort secret masking ----
// A short deny-list of shapes that are secrets whatever file they came out of, applied to the
// two places a guest sees content nobody typed at them: a tool call's rendering (F1 makes that
// much more revealing) and a mirror row (sanitizeFrameRow). NOT a secret scanner, and said so
// in the README: it knows five shapes, it cannot see a value split across SGR sequences, and a
// format it has never heard of goes straight through. The honest framing is stripTokenBlock's.
//
// Cost matters here: the mirror sanitizes every row of every frame at up to 25 frames/s, so the
// rules are compiled once at module load and gated behind ONE hint scan — a row with no
// `AKIA`, no `TOKEN`, no `sk-` (i.e. essentially every row of a TUI) costs a single regex test
// instead of seven. Measured on a real 40-row frame: see SPEC's v0.17 note.
export const SECRET_MASK = '[masked]';
const SECRET_HINT = /AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|PRIVATE[ _]KEY|sk-|pk-|rk-|gh[pousr]_|earer|SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|ACCESS_KEY|CREDENTIAL/;
const SECRET_RULES = [
  // AWS key ids: a documented prefix plus 16 upper-case/digit characters.
  [/\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA)[0-9A-Z]{16}\b/g, SECRET_MASK],
  // A whole PEM private-key block first, then a bare BEGIN line on its own — one mirror row is
  // all the context a frame ever gives us, so the header alone still has to be caught.
  // A CERTIFICATE block is deliberately NOT matched: a public certificate is not a secret.
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, SECRET_MASK],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/g, SECRET_MASK],
  // sk-/pk-/rk- API keys (OpenAI, Stripe, …) and GitHub's ghp_/gho_/ghs_/ghu_/ghr_ tokens.
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, SECRET_MASK],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}/g, SECRET_MASK],
  // A bearer credential in a header or a curl line; the word itself stays, so the line still reads.
  [/\b([Bb]earer\s+)[A-Za-z0-9._~+/-]{16,}={0,2}/g, `$1${SECRET_MASK}`],
  // .env-style KEY=value where the KEY says it is a secret. UPPER CASE only, on purpose: that is
  // the .env convention, and it keeps prose ("check the token"), jam's own `--token abc` and
  // every lower-case identifier out of the deny-list. The key is kept, only the value goes.
  [/\b([A-Z][A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIALS?)[A-Z0-9_]*)(\s*[:=]\s*)(?:"[^"\n]{4,}"|'[^'\n]{4,}'|[^\s"'#,;)]{4,})/g, `$1$2${SECRET_MASK}`],
];

export function maskSecrets(text) {
  const s = String(text ?? '');
  if (!SECRET_HINT.test(s)) return s; // the hot path: one scan, no allocation
  let out = s;
  for (const [re, to] of SECRET_RULES) out = out.replace(re, to);
  return out;
}

// ------------------------------- v0.17 F1: Edit/Write calls render as a real diff ----
// No diff library, and none needed: `old_string`/`new_string` in the tool arguments already ARE
// the diff Claude is about to apply. Before this, every tool_use rendered as
// `Edit: {"file_path":"/very/long/…` truncated at 120 characters, which is the least useful 120
// characters of an edit. Capped the way tool results are capped (a per-line cap plus a line
// budget), and it stays inside the /tools collapse machinery, so a turn full of edits still
// folds into one `⚙ N tools (Edit ×3)` line instead of flooding anybody's transcript.
export const DIFF_TOOLS = new Set(['Edit', 'MultiEdit', 'Write']);
export const FILE_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'Read']);
export const TOOL_DIFF_LINES = 20;
export const TOOL_DIFF_LINE_MAX = TOOL_RESULT_MAX; // same 100 chars a tool result gets

// Which path a tool call touched, for `/files`. Only the tools that name one file they read or
// wrote: Grep/Glob's `path` is a directory to search, which is not "a file this session touched".
export function toolFile(name, input) {
  if (!FILE_TOOLS.has(name)) return null;
  const v = input?.file_path;
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

const diffBody = (oldS, newS) => [
  ...(typeof oldS === 'string' && oldS !== '' ? String(oldS).split('\n').map((l) => `- ${l}`) : []),
  ...(typeof newS === 'string' && newS !== '' ? String(newS).split('\n').map((l) => `+ ${l}`) : []),
];

// null = there was nothing diff-shaped in there, so the caller keeps the JSON summary.
export function toolDiffText(name, input, maxLines = TOOL_DIFF_LINES) {
  if (!DIFF_TOOLS.has(name)) return null;
  const file = typeof input?.file_path === 'string' && input.file_path.trim() ? input.file_path.trim() : null;
  const edits = name === 'MultiEdit' && Array.isArray(input?.edits) ? input.edits : null;
  const body = name === 'Write' ? diffBody(null, input?.content)
    : edits ? edits.flatMap((e) => diffBody(e?.old_string, e?.new_string))
      : diffBody(input?.old_string, input?.new_string);
  if (!file && !body.length) return null;
  const head = `${name}: ${file ?? '?'}${edits ? ` (${edits.length} edit${edits.length === 1 ? '' : 's'})` : ''}`;
  const kept = body.slice(0, maxLines)
    .map((l) => (l.length > TOOL_DIFF_LINE_MAX ? `${l.slice(0, TOOL_DIFF_LINE_MAX - 1)}…` : l));
  const more = body.length - kept.length;
  return [head, ...kept, ...(more > 0 ? [`… ${more} more diff line(s)`] : [])].join('\n');
}

// The live region under the mirror is LIVE_TOOL_ROWS *rows*, not four tool calls — a 20-line
// diff in there would shove the status and input rows off the screen. One line each while the
// turn runs; the whole diff is in the transcript (and in `/tools`).
export function toolLiveLine(text) {
  const lines = String(text ?? '').split('\n');
  return lines.length > 1 ? `${lines[0]}  (+${lines.length - 1} diff line(s))` : lines[0];
}

// ------------------------------- v0.17 F2: the files this session touched ----
// Last touch wins the ordering, so `/files` reads newest first: delete before set, because a
// Map keeps insertion order and re-setting an existing key does NOT move it.
export function noteFilePath(map, file) {
  if (!file) return map;
  const n = (map.get(file) || 0) + 1;
  map.delete(file);
  map.set(file, n);
  return map;
}

export function filesNewestFirst(map) {
  return [...(map || [])].map(([path, n]) => ({ path, n })).reverse();
}

export const FILES_MAX = 25;
export function filesReport(files = [], cwd = '') {
  if (!files.length) return 'no files yet — nothing has read, written or edited one in this session';
  // A path under the project reads better relative to it; anything else stays absolute.
  const short = (p) => (cwd && String(p).startsWith(`${cwd}/`) ? String(p).slice(String(cwd).length + 1) : String(p));
  const rows = files.slice(0, FILES_MAX).map(({ path: p, n }) => `  ×${n}  ${short(p)}`);
  const more = files.length - rows.length;
  return [`${files.length} file(s) touched this session, newest first:`, ...rows,
    ...(more > 0 ? [`  … ${more} more`] : [])].join('\n');
}

// ------------------------------- v0.17 F3: /diff [path] ----
// Ground truth from git, independent of whether the JSONL parsing above saw every change — a
// `sed -i` from a Bash call touched files no Edit tool ever mentioned. argv only, never a shell
// and never an interpolated string: a pathspec goes after `--`, and a leading `-` is refused
// outright so a "path" can never become a git option.
export const DIFF_PATH_MAX = 300;
export function validDiffPath(p) {
  if (p == null || p === '') return { ok: true, path: null };
  if (typeof p !== 'string') return { ok: false, error: 'usage: /diff [path]' };
  const t = p.trim();
  if (!t) return { ok: true, path: null };
  if (t.length > DIFF_PATH_MAX) return { ok: false, error: `a path over ${DIFF_PATH_MAX} characters is not a path` };
  if (/[\x00-\x1f\x7f]/.test(t)) return { ok: false, error: 'a path with control characters in it is not a path' };
  if (t.startsWith('-')) return { ok: false, error: 'a /diff path may not start with "-" — that would be a git option' };
  if (t.split('/').includes('..')) return { ok: false, error: 'no ".." in a /diff path — it stays inside the project' };
  return { ok: true, path: t };
}

export function gitDiffArgs(cwd, p = null) {
  const at = ['-C', String(cwd)];
  // Default is the summary: file names plus insertion/deletion counts, which is the answer to
  // "what changed" in one screen. A named path gets the real hunks.
  return p ? [...at, 'diff', '--', p] : [...at, 'diff', '--stat'];
}

export const OUT_MAX_LINES = 120;
export const OUT_MAX_CHARS = 8000;
export function capOutput(text, maxLines = OUT_MAX_LINES, maxChars = OUT_MAX_CHARS) {
  const all = String(text ?? '').split('\n');
  const kept = all.slice(0, Math.max(1, maxLines));
  let out = kept.join('\n');
  let note = all.length > kept.length ? `… ${all.length - kept.length} more line(s) — ask the host for the rest` : '';
  if (out.length > maxChars) {
    out = out.slice(0, maxChars);
    note = `… truncated at ${maxChars} characters — ask the host for the rest`;
  }
  return note ? `${out}\n${note}` : out;
}

// ------------------------------- v0.17 H1: history backfilled from the JSONL ----
// Until now `history` started EMPTY on every daemon boot and was fed only by live broadcasts —
// so on `--resume`, where the daemon deliberately starts reading at EOF so old turns are not
// re-broadcast, a guest joining a two-hour-old conversation got a blank room. This parses the
// transcript that is already on disk into the same event shapes broadcast() produces, and the
// daemon pushes them straight into the ring buffer BEFORE the WS server accepts anybody:
// no busy/waiting toggle, no tool-collapse counter, no injection, nothing that would fire a
// side effect at a live participant who is not there yet.
// The event shapes are onTranscript's, deliberately duplicated — the live path owns turn and
// status side effects this one must not have, and a test pins the two together.
export const REPLAY_DEFAULT = 300;
export const REPLAY_MAX = 5000;

export function backfillHistory(text, { hostName = 'Host', cap = REPLAY_DEFAULT } = {}) {
  const events = [];
  const files = new Map();
  let results = 0; // the same per-turn `⎿` budget the live path applies (toolResultAction)
  for (const line of String(text ?? '').split('\n')) {
    for (const e of parseJsonlLine(line)) {
      noteFilePath(files, e.file);
      const text_ = stripControl(e.text);
      if (e.kind === 'user') {
        results = 0; // a human turn starts a turn, exactly as startTurn() does live
        // A bridged line was injected as `[Dana]: hello`, and the live broadcast of it carried
        // the name in `from` with the prefix stripped — so the replay has to look the same.
        events.push(e.bridged
          ? { t: 'say', from: e.from, text: text_.replace(PREFIX_RE, '') }
          : { t: 'say', from: hostName, text: text_ });
      } else if (e.kind === 'text') events.push({ t: 'agent', kind: 'text', text: text_ });
      else if (e.kind === 'tool') events.push({ t: 'agent', kind: 'tool', text: text_ });
      else if (e.kind === 'tool-result') {
        const act = toolResultAction(results++);
        if (act !== 'skip') events.push({ t: 'agent', kind: 'tool-result', text: act === 'show' ? text_ : '…' });
      }
    }
  }
  // A cap of 0 is "the flag turned it off"; anything that is not a usable number at all (null,
  // NaN, a string, a negative) is a caller bug and falls back to the default rather than to 0 —
  // silently replaying nothing would look exactly like the blank room H1 exists to fix.
  const n = cap == null ? NaN : Math.floor(Number(cap));
  const keep = Number.isFinite(n) && n >= 0 ? n : REPLAY_DEFAULT;
  return { events: events.slice(events.length - Math.min(keep, events.length)), files, total: events.length };
}

// ------------------------------- v0.17 H2: where the replay ends ----
// One line, so a joiner can tell backlog from what just happened. null when there was no
// backlog at all — a divider over an empty replay would be a lie.
export function historyDivider(count = 0, width = ONBOARD_W) {
  const n = Math.floor(Number(count));
  if (!(n > 0)) return null;
  const label = ` history above (${n} replayed) · live from here `;
  const pad = Math.max(2, Math.floor((width - label.length) / 2));
  return `${'─'.repeat(pad)}${label}${'─'.repeat(pad)}`;
}

// ------------------------------- v0.17 P2: the permission prompt, read off the screen ----
// The ceiling this lifts: "guests cannot answer permission prompts". The tempting fix — give a
// guest F3's raw key passthrough — is a real security regression (arbitrary bytes into the host's
// TUI from off-box), so it is an anti-feature. What IS safe is much narrower: the only structured
// thing about a Claude Code permission prompt, seen from outside, is that its choices are
// NUMBERED. So the daemon reads those numbers off a `capture-pane`, shows them to the guest who
// asked, and — once the host approves that exact choice — types ONE validated digit. Never raw
// bytes, never a digit that is not on the screen, never without `status.waiting` and an approval.
//
// Everything here is the parsing half; the ladder, the re-validation and the typing live in
// host.mjs. Returning [] is the refusal: a screen this cannot read cleanly is a screen nothing
// gets typed into.
export const PERM_OPTIONS_MAX = 9; // one digit, because one digit is all that is ever typed
export const PERM_TEXT_MAX = 80;
export const PERM_ROW_GAP = 3; // rows an option may sit below the previous one (its text wraps)
export const PERM_QUESTION_ROWS = 4; // how far above option 1 the question line may sit
// A prompt may be drawn inside a box, so frame characters come with the capture. (Claude Code
// 2.1.251 uses horizontal rules instead — measured — but earlier and later versions box it.)
const PERM_BOX_RE = /^[\s│┃|╎┆┊╭╰]+|[\s│┃|╎┆┊╮╯]+$/g;
// `❯ 1. Yes` / `2) No, and tell Claude…` — an optional cursor marker, the number, `.` or `)`,
// then text. A row with a number and nothing after it is not an option.
const PERM_OPTION_RE = /^(?:([❯▶>*])\s*)?([1-9])[.)]\s+(\S.*)$/;
// Two structural signals tell claude's option picker apart from a numbered list that merely
// happens to be on the screen (a plan, a file being read, `git log --oneline`): the picker always
// marks its highlighted row, and a question line always sits right above the first option.
// Verified against the real thing (2.1.251): ` Do you want to proceed?` then ` ❯ 1. Yes`.
const PERM_QUESTION_RE = /do you want|proceed\?|permission|do you approve/i;
// `10.` next to the block means the prompt has more options than one digit can pick, so it is not
// a prompt this can drive at all — and saying so is better than silently offering the first nine.
const PERM_MULTI_RE = /^(?:[❯▶>*]\s*)?\d\d+[.)]\s/;

export function parsePermOptions(screen) {
  const hits = [];
  const multi = [];
  const lines = String(screen ?? '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const row = lines[i].replace(PERM_BOX_RE, '');
    const m = PERM_OPTION_RE.exec(row);
    if (m) hits.push({ i, n: Number(m[2]), marked: !!m[1], text: m[3].trim().slice(0, PERM_TEXT_MAX) });
    else if (PERM_MULTI_RE.test(row)) multi.push(i);
  }
  // The options are the BOTTOM-most numbered block on the screen, counting up from the last
  // numbered row to `1.` with no number missing and no big gap between rows. Strict on purpose:
  // a numbered list further up (a file being read, a plan, `git log --oneline`) must never be
  // mistaken for a set of options, and anything we cannot read this cleanly is a refusal — the
  // host still has F3.
  const run = [];
  for (let k = hits.length - 1; k >= 0; k--) {
    const h = hits[k];
    const below = run[0];
    if (!below) {
      if (h.n < 2) break; // the last row must be the LAST option, so a lone `1.` is not a prompt
      run.unshift(h);
      continue;
    }
    if (h.n !== below.n - 1 || below.i - h.i > PERM_ROW_GAP) break;
    run.unshift(h);
    if (h.n === 1) break;
  }
  if (run.length < 2 || run.length > PERM_OPTIONS_MAX || run[0].n !== 1) return [];
  // Either signal is enough; with neither, we do not know what we are looking at — and a digit
  // typed into something that is not a picker lands in claude's input box as text.
  const question = lines.slice(Math.max(0, run[0].i - PERM_QUESTION_ROWS), run[0].i)
    .some((l) => PERM_QUESTION_RE.test(l));
  if (!question && !run.some((o) => o.marked)) return [];
  if (multi.some((i) => i >= run[0].i - PERM_ROW_GAP && i <= run.at(-1).i + PERM_ROW_GAP)) return [];
  return run.map(({ n, text, marked }) => ({ n, text, marked }));
}

// What the guest who asked is shown. Read-only: it describes a screen they are already watching
// in the mirror, so it costs no approval — the approval is on TYPING, which is the part that acts.
export function permOptionsReport(options = []) {
  if (!options.length) return 'no numbered options are on claude\'s screen right now';
  return ['claude is waiting for an answer — the options on its screen:',
    ...options.map((o) => `  ${o.marked ? '❯' : ' '} ${o.n}. ${o.text}`),
    'pick one with /answer <number> — the host has to approve it before anything is typed'].join('\n');
}

// The trust boundary, both ways: a choice that is not a single digit is unparseable, and a digit
// that is not on the screen right now is out of range. Both refuse; neither guesses.
export function validPermChoice(choice, options = []) {
  const raw = String(choice ?? '').trim();
  const range = options.length ? `1-${options.length}` : 'a number';
  if (!/^[1-9]$/.test(raw)) {
    return { ok: false, error: `${JSON.stringify(raw.slice(0, 12))} is not one of the numbered options — /answer ${range}` };
  }
  const n = Number(raw);
  const hit = options.find((o) => o.n === n);
  if (!hit) {
    return { ok: false, error: options.length
      ? `there is no option ${n} on claude's screen — it is showing ${options.length} (${range})`
      : `there is nothing numbered on claude's screen, so ${n} would answer nothing` };
  }
  return { ok: true, n, text: hit.text };
}

// ------------------------------- v0.17 P3: the bell ----
// The most actionable moment in a jam — "claude wants a permission answer", or somebody saying
// your name — is silent for anyone not looking at the window. `\x07` is the whole dependency:
// every terminal turns it into whatever the user already configured (a dock bounce, a flash, an
// OS notification), which is strictly better than jam inventing a policy.
export const BELL = '\x07';
export const BELL_MIN_GAP = 3000;

// A burst of mentions is one bell, not five. A clock that went backwards rings rather than
// staying silent until it catches up.
export function bellAllowed(lastAt, now, gap = BELL_MIN_GAP) {
  const since = Number(now) - Number(lastAt);
  return !(Number(lastAt) > 0) || !(since >= 0) || since >= gap;
}

// Is this text talking to me? Whole-word, case-insensitive, `@Name` included — so "Dana" and
// "@dana," hit while "Danae" and "bandana" do not. The name comes from the roster (NAME_RE), but
// it is escaped anyway: a name is data, and this builds a regex out of it.
export function mentionsMe(text, name) {
  const n = String(name ?? '').trim();
  const t = String(text ?? '');
  if (!n || !t) return false;
  const esc = n.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
  return new RegExp(`(?:^|[^A-Za-z0-9_])@?${esc}(?![A-Za-z0-9_])`, 'i').test(t);
}

// ------------------------------- v0.17 P5: connection quality ----
// T2's heartbeat already round-trips every 30 s; the daemon times the pong and tells that one
// client its own number. This is the whole indicator: one dim figure, no graph, no history.
// Stale is expressed in heartbeats, not seconds, so `--heartbeat` in a test does not make every
// client look broken.
export const RTT_STALE_AFTER = 2.5; // × the heartbeat interval
export function rttText(net, now = 0, heartbeatMs = HEARTBEAT_MS) {
  const at = Number(net?.at) || 0;
  const rtt = Number(net?.rtt);
  if (!at || !Number.isFinite(rtt)) return ''; // nothing measured yet: say nothing
  const age = Number(now) - at;
  const stale = Math.max(1000, (Number(heartbeatMs) || HEARTBEAT_MS) * RTT_STALE_AFTER);
  return age > stale ? `⚠ stale ${Math.round(age / 1000)}s` : `~${Math.max(0, Math.round(rtt))}ms`;
}

// ------------------------------- v0.17 P6: slash-command autocomplete ----
// jam's own commands only. claude's are unknowable client-side (they come from the host's
// plugins, MCP servers and version), and guessing at them would be worse than showing nothing.
// A space ends the list: from there on the words are arguments, not a command name.
export const COMMAND_HINTS_MAX = 8;
export function commandMatches(input, commands = JAM_COMMANDS, max = COMMAND_HINTS_MAX) {
  const t = String(input ?? '');
  if (!t.startsWith('/') || /\s/.test(t)) return [];
  const q = t.toLowerCase();
  const hits = commands.filter((c) => c.startsWith(q));
  // Nothing to suggest once what is typed IS the only command it can be.
  if (hits.length === 1 && hits[0] === q) return [];
  return hits.slice(0, max);
}

// ------------------------------- v0.18: jam owns its tmux sessions ----
// THE SAFETY RULE, which every helper in this section exists to serve: jam may end a tmux
// session only when ALL of these hold — the caller named it explicitly (or picked it out of
// jam's own verified list), the session carries an `@jam-owned` option, and that option points
// at a state dir holding the `session.json` jam wrote FOR THAT NAME. Never a name pattern,
// never a filtered sweep over `tmux list-sessions`, never `--all` without re-verifying every
// single one, never `kill-server`. The machine this runs on has other people's tmux sessions
// on it, and a "cleanup" that once filtered a list of workspaces cost seven live ones.
//
// So: enumeration happens over jam's OWN namespace (`$TMPDIR/claude-jam-<port>` state dirs),
// the decisions are all here where they can be tested, and the impure half — tmux, fs, the
// HTTP call, the prompts — is sessions.mjs and host.mjs. Every refusal path has a test.
export const OWNED_OPTION = '@jam-owned';
export const SESSION_FILE = 'session.json';
export const STATE_PREFIX = 'claude-jam-';
export const SESSION_TAG = 'claude-jam'; // what session.json says it is, so a stray JSON is not one
export const SESSION_V = 1;

// `$TMPDIR/claude-jam-<port>` — the state dir the launcher has always used, and now also the
// namespace `jam sessions` / `jam clean` enumerate. Nothing outside it is ever looked at.
export function stateDirFor(tmpdir, port) {
  return path.join(String(tmpdir ?? ''), `${STATE_PREFIX}${port}`);
}

// The reverse, for that enumeration. A directory name that is not exactly `claude-jam-<port>`
// is not ours and comes back null — never a "close enough".
const STATE_DIR_RE = new RegExp(`^${STATE_PREFIX}(\\d{1,5})$`);
export function portFromStateDir(name) {
  const m = STATE_DIR_RE.exec(String(name ?? ''));
  const port = m ? Number(m[1]) : NaN;
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

// What the launcher writes into the state dir the moment it creates the session, and what
// verifyOwned checks a marker against. `state` is in here on purpose: it is what makes the
// pair self-consistent, so a session.json copied out of a real jam's dir cannot validate in
// the dir somebody copied it into. `secret` is the daemon's hook secret, which is how `jam end`
// authenticates its POST /end — the same loopback+secret gate the knock popup already uses; it
// lives in a 0700 dir beside token.json, which already holds the join token.
export function sessionInfo({ tmux, port, viewPort, cwd, sessionId, createdAt, pid, state,
  secret = null, socket = TMUX_DEFAULT_SOCKET }) {
  return {
    jam: SESSION_TAG,
    v: SESSION_V,
    tmux: String(tmux ?? ''),
    // v0.20: which tmux server this session lives on. `jam sessions|end|clean` enumerate
    // per-socket, so a row that does not name its socket is read as the default one — which is
    // exactly what a session.json written before v0.20 means.
    socket: String(socket || TMUX_DEFAULT_SOCKET),
    port: Number(port),
    viewPort: Number(viewPort),
    cwd: String(cwd ?? ''),
    sessionId: String(sessionId ?? ''),
    createdAt: Number(createdAt) || 0,
    pid: Number(pid) || 0,
    state: String(state ?? ''),
    secret: secret || null,
  };
}

// A session.json off disk. Anything that is not jam's own shape is null, which every caller
// reads as "jam did not write this" — i.e. a refusal, not a fallback.
export function parseSessionJson(text) {
  let o;
  try { o = JSON.parse(String(text ?? '')); } catch { return null; }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  if (o.jam !== SESSION_TAG || !Number.isInteger(o.v)) return null;
  if (typeof o.tmux !== 'string' || !o.tmux) return null;
  if (typeof o.state !== 'string' || !o.state) return null;
  if (!Number.isInteger(o.port) || o.port <= 0 || o.port > 65535) return null;
  // v0.20: a pre-v0.20 file names no socket, and it meant the default server. Anything that is
  // not a plain socket name is refused rather than turned into a path.
  o.socket = typeof o.socket === 'string' && /^[A-Za-z0-9._][A-Za-z0-9._-]{0,63}$/.test(o.socket)
    ? o.socket : TMUX_DEFAULT_SOCKET;
  return o;
}

// The gate every kill goes through, and the only place that may say yes. Deliberately dumb and
// total: it is handed the exact name asked for, the raw `@jam-owned` value tmux reported for
// THAT name (null when the option is unset) and the parsed session.json found in the directory
// that value names (null when there is none). Anything that does not line up is a refusal
// carrying its own reason — a refusal is never "probably fine".
export function verifyOwned(name, marker, session) {
  const n = String(name ?? '');
  if (!n) return { ok: false, why: 'no session name was given, and jam never guesses one' };
  if (!marker) {
    return { ok: false, why: `tmux session "${n}" carries no ${OWNED_OPTION} marker — jam did not `
      + 'create it, so jam will not end it' };
  }
  const dir = String(marker);
  if (!path.isAbsolute(dir)) {
    return { ok: false, why: `"${n}"'s ${OWNED_OPTION} is ${JSON.stringify(dir.slice(0, 80))}, `
      + 'which is not an absolute state dir — refusing' };
  }
  if (!session) {
    return { ok: false, why: `"${n}"'s ${OWNED_OPTION} points at ${dir}, where there is no `
      + `${SESSION_FILE} jam wrote — that marker was put there by hand, refusing` };
  }
  if (session.state !== dir) {
    return { ok: false, why: `${path.join(dir, SESSION_FILE)} says its state dir is `
      + `${session.state} — the pair was not written together, refusing` };
  }
  if (session.tmux !== n) {
    return { ok: false, why: `${path.join(dir, SESSION_FILE)} belongs to session `
      + `"${session.tmux}", not "${n}" — refusing` };
  }
  return { ok: true, dir, info: session };
}

// What state one row of jam's namespace is in. Three measured facts in, one word out:
//   live       the tmux session is there, its marker verifies, the daemon answers
//   no-daemon  session and marker fine, nothing listening — the daemon died under it
//   orphan     no tmux session and no listener: the state dir is all that is left, and this is
//              the ONLY state `jam clean` may delete
//   no-session no tmux session but something IS on that port — flagged, never cleaned, because
//              whatever holds the port is not ours to remove
//   foreign    the tmux session exists and does NOT verify: shown, never touched, ever
export const JAM_STATES = ['live', 'no-daemon', 'orphan', 'no-session', 'foreign'];
export function classifyJam({ tmuxAlive = false, owned = false, portAlive = false } = {}) {
  if (!tmuxAlive) return portAlive ? 'no-session' : 'orphan';
  if (!owned) return 'foreign';
  return portAlive ? 'live' : 'no-daemon';
}

// The `!` in the table: anything that is not a healthy live jam wants the host's eye.
export function jamMark(state) { return state === 'live' ? ' ' : '!'; }

// `jam clean` removes state dirs and nothing else, and only in the one state that means the
// session behind them is provably gone.
export function cleanable(row) { return row?.state === 'orphan'; }

// `jam end` with no name. Exactly one jam is unambiguous; several is a numbered picker; none is
// an error. A name is matched EXACTLY against jam's own verified rows — no prefix, no case
// folding, no fnmatch — because this is the input that decides what gets killed. (tmux itself
// would happily prefix-match `jam` onto `jamtest`, which is exactly the mistake to avoid.)
export function resolveTarget(rows = [], name = null) {
  const list = (Array.isArray(rows) ? rows : []).filter((r) => r && r.name && r.state !== 'foreign');
  const asked = name == null || name === '' ? null : String(name);
  if (asked == null) {
    if (!list.length) {
      return { ok: false, why: 'no jam of jam\'s own is running — `jam sessions` lists what it knows about' };
    }
    if (list.length === 1) return { ok: true, row: list[0] };
    return { ok: false, why: `${list.length} jams are running — name one, or pick a number`, choices: list };
  }
  const hit = list.find((r) => r.name === asked);
  if (hit) return { ok: true, row: hit };
  return { ok: false, choices: list, why: `no jam-owned tmux session is called "${asked}" — `
    + (list.length ? `jam knows about ${list.map((r) => r.name).filter(Boolean).join(', ')}`
      : 'jam knows about none right now') };
}

// Answering a numbered picker. 1-based, exact digits only: an out-of-range or non-numeric
// answer is null, which every caller treats as "nothing was chosen".
export function pickNumber(text, choices = []) {
  const t = String(text ?? '').trim();
  if (!/^\d{1,3}$/.test(t)) return null;
  const i = Number(t) - 1;
  return i >= 0 && i < choices.length ? choices[i] : null;
}

// One keypress answering one of jam's prompts. Lowercased first visible character, and it has
// to be one of the offered keys — anything else is null, i.e. ask again. There is deliberately
// no default: nothing destructive may happen because somebody hit Enter.
export function promptChoice(input, keys = []) {
  const c = String(input ?? '').trim().toLowerCase().slice(0, 1);
  return c && keys.includes(c) ? c : null;
}

// v0.18-1: what happens when the host's client exits. The flags win over the prompt, and stdin
// that is not a terminal cannot answer one — in both of those cases the answer is KEEP, so
// nothing destructive ever happens because nobody was there to say no. A guest is never asked
// at all: their client was a window onto somebody else's session.
export function exitDecision({ endOnExit = false, keepOnExit = false, noPrompt = false, isTty = false, isHost = true } = {}) {
  if (endOnExit && keepOnExit) return 'conflict';
  if (!isHost) return 'keep';
  if (endOnExit) return 'end';
  if (keepOnExit || noPrompt || !isTty) return 'keep';
  return 'prompt';
}

export const EXIT_KEYS = ['k', 'e', 'c'];
export function exitPromptText(guests = 0) {
  const n = Math.max(0, Math.floor(Number(guests) || 0));
  const who = n === 1 ? '1 guest connected' : `${n} guests connected`;
  return `this jam is still running (${who}) — [k]eep it running · [e]nd it · [c]ancel`;
}

// The way back in, printed whenever a client leaves a jam running (`k`, `--keep-on-exit`, a
// non-interactive exit) — one wording, so the launcher and `jam sessions` agree.
export function reattachLines({ tmux = 'jam', port = 7777, clientCmd = 'node client.mjs', name = 'Host',
  token = null, socket = TMUX_DEFAULT_SOCKET } = {}) {
  return [
    `client:  jam host --attach${tmux === 'jam' ? '' : ` --tmux ${tmux}`}`,
    `  or:    ${clientCmd} ws://127.0.0.1:${port} --name ${name}${token ? ` --token ${token}` : ''} --host`,
    // v0.20: jam's tmux lives on a socket of its own, so a bare `tmux attach` no longer finds it.
    `raw TUI: ${tmuxAttachLine(socket, tmux, claudeTarget(tmux))}`,
    `list:    jam sessions`,
    `stop:    jam end ${tmux}`,
  ];
}

// v0.18-5: `jam host` when the name it wants is taken. A jam of jam's own gets four ways out;
// anything else is refused without being touched.
export const TAKEN_KEYS = ['a', 'n', 'e', 'c'];
export function takenPromptText(name, next) {
  return `tmux session "${name}" is already a jam of yours — [a]ttach as host · `
    + `[n]ew session (${next}) · [e]nd it and start fresh · [c]ancel`;
}

export function foreignSessionText(name, why = '') {
  return `tmux session "${name}" already exists and is NOT one of jam's — jam will not touch it.\n`
    + `  ${why || 'no @jam-owned marker'}\n`
    + `  run this jam under another name:  jam host --tmux ${name}-jam\n`
    + `  or look at it yourself:           tmux attach -t ${name}`;
}

// `jam` → `jam-2` → `jam-3`. The first free suffix, so a third jam does not reuse a name that
// is only free because the second one is between states.
export function autoSessionName(base, taken = []) {
  const b = String(base ?? 'jam');
  const used = new Set((Array.isArray(taken) ? taken : []).map(String));
  if (!used.has(b)) return b;
  for (let n = 2; n <= 99; n++) { if (!used.has(`${b}-${n}`)) return `${b}-${n}`; }
  return null;
}

// v0.18-7: `{t:'ending'}` — the session is going away on purpose. A client prints one line and
// leaves with 0; the one thing it must NOT do is reconnect at a daemon that is deliberately
// gone. Exit code 0 always: an orderly end is not a failure, in a script or anywhere else.
export function endingNotice(ev = {}) {
  const who = validName(ev?.by) ? ev.by : null;
  const why = typeof ev?.reason === 'string' && ev.reason.trim() ? ` (${stripControl(ev.reason).slice(0, 80)})` : '';
  return { code: 0, text: `${who ? `${who} ended the jam` : 'the host ended the jam'}${why} — nothing to reconnect to` };
}

// v0.18-4: `/end` in the host client, which ends the session for everybody, so it is the one
// jam command that asks twice. Only a real yes counts; Enter alone is a no.
export function confirmYes(text) {
  const t = String(text ?? '').trim().toLowerCase();
  return t === 'y' || t === 'yes';
}

// `3h 12m` / `12m` / `41s` — how long a jam has been up, for the table.
export function uptimeText(ms) {
  const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

// v0.18-2: `jam sessions`. Rows are built by sessions.mjs out of jam's own namespace; this only
// lays them out. `id` is the first 8 of the claude session id (enough to recognise, short enough
// to fit), `here` the roster, `urls` which relays are configured — never the URLs themselves,
// because a join line carries the token.
export const SESSIONS_COLS = ['', '#', 'name', 'port', 'state', 'up', 'session', 'here', 'urls', 'cwd'];
export function sessionsRow(row = {}, now = 0, i = 0) {
  return {
    mark: jamMark(row.state),
    n: String(i + 1),
    name: row.name || '—',
    port: String(row.port ?? '—'),
    state: row.state || '?',
    up: row.createdAt ? uptimeText(Number(now) - Number(row.createdAt)) : '—',
    session: String(row.sessionId || '').slice(0, 8) || '—',
    here: (row.participants || []).length ? row.participants.join(', ') : '—',
    urls: [row.view ? 'view' : null, row.tunnel ? 'tunnel' : null].filter(Boolean).join('+') || '—',
    cwd: row.cwd || '—',
  };
}

export function sessionsTable(rows = [], now = 0) {
  if (!rows.length) {
    return 'no jams — `jam host` starts one, and this list only ever shows jam\'s own sessions';
  }
  const cells = [SESSIONS_COLS, ...rows.map((r, i) => Object.values(sessionsRow(r, now, i)))];
  const w = SESSIONS_COLS.map((_, c) => Math.max(...cells.map((row) => String(row[c] ?? '').length)));
  const out = cells.map((row) => row.map((v, c) => String(v ?? '').padEnd(c === row.length - 1 ? 0 : w[c])).join(' ').trimEnd());
  const notes = [];
  // v0.20: a bare `tmux attach` no longer finds a jam, so the exact line is printed per live jam.
  for (const r of rows) {
    if (r.name && r.state !== 'foreign') notes.push(`  raw TUI: ${tmuxAttachLine(r.socket, r.name, claudeTarget(r.name))}`);
  }
  if (rows.some((r) => r.state === 'orphan')) notes.push('! orphan = the tmux session is gone; `jam clean` removes those state dirs');
  if (rows.some((r) => r.state === 'no-daemon')) notes.push('! no-daemon = the session is up but nothing answers on its port; `jam end <name>` clears it');
  if (rows.some((r) => r.state === 'no-session')) notes.push('! no-session = no tmux session, but something still holds that port — jam leaves it alone');
  if (rows.some((r) => r.state === 'foreign')) notes.push('! foreign = that name is somebody else\'s tmux session; jam will never touch it');
  return [...out, ...notes].join('\n');
}

// `jam sessions --json`: the row as measured, for scripting. Same facts, no layout.
export function sessionsJson(rows = [], now = 0) {
  return rows.map((r) => ({
    name: r.name ?? null,
    state: r.state,
    port: r.port ?? null,
    viewPort: r.viewPort ?? null,
    cwd: r.cwd ?? null,
    sessionId: r.sessionId ?? null,
    createdAt: r.createdAt ?? null,
    uptimeMs: r.createdAt ? Math.max(0, Number(now) - Number(r.createdAt)) : null,
    participants: r.participants || [],
    view: !!r.view,
    tunnel: !!r.tunnel,
    socket: r.socket ?? TMUX_DEFAULT_SOCKET, // v0.20: which tmux server it lives on
    state_dir: r.dir ?? null,
    cleanable: cleanable(r),
  }));
}

// ------------------------------- v0.22B: invite links ----
// A link is the guest's WHOLE command: `claude-jam join cjam1_…` — no name to type, no token to
// paste, no host to wake up for an approval. So the link is a credential, and everything here is
// written as one: the daemon stores only a HASH of the secret, the record is name-bound, expiring
// and individually revocable, and every rejection has its own reason instead of a shrug.
//
// Format: `cjam1_<base64url(json)>`, json = {v, jam, name, secret, ws:[…], exp}. The version
// lives in the PREFIX as well as in the payload, so a future format is a clean "update
// claude-jam" instead of a JSON parse error — and a v2 link cannot be silently read as a v1 one.
export const INVITE_V = 1;
export const INVITE_PREFIX = `cjam${INVITE_V}_`;
// Any version, so a cjam2_ link is recognised as an invite and refused as a version, not
// dismissed as gibberish.
export const INVITE_LINK_RE = /^cjam(\d{1,3})_([A-Za-z0-9_-]{8,4096})$/;
export const INVITE_SECRET_LEN = 24;
export const INVITE_SECRET_RE = /^[A-Za-z0-9_-]{16,64}$/;
export const INVITE_TTL_MS = 24 * 60 * 60 * 1000; // the default expiry: a day
export const INVITE_TTL_MAX = 30 * 24 * 60 * 60 * 1000;
export const INVITE_MAX_USES = 1000;
export const INVITE_ADDR_MAX = 4;
// Host and optional port only — an invite address becomes a WebSocket URL, never a path or a
// query, and never something with a credential in it.
export const INVITE_ADDR_RE = /^wss?:\/\/[A-Za-z0-9][A-Za-z0-9.-]{0,252}(?::\d{1,5})?$/;
// v0.22B: how long the client waits for ONE address before trying the next.
export const INVITE_CONNECT_MS = 3000;

export function validInviteSecret(s) {
  return typeof s === 'string' && INVITE_SECRET_RE.test(s);
}

// The address list, in the order it will be tried: whatever the caller put first. Invalid or
// duplicate entries drop out rather than becoming a connect attempt that cannot work.
export function inviteAddresses(list = []) {
  const out = [];
  for (const a of Array.isArray(list) ? list : []) {
    const s = typeof a === 'string' ? a.trim() : '';
    if (!INVITE_ADDR_RE.test(s) || out.includes(s)) continue;
    out.push(s);
    if (out.length >= INVITE_ADDR_MAX) break;
  }
  return out;
}

// Tunnel first, then LAN — the tunnel is the one that works from anywhere, and the LAN address is
// what keeps a link alive after a cloudflared respawn changed the hostname (v0.22B's caveat).
export function inviteWsAddresses({ tunnelHost = null, ip = null, port = 0 } = {}) {
  return inviteAddresses([
    tunnelHost ? `wss://${tunnelHost}` : null,
    ip && port ? `ws://${ip}:${port}` : null,
  ]);
}

// `exp` is epoch SECONDS in the link (it is a wire format, and seconds keep it short); every
// record and every check inside jam uses epoch milliseconds like the rest of the codebase.
export function encodeInvite({ jam = '', name, secret, ws = [], expires = 0 }) {
  if (!validName(name)) throw new Error(`bad invite name: ${JSON.stringify(String(name).slice(0, 40))}`);
  if (!validInviteSecret(secret)) throw new Error('bad invite secret: 16-64 chars of [A-Za-z0-9_-]');
  const addrs = inviteAddresses(ws);
  if (!addrs.length) throw new Error('an invite link needs at least one ws:// or wss:// address');
  const exp = Math.floor(Math.max(0, Number(expires) || 0) / 1000);
  const payload = { v: INVITE_V, jam: String(jam ?? '').slice(0, 12), name, secret, ws: addrs, exp };
  return INVITE_PREFIX + Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

// The guest's side. Every refusal carries its own `reason` so the client can say something true
// instead of "could not join", and an EXPIRED link still hands back its decoded contents: the
// addresses and the name are exactly what a fall-through knock needs.
export function decodeInvite(link, now = Date.now()) {
  const s = typeof link === 'string' ? link.trim() : '';
  const m = INVITE_LINK_RE.exec(s);
  if (!m) {
    return { ok: false, reason: 'not-a-link',
      error: 'that is not a claude-jam invite link — they look like cjam1_… (a ws:// URL works too)' };
  }
  const v = Number(m[1]);
  if (v !== INVITE_V) {
    return { ok: false, reason: 'bad-version',
      error: `this is a cjam${v} invite link and this claude-jam speaks cjam${INVITE_V} — `
        + 'update claude-jam, or ask the host for a ws:// URL' };
  }
  let o;
  try { o = JSON.parse(Buffer.from(m[2], 'base64url').toString('utf8')); } catch {
    return { ok: false, reason: 'bad-payload',
      error: 'this invite link is damaged — it did not decode. Ask the host for a fresh one' };
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) {
    return { ok: false, reason: 'bad-payload', error: 'this invite link decoded to nothing usable' };
  }
  // The payload carries the version too: a hand-edited link that kept the cjam1_ prefix and
  // changed `v` is a tampered link, not a v2 one.
  if (o.v !== INVITE_V) {
    return { ok: false, reason: 'bad-version',
      error: `this invite link says it is format ${JSON.stringify(o.v)}, not ${INVITE_V} — ask the host for a fresh one` };
  }
  if (!validName(o.name)) {
    return { ok: false, reason: 'bad-name', error: 'this invite link carries no usable name — ask the host for a fresh one' };
  }
  if (!validInviteSecret(o.secret)) {
    return { ok: false, reason: 'bad-secret', error: 'this invite link carries no usable secret — ask the host for a fresh one' };
  }
  const ws = inviteAddresses(o.ws);
  if (!ws.length) {
    return { ok: false, reason: 'no-address', error: 'this invite link carries no address I can connect to' };
  }
  const invite = { v: INVITE_V, jam: typeof o.jam === 'string' ? o.jam.slice(0, 12) : '',
    name: o.name, secret: o.secret, ws, exp: Math.floor(Number(o.exp) || 0) };
  if (invite.exp && invite.exp * 1000 <= Number(now)) {
    // Still usable for a knock: the addresses and the name are right, only the credential is old.
    return { ok: false, reason: 'expired', invite,
      error: `this invite for ${invite.name} expired ${new Date(invite.exp * 1000).toISOString().slice(0, 16).replace('T', ' ')}Z `
        + '— connecting anyway, and knocking instead' };
  }
  return { ok: true, invite };
}

// The daemon never stores a secret, only its hash — so a state dir (or a stray backup of one)
// cannot hand somebody a working link.
export function inviteHash(secret) {
  return createHash('sha256').update(String(secret ?? ''), 'utf8').digest('hex');
}
// Short handle for `/invite revoke <id>` and the listing. The hash's own first 8 hex chars: it
// identifies a record without being a credential.
export function inviteId(hash) { return String(hash ?? '').slice(0, 8); }

// Two hex digests, compared without leaking where they first differ.
export function hashEq(a, b) {
  const x = Buffer.from(String(a ?? ''), 'utf8');
  const y = Buffer.from(String(b ?? ''), 'utf8');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

// One stored invite. `maxUses: 0` is unlimited, which is the default on purpose: a guest whose
// laptop slept reconnects, and a one-shot link would lock them out of the jam they are in.
export function inviteRecord({ name, secret = null, hash = null, uses = 0, maxUses = 0,
  expires = 0, revoked = false, createdAt = 0 } = {}) {
  const h = hash || inviteHash(secret);
  return {
    id: inviteId(h),
    hash: h,
    name: String(name ?? ''),
    uses: Math.max(0, Math.floor(Number(uses) || 0)),
    maxUses: Math.max(0, Math.floor(Number(maxUses) || 0)),
    expires: Math.max(0, Math.floor(Number(expires) || 0)),
    revoked: revoked === true,
    createdAt: Math.max(0, Math.floor(Number(createdAt) || 0)),
  };
}

// What survives a restart, and what comes back off disk. A record that is not jam's own shape is
// dropped rather than half-trusted — an invite is a credential, so "close enough" is not a thing.
export function parseInvitesFile(text) {
  let o;
  try { o = JSON.parse(String(text ?? '')); } catch { return []; }
  const list = Array.isArray(o) ? o : Array.isArray(o?.invites) ? o.invites : null;
  if (!list) return [];
  const out = [];
  for (const r of list) {
    if (!r || typeof r !== 'object') continue;
    if (typeof r.hash !== 'string' || !/^[0-9a-f]{64}$/.test(r.hash)) continue;
    if (!validName(r.name)) continue;
    out.push(inviteRecord(r));
  }
  return out;
}

// THE admission decision for an invite. Five things have to hold, and each failure says which:
// the secret is one we could have issued, it matches a record, that record is not revoked, not
// expired, not used up — and nobody is already here under that name. Anything else falls through
// to the knock path, which is the point: an invite is a shortcut past the approval, never past
// the door.
export function checkInvite(records, secret, { now = Date.now(), liveNames = [] } = {}) {
  if (!validInviteSecret(secret)) {
    return { ok: false, reason: 'malformed', why: 'that is not the shape of an invite secret I issue' };
  }
  const hash = inviteHash(secret);
  const rec = (Array.isArray(records) ? records : []).find((r) => r && hashEq(r.hash, hash));
  if (!rec) {
    return { ok: false, reason: 'unknown',
      why: 'this invite is not one of mine — the jam may have been restarted or the link re-issued' };
  }
  if (rec.revoked) return { ok: false, reason: 'revoked', rec, why: `the invite for ${rec.name} was revoked` };
  if (rec.expires && rec.expires <= Number(now)) {
    return { ok: false, reason: 'expired', rec, why: `the invite for ${rec.name} expired` };
  }
  if (rec.maxUses && rec.uses >= rec.maxUses) {
    return { ok: false, reason: 'used-up', rec,
      why: `the invite for ${rec.name} has been used ${rec.uses} of ${rec.maxUses} times` };
  }
  if (nameTaken(rec.name, liveNames)) {
    return { ok: false, reason: 'name-taken', rec, why: `somebody is already here as ${rec.name}` };
  }
  return { ok: true, rec, name: rec.name };
}

// What a refused invite is told, and what the host sees in the log. One wording per reason, so a
// guest can say "it says revoked" and the host knows exactly which of the five gates closed.
export function inviteRefusal(reason, why = '') {
  const tail = 'knocking instead — the host can still let you in';
  const known = {
    malformed: 'that invite link is not one I can read',
    unknown: 'that invite is not one of this jam\'s',
    revoked: 'that invite was revoked',
    expired: 'that invite has expired',
    'used-up': 'that invite has been used as many times as it was allowed',
    'name-taken': 'somebody is already connected under that invite\'s name',
  };
  return `${known[reason] || 'that invite was refused'}${why ? ` (${why})` : ''} — ${tail}`;
}

// `/invite revoke <Name|id>` and `claude-jam invite revoke …`. An id matches exactly, a name
// matches every live link issued to that person — revoking "Yossi" takes back Yossi's links, all
// of them, which is what somebody typing that means.
export function resolveInvites(records, target) {
  const t = typeof target === 'string' ? target.trim() : '';
  if (!t) return { ok: false, why: 'name an invite: /invite revoke <Name|id>' };
  const list = (Array.isArray(records) ? records : []).filter((r) => r && !r.revoked);
  const byId = list.filter((r) => String(r.id).toLowerCase() === t.toLowerCase());
  if (byId.length) return { ok: true, hits: byId };
  const byName = list.filter((r) => String(r.name).toLowerCase() === t.toLowerCase());
  if (byName.length) return { ok: true, hits: byName };
  return { ok: false, why: `no live invite matches "${t}" — /invites lists them` };
}

// `2h left` / `expired` / `no expiry`, for the listing.
export function inviteLeft(expires, now = Date.now()) {
  const e = Math.max(0, Math.floor(Number(expires) || 0));
  if (!e) return 'no expiry';
  const left = e - Number(now);
  return left <= 0 ? 'expired' : `${uptimeText(left)} left`;
}

export function inviteState(rec, now = Date.now()) {
  if (!rec) return 'gone';
  if (rec.revoked) return 'revoked';
  if (rec.expires && rec.expires <= Number(now)) return 'expired';
  if (rec.maxUses && rec.uses >= rec.maxUses) return 'used-up';
  return 'live';
}

// `/invites` and `claude-jam invites`. Never the secret and never the link — a listing is read in
// a shared terminal, and the link is the credential. Re-mint to hand one out again.
export function invitesReport(records = [], now = Date.now()) {
  const list = Array.isArray(records) ? records : [];
  if (!list.length) return 'no invite links yet — /invite <Name> mints one';
  const rows = list.map((r) => {
    const used = r.maxUses ? `${r.uses}/${r.maxUses} uses` : `${r.uses} use${r.uses === 1 ? '' : 's'}`;
    return `  ${r.id}  ${r.name}  ${inviteState(r, now)}  ${used}  ${inviteLeft(r.expires, now)}`;
  });
  return [`${list.length} invite link(s) — id, name, state, uses, expiry:`, ...rows,
    '  (the links themselves are never printed twice: /invite <Name> mints a new one)'].join('\n');
}

// What the host is shown the moment a link exists: the guest's whole command, on its own line, so
// it can be selected and sent as one thing.
export function inviteMintedLines(rec, link, clientCmd = 'node client.mjs', now = Date.now()) {
  return [
    `invite for ${rec.name} (${rec.id}) — ${rec.maxUses ? `${rec.maxUses} use(s)` : 'multi-use'}, ${inviteLeft(rec.expires, now)}:`,
    `${clientCmd} ${link}`,
    'that link is a password: it joins as that name with no approval. Send it privately, '
      + `and /invite revoke ${rec.name} when you are done.`,
  ];
}

// `30m`, `24h`, `7d`, `90s`, or a bare number of hours-less seconds… no: a bare number is
// AMBIGUOUS, so it is refused. null = "I did not understand that", never a silent default.
export const DURATION_RE = /^(\d{1,6})([smhd])$/i;
export function parseDuration(text) {
  const m = DURATION_RE.exec(String(text ?? '').trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2].toLowerCase()];
  const ms = n * unit;
  return ms > 0 && ms <= INVITE_TTL_MAX ? ms : null;
}

// `/invite …` in the client and `claude-jam invite …` on the command line parse identically, so
// the two surfaces cannot drift. Returns the op the daemon is asked for, or one usage error.
export const INVITE_USAGE = 'usage: /invite <Name> [--uses N] [--expires 24h] | '
  + '/invite revoke <Name|id> | /invites';
export function parseInviteCommand(rest) {
  const words = String(rest ?? '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return { ok: false, error: INVITE_USAGE };
  const head = words[0].toLowerCase();
  if (head === 'revoke') {
    const target = words.slice(1).join(' ');
    return target ? { ok: true, op: 'revoke', target } : { ok: false, error: 'usage: /invite revoke <Name|id>' };
  }
  if (head === 'list') return { ok: true, op: 'list' };
  const flagAt = words.findIndex((w) => w.startsWith('--'));
  const name = (flagAt < 0 ? words : words.slice(0, flagAt)).join(' ');
  if (!validName(name)) {
    return { ok: false, error: `${JSON.stringify(name)} is not a name I can invite — letters, `
      + 'digits, space, _ or -, up to 24 characters' };
  }
  let maxUses = 0;
  let ttl = INVITE_TTL_MS;
  for (let i = flagAt < 0 ? words.length : flagAt; i < words.length; i += 2) {
    const f = words[i];
    const v = words[i + 1];
    if (f === '--uses') {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1 || n > INVITE_MAX_USES) {
        return { ok: false, error: `--uses wants a whole number from 1 to ${INVITE_MAX_USES}, got ${JSON.stringify(String(v ?? ''))}` };
      }
      maxUses = n;
    } else if (f === '--expires') {
      const ms = parseDuration(v);
      if (ms == null) return { ok: false, error: `--expires wants a duration like 30m, 24h or 7d, got ${JSON.stringify(String(v ?? ''))}` };
      ttl = ms;
    } else {
      return { ok: false, error: `${JSON.stringify(f)} is not an option I know. ${INVITE_USAGE}` };
    }
  }
  return { ok: true, op: 'new', name, maxUses, ttl };
}

// ------------------------------- v0.22C: /kick ----
// The one thing `/deny` never could do: remove somebody who is already in. 4406 is inside the
// 4400-4429 band every client already treats as final, so a kicked guest leaves and does not
// spend the next ten minutes reconnecting.
export const KICK_CODE = 4406;
export function resolveKick(name, liveNames = [], self = null) {
  const asked = typeof name === 'string' ? name.trim() : '';
  if (!asked) return { ok: false, why: 'usage: /kick <name> [revoke]' };
  if (self && asked.toLowerCase() === String(self).toLowerCase()) {
    return { ok: false, why: 'you cannot kick yourself — /quit closes your own client' };
  }
  const hit = (Array.isArray(liveNames) ? liveNames : []).find((n) => String(n).toLowerCase() === asked.toLowerCase());
  if (!hit) return { ok: false, why: `nobody here is called "${asked}" — /who lists who is` };
  return { ok: true, name: hit };
}

// `/kick Yossi` / `/kick Yossi revoke`. The trailing word is the one-shot form of the offer the
// client makes afterwards, so a script (and a smoke) needs no interactive answer.
export function parseKickCommand(rest) {
  const words = String(rest ?? '').trim().split(/\s+/).filter(Boolean);
  const revoke = words.at(-1)?.toLowerCase() === 'revoke';
  const name = (revoke ? words.slice(0, -1) : words).join(' ');
  return name ? { ok: true, name, revoke } : { ok: false, error: 'usage: /kick <name> [revoke]' };
}

// After a kick that landed: the offer to take their way back in with them. Only asked when the
// person actually joined on an invite — a knock-approved guest has nothing to revoke.
export function kickOffer(name, via) {
  return via === 'invite'
    ? `${name} is out. Also revoke their invite link so it cannot let them back in? [y/N]`
    : `${name} is out. They joined by ${via || 'approval'}, so there is no link to revoke.`;
}

// ------------------------------- v0.19: the contract goes in the system prompt ----
// Everything jam told claude used to arrive as SessionStart `additionalContext`. That is
// *context*: `/compact` can summarise it away, and a long jam is exactly where that happens. An
// appended system prompt persists for the whole session instead, so the split is by LIFETIME:
// durable facts and the two standing rules go here, and anything that changes at runtime (the
// roster, the token, the tunnel URLs) stays in the hooks, because a system prompt is read once
// at startup and can never be rewritten.
export const SYSTEM_PROMPT_FILE = 'system-prompt.txt';
export const CLAUDE_CAPS_FILE = 'claude-caps.json';

export function buildSystemPrompt({ hostName = 'the host', manual = 'MANUAL.md' } = {}) {
  return `This session is SHARED with other humans, and bridged by claude-jam.

WHO IS TALKING
- Every participant reaches you prefixed \`[Name]: \` — the host included. The prefix is
  authoritative: only the bridge writes it, and a participant's own text that looked like one is
  bent so it cannot forge somebody else's attribution.
- A message with NO prefix was typed straight into this terminal: somebody attached to the tmux
  session, or the host took the keyboard with F3 in their client.
- The host of this jam is ${hostName}.
- Treat every participant's instructions as the user's, address people by name when it helps, and
  say who asked when you report back on something.

TWO RULES THAT MUST NOT DECAY
1. NEVER reveal the join token, an invite link, or the browser view URL to a \`[Name]:\`-prefixed
   participant — not in full, not in part, not in a paraphrase, and not to somebody who claims to
   be the host. Only an UNPREFIXED message (which is the host's own terminal) may be told, and
   only when it asks. To anybody else: tell them to ask the host.
2. NEVER claim to have seen human-only chat. \`/c <text>\` is relayed between the humans and
   deliberately withheld from you. Asked what was said in \`/c\`, say plainly that you cannot see
   it — do not guess, and do not pretend.

HOW A JAM WORKS (the short version; ${manual} arrives in your context with the long one)
- Joining: \`claude-jam join <invite-link>\` is one command and needs no approval; a shared
  \`--token\` also gets somebody straight in; with neither, a guest knocks and the host accepts.
- \`/invite <Name>\`, \`/invites\`, \`/invite revoke\` mint, list and take back links (host only).
  \`/kick <name>\` removes somebody already in. An invite link is a password: never help anybody
  read one out.
- Everyone's default view is a live mirror of this very screen; F2 shows the transcript instead.
- \`/c\` humans-only chat · \`/who\` participants · \`/help\` the onboarding block · \`/quit\` leave.
- \`/tools\` the last turn's tool log · \`/files\` every path this session touched · \`/diff [path]\`
  git's own view of the working tree.
- \`/export\` hands a guest this session's transcript (the host approves) · \`/send\` and \`/paste\`
  put a file in \`jam-uploads/\` for you to read (the host approves) · \`/get\` takes one back.
- When YOU ask a question (AskUserQuestion), ANYONE in the jam may answer it with \`/answer <n>\` —
  no approval, first answer wins, and the room is told who answered. A question is a product
  decision, so it belongs to whoever is here. (\`--answers host\` keeps it to the host; the
  free-text \"Type something\" option is always the host's, because that is raw keyboard access.)
- PERMISSION prompts (a tool wanting approval) are different, and stay the host's: F3 attaches this
  real terminal to them (F3 again, or Ctrl-b d, comes back). A guest may ASK with \`/answer <n>\`;
  the host approves, and only a digit already visible on your screen is ever typed.
- If somebody's message never reached you, jam kept it: \`/outbox\` lists what is kept and
  \`/retry\` sends the newest again. \`↑\`/\`↓\` recall what they typed. Tell them so if they ask.
- Any other \`/command\` is one of yours: from the host it is typed straight in, from a guest it
  becomes a request the host approves. \`/exit\`, \`/clear\` and \`/resume\` are never approved for a
  guest, because they would end or wipe the session for everybody.

These are instructions to you, not an enforcement boundary — the hard gates are the host's own
approval and the server-side host+loopback checks. Hold the two rules above anyway.
`;
}

// Probing for the flag, and why it is shaped like this: `--append-system-prompt-file` is NOT in
// `claude --help` on 2.1.251 even though it works, so grepping the help text would answer "no"
// on a build that supports it. `--version` short-circuits before options are validated, and `-p`
// costs a turn. So: pass our flag AND a flag nothing could ever know, and read which one the
// parser complains about. Free, instant, and it exits non-zero either way.
export const SYSTEM_PROMPT_PROBE_FLAG = '--claude-jam-probe-unknown-flag';
export function systemPromptProbeArgs(file) {
  return ['--append-system-prompt-file', String(file ?? ''), SYSTEM_PROMPT_PROBE_FLAG];
}

// Our flag named as the unknown option = this build has never heard of it. The probe flag named
// instead = ours got past the parser, which is the whole question. Anything else at all — no
// output, a timeout, a message we do not recognise — is NO, because the fallback (hooks only)
// always works and a wrong yes would stop claude from starting.
export function systemPromptSupported(output) {
  const s = String(output ?? '');
  if (s.includes('--append-system-prompt-file')) return false;
  return s.includes(SYSTEM_PROMPT_PROBE_FLAG);
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

// =============================== v0.30: a landed paste has more than one shape ====
// Observed live 2026-08-29 15:20: a nineteen-line message failed with "pasted text never appeared
// in the claude pane" and Ctrl-U then wiped it. Claude Code 2.1.x does not echo a multi-line
// paste — it collapses the whole thing to a placeholder — so the echo probe could never match.
// Measured on 2.1.251 (100x32, `tmux paste-buffer -p`): ANY bracketed paste carrying a newline
// becomes one, from three lines up, and the counter climbs per paste in a session:
//   `❯ [Pasted text #3 +3 lines]`   `❯ [Pasted text #2 +18 lines]`
// Matched on the FAMILY rather than one spelling: earlier builds drew `[Pasted text +NN lines]`
// with no counter, and a later one is free to put something else between the brackets.
export const PASTE_PLACEHOLDER_RE = /\[pasted\s+text[^\]]{0,64}\]/i;
export function hasPastePlaceholder(text) { return PASTE_PLACEHOLDER_RE.test(String(text ?? '')); }

// The placeholder carries a COUNT, and the count is the only on-screen evidence that a paste
// arrived whole. Measured on 2.1.251: the number is the payload's NEWLINE count — a 19-line file
// (18 newlines) shows `+18 lines`, and `a\nb\nc\n` (3 newlines) shows `+3 lines`. Several pastes
// into one box leave several placeholders, so the counts sum.
const PASTE_COUNT_RE = /\[pasted\s+text[^\]]*?\+(\d+)\s+lines?\]/gi;
export function pastedLines(text) {
  const re = new RegExp(PASTE_COUNT_RE.source, 'gi');
  let n = null;
  for (let m = re.exec(String(text ?? '')); m; m = re.exec(String(text ?? ''))) n = (n ?? 0) + Number(m[1]);
  return n; // null = no placeholder carried a number we could read
}

// The input box's own rows — NOT "the last three rows of the pane". Measured on 2.1.251 the last
// three rows are chrome (`[claude2] | Haiku 4.5 | …`, `⏸ manual mode on`, the corner hint) and the
// box sits four rows further up; worse, that chrome changes on its own (`⏸ manual mode on · ← for
// agents` becomes `paste again to expand` after a paste), so diffing it would report a paste that
// landed when nothing landed at all. So: from the last prompt row down to the rule that closes the
// box. ponytail: with a picker on screen the last prompt row can be a transcript echo rather than
// the box — harmless here, because nothing pastes into a pane that is showing a picker.
export const INPUT_AREA_MAX = 12;
const RULE_ROW_RE = /^[─━—_]{10,}$/;
const PROMPT_ROW_RE = /^\s*(?:❯|>)(?:\s|$)/;
const OPTION_ROW_RE = /^\s*(?:❯|▶|>|\*)\s*\d[.)]\s/;
export function inputAreaRows(screen) {
  const rows = (Array.isArray(screen) ? screen : String(screen ?? '').split('\n'))
    .map((r) => String(r).replace(/\s+$/, ''));
  let i = -1;
  for (let k = rows.length - 1; k >= 0; k--) {
    if (PROMPT_ROW_RE.test(rows[k]) && !OPTION_ROW_RE.test(rows[k])) { i = k; break; }
  }
  if (i < 0) return rows.slice(-3);
  const out = [];
  for (let k = i; k < rows.length && out.length < INPUT_AREA_MAX; k++) {
    if (RULE_ROW_RE.test(rows[k].trim())) break;
    out.push(rows[k]);
  }
  return out;
}

// Did the paste land? Three independent yeses, because a landed paste has three different shapes
// on screen and the live failure was believing only the first one. Returns WHICH one said yes
// (the daemon logs it, so a future rendering change shows up as "always 'changed'" rather than as
// somebody's lost message), or null for "not yet".
export function injectLanded({ probe = '', before = null, after = '', lines = null } = {}) {
  const tailOf = (s) => String(s ?? '').split('\n').slice(-15).join('\n');
  const box = inputAreaRows(after);
  const was = before == null ? null : inputAreaRows(before);
  // A pty drops what a busy TUI does not read in time — measured: an 8 KB `paste-buffer` into a
  // mid-redraw pane arrived 4.2 KB short, silently. So when the box tells us how many lines it
  // took, that is the rule: a count short of what was sent is NOT a landing, it is a truncation,
  // and failing closed here is what turns a silently mangled message into a kept one.
  const shown = pastedLines(box.join('\n'));
  if (lines != null && shown != null) return shown === lines ? 'placeholder' : null;
  // A rule is evidence only if it was NOT already true before the paste. Without that, the
  // second chunk of a chunked payload "lands" on the first chunk's placeholder, and a repeated
  // message lands on its own stale echo.
  if (probe && tailOf(after).includes(probe) && !(before != null && tailOf(before).includes(probe))) return 'probe';
  if (box.some(hasPastePlaceholder) && !(was && was.some(hasPastePlaceholder))) return 'placeholder';
  // Weakest, and last: the box is not what it was immediately before `paste-buffer`. It is the
  // only rule that survives a rendering jam has never seen, and it is safe to be wrong about
  // because v0.30's other half means the payload is on disk either way.
  if (was && was.join('\n') !== box.join('\n')) return 'changed';
  return null;
}

// Is there anything in the box to clear? The v0.30 rule is "capture first, and only clear if
// something is actually in it" — a blind Ctrl-U into an empty box is what wiped a message that
// had in fact never been pasted. Measured bonus: on 2.1.251 ONE Ctrl-U does not clear a wrapped
// multi-row input, it kills one visual line, so clearing means repeating until the box is empty.
export function inputBoxText(screen) {
  const box = inputAreaRows(screen);
  if (!box.length) return '';
  return [box[0].replace(PROMPT_ROW_RE, ''), ...box.slice(1)].join('\n').trim();
}
export const CLEAR_TRIES = 6;

// Very large payloads go in on line boundaries, ≤8 KB a paste, Enter only after the last one.
// Concatenating the chunks is the payload byte for byte: the newline stays with the line it ends,
// so a boundary can never glue two of the sender's lines together. A single line longer than a
// whole chunk is cut, because nothing else can cut it.
// The spec said ~8 KB. Measured, it cannot be: a pty hands the TUI 1022 bytes at a time, and an
// 8 KB `paste-buffer` into a pane that is mid-redraw loses whatever the input queue could not hold
// — 4.2 KB of a 8 KB chunk, with no error anywhere. 2 KB is comfortably inside the queue, and the
// per-chunk verification below is what catches it if a slower machine still comes up short.
// ponytail: measured on macOS 15 / tmux 3.7c. If a payload ever starts arriving short again, this
// number is the knob, and the line-count check is what will tell you.
export const PASTE_CHUNK_MAX = 2 * 1024;
export function chunkPayload(text, max = PASTE_CHUNK_MAX) {
  const s = String(text ?? '');
  const cap = Math.max(1, Math.trunc(max) || PASTE_CHUNK_MAX);
  if (s.length <= cap) return [s];
  const lines = s.split('\n');
  const units = lines.map((l, i) => (i < lines.length - 1 ? `${l}\n` : l));
  const parts = [];
  let cur = '';
  for (let u of units) {
    while (u.length > cap) {
      if (cur) { parts.push(cur); cur = ''; }
      parts.push(u.slice(0, cap));
      u = u.slice(cap);
    }
    if (!u) continue;
    if (cur.length + u.length > cap) { parts.push(cur); cur = ''; }
    cur += u;
  }
  if (cur) parts.push(cur);
  return parts;
}

// ------------------------------------------- v0.30: the outbox ----
// Every payload is written here BEFORE it is pasted and deleted only after a verified submit, so
// "I could not confirm it arrived" is never the same event as "it is gone". The name carries when
// it was written and who wrote it, because `/retry` has to be able to find the newest one that
// belongs to the person asking.
export const OUTBOX_DIR = 'outbox';
export const OUTBOX_KEEP = 20; // kept payloads; the oldest fall off, so a broken pane cannot fill a disk
export const OUTBOX_NAME_RE = /^(\d{10,16})-([A-Za-z0-9_-]{1,24})\.txt$/;
export function outboxSlug(name) {
  return String(name ?? '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'someone';
}
export function outboxName(ts, name) { return `${Math.trunc(Number(ts) || 0)}-${outboxSlug(name)}.txt`; }
export function parseOutboxName(file) {
  const m = OUTBOX_NAME_RE.exec(String(file ?? ''));
  return m ? { file: String(file), ts: Number(m[1]), name: m[2] } : null;
}
// Newest first, because that is the one `/retry` means.
export function outboxEntries(files = []) {
  return (files || []).map(parseOutboxName).filter(Boolean).sort((a, b) => b.ts - a.ts || a.file.localeCompare(b.file));
}
// The host may retry anybody's (they can see the room); everyone else only their own — a kept
// payload is somebody's unsent message, not shared state.
export function resolveOutbox(entries = [], who = null, isHost = false) {
  const slug = outboxSlug(who).toLowerCase();
  const mine = isHost ? entries : entries.filter((e) => e.name.toLowerCase() === slug);
  if (!mine.length) {
    return { ok: false, error: isHost ? 'nothing is kept — every message so far reached claude'
      : 'nothing of yours is kept — every message you sent reached claude' };
  }
  return { ok: true, entry: mine[0], count: mine.length };
}
export function outboxReport(entries = [], now = Date.now()) {
  if (!entries.length) return 'nothing is kept — every message so far reached claude';
  return [`${entries.length} message${entries.length > 1 ? 's' : ''} kept (newest first) — /retry sends the newest again:`,
    ...entries.map((e) => `  ${e.name} · ${uptimeText(Math.max(0, now - e.ts))} ago · ${e.file}`)].join('\n');
}
export function keptMessageText(file) {
  return `couldn't confirm your message reached claude — kept at ${file} · /retry to send it again`;
}

// --------------------------------------- v0.30: client-side input history ----
// Nothing here talks to the daemon: `↑`/`↓` walk what THIS client submitted, so anything typed can
// be recalled and re-sent whatever the daemon did with it. Consecutive duplicates collapse, blanks
// are never stored, and the newest is at index 0.
export const HISTORY_LIVE = 50; // what ↑/↓ walk in memory
export const HISTORY_FILE_MAX = 200; // what the file keeps
export function historyPush(list = [], text, max = HISTORY_LIVE) {
  const s = String(text ?? '').trim();
  if (!s) return list.slice(0, max);
  if (list[0] === s) return list.slice(0, max);
  return [s, ...list].slice(0, max);
}
// `idx` is -1 for "typing something new". Up walks towards older, down back towards the draft.
// The draft is handed back when you walk off the newest end, so ↑ then ↓ never eats what you typed.
export function historyMove(list = [], idx = -1, dir = 'up', draft = '') {
  if (!list.length) return { idx: -1, text: draft, moved: false };
  if (dir === 'up') {
    const next = Math.min(idx + 1, list.length - 1);
    return { idx: next, text: list[next], moved: next !== idx };
  }
  const next = idx - 1;
  if (next < 0) return { idx: -1, text: draft, moved: idx !== -1 };
  return { idx: next, text: list[next], moved: true };
}
// Where the file lives. XDG if it is set, `~/.config/claude-jam/history` otherwise — pure, so the
// clients (which are the only things that touch a disk here) decide when to read and write it.
export const HISTORY_FILE = 'history';
export function historyFilePath(home = os.homedir(), env = {}) {
  const base = env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME)
    ? env.XDG_CONFIG_HOME : path.join(home, '.config');
  return path.join(base, 'claude-jam', HISTORY_FILE);
}
export function parseHistoryFile(text) {
  return String(text ?? '').split('\n').map((l) => l.trim()).filter(Boolean).slice(-HISTORY_FILE_MAX);
}
// On disk oldest-first (a file people may `tail`); in memory newest-first.
export function serializeHistory(list = [], max = HISTORY_FILE_MAX) {
  const out = [...list].reverse().slice(-max);
  return out.length ? `${out.join('\n')}\n` : '';
}

// ================== v0.31: questions are not permissions — classify the CURRENT pane ====
// Observed live 2026-08-29 15:26: the status row said `waiting for permission` while the pane
// was showing an AskUserQuestion picker, and stayed up after the questions were answered. One
// `waiting` boolean, fed by the Notification hook whatever the prompt was, cleared only when the
// next assistant record happened to arrive. So: the STATUS is whatever the screen says.
//
// Measured against claude 2.1.251 (the captures in fixtures/pane/). An AskUserQuestion picker
// draws a checkbox header, its question, its options with a description under each, and a
// "Type something." free-text option; a permission prompt draws the tool's name, the command,
// "Do you want to proceed?" and Yes/Yes-always/No. With several questions the header becomes a
// tab bar whose answered tabs flip from an empty box to a crossed one, focus advancing to the
// first unanswered on its own. See fixtures/pane/question-*.txt and permission-bash.txt.
export const PROMPT_KINDS = ['none', 'question', 'permission', 'dialog'];
const TAB_GLYPH_RE = /[☐☑☒]/; // empty / checked / crossed ballot box
const TAB_ITEM_RE = /^([☐☑☒])\s*(.+)$/;
const Q_FREETEXT_RE = /^(?:type something|other)\b/i;
const Q_NAV_RE = /to navigate/i;
const PROMPT_LOOKUP = 14; // rows above option 1 that can still be this prompt's own chrome
// The dialogs that need a human at the real keyboard: no numbered options to relay, so no digit
// jam could ever safely type. Scanned over the bottom of the screen only - the same words in a
// transcript further up are somebody talking about a dialog, not a dialog.
const DIALOG_RE = /trust this folder|is this a project you created|choose the text style|select login method|enter to confirm/i;
const DIALOG_ROWS = 20;
const FIRST_OPTION_RE = /^(?:[❯▶>*]\s*)?([1-9])[.)]\s+\S/;

function tabsFromRow(row) {
  return String(row ?? '').split(/\s{2,}/).map((s) => s.trim()).filter(Boolean)
    .map((s) => TAB_ITEM_RE.exec(s)).filter(Boolean)
    .map((m) => ({ title: m[2].trim().slice(0, PERM_TEXT_MAX), done: m[1] !== '☐' }));
}

const blankPrompt = (kind) => ({ kind, header: '', question: '', options: [], tabs: [], focus: null, sig: kind });

export function classifyPrompt(screen) {
  const lines = (Array.isArray(screen) ? screen : String(screen ?? '').split('\n'))
    .map((r) => String(r).replace(/\s+$/, ''));
  const options = parsePermOptions(lines.join('\n'));
  if (!options.length) {
    const tail = lines.slice(-DIALOG_ROWS).join('\n');
    return DIALOG_RE.test(tail) ? blankPrompt('dialog') : blankPrompt('none');
  }
  // Where the block starts on screen, so its own chrome can be read and nothing above it can.
  // parsePermOptions already picked the BOTTOM-most numbered block, so the last `1.` is its.
  let first = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    const m = FIRST_OPTION_RE.exec(lines[k].replace(PERM_BOX_RE, ''));
    if (m && Number(m[1]) === 1) { first = k; break; }
  }
  if (first < 0) first = 0;
  const above = lines.slice(Math.max(0, first - PROMPT_LOOKUP), first);
  const tabRow = [...above].reverse().find((l) => TAB_GLYPH_RE.test(l)) || '';
  const tabs = tabsFromRow(tabRow);
  const footer = lines.slice(first, first + options.length * 3 + 6).join('\n');
  const free = options.map((o) => Q_FREETEXT_RE.test(o.text));
  // Any ONE of the three is enough. A picker with none of them is treated as a permission, which
  // is the safe way to be wrong: the worst case is that the host has to approve a question.
  const isQuestion = tabs.length > 0 || free.some(Boolean) || Q_NAV_RE.test(footer);
  const kind = isQuestion ? 'question' : 'permission';
  const question = [...above].reverse()
    .find((l) => l.trim() && !RULE_ROW_RE.test(l.trim()) && !TAB_GLYPH_RE.test(l)) || '';
  const focus = tabs.length ? ((tabs.findIndex((t) => !t.done) + 1) || null) : (isQuestion ? 1 : null);
  const opts = options.map((o, i) => ({ ...o, free: free[i] }));
  const q = question.trim().slice(0, PERM_TEXT_MAX * 2);
  return {
    kind,
    // A question's header is the tab it is focused on; the review step at the end of a form has
    // no focused tab, and naming the last one there would be a lie ("Shell" for "Ready to submit?").
    header: (isQuestion ? (focus ? (tabs[focus - 1]?.title ?? '') : '') : headerRow(lines, first)).trim(),
    question: q,
    options: opts,
    tabs,
    focus,
    sig: promptSig(kind, q, opts, focus),
  };
}

// A permission prompt names its tool on the first row inside the rule that opens it.
function headerRow(lines, first) {
  if (first < 1) return '';
  for (let k = first - 1; k >= Math.max(0, first - PROMPT_LOOKUP); k--) {
    if (!RULE_ROW_RE.test(lines[k].trim())) continue;
    for (let j = k + 1; j < first; j++) if (lines[j].trim()) return lines[j].trim();
    return '';
  }
  return '';
}

// The identity of THIS prompt: what it asks and what it offers. First-answer-wins is keyed on it,
// and so is "the screen changed under your answer" - a picker that advanced to its next question
// has a different signature, so the next answer is a fresh one rather than a stale duplicate.
export function promptSig(kind, question, options = [], focus = null) {
  return [kind, focus ?? '-', question, ...options.map((o) => `${o.n}:${o.text}`)].join('');
}

// What every client shows, in BOTH views, when claude is asking rather than requesting: the
// question, its options, and how to answer it. Free-text options are marked, because they are the
// one kind a guest cannot pick.
export function questionBlock(p = {}, { answers = 'anyone', host = false } = {}) {
  if (!p || p.kind !== 'question') return '';
  const many = (p.tabs || []).length > 1;
  const head = many
    ? `claude is asking (${p.focus ?? p.tabs.length} of ${p.tabs.length}${p.header ? ` · ${p.header}` : ''}): `
    : 'claude is asking: ';
  const canAnswer = answers !== 'host' || host;
  const rows = (p.options || []).map((o) => `  ${o.marked ? '❯' : ' '} ${o.n}. ${o.text}`
    + (o.free ? '  (the host types this one)' : ''));
  const how = canAnswer
    ? `answer it with /answer <1-${(p.options || []).length}>${many ? ' — or /answer <question> <n>' : ''}`
    : 'the host answers this one (--answers host) — /answer <n> asks them';
  return [`${head}${p.question || p.header}`, ...rows, how].join('\n');
}

// The status row, in one line, for whatever is on the pane right now. Distinct and honest per
// kind: v0.31's whole complaint was one wording for three different things.
export function promptStatusText(p = {}, { host = false, answers = 'anyone' } = {}) {
  const kind = p?.kind || 'none';
  if (kind === 'none') return '';
  if (kind === 'dialog') return '⚠ claude needs the host at the keyboard — F3';
  if (kind === 'permission') {
    return `⚠ waiting for permission${p.header ? ` (${p.header})` : ''}`
      + (host ? ' — F3 attaches the TUI (F3 or Ctrl-b d back)' : ' — /answer shows the options');
  }
  const q = (p.question || p.header || '').split('\n')[0];
  const tail = answersMode(answers) === 'host' && !host ? ' — the host answers' : ' — /answer <n>';
  return `⚠ claude is asking: ${q}${tail}`;
}

// `--answers host|anyone`, and the one place that decides. A question is a product decision, so
// anyone may answer it; a permission is a security grant, so it stays on the host's ladder; and
// typing free text into the TUI is raw keyboard access, so it stays the host's whatever the mode.
export const ANSWERS_MODES = ['anyone', 'host'];
export function answersMode(v) { return ANSWERS_MODES.includes(String(v ?? '')) ? String(v) : 'anyone'; }
export function answerDecision({ kind = 'none', host = false, answers = 'anyone', free = false } = {}) {
  if (kind === 'question') {
    if (host) return 'run';
    if (free) return 'ask'; // the host sees the text before it is typed
    return answersMode(answers) === 'anyone' ? 'run' : 'ask';
  }
  if (kind === 'permission') return host ? 'run' : 'ask';
  return 'refuse';
}

// `/answer 2`, `/answer 1 2` (question 1, option 2), `/answer other <text>` - parsed here so the
// client, the daemon and the docs cannot drift apart. A digit is the only thing ever typed into a
// picker, and `other` is the only thing that is not a digit.
export const ANSWER_USAGE = 'usage: /answer (show the options) | /answer <1-9> | '
  + '/answer <question> <1-9> | /answer other <text> (host)';
export const ANSWER_TEXT_MAX = 400;
export function parseAnswerCommand(rest) {
  const t = String(rest ?? '').trim();
  if (!t) return { ok: true, choice: null, q: null };
  const other = /^other\s+(\S[\s\S]*)$/i.exec(t);
  if (other) {
    const text = other[1].trim().slice(0, ANSWER_TEXT_MAX);
    return text ? { ok: true, choice: 'other', text, q: null } : { ok: false, error: ANSWER_USAGE };
  }
  if (/^other$/i.test(t)) return { ok: false, error: 'usage: /answer other <what to type>' };
  const two = /^([1-9])\s+([1-9])$/.exec(t);
  if (two) return { ok: true, q: Number(two[1]), choice: Number(two[2]) };
  if (/^[1-9]$/.test(t)) return { ok: true, q: null, choice: Number(t) };
  return { ok: false, error: ANSWER_USAGE };
}

// Which question a `/answer <q> <n>` is aimed at, against the form that is actually on screen.
// Only the focused one can be answered: moving between tabs is a Tab keypress, i.e. raw keyboard,
// which is exactly what a guest never gets. Refusing says which one is up rather than guessing.
export function resolveAnswerTarget(p = {}, q = null) {
  const tabs = p?.tabs || [];
  const focus = p?.focus ?? null;
  if (q == null) return { ok: true, q: focus };
  if (!tabs.length) {
    return q === 1 ? { ok: true, q: 1 }
      : { ok: false, error: 'claude is asking one question, so /answer <n> is the whole of it' };
  }
  if (q > tabs.length) {
    return { ok: false, error: `claude is asking ${tabs.length} question${tabs.length > 1 ? 's' : ''}, so there is no question ${q}` };
  }
  if (q !== focus) {
    const name = tabs[q - 1]?.title || `question ${q}`;
    const up = tabs[(focus || 1) - 1]?.title || '—';
    return { ok: false, error: `question ${focus ?? '?'} (${up}) is the one on screen — `
      + `${name} comes next, and only the host can Tab between them (F3)` };
  }
  return { ok: true, q };
}

// First answer wins. The lock is the prompt's signature, so it lifts on its own the moment the
// picker moves on - no timer, no cleanup, and a form's second question is a fresh question.
export function answerLock(state = {}, sig = '', who = '') {
  if (state.sig === sig && state.by) return { ok: false, by: state.by };
  return { ok: true, state: { sig, by: who } };
}

// ================================================================================
// v0.22A / v0.24 — the menus.  `claude-jam` with no arguments is a launcher menu,
// `/menu` in a client is the live control panel, and both are built from THIS file:
// the argv the launcher will run, the rows a relay switch may offer, and the tree of
// everything a jam can do.  Nothing here does I/O, so a test can walk the whole
// product surface — which is exactly what the completeness check (menuGaps) does.
// ================================================================================

// How people get in.  `invite` is invite-links-only: a knock is refused outright, so a
// link (or the host minting one) is the ONLY door.
export const ACCESS_MODES = ['knock', 'token', 'invite'];
// Where the jam is reachable from.  One at a time — two relays for one port is a
// startup error, and the runtime switch keeps that rule.
export const REMOTE_MODES = ['off', 'tunnel', 'funnel'];

export function accessMode(v) { return ACCESS_MODES.includes(String(v ?? '')) ? String(v) : 'knock'; }
// `none` is accepted as a spelling of `off` — the launcher menu's row used to read that way,
// and a flag that means the same thing must not be a usage error.
export function remoteMode(v) {
  const t = String(v ?? '');
  if (t === 'none') return 'off';
  return REMOTE_MODES.includes(t) ? t : 'off';
}

// A word for a shell.  Single quotes unless there is one inside, in which case the
// whole thing goes in double quotes — the menu PRINTS the command it is about to run,
// so a path with a space has to come back as something a human can paste.
export function shellQuote(word) {
  const s = String(word ?? '');
  if (s === '') return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
  return s.includes("'") ? `"${s.replace(/(["\\$`])/g, '\\$1')}"` : `'${s}'`;
}

export function hostCommandLine(argv = [], bin = 'claude-jam') {
  return [bin, ...argv].map(shellQuote).join(' ');
}

// The Host screen's whole output: the argv `claude-jam host` is given, and the exact
// command line that argv spells.  The menu never runs anything it did not print first,
// and it never builds a second code path — this is the one place the fields become flags.
export function hostPlan(form = {}) {
  const cwd = String(form.cwd ?? '').trim();
  const name = String(form.name ?? '').trim();
  const jamName = String(form.jamName ?? '').trim();
  const access = accessMode(form.access);
  const token = String(form.token ?? '').trim();
  const remote = remoteMode(form.remote);
  const extra = String(form.extra ?? '').trim();
  if (name && !validName(name)) {
    return { ok: false, error: 'bad name: 1-24 chars of letters, digits, space, _ or -' };
  }
  if (access === 'token' && !validTokenValue(token)) {
    return { ok: false, error: 'a token is 8-64 chars of [A-Za-z0-9_-] — or pick knock / invite-only' };
  }
  if (jamName && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/.test(jamName)) {
    return { ok: false, error: 'the jam name is a tmux session name: letters, digits, _ . -' };
  }
  const argv = ['host'];
  if (cwd) argv.push('--cwd', cwd);
  if (name) argv.push('--name', name);
  if (jamName) argv.push('--tmux', jamName);
  if (access === 'token') argv.push('--token', token);
  if (access === 'invite') argv.push('--invite-only');
  if (remote === 'tunnel') argv.push('--tunnel');
  if (remote === 'funnel') argv.push('--funnel');
  if (form.view) argv.push('--view');
  // Everything after `--` is claude's, verbatim, exactly as it would be typed.
  if (extra) argv.push('--', ...extra.split(/\s+/));
  return { ok: true, argv, command: hostCommandLine(argv) };
}

// The Join screen.  A link carries the address, the name and the secret, so the name and
// token fields exist only for the other case — a bare ws:// URL.
export function parseJoinInput(text) {
  const t = String(text ?? '').trim();
  if (!t) return { ok: false, kind: 'empty', error: 'paste an invite link (cjam1_…) or a ws:// URL' };
  if (/^cjam\d/.test(t)) {
    const d = decodeInvite(t);
    // An EXPIRED link still has an address and a name in it, so it is still a usable join
    // (it becomes a knock).  Anything else has nothing to connect to.
    if (!d.invite) return { ok: false, kind: 'link', error: d.error };
    return { ok: true, kind: 'link', link: t, name: d.invite.name, warn: d.ok ? '' : d.error };
  }
  if (/^wss?:\/\//.test(t)) return { ok: true, kind: 'url', url: t };
  return { ok: false, kind: 'unknown',
    error: 'that is neither an invite link (cjam1_…) nor a ws:// URL' };
}

export function buildJoinArgv(form = {}) {
  const v = parseJoinInput(form.input);
  if (!v.ok) return v;
  if (v.kind === 'link') return { ok: true, argv: ['join', v.link], command: hostCommandLine(['join', v.link]), warn: v.warn };
  const name = String(form.name ?? '').trim();
  if (!validName(name)) return { ok: false, error: 'a ws:// URL needs a name: 1-24 chars of letters, digits, space, _ or -' };
  const token = String(form.token ?? '').trim();
  if (token && !validTokenValue(token)) return { ok: false, error: 'token must be 8-64 chars of [A-Za-z0-9_-]' };
  const argv = ['join', v.url, '--name', name, ...(token ? ['--token', token] : [])];
  return { ok: true, argv, command: hostCommandLine(argv) };
}

// ------------------------------------------- v0.24.1: the relay rows and the switch ----

// One row per remote mode, each carrying WHY it cannot be picked and the exact fix.  The
// launcher greys the disabled ones; `/menu → Access → Remote` shows the same reasons inline,
// so a precondition is never silence.  `funnel` is funnelPrecheck()'s verdict, which already
// distinguishes "no tailscale CLI" from "Funnel is not enabled for this tailnet".
export function remoteRows({ cloudflared = false, funnel = null } = {}) {
  const f = funnel || { ok: false, error: 'Tailscale Funnel was not checked' };
  return [
    { value: 'off', label: 'off — LAN / Tailscale addresses only', disabled: false, reason: '' },
    { value: 'tunnel',
      label: 'tunnel — cloudflared quick tunnel (new URL on every restart)',
      disabled: !cloudflared,
      reason: cloudflared ? '' : 'cloudflared is not on PATH — fix: brew install cloudflared' },
    { value: 'funnel',
      label: 'funnel — Tailscale Funnel (same URL across restarts)',
      disabled: !f.ok,
      // The tailnet name comes along when it is known: a runtime switch to funnel has no
      // launch-time precheck of its own to read it from.
      dns: f.dns || null,
      reason: f.ok ? '' : String(f.error || 'Tailscale Funnel is not available') },
  ];
}

// What a relay switch actually has to do.  Pure, because the interesting half is the
// refusals: an unavailable target, an unknown mode, and the no-op that must not tear a
// working tunnel down and put an identical one back up.
export function relaySwitchDecision({ from = 'off', to = 'off', rows = null } = {}) {
  const cur = remoteMode(from);
  if (!REMOTE_MODES.includes(String(to)) && String(to) !== 'none') {
    return { ok: false, error: `remote is one of ${REMOTE_MODES.join(' | ')}, not ${JSON.stringify(String(to).slice(0, 20))}` };
  }
  const next = remoteMode(to);
  const row = (rows || []).find((r) => r.value === next);
  if (row?.disabled) return { ok: false, error: row.reason || `${next} is not available here` };
  if (cur === next) return { ok: true, action: 'noop', from: cur, to: next };
  if (next === 'off') return { ok: true, action: 'stop', from: cur, to: next };
  return { ok: true, action: cur === 'off' ? 'start' : 'switch', from: cur, to: next };
}

// ---------------------------------------- v0.24b: saying which invite line is current ----

const hhmm = (now) => new Date(now).toTimeString().slice(0, 5);

// v0.24b: `/join` used to APPEND another copy of the invite lines, so a log that had already
// seen two of them ended up with three near-identical blocks and no way to tell which was
// live.  One block now: a heading with the time on it, the current lines, and — only when
// something was printed before — one dim line saying the older ones are stale.
export function joinBlock(info = {}, { now = Date.now(), hadEarlier = false, width = ONBOARD_W } = {}) {
  const head = `── invite ${hhmm(now)} ${'─'.repeat(Math.max(3, width - 16))}`;
  // No address at all is its own answer: `inviteLines` would still return the knock hint, which
  // reads like a working invite when there is nothing to send anybody.
  const body = info.join || info.tunnelJoin
    ? inviteLines(info)
    : ['nothing to hand out yet — no address resolved'];
  return [head, ...body, ...(hadEarlier ? ['(earlier invite lines above are stale)'] : [])];
}

// At boot with --tunnel/--funnel the hostname is ~10s away, so the welcome says what is
// pending instead of printing a LAN-only line that is about to be wrong.
export function relayPendingLine(mode) {
  const m = remoteMode(mode);
  return m === 'off' ? null : `${m}: starting…`;
}

// v0.24b: a relay coming up is an EVENT, not a silent state refresh.  One line, the join
// command already in it, so the host can send it without asking anything else.
export function relayReadyLine(mode, joinLine, { changed = false } = {}) {
  const m = remoteMode(mode);
  if (m === 'off' || !joinLine) return null;
  return `${m} ${changed ? 'moved' : 'ready'}: ${joinLine}`;
}

// ------------------------------------------------ v0.24.2: the menu tree ----

// Every jam command, with the one line the menu shows next to it.  This is the list the
// completeness test walks: a command in JAM_COMMANDS with no entry here is a menu gap, and
// the test fails rather than letting a feature ship that `/menu` cannot reach.
export const COMMAND_HELP = {
  '/c': 'say something to the humans only — claude never sees it',
  '/who': 'who is in the jam right now',
  '/help': 'the onboarding block: the keys and the commands you use most',
  '/menu': 'this panel — every feature, its state, and one key to run it',
  '/quit': 'leave the jam (the jam keeps running)',
  '/exit': 'leave the jam (the jam keeps running)',
  '/mirror': 'flip between the live TUI and the transcript (same as F2)',
  '/tools': "the last turn's tool calls · /tools on|off to stop collapsing them",
  '/join': 'print the current invite lines, with the time they were printed',
  '/accept': 'let a knocking guest in · /accept <name>',
  '/deny': 'turn a knocking guest away · /deny <name>',
  '/token': 'the shared token: /token new | set <v> | off | invite-only on|off',
  '/remote': 'go remote, or come back: /remote off | tunnel | funnel',
  '/allow-cmd': "run a guest's claude command · add `always` for standing approval",
  '/deny-cmd': "refuse a guest's claude command",
  '/export': 'take the session transcript home (a guest asks the host first)',
  '/allow-export': 'let a guest have the transcript · `always` makes it standing',
  '/deny-export': 'refuse a guest the transcript',
  '/send': 'offer a file to the jam · /send <path>',
  '/paste': "send the clipboard's image · /paste <caption>",
  '/get': 'take a file somebody offered · /get <name>',
  '/accept-file': "accept a guest's upload · `always` makes it standing",
  '/deny-file': "refuse a guest's upload",
  '/files': 'the files this session has touched, newest first',
  '/diff': "git's answer about them · /diff <path> for one",
  '/answer': 'answer what claude is asking · /answer <n> | <q> <n> | other <text>',
  '/allow-perm': "type a guest's answer into a permission prompt · `always` makes it standing",
  '/deny-perm': "refuse a guest's answer to a permission prompt",
  '/outbox': 'messages the daemon kept when it could not confirm they landed',
  '/retry': 'send the newest kept message again',
  '/end': 'end the jam for everybody — the daemon, the TUI, the tmux session',
  '/invite': 'mint a link that joins with no approval · /invite <Name> [--uses N]',
  '/invites': 'every link: id, name, state, uses, expiry',
  '/kick': 'remove somebody already in · /kick <name> [revoke]',
};

// Which of them belong to the host.  Everything else is a guest's, and the guest menu lists
// EXACTLY that — enforced by the same completeness test, in both directions.
export const HOST_MENU_ONLY = ['/join', '/accept', '/deny', '/token', '/remote', '/allow-cmd',
  '/deny-cmd', '/allow-export', '/deny-export', '/accept-file', '/deny-file',
  '/allow-perm', '/deny-perm', '/end', '/invite', '/invites', '/kick'];

export function guestCommands(commands = JAM_COMMANDS) {
  return commands.filter((c) => !HOST_MENU_ONLY.includes(c));
}

// The `claude-jam host` flags the docs promise.  Same rule as the commands: a flag listed
// here has to be reachable from the menu with a description, so `/menu → Help & guides`
// is a true index of the launcher rather than a subset somebody remembered.
export const HOST_FLAGS = [
  { flag: '--port', arg: 'N', desc: 'which port the daemon listens on (default 7777)' },
  { flag: '--name', arg: 'X', desc: 'your display name in the jam' },
  { flag: '--cwd', arg: 'DIR', desc: 'the directory claude runs in' },
  { flag: '--tmux', arg: 'NAME', desc: "the jam's name — its tmux session, and what `claude-jam end` takes" },
  { flag: '--token', arg: 'V', desc: 'a shared token: anyone holding it joins with no approval' },
  { flag: '--invite-only', arg: '', desc: 'no knocking at all — an invite link is the only door' },
  { flag: '--view', arg: '', desc: 'also serve the real TUI read-only in a browser (ttyd)' },
  { flag: '--tunnel', arg: '', desc: 'cloudflared quick tunnel — reachable from anywhere, new URL each restart' },
  { flag: '--funnel', arg: '', desc: 'Tailscale Funnel — reachable from anywhere, stable URL' },
  { flag: '--config-dir', arg: 'D', desc: 'which claude profile/account the TUI runs as' },
  { flag: '--tmux-socket', arg: 'default', desc: "put the jam on your own tmux server instead of jam's" },
  { flag: '--no-system-prompt', arg: '', desc: 'do not append the shared-session contract to claude' },
  { flag: '--answers', arg: 'host|anyone', desc: 'who may /answer a question claude asks' },
  { flag: '--replay', arg: 'N', desc: 'how much of the transcript on disk a joining guest is shown' },
  { flag: '--attach', arg: '', desc: 'reopen your client on a jam that is already running' },
  { flag: '--no-prompt', arg: '', desc: 'do not ask on exit whether to keep the jam running' },
  { flag: '--end-on-exit', arg: '', desc: 'end the jam when your client exits' },
  { flag: '--keep-on-exit', arg: '', desc: 'keep the jam running when your client exits' },
  { flag: '--no-menu', arg: '', desc: 'skip the launcher menu (any argument already does)' },
];

// The keyboard, in one place, because it is the half no command list can teach.
export const KEY_HELP = [
  { key: 'F2', desc: 'flip between the live TUI and the transcript' },
  { key: 'F3', desc: 'host: attach the real TUI · F3 again (or Ctrl-b d) comes back' },
  { key: 'Shift+Enter', desc: 'a newline instead of a send (Alt+Enter and a trailing \\ do the same)' },
  { key: '↑ / ↓', desc: 'recall what you sent' },
  { key: 'a / d', desc: 'host: answer the ⚑ approval bar without typing a command' },
  { key: 'Esc', desc: 'dismiss the approval bar · Esc again re-arms the single keys' },
  { key: 'Ctrl-C', desc: 'leave the client (the jam keeps running)' },
];

export const WIKI_PAGES = ['Install', 'Hosting', 'Joining-a-Jam', 'Remote-Access',
  'Files-and-Export', 'Security-Model', 'Troubleshooting'];

// The manual `/menu → Help & guides` renders inline. It is the SAME file claude is given
// (v0.8), which is the point: a human and the agent read one source, so an answer from one
// cannot contradict the other.
export const MANUAL_FILE = 'MANUAL.md';

// `/menu` runs a command with one key when the command means something on its own, and puts it
// on the input line when it needs an argument. Derived from the parser rather than from a list
// somebody has to remember: if `parseClientLine('/kick')` is a usage error, `/kick` needs typing.
export function menuRunsBare(cmd) {
  const t = String(cmd ?? '').trim();
  if (!t.startsWith('/')) return false; // not a command at all, so never something to "run"
  const a = parseClientLine(t);
  return a.kind !== 'error' && a.kind !== 'say';
}

const cmdItem = (c) => ({ id: `cmd${c}`, label: c, desc: COMMAND_HELP[c] || '', covers: [c], run: c });

// The whole control panel as data.  `state` is what the client knows right now, so every
// toggle can show its own value and the menu doubles as the status page.  Host and guest are
// one builder: a guest simply gets the sections a guest may act on.
export function menuTree({ host = true, state = {} } = {}) {
  const s = state || {};
  const val = (v) => (v == null || v === '' ? '—' : String(v));
  const people = (s.roster || []).length;
  const guestOnly = guestCommands();
  const sections = [];

  if (host) {
    sections.push({
      id: 'people', title: 'People', desc: `who is here, and everything waiting on you (${people} connected)`,
      items: [
        { id: 'people.who', label: 'Who is here', desc: COMMAND_HELP['/who'], covers: ['/who'], run: '/who',
          value: (s.roster || []).join(', ') || '—' },
        { id: 'people.pending', label: 'Answer what is waiting', covers: ['/accept', '/deny', '/allow-cmd', '/deny-cmd', '/allow-export', '/deny-export', '/accept-file', '/deny-file', '/allow-perm', '/deny-perm'],
          desc: 'approve or refuse every pending knock, command, upload, export and permission',
          value: `${(s.pending || []).length} waiting` },
        { id: 'people.grants', label: 'Standing approvals', covers: [],
          desc: "every `always` grant a guest holds, listed and individually revocable",
          value: `${(s.grants || []).length} granted` },
        { id: 'people.kick', label: 'Remove somebody', desc: COMMAND_HELP['/kick'], covers: ['/kick'], run: '/kick' },
      ],
    });
    sections.push({
      id: 'invites', title: 'Invites', desc: 'links that join with no approval — each one is a password',
      items: [
        { id: 'invites.new', label: 'Create a link', desc: COMMAND_HELP['/invite'], covers: ['/invite'], run: '/invite' },
        { id: 'invites.list', label: 'List links', desc: COMMAND_HELP['/invites'], covers: ['/invites'], run: '/invites' },
        { id: 'invites.copy', label: 'Copy the last link', covers: [],
          desc: 'put the guest command on your clipboard, ready to send privately' },
        { id: 'invites.revoke', label: 'Revoke a link', covers: [],
          desc: 'take one back — it can never let anybody in again' },
        { id: 'invites.reissue', label: 'Re-issue every link', covers: [],
          desc: 'after a relay change: mint a new link for each live invite and revoke the old one' },
      ],
    });
    sections.push({
      id: 'access', title: 'Access', desc: 'the doors into this jam, and where it is reachable from',
      items: [
        { id: 'access.token', label: 'Shared token', desc: COMMAND_HELP['/token'], covers: ['/token'], run: '/token',
          value: s.token ? 'set' : 'off (friends knock)' },
        { id: 'access.inviteonly', label: 'Invite-only', covers: [],
          desc: 'refuse knocks outright, so an invite link is the only way in',
          value: s.inviteOnly ? 'on' : 'off' },
        { id: 'access.view', label: 'Browser view (ttyd)', covers: [],
          desc: 'serve the real TUI read-only in a browser tab',
          value: s.view ? val(s.view) : 'off' },
        { id: 'access.remote', label: 'Remote', desc: COMMAND_HELP['/remote'], covers: ['/remote'], run: '/remote',
          value: `${remoteMode(s.remote)}${s.tunnelJoin ? ' · up' : (remoteMode(s.remote) === 'off' ? '' : ' · starting…')}` },
        { id: 'access.join', label: 'Show the invite lines', desc: COMMAND_HELP['/join'], covers: ['/join'], run: '/join' },
      ],
    });
  }

  sections.push({
    id: 'session', title: 'Session',
    desc: host ? 'the work itself: what changed, what to take home, and ending it'
      : 'the work itself: what changed, and what to take home',
    items: [
      { id: 'session.files', label: 'Files touched', desc: COMMAND_HELP['/files'], covers: ['/files'], run: '/files' },
      { id: 'session.diff', label: 'Git diff', desc: COMMAND_HELP['/diff'], covers: ['/diff'], run: '/diff' },
      { id: 'session.export', label: 'Export the transcript', desc: COMMAND_HELP['/export'], covers: ['/export'], run: '/export' },
      { id: 'session.send', label: 'Send a file', desc: COMMAND_HELP['/send'], covers: ['/send'], run: '/send' },
      { id: 'session.paste', label: 'Send the clipboard image', desc: COMMAND_HELP['/paste'], covers: ['/paste'], run: '/paste' },
      { id: 'session.get', label: 'Take an offered file', desc: COMMAND_HELP['/get'], covers: ['/get'], run: '/get' },
      { id: 'session.tools', label: 'Tool calls', desc: COMMAND_HELP['/tools'], covers: ['/tools'], run: '/tools' },
      { id: 'session.answer', label: 'Answer claude', desc: COMMAND_HELP['/answer'], covers: ['/answer'], run: '/answer' },
      { id: 'session.chat', label: 'Humans-only chat', desc: COMMAND_HELP['/c'], covers: ['/c'], run: '/c' },
      { id: 'session.mirror', label: 'Live TUI ⇄ transcript', desc: COMMAND_HELP['/mirror'], covers: ['/mirror'], run: '/mirror' },
      { id: 'session.outbox', label: 'Kept messages', desc: COMMAND_HELP['/outbox'], covers: ['/outbox'], run: '/outbox' },
      { id: 'session.retry', label: 'Send a kept message again', desc: COMMAND_HELP['/retry'], covers: ['/retry'], run: '/retry' },
      { id: 'session.replay', label: 'Replay depth', covers: [],
        desc: 'how much of the transcript a joining guest is shown (--replay)',
        value: val(s.replay) },
      { id: 'session.attach', label: 'Attach the real TUI', covers: [],
        desc: host ? 'F3 hands your keyboard to claude — F3 again comes back' : 'host only: F3 attaches the real TUI' },
      ...(host ? [{ id: 'session.end', label: 'End the jam', desc: COMMAND_HELP['/end'], covers: ['/end'], run: '/end' }] : []),
      { id: 'session.leave', label: 'Leave', desc: COMMAND_HELP['/quit'], covers: ['/quit', '/exit'], run: '/quit' },
    ],
  });

  sections.push({
    id: 'help', title: 'Help & guides', desc: 'every command, every key, and the manual claude reads',
    items: [
      { id: 'help.manual', label: 'The manual (MANUAL.md)', covers: [],
        desc: 'the same text claude is given, rendered here — one source for the human and the agent' },
      // The keys only: the whole table is four wrapped rows in a Select, and the row exists to
      // be pressed. Every key still appears here, which is what the completeness test reads.
      { id: 'help.keys', label: 'Keyboard reference', covers: [],
        desc: `${KEY_HELP.map((k) => k.key).join(' · ')} — press for what each one does` },
      { id: 'help.onboard', label: 'Onboarding block', desc: COMMAND_HELP['/help'], covers: ['/help'], run: '/help' },
      { id: 'help.wiki', label: 'Wiki pages', covers: [],
        desc: WIKI_PAGES.join(' · ') },
      { id: 'help.commands', label: 'Every command', covers: [],
        desc: 'the whole list, with one line each and one key to run it',
        items: (host ? JAM_COMMANDS : guestOnly).map(cmdItem) },
      ...(host ? [{ id: 'help.flags', label: 'Host launch flags', covers: [],
        desc: 'what `claude-jam host` takes, and what each flag does',
        items: HOST_FLAGS.map((f) => ({ id: `flag${f.flag}`, label: `${f.flag}${f.arg ? ` ${f.arg}` : ''}`,
          desc: f.desc, covers: [], coversFlag: f.flag })) }] : []),
    ],
  });

  return { id: 'menu', title: host ? 'claude-jam — control panel' : 'claude-jam — what you can do', host, sections };
}

// Every item in the tree, sections and nested lists flattened. One walker, so the completeness
// check and the renderer agree about what "in the menu" means.
export function menuItems(tree) {
  const out = [];
  const walk = (items) => {
    for (const it of items || []) { out.push(it); if (it.items) walk(it.items); }
  };
  for (const sec of tree?.sections || []) { out.push(sec); walk(sec.items); }
  return out;
}

// v0.24.2: completeness, enforced instead of remembered.  Returns what the menu is MISSING —
// a jam command with no entry (or no description), a documented host flag with no entry, and
// for a guest, anything listed that a guest may not actually do.  The test asserts this is
// empty, so adding a command without a menu entry fails the suite rather than shipping.
export function menuGaps({ host = true, state = {} } = {}) {
  const tree = menuTree({ host, state });
  const items = menuItems(tree);
  const described = new Map();
  for (const it of items) {
    for (const c of it.covers || []) {
      if (String(it.desc || '').trim().length >= 8) described.set(c, it.id);
    }
  }
  const want = host ? JAM_COMMANDS : guestCommands();
  const commands = want.filter((c) => !described.has(c));
  const flags = host
    ? HOST_FLAGS.filter((f) => !items.some((it) => it.coversFlag === f.flag && String(it.desc || '').trim().length >= 8))
      .map((f) => f.flag)
    : [];
  // A guest menu must list EXACTLY what a guest may do: nothing host-only may leak in.
  const extra = host ? [] : [...described.keys()].filter((c) => HOST_MENU_ONLY.includes(c));
  return { commands, flags, extra };
}
