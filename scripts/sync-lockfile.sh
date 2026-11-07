#!/usr/bin/env bash
#
# Regenerate package-lock.json from the package.json that is ALREADY in your
# repo - without changing package.json.
#
# Use this when the Cloudflare build fails with:
#   npm error `npm ci` can only install packages when your package.json and
#   package-lock.json ... are in sync.
#
# Safe and non-destructive: your dependency list is untouched, only the lock
# file is rebuilt to match it.
#
#   ./scripts/sync-lockfile.sh
#
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

[ -f package.json ] || { echo "package.json not found" >&2; exit 1; }

echo "Current dependencies in package.json:"
node -e "
const p=require('./package.json');
for (const k of ['dependencies','devDependencies']) {
  if (p[k]) for (const [n,v] of Object.entries(p[k])) console.log('   ', k+':', n, v);
}
" 2>/dev/null || echo "   (could not parse package.json)"

echo ""
echo "Rebuilding package-lock.json ..."
if ! npm install --package-lock-only --no-audit --no-fund >/tmp/sync-lock.log 2>&1; then
  echo "FAILED - see /tmp/sync-lock.log:" >&2
  sed -n '1,20p' /tmp/sync-lock.log >&2
  exit 1
fi

echo "Verifying with npm ci ..."
if npm ci --progress=false >/tmp/sync-lock-ci.log 2>&1; then
  echo ""
  echo "OK - lock file is in sync. Commit it:"
  echo "    git add package-lock.json && git commit -m 'sync package-lock.json'"
  echo "    git push"
else
  echo "npm ci still fails:" >&2
  sed -n '1,20p' /tmp/sync-lock-ci.log >&2
  exit 1
fi
