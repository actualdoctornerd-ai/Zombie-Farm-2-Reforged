import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MAX_FUNCTIONAL_OBJECTS } from "../src/v3/engine";
import {
  MAX_PRESENTATION_BYTES, MAX_PRESENTATION_FALLEN, REQUEST_ENVELOPE_BYTES,
} from "../src/presentationLimits";
import { MAX_ZOMBIE_NAME_LENGTH } from "../../src/zombie/types";
import placeables from "../../public/assets/placeables.json";

// The presentation blob is validated wholesale and rejected wholesale: one field the
// Worker dislikes and the ENTIRE write is refused — zombie names, teams, the Almanac,
// object layout, camera, lifetime stats, all of it. The client then retries the same
// blob every minute, forever, and is refused every time. So each bound here is a
// silent, permanent, total loss of online presentation saving for whoever crosses it.
//
// That is what happened with the object layout: the bound was a literal 512 while the
// object cap is also 512 — but the layout carries one thing the object document never
// does, the presentation-only starter shed. A player who filled their farm to the cap
// sent 513 and lost every one of the above with no error shown, and only the most
// decorated farms in the game could reach it.
//
// A bound written as a literal is a second copy of a number someone else owns. These
// pin the copies together.

const source = readFileSync(fileURLToPath(new URL("../src/index.ts", import.meta.url)), "utf8");

describe("presentation bounds track the limits they are derived from", () => {
  it("admits a layout from a farm filled to the object cap, plus the starter shed", () => {
    expect(source).toContain("objectLayout.length <= MAX_FUNCTIONAL_OBJECTS + 1");
    // If the cap moves, the bound moves with it — that is the whole point of deriving it.
    expect(MAX_FUNCTIONAL_OBJECTS).toBeGreaterThan(0);
  });

  it("does not re-hardcode the object cap next to the derived bound", () => {
    // The failure mode is a literal creeping back in, not a wrong constant.
    expect(source).not.toMatch(/objectLayout\.length <= \d+/);
  });

  // A shed wearing an earlier tier's look sends that tier's catalog key. The bound
  // is a shape check, not an allow-list — but a shape the real keys fail would refuse
  // the whole blob for anyone who ever touched the appearance picker.
  it("accepts every shed appearance key the client can send", () => {
    const bound = source.match(/typeof row\.skin === "string" && \/(.+?)\/\.test\(row\.skin\)/);
    expect(bound, "objectLayout skin check not found — has the validator moved?").toBeTruthy();
    const pattern = new RegExp(bound![1]);
    const sheds = (placeables as { key: string; storageSlots?: number }[])
      .filter((def) => def.storageSlots);
    expect(sheds.length).toBeGreaterThan(1);
    for (const def of sheds) expect(pattern.test(def.key), def.key).toBe(true);
  });

  it("accepts every zombie name the client is willing to make", () => {
    // The client normalises to MAX_ZOMBIE_NAME_LENGTH code points and strips control
    // characters; the server checks the same two things. A server bound BELOW the
    // client's would let a player type a name that then froze their whole save.
    const bound = source.match(/\[\.\.\.row\.name\]\.length <= (\d+)/);
    expect(bound, "roster name length check not found — has the validator moved?").toBeTruthy();
    expect(Number(bound![1])).toBeGreaterThanOrEqual(MAX_ZOMBIE_NAME_LENGTH);
  });
});

// ---------------------------------------------------------------------------
// The byte ceiling. Same failure mode as the shape bounds above — a blob over it is
// refused wholesale and retried forever — and for a long time it was a literal 128 KB
// sitting next to an object cap that could grow past it.
// ---------------------------------------------------------------------------

const uuid = "0123456789abcdef-0123456789abcdef-0123".slice(0, 36);
const longId = (prefix: string) => `${prefix}-${uuid}`;

/** The widest objectLayout row a real farm can produce: a Memorial Statue, turned and
 *  re-skinned, carrying a full fallen zombie, with the ids the client actually mints. */
const widestObjectRow = (i: number) => ({
  id: longId("reward-store"),
  oc: i % 128, or: (i * 7) % 128, rotation: 1, turn: 7, skin: "storage09",
  memorial: {
    id: longId("reward-sale"), key: "zombieMerZombieElite", name: "x".repeat(24),
    color: [255, 255, 255], mutation: Number.MAX_SAFE_INTEGER,
    invasions: 1e9, diedAt: Number.MAX_SAFE_INTEGER,
  },
});

/** Every OTHER presentation shape at the maximum its own validator admits. */
const everythingElse = () => ({
  rosterLayout: Array.from({ length: 512 }, () => ({ id: longId("reward-sale"), name: "x".repeat(24) })),
  almanac: { discovered: Object.fromEntries(
    Array.from({ length: 512 }, (_, i) => [`zombieSpeciesLongish${i}`, 1234567])) },
  fallen: Array.from({ length: MAX_PRESENTATION_FALLEN }, () => widestObjectRow(0).memorial),
  ui: {
    teams: Array.from({ length: 16 }, (_, i) => ({
      id: `team${i}`, name: "x".repeat(24),
      members: Array.from({ length: 64 }, () => longId("reward-sale")),
    })),
    stats: {
      harvested: Object.fromEntries(Array.from({ length: 512 }, (_, i) => [`cropLongishKey${i}`, 123456789])),
      ...Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`counterNumber${i}`, 123456789])),
    },
  },
  player: {}, farm: {}, zombiePot: {}, zombiePots: [], tutorial: {}, settings: {},
  camera: { x: 1, y: 2, zoom: 1 }, selections: {},
});

describe("the presentation byte ceiling admits every farm the game can build", () => {
  it("fits a farm filled to the object cap with nothing but Memorial Statues", () => {
    // The statue is the heaviest object there is — it carries a whole fallen zombie —
    // and it is the one functional item with no purchase limit, so a farm CAN be
    // nothing else. This is the blob that must not be refused.
    const blob = {
      ...everythingElse(),
      objectLayout: Array.from({ length: MAX_FUNCTIONAL_OBJECTS + 1 }, (_, i) => widestObjectRow(i)),
    };
    expect(JSON.stringify(blob).length).toBeLessThanOrEqual(MAX_PRESENTATION_BYTES);
  });

  it("does not re-hardcode the ceiling at the one place that enforces it", () => {
    expect(source).toContain("encoded.length > MAX_PRESENTATION_BYTES");
    expect(source).not.toMatch(/encoded\.length > \d+/);
  });

  it("keeps the request body limit above the ceiling", () => {
    // A body limit below the blob ceiling moves the refusal to the door: the same
    // permanent silent loss, as a 413 from bodyLimit that never reaches the handler.
    expect(source).toContain("maxSize: MAX_PRESENTATION_BYTES + REQUEST_ENVELOPE_BYTES");
    expect(REQUEST_ENVELOPE_BYTES).toBeGreaterThan(0);
  });
});
