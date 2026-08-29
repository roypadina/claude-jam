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
// Today every implementation here is the macOS one, moved unchanged from where it used to live.
// TODO(W1 — native Windows client): add the win32 branch to each function — PowerShell
// `Get-Clipboard -Format Image` for clipboardImage, a BurntToast/WinRT toast for notify,
// `System.Media.SoundPlayer` for playSound, `%TEMP%`/`%APPDATA%\claude-jam` for the paths, an
// ACL that grants only the current user in place of chmod 600, and `start` for openExternal.
// Each of those is a branch inside one of these functions and nothing else has to change.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { UPLOAD_MAX, humanBytes, stateDirFor, configDirPath, historyFilePath } from './lib.mjs';

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
// TODO(W1): Windows has no mode bits that mean this — it needs an ACL granting the current user
// only, and the security docs have to say ACL rather than pretend 0600 carried over.
export function secureWrite(file, data) {
  fs.writeFileSync(file, data, { mode: 0o600 });
  return file;
}

// The parent of a secureWrite: 0700, created only if missing.
export function secureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
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
export function notify(title, body) {
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

// The audible half. Nothing calls this yet — v0.25 (audible join events) is the batch that
// will — and it is here now so that the batch which adds the sounds does not also have to add
// the seam. Same contract as notify(): fire and forget, never throws, false when it did nothing.
export const SOUNDS = { knock: 'Tink', join: 'Glass', leave: 'Bottle', alert: 'Funk' };
export function playSound(kind) {
  const name = SOUNDS[String(kind ?? '')];
  if (!name || !IS_MAC) return false;
  try {
    const child = spawn('afplay', [`/System/Library/Sounds/${name}.aiff`], { stdio: 'ignore' });
    child.on('error', () => { /* no afplay, or the sound is missing: silence is acceptable */ });
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

export function clipboardImage() {
  if (!IS_MAC) {
    throw new Error('/paste reads a PNG off the macOS clipboard — on this platform use /send <path>');
  }
  // mkdtemp, so the path is ours and has no character AppleScript or a shell could read as
  // anything but a path (there is no shell here either: spawnSync with an argv).
  const dir = fs.mkdtempSync(path.join(stateDir(), 'claude-jam-paste-'));
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
    const child = spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: false });
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
