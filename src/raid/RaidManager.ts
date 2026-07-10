// Raid orchestration: turns the raid catalog + owned-zombie roster into the
// view-models the HUD renders, runs the instant-resolve battle, and applies the
// win rewards through GameState + the roster (veterancy) + save.
//
// The HUD is kept decoupled from raid internals — it only ever sees the *View
// types below, and calls back into start().
import { GameAssets, zombiePortrait, raidImage, lootImage } from "../assets";
import { GameState } from "../GameState";
import { ZombieField } from "../zombie/ZombieField";
import { OwnedZombie } from "../zombie/types";
import { buildEnemyUnits, buildPlayerUnits, resolveRaid } from "./CombatEngine";
import {
  ARMY_CAP,
  CONCENTRATION_KEY,
  DICE_KEY,
  MIN_ARMY,
  RAID_COOLDOWN_MS,
  VOUCHER_KEY,
  winGold,
  fightStage,
  isUnlocked,
  lockReason,
  maxLuckTiers,
  power,
  raidTier,
  rewardPreview,
} from "./RaidCatalog";
import { BASE } from "../base";
import { BossSpecial, BossThrowConfig, CombatUnit, HazardConfig, RaidDef, RaidOutcome, RaidStage } from "./types";
import { rollLootTier } from "./LootTable";

// Brain drop table (gameplayParameters `brainDropRateInvasion`, recovered from
// buildStandardBossLootTable): a win can drop 10/30/50 brains at rising rarity. The
// chance scales with the raid's level from the LOWER limit up to the UPPER limit,
// reaching the upper ("optimal") chances at recommendedLevel >= 20. Rarest first, so
// a win yields at most one brain drop.
const BRAIN_DROP_TABLE = [
  { amount: 10, lower: 0.025, upper: 0.05 },
  { amount: 30, lower: 0.01, upper: 0.02 },
  { amount: 50, lower: 0.005, upper: 0.01 },
];
const BRAIN_OPTIMAL_LEVEL = 20; // gameplayParameters `epicBossLootLevelWithOptimalChances`
/** Contact damage an environmental obstacle deals (source carries no value). */
const HAZARD_DAMAGE = 4;
/** Cadence for grab hazards (Lawyers cars / Circus trapeze), source has no timer. */
const GRAB_SPAWN_MS = 9000;

// ---- HUD-facing view models ----

export interface RaidCardView {
  id: number;
  name: string;
  bossName: string;
  portrait: string; // full image url
  recommendedLevel: number;
  unlockLevel: number;
  xp: number;
  rewardPreview: string[];
  introText: string;
  seasonal: boolean;
  unlocked: boolean; // level met AND playable
  lockReason: string; // "" when unlocked
}

export interface RaidPartyZombie {
  id: string;
  name: string; // individual name
  typeName: string; // species/type
  portrait: string;
  str: number;
  dex: number;
  con: number;
  focus: number;
  power: number;
}

export interface RaidPartyView {
  eligible: RaidPartyZombie[]; // deployed zombies, strongest first
  cap: number; // max selectable
  min: number; // minimum to launch
  defaultSelectedIds: string[];
  /** The player's saved attack order (first attacks first), filtered to zombies
   *  still deployed and clamped to `cap`. Empty on a first-ever raid. */
  orderedSelectedIds: string[];
}

/** One loot drop shown in the results panel (name + picture URL, "" if no art). */
export interface LootDrop {
  name: string;
  icon: string;
}

/** The end-of-raid tally, matching the real "ZOMBIES WIN" results panel. */
export interface RaidResultView {
  win: boolean;
  title: string; // "ZOMBIES WIN" / "ZOMBIES LOSE"
  enemiesBeaten: number;
  zombiesLost: number;
  gold: number; // gold plundered
  brains: number; // brains plundered
  loot: LootDrop[]; // item drops (with pictures)
  abilityUnlock: string; // "" unless a tier unlocked on this clear
}

/** Battle consumables chosen on the Invade screens. All optional; each is spent
 *  in beginRaid() only if owned and requested. */
export interface RaidLaunchOpts {
  /** Spend an Invasion Voucher to bypass an active cooldown. */
  useVoucher?: boolean;
  /** Spend a Concentration boost so zombies fight at full focus (no distraction). */
  concentration?: boolean;
  /** How many Golden Dice to spend (each climbs the loot one tier rarer). */
  dice?: number;
}

/** A committed raid ready to be played out (by the live scene or the instant
 *  resolver). The cooldown/voucher gates have passed and the combat lines are
 *  built; rewards are applied later via finishRaid(). */
export interface RaidSetup {
  raid: RaidDef;
  party: OwnedZombie[];
  playerUnits: CombatUnit[];
  enemyUnits: CombatUnit[];
  /** Boss projectile config for the live scene (null if the boss has no throws). */
  bossThrow: BossThrowConfig | null;
  /** Boss special (non-throw) actions for the live scene ([] if none). */
  bossSpecials: BossSpecial[];
  /** Environmental obstacle hazards for the live scene (null if none). */
  hazard: HazardConfig | null;
  /** Minion the boss's summonBoss action spawns (null if it can't summon). */
  summonTemplate: CombatUnit | null;
  /** Blocker the boss's wall action spawns (null if it has no wall). */
  wallTemplate: CombatUnit | null;
  /** Golden Dice spent on this fight — carried into finishRaid() for loot luck. */
  dice: number;
  /** Concentration boost spent — the live scene skips the focus-bubble minigame. */
  concentration: boolean;
}

export class RaidManager {
  constructor(
    private assets: GameAssets,
    private state: GameState,
    private zombies: ZombieField,
    private hooks: { save: () => void },
    /** Between-invasions cooldown in ms (playtest-scaled by main.ts). */
    private cooldownMs: number = RAID_COOLDOWN_MS,
    /** Wall clock, injectable for tests. */
    private now: () => number = () => Date.now()
  ) {}

  /** Ms left on the between-invasions cooldown (0 = ready). */
  cooldownRemaining(): number {
    return Math.max(0, this.cooldownMs - (this.now() - this.state.lastRaidAt));
  }
  /** Whether a cooldown is currently blocking new invasions. */
  onCooldown(): boolean {
    return this.cooldownRemaining() > 0;
  }
  /** How many Invasion Vouchers the player owns (each bypasses the cooldown). */
  voucherCount(): number {
    return this.state.boostCount(VOUCHER_KEY);
  }
  /** How many Concentration boosts the player owns (fight at full focus). */
  concentrationCount(): number {
    return this.state.boostCount(CONCENTRATION_KEY);
  }
  /** How many Golden Dice the player owns (each climbs the loot one tier rarer). */
  diceCount(): number {
    return this.state.boostCount(DICE_KEY);
  }
  /** Most Golden Dice worth spending on a raid (its rare-tier depth). */
  maxDiceFor(raidId: number): number {
    const raid = this.raid(raidId);
    return raid ? maxLuckTiers(raid) : 0;
  }

  private raid(id: number): RaidDef | undefined {
    return this.assets.raids.find((r) => r.id === id);
  }

  /** Deployed (on-farm) owned zombies — the eligible army source. */
  private deployed(): OwnedZombie[] {
    return this.zombies.roster().filter((r) => !r.stored);
  }

  /** All invasions as cards for the select screen (sorted: ladder by level,
   *  seasonal events after). */
  raidCards(): RaidCardView[] {
    const level = this.state.level;
    return this.assets.raids
      .map((r) => ({
        id: r.id,
        name: r.name,
        bossName: r.bossName,
        portrait: r.bossPortrait ? raidImage(r.bossPortrait) : "",
        recommendedLevel: r.recommendedLevel,
        unlockLevel: r.unlockLevel,
        xp: r.xp,
        rewardPreview: rewardPreview(r),
        introText: r.introText.replace(/\\n/g, "\n"),
        seasonal: r.seasonal,
        unlocked: isUnlocked(r, level),
        lockReason: lockReason(r, level),
      }))
      .sort(
        (a, b) =>
          Number(a.seasonal) - Number(b.seasonal) ||
          a.unlockLevel - b.unlockLevel ||
          a.id - b.id
      );
  }

  /** Eligible army + default selection for a raid's Army screen. */
  partyView(): RaidPartyView {
    const cap = Math.min(ARMY_CAP, this.state.zombieMax);
    const eligible: RaidPartyZombie[] = this.deployed()
      .map((z) => ({
        id: z.id,
        name: z.name,
        typeName: z.typeName,
        portrait: zombiePortrait(z.key),
        str: z.str,
        dex: z.dex,
        con: z.con,
        focus: z.focus,
        power: power(z),
      }))
      .sort((a, b) => b.power - a.power);
    // Restore the saved attack order, dropping any zombie that's no longer
    // deployed (sold, stored, died on a raid) and clamping to the current cap.
    const live = new Set(eligible.map((z) => z.id));
    const orderedSelectedIds = this.state.raidAttackOrder
      .filter((id) => live.has(id))
      .slice(0, cap);
    return {
      eligible,
      cap,
      min: MIN_ARMY,
      defaultSelectedIds: eligible.slice(0, cap).map((z) => z.id),
      orderedSelectedIds,
    };
  }

  /** How many deployed zombies are available (for the select-screen gate). */
  eligibleCount(): number {
    return this.deployed().length;
  }

  /** Commit to a raid: enforce the cooldown/voucher + min-army gates, then build
   *  the player + enemy combat lines. Returns null if the raid can't launch. A
   *  voucher (if used) is consumed here; rewards + cooldown come later in
   *  finishRaid(), once the fight has been played out. */
  beginRaid(raidId: number, partyIds: string[], opts: RaidLaunchOpts = {}): RaidSetup | null {
    const raid = this.raid(raidId);
    if (!raid) return null;
    const stage = fightStage(raid, this.state.level);
    const byId = new Map(this.deployed().map((z) => [z.id, z]));
    const party = partyIds.map((id) => byId.get(id)).filter(Boolean) as OwnedZombie[];

    if (!stage || party.length < MIN_ARMY) return null;

    // Cooldown gate: either wait it out, or spend a voucher to skip it.
    if (this.onCooldown()) {
      if (!opts.useVoucher || !this.state.useBoost(VOUCHER_KEY)) return null;
    }

    // Battle consumables — spent now that the launch is committed. Concentration
    // (fight at full focus) needs at most one; Golden Dice stack for loot luck,
    // capped by both the player's stock and the raid's rare-tier depth.
    let concentration = false;
    if (opts.concentration && this.state.useBoost(CONCENTRATION_KEY)) concentration = true;

    let dice = 0;
    const wantDice = Math.max(0, Math.floor(opts.dice ?? 0));
    const diceCap = Math.min(wantDice, this.diceCount(), maxLuckTiers(raid));
    for (let i = 0; i < diceCap && this.state.useBoost(DICE_KEY); i++) dice++;

    // Remember the chosen attack order so the Army screen reopens with it after
    // the raid. `party` is already in launch order and filtered to live zombies.
    this.state.raidAttackOrder = party.map((z) => z.id);

    const enemyUnits = buildEnemyUnits(stage, this.assets.enemyStats, this.assets.raidAttacks);
    return {
      raid,
      party,
      playerUnits: buildPlayerUnits(party, {
        concentration,
        // Gate abilities exactly like the detail card: a tier applies only once
        // its invasion boss is beaten.
        tierUnlocked: (t) => this.state.abilityTierUnlocked(t),
        // Level-scale str/con/dex: zombies don't fight at full stats until L25
        // (binary modifyStatWithLevelScale:).
        playerLevel: this.state.level,
      }),
      enemyUnits,
      bossThrow: this.bossThrowOf(raid, stage),
      bossSpecials: this.bossSpecialsOf(stage),
      hazard: this.hazardOf(raid),
      ...this.summonWallTemplatesOf(stage, enemyUnits),
      dice,
      concentration,
    };
  }

  /** Build the templates the boss can spawn: `summonBoss` reinforces with a copy of
   *  the wave's minion; `wall` drops a high-HP blocker sized from the action's `hp`.
   *  Each is null unless the boss actually has that action. */
  private summonWallTemplatesOf(
    stage: RaidStage,
    enemyUnits: CombatUnit[]
  ): { summonTemplate: CombatUnit | null; wallTemplate: CombatUnit | null } {
    let summonTemplate: CombatUnit | null = null;
    let wallTemplate: CombatUnit | null = null;
    if (stage.bossKey && !stage.throwingDisabled) {
      const actions = this.assets.enemyStats[stage.bossKey]?.bossActions ?? [];
      if (actions.some((a) => a.name === "summonBoss")) {
        const minion = enemyUnits.find((u) => !u.isBoss);
        if (minion) summonTemplate = { ...minion };
      }
      const wall = actions.find((a) => a.name === "wall");
      if (wall) {
        const hp = Math.max(1, Math.round(wall.hp ?? 1500));
        wallTemplate = {
          id: "wall",
          sourceKey: "carrotWall",
          team: "enemy",
          name: "Wall",
          str: 0,
          dex: 1,
          con: Math.round(hp / 10),
          focus: 0,
          hp, // the sim's toSim() uses maxHp directly, so set it to the wall's HP
          maxHp: hp,
          attackCooldownMs: 3500,
          attacks: [{ name: "", frequency: 1, mult: 0 }],
          isBoss: false,
          alive: true,
          isGarden: false,
          isHeadless: false,
          abilities: [],
        };
      }
    }
    return { summonTemplate, wallTemplate };
  }

  /** Build the boss's SPECIAL (non-throw) actions for the selected stage — lasers,
   *  AoE bursts, turn-zombie, etc. Same gate as throws (needs a boss and an "active"
   *  stage). Cast/cooldown come from the source castTime/cooldownTime (seconds);
   *  where a special has no cooldown the cast doubles as the recovery. */
  private bossSpecialsOf(stage: RaidStage): BossSpecial[] {
    if (!stage.bossKey || stage.throwingDisabled) return [];
    const actions = this.assets.enemyStats[stage.bossKey]?.bossActions ?? [];
    return actions
      .filter((a) => a.name !== "throw")
      .map((a) => {
        const castMs = (a.castTime ?? 0) * 1000;
        const cooldownMs = (a.cooldownTime ?? a.castTime ?? 2) * 1000;
        return {
          name: a.name,
          weight: a.frequency,
          castMs,
          cooldownMs,
          damage: a.damage ?? 0,
        };
      });
  }

  /** Build the raid's environmental-hazard config (null if it has none). Damage
   *  obstacles (Beach/Tree/Valentine) carry no source damage value, so a small
   *  default is used; grab hazards (Lawyers cars / Circus trapeze) seize a zombie
   *  instead and spawn on a steady cadence. */
  private hazardOf(raid: RaidDef): HazardConfig | null {
    if (raid.obstacleLimit && raid.obstacleSpawnSecs > 0) {
      return {
        limit: raid.obstacleLimit,
        spawnMs: raid.obstacleSpawnSecs * 1000,
        damage: HAZARD_DAMAGE,
        sprite: "", // obstacle atlas frames aren't preloaded; renders as a hazard dot
        initial: !!raid.initialSpawnClass,
        grab: false,
      };
    }
    if (raid.hasGrab) {
      return { limit: 1, spawnMs: GRAB_SPAWN_MS, damage: 0, sprite: "", initial: false, grab: true };
    }
    return null;
  }

  /** Build the boss's projectile config for the selected stage. Returns null when
   *  the stage has no boss OR throwing is disabled on it (early boss waves let the
   *  boss come down to fight without throwing — verified in the real game). The
   *  throw interval comes from the stage's throwSpeed, else the raid default. */
  private bossThrowOf(raid: RaidDef, stage: RaidStage): BossThrowConfig | null {
    if (!stage.bossKey || stage.throwingDisabled) return null;
    const actions = this.assets.enemyStats[stage.bossKey]?.bossActions ?? [];
    const options = actions
      .filter((a) => a.name === "throw")
      .map((a) => ({
        damage: a.damage ?? 0,
        weight: a.frequency,
        sprite: a.sprite ?? "",
        spriteSize: a.spriteSize ?? 32,
      }))
      .filter((o) => o.sprite);
    if (!options.length) return null;
    // Source throwSpeed reads too fast in the live scene — aim for ~2 real seconds
    // between throws, so each throwSpeed "second" maps to 2000ms (McDonnell's
    // throwSpeed 2 → 4000ms).
    const secs = stage.throwSpeed ?? raid.throwSpeed;
    return { intervalMs: (secs > 0 ? secs : 2) * 2000, options };
  }

  /** Apply the result of a played-out raid: veterancy credit, win rewards, the
   *  between-invasions cooldown, and a save. Returns the result view for the HUD.
   *  Works for both the live scene and the instant resolver. */
  finishRaid(raid: RaidDef, party: OwnedZombie[], outcome: RaidOutcome, dice = 0): RaidResultView {
    // Veterancy is earned by SURVIVING a battle — credit only the units still
    // standing (drives rank-up). A unit knocked out mid-fight, even in a win, gets
    // nothing; a total loss credits no one.
    this.zombies.recordInvasion(outcome.survivors);

    this.state.lastRaidAt = this.now();

    let gold = 0;
    let brains = 0;
    const loot: LootDrop[] = [];
    let abilityUnlock = "";
    if (outcome.win) {
      const wins = this.state.completeRaid(String(raid.id));
      // Raids don't grant XP for now (deliberately).
      const survivalFrac = party.length ? outcome.survivors.length / party.length : 0;
      gold = winGold(raid, survivalFrac);
      this.state.addGold(gold);
      // Loot: ONE weighted drop (source `rollForDrop:`). The rarity tier is chosen
      // by rollLootTier() from the luck bracket (Golden Dice spent), then one
      // eligible alternative in that tier is picked uniformly. A "Bonus Gold" pick
      // pays extra gold (level*100) instead of an item.
      const drop = this.rollLoot(raid, dice);
      if (drop === "Bonus Gold") {
        const bonusGold = raid.recommendedLevel * 100; // getBonusGoldLootForStageLevel:
        gold += bonusGold;
        this.state.addGold(bonusGold);
      } else if (drop) {
        // A boost drop stacks straight into the player's boost inventory (bumping
        // that boost's count) rather than sitting in Storage/Received to be claimed.
        const boost = this.assets.boosts.find((b) => b.name === drop);
        if (boost) this.state.addBoost(boost.key);
        else this.state.receiveItem(drop);
        loot.push({ name: drop, icon: this.lootIcon(drop) });
      }
      // Brains drop occasionally, IN ADDITION to loot (source brain-drop table).
      brains = this.rollBrainDrop(raid);
      if (brains > 0) this.state.addBrains(brains);
      // First clear of a tier boss unlocks that tier's abilities across the roster.
      const tier = raidTier(raid);
      if (tier > 0 && wins === 1) abilityUnlock = `Tier ${tier} abilities unlocked!`;
    }

    this.hooks.save();

    return {
      win: outcome.win,
      title: outcome.win ? "ZOMBIES WIN" : "ZOMBIES LOSE",
      enemiesBeaten: outcome.enemiesBeaten,
      zombiesLost: outcome.losses.length,
      gold,
      brains,
      loot,
      abilityUnlock,
    };
  }

  /** Roll the source brain-drop table for a win. Chance rises with the raid's level
   *  toward the optimal (upper-limit) chances at level 20+. Rarest amount first, so a
   *  win awards at most one drop (0 = none). */
  private rollBrainDrop(raid: RaidDef): number {
    const frac = Math.max(0, Math.min(1, raid.recommendedLevel / BRAIN_OPTIMAL_LEVEL));
    for (let i = BRAIN_DROP_TABLE.length - 1; i >= 0; i--) {
      const t = BRAIN_DROP_TABLE[i];
      const chance = t.lower + (t.upper - t.lower) * frac;
      if (Math.random() < chance) return t.amount;
    }
    return 0;
  }

  /** Roll a single item drop for a win (source `rollForDrop:` + `lootTableFromCategory:`).
   *  Picks a rarity tier from the luck bracket, then a uniform eligible alternative
   *  within it. Eligibility drops `unique` items already owned and `limit`-capped
   *  items at their cap. If the chosen tier has no eligible items, the roll walks
   *  DOWN to commoner tiers (as the binary does). Returns null if nothing is
   *  eligible (e.g. every tier already collected). */
  private rollLoot(raid: RaidDef, bonus: number): string | null {
    // Owned = unclaimed raid loot + items stashed in the shed. (Decorations already
    // placed on the farm aren't tracked as inventory, so a placed unique can still
    // re-drop — a minor divergence from the source's full ownership check.)
    const ownedCount = (name: string): number => {
      let n = this.state.received.filter((r) => r === name).length;
      n += this.state.storedItems.find((s) => s.key === name)?.count ?? 0;
      return n;
    };
    const eligibleIn = (tierIdx: number): string[] =>
      (raid.loot[tierIdx] ?? []).filter((name) => {
        if (!name) return false;
        const d = this.assets.drops[name];
        if (d?.unique && ownedCount(name) > 0) return false;
        if (d && d.limit > 0 && ownedCount(name) >= d.limit) return false;
        return true;
      });

    let tier = rollLootTier(Math.random(), bonus);
    for (; tier >= 0; tier--) {
      const items = eligibleIn(tier);
      if (items.length) return items[Math.floor(Math.random() * items.length)];
    }
    return null;
  }

  /** Resolve a loot item's picture URL ("" when there's no art). Boost loot
   *  (Insta-Plow, Concentration, …) has no drop art, so fall back to the boost
   *  catalog sprite. */
  private lootIcon(name: string): string {
    const d = this.assets.drops[name];
    if (d && d.icon) return lootImage(d.icon);
    const b = this.assets.boosts.find((x) => x.name === name);
    if (b && b.icon) return `${BASE}assets/boosts/${b.icon}`;
    return "";
  }

  /** Quick-resolve path: commit, resolve the fight instantly, apply rewards.
   *  Returns null if the raid can't launch. Kept for the "Quick Resolve" button
   *  and headless tests; the live scene uses beginRaid + finishRaid instead. */
  start(raidId: number, partyIds: string[], opts: RaidLaunchOpts = {}): RaidResultView | null {
    const setup = this.beginRaid(raidId, partyIds, opts);
    if (!setup) return null;
    const outcome = resolveRaid(setup.playerUnits, setup.enemyUnits);
    return this.finishRaid(setup.raid, setup.party, outcome, setup.dice);
  }
}
