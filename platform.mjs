// claude-jam's platform seam (v0.32 W0).
//
// THE RULE: this is the ONLY module allowed to spawn a platform binary — `osascript`, `pngpaste`,
// `afplay`, `pbcopy`, `open` and, when W1 lands, their PowerShell counterparts. Everything else
// in the project asks for the CAPABILITY (an image off the clipboard, a notification, a
// user-writable-only file) and never for the tool that provides it. A unit test enforces it, so
// a `spawnSync('osascript', …)` that creeps into a client is a red test rather than a Windows
// bug found by a user.
//
// tmux, claude, git, curl, cloudflared, tailscale and ttyd are NOT platform binaries: they are
// the tool's actual dependencies, they are spelled the same everywhere, and they stay where they
// are used.
//
// v0.32 W1 filled in the win32 side of every function here: PowerShell `Get-Clipboard -Format
// Image` for clipboardImage, a BurntToast/WinRT toast for notify, `System.Media.SoundPlayer` (or a
// beep pattern) for playSound, `%TEMP%`/`%APPDATA%\claude-jam` for the paths, an `icacls` ACL
// granting only the current user in place of chmod 600, `start` for openExternal. Exactly as W0
// predicted, each one was a branch inside one of these functions and nothing above the seam moved.
//
// HOW THOSE BRANCHES ARE VERIFIED, since nobody working on this project has a Windows machine:
// every DECISION they make lives in lib.mjs as a pure function (which argv, which principal,
// which .wav, which refusal) and is asserted on the `windows-latest` CI leg as well as here.
// What remains unverified is what only a person at a Windows keyboard can see or hear — a toast
// appearing, a knock sounding — and TESTING.md lists each one with the experiment that settles it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { UPLOAD_MAX, humanBytes, stateDirFor, configDirPath, historyFilePath, validHostKey,
  aclUser, aclArgs, parseIcaclsPrincipals,
  PS_ARGS, PS_ENV_FILE, PS_ENV_TITLE, PS_ENV_BODY, PS_CLIP_PNG, PS_TOAST, winSoundPlan } from './lib.mjs';

export const IS_MAC = process.platform === 'darwin';
export const IS_WINDOWS = process.platform === 'win32';

// --------------------------------------------------------------------------- paths ----
// `$TMPDIR` (the base) with no argument, `$TMPDIR/claude-jam-<port>` (one jam's state dir) with
// one. The join itself is lib's, because the state-dir NAME is a safety rule — `claude-jam clean`
// will only ever delete a directory whose basename parses back to a port — and that rule is
// tested where it is written, not here.
export function stateDir(port = null) {
  return port == null ? os.tmpdir() : stateDirFor(os.tmpdir(), port);
}

// `$XDG_CONFIG_HOME/claude-jam` or `~/.config/claude-jam`. On Windows this becomes
// `%APPDATA%\claude-jam` (W1), which is why no caller may build it out of homedir() itself.
export function configDir() { return configDirPath(os.homedir(), process.env); }
export function historyFile() { return historyFilePath(os.homedir(), process.env); }

// A file only its owner may read: the join token, session.json, the invite store, the input
// history. POSIX says 0600, and the mode is set as the file is created rather than after, so
// there is no window where it exists world-readable.
//
// v0.32 W1: Windows has no mode bit that means this. `{ mode: 0o600 }` is not ignored there — it
// is REINTERPRETED, as the read-only attribute and nothing else — so the port is an NTFS ACL with
// one entry (see restrictToUser). The security docs say ACL, in those words, rather than implying
// the mode carried over.
export function secureWrite(file, data) {
  fs.writeFileSync(file, data, { mode: 0o600 });
  if (IS_WINDOWS) restrictToUser(file);
  return file;
}

// The parent of a secureWrite: 0700, created only if missing.
export function secureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (IS_WINDOWS) restrictToUser(dir, { dir: true });
  return dir;
}

// `icacls` — a platform binary, so it is named here and nowhere else. Synchronous on purpose:
// the point of the call is that the file is not readable by anybody else BEFORE the token it
// holds is handed out, and an unawaited promise would put a window back in.
//
// A `false` is a DEGRADATION and not a hole, which is why it does not throw: the file keeps the
// ACL it inherited from `%APPDATA%` or `%TEMP%`, both of which are inside the user's own profile
// (current user + SYSTEM + Administrators — never other users, never a network principal). It is
// still worth knowing about, so the reason comes back rather than a bare boolean.
export const ICACLS = 'icacls';
export function restrictToUser(target, { dir = false, env = process.env } = {}) {
  const user = aclUser(env);
  if (!user) return { ok: false, why: 'no %USERNAME% in the environment, so there is no principal to grant to' };
  try {
    const r = spawnSync(ICACLS, aclArgs(target, user, { dir }), { encoding: 'utf8', windowsHide: true });
    if (r.error) return { ok: false, why: r.error.message };
    if (r.status !== 0) return { ok: false, why: (r.stderr || r.stdout || '').trim().split('\n')[0] || `icacls exited ${r.status}` };
    return { ok: true, user };
  } catch (e) { return { ok: false, why: e.message }; }
}

// Read the ACL back. This is what a test asserts against, and what a human debugging "who can
// read my token file" should run — so it hands back the parsed principals and the raw text both.
export function aclPrincipals(target) {
  try {
    const r = spawnSync(ICACLS, [String(target ?? '')], { encoding: 'utf8', windowsHide: true });
    if (r.error || r.status !== 0) return { ok: false, why: r.error?.message || `icacls exited ${r.status}`, principals: [] };
    return { ok: true, principals: parseIcaclsPrincipals(r.stdout, String(target ?? '')), text: r.stdout };
  } catch (e) { return { ok: false, why: e.message, principals: [] }; }
}

// v0.34: the one place the host key is read off disk — the daemon (to know what to compare
// against), and each client (to prove it is the host). Anything that is not a well-formed key
// comes back null, which every caller reads as "no key", i.e. a guest. Never logged, never
// returned in an error string: a missing key and an unreadable one are the same answer here,
// and the reason a human needs is hostKeyNotice()'s, which quotes the PATH and not the file.
export function readHostKey(file) {
  if (!file) return null;
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const key = raw.trim();
  return validHostKey(key) ? key : null;
}

// ------------------------------------------------------------------- notifications ----
// v0.17 P4: fired alongside P3's bell, because a bell only helps if the terminal is somewhere
// you can hear it. argv only — the title and the body arrive as arguments to a `run` handler,
// never interpolated into the script, so a message containing a quote, a backslash or a `$`
// cannot become AppleScript. Fire and forget by design: never awaited, output dropped, every
// failure swallowed. This is called from a render path, and a notification must not be able to
// cost a frame or throw.
export const NOTIFY_TITLE_MAX = 60;
export const NOTIFY_BODY_MAX = 200;

// v0.32 W1: powershell.exe, not pwsh. `Get-Clipboard -Format Image` is documented as Windows
// PowerShell 5.1 only, and the WinRT type accelerator the toast fallback uses needs the same
// runtime — so all three Windows capabilities go through the one interpreter that has both, and
// it is the one that ships with Windows.
const POWERSHELL = 'powershell.exe';

// Fire and forget, same contract as the macOS branch: never awaited, output dropped, every
// failure swallowed, and `false` when it did nothing. The title and body go in the ENVIRONMENT —
// PS_TOAST is a constant, so a body containing a quote, a `$` or a newline cannot become script.
function notifyWindows(title, body) {
  try {
    const child = spawn(POWERSHELL, [...PS_ARGS, PS_TOAST], {
      stdio: 'ignore',
      windowsHide: true,
      env: {
        ...process.env,
        [PS_ENV_TITLE]: String(title ?? 'claude-jam').slice(0, NOTIFY_TITLE_MAX),
        [PS_ENV_BODY]: String(body ?? '').slice(0, NOTIFY_BODY_MAX),
      },
    });
    child.on('error', () => { /* no powershell, or toasts are off: the bell still rang */ });
    child.unref();
    return true;
  } catch { return false; }
}

export function notify(title, body) {
  if (IS_WINDOWS) return notifyWindows(title, body);
  if (!IS_MAC) return false;
  try {
    const child = spawn('osascript', ['-e', 'on run argv',
      '-e', 'display notification (item 1 of argv) with title (item 2 of argv)',
      '-e', 'end run',
      String(body ?? '').slice(0, NOTIFY_BODY_MAX), String(title ?? 'claude-jam').slice(0, NOTIFY_TITLE_MAX)],
    { stdio: 'ignore', detached: false });
    child.on('error', () => { /* no osascript, or notifications are off: the bell still rang */ });
    child.unref();
    return true;
  } catch { return false; }
}

// The audible half (v0.25). Same contract as notify(): fire and forget, never awaited, never
// throws, `false` when it did nothing.
//
// THREE sounds, and they have to be distinguishable BY EAR, because the entire point is knowing
// without looking whether somebody needs approving:
//   knock  Submarine — a slow low "knock". Somebody is WAITING for you.
//   join   Glass     — one short chime. They are already in; nothing is owed.
//   nudge  Hero      — a person asking for you by name (v0.26).
// Named by SPEC.md v0.25 (Roy picked them), not chosen here — the v0.32 W0 placeholder had
// knock=Tink, and Tink next to Glass is two variations on the same short click.
// Verified present on this machine 2026-08-29: `ls /System/Library/Sounds` has all three.
export const SOUNDS = { knock: 'Submarine', join: 'Glass', nudge: 'Hero' };
export const MAC_SOUND_DIR = '/System/Library/Sounds';

// Linux, UNVERIFIED on this machine — said plainly rather than pretended. `paplay` takes the
// freedesktop .oga set that ships with most desktops; `aplay` is ALSA and plays WAV only, so it
// gets its own candidate list rather than being handed an .oga it would reject. Neither present,
// or no file found: silence, which is an acceptable answer and never an error a user sees.
// v0.32 W1 took the other branch: `System.Media.SoundPlayer` over a .wav from `%WINDIR%\Media`,
// and a per-kind `[console]::beep()` PATTERN when there is none — see winSoundPlan in lib.mjs.
const FD = '/usr/share/sounds/freedesktop/stereo';
const LINUX_SOUNDS = {
  paplay: { knock: [`${FD}/message-new-instant.oga`, `${FD}/bell.oga`],
    join: [`${FD}/service-login.oga`, `${FD}/complete.oga`],
    nudge: [`${FD}/message.oga`, `${FD}/bell.oga`] },
  aplay: { knock: ['/usr/share/sounds/alsa/Front_Center.wav'],
    join: ['/usr/share/sounds/alsa/Front_Left.wav'],
    nudge: ['/usr/share/sounds/alsa/Front_Right.wav'] },
};

// "Verify the files exist at startup once and remember the answer" — a render path must not pay
// a stat per sound, and a missing file must not be re-discovered forty times an hour. `null` is
// a remembered NO, which is why the cache is checked with `in` rather than for truthiness.
const soundCache = new Map();
export function soundFile(kind) {
  const k = String(kind ?? '');
  if (soundCache.has(k)) return soundCache.get(k);
  let hit = null;
  if (SOUNDS[k]) {
    if (IS_MAC) {
      const f = `${MAC_SOUND_DIR}/${SOUNDS[k]}.aiff`;
      if (fs.existsSync(f)) hit = { bin: 'afplay', file: f };
    } else if (IS_WINDOWS) {
      // v0.32 W1: a .wav out of %WINDIR%\Media through System.Media.SoundPlayer, or — on a
      // machine that has none of them — a per-kind BEEP PATTERN, so a knock is still not a join.
      // Which one it is, and which file, is winSoundPlan's decision and is unit-tested; this is
      // only the spawn. Remembered like every other kind: no stat per frame.
      const plan = winSoundPlan(k, fs.existsSync, process.env);
      if (plan) hit = { bin: POWERSHELL, file: plan.file, args: plan.args, env: plan.env, mode: plan.mode };
    } else {
      for (const bin of ['paplay', 'aplay']) {
        const found = (LINUX_SOUNDS[bin][k] || []).find((f) => fs.existsSync(f));
        // The binary is on PATH or it is not; spawn's 'error' handler is what finds out, and a
        // wrong guess here costs one silent child rather than an exception.
        if (found) { hit = { bin, file: found }; break; }
      }
    }
  }
  soundCache.set(k, hit);
  return hit;
}

export function playSound(kind) {
  const s = soundFile(kind);
  if (!s) return false;
  try {
    // `args` is the Windows plan's (a PowerShell script, with the .wav in the environment);
    // afplay/paplay/aplay take the file and nothing else, which is what the default spells.
    const child = spawn(s.bin, s.args ?? [s.file], {
      stdio: 'ignore',
      windowsHide: true,
      ...(s.env ? { env: { ...process.env, ...s.env } } : {}),
    });
    child.on('error', () => { /* no player installed: silence is acceptable */ });
    child.unref();
    return true;
  } catch { return false; }
}

// ---------------------------------------------------------------------- clipboard ----
// `/paste`: the clipboard as a PNG. pngpaste when it is installed, else osascript — every mac
// has it, and `«class PNGf»` is the clipboard type an image lands on.
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

// pngpaste when it is installed, else osascript. Both write the file themselves; what comes back
// is only whether one of them managed it, and why not.
function clipboardPngMac(file) {
  const png = spawnSync('pngpaste', [file], { encoding: 'utf8' });
  if (!png.error && png.status === 0) return { ok: true };
  const as = spawnSync('osascript', ['-e', OSASCRIPT_PNG.replace('%FILE%', file)], { encoding: 'utf8' });
  if (!as.error && as.status === 0) return { ok: true };
  return { ok: false, why: (as.stderr || png.stderr || '').trim().split('\n')[0] || 'nothing to paste' };
}

// v0.32 W1: the same answer through Windows PowerShell. The path rides in the ENVIRONMENT and the
// script is a constant — see PS_CLIP_PNG. Exit 3 is the script's own "there was no image", which
// is the ordinary case and deserves the ordinary sentence rather than a stack trace.
function clipboardPngWindows(file) {
  const r = spawnSync(POWERSHELL, [...PS_ARGS, PS_CLIP_PNG], {
    encoding: 'utf8', windowsHide: true, env: { ...process.env, [PS_ENV_FILE]: file },
  });
  if (r.error) return { ok: false, why: r.error.message };
  if (r.status === 3) return { ok: false, why: 'nothing to paste' };
  if (r.status !== 0) return { ok: false, why: (r.stderr || '').trim().split('\n')[0] || `powershell exited ${r.status}` };
  return { ok: true };
}

export function clipboardImage() {
  if (!IS_MAC && !IS_WINDOWS) {
    throw new Error('/paste reads an image off the clipboard, which claude-jam can only do on '
      + 'macOS and Windows — on this platform use /send <path>');
  }
  // mkdtemp, so the path is ours and has no character AppleScript, PowerShell or a shell could
  // read as anything but a path (there is no shell in either branch either: spawnSync with an
  // argv, and on Windows the filename is not in the script at all).
  const dir = fs.mkdtempSync(path.join(stateDir(), 'claude-jam-paste-'));
  const file = path.join(dir, `paste-${stamp()}.png`);
  try {
    const got = IS_MAC ? clipboardPngMac(file) : clipboardPngWindows(file);
    if (!got.ok) throw new Error(`no image on the clipboard (${got.why})`);
    const data = fs.readFileSync(file);
    if (!data.length) throw new Error('the clipboard image came back empty');
    if (data.length > UPLOAD_MAX) throw new Error(`${humanBytes(data.length)} is over the ${humanBytes(UPLOAD_MAX)} upload cap`);
    return { name: path.basename(file), data };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// v0.22A/v0.24: put one line on the clipboard. An invite link is a credential the host has to
// GET SOMEWHERE — into Slack, into a DM — and re-typing 200 base64url characters is not a plan.
// The text goes in on stdin, never on a command line (a link on an argv is a link in `ps`).
// Returns whether it landed, so the caller can say "copy this by hand" instead of lying.
export function copyText(text) {
  const cmd = IS_MAC ? ['pbcopy', []]
    : IS_WINDOWS ? ['clip', []]
      : ['xclip', ['-selection', 'clipboard']];
  try {
    const r = spawnSync(cmd[0], cmd[1], { input: String(text ?? ''), encoding: 'utf8' });
    return !r.error && r.status === 0;
  } catch { return false; }
}

// ------------------------------------------------------------------------ opening ----
// Hand a URL to whatever the desktop uses. Nothing calls this yet: the view URL and the relay
// URLs are printed for a human to click, and opening a browser from under a TUI is a decision
// nobody has asked for. It is here because it is part of the seam W1 has to fill in, and
// because the day something does want it, it must not reach for `open` on its own.
export function openExternal(url) {
  const u = String(url ?? '');
  if (!/^https?:\/\//.test(u)) return false; // never a file:// or a scheme handler
  const cmd = IS_MAC ? ['open', [u]] : IS_WINDOWS ? ['cmd', ['/c', 'start', '', u]] : ['xdg-open', [u]];
  try {
    // windowsHide: a console flashing up for a quarter of a second under a full-screen TUI is
    // the kind of thing that reads as a crash.
    const child = spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: false, windowsHide: true });
    child.on('error', () => { /* no opener: the URL was printed anyway */ });
    child.unref();
    return true;
  } catch { return false; }
}

// ------------------------------------------------------------- v0.23: mDNS ----
// Advertising a jam on the LAN and finding one. `dns-sd` is a platform binary like everything
// else in this file — it is Apple's Bonjour CLI, it ships in /usr/bin on macOS, the Bonjour
// installer puts the same tool on Windows, and avahi's compat package provides it on Linux — so
// the rule applies: no other module may name it, and a unit test says so.
//
// ONE tool rather than a per-OS pair. The alternative the spec allowed was `avahi-publish-service`
// plus `avahi-browse` on Linux, and it was not built: avahi-browse prints a completely different
// format, this machine has no avahi to verify a parser against, and shipping a parser written
// from a man page is exactly the confident-wrong-fix this project's `-Z` parser exists to avoid.
// A machine with neither gets discovery skipped, with a line saying so and the fix. That is a
// stated deviation, not an oversight.
//
// These two hand back the CHILD rather than a promise, because an advertisement is a long-lived
// tracked child with the same lifecycle discipline as ttyd and cloudflared — killed on exit,
// respawned with backoff — and that discipline lives in host.mjs beside the other relays. What
// belongs here is only "which binary, which argv".
//
// TODO(W1 — native Windows client): Bonjour's dns-sd.exe is the same CLI with the same output,
// so this needs a path probe (`%PROGRAMFILES%\Bonjour\dns-sd.exe`, and PATH) added to
// DNSSD_PATHS and nothing else — no second parser, no second lifecycle. If a platform ever turns
// up with avahi ONLY, that is when a second parser is owed, and it must be written against the
// real binary the way parseDnssdZone() was.
export const DNSSD_PATHS = ['/usr/bin/dns-sd', '/usr/local/bin/dns-sd', '/opt/homebrew/bin/dns-sd'];
export const DNSSD_MISSING = 'no dns-sd on this machine, so claude-jam cannot announce or find '
  + 'jams on the network — everything else works, and an invite link or a ws:// URL still joins. '
  + 'macOS ships it in /usr/bin; on Linux install avahi-utils, on Windows Apple Bonjour. '
  + 'JAM_DNSSD=<path> points at one somewhere else.';

// `JAM_DNSSD` first (the same escape hatch JAM_TAILSCALE and JAM_TTYD give), then the known
// locations. A refusal carries its reason and the fix, never a bare null.
export function resolveDnssd(env = process.env, exists = fs.existsSync) {
  const override = env.JAM_DNSSD;
  if (override) {
    return exists(override) ? { ok: true, bin: override }
      : { ok: false, why: `JAM_DNSSD points at ${override}, which is not there` };
  }
  for (const p of DNSSD_PATHS) if (exists(p)) return { ok: true, bin: p };
  return { ok: false, why: DNSSD_MISSING };
}

export function discoveryAvailable(env = process.env) { return resolveDnssd(env).ok; }

// `dns-sd -R "<name>" _claude-jam._tcp local <port> jam=… host=… …`. The TXT strings arrive
// already built (and already reduced to six keys) from lib's discoveryTxt — this function does
// not decide what is published, it only publishes it. Every value goes on the argv as its own
// word, so a jam name containing a space, a quote or a `$` is a name and never a second argument.
export function advertiseSpawn({ name, type, domain = 'local', port, txt = [] } = {}, env = process.env) {
  const tool = resolveDnssd(env);
  if (!tool.ok) return { ok: false, why: tool.why };
  try {
    const child = spawn(tool.bin, ['-R', String(name), String(type), String(domain), String(port),
      ...txt.map(String)], { stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, child, bin: tool.bin };
  } catch (e) { return { ok: false, why: e.message }; }
}

export function browseSpawn({ type, domain = 'local' } = {}, env = process.env) {
  const tool = resolveDnssd(env);
  if (!tool.ok) return { ok: false, why: tool.why };
  try {
    const child = spawn(tool.bin, ['-Z', String(type), String(domain)], { stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, child, bin: tool.bin };
  } catch (e) { return { ok: false, why: e.message }; }
}

// Browse for `ms` and hand back what was printed, for lib's parseDnssdZone to read. dns-sd never
// exits on its own — it is a watch, not a query — so the timer is what ends it, and the child is
// killed by the pid we spawned, never by name.
export const BROWSE_BUF_MAX = 256 * 1024; // a busy network is not a reason to grow without bound
export async function browseText({ type, domain = 'local', ms = 3000 } = {}, env = process.env) {
  const s = browseSpawn({ type, domain }, env);
  if (!s.ok) return { ok: false, why: s.why, text: '' };
  let text = '';
  // The tail, when it comes to that: parseDnssdZone drops the half-line a truncation leaves
  // behind rather than reading it as a record, which is exactly what it was made total for.
  s.child.stdout.on('data', (d) => { text += d; if (text.length > BROWSE_BUF_MAX) text = text.slice(-BROWSE_BUF_MAX); });
  s.child.stderr.on('data', () => { /* dns-sd says nothing useful here; the timer decides */ });
  s.child.on('error', () => { /* it vanished mid-browse: whatever arrived is the answer */ });
  await new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });
  try { s.child.kill('SIGTERM'); } catch { /* already gone */ }
  return { ok: true, text, bin: s.bin };
}
