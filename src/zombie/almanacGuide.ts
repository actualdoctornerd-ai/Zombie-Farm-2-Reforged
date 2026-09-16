// The Zombie Almanac's field notes: the three long explanations a per-entry
// obtain hint has no room for.
//
// An Almanac hint is one line ("Rarely found after winning an invasion of X"),
// which is enough to point at a source but not enough to explain a SYSTEM. Three
// of them needed the room: the Zombie Pot (the only way to breed a species you
// cannot buy), Brain Tickets (what an elite invasion costs and pays), and the
// Epic Boss events (the entire Epic group's source).
//
// Pure data, no DOM — the panel renders it (ui/panels/zombies.ts) and the numbers
// come from the same constants the mechanics themselves read, so a balance change
// cannot leave the guide quietly lying. Facts the catalog owns (Market prices, the
// event lineup) are injected by main.ts, which is the only place assets are loaded.
//
// NOTHING HERE MAY DESCRIBE THE PITY FLOORS. The dry-streak guarantees in
// raid/brainDrops.ts and raid/zombieDrops.ts are deliberately invisible — a floored
// drop must be indistinguishable from a lucky one — so the guide talks about odds
// and never about a count of wins that earns something.
import { COMBINE_SPECIAL_BY_GROUP, COMBINE_SPECIAL_CHANCE, COMBINE_SPECIAL_LEVEL } from "./combineSpecies";
import { MONOLITH_MULT, POT_DURATION_MS } from "./ZombiePot";
import { MAX_ZOMBIE_POTS } from "../placementLimit";
import { ELITE_BRAIN_LUCK } from "../raid/eliteInvasion";
import { ZOMBIE_LUCK_PER_DIE } from "../raid/zombieDrops";
import { EPIC_BOSS_FIGHT_BRAIN_COST } from "../epicBoss/tokens";

/** One field-note topic: a chip in the Almanac header that opens a read-only page. */
export interface AlmanacGuideTopic {
  id: "pot" | "ticket" | "epic";
  title: string;
  /** One line, shown on the chip itself. */
  blurb: string;
  /** The page body, one paragraph per entry. Plain text — the panel adds the markup. */
  paragraphs: string[];
}

/** Catalog-owned numbers the guide quotes. Each is optional: a build whose assets
 *  have not loaded (or a future catalog that drops one of these) simply omits the
 *  sentence rather than printing "undefined gold". */
export interface AlmanacGuideFacts {
  /** The Brain Ticket's Market listing (assets.boosts). */
  brainTicket?: { cost: number; level: number } | null;
  /** The Epic Boss lineup, summarised: how many events, the player-level band they
   *  unlock across, the brains they cost to activate, ladder length and run length. */
  epic?: {
    count: number;
    firstLevel: number;
    lastLevel: number;
    minBrains: number;
    maxBrains: number;
    rungs: number;
    days: number;
  } | null;
  /** Invasions that can drop a rare zombie at all, by name (raid/zombieDrops). */
  rareZombieRaids?: readonly string[];
  /** Display name for a species key — names the six Pot tier-5 Specials. */
  speciesName?: (key: string) => string | undefined;
}

const minutes = (ms: number) => Math.round(ms / 60_000);

/** English list: "a, b and c". */
const listOf = (items: readonly string[]): string =>
  items.length <= 1
    ? items[0] ?? ""
    : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;

/** The six tier-5 Specials the Pot can promote to, named where the catalog is
 *  available and keyed otherwise (the key is never shown — an empty list just
 *  drops the clause). */
function potSpecialNames(speciesName?: (key: string) => string | undefined): string[] {
  if (!speciesName) return [];
  return Object.values(COMBINE_SPECIAL_BY_GROUP)
    .map((key) => speciesName(key))
    .filter((name): name is string => !!name);
}

function potTopic(facts: AlmanacGuideFacts): AlmanacGuideTopic {
  const specials = potSpecialNames(facts.speciesName);
  const chance = Math.round(COMBINE_SPECIAL_CHANCE * 100);
  return {
    id: "pot",
    title: "The Zombie Pot",
    blurb: "Combine two zombies — the only way to breed a species the Market will not sell you.",
    paragraphs: [
      `Tap a placed Zombie Pot and pick two of your zombies. Both are consumed the moment ` +
        `the combine starts — they leave your army immediately — and the one zombie they ` +
        `become is ready ${minutes(POT_DURATION_MS)} minutes later, or ` +
        `${minutes(POT_DURATION_MS * MONOLITH_MULT)} minutes if a Clay Monolith stands on ` +
        `the farm. You can own ${MAX_ZOMBIE_POTS} pots, and each cooks its own combine, so ` +
        `three can run at once. A combine finishes while the game is closed.`,

      `Slot 1 decides what comes out. Whatever you put in the first slot is the species ` +
        `you get back, along with its name — so treat slot 2 as the donor: its mutations ` +
        `and its colour come along, its species does not.`,

      `Mutations stack per body part. Any mutation the input zombies do not both occupy carries ` +
        `over to the new zombie; where two land on the same part, the higher-tier one wins. ` +
        `There is no roll in this — the two zombies of the same type always breed the same type, ` +
        `with the following exceptions `,

      `TO BREED A NEW SPECIES, put in two of the SAME species. A matched pair climbs a ` +
        `colour instead of copying slot 1: two Greens breed into their body type's Blue ` +
        `once a Blue Grave is on the farm, two Blues into its Red once a Red Grave is, and ` +
        `two Reds into its Silver from player level ${COMBINE_SPECIAL_LEVEL}. A step whose ` +
        `grave you do not own simply does nothing, so nothing is wasted by trying early.`,

      `From level ${COMBINE_SPECIAL_LEVEL}, any pair that is not already a named Special ` +
        `also has a ${chance}% chance to jump straight to slot 1's body type Special` +
        (specials.length ? ` — ${listOf(specials)}` : "") +
        `.The jump is rolled after the colour step, so a Green or Blue matched pair ` +
        `climbs its ladder rung first rather than leaping past it.`,

      `Named Specials are the one restriction. One can only go in slot 1, where it is ` +
        `always inherited, and two of them cannot be combined at all.`,
    ],
  };
}

function ticketTopic(facts: AlmanacGuideFacts): AlmanacGuideTopic {
  const ticket = facts.brainTicket;
  const raids = facts.rareZombieRaids ?? [];
  return {
    id: "ticket",
    title: "Brain Tickets",
    blurb: `Turn one invasion elite: ${ELITE_BRAIN_LUCK}x the brains and ${ELITE_BRAIN_LUCK}x the rare-zombie odds.`,
    paragraphs: [
      `A Brain Ticket is a consumable from the Market's Boosts tab` +
        (ticket ? `, ${ticket.cost.toLocaleString()} gold, unlocked at player level ${ticket.level}` : "") +
        `. Spend it when you launch an invasion.`,

      `It does what an Invasion Voucher does — skips the wait between invasions — and then ` +
        `multiplies that fight's brain drop odds and its rare-zombie drop rate by ` +
        `${ELITE_BRAIN_LUCK}. It is by far the strongest thing you can do to a single ` +
        `invasion's payout.`,

      `The difficulty is the price. A ticketed invasion turns ELITE: same enemies, same ` +
        `wave size, same gold and the same item loot table, but their damage, hit points ` +
        `and attack speed are all scaled up. Each invasion is scaled its own way — the ` +
        `Pirates hit harder, the Lawyers get faster, the Circus throws far more — so an ` +
        `elite run feels like more of that invasion rather than a flat difficulty slider. ` +
        `Take your strongest army; losing the fight spends the ticket for nothing.`,

      `Six invasions have a SECOND, rarer zombie that only a ticket can pay — the Sheriff ` +
        `behind the Deputy, the Master Ninjombie behind the Ninjombie, and so on. An elite ` +
        `win rolls for both: the ordinary zombie at the ${ELITE_BRAIN_LUCK}x above, and the ` +
        `rarer one on its own roll at a lower rate. You keep whichever lands, the rarer one ` +
        `first — so a ticket is the best way to win either half of the pair.`,

      `Golden Dice stack on top. Each die spent on the fight adds another ` +
        `${Math.round(ZOMBIE_LUCK_PER_DIE * 100)}% of the raid's base rare-zombie rate, and ` +
        `the elite multiplier applies to that total — so dice and a ticket on the same ` +
        `invasion are the best rare-zombie odds in the game.`,

      raids.length
        ? `Only some invasions have a rare zombie to win: ${listOf([...raids])}. Those are ` +
          `the runs worth a ticket if you are filling the Almanac rather than farming brains.`
        : `Only some invasions have a rare zombie to win — their Almanac entries name them.`,

      `You do not have to buy them. Every rung of an Epic Boss ladder can drop a Brain ` +
        `Ticket, more often the deeper the rung, and clearing the final rung always does.`,
    ],
  };
}

function epicTopic(facts: AlmanacGuideFacts): AlmanacGuideTopic {
  const epic = facts.epic;
  const cost = epic
    ? epic.minBrains === epic.maxBrains
      ? `${epic.minBrains} brains`
      : `${epic.minBrains}-${epic.maxBrains} brains`
    : "a few brains";
  return {
    id: "epic",
    title: "Epic Zombies",
    blurb: "The Almanac's Epic group — timed boss events, the only source for those species.",
    paragraphs: [
      `The Almanac's Epic group is filed apart from the rest because it has one source ` +
        `nothing else shares. These zombies are not sold, not grown, not dropped by ` +
        `invasions and not produced by the Pot — an Epic Boss event is the only way any of ` +
        `them enters your farm.`,

      `Activate an event from the Market's Epic Boss tab for ${cost}` +
        (epic ? `. There are ${epic.count}, unlocking between player level ${epic.firstLevel} ` +
          `and ${epic.lastLevel} — the later the event, the stronger the zombies it pays out` : "") +
        `. Only one runs at a time` +
        (epic ? `, and a run lasts ${epic.days} days` : "") + `.`,

      `An event is a ladder of ${epic?.rungs ?? 10} rungs: beat the boss and it returns at ` +
        `the next rung with more life. Each attempt costs one Boss Token or ` +
        `${EPIC_BOSS_FIGHT_BRAIN_COST} brain if you have none. Tokens come from farming — ` +
        `every crop harvest has a chance to turn one up — so the way to fight an event ` +
        `often is to keep the farm busy while it runs.`,

      `Most bosses pay out two zombies: a signature one partway up the ladder, and its ` +
        `upgraded form (the Omega, the Admiral, the Madame) for clearing the top. The ` +
        `event's own card lists which rung each one lands on. A cleared rung also pays ` +
        `gold, and can drop event decor, a brain or a Brain Ticket.`,

      `Ladder progress is LIFETIME. If a run expires before you finish, the rungs you ` +
        `cleared stay cleared, and the next activation of that boss picks up where you ` +
        `stopped. Re-activating also re-opens the milestones you already completed, so a ` +
        `signature zombie can be earned more than once — one is not your only chance at it.`,

      `If your farm is at its zombie cap when a prize is won, it is not lost: it waits in ` +
        `Received until you have room to claim it.`,
    ],
  };
}

/** The Almanac's three field-note topics, in the order the header shows them:
 *  the Pot first (it is the one the player acts on today), then the Brain Ticket,
 *  then the Epic events. */
export function almanacGuide(facts: AlmanacGuideFacts = {}): AlmanacGuideTopic[] {
  return [potTopic(facts), ticketTopic(facts), epicTopic(facts)];
}
