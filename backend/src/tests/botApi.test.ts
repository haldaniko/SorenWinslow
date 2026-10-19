import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import request from 'supertest';

const temp = mkdtempSync(path.join(os.tmpdir(), 'sorenwinslow-bot-'));
process.env.SQLITE_PATH = path.join(temp, 'test.sqlite3');
process.env.UPLOAD_DIR = path.join(temp, 'uploads');
process.env.SITE_URL = 'https://sorenwinslow.com';
process.env.BOT_INTEGRATION_TOKEN = 'test-integration-token-with-enough-entropy';

const { ensureSchema, db } = require('../services/db') as typeof import('../services/db');
const { createApp } = require('../app') as typeof import('../app');
const app = createApp();
const auth = { Authorization: `Bearer ${process.env.BOT_INTEGRATION_TOKEN}` };

before(async () => ensureSchema());
after(() => { db.close(); rmSync(temp, { recursive: true, force: true }); });

function payload(externalId = randomUUID()) {
  return { external_id: externalId, title: 'A Telegram Review', content: 'First paragraph.\n\nSecond paragraph.', summary: 'Short summary', category_slugs: ['books'], author_slug: null, tag_names: ['Review'] };
}

test('rejects missing and invalid bearer tokens', async () => {
  assert.equal((await request(app).get('/api/bot/v1/options/')).status, 403);
  assert.equal((await request(app).get('/api/bot/v1/options/').set('Authorization', 'Bearer wrong')).status, 403);
  const token = process.env.BOT_INTEGRATION_TOKEN;
  process.env.BOT_INTEGRATION_TOKEN = '';
  assert.equal((await request(app).get('/api/bot/v1/options/').set(auth)).status, 403);
  process.env.BOT_INTEGRATION_TOKEN = token;
});

test('returns bot options', async () => {
  const response = await request(app).get('/api/bot/v1/options/').set(auth);
  assert.equal(response.status, 200);
  assert.equal(response.body.version, 1);
  assert.equal(response.body.site, 'sorenwinslow');
  assert.ok(response.body.categories.length > 0);
  assert.deepEqual(response.body.authors, []);
});

test('creates a draft, recovers it, and detects payload conflicts', async () => {
  const body = payload();
  const created = await request(app).post('/api/bot/v1/articles/').set(auth).send(body);
  assert.equal(created.status, 201);
  assert.equal(created.body.status, 'draft');
  assert.match(created.body.url, /^https:\/\/sorenwinslow\.com\/articles\//);

  const repeated = await request(app).post('/api/bot/v1/articles/').set(auth).send(body);
  assert.equal(repeated.status, 201);
  assert.equal(repeated.body.article_id, created.body.article_id);

  const conflict = await request(app).post('/api/bot/v1/articles/').set(auth).send({ ...body, title: 'Changed' });
  assert.equal(conflict.status, 409);

  const recovered = await request(app).get(`/api/bot/v1/articles/${body.external_id}/`).set(auth);
  assert.equal(recovered.body.article_id, created.body.article_id);
});

test('uploads one validated image and publishes idempotently', async () => {
  const body = payload();
  await request(app).post('/api/bot/v1/articles/').set(auth).send(body).expect(201);
  const invalid = await request(app).put(`/api/bot/v1/articles/${body.external_id}/image/`).set(auth).attach('image', Buffer.from('not-image'), 'bad.jpg');
  assert.equal(invalid.status, 400);

  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const image = await request(app).put(`/api/bot/v1/articles/${body.external_id}/image/`).set(auth).attach('image', png, 'cover.png');
  assert.equal(image.status, 200);
  assert.match(image.body.image_url, /^https:\/\/sorenwinslow\.com\/uploads\/covers\//);
  const repeatedImage = await request(app).put(`/api/bot/v1/articles/${body.external_id}/image/`).set(auth).attach('image', png, 'again.png');
  assert.equal(repeatedImage.body.image_url, image.body.image_url);

  const published = await request(app).post(`/api/bot/v1/articles/${body.external_id}/publish/`).set(auth);
  assert.equal(published.body.status, 'published');
  const slug = new URL(published.body.url).pathname.split('/').pop()!;
  const publicArticle = await request(app).get(`/api/posts/${slug}`);
  assert.equal(publicArticle.status, 200);
  assert.equal(publicArticle.body.data.status, 'published');
  assert.equal(publicArticle.body.data.coverImage, new URL(image.body.image_url).pathname);
  const repeatedPublish = await request(app).post(`/api/bot/v1/articles/${body.external_id}/publish/`).set(auth);
  assert.deepEqual(repeatedPublish.body, published.body);
  assert.equal((await request(app).put(`/api/bot/v1/articles/${body.external_id}/image/`).set(auth).attach('image', png, 'late.png')).status, 409);
});

test('returns 404 for an unknown article', async () => {
  assert.equal((await request(app).get(`/api/bot/v1/articles/${randomUUID()}/`).set(auth)).status, 404);
});
