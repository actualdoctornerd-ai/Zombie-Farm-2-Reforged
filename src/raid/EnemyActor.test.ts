import { Texture } from "pixi.js";
import { describe, expect, it } from "vitest";
import type { EnemyModel } from "../assets";
import { EnemyActor } from "./EnemyActor";

const arm = (px: number, py: number, back: boolean) => ({
  rx: 0, ry: 0, rw: 1, rh: 1, px, py, ax: 0.5, ay: 0, z: back ? 0 : 1,
  rot: 0, group: "arm" as const, back,
});
const part = (
  group: "body" | "head" | "leg" | "wheel",
  px: number,
  py: number,
  back = false
) => ({
  rx: 0, ry: 0, rw: 1, rh: 1, px, py, ax: 0.5, ay: 0, z: 0,
  rot: 0, group, back,
});

describe("EnemyActor pirate attacks", () => {
  it("rotates both Pirate Boss arms around their authored shoulders", () => {
    const model: EnemyModel = {
      parts: [arm(-3, -4, true), arm(3, -4, false)],
      neck: null,
      slam: true,
      shoulder: { x: 2, y: 0 },
      pivots: [{ name: "back-shoulder", x: -2, y: 0 }],
    };
    const actor = new EnemyActor(Texture.EMPTY, model, "PirateStageActorBoss");
    const arms = (actor as unknown as {
      arms: { sp: { x: number; y: number; rotation: number }; back: boolean }[];
    }).arms;

    // u=0.5225 is the top of the raise for a 0.95 damage-timing slam.
    actor.update(0, false, { atkProg: 0.28 + 0.72 * 0.5225, damageTiming: 0.95 });

    for (const a of arms) {
      const pivot = a.back ? { x: -2, y: 0 } : { x: 2, y: 0 };
      expect(a.sp.rotation).toBeCloseTo(-2.5, 5);
      expect(Math.hypot(a.sp.x - pivot.x, a.sp.y - pivot.y)).toBeCloseTo(Math.sqrt(17), 5);
    }
  });

  it("gives the Scallywag club a slower, higher primary-hand wind-up", () => {
    const model: EnemyModel = {
      parts: [arm(3, -4, false)],
      neck: null,
      shoulder: { x: 2, y: 0 },
    };
    const normal = new EnemyActor(Texture.EMPTY, model, "PirateStageActorSwashbuckler");
    const heavy = new EnemyActor(Texture.EMPTY, model, "PirateStageActorScallywag");
    const attack = { atkProg: 0.28 + 0.72 * 0.5, damageTiming: 1 };
    normal.update(0, false, attack);
    heavy.update(0, false, attack);
    const rotation = (actor: EnemyActor) => (actor as unknown as {
      arms: { sp: { rotation: number } }[];
    }).arms[0].sp.rotation;

    expect(rotation(heavy)).toBeGreaterThan(1);
    expect(rotation(heavy)).toBeGreaterThan(rotation(normal));
  });

  it("uses Arrrnold's asymmetric blade hack at the 95% contact frame", () => {
    const model: EnemyModel = {
      parts: [
        arm(-3, -4, true), arm(3, -4, false),
        part("body", 0, 0), part("head", 0, -8),
      ],
      neck: null,
      slam: true,
    };
    const actor = new EnemyActor(Texture.EMPTY, model, "PirateStageActorBoss");
    actor.update(0, false, {
      atkProg: 1, damageTiming: 0.95, attackName: "PirateBossSlash",
    });
    const rig = actor as unknown as {
      arms: { sp: { rotation: number }; back: boolean }[];
      headParts: { sp: { x: number } }[];
    };

    expect(rig.arms.find((a) => !a.back)!.sp.rotation).toBeCloseTo(Math.PI / 2, 4);
    expect(rig.arms.find((a) => a.back)!.sp.rotation).toBeCloseTo(-135 * Math.PI / 180, 4);
    expect(rig.headParts[0].sp.x).toBeLessThan(0);
  });

  it("uses the Swashbuckler's rear hack and late head snap", () => {
    const model: EnemyModel = {
      parts: [
        arm(-3, -4, true), arm(3, -4, false),
        part("body", 0, 0), part("head", 0, -8),
      ],
      neck: { x: 0, y: 0 },
    };
    const actor = new EnemyActor(Texture.EMPTY, model, "PirateStageActorSwashbuckler");
    actor.update(0, false, {
      atkProg: 1, damageTiming: 0.95, attackName: "SwashbucklerSlice",
    });
    const rig = actor as unknown as {
      arms: { sp: { rotation: number }; back: boolean }[];
      headParts: { sp: { x: number; y: number } }[];
    };

    expect(rig.arms.find((a) => !a.back)!.sp.rotation).toBeCloseTo(Math.PI / 2, 4);
    expect(rig.arms.find((a) => a.back)!.sp.rotation).toBeCloseTo(-135 * Math.PI / 180, 4);
    expect(rig.headParts[0].sp.x).toBeLessThan(-7);
    expect(rig.headParts[0].sp.y).toBeLessThan(-11);
  });
});

describe("EnemyActor circus attacks", () => {
  it("uses the unicycle bear wobble at its 30% contact frame", () => {
    const model: EnemyModel = {
      parts: [
        arm(-3, -4, true), arm(3, -4, false),
        part("body", 0, 0), part("leg", 0, 4), part("wheel", 0, 8),
      ],
      neck: null,
    };
    const actor = new EnemyActor(Texture.EMPTY, model, "CircusStageActorMinion1");
    actor.update(0, false, {
      atkProg: 1, damageTiming: 0.3, attackName: "UnicycleBearAttack",
    });
    const rig = actor as unknown as {
      arms: { sp: { rotation: number } }[];
      bodies: { sp: { rotation: number } }[];
      wheels: { sp: { rotation: number } }[];
    };

    expect(rig.arms[0].sp.rotation).toBeGreaterThan(0.2);
    expect(rig.arms[1].sp.rotation).toBeLessThan(-0.2);
    expect(rig.bodies[0].sp.rotation).toBeGreaterThan(0.2);
    expect(rig.wheels[0].sp.rotation).toBeCloseTo(Math.PI / 2, 4);
  });

  it("rocks all three clown layers independently at the 20% poke", () => {
    const model: EnemyModel = {
      parts: [
        part("body", 0, 80), part("body", 0, 40), part("body", 0, 0),
        arm(44, 80, false), arm(44, 40, false), arm(44, 0, false),
      ],
      neck: null,
    };
    const actor = new EnemyActor(Texture.EMPTY, model, "CircusStageActorMinion2");
    actor.update(0, false, {
      atkProg: 1, damageTiming: 0.2, attackName: "MidgetStackAttack",
    });
    const bodies = (actor as unknown as {
      bodies: { sp: { x: number; rotation: number; scale: { x: number } } }[];
    }).bodies;

    expect(bodies.map(({ sp }) => Math.sign(sp.rotation))).toEqual([1, -1, 1]);
    expect(new Set(bodies.map(({ sp }) => sp.x))).toHaveLength(3);
    expect(bodies[2].sp.scale.x).toBeGreaterThan(bodies[0].sp.scale.x);
  });

  it("uses the Ringmaster's opposing arm flourish and contact lunge", () => {
    const model: EnemyModel = {
      parts: [
        arm(-3, -4, true), arm(3, -4, false),
        part("body", 0, 0), part("head", 0, -8),
        part("leg", -2, 5, true), part("leg", 2, 5, false),
      ],
      neck: { x: 0, y: 0 },
    };
    const actor = new EnemyActor(Texture.EMPTY, model, "CircusStageActorBoss");
    actor.update(0, false, {
      atkProg: 1, damageTiming: 0.75, attackName: "RingMasterAttack",
    });
    const rig = actor as unknown as {
      arms: { sp: { rotation: number }; back: boolean }[];
      headParts: { sp: { x: number; y: number } }[];
    };

    expect(rig.arms.find((a) => a.back)!.sp.rotation).toBeCloseTo(-40 * Math.PI / 180, 4);
    expect(rig.arms.find((a) => !a.back)!.sp.rotation).toBeCloseTo(40 * Math.PI / 180, 4);
    expect(rig.headParts[0].sp.x).toBeLessThan(-9);
    expect(rig.headParts[0].sp.y).toBeGreaterThan(-4);
  });
});

describe("EnemyActor Lawyers raid attacks", () => {
  it("uses the Crazed Worker's full-turn whack and offset rear-hand hack", () => {
    const model: EnemyModel = {
      parts: [
        arm(-3, -4, true), arm(3, -4, false),
        part("body", 0, 0), part("head", 0, -8),
      ],
      neck: { x: 0, y: 0 },
    };
    const actor = new EnemyActor(Texture.EMPTY, model, "CityStageActorCrazedWorker");
    actor.update(0, false, {
      atkProg: 0.9, damageTiming: 1, attackName: "CrazedWorkerAttack",
    });
    const rig = actor as unknown as {
      arms: { sp: { rotation: number }; back: boolean }[];
      headParts: { sp: { x: number; y: number } }[];
    };

    expect(rig.arms.find((a) => !a.back)!.sp.rotation).toBeCloseTo(Math.PI, 4);
    expect(rig.arms.find((a) => a.back)!.sp.rotation).toBeCloseTo(-135 * Math.PI / 180, 4);
    expect(rig.headParts[0].sp.x).toBeLessThan(-7);
    expect(rig.headParts[0].sp.y).toBeLessThan(-11);
  });

  it.each(["CorporateBossPunch", "CorporateBossPunchSpecial"])(
    "uses the Corporate Boss double-flail for %s",
    (attackName) => {
      const model: EnemyModel = {
        parts: [arm(-3, -4, true), arm(3, -4, false), part("head", 0, -8)],
        neck: { x: 0, y: 0 },
        punch: true,
      };
      const actor = new EnemyActor(Texture.EMPTY, model, "CityStageActorBoss");
      actor.update(0, false, { atkProg: 1, damageTiming: 0.4, attackName });
      const arms = (actor as unknown as {
        arms: { sp: { rotation: number }; back: boolean }[];
      }).arms;

      expect(arms.find((a) => !a.back)!.sp.rotation).toBeCloseTo(-Math.PI / 2, 4);
      expect(arms.find((a) => a.back)!.sp.rotation).toBeLessThan(-2);
    }
  );

  it("steps the Lawyer into the alternating-arm contact frame", () => {
    const model: EnemyModel = {
      parts: [
        arm(-3, -4, true), arm(3, -4, false),
        part("body", 0, 0), part("head", 0, -8),
      ],
      neck: { x: 0, y: 0 },
      punch: true,
    };
    const actor = new EnemyActor(Texture.EMPTY, model, "CityStageActorLawyer");
    actor.update(0, false, {
      atkProg: 1, damageTiming: 0.75, attackName: "LawyerAttack",
    });
    const rig = actor as unknown as {
      root: { x: number; y: number };
      arms: { sp: { rotation: number }; back: boolean }[];
    };

    expect(rig.root.x).toBeCloseTo(-15, 4);
    expect(rig.root.y).toBeCloseTo(-15, 4);
    expect(rig.arms.find((a) => !a.back)!.sp.rotation).toBeCloseTo(0, 4);
    expect(rig.arms.find((a) => a.back)!.sp.rotation).toBeCloseTo(50 * Math.PI / 180, 4);
  });
});

describe("EnemyActor Ninja raid attacks", () => {
  it("uses the Ninja girl's full-body stab at its 50% contact frame", () => {
    const model: EnemyModel = {
      parts: [
        arm(-3, -4, true), arm(3, -4, false),
        part("body", 0, 0), part("head", 0, -8),
        part("leg", -2, 5, true), part("leg", 2, 5, false),
      ],
      neck: null,
    };
    const actor = new EnemyActor(Texture.EMPTY, model, "NinjaStageActorGirl");
    actor.update(0, false, {
      atkProg: 1, damageTiming: 0.5, attackName: "NinjaStab",
    });
    const rig = actor as unknown as {
      arms: { sp: { x: number; y: number; rotation: number }; back: boolean }[];
      bodies: { sp: { rotation: number } }[];
      headParts: { sp: { x: number; y: number; rotation: number } }[];
      legs: { sp: { x: number; y: number; rotation: number }; back: boolean }[];
    };
    const frontArm = rig.arms.find((a) => !a.back)!.sp;
    const backArm = rig.arms.find((a) => a.back)!.sp;
    const frontFoot = rig.legs.find((l) => !l.back)!.sp;

    expect(frontArm.x).toBeCloseTo(-2, 4);
    expect(frontArm.y).toBeCloseTo(-3, 4);
    expect(frontArm.rotation).toBeLessThan(0);
    expect(backArm.x).toBeCloseTo(-5.5, 4);
    expect(backArm.rotation).toBeLessThan(-0.5);
    expect(rig.bodies[0].sp.rotation).toBeCloseTo(-4 * Math.PI / 180, 4);
    expect(rig.headParts[0].sp.x).toBeCloseTo(-4, 4);
    expect(rig.headParts[0].sp.y).toBeCloseTo(-6.5, 4);
    expect(rig.headParts[0].sp.rotation).toBeCloseTo(-3 * Math.PI / 180, 4);
    expect(frontFoot.x).toBeCloseTo(3, 4);
    expect(frontFoot.y).toBeCloseTo(4, 4);
    expect(frontFoot.rotation).toBeCloseTo(-10 * Math.PI / 180, 4);
  });
});

describe("EnemyActor Robot raid attacks", () => {
  it("runs BroBot's two front mechanisms on independent spin tracks", () => {
    const model: EnemyModel = {
      parts: [
        arm(-3, -4, true), arm(3, -4, false), arm(5, -2, false),
        part("body", 0, 0), part("head", 0, -8),
      ],
      neck: null,
    };
    const actor = new EnemyActor(Texture.EMPTY, model, "RobotStageActorBroBot");
    actor.update(0, false, {
      atkProg: 0.95, damageTiming: 1, attackName: "BroBotAttack",
    });
    const rig = actor as unknown as {
      arms: { sp: { rotation: number }; back: boolean }[];
      headParts: { sp: { x: number; y: number } }[];
    };
    const front = rig.arms.filter((armPart) => !armPart.back);

    expect(front[0].sp.rotation).toBeCloseTo(-270 * Math.PI / 180, 4);
    expect(front[1].sp.rotation).toBeLessThan(-4);
    expect(rig.headParts[0].sp.x).toBeCloseTo(5, 4);
    expect(rig.headParts[0].sp.y).toBeCloseTo(-6, 4);
  });

  it("uses JunkBot's body recoil and bite snap", () => {
    const model: EnemyModel = {
      parts: [part("body", 0, 0), part("head", 0, -8)],
      neck: null,
    };
    const actor = new EnemyActor(Texture.EMPTY, model, "RobotStageActorJunkBot");
    actor.update(0, false, {
      atkProg: 0.2, damageTiming: 1, attackName: "JunkBotBite",
    });
    const rig = actor as unknown as {
      bodies: { sp: { rotation: number } }[];
      headParts: { sp: { rotation: number } }[];
    };

    expect(rig.bodies[0].sp.rotation).toBeCloseTo(-20 * Math.PI / 180, 4);
    expect(rig.headParts[0].sp.rotation).toBeCloseTo(100 * Math.PI / 180, 4);
  });
});
