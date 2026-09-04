# PetabyteAi — Backend

Private-deployment AI agent dashboard. Node/Express proxy in front of
OpenAI, backed by PostgreSQL.

## Quick start

### Option A — Docker (recommended)

```bash
cp .env.example .env
#   edit .env: set DB_PASS, OPENAI_API_KEY, SESSION_SECRET, CORS_ORIGINS
docker compose up -d
docker compose logs -f api
```

The `api` container runs migrations on boot, so a brand-new `db-data`
volume comes up with the baseline schema. Migration phase57-001 locks the
historical bootstrap `admin` account until a real password is set — run
`node reset-admin.js` once after the first boot (prints a random password).

### Option B — Bare metal

Requires Node ≥18 and PostgreSQL ≥13 reachable on the host.

```bash
# Linux / macOS
./install.sh

# Windows
install.bat
```

`install.sh` (and `.bat`) will:

1. Verify Node version
2. `npm ci` (falls back to `npm install`)
3. Copy `.env.example` → `.env` and inject a fresh `SESSION_SECRET`  
   *(pauses here on first run — edit `.env`, then re-run the script)*
4. Probe the DB connection
5. Run migrations

Then:

```bash
npm start
```

## Configuration (.env)

See `.env.example` for the full template. Required vars:

| Var              | What it does                                          |
|------------------|-------------------------------------------------------|
| `OPENAI_API_KEY` | The OpenAI key the server proxies with                |
| `DB_HOST/PORT/NAME/USER/PASS` | PostgreSQL connection                    |
| `SESSION_SECRET` | Signs session tokens. **Rotate = log everyone out**   |
| `CORS_ORIGINS`   | Comma-separated list of allowed browser origins       |

## Migrations

Everything under `./migrations/*.sql` is applied in lexical order on boot.
Each file is recorded in `_meta.schema_migrations` with its SHA-256; if you
edit a file that has already been applied the runner warns loudly but
does **not** re-run — the safe fix is a new forward-patch migration.

```bash
npm run migrate           # apply anything pending
npm run migrate:status    # dry status: applied / pending / modified
```

`phase0-000-initial-schema.sql` is the cold-install baseline (all
`tbl_*` tables, FKs, indexes, plus seed rows for roles / account
statuses / admin user). It's idempotent and safe on populated DBs.

### Regenerating the baseline

```bash
node dump-schema.js > /tmp/new-baseline.sql
# inspect, diff against phase0-000, merge by hand
```

`dump-schema.js` reads information_schema and emits a fresh
`IF NOT EXISTS` script. Use it when the live schema drifts from
what's in `./migrations/`.

## Backup / restore

```bash
./scripts/backup.sh                        # writes ./backups/petabyte_ai-<stamp>.sql.gz
./scripts/backup.sh --quiet                # silent, for cron

./scripts/restore.sh <dump.sql.gz>         # dry run — prints target
./scripts/restore.sh <dump.sql.gz> --yes   # actually drops + reloads
```

Windows has `scripts\backup.bat`. Both scripts read `.env`, require
`pg_dump` / `psql` on PATH, and respect `BACKUP_KEEP` (default 14).

Suggested cron (Linux):
```
0 3 * * *  /srv/petabyte/scripts/backup.sh --quiet
```

## Graceful shutdown

`SIGTERM` / `SIGINT` drain inflight HTTP requests, stop the session
janitor, and close the PG pool before exiting. `docker compose`
sends SIGTERM by default; `stop_grace_period: 30s` in
`docker-compose.yml` gives drain time.

## Health probe

```
GET /api/health    → 200 {"ok":true,...}
```

Used by the container's `HEALTHCHECK` and by any external uptime
monitor.

## Resetting the admin password

If nobody knows the admin password, run the CLI on the server host:

```bash
cd server && node reset-admin.js            # prints a new random password once
cd server && node reset-admin.js --password 'ChooseOne!1'
```

It forces a change on next login. The old documented default (`admin123`)
is retired — see migration phase57-001: any account still carrying that
hash is locked out until a real password is set.
