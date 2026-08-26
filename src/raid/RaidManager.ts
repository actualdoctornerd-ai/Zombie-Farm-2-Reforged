// Raid orchestration: turns the raid catalog + owned-zombie roster into the
// view-models the HUD renders, commits a raid (beginRaid) for the live scene to play
// out, and applies win rewards (finishRaid) through GameState + roster (veterancy) + save.
//
// The game ALWAYS plays raids in the live scene (beginRaid + finishRaid). `start()` is a
// headless instant-resolve (beginRaid + resolveRaid + finishRaid) retained ONLY for the
// ZF.runRaid dev hook and tests — it is not wired to any player-facing control.
import { GameAssets, zombiePortrait, raidImage, raidRewardImage } from "../assets";
import { GameState } from "../GameState";
import { ZombieField } from "../zombie/ZombieField";
import { OwnedZombie } from "../zombie/types";
import { buildEnemyUnits, buildPlayerUnits, resolveRaid } from "./CombatEngine";
import {
  bossSpecialsFor, bossThrowFor, crabFor, grabberFor, summonFor, turnedTemplateFor,
  wallTemplateFor,
} from "./fightConfig";
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
  resolveStageWave,
  boostDrops,
  seededRandom,
} from "./RaidCatalog";
import { ABILITY_TIER, ABILITY_POOL } from "../zombie/traits";
import { displayTotals } from "../zombie/statDisplay";
import { BossSpecial, BossThrowConfig, CombatUnit, CrabConfig, GrabberConfig, RaidDef, RaidOutcome, SummonConfig, WaveCadence } from "./types";
import { waveCadenceFor } from "./alienStage";
import { rollLootTier } from "./LootTable";
import { rollBrainDropWithPity, nextBrainDryStreak, brainDropChance, brainDropTable } from "./brainDrops";
import { orderPartyRoster } from "./partySelection";
import {
  rollRaidZombieDropWithPity,
  nextRaidZombieDryWins,
  hasRaidZombieDrop,
  raidZombieDropRate,
  RAID_ZOMBIE_DROPS,
} from "./zombieDrops";
import { raidBoostBundle } from "./lootBundles";
import { invasionWinXp, repeatInvasionXp } from "./repeatXp";
import {
  BRAIN_TICKET_KEY,
  ELITE_BRAIN_LUCK,
  eliteBossSpecials,
  eliteBossThrow,
  eliteProfile,
} from "./eliteInvasion";

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
  /** What a win pays once the first clear is behind you (repeatXp.ts). Shown INSTEAD of
   *  the first-clear figure on an already-cleared raid, so a card always advertises the
   *  XP the next win will actually hand over. */
  repeatXp: number;
  /** The same figure on a Brain Ticket — the elite toggle's XP side, alongside the brain
   *  odds it already advertises. */
  eliteRepeatXp: number;
  /** Brain payout odds for a boss win here: the chance of ANY brains, plus the
   *  per-stack tiers behind it. The silent dry-streak floor is not represented — it
   *  must stay invisible (see brainDrops.ts). */
  brainOdds: { chance: number; tiers: { amount: number; chance: number }[] };
  /** The same odds on a Brain Ticket (every tier x ELITE_BRAIN_LUCK) — what the elite
   *  toggle is actually buying, shown next to the ordinary figure. */
  eliteBrainOdds: { chance: number; tiers: { amount: number; chance: number }[] };
  /** The rare zombie only this raid drops, at its base (no Golden Dice) chance, and the
   *  same chance on a Brain Ticket. null for the raids that have none. */
  zombieDrop: { name: string; rate: number; eliteRate: number } | null;
  /** Boosts on this raid's loot table, with the quantity one drop pays. */
  boostDrops: { key: string; name: string; qty: number }[];
  introText: string;
  seasonal: boolean;
  unlocked: boolean; // level met AND playable
  lockReason: string; // "" when unlocked
  minArmy: number; // zombies needed to launch (eased for the first McDonnell clears)
}

export interface RaidPartyZombie {
  id: string;
  key: string;
  name: string; // individual name
  typeName: string; // species/type
  portrait: string;
  mutation: number;
  color?: [number, number, number];
  str: number;
  dex: number;
  con: number;
  focus: number;
  power: number;
  // Displayed 0–100 bars (all always-on bonuses folded in — see statDisplay.displayTotals).
  dispPower: number;
  dispSpeed: number;
  dispLife: number;
}

export interface RaidPartyView {
  /** Deployed zombies in display/auto-pick order: previous raid first, then harvest order. */
  eligible: RaidPartyZombie[];
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
  /** How many were won. Omitted (or 1) for the ordinary single drop; a bundled boost
   *  (Insta-Grow) carries its bundle size so the panel can show "x10". */
  qty?: number;
  /** Where the prize actually went, when that is not "straight onto the farm". A
   *  reward zombie earned with a full army is filed in Received and has to be
   *  claimed, and the results panel is the only place the player reliably looks —
   *  a toast fired behind this panel is not a notification. */
  note?: string;
}

/** The results-panel label for a drop: bare name, or "name x10" for a bundle. */
export function lootDropLabel(drop: LootDrop): string {
  return (drop.qty ?? 1) > 1 ? `${drop.name} x${drop.qty}` : drop.name;
}

/** The end-of-raid tally, matching the real "ZOMBIES WIN" results panel. */
export interface RaidResultView {
  win: boolean;
  title: string; // "ZOMBIES WIN" / "ZOMBIES LOSE"
  enemiesBeaten: number;
  zombiesLost: number;
  gold: number; // gold plundered
  brains: number; // brains plundered
  xp: number; // XP earned — the first-clear bonus, else the per-raid repeat trickle
  /** Whether this win was the first-ever clear of the raid, i.e. which of the two XP
   *  rules `xp` came from. Drives the result panel's label; the amounts alone can't be
   *  told apart (McDonnell's first clear is 100, an elite repeat of the Aliens is 400). */
  firstClear: boolean;
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
  /** Spend a Brain Ticket: bypasses the cooldown like a voucher, quadruples the brain
   *  and rare-zombie odds, and fights the ELITE wave (see eliteInvasion.ts). Requested
   *  by the player; whether it was actually charged is what `RaidSetup.elite` reports. */
  brainTicket?: boolean;
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
  /** ONLINE: server-pinned brain award, revealed at start for the boss-death visual
   * but credited only after the deterministic replay verifies the win. */
  serverBrainDrop?: number;
  /** ONLINE: whether the server actually charged a Brain Ticket and pinned this session
   *  as ELITE. The client must adopt this rather than its own `brainTicket` request —
   *  the pinned enemy wave is scaled (or not) to match, and a disagreement desyncs the
   *  replay from tick 0. */
  serverElite?: boolean;
  /** Seed for any per-fight randomness in the wave itself (today only the Robots'
   *  random boss — see resolveStageWave). ONLINE this MUST be the raid session id,
   *  because the server pinned its own wave from the same seed and the replay
   *  compares the two. Offline any value works; omitting it draws a fresh one. */
  waveSeed?: string;
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
  /** The alien boss's abductee queue (null if this boss can't summon). */
  summon: SummonConfig | null;
  /** How this stage feeds its wave onto the field (raid 6 is the only swarm). */
  waveCadence: WaveCadence;
  /** Blocker the boss's wall action spawns (null if it has no wall). */
  wallTemplate: CombatUnit | null;
  /** The pixel zombie the boss's turnZombie action converts a zombie into (null if it
   *  has no such action — only the Video Games boss does). */
  turnedTemplate: CombatUnit | null;
  /** Carried-grab hazard (Circus Trapeze Artist) for the live scene (null if none). */
  grabber: GrabberConfig | null;
  /** Beach crab hazard (client-only — see fightConfig.crabFor). */
  crab: CrabConfig | null;
  /** Golden Dice spent on this fight — carried into finishRaid() for loot luck. */
  dice: number;
  /** Concentration boost spent — the live scene skips the focus-bubble minigame. */
  concentration: boolean;
  /** Pre-rolled award used by both the boss-death visual and final settlement. */
  brainDrop: number;
  /** Whether this fight could pay brains at all (it fields a boss). Only such an
   *  invasion moves the silent dry-streak counter — see finishRaid. */
  brainEligible: boolean;
  /** A Brain Ticket WAS charged: the enemy line above is already scaled to this raid's
   *  elite profile, and the rare-zombie roll in finishRaid runs at elite luck. */
  elite: boolean;
}

export class RaidManager {
  constructor(
    private assets: GameAssets,
    private state: GameState,
    private zombies: ZombieField,
    private hooks: {
      save: () => void;
      grantZombie?: (key: string) => void;
      /** How many objects of a placeable key stand on the farm, for loot ownership
       *  (a placed decoration is owned even though it is no longer in any bucket). */
      placedCount?: (key: string) => number;
    },
    /** Between-invasions cooldown in ms (playtest-scaled by main.ts). */
    private cooldownMs: number = RAID_COOLDOWN_MS,
    /** Wall clock, injectable for tests. */
    private now: () => number = () => Date.now()
  ) {}

  /** Ms left on the between-invasions cooldown (0 = ready). */
  cooldownRemaining(): number {
    return Math.max(0, this.state.farmerInvasionCooldownMs(this.cooldownMs) - (this.now() - this.state.lastRaidAt));
  }
  /** Whether a cooldown is currently blocking new invasions. */
  onCooldown(): boolean {
    return this.cooldownRemaining() > 0;
  }
  /** How many Invasion Vouchers the player owns (each bypasses the cooldown). */
  voucherCount(): number {
    return this.state.boostCount(VOUCHER_KEY);
  }
  /** How many Brain Tickets the player owns (each starts one elite invasion). */
  brainTicketCount(): number {
    return this.state.boostCount(BRAIN_TICKET_KEY);
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
        repeatXp: repeatInvasionXp(r.id),
        eliteRepeatXp: repeatInvasionXp(r.id, true),
        brainOdds: {
          chance: brainDropChance(r.recommendedLevel),
          tiers: brainDropTable(r.recommendedLevel),
        },
        eliteBrainOdds: {
          chance: brainDropChance(r.recommendedLevel, ELITE_BRAIN_LUCK),
          tiers: brainDropTable(r.recommendedLevel, ELITE_BRAIN_LUCK),
        },
        zombieDrop: RAID_ZOMBIE_DROPS[r.id]
          ? {
              name: RAID_ZOMBIE_DROPS[r.id].name,
              rate: raidZombieDropRate(r.id),
              eliteRate: raidZombieDropRate(r.id, 0, ELITE_BRAIN_LUCK),
            }
          : null,
        boostDrops: boostDrops(r, this.assets.boosts),
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
    const abilityUnlocked = (k: string) => this.state.abilityUnlocked(k);
    const harvestOrdered: RaidPartyZombie[] = this.deployed()
      .map((z) => {
        const disp = displayTotals(z, abilityUnlocked);
        return {
          id: z.id,
          key: z.key,
          name: z.name,
          typeName: z.typeName,
          portrait: zombiePortrait(z.key),
          mutation: z.mutation,
          color: z.color,
          str: z.str,
          dex: z.dex,
          con: z.con,
          focus: z.focus,
          power: power(z),
          dispPower: disp.str,
          dispSpeed: disp.dex,
          dispLife: disp.con,
        };
      });
    const eligible = orderPartyRoster(harvestOrdered, this.state.raidAttackOrder);
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
    // Resolve the wave BEFORE anything reads it: a random-boss stage has no bossKey
    // until this runs, and the boss decides the throws, specials and wall below.
    const authored = fightStage(raid, this.state.level);
    const stage = authored && resolveStageWave(
      authored,
      seededRandom(opts.waveSeed ?? `${raidId}:${this.now()}:${Math.random()}`)
    );
    const byId = new Map(this.deployed().map((z) => [z.id, z]));
    const party = partyIds.map((id) => byId.get(id)).filter(Boolean) as OwnedZombie[];

    const minArmy = minArmyFor(raid, this.state.raidWins(String(raid.id)));
    if (!stage || party.length < minArmy) return null;

    // ONLINE: boost COUNTS are server-owned (state.onInventory present). Consumption
    // goes through the server (optimistic decrement + reconcile) instead of mutating
    // the local list, else the next inventory sync would restore a "spent" boost.
    const online = !!this.state.onInventory;

    // Brain Ticket. Spent BEFORE the cooldown gate, because spending it IS a cooldown
    // bypass — a player who pays 10,000 gold for an elite invasion should not also be
    // charged an Invasion Voucher for the wait it already covers.
    //
    // ONLINE the server decided at /raid/start and PINNED its enemy wave to that
    // decision, so the only safe answer here is the one it sends back: adopt
    // `serverElite`, and never scale a wave the pinned config did not.
    let elite = false;
    if (opts.serverAuthorized) {
      elite = !!opts.serverElite;
      if (elite && !online) this.state.useBoost(BRAIN_TICKET_KEY);
    } else if (opts.brainTicket && this.state.boostCount(BRAIN_TICKET_KEY) > 0) {
      elite = true;
      if (online) this.state.onInventory!({ type: "use", key: BRAIN_TICKET_KEY }, { count: -1 });
      else this.state.useBoost(BRAIN_TICKET_KEY);
    }
    const profile = eliteProfile(raid.id, elite);
    const brainLuck = elite ? ELITE_BRAIN_LUCK : 1;

    // Cooldown gate. ONLINE (serverAuthorized): the server already decided via
    // /raid/start — it owns the clock — and it ALSO consumed the voucher there if it
    // bypassed a cooldown, so there's nothing to spend here (main.ts refreshes the
    // inventory). OFFLINE: the client is authoritative — wait it out, or spend a
    // voucher (or the Brain Ticket just charged) to skip.
    if (opts.serverAuthorized) {
      // An elite launch already paid for the bypass with the ticket spent above.
      if (opts.bypassed && !elite && !online) this.state.useBoost(VOUCHER_KEY);
    } else if (this.onCooldown() && !elite) {
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

    // raidId + playerLevel drive the farm raid's enemy speed-up (see buildEnemyUnits).
    // The server's raidVerifier passes the same pair — keep them in step.
    const enemyUnits = buildEnemyUnits(stage, this.assets.enemyStats, this.assets.raidAttacks, {
      raidId: raid.id,
      playerLevel: this.state.level,
      elite: profile,
    });
    // OFFLINE the roll carries the silent pity floor (a long brain-less streak guarantees
    // the smallest stack). ONLINE the server rolls it — floor included — and pins it.
    const hasBoss = enemyUnits.some((unit) => unit.isBoss);
    const brainDrop = hasBoss
      ? opts.serverAuthorized
        ? Math.max(0, Math.floor(opts.serverBrainDrop ?? 0))
        : rollBrainDropWithPity(raid.recommendedLevel, this.state.brainDryStreak, Math.random, brainLuck)
      : 0;
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
        farmerStrengthMult: this.state.farmerZombieStrengthMult(),
        farmerLifeMult: this.state.farmerZombieLifeMult(),
      }),
      enemyUnits,
      // Elite scales the boss's whole repertoire, not just its body: heavier and (on
      // the raids whose mechanic it is) more frequent projectiles, harder specials, and
      // a tougher wall. The verifier applies the same three helpers to the same profile.
      bossThrow: eliteBossThrow(
        bossThrowFor(this.assets, raid, stage, this.state.raidWins(String(raid.id))),
        profile
      ),
      bossSpecials: eliteBossSpecials(bossSpecialsFor(this.assets, stage), profile),
      grabber: grabberFor(raid),
      crab: crabFor(raid),
      // Alien-stage divergences (raid 6 only) — see raid/alienStage.ts. The verifier
      // builds both from the same helpers, off the same elite/level context.
      waveCadence: waveCadenceFor(raid.id),
      summon: summonFor(this.assets, raid, stage, this.state.level, profile),
      wallTemplate: wallTemplateFor(this.assets, stage, profile),
      // Video Games divergence (raid 9 only) — see raid/videoGameStage.ts. Same shape as
      // the alien summon: the verifier derives it from the same helper and context.
      turnedTemplate: turnedTemplateFor(this.assets, raid, stage, this.state.level, profile),
      dice,
      concentration,
      brainDrop,
      brainEligible: hasBoss,
      elite,
    };
  }

  /** Apply the result of a played-out raid: veterancy credit, win rewards, the
   *  between-invasions cooldown, and a save. Returns the result view for the HUD.
   *  Works for both the live scene and the instant resolver. */
  finishRaid(
    raid: RaidDef,
    party: OwnedZombie[],
    outcome: RaidOutcome,
    dice = 0,
    serverRewards = false,
    brainDrop = 0,
    brainEligible = brainDrop > 0,
    /** A Brain Ticket was charged for this fight (RaidSetup.elite): the rare-zombie roll
     *  below runs at elite luck. The BRAIN award was already rolled at launch, so it does
     *  not need the flag a second time. */
    elite = false
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
    // Lifetime tally (Statistics panel). Counted here rather than beside the win
    // rewards below so a LOSS is counted too — and a retreat, which arrives as an
    // ordinary un-won outcome.
    this.state.recordRaidSettled(outcome.win);

    let gold = 0;
    let brains = 0;
    let xp = 0;
    let firstClear = false;
    const loot: LootDrop[] = [];
    let abilityUnlock = "";
    let serverReward: RaidResultView["serverReward"];
    if (outcome.win) {
      const wins = serverRewards
        ? this.state.raidWins(String(raid.id)) + 1
        : this.state.completeRaid(String(raid.id));
      // XP. The FIRST clear pays the enemy's authored `xp` (GROUND TRUTH — disassembled
      // `firstTimeBeatingEnemy` gate + "You earned %ixp for beating this enemy for the
      // first time."). One boss enemy per raid, so first-ever win (wins === 1) IS
      // first-time-beaten. Every LATER win pays the small per-raid trickle instead
      // (x4 on a Brain Ticket) — a deliberate divergence, see repeatXp.ts.
      firstClear = wins === 1;
      xp = invasionWinXp(raid.id, raid.xp, firstClear, elite);
      const survivalFrac = party.length ? outcome.survivors.length / party.length : 0;
      gold = winGold(raid, survivalFrac);
      // ONLINE: the base win gold + the win's XP (either rule) are SERVER-authoritative
      // — hand them off (main.ts → /raid/finish) instead of crediting locally, so the
      // server prices them and can't be out-fabricated. The figures here are only a
      // prediction for the result panel; the server re-derives both from the session.
      // OFFLINE: credit locally as before.
      if (serverRewards) {
        serverReward = { gold, xp, survivalFrac };
      } else {
        if (xp > 0) this.state.addXp(xp, "raid");
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
          // Bundled boosts pay their whole bundle — Insta-Grow drops ten at a time.
          const boost = this.assets.boosts.find((b) => b.name === drop);
          const qty = boost ? raidBoostBundle(boost.key) : 1;
          if (boost) this.state.addBoost(boost.key, qty);
          else this.state.receiveItem(drop);
          loot.push({ name: drop, icon: this.lootIcon(drop), qty });
        }
        // Brains drop in addition to loot. Offline credit is local; online credit is
        // applied by the server only after deterministic replay verifies the boss win.
        brains = brainDrop;
        if (brains > 0) this.state.addBrains(brains);
        // Settle the silent pity streak on the fights that could actually pay: a boss win.
        // A loss never reaches here, and a boss-less stage can't roll brains, so neither
        // charges the counter towards a guarantee it wouldn't be able to honour.
        if (brainEligible) this.state.brainDryStreak = nextBrainDryStreak(this.state.brainDryStreak, brains);
        // The rare zombie carries its own silent per-raid pity: enough dry wins of THIS raid
        // and the next one hands it over outright (see zombieDrops.ts). Streak settles on
        // every win of a raid that has one; raids without a rare zombie never get a key.
        const dryKey = String(raid.id);
        // `dice` — the Golden Dice spent on this fight — widens the rare-zombie chance the
        // same way it shifts the item roll's tier, and an elite (Brain Ticket) run
        // multiplies it again by ELITE_BRAIN_LUCK.
        const zombieDrop = rollRaidZombieDropWithPity(
          raid.id, true, Math.random(), this.state.zombieDryWins[dryKey] ?? 0, dice,
          elite ? ELITE_BRAIN_LUCK : 1
        );
        if (hasRaidZombieDrop(raid.id)) {
          this.state.zombieDryWins[dryKey] = nextRaidZombieDryWins(this.state.zombieDryWins[dryKey] ?? 0, !!zombieDrop);
        }
        if (zombieDrop) {
          this.hooks.grantZombie?.(zombieDrop.key);
          loot.push({ name: zombieDrop.name, icon: zombiePortrait(zombieDrop.key) });
        }
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
      firstClear,
      loot,
      abilityUnlock,
      serverReward,
    };
  }

  /** Roll a single item drop for a win (source `rollForDrop:` + `lootTableFromCategory:`).
   *  Picks a rarity tier from the luck bracket, then a uniform eligible alternative
   *  within it. Eligibility drops `unique` items already owned and `limit`-capped
   *  items at their cap. If the chosen tier has no eligible items, the roll walks
   *  DOWN to commoner tiers (as the binary does). Returns null if nothing is
   *  eligible (e.g. every tier already collected). */
  private rollLoot(raid: RaidDef, bonus: number): string | null {
    // Owned = unclaimed raid loot + the shed + the object it becomes once PLACED
    // (`drops.json` tile → hooks.placedCount). All three matter: claiming a drop is how
    // it gets used and that empties Received, so counting anything less puts a `unique`
    // straight back on the table the moment the player takes it. Matches the source's
    // `doesOwnItem:` and the server's ownedLootCounter.
    const ownedCount = (name: string): number => {
      let n = this.state.received.filter((r) => r === name).length;
      n += this.state.storedItems.find((s) => s.key === name)?.count ?? 0;
      const tile = this.assets.drops[name]?.tile;
      if (tile) n += this.hooks.placedCount?.(tile) ?? 0;
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
    return raidRewardImage(this.assets, name);
  }

  /** Headless instant-resolve: commit, resolve the fight instantly, apply rewards.
   *  Returns null if the raid can't launch. NOT player-facing — retained only for the
   *  `ZF.runRaid` dev hook and tests; the game plays raids via beginRaid + the live
   *  scene + finishRaid. */
  start(raidId: number, partyIds: string[], opts: RaidLaunchOpts = {}): RaidResultView | null {
    const setup = this.beginRaid(raidId, partyIds, opts);
    if (!setup) return null;
    const outcome = resolveRaid(setup.playerUnits, setup.enemyUnits);
    return this.finishRaid(
      setup.raid, setup.party, outcome, setup.dice, false,
      setup.brainDrop, setup.brainEligible, setup.elite
    );
  }
}
