import { t as tr } from "../../i18n";
// The Statistics panel: the account's lifetime tally, opened from the Account menu.
//
// Rendering only. Every figure — and every word of every label — arrives already
// resolved from buildStatsView (src/statsView.ts), so this file never does
// arithmetic and never has to know what a crop key means.
import { openModal } from "../Modal";
import type { StatSection } from "../../statsView";

export function openStats(host: HTMLElement, sections: StatSection[]): void {
  const { panel } = openModal({
    host,
    bgClass: "stats-bg",
    panelClass: "stats-panel",
    title: tr("Statistics"),
    replaceSelector: ".stats-bg",
  });

  const body = document.createElement("div");
  body.className = "stats-body";

  for (const section of sections) {
    const block = document.createElement("section");
    block.className = "stats-section";
    const heading = document.createElement("h3");
    heading.className = "stats-heading";
    heading.textContent = tr(section.title);
    block.appendChild(heading);
    for (const row of section.rows) {
      const line = document.createElement("div");
      line.className = "stats-row";
      const label = document.createElement("span");
      label.className = "stats-label";
      label.textContent = tr(row.label);
      const right = document.createElement("span");
      right.className = "stats-figure";
      const value = document.createElement("span");
      value.className = "stats-value";
      value.textContent = row.value;
      right.appendChild(value);
      if (row.note) {
        const note = document.createElement("span");
        note.className = "stats-note";
        note.textContent = tr(row.note);
        right.appendChild(note);
      }
      line.append(label, right);
      block.appendChild(line);
    }
    body.appendChild(block);
  }

  panel.appendChild(body);
}
