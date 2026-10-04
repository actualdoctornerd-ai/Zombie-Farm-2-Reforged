// The Life Force panel: opened by tapping the Life Force chip in the top bar. Shows the
// farm's current level and progress, what each level gives (including the levels still
// ahead), and how to raise it.
import { openModal } from "../Modal";
import { UI } from "../uiAsset";
import {
  HARVEST_TIER_NAMES, MAX_LIFE_FORCE_LEVEL, lifeForceLevelRows, lifeForceProgress,
} from "../../lifeForce";

/** What one level adds, as short lines. Pure, so the wording is testable. */
export function levelEffectLines(row: ReturnType<typeof lifeForceLevelRows>[number]): string[] {
  const lines = [`Mutation chance ${Math.round(row.mutationChance * 100)}%`];
  if (row.safeTierGained !== null) {
    const name = HARVEST_TIER_NAMES[row.safeTierGained - 1];
    lines.push(`${name} zombies never fail to harvest`);
  }
  if (row.abilitySlotGained !== null) lines.push(`Ability slot ${row.abilitySlotGained} works`);
  if (row.level === MAX_LIFE_FORCE_LEVEL) lines.push("Maximum level");
  return lines;
}

export function openLifeForce(host: HTMLElement, total: number): void {
  const { panel } = openModal({
    host,
    bgClass: "lf-bg",
    panelClass: "lf-panel",
    replaceSelector: ".lf-bg",
  });
  const p = lifeForceProgress(total);

  const header = document.createElement("div");
  header.className = "lf-p-head";
  const leaf = document.createElement("img");
  leaf.src = UI("lifeForce.png");
  leaf.alt = "";
  const title = document.createElement("div");
  const h = document.createElement("h2");
  h.textContent = "Life Force";
  const sub = document.createElement("div");
  sub.className = "lf-p-level";
  sub.textContent = `Level ${p.level}${p.level === MAX_LIFE_FORCE_LEVEL ? " (max)" : ""}`;
  title.append(h, sub);
  header.append(leaf, title);

  const bar = document.createElement("div");
  bar.className = "lf-p-bar";
  const fill = document.createElement("div");
  fill.className = "lf-p-fill";
  fill.style.width = `${Math.round(p.progress * 100)}%`;
  bar.appendChild(fill);
  const count = document.createElement("div");
  count.className = "lf-p-count";
  count.textContent = p.next === null
    ? `${p.total.toLocaleString()} Life Force`
    : `${p.total.toLocaleString()} / ${p.next.toLocaleString()} Life Force · ${p.toNext} to level ${p.level + 1}`;

  const intro = document.createElement("div");
  intro.className = "lf-p-intro";
  intro.textContent = "Mutation chance is percent per adjacent crop.";

  // Intro and levels scroll together beneath the fixed header, so a short phone still
  // shows the levels; it opens scrolled to the player's own level.
  const levels = document.createElement("div");
  levels.className = "lf-levels";
  const base = document.createElement("div");
  base.className = `lf-row${p.level === 0 ? " lf-cur" : " lf-done"}`;
  base.innerHTML = '<div class="lf-rb">0</div><div class="lf-rbody"><div class="lf-need">Under 30 Life Force</div>'
    + "<ul><li>Mutation chance 5%</li><li>Green zombies fail 20% of harvests, higher colours more</li>"
    + "<li>No ability slots work</li></ul></div>";
  levels.appendChild(base);
  for (const row of lifeForceLevelRows()) {
    const el = document.createElement("div");
    el.className = `lf-row${row.level === p.level ? " lf-cur" : row.level < p.level ? " lf-done" : ""}`;
    const badge = document.createElement("div");
    badge.className = "lf-rb";
    badge.textContent = String(row.level);
    const body = document.createElement("div");
    body.className = "lf-rbody";
    const need = document.createElement("div");
    need.className = "lf-need";
    need.textContent = `${row.need.toLocaleString()} Life Force`;
    if (row.level === p.level) {
      const here = document.createElement("span");
      here.className = "lf-here";
      here.textContent = "You are here";
      need.appendChild(here);
    }
    const ul = document.createElement("ul");
    for (const line of levelEffectLines(row)) {
      const li = document.createElement("li");
      li.textContent = line;
      ul.appendChild(li);
    }
    body.append(need, ul);
    el.append(badge, body);
    levels.appendChild(el);
  }

  levels.prepend(intro);
  panel.append(header, bar, count, levels);
  // Open scrolled to the current level so the player lands on where they are.
  requestAnimationFrame(() => {
    const cur = levels.querySelector<HTMLElement>(".lf-cur");
    if (cur && p.level > 0) levels.scrollTop = Math.max(0, cur.offsetTop - levels.offsetTop - 8);
  });
}
