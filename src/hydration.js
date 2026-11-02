// Keeps prerendered Next pages hydratable after the CMS edits them.
//
// React hydrates against the server HTML node by node. Two things in that HTML
// are invisible but required: the Suspense markers (<!--$--> … <!--/$-->) and
// the empty comments (<!-- -->) that separate adjacent text pieces such as
// "© " + 2026 + " Blue Ferret.". When an edit rewrites an element with
// .text(), or a page is re-serialized without comments, they disappear and
// React throws #418: it discards the prerendered page and renders it again.
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// The home testimonial is a client component:
//   <p>“{quote}”</p>  and  <p>– {author}<span class="text-slate-600">, {role}</span></p>
function testimonialQuoteHtml(quote) { return `“<!-- -->${esc(quote)}<!-- -->”`; }
function testimonialAuthorHtml(author, role) {
  return `– <!-- -->${esc(author)}` + (role ? `<span class="text-slate-600">, <!-- -->${esc(role)}</span>` : '');
}

// Drops whitespace-only text between tags and trims text next to tags.
function compactWhitespace(html) {
  return html.replace(/>\s+</g, '><').replace(/>\s+([^<\s])/g, '>$1').replace(/([^>\s])\s+</g, '$1<').trim();
}

// Repairs a Next page whose comments were stripped. Returns { html, changes }.
// Only touches pages that are Next pages and have lost their markers, so
// running it on a healthy page is a no-op.
function repairHtml(html, rel) {
  const changes = [];
  if (!html.includes('self.__next_f')) return { html, changes };
  let out = html;
  if (!out.includes('<!--$-->')) {
    // the metadata outlet at the top of <body>
    out = out.replace(/<div hidden="">\s*<\/div>/, m => { changes.push('suspense:metadata'); return '<div hidden=""><!--$--><!--/$--></div>'; });
    // the layout boundary closing <main>
    out = out.replace(/<\/main><footer/, m => { changes.push('suspense:main'); return '<!--$--><!--/$--></main><footer'; });
  }
  // The CMS stages block (views/game.ejs → BF_STAGES markers) is written
  // indented, but React renders the same section without whitespace nodes.
  // Unknown comments are skipped by hydration; whitespace text is not.
  out = out.replace(/\s*(<!-- BF_STAGES_START -->)([\s\S]*?)(<!-- BF_STAGES_END -->)\s*/, (m, a, body, b) => {
    const tight = compactWhitespace(body);
    if (m === a + tight + b) return m;
    changes.push('stages:whitespace');
    return a + tight + b;
  });
  // Old spelling left in a game page's footer, where the bundle (and so React)
  // says "KIK вдома". Other pages render "Кік-вдома" themselves: leave them.
  if (/^igry\//.test(rel || '')) out = out.replace(/>Кік-вдома</g, () => { changes.push('text:kik'); return '>KIK вдома<'; });
  // footer copyright: "© " {year} " Blue Ferret. " "Всі права захищені."
  out = out.replace(/>© (\d{4}) Blue Ferret\. Всі права захищені\.</g, (m, y) => {
    changes.push('text:copyright'); return `>© <!-- -->${y}<!-- --> Blue Ferret. <!-- -->Всі права захищені.<`;
  });
  return { html: out, changes };
}

// The stages block of a Next game page is the markup React renders for the
// page's own data, whose open/locked state the CMS never changes (only the
// texts are synced into the page data). Keep the block's texts equal to the
// DB: stage titles, and the paragraph of the open stage. Articles map to the
// stages by position; any other shape is left alone. Returns the new html.
function syncStagesBlock(html, stages) {
  const m = /(<!-- BF_STAGES_START -->)([\s\S]*?)(<!-- BF_STAGES_END -->)/.exec(html);
  if (!m || !Array.isArray(stages)) return html;
  const shown = stages.filter(s => s && s.title);
  const parts = m[2].split(/(?=<article )/);
  const head = parts[0], articles = parts.slice(1);
  if (!articles.length || articles.length !== shown.length) return html;
  const out = articles.map((a, i) => {
    const st = shown[i];
    let next = a.replace(/(<h3 class="[^"]*">)[^<]*(<\/h3>)/, (x, o, c) => o + esc(st.title) + c);
    if (/aria-disabled="false"/.test(next) && st.description) {
      next = next.replace(/(<p class="mt-4 [^"]*">)[^<]*(<\/p>)/, (x, o, c) => o + esc(st.description) + c);
    }
    return next;
  });
  const block = m[1] + head + out.join('') + m[3];
  return html.slice(0, m.index) + block + html.slice(m.index + m[0].length);
}

module.exports = { syncStagesBlock, compactWhitespace, repairHtml, testimonialQuoteHtml, testimonialAuthorHtml };
