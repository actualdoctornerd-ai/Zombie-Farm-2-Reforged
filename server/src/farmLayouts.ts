// Saved farm layouts (the client's Storage → Farm Layouts): where each decoration
// stood, so a farm can swap between looks on any device.
//
// Kept in a table of their own rather than the presentation blob. That blob is
// all-or-nothing — one refused field and every name, team and camera position stops
// saving — and six full layouts of a decorated farm would eat most of its headroom.
// Here a bad or oversized layout write fails alone.
//
// Pure presentation: nothing on the server reads a layout back. Loading one is done
// by the client with ordinary `object.status` store/place commands, which the engine
// checks against the objects the account really owns, so a layout can neither create
// nor destroy anything.
import type { D1Database } from "@cloudflare/workers-types";
import { MAX_FUNCTIONAL_OBJECTS } from "./v3/engine";

export const MAX_FARM_LAYOUTS = 6;
/** One more than the object cap, for the free starter shed (see presentation). */
export const MAX_LAYOUT_ITEMS = MAX_FUNCTIONAL_OBJECTS + 1;

const ID = /^[A-Za-z0-9_-]{1,80}$/;
const KEY = /^[A-Za-z0-9_-]{1,40}$/;

const isCoord = (n: unknown) => Number.isSafeInteger(n) && Number(n) >= 0 && Number(n) < 128;

function validItem(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as { key?: unknown; oc?: unknown; or?: unknown; turn?: unknown; id?: unknown };
  return typeof row.key === "string" && KEY.test(row.key) && isCoord(row.oc) && isCoord(row.or) &&
    Number.isSafeInteger(row.turn) && Number(row.turn) >= 0 && Number(row.turn) < 8 &&
    (row.id === undefined || (typeof row.id === "string" && ID.test(row.id)));
}

export function validFarmLayouts(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > MAX_FARM_LAYOUTS) return false;
  const ids = new Set<string>();
  return value.every((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const row = entry as { id?: unknown; name?: unknown; savedAt?: unknown; items?: unknown };
    if (typeof row.id !== "string" || !ID.test(row.id) || ids.has(row.id)) return false;
    ids.add(row.id);
    return typeof row.name === "string" && [...row.name].length >= 1 && [...row.name].length <= 24 &&
      !/[\u0000-\u001f\u007f]/.test(row.name) &&
      Number.isSafeInteger(row.savedAt) && Number(row.savedAt) >= 0 &&
      Array.isArray(row.items) && row.items.length <= MAX_LAYOUT_ITEMS && row.items.every(validItem);
  });
}

/** Only the fields validFarmLayouts allows, so nothing else is ever stored. */
function canonical(layouts: unknown[]): unknown[] {
  return layouts.map((entry) => {
    const l = entry as { id: string; name: string; savedAt: number; items: Record<string, unknown>[] };
    return {
      id: l.id, name: l.name, savedAt: l.savedAt,
      items: l.items.map((i) => ({
        key: i.key, oc: i.oc, or: i.or, turn: i.turn, ...(i.id === undefined ? {} : { id: i.id }),
      })),
    };
  });
}

export async function readFarmLayouts(db: D1Database, accountId: string): Promise<unknown[]> {
  const row = await db.prepare("SELECT layouts_json FROM farm_layouts WHERE account_id = ?")
    .bind(accountId).first<{ layouts_json: string }>();
  if (!row) return [];
  try {
    const parsed: unknown = JSON.parse(row.layouts_json);
    return validFarmLayouts(parsed) ? parsed as unknown[] : [];
  } catch {
    return [];
  }
}

/** Replace the account's whole list. False when `layouts` is not a valid list. */
export async function writeFarmLayouts(
  db: D1Database, accountId: string, layouts: unknown, now: number,
): Promise<boolean> {
  if (!validFarmLayouts(layouts)) return false;
  const list = layouts as unknown[];
  if (!list.length) {
    await db.prepare("DELETE FROM farm_layouts WHERE account_id = ?").bind(accountId).run();
    return true;
  }
  await db.prepare(`INSERT INTO farm_layouts (account_id, layouts_json, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(account_id) DO UPDATE SET layouts_json = excluded.layouts_json, updated_at = excluded.updated_at`)
    .bind(accountId, JSON.stringify(canonical(list)), now).run();
  return true;
}
