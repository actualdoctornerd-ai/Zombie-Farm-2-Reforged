import { describe, it, expect } from "vitest";
import { call, signIn, uniqueSub, seedPlowed, type Session } from "./helpers";

// Phase D — server-owned zombie field. A zombie is grown from a zombie CROP: plant a
// seed (cost gold OR brains), it grows for a real server grow time, and the harvest
// yields a VERIFIED owned unit. (Harvest-after-grown is unit-tested with an injected
// clock — real grow times can't be waited out here — so these cover the plant debit,
// the grow GATE, and rejections against a real Worker + D1.)

interface FarmRes {
  balance: { gold: number; brains: number; xp: number };
  results: { id: string; status: string; error?: string }[];
}
interface RosterRes {
  balance: { gold: number };
  results: { id: string; status: string; error?: string; gold?: number }[];
}

const GOLD_Z = "ZombieActorRegularTier1"; // 35 gold, grow 600000
const BRAINS_Z = "ZombieActorGardenTier3GreenFlower"; // 50 brains

// A funded account whose plots 0..10 are already PLOWED. Phase E requires tilled soil to
// plant; these tests are about the zombie CROP, not the till, so the soil is imported via
// the one-time migration path rather than paid for plot by plot (which would also perturb
// every gold assertion below by the plow cost).
async function player(gold = 1000, brains = 1000): Promise<Session> {
  const s = await signIn();
  await call("POST", "/economy/sync", s.token, { seed: { gold, brains, xp: 0 } });
  const plots = [];
  for (let oc = 0; oc <= 10; oc++) for (let or = 0; or <= 10; or++) plots.push({ oc, or });
  await seedPlowed(s, plots);
  return s;
}

// Action ids must be GLOBALLY unique — the idempotency tables dedup by id across
// accounts AND spec files (prod ids are random UUIDs), so salt every id.
const aid = (p: string) => `${p}-${uniqueSub()}`;

describe("zombie field — server-owned crops → verified units", () => {
  it("plants a gold zombie crop for the exact cost and records the plot", async () => {
    const s = await player(100, 0);
    const r = await call<FarmRes>("POST", "/farm/actions", s.token, {
      actions: [{ id: aid("zp"), type: "plant", oc: 3, or: 3, cropKey: GOLD_Z }],
    });
    expect(r.body.results[0].status).toBe("applied");
    expect(r.body.balance.gold).toBe(65); // 100 - 35, priced server-side
    // The plot is recorded → replanting it is rejected.
    const r2 = await call<FarmRes>("POST", "/farm/actions", s.token, {
      actions: [{ id: aid("zp"), type: "plant", oc: 3, or: 3, cropKey: GOLD_Z }],
    });
    expect(r2.body.results[0]).toMatchObject({ status: "rejected", error: "plot_occupied" });
  });

  it("plants a brains zombie crop, debiting BRAINS not gold", async () => {
    const s = await player(0, 100);
    const r = await call<FarmRes>("POST", "/farm/actions", s.token, {
      actions: [{ id: aid("zp"), type: "plant", oc: 4, or: 4, cropKey: BRAINS_Z }],
    });
    expect(r.body.results[0].status).toBe("applied");
    expect(r.body.balance.brains).toBe(50); // 100 - 50
    expect(r.body.balance.gold).toBe(0);
  });

  it("rejects harvesting a zombie crop before it has grown, granting NO unit", async () => {
    const s = await player(100, 0);
    await call("POST", "/farm/actions", s.token, { actions: [{ id: aid("zp"), type: "plant", oc: 5, or: 5, cropKey: GOLD_Z }] });
    const h = await call<FarmRes>("POST", "/farm/actions", s.token, {
      actions: [{ id: aid("zh"), type: "harvest", oc: 5, or: 5, unitId: "zEarly" }],
    });
    expect(h.body.results[0]).toMatchObject({ status: "rejected", error: "not_grown" });
    // No unit was granted, so it can't be sold for gold.
    const sell = await call<RosterRes>("POST", "/roster/actions", s.token, {
      actions: [{ id: aid("sell"), type: "sell", unitId: "zEarly" }],
    });
    expect(sell.body.results[0]).toMatchObject({ status: "rejected", error: "no_unit" });
  });

  it("rejects a zombie-crop harvest with no unit id", async () => {
    const s = await player(100, 0);
    await call("POST", "/farm/actions", s.token, { actions: [{ id: aid("zp"), type: "plant", oc: 6, or: 6, cropKey: GOLD_Z }] });
    const h = await call<FarmRes>("POST", "/farm/actions", s.token, {
      actions: [{ id: aid("zh"), type: "harvest", oc: 6, or: 6 }], // missing unitId
    });
    expect(h.body.results[0]).toMatchObject({ status: "rejected", error: "bad_unit" });
  });

  it("rejects an unaffordable zombie crop, charging nothing", async () => {
    const s = await player(10, 0);
    const r = await call<FarmRes>("POST", "/farm/actions", s.token, {
      actions: [{ id: aid("zp"), type: "plant", oc: 7, or: 7, cropKey: GOLD_Z }], // 35 > 10
    });
    expect(r.body.results[0]).toMatchObject({ status: "rejected", error: "insufficient" });
    expect(r.body.balance.gold).toBe(10);
  });

  it("is idempotent: a retried zombie plant doesn't double-charge", async () => {
    const s = await player(100, 0);
    const ev = { actions: [{ id: "dup-zplant", type: "plant", oc: 8, or: 8, cropKey: GOLD_Z }] };
    await call("POST", "/farm/actions", s.token, ev);
    const retry = await call<FarmRes>("POST", "/farm/actions", s.token, ev);
    expect(retry.body.results[0].status).toBe("duplicate");
    const bal = await call<{ gold: number }>("POST", "/economy/sync", s.token, { seed: { gold: 0, brains: 0, xp: 0 } });
    expect(bal.body.gold).toBe(65); // charged once
  });
});
