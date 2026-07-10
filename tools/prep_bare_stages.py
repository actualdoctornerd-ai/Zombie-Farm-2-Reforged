#!/usr/bin/env python3
"""Best-effort enemy actors for the three stage sheets that shipped WITHOUT a
frame/skeleton descriptor: NinjaStage, PirateStage, CityStage.

Unlike Farm/Alien/Robot (json rig) or Beach/Circus/Valentines/TreeWorld
(TexturePacker .plist), these three ship a bare PNG of loose paper-doll parts and
no metadata at all (confirmed absent from the whole app bundle). So we can't
faithfully assemble them. Instead we:

  1. Segment each sheet into connected-component parts (optionally eroding first to
     break thin bridges between touching parts), ordered deterministically.
  2. Hand-assemble each UnitStats actor from a few parts via a HUMANOID recipe
     (torso at the feet, head stacked on top, weapon in hand) with by-eye offsets.

The result is approximate but recognizable. Recipes reference parts by their index
in the deterministic segmentation, so re-running reproduces the same output.

Run from zombiefarm/:  python tools/prep_bare_stages.py
"""
import os
from collections import deque
from PIL import Image, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
EXTRACT = os.path.join(ROOT, "..", "ZF2R_extracted")
SHEETDIR = os.path.join(EXTRACT, "assets", "spritesheets", "stages")
OUT_DIR = os.path.join(ROOT, "public", "assets", "raids", "enemies")

ALPHA_T = 24
MIN_AREA = 120
# (sheet file, erosion radius to separate touching parts before labeling)
SHEETS = {
    "ninja": ("NinjaStage.png", 0),
    "pirate": ("PirateStage.png", 2),
    "city": ("CityStage.png", 2),
}

# Assembly recipes: actor -> layers drawn back->front. Each layer is
# (sheet, part_index, dx, dy): the part's BOTTOM-CENTER is placed at
# (CX+dx, FEET-dy). Offsets are hand-tuned by eye against a preview.
CW, CH, CX, FEET = 320, 400, 160, 380
RECIPES = {
    # Pirate: captain (orange-beard head + red torso) + two bandana crew.
    "PirateStageActorBoss":         [("pirate", 1, 0, 0), ("pirate", 7, 0, 65)],
    "PirateStageActorSwashbuckler": [("pirate", 8, 0, 0), ("pirate", 4, 0, 70)],
    "PirateStageActorScallywag":    [("pirate", 1, 0, 0), ("pirate", 4, 0, 65)],
    # Ninja: rabbit boss with a carrot sword + two rabbit minions.
    "NinjaStageActorBoss": [("ninja", 5, 0, 0), ("ninja", 0, 0, 60), ("ninja", 7, 30, 34)],
    "NinjaStageActorBoy":  [("ninja", 4, 0, 0), ("ninja", 6, 0, 52)],
    "NinjaStageActorGirl": [("ninja", 3, 0, 0), ("ninja", 1, 0, 50)],
    # Corporateville: three distinct office types.
    "CityStageActorLawyer":       [("city", 4, 0, 0), ("city", 0, 0, 58)],                     # white-shirt body + calm head
    "CityStageActorCrazedWorker": [("city", 6, 22, 30), ("city", 5, 0, 0), ("city", 1, 0, 60)],  # suspenders body + angry head + bat
    "CityStageActorBoss":         [("city", 7, 22, 26), ("city", 3, 0, 0), ("city", 2, 0, 54)],  # suit + gavel(hammer) + senior head
}


def segment(path, erode):
    """Deterministic connected-component parts of a sheet, as cropped RGBA images."""
    im = Image.open(path).convert("RGBA")
    w, h = im.size
    alpha = im.getchannel("A")
    if erode:
        alpha = alpha.filter(ImageFilter.MinFilter(erode * 2 + 1))
    a = alpha.tobytes()
    mask = bytearray(1 if a[i] > ALPHA_T else 0 for i in range(w * h))
    seen = bytearray(w * h)
    boxes = []
    for sy in range(h):
        for sx in range(w):
            i = sy * w + sx
            if seen[i] or not mask[i]:
                continue
            q = deque([i]); seen[i] = 1; px = []
            while q:
                j = q.popleft(); jy, jx = divmod(j, w); px.append((jx, jy))
                for dy in (-1, 0, 1):
                    for dx in (-1, 0, 1):
                        nx, ny = jx + dx, jy + dy
                        if 0 <= nx < w and 0 <= ny < h:
                            k = ny * w + nx
                            if not seen[k] and mask[k]:
                                seen[k] = 1; q.append(k)
            if len(px) < MIN_AREA:
                continue
            xs = [p[0] for p in px]; ys = [p[1] for p in px]
            boxes.append((max(0, min(xs) - erode), max(0, min(ys) - erode),
                          min(w, max(xs) + 1 + erode), min(h, max(ys) + 1 + erode)))
    boxes.sort(key=lambda b: (b[1] // 24, b[0]))  # reading order -> stable indices
    return [im.crop(b) for b in boxes]


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    parts = {name: segment(os.path.join(SHEETDIR, f), er) for name, (f, er) in SHEETS.items()}
    for key, layers in RECIPES.items():
        canvas = Image.new("RGBA", (CW, CH), (0, 0, 0, 0))
        for sheet, idx, dx, dy in layers:
            p = parts[sheet][idx]
            canvas.alpha_composite(p, (int(CX + dx - p.width // 2), int(FEET - dy - p.height)))
        box = canvas.getbbox()
        out = canvas.crop(box) if box else canvas
        out.save(os.path.join(OUT_DIR, f"{key}.png"))
        print(f"{key}: {out.width}x{out.height}")


if __name__ == "__main__":
    main()
