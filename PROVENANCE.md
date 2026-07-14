# Provenance

**What this project is.** *Zombie Farm 2 Reforged* is an independent, from-scratch
reimplementation of the 2011 mobile game **Zombie Farm 2** (© The Playforge, Inc.). It is
written in **TypeScript** with **PixiJS** and **Vite**, and runs in the browser.

**What it is derived from.** Gameplay logic, tuning, and assets were recovered directly
from the shipped iOS app bundle (`ZF2R.app`, bundle id `com.playforge.ZF2R`) by:

- disassembling the compiled Objective‑C binary to recover formulas, RNG, and timers;
- converting the game's `.plist` config to JSON; and
- extracting the original cocos2d / TexturePacker art, audio, and map data.

**What it is NOT derived from.** This project does not use, fork, or incorporate the source
code, engine project files, or original (re-drawn) assets of any other fan remake. It
contains no Godot code and no third-party remake's scripts, scenes, or artwork. It is an
independent reverse‑engineering of the original shipped game — the same publicly circulated
artifact that any community project starts from — not a derivative of another team's work.

**IP note.** *Zombie Farm 2* and its assets are the property of The Playforge, Inc. The
`ZF2R.app` bundle studied here is a community re-release ("The ZF Archive, 2022"). This
project is a non-commercial fan reimplementation for study and preservation; no ownership of
the original IP is claimed.
