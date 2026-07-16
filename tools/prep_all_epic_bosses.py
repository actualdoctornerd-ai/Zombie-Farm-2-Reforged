#!/usr/bin/env python3
"""Prepare every recoverable Epic Boss asset family for the web runtime.

Bosses 1-5 use the authored EpicEventEnemy animation lists. EPB 8-10 shipped
without those definitions or atlas metadata, so they intentionally use their
revealed intro art as a static combat actor while preserving their raw sheets in
the output for future frame reconstruction.
"""
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
OUT_ROOT = ROOT / "public" / "assets" / "epic-bosses"
RECT = re.compile(r"\{\{\s*(-?\d+),\s*(-?\d+)\s*\},\s*\{\s*(\d+),\s*(\d+)\s*\}\}")
SIZE = re.compile(r"\{\s*(\d+),\s*(\d+)\s*\}")
POINT = re.compile(r"\{\s*(-?[\d.]+),\s*(-?[\d.]+)\s*\}")

SLUGS = {
    1: "dr-groundhog",
    2: "loco-locust",
    3: "bully-frog",
    4: "foul-owl",
    5: "skunkarella",
}
QUEST_ICONS = {
    1: "questicon_drgroundhog.png",
    2: "questicon_locolocust.png",
    3: "questicon_bullyfrog.png",
    4: "Icon_Quest_FoulOwl.png",
    5: "questIcon_EP_Boss7.png",
}
MAX_LEVELS = {1: 20, 2: 40, 3: 40, 4: 40, 5: 40}
QUEST_IDS = {
    1: ["1000", "1001", "1002", "1003", "1010", "1011"],
    2: ["2000", "2001", "2002", "2003", "2004", "2005", "2006", "2010", "2011"],
    # The shipped Bully Frog row incorrectly reuses Groundhog IDs for its middle
    # milestones. Keep only its unambiguous, boss-prefixed quest records.
    3: ["3000", "3010", "3011"],
    4: ["4000", "4001", "4002", "4003", "4004", "4005", "4006", "4010", "4011"],
    5: ["5000", "5011"],
}
SKUNK_LOOT = [
    {"level": 5, "name": "Skunkarella's Perfume", "tile": "perfumeVat", "sprite": "Perfume_Vat.png"},
    {"level": 10, "name": "Skunkarella's Scarecrow", "tile": "fashionableScarecrow", "sprite": "Fashionable_Scarecrow.png"},
    {"level": 15, "name": "Skunkarella's Mirror", "tile": "evilMirror", "sprite": "Fancy_Evil_Mirror.png"},
    {"level": 20, "name": "Skunkarella's Gravestone", "tile": "bedazzledGravestone", "sprite": "blingn_Gravestone.png"},
    {"level": 25, "name": "Skunkarella's Fountain", "tile": "fancyFountain", "sprite": "fancyChocoFountain_default.png"},
    {"level": 30, "name": "Skunkarella's Gazebo", "tile": "crystalGazebo", "sprite": "Crystal_Gazebo.png"},
    {"level": 35, "name": "Skunkarella's Car", "tile": "diamondCar", "sprite": "Diamond_Car.png"},
    {"level": 37, "name": "Skunkarella's Home", "tile": "jewelHome", "sprite": "Jewel_Home.png"},
    {"level": 39, "name": "Tame Skunk", "stageActor": "skunkPetActor", "sprite": "skunkPet_default.png"},
]

LATE_BOSSES = [
    {
        "id": "rocky-rhino", "sourceId": 8, "name": "Rocky Rhino",
        "questIds": ["8000"],
        "sheet": "rockyRhino_default.png", "portrait": "epb8_portrait_intro.png",
        "lootIcon": "epb8_loot_icon.png", "questIcon": "epb8_quest_icon.png",
        "intros": ["epb8_INTRO1.png", "epb8_INTRO2.png", "epb8_INTRO3.png"],
        "support": ["EPB8_BANNER1.png", "EPB8_CAVE.png", "ROCKY_RHINO_GONG.png",
                    "Rocky_Beetle.png", "EPB_8_Banner_MarketItems.png",
                    "Rocky_Cave_Icon_MarketItems.png", "GONG_ROCKY_RHINO_Icon_MarketItems.png",
                    "Rocky_Beetle_MarketIcons.png", "rockyRhinoPet_default.png",
                    "rockyRhinoPet_default.plist", "rockyrhinogong.mp3"],
        "loot": [
            (10, "Rocky Rhino's Banner", "rockyRhinosBanner", "EPB8_BANNER1.png", None),
            (20, "Rocky Rhino's Cave", "rockyRhinosCave", "EPB8_CAVE.png", None),
            (30, "Rocky Rhino's Gong", "rockyRhinosGong", "ROCKY_RHINO_GONG.png", None),
            (35, "Rocky Rhino's Sculpture", "rockyRhinosSculpture", "Rocky_Beetle.png", None),
            (40, "Tame Rhino", None, "rockyRhinoPet_default.png", "rockyRhinoPetActor"),
        ],
    },
    {
        "id": "general-larvaelus", "sourceId": 9, "name": "General Larvaelus",
        "questIds": ["9000", "9011"],
        "sheet": "generalLarvaelus_default.png", "portrait": "EpicBoss9_PORTRAIT_INTRO.png",
        "lootIcon": "EpicBoss9_LOOT_ICON.png", "questIcon": "EpicBoss9_QUEST_ICON.png",
        "intros": ["EpicBoss9_INTRO1.png", "EpicBoss9_INTRO2.png", "EpicBoss9_INTRO3.png"],
        "support": ["EPB_9_Banner.png", "EPB_9Teleporter_A.png", "EPB_9Teleporter_B.png",
                    "teleporter_default.png", "teleporter_default.plist", "EPB_9_Teleporter_PRTCLE.plist",
                    "Icon_MarketItems_EPB_9_BANNER.png", "Icon_MarketItems_EPB9_A_TELEPORTER.png",
                    "Icon_MarketItems_EPB9_B_TELEPORTER.png", "Icon_MarketItems_EPB9_MAIN_TELEPORTER.png",
                    "generalLarvaelusPet_default.png", "generalLarvaelusPet_default.plist"],
        "loot": [
            (10, "General Larvaelus' Banner", "generalLarvaelusBanner", "EPB_9_Banner.png", None),
            (20, "General Larvaelus' Blue Portal", "generalLarvaelusTeleporterA", "EPB_9Teleporter_A.png", None),
            (30, "General Larvaelus' Red Portal", "generalLarvaelusTeleporterB", "EPB_9Teleporter_B.png", None),
            (35, "General Larvaelus' Portal", "teleporter", "teleporter_default.png", None),
            (40, "Tame Larva", None, "generalLarvaelusPet_default.png", "generalLarvaelusPetActor"),
        ],
    },
    {
        "id": "mystical-mamba", "sourceId": 10, "name": "Mystical Mamba",
        "questIds": ["10000", "10011"],
        "sheet": "mysticalMamba_default.png", "portrait": "EPB_10_portrait_intro.png",
        "lootIcon": "EPB_10_loot_Icon.png", "questIcon": "EPB_10_Quest_Icon.png",
        "intros": ["EPB_10_INTRO_1.png", "EPB_10_INTRO_2.png", "EPB_10_INTRO_3.png"],
        "support": ["EPB_10_IPHONE_ns_icon.png", "EPB_10_BANNER.png",
                    "EPB_10_BANNER_Icon_MarketItems.png", "zomtarMachine_default.png",
                    "zomtarMachine_default.plist", "ZOMTAR_machine_Icon_MarketItems.png",
                    "ZOMTAR_EPB10_default.png", "ZOMTAR_EPB10_default.plist",
                    "ZOMTAR_PARTICLE.plist", "tameMamba_default.png", "tameMamba_default.plist"],
        "loot": [
            (15, "Mystical Mamba Banner", "mysticalMambaBanner", "EPB_10_BANNER.png", None),
            (30, "Mystical Mamba's Wish Machine", "mysticalMambasWishMachineLeft", "zomtarMachine_default.png", None),
            (40, "Tame Mamba", None, "tameMamba_default.png", "tameMamba"),
        ],
    },
]


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


def write_strip(out: Path, name: str, names: list[str], frames: dict, sheet: Image.Image) -> dict:
    images = [compose(sheet, frames[frame]) for frame in names]
    cell_w = max(image.width for image in images)
    cell_h = max(image.height for image in images)
    strip = Image.new("RGBA", (cell_w * len(images), cell_h), (0, 0, 0, 0))
    for index, image in enumerate(images):
        strip.alpha_composite(image, (index * cell_w + (cell_w - image.width) // 2,
                                      cell_h - image.height))
    filename = f"{name}.png"
    strip.save(out / filename, optimize=True)
    return {"file": filename, "cellWidth": cell_w, "cellHeight": cell_h,
            "frameCount": len(images), "frameSeconds": 1 / 12}


def copy(out: Path, source: str, target: str | None = None) -> str | None:
    src = APP / source
    if not src.is_file():
        print(f"warning: missing {source}")
        return None
    name = target or source
    shutil.copy2(src, out / name)
    return name


def multipliers(raw: list[float], max_level: int) -> list[float]:
    return raw[:max_level] + [raw[-1]] * max(0, max_level - len(raw))


def common_catalog(source_id: int, slug: str, name: str, max_level: int,
                   hp: dict, params: dict) -> dict:
    return {
        "id": slug, "sourceId": source_id, "name": name,
        "costBrains": 10, "durationMs": 14 * 24 * 60 * 60 * 1000,
        "fightMs": int(params["epicBossFightTimeBeforeFleeing"]) * 1000,
        "retryMs": int(params["epicBossEscapeTime"]) * 60 * 1000,
        "encounterMs": int(params["epicBossAvailabilityTime"]) * 60 * 1000,
        "baseHp": int(hp["BaseHP"]),
        "multipliers": multipliers(hp["LevelMultiplier"], max_level),
        "maxLevel": max_level,
        "music": "music.wav", "punchSfx": "punch.wav",
    }


def prepare_authored(boss: dict, hp: dict, params: dict) -> None:
    source_id = int(boss["epicBossID"])
    slug = SLUGS[source_id]
    out = OUT_ROOT / slug
    out.mkdir(parents=True, exist_ok=True)
    with (APP / boss["bossSpriteSheeetData"]).open("rb") as handle:
        atlas = plistlib.load(handle)["frames"]
    animations = {}
    with Image.open(APP / boss["bossSpriteSheeetImage"]).convert("RGBA") as sheet:
        for state in ("idle", "enter", "attack", "defeat", "escape", "fly"):
            names = boss.get(f"{state}Animation", {}).get("frames", [])
            if names:
                animations[state] = write_strip(out, state, names, atlas, sheet)
        compose(sheet, atlas[boss["initialFrame"]]).save(out / "boss.png", optimize=True)

    intro = boss["IntroMovieAssets"]
    mappings = [
        (boss["bossHeadPortrait"], "portrait.png"), (boss["enemyIcon"], "loot-icon.png"),
        (QUEST_ICONS[source_id], "quest-icon.png"), (intro["shadowed1"], "intro-1.png"),
        (intro["shadowed2"], "intro-2.png"), (intro["revealed"], "intro-3.png"),
        ("epicEventBGM.wav", "music.wav"), ("epicPunch.wav", "punch.wav"),
        ("epicEventIntroSFX.caf", "intro.caf"),
        (boss["bossSpriteSheeetImage"], "source-sheet.png"),
        (boss["bossSpriteSheeetData"], "source-sheet.plist"),
    ]
    copied = [x for source, target in mappings if (x := copy(out, source, target))]
    loot = SKUNK_LOOT if source_id == 5 else boss.get("loot", [])
    for item in loot:
        if item.get("sprite"):
            copied_name = copy(out, item["sprite"])
            if copied_name:
                copied.append(copied_name)
        if item.get("stageActor"):
            plist = Path(item["sprite"]).with_suffix(".plist").name
            copied_name = copy(out, plist)
            if copied_name:
                copied.append(copied_name)

    layers = []
    for index, layer in enumerate(boss["levelAssets"]):
        target = f"background-{index + 1:02d}.png"
        copy(out, layer["sprite"], target)
        layers.append({**layer, "sprite": target})
    catalog = common_catalog(source_id, slug, boss["bossName"], MAX_LEVELS[source_id], hp, params)
    catalog.update({
        "introText": boss["introText"], "successText": boss["invasionSuccessText"],
        "failedText": boss["invasionFailedText"], "unitStats": boss["UnitStats"],
        "animations": animations, "levelAssets": layers, "loot": loot,
        "questIds": QUEST_IDS[source_id],
        "portrait": "portrait.png", "lootIcon": "loot-icon.png", "questIcon": "quest-icon.png",
        "bossTexture": "boss.png", "reconstructed": False, "copied": sorted(set(copied)),
    })
    (out / "catalog.json").write_text(json.dumps(catalog, indent=2) + "\n", encoding="utf-8")
    print(f"prepared {boss['bossName']}: {len(animations)} animations")


def prepare_late(boss: dict, hp: dict, params: dict) -> None:
    out = OUT_ROOT / boss["id"]
    out.mkdir(parents=True, exist_ok=True)
    copied = []
    mappings = [
        (boss["portrait"], "portrait.png"), (boss["lootIcon"], "loot-icon.png"),
        (boss["questIcon"], "quest-icon.png"), (boss["intros"][0], "intro-1.png"),
        (boss["intros"][1], "intro-2.png"), (boss["intros"][2], "intro-3.png"),
        (boss["intros"][2], "boss.png"), (boss["sheet"], "source-sheet.png"),
        ("epicEventBGM.wav", "music.wav"), ("epicPunch.wav", "punch.wav"),
        ("epicEventIntroSFX.caf", "intro.caf"),
    ]
    for source, target in mappings:
        name = copy(out, source, target)
        if name:
            copied.append(name)
    for source in boss["support"]:
        name = copy(out, source)
        if name:
            copied.append(name)
    # Late definitions use the shared battle scene. Preserve its authored layer layout.
    layers = []
    for index in range(1, 13):
        target = f"background-{index:02d}.png"
        copy(out, f"bg_{index:02d}.png", target)
        layers.append({"anchor": "{0,0}", "position": "{0,0}",
                       "sprite": target, "z": index - 13})
    loot = [{"level": level, "name": name, "sprite": sprite,
             **({"tile": tile} if tile else {}), **({"stageActor": actor} if actor else {})}
            for level, name, tile, sprite, actor in boss["loot"]]
    catalog = common_catalog(boss["sourceId"], boss["id"], boss["name"], 40, hp, params)
    catalog.update({
        "introText": f"{boss['name']} is here",
        "successText": f"You beat {boss['name']}. They'll be back stronger than before!",
        "failedText": f"{boss['name']} beat you",
        "unitStats": {"str": 2, "dex": 2, "con": 20,
                      "attacks": [{"name": "EpicBossAttack", "frequency": 100}]},
        "animations": {}, "levelAssets": layers, "loot": loot, "questIds": boss["questIds"],
        "portrait": "portrait.png", "lootIcon": "loot-icon.png", "questIcon": "quest-icon.png",
        "bossTexture": "boss.png", "reconstructed": True, "copied": sorted(set(copied)),
    })
    (out / "catalog.json").write_text(json.dumps(catalog, indent=2) + "\n", encoding="utf-8")
    print(f"prepared {boss['name']}: static reconstructed actor")


def main() -> None:
    enemies = json.loads((GAMEPLAY / "EpicEventEnemy.json").read_text(encoding="utf-8"))
    hp = json.loads((GAMEPLAY / "EpicBossHP.json").read_text(encoding="utf-8"))
    params = json.loads((GAMEPLAY / "gameplayParameters.json").read_text(encoding="utf-8"))
    for boss in sorted(enemies, key=lambda row: int(row["epicBossID"])):
        prepare_authored(boss, hp, params)
    for boss in LATE_BOSSES:
        prepare_late(boss, hp, params)


if __name__ == "__main__":
    main()
