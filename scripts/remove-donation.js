#!/usr/bin/env node
// Take "Підтримка без нагороди" off every support page of the live site: the
// prerendered HTML (visible and parked pages), the page text, and the client
// bundle that would otherwise put the block back while hydrating.
//
//   node scripts/remove-donation.js --root /var/www/blueferret            dry run
//   node scripts/remove-donation.js --root /var/www/blueferret --apply    do it
//
// Idempotent. The bundle gets a new hashed name (like the CMS and
// enable-payments do) and the pages are relinked; the old chunk is deleted, so
// take a backup first (scripts/deploy-mono.sh --remove-donation does).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const vm = require('vm');
const { stripDonationHtml, stripDonationBundle, hasDonationHtml } = require(process.env.DONATION_LIB || '../src/donation');

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const ROOT = path.resolve(opt('--root', process.env.SITE_ROOT || '/var/www/blueferret'));
const APPLY = args.includes('--apply');
const DIR = path.join(ROOT, '_next', 'static', 'chunks', 'app', 'kik', 'proekty', '[id]', 'pidtrymaty');

function pages() {
  const base = path.join(ROOT, 'kik', 'proekty'), out = [];
  for (const id of fs.existsSync(base) ? fs.readdirSync(base) : []) {
    const d = path.join(base, id, 'pidtrymaty');
    if (!fs.existsSync(d) || !fs.statSync(d).isDirectory()) continue;
    for (const f of fs.readdirSync(d)) if (/^index(\.bf-hidden)?\.html$/.test(f)) out.push(path.join(d, f));
  }
  return out;
}
function allHtml() {
  const out = [];
  (function walk(d) {
    for (const f of fs.readdirSync(d)) {
      if (f.startsWith('.') || f === '_next' || f === 'uploads' || f === 'cdn-cgi') continue;
      const full = path.join(d, f), st = fs.statSync(full);
      if (st.isDirectory()) walk(full); else if (f.endsWith('.html')) out.push(full);
    }
  })(ROOT);
  return out;
}

// 1. look first, write later: nothing is touched unless every step can be done
const htmlPlan = [];
for (const f of pages()) {
  const h = fs.readFileSync(f, 'utf8');
  if (!hasDonationHtml(h)) continue;
  const out = stripDonationHtml(h);
  // a page whose markup is not the expected one is left alone (a parked demo page nobody can open)
  if (out.includes('aria-label="Сума підтримки"')) { console.log('SKIPPED, unexpected markup:', path.relative(ROOT, f)); continue; }
  if (out !== h) htmlPlan.push([f, out]);
}

if (!fs.existsSync(DIR)) { console.error('support-page chunk directory not found:', DIR); process.exit(1); }
const html = allHtml();
// only chunks some page still loads (older ones may linger on disk)
const used = fs.readdirSync(DIR).filter(f => /^page-[0-9a-f]+\.js$/.test(f))
  .filter(n => html.some(f => fs.readFileSync(f, 'utf8').includes(n)));
if (used.length !== 1) { console.error('expected exactly one support-page chunk in use, found', used); process.exit(1); }
const oldName = used[0];
const js = fs.readFileSync(path.join(DIR, oldName), 'utf8');
const next = stripDonationBundle(js);
let bundlePlan = null;
if (next !== js) {
  new vm.Script(next); // must still parse
  const newName = `page-${crypto.createHash('sha256').update(next).digest('hex').slice(0, 16)}.js`;
  bundlePlan = { newName, next, linked: html.filter(f => fs.readFileSync(f, 'utf8').includes(oldName)) };
}

// 2. report / apply
for (const [f] of htmlPlan) console.log((APPLY ? 'stripped ' : 'would strip ') + path.relative(ROOT, f));
if (bundlePlan) console.log(`bundle ${oldName} -> ${bundlePlan.newName}, ${bundlePlan.linked.length} page(s) relinked`);
else console.log(`bundle ${oldName}: nothing to strip`);
if (APPLY) {
  for (const [f, out] of htmlPlan) fs.writeFileSync(f, out);
  if (bundlePlan) {
    fs.writeFileSync(path.join(DIR, bundlePlan.newName), bundlePlan.next);
    for (const f of bundlePlan.linked) fs.writeFileSync(f, fs.readFileSync(f, 'utf8').split(oldName).join(bundlePlan.newName));
    fs.unlinkSync(path.join(DIR, oldName));
  }
}
console.log(APPLY ? 'done' : `dry run: ${htmlPlan.length} page(s) and ${bundlePlan ? 1 : 0} bundle would change (add --apply)`);
