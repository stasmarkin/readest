#!/usr/bin/env bash
# Builds "Readest Selfhost.app" for the server from build-env.sh. Run from anywhere:
#   bash selfhost/build-macos.sh
# READEST_SELFHOST_IDENTIFIER overrides the bundle id (test builds that must not touch the real profile).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
app_dir="$root/apps/readest-app"

# shellcheck source=selfhost/build-env.sh
source "$here/build-env.sh"

conf="$here/tauri.macos.conf.json"
identifier="com.readest.selfhost"
if [[ -n "${READEST_SELFHOST_IDENTIFIER:-}" ]]; then
  identifier="$READEST_SELFHOST_IDENTIFIER"
  conf="$(mktemp -t readest-selfhost-conf).json"
  trap 'rm -f "$conf"' EXIT
  node -e 'const fs=require("fs");const c=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));c.identifier=process.argv[2];fs.writeFileSync(process.argv[3],JSON.stringify(c))' \
    "$here/tauri.macos.conf.json" "$identifier" "$conf"
fi
bash "$here/tauri-config-check.sh" "$conf"

(cd "$app_dir" && pnpm tauri build --bundles app --config "$conf")

bundle="$root/target/release/bundle/macos/Readest Selfhost.app"
[[ -d "$bundle" ]] || { echo "build-macos: no $bundle" >&2; exit 1; }
actual_id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$bundle/Contents/Info.plist")"
[[ "$actual_id" == "$identifier" ]] || { echo "build-macos: bundle id $actual_id, want $identifier" >&2; exit 1; }

bash "$here/bundle-smoke.sh" "$app_dir/out"
bin="$bundle/Contents/MacOS/$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$bundle/Contents/Info.plist")"
if strings "$bin" | grep -qE 'download\.readest\.com/releases|github\.com/readest/readest/releases'; then
  echo "build-macos: updater endpoints still compiled into $bin" >&2
  exit 1
fi
echo "build-macos: OK $bundle ($identifier)"
