import { describe, it, expect } from "vitest";
import {
  validateEvent,
  applyBatch,
  clampSeed,
  EARN_CAP,
  type Balance,
  type EconomyEvent,
} from "../src/economy";

const bal = (gold = 0, brains = 0, xp = 0): Balance => ({ gold, brains, xp });
const ev = (over: Partial<EconomyEvent>): EconomyEvent => ({
  id: "e1",
  currency: "gold",
  delta: 10,
  reason: "harvest",
  ...over,
});

describe("validateEvent", () => {
  it("accepts a normal earn", () => {
    expect(validateEvent(ev({ delta: 100 }), bal()).ok).toBe(true);
  });
  it("accepts a spend within balance", () => {
    expect(validateEvent(ev({ delta: -50, reason: "purchase" }), bal(100)).ok).toBe(true);
  });
  it("rejects an overdraw", () => {
    const r = validateEvent(ev({ delta: -101, reason: "purchase" }), bal(100));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("insufficient");
  });
  it("rejects an earn over the per-currency cap", () => {
    const r = validateEvent(ev({ delta: EARN_CAP.gold + 1 }), bal());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("earn_over_cap");
  });
  it("rejects an unknown reason", () => {
    expect(validateEvent(ev({ reason: "wat" }), bal()).ok).toBe(false);
  });
  it("rejects an unknown currency", () => {
    expect(validateEvent(ev({ currency: "rubies" as never }), bal()).ok).toBe(false);
  });
  it("rejects a non-integer / non-finite delta", () => {
    expect(validateEvent(ev({ delta: 1.5 }), bal()).ok).toBe(false);
    expect(validateEvent(ev({ delta: Infinity }), bal()).ok).toBe(false);
  });
  it("rejects spending xp", () => {
    const r = validateEvent(ev({ currency: "xp", delta: -5, reason: "purchase" }), bal(0, 0, 100));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("xp_no_spend");
  });
  it("rejects a zero delta and a blank id", () => {
    expect(validateEvent(ev({ delta: 0 }), bal()).ok).toBe(false);
    expect(validateEvent(ev({ id: "" }), bal()).ok).toBe(false);
  });
});

describe("applyBatch — idempotent, order-sensitive", () => {
  it("applies a sequence and returns the final balance", () => {
    const events = [
      ev({ id: "a", delta: 100 }),
      ev({ id: "b", delta: -30, reason: "purchase" }),
    ];
    const { balance, results } = applyBatch(events, bal(0), new Set());
    expect(balance.gold).toBe(70);
    expect(results.map((r) => r.status)).toEqual(["applied", "applied"]);
  });
  it("skips a duplicate id (already applied) without re-crediting", () => {
    const events = [ev({ id: "dup", delta: 100 })];
    const { balance, results } = applyBatch(events, bal(50), new Set(["dup"]));
    expect(balance.gold).toBe(50);
    expect(results[0].status).toBe("duplicate");
  });
  it("skips a duplicate within the same batch", () => {
    const events = [ev({ id: "x", delta: 100 }), ev({ id: "x", delta: 100 })];
    const { balance, results } = applyBatch(events, bal(0), new Set());
    expect(balance.gold).toBe(100);
    expect(results.map((r) => r.status)).toEqual(["applied", "duplicate"]);
  });
  it("rejects an overdraw mid-batch but keeps applying the rest", () => {
    const events = [
      ev({ id: "a", delta: -200, reason: "purchase" }), // overdraw (balance 100)
      ev({ id: "b", delta: 25 }),
    ];
    const { balance, results } = applyBatch(events, bal(100), new Set());
    expect(results[0].status).toBe("rejected");
    expect(results[1].status).toBe("applied");
    expect(balance.gold).toBe(125);
  });
  it("respects earlier earns when validating a later spend", () => {
    const events = [
      ev({ id: "a", delta: 100 }),
      ev({ id: "b", delta: -150, reason: "purchase" }), // ok only because of a
    ];
    const { balance, results } = applyBatch(events, bal(60), new Set());
    expect(results.map((r) => r.status)).toEqual(["applied", "applied"]);
    expect(balance.gold).toBe(10);
  });
});

describe("clampSeed — migration guard", () => {
  it("passes legitimate values through", () => {
    expect(clampSeed({ gold: 1234, brains: 20, xp: 5000 })).toEqual({ gold: 1234, brains: 20, xp: 5000 });
  });
  it("clamps absurd or invalid values", () => {
    const s = clampSeed({ gold: 1e30, brains: -5 as unknown as number, xp: NaN as unknown as number });
    expect(s.gold).toBeLessThanOrEqual(100_000_000);
    expect(s.brains).toBe(0);
    expect(s.xp).toBe(0);
  });
});
