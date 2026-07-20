# Contributing

Thanks for taking an interest. This is a non-commercial fan reimplementation of
**Zombie Farm 2**, maintained mostly by one person, so this guide is aimed at making
your change easy to review rather than at enforcing process for its own sake.

Read [PROVENANCE.md](PROVENANCE.md) first if you haven't — it explains what this
project is derived from, and the asset rules below follow from it.

## Before you start

**Open an issue first for anything non-trivial.** A bug fix or a doc correction can go
straight to a pull request. But gameplay changes, new systems, refactors of large
files, and anything touching the server, the save schema, or the security posture
should start as an issue so we can agree on the approach before you spend real time on
it. Large unsolicited pull requests are the most likely thing to sit unmerged.

**Check the Current Gaps section in the [README](README.md#current-gaps).** It lists
what's deliberately missing, partially implemented, or disabled. Items there are fair
game and already scoped.

## Setup

Requires [Node.js](https://nodejs.org) 18+ (CI runs 20). Python 3 is only needed if you
regenerate assets.

```bash
npm install
npm run dev          # http://localhost:5173
```

With no online config, the game runs fully client-side against `localStorage` — no
account, no server. **This is the right mode for most contributions.** Only set up the
Worker if you're actually changing the online layer; see
[server/README.md](server/README.md) for that path.

## Before you open a pull request

Run what CI runs. All of it passes on `main`, so anything red is yours:

```bash
npm test && npm run build

cd server
npm run migrations:check && npm run typecheck && npm test && npm run test:integration
```

If you only touched client code you can skip the server block, and vice versa — CI
runs both regardless.

## What makes a change easy to merge

**Keep it focused.** One concern per pull request. A bug fix plus an unrelated refactor
plus a formatting sweep is three reviews wearing a trenchcoat, and it will be slower
than three separate pull requests.

**Match the surrounding code.** There's no linter or formatter configured — TypeScript
strictness via `tsc` is the only automated style gate. Read the file you're editing and
match its naming, comment density, and idiom.

**Explain the "why" in the description, not just the "what".** The diff shows what
changed. The review needs to know what problem it solves and what you considered.

**Update the docs in the same change.** This repo has a documentation rule (see
[README](README.md#documentation-rule)): if you change gameplay behavior, asset
coverage, menus, the save schema, the online layer, or deployment, the README changes
in the same pull request. If your change opens or closes a known gap, edit the Current
Gaps list. Security-relevant server changes also update [SECURITY.md](SECURITY.md) and
[server/README.md](server/README.md). Stale docs are treated as a defect here, not a
follow-up.

**Add a test when the change is testable.** Client tests sit next to their source as
`*.test.ts`; server tests live in `server/test/`. The rendering, HUD, and DOM layers
are hard to test and largely untested — a well-argued "not practically testable" in the
description is accepted for those. Logic, economy, save, and server changes are
expected to come with tests.

## Areas with extra rules

**Assets.** Do not commit new art or audio extracted from the original game beyond
what's already here, and do not commit generated output that a `tools/prep_*.py` script
can produce — commit the script change instead. See
[Asset Provenance](README.md#asset-provenance): the assets under `public/assets/` are
not covered by this repo's license and are not redistributable.

**Asset URLs.** Every runtime asset path must go through `import.meta.env.BASE_URL`
(see `src/base.ts`). A hardcoded `/assets/...` works in dev and 404s on the deployed
GitHub Pages subpath, which is a nasty class of bug to catch late.

**Save schema.** Changes must load existing saves. Bump the version and add a migration
path rather than breaking players' farms; the online build additionally has to stay
compatible with server-held state.

**Server and security.** The server is authoritative for the economy, raids, and
gifting, and that's load-bearing anti-cheat rather than an implementation detail. Read
[SECURITY.md](SECURITY.md) before changing anything under `server/`. Never trust a
client-supplied outcome, quantity, or price. Database changes go in a new numbered file
under `server/migrations/` — never edit an applied migration.

**Original-game fidelity.** Where behavior is recovered from the original binary,
matching it beats improving it, and the recovered numbers in `docs/mechanics/` win over
intuition. If you believe a recovered value is wrong, say so in the issue with your
evidence rather than quietly changing it.

## Reporting bugs

Include what you did, what you expected, what happened, and whether you were in offline
or online mode — that last one narrows things down fast. Browser and device matter for
rendering and touch issues. Console errors are the single most useful thing you can
paste.

`window.ZF` exposes debug handles (app, world, field, farmer, zombies, state, HUD,
jobs, audio, save manager, quests, quest bus, raids, and helpers like `ZF.runRaid`) if
you want to poke at live state.

Security-relevant bugs — anything letting a client forge currency, items, raid
outcomes, or another player's state — should not be filed as a public issue. See
[SECURITY.md](SECURITY.md).

## Licensing

Code you contribute is under the [MIT License](LICENSE). Game assets are excluded and
remain the property of their owners.
