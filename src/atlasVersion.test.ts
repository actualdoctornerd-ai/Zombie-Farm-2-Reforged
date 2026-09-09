// @ts-ignore - node types are test-environment only, as in clipData.test.ts
import { createHash } from "node:crypto";
// @ts-ignore - see above
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { atlasUrl, frameRects, isFrameKey, sheetStamp, SHEET_STAMP_KEY } from "./atlasVersion";
import type { FrameTable } from "./atlasVersion";

// A sheet and its frame table ship under different cache rules (the table is
// NetworkFirst, the PNG CacheFirst for sixty days on a stable filename), so a table can
// move on while an install keeps reading the old pixels. The stamp is what keeps them
// together: the packer writes the sheet's digest into the table, the loader puts it on
// the URL. These tests pin both halves — the loader's reading of the stamp, and that
// the COMMITTED tables really describe the committed sheets.

const zombieFile = (file: string) => new URL(`../public/assets/zombie/${file}`, import.meta.url);

const digestOf = (file: string) =>
  createHash("sha1").update(readFileSync(zombieFile(file))).digest("hex");

const table = (stamp?: unknown): FrameTable => ({
  "defaultHead.png": { x: 0, y: 0, w: 10, h: 10 },
  ...(stamp === undefined ? {} : { [SHEET_STAMP_KEY]: stamp as FrameTable[string] }),
});

describe("atlasUrl", () => {
  it("versions the sheet URL with the table's stamp", () => {
    const frames = table({ file: "S.png", w: 1, h: 1, sha1: "0123456789ab" });
    expect(atlasUrl("./assets/zombie/S.png", frames)).toBe("./assets/zombie/S.png?v=0123456789ab");
  });

  it("loads an unstamped table's sheet at the bare URL, exactly as before", () => {
    expect(atlasUrl("./assets/zombie/S.png", table())).toBe("./assets/zombie/S.png");
  });

  it("ignores a stamp it cannot trust rather than building a broken URL", () => {
    expect(sheetStamp(table({ sha1: "not hex!" }))).toBeNull();
    expect(sheetStamp(table("abc"))).toBeNull();
    expect(sheetStamp(table({ file: "S.png" }))).toBeNull();
    expect(atlasUrl("S.png", table({ sha1: "x" }))).toBe("S.png");
  });

  it("keeps the stamp out of the part rectangles", () => {
    const frames = table({ file: "S.png", w: 1, h: 1, sha1: "0123456789ab" });
    expect(Object.keys(frameRects(frames))).toEqual(["defaultHead.png"]);
    expect(isFrameKey(SHEET_STAMP_KEY)).toBe(false);
    expect(isFrameKey("ZombieActorZombozo:Hat.png")).toBe(true);
  });
});

describe("the committed frame tables are stamped for the committed sheets", () => {
  // If this fails, a sheet was repacked (or hand-replaced) without its table being
  // re-stamped: run the packer that owns it — tools/prep_assets.pack_special_zombies
  // or tools/prep_zombie_models — rather than editing the digest by hand. A stale
  // stamp is the very bug this exists to prevent: the URL would not change, and every
  // existing install would go on reading the new table through its cached old sheet.
  for (const [tableFile, sheetFile] of [
    ["special_frames.json", "SpecialZombieSheet.png"],
    ["frames.json", "ZombieSheet.png"],
  ] as const) {
    it(`${tableFile} carries the digest of ${sheetFile}`, () => {
      const frames = JSON.parse(readFileSync(zombieFile(tableFile), "utf8")) as FrameTable;
      const stamp = sheetStamp(frames);
      expect(stamp, `${tableFile} has no $sheet stamp`).not.toBeNull();
      expect(stamp!.file).toBe(sheetFile);
      expect(digestOf(sheetFile).startsWith(stamp!.sha1)).toBe(true);
      // Every part must still fit on the sheet the stamp describes — a rectangle
      // past the edge is a frame packed onto a sheet that was never saved.
      for (const [key, rect] of Object.entries(frameRects(frames))) {
        expect(rect.x + rect.w, key).toBeLessThanOrEqual(stamp!.w);
        expect(rect.y + rect.h, key).toBeLessThanOrEqual(stamp!.h);
      }
    });
  }
});
