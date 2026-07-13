#!/usr/bin/env python3
"""Inline the current sprite atlases + rigs into a standalone
sprite_assembler.html so the editor works by double-clicking (no server).

Bundles TWO datasets:
  • enemy  — raids/enemies/models.json + each model's own parts/<key>.png strip
  • zombie — zombie/models.json + shared ZombieSheet.png atlas + frames.json

Re-run after art/rig changes so the tool opens fresh (or hot-load newer files at
runtime via the in-tool Load buttons).

Usage:  python tools/build_sprite_assembler.py
"""
import base64
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
ASSETS = ROOT / "public" / "assets"
TEMPLATE = ROOT / "tools" / "sprite_assembler.template.html"
OUT = ROOT / "tools" / "sprite_assembler.html"


def data_uri(path: pathlib.Path) -> str:
    return "data:image/png;base64," + base64.b64encode(path.read_bytes()).decode("ascii")


def load_json(path: pathlib.Path):
    return json.loads(path.read_text(encoding="utf-8"))


def build_enemy() -> dict:
    edir = ASSETS / "raids" / "enemies"
    models = load_json(edir / "models.json")
    strips = {}
    missing = []
    for key in models:
        png = edir / "parts" / f"{key}.png"
        if png.exists():
            strips[key] = data_uri(png)
        else:
            missing.append(key)
    if missing:
        print(f"  ⚠ enemy strips missing for: {', '.join(missing)}")
    return {"kind": "enemy", "label": "Enemies", "models": models, "strips": strips}


def build_zombie() -> dict:
    zdir = ASSETS / "zombie"
    return {
        "kind": "zombie",
        "label": "Zombies",
        "models": load_json(zdir / "models.json"),
        "frames": load_json(zdir / "frames.json"),
        "atlas": data_uri(zdir / "ZombieSheet.png"),
    }


def main() -> None:
    boot = {"datasets": {"enemy": build_enemy(), "zombie": build_zombie()}, "default": "enemy"}
    html = TEMPLATE.read_text(encoding="utf-8")
    html = html.replace("__BOOT_JSON__", json.dumps(boot, separators=(",", ":")))
    OUT.write_text(html, encoding="utf-8")

    kb = OUT.stat().st_size / 1024
    en = boot["datasets"]["enemy"]
    zo = boot["datasets"]["zombie"]
    print(f"Wrote {OUT.relative_to(ROOT)}  ({kb:.0f} KB)")
    print(f"  enemy:  {len(en['models'])} models, {len(en['strips'])} strips")
    print(f"  zombie: {len(zo['models'])} models, {len(zo['frames'])} frames")


if __name__ == "__main__":
    main()
