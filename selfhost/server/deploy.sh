#!/usr/bin/env bash
# shellcheck disable=SC2029 # ssh command strings are built locally on purpose
# Deploys the Readest server stack at the fork's upstream base, from the Mac:
#   deploy.sh --dry-run | --deploy | --rollback <ts> [--accept-loss]
#             [--target ssh:coolify:/opt/readest | colima:<dir>] [--test-fail-smoke | --test-fail-snapshot]
# The client image is ghcr.io/readest/readest:sha-<merge-base>, docker/ comes from that same commit,
# selfhost/server/ from HEAD. The work happens in remote.sh on the target (see selfhost/README.md).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"

die() { echo "deploy: $*" >&2; exit 1; }

mode="" ts="" accept_loss=0 target="ssh:coolify:/opt/readest" test_flag=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) mode=dry-run; shift ;;
    --deploy) mode=deploy; shift ;;
    --rollback) mode=rollback; ts="${2:?--rollback needs a snapshot timestamp}"; shift 2 ;;
    --accept-loss) accept_loss=1; shift ;;
    --target) target="${2:?}"; shift 2 ;;
    --test-fail-smoke | --test-fail-snapshot) test_flag="$1"; shift ;;
    *) die "unknown argument $1" ;;
  esac
done
[[ -n "$mode" ]] || die "choose --dry-run, --deploy or --rollback <ts>"

case "$target" in
  ssh:*:*) kind=ssh; host="${target#ssh:}"; host="${host%%:*}"; dir="${target#ssh:*:}" ;;
  colima:*) kind=colima; dir="${target#colima:}" ;;
  *) die "bad --target $target" ;;
esac
if [[ -n "$test_flag" && ! ($mode == deploy && $kind == colima) ]]; then
  die "$test_flag is only allowed with --deploy --target colima:<dir>"
fi
if [[ "$mode" == rollback && $accept_loss -ne 1 ]]; then
  echo "deploy: rollback to $ts loses every write made after that snapshot; repeat with --accept-loss" >&2
  exit 2
fi

base="$(git -C "$root" merge-base HEAD upstream/main)"
tag="sha-${base:0:7}"
if [[ "$mode" != rollback ]]; then
  docker manifest inspect "ghcr.io/readest/readest:$tag" >/dev/null 2>&1 ||
    die "image ghcr.io/readest/readest:$tag is not published (yet)"
fi

# Bundle: docker/ at the base, selfhost/server at HEAD. Uncommitted changes are not deployed.
stage="$(mktemp -d "$HOME/.cache/readest-selfhost-deploy.XXXXXX" 2>/dev/null || { mkdir -p "$HOME/.cache" && mktemp -d "$HOME/.cache/readest-selfhost-deploy.XXXXXX"; })"
trap 'rm -rf "$stage"' EXIT
git -C "$root" archive "$base" docker | tar -x -C "$stage"
git -C "$root" archive HEAD selfhost/server | tar -x -C "$stage"
if [[ -n "$(git -C "$root" status --porcelain -- selfhost/server)" ]]; then
  echo "deploy: warning: uncommitted changes in selfhost/server are not part of the bundle" >&2
fi

args=("$mode" "$dir")
if [[ "$mode" == rollback ]]; then args+=("$ts"); else args+=("$tag"); fi
flags=()
[[ $kind == colima ]] && flags+=(--colima)
[[ $accept_loss -eq 1 ]] && flags+=(--accept-loss)
[[ -n "$test_flag" ]] && flags+=("$test_flag")
echo "deploy: $mode $target ($tag)" >&2

if [[ $kind == colima ]]; then
  # colima mounts the Mac's $HOME, so the VM reads the bundle in place.
  colima ssh -- bash "$stage/selfhost/server/remote.sh" "${args[@]}" "$stage" ${flags[@]+"${flags[@]}"}
else
  ssh_opts=(-o RemoteCommand=none -o RequestTTY=no)
  remote_stage="$(ssh "${ssh_opts[@]}" "$host" 'mktemp -d')"
  # COPYFILE_DISABLE: macOS tar would add AppleDouble ._* files, and the migrator globs *.sql.
  COPYFILE_DISABLE=1 tar -C "$stage" -cf - . | ssh "${ssh_opts[@]}" "$host" "tar -x -C '$remote_stage'"
  status=0
  ssh "${ssh_opts[@]}" "$host" "bash '$remote_stage/selfhost/server/remote.sh' ${args[*]} '$remote_stage' ${flags[*]+${flags[*]}}" || status=$?
  ssh "${ssh_opts[@]}" "$host" "rm -rf '$remote_stage'" || true
  exit $status
fi
