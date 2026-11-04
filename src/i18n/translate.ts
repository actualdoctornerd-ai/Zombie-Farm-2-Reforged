// Pure translation/formatting layer. Shared gameplay modules can import this file
// without pulling browser preferences, Vite resource loading or DOM APIs into Workers.
export type Messages = Record<string, string>;
let activeLanguage = "en";
let messages: Messages = Object.create(null);
let legacyFormats: { pattern: RegExp; key: string; slots: number[] }[] = [];
const cache = new Map<string, string>();
const pluralSuffix = /(?:gift|item|zombie|change|job|pet|brain|voucher|defense|reward|minute|day|ticket|time|cancel|slot|building)\{(\d+)\}/gi;
function argumentValues(source: string, values: unknown[]): unknown[] {
  if (activeLanguage !== "zh-CN") return values;
  const result = [...values];
  for (const match of source.matchAll(pluralSuffix)) {
    const slot = Number(match[1]);
    if (result[slot] === "s") result[slot] = "";
  }
  return result;
}

/** Keep the IPA tables unchanged; adapt Objective-C printf placeholders at load. */
export function printfAliases(catalog: Messages): Messages {
  const aliases: Messages = Object.create(null);
  const normalize = (source: string): string => {
    let next = 0;
    return source.replace(/[%％](?:(\d+)\$)?[-+0 #]*\d*(?:\.\d+)?(?:l{1,2})?[@diufsg]/g,
      (_match, position: string | undefined) => `{${position ? Number(position) - 1 : next++}}`);
  };
  for (const [key, value] of Object.entries(catalog)) {
    const source = normalize(key);
    if (source !== key) aliases[source] = normalize(value);
  }
  return aliases;
}

export function useMessages(language: string, catalog: Messages): void {
  activeLanguage = language;
  messages = Object.assign(Object.create(null), printfAliases(catalog), catalog);
  cache.clear();
  // Compatibility for existing view models that already contain formatted text.
  // New UI should use msg/message directly, so names remain explicit arguments.
  legacyFormats = Object.keys(messages).filter((key) =>
    typeof messages[key] === "string" && messages[key].trim() && /\{\d+\}/.test(key) && /[a-z]{4}/i.test(key))
    .sort((a, b) => b.replace(/\{\d+\}/g, "").length - a.replace(/\{\d+\}/g, "").length)
    .map((key) => {
      const slots: number[] = [];
      const escaped = key.split(/(\{\d+\})/).map((part) => {
        if (/^\{\d+\}$/.test(part)) { slots.push(Number(part.slice(1, -1))); return "(.*?)"; }
        return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      }).join("");
      return { key, slots, pattern: new RegExp(`^${escaped}$`, "s") };
    });
}

/** English source keys stay out of saved state, catalog ids and server commands. */
export function t(source: string): string;
export function t(source: undefined): undefined;
export function t(source: string | undefined): string | undefined;
export function t(source: string | undefined): string | undefined {
  if (source === undefined || activeLanguage === "en") return source;
  if (activeLanguage === "zh-CN" && /^\d+[dhms](?:\s+\d+[dhms])*$/.test(source)) {
    return source.replace(/(\d+)([dhms])/g, (_match, amount: string, unit: string) =>
      amount + ({ d: "天", h: "小时", m: "分钟", s: "秒" })[unit]);
  }
  if (activeLanguage === "zh-CN" && /^[+−-]?\d+(?:\.\d+)?\s*XP$/.test(source)) {
    return source.replace(/\s*XP$/, "经验值");
  }
  if (activeLanguage === "zh-CN" && /^[+−-]?\d+\s+(?:Brain|Brains|Gold)$/.test(source)) {
    return source.replace(/\s+(Brain|Brains|Gold)$/, (_match, unit: string) => unit === "Gold" ? "金币" : "脑子");
  }
  const translated = messages[source];
  if (typeof translated === "string" && translated.trim()) return translated;
  const trimmed = source.trim();
  if (trimmed !== source && typeof messages[trimmed] === "string" && messages[trimmed].trim()) {
    return source.replace(trimmed, () => messages[trimmed]);
  }
  if (/[A-Za-z]{2}/.test(source) && !/\{\d+\}/.test(source)) {
    const cached = cache.get(source);
    if (cached !== undefined) return cached;
    for (const format of legacyFormats) {
      const match = format.pattern.exec(trimmed);
      if (!match) continue;
      const args: Record<number, string> = {};
      format.slots.forEach((slot, index) => { args[slot] = match[index + 1]; });
      // Crop names in generated periodic quests are catalog content. Other values
      // (friend, team, zombie names, quantities) are deliberately kept verbatim.
      if (/^(Harvest|Plant|Plow|Win|Grow and harvest) \{0\} \{1\}(?: without losing a zombie)?$/.test(format.key) && args[1]) args[1] = t(args[1]);
      if (format.key === "Level {0}: {1}") args[1] = t(args[1]);
      if (format.key === "{0} Fight {1}? Win or lose, you keep everything you've already won.") {
        args[0] = t(args[0]); args[1] = t(args[1]);
      }
      const values = argumentValues(format.key, Object.assign([], args));
      const result = messages[format.key].replace(/\{(\d+)\}/g, (placeholder, slot: string) => String(values[Number(slot)] ?? placeholder));
      if (cache.size >= 512) cache.clear();
      const padded = source.replace(trimmed, () => result);
      cache.set(source, padded);
      return padded;
    }
    if (cache.size >= 512) cache.clear();
    cache.set(source, source);
  }
  return source;
}

/** Numbered arguments can be reordered by translators. Values remain literal. */
export function message(source: string, ...values: unknown[]): string {
  values = argumentValues(source, values);
  return t(source).replace(/\{(\d+)\}/g, (match, n: string) =>
    Number(n) < values.length ? String(values[Number(n)]) : match);
}

export function msg(parts: TemplateStringsArray, ...values: unknown[]): string {
  return message(parts.reduce((key, part, i) => key + (i ? `{${i - 1}}` : "") + part, ""), ...values);
}

/** Keep English search useful while also accepting the name visible on the card. */
export function matchesLocalizedText(source: string, query: string): boolean {
  const normalize = (text: string) => text.normalize("NFKC").toLowerCase();
  const needle = normalize(query.trim());
  return normalize(source).includes(needle) || normalize(t(source)).includes(needle);
}

// Markup is authored by the game, while arguments have the same escaping contract
// as the existing innerHTML call site. Translate the source BEFORE inserting values,
// so player names, announcement bodies and other user content are never looked up.
export function html(parts: TemplateStringsArray, ...values: unknown[]): string {
  const source = parts.reduce((key, part, i) => key + (i ? `{${i - 1}}` : "") + part, "");
  const text = (original: string): string => {
    const plain = original.replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (entity) =>
      ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " " })[entity]!);
    const translated = t(plain);
    return translated === plain ? original : translated.replace(/[&<>"']/g, (ch) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
  };
  const localized = source
    .replace(/\b(title|alt|aria-label|placeholder)="([^"]*)"/g, (_match, attribute: string, value: string) => `${attribute}="${text(value)}"`)
    .replace(/(^|>)([^<>]+)(?=<|$)/g, (_match, before: string, value: string) => `${before}${text(value)}`);
  return localized.replace(/\{(\d+)\}/g, (match, n: string) =>
    Number(n) < values.length ? String(values[Number(n)]) : match);
}
