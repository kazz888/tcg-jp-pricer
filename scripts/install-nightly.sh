#!/bin/bash
# Installs the nightly Yuyu-tei refresh as a macOS launchd agent.
#
# launchd rather than cron because it is what macOS actually supports, and
# because RunAtLoad + StartCalendarInterval means a run missed while the laptop
# was asleep fires shortly after it wakes, instead of being skipped until
# tomorrow. A laptop is not a server; missing nights is the normal case.
#
# Install:   bash scripts/install-nightly.sh
# Remove:    launchctl bootout gui/$UID/com.tcgjp.refresh
# Run now:   launchctl kickstart -k gui/$UID/com.tcgjp.refresh
# Logs:      tail -f ~/Library/Logs/tcg-jp-pricer.log

set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
LABEL="com.tcgjp.refresh"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/tcg-jp-pricer.log"

mkdir -p "$HOME/Library/LaunchAgents" "$(dirname "$LOG")"

# 01:00 local time. The original plan was 01:00 JST, but the point of that was
# to avoid scraping during Japanese trading hours from a shared IP; from one
# laptop making 12 requests it does not matter, and a time you are awake for is
# easier to debug.
cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$ROOT/scripts/refresh-local.sh</string>
  </array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>1</integer><key>Minute</key><integer>0</integer></dict>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
</dict>
</plist>
PLIST_EOF

launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID" "$PLIST"

echo "Installed $LABEL"
echo "  runs   : 01:00 daily (catches up after sleep)"
echo "  script : $ROOT/scripts/refresh-local.sh"
echo "  logs   : $LOG"
echo
echo "Test it now:  launchctl kickstart -k gui/$UID/$LABEL && tail -f $LOG"
