// lib/append-with-lock.js
//
// Cross-platform synchronous JSONL append with advisory file locking.
// Uses a `.lock` sentinel file via O_EXCL — works on macOS, Linux, and Windows
// without Python or native deps. Degrades to unlocked append if lock acquisition
// times out (better than blocking a Claude Code hook indefinitely).
//
// Sensitive: audit files contain prompt previews. Mode 0600 after write.

const fs = require('fs');
const path = require('path');

const LOCK_RETRY_MS = 10;
const LOCK_MAX_WAIT_MS = 500;
const STALE_LOCK_MS = 5000;

function sleepSync(ms) {
  const end = Date.now() + ms;
  // Intentional busy-wait: hooks are short-lived one-shot processes,
  // setTimeout can't be awaited in sync path, and Atomics.wait adds
  // SharedArrayBuffer dependency for a 10ms nap. Real conflicts are rare.
  while (Date.now() < end) { /* spin */ }
}

function acquireLock(lockPath) {
  const deadline = Date.now() + LOCK_MAX_WAIT_MS;
  while (Date.now() < deadline) {
    try {
      return fs.openSync(lockPath, 'wx');
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const st = fs.statSync(lockPath);
        if (Date.now() - st.mtimeMs > STALE_LOCK_MS) {
          try { fs.unlinkSync(lockPath); } catch {}
          continue;
        }
      } catch {
        // Lock file disappeared between stat and unlink — retry
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
    // Windows and some network filesystems don't honor chmod — not fatal.
    // Caller should not rely on fs permissions as sole secrecy control.
  }
}

function appendWithLock(filePath, line) {
  const dir = path.dirname(filePath);
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}

  const lockPath = filePath + '.lock';
  const fd = acquireLock(lockPath);

  if (fd === null) {
    // Degraded mode: lock unavailable after max wait — append anyway rather
    // than block the hook. On POSIX, O_APPEND makes short writes atomic per
    // syscall, so single-line JSONL append is safe even without the sentinel.
    fs.appendFileSync(filePath, line);
    tightenPermissions(filePath);
    return;
  }

  try {
    fs.appendFileSync(filePath, line);
    tightenPermissions(filePath);
  } finally {
    try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(lockPath); } catch {}
  }
}

module.exports = { appendWithLock };
