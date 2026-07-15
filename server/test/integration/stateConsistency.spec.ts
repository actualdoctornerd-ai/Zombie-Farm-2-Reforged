import { describe, expect, it } from "vitest";
import { call, signIn, uniqueSub } from "./helpers";

const id = (kind: string) => `${kind}-${uniqueSub()}`;

describe("authoritative client/server consistency", () => {
  it("applies Insta-Grow to the server crop before allowing harvest", async () => {
    const s = await signIn();
    await call("POST", "/economy/sync", s.token, { seed: { gold: 200, brains: 15, xp: 0 } });
    const plow = await call<{ results: { status: string }[] }>("POST", "/farm/actions", s.token, {
      actions: [{ id: id("plow"), type: "plow", oc: 8, or: 8 }],
    });
    expect(plow.body.results[0].status).toBe("applied");

    const plant = await call<{ results: { status: string }[] }>("POST", "/farm/actions", s.token, {
      actions: [{ id: id("plant"), type: "plant", oc: 8, or: 8, cropKey: "carrot" }],
    });
    expect(plant.body.results[0].status).toBe("applied");

    await call("POST", "/inventory/actions", s.token, {
      actions: [{ id: id("buy-grow"), type: "buy", key: "insta_grow" }],
    });
    const untargeted = await call<{
      results: { status: string; error?: string }[];
      inventory: Record<string, number>;
    }>("POST", "/inventory/actions", s.token, {
      actions: [{ id: id("use-grow-no-target"), type: "use", key: "insta_grow" }],
    });
    expect(untargeted.body.results[0]).toMatchObject({ status: "rejected", error: "bad_coord" });
    expect(untargeted.body.inventory.insta_grow).toBe(20);

    const grow = await call<{
      results: { status: string }[];
      inventory: Record<string, number>;
      farm: { crops: { oc: number; pr: number; planted_at: number; grow_ms: number }[] };
    }>("POST", "/inventory/actions", s.token, {
      actions: [{ id: id("use-grow"), type: "use", key: "insta_grow", oc: 8, or: 8 }],
    });
    expect(grow.body.results[0].status).toBe("applied");
    expect(grow.body.inventory.insta_grow).toBe(19);
    expect(grow.body.farm.crops[0].planted_at + grow.body.farm.crops[0].grow_ms).toBeLessThanOrEqual(Date.now());

    const harvest = await call<{
      results: { status: string; gold?: number }[];
      balance: { gold: number };
      farm: { crops: unknown[] };
    }>("POST", "/farm/actions", s.token, {
      actions: [{ id: id("harvest"), type: "harvest", oc: 8, or: 8 }],
    });
    expect(harvest.body.results[0]).toMatchObject({ status: "applied", gold: 16 });
    expect(harvest.body.balance.gold).toBe(201);
    expect(harvest.body.farm.crops).toEqual([]);
  });

  it("restores a nonzero base army cap from authoritative state", async () => {
    const s = await signIn();
    const state = await call<{ zombieMax: number }>("GET", "/state", s.token);
    expect(state.body.zombieMax).toBe(16);
  });
});
