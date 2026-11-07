#!/usr/bin/env bash
#
# Deploy the Worker and smoke-test the live URL.
#
#   ./scripts/deploy.sh
#
# Deploys the worker named in wrangler.toml, waits for the new version to
# roll out, then hits the live endpoints so you know it actually works
# rather than just "deploy succeeded".
#
# The worker name matters: wrangler.toml must contain the name of the
# worker you already have live (e.g. "hof"), otherwise you will publish a
# second, empty worker under a different name and wonder why the old URL
# never changes.
#
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

WORKER_NAME=$(grep -E '^name\s*=' wrangler.toml | head -1 | sed -E 's/.*=\s*"?([^"]*)"?/\1/')
echo "Worker name from wrangler.toml: $WORKER_NAME"

if [ -z "$WORKER_NAME" ]; then
  echo "Could not read the worker name from wrangler.toml" >&2
  exit 1
fi

echo ""
echo "==> Deploying"
if ! npx --no-install wrangler deploy; then
  echo "Deploy failed - see the output above." >&2
  exit 1
fi

URL=$(npx --no-install wrangler deployments list 2>/dev/null | grep -oE 'https://[a-z0-9.-]+\.workers\.dev' | head -1)
if [ -z "$URL" ]; then
  URL="https://${WORKER_NAME}.workers.dev"
fi
echo ""
echo "==> Smoke-testing $URL"

sleep 5
for path in "/api/health" "/api/video?url=https%3A%2F%2Fwww.tiktok.com%2F%40tiktok%2Fvideo%2F6718335390845095173" "/api/profile?handle=tiktok"; do
  CODE=$(curl -s -m 60 -o /tmp/deploy-smoke.json -w '%{http_code}' "$URL$path" || echo "000")
  if [ "$CODE" = "200" ]; then
    echo "    PASS $CODE  $path"
  else
    echo "    FAIL $CODE  $path"
    head -c 300 /tmp/deploy-smoke.json
    echo ""
  fi
done

echo ""
echo "Live URL: $URL"
echo "Set your own workers.dev subdomain (talesapi) in the Cloudflare dashboard"
echo "if the URL above shows the default subdomain."
