// Raid orchestration: turns the raid catalog + owned-zombie roster into the
// view-models the HUD renders, commits a raid (beginRaid) for the live scene to play
// out, and applies win rewards (finishRaid) through GameState + roster (veterancy) + save.
//
// The game ALWAYS plays raids in the live scene (beginRaid + finishRaid). `start()` is a
// headless instant-resolve (beginRaid + resolveRaid + finishRaid) retained ONLY for the
// ZF.runRaid dev hook and tests — it is not wired to any player-facing control.
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
  minArmyFor,
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
import { ABILITY_TIER, ABILITY_POOL } from "../zombie/traits";
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
/** Contact damage an environmental obstacle deals (source carries no value; a tuned
 *  chip value kept proportional to the ground-truth melee/HP scale — see BattleSim). */
const HAZARD_DAMAGE = 28;
/** Cadence for grab hazards (Lawyers cars / Circus trapeze), source has no timer. */
const GRAB_SPAWN_MS = 9000;
/** Real falling-obstacle art per raid id (raids/images/). Unmapped -> warning dot.
 *  Summer/Beach mine, Tree World pinecone, Valentine's teapot — all shipped sprites. */
const OBSTACLE_SPRITE: Record<number, string> = {
  7: "beach_debris_seamine.png",
  10: "weapon_pinecone.png",
  11: "valentines2012_debris_pot.png",
};
/** Real grab-hazard art per raid id. Circus = the trapeze girl (extracted from the
 *  stage atlas). Lawyers has no shipped car sprite, so it keeps the dot. */
const GRAB_SPRITE: Record<number, string> = {
  8: "hazard_trapeze_girl.png",
};

// ---- HUD-facing view models ----

export interface RaidCardView {
  id: number;
  name: string;
  bossName: string;
  portrait: string; // full image url
  recommendedLevel: number;
  unlockLevel: number;
  xp: number; // the enemy's XP value (informational)
  /** XP actually on offer from this card: the enemy's `xp` if never cleared, else 0
   *  — XP is a one-time first-clear bonus (`firstTimeBeatingEnemy`). */
  firstClearXp: number;
  rewardPreview: string[];
  introText: string;
  seasonal: boolean;
  unlocked: boolean; // level met AND playable
  lockReason: string; // "" when unlocked
  minArmy: number; // zombies needed to launch (eased for the first McDonnell clears)
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
  xp: number; // XP earned — the enemy's `xp`, granted only on the FIRST clear (0 otherwise)
  loot: LootDrop[]; // item drops (with pictures)
  abilityUnlock: string; // "" unless a tier unlocked on this clear
  /** ONLINE only: the base win gold + first-clear XP the SERVER must credit — NOT
   *  applied locally (main.ts submits it to /raid/finish, which prices it from the
   *  server catalog; the balance client reconciles). Absent offline, where the base
   *  reward was credited locally like before. Bonus gold / brains / loot are always
   *  credited locally (bounded economy + inventory). */
  serverReward?: { gold: number; xp: number; survivalFrac: number };
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
  /** ONLINE: the server (POST /raid/start) already authorized this launch, so
   *  beginRaid must NOT re-run the client cooldown gate. The server owns the clock. */
  serverAuthorized?: boolean;
  /** ONLINE: the server skipped an active cooldown for this launch (a voucher use),
   *  so beginRaid consumes one Invasion Voucher to keep inventory in sync. */
  bypassed?: boolean;
  /** ONLINE: how many Golden Dice the server ACTUALLY consumed at /raid/start and pinned
   *  to the session. Its loot roll uses this, so the client must adopt it rather than
   *  spend its own (it may be fewer than `dice` asked for, if the stock ran short). */
  serverDice?: number;
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
        firstClearXp: this.state.hasClearedRaid(String(r.id)) ? 0 : r.xp,
        rewardPreview: rewardPreview(r),
        introText: r.introText.replace(/\\n/g, "\n"),
        seasonal: r.seasonal,
        unlocked: isUnlocked(r, level),
        lockReason: lockReason(r, level),
        minArmy: minArmyFor(r, this.state.raidWins(String(r.id))),
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

    const minArmy = minArmyFor(raid, this.state.raidWins(String(raid.id)));
    if (!stage || party.length < minArmy) return null;

    // ONLINE: boost COUNTS are server-owned (state.onInventory present). Consumption
    // goes through the server (optimistic decrement + reconcile) instead of mutating
    // the local list, else the next inventory sync would restore a "spent" boost.
    const online = !!this.state.onInventory;

    // Cooldown gate. ONLINE (serverAuthorized): the server already decided via
    // /raid/start — it owns the clock — and it ALSO consumed the voucher there if it
    // bypassed a cooldown, so there's nothing to spend here (main.ts refreshes the
    // inventory). OFFLINE: the client is authoritative — wait it out, or spend a
    // voucher to skip.
    if (opts.serverAuthorized) {
      if (opts.bypassed && !online) this.state.useBoost(VOUCHER_KEY);
    } else if (this.onCooldown()) {
      if (!opts.useVoucher || !this.state.useBoost(VOUCHER_KEY)) return null;
    }

    // Battle consumables — spent now that the launch is committed. Concentration
    // (fight at full focus) needs at most one; Golden Dice stack for loot luck,
    // capped by both the player's stock and the raid's rare-tier depth.
    let concentration = false;
    if (opts.serverAuthorized) concentration = !!opts.concentration;
    else if (opts.concentration && this.state.boostCount(CONCENTRATION_KEY) > 0) {
      concentration = true;
      if (online) this.state.onInventory!({ type: "use", key: CONCENTRATION_KEY }, { count: -1 });
      else this.state.useBoost(CONCENTRATION_KEY);
    }

    // Golden Dice: ONLINE the server already consumed them at /raid/start and PINNED the
    // real count to the session (its loot roll reads that, not a client claim), so take
    // its number and don't spend again — `opts.serverDice` is what it actually charged.
    // OFFLINE: spend locally as before.
    let dice = 0;
    const wantDice = Math.max(0, Math.floor(opts.dice ?? 0));
    const diceCap = Math.min(wantDice, this.diceCount(), maxLuckTiers(raid));
    if (opts.serverAuthorized) {
      dice = Math.max(0, Math.floor(opts.serverDice ?? 0));
    } else {
      for (let i = 0; i < diceCap && this.state.useBoost(DICE_KEY); i++) dice++;
    }

    // Remember the chosen attack order so the Army screen reopens with it after
    // the raid. `party` is already in launch order and filtered to live zombies.
    this.state.raidAttackOrder = party.map((z) => z.id);

    const enemyUnits = buildEnemyUnits(stage, this.assets.enemyStats, this.assets.raidAttacks);
    return {
      raid,
      party,
      playerUnits: buildPlayerUnits(party, {
        concentration,
        // Gate abilities exactly like the detail card: an ability applies only once
        // it has been unlocked (its tier's boss beaten enough times to reach it).
        abilityUnlocked: (k) => this.state.abilityUnlocked(k),
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
   *  instead and spawn on a steady cadence. Real hazard art (by raid id) is used
   *  where it ships; anything unmapped falls back to a round warning dot. */
  private hazardOf(raid: RaidDef): HazardConfig | null {
    // Ground-crossing obstacle/grab hazards are DISABLED for now — the little sprite/dot
    // sliding along the lane read as an out-of-place "ground projectile" and didn't fit the
    // scene. The mechanic (Beach crab, Tree World turtle, Lawyers/Circus grab) is preserved
    // below; flip this early-return off to bring it back once the visuals are right.
    return null;
    // eslint-disable-next-line no-unreachable
    if (raid.obstacleLimit && raid.obstacleSpawnSecs > 0) {
      return {
        limit: raid.obstacleLimit,
        spawnMs: raid.obstacleSpawnSecs * 1000,
        damage: HAZARD_DAMAGE,
        sprite: OBSTACLE_SPRITE[raid.id] ?? "",
        initial: !!raid.initialSpawnClass,
        grab: false,
      };
    }
    if (raid.hasGrab) {
      return { limit: 1, spawnMs: GRAB_SPAWN_MS, damage: 0, sprite: GRAB_SPRITE[raid.id] ?? "", initial: false, grab: true };
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
  finishRaid(
    raid: RaidDef,
    party: OwnedZombie[],
    outcome: RaidOutcome,
    dice = 0,
    serverRewards = false
  ): RaidResultView {
    // Veterancy is earned by SURVIVING a battle — credit only the units still
    // standing (drives rank-up). A unit knocked out mid-fight, even in a win, gets
    // nothing; a total loss credits no one.
    if (!serverRewards) this.zombies.recordInvasion(outcome.survivors);

    // Permanent casualties (GROUND TRUTH — raids cull the fallen; see
    // IMPLEMENTATION_RAIDS_PLAN Phase 6): every downed zombie leaves the roster for
    // good, on wins and losses alike. outcome.losses is exactly the units that died
    // (fled-but-alive zombies on a retreat are survivors, not losses). The reduced
    // roster persists via hooks.save() below.
    if (!serverRewards) this.zombies.removeCasualties(outcome.losses);

    if (!serverRewards) this.state.lastRaidAt = this.now();

    let gold = 0;
    let brains = 0;
    let xp = 0;
    const loot: LootDrop[] = [];
    let abilityUnlock = "";
    let serverReward: RaidResultView["serverReward"];
    if (outcome.win) {
      const wins = serverRewards
        ? this.state.raidWins(String(raid.id)) + 1
        : this.state.completeRaid(String(raid.id));
      // XP (GROUND TRUTH — disassembled `firstTimeBeatingEnemy` gate + "You earned
      // %ixp for beating this enemy for the first time."): the enemy's `xp` is granted
      // only on the FIRST clear of this raid; repeat wins pay gold/brains but no XP.
      // One boss enemy per raid, so first-ever win (wins === 1) IS first-time-beaten.
      if (wins === 1 && raid.xp > 0) xp = raid.xp;
      const survivalFrac = party.length ? outcome.survivors.length / party.length : 0;
      gold = winGold(raid, survivalFrac);
      // ONLINE: the base win gold + first-clear XP are SERVER-authoritative — hand
      // them off (main.ts → /raid/finish) instead of crediting locally, so the server
      // prices them and can't be out-fabricated. OFFLINE: credit locally as before.
      if (serverRewards) {
        serverReward = { gold, xp, survivalFrac };
      } else {
        if (xp > 0) this.state.addXp(xp);
        this.state.addGold(gold);
      }
      // Loot: ONE weighted drop (source `rollForDrop:`). The rarity tier is chosen
      // by rollLootTier() from the luck bracket (Golden Dice spent), then one
      // eligible alternative in that tier is picked uniformly. A "Bonus Gold" pick
      // pays extra gold (level*100) instead of an item.
      // ONLINE the SERVER rolls the drop and grants it (main.ts fills in the result from
      // /raid/finish), because a drop is real value and a client naming its own prize is a
      // mint. It was also just broken online: these local grants went through the
      // spend-only economy and the removed inventory `grant`, so loot evaporated.
      // OFFLINE: roll and grant locally, exactly as before.
      if (!serverRewards) {
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
        // ONLINE this is DEFERRED, not omitted: `win` is still client-asserted, and since
        // buying a ticket to raid again is intended play there's no bound on raid count —
        // so a server-rolled brain drop would make premium currency unlimited. It returns
        // when a win is verifiable (deterministic replay). Offline it can't be farmed for
        // anything a server would honour, so it stays faithful here.
        brains = this.rollBrainDrop(raid);
        if (brains > 0) this.state.addBrains(brains);
      }
      // Beating a tier boss unlocks ONE still-locked ability of that tier (the next
      // in canonical order) across the roster — so `wins` maps to the wins-th pool
      // entry. Once every ability in the tier is unlocked, further wins add none.
      const tier = raidTier(raid);
      if (tier > 0) {
        const pool = ABILITY_TIER[tier] ?? [];
        if (wins >= 1 && wins <= pool.length) {
          const label = ABILITY_POOL[pool[wins - 1]]?.label ?? pool[wins - 1];
          abilityUnlock = `Ability unlocked: ${label}!`;
        }
      }
    }

    this.hooks.save();

    return {
      win: outcome.win,
      title: outcome.win ? "ZOMBIES WIN" : "ZOMBIES LOSE",
      enemiesBeaten: outcome.enemiesBeaten,
      zombiesLost: outcome.losses.length,
      gold,
      brains,
      xp,
      loot,
      abilityUnlock,
      serverReward,
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
  /** Loot art for a drop the SERVER rolled (the client no longer rolls its own online,
   *  but still has to render the result). */
  lootIconFor(name: string): string {
    return this.lootIcon(name);
  }

  private lootIcon(name: string): string {
    const d = this.assets.drops[name];
    if (d && d.icon) return lootImage(d.icon);
    const b = this.assets.boosts.find((x) => x.name === name);
    if (b && b.icon) return `${BASE}assets/boosts/${b.icon}`;
    return "";
  }

  /** Headless instant-resolve: commit, resolve the fight instantly, apply rewards.
   *  Returns null if the raid can't launch. NOT player-facing — retained only for the
   *  `ZF.runRaid` dev hook and tests; the game plays raids via beginRaid + the live
   *  scene + finishRaid. */
  start(raidId: number, partyIds: string[], opts: RaidLaunchOpts = {}): RaidResultView | null {
    const setup = this.beginRaid(raidId, partyIds, opts);
    if (!setup) return null;
    const outcome = resolveRaid(setup.playerUnits, setup.enemyUnits);
    return this.finishRaid(setup.raid, setup.party, outcome, setup.dice);
  }
}
