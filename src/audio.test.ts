import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SETTINGS_KEY } from "./save/schema";
import { AudioManager } from "./audio";

class MockAudio extends EventTarget {
  static instances: MockAudio[] = [];
  loop = false;
  volume = 1;
  preload = "";
  paused = true;
  src: string;
  playCalls = 0;
  pauseCalls = 0;

  constructor(src: string) {
    super();
    this.src = src;
    MockAudio.instances.push(this);
  }

  play() {
    this.paused = false;
    this.playCalls++;
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
  });

  it("uses the farm interaction bark for a raid zombie actor key", () => {
    const audio = new AudioManager();

    audio.brainForZombie("ZombieActorGardenTier1");
    expect(MockAudio.instances[MockAudio.instances.length - 1]?.src).toContain("assets/audio/brainGarden.mp3");

    audio.brainForZombie("ZombieActorRegularTier3");
    expect(MockAudio.instances[MockAudio.instances.length - 1]?.src).toContain("assets/audio/brainRobot.mp3");
  });
});
