// Rank one column's armies by how they did across every row of a grid run, and write the
// bottom share to tmp/prod_exclude.json (merged with what is already there), which
// loadProdPools honours on every later run.
//   node tools/prod_grid_exclude.mjs <gridDir> <level> [share=0.25]
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
const [dir, levelArg, shareArg] = process.argv.slice(2);
const level = Number(levelArg), share = Number(shareArg ?? 0.25);
const pool = JSON.parse(readFileSync("tmp/prod_armies.json", "utf8"))[String(level)];
const acct = new Map(pool.map((a) => [a.id, a.acct]));
const tot = new Map();
for (const f of readdirSync(dir).filter((f) => /^shard\d+\.json$/.test(f)))
  for (const r of JSON.parse(readFileSync(`${dir}/${f}`, "utf8"))) {
    const c = r.cells.find((c) => c.level === level);
    for (const [id, [w, n, l]] of Object.entries(c?.armyStats ?? {})) {
      const t = tot.get(id) ?? [0, 0, 0]; t[0] += w; t[1] += n; t[2] += l; tot.set(id, t);
    }
  }
if (!tot.size) { console.error(`no armyStats for L${level} in ${dir}`); process.exit(1); }
const ranked = [...tot].map(([id, [w, n, l]]) => ({ id, acct: acct.get(id), win: w / n, loss: l / n, size: pool.find((a) => a.id === id)?.units.length }))
  .sort((a, b) => a.win - b.win || b.loss - a.loss);
const cut = Math.round(ranked.length * share);
const dropped = ranked.slice(0, cut);
const file = "tmp/prod_exclude.json";
const ex = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
ex[String(level)] = dropped.map((a) => a.id);
writeFileSync(file, JSON.stringify(ex, null, 1));
console.log(`L${level}: dropped ${cut} of ${ranked.length} armies -> ${file}`);
for (const a of ranked) console.log(`${dropped.includes(a) ? "DROP" : "    "} ${a.id} acct ${a.acct} size ${a.size} win ${(a.win * 100).toFixed(0)}% loss/flight ${a.loss.toFixed(1)}`);
