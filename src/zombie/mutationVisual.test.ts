import { describe, expect, it } from "vitest";
import {
  BACK_ARM_SCALE,
  BACK_ARM_TINT,
  backArmPlacement,
  EYE_MUTATION_FOREGROUND_Z,
  hidesHeadMutationArt,
  matchesMutationReplacement,
  mutationBitsForRendering,
  mutationPartFor,
  mutationPartZIndex,
} from "./mutationVisual";
import { bitOf, MUTATION_LIST, resolveMutationBit } from "./mutations";
import mutationArt from "../../public/assets/zombie/mutations.json";
import zombieModels from "../../public/assets/zombie/models.json";

describe("mutation visual replacements", () => {
  it("keeps the Carrot/Eyebiscus eye attachment above every other layer", () => {
    expect(mutationPartZIndex(4, "head", 6)).toBe(EYE_MUTATION_FOREGROUND_Z);
    expect(mutationPartZIndex(128, "head", 6)).toBe(4.5);
    expect(mutationPartZIndex(8, "root", 8)).toBe(8);
  });

  it("omits carrot-eye artwork from special zombies without changing other mutations", () => {
    const zombies = [
      { key: "regular", category: "normal" as const },
      { key: "special", category: "special" as const },
    ];

    expect(mutationBitsForRendering(zombies, "regular", 4 | 8)).toEqual([4, 8]);
    expect(mutationBitsForRendering(zombies, "special", 4 | 8)).toEqual([8]);
  });

  it("draws no mutation art at all on an Epic reward zombie, in any slot", () => {
    // The prize wears the bits (the Pot put them there, and they buff its stats);
    // only the drawing waits for per-actor art.
    const zombies = [
      { key: "epic", category: "special" as const, rewardOnly: true },
      { key: "special", category: "special" as const, rewardOnly: false },
    ];
    const everySlot = MUTATION_LIST.reduce((m, def) => m | bitOf(def.key), 0);
    expect(mutationBitsForRendering(zombies, "epic", everySlot)).toEqual([]);
    expect(mutationBitsForRendering(zombies, "special", everySlot).length).toBeGreaterThan(0);
  });

  it("draws no head mutation on a masked face, but still draws its other slots", () => {
    // The mask (a beard, a space helmet, a wall of leaves) sits over an ordinary head,
    // so a head mutation would hide that head and float the face parts over the
    // vegetable. The bit is still WORN — only the art is skipped.
    const zombies = [{ key: "ZombieActorZastronaut", category: "special" as const }];
    const mask = bitOf("onion") | bitOf("celery");

    expect(hidesHeadMutationArt("ZombieActorZastronaut")).toBe(true);
    expect(mutationBitsForRendering(zombies, "ZombieActorZastronaut", mask))
      .toEqual([bitOf("celery")]);
    // Pumpking is a head mutation too, and goes the same way.
    expect(mutationBitsForRendering(zombies, "ZombieActorForest", bitOf("pumpking")))
      .toEqual([]);
  });

  it("leaves every other species' head mutations alone", () => {
    expect(hidesHeadMutationArt("ZombieActorRegularTier1")).toBe(false);
    expect(mutationBitsForRendering([], "ZombieActorRegularTier1", bitOf("onion")))
      .toEqual([bitOf("onion")]);
  });

  it("matches every base body silhouette without hiding unrelated decorations", () => {
    expect(matchesMutationReplacement("defaultBody", "body")).toBe(true);
    expect(matchesMutationReplacement("bellydancerBody", "body")).toBe(true);
    expect(matchesMutationReplacement("heartichokeBody", "body")).toBe(true);
    expect(matchesMutationReplacement("flytrapCollar", "body")).toBe(false);
  });

  it("replaces the whole arm pair, front and back", () => {
    // A Celery-arms zombie grows the crop on BOTH sides, so neither base arm stays.
    expect(matchesMutationReplacement("defaultArmF", "armF")).toBe(true);
    expect(matchesMutationReplacement("diverArmF", "armF")).toBe(true);
    expect(matchesMutationReplacement("defaultArmB", "armF")).toBe(true);
    expect(matchesMutationReplacement("diverArmB", "armF")).toBe(true);
    expect(matchesMutationReplacement("dragonArm", "armF")).toBe(false);
  });

  it("replaces the skull while preserving foreground face and accessory layers", () => {
    expect(matchesMutationReplacement("defaultHead", "head")).toBe(true);
    expect(matchesMutationReplacement("defaultUpperTeeth", "head")).toBe(true);
    expect(matchesMutationReplacement("defaultScar", "head")).toBe(true);
    expect(matchesMutationReplacement("defaultEyeL", "head")).toBe(false);
    expect(matchesMutationReplacement("defaultJaw", "head")).toBe(false);
    expect(matchesMutationReplacement("defaultLowerTeeth", "head")).toBe(false);
    expect(matchesMutationReplacement("gnomeFeature", "head")).toBe(false);
    expect(matchesMutationReplacement("barbarianHair", "head")).toBe(false);
    expect(matchesMutationReplacement("defaultBody", "head")).toBe(false);
  });
});

describe("mirrored back arm", () => {
  const model = {
    parts: [
      { file: "defaultArmB", px: -3, py: -25, ax: 0.93, ay: 0.24, z: 0 },
      { file: "defaultBody", px: 10, py: -13, ax: 0.63, ay: 0.66, z: 3 },
      { file: "defaultArmF", px: 9, py: -28, ax: 0.93, ay: 0.28, z: 7 },
    ],
  } as unknown as Parameters<typeof backArmPlacement>[0];
  const turnip = { ox: 0, oy: 28, ax: 1, ay: 0.28 };

  it("shifts the authored front offset by the rig's own front-to-back delta", () => {
    // Authored against the FRONT shoulder; the copy has to land on the back one.
    expect(backArmPlacement(model, turnip)).toEqual({
      x: -12, // 0 + (-3 - 9)
      y: -25, // -28 + (-25 - -28)
      ax: 1, // anchors follow, so it still pivots at the joint
      ay: 0.24, // 0.28 + (0.24 - 0.28)
      z: 0, // behind the body, where the base back arm sat
      scale: BACK_ARM_SCALE,
      tint: BACK_ARM_TINT,
    });
  });

  it("draws no back copy on a rig that has no back arm", () => {
    // Every named special is built from whole-body art with no arm parts at all —
    // a mirrored arm there would float behind the body attached to nothing.
    const armless = { parts: [{ file: "Head.png", px: 0, py: 0, ax: 0.5, ay: 0.5, z: 4 }] };
    expect(backArmPlacement(armless as never, turnip)).toBeUndefined();
  });

  it("places a back copy on every shipped model, since all of them have both arms", () => {
    const models = zombieModels as unknown as Record<string, { parts: { file: string }[] }>;
    for (const [key, model] of Object.entries(models)) {
      expect(backArmPlacement(model as never, turnip), `${key} has no back arm`).toBeDefined();
    }
  });

  it("reproduces the depth cue the base rigs bake into their own back arm", () => {
    // defaultArmB is drawn smaller (27x14 vs 32x17) and ~6% darker than defaultArmF.
    // Crop arms ship one texture, so the copy has to fake the same recession.
    expect(BACK_ARM_SCALE).toBeLessThan(1);
    expect(BACK_ARM_TINT).toBeLessThan(0xffffff);
  });
});

describe("mutation art lookup", () => {
  const part = (file: string) => ({
    file, group: "head" as const, headRel: false, ox: 0, oy: 0, ax: 0, ay: 0, z: 0,
  });
  const shipped = { tomato: part("tomatoHead"), cauli: part("cauliflowerHat") };

  it("finds art by the mutation's KEY, which is how mutations.json is written", () => {
    expect(mutationPartFor(shipped, undefined, bitOf("tomato"))?.file).toBe("tomatoHead");
    expect(mutationPartFor(shipped, {}, bitOf("cauli"))?.file).toBe("cauliflowerHat");
  });

  it("still finds art keyed by a raw bit, so older art keeps resolving", () => {
    // The shipped file was keyed by bit until the keys took over, and a mod may still
    // be. Nothing has to be renamed for its art to appear.
    const parts = { [String(bitOf("pumpking"))]: part("pumpkinHead") };
    expect(mutationPartFor(parts, undefined, bitOf("pumpking"))?.file).toBe("pumpkinHead");
  });

  it("prefers the key-addressed entry when a mutation has both", () => {
    // Only reachable while art is being migrated from one form to the other; pinning
    // it means the change can be made a row at a time without a flicker of ambiguity.
    const parts = { "1": part("oldTomatoHead"), tomato: part("tomatoHead") };
    expect(mutationPartFor(parts, undefined, bitOf("tomato"))?.file).toBe("tomatoHead");
  });

  it("honours a model override addressed either way", () => {
    // This is how the Tier-4 variants show their own art for a shared mutation.
    const parts = { ...shipped, heartichokeBody: part("heartichokeBody") };
    const cauli = bitOf("cauli");
    const byKey = { mutationOverrides: { cauli: "heartichokeBody" } };
    const byBit = { mutationOverrides: { [String(cauli)]: "heartichokeBody" } };
    expect(mutationPartFor(parts, byKey, cauli)?.file).toBe("heartichokeBody");
    expect(mutationPartFor(parts, byBit, cauli)?.file).toBe("heartichokeBody");
  });

  it("returns nothing for a mutation this build ships no art for", () => {
    // The rigs skip a partless mutation AND leave the base body part visible, so a
    // missing image costs one attachment rather than deleting the zombie's head.
    expect(mutationPartFor(shipped, undefined, bitOf("pumpking"))).toBeUndefined();
    expect(mutationPartFor(shipped, { mutationOverrides: { tomato: "missing" } }, bitOf("tomato")))
      .toBeUndefined();
  });
});

describe("shipped mutation data is addressed by name", () => {
  // Both files used to be keyed by the raw bit ("512": {...}), which meant authoring
  // art required knowing a power of two and reading a diff required decoding one.
  // A bit key still RESOLVES (the tests above), so this guards intent rather than
  // capability: the shipped data stays readable.
  const isNumeric = (key: string) => /^\d+$/.test(key);

  it("keys mutations.json by mutation key, never by bit", () => {
    const offenders = Object.keys(mutationArt).filter(isNumeric);
    expect(offenders, `numeric keys in mutations.json: ${offenders.join(", ")}`).toEqual([]);
    // Every catalogued mutation has art, addressed by its own name.
    for (const def of MUTATION_LIST) {
      expect(mutationArt, `no art entry for "${def.key}"`).toHaveProperty(def.key);
    }
  });

  it("keys every model's mutationOverrides by mutation key, never by bit", () => {
    const models = zombieModels as Record<string, { mutationOverrides?: Record<string, string> }>;
    for (const [species, model] of Object.entries(models)) {
      for (const key of Object.keys(model.mutationOverrides ?? {})) {
        expect(isNumeric(key), `${species} overrides bit "${key}"`).toBe(false);
        // ...and it names a mutation that exists, so a typo can't silently do nothing.
        expect(resolveMutationBit(key), `${species} overrides unknown "${key}"`).not.toBeNull();
      }
    }
  });
});
