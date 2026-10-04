#!/usr/bin/env node
// Generate the server's catalog mirrors from the game's JSON assets.
//
//   npm run catalogs          rewrite the generated regions in place
//   npm run catalogs:check    fail if any region is stale (CI / pre-deploy)
//
// WHY THIS EXISTS
// ---------------
// Several files under server/src are hand-written mirrors of public/assets/*.json:
// they carry only the fields that decide VALUE (price, currency, xp, level, caps) so
// the server can price an action itself instead of trusting the client's number. That
// is the right design, but it means every content change has to be made twice, and the
// second half is easy to forget. When it is forgotten the failure is quiet and one-
// sided: the shop offers a crop or an object the server then refuses as `bad_item`, or
// charges a different price than the one the player was shown.
//
// This script makes the assets the single source and the mirrors a build product.
//
// WHY GENERATE RATHER THAN DERIVE AT RUNTIME
// ------------------------------------------
// questCatalog.ts and zombieCropCatalog.ts derive their tables from the JSON at module
// load, which is simpler and cannot drift at all. That is the better pattern where it
// fits. It does not fit here, because these tables are the *economy*: a wrong number is
// a live exploit, not a cosmetic bug. Generating into source keeps every price change
// visible in a reviewable diff, and keeps the server's numbers greppable when someone
// is reading an audit row six months later.
//
// WHAT IS NOT GENERATED
// ---------------------
// Only the marked `#region generated:NAME` blocks are touched. Every comment, helper,
// interface and constant outside them is hand-written and stays that way. Two mirrors
// are absent from this file because they already derive at runtime:
//   server/src/questCatalog.ts        (quests.json, at module load)
//   server/src/zombieCropCatalog.ts   (zombies.json, at module load)

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const asset = (p) => JSON.parse(readFileSync(resolve(ROOT, "public/assets", p), "utf8"));
const srcPath = (p) => resolve(ROOT, "server/src", p);

// ---------------------------------------------------------------------------
// Authored data: everything the JSON assets do NOT carry.
//
// This is the whole of it. If a value is not here and not in an asset, the server is
// not entitled to have an opinion about it — that is the invariant this file protects.
// ---------------------------------------------------------------------------

/** Simultaneous-ownership caps for functional placeables.
 *
 *  placeables.json has no `purchaseLimit` field, so the rule lives here: every
 *  `category: "functional"` row is capped at ONE unless it is named below. Decorations
 *  are uncapped. `null` means "functional but deliberately uncapped" — spell that out
 *  rather than leaving the key absent, so an item that SHOULD have a cap can never
 *  lose one by omission. A functional item that wants a different number needs an
 *  entry here, not a code change. */
const PURCHASE_LIMITS = {
  zombieCombiner: 3,     // the Zombie Pot: three combines in flight at once
  memorialStatue: null,  // one statue remembers one zombie — as many as you have lost
};

/** Boosts deliberately kept OUT of the server mirror, each with the reason.
 *
 *  An excluded boost is one the Market can display and the server will refuse
 *  (`power.buy` -> `bad_item`). That is sometimes what you want — for an asset row that
 *  is authored but not wired up yet — but it is never what you want by ACCIDENT, which
 *  is why it costs a line here and gets printed on every run.
 *
 *  Empty today: every boost boosts.json ships is implemented and priced. */
const EXCLUDED_BOOSTS = {};

/** Climate skins that are free and always owned, so they are not priced rows. */
const FREE_CLIMATES = new Set(["grass"]);

// ---------------------------------------------------------------------------
// Emitters
// ---------------------------------------------------------------------------

const q = (s) => JSON.stringify(String(s));
/** An object key. "auto" leaves safe identifiers bare; "always" quotes everything.
 *  Per-mirror, so a regenerated table keeps the style the file already had and the
 *  first diff shows only real value changes. */
const key = (k, style = "auto") =>
  style === "always" || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? q(k) : k;
/** `{ a: 1, b: true }` with undefined fields dropped, so optional keys stay optional. */
const fields = (o) =>
  "{ " +
  Object.entries(o)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${typeof v === "string" ? q(v) : v}`)
    .join(", ") +
  " }";
const trailing = (text) => (text ? ` // ${text}` : "");

/** A placeable's ownership cap, or undefined for "no cap emitted". Decorations are
 *  uncapped; functional items default to one; PURCHASE_LIMITS overrides, and an
 *  explicit `null` there means functional-but-uncapped. */
function purchaseLimit(row) {
  if (row.category !== "functional") return undefined;
  const named = PURCHASE_LIMITS[row.key];
  if (named === null) return undefined;
  return named ?? 1;
}

/** Rows -> `  key: { … },` lines. `order` is "source" to keep the asset's own order
 *  (so a diff here reads like the diff there) or "key" for alphabetical. `scalar` emits
 *  `key: value,` for tables whose value is a plain number rather than a record. */
function record(rows, { order = "key", keys = "auto", scalar = false } = {}) {
  const entries = order === "key" ? [...rows].sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0)) : rows;
  return entries.map(
    (r) => `  ${key(r.k, keys)}: ${scalar ? r.v : fields(r.v)},${trailing(r.note)}`
  );
}

// ---------------------------------------------------------------------------
// The mirrors
// ---------------------------------------------------------------------------

const MIRRORS = [
  {
    file: "catalog.ts",
    region: "CROPS",
    from: "plants.json",
    build: () =>
      record(
        asset("plants.json").map((c) => ({
          k: c.key,
          v: { cost: c.cost, sell: c.sell, xp: c.xp, growMs: c.growMs, level: c.level },
        })),
        { order: "source" } // plants.json is ordered by unlock level; keep that reading order
      ),
  },

  {
    file: "objectCatalog.ts",
    region: "OBJECTS",
    from: "placeables.json",
    build: () =>
      record(
        asset("placeables.json").map((r) => ({
          k: r.key,
          v: {
            cost: r.cost,
            brains: !!r.brainsNeeded,
            xp: r.xp,
            // The asset writes "no level requirement" as both 0 and -1; the server's
            // check is `level < def.level`, which a level-1 account passes either way,
            // so 0 is normalised to 1 and only -1 stays as the explicit "none".
            level: r.level === 0 ? 1 : r.level,
            purchaseLimit: purchaseLimit(r),
          },
        })),
        { keys: "always" }
      ),
  },

  {
    file: "objectCatalog.ts",
    region: "SHED_SLOTS",
    from: "placeables.json",
    build: () =>
      record(
        asset("placeables.json")
          .filter((r) => r.key.startsWith("storage") && r.storageSlots > 0)
          .map((r) => ({ k: r.key, v: r.storageSlots })),
        { scalar: true }
      ),
  },

  {
    file: "objectCatalog.ts",
    region: "LIFE_FORCE",
    from: "placeables.json",
    build: () =>
      record(
        asset("placeables.json").map((r) => ({ k: r.key, v: r.lifeForce })),
        { scalar: true }
      ),
  },

  {
    file: "shopCatalog.ts",
    region: "SIZE_TIERS",
    from: "upgrades.json",
    build: () =>
      asset("upgrades.json")
        .mapSize.slice()
        .sort((a, b) => a.size - b.size)
        .map((t) => `  ${fields({ size: t.size, gold: t.gold, brains: t.brains, level: t.level })},`),
  },

  {
    file: "shopCatalog.ts",
    region: "CLIMATE_COST",
    from: "upgrades.json",
    build: () =>
      asset("upgrades.json")
        .climate.filter((c) => !FREE_CLIMATES.has(c.terrain))
        .map((c) => `  ${key(c.terrain)}: ${c.gold},`),
  },

  {
    file: "boostCatalog.ts",
    region: "BOOSTS",
    from: "boosts.json",
    build: () =>
      record(
        asset("boosts.json")
          .filter((b) => !EXCLUDED_BOOSTS[b.key])
          .map((b) => ({
            k: b.key,
            v: {
              cost: b.cost,
              brains: !!b.brainsNeeded,
              perPurchase: b.perPurchase,
              level: b.level,
              gift: b.giftZombieKey || undefined,
            },
          })),
        { order: "source" }
      ),
  },

  {
    file: "boostCatalog.ts",
    region: "BOOST_BY_NAME",
    from: "boosts.json",
    build: () =>
      asset("boosts.json")
        .filter((b) => !EXCLUDED_BOOSTS[b.key])
        .map((b) => `  ${key(b.name)}: ${q(b.key)},`),
  },

  {
    file: "raidCatalog.ts",
    region: "RAIDS",
    from: "raids/raids.json",
    build: () =>
      asset("raids/raids.json").map(
        (r) =>
          `  ${r.id}: ${fields({
            gold: r.goldReward,
            bonus: r.bonusGold,
            xp: r.xp,
            recLevel: r.recommendedLevel,
            unlockLevel: r.unlockLevel,
            playable: !!r.playable,
          })},${trailing(r.name)}`
      ),
  },

  {
    file: "raidLootCatalog.ts",
    region: "RAID_LOOT",
    from: "raids/raids.json",
    build: () =>
      asset("raids/raids.json").map(
        (r) =>
          `  ${r.id}: [${(r.loot ?? [])
            .map((tier) => `[${tier.map(q).join(", ")}]`)
            .join(", ")}],${trailing(r.name)}`
      ),
  },

  {
    file: "raidLootCatalog.ts",
    region: "DROPS",
    from: "raids/drops.json",
    build: () =>
      record(
        Object.entries(asset("raids/drops.json")).map(([name, d]) => ({
          k: name,
          v: {
            brains: !!d.brains,
            gold: !!d.gold,
            unique: !!d.unique,
            limit: d.limit ?? 0,
            extraRate: d.extraRate ?? 0,
            tile: d.tile ?? "",
          },
        })),
        { keys: "always" }
      ),
  },
];

// ---------------------------------------------------------------------------
// Region splice
// ---------------------------------------------------------------------------

const BANNER = "regenerate with `npm run catalogs` (server/scripts/gen-catalogs.mjs) — do not hand-edit";

/** Replace the lines between the region markers. Deliberately line-based rather than
 *  index-based: these files are checked out CRLF on Windows, and slicing around a
 *  regex match that has already eaten the `\r` is how you end up writing `\r\r\n`. */
function splice(text, region, from, lines, nl) {
  const all = text.split(nl);
  const isOpen = (l) => l.trim().startsWith(`// #region generated:${region}`);
  const isClose = (l) => l.trim().startsWith(`// #endregion generated:${region}`);
  const start = all.findIndex(isOpen);
  const end = all.findIndex(isClose);
  if (start === -1 || end === -1) {
    throw new Error(
      `no "// #region generated:${region}" … "// #endregion generated:${region}" markers found.\n` +
        `Wrap the generated block once by hand, then this script owns it.`
    );
  }
  if (end < start) throw new Error(`markers for ${region} are in the wrong order`);
  const header = `  // Source: public/assets/${from} — ${BANNER}`;
  return [...all.slice(0, start + 1), header, ...lines, ...all.slice(end)].join(nl);
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const check = process.argv.includes("--check");
const byFile = new Map();
for (const m of MIRRORS) {
  if (!byFile.has(m.file)) byFile.set(m.file, []);
  byFile.get(m.file).push(m);
}

let stale = 0;
let written = 0;

for (const [file, mirrors] of byFile) {
  const path = srcPath(file);
  const before = readFileSync(path, "utf8");
  const nl = before.includes("\r\n") ? "\r\n" : "\n";
  let after = before;
  for (const m of mirrors) {
    try {
      after = splice(after, m.region, m.from, m.build(), nl);
    } catch (err) {
      console.error(`[catalogs] ${file} / ${m.region}: ${err.message}`);
      process.exit(2);
    }
  }
  const regions = mirrors.map((m) => m.region).join(", ");
  if (after === before) {
    console.log(`[catalogs] ok      ${file}  (${regions})`);
    continue;
  }
  if (check) {
    stale++;
    console.error(`[catalogs] STALE   ${file}  (${regions})`);
    for (const line of firstDifferences(before, after, nl)) console.error(`             ${line}`);
  } else {
    writeFileSync(path, after);
    written++;
    console.log(`[catalogs] written ${file}  (${regions})`);
  }
}

for (const [k, why] of Object.entries(EXCLUDED_BOOSTS)) {
  console.log(`[catalogs] excluded boost "${k}" — ${why}`);
}

if (check && stale) {
  console.error(
    `\n[catalogs] ${stale} file(s) out of date with public/assets. Run \`npm run catalogs\` and commit the result.`
  );
  process.exit(1);
}
console.log(
  check
    ? `[catalogs] ${byFile.size} file(s) in sync with public/assets.`
    : `[catalogs] ${written} file(s) updated, ${byFile.size - written} already current.`
);

/** A short, readable sample of what changed — enough to see WHICH row drifted in CI
 *  output without dumping a 500-line table. */
function firstDifferences(before, after, nl, limit = 8) {
  const a = before.split(nl);
  const b = after.split(nl);
  const out = [];
  const seen = new Set(a);
  const kept = new Set(b);
  for (const line of b) {
    if (!seen.has(line) && line.trim() && out.length < limit) out.push(`+ ${line.trim()}`);
  }
  for (const line of a) {
    if (!kept.has(line) && line.trim() && out.length < limit + 4) out.push(`- ${line.trim()}`);
  }
  if (!out.length) out.push("(whitespace or ordering only)");
  return out;
}
