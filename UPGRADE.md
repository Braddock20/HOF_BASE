# Upgrading the `hof` scraper to v2

**Short answer: two files change — `worker/src/tiktok.ts` and `worker/src/index.ts`.**

Everything else stays exactly as it is.

---

## Which repo

Two separate Workers are involved, and they live in different places:

| Worker | Role | Repo |
| --- | --- | --- |
| `hof` | the **scraper** — talks to TikTok, returns metadata | the repo with `wrangler.toml` → `name = "hof"` |
| `hof-base` | your **app** — Hono + Neon, calls the scraper over a service binding | `hof-worker/` (the attached `hof-base-backend-1_2_14-queue-fix.zip`) |

This upgrade only touches the **`hof` scraper** repo.

---

## The mechanical way

From the extracted package:

```bash
./scripts/upgrade-scraper.sh /path/to/your/scraper-repo --deploy
```

That copies the two files, verifies their checksums, runs `npm install`,
typecheck and `wrangler deploy --dry-run`, then deploys and prints the
smoke-test command.

## The manual way

Copy these two files from the package into your scraper repo, overwriting
the existing ones:

```
worker/src/tiktok.ts    <- new
worker/src/index.ts     <- new
```

Then:

```bash
npm install
npm run typecheck
npx wrangler deploy --dry-run     # expect: Total Upload: 34.51 KiB / gzip: 9.26 KiB
npx wrangler deploy
```

### Checksums (to confirm the copy landed)

```
c1fa3dce5f7adb1aad4c141e2819f4a911b818a47ec85983f41dc44d2a95e1ae  worker/src/tiktok.ts
1bbfeb38036ce2b1b3cd7cae4236c22bede09116ae246664b0e5d2ad79131285  worker/src/index.ts
```

```bash
sha256sum worker/src/tiktok.ts worker/src/index.ts
```

---

## Do NOT touch

| File | Why |
| --- | --- |
| `worker/src/types.ts` | **unchanged in v2** — same imports, same exports, same checksum as v1 |
| `package.json` | dependencies did not change |
| `package-lock.json` | unchanged |

`types.ts` is byte-identical to what you already have. The v2 code imports
exactly the same symbols from it as v1 did.

---

## Check `wrangler.toml` before you deploy

```bash
grep '^name' wrangler.toml
```

It must say:

```toml
name = "hof"
```

If it says `tiktok-scraper`, your deploy publishes a **second, empty worker**
and `hof.talesapi.workers.dev` keeps serving the old code.

---

## What changed in each file

### `worker/src/tiktok.ts` — the scraping core

- **`400 "ratelimit triggered"` is now a throttle, not an error.** TikTok
  signals throttling with 429, 5xx, *and* 400-with-that-body. v1 only
  retried the first two, so it aborted instantly on the third and healthy
  accounts looked permanently broken.
- **Account error codes are decoded** from the error body: `10221` = gone,
  `10101` = blocked, `209002` = restricted.
- **Cloudflare cache** — every fetched page is cached for 5 minutes, so the
  five-minute sync cron does not re-download the same videos.
- **Retry with jittered backoff** (1-4 s) on every throttle.
- **`mapLimit()`** — a bounded parallel pool, used for video details.
- Handles are lowercased and the embed payload key is matched
  case-insensitively.

### `worker/src/index.ts` — the router

- **Video detail pages are fetched in parallel** (pool of 6) instead of one
  at a time. 20 posts went from ~20 round trips to ~4.
- **The profile page and the embed page are fetched concurrently**, so their
  latencies overlap instead of adding up.
- **Per-video fallback** — if a detail page is blocked the row still comes
  back with embed-level data and `status = partial`, instead of being lost.
- **New `status` values** on `/api/profile` and `/api/profile/posts`:
  `ok`, `partial`, `empty`, `not_found`, `restricted`, `rate_limited`,
  `failed`.
- **Soft-throttle detection** — if the embed page returns HTTP 200 with an
  empty list while the profile says the account has videos, it is re-fetched.
- **Per-request time budget** so one slow account cannot eat an invocation.

### Response shapes did not change

`hof-base` keeps working untouched. This was verified by running your
actual `normalizeTikTok()` against the v2 responses:

```
@bellapoarch  providerStatus: ok
  metrics: {"followers":91400000,"following":648,"videos":151,"likes":2400000000}
  bio: Picnic At The Cemetery | verified: true
```

and `hof-base`'s `pullPosts()` still resolves `root.videos` correctly and
reads every field it expects.

---

## Optional: teach `hof-base` the new statuses

`hof-base` does not know about the new `status` values yet, so it still
retries a permanently blocked account three times before pausing.

```bash
cd path/to/hof-base
git apply /path/to/tiktok-scraper/hof-base-collector-patch.diff
```

The patch makes `not_found` and `restricted` fail immediately (no retries),
keeps `rate_limited` retryable, and treats `empty` as a success instead of
an error. Verified: typechecks clean and all 8 of your smoke tests pass.

---

## Verify after deploying

```bash
curl -s "https://hof.talesapi.workers.dev/api/profile/posts?handle=wattpad&limit=5" | head -20
```

Expect `meta.ok = 5`, `status: "ok"`, and the five newest posts with real
engagement numbers. Then check the previously broken handles:

```bash
for h in comrade.wa.uoe theelexy_17 .artienoh its_ellah_the_2nd ..steve..calpyfx; do
  curl -s "https://hof.talesapi.workers.dev/api/profile/posts?handle=$h&limit=5" \
    | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('status'), d['meta'].get('ok'))"
done
```

All five should print `ok 5`.

---

## Measured results

| Case | v1 | v2 |
| --- | --- | --- |
| `..steve..calpyfx` | 400 error | 1.7 s cold / **30 ms** warm |
| `comrade.wa.uoe` | 2 598 ms | 995 ms / **29 ms** |
| `theelexy_17` | 2 612 ms | 1 646 ms / **29 ms** |
| `.artienoh` | 5 403 ms | 1 584 ms / **28 ms** |
| `its_ellah_the_2nd` | 2 360 ms | 1 310 ms / **28 ms** |
| 20 posts (what `hof-base` asks for) | ~10-20 s sequential | 0.9-1.6 s cold / **~45 ms** warm |

`aziz.afrencioofficial` is genuinely restricted by TikTok (`errorCode 10101`
/ profile `209002`) and now reports `status: "restricted"` instead of
failing ambiguously.
