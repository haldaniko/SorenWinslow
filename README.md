# Soren Winslow Review

Literary and entertainment review blog: a sharp “Michelin Guide” for books and TV series.

## Local Docker Run

1. Copy env files:
   `cp .env.example .env`
   `cp backend/.env.example backend/.env`
   `cp frontend/.env.example frontend/.env`
2. Generate secrets:
   `npm --prefix backend run generate-secrets`
3. Add `JWT_SECRET`, `REFRESH_TOKEN_SECRET`, and optionally `OPENROUTER_API_KEY` to `backend/.env`.
4. Start everything:
   `docker compose up --build -d`
5. Open frontend at `http://localhost:5173`.

## Superadmin

Set `ADMIN_EMAIL` and `ADMIN_PASSWORD` in env, then run:
`docker compose run --rm admin-seed`

The hidden admin page is `/admin`. There is no public Admin link.

## OpenRouter

Set `OPENROUTER_API_KEY` in `backend/.env`. The default model is `meta-llama/llama-3.1-8b-instruct`.

## Endpoints

- `POST /api/auth/login`
- `POST /api/auth/refresh`
- `POST /api/auth/logout`
- `GET /api/posts`
- `GET /api/posts/:slug`
- `GET /api/admin/posts`
- `POST /api/admin/posts`
- `PUT /api/admin/posts/:id`
- `DELETE /api/admin/posts/:id`
- `GET /api/admin/settings`
- `PUT /api/admin/settings`
- `POST /api/ai/generate-now`
- `POST /api/subscribers`
- `GET /api/health`

## Production

Keep the existing `.env` and `backend/.env.production` on the server; they contain secrets and are ignored by Git. The PostgreSQL credentials in `.env` are still needed for the one-time import. Keep the same Compose project name and project directory used by the old deployment so the existing `sorenwinslow_prod_postgres_data` and `sorenwinslow_prod_uploads` volumes are found. If the old deployment used `COMPOSE_PROJECT_NAME`, keep its value.

Before updating the code, stop the old writers and back up both source volumes and any existing host SQLite/media files. Run these commands from the **current production project directory** on Linux:

```sh
docker compose -f docker-compose.prod.yml stop frontend backend postgres
backup_dir="$(dirname "$PWD")/sorenwinslow-backup-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$backup_dir"
docker run --rm --volumes-from "$(docker compose -f docker-compose.prod.yml ps -a -q postgres)" -v "$backup_dir:/backup" alpine tar -czf /backup/postgres-volume.tar.gz -C /var/lib/postgresql/data .
docker run --rm --volumes-from "$(docker compose -f docker-compose.prod.yml ps -a -q backend)" -v "$backup_dir:/backup" alpine tar -czf /backup/uploads-volume.tar.gz -C /app/uploads .
for item in db.sqlite3 db.sqlite3-journal db.sqlite3-wal db.sqlite3-shm media; do
  if [ -e "$item" ]; then cp -a "$item" "$backup_dir/"; fi
done
```

Verify both archives exist in `$backup_dir`, then update the code while preserving the existing env files. From the updated project root, the entire cutover is:

```sh
docker compose -f docker-compose.prod.yml up --build -d
```

Compose starts the old PostgreSQL data volume in read-only mode. The `migrate` service reads its six application tables, checks column names, row counts, foreign keys and SQLite integrity, transfers PostgreSQL B-tree indexes, copies the old uploads volume into `./media`, verifies `/uploads/...` references, and publishes a completed temporary SQLite file as `./db.sqlite3`. The backend starts only after `migrate` succeeds. It uses `./db.sqlite3` and `./media` through a host bind mount. SQLite uses DELETE journaling, so its temporary journal file is also on the host. The backend drops privileges to the owner of the project directory before starting.

On later starts the migrator validates `./db.sqlite3` and never overwrites it from PostgreSQL; it only checks/copies missing media. An unexpected source schema, missing referenced media, a conflicting media file, or an invalid existing SQLite file stops the migrator with a nonzero exit code. The source volumes are never deleted. Keep the backup until the application and uploaded images have been checked. The existing `admin-seed` service is now optional (`--profile admin-tools`) so normal `up` does not reset the admin password.

## Database And Backup

Production runtime data is in host files `./db.sqlite3` and `./media`. Back up the SQLite file while the backend is stopped, together with `./media`. The original PostgreSQL and uploads volumes remain available for rollback and must not be removed with `docker compose down -v`.
