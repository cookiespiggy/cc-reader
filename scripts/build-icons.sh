#!/usr/bin/env bash
# 从手写的 src-tauri/icons/icon.svg 生成全套 app 图标。
# 不用 python、不用脚本生成设计: 只调 rsvg-convert / bunx tauri icon / iconutil。
# - 标准尺寸: rsvg-convert -> 1024 PNG -> bunx tauri icon
# - tauri icon 会顺带生成 android/ ios/ 目录, 桌面 app 用不到, 删掉
# - 16/32px 用手写的 icon-small.svg (线更粗), 替换 icns 里的小尺寸条目
#   和 32x32.png; 大尺寸保持 icon.svg 的细线稿
set -euo pipefail
cd "$(dirname "$0")/.."

ICONS=src-tauri/icons
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

rsvg-convert -w 1024 -h 1024 "$ICONS/icon.svg" -o "$ICONS/icon-1024.png"
bunx tauri icon "$ICONS/icon-1024.png" >/dev/null 2>&1
rm -rf "$ICONS/android" "$ICONS/ios"

iconutil -c iconset "$ICONS/icon.icns" -o "$TMP/cc.iconset"
while read -r px name; do
  rsvg-convert -w "$px" -h "$px" "$ICONS/icon-small.svg" \
    -o "$TMP/cc.iconset/icon_${name}.png"
done <<'SIZES'
16 16x16
32 16x16@2x
32 32x32
64 32x32@2x
SIZES
iconutil -c icns "$TMP/cc.iconset" -o "$ICONS/icon.icns"
rsvg-convert -w 32 -h 32 "$ICONS/icon-small.svg" -o "$ICONS/32x32.png"

echo "icons rebuilt (hand-written SVG, no python)"
