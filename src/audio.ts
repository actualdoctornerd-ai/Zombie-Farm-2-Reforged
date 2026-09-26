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

export interface FightStrike {
  team: "player" | "enemy";
  attackName?: string;
  impact?: "projectile";
  sfxFile?: string;
}

// Most clips are shipped as compressed .mp3 (universal browser support). The
// .wav->.mp3 coercion lets data-driven filenames (e.g. decor tapSound values
// authored as *.wav) resolve to the shipped file without editing that data.
// Recovered fight cues opt out through an explicit path and retain their PCM WAV.
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

// Ground truth from Attacks.json: player zombies' ordinary attack is ZombieBite,
// while stage actors choose a cue matching their authored attack. These files use
// an explicit assets/audio/ path so A() preserves the recovered WAV extension
// instead of applying its legacy data-driven WAV -> MP3 decor coercion.
function fightStrikeFile({ team, attackName = "", impact, sfxFile }: FightStrike): string {
  // An explicitly named cue wins over the generic thrown-debris splat: the alien bolt
  // has its own authored fire/hit pair (alienLaser.wav / stun.wav).
  if (sfxFile) return sfxFile.includes("/") ? sfxFile : `audio/${sfxFile}`;
  if (impact === "projectile") return "audio/splat.wav";
  const attack = attackName.toLowerCase();
  if (attack.includes("bite")) return "audio/bite.wav";
  if (attack.includes("poke") || attack.includes("stab") || attack.includes("midgetstack")) {
    return "audio/poke.wav";
  }
  if (attack.includes("slice") || attack.includes("slash")) return "audio/swipe.wav";
  if (attack.includes("flail") || attack.includes("scratch")) return "audio/flail.wav";
  if (team === "player") return "audio/bite.wav";
  return "audio/punch.wav";
}

// Exact authored length, in seconds, of every track we loop — taken from the
// original uncompressed source each MP3 was encoded from.
//
// Our MP3s carry a bare Xing header with no LAME gapless tag, so nothing tells a
// decoder how much of the stream is encoder delay and end padding. Every decoder
// therefore renders that padding (52-75 ms here) as real silence, which is the
// audible blip at the loop point. These lengths are what let the loop region
// address only the authored audio inside the padded decode. A track absent from
// the table simply loops its whole decoded buffer, as before.
const AUTHORED_SECONDS: Record<string, number> = {
  "SFXambience.mp3": 8,
  "dayFarmBGM.mp3": 1376780 / 44100,
  "alienStageBGM.mp3": 15.36,
  "enrageBGM.mp3": 222821 / 44100,
  "farmStageBGM.mp3": 64,
  "fightBGM.mp3": 185684 / 44100,
  "ninjaStageBGM.mp3": 24,
  "pirateStageBGM.mp3": 207529 / 44100,
  "robotStageBGM.mp3": 61.44,
  "winBGM.mp3": 453600 / 44100,
};

/** Cross-fade used when a decoded buffer takes over from the streaming element. */
const HANDOVER_MS = 150;

/**
 * How long to wait for `AudioContext.resume()` before giving up on it.
 *
 * iOS takes the audio session away constantly and for mundane reasons — a call, a
 * notification, Siri, the lock screen, another app, memory pressure — and Safari
 * reports that as the non-standard state `"interrupted"`. A `resume()` issued while
 * interrupted can return a promise that NEVER settles, so it must always be raced
 * rather than awaited: an unguarded `await` there is a permanently silent game.
 */
const RESUME_TIMEOUT_MS = 1_200;

/** Minimum gap between context rebuilds, so a device that keeps taking the session
 *  away can't put us in a tear-down loop. */
const REBUILD_COOLDOWN_MS = 5_000;

/** How often to check that audio we believe is playing is actually advancing. */
const WATCHDOG_MS = 2_000;

/**
 * Longest looping track we will hold decoded in memory for the sake of a gapless
 * seam.
 *
 * A decoded buffer costs ~0.37 MB per second (Float32 per channel, stereo, at the
 * 48 kHz iOS runs contexts at) — so `farmStageBGM` alone is 23 MB and `robotStageBGM`
 * 22 MB, against 11 MB for the farm bed and 3 MB for the ambience bed. The long ones
 * are also the ones whose seam is heard least: a stage theme loops once or twice in a
 * whole invasion, while the beds loop all session. 40 s keeps every track that loops
 * often and drops exactly the two that dominate the footprint.
 *
 * This matters beyond tidiness: on a phone already carrying tens of megabytes of
 * artwork, that resident audio is itself a reason the OS reclaims the audio session,
 * which is the interruption the recovery path above exists to survive.
 */
const MAX_DECODED_LOOP_SECONDS = 40;

/**
 * The Web Audio Session API's category control (`navigator.audioSession.type`),
 * which only WebKit implements and which is the ONLY way to tell iOS what kind of
 * audio this page is producing.
 *
 * It matters because of the hardware Ring/Silent switch. iOS routes Web Audio —
 * every buffered one-shot, and every looping track once it hands over to its
 * decoded source — through the "ambient" audio session by default, and ambient
 * audio is silenced outright when the switch is set to silent. Media elements are
 * not, which is why a flipped switch used to take out only some of the game and
 * now takes out nearly all of it. `"playback"` is the category that says "this is
 * the media the user came for", and it plays through the switch.
 *
 * The cost of `"playback"` is that it is not mixable: claiming it stops whatever
 * the player had going in another app. So it is claimed only while the game is
 * actually meant to be making sound, and released back to `"auto"` when it isn't.
 */
type AudioSessionType = "auto" | "playback" | "transient" | "transient-solo" | "ambient";

/** `navigator.audioSession`, or undefined off WebKit / on older iOS, where the
 *  silent switch simply cannot be overridden from the web. */
function audioSessionApi(): { type: AudioSessionType } | undefined {
  if (typeof navigator === "undefined") return undefined;
  return (navigator as unknown as { audioSession?: { type: AudioSessionType } }).audioSession;
}

/** Resolve true if `promise` fulfils within `ms`, false if it rejects OR hangs. */
function settledWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), ms);
    promise.then(() => finish(true), () => finish(false));
  });
}

/** What a LoopTrack needs from the shared audio session. `context()` can return a
 *  DIFFERENT context than it did last call — the manager replaces one the platform
 *  has taken away — so a track must never cache it. */
interface AudioSession {
  context(): AudioContext | null;
  /** Get the session running again, rebuilding it if necessary. Resolves false when
   *  only a fresh user gesture can help. */
  ensureRunning(): Promise<boolean>;
}

/**
 * Where the authored audio actually sits inside a decoded buffer.
 *
 * Browsers strip differing amounts of MP3 encoder delay on their own (some all of
 * it, some the 529-sample decoder delay, some none), so the head is measured
 * rather than assumed. It can only ever lie within the padding surplus
 * `buffer.duration - authored`, and every source here has signal at sample 0, so
 * the first sample above a relative floor inside that window is the true start.
 */
function loopRegion(buffer: AudioBuffer, authored: number | undefined) {
  const whole = { start: 0, end: buffer.duration };
  if (!authored || !(buffer.duration > authored) || typeof buffer.getChannelData !== "function") {
    return whole;
  }
  const rate = buffer.sampleRate;
  const surplus = Math.min(Math.ceil((buffer.duration - authored) * rate), buffer.length);
  const data = buffer.getChannelData(0);
  let peak = 0;
  for (let i = 0, n = Math.min(buffer.length, surplus + rate); i < n; i++) {
    peak = Math.max(peak, Math.abs(data[i]));
  }
  if (peak === 0) return whole; // a silent decode tells us nothing
  const floor = peak * 0.01;
  let head = 0;
  while (head < surplus && Math.abs(data[head]) <= floor) head++;
  return { start: head / rate, end: Math.min(head / rate + authored, buffer.duration) };
}

/**
 * A long track that has to loop seamlessly (music beds, the ambience bed).
 *
 * A media element cannot do this. `loop = true` makes it seek back to zero, which
 * re-primes the demuxer, and on top of that it plays the encoder padding described
 * above — together, the audible half-beat of dead air at every loop point.
 *
 * Web Audio has neither problem: an AudioBufferSourceNode wraps a sample index
 * with no seek at all, and `loopStart`/`loopEnd` let us point it at just the
 * authored audio. The element is kept as the immediate-start path (decoding needs
 * the whole file, streaming does not) and as the fallback wherever Web Audio is
 * unavailable; once the buffer lands, playback cross-fades over to it and every
 * later seam is sample-accurate.
 */
class LoopTrack {
  private el: HTMLAudioElement;
  private source: AudioBufferSourceNode | null = null;
  private amp: GainNode | null = null;
  private buffer: AudioBuffer | null = null;
  private region = { start: 0, end: 0 };
  private decodeStarted = false;
  private wantPlay = false;
  private startedAt = 0;   // ctx.currentTime when `source` started
  private startedFrom = 0; // offset into the loop region at that moment
  private offset = 0;      // resume position while stopped
  private fade: ReturnType<typeof setInterval> | null = null;
  private vol = 1;
  private decodeAttempts = 0;
  private released = false; // dispose() dropped the element source; play() restores it

  constructor(
    private readonly url: string,
    private readonly authored: number | undefined,
    private readonly looping: boolean,
    /** Whether this track earns the decoded (gapless) path at all — see
     *  MAX_DECODED_LOOP_SECONDS. When false it simply streams, as music did before
     *  gapless looping existed, and costs no resident memory. */
    private readonly gapless: boolean,
    private readonly session: AudioSession,
  ) {
    // Created up front (not on first play) so channel volumes can be applied
    // before anything starts, and lazy so the bytes are only fetched once the
    // channel is actually enabled.
    this.el = new Audio(url);
    this.el.loop = looping;
    this.el.preload = "none";
  }

  get volume() { return this.vol; }
  set volume(value: number) {
    this.vol = value;
    this.el.volume = value;
    if (this.amp && this.fade === null) this.amp.gain.value = value;
  }

  /** Whether nothing is AUDIBLE right now — including after a start the browser's
   *  autoplay policy rejected, which is what re-arms the gesture listener.
   *
   *  A started source counts as playing only while its context is running: an
   *  interrupted or suspended context freezes every buffer source without telling
   *  anyone, so "a source object exists" is not evidence of sound. Reporting that as
   *  playing is what let a silent track sit there with nothing ever retrying it.
   *  `wantPlay` is intent and deliberately separate: a blocked start still wants to
   *  play. */
  get paused() {
    if (this.source) return this.session.context()?.state !== "running";
    return this.el.paused;
  }

  /** Whether this track is meant to be playing (as opposed to deliberately stopped),
   *  so a session recovery knows what to bring back. */
  get wanted() { return this.wantPlay; }

  /** Restart from the top on the next play (the non-looping victory sting). */
  rewind() {
    this.offset = 0;
    if (this.el.currentTime > 0) this.el.currentTime = 0;
  }

  play(): Promise<void> {
    this.wantPlay = true;
    this.restoreElement();
    this.decode();
    const ctx = this.session.context();
    if (ctx && this.buffer) {
      if (this.ensureSource()) return Promise.resolve();
      if (ctx.state !== "running") {
        // Backgrounding suspends the context, an interruption freezes it, and the
        // platform can close it outright. Recovering is the session's job — a bare
        // resume() here can hang forever on iOS — and the element is not a stand-in:
        // it is the gappy path, and nothing would ever hand playback back to the
        // buffer. Rejecting re-arms the gesture listener, which is the one thing
        // that CAN fix a session only the user is allowed to restart.
        return this.session.ensureRunning().then((ok) => {
          if (ok && this.wantPlay && this.ensureSource()) return;
          throw new Error("audio session unavailable");
        });
      }
    }
    this.el.volume = this.vol;
    return this.el.play();
  }

  pause() {
    this.offset = this.position();
    this.wantPlay = false;
    this.endFade();
    this.stopSource();
    this.el.pause();
  }

  /** The session was interrupted and has come back.
   *
   *  A source the platform froze is not reliably restarted by it — on iOS a buffer
   *  source that was live across an interruption often stays silent even once the
   *  context reads "running" again — so replace it from the position it stopped at
   *  rather than trusting it. Harmless when called spuriously: the replacement
   *  resumes from the same offset, because a stopped context's clock doesn't
   *  advance. */
  resync() {
    if (!this.source) return;
    this.offset = this.position();
    this.stopSource();
    this.ensureSource();
  }

  /** The context this track is playing on is being replaced. Bank the position and
   *  drop the nodes that belong to it, keeping both the decoded buffer (portable,
   *  and megabytes to rebuild) and `wantPlay` so the new session can resume.
   *
   *  Must be called while the DYING context is still the session's current one —
   *  `position()` reads its clock. */
  detach() {
    this.offset = this.position();
    this.endFade();
    this.stopSource();
  }

  /** Give back the decoded buffer and the media resource, banking the position.
   *
   *  A decoded minute of stereo music is over 20 MB, so a track that has stepped
   *  aside — a finished raid's theme, or the farm bed for the length of an invasion —
   *  must not stay resident. The track remains usable: the next `play()` re-attaches
   *  the element and re-decodes, which is a cached fetch plus a worker decode while
   *  the element already streams. */
  dispose() {
    this.offset = this.position();
    this.wantPlay = false;
    this.stopSource();
    this.endFade();
    this.el.pause();
    this.el.src = "";
    this.released = true;
    this.buffer = null;
    this.decodeStarted = false;
    this.decodeAttempts = 0;
  }

  // --- internals -----------------------------------------------------------
  /** Re-attach the media source dropped by `dispose()`. `el.src` reads back as the
   *  resolved page URL once cleared, so the flag is what tracks this, not the DOM. */
  private restoreElement() {
    if (!this.released) return;
    this.released = false;
    this.el.src = this.url;
  }

  /** Make sure a live buffer source is producing sound, taking over from a
   *  streaming element if one is mid-flight. Returns false when the buffer path
   *  isn't usable right now and the caller should fall back. */
  private ensureSource(): boolean {
    const ctx = this.session.context();
    if (!ctx || !this.buffer || ctx.state !== "running") return false;
    if (this.source) return true; // running context + live source == audible
    if (!this.el.paused) {
      // The buffer landed while the element was streaming — or a recovery restored
      // the session under it. Either way the gapless path takes over from here.
      this.handover();
      return this.source !== null;
    }
    return this.startSource(this.offset);
  }

  /** Seconds into the loop region right now, whichever path is playing. */
  private position(): number {
    const ctx = this.session.context();
    const length = this.region.end - this.region.start;
    if (this.source && ctx && length > 0) {
      const elapsed = this.startedFrom + (ctx.currentTime - this.startedAt);
      return this.looping ? elapsed % length : Math.min(elapsed, length);
    }
    // A streaming element reports its position within the padded stream, which is
    // the same timeline the decoded buffer uses.
    if (!this.el.paused && Number.isFinite(this.el.currentTime)) {
      return Math.max(0, this.el.currentTime - this.region.start);
    }
    return this.offset;
  }

  private decode() {
    if (this.decodeStarted || this.buffer || !this.gapless) return;
    const ctx = this.session.context();
    if (!ctx || this.decodeAttempts >= 3) return; // no Web Audio: the element stays in charge
    this.decodeStarted = true;
    this.decodeAttempts++;
    void fetch(this.url)
      .then((response) => response.arrayBuffer())
      .then((data) => ctx.decodeAudioData(data))
      .then((decoded) => {
        this.buffer = decoded;
        this.region = loopRegion(decoded, this.authored);
        if (this.wantPlay && ctx === this.session.context()) this.ensureSource();
      })
      // A failed fetch/decode simply leaves this track on the element, which is
      // exactly the old behaviour — never a hard failure. Clearing the flag lets a
      // later play() retry (a decode against a context the platform then killed
      // rejects, and permanently stranding the track on the element for that is the
      // same missing-recovery bug this file exists to fix). Bounded by the attempt
      // cap above, so a genuinely missing file can't refetch on every event.
      .catch(() => { this.decodeStarted = false; });
  }

  /** The buffer arrived while the element was streaming: start the gapless source
   *  at the element's position and cross-fade, so the switch itself is inaudible. */
  private handover() {
    const streaming = !this.el.paused;
    this.startSource(this.position(), streaming ? HANDOVER_MS / 1000 : 0);
    if (!streaming || !this.source) return;
    const from = this.el.volume;
    const steps = 6;
    let step = 0;
    this.endFade();
    this.fade = setInterval(() => {
      step++;
      this.el.volume = Math.max(0, from * (1 - step / steps));
      if (step < steps) return;
      this.endFade();
      this.el.pause();
      this.el.volume = this.vol;
      if (this.amp) this.amp.gain.value = this.vol;
    }, HANDOVER_MS / steps);
  }

  private endFade() {
    if (this.fade === null) return;
    clearInterval(this.fade);
    this.fade = null;
  }

  /** Returns whether a source is now playing. */
  private startSource(offset: number, fadeIn = 0): boolean {
    const ctx = this.session.context();
    if (!ctx || !this.buffer) return false;
    this.stopSource();
    const length = this.region.end - this.region.start;
    const from = length > 0 ? Math.min(offset, length) : 0;
    try {
      const source = ctx.createBufferSource();
      source.buffer = this.buffer;
      if (this.looping) {
        source.loop = true;
        source.loopStart = this.region.start;
        source.loopEnd = this.region.end;
      }
      const amp = ctx.createGain();
      amp.gain.value = fadeIn > 0 ? 0 : this.vol;
      if (fadeIn > 0 && typeof amp.gain.linearRampToValueAtTime === "function") {
        amp.gain.linearRampToValueAtTime(this.vol, ctx.currentTime + fadeIn);
      }
      source.connect(amp).connect(ctx.destination);
      source.onended = () => {
        if (source !== this.source) return; // superseded by a restart
        this.source = null;
        this.wantPlay = false; // a non-looping sting finished on its own
      };
      // Non-looping stings are bounded explicitly so the trailing padding never plays.
      source.start(0, this.region.start + from, this.looping ? undefined : length - from);
      this.source = source;
      this.amp = amp;
      this.startedAt = ctx.currentTime;
      this.startedFrom = from;
      return true;
    } catch {
      // A buffer decoded by a context that has since been replaced can be refused.
      // Drop it so the next play() re-decodes against the live context, and let the
      // element cover this attempt.
      this.buffer = null;
      this.decodeStarted = false;
      return false;
    }
  }

  private stopSource() {
    if (!this.source) return;
    const source = this.source;
    const amp = this.amp;
    this.source = null;
    this.amp = null;
    source.onended = null;
    // Nodes belonging to a closed context throw on every one of these.
    try { source.stop(); } catch { /* never started, or context gone */ }
    try { source.disconnect(); } catch { /* context gone */ }
    try { amp?.disconnect(); } catch { /* context gone */ }
  }
}

// Ambient farm life: a quiet continuous bed, plus an occasional rooster/crow so
// the farm never sounds dead. One-shots fire on a randomized 18-42s timer.
const AMBIENCE_BED = "SFXambience.mp3";
const AMBIENCE_ONESHOTS = ["rooster.mp3", "crow.mp3", "birds.mp3"];
const AMBIENCE_MIN_MS = 18_000;
const AMBIENCE_MAX_MS = 42_000;

// A zombie's "Brains…" bark, chosen by its group (the game ships one clip per
// group). The Regular group's cyborg/robot/robocop tiers use the robot bark.
function brainFile(group: string, key: string): string | null {
  switch (group) {
    case "Garden": return "brainGarden.mp3";
    case "Girl":
    case "Female": return "brainGirl.mp3";
    case "Small": return "brainSmall.mp3";
    case "Large": return "brainLarge.mp3";
    case "Headless": return null;
    case "Regular":
      return /Tier[2-5]$/.test(key) ? "brainRobot.mp3" : "brainRegular.mp3";
    default: return "brainRegular.mp3"; // Headless + anything unmapped
  }
}

function zombieGroupFromKey(key: string): string {
  return /^ZombieActor(Garden|Girl|Small|Large|Regular|Headless)/i.exec(key)?.[1] ?? "Regular";
}

interface StoredSettings {
  master?: boolean;
  music?: boolean;
  sfx?: boolean;
  ambience?: boolean;
  masterVolume?: number;
  musicVolume?: number;
  sfxVolume?: number;
  ambienceVolume?: number;
  muteWhenUnfocused?: boolean;
}

const clampVolume = (value: unknown, fallback = 1): number =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : fallback;

// Every fight cue a raid can fire. Decoded up front on entering a raid so combat
// never falls back to the media-element path mid-swing (see playOneShot).
const FIGHT_CUE_FILES = [
  "audio/bite.wav", "audio/flail.wav", "audio/poke.wav",
  "audio/swipe.wav", "audio/punch.wav", "audio/splat.wav",
  // Alien boss laser: fired on `AlienStageBullet init`, hit on `collidedWith:`.
  "audio/alienLaser.wav", "audio/stun.wav",
  // Mega-Robot's nuclear flames (`RobotStageActorGiantBot explodeAttack:`).
  "audio/explosion.wav",
];

/** Web Audio voices allowed at once. Combat can fire ~20 cues/s; past this many
 *  overlapping clips nothing is audible anyway, so extra cues are dropped rather
 *  than allowed to pile up. */
const MAX_VOICES = 24;

/** Safety net for the media-element fallback: reclaim an element to the pool even
 *  if `ended` never arrives (iOS silently stalls elements it decides to evict).
 *  Without this the pool starves and every later cue allocates a fresh element. */
const ONE_SHOT_RECLAIM_MS = 10_000;

export class AudioManager {
  /** Raised once when this device refuses to store the audio settings, so the
   *  player is told rather than left wondering why their volume keeps resetting.
   *  Wired to a HUD toast in main, like SaveManager.onStorageError. */
  onStorageError: ((message: string) => void) | null = null;
  private storageWarned = false;
  masterOn = true;
  musicOn = true;
  sfxOn = true;
  ambienceOn = true;
  masterVolume = 1;
  musicVolume = 1;
  sfxVolume = 1;
  ambienceVolume = 1;
  muteWhenUnfocused = false;
  private bgm: LoopTrack;
  private ambBed: LoopTrack;
  private ambTimer: ReturnType<typeof setTimeout> | null = null;
  private oneShots = new Set<HTMLAudioElement>();
  // Finished one-shot elements, pooled per file for reuse. Raid combat fires up to
  // ~20 cues/s; a fresh `new Audio()` per cue makes iOS re-enter its media-loading
  // pipeline every time, a reliable source of main-thread jank and audio stutter.
  private oneShotPool = new Map<string, HTMLAudioElement[]>();
  // Web Audio one-shot path. See playOneShot: media elements cost several ms of
  // main-thread time per play() on iOS, which is fine for a menu click and ruinous
  // for a raid firing an attack cue on nearly every 50 ms combat tick.
  private ctx: AudioContext | null = null;
  private ctxUnavailable = false;
  private buffers = new Map<string, AudioBuffer>();
  private decoding = new Set<string>();
  private voices = 0;
  private armed = false; // whether a user-gesture resume listener is pending
  // Session recovery. `ensuring` de-dupes concurrent attempts (combat asks on every
  // dropped cue), `lastRebuild` rate-limits tear-downs, and the watchdog catches the
  // failures that produce no event at all. See ensureRunning / checkAudio.
  private ensuring: Promise<boolean> | null = null;
  private lastRebuild = 0;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private lastClock = -1;
  // While a raid is up, its looping stage BGM replaces the farm bgm. `raidBgm`
  // holds the active raid track (and `raidFile` its filename); the farm bgm is
  // paused for the raid's duration.
  private raidBgm: LoopTrack | null = null;
  private raidFile = "";
  private zombieBarkSource: (() => { group: string; key: string } | null) | null = null;

  constructor() {
    this.bgm = this.track("dayFarmBGM.mp3", true);
    this.bgm.volume = 0.4;

    this.ambBed = this.track(AMBIENCE_BED, true);
    this.ambBed.volume = 0.25;

    // Restore persisted channel toggles. Autoplay may be blocked until the user
    // interacts, so arm a one-shot gesture listener to (re)start any looping
    // channel that couldn't begin immediately.
    const s = this.read();
    this.masterOn = s.master ?? true;
    this.musicOn = s.music ?? true;
    this.sfxOn = s.sfx ?? true;
    this.ambienceOn = s.ambience ?? true;
    this.masterVolume = clampVolume(s.masterVolume);
    this.musicVolume = clampVolume(s.musicVolume);
    this.sfxVolume = clampVolume(s.sfxVolume);
    this.ambienceVolume = clampVolume(s.ambienceVolume);
    this.muteWhenUnfocused = s.muteWhenUnfocused ?? false;
    this.applyLoopVolumes();
    this.applyAudioSessionType();

    // Hidden/backgrounded pages always stop audio. Focus events additionally
    // support the optional visible-desktop-window mute behavior. Mobile browsers
    // may emit pagehide/freeze more reliably than blur or visibilitychange.
    window.addEventListener("focus", this.syncFocusAudio);
    window.addEventListener("blur", this.syncFocusAudio);
    window.addEventListener("pagehide", this.pauseForBackground);
    window.addEventListener("pageshow", this.syncFocusAudio);
    document.addEventListener("visibilitychange", this.syncFocusAudio);
    document.addEventListener("freeze", this.pauseForBackground);

    if (this.musicOn && this.canPlay()) void this.bgm.play().catch(() => this.arm());
    if (this.ambienceOn && this.canPlay()) this.startAmbience();
    this.startWatchdog();
  }

  /** Release timers and the audio session. Only the page teardown needs this; the
   *  manager otherwise lives as long as the game does. */
  destroy() {
    this.stopWatchdog();
    this.stopAmbience();
    for (const track of this.loops()) track.dispose();
    const ctx = this.ctx;
    this.ctx = null;
    if (ctx) {
      ctx.onstatechange = null;
      try { void ctx.close().catch(() => { /* already gone */ }); } catch { /* no close */ }
    }
  }

  // --- persistence ---------------------------------------------------------
  private read(): StoredSettings {
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
      // Anything but a plain object is corrupt storage, not settings. Reading the
      // fields off it would throw inside the constructor and take the whole game's
      // boot with it, so a stored `null`/number/string falls back to the defaults.
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? parsed as StoredSettings
        : {};
    } catch {
      return {};
    }
  }
  private persist() {
    const data: StoredSettings = {
      master: this.masterOn,
      music: this.musicOn, sfx: this.sfxOn, ambience: this.ambienceOn,
      masterVolume: this.masterVolume,
      musicVolume: this.musicVolume, sfxVolume: this.sfxVolume,
      ambienceVolume: this.ambienceVolume,
      muteWhenUnfocused: this.muteWhenUnfocused,
    };
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(data));
    } catch (error) {
      // A refused write is INVISIBLE from inside the game: the slider moves, the
      // volume changes, and the whole thing is gone at next launch. That reads as
      // "my settings don't save" with nothing anywhere to explain it, so say it
      // once — the save path already warns the same way for the same reason.
      console.warn("[audio] settings write failed", error);
      if (!this.storageWarned) {
        this.storageWarned = true;
        this.onStorageError?.(
          "Audio settings can't be saved in this browser, so they'll reset when you come back. " +
          "Private browsing or a full storage quota is the usual cause.",
        );
      }
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
      this.resumeFromGesture();
    };
    window.addEventListener("pointerdown", resume, { once: true });
  }

  /** Resume enabled loops synchronously from a real user gesture.
   *
   * Browsers may reject the constructor's autoplay attempt. The start screen
   * calls this from its "Click to Start" handler so playback is authorized by
   * that same gesture instead of depending on the rejection/arming race.
   */
  resumeFromGesture() {
    if (!this.canPlay()) return;
    // Ahead of any start, so the session that gets activated below is the one that
    // plays through the Ring/Silent switch rather than an ambient one already running.
    this.applyAudioSessionType();
    // Start inside the gesture itself — an autoplay policy only honours what the
    // gesture synchronously reaches — then let the async recovery pick up whatever
    // needed the session back first.
    this.restartLoops();
    // Unlock Web Audio from the same gesture. iOS parks a context created outside
    // one in "suspended" forever, which would leave every effect on the slow
    // media-element path for the whole session.
    void this.recover();
    this.startWatchdog();
  }

  // --- audio session ---------------------------------------------------------
  /** Every looping track that currently exists, for session-wide operations. */
  private loops(): LoopTrack[] {
    const tracks = [this.bgm, this.ambBed];
    if (this.raidBgm) tracks.push(this.raidBgm);
    return tracks;
  }

  /** Start whichever loops should be audible but aren't. Safe to call at any time:
   *  a track already producing sound is left alone (`paused` means inaudible, not
   *  "has no source"), so this is the single idempotent repair for every path that
   *  can leave music stopped. */
  private restartLoops() {
    if (!this.canPlay()) return;
    if (this.musicOn && this.activeBgm().paused)
      void this.activeBgm().play().catch(() => this.arm());
    if (this.ambienceOn && this.ambBed.paused)
      void this.ambBed.play().catch(() => this.arm());
  }

  /** Get the session running and put back whatever it was carrying. */
  private recover(): Promise<void> {
    return this.ensureRunning().then((ok) => {
      if (ok) this.restartLoops();
      else this.arm(); // only a user gesture can help now
    });
  }

  /**
   * Get the audio session into a running state.
   *
   * The platform takes it away for reasons the game never sees — on iOS a call, a
   * notification, Siri, the lock screen, another app, or memory pressure — and
   * Safari reports that as the non-standard state `"interrupted"`, in which
   * `resume()` may return a promise that never settles. So resume is RACED, never
   * awaited, and when it loses (or the context has been closed outright) the only
   * cure is a brand new context. Concurrent callers share one attempt.
   */
  private ensureRunning(): Promise<boolean> {
    if (this.ensuring) return this.ensuring;
    const attempt = this.attemptRunning().then(
      (ok) => { this.ensuring = null; return ok; },
      () => { this.ensuring = null; return false; },
    );
    this.ensuring = attempt;
    return attempt;
  }

  private async attemptRunning(): Promise<boolean> {
    let ctx = this.audioContext();
    if (!ctx) return false;
    if (ctx.state === "running") return true;
    if (ctx.state !== "closed" && await this.resumeWithin(ctx)) return true;

    ctx = this.rebuildContext();
    if (!ctx) return false;
    if (ctx.state === "running") return true;
    return this.resumeWithin(ctx);
  }

  /** True only if `resume()` both settled in time AND left the context running. */
  private async resumeWithin(ctx: AudioContext): Promise<boolean> {
    try {
      if (!await settledWithin(ctx.resume(), RESUME_TIMEOUT_MS)) return false;
    } catch {
      return false; // resume() can throw outright on a dead context
    }
    return ctx.state === "running";
  }

  /**
   * Replace a context the platform has taken away.
   *
   * Rate-limited, because a device that keeps interrupting us must not be able to
   * drive a tear-down loop, and because iOS caps how many contexts a page may hold.
   */
  private rebuildContext(): AudioContext | null {
    const now = Date.now();
    if (now - this.lastRebuild < REBUILD_COOLDOWN_MS) return this.ctx;
    this.lastRebuild = now;

    // Bank positions and drop nodes while the DYING context is still current —
    // detach() reads its clock.
    for (const track of this.loops()) track.detach();

    const dying = this.ctx;
    this.ctx = null;
    // Those voices were counted against sources that can now never report `ended`.
    this.voices = 0;
    // One-shot buffers are small and cheap to re-decode, and some engines refuse a
    // buffer that outlived its context. The music buffers are megabytes each, are
    // portable by spec, and stay with their tracks.
    this.buffers.clear();
    this.decoding.clear();
    if (dying) {
      dying.onstatechange = null;
      try { void dying.close().catch(() => { /* already gone */ }); } catch { /* no close */ }
    }

    // A construction failure here must not latch Web Audio off for the session the
    // way a first-use failure does: the platform is momentarily out of contexts, not
    // missing the API. Clear the flag on both sides so the next attempt past the
    // cooldown gets to try again.
    this.ctxUnavailable = false;
    const fresh = this.audioContext();
    this.ctxUnavailable = false;
    return fresh;
  }

  /**
   * Watch for audio that we believe is playing but isn't.
   *
   * Two failures produce no event at all: a source left on a context the system
   * froze (whose `state` can still read "running" while its clock stops), and a loop
   * that never restarted because the focus/visibility event that would have
   * restarted it never came. Both present to the player as music dropping out
   * mid-session with no way back.
   */
  private startWatchdog() {
    if (this.watchdog !== null) return;
    this.lastClock = -1;
    this.watchdog = setInterval(this.checkAudio, WATCHDOG_MS);
    // Node only (tests): a background health check must never hold the process open.
    (this.watchdog as unknown as { unref?: () => void }).unref?.();
  }

  private stopWatchdog() {
    if (this.watchdog === null) return;
    clearInterval(this.watchdog);
    this.watchdog = null;
    this.lastClock = -1;
  }

  private checkAudio = () => {
    if (!this.canPlay() || !(this.musicOn || this.ambienceOn)) return this.stopWatchdog();
    const ctx = this.ctx;
    if (ctx) {
      if (ctx.state !== "running") {
        this.lastClock = -1;
        void this.recover();
        return;
      }
      // A "running" context whose clock has stopped is an interruption the platform
      // never reported. resume() has nothing to do here, so go straight to a rebuild.
      if (this.lastClock >= 0 && ctx.currentTime <= this.lastClock) {
        this.lastClock = -1;
        this.rebuildContext();
        void this.recover();
        return;
      }
      this.lastClock = ctx.currentTime;
    }
    // Reached with no context at all when every live track streams (the long stage
    // themes), which an interruption stops just as dead — those need the same repair.
    this.restartLoops();
  };

  // --- music ---------------------------------------------------------------
  /** Build a track, giving it the authored length that lets it skip the encoder
   *  padding baked into our MP3s, and deciding whether it earns the decoded path.
   *
   *  Gapless looping is a memory purchase, and what it buys depends entirely on how
   *  often the seam is heard. The farm bed and the ambience bed loop all session and
   *  are cheap, so they keep it; a 64-second stage theme loops perhaps twice in a
   *  whole invasion and costs 23 MB, so it streams. A non-looping sting has no seam
   *  to hide and never decodes. An unknown length is treated as too long: we can't
   *  price what we can't measure. */
  private track(file: string, looping: boolean): LoopTrack {
    const authored = AUTHORED_SECONDS[file];
    const gapless = looping && authored !== undefined && authored <= MAX_DECODED_LOOP_SECONDS;
    return new LoopTrack(A(file), authored, looping, gapless, {
      context: () => this.audioContext(),
      ensureRunning: () => this.ensureRunning(),
    });
  }

  // The looping track that should be playing right now: the raid stage BGM while
  // a raid is up, otherwise the farm bgm.
  private activeBgm(): LoopTrack {
    return this.raidBgm ?? this.bgm;
  }

  private canPlay(): boolean {
    return this.masterOn && !document.hidden &&
      (!this.muteWhenUnfocused || document.hasFocus());
  }

  /**
   * Tell iOS whether we are producing media the Ring/Silent switch should respect.
   *
   * See AudioSessionType: without this the switch silences every Web Audio sound in
   * the game. Claim `"playback"` while any channel is on — that is the player asking
   * for sound — and hand the category back when they have turned everything off, so
   * a muted game stops displacing whatever else they were listening to.
   *
   * Called from the settings toggles and from the start gesture, since some WebKit
   * builds only pick the category up when the session is next activated. A no-op
   * everywhere the API is absent.
   */
  private applyAudioSessionType() {
    const session = audioSessionApi();
    if (!session) return;
    const wantsSound = this.masterOn && (this.musicOn || this.sfxOn || this.ambienceOn);
    const want: AudioSessionType = wantsSound ? "playback" : "auto";
    try {
      if (session.type !== want) session.type = want;
    } catch { /* read-only or unsupported value: nothing to fall back to */ }
  }

  // The looping channels' final element volumes: authored base level × per-channel
  // slider × the master slider. One-shots apply the same product in playOneShot.
  private applyLoopVolumes() {
    this.bgm.volume = 0.4 * this.musicVolume * this.masterVolume;
    if (this.raidBgm) this.raidBgm.volume = 0.4 * this.musicVolume * this.masterVolume;
    this.ambBed.volume = 0.25 * this.ambienceVolume * this.masterVolume;
  }

  private pauseForBackground = () => {
    this.stopWatchdog(); // deliberate silence is not a fault to repair
    this.activeBgm().pause();
    this.stopAmbience();
    for (const audio of this.oneShots) audio.pause();
    this.oneShots.clear();
    // Hand the audio hardware back too, so a backgrounded PWA isn't holding a
    // running context alongside the media session it relinquishes below.
    if (this.ctx && this.ctx.state === "running") {
      void this.ctx.suspend().catch(() => { /* already gone */ });
    }
    // Where supported, immediately relinquish the OS media session so a
    // backgrounded PWA/tab no longer presents itself as active music.
    try {
      if (typeof navigator !== "undefined" && navigator.mediaSession)
        navigator.mediaSession.playbackState = "none";
    } catch { /* Media Session is optional and browser-controlled. */ }
  };

  private syncFocusAudio = () => {
    if (!this.canPlay()) return this.pauseForBackground();
    this.startWatchdog();
    // Returning to the foreground is also where an interruption that happened while
    // we were away gets discovered, so this goes through the full recovery rather
    // than a bare resume() that can hang.
    if (this.ctx) void this.recover();
    if (this.musicOn) void this.activeBgm().play().catch(() => this.arm());
    if (this.ambienceOn) this.startAmbience();
  };

  setMuteWhenUnfocused(on: boolean) {
    this.muteWhenUnfocused = on;
    this.syncFocusAudio();
    this.persist();
  }

  // Master kill switch over every channel: off pauses all loops and suppresses
  // one-shots (via canPlay), on resumes whichever loop toggles are enabled.
  setMaster(on: boolean) {
    this.masterOn = on;
    this.applyAudioSessionType();
    this.syncFocusAudio();
    this.persist();
  }

  setMasterVolume(value: number) {
    this.masterVolume = clampVolume(value);
    this.applyLoopVolumes();
    this.persist();
  }

  setMusic(on: boolean) {
    this.musicOn = on;
    this.applyAudioSessionType();
    if (on && this.canPlay()) {
      this.startWatchdog();
      void this.activeBgm().play().catch(() => this.arm());
    } else this.activeBgm().pause();
    this.persist();
  }

  setMusicVolume(value: number) {
    this.musicVolume = clampVolume(value);
    this.applyLoopVolumes();
    this.persist();
  }

  // Enter a raid: swap the farm bgm for the raid's looping stage BGM (`file` is a
  // filename under assets/audio/). Safe to call regardless of the music toggle —
  // it only actually plays when music is on. No-op if the same track is already up.
  enterRaid(file: string) {
    if (!file) return;
    if (this.raidFile !== file) {
      this.exitRaid(true); // tear down any prior raid track without resuming farm
      // The farm bed steps aside for the whole raid, so it gives its decoded buffer
      // back rather than holding 11 MB through a fight that has its own theme. It
      // re-decodes on the way out, behind the element that starts streaming at once.
      this.bgm.dispose();
      const a = this.track(file, true);
      a.volume = 0.4 * this.musicVolume * this.masterVolume;
      this.raidBgm = a;
      this.raidFile = file;
    }
    // Decode every attack cue before the first swing lands. Combat fires these at
    // up to ~20/s; a clip that is still decoding falls back to a media element,
    // which is exactly the per-play main-thread cost raids cannot afford. These are
    // fractions of a second each — the whole set costs less than a second of music.
    for (const cue of FIGHT_CUE_FILES) this.buffer(A(cue));
    if (this.musicOn && this.canPlay()) void this.raidBgm!.play().catch(() => this.arm());
  }

  /** Replace the looping battle track with the recovered, non-looping invasion-win
   *  theme. This follows the Music toggle/volume rather than the SFX channel. */
  playRaidVictory() {
    const file = "winBGM.mp3";
    if (this.raidFile !== file) {
      this.exitRaid(true);
      this.bgm.dispose();
      // Streams from the element: a 10-second sting plays once and has no seam to
      // hide, so decoding it would buy nothing for 4 MB.
      const audio = this.track(file, false);
      audio.rewind();
      audio.volume = 0.4 * this.musicVolume * this.masterVolume;
      this.raidBgm = audio;
      this.raidFile = file;
    }
    if (this.musicOn && this.canPlay()) void this.raidBgm!.play().catch(() => this.arm());
  }

  // Leave a raid: stop the raid track and hand the farm bgm back. `keepFarmPaused`
  // is used internally when immediately swapping to another raid track.
  exitRaid(keepFarmPaused = false) {
    if (this.raidBgm) {
      // A finished raid's track must not outlive the raid — whether that's a decoded
      // buffer or just the element's own network buffer.
      this.raidBgm.dispose();
      this.raidBgm = null;
      this.raidFile = "";
    }
    if (!keepFarmPaused && this.musicOn && this.canPlay()) void this.bgm.play().catch(() => this.arm());
  }

  // --- sfx -----------------------------------------------------------------
  setSfx(on: boolean) {
    this.sfxOn = on;
    this.applyAudioSessionType();
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

  /** Play the attack cue authored for the side/type that landed a raid strike. */
  fightStrike(strike: FightStrike) {
    if (!this.sfxOn || !this.canPlay()) return;
    this.playOneShot(fightStrikeFile(strike), strike.team === "player" ? 0.55 : 0.42);
  }

  // A zombie's "Brains…" bark when it's tapped on the farm, chosen by its group.
  brain(group: string, key: string) {
    if (!this.sfxOn || !this.canPlay()) return;
    const file = brainFile(group, key);
    if (file) this.playOneShot(file, 0.7);
  }

  // Raid combat carries the actor key rather than the farm catalog group. Derive
  // the same group from that key so brain-bubble releases use the farm tap bark.
  brainForZombie(key: string) {
    this.brain(zombieGroupFromKey(key), key);
  }

  /** Supply deployed owned zombies for occasional, group-correct farm barks. */
  setZombieBarkSource(source: () => { group: string; key: string } | null) {
    this.zombieBarkSource = source;
  }

  // A placed decoration's signature tap sound (TileProperties tapSoundEffect /
  // soundID — e.g. the Liberty Bell toll, Gnome King laugh). Gated on SFX.
  tap(file: string) {
    if (!this.sfxOn || !file || !this.canPlay()) return;
    this.playOneShot(file, 0.7);
  }

  /**
   * Fire one short sound effect.
   *
   * Prefers Web Audio: a decoded AudioBuffer played through a throwaway
   * AudioBufferSourceNode costs microseconds. An HTMLAudioElement.play() instead
   * enters the browser's media-element pipeline — on iOS an AVAudioSession round
   * trip per cue, several MAIN-THREAD milliseconds each. Raids fire an attack cue
   * on nearly every 50 ms combat tick, so that per-play cost is what made frame
   * rate collapse the moment zombies started swinging.
   *
   * The element path stays as the fallback for the very first play of a clip
   * (while it decodes), for browsers without Web Audio, and while the context is
   * still suspended awaiting a user gesture. Long looping tracks (music/ambience)
   * deliberately keep using media elements, where streaming is the point.
   */
  private playOneShot(file: string, volume: number, channelVolume = this.sfxVolume) {
    const url = A(file);
    const gain = volume * channelVolume * this.masterVolume;
    if (this.playBuffered(url, gain)) return;
    this.playElement(url, gain);
  }

  /** The AudioContext, created on first use. Returns null where Web Audio is
   *  unavailable (or construction threw), which routes callers to the element
   *  fallback for the rest of the session. */
  private audioContext(): AudioContext | null {
    if (this.ctx || this.ctxUnavailable) return this.ctx;
    const Ctor = typeof window !== "undefined"
      ? (window as unknown as {
          AudioContext?: typeof AudioContext;
          webkitAudioContext?: typeof AudioContext;
        })
      : undefined;
    const Impl = Ctor?.AudioContext ?? Ctor?.webkitAudioContext;
    if (!Impl) {
      this.ctxUnavailable = true;
      return null;
    }
    try {
      const ctx = new Impl();
      // The platform hands the session back without telling anyone, so a context
      // that returns to "running" on its own has to restart the sources that were
      // frozen when it left — nothing else would.
      ctx.onstatechange = () => {
        if (ctx !== this.ctx) return; // superseded by a rebuild
        if (ctx.state !== "running") {
          if (this.canPlay()) this.startWatchdog();
          return;
        }
        // Arriving at "running" means the session had left it. Any source still
        // attached was frozen by the platform and can't be trusted to have resumed.
        for (const track of this.loops()) track.resync();
        this.restartLoops();
      };
      this.ctx = ctx;
    } catch {
      this.ctxUnavailable = true; // blocked or out of hardware contexts
    }
    return this.ctx;
  }

  /** Decoded clip for `url`, kicking off a one-time fetch+decode when missing.
   *  Returns undefined until that lands, so the caller falls back this once. */
  private buffer(url: string): AudioBuffer | undefined {
    const ready = this.buffers.get(url);
    if (ready) return ready;
    const ctx = this.audioContext();
    if (!ctx || this.decoding.has(url)) return undefined;
    this.decoding.add(url);
    void fetch(url)
      .then((response) => response.arrayBuffer())
      .then((data) => ctx.decodeAudioData(data))
      .then((decoded) => { this.buffers.set(url, decoded); })
      // A failed fetch/decode simply leaves this clip on the element path; it must
      // never reject into the console on every subsequent cue, so drop it and let
      // the next call retry.
      .catch(() => { /* stays on the element fallback */ })
      .finally(() => { this.decoding.delete(url); });
    return undefined;
  }

  /** Play through Web Audio. Returns false when that isn't possible yet, meaning
   *  the caller should use the media element for this one cue. */
  private playBuffered(url: string, gain: number): boolean {
    const ctx = this.audioContext();
    if (!ctx) return false;
    const buffer = this.buffer(url);
    if (!buffer) return false;
    // Autoplay policy parks a context created outside a gesture in "suspended", and
    // the platform can interrupt or close a running one at any moment. Kick the
    // shared recovery (concurrent callers share one attempt, so combat asking on
    // every dropped cue costs nothing) and fall back to the element meanwhile.
    if (ctx.state !== "running") {
      void this.recover();
      return false;
    }
    if (this.voices >= MAX_VOICES) return true; // drop, don't queue: it's inaudible anyway
    try {
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      const amp = ctx.createGain();
      amp.gain.value = gain;
      source.connect(amp).connect(ctx.destination);
      this.voices++;
      source.onended = () => {
        this.voices--;
        source.disconnect();
        amp.disconnect();
      };
      source.start();
      return true;
    } catch {
      // A buffer that outlived the context it was decoded by can be refused. Drop it
      // so the next cue re-decodes against the live context, and use the element now.
      this.buffers.delete(url);
      return false;
    }
  }

  /** Media-element fallback. Pooled per file, because a fresh `new Audio()` per cue
   *  makes iOS re-enter its media-loading pipeline every time. */
  private playElement(url: string, gain: number) {
    // Elements are only reclaimed when playback reports back; refuse to allocate
    // past the cap so a browser that never fires `ended` can't accumulate media
    // resources for the whole fight.
    if (this.oneShots.size >= MAX_VOICES && !this.oneShotPool.get(url)?.length) return;
    const a = this.oneShotPool.get(url)?.pop() ?? new Audio(url);
    a.volume = gain;
    this.oneShots.add(a);
    let settled = false;
    const done = () => {
      if (settled) return; // `ended` and a late `error` must not pool twice
      settled = true;
      clearTimeout(reclaim);
      this.oneShots.delete(a);
      const pool = this.oneShotPool.get(url) ?? [];
      if (pool.length < 6) {
        pool.push(a);
        this.oneShotPool.set(url, pool);
      }
    };
    const reclaim = setTimeout(done, ONE_SHOT_RECLAIM_MS);
    // Property handlers (not addEventListener) so reuse replaces the previous
    // play's callbacks instead of stacking them.
    a.onended = done;
    a.onerror = done;
    if (a.currentTime > 0) a.currentTime = 0; // reused element: rewind
    void a.play().catch(done);
  }

  // --- ambience ------------------------------------------------------------
  setAmbience(on: boolean) {
    this.ambienceOn = on;
    this.applyAudioSessionType();
    if (on && this.canPlay()) this.startAmbience();
    else this.stopAmbience();
    this.persist();
  }

  setAmbienceVolume(value: number) {
    this.ambienceVolume = clampVolume(value);
    this.applyLoopVolumes();
    this.persist();
  }

  private startAmbience() {
    this.startWatchdog();
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
        const zombie = Math.random() < 0.25 ? this.zombieBarkSource?.() : null;
        const bark = zombie ? brainFile(zombie.group, zombie.key) : null;
        if (bark) this.playOneShot(bark, 0.45, this.ambienceVolume);
        else {
          const file = AMBIENCE_ONESHOTS[Math.floor(Math.random() * AMBIENCE_ONESHOTS.length)];
          this.playOneShot(file, 0.3, this.ambienceVolume);
        }
        this.scheduleAmbienceOneShot();
      }
    }, delay);
  }
}
