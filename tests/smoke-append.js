#!/usr/bin/env node
// tests/smoke-append.js
//
// Cross-platform smoke test for lib/append-with-lock.
// Verifies sequential append, truly concurrent append (5 child processes
// spawned in parallel via async spawn), lock cleanup, JSON integrity, and
// assertSafePath rejection of sensitive paths.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { appendWithLock, assertSafePath } = require('../lib/append-with-lock');

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

function expectThrow(fn, matchSubstr, label) {
  try {
    fn();
  } catch (e) {
    if (matchSubstr && !String(e.message).includes(matchSubstr)) {
      fail(`${label}: wrong error message: ${e.message}`);
    }
    return;
  }
  fail(`${label}: expected throw, none thrown`);
}

// Child-process mode: append one line and exit.
if (process.argv[2] === '--child') {
  const targetFile = process.argv[3];
  const payload = process.argv[4];
  try {
    appendWithLock(targetFile, payload + '\n');
    process.exit(0);
  } catch (e) {
    console.error(`child: ${e.message}`);
    process.exit(1);
  }
}

async function runConcurrent(N) {
  const children = [];
  for (let i = 0; i < N; i++) {
    const child = spawn(
      process.execPath,
      [__filename, '--child', tmpFile, JSON.stringify({ child: i })],
      { stdio: 'inherit' }
    );
    children.push(new Promise((resolve, reject) => {
      child.on('exit', (code) => {
        code === 0 ? resolve() : reject(new Error(`child exit ${code}`));
      });
      child.on('error', reject);
    }));
  }
  await Promise.all(children);
}

async function main() {
  cleanup();

  // 1. Sequential append
  appendWithLock(tmpFile, JSON.stringify({ seq: 1 }) + '\n');
  appendWithLock(tmpFile, JSON.stringify({ seq: 2 }) + '\n');
  const seqContent = fs.readFileSync(tmpFile, 'utf8');
  if (seqContent !== '{"seq":1}\n{"seq":2}\n') {
    fail(`sequential append: unexpected content ${JSON.stringify(seqContent)}`);
  }
  if (fs.existsSync(lockFile)) fail('sequential append: lock file leaked');

  // Mode check (POSIX only; Windows chmod is best-effort)
  if (process.platform !== 'win32') {
    const mode = fs.statSync(tmpFile).mode & 0o777;
    if (mode !== 0o600) fail(`sequential append: mode is ${mode.toString(8)}, expected 600`);
  }
  cleanup();

  // 2. Truly concurrent append from 5 child processes
  const N = 5;
  await runConcurrent(N);
  const concContent = fs.readFileSync(tmpFile, 'utf8');
  const lines = concContent.split('\n').filter(Boolean);
  if (lines.length !== N) fail(`concurrent append: expected ${N} lines, got ${lines.length}`);
  for (const line of lines) {
    try { JSON.parse(line); } catch { fail(`concurrent append: malformed JSON: ${line}`); }
  }
  if (fs.existsSync(lockFile)) fail('concurrent append: lock file leaked');
  cleanup();

  // 3. assertSafePath rejects sensitive paths
  const homeAwsPath = path.join(os.homedir(), '.aws', 'credentials');
  expectThrow(() => assertSafePath(homeAwsPath), 'sensitive directory', 'deny .aws');

  const homeSshPath = path.join(os.homedir(), '.ssh', 'authorized_keys');
  expectThrow(() => assertSafePath(homeSshPath), 'sensitive directory', 'deny .ssh');

  // 4. assertSafePath rejects paths outside allowed roots
  const rootPath = process.platform === 'win32' ? 'C:\\Windows\\system32\\evil.jsonl' : '/etc/evil.jsonl';
  expectThrow(() => assertSafePath(rootPath), 'outside allowed roots', 'deny /etc or system32');

  // 5. assertSafePath allows home and tmpdir
  try {
    assertSafePath(path.join(os.homedir(), '.ai-audit', 'bias-queue.jsonl'));
    assertSafePath(tmpFile);
  } catch (e) {
    fail(`safe path wrongly rejected: ${e.message}`);
  }

  console.log(`smoke OK (platform=${process.platform}, node=${process.version})`);
}

main().catch((e) => fail(e.message));
