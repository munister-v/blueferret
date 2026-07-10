const fs = require('fs');
const path = require('path');
const db = require('better-sqlite3')('blueferret.db');
const kAll = db.prepare('SELECT * FROM kik_projects ORDER BY sort_order,id');
const SITE_DIR = path.join(__dirname, '..', 'site');

function writeAtomic(filepath, data) {
  const tmp = filepath + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, data, 'utf8');
  fs.renameSync(tmp, filepath);
}

function regenKikCatalog() {
  const kikIndexFile = path.join(SITE_DIR, 'kik', 'proekty', 'index.html');
  if (!fs.existsSync(kikIndexFile)) {
    console.error("Not found", kikIndexFile);
    return;
  }

  const projects = kAll.all();
  const activeCount = projects.filter(p => p.status === 'active').length;
  
  function formatCurrency(n) {
    return new Intl.NumberFormat('uk-UA', { style: 'decimal', maximumFractionDigits: 0 }).format(n) + ' ₴';
  }
  function getStatusLabel(status) {
    const map = {
      'active': 'Збір коштів',
      'preparing': 'Підготовка',
      'finished': 'Успішно завершено',
      'draft': 'Чернетка'
    };
    return map[status] || status;
  }

  let html = `
  <section class="relative py-16 sm:py-24 lg:py-28 px-4 sm:px-6 overflow-hidden">
    <div class="absolute inset-0 bg-gradient-to-br from-emerald-50/85 via-white to-blue-50/45"></div>
    <div class="absolute inset-0 bg-dots-kik opacity-30"></div>
    <div class="absolute inset-0 bg-grain opacity-50"></div>
    <div class="absolute inset-0 bg-[radial-gradient(ellipse_100%_60%_at_50%_-20%,#4BB2721c_0%,transparent_60%)]"></div>
    <div class="absolute inset-0 bg-[radial-gradient(ellipse_80%_40%_at_10%_80%,#009FE310_0%,transparent_55%)]"></div>
    <div class="relative max-w-6xl mx-auto">
      <div class="text-center bf-reveal">
        <div class="h-1 w-20 rounded-full bg-gradient-to-r from-[var(--bf-accent)] to-[var(--kik-accent)] mb-6 mx-auto"></div>
        <p class="mb-3 text-3xl sm:text-4xl text-gradient-warm">KIK вдома</p>
        <h2 class="heading-2 text-3xl sm:text-4xl md:text-5xl mb-4 tracking-tight">Наші проєкти</h2>
        <p class="text-lead max-w-2xl text-slate-600" style="margin:0 auto">Підтримайте створення нових українських ігор. Долучайтеся до спільноти та отримуйте унікальні нагороди.</p>
      </div>
      <div class="flex flex-wrap items-center justify-center gap-2.5 sm:gap-3 mt-8 bf-reveal">
        <span class="inline-flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs sm:text-sm font-semibold text-slate-700 bg-white/90 border border-slate-200/80 shadow-sm">
          <svg class="w-4 h-4 text-[var(--kik-accent)]" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"></path><path d="M8 10v4"></path><path d="M12 10v2"></path><path d="M16 10v6"></path></svg>
          ${projects.length} проєктів
        </span>
        <span class="inline-flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs sm:text-sm font-semibold text-slate-700 bg-white/90 border border-slate-200/80 shadow-sm">
          <svg class="w-4 h-4 text-[var(--kik-accent)]" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"></path><path d="m9 12 2 2 4-4"></path></svg>
          ${activeCount} активних
        </span>
      </div>
    </div>
  </section>
  <section class="py-10 sm:py-16 lg:py-24 px-4 sm:px-6 -mt-2">
    <div class="max-w-6xl mx-auto">
      <div class="grid sm:grid-cols-2 xl:grid-cols-3 gap-5 sm:gap-7 lg:gap-8" data-bf-kik-grid="true">`;

  for (const e of projects) {
    if (e.status === 'draft') continue;
    let t = e.goal > 0 ? Math.min(100, (e.raised / e.goal) * 100) : 0;
    html += `
        <a href="${e.campaign_url || '#'}" target="${e.campaign_url ? '_blank' : '_self'}" class="group flex h-full flex-col bg-white/98 rounded-2xl overflow-hidden board-game-border-kik transition-all duration-300 hover:-translate-y-1 hover:shadow-[0_26px_46px_-30px_rgba(15,23,42,0.45)] bf-reveal">
          <div class="aspect-[16/10] min-h-[190px] relative overflow-hidden bg-gradient-to-br from-emerald-800/95 via-teal-900/90 to-slate-900">
            ${e.cover_url ? `<img src="${e.cover_url}" alt="${e.title.replace(/"/g,'&quot;')}" class="absolute inset-0 w-full h-full object-cover">` : ''}
            <div class="absolute inset-0 bg-gradient-to-t from-slate-950/45 via-slate-900/10 to-transparent"></div>
            <div class="absolute inset-0 bg-dots-kik opacity-22"></div>
            <div class="absolute top-3 left-3 sm:top-5 sm:left-5">
              <span class="board-game-badge inline-block px-3 py-1.5 sm:px-4 sm:py-2 rounded-lg bg-white/95 text-xs sm:text-sm text-slate-700 shadow-md backdrop-blur-sm border border-[var(--kik-accent)]/30">${getStatusLabel(e.status)}</span>
            </div>
            ${(e.goal > 0 && e.raised > 0) ? `
            <div class="absolute bottom-3 right-3 sm:bottom-5 sm:right-5 flex items-center gap-2 px-2.5 py-1.5 sm:px-3.5 sm:py-2 rounded-xl bg-white/95 backdrop-blur-sm border border-white/50 shadow-sm">
              <svg class="w-3.5 h-3.5 sm:w-4 sm:h-4 text-[var(--kik-accent)]" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 7h6v6"></path><path d="m22 7-8.5 8.5-5-5L2 17"></path></svg>
              <span class="text-xs sm:text-sm font-bold text-[var(--kik-accent)]">${Math.round(t)}%</span>
            </div>` : ''}
          </div>
          <div class="p-4 sm:p-6 lg:p-7 flex flex-col flex-1">
            <h2 class="text-lg sm:text-xl lg:text-2xl font-bold group-hover:text-[var(--kik-accent)] transition-colors mb-2 sm:mb-3 text-slate-800 line-clamp-2 min-h-[3.2rem] sm:min-h-[3.6rem]">${e.title}</h2>
            ${e.goal > 0 ? `
            <div class="mb-4 sm:mb-5">
              <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1 sm:gap-3 text-xs sm:text-sm mb-1.5 sm:mb-2">
                <span class="text-slate-500">Зібрано</span>
                <span class="font-bold text-[var(--kik-accent)] leading-tight">${formatCurrency(e.raised)} / ${formatCurrency(e.goal)}</span>
              </div>
              <div class="h-2 sm:h-2.5 rounded-full bg-slate-200/80 overflow-hidden">
                <div class="h-full bg-gradient-to-r from-[var(--kik-accent)] to-emerald-400 rounded-full" style="width: ${t}%"></div>
              </div>
            </div>` : ''}
            <p class="text-body text-sm lg:text-base mb-4 line-clamp-3">${e.description || e.subtitle || ''}</p>
            <span class="inline-flex items-center gap-2 text-[var(--kik-accent)] font-semibold text-sm group-hover:gap-3 transition-all mt-auto">
              Детальніше 
              <svg class="w-4 h-4" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"></path><path d="m12 5 7 7-7 7"></path></svg>
            </span>
          </div>
        </a>`;
  }
  
  html += `
      </div>
    </div>
  </section>`;

  try {
    // Keep a backup just in case
    let doc = fs.readFileSync(kikIndexFile, 'utf8');
    fs.writeFileSync(kikIndexFile + '.bak', doc, 'utf8');
    
    doc = doc.replace(/(<header[^>]*>.*?<\/header>)\s*<main>[\s\S]*?(?=<\/main>\s*<\/div>\s*<\/main>)/, '$1<main>' + html);
    writeAtomic(kikIndexFile, doc);
    console.log("Successfully regenerated KIK catalog HTML!");
  } catch (err) {
    console.error('Failed to regenerate KIK catalog', err);
  }
}

regenKikCatalog();
