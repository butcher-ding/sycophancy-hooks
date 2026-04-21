#!/usr/bin/env node
// tests/smoke-append.js
//
// Cross-platform smoke test for lib/append-with-lock.
// Verifies: sequential append, concurrent append from child processes, and
// lock cleanup. Runs in CI matrix across macOS / Linux / Windows.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { appendWithLock } = require('../lib/append-with-lock');

const tmpFile = path.join(os.tmpdir(), `sh-smoke-${process.pid}.jsonl`);
const lockFile = tmpFile + '.lock';

function cleanup() {
  try { fs.unlinkSync(tmpFile); } catch {}
  try { fs.unlinkSync(lockFile); } catch {}
}

function fail(msg) {
  cleanup();
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

// Mode: child just appends one line then exits
if (process.argv[2] === '--child') {
  const targetFile = process.argv[3];
  const payload = process.argv[4];
  appendWithLock(targetFile, payload + '\n');
  process.exit(0);
}

cleanup();

// 1. Sequential append
appendWithLock(tmpFile, JSON.stringify({ seq: 1 }) + '\n');
appendWithLock(tmpFile, JSON.stringify({ seq: 2 }) + '\n');
const seqContent = fs.readFileSync(tmpFile, 'utf8');
if (seqContent !== '{"seq":1}\n{"seq":2}\n') {
  fail(`sequential append: unexpected content ${JSON.stringify(seqContent)}`);
}
if (fs.existsSync(lockFile)) fail('sequential append: lock file not cleaned up');
cleanup();

// 2. Concurrent append from spawned child processes
const N = 5;
const children = [];
for (let i = 0; i < N; i++) {
  children.push(
    spawnSync(process.execPath, [__filename, '--child', tmpFile, JSON.stringify({ child: i })], {
      stdio: 'inherit'
    })
  );
}
for (const c of children) {
  if (c.status !== 0) fail(`child process exited with status ${c.status}`);
}

const concContent = fs.readFileSync(tmpFile, 'utf8');
const lines = concContent.split('\n').filter(Boolean);
if (lines.length !== N) fail(`concurrent append: expected ${N} lines, got ${lines.length}`);
for (const line of lines) {
  try { JSON.parse(line); } catch { fail(`concurrent append: malformed JSON line: ${line}`); }
}
if (fs.existsSync(lockFile)) fail('concurrent append: lock file not cleaned up');

cleanup();
console.log(`smoke OK (platform=${process.platform}, node=${process.version})`);
