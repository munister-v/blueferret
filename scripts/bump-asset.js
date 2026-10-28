#!/usr/bin/env node
// Cache-bust a site asset: every page references it as /bf.js?v=N and nginx lets
// browsers keep JS for a day, so a changed file needs a new N in every page.
//
//   node scripts/bump-asset.js --root /var/www/blueferret [--asset bf.js] [--apply]
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const ROOT = path.resolve(opt('--root', '/var/www/blueferret'));
const ASSET = opt('--asset', 'bf.js');
const APPLY = args.includes('--apply');
const re = new RegExp(`(/${ASSET.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\?v=)(\\d+)`, 'g');

const files = [];
(function walk(d) {
  for (const f of fs.readdirSync(d)) {
    if (f.startsWith('.') || f === '_next' || f === 'uploads' || f === 'cdn-cgi') continue;
    const full = path.join(d, f), st = fs.statSync(full);
    if (st.isDirectory()) walk(full);
    else if (f.endsWith('.html')) files.push(full);
  }
})(ROOT);

let max = 0;
for (const f of files) for (const m of fs.readFileSync(f, 'utf8').matchAll(re)) max = Math.max(max, +m[2]);
if (!max) { console.log(`no ${ASSET}?v= references found under ${ROOT}`); process.exit(0); }
const next = max + 1;
let n = 0;
for (const f of files) {
  const h = fs.readFileSync(f, 'utf8');
  const out = h.replace(re, `$1${next}`);
  if (out !== h) { n++; if (APPLY) fs.writeFileSync(f, out); }
}
console.log(`${APPLY ? 'bumped' : 'would bump'} ${ASSET}?v=${max} -> ${next} in ${n} page(s)`);
