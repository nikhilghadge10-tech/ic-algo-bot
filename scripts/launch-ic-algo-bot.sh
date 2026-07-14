#!/bin/zsh
set -u

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

PROJECT_DIR="/Users/nikhilghadge/MyProjects/ic-algo-bot"
DASHBOARD_URL="http://localhost:4000"
LOG_DIR="$PROJECT_DIR/logs"
CONTROL_LOG="$LOG_DIR/control-launcher.log"

mkdir -p "$LOG_DIR"
cd "$PROJECT_DIR" || exit 1

if ! /usr/bin/curl -fsS "$DASHBOARD_URL/api/config" >/dev/null 2>&1; then
  # Detach fully so macOS does not terminate the dashboard when this launcher
  # app finishes. The bot still starts only when the Desktop app is clicked.
  /usr/bin/nohup /opt/homebrew/bin/node control/controlServer.js \
    </dev/null >>"$CONTROL_LOG" 2>&1 &!
fi

dashboard_ready=false
for _ in {1..30}; do
  if /usr/bin/curl -fsS "$DASHBOARD_URL/api/config" >/dev/null 2>&1; then
    dashboard_ready=true
    break
  fi
  /bin/sleep 1
done

if [[ "$dashboard_ready" != "true" ]]; then
  /usr/bin/osascript -e 'display alert "IC Algo Bot could not start" message "Please contact Nikhil. The control dashboard did not become ready." as critical'
  exit 1
fi

/usr/bin/curl -fsS -X POST "$DASHBOARD_URL/api/start-all" >>"$CONTROL_LOG" 2>&1 || true
/usr/bin/open -a "Google Chrome" "$DASHBOARD_URL"

# Give services time to initialize, then log a single consolidated readiness result.
for _ in {1..25}; do
  if /usr/bin/curl -fsS "$DASHBOARD_URL/api/readiness" >>"$CONTROL_LOG" 2>&1; then
    exit 0
  fi
  /bin/sleep 1
done

/usr/bin/osascript -e 'display notification "Open the dashboard and check the red or amber status. The Dhan token may need renewal." with title "IC Algo Bot needs attention"'
exit 0
