#!/usr/bin/env bash
# Server side of deploy.sh; runs on the target (Linux) from an unpacked bundle:
#   remote.sh dry-run  <dir> <tag> <bundle-dir> [--colima]
#   remote.sh deploy   <dir> <tag> <bundle-dir> [--colima] [--test-fail-smoke | --test-fail-snapshot]
#   remote.sh rollback <dir> <ts>  <bundle-dir> [--colima] [--accept-loss]
# <bundle-dir> holds docker/ from the fork's merge-base and selfhost/server/ from HEAD.
# The deploy is a cold snapshot: the whole stack goes down, both volumes are copied, and a
# rollback restores both, so the database and the bucket always match.
set -euo pipefail

mode="${1:?mode}"
dir="${2:?dir}"
arg="${3:?tag or ts}"
bundle="${4:?bundle dir}"
shift 4
colima=0 accept_loss=0 fail_smoke=0 fail_snapshot=0
for a in "$@"; do
  case "$a" in
    --colima) colima=1 ;;
    --accept-loss) accept_loss=1 ;;
    --test-fail-smoke) fail_smoke=1 ;;
    --test-fail-snapshot) fail_snapshot=1 ;;
    *) echo "remote: unknown flag $a" >&2; exit 2 ;;
  esac
done
srv="$bundle/selfhost/server"
maint="$srv/compose.maintenance.yaml"
project=readest

log() { echo "remote: $*" >&2; }
die() { log "$*"; exit 1; }

if [[ "$mode" == rollback && $accept_loss -ne 1 ]]; then
  log "rollback to $arg loses every write made after that snapshot; repeat with --accept-loss"
  exit 2
fi
# A rollback must work even when a failed deploy left <dir> half-written; it only needs the snapshots.
if [[ "$mode" == rollback ]]; then
  [[ -d "$dir/backups" ]] || die "$dir/backups does not exist"
else
  [[ -d "$dir" && -f "$dir/.env" && -f "$dir/compose.yaml" ]] || die "$dir is not a Readest stack"
fi

# Compose for the files currently in <dir>; "maint" adds the maintenance overlay last.
dc() {
  local maint_flag=()
  if [[ "${1:-}" == maint ]]; then maint_flag=(-f "$maint"); shift; fi
  local files=(-f "$dir/compose.yaml")
  [[ -f "$dir/compose.override.yaml" ]] && files+=(-f "$dir/compose.override.yaml")
  [[ $colima -eq 1 && -f "$dir/compose.colima.yaml" ]] && files+=(-f "$dir/compose.colima.yaml")
  docker compose --project-directory "$dir" --env-file "$dir/.env" "${files[@]}" "${maint_flag[@]}" "$@"
}

envval() { grep -E "^$1=" "${2:-$dir/.env}" | head -1 | cut -d= -f2- | sed -E "s/^['\"](.*)['\"]$/\\1/"; }

# Invariant projection of a compose config: what a deploy must not change. Bind-mount sources are
# left out (they move with the project dir), and so is the client image (that is the upgrade).
projection() {
  python3 -c '
import json, sys
c = json.load(sys.stdin)
out = {"volumes": sorted(k + "=" + str((v or {}).get("name")) for k, v in (c.get("volumes") or {}).items()), "project": c.get("name"), "networks": sorted((c.get("networks") or {}).keys()), "services": {}}
for name, s in sorted(c["services"].items()):
    labels = s.get("labels") or {}
    out["services"][name] = {
        "container_name": s.get("container_name"),
        "ports": sorted(str(p.get("published")) + ":" + str(p.get("target")) for p in s.get("ports") or []),
        "networks": sorted((s.get("networks") or {}).keys()),
        "named_volumes": sorted(v["source"] + ":" + v["target"] for v in s.get("volumes") or [] if v.get("type") == "volume"),
        "traefik": {k: v for k, v in sorted(labels.items()) if k.startswith("traefik.")},
        "image": None if name == "client" else s.get("image"),
    }
print(json.dumps(out, indent=1, sort_keys=True))
'
}

# Masks every value from .env so a printed config diff leaks no secrets.
mask() {
  python3 -c '
import sys
vals = []
for line in open(sys.argv[1]):
    if "=" in line and not line.lstrip().startswith("#"):
        v = line.split("=", 1)[1].strip().strip("\"'\''")
        if len(v) >= 6: vals.append(v)
vals.sort(key=len, reverse=True)
for line in sys.stdin:
    for v in vals: line = line.replace(v, "***")
    sys.stdout.write(line)
' "$dir/.env"
}

applied_migrations() {
  docker exec supabase-db psql -U postgres -tAc 'select name from readest_meta.migrations order by name' 2>/dev/null || true
}

volume_bytes() {
  docker run --rm -v readest_db-data:/a:ro -v readest_minio-data:/b:ro alpine du -sbc /a /b 2>/dev/null | awk '/total/{print $1}'
}

check_space() {
  local need avail
  need=$(($(volume_bytes) * 3 + 2 * 1024 * 1024 * 1024))
  avail=$(($(df -Pk "$dir" | awk 'NR==2{print $4}') * 1024))
  [[ $avail -ge $need ]] || die "free space $((avail >> 20)) MiB < needed $((need >> 20)) MiB"
  log "free space OK: $((avail >> 20)) MiB (need $((need >> 20)) MiB)"
}

new_tree=""
stage_new_tree() {
  local tag="$1"
  new_tree="$(mktemp -d)"
  cp -a "$bundle/docker/compose.yaml" "$new_tree/"
  cp -a "$bundle/docker/volumes" "$new_tree/volumes"
  [[ -f "$bundle/docker/README.md" ]] && cp -a "$bundle/docker/README.md" "$new_tree/README.md"
  # Kong also sits on the shared coolify network, where bare service names can resolve to other
  # projects' containers; upstream's kong.yml uses them, so point it at this stack's container names.
  sed -i -E 's#http://auth:9999#http://supabase-auth:9999#g; s#http://rest:3000#http://supabase-rest:3000#g' "$new_tree/volumes/api/kong.yml"
  if grep -qE 'http://(auth|rest|kong|db|minio|client):' "$new_tree/volumes/api/kong.yml"; then
    die "kong.yml still routes to a bare service name"
  fi
  local f
  for f in compose.override.yaml wellknown.conf backup.sh README-deploy.md compose.maintenance.yaml compose.colima.yaml smoke.sh remote.sh; do
    [[ -f "$srv/$f" ]] && cp -a "$srv/$f" "$new_tree/$f"
  done
  [[ $colima -eq 1 ]] || rm -f "$new_tree/compose.colima.yaml"
  # AppleDouble files from a macOS tar would be picked up by the migrator's *.sql glob.
  find "$new_tree" -name '._*' -delete
  [[ -d "$dir/wellknown" ]] && cp -a "$dir/wellknown" "$new_tree/wellknown"
  sed -E "s|^READEST_IMAGE=.*|READEST_IMAGE=ghcr.io/readest/readest:$tag|" "$dir/.env" >"$new_tree/.env"
  grep -q "^READEST_IMAGE=ghcr.io/readest/readest:$tag$" "$new_tree/.env" || echo "READEST_IMAGE=ghcr.io/readest/readest:$tag" >>"$new_tree/.env"
  chmod 600 "$new_tree/.env"
}

config_of() {
  local d="$1"
  local files=(-f "$d/compose.yaml")
  [[ -f "$d/compose.override.yaml" ]] && files+=(-f "$d/compose.override.yaml")
  [[ $colima -eq 1 && -f "$d/compose.colima.yaml" ]] && files+=(-f "$d/compose.colima.yaml")
  docker compose --project-directory "$d" --env-file "$d/.env" "${files[@]}" config "${@:2}"
}

step1_checks() {
  local tag="$1"
  stage_new_tree "$tag"
  local cur new
  cur="$(config_of "$dir" --format json | projection)"
  new="$(config_of "$new_tree" --format json | projection)"
  if ! diff <(echo "$cur") <(echo "$new") >/dev/null; then
    diff <(echo "$cur") <(echo "$new") | mask >&2 || true
    die "invariants changed (ports, networks, volumes, container names, Traefik labels or non-client images)"
  fi
  log "invariants: no changes"
  log "config diff (values from .env masked):"
  diff <(config_of "$dir" | sed "s|$dir|<dir>|g") <(config_of "$new_tree" | sed "s|$new_tree|<dir>|g") | mask >&2 || true
  log "file diff:"
  diff -rq "$dir" "$new_tree" 2>/dev/null | grep -v -E "(/backups|\.ops\.lock|/wellknown)" | sed "s|$new_tree|<new>|g" >&2 || true
  local pending
  pending="$(comm -23 <(find "$new_tree/volumes/db/migrations" -name '[0-9]*.sql' -exec basename {} \; | sort) <(applied_migrations | sort))"
  log "migrations to apply: $(echo "$pending" | grep -c . || true)"
  # 029 adds CHECK (file_size >= 0); an old negative row would abort it mid-deploy.
  local negative
  negative="$(docker exec supabase-db psql -U postgres -tAc 'select count(*) from public.files where file_size < 0' 2>/dev/null | tr -d '[:space:]')"
  [[ -z "$negative" || "$negative" == 0 ]] || die "$negative files rows have a negative file_size; fix them before migration 029"
  if [[ -n "$pending" ]]; then while read -r m; do echo "  $m" >&2; done <<<"$pending"; fi
  check_space
}

lock() {
  exec 9>"$dir/.ops.lock"
  flock -n 9 || die "$dir/.ops.lock is held (a backup or another deploy is running)"
}

# Step 0: the old backup.sh has no lock; replace it at a moment cron cannot be starting it.
step0_cron_lock() {
  grep -q 'ops.lock' "$dir/backup.sh" 2>/dev/null && return 0
  local now
  now=$((10#$(date +%H%M)))
  if ((now >= 420 && now <= 440)); then die "too close to the 04:30 backup cron (now $now)"; fi
  pgrep -f "$dir/backup.sh" >/dev/null && die "backup.sh is running"
  cp -a "$srv/backup.sh" "$dir/.backup.sh.new"
  chmod 700 "$dir/.backup.sh.new"
  mv "$dir/.backup.sh.new" "$dir/backup.sh"
  log "step 0: installed backup.sh with the shared lock"
}

wait_db() {
  local i
  for i in $(seq 1 60); do
    if [[ "$(dc "$@" exec -T db psql -U postgres -tAc 'select 1' 2>/dev/null | tr -d '[:space:]')" == 1 ]]; then return 0; fi
    sleep 2
  done
  return 1
}

# Cold snapshot into backups/<prefix>-<ts>. Built in a .partial-* dir and renamed only after every
# archive checked out, so restore never sees a half-written one. Prints the final path.
#   kind=deploy:   image digests (or saved images), backup.sh, then `compose down`
#   kind=rollback: images by tag only, stop whatever runs — works on a broken, half-written stack
# On failure: the dir becomes failed-<ts> and the containers that were running are started again.
snapshot() {
  local prefix="$1" kind="$2" ts snap part
  ts="$(date +%Y%m%d-%H%M%S)"
  while [[ -e "$dir/backups/deploy-$ts" || -e "$dir/backups/rollback-$ts" || -e "$dir/backups/failed-$ts" ]]; do sleep 1; ts="$(date +%Y%m%d-%H%M%S)"; done
  snap="$dir/backups/$prefix-$ts"
  part="$dir/backups/.partial-$prefix-$ts"
  mkdir -p "$dir/backups" && mkdir -m 700 "$part" || return 1
  # Called inside $(...) || ..., where errexit is off: every step checks its own status.
  local running cids cid svc img id digest
  running="$(docker ps -q --filter "label=com.docker.compose.project=$project")" || { snapshot_failed "$part" "$ts" "" "$kind"; return 1; }
  cids="$(docker ps -aq --filter "label=com.docker.compose.project=$project")" || { snapshot_failed "$part" "$ts" "" "$kind"; return 1; }
  if [[ "$kind" == deploy && -z "$cids" ]]; then log "no containers of project $project"; snapshot_failed "$part" "$ts" "" "$kind"; return 1; fi
  : >"$part/images.tsv"
  for cid in $cids; do
    if ! { svc="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "$cid")" &&
      img="$(docker inspect -f '{{.Config.Image}}' "$cid")" &&
      id="$(docker inspect -f '{{.Image}}' "$cid")"; }; then
      snapshot_failed "$part" "$ts" "$running" "$kind"
      return 1
    fi
    digest=tag
    if [[ "$kind" == deploy ]]; then
      if ! digest="$(docker image inspect -f '{{range .RepoDigests}}{{.}} {{end}}' "$id" | awk '{print $1}')"; then
        snapshot_failed "$part" "$ts" "$running" "$kind"
        return 1
      fi
      if [[ -z "$digest" ]]; then
        if ! { mkdir -p "$part/images" && docker save -o "$part/images/$svc.tar" "$id"; }; then
          snapshot_failed "$part" "$ts" "$running" "$kind"
          return 1
        fi
        digest="-"
      fi
    fi
    printf '%s\t%s\t%s\t%s\n' "$svc" "$img" "$id" "$digest" >>"$part/images.tsv" || { snapshot_failed "$part" "$ts" "$running" "$kind"; return 1; }
  done
  if [[ "$kind" == deploy ]]; then
    READEST_OPS_LOCKED=1 "$dir/backup.sh" >&2 || { snapshot_failed "$part" "$ts" "$running" "$kind"; return 1; }
    dc down >&2 || { snapshot_failed "$part" "$ts" "$running" "$kind"; return 1; }
  fi
  stop_project || { snapshot_failed "$part" "$ts" "$running" "$kind"; return 1; }
  tar -C "$dir" --exclude=./backups --exclude=./.ops.lock -czf "$part/config.tgz" . || { snapshot_failed "$part" "$ts" "$running" "$kind"; return 1; }
  if [[ $fail_snapshot -eq 1 ]]; then
    log "test hook: failing the snapshot after down"
    snapshot_failed "$part" "$ts" "$running" "$kind"
    return 1
  fi
  local vol
  for vol in db-data minio-data; do
    docker run --rm -v "${project}_$vol:/v:ro" -v "$part:/s" alpine sh -c "tar -C /v -cf /s/$vol.tar . && tar -tf /s/$vol.tar >/dev/null" ||
      { snapshot_failed "$part" "$ts" "$running" "$kind"; return 1; }
  done
  mv -T "$part" "$snap" || { snapshot_failed "$part" "$ts" "$running" "$kind"; return 1; }
  log "snapshot $snap"
  echo "$snap"
}

snapshot_failed() {
  local part="$1" ts="$2" running="$3" kind="$4"
  mv -T "$part" "$dir/backups/failed-$ts" 2>/dev/null || true
  log "snapshot failed (kept as backups/failed-$ts); starting the previous stack again"
  # Before a deploy the stack ran its normal config; before a rollback it may have been closed on
  # purpose, so only the very containers that were running come back.
  if [[ "$kind" == deploy && -f "$dir/compose.yaml" && -f "$dir/.env" ]] && dc up -d --pull never >&2; then return 0; fi
  if [[ -n "$running" ]]; then
    # shellcheck disable=SC2086
    docker start $running >&2 && return 0
  fi
  log "could not start the previous stack — check $dir by hand"
}

smoke() {
  bash "$srv/smoke.sh" "$dir" "$@"
}

# Routes are closed when every public path answers with the wellknown nginx 404.
probe_closed() {
  [[ $colima -eq 1 ]] && return 0
  local host path code body
  host="$(envval SITE_URL)"
  for path in /api/storage/list /auth/v1/health /rest/v1/ /readest-files/; do
    body="$(mktemp)"
    code="$(curl -s -o "$body" -w '%{http_code}' --max-time 15 "$host$path" || true)"
    if [[ "$code" != 404 ]] || ! grep -q '<center>nginx' "$body"; then
      rm -f "$body"
      log "$host$path is still served (HTTP $code)"
      return 1
    fi
    rm -f "$body"
  done
  log "public routes closed"
}

probe_open() {
  [[ $colima -eq 1 ]] && return 0
  local host anon
  host="$(envval SITE_URL)"
  anon="$(envval ANON_KEY)"
  curl -fsS --max-time 15 "$host/.well-known/readest-client-config.json" | python3 -c '
import json, sys
c = json.load(sys.stdin)
assert all(isinstance(c.get(k), str) and c[k].strip() for k in ("apiBaseUrl", "supabaseUrl", "supabaseAnonKey"))
' || return 1
  curl -fsS --max-time 15 -o /dev/null -H "apikey: $anon" "$host/auth/v1/health" || return 1
  log "public routes open and healthy"
}

# Stops every running container of the project, whatever config is on disk; fails if Docker can't tell.
stop_project() {
  local running
  running="$(docker ps -q --filter "label=com.docker.compose.project=$project")" || return 1
  if [[ -n "$running" ]]; then
    # shellcheck disable=SC2086
    docker stop $running >&2 || return 1
  fi
  running="$(docker ps -q --filter "label=com.docker.compose.project=$project")" || return 1
  [[ -z "$running" ]]
}

# Checks a snapshot and makes every image it ran available locally; changes nothing else.
restore_preflight() {
  local snap="$1"
  [[ -f "$snap/config.tgz" && -f "$snap/db-data.tar" && -f "$snap/minio-data.tar" && -f "$snap/images.tsv" ]] || die "$snap is incomplete"
  # Read every archive to the end now: a truncated one must fail before the stack is touched.
  if ! { gzip -t "$snap/config.tgz" && tar -tzf "$snap/config.tgz" >/dev/null &&
    tar -tf "$snap/db-data.tar" >/dev/null && tar -tf "$snap/minio-data.tar" >/dev/null; }; then
    die "$snap has a damaged archive; nothing restored"
  fi
  local svc img id digest
  while IFS=$'\t' read -r svc img id digest; do
    case "$digest" in
      tag) ;;
      -) docker image inspect "$id" >/dev/null 2>&1 || docker load -i "$snap/images/$svc.tar" >&2 || die "cannot load the saved image of $svc; nothing restored" ;;
      *) docker image inspect "$id" >/dev/null 2>&1 || docker pull "$digest" >&2 || die "cannot pull $digest; nothing restored" ;;
    esac
    docker image inspect "$id" >/dev/null 2>&1 || die "image $img ($id) of $svc is not available; nothing restored"
  done <"$snap/images.tsv"
}

restore() {
  local snap="$1"
  local svc img id digest
  restore_preflight "$snap"
  log "restoring $snap"
  if [[ -f "$dir/compose.yaml" && -f "$dir/.env" ]]; then dc down >&2 || true; fi
  # Volumes are wiped below: nothing of the project may still be running, whatever config is on disk.
  stop_project || die "cannot stop the running stack; nothing restored"
  find "$dir" -mindepth 1 -maxdepth 1 ! -name backups ! -name .ops.lock ! -name backup.sh -exec rm -rf {} +
  tar -C "$dir" --exclude=./backup.sh -xzf "$snap/config.tgz"
  # The cron job needs a backup.sh with the shared lock, whatever this snapshot carried.
  if ! grep -q 'ops.lock' "$dir/backup.sh" 2>/dev/null; then
    cp -a "$srv/backup.sh" "$dir/.backup.sh.new" && chmod 700 "$dir/.backup.sh.new" && mv "$dir/.backup.sh.new" "$dir/backup.sh"
  fi
  while IFS=$'\t' read -r svc img id digest; do
    docker tag "$id" "$img"
  done <"$snap/images.tsv"
  local vol
  for vol in db-data minio-data; do
    docker run --rm -v "${project}_$vol:/v" -v "$snap:/s:ro" alpine sh -c "find /v -mindepth 1 -delete && tar -C /v -xf /s/$vol.tar"
  done
  dc maint up -d --pull never >&2
  wait_db maint || die "database did not come back; the stack stays closed"
  smoke || die "smoke failed on the restored stack; the stack stays closed"
  dc up -d --pull never >&2
  probe_open || { dc maint up -d --pull never >&2; die "restored stack is not reachable from outside; closed again"; }
  log "restored $snap"
}

rotate() {
  local current keep=() snap img
  current="$(envval READEST_IMAGE)"
  mapfile -t snaps < <(find "$dir/backups" -maxdepth 1 -type d -name 'deploy-*' | sort -r)
  local i=0 prev_kept=0
  for snap in "${snaps[@]}"; do
    img="$(awk -F'\t' '$1=="client"{print $2}' "$snap/images.tsv" 2>/dev/null)"
    if [[ $i -lt 3 ]]; then keep+=("$snap")
    elif [[ $prev_kept -eq 0 && -n "$img" && "$img" != "$current" ]]; then keep+=("$snap"); prev_kept=1
    fi
    [[ $i -lt 3 && -n "$img" && "$img" != "$current" ]] && prev_kept=1
    i=$((i + 1))
  done
  for snap in "${snaps[@]}"; do
    if [[ ! " ${keep[*]} " == *" $snap "* ]]; then rm -rf "$snap"; log "removed old snapshot $snap"; fi
  done
}

case "$mode" in
  dry-run)
    step1_checks "$arg"
    grep -q 'ops.lock' "$dir/backup.sh" 2>/dev/null || log "step 0 needed: backup.sh will get the shared lock"
    rm -rf "$new_tree"
    log "dry-run: nothing changed"
    ;;
  deploy)
    lock
    step0_cron_lock
    step1_checks "$arg"
    snap="$(snapshot deploy deploy)" || exit 1
    log "step 3: install files, pull, migrate (closed)"
    if ! { find "$dir" -mindepth 1 -maxdepth 1 ! -name backups ! -name .ops.lock ! -name wellknown ! -name backup.sh -exec rm -rf {} + &&
      cp -a "$new_tree/." "$dir/" && rm -rf "$new_tree" && dc maint pull >&2 && dc maint up -d >&2 && wait_db maint &&
      dc maint exec -T db /docker-entrypoint-initdb.d/zz-readest-migrations.sh >&2 &&
      dc maint exec -T db psql -U postgres -c "NOTIFY pgrst, 'reload schema'" >&2; }; then
      log "step 3 failed; rolling back"
      restore "$snap"
      exit 1
    fi
    if ! probe_closed; then
      dc down >&2
      log "routes were open during the closed phase; rolling back"
      restore "$snap"
      exit 1
    fi
    smoke_args=()
    [[ $fail_smoke -eq 1 ]] && smoke_args+=(--force-fail)
    if ! smoke "${smoke_args[@]}"; then
      log "smoke failed; rolling back"
      restore "$snap"
      exit 1
    fi
    dc up -d >&2
    if ! { probe_open && { [[ $colima -eq 1 ]] || smoke --public "$(envval SITE_URL)"; }; }; then
      dc maint up -d >&2
      die "stack is up but not reachable from outside; closed again. Writes are open since the switch — inspect, then: deploy.sh --rollback $(basename "$snap" | sed 's/^deploy-//') --accept-loss"
    fi
    rotate
    log "deployed $(envval READEST_IMAGE)"
    ;;
  rollback)
    lock
    step0_cron_lock
    [[ -d "$dir/backups/deploy-$arg" && -d "$dir/backups/rollback-$arg" ]] && die "both deploy-$arg and rollback-$arg exist; restore one by hand"
    snap="$dir/backups/deploy-$arg"
    [[ -d "$snap" ]] || snap="$dir/backups/rollback-$arg"
    [[ -d "$snap" ]] || die "no snapshot $arg"
    check_space
    restore_preflight "$snap"
    current="$(snapshot rollback rollback)" || die "could not save the current state; nothing restored"
    log "current state saved to $current"
    restore "$snap"
    ;;
  *) die "unknown mode $mode" ;;
esac
