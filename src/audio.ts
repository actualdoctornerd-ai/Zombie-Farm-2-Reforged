// Farm audio: a looping BGM, an ambient farm bed (birds/rooster over a low
// ambience track), one-shot SFX for farm actions and menu navigation, and
// per-object "tap" sounds for signature decor. All three channels (music,
// sfx, ambience) toggle independently in Settings and persist to localStorage.
// Big files (BGM/ambience bed) are lazy (preload="none") so they only fetch
// once their channel is first enabled.
import { SETTINGS_KEY } from "./save/schema";
import { BASE } from "./base";

export type Sfx =
  | "till" | "plant" | "harvest" | "harvestZombie" | "xp"
  | "buy" | "sell" | "place" | "instaGrow"
  | "menuOpen" | "menuClose" | "menuClick" | "levelUp" | "attack";

// All clips are shipped as compressed .mp3 (universal browser support). The
// .wav->.mp3 coercion lets data-driven filenames (e.g. decor tapSound values
// authored as *.wav) resolve to the shipped file without editing that data.
const A = (n: string) => n.includes("/")
  ? `${BASE}assets/${n}`
  : `${BASE}assets/audio/${n.replace(/\.wav$/i, ".mp3")}`;

// Which clip each SFX plays. Plowing/planting reuse the hoe sound; crops harvest
// with their own pluck; a harvested zombie uses the plain harvest chime.
const SFX_FILE: Record<Sfx, string> = {
  till: "plowing.mp3",
  plant: "plowing.mp3",
  harvest: "harvestPlant.mp3",
  harvestZombie: "harvest.mp3",
  xp: "earn.mp3",
  buy: "buy.mp3",
  sell: "delete.mp3",
  place: "stamp.mp3",
  instaGrow: "poof.mp3",
  menuOpen: "menuOpen.mp3",
  menuClose: "menuClose.mp3",
  menuClick: "menuClick.mp3",
  levelUp: "winner.mp3",
  attack: "block.mp3",
};

// Per-SFX volume. Menu whooshes/clicks sit under action feedback; anything
// unlisted uses DEFAULT_VOL.
const DEFAULT_VOL = 0.6;
const SFX_VOL: Partial<Record<Sfx, number>> = {
  menuOpen: 0.4, menuClose: 0.4, menuClick: 0.28,
  buy: 0.55, sell: 0.55, place: 0.5, instaGrow: 0.6,
  levelUp: 0.75, harvestZombie: 0.7,
  attack: 0.32,
};

// Ambient farm life: a quiet continuous bed, plus an occasional rooster/crow so
// the farm never sounds dead. One-shots fire on a randomized 18-42s timer.
const AMBIENCE_BED = "SFXambience.mp3";
const AMBIENCE_ONESHOTS = ["rooster.mp3", "crow.mp3", "birds.mp3"];
const AMBIENCE_MIN_MS = 18_000;
const AMBIENCE_MAX_MS = 42_000;

// A zombie's "Brains…" bark, chosen by its group (the game ships one clip per
// group). The Regular group's cyborg/robot/robocop tiers use the robot bark.
function brainFile(group: string, key: string): string {
  switch (group) {
    case "Garden": return "brainGarden.mp3";
    case "Girl": return "brainGirl.mp3";
    case "Small": return "brainSmall.mp3";
    case "Large": return "brainLarge.mp3";
    case "Regular":
      return /Tier[2-5]$/.test(key) ? "brainRobot.mp3" : "brainRegular.mp3";
    default: return "brainRegular.mp3"; // Headless + anything unmapped
  }
}

interface StoredSettings {
  music?: boolean;
  sfx?: boolean;
  ambience?: boolean;
  musicVolume?: number;
  sfxVolume?: number;
  ambienceVolume?: number;
  muteWhenUnfocused?: boolean;
}

const clampVolume = (value: unknown, fallback = 1): number =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : fallback;

export class AudioManager {
  musicOn = true;
  sfxOn = true;
  ambienceOn = true;
  musicVolume = 1;
  sfxVolume = 1;
  ambienceVolume = 1;
  muteWhenUnfocused = false;
  private bgm: HTMLAudioElement;
  private ambBed: HTMLAudioElement;
  private ambTimer: ReturnType<typeof setTimeout> | null = null;
  private oneShots = new Set<HTMLAudioElement>();
  private armed = false; // whether a user-gesture resume listener is pending
  // While a raid is up, its looping stage BGM replaces the farm bgm. `raidBgm`
  // holds the active raid track (and `raidFile` its filename); the farm bgm is
  // paused for the raid's duration.
  private raidBgm: HTMLAudioElement | null = null;
  private raidFile = "";

  constructor() {
    this.bgm = new Audio(A("dayFarmBGM.mp3"));
    this.bgm.loop = true;
    this.bgm.volume = 0.4;
    this.bgm.preload = "none";

    this.ambBed = new Audio(A(AMBIENCE_BED));
    this.ambBed.loop = true;
    this.ambBed.volume = 0.25;
    this.ambBed.preload = "none";

    // Restore persisted channel toggles. Autoplay may be blocked until the user
    // interacts, so arm a one-shot gesture listener to (re)start any looping
    // channel that couldn't begin immediately.
    const s = this.read();
    this.musicOn = s.music ?? true;
    this.sfxOn = s.sfx ?? true;
    this.ambienceOn = s.ambience ?? true;
    this.musicVolume = clampVolume(s.musicVolume);
    this.sfxVolume = clampVolume(s.sfxVolume);
    this.ambienceVolume = clampVolume(s.ambienceVolume);
    this.muteWhenUnfocused = s.muteWhenUnfocused ?? false;
    this.bgm.volume = 0.4 * this.musicVolume;
    this.ambBed.volume = 0.25 * this.ambienceVolume;

    // `visibilitychange` covers background tabs/minimized windows while the
    // focus events also cover switching to another desktop window.
    window.addEventListener("focus", this.syncFocusAudio);
    window.addEventListener("blur", this.syncFocusAudio);
    document.addEventListener("visibilitychange", this.syncFocusAudio);

    if (this.musicOn && this.canPlay()) void this.bgm.play().catch(() => this.arm());
    if (this.ambienceOn && this.canPlay()) this.startAmbience();
  }

  // --- persistence ---------------------------------------------------------
  private read(): StoredSettings {
    try {
      return JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    } catch {
      return {};
    }
  }
  private persist() {
    const data: StoredSettings = {
      music: this.musicOn, sfx: this.sfxOn, ambience: this.ambienceOn,
      musicVolume: this.musicVolume, sfxVolume: this.sfxVolume,
      ambienceVolume: this.ambienceVolume,
      muteWhenUnfocused: this.muteWhenUnfocused,
    };
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(data));
    } catch {
      /* ignore quota/private-mode failures */
    }
  }

  // Some browsers block audio until the first user gesture. Arm a one-time
  // listener that resumes any looping channel the user has enabled.
  private arm() {
    if (this.armed || !this.canPlay()) return;
    this.armed = true;
    const resume = () => {
      this.armed = false;
      window.removeEventListener("pointerdown", resume);
      if (!this.canPlay()) return;
      if (this.musicOn) void this.activeBgm().play().catch(() => {});
      if (this.ambienceOn && this.ambBed.paused) void this.ambBed.play().catch(() => {});
    };
    window.addEventListener("pointerdown", resume, { once: true });
  }

  // --- music ---------------------------------------------------------------
  // The looping track that should be playing right now: the raid stage BGM while
  // a raid is up, otherwise the farm bgm.
  private activeBgm(): HTMLAudioElement {
    return this.raidBgm ?? this.bgm;
  }

  private canPlay(): boolean {
    return !this.muteWhenUnfocused || (!document.hidden && document.hasFocus());
  }

  private syncFocusAudio = () => {
    if (!this.canPlay()) {
      this.activeBgm().pause();
      this.stopAmbience();
      for (const audio of this.oneShots) audio.pause();
      this.oneShots.clear();
      return;
    }
    if (this.musicOn) void this.activeBgm().play().catch(() => this.arm());
    if (this.ambienceOn) this.startAmbience();
  };

  setMuteWhenUnfocused(on: boolean) {
    this.muteWhenUnfocused = on;
    this.syncFocusAudio();
    this.persist();
  }

  setMusic(on: boolean) {
    this.musicOn = on;
    if (on && this.canPlay()) void this.activeBgm().play().catch(() => this.arm());
    else this.activeBgm().pause();
    this.persist();
  }

  setMusicVolume(value: number) {
    this.musicVolume = clampVolume(value);
    this.bgm.volume = 0.4 * this.musicVolume;
    if (this.raidBgm) this.raidBgm.volume = 0.4 * this.musicVolume;
    this.persist();
  }

  // Enter a raid: swap the farm bgm for the raid's looping stage BGM (`file` is a
  // filename under assets/audio/). Safe to call regardless of the music toggle —
  // it only actually plays when music is on. No-op if the same track is already up.
  enterRaid(file: string) {
    if (!file) return;
    if (this.raidFile !== file) {
      this.exitRaid(true); // tear down any prior raid track without resuming farm
      this.bgm.pause();     // farm bed steps aside for the whole raid
      const a = new Audio(A(file));
      a.loop = true;
      a.volume = 0.4 * this.musicVolume;
      this.raidBgm = a;
      this.raidFile = file;
    }
    if (this.musicOn && this.canPlay()) void this.raidBgm!.play().catch(() => this.arm());
  }

  // Leave a raid: stop the raid track and hand the farm bgm back. `keepFarmPaused`
  // is used internally when immediately swapping to another raid track.
  exitRaid(keepFarmPaused = false) {
    if (this.raidBgm) {
      this.raidBgm.pause();
      this.raidBgm.src = "";
      this.raidBgm = null;
      this.raidFile = "";
    }
    if (!keepFarmPaused && this.musicOn && this.canPlay()) void this.bgm.play().catch(() => this.arm());
  }

  // --- sfx -----------------------------------------------------------------
  setSfx(on: boolean) {
    this.sfxOn = on;
    this.persist();
  }

  setSfxVolume(value: number) {
    this.sfxVolume = clampVolume(value);
    this.persist();
  }

  // Fire-and-forget one-shot (new element each time so overlaps don't cut off).
  play(name: Sfx) {
    if (!this.sfxOn || !this.canPlay()) return;
    this.playOneShot(SFX_FILE[name], SFX_VOL[name] ?? DEFAULT_VOL);
  }

  // A zombie's "Brains…" bark when it's tapped on the farm, chosen by its group.
  brain(group: string, key: string) {
    if (!this.sfxOn || !this.canPlay()) return;
    this.playOneShot(brainFile(group, key), 0.7);
  }

  // A placed decoration's signature tap sound (TileProperties tapSoundEffect /
  // soundID — e.g. the Liberty Bell toll, Gnome King laugh). Gated on SFX.
  tap(file: string) {
    if (!this.sfxOn || !file || !this.canPlay()) return;
    this.playOneShot(file, 0.7);
  }

  private playOneShot(file: string, volume: number, channelVolume = this.sfxVolume) {
    const a = new Audio(A(file));
    a.volume = volume * channelVolume;
    this.oneShots.add(a);
    const done = () => this.oneShots.delete(a);
    a.addEventListener("ended", done, { once: true });
    a.addEventListener("error", done, { once: true });
    void a.play().catch(done);
  }

  // --- ambience ------------------------------------------------------------
  setAmbience(on: boolean) {
    this.ambienceOn = on;
    if (on && this.canPlay()) this.startAmbience();
    else this.stopAmbience();
    this.persist();
  }

  setAmbienceVolume(value: number) {
    this.ambienceVolume = clampVolume(value);
    this.ambBed.volume = 0.25 * this.ambienceVolume;
    this.persist();
  }

  private startAmbience() {
    void this.ambBed.play().catch(() => this.arm());
    this.scheduleAmbienceOneShot();
  }

  private stopAmbience() {
    this.ambBed.pause();
    if (this.ambTimer !== null) {
      clearTimeout(this.ambTimer);
      this.ambTimer = null;
    }
  }

  private scheduleAmbienceOneShot() {
    if (this.ambTimer !== null) clearTimeout(this.ambTimer);
    const delay = AMBIENCE_MIN_MS + Math.random() * (AMBIENCE_MAX_MS - AMBIENCE_MIN_MS);
    this.ambTimer = setTimeout(() => {
      if (this.ambienceOn && this.canPlay()) {
        const file = AMBIENCE_ONESHOTS[Math.floor(Math.random() * AMBIENCE_ONESHOTS.length)];
        this.playOneShot(file, 0.3, this.ambienceVolume);
        this.scheduleAmbienceOneShot();
      }
    }, delay);
  }
}
