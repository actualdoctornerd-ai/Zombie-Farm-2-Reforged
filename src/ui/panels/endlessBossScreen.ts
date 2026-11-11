// The Endless boss screen (owner, 2026-11-08: every Endless screen is a rehash of an existing
// one). It is the invasion result tally that slides in from the right: the fight's loot and the
// run's gold so far, then the boon, curse and next location as Invade-list cards, Continue as
// the big button, and Reorder Army (the invasion army screen) and Go Home beside it.
import { ENDLESS_BUILD_BOONS, ENDLESS_LOCATION_NAMES, ENDLESS_MODIFIERS, isEndlessBuildBoon, type EndlessStop } from "../../raid/endless";
import { ENDLESS_LOCATION_RAID } from "../../raid/endlessLoot";
import type { Hud } from "../../hud";
import type { EndlessBossView } from "../../net/api";
import type { LootDrop } from "../../raid/RaidManager";
import { ABILITY_POOL } from "../../zombie/traits";
import { zombiePortrait } from "../../assets";

export interface EndlessBossChoices {
  boon: unknown;
  curse: unknown;
  location?: unknown;
  /** The army's new order, when the player changed it. */
  order?: string[];
}

interface Card { title: string; text: string; icon?: string }

const icon = (ability: string): string | undefined => ABILITY_POOL[ability]?.icon;

/** A boon as an Invade-list card: its name, what it does, and the ability art closest to it. */
function boonCard(choice: Record<string, unknown>): Card {
  const pct = typeof choice.percent === "number" ? `${choice.percent}%` : "";
  if (isEndlessBuildBoon(choice.kind)) {
    const boon = ENDLESS_BUILD_BOONS[choice.kind];
    const art = choice.kind.startsWith("drill-") ? "buffAllStats"
      : choice.kind === "sharp-teeth" || choice.kind === "brute-force" ? "powerBuff"
        : choice.kind === "quick-hands" || choice.kind === "frenzy" || choice.kind === "battering-ram" ? "attackSpeedBuff"
          : choice.kind === "green-thumb" ? "healAOE"
            : choice.kind === "vanguard" ? "protect"
              : choice.kind === "rearguard" ? "tankHitPointsBuff"
                : "hitPointsBuff";
    return { title: boon.name, text: boon.text, icon: icon(art) };
  }
  switch (choice.kind) {
    case "revive-headless": return { title: "Second Wind", text: "Fallen Headless zombies stand up again after each battle", icon: icon("ressurect") };
    case "deployment": return { title: "Quick Release", text: `Zombies deploy ${pct} faster (an 80% cut at most)`, icon: icon("turboSpeed") };
    case "opening-deploy": return { title: "Head Start", text: `Start every fight with ${String(choice.count)} zombies already out`, icon: icon("attachMini") };
    case "damage": return { title: "Sharpened", text: `Zombies deal ${pct} more damage`, icon: icon("powerBuff") };
    case "temporary-zombie": return {
      title: String(choice.name), text: "Joins your army for this run and walks on with your third zombie",
      icon: typeof choice.key === "string" ? zombiePortrait(choice.key) : undefined,
    };
    default: return { title: "Boon", text: String(choice.kind) };
  }
}

/** A curse as a card: what it changes about the enemies, for the rest of the run. */
function curseCard(choice: Record<string, unknown>): Card {
  const pct = typeof choice.percent === "number" ? `${choice.percent}%` : "";
  switch (choice.kind) {
    case "enemy-health": return { title: "Thick Hides", text: `Enemies have ${pct} more health` };
    case "enemy-damage": return { title: "Hard Hitters", text: `Enemies deal ${pct} more damage` };
    case "enemy-attack-speed": return { title: "Frenzied Foes", text: `Enemies attack ${pct} faster` };
    case "enemy-stun": return { title: "Dazing Blows", text: "Enemy hits can stun a zombie for a moment" };
    case "enemy-stun-resist": return { title: "Steady Feet", text: `Stuns on enemies wear off ${pct} sooner` };
    case "enemy-explosion": return { title: "Volatile Remains", text: "Some enemies explode when they fall" };
    case "enemy-knockback-headless": return { title: "Shoving Match", text: "Enemy hits can knock Headless zombies back" };
    case "headless-stat": return { title: "Weak Necks", text: `Headless zombies -${pct} ${String(choice.stat)}` };
    default: return { title: "Curse", text: String(choice.kind) };
  }
}

/** One group of choices: a heading and Invade-list cards. Nothing is picked until the player
 *  picks (owner, 2026-11-10: a pre-picked first card read as "nothing taken"); the heading then
 *  names the pick and the card wears a check. Returns the picked index, -1 for none yet. */
function cardGroup(host: HTMLElement, heading: string, cards: readonly Card[], onPick: () => void): () => number {
  const h = document.createElement("div");
  h.className = "rr-choice-h";
  const label = document.createElement("span");
  label.textContent = heading;
  const chosen = document.createElement("span");
  chosen.className = "rr-choice-picked";
  chosen.textContent = "Not chosen";
  h.append(label, chosen);
  const list = document.createElement("div");
  list.className = "rr-choices";
  let picked = -1;
  const els = cards.map((card, index) => {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "rd-card";
    if (card.icon) {
      const thumb = document.createElement("div");
      thumb.className = "rd-thumb";
      thumb.style.backgroundImage = `url(${card.icon})`;
      el.appendChild(thumb);
    }
    const txt = document.createElement("div");
    const cn = document.createElement("div");
    cn.className = "rd-cn";
    cn.textContent = card.title;
    const cl = document.createElement("div");
    cl.className = "rd-cl";
    cl.textContent = card.text;
    txt.append(cn, cl);
    el.appendChild(txt);
    el.onclick = () => {
      picked = index;
      els.forEach((other, i) => other.classList.toggle("sel", i === picked));
      chosen.textContent = `✔ ${card.title}`;
      chosen.classList.add("done");
      onPick();
    };
    list.appendChild(el);
    return el;
  });
  host.append(h, list);
  return () => picked;
}

/** The boss screen. The opening draft of a run that skipped tiers uses it too. */
export function openEndlessBossScreen(
  hud: Hud,
  view: EndlessBossView,
  onChoose: (choices: EndlessBossChoices) => void,
  onEnd: () => void,
): void {
  const raidCards = hud.getRaidCards?.() ?? [];
  const lootIcon = (item: { name: string; key?: string; kind?: string }) => hud.endlessLootIcon?.(item) ?? "";
  const loot: LootDrop[] = view.bossLoot.map((item) => ({ name: item.name, icon: lootIcon(item), qty: item.quantity }));

  const choices = document.createElement("div");
  const boons = view.bossDraft.boons as Record<string, unknown>[];
  const curses = view.bossDraft.curses as Record<string, unknown>[];
  const stops = view.bossDraft.locations as EndlessStop[];
  // Continue opens only once every group has a pick (owner, 2026-11-10).
  let go: HTMLButtonElement | null = null;
  const refresh = () => {
    const ready = boon() >= 0 && curse() >= 0 && (!where || where() >= 0);
    if (!go) return;
    go.disabled = !ready;
    go.textContent = ready ? "Continue" : where ? "Pick a boon, a curse and a location" : "Pick a boon and a curse";
  };
  const boon = cardGroup(choices, "Choose a boon", boons.map(boonCard), () => refresh());
  const curse = cardGroup(choices, "Choose a curse", curses.map(curseCard), () => refresh());
  const where = stops.length ? cardGroup(choices, "Choose where to go next", stops.map((stop) => ({
    title: ENDLESS_LOCATION_NAMES[stop.location],
    text: stop.modifier ? `${ENDLESS_MODIFIERS[stop.modifier].name}: ${ENDLESS_MODIFIERS[stop.modifier].description}` : "No modifier",
    icon: raidCards.find((card) => card.id === ENDLESS_LOCATION_RAID[stop.location])?.portrait,
  })), () => refresh()) : null;

  const startOrder = view.army.map((unit) => unit.id);
  let order = startOrder;
  // A line under the loot, in the tally's own note style: what the run has banked so far, or
  // for a skipped tier, when it pays.
  const earned = Object.entries(view.lootEarned).map(([name, quantity]) => `${name}${quantity > 1 ? ` x${quantity}` : ""}`).join(", ");
  const note = document.createElement("div");
  note.className = "rr-unlock";
  note.textContent = view.opening
    ? "This tier's loot and gold are paid when you beat your first boss."
    : earned ? `Loot so far: ${earned}` : "";
  if (note.textContent) choices.prepend(note);
  hud.openEndlessTally({
    title: view.opening ? `Skipped tier ${view.tier}` : `Tier ${view.tier} cleared!`,
    win: true,
    rows: view.opening ? [] : [["Gold so far", view.goldSoFar.toLocaleString()]],
    loot: view.opening ? [] : loot,
    lootLabel: view.opening ? undefined : "This fight",
    body: choices,
    actions: [
      {
        label: "Continue",
        ref: (button) => { go = button; refresh(); },
        onClick: () => {
          if (boon() < 0 || curse() < 0 || (where && where() < 0)) return false;
          const changed = order.some((id, index) => id !== startOrder[index]);
          onChoose({
            boon: boons[boon()], curse: curses[curse()],
            ...(where ? { location: stops[where()] } : {}),
            ...(changed ? { order } : {}),
          });
        },
      },
      {
        label: "Reorder Army",
        onClick: () => {
          hud.openEndlessOrder(view.army, order, (next) => { order = next; });
          return false; // the tally stays open under the army screen
        },
      },
      {
        label: "Go Home",
        onClick: async () => {
          const body = view.opening
            ? "You skipped ahead and have not beaten a boss yet, so this run pays nothing."
            : "You keep your loot and receive the full gold reward for every floor already cleared.";
          if (!await hud.confirmInGame("End this Endless run?", body, "Go Home")) return false;
          onEnd();
        },
      },
    ],
  });
}
