#!/usr/bin/env bash
# Builds public/assets/tiles.png — the NULLRUN environment atlas.
#
# Source art: Kenney "Tiny Dungeon" (CC0). Each source tile is converted to
# luminance and re-mapped through a two-stop gradient so the whole facility
# shares one cyber palette instead of the pack's fantasy colours.
#
# Usage: tools/build-atlas.sh [path-to-kenney-tiles-dir]
set -euo pipefail

SRC="${1:-.tmp-assets/tiny-dungeon/Tiles}"
OUT_DIR="public/assets"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

if [ ! -d "$SRC" ]; then
  echo "error: source tiles not found at $SRC" >&2
  echo "download Kenney Tiny Dungeon (CC0) and pass its Tiles/ directory" >&2
  exit 1
fi

# name|source tile|dark stop|light stop
TILES=(
  "floor_a|tile_0048|#18232e|#33485c"
  "floor_b|tile_0049|#18232e|#364c60"
  "floor_c|tile_0051|#17222d|#314559"
  "floor_d|tile_0052|#18232e|#354a5e"
  "wall_a|tile_0014|#16222f|#54708a"
  "wall_b|tile_0040|#16222f|#4d6880"
  "wall_c|tile_0059|#16222f|#5a7891"
  "door_closed|tile_0046|#1a1408|#ffa63d"
  "door_open|tile_0033|#141c26|#6b8299"
  "cover_a|tile_0054|#111b23|#4b6b7d"
  "cover_b|tile_0055|#111b23|#527486"
  "cover_c|tile_0075|#111b23|#456273"
  "core|tile_0056|#07222c|#7df9ff"
  "terminal|tile_0065|#231705|#ffc24d"
  "vent|tile_0061|#0d151c|#54718a"
  "extraction|tile_0060|#08241a|#6dffa8"
  # characters: a hooded infiltrator and a helmeted guard, tinted per alert state
  "operative|tile_0112|#07222c|#7df9ff"
  "guard_patrol|tile_0096|#1e1405|#ffa63d"
  "guard_suspicious|tile_0096|#241c05|#ffd24d"
  "guard_hunting|tile_0096|#240810|#ff5470"
  "guard_stunned|tile_0096|#12181e|#6b8299"
)

mkdir -p "$OUT_DIR"
ORDER=()

for entry in "${TILES[@]}"; do
  IFS='|' read -r name src dark light <<< "$entry"
  in="$SRC/$src.png"
  [ -f "$in" ] || { echo "error: missing $in" >&2; exit 1; }

  # keep the original alpha, recolour only the RGB through the gradient ramp
  magick "$in" -alpha extract "$WORK/$name.a.png"
  magick "$in" -alpha off -colorspace Gray \
    \( -size 1x256 gradient:"$dark-$light" -rotate 90 \) -clut \
    "$WORK/$name.rgb.png"
  magick "$WORK/$name.rgb.png" "$WORK/$name.a.png" \
    -alpha off -compose CopyOpacity -composite "$WORK/$name.png"

  ORDER+=("$WORK/$name.png")
done

# 8 columns x 2 rows of 16px tiles, no padding — indices match TILE_ORDER in
# src/render/atlas.ts
montage "${ORDER[@]}" -tile 8x -geometry 16x16+0+0 -background none "$OUT_DIR/tiles.png"
magick "$OUT_DIR/tiles.png" -strip "$OUT_DIR/tiles.png"

echo "wrote $OUT_DIR/tiles.png ($(identify -format '%wx%h' "$OUT_DIR/tiles.png"), ${#TILES[@]} tiles)"
