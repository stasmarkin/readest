#!/usr/bin/env bash
# Build environment for a self-hosted Readest client. Source it, don't run it:
#   source selfhost/build-env.sh
# Profile source is exactly one of:
#   a) READEST_SELFHOST_API_URL + READEST_SELFHOST_SUPABASE_URL + READEST_SELFHOST_ANON_KEY (test profile, offline);
#   b) none of them → ${READEST_SELFHOST_URL:-https://readest.stasmarkin.ru}/.well-known/readest-client-config.json.
# Test hooks: READEST_SELFHOST_CONFIG_FILE (read JSON from a file instead of curl), READEST_APP_DIR.

_selfhost_build_env() {
  local here app_dir server_url config api supabase anon validated
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  app_dir="${READEST_APP_DIR:-$here/../apps/readest-app}"
  server_url="${READEST_SELFHOST_URL:-https://readest.stasmarkin.ru}"

  local explicit=0
  [[ -n "${READEST_SELFHOST_API_URL+x}" ]] && explicit=$((explicit + 1))
  [[ -n "${READEST_SELFHOST_SUPABASE_URL+x}" ]] && explicit=$((explicit + 1))
  [[ -n "${READEST_SELFHOST_ANON_KEY+x}" ]] && explicit=$((explicit + 1))

  if [[ $explicit -eq 3 ]]; then
    config="$(node -e 'process.stdout.write(JSON.stringify({apiBaseUrl: process.argv[1], supabaseUrl: process.argv[2], supabaseAnonKey: process.argv[3]}))' \
      "$READEST_SELFHOST_API_URL" "$READEST_SELFHOST_SUPABASE_URL" "$READEST_SELFHOST_ANON_KEY")"
    server_url=""
  elif [[ $explicit -ne 0 ]]; then
    echo "build-env: set all three READEST_SELFHOST_API_URL, READEST_SELFHOST_SUPABASE_URL, READEST_SELFHOST_ANON_KEY or none" >&2
    return 1
  elif [[ -n "${READEST_SELFHOST_CONFIG_FILE:-}" ]]; then
    config="$(cat "$READEST_SELFHOST_CONFIG_FILE")" || return 1
  else
    if ! config="$(curl -fsS --max-time 15 "$server_url/.well-known/readest-client-config.json")"; then
      echo "build-env: cannot fetch $server_url/.well-known/readest-client-config.json" >&2
      return 1
    fi
  fi

  # Validation lives in node: JSON parsing and URL checks are unreliable in shell.
  if ! validated="$(node -e '
    const [raw, expectedOrigin] = process.argv.slice(1);
    const fail = (m) => { console.error("build-env: " + m); process.exit(1); };
    let c;
    try { c = JSON.parse(raw); } catch { fail("profile is not valid JSON"); }
    if (!c || typeof c !== "object") fail("profile is not an object");
    const out = [];
    for (const k of ["apiBaseUrl", "supabaseUrl", "supabaseAnonKey"]) {
      const v = c[k];
      if (typeof v !== "string" || v.trim() === "") fail(k + " must be a non-empty string");
      if (k !== "supabaseAnonKey") {
        let u;
        try { u = new URL(v); } catch { fail(k + " is not a URL"); }
        if (u.protocol !== "http:" && u.protocol !== "https:") fail(k + " must be http(s)");
        if (expectedOrigin && u.origin !== new URL(expectedOrigin).origin) fail(k + " origin differs from " + expectedOrigin);
        out.push(v.replace(/\/+$/, ""));
      } else out.push(v.trim());
    }
    process.stdout.write(out.join("\n"));
  ' "$config" "$server_url")"; then
    return 1
  fi
  { read -r api; read -r supabase; read -r anon; } <<<"$validated"

  # Rust build.rs and Gradle fall back to these files for SENTRY_DSN; PostHog reads its key before the zeroed default.
  local f key
  for f in "$app_dir/.env.local" "$app_dir/.env"; do
    [[ -f "$f" ]] || continue
    for key in SENTRY_DSN NEXT_PUBLIC_POSTHOG_KEY; do
      if grep -Eq "^[[:space:]]*${key}[[:space:]]*=[[:space:]]*['\"]?[^'\"[:space:]]" "$f"; then
        echo "build-env: $f sets $key; remove it for a self-hosted build" >&2
        return 1
      fi
    done
  done

  export NEXT_PUBLIC_API_BASE_URL="$api"
  export NEXT_PUBLIC_NODE_BASE_URL="$api"
  export NEXT_PUBLIC_SUPABASE_URL="$supabase"
  export NEXT_PUBLIC_SUPABASE_ANON_KEY="$anon"
  export NEXT_PUBLIC_SELF_HOSTED=true
  export NEXT_PUBLIC_DISABLE_UPDATER=1
  local empty
  for empty in NEXT_PUBLIC_POSTHOG_KEY NEXT_PUBLIC_POSTHOG_HOST \
    NEXT_PUBLIC_DEFAULT_POSTHOG_URL_BASE64 NEXT_PUBLIC_DEFAULT_POSTHOG_KEY_BASE64 \
    NEXT_PUBLIC_DEFAULT_SUPABASE_URL_BASE64 NEXT_PUBLIC_DEFAULT_SUPABASE_KEY_BASE64 \
    NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY_BASE64 NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY_DEV_BASE64; do
    export "$empty="
  done
  unset SENTRY_DSN SENTRY_AUTH_TOKEN NEXT_PUBLIC_DIST_CHANNEL

  echo "build-env: api=$api supabase=$supabase anon=${anon:0:6}…" >&2
}

_selfhost_build_env
