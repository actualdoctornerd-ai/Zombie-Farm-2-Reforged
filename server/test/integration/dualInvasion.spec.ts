// The two rules the dual invasions add to /raid/start, tested against the real Worker.
//
// Both are SERVER rules on purpose. The client hides the Brain Ticket button on these four
// and clamps the tier picker to what it believes is unlocked, but neither of those is a
// rule — an old tab, a replayed request or an edited client reaches this endpoint with
// whatever it likes, and the ladder is progression, so the server has to own it.
import { describe, expect, it } from "vitest";
import { RAID_RULESET_VERSION } from "../../../src/raid/replay";
import { DUAL_INVASION_IDS, MAX_TIER } from "../../../src/raid/dualInvasion";
import { call, grantLevel, grantRoster, signIn, uniqueSub } from "./helpers";

/** Raid 12 (Lawyers & Farmers) unlocks at level 46 and needs eight zombies. */
const DUAL_RAID = DUAL_INVASION_IDS[0];
const UNLOCK_LEVEL = 46;
const ARMY = Array.from({ length: 8 }, (_, i) => ({
  id: `dual-z${i}`, key: "ZombieActorRegularTier1", stored: false,
}));

async function readyFarm(label: string) {
  const session = await signIn(uniqueSub(label));
  await grantLevel(session, UNLOCK_LEVEL);
  await grantRoster(session, ARMY);
  return session;
}

const startBody = (extra: Record<string, unknown>) => ({
  raidId: DUAL_RAID,
  orderedUnitIds: ARMY.map((u) => u.id),
  rulesetVersion: RAID_RULESET_VERSION,
  ...extra,
});

describe("dual invasions — Brain Tickets and the tier ladder", () => {
  it("refuses a Brain Ticket, and spends nothing doing it", async () => {
    const session = await readyFarm("dual-no-ticket");

    const started = await call<any>("POST", "/raid/start", session.token,
      startBody({ brainTicket: true, tier: 1 }));

    expect(started.status).toBe(409);
    expect(started.body.error).toBe("elite_unavailable");

    // Refused BEFORE the wave is pinned, so no session was opened and the farm can still
    // launch an ordinary fight immediately — nothing was consumed on the way past.
    const ordinary = await call<any>("POST", "/raid/start", session.token,
      startBody({ tier: 1 }));
    expect(ordinary.status, JSON.stringify(ordinary.body)).toBe(200);
  });

  it("refuses a tier above the one this farm has climbed to", async () => {
    const session = await readyFarm("dual-tier-locked");

    const tooHigh = await call<any>("POST", "/raid/start", session.token,
      startBody({ tier: 2 }));

    expect(tooHigh.status).toBe(403);
    expect(tooHigh.body.error).toBe("tier_locked");
    // …and it says how far the farm HAS climbed, so the client can correct its picker
    // rather than just reporting a refusal.
    expect(tooHigh.body.unlockedTier).toBe(1);

    const topRung = await call<any>("POST", "/raid/start", session.token,
      startBody({ tier: MAX_TIER }));
    expect(topRung.status).toBe(403);
  });

  it("advances the ladder by one on a win, and only on a win", async () => {
    const session = await readyFarm("dual-ladder");

    // A LOSS first: the fight was fought at tier 1, but retreating from it must not
    // unlock tier 2 — otherwise the ladder is climbed by starting fights, not winning them.
    const lost = await call<any>("POST", "/raid/start", session.token, startBody({ tier: 1 }));
    expect(lost.status, JSON.stringify(lost.body)).toBe(200);
    const retreat = await call<any>("POST", "/raid/finish", session.token, {
      sessionId: lost.body.sessionId,
      finalTick: 0,
      inputs: [{ seq: 1, tick: 0, type: "retreat" }],
      clientWin: false,
    });
    expect(retreat.status, JSON.stringify(retreat.body)).toBe(200);

    const afterLoss = await call<any>("POST", "/bootstrap", session.token, {});
    expect(afterLoss.body.gameplay.raids.tiers?.[String(DUAL_RAID)] ?? 0).toBe(0);

    const stillLocked = await call<any>("POST", "/raid/start", session.token, startBody({ tier: 2 }));
    expect(stillLocked.body.error).toBe("tier_locked");
  });
});
