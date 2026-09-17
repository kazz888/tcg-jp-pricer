#!/bin/bash
# Nightly Japanese price refresh, run from THIS machine.
#
# Why not GitHub Actions: yuyu-tei.jp returns 403 to GitHub-hosted runners. It is
# not a User-Agent check - from a home connection even a bare `curl` with no UA
# at all gets 200, while the runner gets 403 with identical headers. They block
# Azure datacenter ranges, which is what GitHub's runners are. Nothing in the
# request can fix that, so the scrape runs from a residential IP instead.
#
# Cardmarket is unaffected and still refreshes in CI - it is an API call to
# Apify, not a scrape, so the runner's IP is irrelevant.
#
# Install as a nightly job:   bash scripts/install-nightly.sh
# Run once by hand:           bash scripts/refresh-local.sh

set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

log() { printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }

log "Yuyu-tei refresh starting in $ROOT"

# A laptop that is asleep or off wifi is the normal case, not an error. Check
# reachability first so the log says "no network" instead of a stack trace.
if ! curl -sf -o /dev/null --max-time 20 "https://yuyu-tei.jp/"; then
  log "yuyu-tei.jp unreachable - skipping tonight (laptop offline, or they are down)"
  exit 0
fi

log "scraping Yuyu-tei"
node scripts/pull-yuyutei.mjs

# Refuse to publish a broken scrape. Yuyu-tei changing their markup would show up
# here as a collapse in row count or in the share of rows carrying a card code.
node -e '
  const d = require("./data/yuyutei.json");
  const rows = d.rows?.length ?? 0;
  const coded = d.rows?.filter(r => r.code && r.code !== "-").length ?? 0;
  console.log(`rows=${rows} coded=${coded}`);
  if (rows < 4000) throw new Error(`only ${rows} rows - refusing to publish`);
  if (coded / rows < 0.9) throw new Error(`only ${(100*coded/rows).toFixed(1)}% carry a code - parser drift?`);
'

log "rebuilding the index"
node scripts/build-index.mjs

log "running checks"
pnpm test >/dev/null
pnpm check >/dev/null
pnpm build >/dev/null

if git diff --quiet -- data/yuyutei.json data/index.json; then
  log "no price movement - nothing to publish"
  exit 0
fi

log "committing and pushing"
git add data/yuyutei.json data/index.json
git -c user.name="nightly" -c user.email="nightly@localhost" \
    commit -m "data: nightly Yuyu-tei refresh (local)"
git pull --rebase --autostash origin main
git push

# Pushing is enough if you want CI to own deploys, but deploying here means the
# phone has the new prices immediately rather than after the next EU run.
if command -v wrangler >/dev/null 2>&1 || [ -x node_modules/.bin/wrangler ]; then
  log "deploying to Cloudflare"
  npx wrangler deploy
else
  log "wrangler not available - pushed only, deploy skipped"
fi

log "done"
