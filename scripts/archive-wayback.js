#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { setDefaultResultOrder } from 'node:dns';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

setDefaultResultOrder('ipv4first');

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
const ASSET_MANIFEST_PATH = path.join(ARCHIVE_DIR, 'asset-manifest.json');
const RANGE_PROBE_PATH = path.join(DISCOVERY_DIR, 'range-probe-report.json');
const RANGE_SOURCE_PATH = path.join(DISCOVERY_DIR, 'month-id-ranges-with-listings.tsv');
const URLS_PATH = path.join(ROOT, 'urls.txt');
const URL_PROBE_PATH = path.join(DISCOVERY_DIR, 'url-probe-report.json');
const URL_IMPORT_PATH = path.join(DISCOVERY_DIR, 'url-import-report.json');
const URL_RETRY_IDS_PATH = path.join(DISCOVERY_DIR, 'urls-retry-post-ids.txt');
const TIMEMAP_PATH = path.join(ROOT, 'json.json');
const TIMEMAP_IMPORT_PATH = path.join(DISCOVERY_DIR, 'timemap-import-report.json');
const TIMEMAP_RETRY_IDS_PATH = path.join(DISCOVERY_DIR, 'timemap-retry-post-ids.txt');
const ARTICLE_MEDIA_REPORT_PATH = path.join(DISCOVERY_DIR, 'article-media-report.json');
const ARTICLE_MEDIA_MISSING_PATH = path.join(DISCOVERY_DIR, 'article-media-missing.json');
const ARTICLE_MEDIA_RECOVER_PATH = path.join(DISCOVERY_DIR, 'article-media-recover-report.json');

const POST_ID_MIN = 74;
const POST_ID_MAX = 9335;
const SNAPSHOT_CUTOFF = '20201231235959';
const MAX_SNAPSHOT_ATTEMPTS = 5;
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
const CATEGORY_COUNTS = {
  8: 354,
  11: 50,
  154: 3,
  10: 213,
  43: 10,
  12: 305,
  42: 57,
  149: 19,
  35: 165,
  16: 132,
  1: 10,
  44: 12,
  21: 98,
};
const CATEGORY_LISTING_TIMESTAMP = '20200805155022';
const MONTH_START = 201112;
const MONTH_END = 201610;
const ASSET_SNAPSHOT_CACHE = new Map();

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

  if (command === 'scan-urls') {
    const snapshots = await scanAllArchivedUrls();
    const existing = await scanOrReadCdx();
    const merged = mergeSnapshotMaps(existing, snapshots);
    await saveJson(CDX_PATH, sortSnapshotMap(merged));
    console.log(
      `Scanned all archived URLs; found ${Object.keys(snapshots).length} post groups; CDX count ${Object.keys(existing).length} -> ${Object.keys(merged).length}`
    );
    return;
  }

  if (command === 'import-urls') {
    const snapshots = await scanOrReadCdx();
    const result = await importUrlsFile(snapshots);
    console.log(
      `Imported ${result.urls_unique_post_ids} urls.txt ids; synthesized ${result.synthesized_count}; CDX count ${result.initial_cdx_count} -> ${result.final_cdx_count}; retry ids written to ${relative(URL_RETRY_IDS_PATH)}`
    );
    return;
  }

  if (command === 'import-timemap') {
    const snapshots = await scanOrReadCdx();
    const result = await importTimemapFile(snapshots);
    console.log(
      `Imported ${result.timemap_unique_post_ids} timemap post ids; synthesized ${result.synthesized_count}; CDX count ${result.initial_cdx_count} -> ${result.final_cdx_count}; retry ids written to ${relative(TIMEMAP_RETRY_IDS_PATH)}`
    );
    return;
  }

  if (command === 'discover-urls') {
    const snapshots = await scanOrReadCdx();
    const result = await discoverFromArchivedUrls(snapshots);
    console.log(
      `Discovered ${result.discovered_count} post ids from archived URL listings; synthesized ${result.synthesized_count}; CDX count ${result.initial_cdx_count} -> ${result.final_cdx_count}`
    );
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

  if (command === 'probe-ranges') {
    const snapshots = await scanOrReadCdx();
    const result = await probeMissingRanges(snapshots);
    console.log(
      `Probed ${result.probed_count} candidate ids; found ${result.found_count}; CDX count ${result.initial_cdx_count} -> ${result.final_cdx_count}; report written to ${relative(RANGE_PROBE_PATH)}`
    );
    return;
  }

  if (command === 'probe-urls') {
    const snapshots = await scanOrReadCdx();
    const result = await probeUrlsFile(snapshots);
    console.log(
      `Probed ${result.probed_count} urls.txt ids; found ${result.found_count}; CDX count ${result.initial_cdx_count} -> ${result.final_cdx_count}; report written to ${relative(URL_PROBE_PATH)}`
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

  if (command === 'assets') {
    const result = await fetchMissingAssets();
    console.log(
      `Retried ${result.total_missing_before} missing assets; localized ${result.localized_now}; remaining ${result.total_missing_after}; manifest written to ${relative(ASSET_MANIFEST_PATH)}`
    );
    return;
  }

  if (command === 'media-report') {
    const result = await writeArticleMediaReport();
    console.log(
      `Article media: ${result.summary.article_media_localized_refs}/${result.summary.article_media_refs} localized; missing ${result.summary.article_media_missing_refs}; report written to ${relative(ARTICLE_MEDIA_REPORT_PATH)}`
    );
    return;
  }

  if (command === 'media-recover') {
    const result = await recoverArticleMedia();
    console.log(
      `Recovered ${result.localized_now}/${result.total_missing_before} article media; remaining ${result.total_missing_after}; report written to ${relative(ARTICLE_MEDIA_RECOVER_PATH)}`
    );
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

function printHelp() {
  console.log(`Usage:
  npm run archive:scan
  npm run archive -- discover --sources tag --synthesize-cdx
  npm run archive:fetch -- --limit 10 --include-assets
  npm run archive -- assets --delay-min 500 --delay-max 1500
  npm run archive -- --start 74 --end 9335 --delay-min 1000 --delay-max 3000

Commands:
  scan   Query CDX and write archive/cdx-snapshots.json
  scan-urls
         Query all archived blog.mozilla.com.tw URLs and extract post ids
  import-urls
         Synthesize cdx-snapshots.json candidates from urls.txt
  import-timemap
         Synthesize cdx-snapshots.json candidates from json.json TimeMap groups
  discover-urls
         Fetch archived listing URLs from the full URL list and extract post ids
  discover
         Discover post ids from archived category/month listing pages
  probe-ranges
         Query individual post ids inferred from monthly missing ranges
  probe-urls
         Query post ids listed in urls.txt but missing from cdx-snapshots.json
  fetch  Read archive/cdx-snapshots.json and archive posts
  assets Retry only missing article image assets from archive/articles-json
  media-report
         Report media referenced inside each raw <article>
  media-recover
         Recover missing media referenced inside each raw <article>
  all    Scan if needed, then archive posts (default)

Options:
  --start <id>          First post id, default ${POST_ID_MIN}
  --end <id>            Last post id, default ${POST_ID_MAX}
  --limit <n>           Limit number of posts processed
  --checkpoint-every <n>
                       Write fetch checkpoint every n posts, default 25
  --ids-file <path>     Process only newline-delimited post ids from a file
  --include-assets      Download images referenced inside article content
  --include-srcset      Include srcset candidates in media-report/media-recover
  --only uploads        Limit media-recover to blog.mozilla.com.tw/wp-content/uploads
  --delay-min <ms>      Minimum request delay, default 1000
  --delay-max <ms>      Maximum request delay, default 3000
  --max-attempts <n>    Snapshot attempts per post, default ${MAX_SNAPSHOT_ATTEMPTS}
  --sources <list>      Listing sources for discover: cat,tag,month,home; default cat,tag,month
  --expected-category-pages
                       Also try category pages inferred from sidebar counts
  --probe-category-cdx Query CDX for each inferred category page before fetching it
  --synthesize-cdx      Add listing-page timestamp candidates for discovered ids
  --merge-cdx           For discovered missing ids, query CDX and merge found snapshots
  --range-source <path> Missing range TSV, default ${relative(RANGE_SOURCE_PATH)}
  --limit <n>           Also limits probe-ranges candidate ids
  --prefixes            Probe inferred ids by CDX prefix groups instead of one id at a time
  --prefix-length <n>   Prefix length for --prefixes, default 3
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

async function scanAllArchivedUrls() {
  const rows = await scanCdxRows('blog.mozilla.com.tw/', 'digest', { matchType: 'prefix' });
  const snapshots = {};

  for (const row of rows) {
    const postId = getPostId(row.original);
    if (!postId || postId < POST_ID_MIN || postId > POST_ID_MAX) {
      continue;
    }

    snapshots[postId] ??= [];
    snapshots[postId].push({
      timestamp: row.timestamp,
      original: normalizeOriginalUrl(row.original),
      statuscode: Number(row.statuscode),
      mimetype: row.mimetype,
      digest: row.digest,
      length: Number(row.length || 0),
    });
  }

  for (const postSnapshots of Object.values(snapshots)) {
    postSnapshots.sort(compareSnapshots);
  }

  return snapshots;
}

function mergeSnapshotMaps(base, extra) {
  const merged = { ...base };

  for (const [postId, postSnapshots] of Object.entries(extra)) {
    const seen = new Set((merged[postId] || []).map((snapshot) => `${snapshot.timestamp}:${snapshot.original}`));
    merged[postId] ??= [];

    for (const snapshot of postSnapshots) {
      const key = `${snapshot.timestamp}:${snapshot.original}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      merged[postId].push(snapshot);
    }
  }

  return merged;
}

async function discoverFromCategories(snapshots) {
  await mkdir(DISCOVERY_DIR, { recursive: true });

  const sources = discoverySources();
  const categoryPages = sources.includes('cat') ? await scanListingPages('cat') : [];
  const tagPages = sources.includes('tag') ? await scanListingPages('tag') : [];
  const monthPages = sources.includes('month') ? await scanListingPages('month') : [];
  const homePages = sources.includes('home') ? await scanListingPages('home') : [];
  const discovered = new Map();
  const listingPages = [...categoryPages, ...tagPages, ...monthPages, ...homePages];

  for (const [index, page] of listingPages.entries()) {
    try {
      const html = await fetchListingPage(page.snapshot);
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
  const initialCdxCount = Object.keys(snapshots).length;
  const missingBefore = discoveredRows.filter((row) => !snapshots[row.post_id]);
  const merged = [];
  const synthesized = [];

  if (hasFlag('synthesize-cdx')) {
    for (const row of missingBefore) {
      const postSnapshots = synthesizeSnapshotsFromSources(row);
      if (postSnapshots.length) {
        snapshots[row.post_id] = postSnapshots;
        synthesized.push({ post_id: row.post_id, snapshots: postSnapshots.length });
      }
    }
  }

  if (hasFlag('merge-cdx')) {
    const mergeTargets = discoveredRows.filter((row) => !snapshots[row.post_id]);
    for (const [index, row] of mergeTargets.entries()) {
      const postSnapshots = await scanPostSnapshots(row.post_id);
      if (postSnapshots.length) {
        snapshots[row.post_id] = postSnapshots;
        merged.push({ post_id: row.post_id, snapshots: postSnapshots.length });
      }
      console.log(`CDX merge ${index + 1}/${mergeTargets.length}: ${row.post_id}, snapshots=${postSnapshots.length}`);
      await sleep(randomDelay());
    }
  }

  if (hasFlag('synthesize-cdx') || hasFlag('merge-cdx')) {
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
      tag: tagPages.length,
      month: monthPages.length,
      home: homePages.length,
      total: listingPages.length,
    },
    discovered_count: discoveredRows.length,
    initial_cdx_count: initialCdxCount,
    final_cdx_count: Object.keys(snapshots).length,
    missing_before_count: missingBefore.length,
    synthesized_count: synthesized.length,
    merged_count: merged.length,
    missing_after_count: missingAfter.length,
    synthesized,
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

async function fetchListingPage(snapshot) {
  try {
    return await fetchText(waybackUrl(snapshot, true));
  } catch (error) {
    return fetchText(waybackUrl(snapshot, false));
  }
}

async function scanListingPages(kind) {
  const rows = await scanListingRows(kind);
  const pages = [];

  for (const row of rows) {
    const parsed = new URL(normalizeOriginalUrl(row.original));
    const key = listingKey(kind, parsed);

    if (kind === 'cat' && !CATEGORY_MAP[key]) {
      continue;
    }
    if (kind === 'month' && !isWantedMonth(key)) {
      continue;
    }

    pages.push({
      kind,
      key,
      name: listingName(kind, key),
      page: listingPageNumber(parsed),
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

  if (kind === 'cat' && hasFlag('expected-category-pages')) {
    pages.push(...await expectedCategoryPages());
  }

  return choosePreferredListingPages(pages);
}

async function scanListingRows(kind) {
  if (kind === 'cat') {
    return scanCdxRows('blog.mozilla.com.tw/%3Fcat=*', 'urlkey');
  }
  if (kind === 'month') {
    return scanCdxRows('blog.mozilla.com.tw/%3Fm=*', 'urlkey');
  }
  if (kind === 'tag') {
    const queryRows = await scanCdxRows('blog.mozilla.com.tw/%3Ftag=*', 'urlkey');
    const pathRows = await scanCdxRows('blog.mozilla.com.tw/tag/*', 'urlkey');
    return [...queryRows, ...pathRows];
  }
  if (kind === 'home') {
    return scanCdxRows('blog.mozilla.com.tw/%3Fpaged=*', 'urlkey');
  }
  throw new Error(`Unknown listing source: ${kind}`);
}

function discoverySources() {
  const rawSources = String(args.sources || 'cat,tag,month')
    .split(',')
    .map((source) => source.trim())
    .filter(Boolean);
  const allowed = new Set(['cat', 'tag', 'month', 'home']);
  const sources = rawSources.filter((source) => allowed.has(source));

  if (!sources.length) {
    throw new Error(`No valid discovery sources in: ${args.sources}`);
  }
  return [...new Set(sources)];
}

function listingKey(kind, parsed) {
  if (kind === 'cat') {
    return parsed.searchParams.get('cat');
  }
  if (kind === 'month') {
    return parsed.searchParams.get('m');
  }
  if (kind === 'tag') {
    return parsed.searchParams.get('tag') || parsed.pathname.match(/\/tag\/([^/]+)/)?.[1] || '';
  }
  if (kind === 'home') {
    return 'home';
  }
  return '';
}

function listingName(kind, key) {
  if (kind === 'cat') {
    return CATEGORY_MAP[key];
  }
  return key;
}

function listingPageNumber(parsed) {
  const queryPage = parsed.searchParams.get('paged');
  if (queryPage) {
    return queryPage;
  }
  return parsed.pathname.match(/\/page\/(\d+)\/?$/)?.[1] || '1';
}

async function expectedCategoryPages() {
  const pages = [];

  for (const [categoryId, count] of Object.entries(CATEGORY_COUNTS)) {
    const totalPages = Math.ceil(count / 10);
    for (let page = 1; page <= totalPages; page += 1) {
      const snapshot = hasFlag('probe-category-cdx')
        ? await scanCategoryPageSnapshot(categoryId, page)
        : null;

      pages.push({
        kind: 'cat',
        key: categoryId,
        name: CATEGORY_MAP[categoryId],
        page: String(page),
        snapshot: snapshot ?? {
          timestamp: CATEGORY_LISTING_TIMESTAMP,
          original: categoryPageUrl(categoryId, page),
          statuscode: 200,
          mimetype: 'text/html',
          digest: `expected-category:${categoryId}:${page}`,
          length: 0,
          inferred_from: 'sidebar_category_links_20200805155022',
        },
      });

      if (hasFlag('probe-category-cdx')) {
        await sleep(randomDelay());
      }
    }
  }

  return pages;
}

async function scanCategoryPageSnapshot(categoryId, page) {
  try {
    const pattern = categoryPageCdxPattern(categoryId, page);
    const rows = await scanCdxRows(pattern, 'digest');
    const snapshots = rows
      .map((row) => ({
        timestamp: row.timestamp,
        original: normalizeOriginalUrl(row.original),
        statuscode: Number(row.statuscode),
        mimetype: row.mimetype,
        digest: row.digest,
        length: Number(row.length || 0),
        discovered_from: 'category_page_cdx_probe',
      }))
      .filter((snapshot) => {
        const parsed = new URL(snapshot.original);
        return parsed.searchParams.get('cat') === String(categoryId) && listingPageNumber(parsed) === String(page);
      })
      .sort(compareSnapshots);

    return snapshots[0] ?? null;
  } catch (error) {
    console.warn(`CDX probe failed: cat ${categoryId} page ${page}: ${error.message}`);
    return null;
  }
}

function categoryPageCdxPattern(categoryId, page) {
  if (page === 1) {
    return `blog.mozilla.com.tw/%3Fcat=${categoryId}`;
  }
  return `blog.mozilla.com.tw/%3Fcat=${categoryId}%26paged=${page}`;
}

function categoryPageUrl(categoryId, page) {
  const url = new URL('https://blog.mozilla.com.tw/');
  url.searchParams.set('cat', categoryId);
  if (page > 1) {
    url.searchParams.set('paged', page);
  }
  return url.href;
}

async function scanCdxRows(urlPattern, collapse, options = {}) {
  const url = [
    'https://web.archive.org/cdx/search/cdx',
    `?url=${urlPattern}`,
    options.matchType ? `&matchType=${options.matchType}` : '',
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
  const rows = await scanCdxRows(`blog.mozilla.com.tw/%3Fp=${postId}`, 'digest');
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

async function probeMissingRanges(snapshots) {
  if (hasFlag('prefixes')) {
    return probeMissingRangePrefixes(snapshots);
  }

  const initialCdxCount = Object.keys(snapshots).length;
  const candidates = await missingRangeCandidates(snapshots);
  const limit = args.limit ? Number(args.limit) : Infinity;
  const selected = candidates.slice(0, limit);
  const found = [];
  const misses = [];
  const errors = [];

  for (const [index, candidate] of selected.entries()) {
    try {
      const postSnapshots = await scanPostSnapshots(candidate.post_id);
      if (postSnapshots.length) {
        snapshots[candidate.post_id] = postSnapshots;
        found.push({ ...candidate, snapshots: postSnapshots.length });
      } else {
        misses.push(candidate);
      }

      console.log(
        `Range probe ${index + 1}/${selected.length}: ${candidate.post_id} ${candidate.month}, snapshots=${postSnapshots.length}`
      );
    } catch (error) {
      errors.push({ ...candidate, reason: error.message });
      console.warn(`Range probe failed ${candidate.post_id} ${candidate.month}: ${error.message}`);
    }

    if ((index + 1) % 25 === 0) {
      await saveRangeProbeCheckpoint({ snapshots, candidates, selected, found, misses, errors, initialCdxCount });
    }

    await sleep(randomDelay());
  }

  await saveRangeProbeCheckpoint({ snapshots, candidates, selected, found, misses, errors, initialCdxCount });
  return JSON.parse(await readFile(RANGE_PROBE_PATH, 'utf8'));
}

async function probeUrlsFile(snapshots) {
  const initialCdxCount = Object.keys(snapshots).length;
  const allIds = await postIdsFromUrlsFile();
  const candidates = allIds.filter((postId) => !snapshots[postId]);
  const limit = args.limit ? Number(args.limit) : Infinity;
  const selected = candidates.slice(0, limit);
  const found = [];
  const misses = [];
  const errors = [];

  for (const [index, postId] of selected.entries()) {
    try {
      const postSnapshots = await scanPostSnapshots(postId);
      if (postSnapshots.length) {
        snapshots[postId] = postSnapshots;
        found.push({ post_id: postId, snapshots: postSnapshots.length });
      } else {
        misses.push({ post_id: postId });
      }
      console.log(`URL probe ${index + 1}/${selected.length}: ${postId}, snapshots=${postSnapshots.length}`);
    } catch (error) {
      errors.push({ post_id: postId, reason: error.message });
      console.warn(`URL probe failed ${postId}: ${error.message}`);
    }

    if ((index + 1) % 25 === 0) {
      await saveUrlProbeCheckpoint({ snapshots, allIds, selected, found, misses, errors, initialCdxCount });
    }

    await sleep(randomDelay());
  }

  await saveUrlProbeCheckpoint({ snapshots, allIds, selected, found, misses, errors, initialCdxCount });
  return JSON.parse(await readFile(URL_PROBE_PATH, 'utf8'));
}

async function importUrlsFile(snapshots) {
  await mkdir(DISCOVERY_DIR, { recursive: true });

  const initialCdxCount = Object.keys(snapshots).length;
  const urlRows = await urlsFileRows();
  const allIds = [...new Set(urlRows.map((row) => row.post_id))].sort((a, b) => a - b);
  const manifest = await readManifestIfExists();
  const failedIds = new Set(manifest?.posts?.filter((post) => post.status !== 'ok').map((post) => post.post_id) ?? []);
  const archivedIds = await readArchivedArticleIds();
  const synthesized = [];

  for (const postId of allIds) {
    if (snapshots[postId]) {
      continue;
    }

    const postSnapshots = synthesizeSnapshotsFromUrls(postId, urlRows.filter((row) => row.post_id === postId));
    if (!postSnapshots.length) {
      continue;
    }

    snapshots[postId] = postSnapshots;
    synthesized.push({ post_id: postId, snapshots: postSnapshots.length });
  }

  const retryIds = allIds
    .filter((postId) => !archivedIds.has(postId))
    .sort((a, b) => a - b);
  const existingFailedRetryIds = retryIds.filter((postId) => failedIds.has(postId));
  const newRetryIds = retryIds.filter((postId) => !failedIds.has(postId));
  const sortedSnapshots = sortSnapshotMap(snapshots);
  const result = {
    generated_at: new Date().toISOString(),
    source: relative(URLS_PATH),
    lines: urlRows.length,
    urls_unique_post_ids: allIds.length,
    initial_cdx_count: initialCdxCount,
    final_cdx_count: Object.keys(sortedSnapshots).length,
    synthesized_count: synthesized.length,
    retry_count: retryIds.length,
    retry_existing_failed_count: existingFailedRetryIds.length,
    retry_new_count: newRetryIds.length,
    synthesized,
  };

  await saveJson(CDX_PATH, sortedSnapshots);
  await saveJson(URL_IMPORT_PATH, result);
  await writeFile(URL_RETRY_IDS_PATH, retryIds.join('\n') + (retryIds.length ? '\n' : ''), 'utf8');
  return result;
}

async function importTimemapFile(snapshots) {
  await mkdir(DISCOVERY_DIR, { recursive: true });

  const initialCdxCount = Object.keys(snapshots).length;
  const timemapRows = await readTimemapRows();
  const postRows = timemapRows
    .map((row) => ({ ...row, post_id: getPostId(row.original) }))
    .filter((row) => row.post_id && row.post_id >= POST_ID_MIN && row.post_id <= POST_ID_MAX);
  const allIds = [...new Set(postRows.map((row) => row.post_id))].sort((a, b) => a - b);
  const archivedIds = await readArchivedArticleIds();
  const synthesized = [];

  for (const postId of allIds) {
    const postSnapshots = synthesizeSnapshotsFromTimemap(postId, postRows.filter((row) => row.post_id === postId));
    if (!postSnapshots.length) {
      continue;
    }

    const before = snapshots[postId]?.length ?? 0;
    snapshots[postId] = mergeSnapshotList(snapshots[postId] || [], postSnapshots);
    const added = snapshots[postId].length - before;

    if (added) {
      synthesized.push({ post_id: postId, snapshots: added });
    }
  }

  const retryIds = allIds
    .filter((postId) => !archivedIds.has(postId))
    .sort((a, b) => a - b);
  const sortedSnapshots = sortSnapshotMap(snapshots);
  const result = {
    generated_at: new Date().toISOString(),
    source: relative(TIMEMAP_PATH),
    rows: timemapRows.length,
    columns: timemapRows.columns,
    url_types: timemapUrlTypeCounts(timemapRows),
    timemap_unique_post_ids: allIds.length,
    initial_cdx_count: initialCdxCount,
    final_cdx_count: Object.keys(sortedSnapshots).length,
    synthesized_count: synthesized.length,
    retry_count: retryIds.length,
    synthesized,
  };

  await saveJson(CDX_PATH, sortedSnapshots);
  await saveJson(TIMEMAP_IMPORT_PATH, result);
  await writeFile(TIMEMAP_RETRY_IDS_PATH, retryIds.join('\n') + (retryIds.length ? '\n' : ''), 'utf8');
  return result;
}

async function readManifestIfExists() {
  try {
    return JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
  } catch {
    return null;
  }
}

async function readArchivedArticleIds() {
  try {
    return new Set((await readdir(JSON_DIR))
      .filter((file) => file.endsWith('.json'))
      .map((file) => Number.parseInt(file, 10))
      .filter(Number.isFinite));
  } catch {
    return new Set();
  }
}

async function readTimemapRows() {
  const rows = JSON.parse(await readFile(TIMEMAP_PATH, 'utf8'));
  const header = rows[0] ?? [];
  const dataRows = rows.slice(1).map((row) => Object.fromEntries(header.map((key, index) => [key, row[index]])));
  dataRows.columns = header;
  return dataRows;
}

async function urlsFileRows() {
  const text = await readFile(URLS_PATH, 'utf8');
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((url, index) => ({ url, index, post_id: getPostId(url) }))
    .filter((row) => row.post_id && row.post_id >= POST_ID_MIN && row.post_id <= POST_ID_MAX);
}

function synthesizeSnapshotsFromTimemap(postId, rows) {
  const snapshots = [];
  const seen = new Set();

  for (const row of rows) {
    const original = normalizeOriginalUrl(row.original);

    for (const timestamp of preferredTimemapTimestamps(row)) {
      const key = `timemap:${postId}:${timestamp}:${original}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      snapshots.push({
        timestamp,
        original: canonicalPostUrl(postId),
        statuscode: 200,
        mimetype: row.mimetype || 'text/html',
        digest: key,
        length: 0,
        discovered_from: {
          kind: 'timemap',
          source_original: original,
          first_timestamp: row.timestamp,
          last_timestamp: row.endtimestamp,
          groupcount: Number(row.groupcount || 0),
          uniqcount: Number(row.uniqcount || 0),
        },
      });
    }
  }

  return snapshots.sort(compareSnapshots);
}

function mergeSnapshotList(existing, extra) {
  const merged = [...existing];
  const seen = new Set(merged.map((snapshot) => `${snapshot.timestamp}:${snapshot.original}`));

  for (const snapshot of extra) {
    const key = `${snapshot.timestamp}:${snapshot.original}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(snapshot);
  }

  return merged.sort(compareSnapshots);
}

function synthesizeSnapshotsFromUrls(postId, rows) {
  const snapshots = [];
  const seen = new Set();

  for (const row of rows) {
    const key = `urls.txt:${postId}:${row.url}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    snapshots.push({
      timestamp: SNAPSHOT_CUTOFF,
      original: canonicalPostUrl(postId),
      statuscode: 200,
      mimetype: 'text/html',
      digest: key,
      length: 0,
      discovered_from: {
        kind: 'urls.txt',
        line: row.index + 1,
        url: row.url,
      },
    });
  }

  return snapshots.sort(compareSnapshots);
}

function preferredTimemapTimestamps(row) {
  const timestamps = [];

  if (row.endtimestamp && row.endtimestamp <= SNAPSHOT_CUTOFF) {
    timestamps.push(row.endtimestamp);
  }
  if (row.timestamp && row.timestamp <= SNAPSHOT_CUTOFF) {
    timestamps.push(row.timestamp);
  }

  return [...new Set(timestamps.length ? timestamps : [SNAPSHOT_CUTOFF])].sort((a, b) => b.localeCompare(a));
}

function timemapUrlTypeCounts(rows) {
  const counts = {
    post: 0,
    category: 0,
    month: 0,
    paged: 0,
    tag: 0,
    feed: 0,
    upload: 0,
    other: 0,
  };

  for (const row of rows) {
    const kind = classifyTimemapUrl(row.original);
    counts[kind] = (counts[kind] ?? 0) + 1;
  }

  return counts;
}

function classifyTimemapUrl(url) {
  try {
    const parsed = new URL(normalizeOriginalUrl(url));
    if (parsed.searchParams.has('p')) return 'post';
    if (parsed.searchParams.has('cat')) return 'category';
    if (parsed.searchParams.has('m')) return 'month';
    if (parsed.searchParams.has('paged')) return 'paged';
    if (parsed.pathname.includes('/tag/')) return 'tag';
    if (parsed.pathname.includes('feed')) return 'feed';
    if (parsed.pathname.includes('/wp-content/uploads/')) return 'upload';
  } catch {
    return 'other';
  }
  return 'other';
}

async function postIdsFromUrlsFile() {
  const text = await readFile(URLS_PATH, 'utf8');
  const ids = text
    .split(/\r?\n/)
    .map((line) => getPostId(line.trim()))
    .filter(Boolean);
  return [...new Set(ids)].sort((a, b) => a - b);
}

async function saveUrlProbeCheckpoint({ snapshots, allIds, selected, found, misses, errors, initialCdxCount }) {
  const sortedSnapshots = sortSnapshotMap(snapshots);
  await saveJson(CDX_PATH, sortedSnapshots);
  await saveJson(URL_PROBE_PATH, {
    generated_at: new Date().toISOString(),
    source: relative(URLS_PATH),
    initial_cdx_count: initialCdxCount,
    final_cdx_count: Object.keys(sortedSnapshots).length,
    urls_unique_post_ids: allIds.length,
    selected_count: selected.length,
    probed_count: found.length + misses.length + errors.length,
    found_count: found.length,
    miss_count: misses.length,
    error_count: errors.length,
    found,
    errors,
  });
}

async function probeMissingRangePrefixes(snapshots) {
  const initialCdxCount = Object.keys(snapshots).length;
  const candidates = await missingRangeCandidates(snapshots);
  const prefixLength = Number(args.prefixLength || args['prefix-length'] || 3);
  const limit = args.limit ? Number(args.limit) : Infinity;
  const groups = prefixCandidateGroups(candidates, prefixLength).slice(0, limit);
  const found = [];
  const errors = [];

  for (const [index, group] of groups.entries()) {
    try {
      const rows = await scanCdxRows(`blog.mozilla.com.tw/%3Fp=${group.prefix}*`, 'digest');
      const grouped = new Map();

      for (const row of rows) {
        const postId = getPostId(row.original);
        if (!group.ids.has(postId) || snapshots[postId]) {
          continue;
        }
        grouped.set(postId, [
          ...(grouped.get(postId) || []),
          {
            timestamp: row.timestamp,
            original: normalizeOriginalUrl(row.original),
            statuscode: Number(row.statuscode),
            mimetype: row.mimetype,
            digest: row.digest,
            length: Number(row.length || 0),
          },
        ]);
      }

      for (const [postId, postSnapshots] of grouped.entries()) {
        snapshots[postId] = postSnapshots.sort(compareSnapshots);
        found.push({ post_id: postId, prefix: group.prefix, snapshots: postSnapshots.length });
      }

      console.log(
        `Prefix probe ${index + 1}/${groups.length}: ${group.prefix}*, candidates=${group.ids.size}, found=${grouped.size}`
      );
    } catch (error) {
      errors.push({ prefix: group.prefix, candidates: group.ids.size, reason: error.message });
      console.warn(`Prefix probe failed ${group.prefix}*: ${error.message}`);
    }

    if ((index + 1) % 10 === 0) {
      await saveRangePrefixCheckpoint({ snapshots, candidates, groups, found, errors, initialCdxCount });
    }

    await sleep(randomDelay());
  }

  await saveRangePrefixCheckpoint({ snapshots, candidates, groups, found, errors, initialCdxCount });
  return JSON.parse(await readFile(RANGE_PROBE_PATH, 'utf8'));
}

function prefixCandidateGroups(candidates, prefixLength) {
  const groups = new Map();

  for (const candidate of candidates) {
    const prefix = String(candidate.post_id).slice(0, prefixLength);
    const group = groups.get(prefix) ?? {
      prefix,
      ids: new Set(),
      density: candidate.density,
      missing: candidate.missing,
      range_span: candidate.range_span,
    };
    group.ids.add(candidate.post_id);
    group.density = Math.max(group.density, candidate.density);
    group.missing = Math.max(group.missing, candidate.missing);
    group.range_span = Math.min(group.range_span, candidate.range_span);
    groups.set(prefix, group);
  }

  return [...groups.values()].sort((a, b) =>
    b.density - a.density ||
    b.missing - a.missing ||
    a.range_span - b.range_span ||
    a.prefix.localeCompare(b.prefix)
  );
}

async function saveRangePrefixCheckpoint({ snapshots, candidates, groups, found, errors, initialCdxCount }) {
  const sortedSnapshots = sortSnapshotMap(snapshots);
  await saveJson(CDX_PATH, sortedSnapshots);
  await saveJson(RANGE_PROBE_PATH, {
    generated_at: new Date().toISOString(),
    mode: 'prefixes',
    source: relative(rangeSourcePath()),
    initial_cdx_count: initialCdxCount,
    final_cdx_count: Object.keys(sortedSnapshots).length,
    total_candidate_count: candidates.length,
    selected_prefix_count: groups.length,
    probed_prefix_count: groups.length,
    found_count: found.length,
    error_count: errors.length,
    found,
    errors,
  });
}

async function saveRangeProbeCheckpoint({ snapshots, candidates, selected, found, misses, errors, initialCdxCount }) {
  const sortedSnapshots = sortSnapshotMap(snapshots);
  await saveJson(CDX_PATH, sortedSnapshots);
  await saveJson(RANGE_PROBE_PATH, {
    generated_at: new Date().toISOString(),
    source: relative(rangeSourcePath()),
    initial_cdx_count: initialCdxCount,
    final_cdx_count: Object.keys(sortedSnapshots).length,
    total_candidate_count: candidates.length,
    selected_count: selected.length,
    probed_count: found.length + misses.length + errors.length,
    found_count: found.length,
    miss_count: misses.length,
    error_count: errors.length,
    found,
    errors,
  });
}

async function missingRangeCandidates(snapshots) {
  const rows = parseTsv(await readFile(rangeSourcePath(), 'utf8'))
    .map((row) => ({
      month: row.month,
      missing: Number(row.missing),
      start: Number(row.candidate_start),
      end: Number(row.candidate_end),
    }))
    .filter((row) => row.start && row.end && row.start <= row.end);
  const candidates = [];

  for (const row of rows) {
    const span = row.end - row.start + 1;
    const density = row.missing / span;
    for (let postId = row.start; postId <= row.end; postId += 1) {
      if (snapshots[postId]) {
        continue;
      }
      candidates.push({
        post_id: postId,
        month: row.month,
        missing: row.missing,
        range_start: row.start,
        range_end: row.end,
        range_span: span,
        density,
      });
    }
  }

  return candidates.sort((a, b) =>
    b.density - a.density ||
    b.missing - a.missing ||
    a.range_span - b.range_span ||
    a.post_id - b.post_id
  );
}

function rangeSourcePath() {
  return path.resolve(ROOT, args.rangeSource || args['range-source'] || RANGE_SOURCE_PATH);
}

function parseTsv(text) {
  const [headerLine, ...lines] = text.trim().split(/\r?\n/);
  const headers = headerLine.split('\t');
  return lines
    .filter(Boolean)
    .map((line) => Object.fromEntries(line.split('\t').map((value, index) => [headers[index], value])));
}

function discoverPostIdsFromHtml(html) {
  return [...new Set(collectLinks(html, 'https://blog.mozilla.com.tw/')
    .map((link) => getPostId(link.url))
    .filter((postId) => postId && postId >= POST_ID_MIN && postId <= POST_ID_MAX))]
    .sort((a, b) => a - b);
}

function synthesizeSnapshotsFromSources(row) {
  const snapshots = [];
  const seen = new Set();

  for (const source of row.sources) {
    const key = `${source.timestamp}:${source.kind}:${source.key}:${source.page}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    snapshots.push({
      timestamp: source.timestamp,
      original: canonicalPostUrl(row.post_id),
      statuscode: 200,
      mimetype: 'text/html',
      digest: `listing:${source.kind}:${source.key}:${source.page}:${source.timestamp}`,
      length: 0,
      discovered_from: source,
    });
  }

  return snapshots.sort(compareSnapshots);
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
  const selectedIds = await readIdsFile();
  const ids = (selectedIds ?? Object.keys(snapshots).map(Number))
    .filter((id) => snapshots[id])
    .filter((id) => selectedIds || (id >= start && id <= end))
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

    if ((index + 1) % Number(args.checkpointEvery || args['checkpoint-every'] || 25) === 0) {
      await saveJson(MANIFEST_PATH, manifest);
      await writeIndex(articles);
      console.log(`Checkpoint: ${index + 1}/${ids.length}`);
    }

    console.log(
      `Fetched ${index + 1}/${ids.length}: ${postId} ${result.status} ${result.asset_status || ''} media=${result.media?.length ?? result.images?.length ?? 0}`
    );

    await sleep(randomDelay());
  }

  return { articles, manifest };
}

async function readIdsFile() {
  const idsFile = args.idsFile ?? args['ids-file'];
  if (!idsFile) {
    return null;
  }

  const text = await readFile(path.resolve(ROOT, idsFile), 'utf8');
  return [...new Set(text
    .split(/\r?\n/)
    .map((line) => Number(line.trim()))
    .filter((id) => Number.isInteger(id) && id >= POST_ID_MIN && id <= POST_ID_MAX))];
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

      const rawPath = path.join(RAW_DIR, `${postId}-${snapshot.timestamp}.html`);
      await writeFile(rawPath, html, 'utf8');

      const cleanedHtml = cleanWaybackHtml(html);
      const parsed = parseArticle(cleanedHtml, snapshot.original);
      const validation = validateParsed(parsed);

      if (!validation.ok) {
        errors.push({ timestamp: snapshot.timestamp, stage: 'validate', reason: validation.reason });
        continue;
      }

      const assetResult = hasFlag('include-assets')
        ? await archiveAssets(postId, parsed.media, snapshot.timestamp)
        : { images: parsed.media, asset_status: 'skipped', asset_errors: [] };

      const article = {
        ...baseArticle(postId),
        title: parsed.title,
        date: parsed.date,
        ...dateParts(parsed.date),
        categories: parsed.categories,
        tags: parsed.tags,
        author: parsed.author,
        page_type: parsed.pageType,
        original_url: canonicalPostUrl(postId),
        archive_url: archiveUrl,
        wayback_timestamp: snapshot.timestamp,
        content_html: parsed.contentHtml,
        content_text: parsed.contentText,
        images: assetResult.images,
        media: assetResult.images,
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
    page_type: '',
    original_url: `https://blog.mozilla.com.tw/?p=${postId}`,
    archive_url: '',
    wayback_timestamp: '',
    content_html: '',
    content_text: '',
    images: [],
    media: [],
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
  const articleClass = attr(firstCapture(articleHtml, [/<article\b([^>]*)>/i]), 'class');
  const bodyClass = attr(firstCapture(html, [/<body\b([^>]*)>/i]), 'class');
  const pageType = /\b(?:attachment|type-attachment|single-attachment)\b/i.test(`${bodyClass} ${articleClass}`)
    ? 'attachment'
    : 'post';
  const contentHtml = extractEntryContent(articleHtml) || articleHtml || '';
  const title = cleanText(
    firstCapture(articleHtml, [
      /<h1\b[^>]*>([\s\S]*?)<\/h1>/i,
      /<h2\b[^>]*class=["'][^"']*\bentry-title\b[^"']*["'][^>]*>([\s\S]*?)<\/h2>/i,
    ]) ||
      firstCapture(html, [/<title\b[^>]*>([\s\S]*?)<\/title>/i])
  ).replace(/\s*[|｜-]\s*Mozilla Taiwan.*$/i, '');

  const date =
    parseDisplayedPostDate(`${html}\n${articleHtml}`) ||
    parseLegacyPublishedDate(html) ||
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
  const media = collectMedia(html, originalUrl);
  const links = collectLinks(contentHtml, originalUrl);
  const contentText = htmlToText(contentHtml);

  return { title, date, categories, tags, author, articleClass, pageType, contentHtml, contentText, images, media, links };
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
      const { buffer, contentType, snapshot } = await fetchAssetBuffer(timestamp, image.url);

      const assetPath = chooseAssetPath(postId, image.url, index, buffer, contentType, usedPaths);
      usedPaths.add(assetPath);
      await mkdir(path.dirname(assetPath), { recursive: true });
      await writeFile(assetPath, buffer);

      archivedImages.push({
        ...image,
        archive_path: path.relative(ARCHIVE_DIR, assetPath),
        markdown_path: `../assets/${path.relative(ASSETS_DIR, assetPath).split(path.sep).join('/')}`,
        wayback_timestamp: snapshot.timestamp,
        asset_archive_url: waybackAssetUrl(snapshot.timestamp, snapshot.original),
        content_type: contentType,
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

async function fetchAssetBuffer(pageTimestamp, originalUrl) {
  const attempts = [
    { timestamp: pageTimestamp, original: originalUrl },
    ...await scanAssetSnapshots(originalUrl, pageTimestamp),
    { timestamp: '', original: originalUrl, timegate: true },
  ];
  const errors = [];

  for (const snapshot of attempts) {
    try {
      const response = await fetchWithRetry(assetSnapshotUrl(snapshot), { accept: '*/*' });
      const contentType = response.headers.get('content-type') || '';

      if (contentType.toLowerCase().startsWith('text/html')) {
        throw new Error(`content_type_html:${contentType || 'missing'}`);
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length === 0) {
        throw new Error('empty_asset');
      }

      return { buffer, contentType, snapshot: snapshotFromWaybackResponse(response.url) || snapshot };
    } catch (error) {
      errors.push(`${snapshot.timestamp}:${error.message}`);
    }
  }

  throw new Error(errors.join(' | '));
}

function assetSnapshotUrl(snapshot) {
  return snapshot.timegate
    ? `https://web.archive.org/web/${snapshot.original}`
    : waybackAssetUrl(snapshot.timestamp, snapshot.original);
}

function snapshotFromWaybackResponse(url) {
  const match = url.match(/^https:\/\/web\.archive\.org\/web\/(\d+)(?:[a-z_]+)?\/(https?:\/\/.+)$/);
  return match ? { timestamp: match[1], original: match[2] } : null;
}

async function scanAssetSnapshots(originalUrl, pageTimestamp) {
  if (ASSET_SNAPSHOT_CACHE.has(originalUrl)) {
    return ASSET_SNAPSHOT_CACHE.get(originalUrl);
  }

  const parsed = new URL(originalUrl);
  const pattern = `${parsed.hostname}${parsed.pathname}${parsed.search}`;
  const query = new URLSearchParams({
    url: pattern,
    output: 'json',
    fl: 'timestamp,original,statuscode,mimetype,digest,length',
  });
  query.append('filter', 'statuscode:200');
  query.append('collapse', 'digest');

  try {
    const response = await fetchWithRetry(`https://web.archive.org/cdx/search/cdx?${query}`, { accept: 'application/json' });
    const rows = await response.json();
    const header = rows[0] ?? [];
    const snapshots = rows
      .slice(1)
      .map((row) => Object.fromEntries(header.map((key, index) => [key, row[index]])))
      .map((row) => ({
        timestamp: row.timestamp,
        original: row.original.startsWith('http') ? row.original : normalizeOriginalUrl(row.original),
        statuscode: Number(row.statuscode),
        mimetype: row.mimetype,
        digest: row.digest,
        length: Number(row.length || 0),
      }))
      .sort((a, b) => compareAssetSnapshots(a, b, pageTimestamp));
    ASSET_SNAPSHOT_CACHE.set(originalUrl, snapshots);
    return snapshots;
  } catch {
    ASSET_SNAPSHOT_CACHE.set(originalUrl, []);
    return [];
  }
}

function compareAssetSnapshots(a, b, pageTimestamp) {
  const aBefore = a.timestamp <= pageTimestamp;
  const bBefore = b.timestamp <= pageTimestamp;

  if (aBefore !== bBefore) {
    return aBefore ? -1 : 1;
  }
  if (aBefore && bBefore) {
    return b.timestamp.localeCompare(a.timestamp);
  }
  return a.timestamp.localeCompare(b.timestamp);
}

async function fetchMissingAssets() {
  const articles = await readArchivedArticles();
  const result = {
    generated_at: new Date().toISOString(),
    articles_total: articles.length,
    articles_with_missing_before: 0,
    articles_with_missing_after: 0,
    total_images: 0,
    total_localized_before: 0,
    total_missing_before: 0,
    total_localized_after: 0,
    total_missing_after: 0,
    localized_now: 0,
    asset_errors: [],
    articles: [],
  };

  for (const [index, article] of articles.entries()) {
    const before = assetStats(article);
    result.total_images += before.total;
    result.total_localized_before += before.localized;
    result.total_missing_before += before.missing;

    if (!before.missing) {
      result.total_localized_after += before.localized;
      result.total_missing_after += before.missing;
      continue;
    }

    result.articles_with_missing_before += 1;
    const updated = await retryArticleAssets(article);
    const after = assetStats(updated);
    result.total_localized_after += after.localized;
    result.total_missing_after += after.missing;
    result.localized_now += after.localized - before.localized;
    result.asset_errors.push(...(updated.asset_errors || []).map((error) => ({ post_id: updated.post_id, ...error })));
    result.articles.push({
      post_id: updated.post_id,
      title: updated.title,
      before,
      after,
      asset_status: updated.asset_status,
      asset_errors: updated.asset_errors || [],
    });

    if (after.missing) {
      result.articles_with_missing_after += 1;
    }

    await writeArticle(updated);

    if ((index + 1) % 25 === 0) {
      await saveJson(ASSET_MANIFEST_PATH, result);
      console.log(`Asset checkpoint: ${index + 1}/${articles.length}`);
    }
  }

  await saveJson(ASSET_MANIFEST_PATH, result);
  return result;
}

async function writeArticleMediaReport() {
  const result = await articleMediaReport();
  await saveJson(ARTICLE_MEDIA_REPORT_PATH, result);
  await saveJson(ARTICLE_MEDIA_MISSING_PATH, result.missing);
  return result;
}

async function recoverArticleMedia() {
  const report = await articleMediaReport();
  const only = String(args.only || '').trim();
  const kind = String(args.kind || '').trim();
  const limit = args.limit ? Number(args.limit) : Infinity;
  const candidates = report.missing
    .filter((item) => !only || (only === 'uploads' && isUploadsUrl(item.url)))
    .filter((item) => !kind || item.kind === kind)
    .slice(0, limit);
  const byPost = new Map();
  const result = {
    generated_at: new Date().toISOString(),
    source_report: relative(ARTICLE_MEDIA_REPORT_PATH),
    include_srcset: hasFlag('include-srcset'),
    only: only || null,
    kind: kind || null,
    total_missing_before: candidates.length,
    localized_now: 0,
    total_missing_after: 0,
    recovered: [],
    failed: [],
  };

  for (const item of candidates) {
    const article = byPost.get(item.post_id) ?? JSON.parse(await readFile(path.join(JSON_DIR, `${item.post_id}.json`), 'utf8'));
    byPost.set(item.post_id, article);

    try {
      const usedPaths = new Set((article.media || article.images || [])
        .map((media) => media.archive_path)
        .filter(Boolean)
        .map((archivePath) => path.join(ARCHIVE_DIR, archivePath)));
      const recovered = await recoverOneMedia(article, item, usedPaths);
      mergeRecoveredMedia(article, recovered);
      result.localized_now += 1;
      result.recovered.push({
        post_id: item.post_id,
        url: item.url,
        archive_path: recovered.archive_path,
        wayback_timestamp: recovered.wayback_timestamp,
      });
    } catch (error) {
      result.failed.push({ ...item, reason: error.message });
      console.warn(`Media recover failed ${item.post_id}: ${item.url}: ${error.message}`);
    }

    if ((result.recovered.length + result.failed.length) % Number(args.checkpointEvery || args['checkpoint-every'] || 25) === 0) {
      await writeRecoveredArticles(byPost);
      await saveJson(ARTICLE_MEDIA_RECOVER_PATH, result);
      console.log(`Media recover checkpoint: ${result.recovered.length + result.failed.length}/${candidates.length}`);
    }

    await sleep(randomDelay());
  }

  await writeRecoveredArticles(byPost);
  const after = await articleMediaReport();
  result.total_missing_after = only
    ? after.missing.filter((item) => only === 'uploads' && isUploadsUrl(item.url)).length
    : after.summary.article_media_missing_refs;
  await saveJson(ARTICLE_MEDIA_REPORT_PATH, after);
  await saveJson(ARTICLE_MEDIA_MISSING_PATH, after.missing);
  await saveJson(ARTICLE_MEDIA_RECOVER_PATH, result);
  return result;
}

async function writeRecoveredArticles(byPost) {
  for (const article of byPost.values()) {
    const missing = (article.media || []).filter((media) => !media.archive_path);
    article.asset_status = missing.length ? 'partial_assets_failed' : 'ok';
    article.asset_errors = missing.map((media) => ({ url: media.url, reason: 'article_media_missing' }));
    await writeArticle(article);
  }
}

async function recoverOneMedia(article, item, usedPaths) {
  const attempts = mediaUrlRecoveryCandidates(item.url);
  const errors = [];

  for (const url of attempts) {
    try {
      const { buffer, contentType, snapshot } = await fetchAssetBuffer(article.wayback_timestamp, url);
      const assetPath = chooseAssetPath(article.post_id, url, item.index, buffer, contentType, usedPaths);
      usedPaths.add(assetPath);
      await mkdir(path.dirname(assetPath), { recursive: true });
      await writeFile(assetPath, buffer);
      return {
        ...item,
        url: item.url,
        recovered_url: url,
        archive_path: path.relative(ARCHIVE_DIR, assetPath),
        markdown_path: `../assets/${path.relative(ASSETS_DIR, assetPath).split(path.sep).join('/')}`,
        wayback_timestamp: snapshot.timestamp,
        asset_archive_url: waybackAssetUrl(snapshot.timestamp, snapshot.original),
        content_type: contentType,
      };
    } catch (error) {
      errors.push(`${url}: ${error.message}`);
    }
  }

  throw new Error(errors.join(' | '));
}

function mergeRecoveredMedia(article, recovered) {
  const media = article.media?.length ? article.media : article.images || [];
  const existing = media.find((item) => item.url === recovered.url);
  if (existing) {
    Object.assign(existing, recovered);
  } else {
    media.push(recovered);
  }
  article.media = media;
  article.images = media;
}

function mediaUrlRecoveryCandidates(url) {
  const candidates = [url];
  const original = originalSizeMediaUrl(url);
  if (original && original !== url) {
    candidates.push(original);
  }
  try {
    const parsed = new URL(url);
    const decodedPath = decodeURIComponent(parsed.pathname);
    if (decodedPath !== parsed.pathname) {
      parsed.pathname = decodedPath;
      candidates.push(parsed.href);
    }
  } catch {}
  return [...new Set(candidates)];
}

function originalSizeMediaUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.pathname = parsed.pathname.replace(/-\d+x\d+(\.[a-z0-9]+)$/i, '$1');
    return parsed.href;
  } catch {
    return '';
  }
}

async function articleMediaReport() {
  const articles = await readArchivedArticles();
  const summary = {
    generated_at: new Date().toISOString(),
    include_srcset: hasFlag('include-srcset'),
    pages_checked: 0,
    pages_with_article_media: 0,
    article_media_refs: 0,
    article_media_localized_refs: 0,
    article_media_missing_refs: 0,
    by_page_type: {},
  };
  const pages = [];
  const missing = [];

  for (const article of articles) {
    const rawPath = path.join(RAW_DIR, `${article.post_id}-${article.wayback_timestamp}.html`);
    if (!article.wayback_timestamp || !await fileExists(rawPath)) {
      continue;
    }

    const rawHtml = await readFile(rawPath, 'utf8');
    const articleHtml = extractArticleElement(rawHtml);
    const media = collectArticleMedia(articleHtml, article.original_url, { includeSrcset: hasFlag('include-srcset') });
    const localizedUrls = new Set((article.media || article.images || [])
      .filter((item) => item.archive_path)
      .map((item) => item.url));
    const localized = media.filter((item) => localizedUrls.has(item.url));
    const pageMissing = media
      .map((item, index) => ({ ...item, index }))
      .filter((item) => !localizedUrls.has(item.url))
      .map((item) => ({
        post_id: article.post_id,
        page_type: article.page_type || 'other',
        title: article.title,
        page_timestamp: article.wayback_timestamp,
        url: item.url,
        source: item.source,
        kind: item.kind,
        index: item.index,
      }));
    const pageType = article.page_type || 'other';
    summary.by_page_type[pageType] ??= { pages: 0, pages_with_media: 0, media_refs: 0, localized_refs: 0, missing_refs: 0 };
    summary.pages_checked += 1;
    summary.by_page_type[pageType].pages += 1;

    if (media.length) {
      summary.pages_with_article_media += 1;
      summary.by_page_type[pageType].pages_with_media += 1;
    }

    summary.article_media_refs += media.length;
    summary.article_media_localized_refs += localized.length;
    summary.article_media_missing_refs += pageMissing.length;
    summary.by_page_type[pageType].media_refs += media.length;
    summary.by_page_type[pageType].localized_refs += localized.length;
    summary.by_page_type[pageType].missing_refs += pageMissing.length;
    missing.push(...pageMissing);
    pages.push({
      post_id: article.post_id,
      page_type: pageType,
      title: article.title,
      media_refs: media.length,
      localized_refs: localized.length,
      missing_refs: pageMissing.length,
    });
  }

  return { summary, pages, missing };
}

async function fileExists(filePath) {
  try {
    await readFile(filePath);
    return true;
  } catch {
    return false;
  }
}

function extractArticleElement(html) {
  const match = html.match(/<article\b[^>]*>/i);
  return match ? sliceBalancedElement(html, match.index, 'article') : '';
}

function collectArticleMedia(html, baseUrl, options = {}) {
  const media = [];

  for (const match of html.matchAll(/<img\b([^>]*)>/gi)) {
    const attrs = match[1];
    media.push({
      url: normalizeUrl(attr(attrs, 'src') || attr(attrs, 'data-src') || '', baseUrl),
      alt: cleanText(attr(attrs, 'alt') || ''),
      kind: 'image',
      source: 'img',
    });
    if (options.includeSrcset) {
      media.push(...collectSrcset(attr(attrs, 'srcset'), baseUrl).map((url) => ({
        url,
        alt: cleanText(attr(attrs, 'alt') || ''),
        kind: 'image',
        source: 'img-srcset',
      })));
    }
  }

  for (const tag of ['video', 'audio', 'source', 'embed']) {
    for (const match of html.matchAll(new RegExp(`<${tag}\\b([^>]*)>`, 'gi'))) {
      const url = normalizeUrl(attr(match[1], 'src'), baseUrl);
      media.push({ url, alt: '', kind: mediaKindForTag(tag), source: tag });
    }
  }

  for (const match of html.matchAll(/<video\b([^>]*)>/gi)) {
    const url = normalizeUrl(attr(match[1], 'poster'), baseUrl);
    media.push({ url, alt: '', kind: 'image', source: 'video-poster' });
  }

  for (const match of html.matchAll(/<object\b([^>]*)>/gi)) {
    const url = normalizeUrl(attr(match[1], 'data'), baseUrl);
    media.push({ url, alt: '', kind: 'object', source: 'object' });
  }

  for (const link of collectLinks(html, baseUrl)) {
    if (isMediaUrl(link.url)) {
      media.push({
        url: link.url,
        alt: link.text,
        kind: mediaKindForUrl(link.url),
        source: 'a-href',
      });
    }
  }

  const seen = new Set();
  return media
    .filter((item) => item.url && !item.url.startsWith('data:') && isWantedMediaUrl(item.url))
    .filter((item) => {
      if (seen.has(item.url)) {
        return false;
      }
      seen.add(item.url);
      return true;
    });
}

function isUploadsUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname === 'blog.mozilla.com.tw' && parsed.pathname.includes('/wp-content/uploads/');
  } catch {
    return false;
  }
}

async function readArchivedArticles() {
  const files = (await readdir(JSON_DIR))
    .filter((file) => file.endsWith('.json'))
    .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));
  const articles = [];

  for (const file of files) {
    articles.push(JSON.parse(await readFile(path.join(JSON_DIR, file), 'utf8')));
  }

  return articles;
}

async function retryArticleAssets(article) {
  const missingImages = (article.images || []).filter((image) => !image.archive_path);
  const existingImages = (article.images || []).filter((image) => image.archive_path);
  const existingByUrl = new Map(existingImages.map((image) => [image.url, image]));
  const retryResult = await archiveAssets(article.post_id, missingImages, article.wayback_timestamp);
  const retriedByUrl = new Map(retryResult.images.map((image) => [image.url, image]));
  const images = (article.images || []).map((image) => existingByUrl.get(image.url) || retriedByUrl.get(image.url) || image);
  const stillMissing = images.filter((image) => !image.archive_path);

  return {
    ...article,
    images,
    asset_status: stillMissing.length ? 'partial_assets_failed' : 'ok',
    asset_errors: retryResult.asset_errors,
  };
}

function assetStats(article) {
  const images = article.images || [];
  const localized = images.filter((image) => image.archive_path).length;
  return {
    total: images.length,
    localized,
    missing: images.length - localized,
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
  return `---\n${yamlLine('post_id', article.post_id)}${yamlLine('title', article.title)}${yamlLine('date', article.date)}${yamlLine('page_type', article.page_type)}${yamlArray('categories', article.categories)}${yamlArray('tags', article.tags)}${yamlLine('author', article.author)}${yamlLine('original_url', article.original_url)}${yamlLine('archive_url', article.archive_url)}${yamlLine('wayback_timestamp', article.wayback_timestamp)}${yamlLine('status', article.status)}${yamlLine('asset_status', article.asset_status)}---\n\n${body}\n`;
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
      kind: 'image',
      source: 'img',
    }))
    .filter((image) => image.url && !image.url.startsWith('data:'));
}

function collectMedia(html, baseUrl) {
  const media = [];

  for (const match of html.matchAll(/<img\b([^>]*)>/gi)) {
    const attrs = match[1];
    media.push({
      url: normalizeUrl(attr(attrs, 'src') || attr(attrs, 'data-src') || '', baseUrl),
      alt: cleanText(attr(attrs, 'alt') || ''),
      kind: 'image',
      source: 'img',
    });
    media.push(...collectSrcset(attr(attrs, 'srcset'), baseUrl).map((url) => ({
      url,
      alt: cleanText(attr(attrs, 'alt') || ''),
      kind: 'image',
      source: 'img-srcset',
    })));
  }

  for (const tag of ['video', 'audio', 'source', 'embed']) {
    for (const match of html.matchAll(new RegExp(`<${tag}\\b([^>]*)>`, 'gi'))) {
      const url = normalizeUrl(attr(match[1], 'src'), baseUrl);
      media.push({ url, alt: '', kind: mediaKindForTag(tag), source: tag });
    }
  }

  for (const match of html.matchAll(/<video\b([^>]*)>/gi)) {
    const url = normalizeUrl(attr(match[1], 'poster'), baseUrl);
    media.push({ url, alt: '', kind: 'image', source: 'video-poster' });
  }

  for (const match of html.matchAll(/<object\b([^>]*)>/gi)) {
    const url = normalizeUrl(attr(match[1], 'data'), baseUrl);
    media.push({ url, alt: '', kind: 'object', source: 'object' });
  }

  for (const match of html.matchAll(/<meta\b([^>]*)>/gi)) {
    const property = attr(match[1], 'property') || attr(match[1], 'name');
    if (/^(?:og:image|twitter:image|og:video|og:audio)$/i.test(property)) {
      media.push({
        url: normalizeUrl(attr(match[1], 'content'), baseUrl),
        alt: '',
        kind: property.toLowerCase().includes('image') ? 'image' : 'media',
        source: property,
      });
    }
  }

  for (const link of collectLinks(html, baseUrl)) {
    if (isMediaUrl(link.url)) {
      media.push({
        url: link.url,
        alt: link.text,
        kind: mediaKindForUrl(link.url),
        source: 'a-href',
      });
    }
  }

  const seen = new Set();
  return media
    .filter((item) => item.url && !item.url.startsWith('data:') && isWantedMediaUrl(item.url))
    .filter((item) => {
      const key = item.url;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
}

function collectSrcset(srcset, baseUrl) {
  return String(srcset || '')
    .split(',')
    .map((part) => part.trim().split(/\s+/)[0])
    .filter(Boolean)
    .map((url) => normalizeUrl(url, baseUrl));
}

function mediaKindForTag(tag) {
  if (tag === 'video') return 'video';
  if (tag === 'audio') return 'audio';
  return 'media';
}

function mediaKindForUrl(url) {
  const ext = path.extname(new URL(url).pathname).toLowerCase();
  if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp', '.tif', '.tiff'].includes(ext)) return 'image';
  if (['.mp4', '.m4v', '.mov', '.webm', '.ogv'].includes(ext)) return 'video';
  if (['.mp3', '.m4a', '.ogg', '.oga', '.wav'].includes(ext)) return 'audio';
  return 'media';
}

function isMediaUrl(url) {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    return /\.(?:jpe?g|png|gif|webp|svg|bmp|tiff?|mp4|m4v|mov|webm|ogv|mp3|m4a|ogg|oga|wav|pdf)(?:$|[?#])/i.test(pathname);
  } catch {
    return false;
  }
}

function isWantedMediaUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname === 'blog.mozilla.com.tw' || parsed.pathname.includes('/wp-content/uploads/') || isMediaUrl(url);
  } catch {
    return false;
  }
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
  const aSyntheticCutoff = isSyntheticCutoffSnapshot(a);
  const bSyntheticCutoff = isSyntheticCutoffSnapshot(b);

  if (aBeforeCutoff !== bBeforeCutoff) {
    return aBeforeCutoff ? -1 : 1;
  }

  if (aCanonical !== bCanonical) {
    return aCanonical ? -1 : 1;
  }

  if (aSyntheticCutoff !== bSyntheticCutoff) {
    return aSyntheticCutoff ? 1 : -1;
  }

  if (aBeforeCutoff && bBeforeCutoff) {
    return b.timestamp.localeCompare(a.timestamp);
  }

  return a.timestamp.localeCompare(b.timestamp);
}

function isSyntheticCutoffSnapshot(snapshot) {
  return snapshot.timestamp === SNAPSHOT_CUTOFF && snapshot.discovered_from?.kind === 'urls.txt';
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

function parseLegacyPublishedDate(html) {
  return parseDate(firstCapture(html, [
    /發表於[:：]\s*(\d{4}[/.]\d{1,2}[/.]\d{1,2})/i,
  ]));
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
