#!/usr/bin/env node
// correction-detect.js
// UserPromptSubmit hook. Scans user's newest message for correction trigger phrases.
// When matched, writes per-session flag and injects instruction requiring AI to
// emit a <correction>{...}</correction> block in this turn's response.
//
// Next turn's Stop hook (correction-write.js) reads the flag and enforces format.

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
    if (!isCorrection(cleaned)) process.exit(0);

    ensureDir(STATE_DIR);
    const flagPath = path.join(STATE_DIR, `pending-correction.${sessionId}`);
    fs.writeFileSync(flagPath, JSON.stringify({
      triggered_at: new Date().toISOString(),
      session_id: sessionId,
      user_prompt_preview: cleaned.slice(0, 400)
    }), { mode: 0o600 });

    // Escalation warning when ≥3 misses accumulated
    let escalation = '';
    try {
      const missingPath = path.join(STATE_DIR, `missing-correction-count.${sessionId}`);
      const missingState = JSON.parse(fs.readFileSync(missingPath, 'utf8'));
      if ((missingState.count || 0) >= 3) {
        const previews = missingState.previews || [];
        // Don't echo preview content into stdout — stdout is injected into the
        // model's next-turn prompt, so preview text containing instruction-like
        // strings would become a prompt-injection amplifier. Show counts only.
        escalation = `\n🚨🚨🚨 Escalation: ${missingState.count} missed corrections accumulated (${previews.length} recorded) 🚨🚨🚨\n升級警告：已累積 ${missingState.count} 次漏記糾正\n\nThis turn MUST emit <correction> block or explicit skip block. (Preview content is in stderr / session log.)\n\n`;
      }
    } catch {}

    const instruction = `
⚠️ correction-gate: User message contains correction trigger phrases (糾正觸發詞)

This turn MUST append a correction block, otherwise Stop hook will block:

\`\`\`
<correction>
{"scene": "...", "wrong": "...", "correct": "...", "category": "language|approval|verification|persona|tone|factcheck", "priority": "core|rule|nit", "pinned": true|false}
</correction>
\`\`\`

Rules:
- **scene**: Context where correction happened (what AI was doing)
- **wrong**: Specific AI behavior user wants changed
- **correct**: What user actually wants
- **category**: language / approval-flow / verification / persona-rule / tone / factcheck
- **priority**: core (rule-level) / rule (regular) / nit (minor detail)
- **pinned**: true for principle-level corrections (keep at top forever), false for minor

If you judge "this isn't actually a correction" (e.g., user is joking, quoting someone else, or stating fact without wanting change), output:

\`\`\`
<correction>
{"skip": true, "reason": "..."}
</correction>
\`\`\`

Hook logs skip reason for audit but doesn't append to corrections file.
`.trim();

    process.stdout.write(escalation + instruction + '\n');
    process.exit(0);
  } catch (err) {
    // Fail-open: if hook itself is broken, don't freeze the agent
    process.stderr.write(`correction-detect: internal error — ${err.message}\n`);
    process.exit(0);
  }
});

function isCorrection(msg) {
  const patterns = [
    // Chinese - explicit correction words / 中文明確糾正詞
    /(這|這個|這樣|你)不對(?!稱)/,
    /錯了/,
    /不對吧/,

    // Chinese - AI-specific correction / 針對 AI 的糾正
    // Negation guard: excludes "又對了/又幫我/又解決/又抓到" which are positive
    /你又(?!(對|幫|解決|抓到|做對|完成|搞定))(.{0,10}?)(錯|用了|寫了|講了|說了|犯|忘|忽略|違反|滑|用回|滑回|重複|偷懶|迎合|雞湯)/,
    /你(還是|仍然|總是|老是|一直)(在|又)?(用|寫|講|說|犯|忘|忽略|違反|滑|混用|偷懶|迎合|雞湯|誇張|縮水)/,
    /你應該(用|是|要|先|去|把|知道|記得|改|寫|說|做|注意|避免)/,

    // Chinese - misjudgment / 誤判類
    /你把.{0,20}?(當成|誤判|搞錯|混淆|搞混|錯讀|錯認)/,

    // Chinese - rule reminder / 規則提醒
    /我(說過|講過|明明說|早就說)[\s\S]{0,30}(要|不要|別|不該|該|才|規則|用|寫)/,

    // Chinese - over/under expression / 表達超標
    /(太|有點)(片面|武斷|誇張|長|短|囉嗦|冗|嚴|鬆|淺|深|繞|跳|籠統|模糊)了?/,

    // Chinese - negation / 否定反應
    /這樣不(行|好|對)/,
    /不(要|准|能)(這樣|那樣|再|又)/,
    /感覺不(像|對)/,

    // Chinese - pattern negation / 模式否定
    /(不是|不該|不應)[\s\S]{0,20}(才是|要|該|這樣|那樣)/,

    // Chinese - memory issue / 記憶問題
    /記憶(有問題|不對|錯了|怎麼了|壞了|跑掉|錯亂)/,

    // Chinese - demanding questioning / 幹嘛質問
    /幹嘛(用|寫|講|說|做|又|還在|一直)/,

    // English - explicit correction
    /\bthat'?s?\s+(wrong|incorrect|not right|not correct)\b/i,
    /\bno,?\s+(not|that's not|you)\b/i,
    /\byou\s+(again|still|always|keep|keeps)\s+(miss|misses|forgot|forget|violated|violating|ignoring|ignored|doing)/i,
    /\byou\s+(should|shouldn'?t)\s+(have|use|write|say|do|note|avoid|know|remember)/i,

    // English - misjudgment
    /\byou\s+(misread|misunderstood|confused|mistook|conflated)\b/i,

    // English - rule reminder
    /\bI\s+(said|told|mentioned|told you)\s+.{0,30}(don'?t|not to|should|need)/i,

    // English - over-expression
    /\b(too|overly|way too)\s+(broad|vague|long|short|verbose|terse|strict|loose|shallow|deep|tangential)\b/i,

    // English - negation reactions
    /\bdon'?t\s+(do|write|say|use)\s+(that|this)\b/i,
    /\bstop\s+(doing|writing|saying|using)\b/i
  ];
  return patterns.some((r) => r.test(msg));
}
