// Legal pages (/oferta/, /povernennia/, /konfidentsiinist/): Markdown in, a
// standalone HTML page out. Shared by scripts/build-legal.js and the admin's
// "Документи" editor. The pages are plain HTML on the site's own CSS, with no
// Next scripts: a page whose content differs from its prerendered React tree
// would be thrown away at hydration, so these deliberately stay standalone.
//
// Any leftover [PLACEHOLDER] is highlighted and the page gets a "draft" banner
// and noindex, so nothing unfinished gets indexed by accident.
const fs = require('fs');
const path = require('path');

const PAGES = [
  { md: 'oferta.md', slug: 'oferta', title: 'Публічна оферта' },
  { md: 'povernennia.md', slug: 'povernennia', title: 'Повернення коштів' },
  { md: 'konfidentsiinist.md', slug: 'konfidentsiinist', title: 'Політика конфіденційності' },
];

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function inline(s) {
  s = esc(s);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, href) =>
    /^(https?:|mailto:|tel:|\/|#)/i.test(href) ? `<a href="${href.replace(/"/g, '&quot;')}">${t}</a>` : t);
  // what is still in [brackets] is a placeholder to fill in
  s = s.replace(/\[([^\]]+)\]/g, '<mark class="ph">[$1]</mark>');
  return s;
}

function render(md) {
  md = md.replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?-->/g, '').trim();
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

const placeholders = body => (body.match(/<mark class="ph">/g) || []).length;

// The inverse of render() for the markup it produces. Used once, to take a
// page that was edited by hand on the server back into Markdown.
function htmlToMd(html) {
  const art = (html.match(/<article>([\s\S]*?)<\/article>/) || [])[1];
  if (art == null) return null;
  const txt = s => s
    .replace(/<mark class="ph">([\s\S]*?)<\/mark>/g, '$1')
    .replace(/<strong>([\s\S]*?)<\/strong>/g, '**$1**')
    .replace(/<a href="([^"]*)">([\s\S]*?)<\/a>/g, (_, h, t) => `[${t}](${h.replace(/&quot;/g, '"')})`)
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .trim();
  const out = [];
  const re = /<(h[1-3]|p|ul|ol)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/g;
  let m;
  while ((m = re.exec(art))) {
    const [, tag, inner] = m;
    if (tag[0] === 'h') out.push('#'.repeat(+tag[1]) + ' ' + txt(inner));
    else if (tag === 'p') out.push(txt(inner));
    else {
      const items = [...inner.matchAll(/<li(?:\s[^>]*)?>([\s\S]*?)<\/li>/g)].map(x => txt(x[1]));
      out.push(items.map((it, i) => (tag === 'ul' ? '- ' : `${i + 1}. `) + it).join('\n'));
    }
  }
  return out.join('\n\n') + '\n';
}

// Reuse the site's own stylesheet links so the pages follow redesigns.
function siteHead(siteRoot) {
  const src = fs.readFileSync(path.join(siteRoot, 'kontakty', 'index.html'), 'utf8');
  const next = (src.match(/href="[^"]*(_next\/static\/css\/[\w-]+\.css)"/) || [])[1];
  const bf = (src.match(/href="(\/bf\.css\?v=\d+)"/) || [])[1] || '/bf.css';
  const js = (src.match(/src="(\/bf\.js\?v=\d+)"/) || [])[1] || '/bf.js';
  if (!next) throw new Error('could not find the site stylesheet in kontakty/index.html');
  return { css: `/${next}`, bf, js };
}

// The site's own header and footer, lifted from a live page so these pages
// look like the rest of the site and follow its redesigns. The captured pages
// carry relative links ("../kik/index.html"); they are made absolute here.
function siteChrome(siteRoot) {
  const src = fs.readFileSync(path.join(siteRoot, 'kontakty', 'index.html'), 'utf8');
  const cut = tag => {
    const i = src.indexOf('<' + tag), j = src.indexOf('</' + tag + '>');
    if (i < 0 || j < i) throw new Error(`no <${tag}> in kontakty/index.html`);
    return src.slice(i, j + tag.length + 3);
  };
  const abs = html => html
    .replace(/ data-bf-id="[^"]*"/g, '')
    .replace(/(href|src)="([^"#?]*)((?:[?#][^"]*)?)"/g, (m, attr, url, tail) => {
      if (/^(https?:|mailto:|tel:|\/\/|\/)/.test(url)) return m;
      let u = url.replace(/^(\.\.\/)+/, '');
      if (u === 'index.html') u = url.startsWith('../') ? '' : 'kontakty/';      // "index.html" in kontakty/ is the page itself
      else u = u.replace(/\/?index\.html$/, '/');
      return `${attr}="/${u}${tail}"`;
    });
  return { header: abs(cut('header')), footer: abs(cut('footer')) };
}

const STYLE = `
:root{--ink:#0f172a;--mute:#475569}
body{background:#f8fafc;color:var(--ink)}
main.lg-main{padding:36px 20px 64px}
article{max-width:760px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:24px;padding:28px 22px;box-shadow:0 20px 46px -34px rgba(15,23,42,.3);font-family:Inter,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
@media(min-width:700px){article{padding:44px 52px}}
article h1{font-size:clamp(26px,4vw,36px);line-height:1.15;margin:0 0 18px;font-weight:800;letter-spacing:.01em}
article h1,article h1+p,article h1+p+p{text-align:center}
article h2{text-align:left}
article h2{font-size:20px;margin:30px 0 10px;font-weight:700}
article p,article li{font-size:16px;line-height:1.7;color:#334155}
article p{margin:0 0 12px}article ul,article ol{margin:0 0 14px;padding-left:22px}article li{margin:4px 0}
article a{color:#2f8a52;text-decoration:underline;text-underline-offset:2px}
mark.ph{background:#fde68a;color:#78350f;border-radius:4px;padding:0 3px}
.draft{max-width:760px;margin:0 auto 16px;padding:12px 16px;border-radius:14px;background:#fef3c7;border:1px solid #f59e0b;color:#78350f;font-size:14px}
`;

function page({ title, body, hasPlaceholders, head, chrome }) {
  return `<!DOCTYPE html>
<html lang="uk"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} | Blue Ferret</title>
<meta name="description" content="${esc(title)} видавництва настільних ігор Blue Ferret.">
${hasPlaceholders ? '<meta name="robots" content="noindex,nofollow">' : ''}
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="${head.css}">
<link rel="stylesheet" href="${head.bf}">
<style>${STYLE}</style></head>
<body class="min-h-screen flex flex-col antialiased">
${chrome.header}
<main class="flex-1 lg-main">
${hasPlaceholders ? '<div class="draft"><b>Чернетка.</b> У тексті лишилися непідставлені дані (виділені жовтим). Сторінка не індексується.</div>' : ''}
<article>
${body}
</article>
</main>
${chrome.footer}
<script src="${head.js}" defer></script>
</body></html>
`;
}

// Markdown → the full page for one slug, plus how many placeholders are left.
function build(siteRoot, slug, md) {
  const p = PAGES.find(x => x.slug === slug);
  if (!p) throw new Error(`unknown legal page: ${slug}`);
  const body = render(md);
  const left = placeholders(body);
  return { html: page({ title: p.title, body, hasPlaceholders: left > 0, head: siteHead(siteRoot), chrome: siteChrome(siteRoot) }), placeholders: left };
}

module.exports = { PAGES, render, htmlToMd, build, placeholders };
