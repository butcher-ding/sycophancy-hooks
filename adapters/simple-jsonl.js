#!/usr/bin/env node
// adapters/simple-jsonl.js
//
// Default adapter: writes audit records as JSONL to `$AI_AUDIT_DIR/<type>.jsonl`.
// Uses a cross-platform `.lock` sentinel for advisory locking.
//
// This is a reference implementation. The core hooks currently write inline;
// this adapter provides the same behavior as a standalone module for users
// who want to swap backends without forking the core hooks.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { appendWithLock } = require('../lib/append-with-lock');

const AUDIT_DIR = process.env.AI_AUDIT_DIR || path.join(os.homedir(), '.ai-audit');

const PATHS = {
  bias_queue: process.env.BIAS_QUEUE_PATH || path.join(AUDIT_DIR, 'bias-queue.jsonl'),
  bias_log: process.env.BIAS_LOG_PATH || path.join(AUDIT_DIR, 'bias-log.jsonl'),
  bias_skipped: process.env.BIAS_SKIPPED_PATH || path.join(AUDIT_DIR, 'bias-skipped.jsonl'),
  correction_queue: process.env.CORRECTIONS_QUEUE_PATH || path.join(AUDIT_DIR, 'corrections-queue.jsonl'),
  correction_log: process.env.CORRECTIONS_LOG_PATH || path.join(AUDIT_DIR, 'corrections.jsonl'),
  correction_skipped: process.env.CORRECTIONS_SKIPPED_PATH || path.join(AUDIT_DIR, 'corrections-skipped.jsonl')
};

function readJSONL(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf8');
  return raw.split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

module.exports = {
  appendBias(record, type = 'queue') {
    const p = PATHS[`bias_${type}`] || PATHS.bias_queue;
    appendWithLock(p, JSON.stringify(record) + '\n');
  },

  appendCorrection(record, type = 'queue') {
    const p = PATHS[`correction_${type}`] || PATHS.correction_queue;
    appendWithLock(p, JSON.stringify(record) + '\n');
  },

  appendSkip(record, kind) {
    // kind: 'bias' | 'correction'
    const p = kind === 'bias' ? PATHS.bias_skipped : PATHS.correction_skipped;
    appendWithLock(p, JSON.stringify(record) + '\n');
  },

  loadQueue(kind) {
    // kind: 'bias' | 'correction'
    const p = kind === 'bias' ? PATHS.bias_queue : PATHS.correction_queue;
    return readJSONL(p);
  },

  // Helper: move record from queue to main log (after human review)
  promoteToLog(record, kind) {
    const logPath = kind === 'bias' ? PATHS.bias_log : PATHS.correction_log;
    appendWithLock(logPath, JSON.stringify(record) + '\n');
  },

  PATHS
};
