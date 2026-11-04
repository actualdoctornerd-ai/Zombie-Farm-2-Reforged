#!/usr/bin/env python3
"""Extract ONLY the main game's string tables. Requires the user's local IPA.

The checked-in tables let contributors build without distributing the IPA.
Use --check to verify provenance/reproducibility without changing any files.
"""
import argparse
import hashlib
import json
from pathlib import Path
import plistlib
import zipfile

LANGUAGES = {
    "English": "en", "de": "de", "es": "es", "fr": "fr", "it": "it",
    "ja": "ja", "ko": "ko", "nl": "nl", "zh-Hans": "zh-CN",
}
ROOT = Path(__file__).resolve().parent.parent


def extract(ipa):
    tables = {}
    with zipfile.ZipFile(ipa) as bundle:
        candidates = [name.removesuffix("English.lproj/Localizable.strings")
                      for name in bundle.namelist()
                      if name.startswith("Payload/")
                      and name.endswith(".app/English.lproj/Localizable.strings")]
        if len(candidates) != 1:
            raise ValueError("Expected exactly one main app's English string table")
        app = candidates[0]
        for directory, language in LANGUAGES.items():
            data = plistlib.loads(bundle.read(f"{app}{directory}.lproj/Localizable.strings"))
            if not isinstance(data, dict) or any(not isinstance(k, str) or not isinstance(v, str)
                                                 for k, v in data.items()):
                raise ValueError(f"Invalid string table: {directory}")
            tables[language] = data
        aliases = []
        for directory in ("zh", "zh-Hant"):
            data = plistlib.loads(bundle.read(f"{app}{directory}.lproj/Localizable.strings"))
            if data != tables["zh-CN"]:
                raise ValueError(f"{directory} differs; review language aliases before importing")
            aliases.append(directory)
    metadata = {
        "artifact": Path(ipa).name,
        "sha256": hashlib.sha256(Path(ipa).read_bytes()).hexdigest(),
        "app": app.rstrip("/"),
        "table": "<language>.lproj/Localizable.strings (binary plist)",
        "entries": {language: len(data) for language, data in tables.items()},
        "identicalChineseTables": ["zh-Hans", *aliases],
        "copyright": "Original game translations belong to their respective owners; excluded from the code's MIT license.",
    }
    return tables, metadata


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("ipa", type=Path)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    tables, metadata = extract(args.ipa)
    files = {ROOT / "src/i18n/locales" / f"{language}.json": data
             for language, data in tables.items()}
    files[ROOT / "src/i18n/source.json"] = metadata
    for filename, data in files.items():
        serialized = json.dumps(data, ensure_ascii=False, sort_keys=True, indent=2) + "\n"
        if args.check:
            if not filename.exists() or filename.read_text(encoding="utf-8") != serialized:
                raise SystemExit(f"Not reproducible: {filename.relative_to(ROOT)}")
        else:
            filename.parent.mkdir(parents=True, exist_ok=True)
            filename.write_text(serialized, encoding="utf-8")
    print(f"{'Verified' if args.check else 'Extracted'} {len(tables)} game language tables; SDK resources excluded.")


if __name__ == "__main__":
    main()
