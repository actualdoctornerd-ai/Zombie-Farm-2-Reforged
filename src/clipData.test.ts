// The authored clip files, checked against the rigs they animate.
//
// public/assets/**/clips.json is hand-authored data — exported from the Rig Studio,
// sometimes hand-edited afterwards — and unlike the built-in clips nothing regenerates
// it, so a typo lives there until someone notices the animation looks wrong. The first
// file we ever received had a `[0, null]` keyframe in it (NaN, and the part vanishes),
// two tracks swinging about a pivot the resolver could never return, and six tracks
// aimed at limbs their rig does not have.
//
// So: whatever clip files are shipped are validated here, with the runtime's own
// resolver, so the answers are the game's answers rather than a second opinion.
// @ts-ignore - node types are test-environment only, as in rigClips.test.ts
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { pivotsOf, resolveTarget } from "./raid/rigClips.js";
import { variantProblem } from "./raid/clipRuntime";
import type { Clip, ClipModel, RigKind } from "./raid/rigClips.js";

const read = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf-8"));
const has = (p: string) => existsSync(new URL(p, import.meta.url));

const FILES: { kind: RigKind; models: string; clips: string }[] = [
  {
    kind: "enemy",
    models: "../public/assets/raids/enemies/models.json",
    clips: "../public/assets/raids/enemies/clips.json",
  },
  {
    kind: "zombie",
    models: "../public/assets/zombie/models.json",
    clips: "../public/assets/zombie/clips.json",
  },
];

/** Everything wrong with one clip file, as human-readable lines. */
function problemsIn(kind: RigKind, models: Record<string, ClipModel>, clips: Record<string, Record<string, Clip>>) {
  const bad: string[] = [];
  for (const [key, set] of Object.entries(clips)) {
    const model = models[key];
    if (!model) { bad.push(`${key}: clips for a rig that is not in models.json`); continue; }
    const pivots = pivotsOf(model);
    for (const [name, clip] of Object.entries(set)) {
      const at = `${key}/${name}`;
      if (!clip || !Array.isArray(clip.tracks)) { bad.push(`${at}: no tracks`); continue; }
      // The runtime drops a mismatched `~n` alternate silently (with a console warning);
      // here it is a failure, so it never ships.
      const variant = variantProblem(set, name);
      if (variant) bad.push(`${at}: ${variant}`);
      if (!(clip.duration > 0)) bad.push(`${at}: duration is ${clip.duration}`);
      clip.tracks.forEach((t, i) => {
        const w = `${at} track ${i} "${t.name ?? ""}"`;
        for (const k of t.keys ?? []) {
          if (!Array.isArray(k) || k.length !== 2 || !Number.isFinite(k[0]) || !Number.isFinite(k[1])) {
            bad.push(`${w}: key ${JSON.stringify(k)} is not two finite numbers — evaluates to NaN`);
          }
        }
        const times = (t.keys ?? []).map((k) => k[0]);
        for (let j = 1; j < times.length; j++) {
          if (times[j] < times[j - 1]) bad.push(`${w}: keys out of order (${times[j - 1]} then ${times[j]})`);
        }
        if (t.target !== "root" && !resolveTarget(kind, model, t.target).length) {
          bad.push(`${w}: target "${t.target}" matches no part on this rig`);
        }
        if (t.channel === "rot" && t.pivot && !pivots.includes(t.pivot)) {
          bad.push(`${w}: pivot "${t.pivot}" is not on this rig (has: ${pivots.join(", ")})`);
        }
        if (t.wave && !Number.isFinite(t.wave.amp)) bad.push(`${w}: wave.amp is not finite`);
      });
    }
  }
  return bad;
}

describe("authored clip files", () => {
  for (const f of FILES) {
    // Shipping no clips at all is the ordinary case for a rig set nobody has edited.
    const present = has(f.clips);
    it(`${f.kind}: ${present ? "every track resolves against its rig" : "no clip file, nothing to check"}`, () => {
      if (!present) { expect(present).toBe(false); return; }
      const bad = problemsIn(f.kind, read(f.models), read(f.clips));
      expect(bad.slice(0, 10).join("\n")).toBe("");
    });
  }

  it("a pivot name that collides with a built-in is caught", () => {
    // The trap that cost two tracks: pivotPoint answers "shoulder" from the model's own
    // shoulder BEFORE it looks at the named list, so a rig pivot called "shoulder" can
    // never be returned. `pivotsOf` still offers the name once, which is why a clip can
    // reference it and quietly get the other point. Rigs must not author one.
    for (const f of FILES) {
      const models: Record<string, ClipModel> = read(f.models);
      for (const [key, m] of Object.entries(models)) {
        const names = (m.pivots ?? []).map((p) => p.name);
        for (const built of ["neck", "shoulder", "self", "origin", "auto"]) {
          expect(
            names.includes(built) && (built !== "neck" || !!m.neck) && (built !== "shoulder" || !!m.shoulder)
              ? `${key} authors a pivot named "${built}"` : "",
          ).toBe("");
        }
        const dupes = names.filter((n, i) => names.indexOf(n) !== i);
        expect(dupes.length ? `${key} has two pivots named "${dupes[0]}"` : "").toBe("");
      }
    }
  });
});
