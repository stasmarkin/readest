#!/usr/bin/env bash
# Builds a colima test stand that mirrors the production stack as it is today (compose.yaml and
# volumes/ copied read-only from coolify:/opt/readest), with test secrets and empty volumes:
#   bash selfhost/test/stand.sh up      # fresh stand on the production layout (migrations 001-017)
#   bash selfhost/test/stand.sh down    # remove containers and volumes
# Stand dir inside the VM: /home/<user>.linux/readest-stand; clients reach it on localhost:3000/8000/9000.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
secrets="${READEST_STAND_SECRETS:-$HOME/.local/state/readest-selfhost/stand.env}"
# shellcheck disable=SC2016 # expanded inside the VM
vm_dir="$(colima ssh -- sh -c 'echo $HOME')/readest-stand"
cmd="${1:?usage: stand.sh up|down}"

vm() { colima ssh -- bash -c "$1"; }
compose="docker compose --project-directory $vm_dir --env-file $vm_dir/.env -f $vm_dir/compose.yaml -f $vm_dir/compose.override.yaml -f $vm_dir/compose.colima.yaml"

case "$cmd" in
  down)
    vm "[ -d $vm_dir ] && $compose down -v --remove-orphans || true; rm -rf $vm_dir"
    echo "stand: removed $vm_dir"
    ;;
  up)
    [[ -f "$secrets" ]] || { echo "stand: no $secrets" >&2; exit 1; }
    stage="$(mktemp -d "$HOME/.cache/readest-stand.XXXXXX")"
    trap 'rm -rf "$stage"' EXIT
    ssh_opts=(-o RemoteCommand=none -o RequestTTY=no)
    ssh "${ssh_opts[@]}" coolify 'tar -C /opt/readest -cf - compose.yaml volumes wellknown.conf' | tar -x -C "$stage"
    # The production backup.sh as first imported (no lock), so the deploy's step 0 gets exercised.
    # shellcheck disable=SC2016 # literal for the script
    git -C "$root" show b9e67a2dd:selfhost/server/backup.sh | sed 's|DEST=/opt/readest/backups|DEST="$(pwd)/backups"|' >"$stage/backup.sh"
    chmod 700 "$stage/backup.sh"
    cp "$root/selfhost/server/compose.override.yaml" "$root/selfhost/server/compose.colima.yaml" "$stage/"
    # shellcheck disable=SC1090
    source "$secrets"
    mkdir -p "$stage/wellknown"
    printf '{"apiBaseUrl":"http://localhost:3000","supabaseUrl":"http://localhost:8000","supabaseAnonKey":"%s"}' "$ANON_KEY" >"$stage/wellknown/readest-client-config.json"
    sed -E \
      -e "s|^READEST_IMAGE=.*|READEST_IMAGE=ghcr.io/readest/readest:0.11.20|" \
      -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$POSTGRES_PASSWORD|" \
      -e "s|^JWT_SECRET=.*|JWT_SECRET=$JWT_SECRET|" \
      -e "s|^ANON_KEY=.*|ANON_KEY=$ANON_KEY|" \
      -e "s|^SERVICE_ROLE_KEY=.*|SERVICE_ROLE_KEY=$SERVICE_ROLE_KEY|" \
      -e "s|^MINIO_ROOT_PASSWORD=.*|MINIO_ROOT_PASSWORD=$MINIO_ROOT_PASSWORD|" \
      -e "s|^SITE_URL=.*|SITE_URL=http://localhost:3000|" \
      -e "s|^API_EXTERNAL_URL=.*|API_EXTERNAL_URL=http://localhost:8000|" \
      -e "s|^ADDITIONAL_REDIRECT_URLS=.*|ADDITIONAL_REDIRECT_URLS=http://localhost:3000/**,readest://auth-callback|" \
      -e "s|^DISABLE_SIGNUP=.*|DISABLE_SIGNUP=true|" \
      "$root/docker/.env.example" >"$stage/.env"
    chmod 600 "$stage/.env"
    find "$stage" -name '._*' -delete
    vm "docker network inspect coolify >/dev/null 2>&1 || docker network create coolify >/dev/null
      [ -d $vm_dir ] && $compose down -v --remove-orphans >/dev/null 2>&1 || true
      rm -rf $vm_dir && mkdir -p $vm_dir && cp -a $stage/. $vm_dir/ && chmod 600 $vm_dir/.env
      $compose up -d"
    for _ in $(seq 1 60); do
      if vm "docker exec supabase-db psql -U postgres -tAc 'select count(*) from readest_meta.migrations'" 2>/dev/null | grep -qx 17; then
        echo "stand: up at $vm_dir, migrations 001-017 applied"
        exit 0
      fi
      sleep 3
    done
    echo "stand: migrations did not reach 017" >&2
    exit 1
    ;;
  *) echo "usage: stand.sh up|down" >&2; exit 2 ;;
esac
