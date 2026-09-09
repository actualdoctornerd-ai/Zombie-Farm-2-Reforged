"""Stamp a frame table with a digest of the sheet it was cut from.

A sprite atlas is two files that only make sense together — the PNG and the JSON that
says which rectangle of it each part occupies — and the service worker caches them
under different rules: the JSON is NetworkFirst (always current), the PNG CacheFirst on
its stable filename for sixty days. So an install that has ever loaded the sheet reads
every NEWER frame table through its OLD pixels: parts packed since then come out
transparent (a floating default head) or, on a row the old sheet did not have, not at
all. That is how the Cozmonaut, the Zombozo and the Boss Zombie shipped.

The runtime (src/atlasVersion.ts) appends this stamp's digest to the sheet URL, so the
URL — and with it the cache entry — changes exactly when the sheet's bytes do. Every
packer that writes a sheet + frame table pair must call `stamp_frames` before dumping
the table; src/atlasVersion.test.ts fails the build if a committed stamp no longer
matches its committed PNG.
"""
import hashlib
import os

from PIL import Image

#: The reserved key the table carries the stamp under. Part names are never `$`-prefixed.
SHEET_STAMP_KEY = "$sheet"
#: Leading hex digits of the SHA-1 kept in the stamp — enough to tell versions apart.
DIGEST_CHARS = 12


def sheet_digest(png_path):
    """Leading hex of the SHA-1 of the PNG's bytes on disk (what the browser downloads)."""
    with open(png_path, "rb") as fh:
        return hashlib.sha1(fh.read()).hexdigest()[:DIGEST_CHARS]


def stamp_frames(frames, png_path):
    """Add (or refresh) the `$sheet` entry of `frames` for the sheet at `png_path`.

    Call AFTER the sheet has been saved, so the digest describes the bytes that ship.
    Returns `frames` for chaining."""
    with Image.open(png_path) as im:
        w, h = im.size
    frames[SHEET_STAMP_KEY] = {
        "file": os.path.basename(png_path),
        "w": w,
        "h": h,
        "sha1": sheet_digest(png_path),
    }
    return frames


def frame_items(frames):
    """`frames.items()` without the stamp — for code that walks the part rectangles."""
    return [(k, v) for k, v in frames.items() if not k.startswith("$")]
