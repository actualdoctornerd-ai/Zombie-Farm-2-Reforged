# zombiefarm - ZF2R Reimplementation

Local-only Zombie Farm 2 reimplementation built from the mechanics and assets organized in
`../ZF2R_extracted/`.

## Status

The project is now a broad playable prototype: local farming, placed objects, storage,
owned zombies, mutations, quests, boosts, and raids all exist. It is not content-complete.
The biggest remaining work is raid breadth/fidelity, ground/climate skins, pets,
missing QoL menus, and broader asset integration. (Farm Size upgrades now ship.)

Authoritative planning/status docs:

- `../ZF2R_extracted/docs/mechanics/IMPLEMENTATION_STATUS.md` - current implementation audit.
- `../ZF2R_extracted/docs/mechanics/IMPLEMENTATION_ROADMAP.md` - phased roadmap.
- `../ZF2R_extracted/docs/mechanics/MECHANICS.md` - source mechanics reference.

## Documentation Rule

When changing gameplay behavior, generated asset coverage, menus, save schema, or milestone
scope, update this README and `../ZF2R_extracted/docs/mechanics/IMPLEMENTATION_STATUS.md` in
the same change. If a change adds or removes a known gap, update the "Current Gaps" section
there so future agents do not work from stale assumptions.

## Implemented

- 30x30 isometric farm rendered from generated field data with camera pan/zoom.
- Modular farmer, walk/work animation, click-to-walk, pathing around placed objects.
- Free-placed 4x4 plots with plow, plant, harvest, zombie-hole, freshness, and offline timers.
- Source-derived crop and zombie catalogs with level/currency/grave gates.
- Local gold, brains, XP, level curve, item economy, and level-up unlock popup.
- Versioned localStorage save/load for farm, objects, zombies, boosts, quests, raids, and Zombie Pot jobs.
- Persistent placeable objects, fruit trees, storage sheds, Mausoleum, graves, monoliths, Zombie Patch, and Zombie Pot.
- Owned zombies with per-type models/portraits, wandering, roster, detail cards, storage/deploy, selling (with confirmation), veterancy, mutations, and ability display.
- Tapping a still-growing crop or zombie opens an info popup with its type, a live countdown to harvest, and an Insta-Grow button that spends one boost use to ripen it on the spot.
- Mutation/combination system with bitmask inheritance, slot restrictions, timers, mixed-color
  combined zombies, same-type alternate results, and field rendering.
- Market with Crops, Items, Upgrade (Farm Size), Boosts, and Brains tabs.
- Storage UI with Items, Pets placeholder, Boosts, and Received tabs.
- Quest engine loading all 96 source quests, with active farm/item quest events and dormant unsupported quest classes.
- Raid select, army select, quick resolve, live battle scene, result panel, cooldown, voucher, loot, XP/gold/brain rewards, and ability tier unlocks.
- Side-view enemy actor art for all 11 raids: procedurally-animated rigs for 10 (idle/walk/attack-lunge) plus Video Games' real frame-atlas sprites. Ninja/Pirate/City rigs are decoded from the iOS binary (`tools/re/extract_stage_rigs.py`). Raid particle FX (impact dust, victory confetti, heal).
- One responsive build for phone and desktop: capability autodetection (`src/platform.ts`), a compact touch HUD, and pinch-to-zoom/pan.
- Audio toggles for farm BGM and a small SFX set; developer controls for testing.

`window.ZF` exposes debug handles including app, world, field, farmer, zombies, state, HUD,
jobs, audio, save manager, quests, quest bus, raids, and helper functions.

## Current Gaps

- **Raids:** only a subset of raids have playable stage data; most invasions are thin or catalog-only. Combat still needs broader stage data, better side-view actors, full multi-wave flow, permanent casualties, status/focus polish, and tuning.
- **Market/upgrades:** Farm Size expansion works (40/50/60 tiers grow the field + adjust the
  backdrop/foliage/camera). Ground climate/terrain skins and authored TMX map loading are not implemented.
- **Pets:** extracted pet data/art exists, but gameplay is missing and the Pets storage tab is a placeholder.
- **Quests:** raid, epic, photo, social, loot, and some combiner quest events remain dormant until their events are added to `LIVE_EVENTS` and emitted consistently.
- **QoL/UI:** market pagination/search, Received item cards/reveal/use flow, boost raid frontend for Concentration/Golden Dice, save reset/export/import, and fuller settings/help menus are missing. (Zombie selling now routes through a confirmation window.)
- **Assets:** raid particle FX (impact/confetti/heal) are wired, but most other particles/VFX, title/loading/news/social promo art, most localization/fonts, raid/combat audio, many terrain tiles, and many stage/pet assets are extracted but not wired into runtime systems.
- **Docs/tests:** docs must be kept current manually; build passes, but there is no automated test script.

## Run It Locally

Requires [Node.js](https://nodejs.org) 18+.

```bash
npm install
npm run dev
```

Open `http://localhost:5173`. The game is fully client-side and saves to the
browser's `localStorage` — no server or account needed.

Production build:

```bash
npm run build      # outputs to dist/
npm run preview    # serve the built dist/ locally
```

## Play Online (GitHub Pages)

This repo ships a GitHub Actions workflow (`.github/workflows/deploy.yml`) that
builds the app and publishes it to GitHub Pages on every push to `main`. To turn
it on:

1. Push this project to a GitHub repo (the `main` branch).
2. In the repo, go to **Settings → Pages → Build and deployment**, and set
   **Source** to **GitHub Actions**.
3. Push (or re-run the workflow). When it finishes, the game is live at
   `https://<your-username>.github.io/<repo-name>/` — share that link; there is
   nothing for the recipient to install.

The build uses a relative base (`base:"./"` in `vite.config.ts`), so it works
whether it's served from a domain root or a Pages project subpath. All runtime
asset URLs go through `import.meta.env.BASE_URL` (see `src/base.ts`); do not
reintroduce hardcoded `/assets/...` paths or subpath hosting will 404.

## Asset Provenance

The art and audio under `public/assets/` are extracted/derived from the
commercial game **Zombie Farm 2** and are used here for a personal,
non-commercial reimplementation. They are **not** covered by any license in this
repo and are not authorized for redistribution or commercial use. If you fork or
publish this, replace or remove those assets, or keep the repo private.

## Regenerate Assets

Art/data under `public/assets/` is produced from `../ZF2R_extracted/raw/ios-1.0/1.0/Payload/ZF2R.app/`.

Common prep scripts:

```bash
python tools/prep_assets.py
python tools/prep_market.py
python tools/prep_placeables.py
python tools/prep_zombie_models.py
python tools/prep_zombie_detail.py
python tools/prep_boosts.py
python tools/prep_quests.py
python tools/prep_raids.py
python tools/prep_drops.py
```

## Layout

| Path | Role |
|---|---|
| `src/main.ts` | App boot, game wiring, input, debug hooks |
| `src/hud.ts` | DOM HUD, menus, market, storage, raids, zombie/quest panels |
| `src/Field.ts` | Terrain, plots, crops, objects, occupancy, persistence |
| `src/GameState.ts` | Currencies, XP/level, storage, boosts, raid progress |
| `src/save/` | Save schema and localStorage manager |
| `src/zombie/` | Owned zombies, rendering, traits, mutations, Zombie Pot |
| `src/raid/` | Raid catalog, resolver, live battle scene, rewards |
| `src/quest/` | Quest bus and data-driven quest engine |
| `src/audio.ts` | Opt-in BGM/SFX |
| `tools/` | Source extraction and public asset/data generation |
| `public/assets/` | Runtime-ready generated assets |
