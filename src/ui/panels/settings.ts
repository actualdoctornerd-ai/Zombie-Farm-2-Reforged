// Settings + Developer menus and the account/devices blocks. Extracted from the
// Hud class: these functions take the Hud instance and render into it, exactly as
// the former methods did. buildAccountBlock/buildDevicesBlock are also used by
// Hud.openProfiles (which stays in the class and calls them here).
import type { Hud } from "../../hud";
import { openModal } from "../Modal";
import { BUILD_ID } from "../../version";
import { diagnosticsReport, diagnosticsCount, clearDiagnostics } from "../../diagnostics";
import {
  FARM_BACKGROUNDS,
  getRightClickMode, setRightClickMode,
  getShowHealthNumbers, setShowHealthNumbers,
  getShowDamageNumbers, setShowDamageNumbers,
} from "../../prefs";
import { recallOneOf, remember } from "../viewState";
import { ABILITY_POOL, ABILITY_TIER, TIER_BOSS } from "../../zombie/traits";
import { otherPlayMode, playModeDestinationLabel } from "../../playMode";
import { updateCheckMessage, type UpdateCheckResult } from "../../updateCheck";
import { usernameRefusalMessage } from "../../net/serviceStatus";
import {
  checkShellUpdate,
  openReleasePage,
  releasesUrl,
  shellInfo,
  shellUpdateMessage,
} from "../../shellUpdate";

export async function confirmLocalFarmReset(
  hud: Pick<Hud, "confirmInGame" | "onResetLocal">,
): Promise<void> {
  const confirmed = await hud.confirmInGame(
    "Reset Local Farm?",
    "This permanently deletes the current Local Farm and its automatic recovery copy from this browser. Downloaded export files and your Online Farm will not be affected.",
    "Reset Farm",
  );
  if (confirmed) hud.onResetLocal?.();
}

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

function volumeRow(label: string, value: number, set: (v: number) => void) {
  const r = document.createElement("label");
  r.className = "set-row set-volume";
  const lbl = document.createElement("span");
  lbl.textContent = label;
  const controls = document.createElement("span");
  controls.className = "set-volume-controls";
  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = "0";
  slider.max = "100";
  slider.step = "1";
  slider.value = String(Math.round(value * 100));
  slider.setAttribute("aria-label", `${label} volume`);
  const amount = document.createElement("span");
  amount.className = "set-volume-value";
  amount.textContent = `${slider.value}%`;
  slider.oninput = () => {
    amount.textContent = `${slider.value}%`;
    set(Number(slider.value) / 100);
  };
  controls.append(slider, amount);
  r.append(lbl, controls);
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

/** The Settings tabs, in display order. Grown past one screenful, the panel is
 *  split by topic: Game (farm/save/account plumbing), Audio, Display (how things
 *  look), Controls (what the inputs do). */
export type SettingsTab = "game" | "audio" | "display" | "controls";
const SETTINGS_TABS: { id: SettingsTab; label: string }[] = [
  { id: "game", label: "Game" },
  { id: "audio", label: "Audio" },
  { id: "display", label: "Display" },
  { id: "controls", label: "Controls" },
];

// Settings modal, split across tabs (see SETTINGS_TABS). The Developer section
// lives in its own menu (openDevMenu), reached via the invisible hotspot beside
// the nameplate. Reopening returns to whichever tab was last read.
export function openSettings(hud: Hud): void {
  // The fullscreen listener is torn down via onClose so it detaches whether the
  // panel is dismissed by the close button or a backdrop click.
  const { panel } = openModal({
    host: hud.el, title: "Settings", panelClass: "settings-panel",
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

  // The ZF2 Sprites switch is deliberately NOT built here. It used to sit at the
  // bottom of Display, and it did nothing: this panel was the only reader of
  // `getSpriteSet()`, so flipping it persisted a preference and changed not one pixel. A
  // setting that visibly does nothing is a support ticket, so it stays out of the panel
  // until there is art behind it.
  //
  // The preference itself is left intact in prefs.ts on purpose — `zf2r.spriteSet` is
  // still written on any device that flipped it, and the ZF1 art pack that gives the
  // switch meaning is being extracted (tools/extract_zf1_ipa.py). Restoring this is a
  // `row("ZF2 Sprites", ...)` and an entry in the `display` list below; the thing that
  // has to land first is a runtime swap keyed off `getSpriteSet()`.

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
      const error = await hud.onSetUsername!(name).catch(() => ({ code: "error" }));
      save.disabled = false;
      input.disabled = false;
      if (error) {
        status.classList.add("error");
        status.textContent = usernameRefusalMessage(error);
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

  // How zombies are drawn, everywhere they appear (farm, raids, Black Market, cards,
  // Mausoleum). Both are pure display choices — the unit keeps its real mutations and
  // its inherited tint either way, so nothing here changes stats or what a trade is
  // worth. Requested by players who want their silver zombies to look silver even when
  // they were bred from greens, and by players who prefer an undecorated horde.
  const appearanceBlock: HTMLElement[] = [];
  if (hud.getZombieAppearance && hud.onSetZombieAppearance) {
    const current = hud.getZombieAppearance();
    appearanceBlock.push(
      settingChoiceRow(
        "Zombie Colour",
        [
          { id: "inherited", label: "Inherited" },
          { id: "species", label: "By Type" },
        ],
        current.bodyColor,
        (v) => hud.onSetZombieAppearance?.({ ...hud.getZombieAppearance!(), bodyColor: v }),
      ),
      noteEl("Inherited keeps the mixed skin a Zombie Pot child was born with. By Type gives every zombie its own species' colour — a silver looks silver however it was bred."),
      settingRow("Show Mutations", current.showMutations,
        (v) => hud.onSetZombieAppearance?.({ ...hud.getZombieAppearance!(), showMutations: v })),
      noteEl("Off hides crop mutations (onion heads, celery arms) on every zombie. They keep the mutations and their stat bonuses — this only changes how they look."),
    );
  }

  // What an invasion shows on top of its health bars. Both default OFF — ZF2 printed
  // neither, and the bars alone are the look most players expect — so this is opt-in
  // detail for anyone who wants to see the arithmetic. Neither changes the fight.
  const combatBlock: HTMLElement[] = [
    settingRow("Health Bar Numbers", getShowHealthNumbers(), (v) => setShowHealthNumbers(v)),
    noteEl("Prints the HP left over each health bar in a raid, like “27/40”."),
    settingRow("Damage Numbers", getShowDamageNumbers(), (v) => setShowDamageNumbers(v)),
    noteEl("Floats the damage of each hit off the unit that took it. Both apply from your next invasion, and neither changes the fight."),
  ];

  const ambienceBlock: HTMLElement[] = [];
  if (hud.getDayNightMode && hud.onSetDayNightMode) {
    ambienceBlock.push(
      settingChoiceRow(
        "Day / Night",
        [
          { id: "auto", label: "Auto" },
          { id: "day", label: "Day" },
          { id: "night", label: "Night" },
        ],
        hud.getDayNightMode(),
        (v) => {
          hud.onSetDayNightMode?.(v);
        }
      ),
      noteEl("Auto follows this device's local clock (night from 7pm to 7am).")
    );
  }
  if (hud.getFarmerLantern && hud.onSetFarmerLantern) {
    ambienceBlock.push(
      settingRow("Farmer's Lantern", hud.getFarmerLantern(),
        (v) => hud.onSetFarmerLantern?.(v)),
      noteEl("Off puts the lamp away and leaves the farm dark after sunset, lit only by whatever you have placed."),
    );
  }
  // What the inputs do, as opposed to what things look like. The right-click row is
  // mouse-only in effect (touch long-press never opens the menu) but shown always —
  // a tablet with a mouse attached is a real player.
  const controlsBlock: HTMLElement[] = [
    settingChoiceRow(
      "Right-Click",
      [
        { id: "menu", label: "Tool Menu" },
        { id: "select", label: "Select Tool" },
      ],
      getRightClickMode(),
      (v) => setRightClickMode(v),
    ),
    noteEl("Tool Menu opens the quick-switch tool menu at the cursor. Select Tool goes straight back to the Select tool, like it used to."),
  ];
  // Whether the farmer himself is a lantern switch. Only offered alongside the
  // lantern feature itself — on its own it would read as a setting for a feature
  // that isn't there.
  if (hud.getFarmerLantern && hud.onSetFarmerLantern
      && hud.getFarmerLanternTap && hud.onSetFarmerLanternTap) {
    controlsBlock.push(
      settingRow("Tap Farmer for Lantern", hud.getFarmerLanternTap(),
        (v) => hud.onSetFarmerLanternTap?.(v)),
      noteEl("On, tapping the farmer at night switches his lantern. Off, that tap goes to the ground under him instead — the Display tab's Farmer's Lantern row still switches it."),
    );
  }
  const farmMode = document.createElement("div");
  farmMode.className = "set-row";
  const farmModeLabel = document.createElement("span");
  farmModeLabel.textContent = hud.playMode === "local" ? "Local Farm" : "Online Farm";
  const switchFarm = document.createElement("button");
  switchFarm.className = "set-action";
  const destination = otherPlayMode(hud.playMode);
  switchFarm.textContent = playModeDestinationLabel(hud.playMode);
  switchFarm.onclick = () => hud.onSwitchFarm?.(destination);
  farmMode.append(farmModeLabel, switchFarm);
  const farmModeNote = noteEl(hud.playMode === "local"
    ? "Saved on this device only. Online Farm has separate progress."
    : "Saved to your account. Local Farm has separate progress.");
  // Save file controls. Both farms export the same thing — a plain save file — but
  // only Local Farm can read one back, so Import/Reset stay local-only.
  const localStorageControls: HTMLElement[] = [];
  if (hud.playMode === "local") {
    const actions = document.createElement("div");
    actions.className = "set-row";
    const label = document.createElement("span");
    label.textContent = "Local Save";
    const controls = document.createElement("div");
    controls.className = "set-username-controls";
    const exportButton = document.createElement("button");
    exportButton.className = "set-action";
    exportButton.textContent = "Export";
    exportButton.onclick = () => hud.onExportSave?.();
    const importButton = document.createElement("button");
    importButton.className = "set-action";
    importButton.textContent = "Import";
    const picker = document.createElement("input");
    picker.type = "file";
    picker.accept = "application/json,.json";
    picker.hidden = true;
    importButton.onclick = () => picker.click();
    picker.onchange = async () => {
      const file = picker.files?.[0];
      if (!file) return;
      if (!hud.onImportLocal?.(await file.text())) {
        hud.showToast("That file is not a valid Local Farm backup.");
      }
    };
    const resetButton = document.createElement("button");
    resetButton.className = "set-action";
    resetButton.textContent = "Reset";
    resetButton.onclick = () => void confirmLocalFarmReset(hud);
    controls.append(exportButton, importButton, resetButton, picker);
    actions.append(label, controls);
    localStorageControls.push(
      actions,
      noteEl("Clearing browser data can remove Local Farm. Export a backup to keep it safe. Import also accepts an Online Farm export."),
    );
  } else {
    // Online Farm export: a one-way copy out to a file. There is no Import here —
    // an Online Farm's progress is the server's, so a file can never be loaded into
    // it — and no Reset, because the account save isn't this browser's to delete.
    const actions = document.createElement("div");
    actions.className = "set-row";
    const label = document.createElement("span");
    label.textContent = "Online Save";
    const controls = document.createElement("div");
    controls.className = "set-username-controls";
    const exportButton = document.createElement("button");
    exportButton.className = "set-action";
    exportButton.textContent = "Export";
    exportButton.onclick = () => hud.onExportSave?.();
    controls.append(exportButton);
    actions.append(label, controls);
    localStorageControls.push(
      actions,
      noteEl("Downloads a copy of this farm. Load it with Local Farm's Import — it can't be imported back into an Online Farm."),
    );
  }
  // Diagnostics: available in BOTH farm modes, because crashes happen in both. Copying
  // is entirely local (clipboard) — nothing is transmitted. Testers paste it into the
  // Discord bug channel named in the Farmer's Guide.
  const diagnostics = document.createElement("div");
  diagnostics.className = "set-row";
  const diagLabel = document.createElement("span");
  diagLabel.textContent = "Diagnostics";
  const diagControls = document.createElement("div");
  diagControls.className = "set-username-controls";
  const copyButton = document.createElement("button");
  copyButton.className = "set-action";
  const captured = diagnosticsCount();
  copyButton.textContent = captured ? `Copy (${captured})` : "Copy";
  copyButton.onclick = async () => {
    const text = diagnosticsReport({ mode: hud.playMode, ...hud.getDiagnosticExtras?.() });
    try {
      await navigator.clipboard.writeText(text);
      hud.showToast("Diagnostics copied. Paste them into your bug report.");
    } catch {
      // Clipboard needs a secure context and permission; neither is guaranteed on a
      // phone browser. Fall back to selectable text the player can copy by hand.
      const box = document.createElement("textarea");
      box.value = text;
      box.className = "set-diagnostics-dump";
      box.readOnly = true;
      diagnostics.after(box);
      box.focus();
      box.select();
      hud.showToast("Couldn't reach the clipboard — copy the text shown instead.", 6000);
    }
  };
  const clearButton = document.createElement("button");
  clearButton.className = "set-action";
  clearButton.textContent = "Clear";
  clearButton.onclick = () => {
    clearDiagnostics();
    copyButton.textContent = "Copy";
    hud.showToast("Diagnostics cleared.");
  };
  diagControls.append(copyButton, clearButton);
  diagnostics.append(diagLabel, diagControls);

  // Updates: ask the service worker to re-check the network right now, rather than
  // waiting for the browser's own periodic check. A waiting build raises the usual
  // bottom toast (with its Reload button) from pwa.ts; every other outcome is
  // reported in the note under the row, so a check that finds nothing still says so.
  const updates = document.createElement("div");
  updates.className = "set-row";
  const updatesLabel = document.createElement("span");
  updatesLabel.textContent = "Updates";
  const updatesButton = document.createElement("button");
  updatesButton.className = "set-action";
  updatesButton.textContent = "Check for Updates";
  // In a downloaded package there is no service worker to ask (it is disabled so
  // it can't mask modded files), so the shell that serves the game tells us which
  // repository it came from and we ask that for its newest release.
  const shell = shellInfo();
  const updatesNote = noteEl(shell
    ? `Ask ${shell.repo} whether a newer version has been released. Nothing is downloaded or changed without asking you.`
    : "Look for a newer version of the game.");
  updatesButton.onclick = async () => {
    updatesButton.disabled = true;
    updatesButton.textContent = "Checking…";
    updatesNote.textContent = "Checking for updates…";
    try {
      if (shell) {
        const result = await checkShellUpdate(shell);
        updatesNote.textContent = shellUpdateMessage(result);
        if (result.status === "update-available") {
          // Deliberately a question, and deliberately the end of our involvement:
          // replacing game/ would delete the player's mods, so accepting opens the
          // download page and leaves the files alone.
          const wanted = await hud.confirmInGame(
            `${result.latest} is available`,
            `You're playing ${result.current}. Opening the download page won't change anything on this PC — you'll get a new zip to extract yourself, and your current copy, saves and mods stay exactly as they are.`,
            "Open download page",
          );
          if (wanted && !(await openReleasePage(shell))) {
            updatesNote.textContent = `Couldn't open a browser. The download is at ${releasesUrl(shell)}`;
          }
        }
      } else {
        let result: UpdateCheckResult;
        try {
          result = (await hud.onCheckForUpdate?.()) ?? "unavailable";
        } catch {
          result = "error";
        }
        updatesNote.textContent = updateCheckMessage(result);
      }
    } finally {
      updatesButton.textContent = "Check for Updates";
      updatesButton.disabled = false;
    }
  };
  updates.append(updatesLabel, updatesButton);

  // The tab bar (the Market's screen-toggle look) and the body it swaps. Every
  // block above is built once; showing a tab just re-parents its elements, so
  // controls keep their state and handlers across switches.
  const tabs = document.createElement("div");
  tabs.className = "pm-screens set-tabs";
  const body = document.createElement("div");
  body.className = "set-body";
  panel.append(tabs, body);

  const tabContent: Record<SettingsTab, HTMLElement[]> = {
    game: [
      farmMode,
      farmModeNote,
      ...localStorageControls,
      ...accountBlock,
      diagnostics,
      noteEl("Copies this build's id, your browser, a short list of what the game has just been doing, and any recorded errors. No save data, no account details, nothing you have typed. Nothing is sent anywhere — paste it into a bug report."),
      updates,
      updatesNote,
    ],
    audio: [
      row("All Audio", hud.audio.masterOn, (v) => hud.audio.setMaster(v)),
      volumeRow("Master Volume", hud.audio.masterVolume, (v) => hud.audio.setMasterVolume(v)),
      row("Music", hud.audio.musicOn, (v) => hud.audio.setMusic(v)),
      volumeRow("Music Volume", hud.audio.musicVolume, (v) => hud.audio.setMusicVolume(v)),
      row("Sound Effects", hud.audio.sfxOn, (v) => hud.audio.setSfx(v)),
      volumeRow("Effects Volume", hud.audio.sfxVolume, (v) => hud.audio.setSfxVolume(v)),
      row("Ambience", hud.audio.ambienceOn, (v) => hud.audio.setAmbience(v)),
      volumeRow("Ambience Volume", hud.audio.ambienceVolume,
        (v) => hud.audio.setAmbienceVolume(v)),
      row("Mute When Unfocused", hud.audio.muteWhenUnfocused,
        (v) => hud.audio.setMuteWhenUnfocused(v)),
      noteEl("Silence the game while its tab or window is in the background."),
    ],
    display: [
      fullscreenRow,
      noteEl(canFullscreen
        ? "Press F to toggle fullscreen. Escape also exits."
        : "This browser doesn't support app-controlled fullscreen."),
      ...ambienceBlock,
      ...bgBlock,
      ...appearanceBlock,
      ...combatBlock,
    ],
    controls: controlsBlock,
  };

  const tabButtons: Record<SettingsTab, HTMLButtonElement> = {} as never;
  const show = (tab: SettingsTab) => {
    for (const t of SETTINGS_TABS) tabButtons[t.id].classList.toggle("sel", t.id === tab);
    body.innerHTML = "";
    body.append(...tabContent[tab]);
    remember("settings.tab", tab);
  };
  for (const t of SETTINGS_TABS) {
    const b = document.createElement("button");
    b.className = "pm-screen";
    b.textContent = t.label;
    b.onclick = () => show(t.id);
    tabButtons[t.id] = b;
    tabs.appendChild(b);
  }
  show(recallOneOf("settings.tab", SETTINGS_TABS.map((t) => t.id), "game"));

  const version = document.createElement("div");
  version.className = "set-version";
  version.textContent = `Version ${BUILD_ID}`;
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
  // textContent for the display name, never innerHTML — the same rule the friends
  // list and the nameplate follow. The server's username allowlist happens to exclude
  // markup today, so this was building HTML from account-controlled text and getting
  // away with it; the safety then lived in a regex three modules away rather than here.
  const whoName = document.createElement("b");
  whoName.textContent = acct.name;
  who.append("Signed in as ", whoName);
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
