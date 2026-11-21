# Readest self-hosted backend

Backend for the luoji12103/readest-self-hosted 0.11.20 clients, served on https://readest.stasmarkin.ru through Coolify's Traefik (network `coolify`); no host ports are published. Secrets live only in `.env` (keep a copy in Vaultwarden).

- Signup is disabled (`DISABLE_SIGNUP=true`). Create users with the admin API: `POST /auth/v1/admin/users` with the `SERVICE_ROLE_KEY`.
- Native clients discover the server via `/.well-known/readest-client-config.json` (nginx `wellknown` service, CORS required).
- The MinIO route in `compose.override.yaml` hardcodes the bucket path `/readest-files/`; change it together with `S3_BUCKET_NAME`.
- Kong upstreams use container names (`supabase-auth`, `supabase-rest`) because Kong also sits on the shared `coolify` network.

## Upgrade

The migration hook only runs on an empty database volume. After changing `READEST_IMAGE` and copying the matching upstream `docker/volumes/db/migrations/*.sql`:

    ./backup.sh
    docker compose pull && docker compose up -d
    docker compose exec db /docker-entrypoint-initdb.d/zz-readest-migrations.sh

## Backups

Cron `30 4 * * * /opt/readest/backup.sh >> /opt/readest/backups/backup.log 2>&1`: Postgres dumps in `backups/db` (14 days), bucket mirror in `backups/files`. Backups stay on this host; there is no off-site copy.

## Exposure

Only what native clients need is routed: `/api/*` (minus `/api/opds/` and `/api/stripe/`), `/auth/v1/`, `/rest/v1/`, `/readest-files/`, `/.well-known/readest-client-config.json`. Everything else, including the browser UI, returns 404 from the `wellknown` nginx catch-all. All public tables have RLS; anonymous REST reads return empty lists.
