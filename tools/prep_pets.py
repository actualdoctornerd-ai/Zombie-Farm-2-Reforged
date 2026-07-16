#!/usr/bin/env python3
"""Export the source pet market and normalized animation strips.

Reads Pets.plist plus its TexturePacker atlases from the extracted iOS app. Each
actor becomes one fixed-cell horizontal strip so Pixi can animate trimmed source
frames without visual jitter. Market variants remain separate catalog entries
(the white/pink bunny share one actor strip and differ by tint).
"""
from __future__ import annotations

import argparse
import json
import os
import plistlib
import re
from pathlib import Path

from PIL import Image


HERE = Path(__file__).resolve().parent
PROJ = HERE.parent
APP = (PROJ / ".." / "ZF2R_extracted" / "raw" / "ios-1.0" / "1.0" /
       "Payload" / "ZF2R.app").resolve()
OUT = PROJ / "public" / "assets" / "pets"
PAIR = re.compile(r"\{\{\s*(-?\d+),\s*(-?\d+)\s*\},\s*\{\s*(\d+),\s*(\d+)\s*\}\}")
SIZE = re.compile(r"\{\s*(\d+),\s*(\d+)\s*\}")
POINT = re.compile(r"\{\s*(-?[\d.]+),\s*(-?[\d.]+)\s*\}")


def load_plist(name: str) -> dict:
    path = APP / name
    if not path.is_file():
        raise FileNotFoundError(f"missing source plist: {path}")
    with path.open("rb") as handle:
        return plistlib.load(handle)


def pair(value: str, label: str) -> tuple[int, int, int, int]:
    match = PAIR.fullmatch(value)
    if not match:
        raise ValueError(f"bad {label}: {value!r}")
    return tuple(map(int, match.groups()))  # type: ignore[return-value]


def size(value: str, label: str) -> tuple[int, int]:
    match = SIZE.fullmatch(value)
    if not match:
        raise ValueError(f"bad {label}: {value!r}")
    return int(match.group(1)), int(match.group(2))


def point(value: str | None) -> tuple[float, float]:
    match = POINT.fullmatch(value or "{0,0}")
    if not match:
        raise ValueError(f"bad spriteOffset: {value!r}")
    return float(match.group(1)), float(match.group(2))


def market_rows(actor_key: str, actor: dict) -> list[dict]:
    if "marketInfo" in actor:
        return [actor["marketInfo"]]
    return list(actor.get("marketEntries", []))


def referenced_frames(actor_key: str, actor: dict, atlas_frames: dict) -> list[str]:
    ordered: list[str] = []
    for animation in actor.get("frameAnimations", {}).values():
        for frame in animation.get("animationFrames", []):
            if frame not in atlas_frames:
                raise ValueError(f"{actor_key}: animation references missing frame {frame!r}")
            if frame not in ordered:
                ordered.append(frame)
    if not ordered:
        fallback = actor.get("frameName") or next(iter(atlas_frames), None)
        if not fallback or fallback not in atlas_frames:
            raise ValueError(f"{actor_key}: no usable animation or fallback frame")
        ordered.append(fallback)
    return ordered


def compose_frame(sheet: Image.Image, data: dict) -> Image.Image:
    if data.get("textureRotated"):
        raise ValueError("rotated pet atlas frames are not supported")
    x, y, w, h = pair(data["textureRect"], "textureRect")
    source_w, source_h = size(data.get("spriteSourceSize", f"{{{w},{h}}}"), "spriteSourceSize")
    offset_x, offset_y = point(data.get("spriteOffset"))
    left = round((source_w - w) / 2 + offset_x)
    top = round((source_h - h) / 2 - offset_y)
    canvas = Image.new("RGBA", (source_w, source_h), (0, 0, 0, 0))
    canvas.alpha_composite(sheet.crop((x, y, x + w, y + h)), (left, top))
    return canvas


def export(check_only: bool = False) -> dict:
    source = load_plist("Pets.plist")
    actors = source.get("Entries", {})
    if not isinstance(actors, dict) or not actors:
        raise ValueError("Pets.plist has no Entries")

    catalog: list[dict] = []
    seen_keys: set[str] = set()
    rendered: dict[str, dict] = {}
    portraits: set[str] = set()

    for actor_key in sorted(actors):
        actor = actors[actor_key]
        frame_list = actor.get("frameList")
        sprite_sheet = actor.get("spriteSheet")
        if not frame_list or not sprite_sheet:
            raise ValueError(f"{actor_key}: missing frameList or spriteSheet")
        atlas = load_plist(frame_list).get("frames", {})
        sheet_path = APP / sprite_sheet
        if not sheet_path.is_file():
            raise FileNotFoundError(f"{actor_key}: missing sprite sheet {sheet_path}")
        names = referenced_frames(actor_key, actor, atlas)
        source_images: list[Image.Image] = []
        with Image.open(sheet_path).convert("RGBA") as sheet:
            for name in names:
                source_images.append(compose_frame(sheet, atlas[name]))
        cell_w = max(image.width for image in source_images)
        cell_h = max(image.height for image in source_images)
        frame_index = {name: index for index, name in enumerate(names)}
        rendered[actor_key] = {
            "file": f"{actor_key}.png",
            "cellWidth": cell_w,
            "cellHeight": cell_h,
            "frameCount": len(names),
        }
        if not check_only:
            strip = Image.new("RGBA", (cell_w * len(source_images), cell_h), (0, 0, 0, 0))
            for index, image in enumerate(source_images):
                strip.alpha_composite(image, (index * cell_w + (cell_w - image.width) // 2,
                                              (cell_h - image.height) // 2))
            OUT.mkdir(parents=True, exist_ok=True)
            strip.save(OUT / f"{actor_key}.png", optimize=True)

        animations = {}
        for name, animation in actor.get("frameAnimations", {}).items():
            animations[name] = {
                "frames": [frame_index[frame] for frame in animation.get("animationFrames", [])],
                "frameSeconds": float(animation.get("animationSpeed", 0.15)),
            }
        states = {
            state: [{"animation": row["name"], "probability": int(row.get("probability", 100))}
                    for row in choices]
            for state, choices in actor.get("stateAnimations", {}).items()
        }

        rows = market_rows(actor_key, actor)
        if not rows:
            raise ValueError(f"{actor_key}: no market entry")
        for market in rows:
            key = str(market.get("key") or market.get("unitKey") or actor_key)
            if key in seen_keys:
                raise ValueError(f"duplicate pet catalog key: {key}")
            seen_keys.add(key)
            color = market.get("color", [255, 255, 255])
            if len(color) != 3:
                raise ValueError(f"{key}: invalid color {color!r}")
            portrait_file = f"portraits/{key}.png"
            portraits.add(key)
            if not check_only:
                portrait = Image.new("RGBA", (cell_w, cell_h), (0, 0, 0, 0))
                first = source_images[0].copy()
                pixels = first.load()
                for py in range(first.height):
                    for px in range(first.width):
                        red, green, blue, alpha = pixels[px, py]
                        pixels[px, py] = (red * int(color[0]) // 255,
                                          green * int(color[1]) // 255,
                                          blue * int(color[2]) // 255, alpha)
                portrait.alpha_composite(first, ((cell_w - first.width) // 2, (cell_h - first.height) // 2))
                (OUT / "portraits").mkdir(parents=True, exist_ok=True)
                portrait.save(OUT / portrait_file, optimize=True)
            catalog.append({
                "key": key,
                "actorKey": actor_key,
                "name": str(market.get("name") or key),
                "cost": int(market.get("cost", 0)),
                "brains": bool(market.get("brainsNeeded", False)),
                "level": max(0, int(market.get("level", 0))),
                "hidden": bool(market.get("dontShowInMarket", False)),
                "description": str(market.get("flavorText") or ""),
                "color": [int(channel) for channel in color],
                "scale": float(actor.get("scale", 1)),
                "walkingSpeed": float(actor.get("walkingSpeed", 1.5)),
                "randomDelay": bool(actor.get("randomDelay", False)),
                "playerOffset": [int(actor.get("playerOffsetX", -20)),
                                 int(actor.get("playerOffsetY", 15))],
                "portrait": portrait_file,
                "sheet": rendered[actor_key],
                "animations": animations,
                "states": states,
            })

    catalog.sort(key=lambda pet: (pet["hidden"], pet["level"], pet["cost"], pet["name"], pet["key"]))
    result = {"version": int(source.get("Version", 0)), "pets": catalog}
    if not check_only:
        OUT.mkdir(parents=True, exist_ok=True)
        for old in OUT.glob("*.png"):
            if old.stem not in rendered:
                old.unlink()
        for old in (OUT / "portraits").glob("*.png"):
            if old.stem not in portraits:
                old.unlink()
        with (OUT / "catalog.json").open("w", encoding="utf-8") as handle:
            json.dump(result, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true", help="validate source without writing output")
    args = parser.parse_args()
    data = export(args.check)
    visible = sum(not pet["hidden"] for pet in data["pets"])
    action = "validated" if args.check else "exported"
    print(f"pets: {action} {len(data['pets'])} variants ({visible} visible)")
