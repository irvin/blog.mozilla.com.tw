import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ARCHIVE_DIR = path.join(ROOT, 'archive');
const MD_DIR = path.join(ARCHIVE_DIR, 'articles-md');
const THEME_ASSETS_DIR = path.join(ARCHIVE_DIR, 'theme-assets');
const BUILD_DIR = path.join(ROOT, 'blog');
const POSTS_DIR = path.join(BUILD_DIR, 'posts');
const ASSETS_DIR = path.join(BUILD_DIR, 'assets');

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

  await rm(BUILD_DIR, { recursive: true, force: true });
  await mkdir(POSTS_DIR, { recursive: true });
  await cp(path.join(ARCHIVE_DIR, 'assets'), ASSETS_DIR, { recursive: true });
  await cp(THEME_ASSETS_DIR, path.join(ASSETS_DIR, 'theme'), { recursive: true });
  await writeFile(path.join(BUILD_DIR, 'styles.css'), stylesheet());
  await writeFile(path.join(BUILD_DIR, '.nojekyll'), '');

  for (const post of posts) {
    const html = markdownToHtml(post.body, `../../`, postIds);
    const outputDir = path.join(POSTS_DIR, String(post.frontmatter.post_id));
    await mkdir(outputDir, { recursive: true });
    await writeFile(path.join(outputDir, 'index.html'), renderPost(post, html));
  }

  await writeArchivePages(posts);
  await writeFile(path.join(BUILD_DIR, 'index.html'), renderIndex(posts));
  await writeFile(path.join(BUILD_DIR, '404.html'), renderNotFound());

  console.log(`Built ${posts.length} pages into ${relative(BUILD_DIR)}`);
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

  return pageShell({
    title: `${post.title} | Mozilla Taiwan 部落格封存`,
    rootPrefix: '../../',
    bodyClass: 'single',
    breadcrumbs: postBreadcrumbs(post, '../../'),
    breadcrumbLeadingSeparator: true,
    snapshotUrl: post.frontmatter.archive_url || SITE_SNAPSHOT_URL,
    body: `
      <main id="primary" class="content" role="main">
        <div class="article-div">
          <article class="post single-post">
            <header class="entry-header">
              <p class="entry-posted">${dateBadge(post.date)}</p>
              <h1 class="entry-title">${title}</h1>
            </header>
            <div class="entry-content">${contentHtml}</div>
            <footer class="entry-footer">
              ${categories ? `<div class="entry-category-box">文章分類：${categories}</div>` : ''}
            </footer>
          </article>
        </div>
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
    mastheadHeading: SITE_SUBTITLE,
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

  await mkdir(path.join(BUILD_DIR, 'categories'), { recursive: true });
  await mkdir(path.join(BUILD_DIR, 'months'), { recursive: true });

  await writeFile(path.join(BUILD_DIR, 'categories', 'index.html'), renderArchiveIndex({
    title: '文章分類',
    rootPrefix: '../',
    groups: categories.map((group) => ({
      name: group.name,
      href: `${group.slug}/`,
      count: group.posts.length,
    })),
  }));

  for (const group of categories) {
    const outputDir = path.join(BUILD_DIR, 'categories', group.slug);
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

  await writeFile(path.join(BUILD_DIR, 'months', 'index.html'), renderArchiveIndex({
    title: '月份封存',
    rootPrefix: '../',
    groups: months.map((group) => ({
      name: monthLabel(group.name),
      href: `${group.name}/`,
      count: group.posts.length,
    })),
  }));

  for (const group of months) {
    const outputDir = path.join(BUILD_DIR, 'months', group.name);
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
    const thumbnail = postThumbnail(post.body, rootPrefix);
    return `
      <div class="article-div divider">
        <article class="post-list-item">
          <header class="entry-header">
            <p class="entry-posted">${dateBadge(post.date)}</p>
            <h2 class="entry-title"><a href="${rootPrefix}posts/${post.id}/">${escapeHtml(post.title)}</a></h2>
          </header>
          ${thumbnail ? `<div class="thumb-img"><img src="${escapeAttr(thumbnail.src)}" alt="${escapeAttr(thumbnail.alt)}" loading="lazy"></div>` : ''}
          <div class="entry-content half">${escapeHtml(excerpt)}${excerpt ? '...' : ''}</div>
          <footer class="entry-footer">
            ${displayCategories(post).length ? `<div class="entry-category-box">文章分類：${displayCategories(post).map((category) => categoryLink(category, rootPrefix)).join('、')}</div>` : ''}
          </footer>
        </article>
      </div>`;
  }).join('\n');
}

function postThumbnail(markdown, rootPrefix) {
  const match = markdown.match(/!\[([^\]]*)\]\(([^)]+)\)/);
  if (!match) {
    return null;
  }
  return {
    alt: match[1],
    src: rewriteUrl(match[2].trim(), rootPrefix, new Set()),
  };
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
  const items = [];
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

function pageShell({ title, rootPrefix, bodyClass, body, breadcrumbs = [], breadcrumbLeadingSeparator = false, mastheadHeading = '', snapshotUrl = SITE_SNAPSHOT_URL }) {
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
          <a id="tabzilla" href="https://moztw.org/">moztw.org</a>
          <hgroup>
            <div class="site-logo"><a href="${rootPrefix}index.html"><img src="${rootPrefix}assets/theme/header-logo.png" width="130" height="49" alt="Firefox"></a></div>
            ${mastheadHeading ? `<h1 class="site-heading">${escapeHtml(mastheadHeading)}</h1>` : ''}
          </hgroup>
        </header>
        ${renderBreadcrumbs(breadcrumbs, breadcrumbLeadingSeparator)}
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
      <p>此頁為 Mozilla Taiwan 部落格封存，由 <a href="${escapeAttr(snapshotUrl)}">Wayback snapshot</a> 重建。</p>
      <p>除另有註明外，本站內容皆採 <a href="${LICENSE_URL}">${LICENSE_NAME}</a> 或更新版本授權大眾使用。</p>
    </section>
  </aside>`;
}

function renderBreadcrumbs(items, leadingSeparator = false) {
  if (!items.length) {
    return '';
  }
  return `<nav class="breadcrumbs">${items.map((item, index) => {
    const content = item.href ? `<a href="${escapeAttr(item.href)}">${escapeHtml(item.label)}</a>` : `<span>${escapeHtml(item.label)}</span>`;
    return `${index || leadingSeparator ? '<b>&raquo;</b>' : ''}${content}`;
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
  background: #f6f4ee url("assets/theme/bg-sky.png") repeat center top;
  color: #484848;
  font: 14px/1.65 "Open Sans", "Helvetica Neue", Arial, "Microsoft JhengHei", sans-serif;
}
a { color: #447bc4; text-decoration: none; }
a:hover { text-decoration: underline; }
#outer-wrapper { border-top: 2px solid #fff; }
#wrapper { min-height: 100vh; }
#doc { width: 980px; margin: 0 auto; padding: 0 10px 48px; }
#masthead { position: relative; padding: 0; }
#tabzilla { position: absolute; right: 0; top: 0; display: block; width: 150px; height: 44px; overflow: hidden; background: rgba(255, 255, 255, 0.5); color: #303030; font-size: 13px; line-height: 44px; text-align: center; text-transform: lowercase; z-index: 2; }
.breadcrumbs { margin: 0 0 20px 20px; padding-bottom: 16px; border-bottom: 1px solid #d6d6d6; color: #303030; font-size: 13px; }
.breadcrumbs b { margin: 0 5px; color: #303030; font-size: 120%; font-weight: bold; }
hgroup { margin: 0; padding: 34px 28px 30px; color: #484848; }
hgroup .site-logo, hgroup .site-heading { margin-top: 1em; margin-left: 0; margin-right: 0; text-shadow: none; }
.site-logo { margin: 0 0 3px; }
.site-logo a:hover { text-decoration: none; }
.site-logo img { display: block; width: 130px; height: auto; }
.site-heading { margin-top: 2em; margin-bottom: 0; font-size: 18px; font-weight: 400; line-height: 1.35; }
#main { display: grid; grid-template-columns: 660px 220px; gap: 60px; align-items: start; padding-top: 26px; }
.article-div { clear: both; margin: 0 0 28px; padding: 20px 20px 30px; border-radius: 5px; background-image: -webkit-linear-gradient(top, rgba(255, 255, 255, 0.5), rgba(255, 255, 255, 0.1)); background-image: linear-gradient(to bottom, rgba(255, 255, 255, 0.5), rgba(255, 255, 255, 0.1)); }
.post, .post-list-item { position: relative; }
.entry-header { display: block; }
.entry-title { margin: 0 0 14px; font-size: 32px; line-height: 1.22; font-weight: 300; }
.post-list-item .entry-title { min-height: 44px; margin-left: 92px; font-size: 26px; }
.entry-title a { color: #303030; }
.entry-posted { margin: 0 0 12px; text-align: left; }
.post-list-item .entry-posted { float: left; margin: 0 18px 8px 0; }
.published { display: inline-block; width: 68px; min-width: 68px; height: 72px; padding: 7px 0 0; background: url("assets/theme/bg-date-lt.png") no-repeat center top; color: #555; text-align: center; box-shadow: none; }
.posted-month, .posted-year { display: block; padding: 0; font-size: 14px; line-height: 1.05; background: transparent; }
.posted-date { display: block; font-size: 27px; line-height: .95; color: #555; }
.thumb-img { float: left; width: 150px; height: 150px; margin: 4px 22px 12px 0; overflow: hidden; background: #fff; border: 1px solid #fff; box-shadow: 0 0 16px rgba(0,0,0,.1), 0 1px 3px rgba(0,0,0,.1); }
.thumb-img img { width: 150px; height: 150px; object-fit: cover; display: block; }
.entry-content { font-size: 16px; }
.post-list-item .entry-content.half { min-height: 120px; color: #484848; }
.entry-content p { margin: 0 0 1.15em; }
.entry-content img { max-width: 100%; height: auto; display: block; margin: 1.4em auto; }
.entry-content blockquote { margin: 1.4em 0; padding-left: 1.2em; border-left: 4px solid #d94f2b; color: #555; }
.entry-content pre { overflow-x: auto; padding: 14px; background: #272822; color: #f8f8f2; }
.entry-content code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .92em; }
.entry-content ul, .entry-content ol { padding-left: 1.6em; }
.entry-footer { display: block; clear: both; margin: 24px 0 0; padding: 12px 24px 3px; background: rgba(0,0,0,.02); border-bottom: 1px solid rgba(255,255,255,.5); box-shadow: 0 0 3px rgba(0,0,0,.1) inset; color: #666; font-size: 14px; }
.entry-category-box { margin-bottom: 10px; }
.entry-category-box span, .entry-tag-box span { display: inline-block; margin: 0 6px 6px 0; padding: 2px 8px; background: #eee; }
.archive-header { margin: 0 0 26px; padding-bottom: 12px; border-bottom: 1px solid #ddd; }
.archive-header h2 { margin: 0 0 4px; font-size: 30px; font-weight: 400; }
.archive-header p { margin: 0; color: #666; }
.archive-list { margin: 0; padding: 0; list-style: none; }
.archive-list li { display: flex; justify-content: space-between; gap: 16px; padding: 10px 0; border-bottom: 1px solid #e5e5df; }
.archive-list span { color: #777; }
#secondary { font-size: 14px; color: #555; }
.widget { display: block; margin: 0 0 22px; padding: 0 0 16px; border-bottom: 1px dotted #d6d6d6; }
.widget h3 { margin: 0 0 10px; color: #333; font-size: 18px; font-weight: 400; }
.widget ul { margin: 0; padding-left: 1.2em; }
.widget li { margin: 0 0 5px; }
.archive-dropdown { max-width: 100%; }
@media (max-width: 1000px) {
  #doc { width: 760px; }
  #main { grid-template-columns: 1fr; }
  #secondary { width: 660px; margin: 20px auto 0; }
  #secondary .widget { display: inline-block; width: 200px; margin: 0 8px 18px; padding: 0 6px 12px; vertical-align: top; }
}
@media (max-width: 760px) {
  #doc { width: auto; padding-left: 18px; padding-right: 18px; }
  #main, #secondary { width: auto; }
  .post-list-item .entry-title { min-height: 0; margin-left: 0; }
  .post-list-item .entry-posted { float: none; }
  .thumb-img { float: none; margin-left: 0; }
  #secondary .widget { display: block; width: auto; margin: 0 0 22px; }
  .entry-posted { text-align: left; }
  .site-heading { font-size: 18px; }
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
