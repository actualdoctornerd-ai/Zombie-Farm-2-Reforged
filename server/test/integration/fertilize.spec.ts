import { describe, it, expect } from "vitest";
import { call, signIn, uniqueSub, seedPlowed, type Session } from "./helpers";

// P13 — the Garden-zombie fertilize roll is SERVER-owned. On each /farm plant the
// server rolls `Math.random() < fertilizeProbability(owned Garden keys)` and stamps the
// plot fertilized (2x harvest). A modified client can't force it, and a roster with no
// Garden units can never produce a fertilized crop. The roll itself is random, so the
// deterministic guarantee we assert is the ZERO case; the presence case is checked
// statistically with a bound chosen so a false failure is astronomically unlikely.

interface FarmRes {
  balance: { gold: number };
  results: { id: string; status: string; error?: string; fertilized?: boolean }[];
}

async function player(gold: number): Promise<Session> {
  const s = await signIn();
  await call("POST", "/economy/sync", s.token, { seed: { gold, brains: 0, xp: 0 } });
  return s;
}

// N carrot plants on distinct plots INSIDE the base 30x30 farm, all in one batch (the
// batch rolls the fertilize probability once, then each plant rolls independently against
// it). Action ids are salted with uniqueSub() because idempotency dedups by id GLOBALLY,
// so reusing "f-0" across tests would spuriously come back "duplicate".
//
// Coords stay in 0..26: Phase E bounds a plant to the OWNED farm, and a 4-tile plot only
// fits up to origin 26 on a 30-wide farm. Returns the plots too, so the caller can import
// them as plowed soil — a plant now needs tilled ground.
const SPAN = 27; // origins 0..26

function plants(n: number) {
  const salt = uniqueSub();
  const actions = [];
  const plots = [];
  for (let i = 0; i < n; i++) {
    const oc = i % SPAN;
    const or = Math.floor(i / SPAN);
    plots.push({ oc, or });
    actions.push({ id: `${salt}-${i}`, type: "plant" as const, oc, or, cropKey: "carrot" });
  }
  return { actions, plots };
}

/** Plant n carrots on freshly-imported plowed soil. */
async function plantOnSoil(s: Session, n: number) {
  const { actions, plots } = plants(n);
  await seedPlowed(s, plots);
  return call<FarmRes>("POST", "/farm/actions", s.token, { actions });
}

describe("fertilize — server-owned Garden roll", () => {
  it("NEVER fertilizes when the roster has zero Garden units (deterministic)", async () => {
    const s = await player(1000);
    // Only combat units → fertilizeProbability is exactly 0.
    await call("POST", "/roster/sync", s.token, {
      units: [
        { id: "c1", key: "ZombieActorRegularTier1" },
        { id: "c2", key: "ZombieActorLargeTier4" },
      ],
    });
    const r = await plantOnSoil(s, 40);
    const applied = r.body.results.filter((x) => x.status === "applied");
    expect(applied).toHaveLength(40);
    // The load-bearing assertion: not a single fertilized plot is possible at p=0.
    expect(applied.every((x) => x.fertilized === false)).toBe(true);
  });

  it("NEVER fertilizes with an empty roster", async () => {
    const s = await player(500);
    const r = await plantOnSoil(s, 30);
    const applied = r.body.results.filter((x) => x.status === "applied");
    expect(applied).toHaveLength(30);
    expect(applied.every((x) => x.fertilized === false)).toBe(true);
  });

  it("DOES fertilize some crops when many high-tier Garden units are owned (statistical)", async () => {
    const s = await player(1000);
    // 15 tier-5 Garden units → per-plant p = 1 - 0.88^15 ≈ 0.85. Over 30 plants the
    // chance of ZERO fertilized is ≈ 0.147^30 ≈ 1e-25 — this test does not flake.
    const units = Array.from({ length: 15 }, (_, i) => ({ id: `g${i}`, key: "ZombieActorGardenTier5" }));
    await call("POST", "/roster/sync", s.token, { units });
    const r = await plantOnSoil(s, 30);
    const applied = r.body.results.filter((x) => x.status === "applied");
    expect(applied).toHaveLength(30);
    const fertCount = applied.filter((x) => x.fertilized === true).length;
    expect(fertCount).toBeGreaterThan(0);
    // Sanity: it also shouldn't fertilize literally everything at p≈0.85 — but that's a
    // soft expectation, so we don't assert an upper bound (avoids a rare flake).
  });

  it("the fertilized flag is decided server-side — a client 'fertilized:true' hint is ignored at p=0", async () => {
    const s = await player(500);
    await call("POST", "/roster/sync", s.token, { units: [{ id: "c", key: "ZombieActorRegularTier1" }] });
    await seedPlowed(s, [{ oc: 3, or: 3 }]);
    // Client tries to assert fertilization directly on the action; server has no Garden
    // units so it must come up false regardless of the client's claim.
    const r = await call<FarmRes>("POST", "/farm/actions", s.token, {
      actions: [{ id: `claim-${uniqueSub()}`, type: "plant", oc: 3, or: 3, cropKey: "carrot", fertilized: true }],
    });
    expect(r.body.results[0]).toMatchObject({ status: "applied", fertilized: false });
  });
});
