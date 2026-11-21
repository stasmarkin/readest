#!/bin/sh
# Daily backup of the Readest stack: Postgres dump (14 days kept) + MinIO bucket mirror on the host.
# The mirror never deletes, so files referenced by older dumps stay restorable.
set -eu
umask 077
cd "$(dirname "$0")"
envval() { grep -E "^$1=" .env | head -1 | cut -d= -f2- | sed -E "s/^['\"](.*)['\"]$/\\1/"; }
DB=$(envval POSTGRES_DB)
BUCKET=$(envval S3_BUCKET_NAME)
MUSER=$(envval MINIO_ROOT_USER)
MPASS=$(envval MINIO_ROOT_PASSWORD)
DEST=/opt/readest/backups
TS=$(date +%Y%m%d-%H%M%S)
mkdir -p "$DEST/db" "$DEST/files"
docker exec supabase-db pg_dump -U supabase_admin -d "$DB" -Fc > "$DEST/db/.readest-$TS.dump.tmp"
mv "$DEST/db/.readest-$TS.dump.tmp" "$DEST/db/readest-$TS.dump"
# Credentials go via the environment, not argv, so they don't show up in the process list.
MC_HOST_l="http://$MUSER:$MPASS@readest-minio:9000"
export MC_HOST_l
docker run --rm --network readest_default -v "$DEST/files:/backup" -e MC_HOST_l \
  --entrypoint mc ghcr.io/coollabsio/minio:RELEASE.2025-10-15T17-29-55Z \
  mirror --overwrite --quiet "l/$BUCKET" /backup >/dev/null
find "$DEST/db" -name 'readest-*.dump' -mtime +14 -delete
echo "$(date -Is) backup ok: readest-$TS.dump"
