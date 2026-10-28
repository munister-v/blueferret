#!/usr/bin/env node
// Turns docs/legal/*.md into static pages (/oferta/, /povernennia/, /konfidentsiinist/).
// The pages are plain HTML on the site's own CSS, with no Next scripts: a page
// whose content differs from its prerendered React tree would be thrown away
// at hydration, so these deliberately stay standalone.
//
//   node scripts/build-legal.js [--out site] [--strict]
//
// Any leftover [PLACEHOLDER] is highlighted and the page gets a "draft" banner
// and noindex. With --strict a placeholder is an error, so nothing unfinished
// can be published by accident.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const flag = n => args.includes(n);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const OUT = path.resolve(opt('--out', path.join(ROOT, 'site')));
const STRICT = flag('--strict');

const PAGES = [
  { md: 'oferta.md', slug: 'oferta', title: 'Публічна оферта' },
  { md: 'povernennia.md', slug: 'povernennia', title: 'Повернення коштів' },
  { md: 'konfidentsiinist.md', slug: 'konfidentsiinist', title: 'Політика конфіденційності' },
];

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function inline(s) {
  s = esc(s);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
  // what is still in [brackets] is a placeholder to fill in
  s = s.replace(/\[([^\]]+)\]/g, '<mark class="ph">[$1]</mark>');
  return s;
}

function render(md) {
  md = md.replace(/<!--[\s\S]*?-->/g, '').trim();
  const out = [];
  let list = null;
  const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const raw of md.split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) { close(); continue; }
    let m;
    if ((m = line.match(/^(#{1,3})\s+(.*)$/))) { close(); out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); }
    else if ((m = line.match(/^-\s+(.*)$/))) { if (list !== 'ul') { close(); out.push('<ul>'); list = 'ul'; } out.push(`<li>${inline(m[1])}</li>`); }
    else if ((m = line.match(/^(\d+)\.\s+(.*)$/)) && list === 'ol') { out.push(`<li>${inline(m[2])}</li>`); }
    else if ((m = line.match(/^1\.\s+(.*)$/))) { close(); out.push('<ol>'); list = 'ol'; out.push(`<li>${inline(m[1])}</li>`); }
    else { close(); out.push(`<p>${inline(line)}</p>`); }
  }
  close();
  return out.join('\n');
}

// Reuse the site's own stylesheet links so the pages follow redesigns.
function siteHead() {
  const src = fs.readFileSync(path.join(OUT, 'kontakty', 'index.html'), 'utf8');
  const next = (src.match(/href="[^"]*(_next\/static\/css\/[\w-]+\.css)"/) || [])[1];
  const bf = (src.match(/href="(\/bf\.css\?v=\d+)"/) || [])[1] || '/bf.css';
  const js = (src.match(/src="(\/bf\.js\?v=\d+)"/) || [])[1] || '/bf.js';
  if (!next) throw new Error('could not find the site stylesheet in kontakty/index.html');
  return { css: `/${next}`, bf, js };
}

const STYLE = `
:root{--ink:#0f172a;--mute:#475569}
body{margin:0;font-family:Inter,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--ink);background:#f8fafc;min-height:100vh;display:flex;flex-direction:column}
.lg-top{background:#fff;border-bottom:1px solid #e2e8f0;position:sticky;top:0;z-index:20}
.lg-top .in{max-width:880px;margin:0 auto;padding:12px 20px;display:flex;align-items:center;gap:18px;flex-wrap:wrap}
.lg-top a.brand{display:flex;align-items:center;gap:10px;font-weight:800;letter-spacing:-.01em;color:var(--ink);text-decoration:none}
.lg-top a.brand img{width:36px;height:36px;object-fit:contain}
.lg-top nav{display:flex;gap:16px;flex-wrap:wrap;margin-left:auto;font-size:14px}
.lg-top nav a{color:var(--mute);text-decoration:none;font-weight:500}.lg-top nav a:hover{color:#2f8a52}
main{flex:1;padding:36px 20px 64px}
article{max-width:760px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:24px;padding:28px 22px;box-shadow:0 20px 46px -34px rgba(15,23,42,.3)}
@media(min-width:700px){article{padding:44px 52px}}
article h1{font-size:clamp(26px,4vw,36px);line-height:1.15;margin:0 0 18px;font-weight:800;letter-spacing:-.02em}
article h2{font-size:20px;margin:30px 0 10px;font-weight:700}
article p,article li{font-size:16px;line-height:1.7;color:#334155}
article p{margin:0 0 12px}article ul,article ol{margin:0 0 14px;padding-left:22px}article li{margin:4px 0}
article a{color:#2f8a52;text-decoration:underline;text-underline-offset:2px}
mark.ph{background:#fde68a;color:#78350f;border-radius:4px;padding:0 3px}
.draft{max-width:760px;margin:0 auto 16px;padding:12px 16px;border-radius:14px;background:#fef3c7;border:1px solid #f59e0b;color:#78350f;font-size:14px}
footer.lg-foot{background:#0f172a;color:#94a3b8;padding:28px 20px 8px;font-size:14px;text-align:center}
`;

function page({ title, body, hasPlaceholders, head }) {
  return `<!DOCTYPE html>
<html lang="uk"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — Blue Ferret</title>
<meta name="description" content="${esc(title)} видавництва настільних ігор Blue Ferret.">
${hasPlaceholders ? '<meta name="robots" content="noindex,nofollow">' : ''}
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="${head.css}">
<link rel="stylesheet" href="${head.bf}">
<style>${STYLE}</style></head>
<body>
<header class="lg-top"><div class="in"><a class="brand" href="/"><img src="/logo-blue-ferret.png" alt="" width="36" height="36">BLUE FERRET</a>
<nav aria-label="Основна навігація"><a href="/">Головна</a><a href="/igry/">Наші ігри</a><a href="/kik/">KIK вдома</a><a href="/kontakty/">Контакти</a></nav></div></header>
<main>
${hasPlaceholders ? '<div class="draft"><b>Чернетка.</b> У тексті лишилися непідставлені дані (виділені жовтим). Сторінка не індексується.</div>' : ''}
<article>
${body}
</article>
</main>
<footer class="lg-foot"><div>© Blue Ferret</div></footer>
<script src="${head.js}" defer></script>
</body></html>
`;
}

function main() {
  const head = siteHead();
  let bad = 0;
  for (const p of PAGES) {
    const md = fs.readFileSync(path.join(ROOT, 'docs', 'legal', p.md), 'utf8');
    const body = render(md);
    const left = (body.match(/<mark class="ph">/g) || []).length;
    if (left && STRICT) { console.error(`✗ ${p.slug}: ${left} placeholder(s) left`); bad++; continue; }
    const dir = path.join(OUT, p.slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), page({ title: p.title, body, hasPlaceholders: left > 0, head }));
    console.log(`✓ /${p.slug}/  ${left ? `(${left} placeholders, draft banner + noindex)` : '(final)'}`);
  }
  if (bad) process.exit(1);
}
main();
