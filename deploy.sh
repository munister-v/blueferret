#!/usr/bin/env bash
# Deploy the Blue Ferret ADMIN CODE (server.js, src/, public/, ...) to the VPS.
# Usage: ./deploy.sh
#
# The live site (/var/www/blueferret, mirrored here as site/) is NOT touched:
# its catalog chunk and project pages are rewritten by the admin server
# (raised/goal/status synced from preorders), so pushing a local copy over it
# reverts the client's numbers. Site files go out with ./deploy-site.sh, and
# ./pull-site.sh refreshes the local mirror from the server.
set -euo pipefail
cd "$(dirname "$0")"

VPS="root@173.242.49.73"
REMOTE="/var/www/blueferret-admin"
KEY="$HOME/.ssh/blueferret_deploy"
SSH="ssh -i $KEY -o StrictHostKeyChecking=no"
SHA_FILE=".deployed-server.sha"

# Refuse to overwrite a server.js that changed on the server since our last deploy.
remote_sha=$($SSH "$VPS" "sha256sum $REMOTE/server.js | cut -d' ' -f1")
local_sha=$(shasum -a 256 server.js | cut -d' ' -f1)
last_sha=$(cat "$SHA_FILE" 2>/dev/null || true)
if [ "$remote_sha" != "$local_sha" ] && [ "$remote_sha" != "$last_sha" ] && [ "${FORCE:-}" != "1" ]; then
  echo "✗ server.js on the VPS differs from what was last deployed from here."
  echo "  Pull it first (scp $VPS:$REMOTE/server.js /tmp/server.live.js; diff server.js /tmp/server.live.js)"
  echo "  or re-run with FORCE=1 if you are sure."
  exit 1
fi

echo "→ Deploying admin code to $VPS:$REMOTE (site/ is excluded)"
rsync -az \
  --exclude='/site/' --exclude='node_modules' --exclude='/data/' --exclude='/backups/' \
  --exclude='.git' --exclude='.DS_Store' --exclude='*.bak*' --exclude='/scratch*' --exclude='/.deployed-server.sha' \
  -e "$SSH" ./ "$VPS:$REMOTE/"

echo "→ Restarting pm2 process"
$SSH "$VPS" "cd $REMOTE && npm install --production --silent && pm2 restart blueferret-admin"
echo "$local_sha" > "$SHA_FILE"
echo "✓ Done"
