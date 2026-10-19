import { Client } from 'pg';
import Cursor from 'pg-cursor';
import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'crypto';
import { promises as fs, readFileSync } from 'fs';
import path from 'path';

const root = process.env.DATA_ROOT || '/data';
const sourceMedia = process.env.SOURCE_UPLOAD_DIR || '/source-uploads';
const target = path.join(root, 'db.sqlite3');
const tables = ['users', 'refresh_tokens', 'generated_posts', 'admin_settings', 'audit_events', 'subscribers'];
const quote = (value) => `"${value.replaceAll('"', '""')}"`;
const schema = readFileSync(new URL('../sql/sqlite-schema.sql', import.meta.url), 'utf8');
let temporary;

function verifyDatabase(file) {
  const db = new Database(file, { fileMustExist: true, readonly: true });
  try {
    if (db.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('SQLite integrity_check failed');
    if (db.pragma('foreign_key_check').length) throw new Error('SQLite foreign_key_check failed');
    if (db.prepare("SELECT value FROM migration_meta WHERE key='source'").pluck().get() !== 'postgres-v1') {
      throw new Error('SQLite migration marker is missing');
    }
    for (const table of tables) db.prepare(`SELECT count(*) FROM ${quote(table)}`).get();
  } finally { db.close(); }
}

function applyRuntimeMigrations(file) {
  const db = new Database(file, { fileMustExist: true });
  try {
    db.pragma('foreign_keys = ON');
    db.exec(`CREATE TABLE IF NOT EXISTS bot_article_deliveries (
      external_id TEXT PRIMARY KEY,
      post_id TEXT NOT NULL UNIQUE REFERENCES generated_posts(id) ON DELETE CASCADE,
      payload_hash TEXT NOT NULL,
      image_url TEXT,
      published_at TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )`);
  } finally { db.close(); }
}

async function hash(file) {
  return createHash('sha256').update(await fs.readFile(file)).digest('hex');
}

async function copyMedia(owner) {
  const destination = path.join(root, 'media');
  await fs.mkdir(destination, { recursive: true });
  await fs.chown(destination, owner.uid, owner.gid);
  let count = 0;
  async function walk(from, to) {
    for (const item of await fs.readdir(from, { withFileTypes: true })) {
      const src = path.join(from, item.name);
      const dest = path.join(to, item.name);
      if (item.isDirectory()) {
        await fs.mkdir(dest, { recursive: true });
        await fs.chown(dest, owner.uid, owner.gid);
        await walk(src, dest);
      } else if (item.isFile()) {
        const temp = `${dest}.migration-${randomUUID()}`;
        try {
          await fs.copyFile(src, temp);
          if ((await hash(src)) !== (await hash(temp))) throw new Error(`Media copy checksum mismatch: ${src}`);
          await fs.chown(temp, owner.uid, owner.gid);
          try {
            await fs.link(temp, dest);
          } catch (error) {
            if (error.code !== 'EEXIST' || (await hash(src)) !== (await hash(dest))) {
              throw new Error(`Existing media differs from source: ${dest}`);
            }
          }
          count++;
        } finally { await fs.rm(temp, { force: true }); }
      } else {
        throw new Error(`Unsupported media entry: ${src}`);
      }
    }
  }
  await walk(sourceMedia, destination);
  console.log(`Media checked: ${count} files; URL prefix /uploads -> ${destination}`);
}

async function verifyMediaUrls(db) {
  for (const row of db.prepare('SELECT cover_image, content_html FROM generated_posts').iterate()) {
    const urls = [row.cover_image, ...(row.content_html.match(/\/uploads\/[^\s"'<>]+/g) || [])];
    for (const url of urls) {
      if (!url.startsWith('/uploads/')) continue;
      const relative = decodeURIComponent(url.split(/[?#]/)[0].slice('/uploads/'.length));
      if (!relative || relative.split('/').includes('..')) throw new Error(`Unsafe media URL: ${url}`);
      const file = path.resolve(root, 'media', relative);
      if (!file.startsWith(path.resolve(root, 'media') + path.sep) || !(await fs.stat(file).catch(() => null))?.isFile()) {
        throw new Error(`Missing media for URL: ${url}`);
      }
    }
  }
}

async function migrate() {
  const owner = await fs.stat(root);
  const existing = await fs.stat(target).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (existing) {
    if (!existing.isFile()) throw new Error(`${target} is not a file`);
    verifyDatabase(target);
    applyRuntimeMigrations(target);
    await copyMedia(owner);
    const db = new Database(target, { readonly: true, fileMustExist: true });
    try { await verifyMediaUrls(db); } finally { db.close(); }
    console.log('Existing valid SQLite retained; PostgreSQL data was not copied again');
    return;
  }

  const pg = new Client({
    host: process.env.PGHOST || 'postgres',
    port: Number(process.env.PGPORT || 5432),
    database: process.env.PGDATABASE || process.env.POSTGRES_DB || 'sorenwinslow',
    user: process.env.PGUSER || process.env.POSTGRES_USER || 'sorenwinslow',
    password: process.env.PGPASSWORD || process.env.POSTGRES_PASSWORD,
  });
  await pg.connect();
  try {
    const setting = await pg.query('SHOW default_transaction_read_only');
    if (setting.rows[0].default_transaction_read_only !== 'on') {
      throw new Error('Source PostgreSQL must be read-only before cutover');
    }
    await pg.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const actual = (await pg.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename")).rows.map((r) => r.tablename);
    const unknown = actual.filter((name) => !tables.includes(name));
    const missing = tables.filter((name) => !actual.includes(name));
    if (unknown.length || missing.length) throw new Error(`Unexpected PostgreSQL schema; extra=${unknown}, missing=${missing}`);
    const otherStructures = (await pg.query(`
      SELECT 'view:' || viewname AS name FROM pg_views WHERE schemaname='public'
      UNION ALL SELECT 'materialized_view:' || matviewname FROM pg_matviews WHERE schemaname='public'
      UNION ALL SELECT 'sequence:' || sequencename FROM pg_sequences WHERE schemaname='public'
      UNION ALL SELECT 'trigger:' || trigger_name FROM information_schema.triggers WHERE trigger_schema='public'
    `)).rows.map((row) => row.name);
    if (otherStructures.length) throw new Error(`Unsupported PostgreSQL structures: ${otherStructures.join(', ')}`);
    const constraints = (await pg.query(`
      SELECT t.relname AS table_name, c.contype AS kind, pg_get_constraintdef(c.oid) AS definition
      FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
      JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public'
    `)).rows;
    const primaryKeys = { users: 'id', refresh_tokens: 'id', generated_posts: 'id',
      admin_settings: 'key', audit_events: 'id', subscribers: 'id' };
    for (const constraint of constraints) {
      if (constraint.kind === 'p') {
        if (constraint.definition !== `PRIMARY KEY (${primaryKeys[constraint.table_name]})`) {
          throw new Error(`Unexpected PostgreSQL primary key: ${constraint.table_name} ${constraint.definition}`);
        }
      } else if (constraint.kind === 'f') {
        if (constraint.table_name !== 'refresh_tokens' ||
            !/^FOREIGN KEY \(user_id\) REFERENCES users\(id\) ON DELETE CASCADE$/.test(constraint.definition)) {
          throw new Error(`Unsupported PostgreSQL foreign key: ${constraint.table_name} ${constraint.definition}`);
        }
      } else if (constraint.kind !== 'u') {
        throw new Error(`Unsupported PostgreSQL constraint: ${constraint.table_name} ${constraint.definition}`);
      }
    }
    for (const table of tables) {
      if (!constraints.some((constraint) => constraint.table_name === table && constraint.kind === 'p')) {
        throw new Error(`Missing PostgreSQL primary key: ${table}`);
      }
    }

    await copyMedia(owner);
    temporary = path.join(root, `.db.sqlite3.migrating-${randomUUID()}`);
    const db = new Database(temporary);
    try {
      db.pragma('journal_mode = DELETE');
      db.pragma('foreign_keys = OFF');
      db.exec(schema);
      for (const table of tables) {
        const columns = (await pg.query(
          `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`, [table],
        )).rows;
        const targetColumns = db.pragma(`table_info(${quote(table)})`).map((c) => c.name);
        const sourceColumns = columns.map((c) => c.column_name);
        if (sourceColumns.slice().sort().join(',') !== targetColumns.slice().sort().join(',')) {
          throw new Error(`Column mismatch in ${table}: PostgreSQL=${sourceColumns}; SQLite=${targetColumns}`);
        }
        const insert = db.prepare(`INSERT INTO ${quote(table)} (${sourceColumns.map(quote).join(',')}) VALUES (${sourceColumns.map(() => '?').join(',')})`);
        const cursor = pg.query(new Cursor(`SELECT * FROM public.${quote(table)}`));
        let count = 0;
        try {
          for (;;) {
            const rows = await cursor.read(500);
            if (!rows.length) break;
            db.transaction((batch) => {
              for (const row of batch) {
                insert.run(...columns.map(({ column_name, data_type }) => {
                  const value = row[column_name];
                  if (value == null) return null;
                  if (data_type === 'ARRAY' || data_type === 'json' || data_type === 'jsonb') return JSON.stringify(value);
                  if (value instanceof Date) return value.toISOString();
                  if (Buffer.isBuffer(value)) return value;
                  if (typeof value === 'object') throw new Error(`Unsupported ${table}.${column_name} type`);
                  return value;
                }));
              }
            })(rows);
            count += rows.length;
          }
        } finally { await cursor.close(); }
        const copied = db.prepare(`SELECT count(*) AS count FROM ${quote(table)}`).get().count;
        const sourceCount = Number((await pg.query(`SELECT count(*) AS count FROM public.${quote(table)}`)).rows[0].count);
        if (copied !== count || copied !== sourceCount) throw new Error(`Row count mismatch in ${table}: source=${sourceCount}, read=${count}, SQLite=${copied}`);
        console.log(`${table}: ${copied} rows`);
      }
      const indexes = (await pg.query(`
        SELECT i.relname AS name, t.relname AS table_name, pg_get_indexdef(i.oid) AS definition
        FROM pg_class i JOIN pg_index ix ON ix.indexrelid=i.oid
        JOIN pg_class t ON t.oid=ix.indrelid JOIN pg_namespace n ON n.oid=t.relnamespace
        WHERE n.nspname='public'
      `)).rows;
      for (const index of indexes) {
        const parsed = /^CREATE (UNIQUE )?INDEX .+ ON (?:public\.)?[\w"]+ USING btree (\(.+\))(?: WHERE (.+))?$/.exec(index.definition);
        if (!parsed || !tables.includes(index.table_name)) throw new Error(`Unsupported PostgreSQL index: ${index.definition}`);
        db.exec(`CREATE ${parsed[1] || ''}INDEX ${quote(`pg_${index.name}`)} ON ${quote(index.table_name)} ${parsed[2]}${parsed[3] ? ` WHERE ${parsed[3]}` : ''}`);
      }
      console.log(`PostgreSQL indexes copied: ${indexes.length}`);
      db.pragma('foreign_keys = ON');
      if (db.pragma('foreign_key_check').length) throw new Error('Foreign keys failed after copy');
      await verifyMediaUrls(db);
      db.prepare("INSERT INTO migration_meta (key,value) VALUES ('source','postgres-v1')").run();
      if (db.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('SQLite integrity check failed');
    } finally { db.close(); }
    verifyDatabase(temporary);
    await fs.chown(temporary, owner.uid, owner.gid);
    await fs.chmod(temporary, 0o660);
    const handle = await fs.open(temporary, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
    await pg.query('COMMIT');
    // Hard link atomically refuses to replace an existing SQLite database.
    await fs.link(temporary, target);
    await fs.rm(temporary);
    temporary = undefined;
    applyRuntimeMigrations(target);
    console.log(`Published ${target}`);
  } finally {
    await pg.end();
  }
}

try { await migrate(); }
catch (error) {
  console.error('Migration failed:', error);
  process.exitCode = 1;
} finally {
  if (temporary) await fs.rm(temporary, { force: true }).catch(console.error);
}
