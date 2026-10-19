# Soren Winslow Review

Literary and entertainment review blog: a sharp “Michelin Guide” for books, television, culture, and ideas.

## Environment

The whole project uses one root `.env`. No backend-, frontend-, dev-, or production-specific secret files are read.

```sh
npm run setup:env
```

The command creates `.env` from `.env.sample`, generates strong values for every secret placeholder, and preserves existing non-placeholder secrets. Keep `.env` outside Git. `docker-compose.yml` overrides only local URLs; `docker-compose.prod.yml` uses the public values from `.env`.

Important settings:

- `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD` — legacy PostgreSQL migration source.
- `REDIS_PASSWORD` — Redis authentication used by both Compose stacks.
- `ADMIN_EMAIL`, `ADMIN_PASSWORD` — optional superadmin seed credentials.
- `JWT_SECRET`, `REFRESH_TOKEN_SECRET` — stable and distinct authentication secrets.
- `BOT_INTEGRATION_TOKEN` — dedicated Telegram-bot integration secret.
- `SITE_URL=https://sorenwinslow.com` — public frontend origin used in article/image URLs.
- `VITE_API_URL=https://api.sorenwinslow.com` — browser-facing backend origin.
- `OPENROUTER_API_KEY` and SMTP variables — optional integrations.

## Local Docker Run

```sh
npm run dev:docker
```

Open the frontend at `http://localhost:3000`. The hidden admin page is `/admin`. To seed/update its account:

```sh
docker compose run --rm admin-seed
```

## Telegram Publishing API

The bot API base is `https://api.sorenwinslow.com/api/bot/v1/` (the trailing slash is significant). Every endpoint requires `Authorization: Bearer <BOT_INTEGRATION_TOKEN>`:

- `GET options/`
- `POST articles/`
- `GET articles/<external_id>/`
- `PUT articles/<external_id>/image/`
- `POST articles/<external_id>/publish/`

The site exposes the category slugs `books`, `television`, `culture`, and `business-ideas`; selectable authors are intentionally empty. Articles are created as drafts in the existing `generated_posts` model. The separate `bot_article_deliveries` table only records the stable UUID, request hash, image, and publication state needed for idempotency. Reusing a UUID with identical content returns the existing draft; different content returns `409`.

Images accept JPG, PNG, or WebP up to 10 MiB, are verified by file signature, and are stored under the existing persistent `/uploads/covers` storage. Publication is idempotent and does not change the first publication timestamp. The public article URL is `https://sorenwinslow.com/articles/<slug>`.

To register this site in the bot repository on the same machine, after preparing `.env` run:

```sh
npm run register:bot
```

This preserves existing `SITES_JSON` entries and adds:

```json
{"id":"sorenwinslow","name":"Soren Winslow Review","api_base":"https://api.sorenwinslow.com/api/bot/v1/","token_env":"SORENWINSLOW_INTEGRATION_TOKEN"}
```

It also copies the site token into `SORENWINSLOW_INTEGRATION_TOKEN` in the bot `.env` without printing it.

## Other endpoints

- `POST /api/auth/login`, `/refresh`, `/logout`
- `GET /api/posts`, `/api/posts/:slug`
- `GET|POST /api/admin/posts`, `PUT|DELETE /api/admin/posts/:slug`
- `GET|PUT /api/admin/settings`
- `POST /api/ai/generate-now`
- `POST /api/subscribers`
- `GET /api/health`

## Production and migration

Keep the same Compose project name and project directory as the old deployment so its `sorenwinslow_prod_postgres_data` and `sorenwinslow_prod_uploads` volumes remain discoverable. Back up both volumes plus any existing `db.sqlite3` and `media` directory before the first cutover. Never run `git clean -fdx` in production because it deletes ignored runtime files, including `.env`.

Deploy from the production project root:

```sh
npm run setup:env
docker compose -f docker-compose.prod.yml up --build -d
```

The first run starts the old PostgreSQL volume read-only, verifies and copies its six application tables into host `./db.sqlite3`, copies uploads to host `./media`, and validates checksums, references, foreign keys, and SQLite integrity. The new bot integration table is an additive migration: it is created automatically for both a newly migrated database and an already-cut-over SQLite database. No destructive migration command is required.

Later starts validate and retain `./db.sqlite3`; they do not recopy PostgreSQL data. Back up `db.sqlite3` while the backend is stopped together with `media/`. The original PostgreSQL and uploads volumes remain available for rollback and must not be removed with `docker compose down -v`.

## Verification

```sh
npm --prefix backend test
npm run build
docker compose config
docker compose -f docker-compose.prod.yml config
```

The backend test suite covers missing/invalid tokens, options, draft creation, repeated creation, payload conflicts, recovery by UUID, image validation/idempotency, publication idempotency, and mutation rejection after publication.
