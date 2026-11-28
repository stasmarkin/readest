#!/usr/bin/env bash
# Tests for selfhost/build-env.sh. Run: bash selfhost/test/build-env.test.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_ENV="$HERE/../build-env.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
APP="$TMP/app"
mkdir -p "$APP"

pass=0
fail=0
ok() { pass=$((pass + 1)); echo "PASS $1"; }
ko() { fail=$((fail + 1)); echo "FAIL $1"; }

# Runs build-env in a clean subshell; prints the given variables after a successful source.
run() {
  # shellcheck disable=SC2016 # the inner script expands its own variables
  env -i PATH="$PATH" HOME="$HOME" READEST_APP_DIR="$APP" BUILD_ENV="$BUILD_ENV" "$@" bash -c '
    set -euo pipefail
    SENTRY_DSN=preset SENTRY_AUTH_TOKEN=preset NEXT_PUBLIC_DIST_CHANNEL=playstore
    export SENTRY_DSN SENTRY_AUTH_TOKEN NEXT_PUBLIC_DIST_CHANNEL
    source "$BUILD_ENV"
    for v in NEXT_PUBLIC_API_BASE_URL NEXT_PUBLIC_NODE_BASE_URL NEXT_PUBLIC_SUPABASE_URL \
      NEXT_PUBLIC_SUPABASE_ANON_KEY NEXT_PUBLIC_SELF_HOSTED NEXT_PUBLIC_DISABLE_UPDATER \
      NEXT_PUBLIC_DEFAULT_POSTHOG_KEY_BASE64 NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY_BASE64 NEXT_PUBLIC_POSTHOG_KEY; do
      printf "%s=%s\n" "$v" "${!v-<unset>}"
    done
    for v in SENTRY_DSN SENTRY_AUTH_TOKEN NEXT_PUBLIC_DIST_CHANNEL; do printf "%s=%s\n" "$v" "${!v-<unset>}"; done
  ' 2>"$TMP/stderr"
}

expect_ok() {
  local name="$1"
  shift
  local out
  if out="$(run "$@")"; then
    echo "$out" >"$TMP/out"
    ok "$name"
  else
    ko "$name (exit≠0: $(cat "$TMP/stderr"))"
    : >"$TMP/out"
  fi
}

expect_fail() {
  local name="$1"
  shift
  if run "$@" >/dev/null; then ko "$name (expected failure)"; else ok "$name"; fi
}

has() { if grep -qxF "$1" "$TMP/out"; then ok "  $1"; else ko "  $1"; fi; }

json() { printf '%s' "$1" >"$TMP/config.json"; }

EXPL=(READEST_SELFHOST_API_URL=http://localhost:3000 READEST_SELFHOST_SUPABASE_URL=http://localhost:8000 READEST_SELFHOST_ANON_KEY=anon-key-123)

# (1) explicit profile exports everything and clears telemetry/payment defaults
expect_ok "explicit profile" "${EXPL[@]}"
has "NEXT_PUBLIC_API_BASE_URL=http://localhost:3000"
has "NEXT_PUBLIC_NODE_BASE_URL=http://localhost:3000"
has "NEXT_PUBLIC_SUPABASE_URL=http://localhost:8000"
has "NEXT_PUBLIC_SUPABASE_ANON_KEY=anon-key-123"
has "NEXT_PUBLIC_SELF_HOSTED=true"
has "NEXT_PUBLIC_DISABLE_UPDATER=1"
has "NEXT_PUBLIC_DEFAULT_POSTHOG_KEY_BASE64="
has "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY_BASE64="
has "NEXT_PUBLIC_POSTHOG_KEY="
has "SENTRY_DSN=<unset>"
has "SENTRY_AUTH_TOKEN=<unset>"
has "NEXT_PUBLIC_DIST_CHANNEL=<unset>"

# (2) partial explicit set
expect_fail "two of three explicit" READEST_SELFHOST_API_URL=http://localhost:3000 READEST_SELFHOST_SUPABASE_URL=http://localhost:8000

# (3) empty / blank explicit anon key
expect_fail "explicit empty anon key" READEST_SELFHOST_API_URL=http://localhost:3000 READEST_SELFHOST_SUPABASE_URL=http://localhost:8000 READEST_SELFHOST_ANON_KEY=
expect_fail "explicit blank anon key" READEST_SELFHOST_API_URL=http://localhost:3000 READEST_SELFHOST_SUPABASE_URL=http://localhost:8000 "READEST_SELFHOST_ANON_KEY=   "

W=(READEST_SELFHOST_URL=https://readest.example.org READEST_SELFHOST_CONFIG_FILE="$TMP/config.json")

# well-known happy path
json '{"apiBaseUrl":"https://readest.example.org","supabaseUrl":"https://readest.example.org/","supabaseAnonKey":"k"}'
expect_ok "well-known profile" "${W[@]}"
has "NEXT_PUBLIC_SUPABASE_URL=https://readest.example.org"

# (4) blank key in JSON
json '{"apiBaseUrl":"https://readest.example.org","supabaseUrl":"https://readest.example.org","supabaseAnonKey":"  "}'
expect_fail "json blank anon key" "${W[@]}"

# (5) null and non-string
json '{"apiBaseUrl":null,"supabaseUrl":"https://readest.example.org","supabaseAnonKey":"k"}'
expect_fail "json null" "${W[@]}"
json '{"apiBaseUrl":"https://readest.example.org","supabaseUrl":"https://readest.example.org","supabaseAnonKey":42}'
expect_fail "json number" "${W[@]}"
json 'not json'
expect_fail "json garbage" "${W[@]}"

# (6) non-http scheme
json '{"apiBaseUrl":"ftp://readest.example.org","supabaseUrl":"https://readest.example.org","supabaseAnonKey":"k"}'
expect_fail "ftp scheme" "${W[@]}"
expect_fail "explicit ftp scheme" READEST_SELFHOST_API_URL=ftp://x READEST_SELFHOST_SUPABASE_URL=http://localhost:8000 READEST_SELFHOST_ANON_KEY=k

# (7) foreign origin
json '{"apiBaseUrl":"https://evil.example.org","supabaseUrl":"https://readest.example.org","supabaseAnonKey":"k"}'
expect_fail "foreign api origin" "${W[@]}"
json '{"apiBaseUrl":"https://readest.example.org","supabaseUrl":"https://x.supabase.co","supabaseAnonKey":"k"}'
expect_fail "foreign supabase origin" "${W[@]}"

# (8) telemetry keys in dotenv files
for file in .env.local .env; do
  for key in SENTRY_DSN NEXT_PUBLIC_POSTHOG_KEY; do
    rm -f "$APP/.env" "$APP/.env.local"
    echo "$key=secretvalue" >"$APP/$file"
    if run "${EXPL[@]}" >/dev/null; then
      ko "$key in $file (expected failure)"
    elif grep -q "$file" "$TMP/stderr" && ! grep -q secretvalue "$TMP/stderr"; then
      ok "$key in $file"
    else
      ko "$key in $file (message: $(cat "$TMP/stderr"))"
    fi
  done
done
rm -f "$APP/.env" "$APP/.env.local"
echo "SENTRY_DSN=" >"$APP/.env"
expect_ok "empty SENTRY_DSN in .env" "${EXPL[@]}"
rm -f "$APP/.env"

# (9) unreachable server without explicit profile
start=$(date +%s)
expect_fail "unreachable server" READEST_SELFHOST_URL=http://127.0.0.1:9
elapsed=$(($(date +%s) - start))
if [[ $elapsed -le 20 ]]; then ok "  fails within 20s ($elapsed s)"; else ko "  took $elapsed s"; fi

# (10) explicit profile works offline
expect_ok "explicit profile with unreachable server" "${EXPL[@]}" READEST_SELFHOST_URL=http://127.0.0.1:9

echo "passed=$pass failed=$fail"
[[ $fail -eq 0 ]]
