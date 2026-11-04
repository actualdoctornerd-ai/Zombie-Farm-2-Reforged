import { useMessages, type Messages } from "./translate";
export { t, message, msg, html, matchesLocalizedText } from "./translate";
export type { Messages } from "./translate";

export const LANGUAGES = [
  { id: "en", name: "English" },
  { id: "de", name: "Deutsch" },
  { id: "es", name: "Español" },
  { id: "fr", name: "Français" },
  { id: "it", name: "Italiano" },
  { id: "ja", name: "日本語" },
  { id: "ko", name: "한국어" },
  { id: "nl", name: "Nederlands" },
  { id: "zh-CN", name: "简体中文" },
] as const;
export type Language = typeof LANGUAGES[number]["id"];
export const LANGUAGE_KEY = "zf2r.language.v1";
const loaders = import.meta.glob<{ default: Messages }>("./locales/*.json");
let language: Language = "en";

/** The IPA's zh, zh-Hans and zh-Hant tables contain identical Simplified text. */
export function resolveLanguage(tag: string): Language | null {
  const primary = tag.toLowerCase().replace(/_/g, "-").split("-")[0];
  if (primary === "zh") return "zh-CN";
  return LANGUAGES.find((item) => item.id === primary)?.id ?? null;
}

export function preferredLanguage(languages: readonly string[] = []): Language {
  try {
    const stored = localStorage.getItem(LANGUAGE_KEY);
    if (stored && resolveLanguage(stored)) return resolveLanguage(stored)!;
  } catch { /* Browser storage is optional. */ }
  for (const tag of languages) {
    const resolved = resolveLanguage(tag);
    if (resolved) return resolved;
  }
  return "en";
}

export function getLanguage(): Language { return language; }

/** Load before any gameplay UI is constructed; no account or network API needed. */
export async function initLanguage(selected = preferredLanguage(navigator.languages)): Promise<void> {
  try {
    const [original, extra] = await Promise.all([
      loaders[`./locales/${selected}.json`](),
      selected === "zh-CN" ? loaders["./locales/zh-CN-extra.json"]() : null,
    ]);
    useMessages(selected, { ...original.default, ...extra?.default });
    language = selected;
  } catch (error) {
    // A missing/offline language chunk must not prevent the farm from opening.
    console.warn("Language resources could not be loaded; using English.", error);
    useMessages("en", {});
    language = "en";
  }
  document.documentElement.lang = language;
}

export function saveLanguage(selected: Language): boolean {
  try { localStorage.setItem(LANGUAGE_KEY, selected); return true; }
  catch { return false; }
}
