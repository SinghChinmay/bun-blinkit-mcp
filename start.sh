#!/bin/bash

# CRITICAL: This script's stdout is the MCP JSON-RPC protocol channel.
# ALL non-JSON output MUST go to stderr. We redirect fd1 to fd2 for the
# entire setup phase, then restore it only for the final exec.
exec 3>&1          # save original stdout (MCP protocol channel) to fd3
exec 1>&2          # redirect ALL stdout to stderr for setup phase

# Add common install locations for bun to PATH
export PATH="$HOME/.bun/bin:$PATH"

# Ensure we are in the script's directory
cd "$(dirname "$0")" || exit 1

if ! command -v bun >/dev/null 2>&1; then
    echo "bun not found. Installing..."
    curl -fsSL https://bun.sh/install | bash
    export PATH="$HOME/.bun/bin:$PATH"
else
    echo "bun found at: $(command -v bun)"
fi

# Install dependencies from the lockfile (no browser binaries needed: the
# server is API-only and never launches Playwright).
echo "Syncing dependencies..."
bun install --frozen-lockfile

# Restore stdout to the MCP protocol channel and launch the server
echo "Starting Blinkit MCP..."
exec 1>&3 3>&-     # restore fd1 from fd3, close fd3
exec bun run main.ts
