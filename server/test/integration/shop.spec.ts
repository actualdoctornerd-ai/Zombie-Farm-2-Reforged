import { describe, it, expect } from "vitest";
import { call, signIn, uniqueSub, type Session } from "./helpers";

// P16 — server-owned farm SIZE (sequential scalar) + CLIMATE skins (owned set).
// /shop/state seeds both once from the save; /shop/size buys the immediate next tier
// for the exact price; /shop/climate buys an unowned skin for its exact gold price.
// Closes save-blob fabrication of farm size / owned climates.

interface ShopState {
  size: number;
  climates: string[];
}
interface ShopResult {
  ok: boolean;
  error?: string;
  balance: { gold: number; brains: number };
  size: number;
  climates: string[];
}

async function player(gold = 0, brains = 0): Promise<Session> {
  const s = await signIn();
  await call("POST", "/economy/sync", s.token, { seed: { gold, brains, xp: 0 } });
  return s;
}
const readBal = async (s: Session) =>
  (await call<{ gold: number; brains: number }>("POST", "/economy/sync", s.token, { seed: { gold: 0, brains: 0, xp: 0 } })).body;
const command = <T extends object>(body: T) => ({ actionId: `shop-${uniqueSub()}`, ...body });

describe("shop — server-owned size + climates", () => {
  it("allows exactly one of 50 racing upgrades against a barely sufficient balance", async () => {
    const s = await player(10_000);
    await call("POST", "/shop/state", s.token, {});
    await Promise.all(Array.from({ length: 50 }, (_, n) =>
      call("POST", "/shop/size", s.token, { actionId: `race-${n}`, size: 40, currency: "gold" })
    ));
    expect((await call<ShopState>("POST", "/shop/state", s.token, {})).body.size).toBe(40);
    expect((await readBal(s)).gold).toBe(0);
  });

  it("seeds base size + no climates for a fresh account", async () => {
    const s = await player();
    const st = await call<ShopState>("POST", "/shop/state", s.token, {});
    expect(st.body.size).toBe(30);
    expect(st.body.climates).toEqual([]);
  });

  it("seeds size + climates ONCE from the save, ignoring unknown/grass terrains", async () => {
    const s = await player();
    const st = await call<ShopState>("POST", "/shop/state", s.token, {
      size: 50,
      climates: ["snow", "grass", "lava", "sand"], // grass free + lava fake are dropped
    });
    expect(st.body.size).toBe(50);
    expect(st.body.climates.sort()).toEqual(["sand", "snow"]);
    // Seeding is idempotent-ish: a later state call with a BIGGER forged size can't grow it.
    const again = await call<ShopState>("POST", "/shop/state", s.token, { size: 60, climates: ["water"] });
    expect(again.body.size).toBe(50); // unchanged — seed only applies to a fresh row
    expect(again.body.climates.sort()).toEqual(["sand", "snow"]); // water NOT added by re-seed
  });

  it("clamps an invalid seed size to base (no off-ladder farm from a forged save)", async () => {
    const s = await player();
    const st = await call<ShopState>("POST", "/shop/state", s.token, { size: 45, climates: [] });
    expect(st.body.size).toBe(30); // 45 isn't a real tier → base
  });

  it("SECURITY: cannot grant free climates by re-POSTing /shop/state after init", async () => {
    const s = await player(0);
    // First call initializes the account at base with no climates.
    const init = await call<ShopState>("POST", "/shop/state", s.token, {});
    expect(init.body.climates).toEqual([]);
    // A modified client now claims it owns every paid climate. Post-init, the seed
    // inputs must be IGNORED — otherwise this is ~18k gold of skins for free.
    const forged = await call<ShopState>("POST", "/shop/state", s.token, {
      climates: ["stone", "dirt", "snow", "sand", "water"],
    });
    expect(forged.body.climates).toEqual([]); // nothing granted
    // And it stays empty on a subsequent read.
    const after = await call<ShopState>("POST", "/shop/state", s.token, {});
    expect(after.body.climates).toEqual([]);
  });

  it("buys the next size tier for the exact gold price and advances the scalar", async () => {
    const s = await player(10_000);
    await call("POST", "/shop/state", s.token, {}); // seed base
    const r = await call<ShopResult>("POST", "/shop/size", s.token, command({ size: 40, currency: "gold" }));
    expect(r.body.ok).toBe(true);
    expect(r.body.size).toBe(40);
    expect(r.body.balance.gold).toBe(0); // 10000 - 10000
    expect((await readBal(s)).gold).toBe(0);
  });

  it("buys a size tier with brains when asked", async () => {
    const s = await player(0, 60);
    await call("POST", "/shop/state", s.token, {});
    const r = await call<ShopResult>("POST", "/shop/size", s.token, command({ size: 40, currency: "brains" }));
    expect(r.body.ok).toBe(true);
    expect(r.body.balance.brains).toBe(0); // 60 - 60
    expect((await readBal(s)).gold).toBe(0); // gold untouched
  });

  it("rejects a non-sequential size jump (30 → 60 skip)", async () => {
    const s = await player(1_000_000);
    await call("POST", "/shop/state", s.token, {});
    const r = await call<ShopResult>("POST", "/shop/size", s.token, command({ size: 60, currency: "gold" }));
    expect(r.body.ok).toBe(false);
    expect(r.body.error).toBe("bad_size");
    expect(r.body.size).toBe(30); // unchanged
    expect((await readBal(s)).gold).toBe(1_000_000); // nothing charged
  });

  it("rejects an off-ladder target size", async () => {
    const s = await player(1_000_000);
    await call("POST", "/shop/state", s.token, {});
    const r = await call<ShopResult>("POST", "/shop/size", s.token, command({ size: 45, currency: "gold" }));
    expect(r.body).toMatchObject({ ok: false, error: "bad_size" });
  });

  it("rejects an unaffordable size upgrade, charging nothing", async () => {
    const s = await player(9_999); // one short of 10000
    await call("POST", "/shop/state", s.token, {});
    const r = await call<ShopResult>("POST", "/shop/size", s.token, command({ size: 40, currency: "gold" }));
    expect(r.body).toMatchObject({ ok: false, error: "insufficient" });
    expect((await readBal(s)).gold).toBe(9_999);
  });

  it("is naturally idempotent: re-buying the same tier after it advanced is a no-op reject", async () => {
    const s = await player(20_000);
    await call("POST", "/shop/state", s.token, {});
    const action = command({ size: 40, currency: "gold" });
    const first = await call<ShopResult>("POST", "/shop/size", s.token, action);
    expect(first.body.ok).toBe(true);
    expect((await readBal(s)).gold).toBe(10_000); // charged once
    // A retry of size:40 now fails the "is it the next tier?" check (next is 50).
    const retry = await call<ShopResult>("POST", "/shop/size", s.token, action);
    expect(retry.body).toMatchObject({ ok: false, error: "bad_size", size: 40 });
    expect((await readBal(s)).gold).toBe(10_000); // NOT double-charged
  });

  it("walks the full ladder 30→40→50→60 then refuses to exceed max", async () => {
    const s = await player(1_000_000);
    await call("POST", "/shop/state", s.token, {});
    for (const size of [40, 50, 60]) {
      const r = await call<ShopResult>("POST", "/shop/size", s.token, command({ size, currency: "gold" }));
      expect(r.body.ok, `buy ${size}`).toBe(true);
      expect(r.body.size).toBe(size);
    }
    expect((await readBal(s)).gold).toBe(1_000_000 - 10_000 - 50_000 - 250_000);
    // Nothing above 60.
    const over = await call<ShopResult>("POST", "/shop/size", s.token, command({ size: 70, currency: "gold" }));
    expect(over.body).toMatchObject({ ok: false, error: "bad_size" });
  });

  it("buys a climate skin for exact gold and adds it to the owned set", async () => {
    const s = await player(10_000);
    await call("POST", "/shop/state", s.token, {});
    const r = await call<ShopResult>("POST", "/shop/climate", s.token, command({ terrain: "water" })); // 10000
    expect(r.body.ok).toBe(true);
    expect(r.body.climates).toContain("water");
    expect(r.body.balance.gold).toBe(0);
    const st = await call<ShopState>("POST", "/shop/state", s.token, {});
    expect(st.body.climates).toContain("water");
  });

  it("rejects re-buying an owned climate (no double charge)", async () => {
    const s = await player(10_000);
    await call("POST", "/shop/state", s.token, {});
    const action = command({ terrain: "stone" });
    await call("POST", "/shop/climate", s.token, action); // 1000
    const retry = await call<ShopResult>("POST", "/shop/climate", s.token, action);
    expect(retry.body).toMatchObject({ ok: false, error: "owned" });
    expect((await readBal(s)).gold).toBe(9_000); // charged once
  });

  it("rejects a fabricated terrain and buying grass", async () => {
    const s = await player(10_000);
    await call("POST", "/shop/state", s.token, {});
    const fake = await call<ShopResult>("POST", "/shop/climate", s.token, command({ terrain: "lava" }));
    expect(fake.body).toMatchObject({ ok: false, error: "bad_climate" });
    const grass = await call<ShopResult>("POST", "/shop/climate", s.token, command({ terrain: "grass" }));
    expect(grass.body).toMatchObject({ ok: false, error: "bad_climate" });
    expect((await readBal(s)).gold).toBe(10_000);
  });

  it("rejects an unaffordable climate, charging nothing", async () => {
    const s = await player(999); // stone is 1000
    await call("POST", "/shop/state", s.token, {});
    const r = await call<ShopResult>("POST", "/shop/climate", s.token, command({ terrain: "stone" }));
    expect(r.body).toMatchObject({ ok: false, error: "insufficient" });
    expect((await readBal(s)).gold).toBe(999);
  });

  it("400s on a malformed size / terrain body", async () => {
    const s = await player(10_000);
    const badSize = await call("POST", "/shop/size", s.token, { currency: "gold" }); // no size
    expect(badSize.status).toBe(400);
    const badTerr = await call("POST", "/shop/climate", s.token, {}); // no terrain
    expect(badTerr.status).toBe(400);
  });
});
