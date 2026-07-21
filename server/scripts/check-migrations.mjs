import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const serverDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = resolve(serverDir, "migrations");
const files = readdirSync(migrationsDir)
  .filter((name) => name.endsWith(".sql"))
  .sort((a, b) => a.localeCompare(b));
const errors = [];

for (const file of files) {
  if (!/^\d{4}_[A-Za-z0-9_]+\.sql$/.test(file)) {
    errors.push(`invalid migration filename: ${file}`);
  }
}

const byNumber = new Map();
for (const file of files) {
  const number = file.slice(0, 4);
  const group = byNumber.get(number) ?? [];
  group.push(file);
  byNumber.set(number, group);
}

// These names are already recorded by deployed D1 databases and therefore cannot be
// renamed safely. Keep this one historical collision explicit and reject every new one.
const legacy0020 = [
  "0020_permanent_import_closure.sql",
  "0020_protocol_v3_reset.sql",
];
for (const [number, group] of byNumber) {
  if (group.length === 1) continue;
  if (number === "0020" && JSON.stringify(group) === JSON.stringify(legacy0020)) continue;
  errors.push(`duplicate migration number ${number}: ${group.join(", ")}`);
}

const highest = Math.max(...files.map((file) => Number(file.slice(0, 4))));
for (let number = 1; number <= highest; number++) {
  const key = String(number).padStart(4, "0");
  if (!byNumber.has(key)) errors.push(`missing migration number: ${key}`);
}

const baselineSql = readFileSync(resolve(serverDir, "scripts", "baseline-migrations.sql"), "utf8");
const baseline = [...baselineSql.matchAll(/'(\d{4}_[^']+\.sql)'/g)]
  .map((match) => match[1])
  .sort((a, b) => a.localeCompare(b));
const missing = files.filter((file) => !baseline.includes(file));
const stale = baseline.filter((file) => !files.includes(file));
if (missing.length) errors.push(`baseline is missing: ${missing.join(", ")}`);
if (stale.length) errors.push(`baseline references absent files: ${stale.join(", ")}`);

// Integration tests initialize from schema.sql and baseline the migration names, so
// they do not replay destructive historical migrations. Guard the live append-only
// ledger explicitly: if a reset drops it, a later forward migration must restore it.
let ledgerPresent = true;
for (const file of files) {
  const sql = readFileSync(resolve(migrationsDir, file), "utf8");
  const statements = [...sql.matchAll(
    /(CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?|DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?)ledger\b/gi
  )];
  for (const [, operation] of statements) ledgerPresent = !/^DROP/i.test(operation);
}
if (!ledgerPresent) errors.push("migration replay drops the live ledger table without restoring it");

if (errors.length) {
  for (const error of errors) console.error(`[migrations] ${error}`);
  process.exitCode = 1;
} else {
  console.log(`[migrations] ${files.length} files verified; next number is ${String(highest + 1).padStart(4, "0")}`);
}
