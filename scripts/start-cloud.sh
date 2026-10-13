#!/usr/bin/env bash
set -euo pipefail
cd /workspace/automanager
bash scripts/setup-cloud-ui.sh --start
export DISPLAY=:99
export AUTOMANAGER_DATA_DIR=/workspace/.cache/automanager-data
export XDG_CONFIG_HOME=/workspace/.cache/automanager-config
export XDG_CACHE_HOME=/workspace/.cache/automanager-browser
export NODE_USE_ENV_PROXY=1
if [[ ! -f out/main/index.js ]]; then npm run build; fi
# The isolated cloud runner cannot provide the Chrome setuid/user-namespace sandbox.
# This runner flag does not change the sandboxed preload configuration in the app.
exec node_modules/electron/dist/electron --no-sandbox --disable-gpu .
