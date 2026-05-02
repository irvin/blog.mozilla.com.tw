import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ARCHIVE_DIR = path.join(ROOT, 'archive');
const MD_DIR = path.join(ARCHIVE_DIR, 'articles-md');
const DOCS_DIR = path.join(ROOT, 'docs');
const POSTS_DIR = path.join(DOCS_DIR, 'posts');
const ASSETS_DIR = path.join(DOCS_DIR, 'assets');

const SITE_TITLE = 'Mozilla Taiwan 部落格';
const SITE_SUBTITLE = '最新部落格文章，提供各式 Mozilla 產品與專案相關訊息';
const LICENSE_NAME = '創用 CC 姓名標示─相同方式分享 4.0 國際';
const LICENSE_URL = 'https://creativecommons.org/licenses/by-sa/4.0/deed.zh-hant';
const KNOWN_CATEGORIES = ['Firefox', 'Firefox for Android', 'Firefox for iOS', 'Firefox OS', 'Identity', 'Mozilla', 'Privacy', 'Security', 'Web App', '新聞訊息', '未分類', '校園大使', '活動'];
const SITE_SNAPSHOT_URL = 'https://web.archive.org/web/*/https://blog.mozilla.com.tw/';
let ALL_POSTS = [];

async function main() {
  const posts = await readPosts();
  ALL_POSTS = posts;
  const postIds = new Set(posts.map((post) => String(post.id)));

  await rm(DOCS_DIR, { recursive: true, force: true });
  await mkdir(POSTS_DIR, { recursive: true });
  await cp(path.join(ARCHIVE_DIR, 'assets'), ASSETS_DIR, { recursive: true });
  await writeFile(path.join(DOCS_DIR, 'styles.css'), stylesheet());
  await writeFile(path.join(DOCS_DIR, '.nojekyll'), '');

  for (const post of posts) {
    const html = markdownToHtml(post.body, `../../`, postIds);
    const outputDir = path.join(POSTS_DIR, String(post.frontmatter.post_id));
    await mkdir(outputDir, { recursive: true });
    await writeFile(path.join(outputDir, 'index.html'), renderPost(post, html));
  }

  await writeArchivePages(posts);
  await writeFile(path.join(DOCS_DIR, 'index.html'), renderIndex(posts));
  await writeFile(path.join(DOCS_DIR, '404.html'), renderNotFound());

  console.log(`Built ${posts.length} pages into ${relative(DOCS_DIR)}`);
}

async function readPosts() {
  const files = (await readdir(MD_DIR)).filter((file) => file.endsWith('.md'));
  const posts = [];

  for (const file of files) {
    const raw = await readFile(path.join(MD_DIR, file), 'utf8');
    const { frontmatter, body } = parseMarkdownFile(raw);
    posts.push({
      file,
      body,
      frontmatter,
      id: Number(frontmatter.post_id),
      title: frontmatter.title || path.basename(file, '.md'),
      date: frontmatter.date || '',
      categories: arrayValue(frontmatter.categories),
      tags: arrayValue(frontmatter.tags),
    });
  }

  return posts.sort((a, b) => {
    const byDate = String(b.date).localeCompare(String(a.date));
    return byDate || b.id - a.id;
  });
}

function parseMarkdownFile(raw) {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) {
    return { frontmatter: {}, body: raw };
  }

  const frontmatter = {};
  const lines = match[1].split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const keyValue = line.match(/^([A-Za-z0-9_-]+):(?:\s*(.*))?$/);
    if (!keyValue) {
      continue;
    }

    const [, key, rawValue = ''] = keyValue;
    if (rawValue.trim()) {
      frontmatter[key] = scalarValue(rawValue.trim());
      continue;
    }

    const list = [];
    while (lines[i + 1]?.startsWith('  - ')) {
      i += 1;
      list.push(scalarValue(lines[i].slice(4).trim()));
    }
    frontmatter[key] = list;
  }

  return { frontmatter, body: raw.slice(match[0].length) };
}

function scalarValue(value) {
  if (value === 'null') {
    return '';
  }
  if (/^-?\d+$/.test(value)) {
    return Number(value);
  }
  return value.replace(/^"(.*)"$/, '$1').replace(/\\"/g, '"');
}

function arrayValue(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function markdownToHtml(markdown, rootPrefix, postIds) {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const html = [];
  let paragraph = [];
  let list = null;
  let blockquote = [];
  let code = null;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    html.push(`<p>${inlineMarkdown(paragraph.join('\n'), rootPrefix, postIds)}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    html.push(`<${list.type}>${list.items.map((item) => `<li>${inlineMarkdown(item, rootPrefix, postIds)}</li>`).join('')}</${list.type}>`);
    list = null;
  };
  const flushBlockquote = () => {
    if (!blockquote.length) return;
    html.push(`<blockquote>${markdownToHtml(blockquote.join('\n'), rootPrefix, postIds)}</blockquote>`);
    blockquote = [];
  };
  const closeBlocks = () => {
    flushParagraph();
    flushList();
    flushBlockquote();
  };

  for (const line of lines) {
    const fence = line.match(/^```(.*)$/);
    if (fence) {
      if (code) {
        html.push(`<pre><code>${escapeHtml(code.lines.join('\n'))}</code></pre>`);
        code = null;
      } else {
        closeBlocks();
        code = { lang: fence[1].trim(), lines: [] };
      }
      continue;
    }

    if (code) {
      code.lines.push(line);
      continue;
    }

    if (!line.trim()) {
      closeBlocks();
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      closeBlocks();
      const level = heading[1].length;
      html.push(`<h${level}>${inlineMarkdown(heading[2], rootPrefix, postIds)}</h${level}>`);
      continue;
    }

    if (line.startsWith('> ')) {
      flushParagraph();
      flushList();
      blockquote.push(line.slice(2));
      continue;
    }

    const unordered = line.match(/^\s*[-*]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+\.\s+(.+)$/);
    if (unordered || ordered) {
      flushParagraph();
      flushBlockquote();
      const type = ordered ? 'ol' : 'ul';
      if (!list || list.type !== type) {
        flushList();
        list = { type, items: [] };
      }
      list.items.push((unordered || ordered)[1]);
      continue;
    }

    flushList();
    flushBlockquote();
    paragraph.push(line);
  }

  closeBlocks();
  if (code) {
    html.push(`<pre><code>${escapeHtml(code.lines.join('\n'))}</code></pre>`);
  }

  return html.join('\n');
}

function inlineMarkdown(text, rootPrefix, postIds) {
  let escaped = escapeHtml(text);
  escaped = escaped.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_match, alt, url) => {
    const src = rewriteUrl(unescapeHtml(url.trim()), rootPrefix, postIds);
    return `<img src="${escapeAttr(src)}" alt="${escapeAttr(unescapeHtml(alt))}" loading="lazy">`;
  });
  escaped = escaped.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label, url) => {
    const href = rewriteUrl(unescapeHtml(url.trim()), rootPrefix, postIds);
    return `<a href="${escapeAttr(href)}">${label}</a>`;
  });
  escaped = autoLinkLocalPostUrls(escaped, rootPrefix, postIds);
  escaped = escaped.replace(/`([^`]+)`/g, '<code>$1</code>');
  escaped = escaped.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  escaped = escaped.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  return escaped.replace(/\n/g, '<br>');
}

function autoLinkLocalPostUrls(html, rootPrefix, postIds) {
  return html
    .split(/(<a\b[\s\S]*?<\/a>)/gi)
    .map((part) => {
      if (/^<a\b/i.test(part)) {
        return part;
      }
      return part.replace(/\bhttps?:\/\/blog\.mozilla\.com\.tw\/(?:posts\/\d+(?:\/[^\s<]*)?|\?p=\d+)\b/g, (url) => {
        const href = rewriteUrl(unescapeHtml(url), rootPrefix, postIds);
        return href === url ? url : `<a href="${escapeAttr(href)}">${escapeHtml(url)}</a>`;
      });
    })
    .join('');
}

function rewriteUrl(url, rootPrefix, postIds) {
  const clean = url.replace(/^<|>$/g, '');
  if (clean.startsWith('../assets/')) {
    return `${rootPrefix}${clean.slice(3)}`;
  }

  const postUrl = clean.match(/^https?:\/\/blog\.mozilla\.com\.tw\/(?:posts\/(\d+)(?:\/|$)|\?p=(\d+))/);
  if (postUrl) {
    const id = postUrl[1] || postUrl[2];
    if (postIds.has(id)) {
      return `${rootPrefix}posts/${id}/`;
    }
  }

  return clean;
}

function renderPost(post, contentHtml) {
  const title = escapeHtml(post.title);
  const categories = displayCategories(post).map((category) => `<span>${categoryLink(category, '../../')}</span>`).join('');
  const tags = post.tags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join('');

  return pageShell({
    title: `${post.title} | Mozilla Taiwan 部落格封存`,
    rootPrefix: '../../',
    bodyClass: 'single',
    breadcrumbs: postBreadcrumbs(post, '../../'),
    snapshotUrl: post.frontmatter.archive_url || SITE_SNAPSHOT_URL,
    body: `
      <main id="primary" class="content" role="main">
        <article class="post single-post">
          <header class="entry-header">
            <h2 class="entry-title">${title}</h2>
            <p class="entry-posted">${dateBadge(post.date)}</p>
          </header>
          <div class="entry-content">${contentHtml}</div>
          <footer class="entry-footer">
            ${categories ? `<div class="entry-category-box">文章分類：${categories}</div>` : ''}
            ${tags ? `<div class="entry-tag-box">標籤：${tags}</div>` : ''}
          </footer>
        </article>
      </main>
      ${sidebar('../../', post.frontmatter.archive_url || SITE_SNAPSHOT_URL)}
    `,
  });
}

function renderIndex(posts) {
  return pageShell({
    title: `${SITE_TITLE} 封存`,
    rootPrefix: '',
    bodyClass: 'home blog',
    breadcrumbs: [{ label: '部落格封存', href: 'index.html' }],
    snapshotUrl: SITE_SNAPSHOT_URL,
    body: `
      <main id="primary" class="content" role="main">
        ${renderPostList(posts, '')}
      </main>
      ${sidebar('', SITE_SNAPSHOT_URL)}
    `,
  });
}

async function writeArchivePages(posts) {
  const categories = groupByCategory(posts);
  const months = groupByMonth(posts);

  await mkdir(path.join(DOCS_DIR, 'categories'), { recursive: true });
  await mkdir(path.join(DOCS_DIR, 'months'), { recursive: true });

  await writeFile(path.join(DOCS_DIR, 'categories', 'index.html'), renderArchiveIndex({
    title: '文章分類',
    rootPrefix: '../',
    groups: categories.map((group) => ({
      name: group.name,
      href: `${group.slug}/`,
      count: group.posts.length,
    })),
  }));

  for (const group of categories) {
    const outputDir = path.join(DOCS_DIR, 'categories', group.slug);
    await mkdir(outputDir, { recursive: true });
    await writeFile(path.join(outputDir, 'index.html'), renderArchivePage({
      title: `文章分類：${group.name}`,
      posts: group.posts,
      rootPrefix: '../../',
      breadcrumbs: [
        { label: '部落格封存', href: '../../index.html' },
        { label: '分類', href: '../' },
        { label: group.name, href: './' },
      ],
    }));
  }

  await writeFile(path.join(DOCS_DIR, 'months', 'index.html'), renderArchiveIndex({
    title: '月份封存',
    rootPrefix: '../',
    groups: months.map((group) => ({
      name: monthLabel(group.name),
      href: `${group.name}/`,
      count: group.posts.length,
    })),
  }));

  for (const group of months) {
    const outputDir = path.join(DOCS_DIR, 'months', group.name);
    await mkdir(outputDir, { recursive: true });
    await writeFile(path.join(outputDir, 'index.html'), renderArchivePage({
      title: `月份封存：${monthLabel(group.name)}`,
      posts: group.posts,
      rootPrefix: '../../',
      breadcrumbs: [
        { label: '部落格封存', href: '../../index.html' },
        { label: '月份', href: '../' },
        { label: monthLabel(group.name), href: './' },
      ],
    }));
  }
}

function renderPostList(posts, rootPrefix) {
  return posts.map((post) => {
    const excerpt = markdownExcerpt(post.body, 150);
    return `
      <div class="article-div divider">
        <article class="post-list-item">
          <header class="entry-header">
            <h2 class="entry-title"><a href="${rootPrefix}posts/${post.id}/">${escapeHtml(post.title)}</a></h2>
            <p class="entry-posted">${dateBadge(post.date)}</p>
          </header>
          <div class="entry-content half">${escapeHtml(excerpt)}${excerpt ? '...' : ''}</div>
          <footer class="entry-footer">
            ${displayCategories(post).length ? `<div class="entry-category-box">文章分類：${displayCategories(post).map((category) => categoryLink(category, rootPrefix)).join('、')}</div>` : ''}
          </footer>
        </article>
      </div>`;
  }).join('\n');
}

function renderArchivePage({ title, posts, rootPrefix, breadcrumbs }) {
  return pageShell({
    title: `${title} | ${SITE_TITLE} 封存`,
    rootPrefix,
    bodyClass: 'archive',
    breadcrumbs,
    snapshotUrl: SITE_SNAPSHOT_URL,
    body: `
      <main id="primary" class="content" role="main">
        <header class="archive-header">
          <h2>${escapeHtml(title)}</h2>
          <p>${posts.length} 篇文章</p>
        </header>
        ${renderPostList(posts, rootPrefix)}
      </main>
      ${sidebar(rootPrefix, SITE_SNAPSHOT_URL)}
    `,
  });
}

function renderArchiveIndex({ title, rootPrefix, groups }) {
  return pageShell({
    title: `${title} | ${SITE_TITLE} 封存`,
    rootPrefix,
    bodyClass: 'archive-index',
    breadcrumbs: [
      { label: '部落格封存', href: `${rootPrefix}index.html` },
      { label: title, href: './' },
    ],
    snapshotUrl: SITE_SNAPSHOT_URL,
    body: `
      <main id="primary" class="content" role="main">
        <header class="archive-header">
          <h2>${escapeHtml(title)}</h2>
        </header>
        <ul class="archive-list">
          ${groups.map((group) => `<li><a href="${escapeAttr(group.href)}">${escapeHtml(group.name)}</a><span>${group.count}</span></li>`).join('')}
        </ul>
      </main>
      ${sidebar(rootPrefix, SITE_SNAPSHOT_URL)}
    `,
  });
}

function groupByCategory(posts) {
  const groups = new Map();
  for (const post of posts) {
    for (const category of displayCategories(post)) {
      if (!groups.has(category)) {
        groups.set(category, []);
      }
      groups.get(category).push(post);
    }
  }
  return [...groups.entries()]
    .map(([name, groupPosts]) => ({ name, slug: slugify(name), posts: groupPosts }))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'));
}

function groupByMonth(posts) {
  const groups = new Map();
  for (const post of posts) {
    const month = post.date?.match(/^\d{4}-\d{2}/)?.[0];
    if (!month) {
      continue;
    }
    if (!groups.has(month)) {
      groups.set(month, []);
    }
    groups.get(month).push(post);
  }
  return [...groups.entries()]
    .map(([name, groupPosts]) => ({ name, posts: groupPosts }))
    .sort((a, b) => b.name.localeCompare(a.name));
}

function monthLabel(month) {
  const [year, value] = month.split('-');
  return `${year} 年 ${Number(value)} 月`;
}

function postBreadcrumbs(post, rootPrefix) {
  const month = post.date?.match(/^\d{4}-\d{2}/)?.[0];
  const items = [{ label: '部落格封存', href: `${rootPrefix}index.html` }];
  if (month) {
    items.push({ label: monthLabel(month), href: `${rootPrefix}months/${month}/` });
  }
  items.push({ label: post.title, href: `${rootPrefix}posts/${post.id}/` });
  return items;
}

function categoryLink(category, rootPrefix) {
  return `<a href="${rootPrefix}categories/${escapeAttr(slugify(category))}/">${escapeHtml(category)}</a>`;
}

function displayCategories(post) {
  return post.categories.filter((category) => KNOWN_CATEGORIES.includes(category));
}

function slugify(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[\\/?%*:|"<>]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'uncategorized';
}

function markdownExcerpt(markdown, maxLength) {
  return markdown
    .replace(/^---[\s\S]*?---\n?/, '')
    .replace(/\[!\[([^\]]*)\]\([^)]+\)\]\([^)]+\)/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[#>*`_-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function renderNotFound() {
  return pageShell({
    title: `找不到頁面 | ${SITE_TITLE}`,
    rootPrefix: '',
    bodyClass: 'error404',
    breadcrumbs: [
      { label: '部落格封存', href: 'index.html' },
      { label: '找不到頁面', href: './' },
    ],
    snapshotUrl: SITE_SNAPSHOT_URL,
    body: `
      <main id="primary" class="content" role="main">
        <article class="post single-post">
          <header class="entry-header"><h2 class="entry-title">找不到頁面</h2></header>
          <div class="entry-content"><p>這份封存中沒有對應的頁面。請回到 <a href="./">文章列表</a> 瀏覽。</p></div>
        </article>
      </main>
      ${sidebar('', SITE_SNAPSHOT_URL)}
    `,
  });
}

function pageShell({ title, rootPrefix, bodyClass, body, breadcrumbs = [], snapshotUrl = SITE_SNAPSHOT_URL }) {
  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="Mozilla Taiwan 部落格封存">
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="${rootPrefix}styles.css">
</head>
<body class="${escapeAttr(bodyClass)} sky">
  <div id="outer-wrapper">
    <div id="wrapper">
      <div id="doc">
        <header id="masthead">
          <a id="tabzilla" href="https://mozilla.org/">mozilla</a>
          <hgroup>
            <h1>Mozilla Taiwan 部落格</h1>
            <h2>${SITE_SUBTITLE}</h2>
          </hgroup>
        </header>
        ${renderBreadcrumbs(breadcrumbs)}
        <div id="main">
          ${body}
        </div>
      </div>
    </div>
  </div>
</body>
</html>
`;
}

function sidebar(rootPrefix, snapshotUrl) {
  return `<aside id="secondary" class="widget-area" role="complementary">
    <section class="widget">
      <h3>文章分類</h3>
      <ul>
        ${KNOWN_CATEGORIES.map((name) => `<li>${categoryLink(name, rootPrefix)}</li>`).join('')}
      </ul>
    </section>
    ${monthArchiveWidget(rootPrefix)}
    <section class="widget">
      <h3>封存說明</h3>
      <p>此頁為 Mozilla Taiwan 部落格封存，由 <a href="${escapeAttr(snapshotUrl)}">Wayback snapshot</a> 重建。除另有註明外，本站內容皆採 <a href="${LICENSE_URL}">${LICENSE_NAME}</a> 或更新版本授權大眾使用。</p>
    </section>
  </aside>`;
}

function renderBreadcrumbs(items) {
  if (!items.length) {
    return '';
  }
  return `<nav class="breadcrumbs">${items.map((item, index) => {
    const content = item.href ? `<a href="${escapeAttr(item.href)}">${escapeHtml(item.label)}</a>` : `<span>${escapeHtml(item.label)}</span>`;
    return `${index ? '<b>-</b>' : ''}${content}`;
  }).join('')}</nav>`;
}

function monthArchiveWidget(rootPrefix) {
  const groups = groupByMonth(ALL_POSTS);
  return `<section class="widget">
    <h3>月份彙整</h3>
    <select class="archive-dropdown" onchange="if (this.value) window.location.href=this.value">
      <option value="">選擇月份</option>
      ${groups.map((group) => `<option value="${rootPrefix}months/${group.name}/">${monthLabel(group.name)} (${group.posts.length})</option>`).join('')}
    </select>
  </section>`;
}

function dateBadge(date) {
  if (!date) {
    return '<time>日期不明</time>';
  }
  const [year, month, day] = String(date).split('-');
  return `<time datetime="${escapeAttr(date)}" class="published"><span class="posted-month">${Number(month)}月</span><span class="posted-date">${Number(day)}</span><span class="posted-year">${year}</span></time>`;
}

function stylesheet() {
  return `body {
  margin: 0;
  background: #f4f4f1;
  color: #333;
  font: 16px/1.7 "Helvetica Neue", Arial, "Noto Sans TC", sans-serif;
}
a { color: #0a6f9e; text-decoration: none; }
a:hover { text-decoration: underline; }
#outer-wrapper { border-top: 2px solid #fff; }
#wrapper { max-width: 1060px; margin: 0 auto; background: #fff; min-height: 100vh; box-shadow: 0 0 20px rgba(0,0,0,.08); }
#doc { padding: 0 32px 48px; }
#masthead { position: relative; padding: 30px 0 24px; border-bottom: 1px solid #ddd; }
#tabzilla { position: absolute; right: 0; top: 0; padding: 7px 14px; background: #c13832; color: #fff; font-size: 13px; text-transform: lowercase; }
#masthead > h2 { margin: 0 0 18px; font-size: 24px; letter-spacing: 0; text-transform: lowercase; }
#masthead > h2 a { color: #333; }
.breadcrumbs { margin: 0 0 22px; color: #777; font-size: 13px; }
.breadcrumbs b { color: #aaa; margin: 0 6px; }
hgroup { padding: 32px 0 34px; background: linear-gradient(90deg, #f08a24, #d94f2b); color: #fff; }
hgroup h1, hgroup h2 { margin-left: 28px; margin-right: 28px; }
hgroup h1 { margin-top: 0; margin-bottom: 2px; font-size: 44px; line-height: 1.1; font-weight: 300; }
hgroup h2 { margin-top: 0; margin-bottom: 0; font-size: 18px; font-weight: 400; }
#main { display: grid; grid-template-columns: minmax(0, 1fr) 250px; gap: 36px; padding-top: 30px; }
.article-div { padding: 0 0 28px; margin: 0 0 30px; border-bottom: 1px solid #ddd; }
.post, .post-list-item { position: relative; }
.entry-header { display: grid; grid-template-columns: minmax(0, 1fr) 74px; gap: 20px; align-items: start; }
.entry-title { margin: 0 0 14px; font-size: 28px; line-height: 1.25; font-weight: 400; }
.post-list-item .entry-title { font-size: 25px; }
.entry-title a { color: #333; }
.entry-posted { margin: 0; text-align: center; }
.published { display: block; border: 1px solid #d0d0cc; background: #f8f8f5; color: #666; }
.posted-month, .posted-year { display: block; padding: 2px 0; font-size: 13px; background: #e7e7e1; }
.posted-date { display: block; font-size: 34px; line-height: 1.2; color: #c13832; }
.entry-content { font-size: 17px; }
.entry-content p { margin: 0 0 1.15em; }
.entry-content img { max-width: 100%; height: auto; display: block; margin: 1.4em auto; }
.entry-content blockquote { margin: 1.4em 0; padding-left: 1.2em; border-left: 4px solid #d94f2b; color: #555; }
.entry-content pre { overflow-x: auto; padding: 14px; background: #272822; color: #f8f8f2; }
.entry-content code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .92em; }
.entry-content ul, .entry-content ol { padding-left: 1.6em; }
.entry-footer { margin-top: 20px; color: #666; font-size: 14px; }
.entry-category-box span, .entry-tag-box span { display: inline-block; margin: 0 6px 6px 0; padding: 2px 8px; background: #eee; }
.entry-source-box { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 12px; }
.archive-header { margin: 0 0 26px; padding-bottom: 12px; border-bottom: 1px solid #ddd; }
.archive-header h2 { margin: 0 0 4px; font-size: 30px; font-weight: 400; }
.archive-header p { margin: 0; color: #666; }
.archive-list { margin: 0; padding: 0; list-style: none; }
.archive-list li { display: flex; justify-content: space-between; gap: 16px; padding: 10px 0; border-bottom: 1px solid #e5e5df; }
.archive-list span { color: #777; }
#secondary { font-size: 14px; color: #555; }
.widget { margin-bottom: 28px; }
.widget h3 { margin: 0 0 10px; padding-bottom: 8px; border-bottom: 1px solid #ddd; color: #333; font-size: 18px; font-weight: 400; }
.widget ul { margin: 0; padding-left: 1.2em; }
.widget li { margin: 0 0 5px; }
#site-footer { margin-top: 34px; padding: 20px 0 0; border-top: 1px solid #ddd; color: #666; font-size: 13px; }
#site-footer p { margin: 0 0 6px; }
@media (max-width: 780px) {
  #doc { padding-left: 18px; padding-right: 18px; }
  #main { grid-template-columns: 1fr; }
  .entry-header { grid-template-columns: 1fr; }
  .entry-posted { text-align: left; }
  .published { display: inline-grid; grid-template-columns: auto auto auto; align-items: baseline; }
  .posted-month, .posted-year, .posted-date { display: inline; padding: 2px 8px; font-size: 14px; }
  hgroup h1 { font-size: 34px; }
}
`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function unescapeHtml(value) {
  return String(value)
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'");
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll('\n', ' ');
}

function relative(filePath) {
  return path.relative(ROOT, filePath);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
