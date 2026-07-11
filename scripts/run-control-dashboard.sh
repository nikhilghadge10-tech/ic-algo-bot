#!/bin/zsh
set -eu

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
cd "/Users/nikhilghadge/MyProjects/ic-algo-bot"
exec /opt/homebrew/bin/node control/controlServer.js
