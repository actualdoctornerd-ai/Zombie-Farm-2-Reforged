// The guard that makes `buildFight` worth having.
//
// A keyword adapter over a positional constructor is only safe while it stays COMPLETE
// and stays the ONLY adapter. Both of those are properties of the source, not of any one
// fight, so two of the three tests here read the source: the third mechanic added to
// `BattleSim` and forgotten here would otherwise behave exactly like the seven arguments
// the balance harness used to drop — silently, and only on the newest content.
//
// The behavioural test covers what TypeScript cannot: `buildFight` passes its arguments
// positionally, so a slip between two neighbours of the SAME type compiles clean. Three
// adjacent booleans and three `CombatUnit | null` slots are the places that can happen,
// so those are the places that get fought.
import { describe, expect, it } from "vitest";
import { buildFight } from "./buildFight";
import type { CombatUnit } from "./types";

// Read through Vite rather than `node:fs`: the client package carries no @types/node,
// and this keeps the test runnable in the same environment as the code it guards.
const SOURCES = import.meta.glob(["./*.ts", "../../server/src/**/*.ts"], {
  query: "?raw", import: "default", eager: true,
}) as Record<string, string>;
const read = (rel: string): string => {
  const hit = Object.entries(SOURCES).find(([path]) => path.endsWith(rel.replace(/^\.\.\/\.\.\//, "")));
  expect(hit, `source not found: ${rel}`).toBeTruthy();
  return hit![1];
};

/** Parameter names of `BattleSim`'s constructor, in order, read off the source. */
function constructorParams(): string[] {
  const src = read("BattleSim.ts");
  const open = src.indexOf("\n  constructor(");
  expect(open, "BattleSim.constructor not found").toBeGreaterThan(0);
  const start = src.indexOf("(", open) + 1;
  // Walk to the matching close paren so nested generics/objects in defaults can't end it.
  let depth = 1;
  let end = start;
  while (depth > 0) {
    const c = src[end++];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
  }
  const body = src
    .slice(start, end - 1)
    .replace(/\/\*[\s\S]*?\*\//g, "") // doc comments between parameters
    .replace(/\/\/[^\n]*/g, "");
  // Split on commas that are not inside a default value's brackets.
  const parts: string[] = [];
  let buf = "";
  depth = 0;
  for (const c of body) {
    if (c === "(" || c === "[" || c === "{" || c === "<") depth++;
    else if (c === ")" || c === "]" || c === "}" || c === ">") depth--;
    if (c === "," && depth === 0) { parts.push(buf); buf = ""; continue; }
    buf += c;
  }
  parts.push(buf);
  return parts
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => p.replace(/^(private|public|protected|readonly)\s+/g, "").match(/^[A-Za-z_$][\w$]*/)?.[0] ?? "");
}

/** The expressions `buildFight` passes, in order. */
function buildFightArgs(): string[] {
  const src = read("buildFight.ts");
  const start = src.indexOf("return new BattleSim(") + "return new BattleSim(".length;
  expect(start).toBeGreaterThan("return new BattleSim(".length - 1);
  const end = src.indexOf("\n  );", start);
  const body = src.slice(start, end);
  const parts: string[] = [];
  let buf = "";
  let depth = 0;
  for (const c of body) {
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    if (c === "," && depth === 0) { parts.push(buf); buf = ""; continue; }
    buf += c;
  }
  parts.push(buf);
  return parts.map((p) => p.trim()).filter(Boolean);
}

function unit(id: string, team: "player" | "enemy", over: Partial<CombatUnit> = {}): CombatUnit {
  return {
    id, sourceKey: id, team, name: id,
    str: 10, dex: 2, con: 60, focus: 100,
    hp: 6000, maxHp: 6000, attackCooldownMs: 1000,
    attacks: [{ name: "", frequency: 1, mult: 1 }],
    isBoss: false, alive: true, isGarden: false, isHeadless: false, abilities: [],
    ...over,
  };
}

describe("buildFight is the only way a fight is assembled", () => {
  it("passes every constructor parameter, in order, under its own name", () => {
    // THE drift guard. A new mechanic appended to BattleSim's constructor and forgotten
    // in FightSpec defaults to off for every caller — which is exactly how the balance
    // harness ended up measuring the four dual invasions with sign, dexTax, copies, the
    // ringmaster's drop and the saucer's bubble all silently absent.
    const params = constructorParams();
    const args = buildFightArgs();
    expect(params.length, "BattleSim gained or lost a constructor parameter").toBe(args.length);
    // Each argument must MENTION the field it is standing in for. The names are not
    // identical on both sides (BattleSim says `summonCfg`, `wallTemplate`, `cadence`;
    // FightSpec says `summon`, `wallTemplate`, `waveCadence`), so the check is that the
    // two are recognisably about the same thing rather than string-equal.
    const alias: Record<string, string> = {
      summonCfg: "summon", cadence: "waveCadence", signCfg: "sign",
      copyCfg: "copies", bubbleCfg: "bubble", crab: "crab", grabber: "grabber",
    };
    params.forEach((param, i) => {
      const want = (alias[param] ?? param).toLowerCase();
      expect(args[i].toLowerCase(), `argument ${i} should carry \`${param}\``).toContain(want);
    });
  });

  it("is the one place production code constructs a BattleSim", () => {
    // Tests build sims directly all over the place and should keep doing so — a unit
    // test of knockback wants two units and nothing else. What must not come back is a
    // second SHIPPING transcription of the argument list.
    const offenders = [
      ["RaidScene.ts", read("RaidScene.ts")],
      ["../../server/src/raidVerifier.ts", read("../../server/src/raidVerifier.ts")],
      ["../../server/src/v3/epicBoss.ts", read("../../server/src/v3/epicBoss.ts")],
    ].filter(([, src]) => src.includes("new BattleSim("));
    expect(offenders.map(([name]) => name)).toEqual([]);
  });

  it("puts each same-typed neighbour in its own slot", () => {
    // Six fields TypeScript cannot tell apart from the field beside them: three adjacent
    // booleans, and three `CombatUnit | null` templates that mean three different things.
    const boss = unit("boss", "enemy", { isBoss: true });
    const player = unit("p0", "player");

    // noDistractions — the butterfly is gone but the brain bubble still gates release.
    // Focus 0: `rollDistract` is a focus check, so a 100-focus zombie is never
    // distracted and both fights would look identical whatever slot the flag landed in.
    const distractable = () => unit("p0", "player", { focus: 0 });
    const plain = buildFight({ playerUnits: [distractable()], enemyUnits: [unit("e0", "enemy")] });
    const quiet = buildFight({
      playerUnits: [distractable()], enemyUnits: [unit("e0", "enemy")], noDistractions: true,
    });
    const bubblesIn = (sim: ReturnType<typeof buildFight>, kind: "butterfly" | "brain") => {
      let seen = 0;
      for (let t = 0; t < 400 && !sim.finished; t++) {
        if (sim.chargingBubble()?.kind === kind) seen++;
        sim.step(50);
      }
      return seen;
    };
    expect(bubblesIn(plain, "butterfly"), "the default fight distracts").toBeGreaterThan(0);
    expect(bubblesIn(quiet, "butterfly"), "noDistractions landed in another slot").toBe(0);

    // escapeOnRoundEnd — the round running out ENDS the attempt instead of enraging.
    const escapes = buildFight({
      playerUnits: [player], enemyUnits: [boss],
      concentration: true, roundMs: 1_000, escapeOnRoundEnd: true,
    });
    for (let t = 0; t < 60 && !escapes.finished; t++) escapes.step(50);
    expect(escapes.finished, "escapeOnRoundEnd landed in another slot").toBe(true);

    // bossFallsFromSky — the boss lands on the combat line instead of holding the perch,
    // which moves the front of the army with it.
    const perched = buildFight({ playerUnits: [unit("p0", "player")], enemyUnits: [unit("b", "enemy", { isBoss: true })], concentration: true });
    const dropped = buildFight({ playerUnits: [unit("p0", "player")], enemyUnits: [unit("b", "enemy", { isBoss: true })], concentration: true, bossFallsFromSky: true });
    const bossX = (sim: ReturnType<typeof buildFight>) => {
      for (let t = 0; t < 40; t++) sim.step(50);
      return sim.snapshot().units.find((u) => u.isBoss)!.x;
    };
    expect(bossX(dropped), "bossFallsFromSky landed in another slot").not.toBe(bossX(perched));

    // The three CombatUnit templates. Only `wallTemplate` belongs to a BOSS ACTION, so
    // a turnedTemplate or a bubbleWall wired into that slot by mistake would put the
    // wrong body on the field — and the two that must not appear are set here so the
    // swap is visible rather than merely absent.
    const walled = buildFight({
      playerUnits: [unit("p0", "player")],
      enemyUnits: [
        // A minion keeps the boss on its perch; only a perched boss walls (ruleset 13).
        unit("minion", "enemy", { sourceKey: "NinjaStageActorBoy", con: 3000, hp: 9000, maxHp: 9000 }),
        unit("boss", "enemy", { sourceKey: "NinjaStageActorBoss", isBoss: true, con: 3000, hp: 9000, maxHp: 9000 }),
      ],
      concentration: true,
      bossSpecials: [{ name: "wall", weight: 100, castMs: 0, cooldownMs: 999_999, damage: 0 }],
      wallTemplate: unit("wall", "enemy", {
        sourceKey: "carrotWall", str: 0, con: 150, hp: 1500, maxHp: 1500,
        attacks: [{ name: "", frequency: 1, mult: 0 }],
      }),
      turnedTemplate: unit("pixel", "enemy", { sourceKey: "pixelZombie" }),
      bubbleWall: unit("junk", "enemy", { sourceKey: "junkWall" }),
    });
    for (let t = 0; t < 400 && !walled.units.some((u) => u.isWall && u.alive); t++) walled.step(50);
    const spawnedKeys = walled.units.map((u) => u.sourceKey);
    expect(spawnedKeys, "wallTemplate landed in another slot").toContain("carrotWall");
    expect(spawnedKeys).not.toContain("pixelZombie");
    expect(spawnedKeys).not.toContain("junkWall");
  });
});
