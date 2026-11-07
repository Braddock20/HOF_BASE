import { describe, it, expect } from "vitest";
import { boolish, slugify } from "../src/http";
import { normalizeTikTok } from "../src/tiktok";
import { parseMetric, allMetrics } from "../src/leaderboard";

describe("HOF normalization", () => {
  it("normalizes slugs", () => expect(slugify("Campus Icon!")).toBe("campus-icon"));
  it("normalizes provider booleans", () => {
    expect(boolish("False")).toBe(false);
    expect(boolish("True")).toBe(true);
    expect(boolish("unknown")).toBe(null);
  });
  it("normalizes the live scraper profile shape and string booleans", () => {
    const item = normalizeTikTok({
      handle: "icon_ritty",
      user_id: "7332419138591376389",
      sec_uid: "sample-sec-uid",
      nickname: "@Icon _ritty",
      status: "ok",
      verified: "False",
      is_private: "False",
      follower_count: 21700,
      following_count: 103,
      video_count: 377,
      total_likes: 577200
    }, "icon_ritty");
    expect(item.username).toBe("icon_ritty");
    expect(item.platformUserId).toBe("7332419138591376389");
    expect(item.providerStatus).toBe("ok");
    expect(item.isPrivate).toBe(false);
    expect(item.platformVerified).toBe(false);
    expect(item.metrics.followers).toBe(21700);
  });
  it("keeps missing metrics null, not zero", () => {
    const item = normalizeTikTok({ handle: "sample", follower_count: 0, verified: "False" }, "sample");
    expect(item.metrics.followers).toBe(0);
    expect(item.metrics.likes).toBe(null);
    expect(item.metricsAvailability.likes).toBe("unavailable");
    expect(item.platformVerified).toBe(false);
  });
});

describe("leaderboard metrics", () => {
  it("parses totals and growth metrics", () => {
    expect(parseMetric("followers")).toEqual({ base: "followers", kind: "total" });
    expect(parseMetric("likes_gain")).toEqual({ base: "likes", kind: "gain" });
    expect(parseMetric("followers_loss")).toEqual({ base: "followers", kind: "loss" });
    expect(parseMetric("videos_growth")).toEqual({ base: "videos", kind: "growth" });
  });
  it("rejects unknown or injected metrics", () => {
    expect(parseMetric("followers; DROP TABLE x")).toBeNull();
    expect(parseMetric("followers_sideways")).toBeNull();
    expect(parseMetric("password")).toBeNull();
  });
  it("lists 12 metrics", () => expect(allMetrics()).toHaveLength(12));
});
