import { Container, Renderer, Texture } from "pixi.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GameAssets, ZombieModel } from "../assets";
import {
  buildZombiePortraitRig, portraitFrameTop, validatePortraitDataUrl, MutationPortraits,
  MAX_PORTRAIT_ATTEMPTS,
} from "./mutationPortrait";

afterEach(() => vi.unstubAllGlobals());

const model: ZombieModel = {
  name: "Test", neck: { x: 2, y: -20 }, scale: 1, color: [100, 120, 140],
  parts: [
    { file: "baseBody", group: "root", px: 0, py: -20, ax: 0.5, ay: 0.5, z: 3, tint: true },
    { file: "baseArmF", group: "root", px: 8, py: -25, ax: 1, ay: 0.5, z: 7, tint: true },
    { file: "defaultHead", group: "head", px: 2, py: -30, ax: 0.5, ay: 0.5, z: 4, tint: true },
    { file: "defaultEyeL", group: "head", px: 0, py: -32, ax: 0.5, ay: 0.5, z: 9, tint: true },
    { file: "defaultJaw", group: "head", px: 2, py: -25, ax: 0.5, ay: 0.5, z: 10, tint: true },
    { file: "defaultLowerTeeth", group: "head", px: 2, py: -24, ax: 0.5, ay: 0.5, z: 11, tint: true },
    { file: "gnomeFeature", group: "head", px: 2, py: -34, ax: 0.5, ay: 0.5, z: 12, tint: false },
  ],
};

const assets = {
  zombieModels: { test: model, ZombieActorRegularTier1: model },
  zombiePartTex: {
    baseBody: Texture.EMPTY, baseArmF: Texture.EMPTY, defaultHead: Texture.EMPTY,
    defaultEyeL: Texture.EMPTY, defaultJaw: Texture.EMPTY, defaultLowerTeeth: Texture.EMPTY,
    gnomeFeature: Texture.EMPTY,
    tomato: Texture.EMPTY, turnip: Texture.EMPTY, lima: Texture.EMPTY,
  },
  mutationParts: {
    "1": { file: "tomato", group: "head", headRel: true, ox: 1, oy: 4, ax: 0.5, ay: 0.5, z: 4 },
    "8": { file: "turnip", group: "root", headRel: false, ox: 8, oy: 25, ax: 1, ay: 0.5, z: 8, replaces: "armF" },
    "1024": { file: "lima", group: "root", headRel: false, ox: 0, oy: 20, ax: 0.5, ay: 0.5, z: 4, replaces: "body" },
  },
} as unknown as GameAssets;

describe("mutation-aware zombie portraits", () => {
  it("accepts visible extracts and rejects fully transparent PNGs", async () => {
    class FakeImage {
      src = "";
      naturalWidth = 1;
      naturalHeight = 1;
      decode = vi.fn().mockResolvedValue(undefined);
    }
    let alpha = 255;
    vi.stubGlobal("Image", FakeImage);
    vi.stubGlobal("document", {
      createElement: () => ({
        width: 0, height: 0,
        getContext: () => ({
          drawImage: vi.fn(),
          getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, alpha]) }),
        }),
      }),
    });

    await expect(validatePortraitDataUrl("data:image/png;base64,visible")).resolves
      .toBe("data:image/png;base64,visible");
    alpha = 0;
    await expect(validatePortraitDataUrl("data:image/png;base64,blank")).rejects
      .toThrow("portrait extraction was transparent");
  });

  it("renders every mutation and hides the base parts they replace", () => {
    const rig = buildZombiePortraitRig(assets, "test", 1 | 8 | 1024);
    const children = rig.children as unknown as {
      label: string;
      visible: boolean;
      tint: number;
      zIndex: number;
    }[];

    expect(children.map((child) => child.label)).toEqual([
      "baseBody", "baseArmF", "defaultHead", "defaultEyeL", "defaultJaw",
      "defaultLowerTeeth", "gnomeFeature", "tomato", "turnip", "lima",
    ]);
    expect(children.find((child) => child.label === "baseBody")?.visible).toBe(false);
    expect(children.find((child) => child.label === "baseArmF")?.visible).toBe(false);
    expect(children.find((child) => child.label === "defaultHead")?.visible).toBe(false);
    expect(children.find((child) => child.label === "defaultEyeL")?.tint).toBe(0xffffff);
    const mutationZ = children.find((child) => child.label === "tomato")?.zIndex ?? 0;
    for (const label of ["defaultEyeL", "defaultJaw", "defaultLowerTeeth", "gnomeFeature"]) {
      const child = children.find((candidate) => candidate.label === label);
      expect(child?.visible).toBe(true);
      expect(child?.zIndex).toBeGreaterThan(mutationZ);
    }
  });

  it("shows a crop arm on both arms, hiding the base pair behind it", () => {
    // The card has to match the farm and battlefield rigs: one crop arm each side.
    const twoArmed: ZombieModel = {
      ...model,
      parts: [
        { file: "baseArmB", group: "root", px: -4, py: -22, ax: 1, ay: 0.45, z: 0, tint: true },
        ...model.parts,
      ],
    };
    const twoArmedAssets = {
      ...assets,
      zombieModels: { ...assets.zombieModels, twoArmed },
      zombiePartTex: { ...assets.zombiePartTex, baseArmB: Texture.EMPTY },
    } as unknown as GameAssets;

    const rig = buildZombiePortraitRig(twoArmedAssets, "twoArmed", 8);
    const children = rig.children as unknown as {
      label: string; visible: boolean; zIndex: number; x: number; scale: { x: number };
    }[];

    expect(children.filter((child) => child.label === "turnip")).toHaveLength(2);
    for (const label of ["baseArmB", "baseArmF"]) {
      expect(children.find((child) => child.label === label)?.visible).toBe(false);
    }
    const [front, back] = children.filter((child) => child.label === "turnip");
    expect(front.zIndex).toBe(8);
    expect(back.zIndex).toBe(0); // behind the body, where the base back arm sat
    expect(back.x).toBe(-4); // 8 + (-4 - 8): the rig's own front-to-back delta
    expect(back.scale.x).toBeLessThan(front.scale.x);
  });
});

// Each extraction blocks the main thread on a GPU readback (~30ms), and the panels
// that ask for them build one tile per owned zombie, so how the cache batches and
// gives up matters as much as what it renders.
describe("portrait extraction scheduling", () => {
  /** Pass validatePortraitDataUrl: one opaque pixel. */
  const stubOpaqueDecode = () => {
    vi.stubGlobal("Image", class {
      src = ""; naturalWidth = 1; naturalHeight = 1;
      decode = vi.fn().mockResolvedValue(undefined);
    });
    vi.stubGlobal("document", {
      createElement: () => ({
        width: 0, height: 0,
        getContext: () => ({
          drawImage: vi.fn(),
          getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, 255]) }),
        }),
      }),
    });
  };

  const fakeRenderer = (base64: () => Promise<string>) =>
    ({ extract: { base64: vi.fn(base64) } } as unknown as Renderer);

  it("extracts each key/mask/color once and reuses the cached result", async () => {
    stubOpaqueDecode();
    const renderer = fakeRenderer(async () => "data:image/png;base64,ok");
    const portraits = new MutationPortraits(renderer, assets);

    const [a, b] = await Promise.all([portraits.get("test", 1), portraits.get("test", 1)]);

    expect(a).toBe("data:image/png;base64,ok");
    expect(b).toBe(a);
    expect(renderer.extract.base64).toHaveBeenCalledTimes(1);
  });

  it("never runs two extractions at once, so a burst cannot form one long task", async () => {
    stubOpaqueDecode();
    let live = 0;
    let overlapped = false;
    const renderer = fakeRenderer(async () => {
      live += 1;
      if (live > 1) overlapped = true;
      await Promise.resolve();
      live -= 1;
      return "data:image/png;base64,ok";
    });
    const portraits = new MutationPortraits(renderer, assets);

    await Promise.all([0, 1, 8, 1024].map((mask) => portraits.get("test", mask)));

    expect(overlapped).toBe(false);
    expect(renderer.extract.base64).toHaveBeenCalledTimes(4);
  });

  // The Black Market lists other players' zombies, so every portrait on it is a cold
  // extraction; leaving the panel mid-burst used to keep spending ~30ms frames on
  // tiles that no longer existed, which reads as a lag spike on the farm behind it.
  it("drops queued portraits once every tile waiting on them has gone", async () => {
    stubOpaqueDecode();
    const renderer = fakeRenderer(async () => "data:image/png;base64,ok");
    const portraits = new MutationPortraits(renderer, assets);
    let onScreen = true;

    const requests = [0, 1, 8, 1024].map((mask) =>
      portraits.get("test", mask, undefined, () => onScreen).catch(() => "dropped"));
    onScreen = false; // the panel closes before the queue drains
    const results = await Promise.all(requests);

    expect(results).toEqual(["dropped", "dropped", "dropped", "dropped"]);
    expect(renderer.extract.base64).not.toHaveBeenCalled();
  });

  it("keeps a portrait a second, still-visible tile is waiting on", async () => {
    stubOpaqueDecode();
    const renderer = fakeRenderer(async () => "data:image/png;base64,ok");
    const portraits = new MutationPortraits(renderer, assets);

    // Same zombie in a panel that closes and one that stays (e.g. the Mausoleum grid
    // behind the market): the shared extraction has to survive for the survivor.
    const closing = portraits.get("test", 1, undefined, () => false);
    const staying = portraits.get("test", 1, undefined, () => true);

    await expect(staying).resolves.toBe("data:image/png;base64,ok");
    await expect(closing).resolves.toBe("data:image/png;base64,ok");
  });

  it("re-extracts an abandoned portrait later instead of writing it off", async () => {
    stubOpaqueDecode();
    const renderer = fakeRenderer(async () => "data:image/png;base64,ok");
    const portraits = new MutationPortraits(renderer, assets);

    // Abandoning must not spend the key's retry attempts, or a player who closes a
    // panel quickly enough, twice, would never see that zombie's portrait again.
    for (let attempt = 0; attempt < MAX_PORTRAIT_ATTEMPTS + 2; attempt++) {
      await expect(portraits.get("test", 1, undefined, () => false)).rejects.toThrow();
    }

    await expect(portraits.get("test", 1)).resolves.toBe("data:image/png;base64,ok");
  });

// A card's portrait box fits the image by `contain`, so a rig that CARRIES something
// tall is shrunk to squeeze the prop in and its face ends up two thirds the size of an
// ordinary zombie's. The hand-labelled top (assets/zombie/tops.json) frames the card to
// the zombie instead. See src/raid/RaidActor.ts for the same rule in a raid.
describe("a labelled rig's portrait frame", () => {
  /** The test rig plus a banner held high above its head. */
  const flagged = (topY?: number): ZombieModel => ({
    ...model,
    ...(topY === undefined ? {} : { topY }),
    parts: [
      ...model.parts,
      { file: "banner", group: "root", px: 0, py: -120, ax: 0.5, ay: 0.5, z: 1, tint: false },
    ],
  });
  const flaggedAssets = (m: ZombieModel) => ({
    ...assets,
    zombieModels: { ...assets.zombieModels, test: m },
    zombiePartTex: { ...assets.zombiePartTex, banner: Texture.EMPTY, tallHat: Texture.EMPTY },
    mutationParts: {
      ...assets.mutationParts,
      // A crop hat that rears up well above the crown — the flytrap collar does exactly
      // this on seven of the eight rigs labelled so far.
      "2": { file: "tallHat", group: "head", headRel: true, ox: 0, oy: 60, ax: 0.5, ay: 0.5, z: 5 },
    },
  }) as unknown as GameAssets;
  const frameTop = (m: ZombieModel, mutation = 0) => {
    const a = flaggedAssets(m);
    const rig = buildZombiePortraitRig(a, "test", mutation);
    const target = new Container();
    target.addChild(rig);
    return portraitFrameTop(rig, m, target.getLocalBounds());
  };

  it("frames to the label instead of the top of the art", () => {
    // Texture.EMPTY is 1x1, so a centred sprite reaches half a pixel past its y.
    expect(frameTop(flagged())).toBe(-120.5);    // unlabelled: the banner sets the top
    expect(frameTop(flagged(-34))).toBe(-34);    // labelled: the zombie's own crown
  });

  it("carries the label through the model's own scale", () => {
    expect(frameTop({ ...flagged(-34), scale: 0.5 })).toBe(-17);
  });

  it("ignores a label that does not describe the rig", () => {
    expect(frameTop(flagged(-400))).toBe(-120.5); // above the art entirely
    expect(frameTop(flagged(40))).toBe(-120.5);   // below the feet
  });

  it("never crops mutation art, whatever the label says", () => {
    // The hat sits at neck.y - oy = -80, above the -34 label: a card exists to show
    // what the zombie is wearing, so the frame opens back up for it.
    expect(frameTop(flagged(-34), 2)).toBe(-80.5);
    // ...but only as far as the mutation reaches, not back to the banner.
    expect(frameTop(flagged(-34), 1)).toBe(-34);
  });

  it("extracts the cropped frame, not the whole silhouette", async () => {
    stubOpaqueDecode();
    const renderer = fakeRenderer(async () => "data:image/png;base64,ok");
    const labelled = new MutationPortraits(renderer, flaggedAssets(flagged(-34)));
    await labelled.get("test", 0);
    const cropped = (renderer.extract.base64 as unknown as
      { mock: { calls: [{ frame: { y: number; height: number } }][] } }).mock.calls[0][0].frame;

    const plainRenderer = fakeRenderer(async () => "data:image/png;base64,ok");
    const plain = new MutationPortraits(plainRenderer, flaggedAssets(flagged()));
    await plain.get("test", 0);
    const whole = (plainRenderer.extract.base64 as unknown as
      { mock: { calls: [{ frame: { y: number; height: number } }][] } }).mock.calls[0][0].frame;

    expect(cropped.y).toBeGreaterThan(whole.y);
    expect(cropped.height).toBeLessThan(whole.height);
    // Same feet, so the zombie is the same size in rig space — only the empty prop
    // space above it is gone, which is what makes it bigger in the card's box.
    expect(cropped.y + cropped.height).toBeCloseTo(whole.y + whole.height, 5);
  });
});

  it("gives up on a portrait that keeps failing instead of retrying it forever", async () => {
    stubOpaqueDecode();
    const renderer = fakeRenderer(async () => { throw new Error("extraction failed"); });
    const portraits = new MutationPortraits(renderer, assets);

    // One request per rebuild of a panel that lists this zombie.
    for (let attempt = 0; attempt < MAX_PORTRAIT_ATTEMPTS + 3; attempt++) {
      await expect(portraits.get("test", 1)).rejects.toThrow();
    }

    expect(renderer.extract.base64).toHaveBeenCalledTimes(MAX_PORTRAIT_ATTEMPTS);
  });
});
