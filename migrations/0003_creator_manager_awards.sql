-- Independent TikTok creator registry. These records intentionally do not
-- reference hof_profiles or require a HOF login/account.
CREATE TABLE IF NOT EXISTS hof_tiktok_creators (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 username TEXT NOT NULL,
 display_name TEXT,
 bio TEXT,
 notes TEXT,
 profile_url TEXT NOT NULL DEFAULT '',
 platform_user_id TEXT,
 sec_uid TEXT,
 avatar_url TEXT,
 is_private BOOLEAN,
 platform_verified BOOLEAN,
 followers BIGINT CHECK(followers IS NULL OR followers>=0),
 following BIGINT CHECK(following IS NULL OR following>=0),
 video_count BIGINT CHECK(video_count IS NULL OR video_count>=0),
 total_likes BIGINT CHECK(total_likes IS NULL OR total_likes>=0),
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','blocked')),
 provider_status TEXT NOT NULL DEFAULT 'pending' CHECK(provider_status IN ('pending','ok','partial','not_found','rate_limited','error')),
 provider_message TEXT,
 last_synced_at TIMESTAMPTZ,
 created_by TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_hof_tiktok_creator_username ON hof_tiktok_creators(lower(username));
CREATE INDEX IF NOT EXISTS idx_hof_tiktok_creators_status ON hof_tiktok_creators(status,created_at DESC);
CREATE TABLE IF NOT EXISTS hof_tiktok_creator_metric_snapshots (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 creator_id UUID NOT NULL REFERENCES hof_tiktok_creators(id) ON DELETE CASCADE,
 captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 followers BIGINT,following BIGINT,videos BIGINT,likes BIGINT,
 availability JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_hof_tiktok_creator_metrics ON hof_tiktok_creator_metric_snapshots(creator_id,captured_at DESC);

INSERT INTO hof_permissions(permission_key,description) VALUES
 ('creator.manage','Manage independent TikTok creator registry'),
 ('creator.sync','Refresh TikTok creator metadata from scraper')
ON CONFLICT(permission_key) DO NOTHING;
INSERT INTO hof_role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM hof_roles r CROSS JOIN hof_permissions p
WHERE r.slug='super-admin' AND p.permission_key IN ('creator.manage','creator.sync')
ON CONFLICT DO NOTHING;
