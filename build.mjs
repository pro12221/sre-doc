/**
 * SRE Notes — Build Pipeline
 *
 * Single source of truth: all Markdown under MarkDown/
 * Outputs:
 *   - posts/{slug}.html         (one per article)
 *   - index.html                (home)
 *   - about.html, 404.html
 *   - js/data.js                (window.SREData)
 *   - rss.xml, sitemap.xml
 *
 * Usage:
 *   node build.mjs                 # full build
 *   node build.mjs --clean         # remove generated files
 *   node build.mjs --watch         # rebuild on MD changes (best-effort)
 */

import { promises as fs } from 'node:fs';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { marked } from 'marked';

import { SITE, CATEGORIES, CATEGORY_BY_DIR, TAG_KEYWORDS } from './build/categories.mjs';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.dirname(__filename);
const TEMPLATES_DIR = path.join(ROOT, 'templates');
const MARKDOWN_DIR = path.join(ROOT, 'MarkDown');
const POSTS_DIR = path.join(ROOT, 'posts');
const JS_DIR = path.join(ROOT, 'js');

// ──────────────────────────────────────────────────────────
// Utilities
// ──────────────────────────────────────────────────────────

const log = (...args) => console.log('[build]', ...args);
const warn = (...args) => console.warn('[build] ⚠', ...args);
const err = (...args) => console.error('[build] ✗', ...args);

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function toPosix(p) {
  return p.split(path.sep).join('/');
}

function relPath(fromFile, toFile) {
  // Compute relative path from a file to another (both absolute or relative to ROOT).
  let rel = path.relative(path.dirname(fromFile), toFile);
  if (!rel.startsWith('.')) rel = './' + rel;
  return toPosix(rel);
}

async function walk(dir, ext) {
  const out = [];
  async function _walk(d) {
    let entries;
    try { entries = await fs.readdir(d, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) await _walk(full);
      else if (e.name.endsWith(ext)) out.push(full);
    }
  }
  await _walk(dir);
  return out.sort();
}

async function readTemplate(name) {
  return await fs.readFile(path.join(TEMPLATES_DIR, name), 'utf8');
}

function shell(cmd, opts = {}) {
  try {
    return execSync(cmd, { encoding: 'utf8', ...opts }).trim();
  } catch (e) {
    return '';
  }
}

function gitFirstCommitDate(file) {
  const rel = toPosix(path.relative(ROOT, file));
  // Use %aI (author date, ISO) for first commit. tail -1 = earliest.
  const out = shell(`git log --reverse --format=%aI -- "${rel}"`);
  if (out) {
    const first = out.split('\n')[0];
    return first ? first.slice(0, 10) : null;
  }
  return null;
}

function fileModDate(file) {
  const s = statSync(file);
  return s.mtime.toISOString().slice(0, 10);
}

// ──────────────────────────────────────────────────────────
// Slug + metadata extraction
// ──────────────────────────────────────────────────────────

/** Derive a URL slug from the markdown title. */
function deriveSlug(title, fallback) {
  const cleaned = title
    .trim()
    // Drop cosmetic delimiters that some draft files use as visual separators.
    .replace(/^[=\-_*~#.\s]+|[=\-_*~#.\s]+$/g, '')
    .replace(/[\\/:*?"<>|]/g, '')     // strip filesystem-unsafe chars
    .replace(/\s+/g, '-')             // spaces → dashes
    .replace(/-+/g, '-')              // collapse dashes
    .replace(/^-|-$/g, '');           // trim dashes
  return cleaned || fallback;
}

/** Infer category from parent directory of an MD file. */
function inferCategory(mdFile) {
  const rel = toPosix(path.relative(MARKDOWN_DIR, mdFile));
  const parts = rel.split('/');
  const dirName = parts[0].toLowerCase(); // case-insensitive
  return CATEGORY_BY_DIR.get(dirName)?.id ?? null;
}

function getCategory(id) {
  return CATEGORIES.find(c => c.id === id);
}

/** Parse the first H1 from markdown source. Fallback: first H2 (unless it's a TOC heading), then filename. */
function parseTitle(md, fallback) {
  const h1 = md.match(/^#\s+(.+?)\s*$/m);
  if (h1) return h1[1].trim();
  // Try the first H2 unless it's a TOC marker.
  const h2 = md.match(/^##\s+(.+?)\s*$/m);
  if (h2) {
    const t = h2[1].trim();
    if (!/^(目录|Table of Contents|TOC|Contents)$/i.test(t)) return t;
  }
  return fallback;
}

/** Generate excerpt from first non-heading paragraph. */
function parseExcerpt(md, maxLen = 90) {
  const lines = md.split('\n');
  let collecting = false;
  let buf = '';
  for (const raw of lines) {
    const line = raw.trim();
    if (collecting) {
      if (!line) { if (buf) break; continue; }
      if (line.startsWith('#')) break;
      if (line.startsWith('!')) continue;
      if (line.startsWith('```')) continue;
      buf += (buf ? '' : '') + line.replace(/[*_`>#-]/g, '').trim();
      if (buf.length > maxLen) break;
    } else if (line && !line.startsWith('#') && !line.startsWith('!') && !line.startsWith('```') && !line.startsWith('|')) {
      collecting = true;
      buf = line.replace(/[*_`>#-]/g, '').trim();
      if (buf.length > maxLen) break;
    }
  }
  if (buf.length > maxLen) buf = buf.slice(0, maxLen).trimEnd() + '…';
  return buf || '（无摘要）';
}

/** Scan content for cross-category tags. */
function inferTags(md, primaryCategory) {
  const text = md.toLowerCase();
  const tags = new Set([primaryCategory]);
  for (const [tag, keywords] of Object.entries(TAG_KEYWORDS)) {
    if (tag === primaryCategory) continue;
    for (const kw of keywords) {
      if (text.includes(kw.toLowerCase())) { tags.add(tag); break; }
    }
  }
  return [...tags];
}

/** Estimate reading time in minutes from a cleaned body. */
function estimateReadingTime(htmlBody) {
  // Strip tags and count Chinese chars + words.
  const text = htmlBody.replace(/<[^>]+>/g, ' ');
  const cjk = (text.match(/[一-鿿]/g) || []).length;
  const words = (text.match(/[A-Za-z]+/g) || []).length;
  // Reading speed: ~400 CJK chars/min, ~250 words/min.
  const minutes = Math.ceil(cjk / 400 + words / 250);
  return Math.max(1, minutes);
}

// ──────────────────────────────────────────────────────────
// Markdown → HTML rendering
// ──────────────────────────────────────────────────────────

function configureMarked() {
  // Custom renderer: code blocks get data-lang attribute for CSS targeting.
  const renderer = new marked.Renderer();
  configureMarked._renderer = renderer;
  renderer._counters = { h2: 0, h3: 0, h4: 0 };
  renderer.code = function(code, lang) {
    const language = (lang || '').trim().split(/\s+/)[0] || 'text';
    // Escape HTML inside the code block.
    const escaped = String(code)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    // Language label is rendered via CSS ::before from data-lang.
    return `<pre data-lang="${language}"><code>${escaped}</code></pre>`;
  };

  // Add id + counter to headings. Counters reset per article (see build()).
  renderer.heading = function(text, level, raw) {
    const counters = renderer._counters;
    if (level === 2) counters.h2++;
    counters.h3 = 0; counters.h4 = 0;
    if (level === 3) counters.h3++;
    if (level === 4) counters.h4++;
    const slug = 'h-' + (level === 2 ? counters.h2 : level === 3 ? `${counters.h2}-${counters.h3}` : `${counters.h2}-${counters.h3}-${counters.h4}`);
    const numbered = level === 2 ? `<span class="h-num">${String(counters.h2).padStart(2, '0')}</span>` : '';
    return `<h${level} id="${slug}" data-num="${counters.h2}-${counters.h3}-${counters.h4}">${numbered}<span class="h-text">${text}</span></h${level}>`;
  };

  marked.setOptions({
    renderer,
    gfm: true,
    breaks: false,
    pedantic: false,
  });
}

// Rewrite image src in rendered HTML so it works from posts/ directory.
// Relative `./images/foo.png` in the MD source lives at MarkDown/{cat}/images/foo.png,
// so from posts/xxx.html the path is `../MarkDown/{cat}/images/foo.png`.
function rewriteImagePaths(html, categoryId) {
  return html.replace(/<img\s+([^>]*?)src="(\.\/[^"]+|\.\.\/[^"]+|[^"http:][^"]*)"/g, (match, attrs, src) => {
    if (src.startsWith('http') || src.startsWith('/')) return match; // already absolute
    // The MD source uses `./images/...` relative to its own folder.
    // From `posts/xxx.html` we need `../MarkDown/{cat}/images/...`.
    const normalized = src.replace(/^\.\//, '');
    const newSrc = `../MarkDown/${categoryId}/${normalized}`;
    return `<img ${attrs}src="${newSrc}"`;
  });
}

// ──────────────────────────────────────────────────────────
// Article processing
// ──────────────────────────────────────────────────────────

async function processArticle(mdFile) {
  const md = await fs.readFile(mdFile, 'utf8');
  if (!md.trim()) {
    warn(`Empty file, skipping: ${mdFile}`);
    return null;
  }

  const fallbackTitle = path.basename(mdFile, '.md');
  const title = parseTitle(md, fallbackTitle);

  const categoryId = inferCategory(mdFile);
  if (!categoryId) {
    warn(`Unknown category directory for ${mdFile}; defaulting to 'uncategorized'`);
  }
  const category = getCategory(categoryId) || { id: 'uncategorized', name: 'Uncategorized', desc: '' };

  // Strip the first H1 from the body — the template renders it separately.
  // Also strip a leading H2 "目录/TOC" section if present.
  let bodyMd = md.replace(/^#\s+.+?\n+/, '');
  bodyMd = bodyMd.replace(/^##\s+(目录|Table of Contents|TOC|Contents)[\s\S]*?(?=\n##\s|\n#\s|$)/m, '');

  let html = marked.parse(bodyMd);
  html = rewriteImagePaths(html, category.id);

  const excerpt = parseExcerpt(md);
  const tags = inferTags(md, category.id);
  const readingTime = estimateReadingTime(html);

  const date = gitFirstCommitDate(mdFile) || fileModDate(mdFile);

  const relFile = toPosix(path.relative(ROOT, mdFile));
  const slug = deriveSlug(title, path.basename(mdFile, '.md'));

  return {
    title,
    category: category.id,
    categoryName: category.name,
    date,
    tags,
    excerpt,
    readingTime,
    htmlBody: html,
    slug,
    sourceFile: relFile,
    url: `posts/${slug}.html`,
  };
}

// ──────────────────────────────────────────────────────────
// Template helpers
// ──────────────────────────────────────────────────────────

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function jsString(s) {
  return JSON.stringify(String(s));
}

function renderRelatedCards(article, allArticles) {
  const sameCat = allArticles
    .filter(a => a.category === article.category && a.url !== article.url)
    .slice(0, 3);
  if (sameCat.length === 0) return '';
  return sameCat.map(a =>
    `<a class="post-card" href="${a.url}">` +
      `<div class="post-card-title">${escapeHtml(a.title)}</div>` +
      `<div class="post-card-desc">${escapeHtml(a.excerpt)}</div>` +
      `<div class="post-card-meta"><span>${escapeHtml(a.categoryName)}</span><span>${a.date}</span></div>` +
    `</a>`
  ).join('\n              ');
}

function prevNext(article, sortedArticles) {
  const idx = sortedArticles.findIndex(a => a.url === article.url);
  const prev = idx > 0 ? sortedArticles[idx - 1] : null;
  const next = idx >= 0 && idx < sortedArticles.length - 1 ? sortedArticles[idx + 1] : null;

  const prevHref = prev ? `href="${prev.url}"` : 'aria-disabled="true"';
  const prevDisabled = prev ? '' : ' disabled';
  const nextHref = next ? `href="${next.url}"` : 'aria-disabled="true"';
  const nextDisabled = next ? '' : ' disabled';

  return {
    prevTitle: prev ? prev.title : '已是第一篇',
    nextTitle: next ? next.title : '已是最后一篇',
    prevHref, prevDisabled, nextHref, nextDisabled,
  };
}

function extraTagsHtml(tags, primaryCategory) {
  return tags
    .filter(t => t !== primaryCategory)
    .map(t => {
      const c = getCategory(t);
      return c ? `<span class="tag tag-${t}">${escapeHtml(c.name)}</span>` : '';
    })
    .filter(Boolean)
    .join('');
}

// ──────────────────────────────────────────────────────────
// Render functions
// ──────────────────────────────────────────────────────────

async function renderPost(article, allArticles, sortedArticles, tpl) {
  const pn = prevNext(article, sortedArticles);
  return tpl
    .replaceAll('{{TITLE}}', escapeHtml(article.title))
    .replaceAll('{{TITLE_SHORT}}', escapeHtml(article.title))
    .replaceAll('{{EXCERPT}}', escapeHtml(article.excerpt))
    .replaceAll('{{CATEGORY}}', article.category)
    .replaceAll('{{CATEGORY_LABEL}}', escapeHtml(article.categoryName))
    .replaceAll('{{DATE}}', article.date)
    .replaceAll('{{READING_TIME}}', String(article.readingTime))
    .replaceAll('{{EXTRA_TAGS}}', extraTagsHtml(article.tags, article.category))
    .replaceAll('{{BODY}}', article.htmlBody)
    .replaceAll('{{PREV_TITLE}}', escapeHtml(pn.prevTitle))
    .replaceAll('{{NEXT_TITLE}}', escapeHtml(pn.nextTitle))
    .replaceAll('{{PREV_HREF}}', pn.prevHref)
    .replaceAll('{{NEXT_HREF}}', pn.nextHref)
    .replaceAll('{{PREV_DISABLED}}', pn.prevDisabled)
    .replaceAll('{{NEXT_DISABLED}}', pn.nextDisabled)
    .replaceAll('{{RELATED_CARDS}}', renderRelatedCards(article, allArticles));
}

function renderDataJs(articles, sortedArticles, tpl) {
  // Compute counts.
  const counts = Object.fromEntries(CATEGORIES.map(c => [c.id, 0]));
  for (const a of articles) {
    if (counts[a.category] != null) counts[a.category]++;
  }
  const catsJson = CATEGORIES
    .map(c => `  { id: ${jsString(c.id)}, name: ${jsString(c.name)}, color: ${jsString(c.color)}, desc: ${jsString(c.desc)}, count: ${counts[c.id] || 0} }`)
    .join(',\n');
  const artsJson = sortedArticles
    .map(a => `  { title: ${jsString(a.title)}, category: ${jsString(a.category)}, date: ${jsString(a.date)}, tags: ${JSON.stringify(a.tags)}, excerpt: ${jsString(a.excerpt)}, url: ${jsString(a.url)}, readingTime: ${a.readingTime} }`)
    .join(',\n');
  return tpl
    .replace('{{CATEGORIES}}', catsJson)
    .replace('{{ARTICLES}}', artsJson);
}

function renderRss(articles, tpl) {
  const recent = articles.slice(0, 20);
  const items = recent.map(a => `    <item>
      <title>${escapeXml(a.title)}</title>
      <link>${SITE.baseUrl}/${a.url}</link>
      <guid isPermaLink="true">${SITE.baseUrl}/${a.url}</guid>
      <pubDate>${a.date}T00:00:00+08:00</pubDate>
      <category>${escapeXml(a.category)}</category>
      <description>${escapeXml(a.excerpt)}</description>
    </item>`).join('\n');
  return tpl
    .replaceAll('{{TITLE}}', escapeXml(SITE.title + ' — ' + SITE.tagline))
    .replaceAll('{{LINK}}', SITE.baseUrl)
    .replaceAll('{{DESCRIPTION}}', escapeXml(SITE.description))
    .replaceAll('{{LANGUAGE}}', SITE.language)
    .replaceAll('{{ITEMS}}', items);
}

function renderSitemap(articles, tpl) {
  const today = new Date().toISOString().slice(0, 10);
  const urls = [
    `  <url><loc>${SITE.baseUrl}/</loc><lastmod>${today}</lastmod><priority>1.0</priority></url>`,
    `  <url><loc>${SITE.baseUrl}/about.html</loc><lastmod>${today}</lastmod><priority>0.6</priority></url>`,
    ...articles.map(a => `  <url><loc>${SITE.baseUrl}/${a.url}</loc><lastmod>${a.date}</lastmod><priority>0.8</priority></url>`),
  ].join('\n');
  return tpl.replaceAll('{{URLS}}', urls);
}

// ──────────────────────────────────────────────────────────
// Main build
// ──────────────────────────────────────────────────────────

async function clean() {
  log('Cleaning generated files...');
  // Remove all posts/*.html except template.html.
  if (existsSync(POSTS_DIR)) {
    const files = await fs.readdir(POSTS_DIR);
    for (const f of files) {
      if (f === 'template.html') continue;
      await fs.unlink(path.join(POSTS_DIR, f));
    }
  }
  for (const f of ['index.html', '404.html', 'about.html', 'rss.xml', 'sitemap.xml', 'search-index.js']) {
    const p = path.join(ROOT, f);
    if (existsSync(p)) await fs.unlink(p);
  }
  for (const f of ['data.js']) {
    const p = path.join(JS_DIR, f);
    if (existsSync(p)) await fs.unlink(p);
  }
  log('Clean complete.');
}

async function build() {
  log('Starting build...');

  if (!existsSync(TEMPLATES_DIR)) {
    err(`Templates directory missing: ${TEMPLATES_DIR}`);
    process.exit(1);
  }

  configureMarked();

  // 1. Scan markdown files.
  log('Scanning MarkDown/...');
  const mdFiles = await walk(MARKDOWN_DIR, '.md');
  log(`Found ${mdFiles.length} markdown files.`);

  // 2. Process each into an article object.
  const articles = [];
  for (const f of mdFiles) {
    try {
      // Reset heading counters per article so they restart at 01.
      if (configureMarked._renderer) configureMarked._renderer._counters = { h2: 0, h3: 0, h4: 0 };
      const a = await processArticle(f);
      if (a) articles.push(a);
    } catch (e) {
      err(`Failed to process ${f}:`, e.message);
    }
  }

  // 3. Dedupe by URL.
  const seen = new Map();
  for (const a of articles) {
    if (seen.has(a.url)) {
      warn(`Duplicate URL: ${a.url} — keeping first`);
      continue;
    }
    seen.set(a.url, a);
  }
  const uniqueArticles = [...seen.values()];

  // 4. Sort by date desc.
  const sortedArticles = uniqueArticles.slice().sort((a, b) => b.date.localeCompare(a.date));

  // 5. Render posts.
  const postTpl = await readTemplate('post.html');
  log(`Rendering ${uniqueArticles.length} post pages...`);
  if (!existsSync(POSTS_DIR)) await fs.mkdir(POSTS_DIR, { recursive: true });

  // Clear old generated posts (keep template.html).
  const existingPosts = await fs.readdir(POSTS_DIR);
  for (const f of existingPosts) {
    if (f === 'template.html') continue;
    await fs.unlink(path.join(POSTS_DIR, f));
  }

  for (const a of uniqueArticles) {
    const out = await renderPost(a, uniqueArticles, sortedArticles, postTpl);
    await fs.writeFile(path.join(POSTS_DIR, `${a.slug}.html`), out, 'utf8');
  }

  // 6. Render data.js.
  const dataTpl = await readTemplate('data.js');
  const dataJs = renderDataJs(uniqueArticles, sortedArticles, dataTpl);
  await fs.writeFile(path.join(JS_DIR, 'data.js'), dataJs, 'utf8');
  log('  → js/data.js');

  // 7. Render index.html (home).
  const homeTpl = await readTemplate('home.html');
  await fs.writeFile(path.join(ROOT, 'index.html'), homeTpl, 'utf8');
  log('  → index.html');

  // 8. Render 404.html and about.html (simple copies of templates).
  for (const f of ['404.html', 'about.html']) {
    const tpl = await readTemplate(f);
    await fs.writeFile(path.join(ROOT, f), tpl, 'utf8');
    log(`  → ${f}`);
  }

  // 9. RSS.
  const rssTpl = await readTemplate('rss.xml');
  await fs.writeFile(path.join(ROOT, 'rss.xml'), renderRss(sortedArticles, rssTpl), 'utf8');
  log('  → rss.xml');

  // 10. sitemap.xml.
  const sitemapTpl = await readTemplate('sitemap.xml');
  await fs.writeFile(path.join(ROOT, 'sitemap.xml'), renderSitemap(sortedArticles, sitemapTpl), 'utf8');
  log('  → sitemap.xml');

  log(`Build complete. ${uniqueArticles.length} articles.`);
}

// ──────────────────────────────────────────────────────────
// CLI
// ──────────────────────────────────────────────────────────

const args = process.argv.slice(2);
if (args.includes('--clean')) {
  await clean();
} else if (args.includes('--watch')) {
  await build();
  log('Watch mode (best-effort): re-running on MD change. Ctrl+C to exit.');
  const { watch } = await import('node:fs');
  let debounce;
  watch(MARKDOWN_DIR, { recursive: true }, () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => build().catch(e => err(e.stack || e.message)), 250);
  });
} else {
  await build();
}