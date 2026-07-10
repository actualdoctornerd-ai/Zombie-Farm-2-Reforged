"""Extract the authentic zombie-detail UI art (stat icons, value box, ability
frame, and ability icons) used by hud.openZombieInfo.

Sources (iOS 1.0 bundle):
  - ZombieMausoleumMutation.png/.json atlas -> stat glyphs on their purple tile,
    the stat value box (3-slice), the ability tile frame, and the "?" placeholder.
  - loose ability_*.png -> the real combat-ability icons.

Outputs to zombiefarm/public/assets/ui/zdetail/ and .../ui/ability/.
Run from the repo root (folder containing ZF2R_extracted/ and zombiefarm/).
"""
import json
import os
import glob
import shutil
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
APP = os.path.join(ROOT, "ZF2R_extracted", "raw", "ios-1.0", "1.0", "Payload", "ZF2R.app")
SHEETS = os.path.join(ROOT, "ZF2R_extracted", "data", "json", "sprites")
OUT = os.path.join(ROOT, "zombiefarm", "public", "assets", "ui", "zdetail")
OUT_ABIL = os.path.join(ROOT, "zombiefarm", "public", "assets", "ui", "ability")

# atlas frame -> output filename (stat glyphs, value box parts, ability frame, ?)
FRAMES = {
    "stats_bg.png": "stat_tile.png",
    "stats_damage.png": "stat_damage.png",   # fist
    "stats_speed.png": "stat_speed.png",     # wing
    "stats_life.png": "stat_life.png",       # heart
    "stats_focus.png": "stat_focus.png",     # crosshair
    "zombie_box_fill.png": "value_fill.png",
    "zombie_box_end.png": "value_end.png",
    "zombies_frame.png": "ability_frame.png",
    "zombies_abilities.png": "ability_unknown.png",  # the "?" placeholder
}


def rect(s):
    nums = [int(float(x)) for x in s.replace("{", "").replace("}", "").split(",")]
    return nums  # x, y, w, h


def main():
    os.makedirs(OUT, exist_ok=True)
    os.makedirs(OUT_ABIL, exist_ok=True)

    atlas = Image.open(os.path.join(APP, "ZombieMausoleumMutation.png")).convert("RGBA")
    frames = json.load(open(os.path.join(SHEETS, "ZombieMausoleumMutation.json")))
    frames = frames.get("frames", frames)
    for name, out in FRAMES.items():
        x, y, w, h = rect(frames[name]["textureRect"])
        atlas.crop((x, y, x + w, y + h)).save(os.path.join(OUT, out))
    print(f"zdetail: {len(FRAMES)} parts -> {OUT}")

    # Copy every ability icon (small; only a few are referenced but keep them all).
    n = 0
    for f in glob.glob(os.path.join(APP, "ability_*.png")):
        shutil.copy(f, os.path.join(OUT_ABIL, os.path.basename(f)))
        n += 1
    print(f"abilities: {n} icons -> {OUT_ABIL}")
    print("done")


if __name__ == "__main__":
    main()
