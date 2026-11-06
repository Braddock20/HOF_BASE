import { describe, it, expect } from "vitest";
import { boolish, slugify } from "../src/http";
import { normalizeTikTok } from "../src/tiktok";

describe("HOF normalization", () => {
  it("normalizes slugs", () => expect(slugify("Campus Icon!")).toBe("campus-icon"));
  it("normalizes provider booleans", () => {
    expect(boolish("False")).toBe(false);
    expect(boolish("True")).toBe(true);
    expect(boolish("unknown")).toBe(null);
  });
  it("keeps missing metrics null, not zero", () => {
    const item = normalizeTikTok({ handle: "sample", follower_count: 0, verified: "False" }, "sample");
    expect(item.metrics.followers).toBe(0);
    expect(item.metrics.likes).toBe(null);
    expect(item.metricsAvailability.likes).toBe("unavailable");
    expect(item.platformVerified).toBe(false);
  });
});
