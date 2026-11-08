import { ENDLESS_MODIFIERS, endlessStopLabel, type EndlessStop } from "../../raid/endless";
import type { Hud } from "../../hud";
import type { EndlessBossView } from "../../net/api";
import { openModal } from "../Modal";

export interface EndlessBossChoices {
  boon: unknown;
  curse: unknown;
  location?: unknown;
  /** The army's new order, when the player changed it. */
  order?: string[];
}

function describeChoice(choice: unknown): string {
  if (!choice || typeof choice !== "object") return String(choice);
  const value = choice as Record<string, unknown>;
  const pct = typeof value.percent === "number" ? ` ${value.percent}%` : "";
  switch (value.kind) {
    case "revive-headless": return "Revive fallen headless zombies after each battle";
    case "damage": return `Zombies deal${pct} more damage`;
    case "deployment": return `Zombies deploy${pct} faster`;
    case "opening-deploy": return `Start with ${value.count} zombies deployed`;
    case "vanguard": return "Your first 3 zombies get 50% more health, the rest 10% less";
    case "rearguard": return "Your last 5 zombies deal 40% more damage, the rest 10% less";
    case "headless-wall": return "Headless zombies get 40% more health, the rest deal 10% less damage";
    case "garden-focus": return "Garden zombies get 60% more health, the rest deal 5% less damage";
    case "temporary-zombie": return `${String(value.name)} joins your army for this run`;
    case "enemy-health": return `Enemies have${pct} more health`;
    case "enemy-damage": return `Enemies deal${pct} more damage`;
    case "enemy-attack-speed": return `Enemies attack${pct} faster`;
    case "enemy-stun": return "Enemies can stun zombies on hit";
    case "enemy-stun-resist": return `Stuns on enemies are${pct} shorter`;
    case "enemy-explosion": return "Some enemies explode when defeated";
    case "enemy-knockback-headless": return "Enemies can knock back headless zombies";
    case "headless-stat": return `Headless zombies have${pct} less ${String(value.stat)} power`;
    case undefined: {
      const stop = value as unknown as EndlessStop;
      return stop.modifier
        ? `${endlessStopLabel(stop)}: ${ENDLESS_MODIFIERS[stop.modifier].description}`
        : endlessStopLabel(stop);
    }
    default: return String(value.kind ?? "Choice");
  }
}

function lootLine(totals: Readonly<Record<string, number>>): string {
  return Object.entries(totals).map(([name, quantity]) => `${name}${quantity > 1 ? ` ×${quantity}` : ""}`).join(", ");
}

/** A column of tappable options, one always picked. Full text, so nothing clips on a phone. */
function optionGroup(host: HTMLElement, label: string, options: readonly unknown[]): () => unknown {
  const heading = document.createElement("div");
  heading.className = "endless-choice-heading";
  heading.textContent = label;
  host.appendChild(heading);
  let picked = 0;
  const rows = options.map((option, index) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "endless-choice-option";
    row.textContent = describeChoice(option);
    row.onclick = () => {
      picked = index;
      rows.forEach((other, i) => other.classList.toggle("selected", i === picked));
    };
    host.appendChild(row);
    return row;
  });
  rows[0]?.classList.add("selected");
  return () => options[picked];
}

/** Move the zombies brought on this run around, and nothing else: no roster, no Mausoleum. */
function openReorder(hud: Hud, army: EndlessBossView["army"], order: string[], onDone: (order: string[]) => void): void {
  const { panel, close } = openModal({
    host: hud.el,
    bgClass: "raid-bg endless-order-bg",
    panelClass: "endless-order-panel",
    title: "Army order",
    replaceSelector: ".endless-order-bg",
  });
  const names = new Map(army.map((unit) => [unit.id, unit.name]));
  const working = [...order];
  const list = document.createElement("div");
  list.className = "endless-order-list";
  const render = () => {
    list.replaceChildren();
    working.forEach((id, index) => {
      const row = document.createElement("div");
      row.className = "endless-order-row";
      const name = document.createElement("span");
      name.textContent = `${index + 1}. ${names.get(id) ?? "Zombie"}`;
      const move = (label: string, by: number) => {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = label;
        button.disabled = index + by < 0 || index + by >= working.length;
        button.onclick = () => {
          [working[index], working[index + by]] = [working[index + by], working[index]];
          render();
        };
        return button;
      };
      row.append(name, move("▲", -1), move("▼", 1));
      list.appendChild(row);
    });
  };
  render();
  const done = document.createElement("button");
  done.type = "button";
  done.className = "btn-primary";
  done.textContent = "Done";
  done.onclick = () => { onDone(working); close(); };
  panel.append(list, done);
}

/** The one screen between tiers: boons, curses, where next, the loot so far and the way home.
 *  The opening draft of a run that skipped tiers uses it too. */
export function openEndlessBossScreen(
  hud: Hud,
  view: EndlessBossView,
  onChoose: (choices: EndlessBossChoices) => void,
  onEnd: () => void,
): void {
  const bg = document.createElement("div");
  bg.className = "panelbg raid-bg";
  const panel = document.createElement("div");
  panel.className = "panel endless-boss-panel";
  const title = document.createElement("h2");
  title.textContent = view.opening ? `Skipped T${view.tier} · build your run` : `T${view.tier} boss defeated`;
  panel.appendChild(title);

  if (!view.opening) {
    const earned = document.createElement("p");
    earned.className = "endless-boss-earned";
    const loot = lootLine(view.lootEarned);
    earned.textContent = `Earned so far: ${view.goldSoFar.toLocaleString()} gold${loot ? `, ${loot}` : ""}`;
    panel.appendChild(earned);
    const thisFight = Object.fromEntries(view.bossLoot.map((item) => [item.name, item.quantity]));
    if (view.bossLoot.length) {
      const note = document.createElement("p");
      note.textContent = `From this fight: ${lootLine(thisFight)}`;
      panel.appendChild(note);
    }
  } else {
    const note = document.createElement("p");
    note.textContent = "Skipped tiers pay their loot and gold once you beat your first boss.";
    panel.appendChild(note);
  }

  const choices = document.createElement("div");
  choices.className = "endless-boss-choices";
  panel.appendChild(choices);
  const boon = optionGroup(choices, "Boon", view.bossDraft.boons);
  const curse = optionGroup(choices, "Curse", view.bossDraft.curses);
  const location = view.bossDraft.locations.length ? optionGroup(choices, "Next location", view.bossDraft.locations) : null;

  const startOrder = view.army.map((unit) => unit.id);
  let order = startOrder;
  const actions = document.createElement("div");
  actions.className = "endless-boss-actions";
  const reorder = document.createElement("button");
  reorder.type = "button";
  reorder.className = "btn-secondary";
  reorder.textContent = "Reorder Army";
  reorder.onclick = () => openReorder(hud, view.army, order, (next) => { order = next; });
  const go = document.createElement("button");
  go.type = "button";
  go.className = "btn-primary";
  go.textContent = "Continue";
  go.onclick = () => {
    bg.remove();
    const changed = order.some((id, index) => id !== startOrder[index]);
    onChoose({
      boon: boon(), curse: curse(),
      ...(location ? { location: location() } : {}),
      ...(changed ? { order } : {}),
    });
  };
  const home = document.createElement("button");
  home.type = "button";
  home.className = "btn-secondary";
  home.textContent = "Go Home";
  home.onclick = async () => {
    const body = view.opening
      ? "You skipped ahead and have not beaten a boss yet, so this run pays nothing."
      : "You keep your loot and receive the full gold reward for every floor already cleared.";
    if (!await hud.confirmInGame("End this Endless run?", body, "Go Home")) return;
    bg.remove();
    onEnd();
  };
  actions.append(go, reorder, home);
  panel.appendChild(actions);
  bg.appendChild(panel);
  hud.el.appendChild(bg);
}
