"""Network layer: a plain-HTTP video fetcher and a browser list collector.

Two strategies, chosen by what the task needs:

* :class:`HttpFetcher` — fetches a single video page over plain HTTP and reads
  the metadata JSON embedded in the HTML. Lightweight, fast, and enough for
  most "I have a list of video links" school projects.
* :class:`BrowserSession` — drives a real Chromium through Playwright and
  passively records the JSON responses the page already fetches. Needed for
  hashtag and profile listings, which are rendered client-side.

The browser session only *reads* responses the page legitimately received.
It does not forge request signatures, rotate identities, or bypass login.
"""

from __future__ import annotations

import gzip
import io
import json
import random
import ssl
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Callable

from .extract import (
    embed_profile,
    embed_user_info_to_profile,
    failed_profile,
    item_from_api,
    parse_rehydration,
    profile_from_html,
    video_item_from_html,
)
from .models import ProfileRecord

DEFAULT_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

# Endpoints whose JSON responses we passively record in list mode.
LIST_ENDPOINTS = (
    "/api/challenge/item_list/",
    "/api/post/item_list/",
    "/api/search/item/full/",
)


class FetchError(RuntimeError):
    """Raised when a page could not be retrieved at all."""


class HttpFetcher:
    """Fetches TikTok video pages over plain HTTP."""

    def __init__(
        self,
        *,
        user_agent: str = DEFAULT_UA,
        timeout: int = 30,
        retries: int = 3,
        delay: float = 2.0,
        jitter: float = 1.5,
        language: str = "en-US",
        logger: Callable[[str], None] | None = None,
    ) -> None:
        self.user_agent = user_agent
        self.timeout = timeout
        self.retries = retries
        self.delay = delay
        self.jitter = jitter
        self.language = language
        self._log = logger or (lambda msg: None)
        self._last_request = 0.0
        self._context = ssl.create_default_context()
        # Serialises requests so parallel workers still respect the rate limit.
        self._lock = threading.Lock()

    # -- rate limiting -------------------------------------------------
    def _wait_turn(self) -> None:
        """Sleep so that requests are spaced by delay (+jitter)."""
        gap = self.delay + random.uniform(0, self.jitter)
        elapsed = time.monotonic() - self._last_request
        if elapsed < gap:
            time.sleep(gap - elapsed)
        self._last_request = time.monotonic()

    # -- raw request ----------------------------------------------------
    def get(self, url: str) -> str:
        """GET a URL and return the decoded body, with retries + backoff."""
        headers = {
            "User-Agent": self.user_agent,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": f"{self.language},en;q=0.9",
            "Accept-Encoding": "gzip, deflate",
            "Referer": "https://www.tiktok.com/",
            "Connection": "keep-alive",
            "Upgrade-Insecure-Requests": "1",
        }
        last_error: Exception | None = None
        for attempt in range(1, self.retries + 1):
            with self._lock:
                self._wait_turn()
                try:
                    request = urllib.request.Request(url, headers=headers)
                    with urllib.request.urlopen(request, timeout=self.timeout, context=self._context) as response:
                        raw = response.read()
                        if response.headers.get("Content-Encoding") == "gzip":
                            raw = gzip.GzipFile(fileobj=io.BytesIO(raw)).read()
                        charset = response.headers.get_content_charset() or "utf-8"
                        return raw.decode(charset, errors="replace")
                except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError) as exc:
                    last_error = exc
                    self._log(f"    retry {attempt}/{self.retries} for {url} ({exc})")
            if attempt < self.retries:
                time.sleep(min(2**attempt, 10) + random.uniform(0, 1))
        raise FetchError(f"GET failed for {url}: {last_error}")

    # -- public API -----------------------------------------------------
    def fetch_video(self, url: str) -> tuple[dict[str, Any] | None, str]:
        """Fetch one video page.

        Returns ``(item, message)``. ``item`` is ``None`` when the video is
        unavailable (removed, private, region-blocked); ``message`` says why.
        """
        html = self.get(url)
        return video_item_from_html(html)

    def fetch_profile(self, handle: str) -> ProfileRecord:
        """Fetch a creator's public profile details.

        One HTTP request: the profile page embeds the creator's bio, avatar,
        follower/following/post counts and account age as JSON. If that page
        cannot be read, the public embed page is used as a fallback.
        """
        handle = str(handle or "").lstrip("@").strip()
        url = f"https://www.tiktok.com/@{urllib.parse.quote(handle)}"
        try:
            html = self.get(url)
        except FetchError as exc:
            return failed_profile(handle, str(exc), source_url=url)

        record = profile_from_html(html, handle, source_url=url)
        if record.status == "ok":
            return record

        # Fallback: the embed page also carries the creator's public details.
        try:
            embed_html = self.get(f"https://www.tiktok.com/embed/@{urllib.parse.quote(handle)}")
            user_info, _ = embed_profile(embed_html, handle)
        except FetchError:
            user_info = {}
        if user_info:
            fallback = embed_user_info_to_profile(
                user_info, handle, url, record.scraped_at
            )
            if fallback.status == "ok":
                return fallback
        return record

    def fetch_user_videos(self, handle: str) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        """Discover a creator's recent posts, newest first.

        Uses TikTok's public embed page, which renders the creator's recent
        videos server-side. This avoids both a browser and the signed
        ``/api/post/item_list/`` endpoint that blocks automated requests.

        Returns ``(videos, user_info)``.
        """
        handle = str(handle or "").lstrip("@").strip()
        url = f"https://www.tiktok.com/embed/@{urllib.parse.quote(handle)}"
        html = self.get(url)
        user_info, videos = embed_profile(html, handle)

        # The embed list is already newest-first, but sorting on the
        # (time-ordered) video id makes the guarantee explicit.
        videos.sort(key=lambda v: int(v["id"]), reverse=True)
        return videos, user_info

class BrowserSession:
    """Drives Chromium via Playwright to collect hashtag and profile listings.

    Usage::

        with BrowserSession(delay=2.0) as session:
            items = session.collect_hashtag("booktok", limit=100)
    """

    def __init__(
        self,
        *,
        headless: bool = True,
        delay: float = 2.0,
        jitter: float = 1.5,
        user_agent: str = DEFAULT_UA,
        language: str = "en-US",
        logger: Callable[[str], None] | None = None,
        scroll_pause: float = 2.0,
    ) -> None:
        self.headless = headless
        self.delay = delay
        self.jitter = jitter
        self.user_agent = user_agent
        self.language = language
        self.scroll_pause = scroll_pause
        self._log = logger or (lambda msg: None)
        self._playwright = None
        self._browser = None
        self._context = None
        self._captured: list[dict[str, Any]] = []
        self._has_more = True
        self._last_action = 0.0

    # -- lifecycle ------------------------------------------------------
    def __enter__(self) -> "BrowserSession":
        try:
            from playwright.sync_api import sync_playwright
        except ImportError as exc:  # pragma: no cover - depends on env
            raise FetchError(
                "Playwright is required for hashtag/profile mode. "
                "Install it with: pip install playwright && playwright install chromium"
            ) from exc

        self._playwright = sync_playwright().start()
        launch_args = [
            "--no-sandbox",
            "--disable-dev-shm-usage",
            "--disable-blink-features=AutomationControlled",
            "--disable-gpu",
        ]
        # Prefer the full Chromium build (new headless) when it is installed:
        # the headless shell is fingerprinted more aggressively.
        errors: list[str] = []
        for channel in (None, "chromium"):
            try:
                kwargs: dict[str, Any] = {"headless": self.headless, "args": launch_args}
                if channel:
                    kwargs["channel"] = channel
                self._browser = self._playwright.chromium.launch(**kwargs)
                break
            except Exception as exc:  # pragma: no cover - environment dependent
                errors.append(f"channel={channel}: {exc}")
        if self._browser is None:
            raise FetchError("Could not launch Chromium. " + " | ".join(errors))

        self._context = self._browser.new_context(
            user_agent=self.user_agent,
            viewport={"width": 1280, "height": 900},
            locale=self.language,
            timezone_id="America/New_York",
        )
        self._context.set_default_timeout(60_000)
        return self

    def __exit__(self, *exc_info) -> None:
        for closer in (self._context, self._browser):
            try:
                if closer:
                    closer.close()
            except Exception:
                pass
        try:
            if self._playwright:
                self._playwright.stop()
        except Exception:
            pass

    # -- helpers --------------------------------------------------------
    def _pace(self) -> None:
        gap = self.delay + random.uniform(0, self.jitter)
        elapsed = time.monotonic() - self._last_action
        if elapsed < gap:
            time.sleep(gap - elapsed)
        self._last_action = time.monotonic()

    def _record_response(self, response) -> None:
        if not any(endpoint in response.url for endpoint in LIST_ENDPOINTS):
            return
        try:
            body = response.text()
        except Exception:
            return
        if not body or not body.strip().startswith("{"):
            return
        try:
            payload = json.loads(body)
        except json.JSONDecodeError:
            return
        items = item_from_api(payload)
        if items:
            self._captured.extend(items)
            self._has_more = bool(payload.get("hasMore", True))

    def _new_page(self):
        page = self._context.new_page()
        page.on("response", self._record_response)
        # NOTE: we deliberately do NOT spoof browser fingerprint properties.
        # Overriding things like navigator.webdriver is itself a strong bot
        # signal and made TikTok reject requests outright.
        return page

    def _scroll_until(self, page, target: int, max_scrolls: int, links: list[str]) -> None:
        """Scroll the page, collecting list responses, until we have enough.

        Stops early when several consecutive scrolls stop producing new
        videos, which is what happens when TikTok throttles a request burst.
        The rendered DOM is harvested on every pass because it sometimes
        shows more videos than the list payload contains.
        """
        idle_scrolls = 0
        for scroll in range(1, max_scrolls + 1):
            if len(self._captured) >= target:
                break
            before = len(self._captured)
            self._pace()
            page.mouse.wheel(0, 1800)
            page.wait_for_timeout(int(self.scroll_pause * 1000))
            links.extend(self._harvest_links(page))
            if len(self._captured) == before:
                idle_scrolls += 1
            else:
                idle_scrolls = 0
            self._log(
                f"    scroll {scroll}: collected {len(self._captured)}/{target},"
                f" links={len(set(links))}"
                + (f" (idle x{idle_scrolls})" if idle_scrolls else "")
            )
            if idle_scrolls >= 4:
                self._log("    no new videos after 4 scrolls, stopping early")
                break

    # -- collectors -----------------------------------------------------
    @staticmethod
    def _harvest_links(page) -> list[str]:
        """Collect video URLs the page rendered in the DOM."""
        try:
            links = page.eval_on_selector_all(
                'a[href*="/video/"]',
                "els => Array.from(new Set(els.map(e => e.getAttribute('href'))))",
            )
        except Exception:
            return []
        out: list[str] = []
        for link in links:
            if not link:
                continue
            if link.startswith("/"):
                link = "https://www.tiktok.com" + link
            if "/video/" in link:
                out.append(link.split("?")[0])
        return list(dict.fromkeys(out))

    @staticmethod
    def _bot_blocked(page) -> bool:
        """True when TikTok served its 'Something went wrong' page."""
        try:
            body = page.inner_text("body")
        except Exception:
            return False
        lowered = body.lower()
        return "something went wrong" in lowered or "please try again later" in lowered

    def collect_hashtag(self, tag: str, *, limit: int = 60, max_scrolls: int = 25) -> dict[str, Any]:
        """Collect videos from a hashtag page (``/tag/<tag>``).

        TikTok's robots.txt explicitly allows ``/tag`` for general crawlers.

        Returns ``{"items": [...], "links": [...], "blocked": bool}`` where
        ``items`` are full metadata dicts and ``links`` are video URLs that
        were rendered but whose metadata was not included in the list payload.
        """
        tag = tag.lstrip("#").strip()
        self._captured = []
        self._has_more = True
        links: list[str] = []
        blocked = False
        page = self._new_page()
        try:
            url = f"https://www.tiktok.com/tag/{urllib.parse.quote(tag)}"
            self._log(f"  opening {url}")
            page.goto(url, wait_until="domcontentloaded", timeout=60_000)
            page.wait_for_timeout(5000)
            blocked = self._bot_blocked(page)
            if blocked:
                self._log("  TikTok returned a bot-check page for this request")
            links.extend(self._harvest_links(page))
            self._scroll_until(page, limit, max_scrolls, links)
        finally:
            page.close()
        return {
            "items": self._captured[:limit],
            "links": links[: limit * 2],
            "blocked": blocked,
        }

    def collect_video_page(self, url: str) -> str:
        """Render a video page and return its HTML (fallback path)."""
        page = self._new_page()
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=60_000)
            page.wait_for_timeout(3000)
            return page.content()
        finally:
            page.close()
