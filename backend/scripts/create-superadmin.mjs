import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import { readFileSync } from 'fs';
import path from 'path';

const email = process.env.LOCAL_SUPERADMIN_EMAIL || process.env.SUPERADMIN_EMAIL;
const password = process.env.LOCAL_SUPERADMIN_PASSWORD || process.env.SUPERADMIN_PASSWORD;
if (!email || !password) throw new Error('Set LOCAL_SUPERADMIN_EMAIL and LOCAL_SUPERADMIN_PASSWORD');
const file = process.env.SQLITE_PATH || path.resolve('db.sqlite3');
const db = new Database(file, { fileMustExist: process.env.NODE_ENV === 'production' });
try {
  if (process.env.NODE_ENV === 'production') {
    if (db.prepare("SELECT value FROM migration_meta WHERE key='source'").pluck().get() !== 'postgres-v1') {
      throw new Error('Production SQLite has not been migrated');
    }
  } else {
    db.exec(readFileSync(new URL('../sql/sqlite-schema.sql', import.meta.url), 'utf8'));
  }
  const passwordHash = await bcrypt.hash(password, 12);
  db.prepare(`INSERT INTO users (email, password_hash, role) VALUES (?, ?, 'admin')
    ON CONFLICT (email) DO UPDATE SET password_hash = excluded.password_hash`).run(email, passwordHash);
  console.log(`Superadmin ready: ${email}`);
} finally { db.close(); }
