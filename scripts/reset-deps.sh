#!/usr/bin/env bash
#
# Restore the Worker to the known-good dependency set.
#
# Use this when the Cloudflare build fails with:
#
#   npm error `npm ci` can only install packages when your package.json and
#   package-lock.json ... are in sync.
#   npm error Missing: <package> from lock file
#
# That happens when package.json and package-lock.json describe different
# dependency sets - for example after merging this project into a repo that
# was scaffolded from Cloudflare's starter template (which pulls in hono,
# zod, vitest and @neondatabase/serverless).
#
# This script:
#   1. backs up your current package.json
#   2. writes the known-good package.json
#   3. regenerates package-lock.json to match
#   4. verifies `npm ci` now works
#
#   ./scripts/reset-deps.sh
#
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

if [ ! -f package.json ]; then
  echo "package.json not found - run this from the project root" >&2
  exit 1
fi

BACKUP="package.json.backup.$(date +%Y%m%d-%H%M%S)"
cp package.json "$BACKUP"
echo "Backed up your package.json -> $BACKUP"

cat > package.json <<'JSON'
{
  "name": "tiktok-scraper",
  "version": "1.0.0",
  "description": "Cloudflare Worker that collects public TikTok video and profile metadata.",
  "private": true,
  "type": "module",
  "main": "worker/src/index.ts",
  "scripts": {
    "dev": "wrangler dev",
    "start": "wrangler dev",
    "deploy": "wrangler deploy",
    "typecheck": "tsc --noEmit",
    "preflight": "./scripts/preflight.sh"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^5.20261104.1",
    "typescript": "^5.6.0",
    "wrangler": "^4.0.0"
  }
}
JSON
echo "Wrote the known-good package.json"

echo "Regenerating package-lock.json ..."
if ! npm install --package-lock-only --no-audit --no-fund >/tmp/reset-deps.log 2>&1; then
  echo "npm install failed:" >&2
  sed -n '1,20p' /tmp/reset-deps.log >&2
  echo "" >&2
  echo "Your original package.json is still at: $BACKUP" >&2
  exit 1
fi
ok_lock="package-lock.json regenerated"

echo "Verifying with npm ci ..."
if npm ci --progress=false >/tmp/reset-deps-ci.log 2>&1; then
  echo ""
  echo "OK - npm ci now works. Commit both files:"
  echo "    git add package.json package-lock.json && git commit -m 'sync worker dependencies'"
else
  echo "npm ci still fails:" >&2
  sed -n '1,20p' /tmp/reset-deps-ci.log >&2
  exit 1
fi
