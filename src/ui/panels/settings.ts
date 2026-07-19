// Settings + Developer menus and the account/devices blocks. Extracted from the
// Hud class: these functions take the Hud instance and render into it, exactly as
// the former methods did. buildAccountBlock/buildDevicesBlock are also used by
// Hud.openProfiles (which stays in the class and calls them here).
import type { Hud } from "../../hud";
import { openModal } from "../Modal";
import { APP_VERSION } from "../../version";
import { getSpriteSet, setSpriteSet, getEdition, setEdition, FARM_BACKGROUNDS } from "../../prefs";
import { ABILITY_POOL, ABILITY_TIER, TIER_BOSS } from "../../zombie/traits";

// A label + ON/OFF toggle row.
function settingRow(label: string, on: boolean, set: (v: boolean) => void) {
  const r = document.createElement("div");
  r.className = "set-row";
  const lbl = document.createElement("span");
  lbl.textContent = label;
  const t = document.createElement("button");
  t.className = "toggle" + (on ? " on" : "");
  t.innerHTML = `<span class="txt l">ON</span><span class="txt r">OFF</span><span class="knob"></span>`;
  t.onclick = () => {
    const now = !t.classList.contains("on");
    t.classList.toggle("on", now);
    set(now);
  };
  r.append(lbl, t);
  return r;
}

// Reusable label + segmented multi-choice row (a small pill button per option).
function settingChoiceRow<T extends string>(
  label: string,
  options: { id: T; label: string }[],
  current: T,
  set: (v: T) => void
) {
  const r = document.createElement("div");
  r.className = "set-row set-row-choice";
  const lbl = document.createElement("span");
  lbl.textContent = label;
  const seg = document.createElement("div");
  seg.className = "set-choice";
  const btns = options.map((o) => {
    const b = document.createElement("button");
    b.className = "choice" + (o.id === current ? " on" : "");
    b.textContent = o.label;
    b.onclick = () => {
      if (b.classList.contains("on")) return;
      for (const other of btns) other.classList.remove("on");
      b.classList.add("on");
      set(o.id);
    };
    return b;
  });
  seg.append(...btns);
  r.append(lbl, seg);
  return r;
}

/** Short "active N ago" for the device list. Coarse on purpose. */
function relTime(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 90) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// Settings modal: Music / Sound Effects / Ambience toggles plus the account
// block. The Developer section now lives in its own menu (openDevMenu), reached
// via the invisible hotspot beside the nameplate.
export function openSettings(hud: Hud): void {
  // The fullscreen listener is torn down via onClose so it detaches whether the
  // panel is dismissed by the close button or a backdrop click.
  const { panel } = openModal({
    host: hud.el, title: "Settings",
    onClose: () => document.removeEventListener("fullscreenchange", refreshFullscreen),
  });

  const row = (label: string, on: boolean, set: (v: boolean) => void) =>
    settingRow(label, on, set);

  // (Account + Sign out moved to the Profile menu — opened by the top-right
  // nameplate. See openProfiles / buildAccountBlock.)

  // A toggle row followed by a small explanatory note underneath it.
  const noteEl = (text: string) => {
    const n = document.createElement("div");
    n.className = "set-note";
    n.textContent = text;
    return n;
  };

  // Fullscreen must be entered from a user gesture, so expose it as a Settings
  // action instead of trying to force it during boot. Pixi already resizes to the
  // window and will automatically pick up the fullscreen viewport dimensions.
  const fullscreenRow = document.createElement("div");
  fullscreenRow.className = "set-row";
  const fullscreenLabel = document.createElement("span");
  fullscreenLabel.textContent = "Fullscreen";
  const fullscreenButton = document.createElement("button");
  fullscreenButton.className = "set-action";
  const canFullscreen = document.fullscreenEnabled &&
    typeof document.documentElement.requestFullscreen === "function";
  const refreshFullscreen = () => {
    const active = document.fullscreenElement !== null;
    fullscreenButton.textContent = active ? "Exit Fullscreen" :
      canFullscreen ? "Enter Fullscreen" : "Unavailable";
    fullscreenButton.disabled = !canFullscreen;
  };
  fullscreenButton.onclick = async () => {
    fullscreenButton.disabled = true;
    try {
      await hud.toggleFullscreen();
    } catch {
      fullscreenButton.textContent = "Couldn't Open";
    } finally {
      if (fullscreenButton.textContent !== "Couldn't Open") refreshFullscreen();
      else fullscreenButton.disabled = false;
    }
  };
  fullscreenRow.append(fullscreenLabel, fullscreenButton);
  refreshFullscreen();
  document.addEventListener("fullscreenchange", refreshFullscreen);

  // Sprite set: original Zombie Farm (ZF1) vs the sequel's art (ZF2). Persisted
  // only — nothing swaps art on it yet (see prefs.ts / README "Current Gaps").
  // ON = ZF2 (the pack wired today), OFF = ZF1.
  const spriteRow = row("ZF2 Sprites", getSpriteSet() === "zf2", (v) =>
    setSpriteSet(v ? "zf2" : "zf1")
  );
  const spriteNote = noteEl("Original (ZF1) vs sequel (ZF2) art. Art swapping isn't wired yet.");

  // Edition: Reforged (all modern additions — online account, brain gifting) vs
  // Traditional (the OG single-player experience). Persisted only for now — the
  // feature gates it will drive aren't wired yet (see prefs.isReforged).
  const editionRow = row("Reforged", getEdition() === "reforged", (v) =>
    setEdition(v ? "reforged" : "traditional")
  );
  const editionNote = noteEl("Reforged adds brain gifting & online features; Traditional is the OG experience. (Gating not wired yet.)");

  // Signed-in players can change the same display name they chose on first login.
  // The server remains the source of truth for normalization and validation.
  const accountBlock: HTMLElement[] = [];
  const acct = hud.myAccount?.();
  if (hud.socialOnline?.() && acct && hud.onSetUsername) {
    const wrap = document.createElement("div");
    wrap.className = "set-username";
    const r = document.createElement("div");
    r.className = "set-row";
    const label = document.createElement("span");
    label.textContent = "Username";
    const controls = document.createElement("div");
    controls.className = "set-username-controls";
    const input = document.createElement("input");
    input.className = "set-username-input";
    input.type = "text";
    input.maxLength = 20;
    input.autocomplete = "off";
    input.value = acct.name;
    input.setAttribute("aria-label", "Username");
    const save = document.createElement("button");
    save.className = "set-username-save";
    save.textContent = "Save";
    const status = document.createElement("div");
    status.className = "set-username-status";
    const submit = async () => {
      const name = input.value.trim();
      if (!name || save.disabled) return;
      save.disabled = true;
      input.disabled = true;
      status.classList.remove("error");
      status.textContent = "Saving…";
      const error = await hud.onSetUsername!(name).catch(() => "error");
      save.disabled = false;
      input.disabled = false;
      if (error) {
        status.classList.add("error");
        status.textContent = error === "bad_username"
          ? "Use 2–20 letters, numbers, spaces or _ - . '"
          : "Couldn't save that. Try again.";
        return;
      }
      input.value = hud.myAccount?.()?.name ?? name;
      status.textContent = "Username updated.";
    };
    save.onclick = () => void submit();
    input.onkeydown = (e) => { if (e.key === "Enter") void submit(); };
    controls.append(input, save);
    r.append(label, controls);
    wrap.append(r, status);
    accountBlock.push(wrap);
  }

  // Farm background: how lush the trees ringing the farm are. All three fill the
  // view to the zoom-out edge; they differ in density (Deep Forest → Light Meadow).
  const bgBlock: HTMLElement[] = [];
  if (hud.getFarmBackground && hud.onSetFarmBackground) {
    bgBlock.push(
      settingChoiceRow("Farm Background", FARM_BACKGROUNDS, hud.getFarmBackground(),
        (v) => hud.onSetFarmBackground?.(v)),
      noteEl("How many trees surround your farm.")
    );
  }

  panel.append(
    row("Music", hud.audio.musicOn, (v) => hud.audio.setMusic(v)),
    row("Sound Effects", hud.audio.sfxOn, (v) => hud.audio.setSfx(v)),
    row("Ambience", hud.audio.ambienceOn, (v) => hud.audio.setAmbience(v)),
    row("Mute When Unfocused", hud.audio.muteWhenUnfocused,
      (v) => hud.audio.setMuteWhenUnfocused(v)),
    noteEl("Silence the game while its tab or window is in the background."),
    fullscreenRow,
    noteEl(canFullscreen
      ? "Press F to toggle fullscreen. Escape also exits."
      : "This browser doesn't support app-controlled fullscreen."),
    ...accountBlock,
    ...bgBlock,
    spriteRow, spriteNote,
    editionRow, editionNote
  );
  const version = document.createElement("div");
  version.className = "set-version";
  version.textContent = `Version ${APP_VERSION}`;
  panel.append(version);
}

// Developer menu: hidden from normal play, opened only via the invisible hotspot
// beside the nameplate. Holds the Night-lighting toggle,
// level/gold/brains overrides, and the per-tier raid ability unlocks.
export function openDevMenu(hud: Hud): void {
  const { panel } = openModal({ host: hud.el, title: "Developer" });

  const row = (label: string, on: boolean, set: (v: boolean) => void) =>
    settingRow(label, on, set);

  // Developer number field: label + numeric input applied on change.
  const numRow = (label: string, value: number, apply: (n: number) => void) => {
    const r = document.createElement("div");
    r.className = "set-row";
    const lbl = document.createElement("span");
    lbl.textContent = label;
    const inp = document.createElement("input");
    inp.type = "number";
    inp.className = "dev-input";
    inp.value = String(value);
    inp.onchange = () => {
      const n = parseInt(inp.value, 10);
      if (!Number.isNaN(n)) {
        apply(n);
        hud.update();
      }
    };
    r.append(lbl, inp);
    return r;
  };

  // Night lighting: toggles the dark overlay + carved lights (was the N key).
  const nightRow = row("Night", hud.getNight?.() ?? false, (v) =>
    hud.onSetNight?.(v)
  );

  // Dev: beat a tier boss once — each win unlocks the NEXT still-locked ability of
  // that tier across the roster (not the whole tier at once).
  const raidWrap = document.createElement("div");
  const raidStatus = document.createElement("div");
  raidStatus.className = "dev-status";
  raidStatus.textContent = "Beat a tier boss to unlock its next ability:";
  const raidBtns = document.createElement("div");
  raidBtns.className = "dev-raid-btns";
  for (let t = 1; t <= 4; t++) {
    const b = document.createElement("button");
    b.className = "dev-btn";
    b.textContent = `Win T${t} — ${TIER_BOSS[t]}`;
    b.onclick = () => {
      const pool = ABILITY_TIER[t] ?? [];
      const before = hud.state.tierAbilitiesUnlocked(t);
      hud.state.completeRaid(String(t));
      const after = hud.state.tierAbilitiesUnlocked(t);
      if (after > before) {
        const label = ABILITY_POOL[pool[after - 1]]?.label ?? pool[after - 1];
        raidStatus.textContent =
          `Unlocked ${label} — Tier ${t} ${after}/${pool.length} (beat ${TIER_BOSS[t]}).`;
      } else {
        raidStatus.textContent = `All Tier ${t} abilities already unlocked.`;
      }
    };
    raidBtns.appendChild(b);
  }
  raidWrap.append(raidStatus, raidBtns);

  panel.append(
    nightRow,
    numRow("Level", hud.state.level, (n) => hud.state.setLevel(n)),
    numRow("Gold", hud.state.gold, (n) => hud.state.setGold(n)),
    numRow("Brains", hud.state.brains, (n) => hud.state.setBrains(n)),
    raidWrap
  );
}

/** Account block for the Account menu: who you're signed in as and a Sign out
 *  button — this is the ONE place Sign out lives. Returns null when there's no
 *  online account (offline build or signed out) so the caller can omit it. The
 *  friend code lives in the Friends panel now, not here. Sign out flushes the
 *  save and returns to the sign-in gate (see hud.onSignOut / main.ts). */
export function buildAccountBlock(hud: Hud): HTMLElement | null {
  const acct = hud.myAccount?.();
  if (!hud.socialOnline?.() || !acct) return null;
  const block = document.createElement("div");
  block.className = "set-acct";
  const info = document.createElement("div");
  info.className = "set-acct-info";
  const who = document.createElement("div");
  who.className = "set-acct-who";
  who.innerHTML = `Signed in as <b>${acct.name}</b>`;
  info.append(who);
  const out = document.createElement("button");
  out.className = "set-signout";
  out.textContent = "Sign out";
  out.onclick = () => hud.onSignOut?.();
  block.append(info, out);
  return block;
}

/** Devices block for the Account menu: this account's live sessions, each with a
 *  device label + last-active time, and a Revoke button for every device EXCEPT
 *  the current one (that's what Sign out is for). Loads asynchronously — returns
 *  the container immediately and fills it in. Null when there's no online account. */
export function buildDevicesBlock(hud: Hud): HTMLElement | null {
  if (!hud.socialOnline?.() || !hud.onListSessions) return null;
  const block = document.createElement("div");
  block.className = "set-devices";
  const h = document.createElement("h3");
  h.textContent = "Devices";
  const list = document.createElement("div");
  list.className = "set-dev-list";
  list.textContent = "Loading…";
  block.append(h, list);

  const render = async () => {
    let rows: { id: string; label: string | null; lastUsedAt: number; current: boolean }[];
    try {
      rows = await hud.onListSessions!();
    } catch {
      list.textContent = "Couldn't load your devices.";
      return;
    }
    list.innerHTML = "";
    if (!rows.length) { list.textContent = "No active devices."; return; }
    for (const r of rows) {
      const row = document.createElement("div");
      row.className = "set-dev-row";
      const meta = document.createElement("div");
      meta.className = "set-dev-meta";
      const name = document.createElement("div");
      name.className = "set-dev-name";
      // textContent — the label is server-derived, but never build markup from it.
      name.textContent = r.label ?? "Unknown device";
      const when = document.createElement("div");
      when.className = "set-dev-when";
      when.textContent = r.current ? "This device" : `Active ${relTime(r.lastUsedAt)}`;
      meta.append(name, when);
      row.append(meta);
      if (!r.current) {
        const rev = document.createElement("button");
        rev.className = "set-dev-revoke";
        rev.textContent = "Sign out";
        rev.onclick = async () => {
          rev.disabled = true;
          const ok = await hud.onRevokeSession?.(r.id).catch(() => false);
          if (ok) row.remove();
          else { rev.disabled = false; hud.showToast("Couldn't sign that device out."); }
        };
        row.append(rev);
      }
      list.append(row);
    }
  };
  void render();
  return block;
}
