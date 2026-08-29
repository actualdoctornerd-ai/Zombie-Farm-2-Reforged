// The friend leaderboard (Social → Leaderboard): you + your accepted friends,
// ranked by one stat at a time — Level plus the Statistics panel's headline
// counters. Rendering only: the ordering lives in social/leaderboard.ts
// (rankLeaderboard) and every number arrives already projected by the server
// (GET /leaderboard/friends), so this file never does arithmetic. The panel only
// ever asks the Hud hooks for things; the server call lives in main.ts.
//
// Fun-only, like the direction says: every column except Level is the
// client-authored lifetime tally, shown only to accepted friends. Nobody's
// rewards read these numbers back.
import type { Hud } from "../../hud";
import { openModal } from "../Modal";
import type { FriendLeaderboardEntry } from "../../net/api";
import {
  LEADERBOARD_CATEGORIES, rankLeaderboard, type LeaderboardCategory,
} from "../../social/leaderboard";
import { formatCount } from "../../statsView";
import { BASE } from "../../base";

/** Medal for a podium rank; every other rank prints as "#n". */
const medal = (rank: number): string =>
  rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : `#${rank}`;

export function openLeaderboardPanel(hud: Hud): void {
  const { panel } = openModal({
    host: hud.el, bgClass: "lb-bg", panelClass: "lb-panel",
    title: "Leaderboard", replaceSelector: ".lb-bg",
  });

  // Signed out: the board is account state, so mirror the Friends panel's gate —
  // say why it's empty and offer the same sign-in button, not a bare error.
  if (!(hud.socialOnline?.() ?? false)) {
    const prompt = document.createElement("div");
    prompt.className = "lb-signin";
    prompt.textContent = "Sign in to see how you rank among your friends:";
    const mount = document.createElement("div");
    mount.className = "fr-gsi";
    panel.append(prompt, mount);
    hud.renderAuthButton?.(mount);
    return;
  }

  const chips = document.createElement("div");
  chips.className = "lb-chips";
  const status = document.createElement("div");
  status.className = "lb-status";
  const list = document.createElement("div");
  list.className = "prof-list lb-list";
  panel.append(chips, status, list);

  let category: LeaderboardCategory = LEADERBOARD_CATEGORIES[0];
  /** Null until the fetch lands (or fails — `failed` tells the two apart). */
  let entries: FriendLeaderboardEntry[] | null = null;
  let failed = false;

  const renderChips = () => {
    chips.replaceChildren();
    for (const c of LEADERBOARD_CATEGORIES) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "lb-chip";
      chip.textContent = c.label;
      chip.setAttribute("aria-pressed", String(c.key === category.key));
      if (c.key === category.key) chip.classList.add("active");
      chip.onclick = () => {
        category = c;
        renderChips();
        renderList();
      };
      chips.appendChild(chip);
    }
  };

  const renderList = () => {
    list.replaceChildren();
    if (entries === null) {
      status.textContent = failed
        ? "Couldn't load the leaderboard. Close and try again."
        : "Loading…";
      return;
    }
    status.textContent = entries.length <= 1
      ? "It's just you so far — add friends to see how you stack up!"
      : "";
    for (const row of rankLeaderboard(entries, category)) {
      const line = document.createElement("div");
      line.className = "prof-row lb-row";
      if (row.entry.self) line.classList.add("lb-self");

      const rank = document.createElement("span");
      rank.className = "lb-rank";
      if (row.rank !== null && row.rank <= 3) rank.classList.add("lb-medal");
      rank.textContent = row.rank === null ? "–" : medal(row.rank);

      // The head they're wearing, same as their friends-list row — absent for an
      // account with no materialized farm, which simply renders face-less.
      const face = hud.friendHeadPart(row.entry.headId);
      const facePic = document.createElement("img");
      facePic.className = "fr-friend-face";
      if (face) {
        facePic.src = `${BASE}assets/player/${face.part}`;
        facePic.alt = "";
        facePic.decoding = "async";
        facePic.title = `Wearing: ${face.name}`;
      }

      const name = document.createElement("span");
      name.className = "lb-name";
      // textContent, never innerHTML, for the account-controlled display name
      // (defense in depth, see SECURITY.md A9).
      name.textContent = row.entry.self ? "You" : (row.entry.name.trim() || "Unnamed friend");

      const value = document.createElement("span");
      value.className = "lb-value";
      if (row.value === null) {
        value.textContent = "no stats yet";
        value.classList.add("lb-novalue");
        value.title = "They haven't played on a version that keeps count.";
      } else {
        value.textContent = category.key === "level"
          ? `Level ${formatCount(row.value)}`
          : formatCount(row.value);
      }

      line.append(rank, ...(face ? [facePic] : []), name, value);
      list.appendChild(line);
    }
  };

  renderChips();
  renderList();
  void (async () => {
    try {
      entries = (await hud.getFriendLeaderboard?.()) ?? null;
      failed = entries === null;
    } catch {
      failed = true;
    }
    if (!panel.isConnected) return; // closed while loading
    renderList();
  })();
}
