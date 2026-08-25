// The username content filter. These tests pin the BEHAVIOUR — how a name is
// folded, and which tier matches how — deliberately not the word lists, so
// extending a list is a data edit that cannot break the suite.
//
// The one thing worth stating up front: the shape rule in `validateUsername` is an
// ALLOWLIST, so the structural attacks (zero-width, RTL override, combining marks,
// emoji) never reach the content filter at all. They are tested here anyway, at the
// `validateUsername` level, because that is the guarantee — not the mechanism.
import { describe, expect, it } from "vitest";
import { fold, foldWords, refuseName } from "../src/nameFilter";
import { validateUsername, normalizeUsername } from "../src/logic";

/** The shape rule's job, restated as data: things a name may never contain. */
const STRUCTURAL_ATTACKS: Array<[string, string]> = [
  ["zero-width space", "Ni​ce"],
  ["zero-width joiner", "Ni‍ce"],
  ["RTL override", "abc‮def"],
  ["stacked combining marks", "á́́bc"],
  ["emoji", "Farmer \u{1F9DF}"],
  ["angle brackets", "bad<name>"],
  ["at sign", "no@symbols"],
];

describe("fold — the four evasions the shape rule lets through", () => {
  it("collapses separator padding", () => {
    expect(fold("s.h.i.t")).toBe("shit");
    expect(fold("s h i t")).toBe("shit");
    expect(fold("s-h_i.t")).toBe("shit");
  });

  it("collapses leetspeak, including the symbol substitutions", () => {
    expect(fold("5h1t")).toBe("shit");
    expect(fold("@ss")).toBe("ass");
    expect(fold("$h1t")).toBe("shit");
  });

  it("folds fullwidth forms onto ASCII", () => {
    expect(fold("ｓｈｉｔ")).toBe("shit");
  });

  it("folds cross-script homoglyphs onto their latin twins", () => {
    expect(fold("Аss")).toBe("ass");        // Cyrillic А
    expect(fold("οmega")).toBe("omega");    // Greek ο
  });

  it("strips accents rather than treating them as different letters", () => {
    expect(fold("Zoë")).toBe("zoe");
    expect(fold("çafe")).toBe("cafe");
  });

  it("leaves an ordinary name as its own lowercase letters", () => {
    expect(fold("Zombie Zoe")).toBe("zombiezoe");
    expect(foldWords("Zombie Zoe")).toBe("zombie zoe");
  });

  // The maps run over digits too, so a name ending in numbers folds oddly. That is
  // fine and deliberate: `fold` is a MATCHING form, never shown to anyone, and the
  // word-boundary rule is what keeps "Bass99" from reading as "ass".
  it("maps digits inside ordinary names too, harmlessly", () => {
    expect(fold("Bass99")).toBe("bassgg");
    expect(refuseName("Bass99")).toBeNull();
  });
});

describe("tier A — long slurs match anywhere, however they are spelled", () => {
  it("refuses a slur on its own", () => {
    expect(refuseName("wetback")).toBe("slur");
  });

  it("refuses a slur buried inside one unbroken word", () => {
    // The anywhere-match is the whole point of this tier: no boundary, still caught.
    expect(refuseName("xxwetbackxx")).toBe("slur");
  });

  it("refuses a slur through every evasion the fold undoes", () => {
    for (const evasion of ["w.e.t.b.a.c.k", "w e t b a c k", "we7b4ck", "WETВACK"])
      expect(refuseName(evasion), evasion).toBe("slur");
  });
});

describe("tier A′ — short slurs are judged as WORDS, and still refuse as slurs", () => {
  // REGRESSION. These six terms were originally on the anywhere-matched list, which
  // is only safe for terms that never sit inside an ordinary word. They all do, and
  // the measured result was a filter that called a player's nationality or given name
  // a racial slur. Each name below was refused before the split.
  it("lets a real place, name or word keep its unfortunate substring", () => {
    for (const innocent of [
      "Pakistan",     // paki
      "Pakistani Farmer",
      "Nazir",        // nazi — a common given name
      "Nazario",
      "Negroponte",   // negro — a real surname
      "Chinkara",     // chink — an Indian gazelle
      "Kikelomo",     // kike — a Yoruba given name
      "Therapist",    // rapist — the textbook case
      "The Therapist",
      "Retardant",    // retard
      "Mongolia",
    ])
      expect(refuseName(innocent), innocent).toBeNull();
  });

  it("still refuses the same term used as a word", () => {
    for (const rude of ["paki", "nazi", "Farmer Nazi Bob", "negro", "chink", "kike",
      "rapist", "Rapist Bob", "retard"])
      expect(refuseName(rude), rude).toBe("slur");
  });

  it("still refuses it through every evasion, because padding IS the evasion", () => {
    for (const evasion of ["n.a.z.i", "n a z i", "n4z1", "NАZI", "r.a.p.i.s.t", "p.a.k.i"])
      expect(refuseName(evasion), evasion).toBe("slur");
  });

  it("calls it a slur, not profanity — the two are the same rule, not the same problem", () => {
    expect(refuseName("nazi")).toBe("slur");
    expect(refuseName("shit")).toBe("profanity");
  });
});

describe("tier B — profanity is judged in context", () => {
  // This is the whole reason the two tiers exist.
  it("lets innocent words keep their unfortunate substrings", () => {
    for (const innocent of ["Scunthorpe", "Scunthorpe Sam", "Assassin", "Penistone", "Classic", "Grape", "Cockburn", "Analysis", "Shiitake"])
      expect(refuseName(innocent), innocent).toBeNull();
  });

  it("still refuses the same word used as a word", () => {
    for (const rude of ["shit", "Shit Farmer", "big ass", "cunt"])
      expect(refuseName(rude), rude).toBe("profanity");
  });

  it("refuses padded or leeted profanity anywhere, because padding IS the evasion", () => {
    for (const evasion of ["s.h.i.t", "5h1t", "@sshole", "f.u.c.k.e.r"])
      expect(refuseName(evasion), evasion).toBe("profanity");
  });

  it("accepts an ordinary farm name untouched", () => {
    for (const fine of ["Zombie Zoe", "Turnip King", "Mr. Brains", "Mr. B", "O'Brien_92-x.y", "Zoë"])
      expect(refuseName(fine), fine).toBeNull();
  });
});

describe("impersonation is judged on the whole name", () => {
  it("refuses a bare staff name", () => {
    for (const name of ["Admin", "MODERATOR", "support", "ZombieFarm"])
      expect(refuseName(name), name).toBe("impersonation");
  });

  // The maintainer's own handle is on the list for the same reason "Admin" is:
  // the market shows a creator's name to strangers, so a second DoctorNerd there
  // is a social-engineering vector rather than a coincidence.
  it("refuses the maintainer's handle", () => {
    expect(refuseName("DoctorNerd")).toBe("impersonation");
  });

  it("allows a name that merely contains one", () => {
    for (const name of ["Modest Mouse", "Administrator of Turnips", "Devon"])
      expect(refuseName(name), name).toBeNull();
  });
});

describe("validateUsername — shape and content behind one door", () => {
  it("separates a shape refusal from a content one, so the caller can explain", () => {
    expect(validateUsername("a")).toEqual({ refused: "shape" });
    expect(validateUsername("x".repeat(21))).toEqual({ refused: "shape" });
    expect(validateUsername("nazi")).toEqual({ refused: "slur" });
    expect(validateUsername("5h1t")).toEqual({ refused: "profanity" });
    expect(validateUsername("admin")).toEqual({ refused: "impersonation" });
  });

  it("rejects every structural attack at the shape rule, before the filter runs", () => {
    for (const [label, attack] of STRUCTURAL_ATTACKS)
      expect(validateUsername(attack), label).toEqual({ refused: "shape" });
  });

  it("returns the trimmed, space-collapsed name when it passes", () => {
    expect(validateUsername("  Zombie   Zoe  ")).toEqual({ name: "Zombie Zoe" });
  });

  it("keeps normalizeUsername's null-or-name contract for its existing callers", () => {
    expect(normalizeUsername("  Zombie   Zoe  ")).toBe("Zombie Zoe");
    expect(normalizeUsername("a")).toBeNull();
    expect(normalizeUsername("nazi")).toBeNull();
  });
});
