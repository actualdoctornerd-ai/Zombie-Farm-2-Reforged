import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getLanguage, initLanguage, LANGUAGE_KEY, preferredLanguage, resolveLanguage, saveLanguage, t } from "./index";
import { useMessages } from "./translate";

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  vi.stubGlobal("document", { documentElement: { lang: "en" } });
});
afterEach(() => { useMessages("en", {}); vi.unstubAllGlobals(); });

describe("device language", () => {
  it("resolves regional tags and the identical original Chinese tables", () => {
    expect(resolveLanguage("de-DE")).toBe("de");
    expect(resolveLanguage("zh_Hant_TW")).toBe("zh-CN");
    expect(resolveLanguage("pt-BR")).toBeNull();
    expect(preferredLanguage(["pt-BR", "ja-JP", "en"])).toBe("ja");
    expect(preferredLanguage(["pt-BR"])).toBe("en");
  });
  it("prefers an explicit device setting and does not touch saves", () => {
    localStorage.setItem("zf2r.play-mode.v1", "local");
    expect(saveLanguage("fr")).toBe(true);
    expect(localStorage.getItem(LANGUAGE_KEY)).toBe("fr");
    expect(preferredLanguage(["zh-CN"])).toBe("fr");
    expect(localStorage.getItem("zf2r.play-mode.v1")).toBe("local");
  });
  it("handles blocked preference storage", () => {
    vi.stubGlobal("localStorage", { getItem: () => { throw Error(); }, setItem: () => { throw Error(); } });
    expect(preferredLanguage(["ko-KR"])).toBe("ko");
    expect(saveLanguage("ja")).toBe(false);
  });
  it("loads original German and supplementary Chinese before rendering", async () => {
    await initLanguage("de");
    expect(t("Settings")).toBe("Einstellungen");
    await initLanguage("zh-CN");
    expect(getLanguage()).toBe("zh-CN");
    expect(document.documentElement.lang).toBe("zh-CN");
    expect(t("Language")).toBe("语言");
    expect(t("Zombie Pot")).toBe("僵尸花盆");
    await initLanguage("en");
    expect(t("Settings")).toBe("Settings");
  });
});
