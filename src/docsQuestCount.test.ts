// The docs quote the size of the quest catalog, and prose does not get typechecked.
//
// This is the guard for a failure that has already happened: a seventeenth Reforged
// achievement (`20017 Game Over, Zedzox`) was authored, and README.md, docs/FEATURES.md
// and QuestSystem.ts's header comment all went on saying "122 records ... plus 16
// Reforged-original achievements". The number is not decoration — it is the one place a
// reader can check whether the catalog they are looking at is the whole catalog.
//
// Same arrangement as docsVersionSync.test.ts, and for the same reason: the conventions
// in this repo that were only written down are the ones that drifted. The coverage test
// at the bottom is what stops a rewording from turning this into a silent no-op.
import { describe, expect, it } from "vitest";
// The app has no @types/node (it only ever runs in a browser); the node test environment
// provides this at runtime. Same treatment as docsVersionSync.test.ts.
// @ts-ignore
import { readFileSync } from "node:fs";
import imported from "../public/assets/quests.json";
import reforged from "../public/assets/quests_reforged.json";

const IMPORTED = Object.keys(imported).length;
const REFORGED = Object.keys(reforged).length;
const TOTAL = IMPORTED + REFORGED;

const read = (rel: string): string =>
  readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

/** Every file allowed to quote a catalog size. A file NOT listed is one nobody checks. */
const SOURCES = ["README.md", "docs/FEATURES.md", "src/quest/QuestSystem.ts"] as const;

interface CountCheck {
  label: string;
  value: number;
  /** Must capture the quoted number in group 1, and must only match a claim about the
   *  CURRENT size. Patterns run against the whole file, so `\s+` spans line wraps —
   *  README.md's sentence breaks between "plus 16" and "Reforged-original". */
  patterns: RegExp[];
}

const CHECKS: CountCheck[] = [
  {
    label: "total quest records",
    value: TOTAL,
    patterns: [
      /(\d+)\s+records:/g,
      /loading\s+(\d+)\s+quest records/g,
      /All\s+(\d+)\s+shipped quest records/g,
    ],
  },
  {
    label: "recovered Quests.plist records",
    value: IMPORTED,
    patterns: [/(\d+)\s+recovered from (?:the original )?Quests\.plist/g],
  },
  {
    label: "Reforged-original achievements",
    value: REFORGED,
    patterns: [/plus\s+(\d+)\s+Reforged-original/g],
  },
];

function findQuoted(check: CountCheck): { where: string; found: number }[] {
  const hits: { where: string; found: number }[] = [];
  for (const source of SOURCES) {
    const text = read(source);
    for (const pattern of check.patterns) {
      for (const match of text.matchAll(pattern)) {
        const line = text.slice(0, match.index).split("\n").length;
        hits.push({ where: `${source}:${line}`, found: Number(match[1]) });
      }
    }
  }
  return hits;
}

describe("docs quote the current quest-catalog size", () => {
  it.each(CHECKS)("$label", (check) => {
    const stale = findQuoted(check)
      .filter((hit) => hit.found !== check.value)
      .map((hit) => `${hit.where} says ${hit.found}, the catalog has ${check.value}`);
    expect(stale).toEqual([]);
  });

  it("actually finds each count quoted somewhere", () => {
    // Without this, rewording a sentence past the patterns above turns the checks into
    // no-ops that still report green. If this trips, either restore the phrasing or widen
    // that check's patterns; do not delete the doc's claim to make it pass.
    const uncovered = CHECKS.filter((check) => findQuoted(check).length === 0).map((c) => c.label);
    expect(uncovered).toEqual([]);
  });
});
