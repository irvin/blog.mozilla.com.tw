#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const ARCHIVE_DIR = path.join(ROOT, 'archive');
const RAW_DIR = path.join(ARCHIVE_DIR, 'raw-html');
const JSON_DIR = path.join(ARCHIVE_DIR, 'articles-json');
const MD_DIR = path.join(ARCHIVE_DIR, 'articles-md');
const ASSETS_DIR = path.join(ARCHIVE_DIR, 'assets');
const DISCOVERY_DIR = path.join(ARCHIVE_DIR, 'discovery');
const CDX_PATH = path.join(ARCHIVE_DIR, 'cdx-snapshots.json');
const MANIFEST_PATH = path.join(ARCHIVE_DIR, 'manifest.json');
const INDEX_PATH = path.join(ARCHIVE_DIR, 'index.csv');

const POST_ID_MIN = 74;
const POST_ID_MAX = 9335;
const SNAPSHOT_CUTOFF = '20201231235959';
const MAX_SNAPSHOT_ATTEMPTS = 5;
const ARTICLE_TEXT_MIN_LENGTH = 120;
const USER_AGENT = 'MozillaTaiwanBlogArchive/0.1 (+https://blog.mozilla.com.tw archival recovery)';
const CATEGORY_MAP = {
  8: 'Firefox',
  11: 'Firefox for Android',
  154: 'Firefox for iOS',
  10: 'Firefox OS',
  43: 'Identity',
  12: 'Mozilla',
  42: 'Privacy',
  149: 'Security',
  35: 'Web App',
  16: '新聞訊息',
  1: '未分類',
  44: '校園大使',
  21: '活動',
};
const MONTH_START = 201112;
const MONTH_END = 201610;

const args = parseArgs(process.argv.slice(2));
const command = args._[0] ?? 'all';

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

async function main() {
  if (args.help || args.h) {
    printHelp();
    return;
  }

  await ensureArchiveDirs();

  if (command === 'scan') {
    const snapshots = await scanCdx();
    await saveJson(CDX_PATH, snapshots);
    console.log(`Saved ${Object.keys(snapshots).length} post snapshot groups to ${relative(CDX_PATH)}`);
    return;
  }

  if (command === 'discover') {
    const snapshots = await scanOrReadCdx();
    const result = await discoverFromCategories(snapshots);
    console.log(
      [
        `Discovered ${result.discovered_count} post ids from listing pages`,
        `${result.missing_before_count} were missing before discovery`,
        `${result.merged_count} merged into ${relative(CDX_PATH)}`,
        `${result.missing_after_count} still missing`,
      ].join('; ')
    );
    return;
  }

  if (command === 'fetch' || command === 'all') {
    const snapshots = command === 'all' ? await scanOrReadCdx() : await readCdx();
    const result = await fetchPosts(snapshots);
    await saveOutputs(result);
    console.log(`Archived ${result.articles.length} articles; manifest written to ${relative(MANIFEST_PATH)}`);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

function printHelp() {
  console.log(`Usage:
  npm run archive:scan
  npm run archive -- discover --merge-cdx
  npm run archive:fetch -- --limit 10 --include-assets
  npm run archive -- --start 74 --end 9335 --delay-min 1000 --delay-max 3000

Commands:
  scan   Query CDX and write archive/cdx-snapshots.json
  discover
         Discover post ids from archived category/month listing pages
  fetch  Read archive/cdx-snapshots.json and archive posts
  all    Scan if needed, then archive posts (default)

Options:
  --start <id>          First post id, default ${POST_ID_MIN}
  --end <id>            Last post id, default ${POST_ID_MAX}
  --limit <n>           Limit number of posts processed
  --include-assets      Download images referenced inside article content
  --delay-min <ms>      Minimum request delay, default 1000
  --delay-max <ms>      Maximum request delay, default 3000
  --max-attempts <n>    Snapshot attempts per post, default ${MAX_SNAPSHOT_ATTEMPTS}
  --merge-cdx           For discovered missing ids, query CDX and merge found snapshots
`);
}

async function scanOrReadCdx() {
  try {
    return await readCdx();
  } catch {
    const snapshots = await scanCdx();
    await saveJson(CDX_PATH, snapshots);
    return snapshots;
  }
}

async function readCdx() {
  return JSON.parse(await readFile(CDX_PATH, 'utf8'));
}

async function scanCdx() {
  const url = [
    'https://web.archive.org/cdx/search/cdx',
    '?url=blog.mozilla.com.tw/%3Fp=*',
    '&output=json',
    '&fl=timestamp,original,statuscode,mimetype,digest,length',
    '&filter=statuscode:200',
    '&filter=mimetype:text/html',
    '&collapse=digest',
  ].join('');

  const response = await fetchWithRetry(url, { accept: 'application/json' });
  const rows = await response.json();
  const header = rows[0] ?? [];
  const snapshots = {};

  for (const row of rows.slice(1)) {
    const item = Object.fromEntries(header.map((key, index) => [key, row[index]]));
    const postId = getPostId(item.original);

    if (!postId || postId < POST_ID_MIN || postId > POST_ID_MAX) {
      continue;
    }

    snapshots[postId] ??= [];
    snapshots[postId].push({
      timestamp: item.timestamp,
      original: normalizeOriginalUrl(item.original),
      statuscode: Number(item.statuscode),
      mimetype: item.mimetype,
      digest: item.digest,
      length: Number(item.length || 0),
    });
  }

  for (const postSnapshots of Object.values(snapshots)) {
    postSnapshots.sort(compareSnapshots);
  }

  return snapshots;
}

async function discoverFromCategories(snapshots) {
  await mkdir(DISCOVERY_DIR, { recursive: true });

  const categoryPages = await scanListingPages('cat');
  const monthPages = await scanListingPages('month');
  const discovered = new Map();
  const listingPages = [...categoryPages, ...monthPages];

  for (const [index, page] of listingPages.entries()) {
    try {
      const html = await fetchText(waybackUrl(page.snapshot, true));
      const cleanedHtml = cleanWaybackHtml(html);
      const ids = discoverPostIdsFromHtml(cleanedHtml);
      const rawPath = path.join(DISCOVERY_DIR, 'listing-pages', `${page.kind}-${page.key}-page-${page.page}-${page.snapshot.timestamp}.html`);

      await mkdir(path.dirname(rawPath), { recursive: true });
      await writeFile(rawPath, html, 'utf8');

      for (const postId of ids) {
        const item = discovered.get(postId) ?? { post_id: postId, sources: [] };
        item.sources.push({
          kind: page.kind,
          key: page.key,
          name: page.name,
          page: page.page,
          url: page.snapshot.original,
          timestamp: page.snapshot.timestamp,
        });
        discovered.set(postId, item);
      }

      console.log(`Discovery ${index + 1}/${listingPages.length}: ${page.kind} ${page.key} page ${page.page}, ids=${ids.length}`);
    } catch (error) {
      console.warn(`Discovery failed: ${page.kind} ${page.key} page ${page.page}: ${error.message}`);
    }

    await sleep(randomDelay());
  }

  const discoveredRows = [...discovered.values()].sort((a, b) => a.post_id - b.post_id);
  const missingBefore = discoveredRows.filter((row) => !snapshots[row.post_id]);
  const merged = [];

  if (hasFlag('merge-cdx')) {
    for (const [index, row] of missingBefore.entries()) {
      const postSnapshots = await scanPostSnapshots(row.post_id);
      if (postSnapshots.length) {
        snapshots[row.post_id] = postSnapshots;
        merged.push({ post_id: row.post_id, snapshots: postSnapshots.length });
      }
      console.log(`CDX merge ${index + 1}/${missingBefore.length}: ${row.post_id}, snapshots=${postSnapshots.length}`);
      await sleep(randomDelay());
    }

    for (const postSnapshots of Object.values(snapshots)) {
      postSnapshots.sort(compareSnapshots);
    }

    await saveJson(CDX_PATH, sortSnapshotMap(snapshots));
  }

  const missingAfter = discoveredRows.filter((row) => !snapshots[row.post_id]);
  const result = {
    generated_at: new Date().toISOString(),
    listing_pages: {
      category: categoryPages.length,
      month: monthPages.length,
      total: listingPages.length,
    },
    discovered_count: discoveredRows.length,
    existing_cdx_count: Object.keys(snapshots).length,
    missing_before_count: missingBefore.length,
    merged_count: merged.length,
    missing_after_count: missingAfter.length,
    merged,
  };

  await saveJson(path.join(DISCOVERY_DIR, 'discovered-post-ids.json'), discoveredRows);
  await saveJson(path.join(DISCOVERY_DIR, 'missing-before-merge.json'), missingBefore);
  await saveJson(path.join(DISCOVERY_DIR, 'missing-after-merge.json'), missingAfter);
  await saveJson(path.join(DISCOVERY_DIR, 'summary.json'), result);
  await writeFile(
    path.join(DISCOVERY_DIR, 'missing-post-ids.txt'),
    missingAfter.map((row) => row.post_id).join('\n') + (missingAfter.length ? '\n' : ''),
    'utf8'
  );

  return result;
}

async function scanListingPages(kind) {
  const rows = kind === 'cat'
    ? await scanCdxRows('blog.mozilla.com.tw/%3Fcat=*', 'urlkey')
    : await scanCdxRows('blog.mozilla.com.tw/%3Fm=*', 'urlkey');
  const pages = [];

  for (const row of rows) {
    const parsed = new URL(normalizeOriginalUrl(row.original));
    const key = kind === 'cat' ? parsed.searchParams.get('cat') : parsed.searchParams.get('m');

    if (kind === 'cat' && !CATEGORY_MAP[key]) {
      continue;
    }
    if (kind === 'month' && !isWantedMonth(key)) {
      continue;
    }

    pages.push({
      kind,
      key,
      name: kind === 'cat' ? CATEGORY_MAP[key] : key,
      page: parsed.searchParams.get('paged') || '1',
      snapshot: {
        timestamp: row.timestamp,
        original: normalizeOriginalUrl(row.original),
        statuscode: Number(row.statuscode),
        mimetype: row.mimetype,
        digest: row.digest,
        length: Number(row.length || 0),
      },
    });
  }

  return choosePreferredListingPages(pages);
}

async function scanCdxRows(urlPattern, collapse) {
  const url = [
    'https://web.archive.org/cdx/search/cdx',
    `?url=${urlPattern}`,
    '&output=json',
    '&fl=timestamp,original,statuscode,mimetype,digest,length',
    '&filter=statuscode:200',
    '&filter=mimetype:text/html',
    `&collapse=${collapse}`,
  ].join('');
  const response = await fetchWithRetry(url, { accept: 'application/json' });
  const rows = await response.json();
  const header = rows[0] ?? [];
  return rows.slice(1).map((row) => Object.fromEntries(header.map((key, index) => [key, row[index]])));
}

function choosePreferredListingPages(pages) {
  const byPage = new Map();

  for (const page of pages) {
    const key = `${page.kind}:${page.key}:${page.page}`;
    const current = byPage.get(key);
    if (!current || compareSnapshots(page.snapshot, current.snapshot) < 0) {
      byPage.set(key, page);
    }
  }

  return [...byPage.values()].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
    if (a.key !== b.key) return String(a.key).localeCompare(String(b.key));
    return Number(a.page) - Number(b.page);
  });
}

async function scanPostSnapshots(postId) {
  const rows = await scanCdxRows(`blog.mozilla.com.tw/*p=${postId}*`, 'digest');
  const snapshots = [];
  const seen = new Set();

  for (const row of rows) {
    const foundPostId = getPostId(row.original);

    if (foundPostId !== postId) {
      continue;
    }

    const key = `${row.timestamp}:${row.original}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    snapshots.push({
      timestamp: row.timestamp,
      original: normalizeOriginalUrl(row.original),
      statuscode: Number(row.statuscode),
      mimetype: row.mimetype,
      digest: row.digest,
      length: Number(row.length || 0),
    });
  }

  return snapshots.sort(compareSnapshots);
}

function discoverPostIdsFromHtml(html) {
  return [...new Set(collectLinks(html, 'https://blog.mozilla.com.tw/')
    .map((link) => getPostId(link.url))
    .filter((postId) => postId && postId >= POST_ID_MIN && postId <= POST_ID_MAX))]
    .sort((a, b) => a - b);
}

function isWantedMonth(value) {
  const month = Number(value);
  return Number.isInteger(month) && month >= MONTH_START && month <= MONTH_END;
}

function sortSnapshotMap(snapshots) {
  return Object.fromEntries(
    Object.entries(snapshots)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([postId, postSnapshots]) => [postId, [...postSnapshots].sort(compareSnapshots)])
  );
}

async function fetchPosts(snapshots) {
  const start = Number(args.start ?? POST_ID_MIN);
  const end = Number(args.end ?? POST_ID_MAX);
  const limit = args.limit ? Number(args.limit) : Infinity;
  const ids = Object.keys(snapshots)
    .map(Number)
    .filter((id) => id >= start && id <= end)
    .sort((a, b) => a - b)
    .slice(0, limit);

  const articles = [];
  const manifest = {
    generated_at: new Date().toISOString(),
    post_id_range: { start, end },
    totals: {
      posts_with_snapshots: ids.length,
      success: 0,
      fetch_failed: 0,
      parse_failed: 0,
      empty_article: 0,
      assets_ok: 0,
      partial_assets_failed: 0,
      asset_errors_count: 0,
    },
    posts: [],
  };

  for (const [index, postId] of ids.entries()) {
    const postSnapshots = [...(snapshots[postId] ?? [])].sort(compareSnapshots);
    const result = await archivePost(postId, postSnapshots);

    manifest.posts.push(summaryForManifest(result));
    if (result.status === 'ok') {
      manifest.totals.success += 1;
      articles.push(result);
    } else {
      manifest.totals[result.status] = (manifest.totals[result.status] ?? 0) + 1;
    }

    if (result.asset_status === 'ok') {
      manifest.totals.assets_ok += 1;
    }
    if (result.asset_status === 'partial_assets_failed') {
      manifest.totals.partial_assets_failed += 1;
    }
    manifest.totals.asset_errors_count += result.asset_errors?.length ?? 0;

    if ((index + 1) % 50 === 0) {
      await saveJson(MANIFEST_PATH, manifest);
      await writeIndex(articles);
      console.log(`Checkpoint: ${index + 1}/${ids.length}`);
    }

    await sleep(randomDelay());
  }

  return { articles, manifest };
}

async function archivePost(postId, postSnapshots) {
  if (!postSnapshots.length) {
    return baseArticle(postId, { status: 'no_snapshot' });
  }

  const candidates = postSnapshots.slice(0, Number(args.maxAttempts ?? MAX_SNAPSHOT_ATTEMPTS));
  const errors = [];

  for (const snapshot of candidates) {
    const rawUrl = waybackUrl(snapshot, true);
    const replayUrl = waybackUrl(snapshot, false);

    try {
      let html;
      let archiveUrl = rawUrl;

      try {
        html = await fetchText(rawUrl);
      } catch (error) {
        errors.push({ timestamp: snapshot.timestamp, stage: 'fetch_raw', reason: error.message });
        html = await fetchText(replayUrl);
        archiveUrl = replayUrl;
      }

      const cleanedHtml = cleanWaybackHtml(html);
      const parsed = parseArticle(cleanedHtml, snapshot.original);
      const validation = validateParsed(parsed);

      if (!validation.ok) {
        errors.push({ timestamp: snapshot.timestamp, stage: 'validate', reason: validation.reason });
        continue;
      }

      const rawPath = path.join(RAW_DIR, `${postId}-${snapshot.timestamp}.html`);
      await writeFile(rawPath, html, 'utf8');

      const assetResult = hasFlag('include-assets')
        ? await archiveAssets(postId, parsed.images, snapshot.timestamp)
        : { images: parsed.images, asset_status: 'skipped', asset_errors: [] };

      const article = {
        ...baseArticle(postId),
        title: parsed.title,
        date: parsed.date,
        ...dateParts(parsed.date),
        categories: parsed.categories,
        tags: parsed.tags,
        author: parsed.author,
        original_url: canonicalPostUrl(postId),
        archive_url: archiveUrl,
        wayback_timestamp: snapshot.timestamp,
        content_html: parsed.contentHtml,
        content_text: parsed.contentText,
        images: assetResult.images,
        links: parsed.links,
        status: 'ok',
        asset_status: assetResult.asset_status,
        asset_errors: assetResult.asset_errors,
      };

      await writeArticle(article);
      return article;
    } catch (error) {
      errors.push({ timestamp: snapshot.timestamp, stage: 'archive', reason: error.message });
    }
  }

  const status = errors.some((error) => error.stage === 'validate' && error.reason === 'empty_article')
    ? 'empty_article'
    : errors.some((error) => error.stage === 'validate')
      ? 'parse_failed'
      : 'fetch_failed';

  return baseArticle(postId, { status, errors });
}

function baseArticle(postId, extra = {}) {
  return {
    post_id: postId,
    title: '',
    date: '',
    year: null,
    month: null,
    day: null,
    categories: [],
    tags: [],
    author: '',
    original_url: `https://blog.mozilla.com.tw/?p=${postId}`,
    archive_url: '',
    wayback_timestamp: '',
    content_html: '',
    content_text: '',
    images: [],
    links: [],
    status: 'ok',
    asset_status: 'ok',
    asset_errors: [],
    ...extra,
  };
}

function parseArticle(html, originalUrl) {
  const articleHtml = firstMatch(html, [
    /<article\b[^>]*>[\s\S]*?<\/article>/i,
    /<div\b[^>]*class=["'][^"']*\bpost\b[^"']*["'][^>]*>[\s\S]*?<\/div>/i,
    /<div\b[^>]*class=["'][^"']*\bentry-content\b[^"']*["'][^>]*>[\s\S]*?<\/div>/i,
    /<div\b[^>]*class=["'][^"']*\bpost-content\b[^"']*["'][^>]*>[\s\S]*?<\/div>/i,
  ]);
  const contentHtml = extractEntryContent(articleHtml) || articleHtml || '';
  const title = cleanText(
    firstCapture(articleHtml, [
      /<h1\b[^>]*>([\s\S]*?)<\/h1>/i,
      /<h2\b[^>]*class=["'][^"']*\bentry-title\b[^"']*["'][^>]*>([\s\S]*?)<\/h2>/i,
    ]) ||
      firstCapture(html, [/<title\b[^>]*>([\s\S]*?)<\/title>/i])
  ).replace(/\s*[|｜-]\s*Mozilla Taiwan.*$/i, '');

  const date =
    parseDisplayedPostDate(articleHtml) ||
    parseDate(firstCapture(articleHtml, [
      /<time\b[^>]*datetime=["']([^"']+)["'][^>]*>/i,
      /<[^>]*class=["'][^"']*\b(?:posted-on|entry-date|published)\b[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i,
    ])) ||
    parseDate(firstCapture(html, [/<meta\b[^>]*property=["']article:published_time["'][^>]*content=["']([^"']+)["'][^>]*>/i]));

  const categories = collectRelText(articleHtml, 'category');
  const tags = collectRelText(articleHtml, 'tag');
  const author = cleanText(firstCapture(articleHtml, [
    /<[^>]*class=["'][^"']*\bauthor\b[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i,
  ]));
  const images = collectImages(contentHtml, originalUrl);
  const links = collectLinks(contentHtml, originalUrl);
  const contentText = htmlToText(contentHtml);

  return { title, date, categories, tags, author, contentHtml, contentText, images, links };
}

function validateParsed(parsed) {
  if (!parsed.contentHtml) {
    return { ok: false, reason: 'parse_failed' };
  }
  if (isErrorPage(parsed.contentText)) {
    return { ok: false, reason: 'wayback_error_page' };
  }
  if (!parsed.title) {
    return { ok: false, reason: 'missing_title' };
  }
  if (parsed.contentText.length < ARTICLE_TEXT_MIN_LENGTH) {
    return { ok: false, reason: 'empty_article' };
  }
  return { ok: true };
}

function extractEntryContent(html) {
  const startMatch = html.match(/<div\b[^>]*class=["'][^"']*\b(?:entry-content|post-content)\b[^"']*["'][^>]*>/i);
  if (!startMatch) {
    return '';
  }

  const startIndex = startMatch.index;
  const afterStart = startIndex + startMatch[0].length;
  const wordpressCommentEnd = html.indexOf('<!-- .entry-content -->', afterStart);

  if (wordpressCommentEnd >= 0) {
    const closeDivStart = html.lastIndexOf('</div>', wordpressCommentEnd);
    const endIndex = closeDivStart >= afterStart ? closeDivStart + '</div>'.length : wordpressCommentEnd;
    return html.slice(startIndex, endIndex);
  }

  return sliceBalancedElement(html, startIndex, 'div');
}

function sliceBalancedElement(html, startIndex, tagName) {
  const tagPattern = new RegExp(`<\\/?${tagName}\\b[^>]*>`, 'gi');
  tagPattern.lastIndex = startIndex;

  let depth = 0;
  let match;

  while ((match = tagPattern.exec(html))) {
    if (match[0].startsWith('</')) {
      depth -= 1;
      if (depth === 0) {
        return html.slice(startIndex, tagPattern.lastIndex);
      }
    } else if (!match[0].endsWith('/>')) {
      depth += 1;
    }
  }

  return '';
}

async function archiveAssets(postId, images, timestamp) {
  const usedPaths = new Set();
  const assetErrors = [];
  const archivedImages = [];

  for (const [index, image] of images.entries()) {
    try {
      const assetUrl = waybackAssetUrl(timestamp, image.url);
      const response = await fetchWithRetry(assetUrl, { accept: 'image/*' });
      const contentType = response.headers.get('content-type') || '';

      if (!contentType.toLowerCase().startsWith('image/')) {
        throw new Error(`content_type_not_image:${contentType || 'missing'}`);
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length === 0) {
        throw new Error('empty_asset');
      }
      if (!looksLikeImage(buffer, contentType)) {
        throw new Error('signature_not_image');
      }

      const assetPath = chooseAssetPath(postId, image.url, index, buffer, contentType, usedPaths);
      usedPaths.add(assetPath);
      await mkdir(path.dirname(assetPath), { recursive: true });
      await writeFile(assetPath, buffer);

      archivedImages.push({
        ...image,
        archive_path: path.relative(ARCHIVE_DIR, assetPath),
        markdown_path: `../assets/${path.relative(ASSETS_DIR, assetPath).split(path.sep).join('/')}`,
      });
    } catch (error) {
      assetErrors.push({ url: image.url, reason: error.message });
      archivedImages.push(image);
    }

    await sleep(randomDelay());
  }

  return {
    images: archivedImages,
    asset_status: assetErrors.length ? 'partial_assets_failed' : 'ok',
    asset_errors: assetErrors,
  };
}

function chooseAssetPath(postId, imageUrl, index, buffer, contentType, usedPaths) {
  const parsed = new URL(imageUrl);
  const uploadsIndex = parsed.pathname.indexOf('/wp-content/uploads/');

  if (uploadsIndex >= 0) {
    const relativePath = decodeURIComponent(parsed.pathname.slice(uploadsIndex + 1));
    const assetPath = path.join(ASSETS_DIR, String(postId), relativePath);
    if (!usedPaths.has(assetPath)) {
      return assetPath;
    }
  }

  const hash = createHash('sha256').update(buffer).digest('hex').slice(0, 12);
  const ext = extensionFromUrlOrType(parsed.pathname, contentType);
  return path.join(ASSETS_DIR, String(postId), `${String(index + 1).padStart(3, '0')}-${hash}${ext}`);
}

async function writeArticle(article) {
  await saveJson(path.join(JSON_DIR, `${article.post_id}.json`), article);
  await writeFile(path.join(MD_DIR, `${article.post_id}.md`), articleToMarkdown(article), 'utf8');
}

async function saveOutputs({ articles, manifest }) {
  await saveJson(MANIFEST_PATH, manifest);
  await writeIndex(articles);
}

async function writeIndex(articles) {
  const rows = [
    ['post_id', 'date', 'title', 'status', 'asset_status', 'original_url', 'archive_url'],
    ...articles.map((article) => [
      article.post_id,
      article.date,
      article.title,
      article.status,
      article.asset_status,
      article.original_url,
      article.archive_url,
    ]),
  ];
  await writeFile(INDEX_PATH, rows.map(csvRow).join('\n') + '\n', 'utf8');
}

function articleToMarkdown(article) {
  const body = htmlToMarkdown(article.content_html, article.images);
  return `---\n${yamlLine('post_id', article.post_id)}${yamlLine('title', article.title)}${yamlLine('date', article.date)}${yamlArray('categories', article.categories)}${yamlArray('tags', article.tags)}${yamlLine('author', article.author)}${yamlLine('original_url', article.original_url)}${yamlLine('archive_url', article.archive_url)}${yamlLine('wayback_timestamp', article.wayback_timestamp)}${yamlLine('status', article.status)}${yamlLine('asset_status', article.asset_status)}---\n\n${body}\n`;
}

function htmlToMarkdown(html, images) {
  let output = html;
  const imageMap = new Map(images.map((image) => [image.url, image.markdown_path]));

  output = output.replace(/<img\b([^>]*)>/gi, (_, attrs) => {
    const src = normalizeUrl(attr(attrs, 'src') || attr(attrs, 'data-src') || '', 'https://blog.mozilla.com.tw/');
    const alt = cleanText(attr(attrs, 'alt') || '');
    return src ? `\n![${alt}](${imageMap.get(src) || src})\n` : '';
  });
  output = output.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_, attrs, text) => {
    const href = normalizeUrl(attr(attrs, 'href') || '', 'https://blog.mozilla.com.tw/');
    const label = htmlToText(text);
    return href && label ? `[${label}](${href})` : label;
  });
  output = output.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, text) => `\n${'#'.repeat(Number(level))} ${htmlToText(text)}\n`);
  output = output.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_, text) => `\n- ${htmlToText(text)}`);
  output = output.replace(/<\/p>|<br\s*\/?>/gi, '\n\n');
  output = output.replace(/<[^>]+>/g, '');
  return decodeEntities(output)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function cleanWaybackHtml(html) {
  return html
    .replace(/<div[^>]+id=["']wm-ipp["'][\s\S]*?<\/div>/gi, '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<iframe\b[\s\S]*?<\/iframe>/gi, '')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/(["'])\/web\/\d+(?:[a-z_]+)?\/(https?:\/\/[^"']+)\1/gi, '$1$2$1');
}

function collectImages(html, baseUrl) {
  return [...html.matchAll(/<img\b([^>]*)>/gi)]
    .map((match) => ({
      url: normalizeUrl(attr(match[1], 'src') || attr(match[1], 'data-src') || '', baseUrl),
      alt: cleanText(attr(match[1], 'alt') || ''),
    }))
    .filter((image) => image.url && !image.url.startsWith('data:'));
}

function collectLinks(html, baseUrl) {
  return [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)]
    .map((match) => ({
      url: normalizeUrl(attr(match[1], 'href') || '', baseUrl),
      text: htmlToText(match[2]),
    }))
    .filter((link) => link.url);
}

function collectRelText(html, rel) {
  const values = [];
  const pattern = new RegExp(`<a\\b[^>]*(?:rel=["'][^"']*\\b${rel}\\b[^"']*["']|href=["'][^"']*/${rel}/[^"']*["'])[^>]*>([\\s\\S]*?)<\\/a>`, 'gi');
  for (const match of html.matchAll(pattern)) {
    const value = cleanText(match[1]);
    if (value && !values.includes(value)) {
      values.push(value);
    }
  }
  return values;
}

function compareSnapshots(a, b) {
  const aBeforeCutoff = a.timestamp <= SNAPSHOT_CUTOFF;
  const bBeforeCutoff = b.timestamp <= SNAPSHOT_CUTOFF;
  const aCanonical = isCanonicalPostUrl(a.original);
  const bCanonical = isCanonicalPostUrl(b.original);

  if (aBeforeCutoff !== bBeforeCutoff) {
    return aBeforeCutoff ? -1 : 1;
  }

  if (aCanonical !== bCanonical) {
    return aCanonical ? -1 : 1;
  }

  if (aBeforeCutoff && bBeforeCutoff) {
    return b.timestamp.localeCompare(a.timestamp);
  }

  return a.timestamp.localeCompare(b.timestamp);
}

function waybackUrl(snapshot, raw) {
  const marker = raw ? `${snapshot.timestamp}id_` : snapshot.timestamp;
  return `https://web.archive.org/web/${marker}/${snapshot.original}`;
}

function waybackAssetUrl(timestamp, url) {
  return `https://web.archive.org/web/${timestamp}id_/${url}`;
}

async function fetchText(url) {
  const response = await fetchWithRetry(url, { accept: 'text/html,application/xhtml+xml' });
  return response.text();
}

async function fetchWithRetry(url, { accept }) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20_000);
      const response = await fetch(url, {
        headers: { 'user-agent': USER_AGENT, accept },
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!response.ok) {
        throw new Error(`http_${response.status}`);
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await sleep(500 * attempt);
      }
    }
  }
  throw lastError;
}

async function ensureArchiveDirs() {
  await Promise.all([RAW_DIR, JSON_DIR, MD_DIR, ASSETS_DIR].map((dir) => mkdir(dir, { recursive: true })));
}

async function saveJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function parseArgs(argv) {
  const parsed = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      parsed._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}

function getPostId(url) {
  try {
    return Number(new URL(normalizeOriginalUrl(url)).searchParams.get('p')) || null;
  } catch {
    const match = url.match(/[?&]p=(\d+)/);
    return match ? Number(match[1]) : null;
  }
}

function canonicalPostUrl(postId) {
  return `https://blog.mozilla.com.tw/?p=${postId}`;
}

function isCanonicalPostUrl(url) {
  try {
    const parsed = new URL(url);
    const keys = [...parsed.searchParams.keys()];
    return keys.length === 1 && keys[0] === 'p';
  } catch {
    return /^[^?]+\?p=\d+$/.test(url);
  }
}

function normalizeOriginalUrl(url) {
  if (url.startsWith('http://') || url.startsWith('https://')) {
    return url.replace(/^http:\/\//, 'https://');
  }
  return `https://${url.replace(/^\/+/, '')}`;
}

function normalizeUrl(url, baseUrl) {
  if (!url) {
    return '';
  }
  const withoutWayback = url.replace(/^https?:\/\/web\.archive\.org\/web\/\d+(?:[a-z_]+)?\//i, '');
  try {
    return new URL(withoutWayback, baseUrl).href.replace(/^http:\/\//, 'https://');
  } catch {
    return url;
  }
}

function attr(attrs, name) {
  const match = attrs.match(new RegExp(`${name}=["']([^"']*)["']`, 'i'));
  return match ? decodeEntities(match[1]) : '';
}

function firstMatch(text, patterns) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      return match[0];
    }
  }
  return '';
}

function firstCapture(text, patterns) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      return match[2] ?? match[1] ?? '';
    }
  }
  return '';
}

function htmlToText(html) {
  return cleanText(html.replace(/<[^>]+>/g, ' '));
}

function cleanText(text) {
  return decodeEntities(String(text || '').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeEntities(text) {
  return String(text)
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([a-f0-9]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function parseDate(value) {
  const text = cleanText(value);
  const isoMatch = text.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    return isoMatch[0];
  }
  const slashMatch = text.match(/(\d{4})[/.](\d{1,2})[/.](\d{1,2})/);
  if (slashMatch) {
    return [slashMatch[1], slashMatch[2].padStart(2, '0'), slashMatch[3].padStart(2, '0')].join('-');
  }
  return '';
}

function parseDisplayedPostDate(html) {
  const monthText = cleanText(firstCapture(html, [/<[^>]*class=["'][^"']*\bposted-month\b[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i]));
  const dayText = cleanText(firstCapture(html, [/<[^>]*class=["'][^"']*\bposted-date\b[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i]));
  const yearText = cleanText(firstCapture(html, [/<[^>]*class=["'][^"']*\bposted-year\b[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i]));
  const month = parseMonth(monthText);
  const day = Number(dayText.match(/\d{1,2}/)?.[0]);
  const year = Number(yearText.match(/\d{4}/)?.[0]);

  if (!year || !month || !day) {
    return '';
  }

  return [String(year), String(month).padStart(2, '0'), String(day).padStart(2, '0')].join('-');
}

function parseMonth(text) {
  const numeric = text.match(/\d{1,2}/)?.[0];
  if (numeric) {
    return Number(numeric);
  }

  const zhMonths = {
    一月: 1,
    二月: 2,
    三月: 3,
    四月: 4,
    五月: 5,
    六月: 6,
    七月: 7,
    八月: 8,
    九月: 9,
    十月: 10,
    十一月: 11,
    十二月: 12,
  };
  return zhMonths[text] ?? null;
}

function dateParts(date) {
  const match = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return { year: null, month: null, day: null };
  }
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

function isErrorPage(text) {
  return /Wayback Machine doesn't have that page archived|Got an HTTP 3\d\d response|Page cannot be displayed|404 Not Found/i.test(text);
}

function looksLikeImage(buffer, contentType) {
  if (contentType.includes('svg')) {
    return buffer.toString('utf8', 0, Math.min(buffer.length, 300)).includes('<svg');
  }
  const hex = buffer.subarray(0, 12).toString('hex');
  return (
    hex.startsWith('ffd8ff') ||
    hex.startsWith('89504e470d0a1a0a') ||
    hex.startsWith('474946383761') ||
    hex.startsWith('474946383961') ||
    hex.startsWith('52494646') ||
    hex.startsWith('000000') ||
    contentType.startsWith('image/')
  );
}

function extensionFromUrlOrType(pathname, contentType) {
  const ext = path.extname(pathname).toLowerCase();
  if (/^\.[a-z0-9]{2,5}$/.test(ext)) {
    return ext;
  }
  const byType = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/svg+xml': '.svg',
  };
  return byType[contentType.split(';')[0].toLowerCase()] ?? '.img';
}

function yamlLine(key, value) {
  if (value === null || value === undefined || value === '') {
    return `${key}: null\n`;
  }
  if (typeof value === 'number') {
    return `${key}: ${value}\n`;
  }
  return `${key}: ${JSON.stringify(String(value))}\n`;
}

function yamlArray(key, values) {
  if (!values?.length) {
    return `${key}: []\n`;
  }
  return `${key}:\n${values.map((value) => `  - ${JSON.stringify(value)}`).join('\n')}\n`;
}

function csvRow(values) {
  return values.map((value) => `"${String(value ?? '').replace(/"/g, '""')}"`).join(',');
}

function summaryForManifest(result) {
  return {
    post_id: result.post_id,
    status: result.status,
    asset_status: result.asset_status,
    title: result.title,
    date: result.date,
    original_url: result.original_url,
    archive_url: result.archive_url,
    wayback_timestamp: result.wayback_timestamp,
    asset_errors: result.asset_errors,
    errors: result.errors,
  };
}

function randomDelay() {
  const min = Number(args.delayMin ?? args['delay-min'] ?? 1000);
  const max = Number(args.delayMax ?? args['delay-max'] ?? 3000);
  return Math.floor(min + Math.random() * Math.max(0, max - min));
}

function hasFlag(name) {
  const camelName = name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
  return Boolean(args[name] || args[camelName]);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function relative(filePath) {
  return path.relative(ROOT, filePath);
}
