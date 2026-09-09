// Versioning a sprite atlas by its CONTENT, so its cached copy can never be read
// through a newer frame table.
//
// A zombie sheet is two files that only make sense together: the PNG, and the JSON
// that says which rectangle of it each part lives in. The service worker caches them
// under different rules (vite.config.ts): JSON is NetworkFirst, so a player always
// gets the current frame table, but art is CacheFirst on a stable filename for sixty
// days — so a player who has ever loaded SpecialZombieSheet.png keeps THAT copy of it
// while the table under it moves on. Every zombie packed after their copy was taken
// then reads from pixels that are transparent in it (or outside it entirely): the
// Cozmonaut and the Zombozo rendered as a floating default head, and the Boss Zombie,
// whose frames sat on a row the old sheet did not have, did not render at all.
//
// The packer therefore stamps each frame table with a digest of the sheet it was cut
// from (tools/atlas_stamp.py), and the loader appends that digest to the sheet's URL.
// The URL only changes when the sheet's bytes do — a repack that moves nothing costs
// nobody a download — and when it does change, the stale entry is simply never asked
// for again and ages out of the cache on its own.
//
// This is deliberately NOT a build stamp on every art URL. Stamping all ~2,000 art
// files with a deploy id would drop the whole 88 MB art cache on every release; a
// content digest on the two atlases whose tables can move re-fetches one file, once,
// when it actually changed. See src/artCacheRepair.ts for the other failure mode (art
// that shipped broken under a filename that never changes).

/** The reserved key a frame table carries its sheet stamp under. Frame names are
 *  part files (`defaultHead.png`, `ZombieActorZombozo:Hat.png`), never `$`-prefixed. */
export const SHEET_STAMP_KEY = "$sheet";

export interface SheetStamp {
  /** The sheet's file name, for the reader's benefit — the loader keys on `sha1`. */
  file: string;
  w: number;
  h: number;
  /** Leading hex of the PNG's SHA-1. Twelve characters is plenty to tell two
   *  versions of one sheet apart, and keeps the URL short. */
  sha1: string;
}

export interface FrameRect { x: number; y: number; w: number; h: number }

/** A frame table as shipped: part rectangles, plus the optional stamp. */
export type FrameTable = Record<string, FrameRect | SheetStamp>;

/** Whether a frame-table key names a part (and not the stamp). */
export function isFrameKey(key: string): boolean {
  return !key.startsWith("$");
}

export function sheetStamp(frames: FrameTable): SheetStamp | null {
  const stamp = frames[SHEET_STAMP_KEY];
  if (!stamp || typeof stamp !== "object" || !("sha1" in stamp)) return null;
  return typeof stamp.sha1 === "string" && /^[0-9a-f]{8,40}$/.test(stamp.sha1) ? stamp : null;
}

/** The URL to fetch `sheetUrl` at: the stamped digest rides along as a query string,
 *  so a changed sheet is a new cache entry while an unchanged one is still the old
 *  hit. An unstamped table (a sheet nobody has repacked since this shipped) loads the
 *  bare URL exactly as before. */
export function atlasUrl(sheetUrl: string, frames: FrameTable): string {
  const stamp = sheetStamp(frames);
  return stamp ? `${sheetUrl}?v=${stamp.sha1}` : sheetUrl;
}

/** Only the part rectangles of a frame table, in a shape that can be iterated. */
export function frameRects(frames: FrameTable): Record<string, FrameRect> {
  const out: Record<string, FrameRect> = {};
  for (const [key, rect] of Object.entries(frames)) {
    if (isFrameKey(key)) out[key] = rect as FrameRect;
  }
  return out;
}
