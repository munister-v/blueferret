#!/usr/bin/env bash
# Deploy Blue Ferret admin to VPS
# Usage: ./deploy.sh
set -e

VPS="root@173.242.49.73"
REMOTE="/var/www/blueferret-admin"
KEY="$HOME/.ssh/blueferret_deploy"

echo "→ Deploying to $VPS:$REMOTE"
rsync -az --exclude='node_modules' --exclude='data' --exclude='.git' \
  -e "ssh -i $KEY -o StrictHostKeyChecking=no" \
  ./ "$VPS:$REMOTE/"

echo "→ Restarting pm2 process"
ssh -i "$KEY" -o StrictHostKeyChecking=no "$VPS" \
  "cd $REMOTE && npm install --production --silent && pm2 restart blueferret-admin"

echo "✓ Done"
