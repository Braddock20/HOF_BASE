# Methodology template

Copy this into your write-up and fill in the blanks. It covers the questions a
teacher is most likely to ask about how you got your data.

---

## 1. Research question

> *(e.g. Which hashtags are most used by educational creators on TikTok, and
> how does video length relate to engagement?)*

## 2. What was collected

| Field | Why it was needed |
| --- | --- |
| caption, hashtags | what the video is about |
| likes, comments, shares, saves, plays | how popular it is and how people interacted |
| create_date, create_hour, create_weekday | when it was published |
| duration_seconds | how long it is |
| author_handle, author_followers | who made it and how big they are |
| sound_title, sound_author | whether a trending audio carried it |

If you also collected **creator profiles** (`--profile`), add:

| Field | Why it was needed |
| --- | --- |
| nickname, bio | who they present themselves as |
| avatar_large | profile picture (a signed URL - it expires, so download it if you need it) |
| follower_count, following_count | account size and reach |
| video_count | how much they have published |
| total_likes | lifetime account likes |
| account_created_date | how new the account is |
| verified, is_private | account flags |

## 3. How it was collected

- **Tool:** `tiktok-scraper` (this repository), written in Python.
- **Method:** *(pick one or more)*
  - `[ ]` single video URLs fetched over HTTP
  - `[ ]` hashtag page `/tag/<tag>` collected with a headless browser
  - `[ ]` creator's recent posts via the public embed page (`/embed/@handle`)
  - `[ ]` creator profile details (bio, avatar, follower counts)
- **Hashtag(s)/profile(s) used:** *(e.g. `#booktok`, `#studytok`)*
- **Number of URLs requested:** *(e.g. 156)*
- **Number of videos successfully collected:** *(e.g. 156)*
- **Success rate:** *(successful / requested — report this, it's expected to be
  below 100% because videos get deleted or made private)*
- **Date and time of collection:** *(e.g. 6 November 2026, 11:42–11:46 UTC)*
- **Request pacing:** one request every 3–4.5 seconds, randomised
- **Tools used for analysis:** `analyze.py` (pandas + matplotlib)

## 4. Limitations — be honest, it earns marks

- **Snapshot, not a trend.** Engagement counts change every hour. These
  numbers describe the sample on the collection date only.
- **Sample size.** *(e.g. 156 videos)* — small enough for hand analysis, large
  enough to spot patterns, but not representative of all of TikTok.
- **Selection bias.** Hashtag pages are ranked by TikTok's algorithm, not
  randomly. You are seeing what TikTok chose to promote, and that algorithm
  favours engagement.
- **No comment text.** Only counts were collected, so you cannot analyse
  sentiment or language in comments.
- **Algorithm effects.** A video's performance depends on creator followers,
  paid promotion, and posting time — so you cannot claim that, for example,
  hashtags *cause* engagement.
- **Timezone.** Publish times are recorded in UTC, not the creator's local time.
- **Discovery is algorithmic.** Hashtag pages are ranked by TikTok's
  recommendation system, so the sample reflects promoted content, not a
  random draw from the tag. Creator profile posts come from TikTok's embed
  page, which returns roughly 3-13 recent posts per creator — so a
  "recent posts" sample is a *recent* slice, not a full back-catalogue.

## 5. Ethics and legality

- Only **public** metadata was collected; nothing behind a login.
- No personal data beyond public handles and public counters.
- No bulk crawling: only the specific hashtags listed above.
- TikTok's `robots.txt` allows `/tag` and `/discover` for general crawlers;
  `/search` is disallowed and was not used.
- The raw data is used for analysis only and is not redistributed.
- Where you publish results, report aggregates rather than individual creators.
- *(Optional but strong)* If you intend to publish the project, the officially
  sanctioned route is the **TikTok Research API** — ask your school whether it
  can apply.

## 6. Reproducing this

```bash
pip install -r requirements.txt
python -m playwright install chromium

python -m tiktok_scraper --hashtag booktok --hashtag studytok \
    --limit 30 --out data/ --format all --delay 3 --scroll-pause 4.5

python analyze.py data/tiktok_metadata.csv --out analysis/
```

To collect creator profiles as well:

```bash
python -m tiktok_scraper --profile bellapoarch --profile booktok --out data/
```

Or run the edge-hosted Worker instead (same output columns):

```bash
# from the repository root
npm install
npm run deploy
curl "https://tiktok-scraper.YOUR-SUBDOMAIN.workers.dev/api/scrape?format=csv&handles=bellapoarch"
```

Note that a re-run collects *different* videos, because hashtag pages are
algorithmically ranked and change over time. To reproduce the exact sample,
use the included `sample_data/tiktok_metadata.csv` instead.

## 7. Results

*(Paste your summary table and figures here — `analysis/summary_stats.csv` and
`analysis/top_hashtags.csv` are ready to go.)*

**Headline finding:**

> *(e.g. Across 156 videos, #booktok appeared in 56 of them and accounted for
> 69% of all likes in the sample.)*

**Supporting evidence:** *(reference the figure numbers)*
