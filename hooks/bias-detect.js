#!/usr/bin/env node
// bias-detect.js
// UserPromptSubmit hook. 偵測判斷類 / 選擇類訊息，命中則寫 flag + 印指令
// 要求 AI 回應結尾附 <bias> 區塊自審認知 / 迎合偏誤
//
// UserPromptSubmit hook. Detects judgment/choice-type messages.
// When matched, injects instruction requiring AI to append <bias> block
// at response end for cognitive/sycophancy self-audit.

const fs = require('fs');
const path = require('path');
const os = require('os');

const STATE_DIR = path.join(os.homedir(), '.claude', 'hooks', 'state');

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
}

// session_id comes from hook payload — sanitize before using in path.join
// to block path traversal ("../") and null bytes.
function sanitizeSessionId(raw) {
  const s = String(raw || '');
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(s)) return 'unknown';
  return s;
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  try {
    const payload = JSON.parse(input || '{}');
    const sessionId = sanitizeSessionId(payload.session_id);
    const userPrompt = (payload.prompt || payload.user_prompt || '').toString();

    if (!userPrompt) process.exit(0);

    const cleaned = userPrompt
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
      .replace(/<command-[\s\S]*?<\/command-[\s\S]*?>/g, '')
      .replace(/<local-command-[\s\S]*?<\/local-command-[\s\S]*?>/g, '')
      .trim();

    if (!cleaned) process.exit(0);
    if (!isJudgment(cleaned)) process.exit(0);

    ensureDir(STATE_DIR);
    const flagPath = path.join(STATE_DIR, `pending-bias.${sessionId}`);
    fs.writeFileSync(flagPath, JSON.stringify({
      triggered_at: new Date().toISOString(),
      session_id: sessionId,
      user_prompt_preview: cleaned.slice(0, 400)
    }), { mode: 0o600 });

    // 讀升級警告狀態 / Read escalation state
    let escalation = '';
    try {
      const missingPath = path.join(STATE_DIR, `missing-bias-count.${sessionId}`);
      const state = JSON.parse(fs.readFileSync(missingPath, 'utf8'));
      if ((state.count || 0) >= 3) {
        const previews = state.previews || [];
        // Don't echo preview content into stdout — stdout is injected into the
        // model's next-turn prompt, so preview text containing instruction-like
        // strings would become a prompt-injection amplifier. Show counts only.
        escalation = `\n🚨🚨🚨 Escalation warning: ${state.count} bias audits missed (${previews.length} recorded) 🚨🚨🚨\n偏誤自審升級警告：已累積 ${state.count} 次漏記\n\nThis turn MUST include <bias> block. (Preview content is in stderr / session log.)\n\n`;
      }
    } catch {}

    const instruction = `
🔍 bias-gate: This is a judgment / choice-type task (判斷類 / 選擇類任務)

Append <bias> block at response end for cognitive/sycophancy self-audit (markdown format):

\`\`\`
<bias>
**Confidence (信心)**: high/medium/low / reason

**Processed (已處理)**:
- counter description → what I actually did (searched/read/re-verified/rewrote main argument), concrete result
- another counter → concrete action

**External Limit (外部限制)**:
- limit description → real external-limit reason (data doesn't exist / third-party closed / no permission / tool limitation)

**Independent View (獨立視角)**: my independent judgment, does it align with user's leaning?

**If Challenged (若反駁)**: if user says X → I'll Y; if says Z → I'll W

**Verdict (判定)**: pass | concern (reason)
</bias>
\`\`\`

Verdict rules:
- pass: brief, no obvious bias risk
- concern: must include specific reason

Counter classification enforcement (violations blocked by Stop hook):

**Processed** (status=processed) → format: "counter → action", action MUST be "what I actually did" (e.g., "grep found X, rewrote main argument", "Read file to confirm", "WebSearch verified Y")

**External Limit** (status=external-limit) → format: "counter → real external-limit reason", reason MUST be structurally impossible (data doesn't exist / third-party closed / no permission / tool limitation)

**External Limit forbidden reasons** (self-controllable, doesn't count as external):
time / cost / busy / lazy / workload / too broad / too much / fast / rushed

**Processed forbidden phrases** (disguised "didn't process"):
from memory / from impression / roughly remember / later / for now / should have X but didn't / didn't seriously X / didn't search / didn't go deep / didn't clone / didn't grep / aware but didn't

**Self-check flow**:
Write first draft → list counters → for each counter ask "can I process it?" → processable ones **actually do the work and rewrite main argument** → unprocessable ones go to "External Limit" with real reason → lower confidence.

If non-judgment type (pure statement / small talk / command), output:

\`\`\`
<bias>
**skip**
Reason: ...
</bias>
\`\`\`
`.trim();

    process.stdout.write(escalation + instruction + '\n');
    process.exit(0);
  } catch (err) {
    process.stderr.write(`bias-detect: internal error — ${err.message}\n`);
    process.exit(0);
  }
});

function isJudgment(msg) {
  const patterns = [
    // Chinese - choice type / 中文選擇類
    /(選|挑)(哪個|哪一|一個)/,
    /哪(個|一個|種|款)(好|對|適|行|可|比較|更|不錯)/,

    // Chinese - asking opinion / 中文徵詢意見
    /你(覺得|認為|建議|看|想|怎麼看)/,
    /(建議|推薦)(我|吧|看|哪|什麼|怎)/,

    // Chinese - feasibility / 中文可行性
    /(可|能)不(可|能)(以|行)?/,
    /行不行/,
    /值(不值|得(嗎|啊|吧|不))/,
    /有沒有.{0,10}(問題|錯|漏|風險|bug)/,
    /(對|錯)(嗎|不對|不錯)/,
    /(好|對|行)不(好|對|行)/,

    // Chinese - should or not / 中文該不該
    /(要|該|需要)不(要|該|需要)/,
    /該不該/,

    // Chinese - evaluate / 中文評估
    /(評估|審查|審一|分析|比較|評比)/,

    // Chinese - how to / 中文怎麼做
    /怎麼(做|辦|選|挑|搞|處理|判斷|評|決)/,
    /如何(做|選|辦|搞|處理|判斷)/,

    // Chinese - trailing subjective question
    /(好嗎|對嗎|可以嗎|行嗎|值得嗎)[\s]*[?？]?\s*$/m,

    // English - choice type
    /\bwhich\b.*(one|option|better|best)/i,
    /\bshould I\b/i,
    /\bwhat do you think\b/i,
    /\bis it (worth|better|right|wrong|good|bad)\b/i,
    /\bcan (I|we|you)\b.*\?/i,

    // English - evaluate / analyze / recommend
    /\b(evaluate|assess|analyze|review|compare|critique)\b/i,
    /\b(how should|how do|how to)\b/i,
    /\brecommend(ation)?\b/i
  ];
  return patterns.some((r) => r.test(msg));
}
