# 工程師客服回覆禮貌化工具 (Dogger Polisher)

這是德記儀器內部使用的客服回覆工具：把工程技術內容轉成有禮貌、可直接對客戶使用的繁中回覆，並用 A~F 型錄做可追溯檢索。

## 專案狀態
**v1.2（內部正式 / 快版）**

## 目前核心功能
1. **三語氣禮貌化**：精簡 / 標準 / 正式。
2. **A~F 分區檢索**：勾哪個查哪個。
3. **命中透明化**：scoped chunks、TopK、token 估算、風險等級。
4. **No-hit 可解釋**：顯示 tokenize、fallback 是否啟用、未命中原因。
5. **推薦產品嚴格校驗**：LLM 提到的產品需可在命中 chunk 驗證，否則剔除。
6. **推薦產品卡（可追溯）**：顯示 section/page/source URL + evidence excerpt。
7. **最小後端代理**：前端改呼叫 `/api/polish`，API key 不再暴露在前端 bundle。`r`n8. **輸入長度控制**：技術回覆內容上限 1000 字（剛好 1000 可送出，超過自動截斷）。`r`n9. **Dark Mode / Light Mode / System**：Header 可切換主題並記住偏好（localStorage）。

## 技術堆疊
- **Frontend**: React 19 + Tailwind CSS
- **Build**: Vite + TypeScript
- **AI**: OpenRouter `google/gemini-3-flash-preview`
- **Testing**: Vitest

## 快速開始

### 1) 環境變數
在專案根目錄建立 `.env`：

```bash
API_KEY=你的_openrouter_key
```

### 2) 本地啟動

```bash
npm install
npm run dev
```

- 開發模式下，Vite middleware 會提供 `/api/polish` 代理。
- `API_KEY` 由 server-side 讀取，不經前端傳遞。

### 3) 建置

```bash
npm run build
```

## 測試與評測

```bash
npm run test
npm run eval:retrieval
```

- `npm run test`：單元測試（section 過濾、fallback、推薦校驗/去重）。
- `npm run eval:retrieval`：執行 `data/eval/queries.json` 基準集，輸出：
  - `data/eval/retrieval-report.json`
  - `data/eval/retrieval-report.md`
- 預設門檻：非空命中率 >= 85%。

## 電子型錄抽取（不需 DB）

```bash
npm run extract:catalog      # B: 178-229
npm run extract:catalog:a    # A: 14-176
npm run extract:catalog:c    # C: 232-252
npm run extract:catalog:d    # D: 254-307
npm run extract:catalog:f    # F: 602-627
npm run merge:catalog:af     # 合併 A~F
```

合併輸出：
- `data/catalog/catalog_A_F_pages.jsonl`
- `data/catalog/catalog_A_F_chunks.jsonl`
- `data/catalog/catalog_A_F_chunks.csv`
- `public/knowledge/catalog_A_F_chunks.json`

## 代理端點
- `api/polish.ts`：部署端（如 Vercel）可用的最小代理。
- `vite.config.ts`：本地 dev/preview 的 middleware 代理（含基本 rate limit + timeout）。


