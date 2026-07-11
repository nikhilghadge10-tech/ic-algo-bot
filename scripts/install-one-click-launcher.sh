#!/bin/zsh
set -eu

PROJECT_DIR="/Users/nikhilghadge/MyProjects/ic-algo-bot"
APP_DIR="$HOME/Desktop/IC Algo Bot.app"
CONTENTS_DIR="$APP_DIR/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"
RESOURCES_DIR="$CONTENTS_DIR/Resources"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
OLD_PLIST_PATH="$LAUNCH_AGENTS_DIR/com.nikhil.ic-algo-bot.plist"
CONTROL_PLIST_PATH="$LAUNCH_AGENTS_DIR/com.nikhil.ic-algo-bot.control.plist"
STARTUP_PLIST_PATH="$LAUNCH_AGENTS_DIR/com.nikhil.ic-algo-bot.startup.plist"

/bin/mkdir -p "$MACOS_DIR" "$RESOURCES_DIR" "$LAUNCH_AGENTS_DIR"
/bin/chmod +x "$PROJECT_DIR/scripts/launch-ic-algo-bot.sh"
/bin/chmod +x "$PROJECT_DIR/scripts/run-control-dashboard.sh"
/bin/cp "$PROJECT_DIR/scripts/launch-ic-algo-bot.sh" "$MACOS_DIR/IC Algo Bot"
/bin/chmod +x "$MACOS_DIR/IC Algo Bot"
if [[ -f "$PROJECT_DIR/assets/ICAlgoBot.icns" ]]; then
  /bin/cp "$PROJECT_DIR/assets/ICAlgoBot.icns" "$RESOURCES_DIR/ICAlgoBot.icns"
fi

/usr/bin/tee "$CONTENTS_DIR/Info.plist" >/dev/null <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>IC Algo Bot</string>
  <key>CFBundleDisplayName</key><string>IC Algo Bot</string>
  <key>CFBundleIdentifier</key><string>com.nikhil.ic-algo-bot</string>
  <key>CFBundleVersion</key><string>1.1</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>IC Algo Bot</string>
  <key>CFBundleIconFile</key><string>ICAlgoBot.icns</string>
</dict></plist>
PLIST

/usr/bin/tee "$CONTROL_PLIST_PATH" >/dev/null <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.nikhil.ic-algo-bot.control</string>
  <key>ProgramArguments</key><array>
    <string>$PROJECT_DIR/scripts/run-control-dashboard.sh</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>EnvironmentVariables</key><dict>
    <key>IC_AUTO_MANAGE</key><string>true</string>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>StandardOutPath</key><string>$PROJECT_DIR/logs/launch-agent.log</string>
  <key>StandardErrorPath</key><string>$PROJECT_DIR/logs/launch-agent-error.log</string>
</dict></plist>
PLIST

/usr/bin/tee "$STARTUP_PLIST_PATH" >/dev/null <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.nikhil.ic-algo-bot.startup</string>
  <key>ProgramArguments</key><array>
    <string>$PROJECT_DIR/scripts/launch-ic-algo-bot.sh</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$PROJECT_DIR/logs/startup-agent.log</string>
  <key>StandardErrorPath</key><string>$PROJECT_DIR/logs/startup-agent-error.log</string>
</dict></plist>
PLIST

USER_DOMAIN="gui/$(/usr/bin/id -u)"
/bin/launchctl bootout "$USER_DOMAIN" "$OLD_PLIST_PATH" 2>/dev/null || true
/bin/launchctl bootout "$USER_DOMAIN" "$CONTROL_PLIST_PATH" 2>/dev/null || true
/bin/launchctl bootout "$USER_DOMAIN" "$STARTUP_PLIST_PATH" 2>/dev/null || true
/bin/rm -f "$OLD_PLIST_PATH"
/bin/launchctl bootstrap "$USER_DOMAIN" "$CONTROL_PLIST_PATH"
/bin/launchctl bootstrap "$USER_DOMAIN" "$STARTUP_PLIST_PATH"

echo "Installed $APP_DIR"
echo "Enabled automatic startup at login"
