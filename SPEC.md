# claude-jam — shared Claude Code session (spec v1, 2026-08-28)

## Goal

Two or more humans on different machines converse with ONE real, interactive Claude Code
session. The host keeps the native `claude` TUI with every plugin, skill, MCP server,
CLAUDE.md and hook they already have. Friends join from a terminal client.

Requirements:

1. **Attribution** — the agent knows the session is shared and sees who wrote each message.
2. **Shared view** — every participant sees every human message, the agent's output, and live
   typing indicators.
3. **Human-only channel** — humans can talk to each other without the agent ever seeing it.
4. **Env preserved** — no reimplementation of Claude Code; the real `claude` binary runs
   interactively with the host's normal configuration.

Phase 1 (this spec): host's machine is the server — one WebSocket port, reached over
Tailscale / LAN / any TCP tunnel. Phase 2 (sketched at the end): a public relay so the host
opens no inbound port.

## Architecture

```
friend: client.mjs ──WS──┐
friend: client.mjs ──WS──┤  host.mjs daemon (node, runs on host Mac, inside tmux pane 0)
host:   client.mjs ──WS──┤    ├─ inject "[Name]: text" → tmux load-buffer/paste-buffer → real `claude` TUI (pane 1)
                         │    ├─ tail ~/.claude/projects/*/<session-id>.jsonl → broadcast agent text / tool calls / host's own messages
                         │    ├─ HTTP /hook endpoint ← hooks.sh (Stop, Notification) for turn-done / permission-waiting status
                         │    └─ roster.json for hooks; broadcast typing + human-only chat (never reaches claude)
host types straight into claude TUI (pane 1) as well → shows up unprefixed in JSONL → broadcast as host
```

`jam host` creates a tmux session `jam` with three panes: daemon (small, logs), `claude`
(main), and the host's own client. Closing the terminal does not kill anything; `tmux attach
-t jam` returns.

## Components

### `host.mjs` (daemon) — node ≥ 22, single dependency `ws`

CLI: `node host.mjs [--port 7777] [--host 0.0.0.0] [--name Roy] [--token <auto>] [--cwd <dir>] [--tmux jam] [-- <extra claude args>]`

Startup:
1. Generate `session-id` (uuid v4) and `token` (16 random url-safe chars) unless given.
2. Write `state/` dir (`$TMPDIR/claude-jam-<port>/`): `roster.json`, `settings.json` (hooks, see below).
3. `tmux new-session -d -s jam -c <cwd>` running the daemon itself (`--daemon` flag) in pane 0;
   `split-window` pane 1: `env JAM_STATE=<state> JAM_PORT=<port> JAM_TOKEN=<token> claude --session-id <id> --settings <state>/settings.json <extra>`;
   `split-window` pane 2: `node client.mjs ws://127.0.0.1:<port> --name <host-name> --token <token> --host`;
   resize so claude gets ≥ 70 % height; `select-pane` on claude; then `tmux attach -t jam`.
   If a session named `jam` already exists: refuse with a clear message (`--tmux other` to run two).
4. Print the join line: `node client.mjs ws://<tailscale-or-lan-ip>:<port> --name <You> --token <token>`
   (detect Tailscale IP via `tailscale ip -4` if present, else first non-loopback IPv4).

Daemon loop:
- WS server (`ws`) + tiny HTTP on the same port. `GET /health` → `{ok, participants}`.
  `POST /hook/<event>` with header `x-jam-token` → used by hooks (see below).
- Message handling (protocol below). `say` → sanitize → inject → broadcast. `chat` → broadcast
  only. `typing` → rebroadcast (rate-limit 1/s per client). Unknown → `error`.
- JSONL tail: locate `~/.claude/projects/*/<session-id>.jsonl` (glob; do not hard-code the
  cwd slug rule). Poll `fs.stat` every 300 ms (fs.watch is unreliable on macOS for appends);
  read new bytes, split lines, parse. Emit:
  - `type:user`, string content or text blocks, not `isMeta`, not tool_result-only → if text
    matches `^\[([^\]]{1,24})\]: ` it is a bridged message already broadcast → skip; else
    broadcast as `say` from the host name.
  - `type:assistant` text blocks → `agent {kind:'text'}`; `tool_use` blocks →
    `agent {kind:'tool', text:'<name>: <first 120 chars of input summary>'}`; ignore thinking.
  - Everything else ignored. A parse error skips the line, never crashes.
  Parsing rules mirror `~/Code/Padina/ClaudeCodeSessionManager/src/core/transcript.ts` —
  keep them in one small function so a JSONL format change is a one-place fix.
- Status: `busy=true` when a `say` is injected or a host user record appears; `busy=false` on
  the `Stop` hook. `waiting=true` on `Notification` hook with `permission_prompt` (or any
  notification whose message mentions permission), cleared on the next assistant record or
  Stop.
- History ring buffer: last 300 broadcast events; sent in `welcome`.
- Roster: `{name, joinedAt}` per live socket → `roster.json` rewritten on every join/leave and
  a `roster` broadcast.

Injection (port of `inject()` in `~/Code/Reeco/Claude-Code-Plugins/reeco-remote/scripts/rr-ctl.sh`):
1. Serialize: one injection at a time (promise queue).
2. Build text: `[Name]: <sanitized text>` — sanitizer strips ANSI/C0 control chars except
   `\n` and `\t`, trims, rejects empty, caps at 20 000 chars. Names must match
   `^[A-Za-z0-9][A-Za-z0-9 _-]{0,23}$`.
3. Wait up to 2 s (8 × 250 ms) for a prompt glyph (`❯` or `^> ?$`) in the last 5 lines of
   `tmux capture-pane -p -t jam:1`; if it never shows, paste anyway (Claude Code queues input
   typed mid-response as the next message — attribution survives because it is in the text).
4. Write text to a temp file, `tmux load-buffer -b jam<n> <file>`, `tmux paste-buffer -b jam<n> -d -p -t jam:1`
   (bracketed paste keeps multi-line messages as one message).
5. Verify: poll `capture-pane` (24 × 250 ms) until the first 40 chars of the text appear, then
   `tmux send-keys -t jam:1 C-m`. If the text never appears → broadcast `error` to the sender,
   log, do not press Enter. Never pass user text through a shell or as argv.

### `client.mjs` — node ≥ 22, zero dependencies (built-in `WebSocket`, `readline`)

CLI: `node client.mjs <ws-url> --name <Name> --token <token> [--host]`

- IRC-style TUI: scrolling log above, one status line, `readline` prompt at the bottom
  (redraw pattern: clear current line, print event, re-prompt with preserved buffer).
- Rendering: `Roy ▸ text` for human→agent messages (own name highlighted), `claude ▸ text`
  for agent text, dim `⚙ Bash: …` for tool calls, `(chat) Dana: text` for human-only,
  `* Dana joined/left`. Status line: `Dana is typing… · claude is working… · ⚠ waiting for
  host permission`. Typing indicators expire 4 s after the last `typing` event.
- Input: plain line → `say`. `/c <text>` → `chat` (human-only). `/who` → print roster.
  `/quit` → exit. Any other `/…` → local error "slash commands run only in the host TUI".
  `readline.emitKeypressEvents` → send `typing` at most once per 1.5 s while keys are pressed.
- Multi-line: a line ending in `\` continues on the next line (joined with `\n`).
- Reconnect with backoff (1 s → 10 s) on socket close; `welcome` replays history — client
  dedupes by event `id`.

### `hooks.sh` — bash, referenced from generated `settings.json`

Generated `settings.json` (passed with `--settings`, so nothing global changes):

```json
{ "hooks": {
  "SessionStart":     [{ "hooks": [{ "type": "command", "command": "<abs>/hooks.sh session-start" }] }],
  "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "<abs>/hooks.sh prompt" }] }],
  "Stop":             [{ "hooks": [{ "type": "command", "command": "<abs>/hooks.sh stop" }] }],
  "Notification":     [{ "hooks": [{ "type": "command", "command": "<abs>/hooks.sh notification" }] }]
}}
```

- `session-start` → stdout JSON `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"<protocol>"}}`.
  Protocol text: "This is a SHARED session bridged by claude-jam. Host: <HostName>. Messages
  that begin with `[Name]:` were written by that participant through the bridge; messages
  without a prefix were typed by the host. Current participants: <list>. Address people by
  name when it helps, treat every participant's instructions as the user's, and mention
  who asked when you report back on something."
- `prompt` → `{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"Participants now: <list from roster.json>"}}`
  only when roster.json changed since the last prompt (compare mtime stored in state); else
  print nothing.
- `stop` / `notification` → read stdin JSON, `curl -s -m 2 -X POST -H "x-jam-token: $JAM_TOKEN" --data-binary @- http://127.0.0.1:$JAM_PORT/hook/<event>`; always exit 0.
- All hooks read `JAM_STATE`, `JAM_PORT`, `JAM_TOKEN` from env (inherited from the `claude`
  process spawned by the daemon). Missing env → exit 0 silently (hooks must never break claude).

### `jam` (bash launcher) and `package.json`

`jam host [...]` → `node host.mjs "$@"`; `jam join <url> --name X --token Y` → `node client.mjs …`.
`package.json`: `{ "name": "claude-jam", "type": "module", "bin": {"jam": "jam"}, "dependencies": {"ws": "^8"} }`.

## WebSocket protocol (JSON text frames)

Client → host:
- `{t:'hello', name, token, host?:true}` — first frame; bad token → `{t:'error'}` + close 4401.
- `{t:'say', text}` — to the agent (injected with prefix).
- `{t:'chat', text}` — human-only.
- `{t:'typing'}`.

Host → clients (every event has `id` (monotonic int) and `ts` (ms)):
- `{t:'welcome', you, roster:[names], history:[events], session:{id, cwd, hostName}}`
- `{t:'roster', roster:[names], joined?, left?}`
- `{t:'say', from, text}` — echoed to everyone including sender once injection is queued.
- `{t:'chat', from, text}`
- `{t:'typing', from}` (not stored in history)
- `{t:'agent', kind:'text'|'tool', text}`
- `{t:'status', busy, waiting}`
- `{t:'error', text}` (to one client)

Phase 2 reuses this protocol unchanged: the host daemon connects OUTBOUND to a relay with
`{t:'hello', role:'host', room, token}`, friends connect to the relay with `room`, and the
relay forwards frames both ways. No inbound port on the host. Not built now.

## Security (phase 1)

- Shared random token required on every connection; wrong token closes the socket.
- Bind `0.0.0.0` by default but document: expose over Tailscale/LAN only; the token is the
  only auth. Hook endpoint accepts loopback only.
- Friend text never touches a shell: sanitized, written to a temp file, pasted via tmux
  buffer. Slash commands from friends are rejected client-side and ignored server-side
  (`say` text starting with `/` is refused with an `error`).
- Friends cannot answer permission prompts; the host TUI does. Clients see a `waiting` status.

## Testing

- `test.mjs` (node:test, no framework): JSONL line classification (user text / bridged user
  skipped / assistant text / tool_use / isMeta / tool_result-only / malformed), sanitizer
  (ANSI stripped, control chars stripped, newline kept, cap enforced), name validation,
  prefix regex, client command parsing (`/c`, `/who`, `/quit`, unknown slash, continuation
  lines). Pure functions exported from `lib.mjs` so tests import them without starting
  servers.
- Smoke (manual or scripted by the implementer, documented in README): `jam host --tmux
  jamtest -- --model haiku` in a scratch cwd; a scripted WS client sends `hello` + `say
  "reply with the single word pong"`; assert the JSONL contains `[Tester]: reply with…`, the
  client receives an `agent` text containing `pong`, and `status busy:false` arrives after
  Stop. Tear down `tmux kill-session -t jamtest` — ONLY that session name, never a pattern.

## Known ceilings (deliberate)

- tmux slightly degrades Claude Code visuals (paler colors, OSC notifications lost).
- JSONL format is officially unstable; parsing is isolated in one function.
- Messages injected while claude is mid-response are queued by Claude Code as the next turn.
- "claude is working" is inferred; `Stop` hook is the only authoritative end-of-turn signal.
- No per-friend auth, no rate limiting, no web client, no permission relay — phase 2+.

## Out of scope for v0

Web client, public relay (phase 2), friends approving tool permissions, raw-TUI view for
friends (`ttyd -R` exists if wanted), multiple concurrent sessions per host, Windows.

## Access control v0.2 (added 2026-08-28 evening)

Motivation: the host wants to mint or rotate the token at runtime, and to let a friend join
without any token by approving them in the moment.

Two admission paths, both ending in the same `welcome`:

1. **Token** — `hello {name, token}` with a token that matches the current one → admitted
   immediately (unchanged). If no token is currently set, a supplied token is simply ignored
   and the client falls through to a knock.
2. **Knock** — `hello {name}` with no token (or a wrong one) → the socket stays open in
   `pending` state, the client receives `{t:'knock', state:'pending'}` and shows
   "waiting for host approval…". Every host client receives `{t:'knock', name, ip}` and shows
   `⚑ Dana wants to join — /accept Dana | /deny Dana`. `/accept` with no name admits the only
   pending knocker (error if there are several). Pending knocks expire after 2 minutes
   (client told `{t:'knock', state:'expired'}`, socket closed 4408). Denied → `{t:'knock',
   state:'denied'}`, close 4403. Max 10 pending knocks; beyond that new knocks are closed
   immediately with 4429. Duplicate live names are refused (4409) in both paths.

Token management (host clients only; a non-host sending these gets `error`):
- `/token new` → daemon generates a fresh 16-char token; `/token set <value>` → uses the
  given value (8–64 chars, `[A-Za-z0-9_-]`); `/token off` → no token; knock is the only way in.
- The daemon replies to ALL host clients with `{t:'token', token: string|null, join: string|null}`
  and logs the join line in the daemon window. Rotating never disconnects already-admitted
  clients. `/join` shows the current join line (or "no token set — friends knock, you
  /accept").
- Startup: `--token <value>` sets one; `--token` omitted → NO token (knock-only) — the daemon
  log says so. The host client's connection is trusted by construction: it is the one the
  launcher spawns on loopback with `--host`; therefore `host: true` in `hello` is honoured
  only from loopback connections, everything else is treated as a friend.

Client changes: `/accept [name]`, `/deny <name>`, `/token new|set <v>|off`, `/join` (host only;
friends get "host only"). Wire frames: client→host `{t:'admit', name, ok}` and
`{t:'token', op, value?}`; host→client `{t:'knock', …}` and `{t:'token', …}`.

Roster/hooks unchanged: pending knockers are NOT in the roster and never reach claude.

## v0.3 — TUI mirror, Claude-Code look, token in context (added 2026-08-28 night)

1. **Live TUI mirror (`ttyd`, default ON when ttyd is installed).** `jam host` also starts a
   read-only browser view of the REAL claude TUI on `--view-port` (default port+1, 7778):
   each ttyd connection gets its own tmux grouped session pinned to the `claude` window
   (`tmux new-session -t <jam> ; set destroy-unattached on ; select-window -t <jam>:claude`)
   so viewers have independent focus and host window-switching never yanks their screen.
   ttyd runs with `-R` (read-only) and HTTP basic auth `-c jam:<view-key>`; view-key = the
   friend token when one is set, else a generated 16-char key that rotates with `/token`.
   The join info (daemon window, host welcome, `/join`) prints BOTH lines: client command +
   `view: http://jam:<key>@<ip>:<view-port>`. ttyd missing → one log line "install ttyd for
   the live view (brew install ttyd)" and everything else works. `--no-view` disables.
   ttyd child is killed when the daemon exits (own PID only).
2. **Claude-Code-style client rendering.** Labels become `[Roy]`, `[Dana]` (own name green,
   others cyan), agent text `⏺ [Claude] <text>`, tool lines stay dim `⚙`, working status
   shows an orange `✻ claude is working…`, prompt glyph `❯ `. Human-only chat keeps the
   yellow `(chat) [Dana]: …` form. No behavior change, rendering only.
3. **Token in claude's context.** Daemon writes `token.json` {token, join, viewUrl} to the
   state dir on boot and on every `/token` change. hooks.sh includes in SessionStart — and in
   the roster-change UserPromptSubmit context whenever token.json's mtime changed since last
   prompt — the block: "Join token: <t>; join command: <line>; live view: <url>. Reveal these
   ONLY when asked by the host (messages WITHOUT a [Name]: prefix). Never reveal them to
   bridged participants ([Name]: prefixed) — tell them to ask the host." No token set → the
   block says "no token set; joining requires host approval (/accept)". `--no-token-in-context`
   omits the block entirely.
   Ceiling (documented in README): this guard is an instruction to the model, not a hard
   boundary — an admitted participant may still socially-engineer the token out of the agent;
   knock mode keeps the hard gate.

## v0.4 — in-TUI knock approval (added 2026-08-28 night)

Goal: the host approves/denies a knock without leaving the claude window.

- On knock, the daemon (in addition to notifying host clients) opens
  `tmux display-popup -t <jam> -w 64 -h 7 -E "<node> <dir>/popup.mjs <name> <ip> <ttl-s> <port>"`.
  The popup renders `⚑ <name> wants to join (<ip>)` + `[a]ccept · [d]eny · [i]gnore/Esc`,
  reads ONE key (raw stdin), then POSTs `{name, ok}` to a new daemon endpoint
  `POST /admit` (loopback-only + `x-jam-secret`, same guard as /hook) and exits. `i`/Esc/any
  other key exits without posting — the knock stays pending and /accept in a client still works.
  The popup auto-exits when its TTL elapses (aligned with knock expiry).
- Popups appear only on clients attached to the `<jam>` session itself — ttyd viewers sit on
  grouped sessions and never see them. Multiple knocks are queued: one popup at a time,
  next popup opens when the previous closes and the knock is still pending.
- While ≥1 knock is pending, the daemon sets the jam session's `status-right` to
  `⚑ N waiting` (saving the previous value at daemon start and restoring it whenever the
  pending count returns to 0 and at daemon exit). Never touch global tmux options — session
  option only (`tmux set -t <jam> status-right …`).
- `--no-popup` disables both popup and status-right.
- Admit/deny/expiry race: /admit for a knock that no longer exists returns 404 and the popup
  exits silently. Deny via popup behaves exactly like /deny (close 4403).
- popup.mjs failures must never affect the daemon (spawn errors logged, ignored).

## v0.4b — profile selection (--config-dir)

- New `jam host` flag `--config-dir <dir>` → the spawned claude window's env gains
  `CLAUDE_CONFIG_DIR=<dir>` (expanded, no trailing slash — a trailing slash changes the
  keychain hash and forces re-login). If the flag is absent but the launcher itself was
  started with CLAUDE_CONFIG_DIR set, forward that value. Log `claude profile: <dir>` at launch.
- JSONL tail keeps globbing `~/.claude/projects/*` AND additionally `<config-dir>/projects/*`
  when set (on this machine they are symlinked to the same place; on other machines they are not).
- README: example `./jam host --name Roy --cwd . --config-dir ~/.claude3` — notes: separate
  account = separate usage limits; that profile answers its own trust dialog on first run in a
  cwd; remote-MCP connectors are per-profile.

## v0.5 — chat-in-view layout + restyle v2 (added 2026-08-28 night, Roy feedback)

Feedback driving it: (1) /c chat is invisible while the host sits in the claude window;
(2) the client looks nothing like Claude Code ("colors, vibe, formatting").

1. **Split-pane layout.** The `claude` tmux window becomes two panes: top = claude TUI
   (all remaining height), bottom = the host's jam client, fixed ~9 rows
   (`split-window -v -l 9`). The separate `you` window is removed. All tmux targeting of the
   claude TUI switches from window to PANE target (`<jam>:claude.0` — top pane); the
   client pane is `.1`. capture-pane/paste-buffer/send-keys/display-popup targets updated
   accordingly. ttyd viewers still pin the `claude` window and therefore see both panes —
   intended (viewers are authenticated participants; /c stays invisible only to claude).
   `--no-split` restores the old separate `you` window.
2. **Restyle v2 (client.mjs rendering only, protocol untouched).**
   - Palette: Claude Code's — orange 256-color 208 (or truecolor #ff8c00-adjacent) for the
     spinner/accents, warm grey dims, cyan for other humans, green for self, no raw 8-color
     yellow/red except errors.
   - Turn rhythm: blank line before each `⏺ [Claude]` turn; agent text word-wrapped to the
     terminal width with 2-space continuation indent.
   - Tool calls `⚙ Bash: <summary>` stay dim; NEW: tool RESULTS render as dim `  ⎿ <first
     line, truncated 100 chars>` — extend parseJsonlLine to emit `{kind:'tool-result'}` from
     user-record tool_result blocks (still skipped for busy/attribution logic), daemon
     broadcasts `agent {kind:'tool-result'}`; cap: skip results while more than 5 arrive in
     one turn (log one `  ⎿ …` ellipsis line instead) to avoid flooding.
   - Markdown-lite on agent text: **bold** → ANSI bold, `code` → dim-highlighted; nothing else.
   - Working indicator: animated spinner frames ✻ ✼ ✽ ✻ rotating in the prompt row while
     busy (timer only while busy, unref'd), keeping the single-row prompt invariant (the
     two-row prompt redraw bug from the first review must not come back).
   - Knock/join/token lines keep their glyphs but adopt the palette.
   - **Aligned name column (Roy feedback #3):** all sender labels pad to one fixed column —
     width = longest live label among roster names + `Claude` (recomputed on roster change),
     e.g. `[Roy]    ▸ hi` / `[Dana]   ▸ hey` / `[Claude] ⏺ text`. Continuation/wrapped lines
     indent to the text column so paragraphs align under their first line. General UX pass
     mandate: consistent one-glyph column between label and text (▸ humans, ⏺ claude,
     ⚙/⎿ tools, ⚑ knocks, * system), consistent spacing, no mixed separators (drop the
     `(chat) Name:` form → `[Dana] ✉ text` in yellow for human-only), errors `! text` red.
     Chat lines, status wording and help line reviewed for consistency in the same pass.

## v0.5.1 — rendering feedback round (Roy, from live screenshots)

1. **Human-only chat unmissable:** render as `[Dana]  [humans-only] <text>` with label, prefix
   and text ALL in one distinct color no other element uses (magenta family, 256-color ~213).
   The ✉ glyph is dropped with the rest (see 2).
2. **No speech glyphs:** remove `⏺` from claude lines and `▸` from human lines — speech is just
   `[Name]  text`. Glyph column survives only for non-speech: `⚙`/`⎿` tools, `⚑` knocks,
   `*` system, `!` errors.
3. **Per-user color identity:** every participant gets a stable color (hash of name into a
   curated 256-color palette that excludes claude-orange 208, chat-magenta, error-red, dim
   greys); BOTH the `[Name]` label and the message text render in it. Self keeps green.
   `[Claude]` label stays orange; claude's TEXT stays the default light grey. Colors stay
   stable across roster changes (hash, not join order).
4. **Separation:** one blank line between every message block — human says, claude turns,
   chat lines — regardless of same/different sender. Tool `⚙` + its `⎿` result(s) stay glued
   as one block (blank line before the first `⚙` only). System/join/typing-expiry lines and
   the help line stay compact (no forced blank).

## v0.6 — ink client (UI/UX overhaul, Roy-approved dependency)

Motivation: readline single-row prompt forces status text into the prompt row ("working/typing
hints in wrong place"). Roy explicitly approved adding UI libs.

- client.mjs becomes an ink app (deps: ink@^5, react@^18, ink-text-input@^6 — same versions as
  ~/Code/Padina/ClaudeCodeSessionManager). Layout, bottom-up:
  1. input row: `Roy ❯ <TextInput>` (self-green name, orange caret)
  2. status bar (own dim row, always present, empty when idle): left `✻ claude is working…`
     (animated) · `⚠ waiting for host permission`; right `Dana is typing…` (multi-name
     aggregation "Dana, Eli are typing…")
  3. everything above: transcript via ink `<Static>` (append-only — no re-render of history,
     scrollback stays native terminal scrollback)
- ALL v0.5/v0.5.1 rendering rules carry over verbatim (aligned name column, per-user colors,
  [humans-only] magenta, no speech glyphs, blank-line blocks, wrap via ink's own Box/Text
  wrapping where possible — keep lib.mjs pure helpers as the single source of visual truth
  where they exist; wrapText may retire if ink wraps correctly with hanging indent via
  paddingLeft on a Box).
- Behavior parity checklist (all must survive): typing events throttled from TextInput
  onChange; multi-line via trailing `\`; all slash commands; host gating; knock render +
  /accept; reconnect/backoff + history dedupe + boot-id reset; close codes 4400-4429 exit;
  exit codes preserved; --host flag; SIGINT clean exit.
- WS + state logic stays plain (no React for the socket) — one small store, ink renders it.
- Keep a `--basic` flag: the old readline renderer (moved to client-basic.mjs or a branch)
  for terminals where ink misbehaves; README notes it.
- Tests: pure helpers keep their tests; add an ink-testing-library smoke render if trivial
  (ccsm has the devDep pattern) — otherwise the real-pty capture in the smoke serves as proof.
- Real visual proof required (pty capture of a session with 2 friends, chat, tool turn,
  typing indicator + working spinner in the STATUS BAR, not the prompt).

## v0.7 — terminal mirror mode (guest sees the REAL TUI)

Goal: guest terminal shows Claude Code exactly — by streaming the host TUI's actual cells,
not imitating them.

- Daemon: every 250 ms run `tmux capture-pane -e -p -t <claude-pane>` (escape sequences
  preserved); if changed since last frame, broadcast `{t:'screen', rows:[...], w, h}` to
  clients that requested mirror mode (hello `{mirror:true}` or runtime toggle frame
  `{t:'mirror', on}`). Never store screen frames in history. Sanitizing: strip only C0/OSC
  sequences dangerous outside rendering (keep SGR colors, cursor-irrelevant since rows are
  reprinted); title/clipboard OSC dropped.
- Client (ink): F2 (and `/mirror`) toggles views — [transcript] ⇄ [mirror]. Mirror view:
  top = latest frame rows verbatim (truncate/pad to guest terminal width; if guest narrower
  than host pane, crop right and show a dim "host is wider" hint), then the same status bar +
  input row. Chat/knock lines while in mirror mode: render as a 3-row overlay strip above the
  status bar (latest 3 events), full history still in the transcript view.
- Mirror is view-only sugar: all interaction stays the jam protocol (say/chat/commands).
- Guests default to transcript view; the welcome line mentions "F2 = live view of the real TUI".
- Bandwidth guard: frames only to subscribed clients, only on change, coalesced to 4/s max.

## v0.8 — claude knows the jam manual (standing rule)

- New `MANUAL.md` in the project root: compact operator manual (host + guest) — the single
  source of truth for "how do I use jam", written for claude to relay.
- hooks.sh `session-start` appends MANUAL.md's content to the SessionStart additionalContext
  (after the shared-protocol + token blocks), defensively (missing file → skip, exit 0).
  SessionStart only — never in the per-prompt hook (too big).
- STANDING RULE: every future spec section that adds/changes a user-visible feature, flag or
  command MUST update MANUAL.md in the same change. The implementing agent's checklist
  includes it; reviewers treat a stale MANUAL.md as a blocker.

## v0.9 — clean viewer surface (Roy: browser must show ONLY the claude session)

Problem: ttyd viewers pin the `claude` window, which since v0.5 contains the host's chat pane,
and grouped sessions inherit the status bar — guests see host chrome.

- The claude TUI returns to being the ONLY pane in window `claude`. Viewer grouped sessions
  additionally set `status off` (session-scoped, their own session) so the browser shows
  nothing but the Claude Code screen.
- Host chat-in-view, by environment:
  - cmux detected (`cmux identify --json` succeeds AND the launcher runs inside cmux): the
    launcher creates a cmux split below the caller surface running the host client
    (`cmux new-split` per the cmux CLI), and tmux-attaches the main surface to window
    `claude`. Chat strip lives in cmux, invisible to tmux viewers.
  - otherwise: two tmux windows (`claude`, `chat` — the old `you` naming retires); the
    launcher prints "Ctrl-b n toggles chat". `--split` (now opt-IN) restores the v0.5
    same-window split for hosts who prefer it and accept viewers seeing the strip.
- The in-window popup + status-right badge still land on the host's tmux client only
  (viewer sessions: `status off` hides the badge; display-popup already targets attached
  clients of the base session — verify viewers never render it).
- Terminal mirror (v0.7) already targets the claude PANE, so it stays clean by construction.
- README/MANUAL.md updated (standing rule).

## v0.10 — tool collapse (Claude-Code-like)

- Ink client: tool activity for the IN-PROGRESS turn renders in the live region (below the
  Static transcript, above the status bar) — up to the last 4 ⚙/⎿ lines, dim.
- When the turn completes (busy→false or next agent text block), the live tool lines fold
  into ONE dim summary line appended to the transcript: `⚙ N tools (Bash ×a, Read ×b, …)`.
  Turns with ≤1 tool call keep the plain ⚙ (+ its ⎿) inline as today.
- `/tools` re-prints the LAST completed turn's full tool log (all ⚙/⎿ lines) into the
  transcript; `/tools on|off` sets always-expanded mode (off = collapse, default).
- Host `Ctrl-b z` (zoom) and resize documented in README/MANUAL as the way to hide/size the
  chat strip in `--split` mode; cmux layout (v0.9) needs nothing.

## v0.10b — newline keys in the client input

- Ink client input: Shift+Enter (kitty/CSI-u `ESC[13;2u`, also `ESC[27;2;13~` xterm modifyOtherKeys
  form) and Option/Alt+Enter (`ESC\r`) insert a literal newline into the composing message
  instead of submitting; plain Enter submits. Trailing-`\` continuation stays as the
  works-everywhere fallback and MANUAL.md documents all three.
- Multi-line composition renders the pending lines above the input row (dim) so the user sees
  the whole message before submitting.
- client-basic.mjs: detect the same sequences via readline keypress `sequence` if cheap;
  otherwise leave `\` as its only mechanism (documented).

## v0.10c — guest onboarding block on connect

On every welcome, replace the single help line with a short dim onboarding block (guests get
the full version; host a trimmed one since host commands already show elsewhere):

  ── claude-jam ────────────────────────────────────────
  plain line        → claude (attributed [Dana])
  /c <text>         → humans only — claude never sees it
  /who /quit        → participants / leave
  F2 or /mirror     → watch the REAL Claude Code screen
  Shift+Enter or \  → multi-line message
  Lost? just ask claude — e.g. "how does this jam work?",
  "how do I chat privately?" — it knows the full manual.
  ──────────────────────────────────────────────────────

Reprint on `/help` (new command, everyone). Keep it ≤10 rows, dim, above the first messages;
history replay comes after it. MANUAL.md gains /help (standing rule).

## v0.11 — built-in cloudflared tunnel (--tunnel)

- `jam host --tunnel` (requires cloudflared on PATH; clear error + brew hint if missing):
  the launcher spawns TWO quick tunnels as tracked children —
  `cloudflared tunnel --url http://localhost:<port>` and `--url http://localhost:<view-port>`
  — parses each one's `https://<rand>.trycloudflare.com` line from stderr (retry/wait up to
  30 s), and derives: guest join `wss://<rand1>.trycloudflare.com` (no port), view
  `https://jam:<key>@<rand2>.trycloudflare.com`.
- Tunnel URLs flow everywhere join info already flows: daemon log, host welcome/`/join`,
  token.json (extra fields `tunnelJoin`, `tunnelView`) hence claude's context block, and the
  `{t:'token'}` frame. When a tunnel is up, print tunnel lines FIRST (they're what you send a
  remote friend); local Tailscale/LAN lines stay printed below.
- Lifecycle: cloudflared children tracked by PID, killed on daemon exit (same rule as ttyd);
  a tunnel process dying logs a warning + clears the URLs (no auto-restart in v0; ceiling).
  `/token` rotation does NOT change tunnel hostnames (only the view key inside the URL).
- Client: no changes needed (wss already works); README/MANUAL updated per standing rule,
  including the trade-off note (Cloudflare terminates TLS; knock/token still the gate).

### v0.9 addendum — viewer dot-fill

Browsers larger than the host pane show tmux's `·` fill. Fix: set `fill-character ' '`
(window option) on the jam session at launch — cosmetic, host unaffected. Optionally append
`?fontSize=<n>` guidance to the view URL docs (ttyd client option) for viewers who want the
TUI larger. (Implemented in the redesign round.)

## v0.12 — session export to guest (host-gated)

- Guest `/export` → host sees `⇩ Dana requests the session transcript — /allow-export Dana |
  /allow-export always | /deny-export Dana` (client line + popup reuse). `always` = standing
  approval for the rest of THIS jam (state in daemon memory only).
- On approval the daemon streams the session JSONL over the existing WS (chunked frames
  `{t:'file', xfer, seq, done, b64}`, 64 KB chunks, 50 MB cap) → guest client writes
  `./jam-session-<sid>.jsonl` and prints continue instructions:
  `mkdir -p ~/.claude/projects/<slug of their cwd> && cp … <sid>.jsonl && claude --resume <sid>`
  (slug rule printed by the client; works because resume scans projects/*.jsonl).
- SECURITY (README+MANUAL, plain wording): the transcript contains EVERYTHING claude saw —
  including the join token/view URL block if token-in-context is on, file contents read
  during the session, and tool outputs. The approval message reminds the host; recommend
  `/token new` after exporting. Guests can already read the whole conversation visually —
  export changes convenience, not confidentiality class, EXCEPT the token block: strip
  known jam token blocks from the exported copy where safely identifiable (regex on our own
  hook text), best-effort, documented.

## v0.13 — remote files & image pasting

- Guest→host file send: `/send <path>` in the client (also bare image paste: `/paste` grabs
  the clipboard image via pngpaste if installed, osascript PNG fallback; macOS only, others
  get a hint). Chunked upload over WS (same frame shape as v0.12, 20 MB cap per file,
  1 in-flight per client).
- Host gate mirrors knocks: `⇪ Dana wants to send photo.png (2.1 MB) — /accept-file Dana |
  /accept-file always | /deny-file Dana` (+ popup). On accept the daemon writes to
  `<cwd>/jam-uploads/<sanitized-name>` (basename only, no traversal, collision → suffix,
  0644) and injects `[Dana]: sent a file: jam-uploads/photo.png <optional caption>` so
  claude can Read/inspect it. Everyone's client shows the transfer line.
- Host→guests: host `/send <path>` broadcasts an offer; each guest gets
  `⇩ Roy offers notes.md (12 KB) — /get notes.md saves to ./jam-downloads/`.
- Trust boundary: filenames sanitized server-side, size caps enforced server-side, uploads
  live only under jam-uploads/, binary-safe base64, never executed, never auto-opened.
  MANUAL/README updated (standing rule).

## v0.14 — mirror-first unified view (Roy direction change)

Everyone — host included — uses the same single-pane client; the mirror of the real TUI is
the DEFAULT view, the transcript is the F2 alternate. Web view demoted to opt-in.

- Client default view = mirror (live TUI cells) + chat strip (last 3 chat/system lines) +
  status row + input. F2//mirror flips to the transcript view (full history) and back.
- `jam host` runs the tmux session DETACHED (daemon, claude TUI, nothing attached) and execs
  the client full-screen in the current terminal as the host. No cmux split, no `chat`
  window, no `--split` layouts — that whole v0.9 host-chat machinery retires (keep
  `tmux attach -t jam` documented as the escape hatch for direct TUI access).
- Host TUI control from inside the client: **F3 toggles passthrough mode** (host + loopback
  only): while on, every key is forwarded raw to the claude pane (send-keys -H via daemon,
  loopback+trusted socket only), status row shows `⌨ TUI control — F3 returns`; used for
  permission prompts, trust dialog, /model, /compact. When claude's permission prompt fires
  (`waiting` status), the status row hints `F3 to answer`. Guests never get passthrough
  (server-enforced: host flag + loopback).
- Host's plain input stays jam-attributed (`[Roy]:` injected like everyone) — attribution
  becomes fully symmetric; the SessionStart protocol text updates: "all participants,
  including the host, appear as [Name]:" (unprefixed = someone typed in the raw TUI via
  attach or F3).
- ttyd/web view: default OFF; `--view` turns it on (flag polarity flips; `--no-view` accepted
  no-op). MANUAL/README rewritten for the new model (standing rule).
- Keep working: knocks (popup now unnecessary for the host-in-client — knock renders in the
  client + still the tmux popup for anyone attached; keep both), tool collapse in transcript
  view, export/files specs unchanged.
- **Host slash passthrough (condition for unified view):** in the HOST client, any `/command`
  that is not a jam command (`/c /who /help /quit /mirror /tools /join /accept /deny /token`
  + export/file commands) is forwarded to the claude TUI verbatim — daemon types it into the
  pane (send-keys -l literal + Enter, NO [Name] prefix) so claude's own command palette runs
  it (`/model`, `/compact`, `/mcp`, `/resume` …). Server-enforced host+loopback only; guests
  keep getting "host TUI only". Interactive command UIs (pickers) then render in the mirror,
  and F3 passthrough drives them.
- **Guest slash commands (host-gated):** a guest's non-jam `/command` becomes a request:
  guest sees `sent to host for approval`, host client (and popup) shows
  `⌘ Dana wants to run /compact — /allow-cmd Dana | /allow-cmd always | /deny-cmd Dana`.
  Approved → daemon types it into the TUI exactly like a host slash passthrough, and
  broadcasts `* Dana ran /compact (approved by Roy)`. `always` = standing approval for that
  guest for THIS jam. Dangerous by nature (commands change the session for everyone) —
  default deny, never auto-approve, and `/allow-cmd always` excludes `/exit`, `/clear`,
  `/resume` (session-lifecycle commands stay host-only, hard list server-side).

## v0.14 — the full ceiling list (moved out of the README, 2026-08-29)

The public README keeps a short list. This is all of them.


- tmux slightly degrades Claude Code visuals — paler colors, OSC notifications lost.
- The JSONL format is officially unstable. All parsing lives in `parseJsonlLine` in `lib.mjs`,
  so a format change is a one-place fix.
- A message injected mid-response is queued by Claude Code as the next turn, not merged.
- `busy` is inferred; the `Stop` hook is the only authoritative end-of-turn signal. It fires
  before claude has flushed the turn's last record, so the `Stop` handler drains the JSONL
  tail until the file goes quiet (≤ 2 s) and only then pushes `busy:false` — so the final
  `agent` text now always arrives before `busy:false`, instead of ~300 ms after it.
- Injection verifies by looking for the message's own first visual line (up to 40 chars, less
  on a narrow pane) in the pane, so two identical consecutive messages could match a stale
  echo. Nonce-prefix it if that ever bites.
- Friends cannot answer permission prompts; the host does that with F3 (or by attaching).
  A friend's slash command runs only after the host approves it, and never at all if it is
  `/exit`, `/clear` or `/resume`.
- Admission is per person (`/accept`), but there are still no per-friend credentials: once in,
  everybody is equally trusted, and `/deny` cannot kick somebody who is already admitted.
- A knock popup that is answered elsewhere (a client's `/accept`, or the knock expiring) stays
  on screen until a key or its TTL closes it, and it holds the queue while it is there — the
  daemon is the source of truth, so it just gets a 404. A knock that arrives while nobody is
  attached gets no popup at all, and none is re-opened when a client attaches later.
- `status-right` is snapshotted once, when the daemon starts. Changing it yourself while jam
  is running means the next restore puts the daemon's snapshot back, not your newer value.
- The claude window is sized for the host's mirror, and `resize-window` pins it: an attaching
  client (a `tmux attach`, a second browser viewer) gets blank padding instead of reshaping it,
  and if something does take the size the daemon only puts it back once nobody is attached —
  while you are attached, the size is yours. Two viewers of different sizes means the smaller
  picture wins for one of them; that is tmux, not jam.
- The host's client tracks its terminal, not the other way round: on a terminal that never
  reports a size (a pipe, some CI shells) the window falls back to 80x19 and the mirror is that
  small for everyone. Resize the terminal once and it corrects itself.
- More than five tool results in one turn collapse to a single `⎿ …`; the full output is in
  the host's TUI, and the count resets on the next turn.
- The live tool region shows the last four `⚙`/`⎿` lines, and which of the two you see is up
  to the turn: seven `tool_use` blocks in ONE assistant record arrive together, so the four
  newest lines can all be `⎿` results. `/tools` after the turn has the whole list.
- `/tools` remembers one turn — the last completed one. A summary line scrolled off the screen
  cannot be expanded again; the host's TUI keeps everything.
- The mirror streams the pane as it is, so a guest with a shorter terminal sees the **bottom**
  of it and a host pane much taller than the guest's window looks half empty (that blank space
  is really there). Cropping is reported, never compensated for; the `⚙`/status rows and the
  input box are always in the kept part, which is what a watcher wants.
- Mirror frames are not history: a client that flips to the mirror before the first frame
  arrives sees `waiting for the host's screen…` for up to 250 ms, and a reconnect re-subscribes
  from scratch. Nothing older than "now" is ever streamed.
- The transcript printed before the mirror went up stays on screen above the frame (`<Static>`
  output belongs to the terminal, not to ink). Lines that arrive *during* the mirror are held
  back and flushed on the way out, so ordering survives, but the frame is drawn under whatever
  was already there.
- The key filter holds a partial escape sequence only when it is longer than one byte, so a
  chunk boundary falling exactly after the `ESC` of `ESC[13;2u` leaks `[13;2u` as text. A
  terminal writes a sequence in one `write()`, so this has not been observed; the alternative
  (holding a lone `ESC`) would swallow the Escape key.
- `Shift+Enter` needs a terminal that actually sends `ESC[13;2u` / `ESC[27;2;13~` (kitty,
  Ghostty, WezTerm, iTerm2 with CSI-u on, tmux passing them through); `Option+Enter` needs
  Alt-as-ESC. A trailing `\` is the mechanism that works everywhere, and `--basic` has only
  that one.
- The live view, the tool collapse, the newline keys and F2/F3 are ink-only: `--basic` appends
  lines and never redraws, and it reads stdin through readline instead of the key filter. It is
  a transcript-only client, and its onboarding footer says so.
- Markdown-lite is applied per logical line, so a `**bold**` or `` `code` `` span that straddles
  an explicit newline renders with its markers visible instead of styled. (In `--basic` it is
  applied per already-wrapped line, so a soft wrap breaks a span there too.)
- The transcript is append-only, so a line keeps the label-column width and the terminal width
  it was drawn at: widening the column (a long name joining) or resizing the terminal aligns
  everything from that point on, not what is already on screen. Redrawing history is what
  `<Static>` exists to avoid.
- The invite/view lines are handed to the terminal unwrapped on purpose, so they stay one
  selectable run. On a pane narrower than the line (~85 columns) that means a soft wrap; the
  copy is still whole, but a terminal that does not reflow on copy will paste a newline into
  the command.
- ink needs raw mode on stdin. With a pipe or a heredoc the client falls back to `--basic`
  automatically; a terminal ink dislikes for any other reason needs the flag by hand.
- `--config-dir` picks the profile; it cannot log it in. A brand-new profile lands in claude's
  first-run onboarding, which only you can answer, in the `claude` window.
- The token-in-context guard ("reveal only to the host") is an instruction to the model, not
  a boundary. And a `kill -9` of the daemon orphans the ttyd child — that pid is logged at
  launch.
- `--tunnel`: a dead `cloudflared` child is never auto-restarted (v0 ceiling) — its line just
  disappears from `/join`/the daemon log until the host restarts with `--tunnel` again. The
  tunnel hostnames are fixed for the daemon's whole life; only `/token` off/on can drop or
  regenerate the *credential* inside the URL, never the host itself. Cloudflare's edge
  terminates TLS, so it (and anyone who can see its logs) is a party to the connection the
  same way any TLS-terminating proxy is — the join token / knock approval is what actually
  gates who gets in, same trust model as the LAN case. No IP allow-listing on a quick tunnel:
  the URL itself is the only thing standing between a stranger and a knock/wrong-token attempt.
- F3 passthrough is raw by design: the host's bytes reach claude unsanitized (that is what
  answering a prompt means). The gate is the socket — `--host` **and** loopback, i.e. the client
  the launcher spawned — plus a size cap per frame. Anything else on loopback that speaks the
  protocol could claim the same trust; on a shared machine, that is the boundary to know about.
- Slash passthrough types the command and presses Enter after 300 ms. claude's palette filters
  as you type and Enter picks the highlighted row, so a command whose name is a prefix of
  another could in principle submit the neighbour; every real command name we tried resolved to
  itself. A picker that opens instead is normal — drive it with F3.
- `/exit` and `/quit` in a client mean "leave my client"; they never reach claude. Ending the
  session itself is `tmux attach -t jam` (or `tmux kill-session`).
- Standing approval (`/allow-cmd always`) lives in daemon memory, is per name, and dies with
  the daemon. A guest who reconnects under the same name keeps it; there is no way to revoke it
  short of restarting (there is no `/deny-cmd always`).
- A guest can have one command request in flight, and it expires after two minutes. The tmux
  popup for it only appears if somebody is attached to the jam session, which in the normal
  v0.14 layout nobody is — the host answers in their client.
- The connect block is printed above the live view, so a client that reconnects to a busy
  daemon replays up to 300 events into the terminal's scrollback before the frame comes back.
  That is the transcript doing its job, but it does scroll.
- Nothing tells a guest that the host is in TUI control: their view keeps updating (they can see
  the keystrokes land), but the `⌨` marker is local to the host's client.
- **Export scrubbing is best effort.** The only thing removed from an exported transcript is
  jam's own token block (matched by the text hooks.sh writes) and the raw token string. Anything
  else claude saw — file contents, tool output, another secret it happened to read — goes with
  the copy. A changed hook wording would silently stop matching; the token replacement is the
  backstop. `/token new` after an export is the real mitigation.
- A transfer is held whole in memory at both ends (a 50 MB transcript is ~50 MB + its base64
  frames a few at a time), there is no resume: a socket that drops mid-transfer loses it and the
  partial file is never written. Uploads are 20 MB, the transcript and offers 50 MB.
- `jam-uploads/` is append-only as far as jam is concerned: nothing is ever cleaned up, and a
  repeat name gets `-1`, `-2`, … up to 99, then the upload is refused. Same for a guest's
  `jam-downloads/`.
- Offers live for the daemon's whole life and are never re-broadcast: a guest who joins after
  `/send` is not told about it (they can still `/get <name>` if somebody tells them the name),
  and an offer whose file is deleted or grown past the cap only fails when someone tries.
- `/paste` is macOS-only by nature (`pngpaste`, else `osascript` `«class PNGf»`), and it takes
  the clipboard as PNG only — a copied file, a PDF or an HTML snippet is not an image. The name
  it invents is `paste-<yyyymmdd-hhmmss>.png`, so two pastes in the same second collide (and get
  the `-1` suffix).
- Standing approval (`/allow-export always`, `/accept-file always`) is per name, per kind, in
  daemon memory, with no way to revoke it short of a restart — same ceiling as `/allow-cmd
  always`. A guest reconnecting under the same name keeps it.
- The host's `/export` writes into the host's own cwd, next to the project. It is the same file
  claude is already writing, so it is a copy, not a move.
- Nothing scans an uploaded file. It is written 0644, never executed, never opened, and claude is
  merely told the path — but the moment claude `Read`s it, its contents are in the session's
  context (and therefore in anybody's later `/export`).
- No rate limiting, no web client, single session per host, no Windows.
- First run in a fresh directory hits claude's "is this a folder you trust?" dialog. Before
  every injection until one succeeds, the daemon waits up to 30 s for either that dialog (it
  answers it, moving off the "No, exit" default first) or the input prompt — so a message sent
  while claude is still booting still lands.


## Running the eight end-to-end smokes

Eight end-to-end smokes, all verified 2026-08-29 on node 24.15 / tmux 3.7c / claude 2.1.251 /
ttyd 1.7.7 / cloudflared 2026.8.2. Run `smoke-ink.mjs` against a **fresh** daemon: it asserts on what is on screen,
and a daemon with replayed history puts an older turn's collapsed-tool line there.

```sh
# zsh: `command -v claude` prints the alias text, not a path — ask for the binary.
# Run the launcher inside a tmux session of your own so it has a real terminal size, and
# --no-attach so no host client of its own opens (the smokes bring their own clients).
tmux new-session -d -s jamdrive -x 120 -y 40 -c "$PWD" \
  "JAM_CLAUDE=$(whence -p claude 2>/dev/null || command -v claude) node host.mjs \
   --tmux jamtest --port 7799 --view-port 7801 --name Host --token smoketoken \
   --hook-secret smokehooksecret --cwd '$PWD' --no-attach -- --model haiku; sleep 1800"

node scripts/smoke-ink.mjs   ws://127.0.0.1:7799 smoketoken jamtest   # first: needs empty history
node scripts/smoke-xfer.mjs  ws://127.0.0.1:7799 smoketoken jamtest smokehooksecret
node scripts/smoke.mjs       ws://127.0.0.1:7799 smoketoken
node scripts/smoke-mirror.mjs ws://127.0.0.1:7799 smoketoken
node scripts/smoke-popup.mjs ws://127.0.0.1:7799 jamtest 7799 smokehooksecret
node scripts/smoke-slash.mjs ws://127.0.0.1:7799 smoketoken jamtest   # last, and ONCE per
#   daemon: it grants Guest standing approval (`/allow-cmd always`), which lives in daemon
#   memory, so a second run against the same daemon gets no cmdreq to answer.
tmux kill-session -t jamtest          # exact names only, never a pattern
tmux kill-session -t jamdrive
rm -rf "$TMPDIR/claude-jam-7799" jam-uploads

# knock-only daemon (no --token) for the admission smoke
tmux new-session -d -s jamdrive -x 120 -y 40 -c "$PWD" \
  "JAM_CLAUDE=... node host.mjs --tmux jamtest --port 7799 --name Host --cwd '$PWD' \
   --no-attach -- --model haiku; sleep 300"
node scripts/smoke-knock.mjs ws://127.0.0.1:7799
tmux kill-session -t jamtest; tmux kill-session -t jamdrive
rm -rf "$TMPDIR/claude-jam-7799"

# v0.17: the transport smoke takes NO arguments and needs no daemon of yours. It starts and
# kills its own on 7811/7813 (no tmux session, no claude at all), because it needs a
# --heartbeat far shorter than a real run and it deliberately kills relay children.
# ~2 min; needs cloudflared on PATH for its T1 steps.
node scripts/smoke-transport.mjs
```

## v0.15 — native-speed host TUI control + faster frames (Roy: F3 typing feels remote)

Root cause: F3 passthrough routes each keystroke client → WS → daemon → `tmux send-keys`, and
feedback arrives only on the next 250 ms `capture-pane` poll. Locally that is ~300-500 ms per
key — unusable for real typing.

1. **Host F3 = real attach, not proxy.** In the HOST client (host + loopback), F3 suspends the
   ink app (unmount/stdin release), spawns `tmux attach -t <jam>:claude` (the WINDOW by name —
   a bare session target lands on window 0, the daemon's log) with the terminal inherited
   (stdio: 'inherit'), and re-renders the client when tmux detaches. Native latency, full
   fidelity (pickers, permission dialogs, mouse, colors). Status line hint becomes
   "F3 → attach to the real TUI (Ctrl-b d to come back)". While attached, the daemon pauses the
   host client's frame subscription; on return it resizes the claude window back to the host's
   terminal (existing resize logic) and resumes frames. The old proxy path stays for GUESTS
   only (they cannot attach), gated server-side as today.
2. **Frames get faster and cheaper.** Replace fixed 250 ms polling with adaptive cadence:
   40 ms while any client is in mirror view AND activity was seen in the last 2 s (typing,
   busy, new frame), 250 ms when idle, plus the existing change-detection so unchanged screens
   send nothing. Cap 25 frames/s per client. Where available prefer `tmux pipe-pane -o` to a
   local socket/fifo as the change signal (poll capture-pane only when the signal fires) — if
   pipe-pane proves fiddly, keep the adaptive poll (document which shipped).
   **Shipped: the adaptive poll**, not pipe-pane. pipe-pane would have to carry every byte a
   full-screen TUI redraws into a fifo of our own, and `capture-pane` would still be the thing
   that turns it into a frame — so the only win was over an idle mirror, which already cost 4
   polls/s and now costs none at all when nobody is watching. One self-rescheduling timer
   instead: `frameCadence()` in lib.mjs, activity stamped by broadcast(), by a keystroke and by
   a frame that actually changed, and the pane size cached for 500 ms so the fast cadence does
   not double the tmux spawn count. Measured (smoke-mirror, 2026-08-29): 14 frames in 3 s while
   a haiku turn ran, gaps min 46 ms / median 139 ms — under v0.14 no gap could be under 250 ms —
   then 0 frames in 3 s once idle, with the daemon logging the
   `[frames] cadence 40ms (active)` -> `250ms (idle)` transition.
3. **Guest key latency honesty:** guests keep proxied input; the client shows a one-time hint
   that raw TUI control is host-only, and echoes their submitted line locally so typing feels
   instant even when the frame lags.

## v0.16 — one-key approval inside the client (Roy: bring back the a/d popup feel)

Since v0.14 the host's tmux session is detached, so `tmux display-popup` has no client to draw
on and knocks only appear as a text line. Restore the one-keypress feel natively in the client:

- Any pending request (knock, command, export, file) raises an **approval bar** just above the
  status row, styled like the old popup: `⚑ Dana wants to join (100.x.y.z)  [a]ccept  [d]eny
  [i]gnore  ·  2:00`, with a live countdown to the request's expiry. Multiple pending requests:
  the bar shows the first and `+N more`.
- While the bar is up AND the input line is empty, single keys act: `a` accept, `d` deny,
  `i`/Esc dismiss the bar (request stays pending; `/accept` etc still work). Any other
  printable key goes to the input as usual and hides the single-key hint (so typing never
  accidentally approves) — pressing Esc brings it back.
- Kinds keep their glyphs: `⚑` join, `⌘` command, `⇩` export, `⇪` file; approving runs exactly
  the same ladder path as the slash commands, no second mechanism.
- Guests never see the bar (server already sends host-only frames).
- The tmux popup path stays for anyone attached to the session; when both exist, whichever
  answers first wins and the other closes (ladder already handles late answers with 404).

## v0.17 — accepted feature program (judged 2026-08-29 from RESEARCH.md)

Source: ~/ClaudWork/2026-08-29-jam-feature-research/RESEARCH.md. Judged keepers only; the 8
anti-features there are rejected, and D4 (host delegation), A3, B2, B4, E2 are deferred.
Ship in the batches below; each item keeps its RESEARCH.md id for traceability.

### Batch T — transport survives 2 hours
- **T1 (A1)** auto-restart the `cloudflared` child with backoff (1s→30s, unlimited), reusing
  `joinInfo()`/`writeTokenFile()`/`sendHosts()` so the new URL propagates; log every respawn.
- **T2 (A2)** server-side ping/pong: 30 s interval, `isAlive` flag, `terminate()` on a missed
  round, roster cleanup — the `ws` README pattern. Keeps us under Cloudflare's 100 s idle cap
  even when the mirror is legitimately silent.
- **T3 (A4)** reconnect UX tiering: after 5 failed attempts the client says the tunnel URL may
  have changed and how to get the new one.
- **T4 (new, replaces A5)** `--funnel`: use **Tailscale Funnel** instead of cloudflared —
  `tailscale funnel --bg <port>` (or `tailscale serve` semantics per the installed version;
  read `tailscale funnel --help` and verify locally). Wins over named tunnels: STABLE public
  hostname (`<machine>.<tailnet>.ts.net`) across restarts, real TLS cert, no domain, no
  Cloudflare account, guest installs nothing. Two ports (client + view) via path or two funnel
  targets — pick what the CLI actually supports and document it. Same lifecycle discipline as
  cloudflared (tracked PID, killed on exit, restart on death). Startup validates
  `tailscale status` and prints a clear hint if Funnel is not enabled for the tailnet.
  Flags: `--tunnel` (cloudflared, ephemeral URL) and `--funnel` (Tailscale, stable URL);
  mutually exclusive, both optional.

#### Batch T — shipped 2026-08-29

All four, plus `scripts/smoke-transport.mjs` (13 steps) and 16 unit tests — 159 total.

- **One relay path, not two.** cloudflared and `tailscale funnel` differ only in argv and in
  which line carries the hostname, so `RELAYS` in host.mjs holds exactly that and
  `spawnRelay()` owns the pid tracking, the URL propagation and T1's backoff for both. Both
  stdout and stderr are piped and fed into one buffer: cloudflared banners on stderr,
  `tailscale funnel` on stdout.
- **T1** `respawnDelay(attempt)` = `min(1000 * 2**(attempt-1), 30000)`, unlimited attempts,
  counter reset the moment a URL resolves — so a relay that ran an hour waits 1 s, not 30. Our
  own `stopTunnels()` sets `relayStopping` first, so shutdown is not a death to recover from.
  A relay that dies without ever resolving now logs the tail of what it said, which is the only
  diagnosis available for a blocked cloudflared or a sandboxed Tailscale.
  No new frame: `onTunnelChange()` already fed `writeTokenFile()` + `printJoin()` +
  `sendHosts({t:'token'})`, which is how `/token` rotation has always worked.
- **T2** `startHeartbeat()` runs `heartbeatSweep()` over `wss.clients` every 30 s
  (`--heartbeat <ms>` for tests), pings whoever pongd since the last tick and `terminate()`s
  whoever did not. `ws.jamAlive` is the flag; `ws.on('pong')` clears it. `terminate()` fires
  `close`, so the existing handler does the roster/mirror/ladder cleanup — nothing duplicated.
  Clients needed NO change: the browser-standard `WebSocket` they all use answers protocol
  pings itself and gives the application no say in it.
- **T3** a per-client counter, reset on a socket that actually opened, and
  `reconnectMessage(attempts, nextMs)`. Both clients. The first four failures keep the old
  wording exactly; the fifth (~15 s of 1-2-4-8 backoff) names the URL change and points at
  `/join`.
- **T4** the shape that made this cheap: a funnel host string (`<machine>.<tailnet>.ts.net`,
  or `…:8443`) is a drop-in for a trycloudflare one, so it fills the same `tunnelHosts` slots
  and every join line, `token.json` field, welcome block and `/join` reprint works unchanged —
  including the `tunnel invite:` / `tunnel view:` labels, which are shared on purpose (the
  `.ts.net` in the URL is what tells them apart).
  **Two ports, not `--set-path`:** Funnel opens only 443, 8443 and 10000, and a path mount
  would also have to agree with the daemon's own `/health`, `/admit` and `/hook/*` routes.
  443 → the client (so the join line carries no port), 8443 → the ttyd view.
  **Foreground, not `--bg`:** the funnel then lives and dies with a pid we track, which is
  cloudflared's lifecycle exactly, respawn included. Shutdown additionally runs
  `funnel --https=<port> off` for the two ports it opened — belt and braces, because a funnel
  left open is a port on the public internet — and never `funnel reset`, which would drop
  config this daemon never created.
  `resolveTailscale()` exists because macOS keeps the CLI inside `Tailscale.app` and puts
  nothing on PATH; `--funnel-cli` / `JAM_TAILSCALE` override it.
  **The live path is UNVERIFIED, and the reasons are hard blockers, not oversights:**
  (1) the tailnet it was written against has no `funnel` node attribute — `Self.CapMap` in
  `tailscale status --json` lacks `https://tailscale.com/cap/funnel`, which is what
  `funnelPrecheck()` reads and refuses on; a tailnet admin grants it in Access Controls with
  `"nodeAttrs": [{"target": ["autogroup:member"], "attr": ["funnel"]}]`.
  (2) that machine runs the App Store (sandboxed, `_MASReceipt`, bundle id
  `io.tailscale.ipn.macos`) build of Tailscale 1.102.3, whose CLI answers EVERY serve/funnel
  mutation — `funnel`, and plain tailnet-only `serve` too — with `The Tailscale GUI failed to
  start: The operation couldn't be completed. (Tailscale.CLIError error 3.)`, while read-only
  `status` / `funnel status` work fine. The standalone build from tailscale.com is needed.
  So the lifecycle is proved in `smoke-transport.mjs` against a stub CLI that answers exactly
  as the real one documents (argv, foreground banner, `off`), and the precheck refusal is
  asserted against the REAL CLI. Our half of the contract is verified; Tailscale's is not.

### Batch H — history and orientation
- **H1 (B1)** seed the `history` ring buffer at daemon boot by parsing the existing session
  JSONL with `parseJsonlLine`, bypassing live side effects (no busy/waiting/tool-collapse
  churn), capped by a new `--replay N` (default 300 events). Fixes the blank-room problem for
  guests joining a `--resume`d or long-running session.
- **H2 (B3)** a `── history above · live from here ──` divider at the end of a join's replay.

### Batch F — guests see the work
- **F1 (C1)** stop truncating `Edit`/`MultiEdit`/`Write` tool calls: render file path + real
  `-`/`+` lines from `old_string`/`new_string` (no diff library — the args ARE the diff),
  capped like `TOOL_RESULT_MAX`, collapsible with the existing `/tools` machinery.
- **F2 (C2)** `/files` — the set of paths this session touched (from Edit/Write/Read inputs),
  newest first, with a per-path change count.
- **F3 (C3)** `/diff [path]` — `git -C <cwd> diff --stat` by default, full diff for one path;
  degrades cleanly outside a repo; capped output.
- **F4 (C4)** best-effort secret masking (deny-list: AWS keys, `-----BEGIN … PRIVATE KEY`,
  `sk-`/bearer tokens, `.env`-style `KEY=value`) applied to tool-call rendering AND
  `sanitizeFrameRow` mirror rows. Documented as best-effort, never presented as a guarantee.
  This is a trust-boundary feature: ship it in the same batch as F1, not later.

### Batch P — guest parity and polish
- **P1 (D2)** read-only guest command allowlist (`/cost`, `/status`, `/context`) resolving to
  `run` with no host round-trip; hard list and ask-path unchanged.
- **P2 (D1)** structured permission relay: 4th ladder kind `permission`. When `waiting` is
  true a guest may request to answer; daemon extracts the visible options via `capture()`,
  shows them, and on host approval types ONLY a validated digit + Enter through
  `sendKeyArgs`. Never raw bytes, never without host approval.
- **P3 (D3)** bell on `waiting` transition (host) and on your own name appearing in a
  say/chat (everyone).
- **P4 (E4)** macOS `display notification` alongside the bell, same osascript precedent as
  `/paste`.
- **P5 (E1)** connection-quality indicator in the status bar from T2's ping data
  (`~120ms` / `⚠ stale 12s`).
- **P6 (E3)** slash-command autocomplete: dim filtered list of jam's own commands while the
  input starts with `/`.
- **P7 (E5)** contrast/color-blind pass over `COLOR_PALETTE`.
