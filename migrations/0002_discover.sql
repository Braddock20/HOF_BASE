-- HOF Discover, submissions, moderation, feed sessions and private B2 media references.
CREATE TABLE IF NOT EXISTS hof_media_assets (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 storage_provider TEXT NOT NULL DEFAULT 'b2',
 object_key TEXT NOT NULL UNIQUE,
 b2_file_id TEXT,
 mime_type TEXT NOT NULL,
 file_size BIGINT,
 width INTEGER,
 height INTEGER,
 checksum_sha1 TEXT,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','ready','deleted','failed')),
 visibility TEXT NOT NULL DEFAULT 'private' CHECK(visibility IN ('private','public')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 deleted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_hof_media_status ON hof_media_assets(status,visibility);

CREATE TABLE IF NOT EXISTS hof_discover_posts (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 source TEXT NOT NULL DEFAULT 'hof' CHECK(source IN ('tiktok','hof','external')),
 source_post_id TEXT,
 source_url TEXT,
 creator_social_account_id UUID REFERENCES hof_social_accounts(id) ON DELETE SET NULL,
 creator_name TEXT,
 creator_handle TEXT,
 caption TEXT,
 hashtags TEXT[] NOT NULL DEFAULT '{}',
 media_type TEXT NOT NULL CHECK(media_type IN ('video','image','carousel')),
 media_url TEXT,
 thumbnail_media_id UUID REFERENCES hof_media_assets(id) ON DELETE SET NULL,
 media_asset_id UUID REFERENCES hof_media_assets(id) ON DELETE SET NULL,
 external_thumbnail_url TEXT,
 duration_seconds NUMERIC(8,2),
 width INTEGER,
 height INTEGER,
 published_at TIMESTAMPTZ,
 likes BIGINT,
 comments BIGINT,
 shares BIGINT,
 saves BIGINT,
 plays BIGINT,
 reposts BIGINT,
 source_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','hidden','deleted')),
 visibility TEXT NOT NULL DEFAULT 'public' CHECK(visibility IN ('public','unlisted','hidden')),
 is_pinned BOOLEAN NOT NULL DEFAULT false,
 approved_by UUID,
 approved_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 deleted_at TIMESTAMPTZ,
 UNIQUE(source,source_post_id)
);
CREATE INDEX IF NOT EXISTS idx_hof_discover_feed ON hof_discover_posts(status,visibility,published_at DESC);
CREATE INDEX IF NOT EXISTS idx_hof_discover_creator ON hof_discover_posts(creator_social_account_id,published_at DESC);

CREATE TABLE IF NOT EXISTS hof_discover_feed_sessions (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 post_ids UUID[] NOT NULL,
 generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 expires_at TIMESTAMPTZ NOT NULL DEFAULT now()+interval '2 days'
);
CREATE INDEX IF NOT EXISTS idx_hof_feed_sessions_expiry ON hof_discover_feed_sessions(expires_at);

CREATE TABLE IF NOT EXISTS hof_discover_reports (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 post_id UUID NOT NULL REFERENCES hof_discover_posts(id) ON DELETE RESTRICT,
 reporter_ref TEXT,
 report_type TEXT NOT NULL,
 description TEXT,
 status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','reviewing','resolved','dismissed')),
 reviewed_by UUID,
 resolution_note TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 reviewed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_hof_discover_reports_queue ON hof_discover_reports(status,created_at DESC);

CREATE TABLE IF NOT EXISTS hof_creator_requests (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 display_name TEXT,
 platform TEXT NOT NULL DEFAULT 'tiktok' CHECK(platform IN ('tiktok','instagram','youtube')),
 username TEXT NOT NULL,
 profile_url TEXT,
 reason TEXT NOT NULL,
 submitter_ref TEXT,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
 reviewed_by UUID,
 review_note TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 reviewed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_hof_creator_requests_queue ON hof_creator_requests(status,created_at DESC);

CREATE TABLE IF NOT EXISTS hof_discover_submissions (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 submitter_ref TEXT,
 source TEXT NOT NULL DEFAULT 'external' CHECK(source IN ('tiktok','external','hof')),
 source_url TEXT,
 source_post_id TEXT,
 creator_handle TEXT,
 caption TEXT,
 media_type TEXT NOT NULL CHECK(media_type IN ('video','image','carousel')),
 thumbnail_url TEXT,
 media_url TEXT,
 width INTEGER,
 height INTEGER,
 duration_seconds NUMERIC(8,2),
 reason TEXT NOT NULL,
 media_asset_id UUID REFERENCES hof_media_assets(id) ON DELETE SET NULL,
 thumbnail_media_id UUID REFERENCES hof_media_assets(id) ON DELETE SET NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
 reviewed_by UUID,
 review_note TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 reviewed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_hof_discover_submissions_queue ON hof_discover_submissions(status,created_at DESC);

INSERT INTO hof_permissions(permission_key,description) VALUES
('discover.view','View Discover moderation data'),
('discover.moderate','Approve, hide, restore and delete Discover posts'),
('discover.reports.review','Review and resolve Discover reports'),
('discover.submissions.review','Review user Discover submissions'),
('creator.requests.review','Review user-submitted creator requests'),
('media.manage','Manage private media references')
ON CONFLICT(permission_key) DO NOTHING;

-- Existing super-admin receives all permissions dynamically through requireAdmin.
INSERT INTO hof_role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM hof_roles r CROSS JOIN hof_permissions p WHERE r.slug='super-admin'
ON CONFLICT DO NOTHING;
INSERT INTO hof_role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM hof_roles r JOIN hof_permissions p ON p.permission_key IN
('discover.view','discover.moderate','discover.reports.review','discover.submissions.review','creator.requests.review','media.manage')
WHERE r.slug IN ('admin','moderator') ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS hof_post_metric_snapshots (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 post_id UUID NOT NULL REFERENCES hof_discover_posts(id) ON DELETE CASCADE,
 captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 likes BIGINT,comments BIGINT,shares BIGINT,saves BIGINT,plays BIGINT,reposts BIGINT
);
CREATE INDEX IF NOT EXISTS idx_hof_post_metrics_time ON hof_post_metric_snapshots(post_id,captured_at DESC);

CREATE TABLE IF NOT EXISTS hof_discover_seen_posts (
 visitor_hash TEXT NOT NULL,
 post_id UUID NOT NULL REFERENCES hof_discover_posts(id) ON DELETE CASCADE,
 last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY(visitor_hash,post_id)
);
CREATE INDEX IF NOT EXISTS idx_hof_discover_seen_recent ON hof_discover_seen_posts(visitor_hash,last_seen_at DESC);

CREATE TABLE IF NOT EXISTS hof_deleted_source_posts (
 source TEXT NOT NULL,
 source_post_id TEXT NOT NULL,
 reason TEXT NOT NULL,
 deleted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY(source,source_post_id)
);
