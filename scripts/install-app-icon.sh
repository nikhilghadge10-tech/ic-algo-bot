#!/bin/zsh
set -eu

PROJECT_DIR="/Users/nikhilghadge/MyProjects/ic-algo-bot"
SOURCE_IMAGE="/Users/nikhilghadge/Desktop/Bot images/desktop icon.png"
ICONSET_DIR="/private/tmp/ICAlgoBot.iconset"
ASSET_DIR="$PROJECT_DIR/assets"
ICNS_PATH="$ASSET_DIR/ICAlgoBot.icns"
APP_RESOURCES="$HOME/Desktop/IC Algo Bot.app/Contents/Resources"

/bin/rm -rf "$ICONSET_DIR"
/bin/mkdir -p "$ICONSET_DIR" "$ASSET_DIR" "$APP_RESOURCES"

for size in 16 32 128 256 512; do
  /usr/bin/sips -z "$size" "$size" "$SOURCE_IMAGE" --out "$ICONSET_DIR/icon_${size}x${size}.png" >/dev/null
  double_size=$((size * 2))
  /usr/bin/sips -z "$double_size" "$double_size" "$SOURCE_IMAGE" --out "$ICONSET_DIR/icon_${size}x${size}@2x.png" >/dev/null
done

/usr/bin/iconutil -c icns "$ICONSET_DIR" -o "$ICNS_PATH"
/bin/cp "$ICNS_PATH" "$APP_RESOURCES/ICAlgoBot.icns"
/usr/bin/touch "$HOME/Desktop/IC Algo Bot.app"
/bin/rm -rf "$ICONSET_DIR"

echo "Installed IC Algo Bot desktop icon"
