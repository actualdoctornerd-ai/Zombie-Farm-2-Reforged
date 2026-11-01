import { describe, expect, it } from "vitest";
import { devKeyAccepted } from "../src/auth";

describe("devKeyAccepted", () => {
  it("asks for no key when none is configured (local dev, test harness)", async () => {
    expect(await devKeyAccepted({}, undefined)).toBe(true);
  });

  it("fails closed when a key is required but the secret is missing", async () => {
    expect(await devKeyAccepted({ DEV_AUTH_REQUIRE_KEY: "1" }, undefined)).toBe(false);
    expect(await devKeyAccepted({ DEV_AUTH_REQUIRE_KEY: "1" }, "anything")).toBe(false);
  });

  it("accepts only the configured key", async () => {
    const env = { DEV_AUTH_KEY: "s3cret-key", DEV_AUTH_REQUIRE_KEY: "1" };
    expect(await devKeyAccepted(env, "s3cret-key")).toBe(true);
    expect(await devKeyAccepted(env, "s3cret-kez")).toBe(false);
    expect(await devKeyAccepted(env, "")).toBe(false);
    expect(await devKeyAccepted(env, undefined)).toBe(false);
  });
});
