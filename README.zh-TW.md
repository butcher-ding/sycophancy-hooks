# sycophancy-hooks（繁中版）

**Claude Code 的反迎合偏誤執行層。**

一組 [Claude Code hooks](https://code.claude.com/docs/en/hooks-guide)，在結構層強制 AI 自審迎合偏誤與認知偏誤——不是靠提示詞禮貌請求，而是**擋下不符格式的回應**。

> English version: [README.md](README.md)

---

## 為什麼需要這個

LLM 迎合偏誤（sycophancy）已是可測量、可重現的現象：

- **ELEPHANT** 基準（Cheng et al., 2025）量測到社交迎合最高達**比人類基線高 45 個百分點**
- [`SYCOPHANCY.md`](https://sycophancy.md/) 提出了自審協議，但只是**規範沒有執行**
- 既有的「批評者迴圈」「自我審查」方法依賴模型自願修正——但這正是迎合偏誤會腐蝕的地方

**這個 repo 是 SYCOPHANCY.md 缺的執行層。**

Hook 在 OS 行程層運行。AI 沒辦法用禮貌話術繞過。Stop hook 讀回應、解析自審區塊、用 `exit(2)` 擋下違規（例如「外部限制」理由用「時間/成本」這類可控藉口而非真實結構性限制）。

---

## 內容

### `hooks/bias-detect.js`（UserPromptSubmit）
偵測使用者的判斷類 / 選擇類訊息（中英文模式皆有）。命中時寫 flag 檔，注入指令要求 AI 在回應結尾附 `<bias>` 區塊。

### `hooks/bias-write.js`（Stop）
讀 pending-bias flag、從上一個 AI 回應抽 `<bias>` 區塊、解析 markdown 欄位、強制結構規則：

- **必要欄位**：Confidence（信心）、Independent View（獨立視角）、Verdict（判定）
- **Counter evidence** 必須分類成 `processed` 或 `external-limit`
- **External-limit** 理由用正則擋可控藉口（`time`、`cost`、`busy`、`lazy`、`workload`、`rushed`、「時間」、「成本」、「忙」...）
- **Processed** 動作用正則擋「偷懶包裝詞」（`from memory`、`roughly remember`、`later I'll`、「憑記憶」、「粗估」、「之後再」...）
- **邏輯矛盾偵測**：捕捉 external-limit 裡「可處理但沒做」的承認句型

違規觸發 `exit(2)` + 提示這是**下一輪**回應的提醒，不是要立刻重送。

合格自審寫到佇列供人工審核。

漏記自審會累積計數器。`ENFORCEMENT_DATE`（可設定）後，3 次漏記在下次判斷類訊息觸發紅色升級警告。

### `hooks/correction-detect.js`（UserPromptSubmit）
偵測使用者訊息中的糾正觸發詞（「錯了」、「你又」、「這樣不對」、英文 `that's wrong`、`you should`、`stop doing` 等）。命中時寫 flag 要 AI 附 `<correction>` 區塊。

### `hooks/correction-write.js`（Stop）
從 AI 回應抽 `<correction>{json}</correction>` 區塊、驗必要欄位（scene / wrong / correct）、寫到糾正佇列。漏記同樣累積計數+升級警告。

**格式要求**：區段標題（`**Confidence**`、`**Processed**` 等）必須從**行首**開始，不可縮排——解析器用行首 `**` 當區段分隔符。欄位值內嵌的 `**bold**` 沒問題。

---

## 前置需求

- **macOS、Linux 或 Windows**（跨平台——使用 `O_EXCL` 哨兵檔鎖，無原生依賴）
- **Node.js 16+**
- **Claude Code 2.x**

## 安裝

```bash
git clone https://github.com/butcher-ding/sycophancy-hooks.git
cd sycophancy-hooks
npm install          # 不安裝執行時依賴，只初始化腳本
npm test             # 跑 parser 測試確認環境 OK
chmod +x hooks/*.js  # macOS / Linux 才需要

# 建立 symlink 到 Claude Code（macOS / Linux）
ln -s "$(pwd)/hooks/bias-detect.js" ~/.claude/hooks/bias-detect.js
ln -s "$(pwd)/hooks/bias-write.js" ~/.claude/hooks/bias-write.js
ln -s "$(pwd)/hooks/correction-detect.js" ~/.claude/hooks/correction-detect.js
ln -s "$(pwd)/hooks/correction-write.js" ~/.claude/hooks/correction-write.js
```

**Windows（以管理員身分開 PowerShell）：**
```powershell
cd <repo 路徑>
New-Item -ItemType SymbolicLink -Path "$env:USERPROFILE\.claude\hooks\bias-detect.js" -Target "$PWD\hooks\bias-detect.js"
New-Item -ItemType SymbolicLink -Path "$env:USERPROFILE\.claude\hooks\bias-write.js" -Target "$PWD\hooks\bias-write.js"
New-Item -ItemType SymbolicLink -Path "$env:USERPROFILE\.claude\hooks\correction-detect.js" -Target "$PWD\hooks\correction-detect.js"
New-Item -ItemType SymbolicLink -Path "$env:USERPROFILE\.claude\hooks\correction-write.js" -Target "$PWD\hooks\correction-write.js"
```

### ⚠️ Claude Code 設定檔（合併，不要覆蓋）

打開你現有的 `~/.claude/settings.json`，**合併** `examples/settings.json` 裡的 hook 條目。**不要把範例覆蓋掉你的設定檔**——那會抹掉你其他 hook、權限、設定。

在你現有的 `hooks` 區段加入這幾條：

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

若你本來就有 `UserPromptSubmit` 或 `Stop` hook，把新條目**加到陣列**而不是取代。

範例設定檔見 `examples/settings.json`。

---

## 環境變數設定

全部可選，有合理預設：

| 變數 | 預設 | 用途 |
|---|---|---|
| `AI_AUDIT_DIR` | `~/.ai-audit/` | 日誌根目錄 |
| `BIAS_LOG_PATH` | `$AI_AUDIT_DIR/bias-log.jsonl` | 人工審核後的偏誤主檔 |
| `BIAS_QUEUE_PATH` | `$AI_AUDIT_DIR/bias-queue.jsonl` | 待審佇列 |
| `BIAS_SKIPPED_PATH` | `$AI_AUDIT_DIR/bias-skipped.jsonl` | AI 判定非判斷類的紀錄 |
| `CORRECTIONS_LOG_PATH` | `$AI_AUDIT_DIR/corrections.jsonl` | 人工審核後的糾正主檔 |
| `CORRECTIONS_QUEUE_PATH` | `$AI_AUDIT_DIR/corrections-queue.jsonl` | 糾正待審佇列 |
| `CORRECTIONS_SKIPPED_PATH` | `$AI_AUDIT_DIR/corrections-skipped.jsonl` | AI 判定非糾正 |
| `BIAS_ENFORCEMENT_DELAY_DAYS` | `14` | 首次使用起算的寬限期天數；超過後 3 次漏記才觸發紅色升級警告 |
| `BIAS_ENFORCE_NOW` | （未設定）| 設為 `1` 可跳過寬限期，立即強制 |

## ⚠️ 隱私提醒

`user_prompt_preview`（使用者訊息前 400 字）會被寫進 jsonl 佇列 / 主檔。**請不要**：
- `git push` 你的 `$AI_AUDIT_DIR` 目錄（預設 `.gitignore` 已擋 `.ai-audit/` 和 `*.jsonl`，維持現況即可）
- 用 Dropbox / iCloud / OneDrive 同步 `$AI_AUDIT_DIR`，若你的 prompt 含 API key、密碼、機密程式碼
- 把 audit 檔案分享給別人，除非你已逐行檢查過
- 把 `AI_AUDIT_DIR` 或其他路徑 env var 設成 `~/.ssh/`、`/etc/`、共用目錄等敏感位置 — env var 直接決定寫入目標，寫錯會寫到奇怪的地方

audit 檔案只給**本機**審閱用。

---

## 比較其他作法

| 作法 | 機制 | 繞過風險 |
|---|---|---|
| 系統提示（「要誠實」） | 自願 | 高 |
| `SYCOPHANCY.md` 協議 | 只是規範 | 依賴 AI 自律 |
| **sycophancy-hooks** | **OS 行程層強制** | **結構性擋下** |
| 微調介入 | 訓練模型 | 需要模型存取權 |

---

## 雙語設計

Hook 訊息中英雙語。正則模式偵測兩種語言。作者母語是中文，原風格用中英混用的非正式語氣，hook 預設支援。

---

## Claude Code 版本相容性

Claude Code 2.x 測試過。Hook API 還在演變——若遇到 schema drift 問題，開 issue 附上你的 Claude Code 版本。

---

## 貢獻

歡迎貢獻。送 PR 前：

1. **重大變更先開 issue**——討論後再寫 code 省來回
2. **變更聚焦**——一個 PR 一個議題，不要混雜無關修正
3. **跑 `npm run lint:syntax`** 驗證語法
4. **跑測試**：`npm test`（改 parser 邏輯時請補測試）
5. **盡量在所有支援平台測**——macOS、Linux、Windows。CI 每個 PR 都會跑三個平台，但本地測比較快
6. **尊重雙語設計**——新增面向使用者的字串，若既有訊息是雙語就加雙語；純英文的非訊息 code 可以

`adapters/` 貢獻請見 `adapters/README.md` 介面草案。

Bug 回報附上：Claude Code 版本、OS、Node.js 版本、hook 輸出 / stderr。

---

## 授權

MIT — 見 [LICENSE](LICENSE)。

---

## 相關資源

- [`SYCOPHANCY.md`](https://sycophancy.md/) — 這個 repo 實作的協議規範
- [ELEPHANT benchmark](https://arxiv.org/abs/2505.13995) — 社交迎合量測
- [`lechmazur/sycophancy`](https://github.com/lechmazur/sycophancy) — 基準排行榜
- [`google/sycophancy-intervention`](https://github.com/google/sycophancy-intervention) — 合成微調資料
- [`hesreallyhim/awesome-claude-code`](https://github.com/hesreallyhim/awesome-claude-code) — Claude Code hook 生態

---

## 狀態

**Early alpha。** 核心 `bias-detect` + `bias-write` + `correction-detect` + `correction-write` 可用。路線圖：

- [x] `correction-detect` + `correction-write`（使用者糾正捕捉迴圈）
- [x] `adapters/` 參考實作（simple-jsonl、shared-memory）— *尚未接進 hooks，目前僅作參考*
- [x] `examples/rules-template.md`（規則主表範本）
- [x] Parser 模糊測試（`tests/parseMarkdownBias.test.js`）
- [ ] 把 hooks 接到 `adapters/`（目前 hooks 用 inline jsonl 寫入）
- [ ] 完整 i18n（目前中英雙語 hardcoded）
- [ ] `package.json` + `engines` 欄位（for Dependabot / npm audit）
