# Zombie Farm 2 Reforged

A browser-based reimplementation of **Zombie Farm 2**, built from the mechanics,
data, and assets organized in `../ZF2R_extracted/`. It runs two ways from one
codebase:

- **Offline/local build** — fully client-side, saves to `localStorage`, no server
  or account needed. This is what you get when the online config is left blank.
- **Hosted online build** — the deployed production site requires **Google
  sign-in** and a player-chosen username, and stores protocol-v3 gameplay state in a
  Cloudflare Worker + D1 backend. It adds cloud saves, friends, brain gifting, and
  read-only visits to friends' farms.

The project blends original-game fidelity work (recovered mechanics, art, and
combat numbers) with new "Reforged" additions (the online/social layer).

## License

The original source code and documentation in this repository are available
under the [MIT License](LICENSE). The third-party game assets described under
[Asset Provenance](#asset-provenance) are excluded and remain subject to their
owners' rights.

## Status

A broad playable prototype: farming, placed objects, storage, owned zombies,
mutations, quests, live invasions, cloud saves, friends, gifting, and read-only
farm visits all exist. It is **not** content-complete or fully faithful to every
original system. The biggest remaining work is raid breadth/fidelity, pets,
missing QoL menus, and broader asset integration.

### Where the docs live

Everything a contributor needs is in this repo:

| Doc | Covers |
|---|---|
| [README.md](README.md) | This file — what's implemented, gaps, how to run it |
| [CONTRIBUTING.md](CONTRIBUTING.md) | How to set up, test, and open a pull request |
| [SECURITY.md](SECURITY.md) | Anti-cheat posture, threat model, release gates |
| [PROVENANCE.md](PROVENANCE.md) | What this is derived from, and what it is not |
| [server/README.md](server/README.md) | API surface, local Worker setup, ops notes |
| [server/RUNBOOK.md](server/RUNBOOK.md) | Incident response and operational procedures |
| [docs/](docs/) | Per-system deep dives (Epic Bosses, Black Market, protocol rollout, recovered mechanics) |

Some **source-extraction** references (the disassembly notes, the raw mechanics
audit, and the phased roadmap) live outside this repo under `../ZF2R_extracted/`,
because they are bound up with the extracted commercial game bundle and are not
redistributable. You do **not** need them to contribute — anything load-bearing that
comes out of them gets written up in `docs/mechanics/` here. If you hit a gameplay
question that only those notes can answer, open an issue and ask; the answer will be
copied into the repo rather than left external.

## Documentation Rule

When changing gameplay behavior, generated asset coverage, menus, save schema, the
online/social layer, or deployment, update this README **in the same change**. If a
change adds or removes a known gap, update the "Current Gaps" section below so nobody
works from stale assumptions. Security-relevant changes to the server or raid path
must also update [SECURITY.md](SECURITY.md) and [server/README.md](server/README.md).

## Implemented

### Farming and economy
- 30x30 isometric farm rendered from generated field data with camera pan/zoom.
- Modular farmer, walk/work animation, click-to-walk, pathing around placed objects.
- Free-placed 4x4 plots with plow, plant, harvest, zombie-hole, and offline timers.
- Source-derived crop and zombie catalogs with level/currency/grave gates.
- Local gold, brains, XP, level curve, item economy, and level-up unlock popup.
- Persistent placeable objects, fruit trees, storage sheds, Mausoleum, graves, monoliths, Zombie Patch, and Zombie Pot.
- A placed Plowing Monolith makes plowing free, removes the normal plow XP reward, and adds +1 XP to every crop, zombie, and fruit-tree harvest.
- Market with Crops, Items, Upgrade, Boosts, Farmer, Pets, and Brains tabs, plus a name-search box and a themed pager on the card lists (pages fit the visible grid so it doesn't scroll on desktop/tablet).
- Farm Size upgrades (40/50/60 tiers grow the field + adjust backdrop/foliage/camera).
- Whole-farm ground/climate skins: owned terrains are stored in `GameState`, purchased in the Market Upgrade tab, repaint every tile via `Field.setClimate`, and can be re-applied for free later. The current climate is saved.
- Storage UI with Items, the owned-pet collection, Boosts, and Received tabs.

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
- Zombies that die in an invasion are culled from the roster + save, unless revived from the one-time post-battle **revival offer** (one brain per casualty, restored from a server-owned snapshot online); casualties not revived are permanently lost.
- All 11 invasions scale by player level through a full 7-stage difficulty ladder (McDonnell's authored ladder, extrapolated onto every other raid — one stage per invasion, not sequential waves; enemies emerge one at a time by design).
- Side-view enemy actor art for all 11 raids: procedurally-animated rigs for 10 (idle/walk/attack-lunge) plus Video Games' real frame-atlas sprites. Ninja/Pirate/City rigs are decoded from the iOS binary (their bone layout ships in `public/assets/raids/enemies/models.json`; the atlases have no TexturePacker plist — see `docs/mechanics/RAID_TIMING_AND_HAZARDS.md`). Raid particle FX (impact dust, victory confetti, heal).

### Online and social (Reforged)
- **Google account authentication** — the hosted build gates the whole game behind Sign in with Google (`src/net/gate.ts`); an offline build (no config) has no lock.
- **Player-chosen usernames** picked on first login.
- **Online state** across devices: the Cloudflare Worker owns protocol-v3 gameplay state, with an exclusive single-writer lease (token-hashed, account-version CAS), account-version conflict handling, an offline command outbox, and a local per-account cache.
- **Server-verified raids**: `/raid/finish` replays the pinned combat from the submitted input transcript and derives the outcome server-side (no client-asserted win/casualties); all mutation routes are serialized through the writer lease. See `SECURITY.md` for the current anti-cheat posture and residual limits.
- **Friends**: friend codes, server-backed friend lists, **daily brain gifting**, and a **gift inbox** with claiming.
- **Black Market**: server-authoritative buy/sell-zombie orders with brain/zombie escrow, a per-day order cap, price bounds, and atomic fulfillment.
- **Read-only friend-farm visits**: the client reloads into visit mode and the server returns an allowlisted projection of the friend's save (farm, objects, zombies, Zombie Pot only — currencies zeroed; progression, quests, raids, storage, and social data omitted). Autosave is disabled and editing controls are hidden while visiting.

### Platform and interface
- The Market's **Farmer** section supports independently equipping every owned source head and body. Unpriced parts start unlocked; priced heads use authoritative online purchases, and their listed harvesting, zombie growth/stat, and invasion-cooldown effects apply while equipped.
- The source-derived **Pets** catalog includes all 40 market variants with their original prices and animations. Pet purchase/selection is server-authoritative online; one selected cosmetic companion follows the farmer and has no gameplay effects.
- One responsive build for phone and desktop: capability autodetection (`src/platform.ts`), a compact touch HUD, and pinch-to-zoom/pan.
- Music, sound effects, and farm ambience are enabled by default and can be toggled independently in Settings. An optional **Mute When Unfocused** setting silences all channels while the game tab or window is in the background. The mandatory first-run tutorial uses real farm actions: plow, plant a zombie, buy and use Insta-Grow, harvest, then raid. Developer controls (a separate menu opened by an invisible hotspot beside the nameplate) support testing.
- **Farm background** setting: foliage density choices (Deep Forest / Woodland / Light Meadow) persisted in `src/prefs.ts`. This changes the density of decorative surrounding foliage — distinct from ground/climate skins, which change the farm's tile terrain.
- Settings toggles for **ZF2 Sprites** and **Reforged** edition, both persisted preferences (`src/prefs.ts`). Their behavior is **not yet wired** — the sprite toggle doesn't swap art, and the edition toggle doesn't gate features yet.

### Saving and testing
- Versioned save (local, or synchronized to the server when online) for farm, objects, zombies, boosts, quests, raids, Epic Boss runs, climate, and Zombie Pot jobs.
- Automated Vitest suites exist for both client (`npm test`) and server (economy, loot, combat stats/prediction, mutations, Zombie Pot, ability unlocking, raid catalog/ordering, friend logic, and the server-side friend-visit save projection). Coverage is incomplete; the GitHub Pages deploy is gated by the client suite, and the Worker deploy is gated by migration validation, the server suite, and typechecking.

`window.ZF` exposes debug handles including app, world, field, farmer, zombies, state, HUD,
jobs, audio, save manager, quests, quest bus, raids, and helper functions (e.g. `ZF.runRaid`, which uses the retained headless resolver).

## Current Gaps

Qualifiers: *implemented*, *partially implemented*, *placeholder*, *disabled*, *missing*, *Reforged-only*, *fidelity approximation*.

- **Raids (partially implemented / fidelity approximation):** the ladder, live combat, boosts, and permanent casualties ship, but combat still needs better side-view actors, status/focus polish, and per-raid balance tuning. Boss **summon** reinforcements, the faithful **carrotWall/junkWall** blockers, and the Circus **trapeze carried-grab** are wired; only the ground-crossing crossing-obstacle hazards (Beach crab, Tree World turtle, Lawyers cars) stay **disabled** (`RaidManager.hazardOf` returns `null`) pending better visual integration.
- **Market/upgrades (partially implemented):** Farm Size and ground/climate skins work; authored **TMX map loading is missing**.
- **Quests (partially implemented):** the farm loop, raids/invasions, Zombie Pot, and every Epic Boss emit live events. Recovered Epic quest chains are selected for the active boss; some late bosses have incomplete or missing shipped quest data. Social, photo/camera, and seasonal quest classes remain dormant.
- **Epic Bosses (eight recovered bosses):** Market → Epic Boss offers Dr. Groundhog, Loco Locust, Bully Frog, Foul Owl, Skunkarella, Rocky Rhino, General Larvaelus, and Mystical Mamba as repeatable 14-day runs for 100 brains. All use 30-second manual-focus fights, permanent casualties, retained damage, crop-harvested fight tokens (or 10 brains per attempt), scaling brain/gold victory rewards, namespaced loot, pets, and deterministic online replay. The first five use exact authored combat strips; EPB 8-10 use static recovered art until their missing atlas metadata can be reconstructed. See `docs/EPIC_BOSS_MECHANICS.md`.
- **Settings toggles — Sprites & Edition (placeholder):** the **ZF2 Sprites** and **Reforged/Traditional** switches persist a preference (`src/prefs.ts`) but do nothing yet. Sprites needs a ZF1 art pack and a runtime swap keyed off `getSpriteSet()`; Traditional needs feature gates so the online/friends surfaces read `isReforged()` and hide when it is off.
- **QoL/UI (missing):** Received item cards/reveal/use flow, save reset/export/import, and fuller settings/help menus are missing.
- **Assets (partially wired):** raid particle FX are wired, but most other particles/VFX, title/loading/news/social promo art, most localization/fonts, raid/combat audio, many terrain tiles, and many stage assets are extracted but not wired into runtime systems.
- **Tests/CI (partially implemented):** Vitest suites exist for client and server; pull requests are gated by `.github/workflows/ci.yml` (client tests + build, server tests + integration + typecheck + migration check), and both deployment workflows are test-gated. Coverage remains incomplete — notably the HUD/DOM layer, which is largely untested.

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
npm test                            # client suite — 52 files, 295 tests
npm run build                       # tsc typecheck + vite build

cd server
npm test                            # server unit suite — 18 files, 247 tests
npm run test:integration            # route-level integration — 20 tests
npm run typecheck                   # tsc --noEmit
npm run migrations:check            # validate migration ordering/numbering
```

The integration suite boots a real `wrangler dev` Worker with local D1 and drives it
over HTTP (it can't use `@cloudflare/vitest-pool-workers` — that pool breaks on paths
containing a space). It is slower than the unit suites and runs single-threaded,
since every spec shares one Worker and database.

Note that `vitest.integration.config.ts` **allowlists** which specs run — currently
`v3.spec.ts` and `blackMarket.spec.ts`. The other files in `test/integration/` are
retired protocol-v2 specs that are not executed; don't assume a green run covered
them.

CI runs all of these on every pull request (`.github/workflows/ci.yml`). Run them
locally before opening one — see [CONTRIBUTING.md](CONTRIBUTING.md).

## Deployment (GitHub Pages)

The GitHub Actions workflow (`.github/workflows/deploy.yml`) runs on every push to
`main`: it installs dependencies, runs the client Vitest suite, builds `dist/`, and
then **force-pushes the output to the `gh-pages` branch**. A test or build failure
leaves the currently deployed site unchanged. The production online config
(`VITE_API_URL`, `VITE_GOOGLE_CLIENT_ID`) is committed in `.env.production` — both
values are public, so nothing is injected at build time.

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
python tools/prep_farmer.py
python tools/prep_market.py
python tools/prep_placeables.py
python tools/prep_zombie_models.py
python tools/prep_zombie_detail.py
python tools/prep_boosts.py
python tools/prep_quests.py
python tools/prep_raids.py
python tools/prep_drops.py
python tools/prep_pets.py
python tools/prep_enemies.py
python tools/prep_upgrades.py
python tools/prep_epic_bosses.py
```

`tools/sprite_assembler.html` (built by `tools/build_sprite_assembler.py`) is a
hands-on drag/rotate/pivot editor for hand-authoring zombie `models.json`; its
export round-trips the same schema the runtime reads.

## Layout

| Path | Role |
|---|---|
| `src/main.ts` | App boot, auth gate, game wiring, input, debug hooks |
| `src/hud.ts` | DOM HUD shell: menus, market, raids, zombie/quest/social panels. Still the largest file (~4.3k lines); an in-progress refactor is moving panels out into `src/ui/` |
| `src/ui/` | Extracted HUD pieces: `hud.css`, `Modal.ts`, `hudTypes.ts`, `uiAsset.ts`, and `panels/` (dialogs, settings, storage) |
| `src/Field.ts` | Terrain, plots, crops, objects, climate skins, occupancy, persistence |
| `src/GameState.ts` | Currencies, XP/level, storage, boosts, raid progress, friends |
| `src/JobSystem.ts` | Growth/harvest timers, offline catch-up, fertilize |
| `src/assets.ts` | Runtime asset catalog and loader paths |
| `src/net/` | Online layer: auth, sign-in gate, server API client, friend visits |
| `src/save/` | Save schema and local/server save manager |
| `src/zombie/` | Owned zombies, rendering, traits, mutations, Zombie Pot |
| `src/raid/` | Raid catalog, live battle sim/scene, deterministic replay, rewards |
| `src/epicBoss/` | Epic Boss runs: catalog, fight flow, rewards (see `docs/EPIC_BOSS_MECHANICS.md`) |
| `src/quest/` | Quest bus and data-driven quest engine |
| `src/tutorial/` | First-run tutorial controller, beats, and DOM overlay |
| `src/social/` | Local friend-list fallback + gifting helpers |
| `src/audio.ts` | Opt-in BGM/SFX |
| `src/platform.ts`, `src/touchInput.ts` | Phone/desktop capability detection, pinch-zoom and pan |
| `src/prefs.ts` | Persisted user preferences (audio, foliage, sprite set, edition) |
| `src/base.ts` | `BASE_URL` prefixing for all runtime asset URLs — never hardcode `/assets/...` |
| `src/iso.ts`, `src/depthSort.ts`, `src/lighting.ts`, `src/cropTop.ts` | Isometric projection, draw-order toposort, night lighting, crop overhang fix |
| `src/economy.ts`, `src/farmRewards.ts` | Prices, payouts, and reward math |
| `server/` | Cloudflare Worker + D1 backend: saves, friends, gifting, visits, raid verification |
| `tools/` | Source extraction and public asset/data generation |
| `public/assets/` | Runtime-ready generated assets |
