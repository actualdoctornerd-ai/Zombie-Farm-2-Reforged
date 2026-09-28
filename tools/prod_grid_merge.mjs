// Merge a partial prod-grid run (PRODGRID_MIN_ROW) over a full one: every row in the partial
// dir replaces its twin (raid, elite, tier, pilot) in the full dir's shards, in place.
//   node tools/prod_grid_merge.mjs tmp/prodgrid_40 tmp/prodgrid
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
const [part, full] = process.argv.slice(2);
const key = (r) => `${r.raidId}|${r.elite}|${r.tier}|${r.pilot}`;
const fresh = new Map();
for (const f of readdirSync(part).filter((f) => /^shard\d+\.json$/.test(f)))
  for (const r of JSON.parse(readFileSync(`${part}/${f}`, "utf8"))) fresh.set(key(r), r);
let n = 0;
for (const f of readdirSync(full).filter((f) => /^shard\d+\.json$/.test(f))) {
  const rows = JSON.parse(readFileSync(`${full}/${f}`, "utf8")).map((r) => {
    const k = key(r); if (fresh.has(k)) { n++; const x = fresh.get(k); fresh.delete(k); return x; } return r;
  });
  writeFileSync(`${full}/${f}`, JSON.stringify(rows, null, 1));
}
console.log(`replaced ${n} rows; ${fresh.size} unmatched`);
