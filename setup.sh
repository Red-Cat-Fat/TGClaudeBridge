#!/usr/bin/env sh
# TGClaudeBridge setup for macOS / Linux: asks for the bot token, chat id and idle time, saves them, installs the plugin.
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 18+ is required: https://nodejs.org"
  exit 1
fi
exec node "$(dirname "$0")/setup.js" "$@"
