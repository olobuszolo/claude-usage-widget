#!/bin/bash
set -euo pipefail
LABEL="com.claudeusage.agent"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
echo "Agent removed."
