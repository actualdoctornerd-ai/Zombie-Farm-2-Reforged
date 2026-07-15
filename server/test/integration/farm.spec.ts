import { describe, it, expect } from "vitest";
import { call, signIn, makeSave, seedPlowed, uniqueSub, PLOW, type Session } from "./helpers";

// Exact server-computed crop economics via /farm/actions. (Harvest-after-grown is
// covered by the unit tests with an injected clock — 15-min real grow times can't
// be waited out here — so these cover cost, the grow GATE, idempotency, and
// rejections against a real Worker + D1.)
//
// Phase E: a plant now also needs PLOWED soil inside the OWNED farm at a sufficient
// level. Tests that aren't about the plow itself import their soil via seedPlowed().

interface FarmRes {
  balance: { gold: number; xp: number };
  results: { id: string; status: string; error?: string; gold?: number; xp?: number }[];
}

const aid = (p: string) => `${p}-${uniqueSub()}`;

async function player(gold = 1000): Promise<Session> {
  const s = await signIn();
  await call("PUT", "/save", s.token, { save: makeSave(gold, 0, 0), baseRev: 0 });
  await call("POST", "/economy/sync", s.token, { seed: { gold, brains: 0, xp: 0 } });
  return s;
}

describe("farm — exact economics", () => {
  it("plant debits the exact seed cost and records the plot", async () => {
    const s = await player(100);
    await seedPlowed(s, [{ oc: 2, or: 3 }]);
    const r = await call<FarmRes>("POST", "/farm/actions", s.token, {
      actions: [{ id: aid("a1"), type: "plant", oc: 2, or: 3, cropKey: "carrot" }],
    });
    expect(r.body.results[0].status).toBe("applied");
    expect(r.body.results[0].gold).toBe(-5); // carrot seed cost
    expect(r.body.balance.gold).toBe(95); // 100 - 5, computed server-side
    // The plot is now recorded server-side → replanting it is rejected as occupied. (The
    // plant also consumed the soil; planPlant deliberately checks occupied first so a
    // replant reports the specific verdict rather than "not_plowed".)
    const r2 = await call<FarmRes>("POST", "/farm/actions", s.token, {
      actions: [{ id: aid("a2"), type: "plant", oc: 2, or: 3, cropKey: "carrot" }],
    });
    expect(r2.body.results[0]).toMatchObject({ status: "rejected", error: "plot_occupied" });
  });

  it("rejects harvesting before the crop has grown (server clock)", async () => {
    const s = await player(100);
    await seedPlowed(s, [{ oc: 5, or: 5 }]);
    await call("POST", "/farm/actions", s.token, { actions: [{ id: aid("b1"), type: "plant", oc: 5, or: 5, cropKey: "carrot" }] });
    const h = await call<FarmRes>("POST", "/farm/actions", s.token, {
      actions: [{ id: aid("b2"), type: "harvest", oc: 5, or: 5 }],
    });
    expect(h.body.results[0]).toMatchObject({ status: "rejected", error: "not_grown" });
  });

  it("rejects harvesting an empty plot", async () => {
    const s = await player(100);
    const h = await call<FarmRes>("POST", "/farm/actions", s.token, {
      actions: [{ id: aid("e1"), type: "harvest", oc: 9, or: 9 }],
    });
    expect(h.body.results[0]).toMatchObject({ status: "rejected", error: "nothing_planted" });
  });

  it("is idempotent: a retried plant doesn't double-charge", async () => {
    const s = await player(100);
    await seedPlowed(s, [{ oc: 7, or: 7 }]);
    const ev = { actions: [{ id: aid("dup-plant"), type: "plant", oc: 7, or: 7, cropKey: "carrot" }] };
    await call("POST", "/farm/actions", s.token, ev);
    const retry = await call<FarmRes>("POST", "/farm/actions", s.token, ev);
    expect(retry.body.results[0].status).toBe("duplicate");
    const bal = await call<{ gold: number }>("POST", "/economy/sync", s.token, { seed: { gold: 0, brains: 0, xp: 0 } });
    expect(bal.body.gold).toBe(95); // charged exactly once
  });

  it("rejects an unaffordable plant and an unknown crop, applying neither", async () => {
    const s = await player(2);
    await seedPlowed(s, [{ oc: 1, or: 1 }, { oc: 1, or: 2 }]);
    const r = await call<FarmRes>("POST", "/farm/actions", s.token, {
      // onion, not potato: potato is level-gated, so a level-1 account would be rejected
      // as `locked` before affordability is ever reached. Onion is level 1.
      actions: [
        { id: aid("c1"), type: "plant", oc: 1, or: 1, cropKey: "onion" }, // costs 20, only have 2
        { id: aid("c2"), type: "plant", oc: 1, or: 2, cropKey: "diamond" }, // not a crop
      ],
    });
    expect(r.body.results.map((x) => x.error)).toEqual(["insufficient", "bad_crop"]);
    expect(r.body.balance.gold).toBe(2); // nothing charged
  });
});

// ---- Phase E: plowed soil + owned-farm bound + level gate ------------------
describe("farm — plow, land ownership, and level gates", () => {
  it("plow charges the server's cost, grants xp, and makes the plot plantable", async () => {
    const s = await player(100);
    const p = await call<FarmRes>("POST", "/farm/actions", s.token, {
      actions: [{ id: aid("t"), type: "plow", oc: 8, or: 8 }],
    });
    expect(p.body.results[0]).toMatchObject({ status: "applied", gold: -PLOW, xp: 1 });
    expect(p.body.balance.gold).toBe(90);
    expect(p.body.balance.xp).toBe(1);
    // Now plantable. Before Phase E the plow was a purely local spend, so online it cost
    // nothing and the plant never checked for soil at all.
    const r = await call<FarmRes>("POST", "/farm/actions", s.token, {
      actions: [{ id: aid("p"), type: "plant", oc: 8, or: 8, cropKey: "carrot" }],
    });
    expect(r.body.results[0].status).toBe("applied");
    expect(r.body.balance.gold).toBe(85); // 100 - 10 plow - 5 seed
  });

  it("refuses to plant on soil that was never plowed", async () => {
    const s = await player(100);
    const r = await call<FarmRes>("POST", "/farm/actions", s.token, {
      actions: [{ id: aid("np"), type: "plant", oc: 12, or: 12, cropKey: "carrot" }],
    });
    expect(r.body.results[0]).toMatchObject({ status: "rejected", error: "not_plowed" });
    expect(r.body.balance.gold).toBe(100); // no seed charged
  });

  it("the plant CONSUMES the soil: replanting a harvested plot needs a fresh till", async () => {
    const s = await player(100);
    await call("POST", "/farm/actions", s.token, { actions: [{ id: aid("t"), type: "plow", oc: 16, or: 16 }] });
    await call("POST", "/farm/actions", s.token, { actions: [{ id: aid("p"), type: "plant", oc: 16, or: 16, cropKey: "carrot" }] });
    // Re-plowing the now-planted plot is rejected (it's occupied, not bare dirt)...
    const re = await call<FarmRes>("POST", "/farm/actions", s.token, {
      actions: [{ id: aid("t2"), type: "plow", oc: 16, or: 16 }],
    });
    expect(re.body.results[0]).toMatchObject({ status: "rejected", error: "plot_occupied" });
  });

  it("won't plow the same soil twice — a till can't be farmed for free xp", async () => {
    const s = await player(100);
    await call("POST", "/farm/actions", s.token, { actions: [{ id: aid("t"), type: "plow", oc: 20, or: 20 }] });
    const again = await call<FarmRes>("POST", "/farm/actions", s.token, {
      actions: [{ id: aid("t2"), type: "plow", oc: 20, or: 20 }],
    });
    expect(again.body.results[0]).toMatchObject({ status: "rejected", error: "already_plowed" });
    expect(again.body.balance.xp).toBe(1); // one till, one xp
  });

  it("refuses to farm land the account never bought", async () => {
    const s = await player(100); // base farm is 30x30
    const r = await call<FarmRes>("POST", "/farm/actions", s.token, {
      actions: [
        { id: aid("far"), type: "plow", oc: 40, or: 40 }, // land beyond the farm
        { id: aid("edge"), type: "plow", oc: 27, or: 0 }, // 27+4 = 31, pokes one tile out
      ],
    });
    expect(r.body.results.map((x) => x.error)).toEqual(["outside_farm", "outside_farm"]);
    expect(r.body.balance.gold).toBe(100);
  });

  it("refuses a crop the account's LEVEL hasn't unlocked (level derived from server xp)", async () => {
    const s = await player(1000); // level 1: no xp seeded
    await seedPlowed(s, [{ oc: 4, or: 4 }]);
    const r = await call<FarmRes>("POST", "/farm/actions", s.token, {
      actions: [{ id: aid("lk"), type: "plant", oc: 4, or: 4, cropKey: "potato" }], // level-gated crop
    });
    expect(r.body.results[0]).toMatchObject({ status: "rejected", error: "locked" });
    expect(r.body.balance.gold).toBe(1000); // not charged
  });

  it("imports already-plowed soil exactly once, so a client can't re-mint free soil", async () => {
    const s = await player(100);
    const first = await call<{ plowed: { oc: number; pr: number }[] }>("POST", "/farm/sync", s.token, {
      plowed: [{ oc: 0, or: 0 }, { oc: 4, or: 4 }],
    });
    expect(first.body.plowed).toHaveLength(2);
    // A second import is ignored: the soil_seeded flag already fired. Without that guard
    // an emptied plowed_soil set would let a client re-import free soil (10g + 1xp each).
    const second = await call<{ plowed: { oc: number; pr: number }[] }>("POST", "/farm/sync", s.token, {
      plowed: [{ oc: 8, or: 8 }, { oc: 12, or: 12 }],
    });
    expect(second.body.plowed.map((p) => p.oc)).toEqual([0, 4]); // not 8/12
    // The import grants no xp/gold — that soil was paid for pre-migration.
    expect(second.status).toBe(200);
    const bal = await call<{ gold: number; xp: number }>("POST", "/economy/sync", s.token, { seed: { gold: 0, brains: 0, xp: 0 } });
    expect(bal.body).toMatchObject({ gold: 100, xp: 0 });
  });

  it("drops imported soil that falls outside the owned farm", async () => {
    const s = await player(100);
    const r = await call<{ plowed: { oc: number; pr: number }[] }>("POST", "/farm/sync", s.token, {
      plowed: [{ oc: 2, or: 2 }, { oc: 99, or: 99 }, { oc: -5, or: 0 }],
    });
    expect(r.body.plowed).toEqual([{ oc: 2, pr: 2 }]);
  });
});
