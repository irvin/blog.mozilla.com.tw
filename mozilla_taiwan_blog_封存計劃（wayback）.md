# Mozilla Taiwan Blog Web Archive 封存計劃（完整版）

## 🎯 目標

將已下架的 `blog.mozilla.com.tw` 文章內容，透過 Wayback Machine 完整封存，範圍：

```text
?p=74 ~ ?p=9335
```

核心原則：
- 只抓「實際存在的文章」
- 以 `<article>` 為主體
- 輸出可重建網站、可分析、可長期保存的資料格式

---

## 📦 輸出成果（資料結構）

```text
archive/
├── raw-html/              # 原始 Wayback HTML（可重現）
├── articles-json/         # 結構化資料（分析用）
├── articles-md/           # Markdown（重建網站用）
├── assets/                # 圖片與附件
│   └── {post_id}/
├── index.csv              # 快速索引（搜尋/統計）
└── manifest.json          # 全域狀態（進度/錯誤）
```

---

## 🧾 單篇資料 Schema

```json
{
  "post_id": 9335,
  "title": "...",
  "date": "YYYY-MM-DD",
  "year": 2016,
  "month": 10,
  "day": 25,
  "categories": [],
  "tags": [],
  "author": "...",
  "original_url": "https://blog.mozilla.com.tw/?p=9335",
  "archive_url": "...",
  "wayback_timestamp": "20200927091734",
  "content_html": "...",
  "content_text": "...",
  "images": [],
  "links": [],
  "status": "ok",
  "asset_status": "ok",
  "asset_errors": []
}
```

---

## 🧭 Pipeline 設計

```text
CDX → 篩選 → snapshot 選擇 → 抓取 → 清理 → 解析 → 驗證 → fallback → 輸出
```

---

## Phase 1 — CDX 掃描（來源盤點）

API：

```text
https://web.archive.org/cdx/search/cdx
```

查詢條件：

- url = `blog.mozilla.com.tw/?p=*`
- output = json
- fields = timestamp, original, statuscode, mimetype, digest, length

篩選：

```text
74 <= post_id <= 9335
statuscode == 200
mimetype == text/html
```

實作注意：

- query string 內的 `?p=*` 必須 URL encode，避免 `?` 被當成 CDX API 參數分隔符
- 建議查詢 URL：

```text
https://web.archive.org/cdx/search/cdx?url=blog.mozilla.com.tw/%3Fp=*&output=json&fl=timestamp,original,statuscode,mimetype,digest,length&filter=statuscode:200&filter=mimetype:text/html&collapse=digest
```

- 使用 `digest` 去除內容相同的重複 snapshot
- 保留 `length` 供 snapshot selection 判斷空頁或異常頁

👉 產出：post_id → snapshots[]

---

## Phase 2 — Snapshot Selection（關鍵）

每篇文章通常有多個 snapshot。

主策略：

- 以 2020 年最後一個可用 snapshot 為主
- 優先選擇 timestamp <= `20201231235959` 的最新版本
- 不直接採用 2021 年之後 snapshot，除非 2020 年以前完全沒有可用版本

排序策略（score-based）：

1. 是否為 2020 年內或 2020 年以前的 snapshot
2. timestamp 越接近 `20201231235959` 越好
3. statuscode == 200
4. HTML size（避免空頁）
5. 是否包含 `<article>` 或有效文章容器
6. 是否含有有效 title、date、正文內容

Fallback 策略：

```text
最多嘗試 3~5 個 snapshot
成功條件：
- title 存在
- article 長度 > threshold
- 非關站頁 / redirect 頁 / Wayback 錯誤頁

若 2020 年最後版本不可用：
1. 往 2020 年以前較早 snapshot 回退
2. 再視需要嘗試 2021 年之後 snapshot
3. 所有 fallback 都必須通過內容品質驗證
```

---

## Phase 3 — 抓取 HTML

URL 格式：

```text
https://web.archive.org/web/{timestamp}id_/{original_url}
```

說明：

- HTML 抓取優先使用 raw mode：`{timestamp}id_`
- raw mode 可減少 Wayback toolbar、script、iframe 與 URL rewrite 污染
- 若 raw mode 失敗，再 fallback 到 replay URL：

```text
https://web.archive.org/web/{timestamp}/{original_url}
```

抓取策略：

- delay：1–3 秒（隨機）
- headers：User-Agent（模擬瀏覽器）
- retry：最多 3 次
- timeout：10–20 秒
- checkpoint：每 50 篇 flush

---

## Phase 4 — Wayback 清理

移除污染：

```css
#wm-ipp
script
iframe
noscript
style
```

處理 URL rewrite：

```text
/web/{ts}/https://... → original URL
```

---

## Phase 5 — 內容解析

Primary selector：

```css
article
```

Fallback：

```css
div.post
div.entry
div.entry-content
div.post-content
```

抽取欄位：

- title
- date（解析成 YYYY-MM-DD）
- categories / tags
- author
- content_html
- content_text
- images（img[src]）
- links（a[href]）

---

## Phase 6 — 資產封存（重要）

流程：

1. 抓 `<article>` 內所有 `img[src]`
2. 下載圖片（透過 Wayback URL）
3. 優先保留 WordPress uploads 原始路徑：

```text
assets/{post_id}/wp-content/uploads/{path}/{filename}
```

例如：

```text
https://blog.mozilla.com.tw/wp-content/uploads/data-breaches-notification-1024x657.jpg
→ assets/9335/wp-content/uploads/data-breaches-notification-1024x657.jpg
```

4. 若圖片 URL 沒有明確 uploads 路徑，或同一篇文章內出現同名衝突，再使用 deterministic fallback：

```text
assets/{post_id}/{index}-{hash}.{ext}
```

5. 下載後驗證：

- HTTP status == 200
- Content-Type 為 image/*
- 檔案大小 > 0
- 必要時比對副檔名與檔案 signature
- 若 Wayback 回傳 HTML 錯誤頁，不可存成圖片

6. rewrite Markdown：

```markdown
![alt](../assets/9335/wp-content/uploads/data-breaches-notification-1024x657.jpg)
```

---

## Phase 7 — Markdown 輸出

```markdown
---
post_id: 9335
title: ...
date: 2016-10-25
categories:
  - Mozilla
---

內文...
```

---

## Phase 8 — Validation（品質控管）

統計項目：

- total posts
- success
- no snapshot
- fetch failed
- parse failed
- empty article
- assets ok
- partial assets failed
- asset errors count

狀態定義：

```text
ok
no_snapshot
fetch_failed
parse_failed
empty_article
partial_assets_failed
```

文章狀態與資產狀態分開記錄：

```json
{
  "status": "ok",
  "asset_status": "partial_assets_failed",
  "asset_errors": [
    {
      "url": "https://blog.mozilla.com.tw/wp-content/uploads/example.jpg",
      "reason": "content_type_not_image"
    }
  ]
}
```

- `status` 表示文章正文是否成功封存
- `asset_status` 表示圖片與附件是否完整
- 若正文成功但部分圖片失敗，文章仍可維持 `status: ok`
- 所有失敗資產都寫入 `asset_errors[]`，供後續補抓

---

## Phase 9 — 靜態網站重建

推薦工具：

- Astro（最佳平衡）
- Eleventy（簡潔）

功能：

- permalink 還原
- 全文搜尋
- 分類 / tag

---

## ⚠️ Wayback 限制與對策

### 限制

- rate limiting
- 行為偵測
- 歷史 robots.txt
- snapshot 不完整

### 對策

- 使用 CDX API（避免 brute force）
- 加 delay（1–3 秒）
- 加 User-Agent
- retry + fallback
- 避免高併發

---

## 🚀 實作階段

### MVP

1. CDX 清單
2. 篩 p 範圍
3. 抓 2020 年最後有效 snapshot
4. parse `<article>`
5. 輸出 JSON + Markdown

### 穩定版

6. snapshot fallback
7. retry / checkpoint
8. 圖片下載
9. validation report

### 完整版

10. static site
11. 搜尋 index
12. 部署（Cloudflare Pages / GitHub Pages）

---

## 🧠 架構總結

```text
CDX → snapshot selection → fetch → parse → validate → fallback → export
```

---

## 📌 最終策略

不要 mirror 整站。

應採：

```text
CDX API → 精準抓取 → 結構化 → Markdown → 重建
```

這是唯一同時滿足：
- 穩定
- 可重現
- 可分析
- 可部署

的做法。
