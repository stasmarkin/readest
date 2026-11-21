#!/usr/bin/env bash
# Read-only smoke test of a Readest stack from inside its network (works while Traefik routes are off):
#   smoke.sh <dir> [--expect-file <file_key> --expect-sha256 <hex>] [--force-fail]
# Auth health, a short-lived JWT for the first user (signed here; the secret never leaves the host),
# /api/storage/list, then a presigned download of up to 50 listed files (or of the expected one).
set -euo pipefail
dir="${1:?usage: smoke.sh <dir> [...]}"
shift
expect_key="" expect_sha="" force_fail=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --expect-file) expect_key="$2"; shift 2 ;;
    --expect-sha256) expect_sha="$2"; shift 2 ;;
    --force-fail) force_fail=1; shift ;;
    *) echo "smoke: unknown arg $1" >&2; exit 2 ;;
  esac
done
if [[ $force_fail -eq 1 ]]; then echo "smoke: forced failure (test hook)" >&2; exit 1; fi

envval() { grep -E "^$1=" "$dir/.env" | head -1 | cut -d= -f2- | sed -E "s/^['\"](.*)['\"]$/\\1/"; }
container() { docker ps --filter label=com.docker.compose.project=readest --filter "label=com.docker.compose.service=$1" --format '{{.Names}}' | head -1; }

kong="$(container kong)"
client="$(container client)"
minio="$(container minio)"
[[ -n "$kong" && -n "$client" && -n "$minio" ]] || { echo "smoke: kong/client/minio not running" >&2; exit 1; }
user_id="$(docker exec supabase-db psql -U postgres -tAc 'select id from auth.users order by created_at limit 1' | tr -d '[:space:]')"
[[ -n "$user_id" ]] || { echo "smoke: no users" >&2; exit 1; }

# Secrets go through a 600 env file, not argv, so they stay out of the process list.
envfile="$(mktemp)"
trap 'rm -f "$envfile"' EXIT
printf 'JWT_SECRET=%s\nANON_KEY=%s\nUSER_ID=%s\nKONG=%s\nCLIENT=%s\nMINIO=%s\nEXPECT_KEY=%s\nEXPECT_SHA=%s\n' \
  "$(envval JWT_SECRET)" "$(envval ANON_KEY)" "$user_id" "$kong:8000" "$client:3000" "$minio:9000" \
  "$expect_key" "$expect_sha" >"$envfile"
docker run --rm -i --network readest_default --env-file "$envfile" node:24-alpine node - <<'JS'
const crypto = require('crypto');
const http = require('http');
const { JWT_SECRET, ANON_KEY, USER_ID, KONG, CLIENT, MINIO, EXPECT_KEY, EXPECT_SHA } = process.env;
const deadline = Date.now() + 120_000;
const fail = (m) => { console.error('smoke: FAIL ' + m); process.exit(1); };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const head = b64({ alg: 'HS256', typ: 'JWT' });
const body = b64({ sub: USER_ID, role: 'authenticated', aud: 'authenticated', iat: now, exp: now + 300 });
const jwt = `${head}.${body}.${crypto.createHmac('sha256', JWT_SECRET).update(`${head}.${body}`).digest('base64url')}`;

const retry = async (what, fn) => {
  for (;;) {
    try { return await fn(); } catch (e) {
      if (Date.now() > deadline) fail(`${what}: ${e.message}`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
};
// fetch() rewrites Host to the URL's host, which breaks the SigV4 signature of a presigned URL;
// node:http keeps the signed Host while connecting to MinIO inside the network.
const download = (signed) => new Promise((resolve, reject) => {
  const u = new URL(signed);
  const [host, port] = MINIO.split(':');
  const req = http.request({ host, port, path: u.pathname + u.search, headers: { Host: u.host } }, (res) => {
    const hash = crypto.createHash('sha256');
    let size = 0;
    res.on('data', (c) => { hash.update(c); size += c.length; });
    res.on('end', () => resolve({ status: res.statusCode, size, sha: hash.digest('hex') }));
  });
  req.on('error', reject);
  req.end();
});

(async () => {
  await retry('auth health', async () => {
    const r = await fetch(`http://${KONG}/auth/v1/health`, { headers: { apikey: ANON_KEY } });
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
  });
  const auth = { Authorization: `Bearer ${jwt}` };
  const list = await retry('storage list', async () => {
    const r = await fetch(`http://${CLIENT}/api/storage/list?pageSize=50`, { headers: auth });
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    if (!Array.isArray(j.files)) throw new Error('no files array');
    return j.files;
  });
  if (list.length === 0) fail('storage list is empty');
  const keys = EXPECT_KEY ? [EXPECT_KEY] : list.map((f) => f.file_key);
  for (const key of keys.slice(0, 50)) {
    const r = await fetch(`http://${CLIENT}/api/storage/download?fileKey=${encodeURIComponent(key)}`, { headers: auth });
    if (r.status !== 200) { if (EXPECT_KEY) fail(`download url for expected file: HTTP ${r.status}`); continue; }
    const { downloadUrl } = await r.json();
    const d = await download(downloadUrl);
    if (d.status === 200 && d.size > 0) {
      if (EXPECT_SHA && d.sha !== EXPECT_SHA) fail(`expected file sha256 ${d.sha} != ${EXPECT_SHA}`);
      console.error(`smoke: OK (${list.length} files listed, downloaded ${d.size} bytes)`);
      process.exit(0);
    }
    if (EXPECT_KEY) fail(`expected file download: HTTP ${d.status}`);
  }
  fail('no listed file could be downloaded');
})().catch((e) => fail(e.stack || String(e)));
JS
