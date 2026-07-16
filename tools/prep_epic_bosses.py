#!/usr/bin/env python3
"""Export the first source Epic Boss (Dr. Groundhog) into runtime assets."""
from __future__ import annotations

import json
import plistlib
import re
import shutil
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parent.parent
EXTRACTED = (ROOT / ".." / "ZF2R_extracted").resolve()
APP = EXTRACTED / "raw" / "ios-1.0" / "1.0" / "Payload" / "ZF2R.app"
GAMEPLAY = EXTRACTED / "data" / "json" / "gameplay"
OUT = ROOT / "public" / "assets" / "epic-bosses" / "dr-groundhog"
RECT = re.compile(r"\{\{\s*(-?\d+),\s*(-?\d+)\s*\},\s*\{\s*(\d+),\s*(\d+)\s*\}\}")
SIZE = re.compile(r"\{\s*(\d+),\s*(\d+)\s*\}")
POINT = re.compile(r"\{\s*(-?[\d.]+),\s*(-?[\d.]+)\s*\}")


def compose(sheet: Image.Image, frame: dict) -> Image.Image:
    if frame.get("textureRotated"):
        raise ValueError("rotated Epic Boss frames are unsupported")
    rect = RECT.fullmatch(frame["textureRect"])
    if not rect:
        raise ValueError(f"bad textureRect: {frame['textureRect']!r}")
    x, y, w, h = map(int, rect.groups())
    source = SIZE.fullmatch(frame.get("spriteSourceSize", f"{{{w},{h}}}"))
    offset = POINT.fullmatch(frame.get("spriteOffset", "{0,0}"))
    if not source or not offset:
        raise ValueError("bad source size/offset")
    sw, sh = map(int, source.groups())
    ox, oy = map(float, offset.groups())
    canvas = Image.new("RGBA", (sw, sh), (0, 0, 0, 0))
    canvas.alpha_composite(sheet.crop((x, y, x + w, y + h)),
                           (round((sw - w) / 2 + ox), round((sh - h) / 2 - oy)))
    return canvas


def write_strip(name: str, names: list[str], frames: dict, sheet: Image.Image) -> dict:
    images = [compose(sheet, frames[frame]) for frame in names]
    cell_w = max(image.width for image in images)
    cell_h = max(image.height for image in images)
    strip = Image.new("RGBA", (cell_w * len(images), cell_h), (0, 0, 0, 0))
    for index, image in enumerate(images):
        strip.alpha_composite(image, (index * cell_w + (cell_w - image.width) // 2,
                                      cell_h - image.height))
    filename = f"{name}.png"
    strip.save(OUT / filename, optimize=True)
    return {"file": filename, "cellWidth": cell_w, "cellHeight": cell_h,
            "frameCount": len(images), "frameSeconds": 1 / 12}


def main() -> None:
    enemies = json.loads((GAMEPLAY / "EpicEventEnemy.json").read_text(encoding="utf-8"))
    boss = next(row for row in enemies if row.get("epicBossID") == 1)
    hp = json.loads((GAMEPLAY / "EpicBossHP.json").read_text(encoding="utf-8"))
    params = json.loads((GAMEPLAY / "gameplayParameters.json").read_text(encoding="utf-8"))
    with (APP / boss["bossSpriteSheeetData"]).open("rb") as handle:
        atlas = plistlib.load(handle)["frames"]

    OUT.mkdir(parents=True, exist_ok=True)
    animations: dict[str, dict] = {}
    with Image.open(APP / boss["bossSpriteSheeetImage"]).convert("RGBA") as sheet:
        for state in ("idle", "enter", "attack", "defeat", "escape", "fly"):
            names = boss.get(f"{state}Animation", {}).get("frames", [])
            if names:
                animations[state] = write_strip(state, names, atlas, sheet)
        idle = compose(sheet, atlas[boss["initialFrame"]])
        idle.save(OUT / "boss.png", optimize=True)

    copied: list[str] = []
    for source_name, target_name in [
        (boss["bossHeadPortrait"], "portrait.png"),
        (boss["enemyIcon"], "loot-icon.png"),
        ("questicon_drgroundhog.png", "quest-icon.png"),
        (boss["IntroMovieAssets"]["shadowed1"], "intro-1.png"),
        (boss["IntroMovieAssets"]["shadowed2"], "intro-2.png"),
        (boss["IntroMovieAssets"]["revealed"], "intro-3.png"),
        ("epicEventBGM.wav", "music.wav"),
        ("epicPunch.wav", "punch.wav"),
        ("epicEventIntroSFX.caf", "intro.caf"),
    ]:
        source = APP / source_name
        if source.is_file():
            shutil.copy2(source, OUT / target_name)
            copied.append(target_name)

    layers: list[dict] = []
    for index, layer in enumerate(boss["levelAssets"]):
        source = APP / layer["sprite"]
        target = f"background-{index + 1:02d}.png"
        if source.is_file():
            shutil.copy2(source, OUT / target)
        layers.append({**layer, "sprite": target})

    catalog = {
        "id": "dr-groundhog",
        "sourceId": 1,
        "name": boss["bossName"],
        "costBrains": 10,
        "durationMs": 14 * 24 * 60 * 60 * 1000,
        "fightMs": int(params["epicBossFightTimeBeforeFleeing"]) * 1000,
        "retryMs": int(params["epicBossEscapeTime"]) * 60 * 1000,
        "encounterMs": int(params["epicBossAvailabilityTime"]) * 60 * 1000,
        "baseHp": int(hp["BaseHP"]),
        "multipliers": hp["LevelMultiplier"][:20],
        "maxLevel": 20,
        "introText": boss["introText"],
        "successText": boss["invasionSuccessText"],
        "failedText": boss["invasionFailedText"],
        "unitStats": boss["UnitStats"],
        "animations": animations,
        "levelAssets": layers,
        "loot": boss["loot"],
        # startingQuestIDs names the always-surfaced quests; include the linked
        # 5/10/15/20 milestone chain recovered from Quests.json as well.
        "questIds": [1000, 1001, 1002, 1003, 1010, 1011],
        "portrait": "portrait.png",
        "lootIcon": "loot-icon.png",
        "questIcon": "quest-icon.png",
        "music": "music.wav",
        "punchSfx": "punch.wav",
        "copied": copied,
    }
    (OUT / "catalog.json").write_text(json.dumps(catalog, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {OUT / 'catalog.json'} and {len(animations)} animation strips")


if __name__ == "__main__":
    main()
