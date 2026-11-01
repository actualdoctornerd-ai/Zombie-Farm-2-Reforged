import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Every `rateLimit(tier, name, max, windowMs)` is enforced in a deployed Worker by the
// binding named `RL_<max>`. A limit with no binding silently drops to the D1 counter
// (a write per request), and until 2026-10-31 the code's numbers were not enforced at
// all — so pin the pairing here.
const source = readFileSync("src/index.ts", "utf8");
const toml = readFileSync("wrangler.toml", "utf8").replace(/\r\n/g, "\n");

const used = [...source.matchAll(/rateLimit\(\s*"RL_[A-Z]+",\s*"[^"]+",\s*([\d_]+),\s*([\d_]+)\s*\)/g)]
  .map((m) => ({ max: Number(m[1].replace(/_/g, "")), windowMs: Number(m[2].replace(/_/g, "")) }));

function bindings(prefix: string): Map<string, { limit: number; period: number }> {
  const out = new Map<string, { limit: number; period: number }>();
  const header = `[[${prefix}unsafe.bindings]]`;
  for (const block of toml.split("\n\n")) {
    if (!block.split("\n").some((line) => line.trim() === header)) continue;
    const name = /^name = "(RL_\d+)"/m.exec(block)?.[1];
    const simple = /^simple = \{ limit = (\d+), period = (\d+) \}/m.exec(block);
    if (name && simple && /^type = "ratelimit"/m.test(block)) {
      out.set(name, { limit: Number(simple[1]), period: Number(simple[2]) });
    }
  }
  return out;
}

describe("rate-limit bindings", () => {
  it("finds the limits the routes declare", () => {
    expect(used.length).toBeGreaterThan(30);
  });

  it("every limiter is per minute", () => {
    for (const { windowMs } of used) expect(windowMs).toBe(60_000);
  });

  for (const [env, prefix] of [["staging", ""], ["production", "env.production."]] as const) {
    it(`${env} has an RL_<max> binding of that limit for every route`, () => {
      const have = bindings(prefix);
      for (const { max } of used) {
        expect(have.get(`RL_${max}`), `RL_${max} in ${env}`).toEqual({ limit: max, period: 60 });
      }
    });
  }

  it("staging and production use different namespace ids", () => {
    const ids = [...toml.matchAll(/namespace_id = "(\d+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
