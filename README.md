# Mozilla Taiwan Blog Archive

這個 repo 保存並重建 `blog.mozilla.com.tw` 的 Wayback Machine 封存內容，輸出為可由 GitHub Pages 發布的靜態 HTML。

## 常用指令

```bash
npm run site:build
```

將 `archive/articles-md` 內的 Markdown 文章轉成靜態網站，輸出到 `blog/`。

```bash
npm run site:deploy
```

執行完整發布流程：

1. 重新執行 `npm run site:build`
2. 建立或重用 `gh-pages` worktree
3. 將 `blog/` 內容同步到 `gh-pages` branch 根目錄
4. commit `gh-pages`
5. push `origin gh-pages`

可用參數：

```bash
npm run site:deploy -- --no-push
npm run site:deploy -- --worktree /private/tmp/blog.mozilla.com.tw-gh-pages
npm run site:deploy -- --message "Publish static site"
```

## 靜態網站結構

`scripts/build-site.js` 會產生：

- `blog/index.html`：全部文章列表
- `blog/posts/<post_id>/index.html`：單篇文章頁
- `blog/categories/index.html`：分類索引
- `blog/categories/<category>/index.html`：分類文章列表
- `blog/months/index.html`：月份索引
- `blog/months/YYYY-MM/index.html`：月份文章列表
- `blog/assets/`：文章內已本地化的媒體檔案
- `blog/styles.css`：基本樣式
- `blog/.nojekyll`：避免 GitHub Pages 以 Jekyll 處理底線路徑或檔名

## 編譯實作細節

輸入來源是已封存的 Markdown 與媒體檔：

- `archive/articles-md/*.md`
- `archive/assets/**`

每篇 Markdown 的 frontmatter 提供 `post_id`、`title`、`date`、`categories`、`tags`、`original_url`、`archive_url` 等欄位。build script 會用 frontmatter 排序、建立文章 URL、分類頁、月份頁，並把 Markdown body 轉成 HTML。

站內連結會盡量轉為相對路徑：

- `https://blog.mozilla.com.tw/?p=<id>`
- `https://blog.mozilla.com.tw/posts/<id>/...`

如果 `<id>` 存在於目前輸出的文章集合，會改成相對的 `posts/<id>/`；如果本地沒有該文章，保留原始外部連結以避免產生斷連。

媒體路徑會從 Markdown 的 `../assets/...` 轉成相對於輸出頁面的 `assets/...` 路徑。外部媒體若尚未本地化，仍保留原始 URL。

部署由 `scripts/deploy-gh-pages.js` 處理。預設 worktree 位置為：

```text
/private/tmp/blog.mozilla.com.tw-gh-pages-deploy
```

也可用 `--worktree` 或 `GH_PAGES_WORKTREE` 指定其他位置。

## 授權

沿用 Mozilla Taiwan 網站授權。除另有註明外，本站內容皆採用 [創用 CC 姓名標示─相同方式分享 4.0 國際](https://creativecommons.org/licenses/by-sa/4.0/deed.zh-hant) 或更新版本授權大眾使用。

個別文章、圖片、影片、引用內容或外部連結若另有授權標示，應以該標示為準。
