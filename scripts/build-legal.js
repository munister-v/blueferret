#!/usr/bin/env node
// Turns docs/legal/*.md into static pages (/oferta/, /povernennia/, /konfidentsiinist/).
// The rendering lives in src/legal.js, shared with the admin's "Документи" tab;
// on the server the admin is the source of truth, this is for local builds.
//
//   node scripts/build-legal.js [--out site] [--strict]
//
// With --strict a leftover [PLACEHOLDER] is an error, so nothing unfinished
// can be published by accident.
const fs = require('fs');
const path = require('path');
const legal = require('../src/legal');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const flag = n => args.includes(n);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const OUT = path.resolve(opt('--out', path.join(ROOT, 'site')));
const STRICT = flag('--strict');

function main() {
  let bad = 0;
  for (const p of legal.PAGES) {
    const md = fs.readFileSync(path.join(ROOT, 'docs', 'legal', p.md), 'utf8');
    const { html, placeholders: left } = legal.build(OUT, p.slug, md);
    if (left && STRICT) { console.error(`✗ ${p.slug}: ${left} placeholder(s) left`); bad++; continue; }
    const dir = path.join(OUT, p.slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), html);
    console.log(`✓ /${p.slug}/  ${left ? `(${left} placeholders, draft banner + noindex)` : '(final)'}`);
  }
  if (bad) process.exit(1);
}
main();
