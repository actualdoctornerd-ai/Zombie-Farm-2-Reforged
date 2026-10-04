// The invasion DROP TABLE: opened from the "Drop table" button on an invasion's detail
// pane. Lists everything a win can pay with its odds — the gold and XP, the single item
// drop by rarity tier, the separate-roll banners, brains (ordinary and Brain Ticket), the
// rare zombie and the boss statues — and lets the player flip the Golden Dice count to see
// how luck shifts it. The numbers come from raid/dropTable.ts; this file only draws them.
//
// The brain / rare-zombie dry-streak floors are NOT shown, on purpose (brainDrops.ts).
import { openModal } from "../Modal";
import type { RaidCardView } from "../../raid/RaidManager";
import { ELITE_BRAIN_LUCK } from "../../raid/eliteInvasion";
import { acceptsBrainTicket } from "../../raid/dualInvasion";
import { firstClearBrains } from "../../raid/brainDrops";
import { raidZombieDropRate } from "../../raid/zombieDrops";
import {
  LOOT_TIER_LABELS, formatOdds, itemLootTable, statueRule, type LootRow,
} from "../../raid/dropTable";

/** "Insta-Grow ×10", "Bonus Gold (900 gold)", or just the name. */
function rowLabel(row: LootRow): string {
  if (row.name === "Bonus Gold") return `Bonus Gold (${row.qty.toLocaleString()} gold)`;
  return row.qty > 1 ? `${row.name} ×${row.qty}` : row.name;
}

function line(label: string, value: string, cls = ""): HTMLElement {
  const row = document.createElement("div");
  row.className = `dt-row ${cls}`.trim();
  const k = document.createElement("span");
  k.className = "dt-k";
  k.textContent = label;
  const v = document.createElement("span");
  v.className = "dt-v";
  v.textContent = value;
  row.append(k, v);
  return row;
}

function section(title: string, note?: string): HTMLElement {
  const sec = document.createElement("section");
  sec.className = "dt-sec";
  const h = document.createElement("h3");
  h.textContent = title;
  sec.appendChild(h);
  if (note) {
    const p = document.createElement("p");
    p.className = "dt-note";
    p.textContent = note;
    sec.appendChild(p);
  }
  return sec;
}

export function openDropTable(host: HTMLElement, card: RaidCardView): void {
  const { panel } = openModal({
    host,
    bgClass: "dt-bg",
    panelClass: "dt-panel",
    replaceSelector: ".dt-bg",
  });
  const lt = card.lootTable;

  const head = document.createElement("div");
  head.className = "dt-head";
  const h = document.createElement("h2");
  h.textContent = `${card.name} — drop table`;
  const sub = document.createElement("div");
  sub.className = "dt-sub";
  sub.textContent = "Everything a win can pay. Odds are per win.";
  head.append(h, sub);

  const body = document.createElement("div");
  body.className = "dt-body";
  let dice = 0;

  const render = () => {
    body.innerHTML = "";

    // ---- gold + XP: certain, not rolled -----------------------------------------------
    const base = section("Every win");
    base.appendChild(line("Gold", `up to ${lt.winGold.toLocaleString()} — less for each zombie lost`));
    base.appendChild(line("XP", card.firstClearXp > 0
      ? `${card.xp.toLocaleString()} the first time, then ${card.repeatXp.toLocaleString()} per win`
      : `${card.repeatXp.toLocaleString()} per win`));
    body.appendChild(base);

    // ---- luck selector ------------------------------------------------------------------
    if (lt.maxDice > 0) {
      const luck = document.createElement("div");
      luck.className = "dt-luck";
      const label = document.createElement("span");
      label.textContent = "Golden Dice spent:";
      luck.appendChild(label);
      for (let n = 0; n <= lt.maxDice; n++) {
        const b = document.createElement("button");
        b.className = "dt-die" + (n === dice ? " sel" : "");
        b.textContent = String(n);
        b.onclick = () => { dice = n; render(); };
        luck.appendChild(b);
      }
      body.appendChild(luck);
    }

    // ---- the item roll ------------------------------------------------------------------
    const items = itemLootTable({
      loot: lt.tiers,
      dice,
      extraRateOf: (name) => lt.extraRates[name] ?? 0,
      bundleOf: (name) => lt.bundles[name] ?? 1,
      bonusGold: lt.bonusGold,
    });
    const loot = section("Item drop", "One roll per win: a rarity tier first, then one item inside it.");
    for (const tier of items.tiers) {
      const t = document.createElement("div");
      t.className = "dt-tier";
      t.appendChild(line(LOOT_TIER_LABELS[tier.tier] ?? `Tier ${tier.tier + 1}`, formatOdds(tier.chance), "dt-tier-h"));
      for (const row of tier.rows) t.appendChild(line(rowLabel(row), formatOdds(row.chance), "dt-item"));
      loot.appendChild(t);
    }
    body.appendChild(loot);

    if (items.extras.length) {
      const extra = section("Also drops", "Rolled separately, on top of the item above.");
      for (const row of items.extras) extra.appendChild(line(rowLabel(row), formatOdds(row.chance), "dt-item"));
      body.appendChild(extra);
    }

    // ---- brains -------------------------------------------------------------------------
    const ticket = acceptsBrainTicket(card.id);
    const brains = section(
      "Brains",
      "Only a boss win can pay these. Tiers roll rarest first; the first hit pays.",
    );
    const brainFirst = firstClearBrains(card.unlockLevel);
    brains.appendChild(line("First clear", `${brainFirst} ${brainFirst === 1 ? "brain" : "brains"}, guaranteed`));
    const ticketBy = new Map(card.eliteBrainOdds.tiers.map((t) => [t.amount, t.chance]));
    for (const t of card.brainOdds.tiers) {
      const tk = ticketBy.get(t.amount);
      brains.appendChild(line(
        `${t.amount} ${t.amount === 1 ? "brain" : "brains"}`,
        formatOdds(t.chance) + (ticket && tk !== undefined ? `  ·  ${formatOdds(tk)} with a Brain Ticket` : ""),
        "dt-item",
      ));
    }
    brains.appendChild(line(
      "Any brains",
      formatOdds(card.brainOdds.chance) +
        (ticket ? `  ·  ${formatOdds(card.eliteBrainOdds.chance)} with a Brain Ticket` : ""),
      "dt-sum",
    ));
    body.appendChild(brains);

    // ---- rare zombie --------------------------------------------------------------------
    if (card.zombieDrop) {
      const z = card.zombieDrop;
      const rare = section("Rare zombie", "Golden Dice raise this chance too.");
      rare.appendChild(line(z.name, formatOdds(raidZombieDropRate(card.id, dice)), "dt-item"));
      if (ticket) {
        const promoted = z.eliteName !== z.name;
        rare.appendChild(line(
          `${z.name} (Brain Ticket)`,
          formatOdds(raidZombieDropRate(card.id, dice, ELITE_BRAIN_LUCK, false)),
          "dt-item",
        ));
        if (promoted) {
          rare.appendChild(line(
            `${z.eliteName} (Brain Ticket)`,
            formatOdds(raidZombieDropRate(card.id, dice, ELITE_BRAIN_LUCK, true)),
            "dt-item",
          ));
        }
      }
      body.appendChild(rare);
    }

    // ---- boss statues -------------------------------------------------------------------
    const statue = statueRule(card.id);
    if (statue) {
      const s = section(
        "Boss statues",
        "A statue takes the place of that win's item drop, and is a milestone reward.",
      );
      s.appendChild(line(statue.name, `win #${statue.stoneWins}, then ${formatOdds(statue.stoneRate)} per win`, "dt-item"));
      s.appendChild(line(statue.goldenName, `win #${statue.goldenWins}, then ${formatOdds(statue.goldenRate)} per win`, "dt-item"));
      body.appendChild(s);
    }

    const foot = document.createElement("p");
    foot.className = "dt-note dt-foot";
    foot.textContent =
      "Item odds assume a farm that owns none of them yet. A decoration you already own " +
      "that can't be had twice drops out, and its share goes to the tier's other items.";
    body.appendChild(foot);
  };

  render();
  panel.append(head, body);
}
