import { describe, it, expect } from "vitest";
import { call, signIn, makeSave, type Session } from "./helpers";

// Exact server-computed crop economics via /farm/actions. (Harvest-after-grown is
// covered by the unit tests with an injected clock — 15-min real grow times can't
// be waited out here — so these cover cost, the grow GATE, idempotency, and
// rejections against a real Worker + D1.)

interface FarmRes {
  balance: { gold: number; xp: number };
  results: { id: string; status: string; error?: string; gold?: number }[];
}

async function player(gold = 1000): Promise<Session> {
  const s = await signIn();
  await call("PUT", "/save", s.token, { save: makeSave(gold, 0, 0), baseRev: 0 });
  await call("POST", "/economy/sync", s.token, { seed: { gold, brains: 0, xp: 0 } });
  return s;
}

describe("farm — exact economics", () => {
  it("plant debits the exact seed cost and records the plot", async () => {
    const s = await player(100);
    const r = await call<FarmRes>("POST", "/farm/actions", s.token, {
      actions: [{ id: "a1", type: "plant", oc: 2, or: 3, cropKey: "carrot" }],
    });
    expect(r.body.results[0].status).toBe("applied");
    expect(r.body.results[0].gold).toBe(-5); // carrot seed cost
    expect(r.body.balance.gold).toBe(95); // 100 - 5, computed server-side
    // The plot is now recorded server-side → replanting it is rejected.
    const r2 = await call<FarmRes>("POST", "/farm/actions", s.token, {
      actions: [{ id: "a2", type: "plant", oc: 2, or: 3, cropKey: "carrot" }],
    });
    expect(r2.body.results[0]).toMatchObject({ status: "rejected", error: "plot_occupied" });
  });

  it("rejects harvesting before the crop has grown (server clock)", async () => {
    const s = await player(100);
    await call("POST", "/farm/actions", s.token, { actions: [{ id: "b1", type: "plant", oc: 5, or: 5, cropKey: "carrot" }] });
    const h = await call<FarmRes>("POST", "/farm/actions", s.token, {
      actions: [{ id: "b2", type: "harvest", oc: 5, or: 5 }],
    });
    expect(h.body.results[0]).toMatchObject({ status: "rejected", error: "not_grown" });
  });

  it("rejects harvesting an empty plot", async () => {
    const s = await player(100);
    const h = await call<FarmRes>("POST", "/farm/actions", s.token, {
      actions: [{ id: "e1", type: "harvest", oc: 9, or: 9 }],
    });
    expect(h.body.results[0]).toMatchObject({ status: "rejected", error: "nothing_planted" });
  });

  it("is idempotent: a retried plant doesn't double-charge", async () => {
    const s = await player(100);
    const ev = { actions: [{ id: "dup-plant", type: "plant", oc: 7, or: 7, cropKey: "carrot" }] };
    await call("POST", "/farm/actions", s.token, ev);
    const retry = await call<FarmRes>("POST", "/farm/actions", s.token, ev);
    expect(retry.body.results[0].status).toBe("duplicate");
    const bal = await call<{ gold: number }>("POST", "/economy/sync", s.token, { seed: { gold: 0, brains: 0, xp: 0 } });
    expect(bal.body.gold).toBe(95); // charged exactly once
  });

  it("rejects an unaffordable plant and an unknown crop, applying neither", async () => {
    const s = await player(2);
    const r = await call<FarmRes>("POST", "/farm/actions", s.token, {
      actions: [
        { id: "c1", type: "plant", oc: 1, or: 1, cropKey: "potato" }, // costs 50, only have 2
        { id: "c2", type: "plant", oc: 1, or: 2, cropKey: "diamond" }, // not a crop
      ],
    });
    expect(r.body.results.map((x) => x.error)).toEqual(["insufficient", "bad_crop"]);
    expect(r.body.balance.gold).toBe(2); // nothing charged
  });
});
