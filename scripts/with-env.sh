#!/usr/bin/env bash
# Run a command with .env.dev (or .env) loaded. usage: scripts/with-env.sh forge test
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$HOME/.foundry/bin:$PATH"
for f in "$ROOT/.env.dev" "$ROOT/.env"; do
  if [ -f "$f" ]; then set -a; # shellcheck disable=SC1090
    source "$f"; set +a; break; fi
done
exec "$@"
