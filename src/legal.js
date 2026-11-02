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
  const keep = [];
  const stash = html => `\u0000${keep.push(html) - 1}\u0000`;
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, href) =>
    stash(/^(https?:|mailto:|tel:|\/|#)/i.test(href) ? `<a href="${href.replace(/"/g, '&quot;')}">${t}</a>` : t));
  // bare addresses become links; the markup is stashed so [placeholders] never see it
  s = s.replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, m => stash(`<a href="mailto:${m}">${m}</a>`));
  s = s.replace(/https?:\/\/[^\s<>)]+[^\s<>).,;:]/g, m => stash(`<a href="${m}">${m}</a>`));
  // what is still in [brackets] is a placeholder to fill in
  s = s.replace(/\[([^\]]+)\]/g, '<mark class="ph">[$1]</mark>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, n) => keep[n]);
}

function render(md) {
  md = md.replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?-->/g, '').trim();
  const lines = md.split('\n').map(l => l.trimEnd());
  // contents: only for long documents, in front of the first section
  const heads = lines.map(l => (l.match(/^##\s+(.*)$/) || [])[1]).filter(Boolean);
  const toc = heads.length >= 8
    ? `<nav class="toc" aria-label="Зміст"><b>Зміст</b>${heads.map((h, n) => `<a href="#s${n + 1}">${inline(h)}</a>`).join('')}</nav>`
    : '';
  const out = [];
  let list = null, sec = 0, tocDone = !toc;
  const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const line of lines) {
    if (!line.trim()) { close(); continue; }
    let m;
    if ((m = line.match(/^(#{1,3})\s+(.*)$/))) {
      close();
      if (m[1].length === 2) {
        if (!tocDone) { out.push(toc); tocDone = true; }
        out.push(`<h2 id="s${++sec}">${inline(m[2])}</h2>`);
      } else out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`);
    }
    else if ((m = line.match(/^-\s+(.*)$/))) { if (list !== 'ul') { close(); out.push('<ul>'); list = 'ul'; } out.push(`<li>${inline(m[1])}</li>`); }
    else if ((m = line.match(/^(\d+)\.\s+(.*)$/)) && list === 'ol') { out.push(`<li>${inline(m[2])}</li>`); }
    else if ((m = line.match(/^1\.\s+(.*)$/))) { close(); out.push('<ol>'); list = 'ol'; out.push(`<li>${inline(m[1])}</li>`); }
    else if ((m = line.match(/^(\d+(?:\.\d+)+\.?)\s+(.*)$/))) { close(); out.push(`<p class="cl"><span class="no">${m[1]}</span> <span class="tx">${inline(m[2])}</span></p>`); }
    else if (/^Редакція від\s/.test(line)) { close(); out.push(`<p class="ed">${inline(line)}</p>`); }
    else { close(); out.push(`<p>${inline(line)}</p>`); }
  }
  close();
  if (!tocDone) out.push(toc);
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
article h1,article h2,article h3{font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
html{scroll-behavior:smooth}
main.lg-main{padding:36px 20px 64px}
main.lg-main .bf-reveal,main.lg-main .bf-reveal-left,main.lg-main .bf-reveal-scale{opacity:1!important;transform:none!important;transition:none!important}
article{max-width:780px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:28px;padding:30px 20px 34px;box-shadow:0 24px 60px -36px rgba(15,23,42,.32)}
@media(min-width:700px){article{padding:52px 60px 56px}}
article h1{font-size:clamp(28px,4.4vw,40px);line-height:1.12;margin:0 0 14px;font-weight:800;letter-spacing:-.01em;text-align:center;color:#0f172a}
article h1+p{text-align:center;color:#64748b;font-size:16px;line-height:1.55;margin:0 auto 14px;max-width:560px}
article p.ed{display:table;margin:0 auto 26px;padding:6px 16px;border-radius:999px;background:#4BB2721a;border:1px solid #4BB27238;color:#2f8a52;font-size:13px;font-weight:700;letter-spacing:.01em}
article h1+p.ed{margin:0 auto 26px;font-size:13px;color:#2f8a52}
article h2{position:relative;font-size:clamp(19px,2.6vw,23px);line-height:1.3;margin:42px 0 14px;padding-left:18px;font-weight:800;letter-spacing:-.005em;color:#0f172a;text-align:left;scroll-margin-top:92px}
article h2::before{content:"";position:absolute;left:0;top:.14em;bottom:.14em;width:5px;border-radius:5px;background:linear-gradient(180deg,#009FE3,#4BB272)}
article h3{font-size:17px;margin:24px 0 8px;font-weight:700;color:#0f172a}
article p,article li{font-size:16px;line-height:1.75;color:#334155}
article p{margin:0 0 14px}
article strong{color:#0f172a}
article p.cl{display:flex;gap:10px;margin:0 0 12px}
article p.cl .no{flex:none;min-width:3.1em;color:#2f8a52;font-weight:800;font-variant-numeric:tabular-nums}
article p.cl .tx{flex:1;min-width:0}
@media(max-width:600px){main.lg-main{padding:20px 10px 44px}article{padding:26px 16px 30px;border-radius:22px}article p.cl{display:block}article p.cl .no{display:inline;margin-right:.45em;min-width:0}article p.cl .tx{display:inline}article li{padding:12px 14px 12px 40px}article ol li{padding-left:52px}article p,article li{font-size:15.5px;line-height:1.7}}
article ul,article ol{list-style:none;margin:0 0 18px;padding:0}
article li{position:relative;margin:8px 0;padding:13px 16px 13px 44px;border:1px solid #e6edf3;border-radius:16px;background:#f8fafc}
article ul li::before{content:"";position:absolute;left:18px;top:1.2em;width:9px;height:9px;border-radius:50%;background:#4BB272;box-shadow:0 0 0 4px #4BB27222}
article ol{counter-reset:st}
article ol li{counter-increment:st;padding-left:56px}
article ol li::before{content:counter(st);position:absolute;left:14px;top:12px;width:30px;height:30px;border-radius:50%;background:#0f172a;color:#fff;text-align:center;line-height:30px;font-size:14px;font-weight:700}
article a{color:#2f8a52;font-weight:600;text-decoration:underline;text-underline-offset:3px;text-decoration-color:#4BB27266;word-break:break-word}
article a:hover{text-decoration-color:#2f8a52}
article nav.toc{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 6px;padding:16px 16px 14px;border-radius:20px;background:#f1f5f9;border:1px solid #e2e8f0}
article nav.toc b{flex-basis:100%;font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#64748b;margin-bottom:2px}
article nav.toc a{padding:7px 12px;border-radius:999px;background:#fff;border:1px solid #e2e8f0;color:#334155;font-size:13px;font-weight:600;line-height:1.3;text-decoration:none}
article nav.toc a:hover{border-color:#4BB272;color:#2f8a52}
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
