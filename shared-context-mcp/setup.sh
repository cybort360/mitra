#!/usr/bin/env bash
# Onboard a new participant to the shared context server.
#
#   ./shared-context-mcp/setup.sh <your-name>
#
# Clones nothing and assumes you already have the repo. It builds the server,
# registers you, and pulls the team's existing context so you start informed
# rather than empty.
set -euo pipefail

NAME="${1:-}"
if [[ -z "$NAME" ]]; then
  echo "usage: $0 <your-name>   (e.g. sam, or agent:cline)" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG="$ROOT/shared-context-mcp"
DB="$ROOT/.shared-context/context.db"
SYNC="$ROOT/shared-context/sync"

command -v node >/dev/null || { echo "node is required (>=22.5.0, for the built-in node:sqlite)" >&2; exit 1; }
# Fail early with a clear message rather than a cryptic module error.
node -e 'require("node:sqlite")' 2>/dev/null || {
  echo "node $(node --version) is too old: node:sqlite requires >=22.5.0" >&2
  exit 1
}

echo "==> building shared-context-mcp"
cd "$PKG"
npm install --silent
npm run build --silent

mkdir -p "$(dirname "$DB")" "$SYNC"

export SHARED_CONTEXT_NODE_ID="$NAME"
export SHARED_CONTEXT_DB="$DB"
export SHARED_CONTEXT_SYNC_DIR="$SYNC"

echo "==> joining as $NAME"
node dist/cli.js init --db "$DB" --sync-dir "$SYNC"

echo
cat <<EOF
Ready. Add this to your MCP client config:

{
  "mcpServers": {
    "shared-context": {
      "command": "node",
      "args": ["$PKG/dist/main.js"],
      "env": {
        "SHARED_CONTEXT_DB": "$DB",
        "SHARED_CONTEXT_SYNC_DIR": "$SYNC",
        "SHARED_CONTEXT_NODE_ID": "$NAME"
      }
    }
  }
}

Daily loop:
  node $PKG/dist/cli.js sync --db $DB     # pick up teammates' context
  git add shared-context/sync && git commit -m "ctx: ..." && git push
EOF
