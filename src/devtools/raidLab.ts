// Raid Lab — a dev-only stage for every raid animation.
// =====================================================
// Served at /raid-lab.html by the dev server; not part of the production build.
//
// The problem this solves: an invasion animation is easy to author and hard to WATCH.
// A boss special fires on a weighted roll behind a cast timer, a Garden heal needs
// somebody hurt, a revive needs somebody dead, and the Circus trapeze sweeps in once
// every few seconds into a fight you have to win first. Reviewing one meant playing
// until it happened.
//
// So this page reuses the game's own code — loadAssets(), RaidScene, BattleSim, and the
// fight-config builders RaidManager itself calls (raid/fightConfig.ts) — and adds only
// a way to ASK:
//
//   • ACTIVATED moves go through the sim's own `activate()`, live, on the running fight.
//   • BOSS actions are SOLOED: the fight is rebuilt carrying that action alone on a
//     short recovery, so it plays on a loop. The action itself keeps its authored cast
//     and its elite scaling — only the mix and the recovery are the lab's.
//   • HEALS, REVIVES and DEATHS are staged by WOUNDING units (`hp = …`) and letting the
//     simulation reach those states through its ordinary paths. Nothing here poses a
//     unit or writes a state directly, which is why what you watch is the real thing.
//
// If an animation looks wrong here, it looks wrong in an invasion.
import "pixi.js/unsafe-eval";
import { Application, type Ticker } from "pixi.js";
import { loadAssets, type GameAssets, type ZombieDef } from "../assets";
import { EPIC_BOSSES, epicBossHp } from "../epicBoss/catalog";
import { buildEpicBossSetup } from "../epicBoss/combat";
import { epicAsset } from "../epicBoss/lootImage";
import type { EpicBossDef, EpicBossRun } from "../epicBoss/types";
import { waveCadenceFor } from "../raid/alienStage";
import { buildEnemyUnits, buildPlayerUnits } from "../raid/CombatEngine";
import { eliteBossSpecials, eliteBossThrow, eliteProfile } from "../raid/eliteInvasion";
import {
  bossSpecialsFor, bossThrowFor, crabFor, grabberFor, summonFor, turnedTemplateFor,
  wallTemplateFor,
} from "../raid/fightConfig";
import { fightStage, resolveStageWave, seededRandom } from "../raid/RaidCatalog";
import { RaidScene, type RaidSceneParams } from "../raid/RaidScene";
import { RAID_TICK_MS } from "../raid/replay";
import type {
  BossSpecial, BossThrowConfig, BossThrowOption, CombatUnit, RaidDef, RaidStage,
} from "../raid/types";
import { ABILITY_KIND } from "../zombie/abilities";
import { abilityTierOf, ABILITY_POOL, ABILITY_TIER } from "../zombie/traits";
import { makeOwned } from "../zombie/types";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** What the lab is rebuilding the fight to show. "" = the shipped mix.
 *  `throw:<index>` / `special:<name>` / `hazard:grabber` / `hazard:crab`. */
type Solo = string;

interface ArmyRow { key: string; count: number }

const state = {
  /** "raid:<id>" or "epic:<bossId>". */
  fight: "raid:1",
  level: 25,
  /** Which authored wave the stage's random roster resolves to (a seed, not an index). */
  wave: 0,
  elite: false,
  concentration: true,
  epicLevel: 5,
  /** Highest ability tier UNLOCKED, exactly as the game gates it — a zombie shows the
   *  ability for each tier up to its own colour-class rank, but only once that tier's
   *  invasion boss has been beaten.
   *
   *  Default 2, and the reason is the laser. The army below picks the strongest species
   *  in each group, and the strongest Regular is a rank-4 one whose OWN tier-3 and tier-4
   *  abilities are Laser Beam and Laser Beam Ver.2. Unlock everything and five zombies
   *  walk in firing continuously, which is a perfectly real army and completely useless
   *  for watching anything else. Two is a quiet baseline you add to. */
  tierCap: 2,
  army: [] as ArmyRow[],
  /** Abilities granted to EVERY zombie on top of what its class already gives.
   *
   *  The default is what the ACTION buttons need and nothing else: the five activated
   *  moves, and the three support abilities the sim gates on `isGarden` so only the one
   *  Garden zombie ever casts them. Deliberately NOT the lasers — `laserBeam`/`zomBeam`
   *  are automatic and ungated, so granting one to the whole army turns every fight into
   *  eight laser turrets and you cannot see the animation you came to watch. Tick them
   *  on when the laser IS what you came to watch (and cut the army down to one). */
  granted: new Set<string>(["bash", "bashV2", "explode", "explodeV2", "attachMini",
    "heal", "healAOE", "ressurect"]),
  solo: "" as Solo,
  paused: false,
  speed: 1,
};

let assets: GameAssets;
let app: Application;
let scene: RaidScene | null = null;
/** Bumped on every restart; a build that finishes after a newer one started is dropped. */
let buildToken = 0;
let outcomeLine = "";
let note = "";

const stageEl = document.getElementById("stage") as HTMLDivElement;
const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
void (async function main() {
  app = new Application();
  await app.init({
    background: "#14171c",
    resizeTo: stageEl,
    antialias: false,
    resolution: Math.min(window.devicePixelRatio || 1, 2),
    autoDensity: true,
  });
  app.ticker.maxFPS = 60;
  stageEl.appendChild(app.canvas);

  assets = await loadAssets();
  document.getElementById("boot")?.remove();

  state.army = defaultArmy();
  buildRaidList();
  buildAbilityList();
  buildArmyRows();
  wireControls();
  await restart();

  app.ticker.add(tick);

  // The console is part of the tool. `ZFLAB.scene.sim` is the live fight, so anything
  // the buttons do can be done by hand — and anything they DON'T cover can be reached
  // without adding a button for it first.
  (window as unknown as { ZFLAB: unknown }).ZFLAB = {
    app, assets, state,
    get scene() { return scene; },
    restart,
    /** Drive N frames by hand. The Pixi ticker only runs while the page is compositing,
     *  so a headless check (or a backgrounded tab) needs this — see the note in
     *  docs/ or `headless visual verification`. */
    frames(n = 60, ms = 16.7) {
      for (let i = 0; i < n; i++) scene?.update((ms / 1000) * state.speed);
      refreshStatus(true);
      return scene?.sim.units.filter((u) => u.alive).length ?? 0;
    },
  };
})();

// ---------------------------------------------------------------------------
// The fight
// ---------------------------------------------------------------------------

const epicDefOf = (): EpicBossDef | null =>
  state.fight.startsWith("epic:")
    ? EPIC_BOSSES.find((b) => b.id === state.fight.slice(5)) ?? null
    : null;

const raidOf = (): RaidDef | null =>
  state.fight.startsWith("raid:")
    ? assets.raids.find((r) => r.id === Number(state.fight.slice(5))) ?? null
    : null;

/** The stage this raid fights at the chosen level, with its wave roll resolved. Random
 *  rosters (the Robots' boss, the Ninjas' mix) are seeded off `state.wave` so a given
 *  slider position always brings the same line-up back. */
function currentStage(raid: RaidDef): RaidStage | null {
  const base = fightStage(raid, state.level);
  if (!base) return null;
  return resolveStageWave(base, seededRandom(`lab:${raid.id}:${state.wave}`));
}

/** The party, as owned zombies. */
function party() {
  const defs = new Map(assets.zombies.map((z) => [z.key, z]));
  const out = [];
  let n = 0;
  for (const row of state.army) {
    const def = defs.get(row.key);
    if (!def) continue;
    for (let i = 0; i < row.count; i++) out.push(makeOwned(`lab${n++}`, def, 0, 0, 5));
  }
  return out;
}

/** The game's unlock gate, driven by the Tiers slider rather than by raid wins. */
const unlocked = (key: string) => abilityTierOf(key) <= state.tierCap;

function playerUnits(): CombatUnit[] {
  const units = buildPlayerUnits(party(), {
    concentration: state.concentration,
    abilityUnlocked: unlocked,
    playerLevel: state.level,
  });
  // The granted set is ADDITIVE and applied after the build, so it changes what the sim
  // and the strip DO (which reads the array every tick) without pretending to change the
  // stats, which were baked above. See the note under the Abilities list.
  for (const u of units) {
    for (const key of state.granted) if (!u.abilities.includes(key)) u.abilities.push(key);
  }
  return units;
}

/** Trim a config down to the one action being soloed, on a short recovery so it loops.
 *  Elite scaling is applied to the WHOLE list first, so a soloed action carries exactly
 *  the numbers it would carry in that fight. */
function soloed(
  bossThrow: BossThrowConfig | null,
  specials: BossSpecial[]
): { bossThrow: BossThrowConfig | null; specials: BossSpecial[] } {
  const [kind, what] = state.solo.split(":");
  if (kind === "throw") {
    const option = bossThrow?.options[Number(what)];
    return option
      ? { bossThrow: { intervalMs: 1500, options: [option] }, specials: [] }
      : { bossThrow, specials };
  }
  if (kind === "special") {
    const special = specials.find((s) => s.name === what);
    return special
      ? { bossThrow: null, specials: [{ ...special, weight: 1, cooldownMs: 1200 }] }
      : { bossThrow, specials };
  }
  // A soloed HAZARD silences the boss entirely, so nothing competes for the eye.
  if (kind === "hazard") return { bossThrow: null, specials: [] };
  return { bossThrow, specials };
}

function buildParams(): RaidSceneParams | null {
  const epic = epicDefOf();
  if (epic) return epicParams(epic);
  const raid = raidOf();
  if (!raid) return null;
  const stage = currentStage(raid);
  if (!stage) return null;

  const profile = eliteProfile(raid.id, state.elite);
  const fightAssets = assets;
  const shippedThrow = eliteBossThrow(bossThrowFor(fightAssets, raid, stage, 99), profile);
  const shippedSpecials = eliteBossSpecials(bossSpecialsFor(fightAssets, stage), profile);
  const { bossThrow, specials } = soloed(shippedThrow, shippedSpecials);

  const hazard = state.solo.startsWith("hazard:") ? state.solo.slice(7) : "";
  const grabber = grabberFor(raid);
  const crab = crabFor(raid);

  return {
    raid,
    assets,
    playerUnits: playerUnits(),
    enemyUnits: buildEnemyUnits(stage, assets.enemyStats, assets.raidAttacks, {
      raidId: raid.id, playerLevel: state.level, elite: profile,
    }),
    bossThrow,
    bossSpecials: specials,
    // The wall / summon / pixel-zombie templates are what their actions STAND UP, so
    // they travel with the fight whether or not that action is the one being soloed —
    // withhold one and its action becomes a silent no-op rather than an animation.
    wallTemplate: wallTemplateFor(fightAssets, stage, profile),
    summon: summonFor(fightAssets, raid, stage, state.level, profile),
    turnedTemplate: turnedTemplateFor(fightAssets, raid, stage, state.level, profile),
    waveCadence: waveCadenceFor(raid.id),
    grabber: hazard === "crab" ? null : grabber,
    crab: hazard === "grabber" ? null : crab,
    concentration: state.concentration,
    brainDrop: 10,
    confirmRetreat: () => Promise.resolve(true),
    onFinish: (outcome) => {
      outcomeLine = outcome.win
        ? `WIN — ${outcome.enemiesBeaten} beaten, ${outcome.losses.length} lost`
        : `LOSS — ${outcome.enemiesBeaten} beaten, ${outcome.losses.length} lost`;
    },
  };
}

/** An Epic Boss fight at a chosen rung. It carries no bossActions — its repertoire is
 *  its animation strips — so the action panel falls back to the fight-state pokes. */
function epicParams(def: EpicBossDef): RaidSceneParams {
  const level = Math.min(def.maxLevel, Math.max(1, state.epicLevel));
  const maxHp = epicBossHp(def, level);
  const run: EpicBossRun = {
    runId: "lab", bossId: def.id, activatedAt: 0, expiresAt: 0,
    level, maxHp, currentHp: maxHp, encounterStartedAt: 0, retryReadyAt: 0,
    tokenCount: 0, completedAt: 0, attackOrder: [],
  };
  const setup = buildEpicBossSetup(def, run, party(), assets, {
    level: state.level,
    abilityUnlocked: unlocked,
    farmerZombieStrengthMult: () => 1,
    farmerZombieLifeMult: () => 1,
  });
  for (const u of setup.playerUnits) {
    for (const key of state.granted) if (!u.abilities.includes(key)) u.abilities.push(key);
  }
  return {
    raid: setup.raid,
    assets,
    playerUnits: setup.playerUnits,
    enemyUnits: setup.enemyUnits,
    bossThrow: null,
    roundMs: def.fightMs,
    escapeOnRoundEnd: true,
    noDistractions: true,
    imageBase: epicAsset(def, ""),
    bossTexture: epicAsset(def, def.bossTexture),
    bossPortrait: epicAsset(def, def.portrait),
    bossAnimations: def.animations,
    bossFallsFromSky: true,
    bossEngageDistance: 150,
    // Same compensation main.ts applies: the authored bosses sit high inside padded
    // animation cells; a reconstructed one is cut tight and stands on the line unaided.
    bossGroundOffset: def.reconstructed
      ? { x: 0, y: 0 }
      : { x: 32, y: def.id === "loco-locust" ? 8 : 24 },
    confirmRetreat: () => Promise.resolve(true),
    onFinish: (outcome) => {
      outcomeLine = `${outcome.win ? "WIN" : "LOSS"} — ${def.name} L${level}`;
    },
  };
}

async function restart() {
  const token = ++buildToken;
  if (scene) {
    app.stage.removeChild(scene.container);
    scene.destroy();
    scene = null;
  }
  outcomeLine = "";
  const params = buildParams();
  if (!params) { note = "this invasion has no playable stage at that level"; return; }
  const built = await RaidScene.create(app, params);
  if (token !== buildToken) { built.destroy(); return; } // a newer restart already won
  scene = built;
  app.stage.addChild(built.container);
  buildActions();
  refreshStage();
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** Player units the sim currently has on the field, front-most first. */
const deployed = () =>
  (scene?.sim.units ?? [])
    .filter((u) => u.team === "player" && u.alive)
    .sort((a, b) => b.x - a.x);

const liveEnemies = () =>
  (scene?.sim.units ?? [])
    .filter((u) => u.team === "enemy" && u.alive)
    .sort((a, b) => a.x - b.x);

/** Wound units to a fraction of their maximum. This is the ONLY way the lab reaches
 *  heals, revives and deaths: the sim then gets there down its ordinary paths — a heal
 *  because somebody is hurt, a death because the next hit lands on 1 HP — so what plays
 *  is the real animation rather than a pose. */
function wound(units: { hp: number; maxHp: number }[], frac: number, label: string) {
  if (!units.length) { note = `${label}: nobody on the field yet`; return; }
  for (const u of units) u.hp = Math.max(1, Math.round(u.maxHp * frac));
  note = `${label}: ${units.length} unit${units.length === 1 ? "" : "s"} → ${Math.round(frac * 100)}% HP`;
}

interface Action { label: string; hint?: string; solo?: Solo; run?: () => void }

function actionGroups(): { title: string; actions: Action[] }[] {
  const raid = raidOf();
  const stage = raid ? currentStage(raid) : null;
  const groups: { title: string; actions: Action[] }[] = [];

  // --- activated moves, live on the running fight --------------------------------
  const activated = Object.keys(ABILITY_POOL).filter((k) => ABILITY_KIND[k] === "activated");
  groups.push({
    title: "Activated moves",
    actions: activated.map((key) => ({
      label: ABILITY_POOL[key].label,
      hint: ABILITY_POOL[key].effect,
      run: () => {
        const ok = scene?.sim.activate(key) ?? false;
        const status = scene?.sim.activatedStatus().find((s) => s.key === key);
        note = ok
          ? `${ABILITY_POOL[key].label}: wind-up started`
          : `${ABILITY_POOL[key].label}: nobody can perform it right now` +
            (status ? ` (ready ${status.ready}, on the strip: ${status.present})` : "") +
            (state.granted.has(key) ? "" : " — grant it below first");
      },
    })),
  });

  // --- the states the automatic team abilities answer to --------------------------
  groups.push({
    title: "Support (staged)",
    actions: [
      {
        label: "Hurt the line (30% HP)",
        hint: "A Garden zombie's Heal / Heal All answers this within its cadence",
        run: () => wound(deployed().filter((u) => !u.isGarden), 0.3, "Hurt the line"),
      },
      {
        label: "Front zombie to 1 HP",
        hint: "The next hit kills it — death FX, then Resurrect if the army has one",
        run: () => wound(deployed().slice(0, 1), 0.0001, "Front zombie"),
      },
      {
        label: "Whole army to 1 HP",
        hint: "Watch the defeat path",
        run: () => wound(deployed(), 0.0001, "Whole army"),
      },
    ],
  });

  // --- enemy deaths, the boss's death, the victory outro ---------------------------
  groups.push({
    title: "Enemies",
    actions: [
      {
        label: "Front enemy to 1 HP",
        run: () => wound(liveEnemies().filter((u) => !u.isBoss).slice(0, 1), 0.0001, "Front enemy"),
      },
      {
        label: "Every enemy to 1 HP",
        run: () => wound(liveEnemies().filter((u) => !u.isBoss), 0.0001, "Every enemy"),
      },
      {
        label: "Boss to 1 HP",
        hint: "Its death, the brain drop and the victory outro",
        run: () => wound(liveEnemies().filter((u) => u.isBoss), 0.0001, "Boss"),
      },
    ],
  });

  // --- the boss's own repertoire, soloed -------------------------------------------
  if (raid && stage) {
    const profile = eliteProfile(raid.id, state.elite);
    const shippedThrow = eliteBossThrow(bossThrowFor(assets, raid, stage, 99), profile);
    const specials = eliteBossSpecials(bossSpecialsFor(assets, stage), profile);
    const actions: Action[] = [];
    (shippedThrow?.options ?? []).forEach((option: BossThrowOption, i: number) => {
      actions.push({
        label: `Throw · ${option.sprite.replace(/\.png$/i, "")}`,
        hint: `${option.damage} damage · every 1.5 s while soloed`,
        solo: `throw:${i}`,
      });
    });
    for (const special of specials) {
      actions.push({
        label: special.name,
        hint: `cast ${Math.round(special.castMs)} ms · ${special.damage} damage · 1.2 s recovery while soloed`,
        solo: `special:${special.name}`,
      });
    }
    groups.push({
      title: actions.length ? "Boss actions (solo)" : "Boss actions",
      actions: actions.length
        ? [...actions, { label: "All, as shipped", hint: "the authored weighted mix", solo: "" }]
        : [{ label: stage.bossKey ? "this boss throws nothing at this stage" : "no boss on this stage" }],
    });

    // --- the two rescue hazards ----------------------------------------------------
    const hazards: Action[] = [];
    if (grabberFor(raid)) {
      hazards.push({
        label: "Trapeze Artist",
        hint: "sweeps in, grabs the rear zombie, carries it off — tap it apart",
        solo: "hazard:grabber",
      });
    }
    if (crabFor(raid)) {
      hazards.push({ label: "Beach crab", hint: "grabs, holds 2 s, hauls left", solo: "hazard:crab" });
    }
    groups.push({
      title: hazards.length ? "Hazards (solo)" : "Hazards",
      actions: hazards.length
        ? [...hazards, { label: "All, as shipped", solo: "" }]
        : [{ label: "this invasion ships none" }],
    });
  }

  return groups;
}

function buildActions() {
  const box = $("#actions");
  box.innerHTML = "";
  for (const group of actionGroups()) {
    const head = document.createElement("div");
    head.className = "slot";
    head.style.margin = "8px 0 3px";
    head.textContent = group.title;
    box.appendChild(head);
    for (const action of group.actions) {
      if (!action.run && action.solo === undefined) {
        const note_ = document.createElement("div");
        note_.className = "note";
        note_.style.padding = "0 0 4px";
        note_.textContent = action.label;
        box.appendChild(note_);
        continue;
      }
      const btn = document.createElement("button");
      btn.className = "act";
      if (action.solo !== undefined && action.solo !== "" && state.solo === action.solo) {
        btn.classList.add("solo");
      }
      btn.title = action.hint ?? "";
      btn.textContent = action.label;
      if (action.solo !== undefined) {
        const tag = document.createElement("span");
        tag.className = "k";
        tag.textContent = action.solo === "" ? "reset" : "solo";
        btn.appendChild(tag);
      }
      btn.addEventListener("click", () => {
        if (action.run) { action.run(); refreshStatus(true); return; }
        // Clicking the action you are already soloing puts the shipped mix back.
        state.solo = state.solo === action.solo ? "" : action.solo!;
        note = state.solo ? `soloing ${state.solo}` : "back to the shipped mix";
        void restart();
      });
      box.appendChild(btn);
    }
  }
}

// ---------------------------------------------------------------------------
// Left column — which fight
// ---------------------------------------------------------------------------

function buildRaidList() {
  const box = $("#raidList");
  box.innerHTML = "";
  const add = (id: string, name: string, tag: string) => {
    const row = document.createElement("div");
    row.className = "item" + (state.fight === id ? " sel" : "");
    row.innerHTML = `<span class="nm"></span><span class="tag"></span>`;
    (row.querySelector(".nm") as HTMLElement).textContent = name;
    (row.querySelector(".tag") as HTMLElement).textContent = tag;
    row.addEventListener("click", () => {
      state.fight = id;
      state.solo = "";
      buildRaidList();
      void restart();
    });
    box.appendChild(row);
  };
  const head = (text: string) => {
    const h = document.createElement("div");
    h.className = "slot";
    h.textContent = text;
    box.appendChild(h);
  };

  const ladder = assets.raids.filter((r) => r.playable && !r.seasonal);
  const seasonal = assets.raids.filter((r) => r.playable && r.seasonal);
  head("Ladder");
  for (const r of ladder) add(`raid:${r.id}`, r.name, `L${r.recommendedLevel}`);
  if (seasonal.length) {
    head("Events");
    for (const r of seasonal) add(`raid:${r.id}`, r.name, `L${r.recommendedLevel}`);
  }
  head("Epic bosses");
  for (const b of EPIC_BOSSES) add(`epic:${b.id}`, b.name, `×${b.maxLevel}`);
}

function refreshStage() {
  const epic = epicDefOf();
  if (epic) {
    $("#stageInfo").textContent =
      `${epic.name} · rung ${Math.min(epic.maxLevel, state.epicLevel)}/${epic.maxLevel}\n` +
      `${epicBossHp(epic, Math.min(epic.maxLevel, state.epicLevel)).toLocaleString()} HP · ` +
      `${Object.keys(epic.animations).length} animation strips`;
    return;
  }
  const raid = raidOf();
  const stage = raid ? currentStage(raid) : null;
  if (!raid || !stage) { $("#stageInfo").textContent = "no playable stage"; return; }
  const idx = raid.stages.indexOf(fightStage(raid, state.level)!);
  // Count the units the stage actually BUILDS, not `enemyKeys`: a weighted wave (the
  // Circus, the late endless ones) leaves that array empty and draws its line-up from
  // `weighted` + `population` instead, which reads as "0 enemy types" and is a lie.
  const line = buildEnemyUnits(stage, assets.enemyStats, assets.raidAttacks, {
    raidId: raid.id, playerLevel: state.level, elite: eliteProfile(raid.id, state.elite),
  });
  const kinds = new Set(line.filter((u) => !u.isBoss).map((u) => u.sourceKey));
  const grunts = line.filter((u) => !u.isBoss).length;
  $("#stageInfo").textContent =
    `stage ${idx + 1}/${raid.stages.length} · ${grunts} enemies, ${kinds.size} kind${kinds.size === 1 ? "" : "s"}\n` +
    `boss: ${stage.bossKey || "none"}${stage.throwingDisabled ? " (no throwing)" : ""}\n` +
    `${raid.levelAssets.length} parallax layers · ${raid.music}`;
}

// ---------------------------------------------------------------------------
// Right column — army and abilities
// ---------------------------------------------------------------------------

/** The strongest ordinary species in a group — highest class rank wins, so its own
 *  ability tiers are as deep as that group can go. */
function pickForGroup(group: string): ZombieDef | null {
  const rank = ["Green", "Blue", "Red", "Silver", "Special", "Yellow"];
  const pool = assets.zombies.filter((z) => z.group === group && z.category !== "special");
  if (!pool.length) return null;
  return pool.slice().sort((a, b) =>
    (rank.indexOf(b.className) - rank.indexOf(a.className)) || (b.str + b.con) - (a.str + a.con)
  )[0];
}

/** A party that can show everything: a Garden zombie so Heal has a caster, a Small and
 *  a Large so Mini Buddy has a rider and a carrier, and a rank of Regulars to fight. */
function defaultArmy(): ArmyRow[] {
  const rows: ArmyRow[] = [];
  const push = (group: string, count: number) => {
    const def = pickForGroup(group);
    if (def) rows.push({ key: def.key, count });
  };
  push("Garden", 1);
  push("Small", 1);
  push("Large", 1);
  push("Regular", 5);
  return rows.length ? rows : [{ key: assets.zombies[0].key, count: 8 }];
}

function buildArmyRows() {
  const box = $("#armyRows");
  box.innerHTML = "";
  state.army.forEach((row, i) => {
    const wrap = document.createElement("div");
    wrap.className = "armyrow";

    const sel = document.createElement("select");
    for (const z of assets.zombies) {
      const opt = document.createElement("option");
      opt.value = z.key;
      opt.textContent = `${z.name} · ${z.group}/${z.className}`;
      if (z.key === row.key) opt.selected = true;
      sel.appendChild(opt);
    }
    sel.addEventListener("change", () => { row.key = sel.value; void restart(); });

    const num = document.createElement("input");
    num.type = "number"; num.min = "0"; num.max = "16"; num.value = String(row.count);
    num.addEventListener("change", () => {
      const v = parseInt(num.value, 10);
      if (!Number.isFinite(v)) return;      // an empty field is a person mid-edit
      row.count = Math.max(0, Math.min(16, v));
      num.value = String(row.count);
      void restart();
    });

    const del = document.createElement("button");
    del.className = "mini"; del.textContent = "×"; del.title = "remove";
    del.addEventListener("click", () => {
      state.army.splice(i, 1);
      buildArmyRows();
      void restart();
    });

    wrap.append(sel, num, del);
    box.appendChild(wrap);
  });
}

function buildAbilityList() {
  const box = $("#abils");
  box.innerHTML = "";
  $("#abilNote").innerHTML =
    "Granted to <b>every</b> zombie, on top of its class's own. This changes what the " +
    "fight <b>does</b> — the sim reads the list every tick — but not its stats, which " +
    "were baked when the units were built, so the passive <code>+%</code> ones appear " +
    "on the card and change nothing.<br>" +
    "<code>activated</code> waits for its button. <code>team</code> is automatic but " +
    "gated — the heals and the revive only ever come from a Garden zombie. " +
    "<code>self</code> is automatic and <b>ungated</b>: grant Laser Beam and all eight " +
    "zombies fire, which drowns out whatever else you were watching.";
  for (let tier = 1; tier <= 4; tier++) {
    const head = document.createElement("div");
    head.className = "slot";
    // A tier above the cap is locked for the SPECIES gate, so nothing is granted by
    // class rank — but the checkboxes still work, because granting is how the lab
    // reaches an ability its army could not otherwise carry.
    head.textContent = tier <= state.tierCap ? `Tier ${tier}` : `Tier ${tier} · locked`;
    box.appendChild(head);
    for (const key of ABILITY_TIER[tier]) {
      const meta = ABILITY_POOL[key];
      const row = document.createElement("div");
      row.className = "abil" + (state.granted.has(key) ? " on" : "");
      row.innerHTML = `<span class="box"></span><span class="nm"></span><span class="st"></span>`;
      (row.querySelector(".nm") as HTMLElement).textContent = meta.label;
      (row.querySelector(".st") as HTMLElement).textContent = ABILITY_KIND[key];
      row.title = meta.effect;
      row.addEventListener("click", () => {
        if (state.granted.has(key)) state.granted.delete(key);
        else state.granted.add(key);
        buildAbilityList();
        void restart();
      });
      box.appendChild(row);
    }
  }
}

// ---------------------------------------------------------------------------
// Transport + status
// ---------------------------------------------------------------------------

function tick(ticker: Ticker) {
  if (!scene || state.paused) return;
  scene.update((ticker.deltaMS / 1000) * state.speed);
  refreshStatus();
}

let statusDue = 0;

function refreshStatus(force = false) {
  const now = performance.now();
  if (!force && now < statusDue) return;
  statusDue = now + 150;
  const sim = scene?.sim;
  if (!sim) { $("#status").textContent = note || "no fight"; return; }
  const players = sim.units.filter((u) => u.team === "player");
  const enemies = sim.units.filter((u) => u.team === "enemy");
  const alive = (list: typeof players) => list.filter((u) => u.alive).length;
  const ready = sim.activatedStatus()
    .filter((s) => s.present || s.ready)
    .map((s) => `${s.key}×${s.ready}`)
    .join(" ");
  const team = sim.teamAbilityStatus().map((s) => `${s.key}×${s.count}`).join(" ");
  $("#status").innerHTML =
    `<b>zombies</b> ${alive(players)}/${players.length}   ` +
    `<b>enemies</b> ${alive(enemies)}/${enemies.length}   ` +
    `<b>projectiles</b> ${sim.projectiles.length}   ` +
    `<b>hazards</b> ${sim.grabbers.length + sim.crabs.length}\n` +
    `ready: ${ready || "—"}\nteam: ${team || "—"}\n` +
    `${outcomeLine ? outcomeLine + "   " : ""}${note}`;
}

function wireControls() {
  const play = $<HTMLButtonElement>("#play");
  play.addEventListener("click", () => {
    state.paused = !state.paused;
    play.textContent = state.paused ? "Play" : "Pause";
    play.classList.toggle("on", state.paused);
    refreshStatus(true);
  });
  const stepBy = (n: number) => {
    for (let i = 0; i < n; i++) scene?.update(RAID_TICK_MS / 1000);
    refreshStatus(true);
  };
  $("#step").addEventListener("click", () => stepBy(1));
  $("#step10").addEventListener("click", () => stepBy(10));
  // The march in takes ten to fifteen seconds, and an activated move needs somebody
  // already swinging — so the first thing anyone wants is to be at the contact line.
  $("#engage").addEventListener("click", () => {
    const sim = scene?.sim;
    if (!sim) return;
    const engaged = () => sim.units.some((u) => u.team === "player" && u.alive && u.state === "fight");
    let ticks = 0;
    const cap = 40_000 / RAID_TICK_MS; // 40 s is longer than any stage's walk-in
    while (!engaged() && !sim.finished && ticks < cap) { scene!.update(RAID_TICK_MS / 1000); ticks++; }
    note = engaged()
      ? `skipped ${((ticks * RAID_TICK_MS) / 1000).toFixed(1)} s to first contact`
      : `no contact within 40 s (fight ${sim.finished ? "already over" : "still closing"})`;
    refreshStatus(true);
  });
  $("#restart").addEventListener("click", () => { void restart(); });

  const speed = $<HTMLInputElement>("#speed");
  speed.addEventListener("input", () => {
    state.speed = parseFloat(speed.value) || 1;
    $("#speedV").textContent = `${state.speed.toFixed(2)}×`;
  });

  const level = $<HTMLInputElement>("#level");
  level.addEventListener("input", () => {
    const v = parseInt(level.value, 10);
    if (!Number.isFinite(v)) return;
    state.level = v;
    state.epicLevel = Math.max(1, Math.round(v / 4));
    $("#levelV").textContent = String(v);
    refreshStage();
  });
  level.addEventListener("change", () => { void restart(); });

  const wave = $<HTMLInputElement>("#wave");
  wave.addEventListener("input", () => {
    const v = parseInt(wave.value, 10);
    if (!Number.isFinite(v)) return;
    state.wave = v;
    $("#waveV").textContent = String(v);
    refreshStage();
  });
  wave.addEventListener("change", () => { void restart(); });

  const tiers = $<HTMLInputElement>("#tiers");
  tiers.addEventListener("input", () => {
    const v = parseInt(tiers.value, 10);
    if (!Number.isFinite(v)) return;
    state.tierCap = v;
    $("#tiersV").textContent = String(v);
  });
  tiers.addEventListener("change", () => { buildAbilityList(); void restart(); });

  const elite = $<HTMLButtonElement>("#elite");
  elite.addEventListener("click", () => {
    state.elite = !state.elite;
    elite.classList.toggle("on", state.elite);
    void restart();
  });
  const conc = $<HTMLButtonElement>("#conc");
  conc.addEventListener("click", () => {
    state.concentration = !state.concentration;
    conc.classList.toggle("on", state.concentration);
    void restart();
  });

  $("#addRow").addEventListener("click", () => {
    const def = pickForGroup("Regular") ?? assets.zombies[0];
    state.army.push({ key: def.key, count: 1 });
    buildArmyRows();
    void restart();
  });
  const preset = (rows: ArmyRow[]) => {
    state.army = rows;
    buildArmyRows();
    void restart();
  };
  $("#pRegulars").addEventListener("click", () => {
    const def = pickForGroup("Regular");
    if (def) preset([{ key: def.key, count: 8 }]);
  });
  $("#pMixed").addEventListener("click", () => {
    const groups = ["Regular", "Female", "Small", "Large", "Headless", "Garden"];
    preset(groups.map((g) => pickForGroup(g)).filter((d): d is ZombieDef => !!d)
      .map((d) => ({ key: d.key, count: 1 })));
  });
  $("#pGarden").addEventListener("click", () => {
    const def = pickForGroup("Garden");
    if (!def) return;
    const row = state.army.find((r) => r.key === def.key);
    if (row) row.count++;
    else state.army.unshift({ key: def.key, count: 1 });
    buildArmyRows();
    void restart();
  });

  $("#png").addEventListener("click", () => {
    app.renderer.render(app.stage);
    const a = document.createElement("a");
    a.href = app.canvas.toDataURL("image/png");
    a.download = `${state.fight.replace(":", "-")}.png`;
    a.click();
  });
}
