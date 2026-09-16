import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MAX_FUNCTIONAL_OBJECTS } from "../src/v3/engine";
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
