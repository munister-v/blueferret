#!/usr/bin/env bash
# Roll the monobank work out to the VPS in three independent, reversible parts.
# Without --apply nothing is changed on the server (rsync runs with -n).
#
#   scripts/deploy-mono.sh --server                 admin code (payments stay OFF until MONO_API_TOKEN is set)
#   scripts/deploy-mono.sh --site                   legal pages + payment UI + footer links
#   scripts/deploy-mono.sh --remove-donation        take "Підтримка без нагороди" off the support pages (after --server)
#   scripts/deploy-mono.sh --enable-payments        flip the support-page bundle on (do this last)
#   add --apply to really do it
#   --site --allow-draft  publish legal pages that still hold [PLACEHOLDERS] (draft banner + noindex)
#
# Order that is safe: --server, fill the placeholders in docs/legal/*.md, --site,
# set MONO_API_TOKEN (see docs/mono-acquiring.md), restart, --enable-payments.
set -euo pipefail

VPS="root@173.242.49.73"
ADMIN="/var/www/blueferret-admin"
SITE="/var/www/blueferret"
KEY="${BF_KEY:-$HOME/.ssh/blueferret_deploy}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
SSH="ssh -i $KEY -o BatchMode=yes -o ConnectTimeout=10"
# -rlt, not -a: never copy owner/permissions of the local temp dir onto the web root (that once made it 700 -> 403)
RS="rsync -rltz -e \"$SSH\""

DO_SERVER=0; DO_SITE=0; DO_PAY=0; DO_DON=0; APPLY=0; STRICT="--strict"
for a in "$@"; do case "$a" in
  --server) DO_SERVER=1;; --site) DO_SITE=1;; --enable-payments) DO_PAY=1;; --remove-donation) DO_DON=1;; --apply) APPLY=1;; --allow-draft) STRICT="";;
  *) echo "unknown option $a"; exit 2;; esac; done
[ $((DO_SERVER+DO_SITE+DO_PAY+DO_DON)) -gt 0 ] || { sed -n 2,14p "$0"; exit 2; }
DRY=""; [ $APPLY = 1 ] || DRY="-n"
TS="$(date +%Y%m%d%H%M%S)"
BAK="/root/bf-backups/mono-$TS"  # outside the web root on purpose
say() { printf '\n== %s\n' "$*"; }
remote() { $SSH "$VPS" "$@"; }
[ $APPLY = 1 ] && echo "APPLYING to $VPS" || echo "DRY RUN (add --apply to change the server)"

if [ $DO_SERVER = 1 ]; then
  say "admin code -> $ADMIN"
  (cd "$HERE" && node --test tests/ >/dev/null) || { echo "tests fail, stopping"; exit 1; }
  if [ $APPLY = 1 ]; then
    remote "mkdir -p $BAK/admin && cd $ADMIN && cp -a server.js src package.json package-lock.json $BAK/admin/"
    echo "backup: $BAK/admin"
  fi
  eval $RS $DRY --itemize-changes "$HERE/server.js" "$HERE/package.json" "$HERE/package-lock.json" "$VPS:$ADMIN/"
  eval $RS $DRY --itemize-changes "$HERE/src/" "$VPS:$ADMIN/src/"
  if [ $APPLY = 1 ]; then
    remote "cd $ADMIN && node --check server.js && npm install --omit=dev --silent && pm2 restart blueferret-admin --update-env"
    sleep 3
    echo -n "status: "; remote "curl -s -m 5 http://127.0.0.1:4100/api/mono/status"; echo
    echo "rollback: ssh ... 'cp -a $BAK/admin/* $ADMIN/ && pm2 restart blueferret-admin'"
  fi
fi

if [ $DO_SITE = 1 ]; then
  say "site -> $SITE"
  STAGE="$(mktemp -d)"
  # the live site is the source of truth for stylesheet links
  scp -q -i "$KEY" -o BatchMode=yes "$VPS:$SITE/kontakty/index.html" "$STAGE/kontakty.html"
  mkdir -p "$STAGE/kontakty" && mv "$STAGE/kontakty.html" "$STAGE/kontakty/index.html"
  node "$HERE/scripts/build-legal.js" --out "$STAGE" $STRICT \
    || { echo "Fill the [PLACEHOLDERS] in docs/legal/*.md first (the footer links to these pages)."; exit 1; }
  rm -rf "$STAGE/kontakty"
  cp "$HERE/site/bf.js" "$HERE/site/bf-pay.js" "$STAGE/"
  # nginx lets browsers keep JS for a day: version bf-pay.js by its content so a change really reaches them
  PAYV="$(shasum "$HERE/site/bf-pay.js" | cut -c1-8)"
  perl -pi -e "s#/bf-pay\.js\?v=[0-9a-f]+#/bf-pay.js?v=$PAYV#g" "$STAGE/bf.js"
  grep -q "bf-pay.js?v=$PAYV" "$STAGE/bf.js" || { echo "could not version bf-pay.js in bf.js"; exit 1; }
  if [ $APPLY = 1 ]; then
    remote "mkdir -p $BAK/site && cd $SITE && cp -a bf.js $BAK/site/ && { [ ! -f bf-pay.js ] || cp -a bf-pay.js $BAK/site/; }"
    echo "backup: $BAK/site"
  fi
  eval $RS $DRY --itemize-changes "$STAGE/" "$VPS:$SITE/"
  if [ $APPLY = 1 ]; then
    remote "cd $SITE && restorecon -R $SITE 2>/dev/null; true"
    # bump the cache-busting version of bf.js in every page (copy the script over first)
    scp -q -i "$KEY" -o BatchMode=yes "$HERE/scripts/bump-asset.js" "$VPS:/tmp/bump-asset.js"
    remote "node /tmp/bump-asset.js --root $SITE --asset bf.js --apply && rm /tmp/bump-asset.js && restorecon -R $SITE 2>/dev/null; true"
    echo "rollback: copy $BAK/site/bf.js back, remove oferta/ povernennia/ konfidentsiinist/ bf-pay.js, then re-bump: node scripts/bump-asset.js --root $SITE --apply"
  fi
  rm -rf "$STAGE"
fi

if [ $DO_DON = 1 ]; then
  say "remove the no-reward block from the support pages"
  remote "test -f $ADMIN/src/donation.js" || { echo "Deploy the server first (--server --apply): src/donation.js is missing there."; exit 1; }
  scp -q -i "$KEY" -o BatchMode=yes "$HERE/scripts/remove-donation.js" "$VPS:/tmp/remove-donation.js"
  if [ $APPLY = 1 ]; then
    remote "mkdir -p $BAK && cd $SITE && tar czf $BAK/support-pages.tgz kik '_next/static/chunks/app/kik/proekty/[id]/pidtrymaty' && echo backup: $BAK/support-pages.tgz"
    remote "DONATION_LIB=$ADMIN/src/donation node /tmp/remove-donation.js --root $SITE --apply && restorecon -R $SITE 2>/dev/null; rm /tmp/remove-donation.js; true"
    echo "undo: tar xzf $BAK/support-pages.tgz -C $SITE (and remove the new page-*.js chunk)"
  else
    remote "DONATION_LIB=$ADMIN/src/donation node /tmp/remove-donation.js --root $SITE; rm /tmp/remove-donation.js"
  fi
fi

if [ $DO_PAY = 1 ]; then
  say "enable payments in the support-page bundle"
  remote "curl -s -m 5 http://127.0.0.1:4100/api/mono/status" | grep -q '"enabled":true' \
    || { echo "The server reports payments disabled: set MONO_API_TOKEN and restart first."; exit 1; }
  scp -q -i "$KEY" -o BatchMode=yes "$HERE/scripts/enable-payments.js" "$VPS:/tmp/enable-payments.js"
  if [ $APPLY = 1 ]; then
    remote "node /tmp/enable-payments.js --root $SITE --apply && restorecon -R $SITE 2>/dev/null; rm /tmp/enable-payments.js; true"
    echo "undo: ssh ... 'node enable-payments.js --root $SITE --revert' (script is in the repo)"
  else
    remote "node /tmp/enable-payments.js --root $SITE; rm /tmp/enable-payments.js"
  fi
fi
echo; echo done
