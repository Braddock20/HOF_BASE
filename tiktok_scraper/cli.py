"""Command-line interface for the TikTok metadata scraper."""

from __future__ import annotations

import argparse
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Any

from .extract import (
    embed_item_to_aweme,
    failed_record,
    normalize,
    video_id_from_url,
    video_item_from_html,
)
from .fetchers import BrowserSession, DEFAULT_UA, FetchError, HttpFetcher
from .models import ProfileRecord, VideoRecord
from .storage import build_profile_writer, build_writer, existing_ids, write_all

BANNER = r"""
  tiktok-scraper  -  public metadata collection for academic research
"""


# ---------------------------------------------------------------- helpers
def _log_factory(verbose: bool, quiet: bool):
    def log(message: str) -> None:
        if quiet:
            return
        stamp = datetime.now().strftime("%H:%M:%S")
        print(f"[{stamp}] {message}", flush=True)

    return log


def _read_url_file(path: str) -> list[str]:
    urls: list[str] = []
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if line and not line.startswith("#"):
                urls.append(line)
    return urls


def _apply_filters(record: VideoRecord, args: argparse.Namespace) -> bool:
    """Return True if the record passes the configured filters."""
    if args.min_likes:
        likes = record.likes
        if not isinstance(likes, int) or likes < args.min_likes:
            return False
    if args.min_duration:
        duration = record.duration_seconds
        if not isinstance(duration, int) or duration < args.min_duration:
            return False
    if args.since or args.until:
        if not record.create_date:
            return False
        if args.since and record.create_date < args.since:
            return False
        if args.until and record.create_date > args.until:
            return False
    return True


def _fetch_profiles(handles: list[str], args: argparse.Namespace, log) -> list[ProfileRecord]:
    """Fetch public profile details for each handle."""
    fetcher = HttpFetcher(
        user_agent=args.user_agent,
        timeout=args.timeout,
        retries=args.retries,
        delay=args.delay,
        jitter=args.jitter,
        language=args.lang,
        logger=log,
    )
    records: list[ProfileRecord] = []
    total = len(handles)
    for index, handle in enumerate(handles, start=1):
        record = fetcher.fetch_profile(handle)
        log(
            f"  [{index}/{total}] @{handle} -> {record.status}"
            + (f" ({record.status_message})" if record.status != "ok" else
               f", {record.follower_count} followers, {record.video_count} posts")
        )
        records.append(record)
    return records


def _collect_from_users(
    handles: list[str], args: argparse.Namespace, log
) -> tuple[dict[str, dict[str, Any]], list[str]]:
    """Discover each creator's recent posts.

    Uses the public embed page, which renders recent posts server-side, so
    this needs no browser. Returns ``(fallback_items, video_urls)`` where
    ``fallback_items`` maps video id -> partial record, used when the full
    video page cannot be read.
    """
    fetcher = HttpFetcher(
        user_agent=args.user_agent,
        timeout=args.timeout,
        retries=args.retries,
        delay=args.delay,
        jitter=args.jitter,
        language=args.lang,
        logger=log,
    )
    fallbacks: dict[str, dict[str, Any]] = {}
    urls: list[str] = []
    for handle in handles:
        clean = handle.lstrip("@").strip()
        try:
            videos, _ = fetcher.fetch_user_videos(clean)
        except FetchError as exc:
            log(f"  @{clean}: discovery failed ({exc})")
            continue
        if not videos:
            log(f"  @{clean}: no public posts found")
            continue
        log(f"  @{clean}: found {len(videos)} recent post(s)")
        for item in videos[: args.limit]:
            video_id = str(item.get("id") or "")
            author = item.get("authorUniqueId") or clean
            fallbacks[video_id] = embed_item_to_aweme(item)
            urls.append(f"https://www.tiktok.com/@{author}/video/{video_id}")
    return fallbacks, urls


def _collect_from_browser(
    args: argparse.Namespace, log
) -> tuple[list[tuple[dict[str, Any], str, str]], list[str]]:
    """Run the browser collectors.

    Returns ``(items, extra_urls)`` where ``items`` are aweme dicts that came
    with full metadata, and ``extra_urls`` are videos that were discovered in
    the page but whose metadata still has to be fetched over HTTP.
    """
    results: list[tuple[dict[str, Any], str, str]] = []
    extra_urls: list[str] = []
    with BrowserSession(
        headless=not args.headful,
        delay=args.delay,
        jitter=args.jitter,
        user_agent=args.user_agent,
        language=args.lang,
        logger=log,
        scroll_pause=args.scroll_pause,
    ) as session:
        for tag in args.hashtag:
            log(f"hashtag #{tag} (limit {args.limit})")
            try:
                found = session.collect_hashtag(tag, limit=args.limit)
            except Exception as exc:
                log(f"  hashtag #{tag} failed: {exc}")
                continue
            if found.get("blocked"):
                log(
                    "  TikTok served a bot-check page for this hashtag. "
                    "Slow down (raise --delay), wait a few minutes, "
                    "or switch to --url mode."
                )
            source = f"https://www.tiktok.com/tag/{tag.lstrip('#')}"
            items = found.get("items") or []
            log(f"  collected {len(items)} full items, {len(found.get('links') or [])} links")
            results.extend((item, source, "hashtag") for item in items)
            extra_urls.extend(_unseen_links(found.get("links") or [], items)[: args.limit])

    return results, list(dict.fromkeys(extra_urls))


def _unseen_links(links: list[str], items: list[dict[str, Any]]) -> list[str]:
    """Links whose video id was not already delivered with full metadata."""
    known = {str(item.get("id") or "") for item in items}
    out: list[str] = []
    for link in links:
        video_id = video_id_from_url(link)
        if not video_id or video_id in known:
            continue
        out.append(link)
    return out


def _fetch_urls(urls: list[str], args: argparse.Namespace, log) -> list[tuple[dict[str, Any] | None, str, str]]:
    """Fetch single video pages over HTTP, in parallel with rate limiting.

    Pages that need JavaScript to expose their metadata are retried through
    the browser renderer. Returns ``(item, url, message)`` triples where
    ``item`` is ``None`` for failures and ``message`` explains why.
    """
    results: list[tuple[dict[str, Any] | None, str, str]] = []
    fetcher = HttpFetcher(
        user_agent=args.user_agent,
        timeout=args.timeout,
        retries=args.retries,
        delay=args.delay,
        jitter=args.jitter,
        language=args.lang,
        logger=log,
    )

    needs_browser: list[str] = []

    def fetch(url: str):
        try:
            item, message = fetcher.fetch_video(url)
            return url, item, message
        except FetchError as exc:
            return url, None, str(exc)

    total = len(urls)
    with ThreadPoolExecutor(max_workers=max(1, args.concurrency)) as pool:
        for index, (url, item, message) in enumerate(pool.map(fetch, urls), start=1):
            if item is None and "no_rehydration_json" in message:
                needs_browser.append(url)
                log(f"  [{index}/{total}] {url} -> needs JS, will retry in browser")
                results.append((None, url, message))
                continue
            log(f"  [{index}/{total}] {url} -> {'ok' if item else message}")
            results.append((item, url, message))

    # Fallback: render pages that did not expose metadata over plain HTTP.
    if needs_browser:
        log(f"retrying {len(needs_browser)} page(s) with the browser renderer")
        with BrowserSession(
            headless=not args.headful,
            delay=args.delay,
            jitter=args.jitter,
            user_agent=args.user_agent,
            language=args.lang,
            logger=log,
        ) as session:
            for url in needs_browser:
                try:
                    html = session.collect_video_page(url)
                    item, message = video_item_from_html(html)
                except Exception as exc:
                    item, message = None, str(exc)
                log(f"  browser {url} -> {'ok' if item else message}")
                results = [
                    (item, u, message) if u == url else (i, u, m) for (i, u, m) in results
                ]
    return results


# ---------------------------------------------------------------- command
def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="tiktok-scraper",
        description="Collect public TikTok video metadata (captions, hashtags, sounds, "
        "engagement counts, publish times) for academic analysis.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""\
examples:
  # a specific video
  python -m tiktok_scraper --url "https://www.tiktok.com/@user/video/123"

  # a list of videos from a file
  python -m tiktok_scraper --urls-file examples/urls.txt --out data/

  # hashtag and profile listings (uses a real browser)
  python -m tiktok_scraper --hashtag booktok --limit 100 --out data/

  # everything into one run, CSV + JSONL + SQLite
  python -m tiktok_scraper --hashtag booktok --url "https://..." --format all
""",
    )

    source = parser.add_argument_group("sources")
    source.add_argument("--url", action="append", default=[], metavar="URL",
                        help="a single video URL (repeatable)")
    source.add_argument("--urls-file", metavar="PATH",
                        help="text file with one video URL per line")
    source.add_argument("--hashtag", action="append", default=[], metavar="TAG",
                        help="collect from a hashtag page, e.g. booktok (repeatable)")
    source.add_argument("--user", action="append", default=[], metavar="HANDLE",
                        help="collect from a creator profile, e.g. @booktok (repeatable)")
    source.add_argument("--profile", action="append", default=[], metavar="HANDLE",
                        help="fetch public profile details for a creator (repeatable): "
                             "bio, avatar, followers, following, post count")
    source.add_argument("--profiles-file", metavar="PATH",
                        help="text file with one creator handle per line")

    output = parser.add_argument_group("output")
    output.add_argument("--out", default="tiktok_data", metavar="DIR",
                        help="output directory (default: tiktok_data)")
    output.add_argument("--name", default="tiktok_metadata", metavar="STEM",
                        help="output file name stem (default: tiktok_metadata)")
    output.add_argument("--format", default="csv",
                        choices=["csv", "jsonl", "sqlite", "all"],
                        help="output format (default: csv)")
    output.add_argument("--resume", action="store_true",
                        help="skip videos already present in the output CSV")

    limits = parser.add_argument_group("limits & filters")
    limits.add_argument("--limit", type=int, default=60,
                        help="max videos per hashtag/profile (default: 60)")
    limits.add_argument("--min-likes", type=int, default=0, metavar="N",
                        help="only keep videos with at least N likes")
    limits.add_argument("--min-duration", type=int, default=0, metavar="SEC",
                        help="only keep videos at least SEC seconds long")
    limits.add_argument("--since", metavar="YYYY-MM-DD", help="only keep videos published on/after this date")
    limits.add_argument("--until", metavar="YYYY-MM-DD", help="only keep videos published on/before this date")

    behaviour = parser.add_argument_group("behaviour")
    behaviour.add_argument("--delay", type=float, default=2.0, metavar="SEC",
                           help="minimum pause between requests (default: 2.0)")
    behaviour.add_argument("--jitter", type=float, default=1.5, metavar="SEC",
                           help="extra random pause added to each delay (default: 1.5)")
    behaviour.add_argument("--concurrency", type=int, default=4,
                           help="parallel fetches for --url mode (default: 4)")
    behaviour.add_argument("--retries", type=int, default=3, help="retries per request (default: 3)")
    behaviour.add_argument("--timeout", type=int, default=30, help="request timeout in seconds (default: 30)")
    behaviour.add_argument("--scroll-pause", type=float, default=4.0, metavar="SEC",
                           help="pause between scrolls in browser mode (default: 4.0)")
    behaviour.add_argument("--headful", action="store_true", help="show the browser window (hashtag/profile mode)")
    behaviour.add_argument("--user-agent", default=DEFAULT_UA, help="custom User-Agent header")
    behaviour.add_argument("--lang", default="en-US", help="Accept-Language header (default: en-US)")
    behaviour.add_argument("--quiet", action="store_true", help="suppress progress output")
    behaviour.add_argument("--verbose", action="store_true", help="verbose progress output")

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    log = _log_factory(args.verbose, args.quiet)

    if not (args.url or args.urls_file or args.hashtag or args.user or args.profile or args.profiles_file):
        parser.error(
            "give at least one source: --url, --urls-file, --hashtag, --user, "
            "--profile or --profiles-file"
        )

    print(BANNER, file=sys.stderr)

    # ---- gather sources ----------------------------------------------
    url_targets: list[str] = list(args.url)
    if args.urls_file:
        if not os.path.exists(args.urls_file):
            parser.error(f"URLs file not found: {args.urls_file}")
        url_targets.extend(_read_url_file(args.urls_file))

    profile_handles: list[str] = list(args.profile)
    if args.profiles_file:
        if not os.path.exists(args.profiles_file):
            parser.error(f"Profiles file not found: {args.profiles_file}")
        profile_handles.extend(_read_url_file(args.profiles_file))
    profile_handles = list(dict.fromkeys(h.lstrip("@").strip() for h in profile_handles if h.strip()))

    # ---- resume support ---------------------------------------------
    seen: set[str] = set()
    if args.resume:
        stem = args.name
        seen = existing_ids(os.path.join(args.out, f"{stem}.csv"))
        if seen:
            log(f"resume: {len(seen)} videos already collected, skipping them")

    # ---- collect ------------------------------------------------------
    started = time.monotonic()
    browser_items: list[tuple[dict[str, Any], str, str]] = []
    url_results: list[tuple[dict[str, Any] | None, str, str]] = []
    discovered_urls: list[str] = []

    if args.hashtag:
        log("starting browser session for hashtag collection")
        browser_items, discovered_urls = _collect_from_browser(args, log)
        if discovered_urls:
            log(f"{len(discovered_urls)} discovered video(s) need full metadata; fetching over HTTP")

    fallback_items: dict[str, dict[str, Any]] = {}
    user_urls: set[str] = set()
    if args.user:
        log(f"discovering recent posts for {len(args.user)} creator(s)")
        fallback_items, discovered = _collect_from_users(args.user, args, log)
        user_urls = set(discovered)
        discovered_urls.extend(discovered)

    url_targets = list(dict.fromkeys(url_targets + discovered_urls))
    if url_targets:
        log(f"fetching {len(url_targets)} video page(s) over HTTP")
        url_results = _fetch_urls(url_targets, args, log)

    profile_records: list[ProfileRecord] = []
    if profile_handles:
        log(f"fetching {len(profile_handles)} creator profile(s)")
        profile_records = _fetch_profiles(profile_handles, args, log)

    # ---- normalise, filter, write ------------------------------------
    formats = ["csv", "jsonl", "sqlite"] if args.format == "all" else [args.format]
    writers = [build_writer(args.out, args.name, fmt) for fmt in formats]
    profile_writers = (
        [build_profile_writer(args.out, args.name, fmt) for fmt in formats]
        if profile_handles
        else []
    )

    scraped_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    written = 0
    filtered_out = 0
    failed = 0
    duplicates = 0
    unique_ids: set[str] = set()

    # Normalise both collection paths into (item, url, discovery_mode, message).
    entries: list[tuple[dict[str, Any] | None, str, str, str]] = []
    for item, source, mode in browser_items:
        entries.append((item, source, mode, ""))
    for item, url, message in url_results:
        entries.append((item, url, "user" if url in user_urls else "url", message))

    try:
        for item, url, mode, message in entries:
            if item is None:
                # A partial record from embed discovery beats no record at all.
                video_id = video_id_from_url(url)
                if video_id and video_id in fallback_items:
                    item = fallback_items[video_id]
                    message = "partial (embed page only)"
                    mode = "user"
            if item is None:
                record = failed_record(url, message or "unavailable", source_url=url, discovery_mode=mode)
                failed += 1
                write_all(writers, record)
                written += 1
                continue

            video_id = str(item.get("id") or "")
            if video_id in unique_ids:
                duplicates += 1
                continue
            unique_ids.add(video_id)
            if video_id in seen:
                continue

            record = normalize(item, source_url=url, discovery_mode=mode, scraped_at=scraped_at)
            if not _apply_filters(record, args):
                filtered_out += 1
                continue
            write_all(writers, record)
            written += 1
        for record in profile_records:
            for writer in profile_writers:
                writer.write(record)
    finally:
        for writer in writers:
            writer.close()
        for writer in profile_writers:
            writer.close()

    elapsed = time.monotonic() - started
    log("")
    log("=" * 58)
    log(f"  videos written : {written}")
    log(f"  failed/unavail : {failed}")
    log(f"  filtered out   : {filtered_out}")
    log(f"  duplicates     : {duplicates}")
    log(f"  elapsed        : {elapsed:.1f}s")
    if profile_records:
        log(f"  profiles       : {len(profile_records)}")
    for fmt in formats:
        path = os.path.join(args.out, f"{args.name}.{fmt}" if fmt != "sqlite" else f"{args.name}.sqlite3")
        log(f"  output         : {path}")
        if profile_handles:
            suffix = {"csv": ".csv", "jsonl": ".jsonl", "sqlite": ".sqlite3"}[fmt]
            log(f"  profile output : {os.path.join(args.out, args.name + '_profiles' + suffix)}")
    log("=" * 58)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
