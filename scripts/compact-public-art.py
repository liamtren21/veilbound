"""Compact artwork inside a staging directory created by stage-public-api.mjs."""

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import sys

from PIL import Image

stage = Path(sys.argv[1]).resolve()
if not stage.name.startswith("veilbound-public-api-") or not (stage / "public" / "expedition.html").is_file():
    raise SystemExit("Expected a staged VEILBOUND game directory")
public = stage / "public"
assets = [file for file in (public / "combat-assets").rglob("*") if file.is_file()]
sources = [*public.glob("*.mjs"), *public.glob("*.css"), public / "expedition.html"]
references = "\n".join(file.read_text(encoding="utf-8") for file in sources)
hero_manifests = {f"{hero}-manifest.json" for hero in ("mara", "rook", "tess", "elian", "nera", "gideon")}
# These directories and filename families are addressed by IDs at runtime.
dynamic_directories = {"talismans-v3", "warden-avatars-v1", "enemy-intents-v1", "skill-icons-v7", "expedition-scenes-v2", "region-emblems-v2", "route-frames-v1", "account-v1"}
companion_sheets = {"brinewisp.png", "flintback.png", "chimewing.png", "waxwing.png", "cindermoth.png", "scriptfin.png"}
dynamic_prefixes = ("wood-", "boss-arena-", "dice-ink-")
selected = {
    file for file in assets
    if file.name in references or file.name in hero_manifests or file.name in companion_sheets
    or file.suffix in {".ttf", ".txt"}
    or file.relative_to(public / "combat-assets").parts[0] in dynamic_directories
    or file.name.startswith(dynamic_prefixes)
}
while True:
    manifests = "\n".join(file.read_text(encoding="utf-8") for file in selected if file.suffix == ".json")
    extra = {file for file in assets if file.name in manifests} - selected
    if not extra:
        break
    selected.update(extra)

def compact(file):
    if file not in selected:
        file.unlink()
    elif file.suffix == ".png":
        with Image.open(file) as image:
            image.save(file.with_suffix(".png.webp"), "WEBP", quality=82, method=4)
        file.unlink()

with ThreadPoolExecutor(max_workers=8) as pool:
    list(pool.map(compact, assets))
