// ---------------------------------------------------------------------------
// Username content filter — the second half of `validateUsername`.
// ---------------------------------------------------------------------------
// A chosen name is the only thing about a player that other players see, and it
// does NOT stay inside consented friendships: every Black Market listing query
// selects `a.username AS creator_name`, so the name reaches every farmer browsing
// the market. That is the surface this file exists for.
//
// WHAT THE SHAPE RULE ALREADY BLOCKS (measured — don't re-solve these here).
// `validateUsername`'s allowlist is `^[\p{L}\p{N} _.'-]+$`, which admits only
// letters, numbers and five punctuation marks. Because it is an allowlist rather
// than a denylist, every structural trick is already rejected before this file
// runs: zero-width spaces, RTL/LTR overrides, stacked combining marks and emoji
// are all format or mark characters and match neither \p{L} nor \p{N}.
//
// WHAT STILL GETS THROUGH, and therefore what the folding below is for:
//   homoglyphs      Cyrillic "Аss", Greek "οmega"   -> confusable map
//   fullwidth       "ｓｈｉｔ"                        -> NFKD
//   leetspeak       "5h1t", "@ss"                   -> leet map
//   separators      "s.h.i.t", "s h i t"            -> padding rule, below
//
// TWO FOLDED FORMS, and the distinction between them is the whole design:
//   `spaced` keeps word structure ("s h i t"), so a term can be matched on WORD
//     BOUNDARIES — which is what lets "Scunthorpe" and "Assassin" through.
//   `tight`  removes it entirely ("shit"), so a term can be matched ANYWHERE —
//     which is what catches a name padded out to dodge the boundary rule.
// Both have the leet and homoglyph maps applied, so "@sshole" reads as "asshole"
// on the word-boundary pass and needs no anywhere-match at all.
//
// WHICH TERMS GET WHICH TREATMENT:
//   SLURS are anywhere-matched on `tight`, always. They are long enough not to be
//     substrings of innocent words, so an anywhere-match costs nothing.
//   SLURS_AS_WORDS are the slurs that ARE substrings of ordinary words and names —
//     "paki" in Pakistan, "nazi" in Nazir, "rapist" in therapist. They are matched
//     the same way PROFANITY is and still refuse as `slur`. See that list for the
//     measured false positives this split exists to prevent.
//   PROFANITY is word-boundary matched on `spaced`, always — and additionally
//     anywhere-matched on `tight` when the name is PADDED, because someone typing
//     "s.h.i.t" is evading rather than naming a mushroom.
//   SUBSTRING_PRONE profanity ("ass", "cum", "hoe") is word-boundary matched and
//     NEVER anywhere-matched, at any level of evasion. These sit inside too many
//     real words — Bass, Cumbria, Shoe — and an anywhere-match on them is exactly
//     the Scunthorpe problem this file is built to avoid.
//
// The lists are data. Extending them is a one-line edit and needs no other change;
// `nameFilter.test.ts` pins the BEHAVIOUR — folding, tiering, and the false-
// positive cases — rather than the contents, so growing a list can't break it.

/** Homoglyphs that survive NFKD: letters from other scripts that render as Latin.
 *  Only the confusables that turn up in real evasions — this is not a full Unicode
 *  confusables table and does not need to be. */
const CONFUSABLES: Record<string, string> = {
  // Cyrillic
  "а": "a", "в": "b", "с": "c", "е": "e", "н": "h", "к": "k", "м": "m",
  "о": "o", "р": "p", "ѕ": "s", "т": "t", "и": "u", "х": "x", "у": "y",
  // Greek
  "α": "a", "β": "b", "ε": "e", "η": "n", "ι": "i", "κ": "k", "ο": "o",
  "ρ": "p", "σ": "s", "τ": "t", "υ": "u", "χ": "x", "ν": "v", "ω": "w",
};

/** Digit and symbol substitutions, applied to both folded forms. Mapping digits
 *  onto letters means an ordinary name ending in numbers ("Bass99") folds to
 *  "bassgg" — harmless, because "ass" is word-boundary matched and "bassgg" has
 *  no such boundary. That is the case the first draft of this file got wrong. */
const LEET: Record<string, string> = {
  "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "6": "g",
  "7": "t", "8": "b", "9": "g", "@": "a", "$": "s", "!": "i", "+": "t",
};

/** Map one character through both substitution tables. */
function mapChar(ch: string): string {
  return CONFUSABLES[ch] ?? LEET[ch] ?? ch;
}

/** Fold to the matching form that KEEPS word structure: accents, script, case and
 *  leetspeak resolved, everything else collapsed to single spaces.
 *  "Ｓ.４.д Bass99" -> "s a bass99" style. Exported for the tests. */
export function foldWords(raw: string): string {
  let out = "";
  for (const ch of raw.normalize("NFKD").toLowerCase()) out += mapChar(ch);
  return out.replace(/[^a-z0-9]+/g, " ").trim();
}

/** Fold to the matching form with NO word structure at all, for anywhere-matching
 *  a padded name. "s.h.i.t" -> "shit". Exported for the tests. */
export function fold(raw: string): string {
  return foldWords(raw).replace(/ /g, "");
}

/** Was this name padded out to break up a word — "s.h.i.t", "s h i t"? Detected as
 *  two or more SINGLE-CHARACTER words, which is what padding produces and what an
 *  ordinary name does not. One lone initial is not enough: "Mr. B" is a name. */
function isPadded(raw: string): boolean {
  const words = foldWords(raw).split(" ").filter(Boolean);
  if (words.length < 2) return false;
  return words.filter((word) => word.length === 1).length >= 2;
}

// ---------------------------------------------------------------------------
// The lists. Data only — see the header for how each is matched.
// ---------------------------------------------------------------------------

/** Matched ANYWHERE in the folded name, always. Put a term here only if it never
 *  occurs inside an innocent word; if it does, it belongs in SLURS_AS_WORDS.
 *
 *  That rule is load-bearing rather than tidy, and it was broken once already: the
 *  first version of this list held `paki`, `nazi`, `negro`, `chink`, `kike` and
 *  `rapist`, every one of which is a substring of something ordinary. The measured
 *  result was that **Pakistan**, **Pakistani Farmer**, **Nazir**, **Negroponte**,
 *  **Chinkara**, **Kikelomo** and **Therapist** were all refused as slurs. Refusing a
 *  player's own nationality or given name as a racial slur is the single worst thing
 *  this file could do, so those terms moved to the word-boundary list below — where
 *  they still catch the name used AS that word, and still catch every evasion, but
 *  cannot fire from inside a longer innocent one.
 *
 *  Before adding a term here, check it against a real word and a real name. If it is
 *  short (five characters or fewer), assume it collides with something and use
 *  SLURS_AS_WORDS instead. */
const SLURS: readonly string[] = [
  "nigger", "nigga", "niggah",
  "faggot", "fagot", "tranny", "shemale",
  "gook", "spick", "wetback", "beaner", "kyke",
  "raghead", "towelhead", "sandnigger",
  "wigger", "zipperhead",
  "mongoloid",
  "hitler", "siegheil", "gaschamber", "holocaust",
  "whitepower", "whitepride",
  "childporn", "childrape", "pedophile", "paedophile",
  "molester",
];

/** Slurs that ARE substrings of innocent words, so they are matched exactly the way
 *  PROFANITY is: on word boundaries always, and anywhere once the name is padded.
 *  Kept as its own list rather than folded into PROFANITY so the refusal still reads
 *  as `slur` — the two are the same MATCHING rule but not the same kind of problem,
 *  and only one of them is worth a moderator's attention.
 *
 *  What this buys, measured: "Pakistan", "Nazir", "Negroponte", "Chinkara",
 *  "Kikelomo" and "Therapist" pass; "paki", "Nazi Bob", "n.a.z.i", "n4z1" and
 *  "NАZI" (Cyrillic А) are all still refused. */
const SLURS_AS_WORDS: readonly string[] = [
  "negro", "chink", "kike", "paki", "nazi",
  "retard", "retarded", "rapist",
];

/** Word-boundary matched always, and anywhere-matched when the name is padded. */
const PROFANITY: readonly string[] = [
  "fuck", "fucker", "fucking", "fucked", "motherfucker", "fuk", "fuq", "fck",
  "shit", "bullshit", "shithead", "shitty",
  "cunt", "twat",
  "bitch", "bastard", "whore", "slut",
  "dick", "cock", "penis", "vagina", "pussy", "clit",
  "asshole", "arsehole", "butthole", "dickhead",
  "wank", "wanker", "jizz", "blowjob", "handjob", "rimjob",
  "porn", "porno", "hentai", "orgy", "incest", "bukkake",
  "bollocks", "smegma", "queef", "felch", "nutsack",
  "pissed", "turd", "prick",
];

/** Word-boundary matched ONLY, never anywhere — these sit inside real words
 *  (Bass, Cumbria, Shoe, Essex, Titan, Analysis, Grape, Sussex). */
const SUBSTRING_PRONE: readonly string[] = [
  "ass", "arse", "anal", "anus", "cum", "hoe", "sex", "sexy",
  "tit", "tits", "titty", "boob", "boobs", "nipple",
  "piss", "crap", "fart", "knob", "semen", "nsfw",
];

/** Impersonation is judged on the WHOLE name: "Admin" is a problem, "Administrator
 *  of Turnips" is a joke, and "Modest Mouse" contains "mod" but is nobody's staff
 *  account. The maintainer's own handle is here for the same reason the rest are —
 *  the market shows a creator's name to strangers. */
const IMPERSONATION: readonly string[] = [
  "admin", "administrator", "moderator", "mod", "staff", "support",
  "official", "system", "server", "root", "owner", "developer",
  "zombiefarm", "zombiefarmreforged", "doctornerd", "helpdesk", "gamemaster",
];

/** Why a name was refused. */
export type NameRefusal = "slur" | "profanity" | "impersonation";

/** Content-check an ALREADY shape-validated name. Returns the reason it cannot be
 *  used, or `null` if it can. Pure and side-effect free — the whole filter is one
 *  function over one string, which is what makes it cheap to test. */
export function refuseName(name: string): NameRefusal | null {
  const spaced = foldWords(name);
  const tight = spaced.replace(/ /g, "");

  for (const term of SLURS) {
    if (tight.includes(fold(term))) return "slur";
  }

  const padded = isPadded(name);
  const boundaryMatch = (term: string) => new RegExp(`\\b${fold(term)}\\b`).test(spaced);

  // Same matching rule as PROFANITY below, different verdict — see SLURS_AS_WORDS.
  for (const term of SLURS_AS_WORDS) {
    if (boundaryMatch(term)) return "slur";
    if (padded && tight.includes(fold(term))) return "slur";
  }

  for (const term of PROFANITY) {
    if (boundaryMatch(term)) return "profanity";
    if (padded && tight.includes(fold(term))) return "profanity";
  }

  for (const term of SUBSTRING_PRONE) {
    if (boundaryMatch(term)) return "profanity";
  }

  if (IMPERSONATION.includes(tight)) return "impersonation";

  return null;
}
