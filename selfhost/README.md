# Readest Selfhost

Fork-only rails that point Readest at our own server (`https://readest.stasmarkin.ru`) with no payments, telemetry, updater or Readest cloud. Everything fork-specific lives here; upstream code only gets small patches behind `isSelfHosted()` and `NEXT_PUBLIC_DISABLE_UPDATER`.

## Clients

| What | Command | Result |
|---|---|---|
| macOS | `bash selfhost/build-macos.sh` | `target/release/bundle/macos/Readest Selfhost.app` (`com.readest.selfhost`) |
| Android | `bash selfhost/build-android.sh` | `~/Downloads/readest-selfhost-<version>-<sha>.apk` (`com.readest.selfhost`, arm64; localhost test builds go to `~/.config/readest-selfhost/test/`) |

- The server address and anon key are baked in at build time from `https://readest.stasmarkin.ru/.well-known/readest-client-config.json` (`READEST_SELFHOST_URL` overrides the host). For a test build set all three of `READEST_SELFHOST_API_URL`, `READEST_SELFHOST_SUPABASE_URL`, `READEST_SELFHOST_ANON_KEY`; no network is needed then.
- `build-env.sh` refuses to build if `apps/readest-app/.env.local` or `.env` sets `SENTRY_DSN` or `NEXT_PUBLIC_POSTHOG_KEY`.
- Android needs `ANDROID_HOME` (default `/opt/homebrew/share/android-commandlinetools`), NDK `28.2.13676358`, `rustup target add aarch64-linux-android`, JDK 17. The signing key is created on the first run in `~/.config/readest-selfhost/android.{jks,properties}` — keep both in Vaultwarden; a new key means uninstalling the app before installing the next APK.
- Installing the macOS app: back up `~/Library/Application Support/com.readest.selfhost`, quit the app, replace `/Applications/Readest Selfhost.app`. It reuses the profile of the luoji12103 build with the same id; if its session is not picked up, sign in again.

## Server

The stack in `/opt/readest` on the Coolify host is upstream's `docker/` stack behind Coolify's Traefik (not a Coolify resource). `server/` holds what lives only there (`compose.override.yaml`, `wellknown.conf`, `backup.sh`, `README-deploy.md`) plus the deploy tooling.

```
bash selfhost/server/deploy.sh --dry-run                 # read-only: tag, diffs, pending migrations
bash selfhost/server/deploy.sh --deploy                  # upgrade to ghcr.io/readest/readest:sha-<fork base>
bash selfhost/server/deploy.sh --rollback <ts> --accept-loss
```

- Image `sha-<merge-base(HEAD, upstream/main)>` and `docker/` come from the same upstream commit; `server/` from HEAD (commit before deploying).
- A deploy is a cold snapshot: the stack goes down (minutes of downtime, clients retry), configs, image digests and both volumes go to `backups/deploy-<ts>/`, files are replaced, migrations run with Traefik routes off, the smoke test downloads a book from inside the network, then routes open. Any failure before opening restores the snapshot automatically. A failure after opening only closes the routes again and prints the rollback command.
- Public routes appear only after Traefik sees the containers healthy (kong: ~10 s), so the deploy polls them for up to `READEST_PROBE_TIMEOUT` seconds (default 90).
- Once public-facing services are up in maintenance, a failure stops kong, client and minio and leaves the database up — no rollback over writes they may have taken; run `--deploy` again or `--rollback`. A closed stack stays closed through a failed snapshot.
- `--rollback` restores both volumes from the snapshot, so writes made after it are lost; it saves the current state to `backups/rollback-<ts>/` first.
- Kong's upstreams are rewritten to `supabase-auth`/`supabase-rest`: on the shared `coolify` network bare service names can resolve to other projects' containers.
- `backup.sh` (cron 04:30) and deploys share `.ops.lock`. The first deploy installs the locking `backup.sh` and refuses to run 04:20–04:40.
- Snapshots kept: the last three `deploy-*` plus the latest one of the previous client version.
- Test stand: `bash selfhost/test/stand.sh up` mirrors the production layout, image and migrations on colima (it refuses a `readest` project or volumes that aren't its own) (clients on `localhost:3000/8000/9000`, emulator via `adb reverse`), then `deploy.sh --target colima:<dir>`; `--test-fail-smoke` / `--test-fail-snapshot` exercise the rollback paths there only.

## Network

Normal use (sign-in, library, reading Latin/Cyrillic books, sync, upload/download, profile, About) talks only to our server, plus Google Fonts when the reader loads them. Still Readest-hosted and used only when enabled: Word Lens packs (`cdn.readest.com`, off by default) and CJK fonts (`storage.readest.com`, jsDelivr — CJK books or locale). User-enabled third parties (Edge TTS, Google/Yandex translate, OPDS catalogs, KOSync, …) work as upstream.

## Known limits

- Sharing (`/s/<token>`) builds `web.readest.com` links and the browser UI is not served — sharing does not work.
- Readest Voice, Send to Readest by email and Cloudflare stats compaction need Readest's infrastructure.
- The default translator is DeepL through our server, which has no keys: pick Google, Yandex or a custom translator, or add `DEEPL_FREE_API_KEYS` to the `client` environment in `server/compose.override.yaml` and redeploy.
- OAuth buttons on the sign-in screen are not configured; sign in with email and password. iOS, Windows and Linux are not built.
- After the server upgrade the luoji12103 0.11.20 clients are not guaranteed to sync — replace them.
