# sycophancy-hooks

**Execution-layer enforcement for anti-sycophancy in Claude Code.**

A set of [Claude Code hooks](https://code.claude.com/docs/en/hooks-guide) that force AI agents to self-audit for sycophancy and cognitive bias at the structural level—not by politeness prompts, but by **blocking responses that don't meet format requirements**.

---

## Why this exists

LLM sycophancy is now a measured, reproducible phenomenon:

- **ELEPHANT** benchmark (Cheng et al., 2025) quantifies social sycophancy at up to **45 percentage points** above human baseline.
- [`SYCOPHANCY.md`](https://sycophancy.md/) proposed a spec for self-audit protocols, but remained a **specification without enforcement**.
- Existing "critic loop" and "self-review" approaches rely on the model voluntarily self-correcting—which is exactly what sycophancy corrupts.

**This repo is the execution layer SYCOPHANCY.md implied but didn't ship.**

Hooks run at OS process level. The AI cannot bypass them by politeness. Stop hook reads the response, parses the self-audit block, blocks with `exit(2)` if structure is violated (e.g., "External Limit" reason uses time/cost excuses instead of real structural limits).

---

## What's included

### `hooks/bias-detect.js` (UserPromptSubmit)
Detects judgment / choice-type user messages (Chinese + English patterns). When matched, writes a flag file and injects instructions requiring the AI to append a `<bias>` block at response end.

### `hooks/bias-write.js` (Stop)
Reads the pending-bias flag, extracts the `<bias>` block from the last assistant response, parses markdown fields, and enforces structural rules:

- **Required fields**: Confidence, Independent View, Verdict
- **Counter evidence** must be classified as `processed` OR `external-limit`
- **External-limit** reasons are regex-blocked for self-controllable excuses (`time`, `cost`, `busy`, `lazy`, `workload`, `rushed`, ...)
- **Processed** actions are regex-blocked for disguised-as-processed phrasing (`from memory`, `roughly remember`, `later I'll`, `should have but didn't`, ...)
- **Logic contradiction** detector: catches "could process but didn't" admissions inside external-limit

Violations trigger `exit(2)` with hint that this is a reminder for **next** response, not a demand to re-send immediately.

Valid audits are written to a queue for later human review.

Missing audits increment a counter. After a configurable grace period (default 14 days after first use), 3 misses trigger a red escalation warning on the next judgment-type turn.

**Format requirement**: section titles (`**Confidence**`, `**Processed**`, etc.) must start at column 0 with no leading indentation — the parser uses line-start `**` as the section separator. Indented `**bold**` text inside field values is fine.

### `hooks/correction-detect.js` (UserPromptSubmit)
Detects correction trigger phrases in user messages (`that's wrong`, `you should`, `stop doing`, `錯了`, `你又...`, etc., with negation guards for positive phrasings like `你又對了`). When matched, requires AI to emit a `<correction>{...}</correction>` JSON block.

### `hooks/correction-write.js` (Stop)
Extracts the `<correction>` block from the AI response, validates required fields (`scene`, `wrong`, `correct`), and appends to a queue for human review. Missing blocks accumulate counter + escalation warning just like bias hooks.

---

## Prerequisites

- **macOS or Linux** (POSIX `fcntl` required for file locking — **Windows is not supported**)
- **Node.js 16+**
- **Python 3** (used for file locking via `fcntl`)
- **Claude Code 2.x**

## Installation

```bash
git clone https://github.com/YOUR_GITHUB_USERNAME/sycophancy-hooks.git  # ← replace with your GitHub username
cd sycophancy-hooks
chmod +x hooks/*.js

# Symlink hooks into Claude Code
ln -s "$(pwd)/hooks/bias-detect.js" ~/.claude/hooks/bias-detect.js
ln -s "$(pwd)/hooks/bias-write.js" ~/.claude/hooks/bias-write.js
ln -s "$(pwd)/hooks/correction-detect.js" ~/.claude/hooks/correction-detect.js
ln -s "$(pwd)/hooks/correction-write.js" ~/.claude/hooks/correction-write.js
```

> **New Claude Code install?** If `~/.claude/settings.json` doesn't exist yet, create it first with `{}` as content, then add the hook entries below.

### ⚠️ Configure Claude Code settings (merge, do NOT overwrite)

Open your existing `~/.claude/settings.json` and **merge** the hook entries from `examples/settings.json`. **Do not copy the example over your settings file** — that will wipe any other hooks, permissions, and configuration you have.

Add these entries to your existing `hooks` section:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          { "type": "command", "command": "~/.claude/hooks/bias-detect.js" },
          { "type": "command", "command": "~/.claude/hooks/correction-detect.js" }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "~/.claude/hooks/bias-write.js" },
          { "type": "command", "command": "~/.claude/hooks/correction-write.js" }
        ]
      }
    ]
  }
}
```

If you already have `UserPromptSubmit` or `Stop` hooks, append the new entry into the existing array rather than replacing.

See `examples/settings.json` for the reference config.

---

## Configuration

Environment variables (all optional, sensible defaults):

| Var | Default | Purpose |
|---|---|---|
| `AI_AUDIT_DIR` | `~/.ai-audit/` | Base directory for logs |
| `BIAS_LOG_PATH` | `$AI_AUDIT_DIR/bias-log.jsonl` | Main log after user review |
| `BIAS_QUEUE_PATH` | `$AI_AUDIT_DIR/bias-queue.jsonl` | Pending queue awaiting review |
| `BIAS_SKIPPED_PATH` | `$AI_AUDIT_DIR/bias-skipped.jsonl` | AI-judged non-judgment turns |
| `CORRECTIONS_LOG_PATH` | `$AI_AUDIT_DIR/corrections.jsonl` | Main correction log after review |
| `CORRECTIONS_QUEUE_PATH` | `$AI_AUDIT_DIR/corrections-queue.jsonl` | Pending correction queue |
| `CORRECTIONS_SKIPPED_PATH` | `$AI_AUDIT_DIR/corrections-skipped.jsonl` | AI-judged non-corrections |
| `BIAS_ENFORCEMENT_DELAY_DAYS` | `14` | Grace period (days after first use) before 3-miss red escalation activates |
| `BIAS_ENFORCE_NOW` | (unset) | Set to `1` to skip grace period and enforce immediately |

## ⚠️ Privacy note

`user_prompt_preview` (first 400 chars of your prompt) is stored in the jsonl queue/log files. **Do not**:
- `git push` the `$AI_AUDIT_DIR` directory (the default `.gitignore` excludes `.ai-audit/` and `*.jsonl` — keep it that way)
- Sync `$AI_AUDIT_DIR` via Dropbox / iCloud / OneDrive if your prompts contain secrets (API keys, passwords, confidential code)
- Share the audit files with anyone unless you've reviewed them
- Set `AI_AUDIT_DIR` or other path env vars to sensitive locations like `~/.ssh/`, `/etc/`, or shared directories — the env var directly controls the write target, and misconfiguration writes to unexpected places

The audit files are meant for **local** review only.

---

## Comparison to other approaches

| Approach | Mechanism | Bypass risk |
|---|---|---|
| System prompts ("be honest") | Voluntary | High |
| `SYCOPHANCY.md` protocol | Spec-only | Dependent on AI self-discipline |
| **sycophancy-hooks** | **OS-level enforcement** | **Structurally blocked** |
| Fine-tuning interventions | Model training | Requires model access |

---

## Bilingual by design

Hook messages are bilingual (English + Traditional Chinese). Regex patterns detect both language families. The author's native audit style uses mixed-language casual registers, which the hook supports by default.

---

## Claude Code version compatibility

Tested with Claude Code 2.x. Hook API is still evolving—if you see schema drift issues, open an issue with your Claude Code version.

---

## Contributing

Contributions welcome. Before sending a PR:

1. **Open an issue first** for non-trivial changes — discussion before code saves round-trips.
2. **Keep changes focused** — one concern per PR. Don't bundle unrelated fixes.
3. **Run `node -c hooks/*.js`** to verify syntax.
4. **Run tests**: `node tests/parseMarkdownBias.test.js` (add new tests when touching parser logic).
5. **Test on macOS or Linux** — Windows is explicitly unsupported.
6. **Respect the bilingual design** — if you add user-facing strings, include both English and Traditional Chinese where existing messages do. Pure-English PRs for non-message code are fine.

For `adapters/` contributions, see `adapters/README.md` for the interface draft.

Bug reports: include your Claude Code version, OS, Node.js version, and the hook output / stderr.

## License

MIT — see [LICENSE](LICENSE).

---

## Related work

- [`SYCOPHANCY.md`](https://sycophancy.md/) — protocol spec this repo implements
- [ELEPHANT benchmark](https://arxiv.org/abs/2505.13995) — social sycophancy measurement
- [`lechmazur/sycophancy`](https://github.com/lechmazur/sycophancy) — benchmark leaderboard
- [`google/sycophancy-intervention`](https://github.com/google/sycophancy-intervention) — synthetic fine-tuning data
- [`hesreallyhim/awesome-claude-code`](https://github.com/hesreallyhim/awesome-claude-code) — broader Claude Code hook ecosystem

---

## Status

**Early alpha.** Core `bias-detect` + `bias-write` + `correction-detect` + `correction-write` working. Roadmap:

- [x] `correction-detect` + `correction-write` (user-correction capture loop)
- [x] `adapters/` reference implementations (simple-jsonl, shared-memory) — *not wired into hooks yet, use as reference*
- [x] `examples/rules-template.md` (rule-book scaffold users can customize)
- [x] Fuzz tests for parser (`tests/parseMarkdownBias.test.js`)
- [ ] Wire hooks to use `adapters/` (currently hooks have inline jsonl writes)
- [ ] Full i18n via env var (currently bilingual hardcoded)
- [ ] `package.json` with `engines` field for Dependabot / npm audit
