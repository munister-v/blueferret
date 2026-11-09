#!/usr/bin/env node
// Flip the build-time switch NEXT_PUBLIC_ENABLE_PAYMENTS in the live support-page
// bundle. The site is a static export: the flag is a constant inside the hashed
// chunk, so enabling payments means writing a new chunk file and relinking the
// pages that load it — the same thing the CMS does when it saves KIK projects.
//
//   node scripts/enable-payments.js --root /var/www/blueferret            dry run
//   node scripts/enable-payments.js --root /var/www/blueferret --apply    do it
//   node scripts/enable-payments.js --root /var/www/blueferret --revert   undo
//
// The old chunk file is left on disk, and every changed file is listed in
// <root>/.enable-payments-undo.json, so --revert is exact.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const vm = require('vm');

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const ROOT = path.resolve(opt('--root', process.env.SITE_ROOT || '/var/www/blueferret'));
const APPLY = args.includes('--apply');
const REVERT = args.includes('--revert');
const UNDO = path.join(ROOT, '.enable-payments-undo.json');
const DIR = path.join(ROOT, '_next', 'static', 'chunks', 'app', 'kik', 'proekty', '[id]', 'pidtrymaty');
const FLAG = /"true"===r\(\d+\)\.env\.NEXT_PUBLIC_ENABLE_PAYMENTS/;

function htmlFiles() {
  const out = [];
  (function walk(d) {
    for (const f of fs.readdirSync(d)) {
      if (f.startsWith('.') || f === '_next' || f === 'uploads' || f === 'cdn-cgi') continue;
      const full = path.join(d, f), st = fs.statSync(full);
      if (st.isDirectory()) walk(full);
      else if (f.endsWith('.html')) out.push(full);
    }
  })(ROOT);
  return out;
}

// The pages were prerendered with the flag off, so their buttons carry a
// `disabled` attribute. React does not repair a mismatching attribute while
// hydrating, so flipping the flag alone leaves them dead: drop it in the HTML too.
const BTN = 'type="button"';
const BTN_TAIL = 'class="inline-flex items-center justify-center gap-2 px-5 py-3 rounded-xl';
const setDisabled = (html, on) => on
  ? html.split(`<button ${BTN} ${BTN_TAIL}`).join(`<button ${BTN} disabled="" ${BTN_TAIL}`)
  : html.split(`<button ${BTN} disabled="" ${BTN_TAIL}`).join(`<button ${BTN} ${BTN_TAIL}`);

function relink(from, to, files, dry, enabling) {
  const changed = [];
  for (const f of files) {
    const h = fs.readFileSync(f, 'utf8');
    if (!h.includes(from)) continue;
    changed.push(f);
    if (!dry) fs.writeFileSync(f, setDisabled(h.split(from).join(to), !enabling));
  }
  return changed;
}

function revert() {
  if (!fs.existsSync(UNDO)) { console.error('nothing to revert (no undo file)'); process.exit(1); }
  const u = JSON.parse(fs.readFileSync(UNDO, 'utf8'));
  for (const f of u.files) {
    const h = fs.readFileSync(f, 'utf8');
    fs.writeFileSync(f, setDisabled(h.split(u.newName).join(u.oldName), true));
  }
  try { fs.unlinkSync(path.join(DIR, u.newName)); } catch { /* already gone */ }
  fs.unlinkSync(UNDO);
  console.log(`reverted: ${u.files.length} page(s) point at ${u.oldName} again`);
}

function enable() {
  if (fs.existsSync(UNDO)) {
    console.log('already applied (undo file present). Use --revert first to redo it.');
    return;
  }
  if (!fs.existsSync(DIR)) { console.error('support-page chunk directory not found:', DIR); process.exit(1); }
  const names = fs.readdirSync(DIR).filter(f => /^page-[0-9a-f]+\.js$/.test(f));
  if (names.length !== 1) { console.error('expected exactly one page-*.js, found', names); process.exit(1); }
  const oldName = names[0];
  const src = fs.readFileSync(path.join(DIR, oldName), 'utf8');
  if (!FLAG.test(src)) {
    console.log(/NEXT_PUBLIC_ENABLE_PAYMENTS/.test(src) ? 'flag is present in an unexpected form, not touching it' : 'flag already removed: payments are already enabled in the bundle');
    return;
  }
  const next = src.replace(FLAG, '!0');
  new vm.Script(next); // refuse to publish a broken bundle
  const newName = `page-${crypto.createHash('sha256').update(next).digest('hex').slice(0, 16)}.js`;
  const files = relink(oldName, newName, htmlFiles(), true, true);
  console.log(`${APPLY ? 'applying' : 'dry run'}: ${oldName} -> ${newName}; ${files.length} page(s) to relink`);
  files.forEach(f => console.log('  ', path.relative(ROOT, f)));
  if (!APPLY) { console.log('re-run with --apply'); return; }
  fs.writeFileSync(path.join(DIR, newName), next);
  relink(oldName, newName, files, false, true);
  fs.writeFileSync(UNDO, JSON.stringify({ oldName, newName, files, at: new Date().toISOString() }, null, 2));
  console.log('done. Undo: --revert');
}

REVERT ? revert() : enable();
