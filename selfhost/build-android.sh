#!/usr/bin/env bash
# shellcheck disable=SC2016 # cleanup_cmds are single-quoted on purpose and expanded by eval on exit
# Builds a signed arm64 "Readest Selfhost" APK (com.readest.selfhost) for the server from build-env.sh
# and copies it to ~/Downloads. Run from anywhere:
#   bash selfhost/build-android.sh
# Signing key: ~/.config/readest-selfhost/android.{jks,properties}, created on first run.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
app_dir="$root/apps/readest-app"
gen="$app_dir/src-tauri/gen/android"
key_dir="${READEST_SELFHOST_KEY_DIR:-$HOME/.config/readest-selfhost}"
application_id="com.readest.selfhost"

die() { echo "build-android: $*" >&2; exit 1; }

# shellcheck source=selfhost/build-env.sh
source "$here/build-env.sh"

# Toolchain.
: "${ANDROID_HOME:=/opt/homebrew/share/android-commandlinetools}"
: "${NDK_HOME:=$ANDROID_HOME/ndk/28.2.13676358}"
export ANDROID_HOME NDK_HOME
[[ -d "$ANDROID_HOME/platform-tools" ]] || die "no Android SDK at $ANDROID_HOME (brew install --cask android-commandlinetools)"
[[ -d "$NDK_HOME" ]] || die "no NDK at $NDK_HOME (sdkmanager \"ndk;28.2.13676358\")"
rustup target list --installed | grep -qx aarch64-linux-android || die "no rust target (rustup target add aarch64-linux-android)"
if [[ -z "${JAVA_HOME:-}" ]]; then
  JAVA_HOME="$(/usr/libexec/java_home -v 17 2>/dev/null)" || die "no JDK 17 (set JAVA_HOME)"
  export JAVA_HOME
fi
build_tools="$(find "$ANDROID_HOME/build-tools" -mindepth 1 -maxdepth 1 -type d | sort -V | tail -1)"
[[ -x "$build_tools/aapt" && -x "$build_tools/apksigner" ]] || die "no aapt/apksigner in $build_tools"

# Gradle's JVM ignores HTTPS_PROXY; hand it over as system properties (every JVM, incl. the daemon).
proxy="${HTTPS_PROXY:-${https_proxy:-}}"
if [[ -n "$proxy" && "${JAVA_TOOL_OPTIONS:-}" != *proxyHost* ]]; then
  hostport="${proxy#*://}"
  hostport="${hostport%%/*}"
  hostport="${hostport##*@}"
  export JAVA_TOOL_OPTIONS="${JAVA_TOOL_OPTIONS:-} -Dhttps.proxyHost=${hostport%:*} -Dhttps.proxyPort=${hostport##*:} -Dhttp.proxyHost=${hostport%:*} -Dhttp.proxyPort=${hostport##*:} -Dhttp.nonProxyHosts=localhost|127.*"
fi

bash "$here/tauri-config-check.sh" "$here/tauri.android.conf.json" --mobile

# The Android project is only partly tracked; generate the rest like scripts/worktree-new.ts does.
if [[ ! -x "$gen/gradlew" ]]; then
  if [[ -n "$(git -C "$root" status --porcelain -- "$gen" "$app_dir/src-tauri/icons")" ]]; then
    die "local changes under $gen; commit or stash them before the Android project is regenerated"
  fi
  (cd "$app_dir" && rm -rf "$gen" && pnpm tauri android init && pnpm tauri icon ../../data/icons/readest-book.png)
  git -C "$root" checkout -- "$gen" "$app_dir/src-tauri/icons"
fi

# Signing key, created once; losing it only means reinstalling the APK.
mkdir -p "$key_dir"
chmod 700 "$key_dir"
jks="$key_dir/android.jks"
props="$key_dir/android.properties"
if [[ ! -f "$jks" ]]; then
  password="$(openssl rand -hex 24)"
  (umask 077 && printf 'password=%s\n' "$password" >"$props")
  keytool -genkeypair -keystore "$jks" -alias readest-selfhost -keyalg RSA -keysize 4096 -validity 36500 \
    -dname 'CN=Readest Selfhost' -storepass "$password" -keypass "$password" >/dev/null
  chmod 600 "$jks"
  echo "build-android: created signing key $jks — save it and $props to Vaultwarden" >&2
fi
password="$(grep -E '^password=' "$props" | cut -d= -f2-)"
[[ -n "$password" ]] || die "no password in $props"

# Everything this script changes in the checkout is put back on exit.
cleanup_cmds=()
cleanup() {
  local c
  for c in "${cleanup_cmds[@]+"${cleanup_cmds[@]}"}"; do eval "$c" || true; done
}
trap cleanup EXIT

# Gradle reads the signing config from READEST_KEYSTORE_PROPERTIES, so the checkout's own
# keystore.properties (the regular release config) is never touched.
ks_props="$key_dir/keystore.properties"
# Older versions of this script wrote our config into the checkout; never leave it for regular builds.
legacy="$gen/keystore.properties"
if [[ -f "$legacy" ]] && grep -q '^keyAlias=readest-selfhost$' "$legacy"; then
  rm -f "$legacy"
  if [[ -e "$legacy.before-selfhost" || -L "$legacy.before-selfhost" ]]; then mv "$legacy.before-selfhost" "$legacy"; fi
fi
rm -f "$legacy.selfhost-owned"
(umask 077 && printf 'keyAlias=readest-selfhost\npassword=%s\nstoreFile=%s\n' "$password" "$jks" >"$ks_props")
export READEST_KEYSTORE_PROPERTIES="$ks_props"

# The deep-link plugin rewrites the tracked AndroidManifest.xml from our config; put it back so a
# build leaves the checkout clean (fork sync/rebuild refuse dirty trees).
manifest="$gen/app/src/main/AndroidManifest.xml"
if [[ -z "$(git -C "$root" status --porcelain -- "$manifest")" ]]; then
  cleanup_cmds+=('git -C "$root" checkout -- "$manifest"')
fi
(cd "$app_dir" && READEST_APPLICATION_ID="$application_id" \
  pnpm tauri android build --apk --target aarch64 --config "$here/tauri.android.conf.json")

apk="$gen/app/build/outputs/apk/universal/release/app-universal-release.apk"
[[ -f "$apk" ]] || die "no $apk"

"$build_tools/aapt" dump badging "$apk" | grep -q "^package: name='$application_id'" || die "APK package is not $application_id"
want_sha="$(keytool -list -v -keystore "$jks" -alias readest-selfhost -storepass "$password" | awk -F': ' '/SHA256:/{print $2; exit}' | tr -d ':' | tr '[:upper:]' '[:lower:]')"
got_sha="$("$build_tools/apksigner" verify --print-certs "$apk" | awk -F': ' '/certificate SHA-256 digest/{print $2; exit}')"
[[ -n "$want_sha" && "$want_sha" == "$got_sha" ]] || die "APK signer $got_sha is not the selfhost key $want_sha"
if "$build_tools/aapt" dump xmltree "$apk" AndroidManifest.xml | grep -q 'web\.readest\.com'; then
  die "APK manifest still has the web.readest.com App Link"
fi
bash "$here/bundle-smoke.sh" "$app_dir/out"
libs="$(mktemp -d)"
cleanup_cmds+=('rm -rf "$libs"')
unzip -q -o "$apk" 'lib/arm64-v8a/*.so' -d "$libs"
if strings "$libs"/lib/arm64-v8a/*.so | grep -qE 'download\.readest\.com/releases|github\.com/readest/readest/releases'; then
  die "updater endpoints still compiled into the native library"
fi

version="$(node -p 'require(process.argv[1]).version' "$app_dir/package.json")"
sha="$(git -C "$root" rev-parse --short=7 HEAD)"
dest="$HOME/Downloads/readest-selfhost-$version-$sha.apk"
# Test builds for the colima stand must not look like a real release in ~/Downloads.
if [[ "$NEXT_PUBLIC_API_BASE_URL" == http://localhost:* ]]; then
  mkdir -p "$key_dir/test"
  dest="$key_dir/test/readest-selfhost-localhost-$version-$sha.apk"
fi
cp "$apk" "$dest"
echo "build-android: OK $dest"

# A localhost test profile reaches the colima stand only through adb reverse.
if [[ "$NEXT_PUBLIC_API_BASE_URL" == http://localhost:* ]]; then
  devices="$(adb devices | awk 'NR>1 && $2=="device"{print $1}')"
  count="$(printf '%s' "$devices" | grep -c . || true)"
  if [[ "$count" -ne 1 ]]; then
    echo "build-android: warning: $count adb devices, skipping adb reverse" >&2
  else
    for port in 3000 8000 9000; do adb -s "$devices" reverse "tcp:$port" "tcp:$port" >/dev/null; done
    for port in 3000 8000 9000; do
      adb -s "$devices" reverse --list | grep -q "tcp:$port tcp:$port" || die "adb reverse tcp:$port missing"
    done
    echo "build-android: adb reverse 3000/8000/9000 on $devices" >&2
  fi
fi
