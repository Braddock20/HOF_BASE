export interface Env {
  APP_ENV: string;
  DATABASE_URL: string;
  TIKTOK_SCRAPER_BASE_URL?: string;
  TIKTOK_SCRAPER_API_KEY?: string;
  ADMIN_API_KEY?: string;
  RATE_LIMIT_ENABLED?: string;
  LOG_LEVEL?: string;
}

export interface AppVariables {
  requestId: string;
  subject?: string;
  userId?: string;
  permissions?: Set<string>;
  adminId?: string;
}
