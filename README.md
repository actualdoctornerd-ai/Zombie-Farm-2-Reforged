# Zombie Farm 2 Reforged

A browser-based reimplementation of **Zombie Farm 2**, built from the mechanics,
data, and assets organized in `../ZF2R_extracted/`. It runs two ways from one
codebase:

- **Offline/local build** — fully client-side, saves to `localStorage`, no server
  or account needed. This is what you get when the online config is left blank.
- **Hosted online build** — the deployed production site requires **Google
  sign-in** and a player-chosen username, and stores the authoritative save in a
  Cloudflare Worker + D1 backend. It adds cloud saves, friends, brain gifting, and
  read-only visits to friends' farms.

The project blends original-game fidelity work (recovered mechanics, art, and
combat numbers) with new "Reforged" additions (the online/social layer).

## Status

A broad playable prototype: farming, placed objects, storage, owned zombies,
mutations, quests, live invasions, cloud saves, friends, gifting, and read-only
farm visits all exist. It is **not** content-complete or fully faithful to every
original system. The biggest remaining work is raid breadth/fidelity, pets,
missing QoL menus, and broader asset integration.

Authoritative planning/status docs live **outside this repo** and are the
development-side references (they are intentionally not published here):

- `../ZF2R_extracted/docs/mechanics/IMPLEMENTATION_STATUS.md` - current implementation audit.
- `../ZF2R_extracted/docs/mechanics/IMPLEMENTATION_ROADMAP.md` - phased roadmap.
- `../ZF2R_extracted/docs/mechanics/MECHANICS.md` - source mechanics reference.

## Documentation Rule

When changing gameplay behavior, generated asset coverage, menus, save schema, the
online/social layer, or deployment, update this README and
`../ZF2R_extracted/docs/mechanics/IMPLEMENTATION_STATUS.md` in the same change. If a
change adds or removes a known gap, update the "Current Gaps" section there so
future agents do not work from stale assumptions.

## Implemented

### Farming and economy
- 30x30 isometric farm rendered from generated field data with camera pan/zoom.
- Modular farmer, walk/work animation, click-to-walk, pathing around placed objects.
- Free-placed 4x4 plots with plow, plant, harvest, zombie-hole, and offline timers.
- Source-derived crop and zombie catalogs with level/currency/grave gates.
- Local gold, brains, XP, level curve, item economy, and level-up unlock popup.
- Persistent placeable objects, fruit trees, storage sheds, Mausoleum, graves, monoliths, Zombie Patch, and Zombie Pot.
- Market with Crops, Items, Upgrade, Boosts, and Brains tabs, plus a name-search box and a themed pager on the card lists (pages fit the visible grid so it doesn't scroll on desktop/tablet).
- Farm Size upgrades (40/50/60 tiers grow the field + adjust backdrop/foliage/camera).
- Whole-farm ground/climate skins: owned terrains are stored in `GameState`, purchased in the Market Upgrade tab, repaint every tile via `Field.setClimate`, and can be re-applied for free later. The current climate is saved.
- Storage UI with Items, Pets placeholder, Boosts, and Received tabs.

### Zombies and mutation
- Owned zombies with per-type models/portraits, wandering, roster, detail cards, storage/deploy, selling (with confirmation), veterancy, mutations, and ability display.
- Tapping a still-growing crop or zombie opens an info popup with its type, a live countdown to harvest, and an Insta-Grow button that spends one boost use to ripen it on the spot.
- Mutation/combination system (Zombie Pot) with bitmask inheritance, slot restrictions, timers, mixed-color combined zombies, same-type alternate results, and field rendering.

### Quests
- Quest engine loading all 96 source quests, activating each when its prerequisite and level gate are met.
- Live quest events cover the farm loop (soil plowing, crop plant/harvest, zombie harvest, item purchase), raids/invasions (successful invasion, perfect invasion, raid loot), and the Zombie Pot combiner (combine + harvest).
- Completing a quest shows a celebratory "QUEST COMPLETE!" popup (quest icon + reward), styled like the level-up popup; multiple completions queue and show one at a time. Raid-driven completions are held until the player returns to the farm, so they never pop over the battle result screen.

### Raids and combat
- Raid select, army select, **live battle scene** (there is no player-facing quick/instant resolve — the game always plays the fight out), result panel, cooldown, voucher, loot, and XP/gold/brain rewards, including first-clear XP and ability tier unlocks.
- Army-selection boost frontend: a **Concentration** toggle (bypasses the focus minigame) and a **Golden Dice** stepper (raises loot tier), both inventory-aware, consumed at raid start.
- Zombies that die in an invasion are permanently lost (culled from the roster + save).
- All 11 invasions scale by player level through a full 7-stage difficulty ladder (McDonnell's authored ladder, extrapolated onto every other raid — one stage per invasion, not sequential waves; enemies emerge one at a time by design).
- Side-view enemy actor art for all 11 raids: procedurally-animated rigs for 10 (idle/walk/attack-lunge) plus Video Games' real frame-atlas sprites. Ninja/Pirate/City rigs are decoded from the iOS binary (`tools/re/extract_stage_rigs.py`). Raid particle FX (impact dust, victory confetti, heal).

### Online and social (Reforged)
- **Google account authentication** — the hosted build gates the whole game behind Sign in with Google (`src/net/gate.ts`); an offline build (no config) has no lock.
- **Player-chosen usernames** picked on first login.
- **Cloud saves** across devices: the Cloudflare Worker is the authoritative store, with revision-guarded writes, 409 conflict handling, an offline retry outbox, and a local per-account cache.
- **Friends**: friend codes, server-backed friend lists, **daily brain gifting**, and a **gift inbox** with claiming.
- **Read-only friend-farm visits**: the client reloads into visit mode and the server returns an allowlisted projection of the friend's save (farm, objects, zombies, Zombie Pot only — currencies zeroed; progression, quests, raids, storage, and social data omitted). Autosave is disabled and editing controls are hidden while visiting.

### Platform and interface
- One responsive build for phone and desktop: capability autodetection (`src/platform.ts`), a compact touch HUD, and pinch-to-zoom/pan.
- Audio toggles for farm BGM and a small SFX set; developer controls (a separate menu opened by an invisible hotspot beside the nameplate) for testing.
- **Farm background** setting: foliage density choices (Deep Forest / Woodland / Light Meadow) persisted in `src/prefs.ts`. This changes the density of decorative surrounding foliage — distinct from ground/climate skins, which change the farm's tile terrain.
- Settings toggles for **ZF2 Sprites** and **Reforged** edition, both persisted preferences (`src/prefs.ts`). Their behavior is **not yet wired** — the sprite toggle doesn't swap art, and the edition toggle doesn't gate features yet.

### Saving and testing
- Versioned save (local, or synchronized to the server when online) for farm, objects, zombies, boosts, quests, raids, climate, and Zombie Pot jobs.
- Automated Vitest suites exist for both client (`npm test`) and server (economy, loot, combat stats/prediction, mutations, Zombie Pot, ability unlocking, raid catalog/ordering, friend logic, and the server-side friend-visit save projection). Coverage is incomplete and the deploy workflow does not currently run the tests.

`window.ZF` exposes debug handles including app, world, field, farmer, zombies, state, HUD,
jobs, audio, save manager, quests, quest bus, raids, and helper functions (e.g. `ZF.runRaid`, which uses the retained headless resolver).

## Current Gaps

Qualifiers: *implemented*, *partially implemented*, *placeholder*, *disabled*, *missing*, *Reforged-only*, *fidelity approximation*.

- **Raids (partially implemented / fidelity approximation):** the ladder, live combat, boosts, and permanent casualties ship, but combat still needs better side-view actors, status/focus polish, and per-raid balance tuning. Boss **summon/wall** specials are deferred (templates are built but not spawned), and ground-crossing **environmental hazards are disabled** (`RaidManager.hazardOf` returns `null`) pending better visual integration.
- **Market/upgrades (partially implemented):** Farm Size and ground/climate skins work; authored **TMX map loading is missing**.
- **Pets (missing):** extracted pet data/art exists, but gameplay is missing and the Pets storage tab is a **placeholder**.
- **Quests (partially implemented):** the farm loop, raids/invasions, and the Zombie Pot combiner emit live events. Social, photo/camera, and Epic Boss quest classes remain **dormant** until their events are wired into `LIVE_EVENTS` and emitted.
- **Settings toggles — Sprites & Edition (placeholder):** the **ZF2 Sprites** and **Reforged/Traditional** switches persist a preference (`src/prefs.ts`) but do nothing yet. Sprites needs a ZF1 art pack and a runtime swap keyed off `getSpriteSet()`; Traditional needs feature gates so the online/friends surfaces read `isReforged()` and hide when it is off.
- **QoL/UI (missing):** Received item cards/reveal/use flow, save reset/export/import, and fuller settings/help menus are missing.
- **Assets (partially wired):** raid particle FX are wired, but most other particles/VFX, title/loading/news/social promo art, most localization/fonts, raid/combat audio, many terrain tiles, and many stage/pet assets are extracted but not wired into runtime systems.
- **Tests/CI (partially implemented):** Vitest suites exist for client and server, but coverage is incomplete and the deploy workflow does not run them.

## Run It Locally

Requires [Node.js](https://nodejs.org) 18+.

### Offline / local build (no account)

Leave the online config blank (the default) and the game runs fully client-side,
saving to `localStorage` — no server or account needed.

```bash
npm install
npm run dev
```

Open `http://localhost:5173`.

### Online development build

To exercise the online layer (sign-in, cloud saves, friends), you also need the
server running and the client pointed at it via `.env.local`:

- `VITE_API_URL` — base URL of your local Worker (`wrangler dev` serves `http://127.0.0.1:8787`).
- `VITE_GOOGLE_CLIENT_ID` — a Google OAuth web client id. Leave blank to use the
  dev sign-in bypass (`window.zfDevSignIn`), which the Worker only honors while
  `DEV_AUTH=1` — the real Google popup can't be automated.

Run the server (from `server/`):

```bash
cd server
npm install
npm run db:apply:local   # create the local D1 schema
npm run dev              # wrangler dev on :8787
```

Then `npm run dev` in the repo root as above. See `.env.example` for all client
config; both online values are public (safe to commit).

### Production build

```bash
npm run build      # tsc + vite build → dist/
npm run preview    # serve the built dist/ locally
```

## Tests

```bash
npm test                 # client Vitest suite
cd server && npm test    # server Vitest suite
cd server && npm run typecheck
```

## Deployment (GitHub Pages)

The GitHub Actions workflow (`.github/workflows/deploy.yml`) runs on every push to
`main`: it builds `dist/` and **force-pushes the output to the `gh-pages`
branch**. The production online config (`VITE_API_URL`, `VITE_GOOGLE_CLIENT_ID`)
is committed in `.env.production` — both values are public, so nothing is injected
at build time.

To serve it:

1. Push this project to a GitHub repo (the `main` branch) so the workflow runs.
2. In the repo, go to **Settings → Pages → Build and deployment**, set **Source**
   to **Deploy from a branch**, and choose branch **`gh-pages`** / folder **`/ (root)`**.
3. When the workflow finishes and Pages publishes, the game is live at
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
| `src/main.ts` | App boot, auth gate, game wiring, input, debug hooks |
| `src/hud.ts` | DOM HUD, menus, market, storage, raids, zombie/quest/social panels |
| `src/Field.ts` | Terrain, plots, crops, objects, climate skins, occupancy, persistence |
| `src/GameState.ts` | Currencies, XP/level, storage, boosts, raid progress, friends |
| `src/net/` | Online layer: auth, sign-in gate, server API client, friend visits |
| `src/save/` | Save schema and local/server save manager |
| `src/zombie/` | Owned zombies, rendering, traits, mutations, Zombie Pot |
| `src/raid/` | Raid catalog, live battle sim/scene, headless resolver, rewards |
| `src/quest/` | Quest bus and data-driven quest engine |
| `src/social/` | Local friend-list fallback + gifting helpers |
| `src/audio.ts` | Opt-in BGM/SFX |
| `server/` | Cloudflare Worker + D1 backend: saves, friends, gifting, visits |
| `tools/` | Source extraction and public asset/data generation |
| `public/assets/` | Runtime-ready generated assets |
