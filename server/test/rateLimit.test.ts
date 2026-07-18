import { describe, expect, it, vi } from "vitest";
import { rateLimit } from "../src/index";

const context = (success: boolean) => {
  const headers = new Map<string, string>();
  const limit = vi.fn().mockResolvedValue({ success });
  const c = {
    env: { RL_WRITE: { limit } },
    get: vi.fn().mockReturnValue("account-123"),
    req: { header: vi.fn().mockReturnValue(undefined) },
    header: (name: string, value: string) => { headers.set(name, value); },
    json: (body: unknown, status: number) => ({ body, status }),
  };
  return { c, headers, limit };
};

describe("rate limiting middleware", () => {
  it("keys limits by route and account and returns retry metadata", async () => {
    const { c, headers, limit } = context(false);
    const next = vi.fn();
    const middleware = rateLimit("RL_WRITE", "epic_boss", 60, 60_000);

    const response = await middleware(c as never, next) as unknown as {
      body: { error: string; retryAfterMs: number };
      status: number;
    };

    expect(limit).toHaveBeenCalledWith({ key: "epic_boss:account-123" });
    expect(next).not.toHaveBeenCalled();
    expect(headers.get("Retry-After")).toBe("60");
    expect(response).toEqual({
      status: 429,
      body: { error: "rate_limited", retryAfterMs: 60_000 },
    });
  });

  it("continues when the limiter accepts the request", async () => {
    const { c } = context(true);
    const next = vi.fn().mockResolvedValue(undefined);
    const middleware = rateLimit("RL_WRITE", "epic_boss", 60, 60_000);

    await middleware(c as never, next);

    expect(next).toHaveBeenCalledOnce();
  });
});
