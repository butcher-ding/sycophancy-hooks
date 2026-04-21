#!/usr/bin/env node
// bias-write.js
// Stop hook. 讀 pending-bias flag，抽 <bias> 區塊寫入 log
// 無區塊時計數累積。ENFORCEMENT_DATE 後達 3 次觸發紅字
//
// Stop hook. Reads pending-bias flag, extracts <bias> block, writes to log.
// Increments missing counter when absent. After ENFORCEMENT_DATE, 3 misses → red warning.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { appendWithLock } = require('../lib/append-with-lock');

const STATE_DIR = path.join(os.homedir(), '.claude', 'hooks', 'state');

// 可設定的記憶路徑（env var）/ Configurable memory paths via env vars
const AUDIT_DIR = process.env.AI_AUDIT_DIR || path.join(os.homedir(), '.ai-audit');
const BIAS_LOG_PATH = process.env.BIAS_LOG_PATH || path.join(AUDIT_DIR, 'bias-log.jsonl');
const BIAS_QUEUE_PATH = process.env.BIAS_QUEUE_PATH || path.join(AUDIT_DIR, 'bias-queue.jsonl');
const SKIP_PATH = process.env.BIAS_SKIPPED_PATH || path.join(AUDIT_DIR, 'bias-skipped.jsonl');

// Enforcement grace period: on first use, a marker is written. Enforcement only
// activates after N days. Override via BIAS_ENFORCEMENT_DELAY_DAYS (default 14).
// Set BIAS_ENFORCE_NOW=1 to skip grace period.
const ENFORCEMENT_DELAY_DAYS = Number(process.env.BIAS_ENFORCEMENT_DELAY_DAYS || 14);
const FIRST_USE_MARKER = path.join(STATE_DIR, 'bias-first-use');

function missingPath(sessionId) {
  return path.join(STATE_DIR, `missing-bias-count.${sessionId}`);
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

// Markdown bias block parser.
// Returns { confidence, counter_evidence: [{content, status, action_or_reason}], independent_view, reversal_check, verdict }
// Or { skip: true, reason: ... }
function parseMarkdownBias(text) {
  if (/\*\*\s*skip\s*\*\*/i.test(text)) {
    const reasonMatch = text.match(/(?:理由|Reason)\s*[:：]\s*([\s\S]+?)(?=\n\*\*|$)/i);
    return {
      skip: true,
      reason: reasonMatch ? reasonMatch[1].trim() : ''
    };
  }

  // Field extraction: supports multi-line, captures until next section-level ** or end
  // Supports bilingual labels: Chinese + English
  // Regex note: lookahead only matches ** at line start (no leading whitespace)
  // to prevent false truncation on embedded bold **text** within field values.
  const getField = (names) => {
    for (const name of names) {
      const re = new RegExp(`\\*\\*\\s*${name}\\s*(?:\\([^)]*\\))?\\s*\\*\\*\\s*[:：]?\\s*([\\s\\S]+?)(?=\\n\\*\\*|$)`, 'i');
      const m = text.match(re);
      if (m) return m[1].trim();
    }
    return null;
  };

  const getItems = (names) => {
    for (const name of names) {
      const re = new RegExp(`\\*\\*\\s*${name}\\s*(?:\\([^)]*\\))?\\s*\\*\\*\\s*[:：]?\\s*\\n([\\s\\S]+?)(?=\\n\\*\\*|$)`, 'i');
      const m = text.match(re);
      if (m) {
        return m[1]
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l.startsWith('-') || l.startsWith('*') || l.startsWith('•'))
          .map((l) => {
            const body = l.replace(/^[-*•]\s*/, '');
            const parts = body.split(/\s*→\s*|\s*->\s*|\s*=>\s*/);
            return {
              content: (parts[0] || body).trim(),
              action_or_reason: (parts[1] || '').trim()
            };
          })
          .filter((x) => x.content);
      }
    }
    return [];
  };

  const confidence = getField(['信心', 'Confidence']);
  const independent_view = getField(['獨立視角', 'Independent View']);
  const reversal_check = getField(['若反駁', 'If Challenged']);
  const verdict = getField(['判定', 'Verdict']);

  const processed = getItems(['已處理', 'Processed']).map((x) => ({ ...x, status: 'processed' }));
  const externalLimit = getItems(['外部限制', 'External Limit']).map((x) => ({ ...x, status: 'external-limit' }));

  return {
    confidence,
    counter_evidence: [...processed, ...externalLimit],
    independent_view,
    reversal_check,
    verdict
  };
}

function enforcementActive() {
  if (process.env.BIAS_ENFORCE_NOW === '1') return true;
  try { fs.mkdirSync(STATE_DIR, { recursive: true }); } catch {}
  if (!fs.existsSync(FIRST_USE_MARKER)) {
    fs.writeFileSync(FIRST_USE_MARKER, new Date().toISOString(), { mode: 0o600 });
    return false;
  }
  const firstUse = new Date(fs.readFileSync(FIRST_USE_MARKER, 'utf8'));
  const daysElapsed = (Date.now() - firstUse.getTime()) / (1000 * 60 * 60 * 24);
  return daysElapsed >= ENFORCEMENT_DELAY_DAYS;
}

// All exit(2) blocks append this hint:
// AI often misinterprets "blocked = immediately resend bare bias" — which creates two consecutive bias blocks.
function writeExitHint() {
  process.stderr.write(
    '\n⚠️ This is a reminder for NEXT response, not a request to re-send now.\n' +
    '此為下次回應的提醒，上輪主論述已送出。\n' +
    'Do NOT send a bare <bias> block alone (creates two consecutive bias blocks in dialogue).\n' +
    'Wait for user\'s next turn, then attach full response + corrected bias.\n'
  );
}

// Export parseMarkdownBias for testing when module is required, not executed directly.
if (require.main !== module) {
  module.exports = { parseMarkdownBias };
  return;
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  try {
    const payload = JSON.parse(input || '{}');
    const sessionId = payload.session_id || 'unknown';
    const transcriptPath = payload.transcript_path;

    const flagPath = path.join(STATE_DIR, `pending-bias.${sessionId}`);
    if (!fs.existsSync(flagPath)) process.exit(0);

    let flagData = {};
    try { flagData = JSON.parse(fs.readFileSync(flagPath, 'utf8')); } catch {}
    try { fs.unlinkSync(flagPath); } catch {}

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      process.stderr.write('bias-write: transcript not found, skip\n');
      process.exit(0);
    }

    const lastAssistantText = getLastAssistantText(transcriptPath);
    if (!lastAssistantText) {
      process.stderr.write('bias-write: assistant output empty, skip\n');
      process.exit(0);
    }

    const block = extractBiasBlock(lastAssistantText);
    if (!block) {
      const preview = (flagData.user_prompt_preview || '').slice(0, 120);
      const state = incrementMissing(sessionId, preview);
      const enforcing = enforcementActive();
      if (state.count >= 3 && enforcing) {
        const previewList = (state.previews || []).map((p, i) => `  ${i + 1}. ${p}`).join('\n');
        process.stderr.write(
          `\x1b[31m\x1b[1m🔍🔍🔍 bias-gate: ${state.count} missing bias audits accumulated 🔍🔍🔍\x1b[0m\n` +
          `Last ${state.previews.length} previews:\n${previewList}\n` +
          'Escalation warning will inject on next judgment-type turn.\n'
        );
      } else {
        const mode = enforcing ? 'enforcing' : `observation (grace period ${ENFORCEMENT_DELAY_DAYS} days)`;
        process.stderr.write(
          `🔍 bias-gate [${mode}]: last turn was judgment-type but AI output no <bias> block. (accumulated ${state.count})\n`
        );
      }
      process.exit(0);
    }

    let parsed;
    try {
      parsed = parseMarkdownBias(block);
    } catch (e) {
      process.stderr.write(`bias-write: markdown parse failed — ${e.message}\n`);
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
        appendWithLock(SKIP_PATH, JSON.stringify(skipRecord) + '\n');
      } catch (e) {
        process.stderr.write(`bias-write: skip log write failed — ${e.message}\n`);
      }
      resetMissing(sessionId);
      process.stderr.write(
        `bias-write: judged non-judgment, skip logged — ${parsed.reason || '(no reason)'}\n`
      );
      process.exit(0);
    }

    const required = ['confidence', 'independent_view', 'verdict'];
    const missing = required.filter((k) => !parsed[k]);
    if (missing.length > 0) {
      process.stderr.write(
        `bias-write: bias block missing fields ${missing.join(',')}, not written\n`
      );
      process.exit(0);
    }

    // Format enforcement + regex blocks for bypass phrasing
    const counter = parsed.counter_evidence;
    if (counter !== null && counter !== undefined) {
      if (!Array.isArray(counter)) {
        process.stderr.write(
          '⛔ bias-gate: counter_evidence must be array (each item has 3 fields: content / status / action_or_reason), not a string.\n' +
          'counter_evidence 必須是陣列格式。\n' +
          'Please re-output bias block in correct format.\n'
        );
        writeExitHint();
        process.exit(2);
      }
      for (let i = 0; i < counter.length; i++) {
        const item = counter[i];
        if (!item || typeof item !== 'object') {
          process.stderr.write(`⛔ bias-gate: counter[${i}] is not an object. 不是物件。\n`);
          writeExitHint();
          process.exit(2);
        }
        if (!item.content || !item.status || !item.action_or_reason) {
          process.stderr.write(
            `⛔ bias-gate: counter[${i}] missing fields (needs content / status / action_or_reason). 缺欄位。\n`
          );
          writeExitHint();
          process.exit(2);
        }
        if (item.status !== 'processed' && item.status !== 'external-limit') {
          process.stderr.write(
            `⛔ bias-gate: counter[${i}].status must be "processed" or "external-limit", got "${item.status}".\n` +
            `counter[${i}].status 必須是 "processed" 或 "external-limit"。\n`
          );
          writeExitHint();
          process.exit(2);
        }

        const reason = String(item.action_or_reason);

        // external-limit reason cannot be time / cost class (self-controllable)
        if (item.status === 'external-limit') {
          const fakeLimitPatterns = [
            /時間/, /time\b/i,
            /成本/, /\bcost\b/i,
            /太花/, /too (expensive|costly)/i,
            /忙/, /\bbusy\b/i,
            /懶/, /\blazy\b/i,
            /工作量/, /\bworkload\b/i,
            /範圍太(廣|大)/, /too (broad|wide|much)/i,
            /太多/,
            /快速/, /\bfast\b|\bquickly\b/i,
            /趕/, /\brushed\b/i
          ];
          const matched = fakeLimitPatterns.find((p) => p.test(reason));
          if (matched) {
            process.stderr.write(
              `⛔ bias-gate: counter[${i}] marked external-limit but reason contains "${matched.source}" — self-controllable phrase.\n` +
              `Reason: "${reason.slice(0, 120)}"\n` +
              'Real external-limit: data doesn\'t exist / third-party closed / no permission / tool limitation. Not time/cost excuses.\n' +
              '真外部限制：資料不存在 / 第三方不開放 / 我沒權限 / 工具限制。不是時間成本藉口。\n'
            );
            writeExitHint();
            process.exit(2);
          }

          // Logic contradiction: reason admits "can process but didn't" yet marks external-limit
          const logicContradictionPatterns = [
            /可(查|處理|做|驗證|讀|搜|grep|clone|試|補|確認)(但|卻).{0,20}?沒/,
            /有(辦法|方法|管道|工具)(但|卻).{0,20}?沒/,
            /(能|可以)(查|做|處理|驗證|確認).{0,20}?但.{0,20}?沒/,
            /這.{0,15}?(其實|確實|可以).{0,15}?可(處理|查|做|驗證)/,
            /可以.{0,15}?但(這|我|本).{0,15}?沒/,
            /could\s+have\s+\w+\s+but\s+didn't/i,
            /able\s+to\s+\w+\s+but\s+didn't/i
          ];
          const logicMatch = logicContradictionPatterns.find((p) => p.test(reason));
          if (logicMatch) {
            process.stderr.write(
              `⛔ bias-gate: counter[${i}] marked external-limit but reason admits "could process but didn't" — logical contradiction.\n` +
              `counter[${i}] 標 external-limit 但理由承認「其實能處理但沒做」——邏輯矛盾。\n` +
              `Matched pattern: ${logicMatch.source}\n` +
              `Reason: "${reason.slice(0, 160)}"\n` +
              'If processable, actually process it and change status=processed. Don\'t smuggle into external-limit.\n' +
              '能處理就實際處理並改 status=processed，不要夾帶到 external-limit。\n'
            );
            writeExitHint();
            process.exit(2);
          }
        }

        // processed action_or_reason cannot contain "didn't process" disguised phrasing
        if (item.status === 'processed') {
          const unprocessedPatterns = [
            /沒(去|有|認真|真的)?(查|驗證|讀|看|測|clone|grep|跑|深入|細讀)/,
            /(未|沒)(處理|做|深入|細)/,
            /憑(記憶|印象|感覺)/, /from\s+(memory|impression)/i,
            /靠(記憶|印象)/,
            /印象中/, /as I recall/i,
            /大概記得/, /roughly remember/i,
            /粗估/, /粗略/, /\brough(ly)?\s+estimate/i,
            /(應|該|本該)(去|然|該)?.{0,15}?(但|卻).{0,15}?沒/,
            /我(應)?該.{0,15}?(但|卻).{0,15}?沒/,
            /之後再(查|驗證|讀|處理)/, /later I'll/i,
            /暫時(沒|未|先)/, /for now/i,
            /先這樣/,
            /目前(沒|未)/,
            /(意識|知道|發現|承認).{0,30}?(偏誤|問題).{0,30}?(但|然而).{0,15}?(沒|未)/,
            /這點我承認但/, /I acknowledge but/i,
            /沒時間/, /no time/i,
            /太花時間/, /takes too long/i
          ];
          const matched = unprocessedPatterns.find((p) => p.test(reason));
          if (matched) {
            process.stderr.write(
              `⛔ bias-gate: counter[${i}] marked processed but action_or_reason contains "didn't process" disguised phrasing.\n` +
              `counter[${i}] 標 processed 但 action_or_reason 含「沒處理」的偽裝字眼。\n` +
              `Matched pattern: ${matched.source}\n` +
              `Reason: "${reason.slice(0, 120)}"\n` +
              'Real processed: "I searched X, result Y", "rewrote main argument Z", "Read file to confirm W".\n' +
              '真正的 processed：「grep 找到 X、結果 Y」「改了主論述 Z」「Read 檔案確認 W」。\n' +
              'If actually didn\'t process, change to external-limit (but not time/cost excuses) or actually go process it.\n' +
              '若真的沒處理，改 external-limit（但不是時間成本藉口）或實際去處理。\n'
            );
            writeExitHint();
            process.exit(2);
          }
        }
      }
    }

    const record = {
      id: `bias-${Date.now()}`,
      timestamp: new Date().toISOString(),
      session_id: sessionId,
      user_prompt_preview: flagData.user_prompt_preview || '',
      confidence: parsed.confidence,
      counter_evidence: parsed.counter_evidence || null,
      independent_view: parsed.independent_view,
      reversal_check: parsed.reversal_check || null,
      verdict: parsed.verdict
    };

    // Write to queue (not main log) — awaits user review
    appendWithLock(BIAS_QUEUE_PATH, JSON.stringify(record) + '\n');
    resetMissing(sessionId);
    const verdictShort = String(parsed.verdict).split(/[—-]/)[0].trim();
    process.stderr.write(
      `✓ bias queued [${verdictShort}]: ${String(parsed.independent_view || '').slice(0, 60)}\n` +
      `(Next SessionStart will auto-popup for user review.)\n`
    );
    process.exit(0);
  } catch (err) {
    process.stderr.write(`bias-write: internal error — ${err.message}\n`);
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

function extractBiasBlock(text) {
  const match = text.match(/<bias>\s*([\s\S]*?)\s*<\/bias>/);
  if (!match) return null;
  return match[1].replace(/^```json\s*/i, '').replace(/\s*```\s*$/, '').trim();
}

