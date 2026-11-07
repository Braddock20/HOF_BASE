/**
 * Shared types for the TikTok metadata worker.
 *
 * Field names intentionally match the Python scraper's CSV schema
 * (`tiktok-scraper/`) so that data collected by either tool can be pooled
 * into one dataset without renaming columns.
 */

/** A single TikTok video's public metadata. */
export interface VideoRecord {
  video_id: string;
  url: string;
  source_url: string;
  discovery_mode: string;
  author_handle: string;
  author_id: string;
  author_nickname: string;
  author_verified: string;
  author_followers: string | number;
  author_following: string | number;
  author_video_count: string | number;
  author_heart_count: string | number;
  author_bio: string;
  author_avatar: string;
  caption: string;
  hashtags: string;
  hashtag_count: string | number;
  mentions: string;
  sound_id: string;
  sound_title: string;
  sound_author: string;
  sound_is_original: string;
  sound_duration: string | number;
  likes: string | number;
  comments: string | number;
  shares: string | number;
  saves: string | number;
  plays: string | number;
  reposts: string | number;
  create_time: string;
  create_date: string;
  create_hour: string | number;
  create_weekday: string;
  location_created: string;
  duration_seconds: string | number;
  width: string | number;
  height: string | number;
  cover_url: string;
  video_language: string;
  is_ad: string;
  is_pinned: string;
  is_aigc: string;
  scraped_at: string;
  status: string;
  status_message: string;
}

/** A creator's public profile details. */
export interface ProfileRecord {
  handle: string;
  profile_url: string;
  source_url: string;
  user_id: string;
  sec_uid: string;
  nickname: string;
  bio: string;
  bio_link: string;
  avatar_large: string;
  avatar_medium: string;
  avatar_thumb: string;
  verified: string;
  is_private: string;
  follower_count: string | number;
  following_count: string | number;
  video_count: string | number;
  total_likes: string | number;
  friend_count: string | number;
  account_created: string;
  account_created_date: string;
  language: string;
  show_music_tab: string;
  has_bio_link: string;
  scraped_at: string;
  status: string;
  status_message: string;
}

/** Column order for CSV output. */
export const VIDEO_FIELDS: (keyof VideoRecord)[] = [
  "video_id", "url", "source_url", "discovery_mode",
  "author_handle", "author_id", "author_nickname", "author_verified",
  "author_followers", "author_following", "author_video_count",
  "author_heart_count", "author_bio", "author_avatar",
  "caption", "hashtags", "hashtag_count", "mentions",
  "sound_id", "sound_title", "sound_author", "sound_is_original", "sound_duration",
  "likes", "comments", "shares", "saves", "plays", "reposts",
  "create_time", "create_date", "create_hour", "create_weekday",
  "location_created",
  "duration_seconds", "width", "height", "cover_url", "video_language",
  "is_ad", "is_pinned", "is_aigc",
  "scraped_at", "status", "status_message",
];

export const PROFILE_FIELDS: (keyof ProfileRecord)[] = [
  "handle", "profile_url", "source_url",
  "user_id", "sec_uid", "nickname", "bio", "bio_link",
  "avatar_large", "avatar_medium", "avatar_thumb",
  "verified", "is_private",
  "follower_count", "following_count", "video_count", "total_likes", "friend_count",
  "account_created", "account_created_date", "language",
  "show_music_tab", "has_bio_link",
  "scraped_at", "status", "status_message",
];
