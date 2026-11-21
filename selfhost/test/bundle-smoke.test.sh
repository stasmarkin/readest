#!/usr/bin/env bash
# Tests for selfhost/bundle-smoke.sh on synthetic bundles. Run: bash selfhost/test/bundle-smoke.test.sh
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SMOKE="$HERE/../bundle-smoke.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/app"
POSTHOG_RAW="phc_testkey_123456"
STRIPE_RAW="pk_live_teststripe_987"
POSTHOG_B64="$(printf '%s' "$POSTHOG_RAW" | base64)"
STRIPE_B64="$(printf '%s' "$STRIPE_RAW" | base64)"
printf 'NEXT_PUBLIC_DEFAULT_POSTHOG_KEY_BASE64=%s\nNEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY_BASE64=%s\n' "$POSTHOG_B64" "$STRIPE_B64" >"$TMP/app/.env"
export READEST_APP_DIR="$TMP/app" NEXT_PUBLIC_API_BASE_URL=https://readest.example.org \
  NEXT_PUBLIC_SUPABASE_URL=https://readest.example.org NEXT_PUBLIC_SUPABASE_ANON_KEY=anon-xyz

pass=0
fail=0
bundle() { rm -rf "$TMP/out" && mkdir -p "$TMP/out" && printf '%s\n' "$@" >"$TMP/out/chunk.js"; }
expect() {
  local want="$1" name="$2" got=ok
  bash "$SMOKE" "$TMP/out" 2>/dev/null || got=fail
  if [[ $got == "$want" ]]; then pass=$((pass + 1)); echo "PASS $name"; else fail=$((fail + 1)); echo "FAIL $name (got $got)"; fi
}

bundle 'a="https://readest.example.org/api"' 'b="anon-xyz"'
expect ok "clean bundle"
bundle 'a="https://readest.example.org"' 'b="anon-xyz"' "c=\"$POSTHOG_B64\""
expect fail "posthog base64 literal"
bundle 'a="https://readest.example.org"' 'b="anon-xyz"' "c=\"$STRIPE_RAW\""
expect fail "decoded stripe key"
bundle 'b="anon-xyz"'
expect fail "missing api origin"
bundle 'a="https://readest.example.org"'
expect fail "missing anon key"
echo "passed=$pass failed=$fail"
[[ $fail -eq 0 ]]
