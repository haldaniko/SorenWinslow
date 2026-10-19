import { createHash, randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import slugify from 'slugify';
import { HttpError } from '../middleware/errorHandler';
import { db } from './db';
import { sanitizeArticleHtml } from './htmlSanitizer';

export const botCategories = [
  { slug: 'books', name: 'Books' },
  { slug: 'television', name: 'Television' },
  { slug: 'culture', name: 'Culture' },
  { slug: 'business-ideas', name: 'Business & Ideas' },
] as const;

type CreateInput = {
  external_id: string;
  title: string;
  content: string;
  summary?: string;
  category_slugs: string[];
  author_slug?: string | null;
  tag_names?: string[];
};

type ArticleResponse = { article_id: string; status: 'draft' | 'published'; url: string; image_url: string | null };

function publicBase() {
  return (process.env.SITE_URL || 'http://localhost:3000').replace(/\/$/, '');
}

function articleResponse(row: any): ArticleResponse {
  return {
    article_id: String(row.id),
    status: row.status,
    url: `${publicBase()}/articles/${encodeURIComponent(row.slug)}`,
    image_url: row.image_url ? `${publicBase()}${row.image_url}` : null,
  };
}

function normalize(input: CreateInput) {
  if (!input || typeof input !== 'object') throw new HttpError(400, 'JSON body is required');
  if (typeof input.external_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.external_id)) {
    throw new HttpError(400, 'external_id must be a UUID');
  }
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  const content = typeof input.content === 'string' ? input.content.trim() : '';
  const summary = typeof input.summary === 'string' ? input.summary.trim() : '';
  if (!title || title.length > 300) throw new HttpError(400, 'title is required and must be at most 300 characters');
  if (!content || content.length > 100_000) throw new HttpError(400, 'content is required and must be at most 100000 characters');
  if (summary.length > 1000) throw new HttpError(400, 'summary must be at most 1000 characters');
  if (!Array.isArray(input.category_slugs) || input.category_slugs.length < 1 || input.category_slugs.some((item) => typeof item !== 'string')) {
    throw new HttpError(400, 'At least one category is required');
  }
  const categorySlugs = [...new Set(input.category_slugs)];
  const known = new Set(botCategories.map((category) => category.slug));
  if (categorySlugs.some((slug) => !known.has(slug as any))) throw new HttpError(400, 'Unknown category');
  if (input.author_slug != null) throw new HttpError(400, 'This site does not expose selectable authors');
  const tagNames = input.tag_names == null ? [] : input.tag_names;
  if (!Array.isArray(tagNames) || tagNames.length > 10 || tagNames.some((tag) => typeof tag !== 'string' || !tag.trim() || tag.trim().length > 80)) {
    throw new HttpError(400, 'tag_names must contain at most 10 non-empty tags of at most 80 characters');
  }
  return { externalId: input.external_id.toLowerCase(), title, content, summary, categorySlugs, tagNames: tagNames.map((tag) => tag.trim()) };
}

function toHtml(content: string) {
  const escaped = content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return sanitizeArticleHtml(escaped.split(/\n{2,}/).map((paragraph) => `<p>${paragraph.replace(/\n/g, '<br>')}</p>`).join(''));
}

function payloadHash(value: ReturnType<typeof normalize>) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function selectArticle(externalId: string) {
  return db.prepare(`SELECT p.*, d.image_url FROM bot_article_deliveries d
    JOIN generated_posts p ON p.id = d.post_id WHERE d.external_id = ?`).get(externalId);
}

export function getBotArticle(externalId: string): ArticleResponse | null {
  const row = selectArticle(externalId.toLowerCase());
  return row ? articleResponse(row) : null;
}

export function createBotArticle(input: CreateInput): ArticleResponse {
  const normalized = normalize(input);
  const hash = payloadHash(normalized);
  return db.transaction(() => {
    const existing = db.prepare(`SELECT p.*, d.image_url, d.payload_hash FROM bot_article_deliveries d
      JOIN generated_posts p ON p.id = d.post_id WHERE d.external_id = ?`).get(normalized.externalId) as any;
    if (existing) {
      if (existing.payload_hash !== hash) throw new HttpError(409, 'external_id already exists with different content');
      return articleResponse(existing);
    }
    const postId = randomUUID();
    const baseSlug = (slugify(normalized.title, { lower: true, strict: true, trim: true }) || 'article').slice(0, 120);
    let slug = `${baseSlug}-${normalized.externalId}`;
    if (db.prepare('SELECT 1 FROM generated_posts WHERE slug = ?').get(slug)) slug = `${slug}-${postId.slice(0, 8)}`;
    const categoryNames = normalized.categorySlugs.map((slug) => botCategories.find((category) => category.slug === slug)!.name);
    const tags = [...new Set([...categoryNames, ...normalized.tagNames])];
    db.prepare(`INSERT INTO generated_posts
      (id, slug, title, excerpt, content_html, cover_image, status, author, tags, source)
      VALUES (?, ?, ?, ?, ?, '/covers/velvet-index.svg', 'draft', 'Editorial team', ?, 'bot')`)
      .run(postId, slug, normalized.title, normalized.summary || normalized.content.slice(0, 240), toHtml(normalized.content), JSON.stringify(tags));
    db.prepare('INSERT INTO bot_article_deliveries (external_id, post_id, payload_hash) VALUES (?, ?, ?)')
      .run(normalized.externalId, postId, hash);
    return articleResponse(selectArticle(normalized.externalId));
  })();
}

export function publishBotArticle(externalId: string): ArticleResponse {
  return db.transaction(() => {
    const row = selectArticle(externalId.toLowerCase()) as any;
    if (!row) throw new HttpError(404, 'Article not found');
    if (row.status === 'published') return articleResponse(row);
    if (row.status !== 'draft') throw new HttpError(409, 'Article is not publishable');
    const now = new Date().toISOString();
    db.prepare("UPDATE generated_posts SET status = 'published', updated_at = ? WHERE id = ?").run(now, row.id);
    db.prepare("UPDATE bot_article_deliveries SET published_at = COALESCE(published_at, ?), updated_at = ? WHERE external_id = ?")
      .run(now, now, externalId.toLowerCase());
    return articleResponse(selectArticle(externalId.toLowerCase()));
  })();
}

function imageKind(buffer: Buffer) {
  if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'jpg';
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP') return 'webp';
  throw new HttpError(400, 'Image must be a valid JPG, PNG, or WebP file');
}

export async function saveBotArticleImage(externalId: string, buffer?: Buffer): Promise<ArticleResponse> {
  if (!buffer?.length) throw new HttpError(400, 'image is required');
  if (buffer.length > 10 * 1024 * 1024) throw new HttpError(400, 'Image must be 10 MiB or smaller');
  const id = externalId.toLowerCase();
  const current = selectArticle(id) as any;
  if (!current) throw new HttpError(404, 'Article not found');
  if (current.status !== 'draft') throw new HttpError(409, 'Published articles cannot be changed');
  if (current.image_url) return articleResponse(current);
  const extension = imageKind(buffer);
  const relative = `/uploads/covers/bot-${id}.${extension}`;
  const destination = path.join(process.env.UPLOAD_DIR || path.resolve(process.cwd(), 'uploads'), 'covers', `bot-${id}.${extension}`);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  try { await fs.writeFile(destination, buffer, { flag: 'wx' }); }
  catch (error: any) { if (error.code !== 'EEXIST') throw error; }
  return db.transaction(() => {
    const latest = selectArticle(id) as any;
    if (!latest) throw new HttpError(404, 'Article not found');
    if (latest.status !== 'draft') throw new HttpError(409, 'Published articles cannot be changed');
    if (!latest.image_url) {
      const now = new Date().toISOString();
      db.prepare('UPDATE generated_posts SET cover_image = ?, updated_at = ? WHERE id = ?').run(relative, now, latest.id);
      db.prepare('UPDATE bot_article_deliveries SET image_url = ?, updated_at = ? WHERE external_id = ?').run(relative, now, id);
    }
    return articleResponse(selectArticle(id));
  })();
}
