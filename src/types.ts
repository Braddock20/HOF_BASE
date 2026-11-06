export interface Env {
  APP_ENV: string;
  DATABASE_URL: string;
  TIKTOK_SCRAPER_BASE_URL?: string;
  TIKTOK_SCRAPER_API_KEY?: string;
  ADMIN_API_KEY?: string;
  RATE_LIMIT_ENABLED?: string;
  CORS_ORIGINS?: string;
  LOG_LEVEL?: string;
  TIKTOK_PROFILE_PATH?: string;
  TIKTOK_POSTS_PATH?: string;
  TIKTOK_BATCH_PROFILE_PATH?: string;
  TIKTOK_SYNC_BATCH_SIZE?: string;
  TIKTOK_SYNC_ENABLED?: string;
  B2_ACCOUNT_ID?: string;
  B2_APPLICATION_KEY_ID?: string;
  B2_APPLICATION_KEY?: string;
  B2_BUCKET_ID?: string;
  B2_BUCKET_NAME?: string;
}

export interface AppVariables {
  requestId: string;
  subject?: string;
  userId?: string;
  permissions?: Set<string>;
  adminId?: string;
}
