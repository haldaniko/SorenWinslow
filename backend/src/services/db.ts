import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import path from 'path';
import { samplePosts } from '../data/samplePosts';
import { sanitizeArticleHtml } from './htmlSanitizer';

export const databasePath = process.env.SQLITE_PATH || path.resolve(process.cwd(), 'db.sqlite3');

function requireProductionEnv() {
  if (process.env.NODE_ENV !== 'production') return;
  for (const key of ['SQLITE_PATH', 'JWT_SECRET', 'REFRESH_TOKEN_SECRET']) {
    if (!process.env[key]) throw new Error(`${key} is required in production`);
  }
  if (process.env.JWT_SECRET === process.env.REFRESH_TOKEN_SECRET ||
      (process.env.JWT_SECRET || '').length < 32 || (process.env.REFRESH_TOKEN_SECRET || '').length < 32) {
    throw new Error('JWT secrets must differ and be at least 32 characters');
  }
  if ((process.env.CORS_ORIGIN || '').includes('localhost') || (process.env.SITE_URL || '').includes('localhost')) {
    throw new Error('Production CORS_ORIGIN and SITE_URL must not point to localhost');
  }
}

requireProductionEnv();
// fileMustExist prevents a failed migration from silently creating an empty production DB.
export const db = new Database(databasePath, { fileMustExist: process.env.NODE_ENV === 'production' });
db.pragma('journal_mode = DELETE');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

export async function query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<{ rows: T[] }> {
  const ordered: unknown[] = [];
  const statement = sql.replace(/\$(\d+)/g, (_match, index: string) => {
    ordered.push(params[Number(index) - 1]);
    return '?';
  });
  const normalized = ordered.map((value) => Array.isArray(value) ? JSON.stringify(value) : value);
  const prepared = db.prepare(statement);
  return { rows: prepared.reader ? prepared.all(...normalized) as T[] : (prepared.run(...normalized), []) };
}

export async function ensureSchema() {
  if (process.env.NODE_ENV === 'production') {
    const marker = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='migration_meta'").get();
    if (!marker || db.prepare("SELECT value FROM migration_meta WHERE key='source'").pluck().get() !== 'postgres-v1') {
      throw new Error('SQLite database has no completed PostgreSQL migration marker');
    }
    if (db.pragma('integrity_check', { simple: true }) !== 'ok' || (db.pragma('foreign_key_check') as unknown[]).length) {
      throw new Error('SQLite integrity or foreign key check failed');
    }
  } else {
    db.exec(readFileSync(path.resolve(__dirname, '../../sql/sqlite-schema.sql'), 'utf8'));
  }

  // Additive runtime migration for deployments that already completed the PostgreSQL cutover.
  db.exec(`CREATE TABLE IF NOT EXISTS bot_article_deliveries (
    external_id TEXT PRIMARY KEY,
    post_id TEXT NOT NULL UNIQUE REFERENCES generated_posts(id) ON DELETE CASCADE,
    payload_hash TEXT NOT NULL,
    image_url TEXT,
    published_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`);

  const count = await query<{ count: number }>('SELECT count(*) AS count FROM generated_posts');
  if (count.rows[0].count === 0 && process.env.NODE_ENV !== 'production') {
    for (const post of samplePosts) {
      await query(
        `INSERT INTO generated_posts (slug, title, excerpt, content_html, cover_image, tags, seo_title, seo_description, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'legacy') ON CONFLICT (slug) DO NOTHING`,
        [post.slug, post.title, post.excerpt, sanitizeArticleHtml(post.contentHtml),
          post.coverImage || '/covers/velvet-index.svg', post.tags || [], post.seoTitle || null, post.seoDescription || null],
      );
    }
  }
}
