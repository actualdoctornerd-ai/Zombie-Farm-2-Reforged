# Loose mutation art

Drop a PNG in this folder to give a mutation its artwork without repacking
`ZombieSheet.png`.

The shipped mutations are packed into that atlas and their `mutations.json` entries
name an atlas frame (`"file": "tomatoHead"`). Any `file` the atlas has **no frame
for** is loaded from here instead, at startup, as its own image — so a new mutation
is one PNG plus one JSON entry, and its offsets can be nudged and reloaded without
running the asset pipeline. (See `looseMutationPath` in `src/assets.ts`.)

## Adding one

1. Add the mutation to `CATALOG` in `src/zombie/mutations.ts` — append only:

```ts
{ key: "cornhead", name: "Cornhead", slot: "head", stats: { con: 8, dex: -2 } },
```

   `stats` takes any mix of `str` (Damage), `dex` (Speed) and `con` (Life). A
   **negative is a real penalty** — the card shows it signed and in red, and the
   Market card sells it honestly. Stats stay positive in combat (`MIN_COMBAT_STAT`),
   so a heavy penalty makes a zombie useless, never inverted. Authoring the first
   negative mutation is a rules change: bump the replay ruleset version with it.

2. Save the art here, e.g. `cornhead.png`.
3. Add an entry to `public/assets/zombie/mutations.json`, keyed by the mutation's
   **key** (new entries should use the key; the shipped ones are keyed by bit and
   both are resolved):

```json
"cornhead": {
  "file": "cornhead.png",
  "group": "head",
  "headRel": false,
  "ox": 6,
  "oy": 38,
  "ax": 0.73,
  "ay": 0.7,
  "z": 4,
  "replaces": "head"
}
```

4. Optionally wire a crop to it in `src/zombie/cropMutations.ts`:
   `corn: "cornhead"`, or `corn: ["cornhead", "turnip"]` for a crop that grows more
   than one.

## Notes

- `file` may omit `.png`. A `file` containing a `/` is taken as authored relative to
  `assets/zombie/`, so art kept in its own folder (`"modded_mutations/cornhead.png"`)
  resolves unchanged.
- `group` is `"head"` (tilts with the head-nod, uses the model's neck offset when
  `headRel`) or `"root"` (arms, bodies, collars — authored z, no tilt).
- `replaces` hides the base silhouette part underneath: `"head"`, `"armF"` or
  `"body"`. Omit it for an overlay. A head-slot mutation replaces `"head"` by default.
- `"armF"` names the arm SLOT, and a crop arm claims the whole pair: the base front
  **and** back arms are hidden, and the art is drawn twice — once where you authored
  it, once mirrored onto the back shoulder. Author the offsets against the FRONT arm
  only; the copy is shifted by the model's own ArmF→ArmB delta and drawn slightly
  smaller and dimmer, the same depth cue the base rigs bake into their own back arm.
  A rig with no back arm (the named specials have no arm parts at all) gets the front
  copy alone.
- Art that fails to load is warned about in the console and skipped — the zombie keeps
  its own body part rather than losing it, so a typo costs one attachment, not a rig.
- JSON has no comments. Do not put `//` in this file's siblings.
