import { describe, it, expect } from "vitest";
import {
  validateEvent,
  applyBatch,
  clampSeed,
  type Balance,
  type EconomyEvent,
} from "../src/economy";

const bal = (gold = 0, brains = 0, xp = 0): Balance => ({ gold, brains, xp });
// Default event is a SPEND (the only thing /economy/apply accepts now) — earns are
// server-derived, never client-authored.
const ev = (over: Partial<EconomyEvent>): EconomyEvent => ({
  id: "e1",
  currency: "gold",
  delta: -10,
  reason: "purchase",
  ...over,
});

describe("validateEvent — spend-only", () => {
  it("accepts a spend within balance", () => {
    expect(validateEvent(ev({ delta: -50 }), bal(100)).ok).toBe(true);
  });
  it("rejects an overdraw", () => {
    const r = validateEvent(ev({ delta: -101 }), bal(100));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("insufficient");
  });
  it("rejects ANY positive delta (no client-authored earns)", () => {
    for (const currency of ["gold", "brains", "xp"] as const) {
      const r = validateEvent(ev({ currency, delta: 1, reason: "misc" }), bal());
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe("earn_forbidden");
    }
  });
  it("rejects an unknown reason", () => {
    expect(validateEvent(ev({ reason: "harvest" }), bal(100)).ok).toBe(false); // earn reason, removed
    expect(validateEvent(ev({ reason: "wat" }), bal(100)).ok).toBe(false);
  });
  it("rejects an unknown currency", () => {
    expect(validateEvent(ev({ currency: "rubies" as never }), bal()).ok).toBe(false);
  });
  it("rejects a non-integer / non-finite delta", () => {
    expect(validateEvent(ev({ delta: -1.5 }), bal(100)).ok).toBe(false);
    expect(validateEvent(ev({ delta: -Infinity }), bal(100)).ok).toBe(false);
  });
  it("rejects spending xp", () => {
    const r = validateEvent(ev({ currency: "xp", delta: -5 }), bal(0, 0, 100));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("xp_no_spend");
  });
  it("rejects a zero delta and a blank id", () => {
    expect(validateEvent(ev({ delta: 0 }), bal()).ok).toBe(false);
    expect(validateEvent(ev({ id: "" }), bal(100)).ok).toBe(false);
  });
});

describe("applyBatch — idempotent spends", () => {
  it("applies a sequence of spends and returns the final balance", () => {
    const events = [
      ev({ id: "a", delta: -30 }),
      ev({ id: "b", delta: -20 }),
    ];
    const { balance, results } = applyBatch(events, bal(100), new Set());
    expect(balance.gold).toBe(50);
    expect(results.map((r) => r.status)).toEqual(["applied", "applied"]);
  });
  it("skips a duplicate id (already applied) without re-debiting", () => {
    const events = [ev({ id: "dup", delta: -10 })];
    const { balance, results } = applyBatch(events, bal(50), new Set(["dup"]));
    expect(balance.gold).toBe(50);
    expect(results[0].status).toBe("duplicate");
  });
  it("skips a duplicate within the same batch", () => {
    const events = [ev({ id: "x", delta: -10 }), ev({ id: "x", delta: -10 })];
    const { balance, results } = applyBatch(events, bal(50), new Set());
    expect(balance.gold).toBe(40);
    expect(results.map((r) => r.status)).toEqual(["applied", "duplicate"]);
  });
  it("rejects an overdraw mid-batch but keeps applying the rest", () => {
    const events = [
      ev({ id: "a", delta: -200 }), // overdraw (balance 100)
      ev({ id: "b", delta: -25 }),
    ];
    const { balance, results } = applyBatch(events, bal(100), new Set());
    expect(results[0].status).toBe("rejected");
    expect(results[1].status).toBe("applied");
    expect(balance.gold).toBe(75);
  });
  it("rejects a positive (earn) delta mid-batch but keeps applying spends", () => {
    const events = [
      ev({ id: "a", delta: 50, reason: "misc" }), // earn → forbidden
      ev({ id: "b", delta: -25 }),
    ];
    const { balance, results } = applyBatch(events, bal(100), new Set());
    expect(results[0]).toMatchObject({ status: "rejected", error: "earn_forbidden" });
    expect(results[1].status).toBe("applied");
    expect(balance.gold).toBe(75);
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
