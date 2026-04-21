#!/usr/bin/env node
// correction-write.js
// Stop hook. Extracts <correction>{json}</correction> block from AI response
// and appends to queue JSONL (for human review). Increments missing counter
// when no block found despite correction-detect flag being set.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { appendWithLock } = require('../lib/append-with-lock');

const STATE_DIR = path.join(os.homedir(), '.claude', 'hooks', 'state');

// Configurable memory paths via env vars
const AUDIT_DIR = process.env.AI_AUDIT_DIR || path.join(os.homedir(), '.ai-audit');
const CORRECTIONS_PATH = process.env.CORRECTIONS_LOG_PATH || path.join(AUDIT_DIR, 'corrections.jsonl');
const CORRECTION_QUEUE_PATH = process.env.CORRECTIONS_QUEUE_PATH || path.join(AUDIT_DIR, 'corrections-queue.jsonl');
const CORRECTIONS_SKIPPED_PATH = process.env.CORRECTIONS_SKIPPED_PATH || path.join(AUDIT_DIR, 'corrections-skipped.jsonl');

function missingPath(sessionId) {
  return path.join(STATE_DIR, `missing-correction-count.${sessionId}`);
}

function incrementMissing(sessionId, preview) {
  const p = missingPath(sessionId);
  let state = { count: 0, previews: [] };
  try { state = JSON.parse(fs.readFileSync(p, 'utf8')); } catch {}
  state.count = (state.count || 0) + 1;
  state.previews = [...(state.previews || []), preview].slice(-3);
  try { fs.mkdirSync(path.dirname(p), { recursive: true }); } catch {}
  fs.writeFileSync(p, JSON.stringify(state), { mode: 0o600 });
  return state;
}

function resetMissing(sessionId) {
  try { fs.unlinkSync(missingPath(sessionId)); } catch {}
}

// Exit hint for all exit(2) blocks
function writeExitHint() {
  process.stderr.write(
    '\n⚠️ This is a reminder for NEXT response, not a request to re-send now.\n' +
    '此為下次回應的提醒，上輪主論述已送出。\n' +
    'Do NOT send a bare <correction> block alone.\n' +
    'Wait for user\'s next turn, then attach full response + corrected block.\n'
  );
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  try {
    const payload = JSON.parse(input || '{}');
    const sessionId = payload.session_id || 'unknown';
    const transcriptPath = payload.transcript_path;

    const flagPath = path.join(STATE_DIR, `pending-correction.${sessionId}`);
    if (!fs.existsSync(flagPath)) process.exit(0);

    let flagData = {};
    try { flagData = JSON.parse(fs.readFileSync(flagPath, 'utf8')); } catch {}
    try { fs.unlinkSync(flagPath); } catch {}

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      process.stderr.write('correction-write: transcript not found, skip\n');
      process.exit(0);
    }

    const lastAssistantText = getLastAssistantText(transcriptPath);
    if (!lastAssistantText) {
      process.stderr.write('correction-write: assistant output empty, skip\n');
      process.exit(0);
    }

    const block = extractCorrectionBlock(lastAssistantText);
    if (!block) {
      const preview = (flagData.user_prompt_preview || '').slice(0, 120);
      const state = incrementMissing(sessionId, preview);
      if (state.count >= 3) {
        const previewList = (state.previews || []).map((p, i) => `  ${i + 1}. ${p}`).join('\n');
        process.stderr.write(
          `\x1b[31m\x1b[1m⚠️⚠️⚠️ correction-gate: ${state.count} missed corrections accumulated ⚠️⚠️⚠️\x1b[0m\n` +
          `Last ${state.previews.length} user previews:\n${previewList}\n` +
          'Next trigger will inject escalation warning. If these weren\'t really corrections, output three skip blocks in next response.\n'
        );
      } else {
        process.stderr.write(
          `⚠️ correction-gate: last turn had correction trigger phrase but AI emitted no <correction> block. (accumulated ${state.count} / 3)\n` +
          `Trigger preview: ${preview}\n` +
          'If it was a real correction, record it next time. If not (joke/quote), output {"skip": true, ...}\n'
        );
      }
      process.exit(0);
    }

    let parsed;
    try {
      parsed = JSON.parse(block);
    } catch (e) {
      process.stderr.write(`correction-write: JSON parse failed — ${e.message}\n`);
      writeExitHint();
      process.exit(0);
    }

    if (parsed.skip === true) {
      const skipRecord = {
        id: `skip-${Date.now()}`,
        timestamp: new Date().toISOString(),
        session_id: sessionId,
        reason: parsed.reason || '(no reason)',
        user_prompt_preview: flagData.user_prompt_preview || ''
      };
      try {
        appendWithLock(CORRECTIONS_SKIPPED_PATH, JSON.stringify(skipRecord) + '\n');
      } catch (e) {
        process.stderr.write(`correction-write: skip log write failed — ${e.message}\n`);
      }
      resetMissing(sessionId);
      process.stderr.write(
        `correction-write: AI judged non-correction, skip logged — ${parsed.reason || '(no reason)'}\n`
      );
      process.exit(0);
    }

    // Validate required fields
    const required = ['scene', 'wrong', 'correct'];
    const missing = required.filter((k) => !parsed[k]);
    if (missing.length > 0) {
      process.stderr.write(
        `correction-write: correction block missing fields ${missing.join(',')}, not written\n`
      );
      writeExitHint();
      process.exit(0);
    }

    const record = {
      id: `corr-${Date.now()}`,
      timestamp: new Date().toISOString(),
      session_id: sessionId,
      scene: parsed.scene,
      wrong: parsed.wrong,
      correct: parsed.correct,
      category: parsed.category || 'persona',
      priority: parsed.priority || 'rule',
      pinned: parsed.pinned === true
    };

    // Write to queue (not main log) — awaits user review
    appendWithLock(CORRECTION_QUEUE_PATH, JSON.stringify(record) + '\n');
    resetMissing(sessionId);
    process.stderr.write(
      `✓ correction queued [${record.category}/${record.priority}${record.pinned ? '/pinned' : ''}]: ${String(record.scene).slice(0, 60)}\n` +
      `(Next SessionStart will auto-popup for user review.)\n`
    );
    process.exit(0);
  } catch (err) {
    process.stderr.write(`correction-write: internal error — ${err.message}\n`);
    process.exit(0);
  }
});

function getLastAssistantText(transcriptPath) {
  const TAIL_BYTES = 256 * 1024;
  const stat = fs.statSync(transcriptPath);
  const readFrom = Math.max(0, stat.size - TAIL_BYTES);
  const length = Math.min(TAIL_BYTES, stat.size);
  const fd = fs.openSync(transcriptPath, 'r');
  let raw;
  try {
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, readFrom);
    raw = buf.toString('utf8');
  } finally { fs.closeSync(fd); }
  const lines = raw.split('\n');
  const usable = (readFrom > 0 ? lines.slice(1) : lines).filter((l) => l.trim());
  for (let i = usable.length - 1; i >= 0; i--) {
    let evt;
    try { evt = JSON.parse(usable[i]); } catch { continue; }
    const text = extractAssistantText(evt);
    if (text) return text;
  }
  return null;
}

function extractAssistantText(evt) {
  const isAssistant =
    evt.type === 'assistant' ||
    evt.role === 'assistant' ||
    evt.message?.role === 'assistant';
  if (!isAssistant) return null;
  const content = evt.message?.content ?? evt.content;
  if (!content) return null;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const texts = [];
    for (const part of content) {
      if (typeof part === 'string') texts.push(part);
      else if (part?.type === 'text' && typeof part.text === 'string') texts.push(part.text);
    }
    return texts.join('\n').trim() || null;
  }
  return null;
}

function extractCorrectionBlock(text) {
  // Match the LAST <correction> block in the response (not the first)
  // in case AI quoted an old one earlier.
  const regex = /<correction>\s*([\s\S]*?)\s*<\/correction>/g;
  let match;
  let lastContent = null;
  while ((match = regex.exec(text)) !== null) {
    lastContent = match[1];
  }
  if (!lastContent) return null;
  return lastContent.replace(/^```json\s*/i, '').replace(/\s*```\s*$/, '').trim();
}

