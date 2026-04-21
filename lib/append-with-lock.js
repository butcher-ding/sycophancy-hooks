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
// Sensitive: audit files contain prompt previews. Created with mode 0600 and
// also chmod'd after every write (defence-in-depth for existing files).

const fs = require('fs');
const os = require('os');
const path = require('path');

const LOCK_RETRY_MS = 10;
const LOCK_MAX_WAIT_MS = 500;

let chmodWarned = false;

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
    // ESRCH = no such process (dead); EPERM = exists but not ours (alive)
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

function tightenPermissions(filePath) {
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // chmod may fail on Windows / network FS — not fatal (already warned below)
  }
  if (process.platform === 'win32' && !chmodWarned) {
    process.stderr.write(
      '[sycophancy-hooks] NOTE: On Windows, POSIX 0600 cannot isolate audit ' +
      'files from other local Windows users. Audit files may contain prompt ' +
      'previews; see README "Privacy note".\n'
    );
    chmodWarned = true;
  }
}

// Allowlist of prefix roots that appendWithLock will write to. All paths must
// resolve under one of these. Denylist catches sensitive subdirectories.
const HOME = os.homedir();
const ALLOW_ROOTS = [HOME, os.tmpdir()];
const DENY_SUBPATHS = [
  path.join(HOME, '.ssh'),
  path.join(HOME, '.aws'),
  path.join(HOME, '.gnupg'),
  path.join(HOME, '.config', 'gh'),
  path.join(HOME, '.netrc'),
  path.join(HOME, '.docker'),
  path.join(HOME, '.kube')
];

function isUnder(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function assertSafePath(filePath) {
  const resolved = path.resolve(filePath);
  if (!ALLOW_ROOTS.some((root) => isUnder(resolved, root))) {
    throw new Error(
      `[sycophancy-hooks] refusing to write outside allowed roots ` +
      `(home or tmpdir): ${resolved}`
    );
  }
  for (const denied of DENY_SUBPATHS) {
    if (isUnder(resolved, denied)) {
      throw new Error(
        `[sycophancy-hooks] refusing to write into sensitive directory ` +
        `${denied}: ${resolved}`
      );
    }
  }
}

function appendWithLock(filePath, line) {
  assertSafePath(filePath);
  const dir = path.dirname(filePath);
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}

  const lockPath = filePath + '.lock';
  const lockFd = acquireLock(lockPath);

  // Open the target file with 0600 on creation so we never have a 0644 window.
  // For existing files, mode arg is ignored — we chmod below as backup.
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

module.exports = { appendWithLock, assertSafePath };
