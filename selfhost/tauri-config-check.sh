#!/usr/bin/env bash
# Checks the effective Tauri config (base tauri.conf.json merge-patched with a selfhost config):
# no updater endpoints, no updater artifacts and, for mobile, no web.readest.com App Link while
# every other deep-link scheme of the base config is kept (catches drift after an upstream sync).
#   selfhost/tauri-config-check.sh selfhost/tauri.android.conf.json [--mobile]
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
base="${READEST_TAURI_BASE_CONF:-$here/../apps/readest-app/src-tauri/tauri.conf.json}"
overlay="${1:?usage: tauri-config-check.sh <selfhost-conf.json> [--mobile]}"
mobile="${2:-}"

node -e '
const fs = require("fs");
const [basePath, overlayPath, mobile] = process.argv.slice(1);
const base = JSON.parse(fs.readFileSync(basePath, "utf8"));
const overlay = JSON.parse(fs.readFileSync(overlayPath, "utf8"));
// RFC 7396 merge patch, as Tauri applies --config files.
const merge = (t, p) => {
  if (p === null || typeof p !== "object" || Array.isArray(p)) return p;
  const r = t && typeof t === "object" && !Array.isArray(t) ? { ...t } : {};
  for (const [k, v] of Object.entries(p)) {
    if (v === null) delete r[k];
    else r[k] = merge(r[k], v);
  }
  return r;
};
const eff = merge(base, overlay);
const errors = [];
const endpoints = eff.plugins?.updater?.endpoints;
if (!Array.isArray(endpoints) || endpoints.length !== 0) errors.push("plugins.updater.endpoints must be []");
if (eff.bundle?.createUpdaterArtifacts !== false) errors.push("bundle.createUpdaterArtifacts must be false");
if (/upload-sourcemaps/.test(eff.build?.beforeBuildCommand ?? "")) errors.push("beforeBuildCommand must not upload sourcemaps");
if (mobile === "--mobile") {
  const effMobile = eff.plugins?.["deep-link"]?.mobile ?? [];
  if (JSON.stringify(effMobile).includes("web.readest.com")) errors.push("deep-link.mobile still has web.readest.com");
  const key = (e) => JSON.stringify(e.scheme) + (e.host ?? "");
  const want = (base.plugins?.["deep-link"]?.mobile ?? []).filter((e) => e.host !== "web.readest.com").map(key);
  const have = new Set(effMobile.map(key));
  for (const k of want) if (!have.has(k)) errors.push("deep-link.mobile lost base entry " + k);
}
if (errors.length) { for (const e of errors) console.error("tauri-config-check: " + e); process.exit(1); }
console.error("tauri-config-check: OK " + overlayPath);
' "$base" "$overlay" "$mobile"
