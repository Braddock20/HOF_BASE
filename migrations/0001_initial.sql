CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS hof_profiles (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 display_name TEXT NOT NULL,
 slug TEXT NOT NULL UNIQUE,
 bio TEXT,
 avatar_media_id UUID,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','active','blocked','removed')),
 visibility TEXT NOT NULL DEFAULT 'public' CHECK(visibility IN ('public','unlisted','hidden')),
 claim_status TEXT NOT NULL DEFAULT 'unclaimed' CHECK(claim_status IN ('unclaimed','claim_pending','claimed')),
 created_by_user_id TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 removed_at TIMESTAMPTZ,
 blocked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_hof_profiles_public ON hof_profiles(status,visibility,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hof_profiles_name ON hof_profiles USING gin(to_tsvector('simple',display_name));

CREATE TABLE IF NOT EXISTS hof_social_accounts (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 profile_id UUID NOT NULL REFERENCES hof_profiles(id) ON DELETE RESTRICT,
 platform TEXT NOT NULL CHECK(platform IN ('tiktok','instagram','youtube')),
 platform_user_id TEXT, platform_secondary_id TEXT,
 username TEXT NOT NULL, profile_url TEXT NOT NULL,
 display_name TEXT, bio TEXT, is_private BOOLEAN, platform_verified BOOLEAN,
 followers BIGINT CHECK(followers IS NULL OR followers>=0),
 following BIGINT CHECK(following IS NULL OR following>=0),
 video_count BIGINT CHECK(video_count IS NULL OR video_count>=0),
 total_likes BIGINT CHECK(total_likes IS NULL OR total_likes>=0),
 metrics_availability JSONB NOT NULL DEFAULT '{}'::jsonb,
 avatar_url_temporary TEXT, last_synced_at TIMESTAMPTZ,
 provider_status TEXT NOT NULL DEFAULT 'partial' CHECK(provider_status IN ('ok','partial','not_found','rate_limited','error')),
 provider_message TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_hof_social_platform_user ON hof_social_accounts(platform,platform_user_id) WHERE platform_user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_hof_social_profile_platform_username ON hof_social_accounts(profile_id,platform,lower(username));
CREATE INDEX IF NOT EXISTS idx_hof_social_username ON hof_social_accounts(platform,lower(username));

CREATE TABLE IF NOT EXISTS hof_verifications (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 profile_id UUID NOT NULL REFERENCES hof_profiles(id) ON DELETE RESTRICT,
 verification_type TEXT NOT NULL CHECK(verification_type IN ('identity','campus')),
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','verified','rejected','revoked')),
 verified_by UUID, verified_at TIMESTAMPTZ, expires_at TIMESTAMPTZ,
 reason TEXT, evidence_ref TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(profile_id,verification_type)
);
CREATE TABLE IF NOT EXISTS hof_verification_history (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), profile_id UUID NOT NULL REFERENCES hof_profiles(id) ON DELETE RESTRICT,
 verification_type TEXT NOT NULL CHECK(verification_type IN ('identity','campus')),
 previous_status TEXT, new_status TEXT NOT NULL, actor_admin_id UUID,
 reason TEXT NOT NULL, evidence_ref TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_hof_verification_history_profile ON hof_verification_history(profile_id,created_at DESC);

CREATE TABLE IF NOT EXISTS hof_ranks (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
 description TEXT, badge_color TEXT NOT NULL DEFAULT '#555555' CHECK(badge_color ~ '^#[0-9A-Fa-f]{6}$'),
 text_color TEXT NOT NULL DEFAULT '#FFFFFF' CHECK(text_color ~ '^#[0-9A-Fa-f]{6}$'),
 icon TEXT, is_active BOOLEAN NOT NULL DEFAULT true, display_order INTEGER NOT NULL DEFAULT 0,
 created_by UUID, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS hof_profile_ranks (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), profile_id UUID NOT NULL REFERENCES hof_profiles(id) ON DELETE RESTRICT,
 rank_id UUID NOT NULL REFERENCES hof_ranks(id) ON DELETE RESTRICT, assigned_by UUID,
 assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(), expires_at TIMESTAMPTZ,
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked','expired')),
 reason TEXT NOT NULL, revoked_by UUID, revoked_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_hof_active_profile_rank ON hof_profile_ranks(profile_id,rank_id) WHERE status='active';
CREATE INDEX IF NOT EXISTS idx_hof_profile_ranks_profile ON hof_profile_ranks(profile_id,status);

CREATE TABLE IF NOT EXISTS hof_categories (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
 description TEXT, is_active BOOLEAN NOT NULL DEFAULT true, display_order INTEGER NOT NULL DEFAULT 0,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS hof_profile_categories (
 profile_id UUID NOT NULL REFERENCES hof_profiles(id) ON DELETE RESTRICT,
 category_id UUID NOT NULL REFERENCES hof_categories(id) ON DELETE RESTRICT,
 assigned_by UUID, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(profile_id,category_id)
);
CREATE TABLE IF NOT EXISTS hof_display_sections (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
 description TEXT, max_items INTEGER NOT NULL DEFAULT 10 CHECK(max_items>0),
 is_active BOOLEAN NOT NULL DEFAULT true, display_order INTEGER NOT NULL DEFAULT 0,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS hof_section_items (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), section_id UUID NOT NULL REFERENCES hof_display_sections(id) ON DELETE RESTRICT,
 profile_id UUID NOT NULL REFERENCES hof_profiles(id) ON DELETE RESTRICT, position INTEGER NOT NULL CHECK(position>=0),
 starts_at TIMESTAMPTZ, ends_at TIMESTAMPTZ, assigned_by UUID, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(section_id,profile_id), CHECK(ends_at IS NULL OR starts_at IS NULL OR ends_at>starts_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_hof_section_position ON hof_section_items(section_id,position);

CREATE TABLE IF NOT EXISTS hof_admins (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), auth_subject TEXT NOT NULL UNIQUE, email TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended','revoked')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), last_login_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS hof_roles (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT NOT NULL UNIQUE, slug TEXT NOT NULL UNIQUE,
 description TEXT, is_system BOOLEAN NOT NULL DEFAULT false, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS hof_permissions (id UUID PRIMARY KEY DEFAULT gen_random_uuid(),permission_key TEXT NOT NULL UNIQUE,description TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS hof_admin_roles (
 admin_id UUID NOT NULL REFERENCES hof_admins(id) ON DELETE RESTRICT,
 role_id UUID NOT NULL REFERENCES hof_roles(id) ON DELETE RESTRICT, assigned_by UUID, assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY(admin_id,role_id)
);
CREATE TABLE IF NOT EXISTS hof_role_permissions (
 role_id UUID NOT NULL REFERENCES hof_roles(id) ON DELETE RESTRICT,
 permission_id UUID NOT NULL REFERENCES hof_permissions(id) ON DELETE RESTRICT, PRIMARY KEY(role_id,permission_id)
);

CREATE TABLE IF NOT EXISTS hof_audit_logs (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), actor_admin_id UUID, actor_subject TEXT,
 action TEXT NOT NULL,target_type TEXT NOT NULL,target_id TEXT,reason TEXT,request_id TEXT,ip_hash TEXT,user_agent TEXT,
 before_state JSONB,after_state JSONB,created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_hof_audit_created ON hof_audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hof_audit_target ON hof_audit_logs(target_type,target_id,created_at DESC);
CREATE TABLE IF NOT EXISTS hof_moderation_actions (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),profile_id UUID NOT NULL REFERENCES hof_profiles(id) ON DELETE RESTRICT,
 action TEXT NOT NULL CHECK(action IN ('block','unblock','remove','restore','warning')),reason TEXT NOT NULL,
 actor_admin_id UUID,created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS hof_profile_reports (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),profile_id UUID NOT NULL REFERENCES hof_profiles(id) ON DELETE RESTRICT,
 reporter_user_id TEXT,report_type TEXT NOT NULL,description TEXT,status TEXT NOT NULL DEFAULT 'open'
 CHECK(status IN ('open','reviewing','resolved','dismissed')),reviewed_by UUID,resolution_note TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),resolved_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS hof_submissions (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), submitter_subject TEXT NOT NULL, display_name TEXT NOT NULL,
 platform TEXT CHECK(platform IS NULL OR platform IN ('tiktok','instagram','youtube')), username TEXT, profile_url TEXT,
 reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
 reviewed_by UUID, review_note TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), reviewed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_hof_submissions_status ON hof_submissions(status,created_at DESC);

CREATE TABLE IF NOT EXISTS hof_social_metric_snapshots (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), social_account_id UUID NOT NULL REFERENCES hof_social_accounts(id) ON DELETE RESTRICT,
 captured_at TIMESTAMPTZ NOT NULL DEFAULT now(), followers BIGINT, following BIGINT, videos BIGINT, likes BIGINT,
 availability JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_hof_metric_snapshots_account_time ON hof_social_metric_snapshots(social_account_id,captured_at DESC);
CREATE TABLE IF NOT EXISTS hof_sync_jobs (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), platform TEXT NOT NULL, social_account_id UUID,
 status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','succeeded','failed')),
 attempts INTEGER NOT NULL DEFAULT 0, requested_by TEXT, started_at TIMESTAMPTZ, finished_at TIMESTAMPTZ,
 error_summary TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS hof_awards (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),name TEXT NOT NULL,slug TEXT NOT NULL UNIQUE,description TEXT,
 category TEXT,status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','nominations','voting','published','closed')),
 nomination_starts_at TIMESTAMPTZ,nomination_ends_at TIMESTAMPTZ,voting_starts_at TIMESTAMPTZ,voting_ends_at TIMESTAMPTZ,
 published_at TIMESTAMPTZ,eligibility_rules JSONB NOT NULL DEFAULT '{}'::jsonb,created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS hof_nominations (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),award_id UUID NOT NULL REFERENCES hof_awards(id) ON DELETE RESTRICT,
 nominee_profile_id UUID NOT NULL REFERENCES hof_profiles(id) ON DELETE RESTRICT,nominator_subject TEXT NOT NULL,
 justification TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
 reviewer_id UUID,review_note TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS hof_votes (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),award_id UUID NOT NULL REFERENCES hof_awards(id) ON DELETE RESTRICT,
 nominee_profile_id UUID NOT NULL REFERENCES hof_profiles(id) ON DELETE RESTRICT,voter_subject TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),UNIQUE(award_id,voter_subject)
);
CREATE TABLE IF NOT EXISTS hof_award_winners (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),award_id UUID NOT NULL REFERENCES hof_awards(id) ON DELETE RESTRICT,
 profile_id UUID NOT NULL REFERENCES hof_profiles(id) ON DELETE RESTRICT,place INTEGER NOT NULL CHECK(place>0),
 published_at TIMESTAMPTZ NOT NULL DEFAULT now(),UNIQUE(award_id,place),UNIQUE(award_id,profile_id)
);

INSERT INTO hof_display_sections(name,slug,description,max_items,display_order)
VALUES ('Campus Icons','campus-icons','Curated campus personalities',12,1),
('Featured Personalities','featured-personalities','Editorially selected profiles',12,2),
('Trending Personalities','trending-personalities','Profiles with reliable recent momentum',12,3),
('Student Achievers','student-achievers','Recognized student achievements',12,4),
('Rising Stars','rising-stars','Emerging campus personalities',12,5)
ON CONFLICT(slug) DO NOTHING;

INSERT INTO hof_categories(name,slug,display_order) VALUES
('Creators','creators',1),('Comedy','comedy',2),('Music','music',3),('Fashion and Style','fashion-style',4),
('Sports','sports',5),('Photography','photography',6),('Arts and Performance','arts-performance',7),
('Entrepreneurship','entrepreneurship',8),('Academic Achievers','academic-achievers',9),
('Community Impact','community-impact',10),('Rising Stars','rising-stars',11),('Campus Personalities','campus-personalities',12)
ON CONFLICT(slug) DO NOTHING;

INSERT INTO hof_permissions(permission_key,description) VALUES
('admin.dashboard.view','View admin dashboard'),('admin.manage','Manage administrator accounts'),
('security.manage','Manage security settings'),('audit.view','View audit logs'),
('profile.view','View all profiles'),('profile.edit','Edit profile editorial fields'),
('profile.verify.identity','Verify identity'),('profile.verify.campus','Verify campus affiliation'),
('profile.verification.revoke','Revoke verification'),('profile.block','Block profiles'),
('profile.unblock','Unblock profiles'),('profile.remove','Remove profiles'),('profile.restore','Restore profiles'),
('profile.feature','Manage featured placement'),('profile.claim.review','Review profile claims'),
('rank.view','View ranks'),('rank.create','Create ranks'),('rank.edit','Edit ranks'),
('rank.activate','Activate or deactivate ranks'),('rank.assign','Assign ranks'),('rank.revoke','Revoke ranks'),
('section.manage','Manage curated sections'),('category.manage','Manage categories'),('award.manage','Manage awards'),
('nomination.review','Review nominations'),('vote.manage','Manage voting'),('report.review','Review reports'),
('report.resolve','Resolve reports'),('statistics.view','View statistics'),('sync.run','Run provider sync'),
('settings.manage','Manage settings')
ON CONFLICT(permission_key) DO NOTHING;

INSERT INTO hof_roles(name,slug,description,is_system) VALUES
('Super Admin','super-admin','Full system and security control',true),
('Admin','admin','General HOF administration',true),
('Editor','editor','Editorial profile and section management',true),
('Moderator','moderator','Reports and moderation',true),
('Awards Manager','awards-manager','Awards and nominations',true)
ON CONFLICT(slug) DO NOTHING;

-- Role grants are explicit and editable. Super Admin receives all seeded permissions.
INSERT INTO hof_role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM hof_roles r CROSS JOIN hof_permissions p WHERE r.slug='super-admin'
ON CONFLICT DO NOTHING;
INSERT INTO hof_role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM hof_roles r JOIN hof_permissions p ON p.permission_key IN
('admin.dashboard.view','profile.view','profile.edit','profile.verify.identity','profile.verify.campus',
'profile.verification.revoke','profile.block','profile.unblock','profile.remove','profile.restore',
'rank.view','rank.create','rank.edit','rank.activate','rank.assign','rank.revoke','section.manage','category.manage',
'report.review','report.resolve','statistics.view','sync.run')
WHERE r.slug='admin' ON CONFLICT DO NOTHING;
INSERT INTO hof_role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM hof_roles r JOIN hof_permissions p ON p.permission_key IN
('admin.dashboard.view','profile.view','profile.edit','profile.feature','section.manage','category.manage')
WHERE r.slug='editor' ON CONFLICT DO NOTHING;
INSERT INTO hof_role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM hof_roles r JOIN hof_permissions p ON p.permission_key IN
('admin.dashboard.view','profile.view','profile.block','profile.unblock','profile.remove','profile.restore','report.review','report.resolve')
WHERE r.slug='moderator' ON CONFLICT DO NOTHING;
INSERT INTO hof_role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM hof_roles r JOIN hof_permissions p ON p.permission_key IN
('admin.dashboard.view','profile.view','award.manage','nomination.review','vote.manage','rank.view','rank.assign','rank.revoke')
WHERE r.slug='awards-manager' ON CONFLICT DO NOTHING;
