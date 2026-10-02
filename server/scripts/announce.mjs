#!/usr/bin/env node
// Post, list and retire in-game announcements (the `announcements` D1 table, migration 0059).
//
//   node scripts/announce.mjs list   [--prod]
//   node scripts/announce.mjs post   --title "..." (--body "..." | --body-file notes.txt)
//                                    [--publish-at 2026-10-03T18:00Z] [--expires 7d | ISO date]
//                                    [--min-ruleset 70] [--prod --yes] [--dry-run]
//   node scripts/announce.mjs retire <id> [--prod --yes]
//
// STAGING IS THE DEFAULT, like every wrangler command in this repo. Production needs --prod,
// and posting or retiring there also needs --yes: an announcement is read by every player.
//
// Players see each announcement once, on their next load of an updated client. Useful flags:
//   --min-ruleset N   only clients whose raid ruleset is at least N see it — post a "what changed"
//                     note BEFORE the update goes out and only players who have updated see it
//   --publish-at T    nothing is served before T (schedule it)
//   --expires X       "7d", "12h", "30m" from now, or an ISO date; default is until retired
//
// Body text is plain: a blank line starts a new paragraph and a line beginning "- " is a bullet.
// Title max 80 characters, body max 2000 (longer is trimmed by the Worker).
//
// Needs `npx wrangler` logged in with D1 access, same as the migrations workflow.
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STAGING_DB = "zombiefarm-staging";
const PROD_DB = "zombiefarm";
const TITLE_MAX = 80;
const BODY_MAX = 2000;

function fail(message) {
  console.error(`announce: ${message}`);
  process.exit(1);
}

/** `--flag value` and bare `--flag` arguments, plus the positionals. */
export function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) flags[name] = true;
    else {
      flags[name] = next;
      i++;
    }
  }
  return { flags, positional };
}

/** A time flag as ms since the epoch: "now", "7d" / "12h" / "30m" from `now`, or an ISO date. */
export function parseWhen(text, now = Date.now()) {
  if (text === "now") return now;
  const rel = /^(\d+)([dhm])$/.exec(text);
  if (rel) {
    const unit = { d: 86_400_000, h: 3_600_000, m: 60_000 }[rel[2]];
    return now + Number(rel[1]) * unit;
  }
  const at = Date.parse(text);
  if (Number.isNaN(at)) throw new Error(`can't read "${text}" as a time (try 7d, 12h, or 2026-10-03T18:00Z)`);
  return at;
}

/** wrangler prints warnings (and colour codes) before its --json output, so parse from the first
 *  line that opens a JSON document rather than the whole stream. Returns the raw text if none does. */
export function parseWranglerJson(out) {
  const clean = String(out).replace(/\u001b\[[0-9;]*m/g, "");
  const lines = clean.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*[\[{]/.test(lines[i])) {
      try {
        return JSON.parse(lines.slice(i).join("\n"));
      } catch {
        // keep looking: a warning line can also start with a bracket
      }
    }
  }
  return clean;
}

const sqlText = (value) => `'${String(value).replaceAll("'", "''")}'`;

/** The INSERT for a validated announcement. Throws on anything the Worker would drop. */
export function buildInsert({ title, body, publishAt, expiresAt, minRuleset, now = Date.now() }) {
  const t = String(title ?? "").trim();
  const b = String(body ?? "").trim();
  if (!t) throw new Error("a title is required (--title)");
  if (!b) throw new Error("a body is required (--body or --body-file)");
  if (t.length > TITLE_MAX) throw new Error(`title is ${t.length} characters; the limit is ${TITLE_MAX}`);
  if (b.length > BODY_MAX) throw new Error(`body is ${b.length} characters; the limit is ${BODY_MAX}`);
  const published = publishAt ?? now;
  if (expiresAt !== undefined && expiresAt !== null && expiresAt <= published) {
    throw new Error("--expires must be after the publish time");
  }
  if (minRuleset !== undefined && minRuleset !== null && !Number.isInteger(minRuleset)) {
    throw new Error("--min-ruleset must be a whole number");
  }
  return (
    "INSERT INTO announcements (title, body, published_at, expires_at, min_ruleset, active, created_at) VALUES (" +
    [sqlText(t), sqlText(b), published, expiresAt ?? "NULL", minRuleset ?? "NULL", 1, now].join(", ") + ");"
  );
}

/** Run SQL against D1. Writes go through --file (a body can span lines and hold quotes) but
 *  --file only reports a summary, so a SELECT must use --command to get its rows back. */
function runSql(sql, { prod, rows = false }) {
  const dir = mkdtempSync(join(tmpdir(), "announce-"));
  try {
    let source;
    if (rows) {
      source = `--command "${sql.replaceAll('"', '\\"')}"`;
    } else {
      const file = join(dir, "q.sql");
      writeFileSync(file, sql, "utf8");
      source = `--file "${file}"`;
    }
    const env = prod ? " --env production" : "";
    const cmd = `npx wrangler d1 execute ${prod ? PROD_DB : STAGING_DB} --remote ${source} --json${env}`;
    return parseWranglerJson(execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function fmt(ms) {
  return ms ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") + "Z" : "-";
}

function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const [command, arg] = positional;
  const prod = flags.prod === true;
  const target = prod ? "PRODUCTION" : "staging";

  if (command === "list") {
    const result = runSql(
      "SELECT id, title, published_at, expires_at, min_ruleset, active FROM announcements ORDER BY id DESC LIMIT 20;",
      { prod, rows: true }
    );
    const rows = result?.[0]?.results ?? [];
    console.log(`Announcements on ${target} (newest first):`);
    if (!rows.length) console.log("  (none)");
    for (const r of rows) {
      const state = r.active ? "live" : "retired";
      console.log(
        `  #${r.id} [${state}] ${r.title}  | published ${fmt(r.published_at)} | expires ${fmt(r.expires_at)}` +
        (r.min_ruleset ? ` | needs ruleset ${r.min_ruleset}+` : "")
      );
    }
    return;
  }

  if (command === "post") {
    let body = flags.body;
    if (flags["body-file"]) body = readFileSync(String(flags["body-file"]), "utf8");
    let sql;
    try {
      sql = buildInsert({
        title: flags.title === true ? "" : flags.title,
        body: body === true ? "" : body,
        publishAt: flags["publish-at"] ? parseWhen(String(flags["publish-at"])) : undefined,
        expiresAt: flags.expires ? parseWhen(String(flags.expires)) : undefined,
        minRuleset: flags["min-ruleset"] ? Number(flags["min-ruleset"]) : undefined,
      });
    } catch (error) {
      fail(error.message);
    }
    console.log(`Announcement for ${target}:\n  ${flags.title}\n`);
    console.log(String(body).trim().split("\n").map((l) => `  | ${l}`).join("\n"));
    if (flags["dry-run"]) {
      console.log("\n(dry run: nothing written)");
      return;
    }
    if (prod && flags.yes !== true) fail("posting to production needs --yes (every player will read this)");
    runSql(sql, { prod });
    console.log(`\nPosted to ${target}. Players see it on their next load (the Worker caches for up to a minute).`);
    return;
  }

  if (command === "retire") {
    const id = Number(arg);
    if (!Number.isInteger(id) || id < 1) fail("usage: announce.mjs retire <id> [--prod --yes]");
    if (prod && flags.yes !== true) fail("retiring on production needs --yes");
    runSql(`UPDATE announcements SET active = 0 WHERE id = ${id};`, { prod });
    console.log(`Retired #${id} on ${target}.`);
    return;
  }

  fail("usage: announce.mjs list | post --title ... --body ... | retire <id>   (add --prod [--yes] for production)");
}

// Run only when invoked directly, so the helpers above can be imported by tests.
if (import.meta.url === new URL(process.argv[1], "file://").href || process.argv[1]?.endsWith("announce.mjs")) {
  main();
}
