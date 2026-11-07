"""Data model for a scraped TikTok video record."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any

#: Ordered output schema. Also used to build the CSV header.
FIELDS: list[str] = [
    # identity
    "video_id",
    "url",
    "source_url",
    "discovery_mode",
    # author
    "author_handle",
    "author_id",
    "author_nickname",
    "author_verified",
    "author_followers",
    "author_following",
    "author_video_count",
    "author_heart_count",
    "author_bio",
    "author_avatar",
    # content
    "caption",
    "hashtags",
    "hashtag_count",
    "mentions",
    # sound
    "sound_id",
    "sound_title",
    "sound_author",
    "sound_is_original",
    "sound_duration",
    # engagement
    "likes",
    "comments",
    "shares",
    "saves",
    "plays",
    "reposts",
    # when / where
    "create_time",
    "create_date",
    "create_hour",
    "create_weekday",
    "location_created",
    # technical
    "duration_seconds",
    "width",
    "height",
    "cover_url",
    "video_language",
    "is_ad",
    "is_pinned",
    "is_aigc",
    # provenance
    "scraped_at",
    "status",
    "status_message",
]


@dataclass
class VideoRecord:
    """One video's worth of public metadata.

    Every field is optional because TikTok omits data depending on region,
    age of the post, and whether the account is private or removed.
    """

    video_id: str = ""
    url: str = ""
    source_url: str = ""
    discovery_mode: str = ""

    author_handle: str = ""
    author_id: str = ""
    author_nickname: str = ""
    author_verified: Any = ""
    author_followers: Any = ""
    author_following: Any = ""
    author_video_count: Any = ""
    author_heart_count: Any = ""
    author_bio: str = ""
    author_avatar: str = ""

    caption: str = ""
    hashtags: str = ""
    hashtag_count: Any = ""
    mentions: str = ""

    sound_id: str = ""
    sound_title: str = ""
    sound_author: str = ""
    sound_is_original: Any = ""
    sound_duration: Any = ""

    likes: Any = ""
    comments: Any = ""
    shares: Any = ""
    saves: Any = ""
    plays: Any = ""
    reposts: Any = ""

    create_time: str = ""
    create_date: str = ""
    create_hour: Any = ""
    create_weekday: Any = ""

    location_created: str = ""
    duration_seconds: Any = ""
    width: Any = ""
    height: Any = ""
    cover_url: str = ""
    video_language: str = ""
    is_ad: Any = ""
    is_pinned: Any = ""
    is_aigc: Any = ""

    scraped_at: str = ""
    status: str = ""
    status_message: str = ""

    def to_dict(self) -> dict[str, Any]:
        """Flat dict with only the schema fields, in schema order."""
        raw = asdict(self)
        return {k: raw.get(k, "") for k in FIELDS}

    def to_row(self) -> list[Any]:
        """List ordered like :data:`FIELDS`, ready for CSV."""
        data = self.to_dict()
        return [data[k] for k in FIELDS]


#: Ordered output schema for creator profiles.
PROFILE_FIELDS: list[str] = [
    "handle",
    "profile_url",
    "source_url",
    "user_id",
    "sec_uid",
    "nickname",
    "bio",
    "bio_link",
    "avatar_large",
    "avatar_medium",
    "avatar_thumb",
    "verified",
    "is_private",
    "follower_count",
    "following_count",
    "video_count",
    "total_likes",
    "friend_count",
    "account_created",
    "account_created_date",
    "language",
    "show_music_tab",
    "has_bio_link",
    "scraped_at",
    "status",
    "status_message",
]


@dataclass
class ProfileRecord:
    """Public information about a creator's profile."""

    handle: str = ""
    profile_url: str = ""
    source_url: str = ""
    user_id: str = ""
    sec_uid: str = ""
    nickname: str = ""
    bio: str = ""
    bio_link: str = ""
    avatar_large: str = ""
    avatar_medium: str = ""
    avatar_thumb: str = ""
    verified: Any = ""
    is_private: Any = ""
    follower_count: Any = ""
    following_count: Any = ""
    video_count: Any = ""
    total_likes: Any = ""
    friend_count: Any = ""
    account_created: str = ""
    account_created_date: str = ""
    language: str = ""
    show_music_tab: Any = ""
    has_bio_link: Any = ""
    scraped_at: str = ""
    status: str = ""
    status_message: str = ""

    def to_dict(self) -> dict[str, Any]:
        raw = asdict(self)
        return {k: raw.get(k, "") for k in PROFILE_FIELDS}

    def to_row(self) -> list[Any]:
        data = self.to_dict()
        return [data[k] for k in PROFILE_FIELDS]
