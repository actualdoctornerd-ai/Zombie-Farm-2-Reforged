import { describe, expect, it } from "vitest";
import { call, commandBody, grantBalance, grantRoster, signIn, uniqueSub, xpForLevel } from "./helpers";
import { RAID_RULESET_VERSION } from "../../../src/raid/replay";
import zombieRows from "../../../public/assets/zombies.json";
import { OMNI_FARMER_QUEST_ID, omniAlmanacClassifier, type AlmanacClassRow } from "../../../src/quest/omniFarmer";
import { QUEST_DEFINITIONS } from "../../src/questCatalog";

// Omni-Farmer's prize end to end (owner, 2026-11-11; ruleset 90): the Green Flower Ticket
// is never sold, the Green Flower Zombie cannot be planted without one, and Boundless
// Vitality keeps a Green Flower that falls in an invasion off the casualty list on the
// DEPLOYED replay verifier — not just in the unit-tested sim.

const GREEN_FLOWER = "ZombieActorGardenTier3GreenFlower";
const ZOMBEE = "ZombieActorGardenTier4";
const REGULAR = "ZombieActorRegularTier1";

async function level44(label: string) {
  const s = await signIn(uniqueSub(label));
  await grantBalance(s, { gold: 1_000_000, brains: 100, xp: xpForLevel(44) });
  return s;
}

/** One Garden at the HEAD of the line (it deploys first, with nobody ahead of it to
 *  shelter behind, so it is out on the field taking hits) and seven Regulars after it,
 *  against the Robots, settled on the server's OWN simulation of the whole fight
 *  (finalTick 0, no inputs). A Garden at the back survives: once the front falls the
 *  fight ends "healers only". The farm gets Life Force level 2 first: Boundless
 *  Vitality sits in ability slot 2, which works from 45 Life Force like any slot-2
 *  ability (a Daisy is 1 Life Force for 10 gold). */
async function fightWithGarden(label: string, gardenKey: string) {
  const s = await level44(label);
  const front = Array.from({ length: 7 }, (_, i) => `front${i}`);
  await grantRoster(s, [
    ...front.map((id) => ({ id, key: REGULAR, stored: false })),
    { id: "garden", key: gardenKey, stored: false },
  ]);
  const boot = await call<any>("POST", "/bootstrap", s.token, {});
  const daisies = await call<any>("POST", "/commands", s.token, commandBody(boot.body, `${label}-daisies`, 1,
    Array.from({ length: 50 }, () => ({ type: "object.buy", catalogKey: "daisy" }))));
  expect(daisies.status, JSON.stringify(daisies.body)).toBe(200);
  const started = await call<any>("POST", "/raid/start", s.token, {
    raidId: 5, orderedUnitIds: ["garden", ...front], rulesetVersion: RAID_RULESET_VERSION,
  });
  expect(started.status, JSON.stringify(started.body)).toBe(200);
  const finished = await call<any>("POST", "/raid/finish", s.token, {
    sessionId: started.body.sessionId, finalTick: 0, inputs: [],
  });
  expect(finished.status, JSON.stringify(finished.body)).toBe(200);
  const after = await call<any>("POST", "/bootstrap", s.token, {});
  return {
    outcome: finished.body.outcome as { survivors: string[]; losses: string[] },
    roster: (after.body.gameplay.roster as { id: string }[]).map((u) => u.id),
  };
}

describe("Omni-Farmer prize", () => {
  it("never sells the Green Flower Ticket, and refuses a Green Flower planted without one", async () => {
    const s = await level44("gf-ticket");
    const boot = await call<any>("POST", "/bootstrap", s.token, {});
    const res = await call<any>("POST", "/commands", s.token, commandBody(boot.body, "gf-ticket-batch", 1, [
      { type: "power.buy", key: "green_flower_ticket" },
      { type: "farm.plow", oc: 0, or: 0 },
      { type: "farm.plant", oc: 0, or: 0, cropKey: GREEN_FLOWER },
    ]));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.results[0]).toMatchObject({ status: "rejected", error: "not_for_sale" });
    expect(res.body.results[1].status).toBe("applied");
    expect(res.body.results[2]).toMatchObject({ status: "rejected", error: "no_ticket" });
    expect(res.body.gameplay.inventory.green_flower_ticket ?? 0).toBe(0);
  });

  it("reads the Almanac gauge from the saved presentation on the next command batch", async () => {
    const s = await level44("gf-almanac");
    const classOf = omniAlmanacClassifier(zombieRows as AlmanacClassRow[]);
    const counted = (zombieRows as { key: string }[]).filter((z) => classOf(z.key)).map((z) => z.key);
    const gaugeIndex = QUEST_DEFINITIONS[OMNI_FARMER_QUEST_ID].requirements
      .findIndex((r) => r.gauge === "almanacZombies");
    const progressAfter = async (n: number, batch: string) => {
      const boot = await call<any>("POST", "/bootstrap", s.token, {});
      const saved = await call<any>("PUT", "/presentation", s.token, {
        protocolVersion: 3, expectedVersion: boot.body.presentation.version,
        data: { ...boot.body.presentation.data, almanac: { discovered: Object.fromEntries(counted.slice(0, n).map((k) => [k, 1])) } },
      });
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
      const fresh = await call<any>("POST", "/bootstrap", s.token, {});
      const res = await call<any>("POST", "/commands", s.token, commandBody(fresh.body, batch, n, [{ type: "writer.claim" }]));
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const quest = (res.body.gameplay.quests.progress as { questId: string; counts: number[] }[])
        .find((p) => p.questId === OMNI_FARMER_QUEST_ID);
      return quest?.counts[gaugeIndex];
    };
    expect(await progressAfter(12, "gf-almanac-12")).toBe(12);
    expect(await progressAfter(50, "gf-almanac-50")).toBe(50);
  });

  it("brings a fallen Green Flower home from an invasion that buries a Zombee in its place", async () => {
    // The control: the SAME fight with a Zombee (a sturdier Garden) at the back kills it.
    const control = await fightWithGarden("gf-control", ZOMBEE);
    expect(control.outcome.losses, JSON.stringify(control.outcome)).toContain("garden");
    expect(control.roster).not.toContain("garden");

    // The Green Flower falls too, and comes home.
    const flower = await fightWithGarden("gf-vitality", GREEN_FLOWER);
    expect(flower.outcome.losses, JSON.stringify(flower.outcome)).not.toContain("garden");
    expect(flower.outcome.survivors).toContain("garden");
    expect(flower.roster).toContain("garden");
  });
});
