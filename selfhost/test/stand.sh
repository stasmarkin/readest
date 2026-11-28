#!/usr/bin/env bash
# Builds a colima test stand that mirrors the production stack as it is today (compose.yaml and
# volumes/ copied read-only from coolify:/opt/readest), with test secrets and empty volumes:
#   bash selfhost/test/stand.sh up      # fresh stand on the production layout, image and migrations
#   bash selfhost/test/stand.sh down    # remove containers and volumes
# Stand dir inside the VM: /home/<user>.linux/readest-stand; clients reach it on localhost:3000/8000/9000.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
secrets="${READEST_STAND_SECRETS:-$HOME/.local/state/readest-selfhost/stand.env}"
# shellcheck disable=SC2016 # expanded inside the VM
vm_dir="$(colima ssh -- sh -c 'echo $HOME')/readest-stand"
cmd="${1:?usage: stand.sh up|down}"

vm() { colima ssh -- bash -o pipefail -c "$1"; }
# The stand is the compose project "readest" in the default colima VM. Its containers and volumes
# may only be touched when they are the stand's: containers started from the stand dir, and volumes
# only while the stand marker exists (a stopped foreign project leaves volumes without containers).
owners="$(vm "docker ps -a --filter label=com.docker.compose.project=readest --format '{{.Label \"com.docker.compose.project.working_dir\"}}'")" ||
  { echo "stand: cannot list containers in the VM" >&2; exit 1; }
if [[ -n "$(grep -vxF "$vm_dir" <<<"$owners" | grep . || true)" ]]; then
  echo "stand: compose project 'readest' in this VM is not the stand ($(sort -u <<<"$owners" | tr '\n' ' ')); refusing" >&2
  exit 1
fi
# The marker records the creation time of the stand's volumes and lives outside the stand dir
# (deploys replace that dir): volumes recreated by anyone else no longer match it.
# shellcheck disable=SC2016 # expanded inside the VM
marker='$HOME/.readest-stand-volumes'
vol_ids='docker volume ls -q --filter name=^readest_ | sort | xargs -r docker volume inspect -f "{{.Name}} {{.CreatedAt}}"'
volumes="$(vm "$vol_ids")" || { echo "stand: cannot list volumes in the VM" >&2; exit 1; }
if [[ -n "$volumes" && "$volumes" != "$(vm "cat $marker 2>/dev/null" || true)" ]]; then
  echo "stand: readest_* volumes in this VM are not the stand's (no matching $marker); refusing" >&2
  exit 1
fi
compose="docker compose --project-directory $vm_dir --env-file $vm_dir/.env -f $vm_dir/compose.yaml -f $vm_dir/compose.override.yaml -f $vm_dir/compose.colima.yaml"

case "$cmd" in
  down)
    vm "[ -d $vm_dir ] && $compose down -v --remove-orphans || true; sudo rm -rf $vm_dir $marker"
    echo "stand: removed $vm_dir"
    ;;
  up)
    [[ -f "$secrets" ]] || { echo "stand: no $secrets" >&2; exit 1; }
    stage="$(mktemp -d "$HOME/.cache/readest-stand.XXXXXX")"
    trap 'rm -rf "$stage"' EXIT
    ssh_opts=(-o RemoteCommand=none -o RequestTTY=no)
    ssh "${ssh_opts[@]}" coolify 'tar -C /opt/readest -cf - compose.yaml volumes wellknown.conf' | tar -x -C "$stage"
    # Only the image line of the production .env; its secrets stay on the server.
    prod_image="$(ssh "${ssh_opts[@]}" coolify "grep -E '^READEST_IMAGE=' /opt/readest/.env | cut -d= -f2-")"
    [[ -n "$prod_image" ]] || { echo "stand: no READEST_IMAGE in the production .env" >&2; exit 1; }
    want_migrations="$(find "$stage/volumes/db/migrations" -name '[0-9]*.sql' | wc -l | tr -d ' ')"
    cp "$root/selfhost/server/backup.sh" "$stage/backup.sh"
    chmod 700 "$stage/backup.sh"
    cp "$root/selfhost/server/compose.override.yaml" "$root/selfhost/server/compose.colima.yaml" "$stage/"
    # shellcheck disable=SC1090
    source "$secrets"
    mkdir -p "$stage/wellknown"
    printf '{"apiBaseUrl":"http://localhost:3000","supabaseUrl":"http://localhost:8000","supabaseAnonKey":"%s"}' "$ANON_KEY" >"$stage/wellknown/readest-client-config.json"
    sed -E \
      -e "s|^READEST_IMAGE=.*|READEST_IMAGE=$prod_image|" \
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
      sudo rm -rf $vm_dir && mkdir -p $vm_dir && cp -a $stage/. $vm_dir/ && chmod 600 $vm_dir/.env
      $compose up -d; rc=\$?; $vol_ids >$marker; exit \$rc"
    for _ in $(seq 1 60); do
      if vm "docker exec supabase-db psql -U postgres -tAc 'select count(*) from readest_meta.migrations'" 2>/dev/null | grep -qx "$want_migrations"; then
        echo "stand: up at $vm_dir on $prod_image, $want_migrations migrations applied"
        exit 0
      fi
      sleep 3
    done
    echo "stand: migrations did not reach $want_migrations" >&2
    exit 1
    ;;
  *) echo "usage: stand.sh up|down" >&2; exit 2 ;;
esac
