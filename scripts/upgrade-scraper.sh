#!/usr/bin/env bash
#
# Upgrade an existing scraper repo to the hardened v2 build.
#
#   ./scripts/upgrade-scraper.sh /path/to/your/scraper-repo [--deploy]
#
# Only TWO files changed in v2:
#   worker/src/tiktok.ts   the scraping core (throttle handling, cache, pool)
#   worker/src/index.ts     the router (parallel fetching, status values)
#
# worker/src/types.ts is unchanged - do not touch it.
#
# The script copies the two files, verifies their checksums, runs the same
# checks the Cloudflare build runs, and optionally deploys.
#
set -uo pipefail

PKG_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="${1:-}"
DEPLOY=0
for arg in "$@"; do [ "$arg" = "--deploy" ] && DEPLOY=1; done

if [ -z "$TARGET" ]; then
  echo "Usage: $0 /path/to/your/scraper-repo [--deploy]" >&2
  exit 1
fi
if [ ! -f "$TARGET/wrangler.toml" ]; then
  echo "Not a scraper repo: $TARGET/wrangler.toml not found" >&2
  exit 1
fi

cd "$TARGET" || exit 1

echo "==> Target repo: $(pwd)"
WORKER_NAME=$(grep -E '^name\s*=' wrangler.toml | head -1 | sed -E 's/.*=\s*"?([^"]*)"?/\1/')
echo "    worker name  : $WORKER_NAME"
if [ "$WORKER_NAME" != "hof" ]; then
  echo ""
  echo "    WARNING: wrangler.toml says name = \"$WORKER_NAME\"."
  echo "    If your live worker is 'hof', change this before deploying,"
  echo "    or you will publish a second worker instead of updating yours."
  echo ""
fi

echo ""
echo "==> Copying the two changed files"
for f in worker/src/tiktok.ts worker/src/index.ts; do
  if [ ! -f "$PKG_DIR/$f" ]; then
    echo "    MISSING in package: $f" >&2
    exit 1
  fi
  mkdir -p "$(dirname "$f")"
  cp "$PKG_DIR/$f" "$f"
  echo "    updated $f"
done
echo "    (worker/src/types.ts left untouched - unchanged in v2)"

echo ""
echo "==> Verifying checksums"
EXPECTED_TIKTOK="c1fa3dce5f7adb1aad4c141e2819f4a911b818a47ec85983f41dc44d2a95e1ae"
EXPECTED_INDEX="1bbfeb38036ce2b1b3cd7cae4236c22bede09116ae246664b0e5d2ad79131285"
ACTUAL_TIKTOK=$(sha256sum worker/src/tiktok.ts | cut -d' ' -f1)
ACTUAL_INDEX=$(sha256sum worker/src/index.ts | cut -d' ' -f1)
if [ "$ACTUAL_TIKTOK" = "$EXPECTED_TIKTOK" ]; then echo "    OK worker/src/tiktok.ts"; else echo "    MISMATCH worker/src/tiktok.ts" >&2; exit 1; fi
if [ "$ACTUAL_INDEX" = "$EXPECTED_INDEX" ]; then echo "    OK worker/src/index.ts"; else echo "    MISMATCH worker/src/index.ts" >&2; exit 1; fi

echo ""
echo "==> Running the pre-flight checks"
npm install --no-audit --no-fund > /tmp/upgrade-npm.log 2>&1 || {
  echo "    npm install failed - see /tmp/upgrade-npm.log" >&2
  tail -20 /tmp/upgrade-npm.log >&2
  exit 1
}
npx --no-install tsc --noEmit || { echo "    typecheck FAILED" >&2; exit 1; }
echo "    typecheck clean"
npx --no-install wrangler deploy --dry-run > /tmp/upgrade-deploy.log 2>&1 || {
  echo "    bundle FAILED - see /tmp/upgrade-deploy.log" >&2
  tail -20 /tmp/upgrade-deploy.log >&2
  exit 1
}
grep -E "Total Upload" /tmp/upgrade-deploy.log | sed 's/^/    /'

if [ "$DEPLOY" -eq 1 ]; then
  echo ""
  echo "==> Deploying"
  npx --no-install wrangler deploy || exit 1
  echo ""
  echo "Deployed. Smoke test:"
  echo "    curl \"https://hof.talesapi.workers.dev/api/profile/posts?handle=wattpad&limit=5\""
else
  echo ""
  echo "Ready. Deploy with:"
  echo "    npx wrangler deploy"
  echo "  or re-run this script with --deploy"
fi
