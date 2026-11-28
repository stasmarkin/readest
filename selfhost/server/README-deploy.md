# Readest self-hosted backend

Backend for the Readest Selfhost clients built from the `stasmarkin/readest` fork (`selfhost/README.md`), served on https://readest.stasmarkin.ru through Coolify's Traefik (network `coolify`); no host ports are published. Secrets live only in `.env` (keep a copy in Vaultwarden). This directory is managed from the fork: edit `selfhost/server/` there, not here.

- Signup is disabled (`DISABLE_SIGNUP=true`). Create users with the admin API: `POST /auth/v1/admin/users` with the `SERVICE_ROLE_KEY`.
- Native clients built before the fork baked the server in discover it via `/.well-known/readest-client-config.json` (nginx `wellknown` service, CORS required); the fork's build scripts read their profile from it too.
- The MinIO route in `compose.override.yaml` hardcodes the bucket path `/readest-files/`; change it together with `S3_BUCKET_NAME`.
- Kong upstreams use container names (`supabase-auth`, `supabase-rest`) because Kong also sits on the shared `coolify` network; the deploy rewrites upstream's `kong.yml` accordingly.

## Upgrade and rollback

From the fork checkout on the Mac (never by hand here):

    bash selfhost/server/deploy.sh --dry-run
    bash selfhost/server/deploy.sh --deploy
    bash selfhost/server/deploy.sh --rollback <ts> --accept-loss

Snapshots: `backups/deploy-<ts>/` (configs, `.env`, image digests, both volumes). Details in the fork's `selfhost/README.md`.

## Backups

Cron `30 4 * * * /opt/readest/backup.sh >> /opt/readest/backups/backup.log 2>&1`: Postgres dumps in `backups/db` (14 days), bucket mirror in `backups/files`. Shares `.ops.lock` with deploys. Backups stay on this host; there is no off-site copy.

## Exposure

Only what native clients need is routed: `/api/*` (minus `/api/opds/`, `/api/stripe/` and `/api/gift/`), `/auth/v1/`, `/rest/v1/`, `/readest-files/`, `/.well-known/readest-client-config.json`. Everything else, including the browser UI, returns 404 from the `wellknown` nginx catch-all. All public tables have RLS; anonymous REST reads return empty lists.
