"""Turn TikTok's nested page/API JSON into flat :class:`VideoRecord` rows.

TikTok serves the same underlying "aweme" schema in two places:

* the page HTML, as ``__UNIVERSAL_DATA_FOR_REHYDRATION__`` JSON, and
* the JSON that the web client fetches from ``/api/*/item_list/`` endpoints.

Because the schema is shared, one normaliser handles both, which is what
lets the browser-based list collectors feed the same pipeline as the
plain-HTTP single-video fetcher.
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from typing import Any, Iterable

from .models import ProfileRecord, VideoRecord

REHYDRATION_RE = re.compile(
    r'<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">(.*?)</script>',
    re.DOTALL,
)
HASHTAG_RE = re.compile(r"#([\wÀ-ɏ]+)")
MENTION_RE = re.compile(r"@([\w.\-]+)")

# TikTok counts are sometimes ints, sometimes strings, sometimes abbreviated
# ("35.2K", "1.4M"). Normalise all three to a plain int.
_MULTIPLIERS = {"K": 1_000, "M": 1_000_000, "B": 1_000_000_000}


def parse_number(value: Any) -> int | None:
    """Coerce a TikTok stat into an int, understanding K/M/B suffixes."""
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, (int, float)):
        return int(value)
    text = str(value).strip().replace(",", "")
    if not text:
        return None
    multiplier = 1
    if text[-1].upper() in _MULTIPLIERS:
        multiplier = _MULTIPLIERS[text[-1].upper()]
        text = text[:-1].strip()
    try:
        return int(float(text) * multiplier)
    except ValueError:
        return None


def parse_rehydration(html: str) -> dict[str, Any] | None:
    """Extract the ``__DEFAULT_SCOPE__`` object from a TikTok HTML page."""
    match = REHYDRATION_RE.search(html or "")
    if not match:
        return None
    try:
        payload = json.loads(match.group(1))
    except json.JSONDecodeError:
        return None
    scope = payload.get("__DEFAULT_SCOPE__")
    return scope if isinstance(scope, dict) else None


def video_item_from_html(html: str) -> tuple[dict[str, Any] | None, str]:
    """Pull the video item + status out of a rendered/HTML video page.

    Returns ``(item, status_message)``. ``item`` is ``None`` when the video is
    unavailable; ``status_message`` then explains why.
    """
    scope = parse_rehydration(html)
    if scope is None:
        return None, "no_rehydration_json"

    detail = scope.get("webapp.video-detail") or {}
    status_code = detail.get("statusCode")
    status_msg = detail.get("statusMsg") or ""

    item_struct = ((detail.get("itemInfo") or {}).get("itemStruct")) or {}
    if not item_struct:
        if status_code:
            return None, f"unavailable (statusCode={status_code} {status_msg})".strip()
        return None, "item_struct_missing"

    # TikTok reports deleted/private posts with a 0x0022 status code even
    # when a partial itemStruct is present.
    if status_code not in (0, None):
        return None, f"unavailable (statusCode={status_code} {status_msg})".strip()

    return item_struct, ""


def item_from_api(payload: dict[str, Any]) -> list[dict[str, Any]]:
    """Pull the aweme list out of an ``/api/*/item_list/`` response."""
    items = payload.get("itemList")
    if isinstance(items, list):
        return [i for i in items if isinstance(i, dict) and i.get("id")]
    return []


def _text_extra_parts(item: dict[str, Any]) -> tuple[list[str], list[str]]:
    """Return ``(hashtags, mentions)`` using TikTok's own annotation.

    ``textExtra`` is authoritative when present (it carries real hashtag IDs);
    we fall back to regex over the caption otherwise.
    """
    hashtags: list[str] = []
    mentions: list[str] = []
    for extra in item.get("textExtra") or []:
        if not isinstance(extra, dict):
            continue
        kind = extra.get("type")
        if kind == 1 and extra.get("hashtagName"):
            name = str(extra["hashtagName"]).strip()
            if name and name not in hashtags:
                hashtags.append(name)
        elif kind == 2 and (extra.get("uniqueId") or extra.get("userId")):
            handle = str(extra.get("uniqueId") or extra.get("userId")).strip()
            if handle and handle not in mentions:
                mentions.append(handle)

    caption = str(item.get("desc") or "")
    if not hashtags:
        hashtags = [h for h in HASHTAG_RE.findall(caption) if h.lower() != "fyp"]
    if not mentions:
        mentions = list(dict.fromkeys(MENTION_RE.findall(caption)))
    return hashtags, mentions


def _stats(item: dict[str, Any]) -> dict[str, int | None]:
    """Prefer ``statsV2`` (exact counts) and fall back to ``stats``."""
    v2 = item.get("statsV2") or {}
    base = item.get("stats") or {}

    def pick(name: str) -> int | None:
        raw = v2.get(name, base.get(name))
        return parse_number(raw)

    return {
        "likes": pick("diggCount"),
        "comments": pick("commentCount"),
        "shares": pick("shareCount"),
        "saves": pick("collectCount"),
        "plays": pick("playCount"),
        "reposts": pick("repostCount"),
    }


def _author_stats(item: dict[str, Any]) -> tuple[int | None, int | None, int | None, int | None]:
    """Pull follower / following / post-count / account-like numbers.

    TikTok exposes these on every video, so a video record can carry the
    author's reach without a second request.
    """
    stats = item.get("authorStats") or {}
    v2 = item.get("authorStatsV2") or {}

    def pick(name: str) -> int | None:
        raw = stats.get(name, v2.get(name))
        return parse_number(raw)

    return (
        pick("followerCount"),
        pick("followingCount"),
        pick("videoCount"),
        pick("heart"),
    )


def profile_from_html(
    html: str,
    handle: str = "",
    *,
    source_url: str = "",
    scraped_at: str = "",
) -> ProfileRecord:
    """Parse a creator profile page into a :class:`ProfileRecord`.

    The profile page embeds the creator's public details (bio, avatar,
    follower/following/post counts) as JSON, so one plain HTTP request is
    enough - no browser and no login.
    """
    scope = parse_rehydration(html)
    if scope is None:
        return failed_profile(handle, "no_rehydration_json", source_url=source_url)

    detail = scope.get("webapp.user-detail") or {}
    status_code = detail.get("statusCode")
    status_msg = detail.get("statusMsg") or ""

    user_info = detail.get("userInfo") or {}
    user = user_info.get("user") or {}
    stats = user_info.get("stats") or {}

    if not user and status_code not in (0, None):
        return failed_profile(
            handle,
            f"unavailable (statusCode={status_code} {status_msg})".strip(),
            source_url=source_url,
        )
    if not user:
        return failed_profile(handle, "profile_data_missing", source_url=source_url)

    unique_id = str(user.get("uniqueId") or handle.lstrip("@"))
    profile_url = f"https://www.tiktok.com/@{unique_id}"

    created_ts = parse_number(user.get("createTime"))
    created_iso = ""
    created_date = ""
    if created_ts:
        try:
            dt = datetime.fromtimestamp(created_ts, tz=timezone.utc)
            created_iso = dt.isoformat()
            created_date = dt.strftime("%Y-%m-%d")
        except (OverflowError, OSError, ValueError):
            pass

    # "heart" is the account's total likes; "heartCount" can be negative.
    total_likes = parse_number(stats.get("heart")) or 0
    if total_likes <= 0:
        total_likes = parse_number(stats.get("heartCount")) or 0

    bio_link = ""
    raw_link = user.get("bioLink")
    if isinstance(raw_link, dict):
        bio_link = str(raw_link.get("link") or "")
    elif isinstance(raw_link, str):
        bio_link = raw_link

    profile_tab = user.get("profileTab") or {}

    return ProfileRecord(
        handle=unique_id,
        profile_url=profile_url,
        source_url=source_url or profile_url,
        user_id=str(user.get("id") or ""),
        sec_uid=str(user.get("secUid") or ""),
        nickname=str(user.get("nickname") or ""),
        bio=str(user.get("signature") or ""),
        bio_link=bio_link,
        avatar_large=str(user.get("avatarLarger") or ""),
        avatar_medium=str(user.get("avatarMedium") or ""),
        avatar_thumb=str(user.get("avatarThumb") or ""),
        verified=bool(user.get("verified")),
        is_private=bool(user.get("privateAccount")),
        follower_count=parse_number(stats.get("followerCount")) or 0,
        following_count=parse_number(stats.get("followingCount")) or 0,
        video_count=parse_number(stats.get("videoCount")) or 0,
        total_likes=total_likes,
        friend_count=parse_number(stats.get("friendCount")) or 0,
        account_created=created_iso,
        account_created_date=created_date,
        language=str(user.get("language") or ""),
        show_music_tab=bool(profile_tab.get("showMusicTab")),
        has_bio_link=bool(bio_link),
        scraped_at=scraped_at or datetime.now(timezone.utc).isoformat(timespec="seconds"),
        status="ok",
        status_message="",
    )


def failed_profile(handle: str, reason: str, *, source_url: str = "") -> ProfileRecord:
    """Placeholder row for a profile that could not be read."""
    handle = str(handle or "").lstrip("@")
    return ProfileRecord(
        handle=handle,
        profile_url=f"https://www.tiktok.com/@{handle}" if handle else "",
        source_url=source_url or f"https://www.tiktok.com/@{handle}",
        scraped_at=datetime.now(timezone.utc).isoformat(timespec="seconds"),
        status="failed",
        status_message=reason,
    )


FRONTITY_RE = re.compile(
    r'<script[^>]*id="__FRONTITY_CONNECT_STATE__"[^>]*type="application/json"[^>]*>(.*?)</script>',
    re.DOTALL,
)


def parse_frontity(html: str) -> dict[str, Any] | None:
    """Parse the ``__FRONTITY_CONNECT_STATE__`` blob used by embed pages.

    TikTok's public embed pages (``/embed/@handle``) render the creator's
    recent videos server-side, which makes them a reliable source of recent
    post IDs without a browser or an API signature.
    """
    match = FRONTITY_RE.search(html or "")
    if not match:
        return None
    try:
        payload = json.loads(match.group(1))
    except json.JSONDecodeError:
        return None
    data = (payload.get("source") or {}).get("data")
    return data if isinstance(data, dict) else None


def embed_profile(html: str, handle: str) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Pull ``(userInfo, videoList)`` out of an embed page.

    The video list is ordered newest-first by TikTok.
    """
    data = parse_frontity(html)
    if data is None:
        return {}, []
    key = f"/embed/@{handle.lstrip('@')}"
    profile = data.get(key) or {}
    if not isinstance(profile, dict):
        return {}, []
    user_info = profile.get("userInfo") or {}
    video_list = profile.get("videoList") or []
    videos = [v for v in video_list if isinstance(v, dict) and v.get("id")]
    return user_info, videos


def embed_item_to_aweme(item: dict[str, Any]) -> dict[str, Any]:
    """Convert an embed video entry into the aweme shape ``normalize`` expects.

    Used as a fallback when the full video page cannot be read, so a
    partially-known video still produces a usable row.
    """
    video = {
        "cover": item.get("coverUrl") or "",
        "originCover": item.get("originCoverUrl") or "",
        "dynamicCover": item.get("dynamicCoverUrl") or "",
        "width": item.get("width"),
        "height": item.get("height"),
        "ratio": item.get("ratio"),
    }
    return {
        "id": item.get("id"),
        "desc": item.get("desc") or "",
        "author": {"uniqueId": item.get("authorUniqueId") or ""},
        "video": video,
        "stats": {"playCount": item.get("playCount")},
        "createTime": item.get("createTime"),
    }


def embed_user_info_to_profile(
    user_info: dict[str, Any], handle: str, source_url: str, scraped_at: str = ""
) -> ProfileRecord:
    """Build a profile record from embed page user info.

    This is a secondary source: the profile page (``webapp.user-detail``)
    is richer, but the embed page still exposes bio, avatar and the
    follower / following counts, so it is a useful fallback.
    """
    unique_id = str(user_info.get("uniqueId") or handle.lstrip("@"))
    profile_url = f"https://www.tiktok.com/@{unique_id}"
    created_ts = parse_number(user_info.get("createTime"))
    created_iso = ""
    created_date = ""
    if created_ts:
        try:
            dt = datetime.fromtimestamp(created_ts, tz=timezone.utc)
            created_iso = dt.isoformat()
            created_date = dt.strftime("%Y-%m-%d")
        except (OverflowError, OSError, ValueError):
            pass

    hearts = parse_number(user_info.get("heartCount")) or 0

    return ProfileRecord(
        handle=unique_id,
        profile_url=profile_url,
        source_url=source_url or profile_url,
        user_id=str(user_info.get("id") or ""),
        nickname=str(user_info.get("nickname") or ""),
        bio=str(user_info.get("signature") or ""),
        avatar_thumb=str(user_info.get("avatarThumbUrl") or ""),
        verified=bool(user_info.get("verified")),
        is_private=bool(user_info.get("privateAccount")),
        follower_count=parse_number(user_info.get("followerCount")) or 0,
        following_count=parse_number(user_info.get("followingCount")) or 0,
        total_likes=hearts if hearts > 0 else 0,
        account_created=created_iso,
        account_created_date=created_date,
        scraped_at=scraped_at or datetime.now(timezone.utc).isoformat(timespec="seconds"),
        status="ok",
        status_message="",
    )


def normalize(
    item: dict[str, Any],
    *,
    source_url: str = "",
    discovery_mode: str = "",
    scraped_at: str = "",
) -> VideoRecord:
    """Convert a raw TikTok aweme dict into a flat :class:`VideoRecord`."""
    item = item or {}
    video_id = str(item.get("id") or item.get("aweme_id") or "")

    author = item.get("author") or {}
    music = item.get("music") or {}
    video = item.get("video") or {}

    caption = str(item.get("desc") or "")
    hashtags, mentions = _text_extra_parts(item)
    stats = _stats(item)
    followers, following, video_count, hearts = _author_stats(item)

    create_ts = parse_number(item.get("createTime"))
    create_iso = ""
    create_date = ""
    create_hour = ""
    create_weekday = ""
    if create_ts:
        try:
            dt = datetime.fromtimestamp(create_ts, tz=timezone.utc)
            create_iso = dt.isoformat()
            create_date = dt.strftime("%Y-%m-%d")
            create_hour = dt.hour
            create_weekday = dt.strftime("%A")
        except (OverflowError, OSError, ValueError):
            pass

    challenges = [
        str(c.get("title") or "")
        for c in (item.get("challenges") or [])
        if isinstance(c, dict) and c.get("title")
    ]
    for challenge in challenges:
        if challenge.lower() not in [h.lower() for h in hashtags]:
            hashtags.append(challenge)

    record = VideoRecord(
        video_id=video_id,
        url=f"https://www.tiktok.com/@{author.get('uniqueId', '')}/video/{video_id}"
        if video_id and author.get("uniqueId")
        else f"https://www.tiktok.com/video/{video_id}",
        source_url=source_url,
        discovery_mode=discovery_mode,
        author_handle=str(author.get("uniqueId") or ""),
        author_id=str(author.get("id") or ""),
        author_nickname=str(author.get("nickname") or ""),
        author_verified=author.get("verified"),
        author_followers=followers if followers is not None else "",
        author_following=following if following is not None else "",
        author_video_count=video_count if video_count is not None else "",
        author_heart_count=hearts if hearts is not None else "",
        author_bio=str(author.get("signature") or ""),
        author_avatar=str(author.get("avatarLarger") or author.get("avatarMedium") or ""),
        caption=caption,
        hashtags=",".join(hashtags),
        hashtag_count=len(hashtags),
        mentions=",".join(mentions),
        sound_id=str(music.get("id") or ""),
        sound_title=str(music.get("title") or ""),
        sound_author=str(music.get("authorName") or music.get("author") or ""),
        sound_is_original=music.get("original"),
        sound_duration=parse_number(music.get("duration")) or "",
        likes=stats["likes"] if stats["likes"] is not None else "",
        comments=stats["comments"] if stats["comments"] is not None else "",
        shares=stats["shares"] if stats["shares"] is not None else "",
        saves=stats["saves"] if stats["saves"] is not None else "",
        plays=stats["plays"] if stats["plays"] is not None else "",
        reposts=stats["reposts"] if stats["reposts"] is not None else "",
        create_time=str(create_ts) if create_ts else "",
        create_date=create_date,
        create_hour=create_hour,
        create_weekday=create_weekday,
        location_created=str(item.get("locationCreated") or ""),
        duration_seconds=parse_number(video.get("duration")) or "",
        width=parse_number(video.get("width")) or "",
        height=parse_number(video.get("height")) or "",
        cover_url=str(video.get("cover") or video.get("originCover") or video.get("dynamicCover") or ""),
        video_language=str(item.get("textLanguage") or ""),
        is_ad=bool(item.get("isAd")),
        is_pinned=bool(item.get("isPinnedItem")),
        is_aigc=bool(item.get("IsAigc")),
        scraped_at=scraped_at or datetime.now(timezone.utc).isoformat(timespec="seconds"),
        status="ok",
        status_message="",
    )
    return record


def video_id_from_url(url: str) -> str:
    """Pull the numeric video id out of a TikTok video URL."""
    match = re.search(r"/video/(\d+)", url or "")
    return match.group(1) if match else ""


def failed_record(url: str, reason: str, *, source_url: str = "", discovery_mode: str = "") -> VideoRecord:
    """A placeholder row so failed fetches still show up in the output."""
    return VideoRecord(
        video_id=video_id_from_url(url),
        url=url,
        source_url=source_url,
        discovery_mode=discovery_mode,
        scraped_at=datetime.now(timezone.utc).isoformat(timespec="seconds"),
        status="failed",
        status_message=reason,
    )
