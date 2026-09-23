// The faces in the objection's bubbles (raid 12). See signIcon.ts.
//
// The rigs themselves need a renderer, so this does not build sprites. It pins the DATA the
// icon rests on — which is where it would break silently. Every one of these is a premise
// the builder assumes and cannot check for itself at runtime: that the six classes each
// have a Green starter, that five of them have a head to show, and that the sixth has none
// so the body fallback is the thing that runs rather than dead code.
import { describe, expect, it } from "vitest";
import { SIGN_ICON_KEY } from "./signIcon";
import { SIGN_GROUPS } from "./dualInvasion";
import modelsJson from "../../public/assets/zombie/models.json";
import zombiesJson from "../../public/assets/zombies.json";

interface ModelPart { file: string; group: string }
interface Model { parts: ModelPart[]; scale: number }
const models = modelsJson as unknown as Record<string, Model>;
const species = zombiesJson as { key: string; group: string; className: string }[];
const byKey = new Map(species.map((z) => [z.key, z]));

const headPartsOf = (key: string) => models[key].parts.filter((p) => p.group === "head");

describe("the objection's faces", () => {
  it("names one zombie for every class the objection can bar, and no others", () => {
    expect(Object.keys(SIGN_ICON_KEY).sort()).toEqual([...SIGN_GROUPS].sort());
  });

  it("uses each class's GREEN starter — the face every player already knows", () => {
    for (const group of SIGN_GROUPS) {
      const def = byKey.get(SIGN_ICON_KEY[group]);
      expect(def, `${group}: ${SIGN_ICON_KEY[group]} is a real species`).toBeDefined();
      expect(def!.group, `${group} icon is a ${group}`).toBe(group);
      expect(def!.className, `${group} icon is the Green one`).toBe("Green");
    }
  });

  it("has a rig for each, with a head to show", () => {
    for (const group of SIGN_GROUPS) {
      const key = SIGN_ICON_KEY[group];
      expect(models[key], `${key} has a model`).toBeDefined();
      if (group === "Headless") continue;
      expect(headPartsOf(key).length, `${group} has a head`).toBeGreaterThan(0);
    }
  });

  it("gives Headless NO head, which is why it falls back to the body", () => {
    // Not a quirk to work around — it is the icon. A decapitated torso is how the class
    // reads on the field, and the fallback in `buildSignIcon` is reached only because this
    // is true. If a re-export ever gave the Headless rig a head group, the icon would
    // quietly become an empty box and this is the only place that would notice.
    const key = SIGN_ICON_KEY.Headless;
    expect(headPartsOf(key)).toEqual([]);
    expect(models[key].parts.length, "but it does have a body").toBeGreaterThan(0);
  });

  it("keeps the six visually apart, by feature or by size", () => {
    // Two cues, and each class needs at least one of them or the bubble is a coin toss.
    // Regular is deliberately the one with NO distinguishing part — it is the default face,
    // and what separates it is scale.
    const featureOf = (group: string) => headPartsOf(SIGN_ICON_KEY[group])
      .map((p) => p.file)
      .filter((f) => /Feature$|^bruteJaw$/.test(f))
      .join("+");
    expect(featureOf("Garden")).toContain("gnome");
    expect(featureOf("Female")).toContain("female");
    expect(featureOf("Small")).toContain("eyeBrow");
    expect(featureOf("Large")).toContain("brow");
    expect(featureOf("Regular"), "the plain one, told apart by size").toBe("");

    // …so Regular must not be the same size as the other featureless-adjacent classes.
    const scale = (group: string) => models[SIGN_ICON_KEY[group]].scale;
    expect(scale("Small")).toBeLessThan(scale("Regular"));
    expect(scale("Large")).toBeGreaterThan(scale("Regular"));
  });
});
