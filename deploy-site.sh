#!/usr/bin/env bash
# Push specific site files to the live site.
# Usage: ./deploy-site.sh path/under/site [more paths ...]   e.g. ./deploy-site.sh bf.js bf-pay.js
#
# Paths are relative to site/. Files are copied one by one (never a blanket sync) and the
# remote copy is backed up first. Files the admin server owns are refused: the KIK catalog
# chunk, kik/proekty/, igry/ (games pages), uploads/ and sitemap.xml. Change those in the admin, not here.
set -euo pipefail
cd "$(dirname "$0")"
[ $# -gt 0 ] || { echo "usage: $0 <path under site/> ..."; exit 2; }

VPS="root@173.242.49.73"; REMOTE="/var/www/blueferret"
SSH="ssh -i $HOME/.ssh/blueferret_deploy -o StrictHostKeyChecking=no"
stamp=$(date +%Y%m%d%H%M%S)

for p in "$@"; do
  p="${p#site/}"; p="${p#/}"
  case "$p" in
    *..*) echo "✗ bad path: $p"; exit 1;;
    kik/proekty/*|_next/static/chunks/app/kik/proekty/*|igry/*|_next/static/chunks/app/igry/*|uploads/*|sitemap.xml)
      echo "✗ $p is managed by the admin server (catalog numbers live there); edit it in the admin"; exit 1;;
  esac
  [ -f "site/$p" ] || { echo "✗ no such file: site/$p"; exit 1; }
done

for p in "$@"; do
  p="${p#site/}"; p="${p#/}"
  $SSH "$VPS" "[ -f '$REMOTE/$p' ] && cp -p '$REMOTE/$p' '$REMOTE/$p.bak-$stamp' || true"
  rsync -az -e "$SSH" "site/$p" "$VPS:$REMOTE/$p"
  $SSH "$VPS" "restorecon '$REMOTE/$p' 2>/dev/null || true"
  echo "✓ $p"
done
