#!/usr/bin/env node
// Puts back the hydration markers the CMS stripped from prerendered Next pages
// (see src/hydration.js). Dry run by default; --apply writes, keeping a .bak copy.
//   node scripts/repair-hydration.js --root /var/www/blueferret [--apply]
//
// On a Next game page the CMS stages block (BF_STAGES markers) is not what
// React renders there, so it is swapped for React's own markup of that section
// (scripts/hydration/<slug>-stages.html, captured from the client render).
const fs = require('fs'), path = require('path');
const cheerio = require('cheerio');
const { repairHtml, testimonialQuoteHtml, testimonialAuthorHtml } = require(process.env.HYDRATION_LIB || '../src/hydration');

const args = process.argv.slice(2);
const root = args[args.indexOf('--root') + 1];
const apply = args.includes('--apply');
if (!root || !fs.existsSync(root)) { console.error('usage: --root <site> [--apply]'); process.exit(2); }

function pages(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '_next' || e.name === 'uploads' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) pages(p, acc); else if (e.name === 'index.html') acc.push(p);
  }
  return acc;
}

// The home testimonial: <svg.lucide-quote> then <p>quote</p><p>– author, role</p>
function repairTestimonial(html, changes) {
  if (!html.includes('lucide-quote')) return html;
  const $ = cheerio.load(html, { decodeEntities: false });
  const ps = $('main svg.lucide-quote').first().parent().children('p');
  if (ps.length < 2) return html;
  const q = ps.eq(0), a = ps.eq(1);
  if ((q.html() || '').includes('<!-- -->')) return html;
  const quote = q.text().trim().replace(/^[“"]\s*/, '').replace(/\s*[”"]$/, '');
  const byline = a.text().trim().replace(/^[–—-]\s*/, '');
  const i = byline.indexOf(',');
  const author = i >= 0 ? byline.slice(0, i).trim() : byline, role = i >= 0 ? byline.slice(i + 1).trim() : '';
  // cheerio's text() decodes entities, testimonial*Html encodes them again
  q.html(testimonialQuoteHtml(quote));
  a.html(testimonialAuthorHtml(author, role));
  changes.push('testimonial');
  return $.html();
}

function replaceStages(file, html, changes) {
  const m = file.match(/igry[\\/]([^\\/]+)[\\/]index\.html$/);
  if (!m || !html.includes('self.__next_f') || !html.includes('<!-- BF_STAGES_START -->')) return html;
  const src = path.join(__dirname, 'hydration', `${m[1]}-stages.html`);
  if (!fs.existsSync(src)) return html;
  changes.push('stages:react');
  const react = fs.readFileSync(src, 'utf8').trim();
  return html.replace(/\s*<!-- BF_STAGES_START -->[\s\S]*?<!-- BF_STAGES_END -->\s*/, () => react);
}

let total = 0;
for (const f of pages(root)) {
  const before = fs.readFileSync(f, 'utf8');
  const changes = [];
  let html = replaceStages(f, before, changes);
  html = repairTestimonial(html, changes);
  const r = repairHtml(html, path.relative(root, f).split(path.sep).join('/')); html = r.html; changes.push(...r.changes);
  if (!changes.length || html === before) continue;
  total++;
  console.log(`${apply ? 'fixed' : 'would fix'} ${path.relative(root, f)}: ${changes.join(', ')}`);
  if (apply) {
    fs.copyFileSync(f, `${f}.bak-hydration-${Date.now()}`);
    fs.writeFileSync(f, html);
  }
}
console.log(total ? `${total} page(s)` : 'nothing to repair');
