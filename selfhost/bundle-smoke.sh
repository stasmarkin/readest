#!/usr/bin/env bash
# Checks a built web bundle (Next export dir): it targets the profile from build-env.sh and carries
# none of Readest's default telemetry, Supabase or Stripe values (neither base64 literals nor decoded).
#   selfhost/bundle-smoke.sh <out-dir>     (expects NEXT_PUBLIC_API_BASE_URL etc. in the environment)
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
out="${1:?usage: bundle-smoke.sh <out-dir>}"
dotenv="${READEST_APP_DIR:-$here/../apps/readest-app}/.env"
[[ -d "$out" ]] || { echo "bundle-smoke: no $out" >&2; exit 1; }
: "${NEXT_PUBLIC_API_BASE_URL:?}" "${NEXT_PUBLIC_SUPABASE_URL:?}" "${NEXT_PUBLIC_SUPABASE_ANON_KEY:?}"

errors=0
contains() { grep -rqF -- "$1" "$out"; }

for need in "$NEXT_PUBLIC_API_BASE_URL" "$NEXT_PUBLIC_SUPABASE_URL" "$NEXT_PUBLIC_SUPABASE_ANON_KEY"; do
  if ! contains "$need"; then
    echo "bundle-smoke: profile value missing from bundle: ${need:0:24}…" >&2
    errors=$((errors + 1))
  fi
done

for key in NEXT_PUBLIC_DEFAULT_POSTHOG_KEY_BASE64 NEXT_PUBLIC_DEFAULT_SUPABASE_URL_BASE64 \
  NEXT_PUBLIC_DEFAULT_SUPABASE_KEY_BASE64 NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY_BASE64; do
  literal="$(grep -E "^${key}=" "$dotenv" | head -1 | cut -d= -f2- | tr -d "\"'" || true)"
  [[ -n "$literal" ]] || continue
  decoded="$(printf '%s' "$literal" | base64 -d 2>/dev/null || true)"
  for value in "$literal" "$decoded"; do
    [[ -n "$value" ]] || continue
    if contains "$value"; then
      echo "bundle-smoke: bundle contains Readest default $key" >&2
      errors=$((errors + 1))
    fi
  done
done

if [[ $errors -ne 0 ]]; then exit 1; fi
echo "bundle-smoke: OK $out" >&2
