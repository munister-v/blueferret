// /kik/proekty/ is rendered in the browser only (Next bails out to client
// rendering because the page reads the URL), so its HTML used to carry nothing
// but "Завантаження...": on a slow phone or an in-app browser that is all a
// visitor saw. This writes the real project cards into that fallback. React
// replaces the fallback wholesale when it renders, so the two never clash.
const fs = require('fs');
const path = require('path');

const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const money = n => new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 0 }).format(Number(n) || 0) + ' ₴';
const safeHref = (u, d) => (typeof u === 'string' && /^\/(?!\/)\S*$/.test(u.trim()) ? u.trim() : d);

function card(p) {
  const pct = p.goal > 0 ? Math.min(100, (Number(p.raised) || 0) / p.goal * 100) : 0;
  const cover = p.coverImage
    ? `<img src="${esc(safeHref(p.coverImage, ''))}" alt="${esc(p.name)}" loading="lazy" decoding="async" class="absolute inset-0 w-full h-full object-cover">`
    : '';
  const bar = p.goal > 0
    ? `<div class="mb-4 sm:mb-5"><div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1 sm:gap-3 text-xs sm:text-sm mb-1.5 sm:mb-2"><span class="text-slate-500">Зібрано</span><span class="font-bold text-[var(--kik-accent)] leading-tight">${money(p.raised)} / ${money(p.goal)}</span></div><div class="h-2 sm:h-2.5 rounded-full bg-slate-200/80 overflow-hidden"><div class="h-full bg-gradient-to-r from-[var(--kik-accent)] to-emerald-400 rounded-full" style="width:${pct.toFixed(1)}%"></div></div></div>`
    : '';
  return `<a href="${esc(safeHref(p.link, '/kik/proekty/'))}" class="group flex h-full flex-col bg-white/98 rounded-2xl overflow-hidden board-game-border-kik">`
    + `<div class="aspect-[16/10] min-h-[190px] relative overflow-hidden bg-gradient-to-br from-emerald-800/95 via-teal-900/90 to-slate-900">${cover}`
    + `<div class="absolute top-3 left-3 sm:top-5 sm:left-5"><span class="board-game-badge inline-block px-3 py-1.5 sm:px-4 sm:py-2 rounded-lg bg-white/95 text-xs sm:text-sm text-slate-700 shadow-md">${esc(p.statusLabel)}</span></div></div>`
    + `<div class="p-4 sm:p-6 lg:p-7 flex flex-col flex-1"><h2 class="text-lg sm:text-xl lg:text-2xl font-bold mb-2 sm:mb-3 text-slate-800">${esc(p.name)}</h2>${bar}`
    + `<p class="text-body text-sm lg:text-base mb-4">${esc(p.shortDescription)}</p>`
    + `<span class="inline-flex items-center gap-2 text-[var(--kik-accent)] font-semibold text-sm mt-auto">Детальніше →</span></div></a>`;
}

function render(projects) {
  const list = (projects || []).filter(p => p && p.status !== 'draft');
  return `<div class="min-h-screen" data-bf-kik-fallback="1">`
    + `<section class="relative py-16 sm:py-24 px-4 sm:px-6"><div class="max-w-6xl mx-auto text-center">`
    + `<p class="section-label mb-3">Проєкти</p><h1 class="heading-2 text-3xl sm:text-4xl md:text-5xl mb-4 tracking-tight">Авторські ігри</h1>`
    + `<p class="text-lead max-w-2xl text-slate-600" style="margin:0 auto">Підбірка проєктів платформи KIK вдома: етапи, оновлення та поточний прогрес.</p></div></section>`
    + `<section class="py-6 sm:py-12 px-4 sm:px-6"><div class="max-w-6xl mx-auto"><div class="grid sm:grid-cols-2 xl:grid-cols-3 gap-5 sm:gap-7 lg:gap-8">`
    + list.map(card).join('')
    + `</div></div></section></div>`;
}

// The fallback is everything between the bail-out template and the end of its
// Suspense boundary. Returns true when the page was changed.
const BOUNDARY = /(<template data-dgst="BAILOUT_TO_CLIENT_SIDE_RENDERING"><\/template>)([\s\S]*?)(<!--\/\$-->)/;

function apply(siteRoot, projects) {
  const file = path.join(siteRoot, 'kik', 'proekty', 'index.html');
  const html = fs.readFileSync(file, 'utf8');
  const m = html.match(BOUNDARY);
  if (!m) return false;
  const next = html.replace(BOUNDARY, (_, a, _b, z) => a + render(projects) + z);
  if (next === html) return false;
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, next);
  fs.renameSync(tmp, file);
  return true;
}

module.exports = { render, apply, BOUNDARY };
