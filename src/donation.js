// The support page used to offer "Підтримка без нагороди" (any amount, no reward)
// above the reward cards. That block is gone: only the reward sets can be bought.
// It lives in three places, and all three must agree or React rebuilds it while
// hydrating: the prerendered HTML, the page's client bundle, and the page text.

const OLD_SUBTITLE = 'Оберіть варіант: замовити фіксовану версію гри або підтримати сумою без нагороди.';
const NEW_SUBTITLE = 'Оберіть набір, щоб підтримати випуск гри. Нагороду — примірник гри — ми відправимо після завершення збору.';

const BLOCK_OPEN = '<div class="rounded-3xl border border-slate-200/80 bg-white/95 p-5 sm:p-6 shadow-[0_20px_46px_-34px_rgba(15,23,42,0.35)]">';

function divEnd(html, start) {
  const re = /<div\b|<\/div>/g; re.lastIndex = start;
  let depth = 0, m;
  while ((m = re.exec(html))) {
    if (m[0] === '</div>') { if (--depth === 0) return re.lastIndex; } else depth++;
  }
  return -1;
}

// Remove the no-reward block (and fix the subtitle) in a prerendered support page.
function stripDonationHtml(html) {
  let out = html;
  const at = out.indexOf('<div class="space-y-5">' + BLOCK_OPEN);
  if (at >= 0) {
    const start = at + '<div class="space-y-5">'.length;
    const end = divEnd(out, start);
    const block = end > 0 ? out.slice(start, end) : '';
    if (block.includes('aria-label="Сума підтримки"')) out = out.slice(0, start) + out.slice(end);
  }
  return out.split(OLD_SUBTITLE).join(NEW_SUBTITLE);
}

// Same in the client bundle: drop the first child of the page's root <div>.
// (Minified names differ between builds, hence the regex.)
function stripDonationBundle(js) {
  const re = /\(0,(\w+)\.jsx\)\("div",\{className:"rounded-3xl border border-slate-200\/80 bg-white\/95 p-5 sm:p-6 shadow-\[0_20px_46px_-34px_rgba\(15,23,42,0\.35\)\]",children:/;
  const m = re.exec(js);
  if (!m) return js;
  const grid = js.indexOf(`,(0,${m[1]}.jsx)("div",{className:"grid gap-4"`, m.index);
  if (grid < 0 || !js.slice(m.index, grid).includes('"aria-label"') && !js.slice(m.index, grid).includes('amountAria')) return js;
  return js.slice(0, m.index) + js.slice(grid + 1);
}

const hasDonationHtml = html => html.includes('aria-label="Сума підтримки"') || html.includes(OLD_SUBTITLE);

module.exports = { stripDonationHtml, stripDonationBundle, hasDonationHtml, OLD_SUBTITLE, NEW_SUBTITLE };
