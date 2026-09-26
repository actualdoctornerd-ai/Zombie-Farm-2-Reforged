import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SETTINGS_KEY } from "./save/schema";
import { AudioManager } from "./audio";

class MockAudio extends EventTarget {
  static instances: MockAudio[] = [];
  static rejectPlay = false;
  loop = false;
  volume = 1;
  preload = "";
  paused = true;
  currentTime = 0;
  src: string;
  playCalls = 0;
  pauseCalls = 0;

  constructor(src: string) {
    super();
    this.src = src;
    MockAudio.instances.push(this);
  }

  play() {
    this.playCalls++;
    if (MockAudio.rejectPlay) return Promise.reject(new Error("autoplay blocked"));
    this.paused = false;
    return Promise.resolve();
  }

  pause() {
    this.paused = true;
    this.pauseCalls++;
  }
}

describe("AudioManager focus muting", () => {
  let focused: boolean;
  let hidden: boolean;
  let windowTarget: EventTarget;
  let storage: Map<string, string>;

  beforeEach(() => {
    vi.useFakeTimers();
    MockAudio.instances = [];
    MockAudio.rejectPlay = false;
    focused = true;
    hidden = false;
    storage = new Map();
    windowTarget = new EventTarget();
    const documentTarget = new EventTarget();
    Object.defineProperties(documentTarget, {
      hidden: { get: () => hidden },
      hasFocus: { value: () => focused },
    });
    vi.stubGlobal("window", windowTarget);
    vi.stubGlobal("document", documentTarget);
    vi.stubGlobal("Audio", MockAudio);
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("pauses every channel on blur, suppresses effects, and resumes loops", () => {
    storage.set(SETTINGS_KEY, JSON.stringify({
      music: true, sfx: true, ambience: true, muteWhenUnfocused: true,
    }));
    const audio = new AudioManager();
    const [music, ambience] = MockAudio.instances;

    expect(music.playCalls).toBe(1);
    expect(ambience.playCalls).toBe(1);

    focused = false;
    windowTarget.dispatchEvent(new Event("blur"));
    expect(music.paused).toBe(true);
    expect(ambience.paused).toBe(true);

    audio.play("buy");
    expect(MockAudio.instances).toHaveLength(2);

    focused = true;
    windowTarget.dispatchEvent(new Event("focus"));
    expect(music.playCalls).toBe(2);
    expect(ambience.playCalls).toBe(2);
  });

  it("persists the option and mutes immediately when enabled in the background", () => {
    focused = false;
    const audio = new AudioManager();
    const [music, ambience] = MockAudio.instances;

    audio.setMuteWhenUnfocused(true);

    expect(music.paused).toBe(true);
    expect(ambience.paused).toBe(true);
    expect(JSON.parse(storage.get(SETTINGS_KEY)!)).toMatchObject({
      music: true, sfx: true, ambience: true, muteWhenUnfocused: true,
    });
  });

  it("also reacts when a still-focused tab becomes hidden", () => {
    storage.set(SETTINGS_KEY, JSON.stringify({ muteWhenUnfocused: true }));
    new AudioManager();
    const [music, ambience] = MockAudio.instances;

    hidden = true;
    document.dispatchEvent(new Event("visibilitychange"));

    expect(music.paused).toBe(true);
    expect(ambience.paused).toBe(true);
  });

  it("always pauses a hidden mobile page even when focus muting is disabled", () => {
    storage.set(SETTINGS_KEY, JSON.stringify({ muteWhenUnfocused: false }));
    new AudioManager();
    const [music, ambience] = MockAudio.instances;

    hidden = true;
    document.dispatchEvent(new Event("visibilitychange"));

    expect(music.paused).toBe(true);
    expect(ambience.paused).toBe(true);
  });

  it("stops audio on mobile pagehide even before hidden state updates", () => {
    storage.set(SETTINGS_KEY, JSON.stringify({ muteWhenUnfocused: false }));
    new AudioManager();
    const [music, ambience] = MockAudio.instances;

    windowTarget.dispatchEvent(new Event("pagehide"));

    expect(music.paused).toBe(true);
    expect(ambience.paused).toBe(true);
  });

  it("restores and applies independent channel volumes", () => {
    storage.set(SETTINGS_KEY, JSON.stringify({
      musicVolume: 0.5, sfxVolume: 0.25, ambienceVolume: 0.4,
    }));
    const audio = new AudioManager();
    const [music, ambience] = MockAudio.instances;

    expect(music.volume).toBeCloseTo(0.2);
    expect(ambience.volume).toBeCloseTo(0.1);

    audio.play("buy");
    expect(MockAudio.instances[MockAudio.instances.length - 1].volume).toBeCloseTo(0.55 * 0.25);

    audio.setMusicVolume(0.75);
    audio.setSfxVolume(0.6);
    audio.setAmbienceVolume(0.8);
    expect(music.volume).toBeCloseTo(0.3);
    expect(ambience.volume).toBeCloseTo(0.2);
    expect(JSON.parse(storage.get(SETTINGS_KEY)!)).toMatchObject({
      musicVolume: 0.75, sfxVolume: 0.6, ambienceVolume: 0.8,
    });
  });

  it("scales every channel by the master volume", () => {
    storage.set(SETTINGS_KEY, JSON.stringify({
      masterVolume: 0.5, musicVolume: 0.5, sfxVolume: 0.25, ambienceVolume: 0.4,
    }));
    const audio = new AudioManager();
    const [music, ambience] = MockAudio.instances;

    expect(music.volume).toBeCloseTo(0.4 * 0.5 * 0.5);
    expect(ambience.volume).toBeCloseTo(0.25 * 0.4 * 0.5);

    audio.play("buy");
    expect(MockAudio.instances[MockAudio.instances.length - 1].volume)
      .toBeCloseTo(0.55 * 0.25 * 0.5);

    audio.setMasterVolume(1);
    expect(music.volume).toBeCloseTo(0.2);
    expect(ambience.volume).toBeCloseTo(0.1);
    expect(JSON.parse(storage.get(SETTINGS_KEY)!)).toMatchObject({ masterVolume: 1 });
  });

  it("silences everything when the master toggle is off and resumes when re-enabled", () => {
    const audio = new AudioManager();
    const [music, ambience] = MockAudio.instances;
    expect(music.paused).toBe(false);

    audio.setMaster(false);
    expect(music.paused).toBe(true);
    expect(ambience.paused).toBe(true);

    const count = MockAudio.instances.length;
    audio.play("buy");
    expect(MockAudio.instances).toHaveLength(count);

    audio.setMaster(true);
    expect(music.paused).toBe(false);
    expect(ambience.paused).toBe(false);
    expect(JSON.parse(storage.get(SETTINGS_KEY)!)).toMatchObject({ master: true });
  });

  it("stays silent on boot when the master toggle was saved off", () => {
    storage.set(SETTINGS_KEY, JSON.stringify({ master: false }));
    new AudioManager();
    const [music, ambience] = MockAudio.instances;

    expect(music.playCalls).toBe(0);
    expect(ambience.playCalls).toBe(0);
  });

  // A device that refuses the write makes a volume change look like it took and
  // then loses it at next launch — "my settings don't save", with nothing in the
  // game to explain it. Say so once, and only once (the slider fires per drag step).
  it("warns once when this device won't store the settings", () => {
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: () => { throw new DOMException("quota", "QuotaExceededError"); },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const audio = new AudioManager();
    const messages: string[] = [];
    audio.onStorageError = (message) => messages.push(message);

    audio.setMasterVolume(0.4);
    audio.setMusicVolume(0.2);
    audio.setSfxVolume(0.1);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/reset when you come back/);
    // The failure is confined to persistence: the session itself still obeys.
    expect(audio.masterVolume).toBe(0.4);
    expect(audio.musicVolume).toBe(0.2);
    warn.mockRestore();
  });

  // A corrupt settings key used to be dereferenced straight out of JSON.parse, so
  // a stored "null" threw inside the constructor and took the whole boot with it.
  it("falls back to defaults when the stored settings are not an object", () => {
    for (const corrupt of ["null", "42", '"music"', "[1,2]", "{"]) {
      storage.set(SETTINGS_KEY, corrupt);
      const audio = new AudioManager();
      expect(audio.masterOn, corrupt).toBe(true);
      expect(audio.masterVolume, corrupt).toBe(1);
      expect(audio.musicVolume, corrupt).toBe(1);
    }
  });

  it("resumes enabled loops from the explicit start gesture after autoplay is blocked", async () => {
    MockAudio.rejectPlay = true;
    const audio = new AudioManager();
    const [music, ambience] = MockAudio.instances;
    await Promise.resolve();

    expect(music.paused).toBe(true);
    expect(ambience.paused).toBe(true);

    MockAudio.rejectPlay = false;
    audio.resumeFromGesture();

    expect(music.paused).toBe(false);
    expect(ambience.paused).toBe(false);
    expect(music.playCalls).toBe(2);
    expect(ambience.playCalls).toBe(2);
  });

  it("uses the recovered zombie bite and authored enemy attack cues", () => {
    const audio = new AudioManager();

    audio.fightStrike({ team: "player", attackName: "ZombieBite" });
    expect(MockAudio.instances[MockAudio.instances.length - 1]?.src).toContain("assets/audio/bite.wav");
    expect(MockAudio.instances[MockAudio.instances.length - 1]?.volume).toBeCloseTo(0.55);

    audio.fightStrike({ team: "player", attackName: "ZombieScratch" });
    expect(MockAudio.instances[MockAudio.instances.length - 1]?.src).toContain("assets/audio/flail.wav");

    audio.fightStrike({ team: "enemy", attackName: "FarmhandPoke" });
    expect(MockAudio.instances[MockAudio.instances.length - 1]?.src).toContain("assets/audio/poke.wav");

    audio.fightStrike({ team: "enemy", attackName: "MidgetStackAttack" });
    expect(MockAudio.instances[MockAudio.instances.length - 1]?.src).toContain("assets/audio/poke.wav");

    audio.fightStrike({ team: "enemy", attackName: "LumberjackSlice" });
    expect(MockAudio.instances[MockAudio.instances.length - 1]?.src).toContain("assets/audio/swipe.wav");

    audio.fightStrike({ team: "enemy", impact: "projectile" });
    expect(MockAudio.instances[MockAudio.instances.length - 1]?.src).toContain("assets/audio/splat.wav");
  });

  it("uses the recovered non-looping invasion theme for raid victories", () => {
    const audio = new AudioManager();

    audio.enterRaid("farmStageBGM.mp3");
    audio.playRaidVictory();

    const victory = MockAudio.instances[MockAudio.instances.length - 1];
    expect(victory.src).toContain("assets/audio/winBGM.mp3");
    expect(victory.loop).toBe(false);
    expect(victory.playCalls).toBe(1);
  });

  it("keeps the winner cue assigned to level-ups", () => {
    const audio = new AudioManager();

    audio.play("levelUp");

    expect(MockAudio.instances[MockAudio.instances.length - 1]?.src).toContain("assets/audio/winner.mp3");
  });

  it("uses the farm interaction bark for a raid zombie actor key", () => {
    const audio = new AudioManager();

    audio.brainForZombie("ZombieActorGardenTier1");
    expect(MockAudio.instances[MockAudio.instances.length - 1]?.src).toContain("assets/audio/brainGarden.mp3");

    audio.brainForZombie("ZombieActorRegularTier3");
    expect(MockAudio.instances[MockAudio.instances.length - 1]?.src).toContain("assets/audio/brainRobot.mp3");
  });

  it("reclaims a stalled fallback element instead of allocating a new one", () => {
    const audio = new AudioManager();
    const before = MockAudio.instances.length;

    // A browser that never reports `ended` (iOS evicting a stalled element) must
    // not strand the pool: the timed reclaim returns the element for reuse.
    audio.play("buy");
    expect(MockAudio.instances).toHaveLength(before + 1);
    vi.advanceTimersByTime(10_000);

    audio.play("buy");
    expect(MockAudio.instances).toHaveLength(before + 1);
  });

  it("uses girl audio for the catalog's Female group and keeps headless silent", () => {
    const audio = new AudioManager();

    audio.brain("Female", "ZombieActorGirlTier1");
    expect(MockAudio.instances[MockAudio.instances.length - 1]?.src).toContain("assets/audio/brainGirl.mp3");

    const count = MockAudio.instances.length;
    audio.brain("Headless", "ZombieActorHeadlessTier1");
    expect(MockAudio.instances).toHaveLength(count);

    audio.brainForZombie("ZombieActorHeadlessTier1");
    expect(MockAudio.instances).toHaveLength(count);
  });
});

// Raid combat fires an attack cue on nearly every 50 ms simulation tick. Each
// HTMLAudioElement.play() costs several milliseconds of main-thread time on iOS,
// so those cues must reach the speaker through Web Audio instead.
describe("AudioManager one-shot effects", () => {
  class MockSource {
    static started: MockSource[] = [];
    buffer: unknown = null;
    onended: (() => void) | null = null;
    connect = (destination: unknown) => destination;
    disconnect = () => {};
    start = () => { MockSource.started.push(this); };
  }

  class MockContext {
    state = "running";
    destination = {};
    decodeCalls = 0;
    createBufferSource = () => new MockSource();
    createGain = () => ({
      gain: { value: 0 },
      connect: (destination: unknown) => destination,
      disconnect: () => {},
    });
    decodeAudioData = () => { this.decodeCalls++; return Promise.resolve({} as AudioBuffer); };
    resume = () => { this.state = "running"; return Promise.resolve(); };
    suspend = () => { this.state = "suspended"; return Promise.resolve(); };
  }

  let context: MockContext;
  let storage: Map<string, string>;

  /** Let the fetch -> arrayBuffer -> decodeAudioData chain settle. */
  const settleDecode = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

  beforeEach(() => {
    MockAudio.instances = [];
    MockAudio.rejectPlay = false;
    MockSource.started = [];
    storage = new Map();
    // These cases count buffer sources and decodes, and the looping music/ambience
    // beds now use both. Silence those channels so the numbers are purely one-shots.
    storage.set(SETTINGS_KEY, JSON.stringify({ music: false, ambience: false }));
    context = new MockContext();
    const windowTarget = new EventTarget() as EventTarget & { AudioContext: unknown };
    windowTarget.AudioContext = function () { return context; } as unknown;
    const documentTarget = new EventTarget();
    Object.defineProperties(documentTarget, {
      hidden: { get: () => false },
      hasFocus: { value: () => true },
    });
    vi.stubGlobal("window", windowTarget);
    vi.stubGlobal("document", documentTarget);
    vi.stubGlobal("Audio", MockAudio);
    vi.stubGlobal("fetch", () =>
      Promise.resolve({ arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) }));
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("plays a decoded cue through Web Audio without allocating a media element", async () => {
    const audio = new AudioManager();

    // First cue: still decoding, so it falls back to a media element.
    audio.fightStrike({ team: "player", attackName: "ZombieBite" });
    const afterFallback = MockAudio.instances.length;
    expect(MockSource.started).toHaveLength(0);

    await settleDecode();

    // Every later cue is a throwaway buffer source — no new media element.
    for (let i = 0; i < 20; i++) {
      audio.fightStrike({ team: "player", attackName: "ZombieBite" });
    }
    expect(MockSource.started).toHaveLength(20);
    expect(MockAudio.instances).toHaveLength(afterFallback);
  });

  it("applies the sfx and master volumes to the buffered voice", async () => {
    storage.set(SETTINGS_KEY, JSON.stringify({
      music: false, ambience: false, masterVolume: 0.5, sfxVolume: 0.4,
    }));
    const audio = new AudioManager();
    const gains: { gain: { value: number } }[] = [];
    context.createGain = () => {
      const node = {
        gain: { value: 0 },
        connect: (destination: unknown) => destination,
        disconnect: () => {},
      };
      gains.push(node);
      return node;
    };

    audio.fightStrike({ team: "player", attackName: "ZombieBite" });
    await settleDecode();
    audio.fightStrike({ team: "player", attackName: "ZombieBite" });

    expect(gains[gains.length - 1].gain.value).toBeCloseTo(0.55 * 0.4 * 0.5);
  });

  it("caps concurrent voices so a busy fight cannot pile them up", async () => {
    const audio = new AudioManager();
    audio.fightStrike({ team: "player", attackName: "ZombieBite" });
    await settleDecode();

    // Nothing reports `ended`, so every voice stays live.
    for (let i = 0; i < 60; i++) {
      audio.fightStrike({ team: "player", attackName: "ZombieBite" });
    }

    expect(MockSource.started).toHaveLength(24);
  });

  it("frees a voice slot once the clip ends", async () => {
    const audio = new AudioManager();
    audio.fightStrike({ team: "player", attackName: "ZombieBite" });
    await settleDecode();

    for (let i = 0; i < 60; i++) {
      audio.fightStrike({ team: "player", attackName: "ZombieBite" });
    }
    for (const source of MockSource.started) source.onended?.();
    audio.fightStrike({ team: "player", attackName: "ZombieBite" });

    expect(MockSource.started).toHaveLength(25);
  });

  it("decodes every attack cue when a raid starts", async () => {
    const audio = new AudioManager();

    audio.enterRaid("farmStageBGM.mp3");
    await settleDecode();

    // bite / flail / poke / swipe / punch / splat / alienLaser / stun / explosion.
    expect(context.decodeCalls).toBe(9);
    audio.fightStrike({ team: "enemy", impact: "projectile" });
    expect(MockSource.started).toHaveLength(1);
  });

  it("stays on the media element while the context is gesture-locked", async () => {
    const audio = new AudioManager();
    audio.fightStrike({ team: "player", attackName: "ZombieBite" });
    await settleDecode();
    context.state = "suspended";

    const before = MockAudio.instances.length;
    audio.fightStrike({ team: "player", attackName: "ZombieBite" });

    expect(MockSource.started).toHaveLength(0);
    expect(MockAudio.instances).toHaveLength(before + 1);
    // The attempted resume leaves it running for the next cue.
    audio.fightStrike({ team: "player", attackName: "ZombieBite" });
    expect(MockSource.started).toHaveLength(1);
  });
});

// Our music MP3s carry no LAME gapless tag, so decoders render the encoder's
// delay + end padding as real silence, and a media element's `loop` seek adds a
// stall on top. Both are audible as a blip at every loop point, so looping tracks
// play from a decoded buffer whose loop region covers only the authored audio.
describe("AudioManager gapless music looping", () => {
  const RATE = 44100;
  /** dayFarmBGM's authored length, and the padding a decoder adds around it. */
  const AUTHORED = 1376780 / RATE;
  const HEAD = 1105; // encoder delay samples left at the head of the decode
  const TAIL = 1199;

  class MockGain {
    gain = { value: 0, linearRampToValueAtTime: () => {} };
    connect = (destination: unknown) => destination;
    disconnect = () => {};
  }

  class MockSource {
    static started: MockSource[] = [];
    buffer: AudioBuffer | null = null;
    loop = false;
    loopStart = 0;
    loopEnd = 0;
    startArgs: unknown[] = [];
    onended: (() => void) | null = null;
    connect = (destination: unknown) => destination;
    disconnect = () => {};
    stop = () => {};
    start = (...args: unknown[]) => {
      this.startArgs = args;
      MockSource.started.push(this);
    };
  }

  /** A decode of a padded MP3: silence, then the authored audio, then padding. */
  function paddedBuffer(): AudioBuffer {
    const length = HEAD + Math.round(AUTHORED * RATE) + TAIL;
    const data = new Float32Array(length);
    for (let i = HEAD; i < length - TAIL; i++) data[i] = 0.5;
    return {
      duration: length / RATE,
      length,
      sampleRate: RATE,
      numberOfChannels: 1,
      getChannelData: () => data,
    } as unknown as AudioBuffer;
  }

  let context: {
    state: string;
    currentTime: number;
    decodeAudioData: () => Promise<AudioBuffer>;
    resume: () => Promise<void>;
  };
  const settleDecode = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

  beforeEach(() => {
    MockAudio.instances = [];
    MockAudio.rejectPlay = false;
    MockSource.started = [];
    context = {
      state: "running",
      currentTime: 0,
      destination: {},
      createBufferSource: () => new MockSource(),
      createGain: () => new MockGain(),
      decodeAudioData: () => Promise.resolve(paddedBuffer()),
      resume: () => Promise.resolve(),
      suspend: () => Promise.resolve(),
    } as never;
    const windowTarget = new EventTarget() as EventTarget & { AudioContext: unknown };
    windowTarget.AudioContext = function () { return context; } as unknown;
    const documentTarget = new EventTarget();
    Object.defineProperties(documentTarget, {
      hidden: { get: () => false },
      hasFocus: { value: () => true },
    });
    vi.stubGlobal("window", windowTarget);
    vi.stubGlobal("document", documentTarget);
    vi.stubGlobal("Audio", MockAudio);
    vi.stubGlobal("fetch", () =>
      Promise.resolve({ arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) }));
    vi.stubGlobal("localStorage", {
      getItem: () => JSON.stringify({ music: true, ambience: false }),
      setItem: () => {},
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("loops the authored audio only, skipping the encoder padding", async () => {
    new AudioManager();
    await settleDecode();

    const [music] = MockSource.started;
    expect(music.loop).toBe(true);
    // The head silence is measured out of the decode, and the region ends exactly
    // one authored length later — so the seam carries no dead air from either end.
    expect(music.loopStart).toBeCloseTo(HEAD / RATE, 5);
    expect(music.loopEnd - music.loopStart).toBeCloseTo(AUTHORED, 5);
    // Playback starts inside the region too, not on the leading silence.
    expect(music.startArgs[1]).toBeCloseTo(HEAD / RATE, 5);
  });

  it("streams from the element first, then hands over to the gapless buffer", async () => {
    new AudioManager();
    const [element] = MockAudio.instances;

    // Decoding needs the whole file, so the element covers the start as before.
    expect(element.playCalls).toBe(1);
    expect(MockSource.started).toHaveLength(0);

    await settleDecode();
    expect(MockSource.started).toHaveLength(1);
  });

  // A decoded buffer costs ~0.37 MB per second of stereo audio, so the decoded path
  // is only worth buying where the seam it hides is actually heard often. Everything
  // else streams from the element, exactly as music did before gapless looping.
  it("streams a non-looping sting instead of decoding it", async () => {
    const audio = new AudioManager();
    audio.enterRaid("farmStageBGM.mp3");
    await settleDecode();
    MockSource.started = [];

    audio.playRaidVictory();
    await settleDecode();

    // Played once, no seam to hide: 4 MB of decoded buffer would buy nothing.
    expect(MockSource.started).toHaveLength(0);
    const sting = MockAudio.instances.find((a) => a.src.includes("winBGM"))!;
    expect(sting.paused).toBe(false);
  });

  it("streams a track with no authored length rather than pricing it blind", async () => {
    const audio = new AudioManager();
    await settleDecode();
    MockSource.started = [];

    audio.enterRaid("someUnknownStage.mp3");
    await settleDecode();

    expect(MockSource.started).toHaveLength(0);
    const unknown = MockAudio.instances.find((a) => a.src.includes("someUnknownStage"))!;
    expect(unknown.paused).toBe(false);
  });

  it("streams the long stage themes and decodes only the beds", async () => {
    const audio = new AudioManager();
    await settleDecode();
    // The farm bed loops all session at 31 s, so it earns its 11 MB.
    expect(MockSource.started).toHaveLength(1);

    MockSource.started = [];
    audio.enterRaid("farmStageBGM.mp3"); // 64 s: 23 MB for a seam heard once a fight
    await settleDecode();

    expect(MockSource.started).toHaveLength(0);
    const stage = MockAudio.instances.find((a) => a.src.includes("farmStageBGM"))!;
    expect(stage.paused).toBe(false);
  });

  it("gives the farm bed's buffer back for the length of a raid, then restores it", async () => {
    const audio = new AudioManager();
    await settleDecode();
    const bed = MockAudio.instances.find((a) => a.src.includes("dayFarmBGM"))!;

    audio.enterRaid("farmStageBGM.mp3");
    await settleDecode();
    // Holding 11 MB through a fight that has its own theme is pure waste.
    expect(bed.src).toBe("");

    MockSource.started = [];
    audio.exitRaid();
    await settleDecode();

    // ...and the track is reusable: it re-attaches and decodes again on the way out.
    expect(bed.src).toContain("dayFarmBGM");
    expect(MockSource.started).toHaveLength(1);
  });

  it("returns to the buffer, not the element, after a background/foreground cycle", async () => {
    new AudioManager();
    await settleDecode();
    expect(MockSource.started).toHaveLength(1);
    const element = MockAudio.instances[0];
    const playsWhileBuffered = element.playCalls;

    // Backgrounding suspends the context; resuming it is async, so a naive check of
    // `state === "running"` on the way back would strand music on the gappy element
    // path for the rest of the session.
    window.dispatchEvent(new Event("pagehide"));
    context.state = "suspended";
    // Real resumes settle on a later tick, which is exactly what a synchronous
    // `state === "running"` check gets wrong.
    context.resume = () => Promise.resolve().then(() => { context.state = "running"; });

    document.dispatchEvent(new Event("visibilitychange"));
    await settleDecode();

    expect(MockSource.started).toHaveLength(2);
    expect(element.playCalls).toBe(playsWhileBuffered);
  });

  it("drops a finished raid track's decoded buffer instead of holding it", async () => {
    const audio = new AudioManager();
    audio.enterRaid("farmStageBGM.mp3");
    await settleDecode();

    const raid = MockAudio.instances.find((a) => a.src.includes("farmStageBGM"))!;
    audio.exitRaid();

    expect(raid.src).toBe("");
  });
});

// The platform can take the audio session away at any moment — on iOS a call, a
// notification, Siri, the lock screen, another app, or memory pressure — and Safari
// reports that as the non-standard state "interrupted", where resume() can return a
// promise that NEVER settles. Music rides that session, so without a recovery path
// it simply stops and nothing ever retries it, while effects keep playing on their
// media-element fallback: the "audio cuts in and out" a player hears.
describe("AudioManager audio-session recovery", () => {
  class MockSource {
    static started: MockSource[] = [];
    buffer: unknown = null;
    loop = false;
    loopStart = 0;
    loopEnd = 0;
    onended: (() => void) | null = null;
    connect = (destination: unknown) => destination;
    disconnect = () => {};
    stop = () => {};
    start = () => { MockSource.started.push(this); };
  }

  class MockContext {
    static live: MockContext[] = [];
    state = "running";
    currentTime = 0;
    destination = {};
    closeCalls = 0;
    onstatechange: (() => void) | null = null;
    /** Safari during an interruption: resume() never settles, either way. */
    resumeHangs = false;
    constructor() { MockContext.live.push(this); }
    createBufferSource = () => new MockSource();
    createGain = () => ({
      gain: { value: 0, linearRampToValueAtTime: () => {} },
      connect: (destination: unknown) => destination,
      disconnect: () => {},
    });
    decodeAudioData = () => Promise.resolve({
      duration: 40, length: 40 * 44100, sampleRate: 44100,
      getChannelData: () => new Float32Array(64).fill(0.5),
    } as unknown as AudioBuffer);
    resume = () => {
      if (this.resumeHangs) return new Promise<void>(() => {});
      this.setState("running");
      return Promise.resolve();
    };
    suspend = () => { this.setState("suspended"); return Promise.resolve(); };
    close = () => { this.closeCalls++; this.setState("closed"); return Promise.resolve(); };
    setState(next: string) {
      this.state = next;
      this.onstatechange?.();
    }
  }

  const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  const current = () => MockContext.live[MockContext.live.length - 1];

  let hidden: boolean;

  beforeEach(() => {
    MockAudio.instances = [];
    MockAudio.rejectPlay = false;
    MockSource.started = [];
    MockContext.live = [];
    hidden = false;
    const windowTarget = new EventTarget() as EventTarget & { AudioContext: unknown };
    windowTarget.AudioContext = MockContext;
    const documentTarget = new EventTarget();
    Object.defineProperties(documentTarget, {
      hidden: { get: () => hidden },
      hasFocus: { value: () => true },
    });
    vi.stubGlobal("window", windowTarget);
    vi.stubGlobal("document", documentTarget);
    vi.stubGlobal("Audio", MockAudio);
    vi.stubGlobal("fetch", () =>
      Promise.resolve({ arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) }));
    vi.stubGlobal("localStorage", {
      getItem: () => JSON.stringify({ music: true, ambience: false }),
      setItem: () => {},
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("reports an interrupted track as not playing, so callers know to restart it", async () => {
    const audio = new AudioManager();
    await settle();
    expect(MockSource.started).toHaveLength(1);

    // The source object still exists, but a frozen context makes no sound. Treating
    // that as "playing" is what let music die with nothing left to retry.
    current().state = "interrupted";
    MockSource.started = [];
    audio.resumeFromGesture();
    await settle();

    expect(MockSource.started.length).toBeGreaterThan(0);
  });

  it("rebuilds the context and restarts music when resume() hangs", async () => {
    const audio = new AudioManager();
    await settle();
    const interrupted = current();

    interrupted.state = "interrupted";
    interrupted.resumeHangs = true;
    MockSource.started = [];

    vi.useFakeTimers();
    audio.resumeFromGesture();
    // A hanging resume() must not stall recovery: it is raced, not awaited.
    await vi.advanceTimersByTimeAsync(2_000);
    vi.useRealTimers();
    await settle();

    expect(interrupted.closeCalls).toBe(1);
    expect(MockContext.live).toHaveLength(2);
    expect(current().state).toBe("running");
    expect(MockSource.started.length).toBeGreaterThan(0); // playing on the new context
  });

  it("rebuilds a context the platform closed outright", async () => {
    const audio = new AudioManager();
    await settle();
    current().state = "closed";
    MockSource.started = [];

    audio.resumeFromGesture();
    await settle();

    expect(MockContext.live).toHaveLength(2);
    expect(MockSource.started.length).toBeGreaterThan(0);
  });

  it("restarts frozen sources when the session comes back on its own", async () => {
    new AudioManager();
    await settle();
    const ctx = current();
    ctx.state = "interrupted";
    MockSource.started = [];

    // No focus/visibility event accompanies this — statechange is the only signal.
    ctx.setState("running");
    await settle();

    expect(MockSource.started.length).toBeGreaterThan(0);
  });

  it("recovers a context that claims to be running but whose clock has stopped", async () => {
    vi.useFakeTimers();
    new AudioManager();
    await vi.advanceTimersByTimeAsync(0);
    const stalled = current();
    stalled.currentTime = 5;

    // Two watchdog ticks with no progress: state still says "running", so resume()
    // has nothing to do and only a new context can recover it.
    await vi.advanceTimersByTimeAsync(2_100);
    await vi.advanceTimersByTimeAsync(2_100);

    expect(stalled.closeCalls).toBe(1);
    expect(MockContext.live).toHaveLength(2);
  });

  it("leaves a healthy context alone", async () => {
    vi.useFakeTimers();
    new AudioManager();
    await vi.advanceTimersByTimeAsync(0);
    const ctx = current();

    for (let tick = 1; tick <= 4; tick++) {
      ctx.currentTime = tick * 2;
      await vi.advanceTimersByTimeAsync(2_100);
    }

    expect(ctx.closeCalls).toBe(0);
    expect(MockContext.live).toHaveLength(1);
  });

  it("does not fight a deliberate background suspend", async () => {
    vi.useFakeTimers();
    new AudioManager();
    await vi.advanceTimersByTimeAsync(0);
    const ctx = current();

    hidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(10_000);

    // Backgrounded audio is supposed to be silent; recovering it would be a bug.
    expect(ctx.closeCalls).toBe(0);
    expect(MockContext.live).toHaveLength(1);
  });

  it("repairs a streaming track too, which has no buffer source to inspect", async () => {
    vi.useFakeTimers(); // the watchdog interval must be created under fake timers
    const audio = new AudioManager();
    await settle();
    audio.enterRaid("farmStageBGM.mp3"); // too long to decode: this one streams
    await settle();
    const stage = MockAudio.instances.find((a) => a.src.includes("farmStageBGM"))!;
    expect(stage.paused).toBe(false);
    const playsBefore = stage.playCalls;

    stage.pause(); // an interruption stops media elements as dead as buffer sources
    await vi.advanceTimersByTimeAsync(2_100);

    expect(stage.playCalls).toBeGreaterThan(playsBefore);
    expect(stage.paused).toBe(false);
  });

  it("frees the voice budget a dead context's sources could never release", async () => {
    const audio = new AudioManager();
    await settle();
    audio.enterRaid("farmStageBGM.mp3");
    await settle();

    // Fill the voice cap, then lose the context: those sources can never report
    // `ended`, so without a reset the budget stays spent and effects go silent.
    for (let i = 0; i < 40; i++) audio.fightStrike({ team: "player", attackName: "Bite" });
    current().state = "closed";
    audio.resumeFromGesture();
    await settle();

    // The first cue after the rebuild re-decodes against the new context; the next
    // one has to reach Web Audio again rather than a spent budget.
    MockSource.started = [];
    audio.fightStrike({ team: "player", attackName: "Bite" });
    await settle();
    audio.fightStrike({ team: "player", attackName: "Bite" });

    expect(MockSource.started.length).toBeGreaterThan(0);
  });
});

describe("AudioManager iOS silent switch", () => {
  let session: { type: string };

  beforeEach(() => {
    MockAudio.instances = [];
    MockAudio.rejectPlay = false;
    const documentTarget = new EventTarget();
    Object.defineProperties(documentTarget, {
      hidden: { get: () => false },
      hasFocus: { value: () => true },
    });
    session = { type: "auto" };
    vi.stubGlobal("window", new EventTarget());
    vi.stubGlobal("document", documentTarget);
    vi.stubGlobal("Audio", MockAudio);
    vi.stubGlobal("navigator", { audioSession: session });
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // Without "playback", iOS treats every Web Audio sound as ambient and the
  // hardware Ring/Silent switch silences the game outright.
  it("claims the playback category so the Ring/Silent switch can't mute the game", () => {
    new AudioManager();
    expect(session.type).toBe("playback");
  });

  it("also claims it from the start gesture, which is when the session activates", () => {
    const audio = new AudioManager();
    session.type = "auto";
    audio.resumeFromGesture();
    expect(session.type).toBe("playback");
  });

  // The category is not mixable, so holding it while silent would keep another
  // app's music stopped for no reason.
  it("hands the category back once every channel is off", () => {
    const audio = new AudioManager();
    audio.setMusic(false);
    audio.setSfx(false);
    expect(session.type).toBe("playback"); // ambience still on
    audio.setAmbience(false);
    expect(session.type).toBe("auto");

    audio.setSfx(true);
    expect(session.type).toBe("playback");
  });

  it("releases it on master mute and reclaims it on unmute", () => {
    const audio = new AudioManager();
    audio.setMaster(false);
    expect(session.type).toBe("auto");
    audio.setMaster(true);
    expect(session.type).toBe("playback");
  });

  it("works where the API is absent", () => {
    vi.stubGlobal("navigator", {});
    expect(() => new AudioManager().setMusic(false)).not.toThrow();
  });
});
