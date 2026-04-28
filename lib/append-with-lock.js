// lib/append-with-lock.js
//
// Cross-platform synchronous JSONL append with advisory file locking.
// Uses a `.lock` sentinel file via O_EXCL — works on macOS, Linux, and Windows
// without Python or native deps. The lock file carries the owner's PID, so
// orphan detection is liveness-based (not mtime-based) and less prone to
// racing with a legitimate new owner.
//
// Degrades to unlocked append if lock acquisition times out — hooks should
// never block Claude Code indefinitely. JSONL append on POSIX is atomic per
// syscall for <PIPE_BUF writes, so degraded mode still preserves line shape.
//
// Path safety: writes are confined to an explicit allowlist of roots
// (~/.ai-audit, ~/.shared-memory, tmpdir, plus $SYCOPHANCY_ALLOW_ROOTS).
// Parent directories are resolved via fs.realpathSync to defeat symlink
// bypasses that would let a malicious env var redirect writes into ~/.ssh
// or similar sensitive targets.
//
// Sensitive: audit files contain prompt previews. Files are created at 0600,
// existing files are chmod'd to 0600 before and after every append.

const fs = require('fs');
const os = require('os');
const path = require('path');

const LOCK_RETRY_MS = 10;
const LOCK_MAX_WAIT_MS = 500;

const HOME = os.homedir();
const WIN_WARN_SENTINEL = path.join(HOME, '.sycophancy-hooks-winwarned');

function sleepSync(ms) {
  const end = Date.now() + ms;
  // Intentional busy-wait: hooks are short-lived one-shot processes,
  // setTimeout can't block a sync path, and Atomics.wait would require
  // SharedArrayBuffer for a 10ms nap. Real lock contention is rare.
  while (Date.now() < end) { /* spin */ }
}

function pidAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // ESRCH = no such process (dead); EPERM = exists but not ours (alive).
    // Note: EPERM may produce a false-positive if PID was recycled to an
    // unrelated process owned by another user. Degraded mode (append without
    // lock after 500ms) bounds the impact.
    return e.code === 'EPERM';
  }
}

function readLockPid(lockPath) {
  try {
    const raw = fs.readFileSync(lockPath, 'utf8').trim();
    const pid = parseInt(raw, 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

function acquireLock(lockPath) {
  const deadline = Date.now() + LOCK_MAX_WAIT_MS;
  while (Date.now() < deadline) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      try {
        fs.writeSync(fd, String(process.pid));
      } catch {
        // Lock created but we failed to write PID — still hold the lock
      }
      return fd;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const pidBefore = readLockPid(lockPath);
      if (pidBefore !== null && !pidAlive(pidBefore)) {
        // Orphan candidate. Re-read to ensure PID hasn't changed under us
        // (a new legitimate owner could have replaced the file). Only unlink
        // when we see the same dead PID twice.
        const pidNow = readLockPid(lockPath);
        if (pidNow === pidBefore) {
          try { fs.unlinkSync(lockPath); } catch {}
        }
        continue;
      }
      sleepSync(LOCK_RETRY_MS);
    }
  }
  return null;
}

function warnWindowsChmodOnce() {
  if (process.platform !== 'win32') return;
  try {
    if (fs.existsSync(WIN_WARN_SENTINEL)) return;
  } catch { return; }
  try {
    process.stderr.write(
      '[sycophancy-hooks] NOTE: On Windows, POSIX 0600 cannot isolate audit ' +
      'files from other local Windows users. Audit files may contain prompt ' +
      'previews; see README "Privacy note". This warning prints once per ' +
      `machine; delete ${WIN_WARN_SENTINEL} to reset.\n`
    );
    fs.writeFileSync(WIN_WARN_SENTINEL, new Date().toISOString() + '\n');
  } catch {
    // Best-effort — if we can't write the sentinel, we'll warn again next time
  }
}

function tightenPermissions(filePath) {
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // chmod may fail on Windows / network FS — not fatal
  }
  warnWindowsChmodOnce();
}

// Default allowed roots. Users can extend via $SYCOPHANCY_ALLOW_ROOTS
// (colon-separated on POSIX, semicolon on Windows — same syntax as PATH).
// Explicit allowlist beats blacklist: we don't have to chase every sensitive
// dotfile (~/.npmrc, ~/.gitconfig, ...) as the denylist approach would.
function defaultAllowRoots() {
  return [
    path.join(HOME, '.ai-audit'),
    path.join(HOME, '.shared-memory'),
    os.tmpdir()
  ];
}

function parseAllowRoots() {
  const base = defaultAllowRoots();
  const extra = process.env.SYCOPHANCY_ALLOW_ROOTS;
  // Type-check before splitting: rejects non-string values and empty strings
  // so a poisoned env (e.g. exported as literal "undefined") can't extend the
  // allowlist. Each entry must be an absolute path — relative paths get dropped
  // to prevent escalation from a writable cwd into parent dirs.
  if (typeof extra === 'string' && extra.length > 0) {
    const sep = process.platform === 'win32' ? ';' : ':';
    const parsed = extra
      .split(sep)
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((p) => path.isAbsolute(p));
    base.push(...parsed);
  }
  // Resolve each root through realpath so symlinked roots compare correctly.
  return base.map((r) => {
    try { return fs.realpathSync(r); } catch { return path.resolve(r); }
  });
}

function isUnder(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// Resolve a path while following symlinks on the parent directory. This
// defeats the attack where `~/.ai-audit/foo.jsonl` is a symlink pointing
// into `~/.ssh/authorized_keys`: we compare the realpath-of-parent + basename
// against the allowlist, so the symlinked target is detected before we write.
function safeResolve(filePath) {
  const resolved = path.resolve(filePath);
  const parent = path.dirname(resolved);
  const base = path.basename(resolved);
  try {
    const realParent = fs.realpathSync(parent);
    return path.join(realParent, base);
  } catch {
    // Parent doesn't exist yet — no symlink to follow, resolved is safe
    return resolved;
  }
}

function assertSafePath(filePath) {
  const real = safeResolve(filePath);
  const roots = parseAllowRoots();
  if (!roots.some((root) => isUnder(real, root))) {
    throw new Error(
      `[sycophancy-hooks] refusing to write outside allowed roots. ` +
      `Resolved: ${real}. Allowed: ${roots.join(', ')}. ` +
      `Extend via SYCOPHANCY_ALLOW_ROOTS (PATH-style separator) if needed.`
    );
  }
}

function appendWithLock(filePath, line) {
  assertSafePath(filePath);
  const dir = path.dirname(filePath);
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}

  const lockPath = filePath + '.lock';
  const lockFd = acquireLock(lockPath);

  // Zero-window permissions: if file already exists with looser perms, tighten
  // BEFORE opening. Silent failure if missing — fs.openSync with 0o600 below
  // will then create it at 0600 from byte zero.
  try { fs.chmodSync(filePath, 0o600); } catch {}

  let fileFd;
  try {
    fileFd = fs.openSync(filePath, 'a', 0o600);
    fs.writeSync(fileFd, line);
  } finally {
    if (fileFd !== undefined) {
      try { fs.closeSync(fileFd); } catch {}
    }
    tightenPermissions(filePath);
    if (lockFd !== null) {
      try { fs.closeSync(lockFd); } catch {}
      try { fs.unlinkSync(lockPath); } catch {}
    }
  }
}

module.exports = { appendWithLock, assertSafePath, parseAllowRoots };
