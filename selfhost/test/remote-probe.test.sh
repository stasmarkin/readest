#!/usr/bin/env bash
# Tests for the public-route probes of selfhost/server/remote.sh with a fake curl that makes
# Traefik's router appear (or vanish) only after a few attempts. Run: bash selfhost/test/remote-probe.test.sh
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REMOTE="$HERE/../server/remote.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin" "$TMP/stack"
printf 'SITE_URL=https://readest.example.org\nANON_KEY=anon\n' >"$TMP/stack/.env"

# Fake curl: answers like the wellknown nginx catch-all (404) until call number $READY_AFTER, then
# like the real routes; with MODE=close the other way round. Counts calls in $TMP/calls.
cat >"$TMP/bin/curl" <<'SH'
#!/usr/bin/env bash
n=$(( $(cat "$CALLS" 2>/dev/null || echo 0) + 1 )); echo "$n" >"$CALLS"
open=0; [[ $n -gt $READY_AFTER ]] && open=1; [[ "$MODE" == close ]] && open=$((1 - open))
out=/dev/stdout fail=0 fmt=""
while [[ $# -gt 0 ]]; do case "$1" in -o) out="$2"; shift 2 ;; -w) fmt="$2"; shift 2 ;; -f|-fs|-fsS) fail=1; shift ;; *) url="$1"; shift ;; esac; done
if [[ $open -eq 1 ]]; then
  case "$url" in */.well-known/*) echo '{"apiBaseUrl":"a","supabaseUrl":"b","supabaseAnonKey":"c"}' >"$out" ;; *) echo ok >"$out" ;; esac
  [[ -n "$fmt" ]] && printf 200
  exit 0
fi
echo '<html><center>nginx</center></html>' >"$out"
[[ -n "$fmt" ]] && printf 404
[[ $fail -eq 1 ]] && exit 22
exit 0
SH
chmod +x "$TMP/bin/curl"

pass=0
fail=0
# Each case runs in its own shell: remote.sh is sourced in library mode with fast polling.
check() {
  local name="$1" want="$2" mode="$3" ready="$4" timeout="$5" fn="$6" got=ok
  rm -f "$TMP/calls"
  PATH="$TMP/bin:$PATH" CALLS="$TMP/calls" MODE="$mode" READY_AFTER="$ready" \
    READEST_REMOTE_LIB=1 READEST_REMOTE_DIR="$TMP/stack" READEST_PROBE_TIMEOUT="$timeout" READEST_PROBE_INTERVAL=0 \
    bash -c 'fn="$2"; source "$1" && "$fn"' _ "$REMOTE" "$fn" >"$TMP/out" 2>&1 || got=fail
  if [[ $got == "$want" ]]; then
    pass=$((pass + 1))
    echo "PASS $name"
  else
    fail=$((fail + 1))
    echo "FAIL $name (got $got): $(tail -2 "$TMP/out")"
  fi
}

# probe_open makes two requests per attempt; the router shows up on the 7th request (4th attempt).
check "open: router registers late" ok open 6 5 probe_open
check "open: router never registers" fail open 1000 1 probe_open
if grep -q 'still not there after 1s' "$TMP/out"; then pass=$((pass + 1)); echo "PASS   timeout message"; else fail=$((fail + 1)); echo "FAIL   timeout message: $(cat "$TMP/out")"; fi
check "open: already open" ok open 0 5 probe_open
# probe_closed checks four paths per attempt; the routes vanish only after 6 requests.
check "closed: routes vanish late" ok close 6 5 probe_closed
check "closed: routes never vanish" fail close 1000 1 probe_closed

echo "passed=$pass failed=$fail"
[[ $fail -eq 0 ]]
