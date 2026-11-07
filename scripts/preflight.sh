#!/usr/bin/env bash
#
# Pre-flight check for the Cloudflare Worker.
#
# Runs exactly what Cloudflare's build runs, locally, so a broken build is
# caught in seconds instead of after a 3-minute remote build.
#
#   ./scripts/preflight.sh
#
# Checks:
#   1. required tools are present
#   2. package.json and package-lock.json agree  (npm ci - the step that
#      fails with "Missing: <pkg> from lock file")
#   3. TypeScript compiles
#   4. the Worker bundles
#   5. the Python scraper still imports and runs
#
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

FAILURES=0
step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
ok()   { printf '    \033[32mPASS\033[0m %s\n' "$1"; }
bad()  { printf '    \033[31mFAIL\033[0m %s\n' "$1"; FAILURES=$((FAILURES + 1)); }

step "1/6  Toolchain"
if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
  ok "node $(node --version), npm $(npm --version)"
else
  bad "node/npm not found on PATH"
fi
if command -v python3 >/dev/null 2>&1; then
  ok "python3 $(python3 --version 2>&1 | cut -d' ' -f2)"
else
  bad "python3 not found on PATH"
fi

step "2/6  Lock file is in sync with package.json  (npm ci)"
if [ -f package-lock.json ]; then
  if npm ci --progress=false >/tmp/preflight-npmci.log 2>&1; then
    ok "npm ci succeeded"
  else
    bad "npm ci failed - package.json and package-lock.json are out of sync"
    sed -n '1,12p' /tmp/preflight-npmci.log | sed 's/^/      /'
    echo ""
    echo "      Which packages does package.json want that the lock file lacks?"
    node -e "
      const fs=require('fs');
      const lock=JSON.parse(fs.readFileSync('package-lock.json','utf8'));
      const have=new Set(Object.keys(lock.packages||{}).map(k=>k.replace(/^node_modules\//,'')));
      const pkg=JSON.parse(fs.readFileSync('package.json','utf8'));
      const want={...(pkg.dependencies||{}),...(pkg.devDependencies||{})};
      const missing=Object.keys(want).filter(n=>!have.has(n));
      console.log(missing.length? '      -> '+missing.join(', ') : '      -> (none - the lock file may just be stale)');
    " 2>/dev/null | sed 's/^/      /'
    echo ""
    echo "      Fix A (keeps your dependencies):  ./scripts/sync-lockfile.sh"
    echo "      Fix B (known-good set):            ./scripts/reset-deps.sh"
    echo "      Fix C (dashboard only):           install command = npm install"
  fi
else
  bad "package-lock.json is missing - run: npm install"
fi

step "3/6  Exactly one wrangler config"
CONFIGS=$(ls wrangler.toml wrangler.json wrangler.jsonc 2>/dev/null | tr '\n' ' ')
CONFIGS_COUNT=$(echo "$CONFIGS" | wc -w | tr -d ' ')
if [ "$CONFIGS_COUNT" -eq 1 ]; then
  ok "using $CONFIGS"
elif [ "$CONFIGS_COUNT" -eq 0 ]; then
  bad "no wrangler config found (need wrangler.toml at the repo root)"
  echo "      Fix: copy wrangler.toml from this project to the repository root"
else
  bad "multiple wrangler configs found: $CONFIGS"
  echo "      Fix: keep only wrangler.toml and delete the others - wrangler"
  echo "            cannot tell which one to use and may fail to start."
fi

step "4/6  TypeScript compiles"
if npx --no-install tsc --noEmit >/tmp/preflight-tsc.log 2>&1; then
  ok "typecheck clean"
else
  bad "typecheck failed"
  sed -n '1,12p' /tmp/preflight-tsc.log | sed 's/^/      /'
fi

step "5/6  Worker bundles"
if npx --no-install wrangler deploy --dry-run >/tmp/preflight-deploy.log 2>&1; then
  ok "$(grep -E 'Total Upload' /tmp/preflight-deploy.log | head -1)"
else
  bad "wrangler deploy --dry-run failed"
  sed -n '1,12p' /tmp/preflight-deploy.log | sed 's/^/      /'
fi

step "6/6  Python scraper smoke test"
if python3 -m tiktok_scraper --help >/tmp/preflight-py.log 2>&1; then
  ok "python -m tiktok_scraper --help"
else
  bad "python scraper failed to start"
  sed -n '1,12p' /tmp/preflight-py.log | sed 's/^/      /'
fi

printf '\n%s\n' "------------------------------------------------------------"
printf '  If step 2 failed, the Cloudflare install command must be\n'
printf '  "npm install" (not the default npm ci) until the lock file is\n'
printf '  committed and in sync.\n'
if [ "$FAILURES" -eq 0 ]; then
  printf '\033[32mAll checks passed - safe to push.\033[0m\n'
  exit 0
else
  printf '\033[31m%d check(s) failed - fix them before pushing.\033[0m\n' "$FAILURES"
  exit 1
fi
