#!/usr/bin/env bash
# Refresh the local site/ mirror from the live site. The server is the source of truth.
# Usage: ./pull-site.sh
set -euo pipefail
cd "$(dirname "$0")"
rsync -az --itemize-changes --exclude='*.bak*' \
  -e "ssh -i $HOME/.ssh/blueferret_deploy -o StrictHostKeyChecking=no" \
  root@173.242.49.73:/var/www/blueferret/ site/ | grep -v '^\.d' || true
echo "✓ site/ now mirrors the live site"
