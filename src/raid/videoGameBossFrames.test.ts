import { describe, expect, it } from "vitest";
// The app has no @types/node; Vitest supplies these modules at runtime.
// @ts-ignore
import { readFileSync } from "node:fs";
// @ts-ignore
import { inflateSync } from "node:zlib";
import { usesGroundEnemyFrames } from "./enemyFramePresentation";

interface DecodedPng { width: number; height: number; pixels: Uint8Array }

const decodeRgbaPng = (path: URL): DecodedPng => {
  const png = readFileSync(path);
  const chunks: Uint8Array[] = [];
  let width = 0, height = 0;
  for (let p = 8; p + 8 <= png.length;) {
    const len = png.readUInt32BE(p);
    const type = png.toString("ascii", p + 4, p + 8);
    const body = png.subarray(p + 8, p + 8 + len);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      expect([body[8], body[9], body[12]]).toEqual([8, 6, 0]);
    } else if (type === "IDAT") chunks.push(body);
    p += len + 12;
  }
  const joined = new Uint8Array(chunks.reduce((n, chunk) => n + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) { joined.set(chunk, at); at += chunk.length; }
  const raw = inflateSync(joined) as Uint8Array;
  const pixels = new Uint8Array(width * height * 4);
  const stride = width * 4;
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? pixels[y * stride + x - 4] : 0;
      const b = y ? pixels[(y - 1) * stride + x] : 0;
      const c = x >= 4 && y ? pixels[(y - 1) * stride + x - 4] : 0;
      let add = 0;
      if (filter === 1) add = a;
      else if (filter === 2) add = b;
      else if (filter === 3) add = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      pixels[y * stride + x] = (line[x] + add) & 255;
    }
  }
  return { width, height, pixels };
};

const dir = new URL(
  "../../public/assets/raids/enemies/animations/VideoGameStageBossActor/",
  import.meta.url
);

describe("Zedzox frame presentation", () => {
  it("keeps authored frames on the window and uses cutouts everywhere on the ground", () => {
    expect(usesGroundEnemyFrames("structure")).toBe(false);
    expect(usesGroundEnemyFrames("descending")).toBe(false);
    for (const state of ["emerging", "hold", "fight", "dead"]) {
      expect(usesGroundEnemyFrames(state), state).toBe(true);
    }
  });

  it("ships complete transparent ground strips without deleting the black outline", () => {
    for (const [state, count] of [["idle", 2], ["attack", 4]] as const) {
      for (let frame = 0; frame < count; frame++) {
        const image = decodeRgbaPng(new URL(`ground-${state}-${frame}.png`, dir));
        expect([image.width, image.height]).toEqual([96, 96]);
        let black = 0, opaque = 0;
        for (let p = 0; p < image.pixels.length; p += 4) {
          const [r, g, b, a] = image.pixels.subarray(p, p + 4);
          if (!a) continue;
          opaque++;
          if (r === 0 && g === 0 && b === 0) black++;
        }
        // The old flood-fill left ~700 outline pixels. The reviewed matte retains the
        // full one-pixel silhouette while removing the ~1,100 backdrop pixels.
        expect(black, `${state}-${frame} outline`).toBeGreaterThan(1500);
        expect(black, `${state}-${frame} backdrop`).toBeLessThan(1800);
        expect(opaque, `${state}-${frame} character`).toBeGreaterThan(5500);
        // The robe intentionally reaches the bottom; the unused upper corners must not
        // bring an opaque black box back onto the dirt.
        for (const [x, y] of [[0, 0], [95, 0], [0, 95], [95, 95]]) {
          expect(image.pixels[(y * 96 + x) * 4 + 3], `${state}-${frame} ${x},${y}`).toBe(0);
        }
      }
    }
  });
});
