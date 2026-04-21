#!/usr/bin/env node
// adapters/shared-memory.js
//
// Advanced adapter example: writes audit records into a multi-AI shared memory
// structure. Organizes records by domain, supports source tagging, and maintains
// hierarchical index files.
//
// Directory layout:
//   $SHARED_MEMORY_DIR/
//     MEMORY.md                      — top-level index
//     domains/
//       lessons/
//         _index.md                   — domain index
//         bias-queue.jsonl            — pending bias audits
//         bias-log.jsonl              — reviewed bias audits
//         corrections-queue.jsonl     — pending corrections
//         corrections.jsonl           — reviewed corrections
//
// Source tagging convention for correction/bias records:
//   [user:said]      — User explicitly stated
//   [ai:inferred]    — AI inferred from context (pending user verification)
//   [user:verified]  — AI inferred, user confirmed
//
// This is an advanced example. Most users should start with simple-jsonl.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

if (process.platform === 'win32') {
  throw new Error('shared-memory adapter requires POSIX fcntl (Windows not supported).');
}

const SHARED_MEMORY_DIR = process.env.SHARED_MEMORY_DIR || path.join(os.homedir(), '.shared-memory');
const LESSONS_DIR = path.join(SHARED_MEMORY_DIR, 'domains', 'lessons');

const PATHS = {
  bias_queue: path.join(LESSONS_DIR, 'bias-queue.jsonl'),
  bias_log: path.join(LESSONS_DIR, 'bias-log.jsonl'),
  bias_skipped: path.join(LESSONS_DIR, 'bias-skipped.jsonl'),
  correction_queue: path.join(LESSONS_DIR, 'corrections-queue.jsonl'),
  correction_log: path.join(LESSONS_DIR, 'corrections.jsonl'),
  correction_skipped: path.join(LESSONS_DIR, 'corrections-skipped.jsonl'),
  lessons_index: path.join(LESSONS_DIR, '_index.md'),
  memory_index: path.join(SHARED_MEMORY_DIR, 'MEMORY.md')
};

function appendWithLock(filePath, line) {
  const dir = path.dirname(filePath);
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  const pythonScript = `
import fcntl, sys, os
path = sys.argv[1]
line = sys.stdin.read()
with open(path, 'a') as f:
    fcntl.flock(f, fcntl.LOCK_EX)
    try:
        f.write(line)
    finally:
        fcntl.flock(f, fcntl.LOCK_UN)
# Tighten permissions: audit files contain prompt previews (sensitive)
os.chmod(path, 0o600)
`.trim();
  execFileSync('python3', ['-c', pythonScript, filePath], {
    input: line,
    stdio: ['pipe', 'ignore', 'inherit']
  });
}

function readJSONL(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf8');
  return raw.split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

function ensureIndexFiles() {
  try { fs.mkdirSync(LESSONS_DIR, { recursive: true }); } catch {}

  if (!fs.existsSync(PATHS.lessons_index)) {
    fs.writeFileSync(PATHS.lessons_index, `# domains/lessons/

Audit records and corrections captured via sycophancy-hooks.

## Files

- \`bias-queue.jsonl\` — Pending bias audits awaiting user review
- \`bias-log.jsonl\` — Reviewed bias audits (history)
- \`bias-skipped.jsonl\` — AI-judged non-judgment turns
- \`corrections-queue.jsonl\` — Pending corrections awaiting user review
- \`corrections.jsonl\` — Reviewed corrections (history)
- \`corrections-skipped.jsonl\` — AI-judged non-corrections

## Source tagging

When adding records manually, tag the source:
- \`[user:said]\` — User explicitly stated
- \`[ai:inferred]\` — AI inferred (pending verification)
- \`[user:verified]\` — AI inferred, user confirmed
`);
  }

  if (!fs.existsSync(PATHS.memory_index)) {
    fs.writeFileSync(PATHS.memory_index, `# Shared Memory

Multi-AI shared memory root. Each AI tool reads/writes via domain files.

## Top-level

- \`domains/\` — Organized by topic
  - \`lessons/\` — Audit records, corrections, accumulated rules

## Conventions

- Query path: top-level → domain \`_index.md\` → specific file (max 3 hops)
- Write path: write to target domain, update \`_index.md\`
- Do NOT write bias/correction records here directly; use sycophancy-hooks to capture them
`);
  }
}

module.exports = {
  appendBias(record, type = 'queue') {
    ensureIndexFiles();
    const p = PATHS[`bias_${type}`] || PATHS.bias_queue;
    appendWithLock(p, JSON.stringify(record) + '\n');
  },

  appendCorrection(record, type = 'queue') {
    ensureIndexFiles();
    const p = PATHS[`correction_${type}`] || PATHS.correction_queue;
    appendWithLock(p, JSON.stringify(record) + '\n');
  },

  appendSkip(record, kind) {
    ensureIndexFiles();
    const p = kind === 'bias' ? PATHS.bias_skipped : PATHS.correction_skipped;
    appendWithLock(p, JSON.stringify(record) + '\n');
  },

  loadQueue(kind) {
    const p = kind === 'bias' ? PATHS.bias_queue : PATHS.correction_queue;
    return readJSONL(p);
  },

  promoteToLog(record, kind) {
    const logPath = kind === 'bias' ? PATHS.bias_log : PATHS.correction_log;
    appendWithLock(logPath, JSON.stringify(record) + '\n');
  },

  PATHS,
  SHARED_MEMORY_DIR
};
