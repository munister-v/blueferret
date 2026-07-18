'use strict';
const express = require('express');
const crypto  = require('crypto');
const path    = require('path');
const fs      = require('fs');
const multer  = require('multer');
const Database = require('better-sqlite3');

const PORT      = parseInt(process.env.PORT || '4100', 10);
const HOST      = process.env.HOST || '127.0.0.1';
const PASS_HASH = (process.env.ADMIN_PASS_HASH ||
  'cf1f40037282725a43a2968b3b7509db30ffceaa33039ae1b6dc7a7a3927c5ac').toLowerCase();
const DB_PATH   = process.env.DB_PATH || path.join(__dirname, 'data', 'blueferret.db');
const SITE_ROOT = process.env.SITE_ROOT || '/var/www/blueferret';
const UPLOADS   = path.join(SITE_ROOT, 'uploads');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
fs.mkdirSync(UPLOADS, { recursive: true });

// ---------- DB ----------
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER, ip TEXT, action TEXT, detail TEXT
  );
  CREATE TABLE IF NOT EXISTS games (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    subtitle TEXT DEFAULT '',
    description TEXT DEFAULT '',
    status TEXT DEFAULT 'published',
    cover_url TEXT DEFAULT '',
    gallery TEXT DEFAULT '[]',
    players TEXT DEFAULT '',
    age TEXT DEFAULT '',
    duration TEXT DEFAULT '',
    buy_url TEXT DEFAULT '',
    sort_order INTEGER DEFAULT 0,
    created_at INTEGER,
    updated_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS kik_projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    subtitle TEXT DEFAULT '',
    description TEXT DEFAULT '',
    status TEXT DEFAULT 'active',
    goal INTEGER DEFAULT 0,
    raised INTEGER DEFAULT 0,
    backers INTEGER DEFAULT 0,
    cover_url TEXT DEFAULT '',
    campaign_url TEXT DEFAULT '',
    ends_at INTEGER,
    sort_order INTEGER DEFAULT 0,
    created_at INTEGER,
    updated_at INTEGER
  );
`);
// Lightweight column migration: add new game fields to DBs created before
// this version without needing a manual ALTER TABLE on the server.
(function migrateGamesColumns(){
  const cols = db.prepare("PRAGMA table_info(games)").all().map(c => c.name);
  const add = (name, ddl) => { if (!cols.includes(name)) db.exec(`ALTER TABLE games ADD COLUMN ${ddl}`); };
  add('designer', "designer TEXT DEFAULT ''");
  add('components', "components TEXT DEFAULT ''");
  add('links', "links TEXT DEFAULT '[]'");
})();

const getRow  = db.prepare('SELECT value FROM settings WHERE key=?');
const upsert  = db.prepare(`INSERT INTO settings(key,value,updated_at) VALUES(?,?,?)
  ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`);
const insAudit = db.prepare('INSERT INTO audit(ts,ip,action,detail) VALUES(?,?,?,?)');

function getSetting(key, fallback) {
  const r = getRow.get(key);
  if (!r) return fallback;
  try { return JSON.parse(r.value); } catch { return fallback; }
}
function setSetting(key, val) { upsert.run(key, JSON.stringify(val), Date.now()); }
function audit(ip, action, detail) {
  try { insAudit.run(Date.now(), ip||'', action, detail ? JSON.stringify(detail).slice(0,2000) : null); } catch {}
}
function writeAtomic(file, content) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}
const BACKUP_KEEP = 15;
function writeBackup(file) {
  if (!fs.existsSync(file)) return;
  const ts = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  fs.copyFileSync(file, `${file}.bak-${ts}`);
  // Every edit adds a new .bak-<timestamp> and nothing ever removed the old
  // ones, so they accumulated forever across every page directory — keep
  // only the most recent BACKUP_KEEP per file.
  try {
    const dir = path.dirname(file);
    const base = path.basename(file);
    const prefix = `${base}.bak-`;
    const backups = fs.readdirSync(dir)
      .filter(f => f.startsWith(prefix))
      .sort(); // timestamp-suffixed names sort chronologically
    for (const old of backups.slice(0, -BACKUP_KEEP)) {
      try { fs.unlinkSync(path.join(dir, old)); } catch {}
    }
  } catch {}
}
function bumpPublishedAt() {
  const g = Object.assign({}, DEFAULTS.general, getSetting('general', {}));
  g.publishedAt = Date.now();
  setSetting('general', g);
  return g.publishedAt;
}

// session secret
let SECRET = getSetting('__secret', null);
if (!SECRET) { SECRET = crypto.randomBytes(32).toString('hex'); setSetting('__secret', SECRET); }

// current password hash (can be changed via UI)
function getPassHash() { return getSetting('__pass_hash', null) || PASS_HASH; }

// ---------- defaults ----------
const DEFAULTS = {
  general:      { siteTitle: 'Blue Ferret', tagline: 'Незалежне видавництво настільних ігор', primaryColor: '#2E9BE6', publishedAt: 0 },
  maintenance:  { enabled: false, message: 'Сайт тимчасово на технічному обслуговуванні. Скоро повернемось!' },
  banner:       { enabled: false, text: '', link: '', bg: '#2E9BE6', fg: '#ffffff' },
  contacts:     { email: 'rogachovanika@gmail.com', telegram: 'https://t.me/blueferret_game', instagram: 'https://www.instagram.com/blueferret_game', facebook: 'https://facebook.com/blueferret_game', x: '' },
  seo:          { defaultTitle: '', defaultDescription: '', ogImage: '', noindex: false },
  integrations: { headScripts: '', bodyScripts: '' },
  appearance:   { customCss: '' },
};
const PUBLIC_KEYS   = ['general','maintenance','banner','appearance','integrations','contacts'];
const EDITABLE_KEYS = Object.keys(DEFAULTS);

function fullSettings() {
  const out = {};
  for (const k of EDITABLE_KEYS) out[k] = Object.assign({}, DEFAULTS[k], getSetting(k, {}));
  return out;
}

// ---------- app ----------
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '4mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  if (req.path.startsWith('/api/admin') || req.path.startsWith('/admin')) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});
app.use((req, _res, next) => {
  req.cookies = {};
  const h = req.headers.cookie;
  if (h) for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i > -1) req.cookies[part.slice(0,i).trim()] = decodeURIComponent(part.slice(i+1).trim());
  }
  next();
});

// ---------- auth ----------
const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');
function validToken(tok) {
  if (!tok) return false;
  const i = tok.lastIndexOf('.');
  if (i < 0) return false;
  const payload = tok.slice(0, i), sig = tok.slice(i+1);
  const exp = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
  if (sig.length !== exp.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(exp))) return false;
  const parts = payload.split('.');
  const ts = parseInt(parts[0], 10);
  const maxAge = parts[2] === 'long' ? 30 * 24 * 3600 * 1000 : 7 * 24 * 3600 * 1000;
  return ts && (Date.now() - ts) < maxAge;
}
function makeToken(long = false) {
  const payload = `${Date.now()}.${crypto.randomBytes(8).toString('hex')}${long ? '.long' : ''}`;
  const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
  return `${payload}.${sig}`;
}
function requireAuth(req, res, next) {
  if (validToken(req.cookies.bf_session)) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    return next();
  }
  res.status(401).json({ error: 'unauthorized' });
}

const attempts = new Map();
function throttled(ip) { const a = attempts.get(ip); return a && a.until > Date.now(); }
function bump(ip, ok) {
  if (ok) { attempts.delete(ip); return; }
  const a = attempts.get(ip) || { n: 0, until: 0 };
  a.n++;
  if (a.n >= 5) { a.until = Date.now() + 10*60*1000; a.n = 0; }
  attempts.set(ip, a);
}

// ---------- auth routes ----------
app.post('/api/admin/login', (req, res) => {
  const ip = req.ip;
  if (throttled(ip)) return res.status(429).json({ error: 'too_many_attempts' });
  const ok = sha256(req.body?.password || '') === getPassHash();
  bump(ip, ok);
  audit(ip, ok ? 'login_ok' : 'login_fail', null);
  if (!ok) return res.status(401).json({ error: 'invalid_password' });
  const long = !!req.body?.remember;
  const maxAge = long ? 30*24*3600 : 7*24*3600;
  res.setHeader('Set-Cookie', `bf_session=${makeToken(long)}; HttpOnly; Path=/; Max-Age=${maxAge}; SameSite=Lax`);
  res.json({ ok: true });
});
app.post('/api/admin/logout', (_req, res) => {
  res.setHeader('Set-Cookie', 'bf_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax');
  res.json({ ok: true });
});
app.get('/api/admin/me', (req, res) => res.json({ authenticated: validToken(req.cookies.bf_session) }));

app.post('/api/admin/password', requireAuth, (req, res) => {
  const { current, next: nextPass } = req.body || {};
  if (!current || !nextPass) return res.status(400).json({ error: 'missing fields' });
  if (sha256(current) !== getPassHash()) return res.status(401).json({ error: 'wrong_current' });
  if (nextPass.length < 8) return res.status(400).json({ error: 'too_short' });
  setSetting('__pass_hash', sha256(nextPass));
  audit(req.ip, 'password_change', null);
  res.json({ ok: true });
});

// ---------- settings ----------
app.get('/api/admin/settings', requireAuth, (_req, res) => res.json(fullSettings()));
app.put('/api/admin/settings', requireAuth, (req, res) => {
  const body = req.body || {}, changed = [];
  for (const k of EDITABLE_KEYS) {
    if (body[k] && typeof body[k] === 'object') {
      setSetting(k, Object.assign({}, DEFAULTS[k], getSetting(k, {}), body[k]));
      changed.push(k);
    }
  }
  bumpPublishedAt();
  audit(req.ip, 'settings_save', { changed });
  res.json({ ok: true, changed, settings: fullSettings() });
});
app.get('/api/admin/audit', requireAuth, (_req, res) => {
  res.json(db.prepare('SELECT ts,ip,action,detail FROM audit ORDER BY id DESC LIMIT 200').all());
});

// ---------- dashboard stats ----------
app.get('/api/admin/stats', requireAuth, (_req, res) => {
  const games   = db.prepare("SELECT COUNT(*) as n FROM games WHERE status='published'").get().n;
  const drafts  = db.prepare("SELECT COUNT(*) as n FROM games WHERE status!='published'").get().n;
  const kik     = db.prepare('SELECT COUNT(*) as n FROM kik_projects').get().n;
  const kikGoal = db.prepare('SELECT COALESCE(SUM(goal),0) as n FROM kik_projects').get().n;
  const kikRaised = db.prepare('SELECT COALESCE(SUM(raised),0) as n FROM kik_projects').get().n;
  const backers = db.prepare('SELECT COALESCE(SUM(backers),0) as n FROM kik_projects').get().n;
  const lastAudit = db.prepare('SELECT ts,action FROM audit ORDER BY id DESC LIMIT 1').get();
  let uploads = 0;
  try { uploads = fs.readdirSync(UPLOADS).filter(f => !f.startsWith('.')).length; } catch {}
  res.json({ games, drafts, kik, kikGoal, kikRaised, backers, uploads, lastAudit });
});

// ---------- games CRUD ----------
function parseGallery(v) { try { return JSON.parse(v||'[]'); } catch { return []; } }
function gameRow(r) { return r ? { ...r, gallery: parseGallery(r.gallery), links: parseLinks(r.links) } : null; }
function isPublicGameStatus(status) {
  return !['draft', 'archived'].includes(String(status || 'published'));
}
function publicGames() {
  return gAll.all().filter(g => isPublicGameStatus(g.status)).map(gameRow);
}
function statusLabel(s) {
  return s==='draft'?'Чернетка':s==='archived'?'Архів':s==='preorder'?'Передзамовлення':s==='onsale'?'У продажі':'Анонс';
}
function gamePublicUrl(g) {
  return g.buy_url || `/igry/${g.slug}/`;
}
function generatedGameCard(g) {
  const title = escapeHtml(g.title || g.slug);
  const desc = escapeHtml(g.description || g.subtitle || '');
  const href = escapeHtml(gamePublicUrl(g));
  const cover = escapeHtml(g.cover_url || '/images/placeholder-game.svg');
  return `<a href="${href}" class="group relative flex h-full flex-col bg-white rounded-2xl sm:rounded-3xl overflow-hidden board-game-border transition-all duration-300 hover:-translate-y-1 hover:shadow-[0_28px_46px_-30px_rgba(15,23,42,0.45)]">
<div class="aspect-[4/3] relative overflow-hidden bg-slate-800">
<img src="${cover}" alt="${title}" class="absolute inset-0 h-full w-full object-cover" loading="lazy" decoding="async"/>
<div class="absolute inset-0 bg-gradient-to-t from-black/45 via-black/5 to-transparent"></div>
<div class="absolute bottom-3 sm:bottom-5 left-3 sm:left-5 right-3 sm:right-5 flex justify-between items-end gap-2">
<span class="board-game-badge inline-block px-3 sm:px-4 py-1.5 sm:py-2 rounded-lg bg-white/95 text-slate-700 text-xs sm:text-sm shadow-md backdrop-blur-sm border border-[var(--bf-accent)]/30">${statusLabel(g.status)}</span>
<span class="p-2.5 sm:p-3 rounded-xl bg-white/95 backdrop-blur-sm border border-white/60 shadow-sm text-bf" aria-hidden="true">→</span>
</div>
</div>
<div class="p-5 sm:p-7 lg:p-8 flex flex-col h-full">
<h2 class="text-lg sm:text-2xl lg:text-[1.8rem] font-bold group-hover:text-[var(--bf-accent)] transition-colors duration-300 mb-3 sm:mb-4 tracking-tight text-slate-800">${title}</h2>
<p class="text-slate-600 text-sm sm:text-lg leading-[1.7] mb-5 sm:mb-6">${desc}</p>
<span class="inline-flex items-center gap-2 text-[var(--bf-accent)] font-bold text-sm group-hover:gap-4 group-hover:text-[var(--teal-accent)] transition-all duration-300 mt-auto">Детальніше →</span>
</div>
</a>`;
}

function regenGamesCatalog() {
  const p = path.join(PAGES_ROOT, 'igry/index.html');
  if (!fs.existsSync(p)) return;
  let html = fs.readFileSync(p, 'utf8');

  const startIdx = html.indexOf('data-bf-games-grid="true"');
  if (startIdx === -1) return;
  const divStart = html.lastIndexOf('<div', startIdx);
  
  let depth = 0;
  let tagRegex = /<\/?div[^>]*>/gi;
  tagRegex.lastIndex = divStart;
  let match;
  let gridEnd = -1;
  while ((match = tagRegex.exec(html)) !== null) {
    if (match[0].startsWith('</')) depth--;
    else depth++;
    if (depth === 0) {
      gridEnd = match.index + match[0].length;
      break;
    }
  }
  
  if (gridEnd === -1) return;
  
  const gridOuterHTML = html.slice(divStart, gridEnd);
  const games = publicGames();
  const newCards = games.map(generatedGameCard);
  
  const firstCloseBracket = gridOuterHTML.indexOf('>');
  const newGridHTML = gridOuterHTML.slice(0, firstCloseBracket + 1) + newCards.join('') + '</div>';
  
  let newHtml = html.slice(0, divStart) + newGridHTML + html.slice(gridEnd);
  
  const countRegex = /(<span[^>]*>)\s*\d+\s*(ігри|гра|ігор)\s+в\s+каталозі\s*(<\/span>)/i;
  const word = games.length === 1 ? 'гра' : (games.length >= 2 && games.length <= 4 ? 'ігри' : 'ігор');
  newHtml = newHtml.replace(countRegex, `$1${games.length} ${word} в каталозі$3`);
  
  newHtml = newHtml.replace(/<script>window\.__BF_IGRY_HTML=[\s\S]*?<\/script>/i, '');
  
  if (newHtml !== html) writeAtomic(p, newHtml);
}

function cleanText(v) { return String(v ?? '').trim(); }
function escapeHtml(s) {
  return cleanText(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#x27;'}[c]));
}
// Minimal markdown: **bold** and _italic_ only. Always run AFTER escapeHtml
// so the raw text is already entity-safe before these get turned into tags —
// authors can't smuggle real markup through this.
function inlineMd(escaped) {
  return escaped
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/_(.+?)_/g, '<em>$1</em>');
}
function renderDescriptionBlocks(text) {
  const blocks = String(text || '').split(/\n\s*\n/).map(b => b.trim()).filter(Boolean);
  if (!blocks.length) return '<p>Опис гри скоро з\'явиться.</p>';
  return blocks.map(block => {
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length > 1 && lines.every(l => l.startsWith('- '))) {
      return `<ul class="bfg-list">${lines.map(l => `<li>${inlineMd(escapeHtml(l.slice(2)))}</li>`).join('')}</ul>`;
    }
    return `<p>${inlineMd(escapeHtml(lines.join(' ')))}</p>`;
  }).join('');
}
function renderGallerySection(gallery, title) {
  if (!gallery || !gallery.length) return '';
  const items = gallery.map(url => `<div class="bfg-gallery-item"><img src="${escapeHtml(url)}" alt="${escapeHtml(title)}" loading="lazy"></div>`).join('');
  return `<section class="bfg-gallery"><div class="bfg-gallery-inner"><h2 class="bfg-section-title">Галерея</h2><div class="bfg-gallery-grid">${items}</div></div></section>`;
}
function renderComponentsSection(components){
  const lines = String(components||'').split('\n').map(l=>l.trim()).filter(Boolean);
  if(!lines.length) return '';
  const items = lines.map(l => `<li>${inlineMd(escapeHtml(l.replace(/^- /,'')))}</li>`).join('');
  return `<section class="bfg-components"><div class="bfg-components-inner"><h2 class="bfg-section-title">У коробці</h2><ul class="bfg-list">${items}</ul></div></section>`;
}
function generatedGameHtml(g) {
  const title = escapeHtml(g.title || g.slug);
  const subtitle = escapeHtml(g.subtitle || g.players || 'Настільна гра Blue Ferret');
  const cover = escapeHtml(g.cover_url || '/images/placeholder-game.svg');
  const statusRaw = (g.status || 'published');
  const statusLabel = statusRaw === 'draft' ? 'Чернетка' : statusRaw === 'archived' ? 'Архів' : statusRaw === 'preorder' ? 'Передзамовлення' : statusRaw === 'onsale' ? 'У продажі' : 'Анонс';
  const players = escapeHtml(g.players || '');
  const age = escapeHtml(g.age || '');
  const duration = escapeHtml(g.duration || '');
  const buy = escapeHtml(g.buy_url || '');
  const designer = escapeHtml(g.designer || '');
  const chips = [players && `<span class="bf-chip">👥 ${players}</span>`, age && `<span class="bf-chip">🎂 ${age}</span>`, duration && `<span class="bf-chip">⏱ ${duration}</span>`, designer && `<span class="bf-chip">✏️ ${designer}</span>`].filter(Boolean).join('');
  const extraLinks = (Array.isArray(g.links) ? g.links : parseLinks(g.links))
    .map(l => `<a class="bfg-btn secondary" href="${escapeHtml(l.url)}">${escapeHtml(l.label)}</a>`).join('');
  const metaDesc = escapeHtml(String(g.description || '').split(/\n\s*\n/)[0] || 'Опис гри скоро з\'явиться.').replace(/^- /, '');
  return `<!doctype html>
<html lang="uk">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${title} | Blue Ferret</title>
<meta name="description" content="${metaDesc.slice(0, 155)}">
<link rel="canonical" href="https://blueferret.com.ua/igry/${escapeHtml(g.slug)}/">
<meta property="og:title" content="${title} | Blue Ferret">
<meta property="og:description" content="${metaDesc.slice(0, 155)}">
<meta property="og:url" content="https://blueferret.com.ua/igry/${escapeHtml(g.slug)}/">
<meta property="og:type" content="website">
<meta property="og:image" content="${cover.startsWith('http') ? cover : 'https://blueferret.com.ua' + cover}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${title} | Blue Ferret">
<link rel="shortcut icon" href="/favicon.ico">
<link rel="stylesheet" href="/_next/static/css/a80874b32dc71380.css">
<link rel="stylesheet" href="/bf.css?v=8">
<style>
body{margin:0;background:#f8fbff;color:#0f172a;font-family:Inter,system-ui,sans-serif}
.bfg-wrap{min-height:100vh;background:radial-gradient(ellipse 100% 70% at 50% -10%,rgba(0,159,227,.18),transparent 60%),linear-gradient(135deg,#f6fbff,#fff,#eefaf3)}
.bfg-header{background:#0a0f1a/98;backdrop-filter:blur(24px);border-bottom:1px solid rgba(255,255,255,.05);position:sticky;top:0;z-index:50}
.bfg-nav{max-width:1120px;margin:0 auto;padding:0 18px;display:flex;justify-content:space-between;align-items:center;height:64px}
.bfg-logo{display:flex;align-items:center;gap:12px;text-decoration:none;color:#fff}
.bfg-logo img{width:40px;height:40px;object-fit:contain}
.bfg-logo-text{display:flex;flex-direction:column}
.bfg-logo-name{font-weight:800;font-size:15px;color:#fff;letter-spacing:-.01em}
.bfg-logo-sub{font-size:10px;text-transform:uppercase;letter-spacing:.18em;color:#94a3b8}
.bfg-nav-links{display:flex;align-items:center;gap:4px}
.bfg-nav-links a{color:#94a3b8;text-decoration:none;font-weight:500;font-size:14px;padding:8px 14px;border-radius:10px;transition:all .2s}
.bfg-nav-links a:hover{color:#fff;background:rgba(255,255,255,.1)}
.bfg-nav-links a.active{color:#fff;background:rgba(255,255,255,.12)}
.bfg-shell{max-width:1120px;margin:0 auto;padding:56px 18px 100px;display:grid;grid-template-columns:minmax(0,1.1fr) minmax(280px,.9fr);gap:48px;align-items:center}
.bfg-copy{padding:24px 0}
.bfg-kicker{display:inline-flex;align-items:center;gap:8px;border:1px solid rgba(0,159,227,.25);background:rgba(0,159,227,.08);border-radius:999px;padding:8px 16px;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.1em;color:#0369a1;margin-bottom:20px}
.bfg-title{font-size:clamp(40px,7vw,88px);line-height:.9;letter-spacing:-.055em;margin:0 0 20px;font-weight:900;color:#0f172a}
.bfg-sub{font-size:clamp(17px,2.2vw,24px);line-height:1.35;color:#334155;margin:0 0 18px;max-width:620px}
.bfg-desc{font-size:16px;line-height:1.8;color:#475569;max-width:660px}
.bfg-desc p{margin:0 0 14px}
.bfg-desc p:last-child{margin-bottom:0}
.bfg-list{margin:0 0 14px;padding-left:20px}
.bfg-list li{margin-bottom:4px}
.bfg-components{padding:10px 18px 20px}
.bfg-components-inner{max-width:1120px;margin:0 auto}
.bfg-components-inner .bfg-list{columns:2;column-gap:32px;font-size:16px;color:#334155}
.bfg-components-inner .bfg-list li{break-inside:avoid;margin-bottom:8px}
@media(max-width:640px){.bfg-components-inner .bfg-list{columns:1}}
.bfg-gallery{padding:10px 18px 100px}
.bfg-gallery-inner{max-width:1120px;margin:0 auto}
.bfg-section-title{font-size:clamp(24px,3.5vw,34px);font-weight:900;color:#0f172a;margin:0 0 24px;letter-spacing:-.03em}
.bfg-gallery-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:16px}
.bfg-gallery-item{border-radius:16px;overflow:hidden;background:#0f172a;box-shadow:0 14px 34px -18px rgba(15,23,42,.35)}
.bfg-gallery-item img{width:100%;aspect-ratio:4/3;object-fit:cover;display:block}
.bfg-chips{display:flex;flex-wrap:wrap;gap:10px;margin:24px 0}
.bfg-chip{display:inline-flex;align-items:center;gap:6px;border:1px solid #dbeafe;background:#fff;border-radius:12px;padding:8px 14px;font-size:13px;font-weight:600;color:#1e3a8a;box-shadow:0 1px 3px rgba(0,0,0,.06)}
.bfg-actions{display:flex;flex-wrap:wrap;gap:12px;margin-top:32px}
.bfg-btn{display:inline-flex;align-items:center;justify-content:center;min-height:48px;padding:0 24px;border-radius:14px;text-decoration:none;font-weight:700;font-size:15px;transition:all .2s}
.bfg-btn.primary{background:#009fe3;color:#fff;box-shadow:0 12px 30px -12px rgba(0,159,227,.7)}
.bfg-btn.primary:hover{background:#0088c4;transform:translateY(-1px)}
.bfg-btn.secondary{background:#fff;color:#0f172a;border:1px solid #cbd5e1}
.bfg-btn.secondary:hover{border-color:#009fe3;color:#009fe3}
.bfg-cover{background:#0f172a;border-radius:24px;box-shadow:0 30px 70px -30px rgba(15,23,42,.6);overflow:hidden;aspect-ratio:4/3;position:relative}
.bfg-cover img{width:100%;height:100%;object-fit:cover;display:block}
.bfg-footer{background:linear-gradient(to bottom,#0f172a,#0a0f1a);padding:60px 18px 40px;text-align:center;margin-top:80px}
.bfg-footer-inner{max-width:600px;margin:0 auto}
.bfg-footer p{color:#64748b;font-size:14px;margin:0}
.bfg-footer a{color:#009fe3;text-decoration:none}
@media(max-width:800px){.bfg-shell{grid-template-columns:1fr;padding-top:28px;gap:32px}.bfg-cover{order:-1;border-radius:18px}.bfg-title{font-size:clamp(36px,10vw,60px)}.bfg-nav-links{display:none}}
</style>
</head>
<body>
<div class="bfg-wrap" data-bf-generated-game="true">
  <header class="bfg-header">
    <nav class="bfg-nav">
      <a class="bfg-logo" href="/">
        <img src="/logo-blue-ferret.png" alt="Blue Ferret">
        <div class="bfg-logo-text">
          <span class="bfg-logo-name">BLUE FERRET</span>
          <span class="bfg-logo-sub">видавництво</span>
        </div>
      </a>
      <div class="bfg-nav-links">
        <a href="/">Головна</a>
        <a href="/igry/" class="active">Наші ігри</a>
        <a href="/kontakty/">Контакти</a>
      </div>
    </nav>
  </header>
  <section class="bfg-shell">
    <div class="bfg-copy">
      <span class="bfg-kicker">${statusLabel}</span>
      <h1 class="bfg-title">${title}</h1>
      <p class="bfg-sub">${subtitle}</p>
      <div class="bfg-desc">${renderDescriptionBlocks(g.description)}</div>
      <div class="bfg-chips">${chips}</div>
      <div class="bfg-actions">
        ${buy ? `<a class="bfg-btn primary" href="${buy}">Придбати →</a>` : ''}
        ${extraLinks}
        <a class="bfg-btn secondary" href="/igry/">← Назад до каталогу</a>
      </div>
    </div>
    <figure class="bfg-cover">
      <img src="${cover}" alt="${title}" loading="eager">
    </figure>
  </section>
  ${renderComponentsSection(g.components)}
  ${renderGallerySection(g.gallery, title)}
  <footer class="bfg-footer">
    <div class="bfg-footer-inner">
      <p>© 2026 <a href="/">Blue Ferret</a> — Незалежне видавництво настільних ігор</p>
    </div>
  </footer>
</div>
<script src="/api/public/runtime.js" defer></script>
</body>
</html>`;
}
function writeGeneratedGamePage(row) {
  const g = gameRow(row);
  if (!g || !g.slug) return;
  if (!isPublicGameStatus(g.status)) {
    removeGeneratedGamePage(g.slug);
    return;
  }
  const file = path.join(SITE_ROOT, 'igry', g.slug, 'index.html');
  const nextHtml = generatedGameHtml(g);
  if (fs.existsSync(file)) {
    const existing = fs.readFileSync(file, 'utf8');
    if (existing === nextHtml) return;
    // A page at this slug that doesn't carry our marker is a hand-crafted
    // page (e.g. a real Next.js-rendered design) placed here outside the
    // CMS — never clobber it with the generic generated template.
    if (!existing.includes('data-bf-generated-game="true"')) return;
    writeBackup(file);
  }
  writeAtomic(file, nextHtml);
}
function removeGeneratedGamePage(slug) {
  if (!slug) return;
  const dir = path.join(SITE_ROOT, 'igry', slug);
  const file = path.join(dir, 'index.html');
  if (!file.startsWith(path.join(SITE_ROOT, 'igry'))) return;
  if (!fs.existsSync(file)) return;
  const existing = fs.readFileSync(file, 'utf8');
  if (!existing.includes('data-bf-generated-game="true"')) return;
  fs.unlinkSync(file);
  try { fs.rmdirSync(dir); } catch {}
}

const gAll  = db.prepare('SELECT * FROM games ORDER BY sort_order,id');
const gOne  = db.prepare('SELECT * FROM games WHERE id=?');
const gSlug = db.prepare('SELECT * FROM games WHERE slug=?');
const gIns  = db.prepare(`INSERT INTO games(slug,title,subtitle,description,status,cover_url,gallery,players,age,duration,buy_url,designer,components,links,sort_order,created_at,updated_at)
  VALUES(@slug,@title,@subtitle,@description,@status,@cover_url,@gallery,@players,@age,@duration,@buy_url,@designer,@components,@links,@sort_order,@t,@t)`);
const gUpd  = db.prepare(`UPDATE games SET slug=@slug,title=@title,subtitle=@subtitle,description=@description,status=@status,cover_url=@cover_url,gallery=@gallery,players=@players,age=@age,duration=@duration,buy_url=@buy_url,designer=@designer,components=@components,links=@links,sort_order=@sort_order,updated_at=@t WHERE id=@id`);
const gDel  = db.prepare('DELETE FROM games WHERE id=?');

function syncPublicGames() {
  const rows = gAll.all();
  for (const row of rows) writeGeneratedGamePage(row);
  regenGamesCatalog();
  try { execFileSync('restorecon',['-R',SITE_ROOT],{stdio:'ignore',timeout:15000}); } catch {}
}

function parseLinks(v) {
  const arr = Array.isArray(v) ? v : (() => { try { return JSON.parse(v||'[]'); } catch { return []; } })();
  return arr
    .map(l => ({ label: cleanText(l && l.label), url: cleanText(l && l.url) }))
    .filter(l => l.label && l.url);
}
function gameBody(b, ex={}) {
  const rawSlug = (b.slug||ex.slug||b.title||'').toLowerCase().replace(/[^a-zа-яіїєґ0-9]+/gi,'-').replace(/^-|-$/g,'');
  const slug = rawSlug || `game-${Date.now()}`;
  const gallery = Array.isArray(b.gallery) ? b.gallery : parseGallery(ex.gallery);
  const links = b.links !== undefined ? parseLinks(b.links) : parseLinks(ex.links);
  return { slug, title:cleanText(b.title??ex.title), subtitle:cleanText(b.subtitle??ex.subtitle??''), description:cleanText(b.description??ex.description??''),
    status:b.status||ex.status||'published', cover_url:cleanText(b.cover_url??ex.cover_url??''),
    gallery:JSON.stringify(gallery), players:cleanText(b.players??ex.players??''),
    age:cleanText(b.age??ex.age??''), duration:cleanText(b.duration??ex.duration??''), buy_url:cleanText(b.buy_url??ex.buy_url??''),
    designer:cleanText(b.designer??ex.designer??''), components:cleanText(b.components??ex.components??''),
    links:JSON.stringify(links),
    sort_order:b.sort_order??ex.sort_order??0, t:Date.now() };
}

app.get('/api/admin/games', requireAuth, (_r, res) => res.json(gAll.all().map(gameRow)));
app.get('/api/admin/games/:id', requireAuth, (req, res) => {
  const r = gOne.get(+req.params.id); if (!r) return res.status(404).json({error:'not_found'}); res.json(gameRow(r));
});
app.post('/api/admin/games', requireAuth, (req, res) => {
  const b = req.body||{};
  if (!b.title) return res.status(400).json({error:'title required'});
  const data = gameBody(b);
  if (gSlug.get(data.slug)) return res.status(409).json({error:'slug_exists'});
  const info = gIns.run(data);
  syncPublicGames();
  const publishedAt = bumpPublishedAt();
  audit(req.ip,'game_create',{id:info.lastInsertRowid,slug:data.slug,publishedAt});
  res.status(201).json({...gameRow(gOne.get(info.lastInsertRowid)), publishedAt});
});
app.put('/api/admin/games/:id', requireAuth, (req, res) => {
  const id=+req.params.id, ex=gOne.get(id);
  if (!ex) return res.status(404).json({error:'not_found'});
  const data = gameBody(req.body||{}, ex);
  const c = gSlug.get(data.slug);
  if (c && c.id!==id) return res.status(409).json({error:'slug_exists'});
  gUpd.run({...data,id});
  if (ex.slug !== data.slug) removeGeneratedGamePage(ex.slug);
  syncPublicGames();
  const publishedAt = bumpPublishedAt();
  audit(req.ip,'game_update',{id,publishedAt});
  res.json({...gameRow(gOne.get(id)), publishedAt});
});
app.delete('/api/admin/games/:id', requireAuth, (req, res) => {
  const id=+req.params.id;
  const ex = gOne.get(id);
  if (!ex) return res.status(404).json({error:'not_found'});
  removeGeneratedGamePage(ex.slug);
  gDel.run(id);
  syncPublicGames();
  const publishedAt = bumpPublishedAt();
  audit(req.ip,'game_delete',{id,publishedAt});
  res.json({ok:true,publishedAt});
});

app.post('/api/admin/games/:id/duplicate', requireAuth, (req, res) => {
  const id=+req.params.id, ex=gOne.get(id);
  if (!ex) return res.status(404).json({error:'not_found'});
  const base = slugify(`${ex.slug || ex.title}-copy`) || `game-${Date.now()}`;
  let slug = base, i = 2;
  while (gSlug.get(slug)) slug = `${base}-${i++}`;
  const data = gameBody({
    ...ex,
    slug,
    title: `${ex.title || 'Гра'} копія`,
    status: 'draft',
    gallery: parseGallery(ex.gallery),
    sort_order: Number(ex.sort_order || 0) + 1,
  });
  const info = gIns.run(data);
  syncPublicGames();
  const publishedAt = bumpPublishedAt();
  audit(req.ip,'game_duplicate',{from:id,id:info.lastInsertRowid,slug,publishedAt});
  res.status(201).json({...gameRow(gOne.get(info.lastInsertRowid)), publishedAt});
});

app.post('/api/admin/sync-public', requireAuth, (req, res) => {
  syncPublicGames();
  regenKikCatalog();
  const publishedAt = bumpPublishedAt();
  audit(req.ip, 'sync_public', { publishedAt });
  res.json({ ok: true, publishedAt, games: publicGames().length });
});

// ---------- KIK CRUD ----------
const kAll = db.prepare('SELECT * FROM kik_projects ORDER BY sort_order,id');
const kOne = db.prepare('SELECT * FROM kik_projects WHERE id=?');
const kIns = db.prepare(`INSERT INTO kik_projects(title,subtitle,description,status,goal,raised,backers,cover_url,campaign_url,ends_at,sort_order,created_at,updated_at)
  VALUES(@title,@subtitle,@description,@status,@goal,@raised,@backers,@cover_url,@campaign_url,@ends_at,@sort_order,@t,@t)`);
const kUpd = db.prepare(`UPDATE kik_projects SET title=@title,subtitle=@subtitle,description=@description,status=@status,goal=@goal,raised=@raised,backers=@backers,cover_url=@cover_url,campaign_url=@campaign_url,ends_at=@ends_at,sort_order=@sort_order,updated_at=@t WHERE id=@id`);
const kDel = db.prepare('DELETE FROM kik_projects WHERE id=?');

function kikBody(b, ex={}) {
  return { title:b.title??ex.title, subtitle:b.subtitle??ex.subtitle??'', description:b.description??ex.description??'',
    status:b.status||ex.status||'active', goal:+(b.goal??ex.goal??0), raised:+(b.raised??ex.raised??0),
    backers:+(b.backers??ex.backers??0), cover_url:b.cover_url??ex.cover_url??'',
    campaign_url:b.campaign_url??ex.campaign_url??'',
    ends_at:b.ends_at!=null?b.ends_at:ex.ends_at??null,
    sort_order:+(b.sort_order??ex.sort_order??0), t:Date.now() };
}

function regenKikCatalog() {
  const kikIndexFile = path.join(SITE_DIR, 'kik', 'proekty', 'index.html');
  if (!fs.existsSync(kikIndexFile)) return;

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
    let doc = fs.readFileSync(kikIndexFile, 'utf8');
    doc = doc.replace(/(<header[^>]*>.*?<\/header>)\s*<main>[\s\S]*?(?=<\/main>\s*<\/div>\s*<\/main>)/, '$1<main>' + html);
    writeAtomic(kikIndexFile, doc);
  } catch (err) {
    console.error('Failed to regenerate KIK catalog', err);
  }
}

app.get('/api/admin/kik', requireAuth, (_r, res) => res.json(kAll.all()));
app.get('/api/admin/kik/:id', requireAuth, (req, res) => {
  const r=kOne.get(+req.params.id); if(!r) return res.status(404).json({error:'not_found'}); res.json(r);
});
app.post('/api/admin/kik', requireAuth, (req, res) => {
  const b=req.body||{}; if(!b.title) return res.status(400).json({error:'title required'});
  const data=kikBody(b); const info=kIns.run(data);
  regenKikCatalog();
  const publishedAt = bumpPublishedAt();
  audit(req.ip,'kik_create',{id:info.lastInsertRowid,title:data.title,publishedAt});
  res.status(201).json({...kOne.get(info.lastInsertRowid), publishedAt});
});
app.put('/api/admin/kik/:id', requireAuth, (req, res) => {
  const id=+req.params.id, ex=kOne.get(id);
  if(!ex) return res.status(404).json({error:'not_found'});
  const data=kikBody(req.body||{},ex); kUpd.run({...data,id});
  regenKikCatalog();
  const publishedAt = bumpPublishedAt();
  audit(req.ip,'kik_update',{id,publishedAt}); res.json({...kOne.get(id), publishedAt});
});
app.delete('/api/admin/kik/:id', requireAuth, (req, res) => {
  const id=+req.params.id;
  if(!kOne.get(id)) return res.status(404).json({error:'not_found'});
  kDel.run(id); 
  regenKikCatalog();
  const publishedAt = bumpPublishedAt(); audit(req.ip,'kik_delete',{id,publishedAt}); res.json({ok:true,publishedAt});
});

// ---------- media upload ----------
const storage = multer.diskStorage({
  destination: (_req, _f, cb) => cb(null, UPLOADS),
  filename: (_req, file, cb) => {
    const ext  = path.extname(file.originalname).toLowerCase();
    const base = path.basename(file.originalname, ext).replace(/[^a-z0-9а-яіїєґ]/gi,'-').replace(/^-+|-+$/g,'').slice(0,40) || 'media';
    cb(null, `${base}-${Date.now()}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 10*1024*1024 },
  fileFilter: (_r, f, cb) => {
    if (!/\.(jpe?g|png|webp|gif|svg|avif)$/i.test(f.originalname)) {
      const err = new Error('unsupported_file_type');
      err.statusCode = 415;
      return cb(err);
    }
    cb(null, true);
  },
});

app.post('/api/admin/upload', requireAuth, (req, res, next) => {
  upload.single('file')(req, res, err => {
    if (err) return next(err);
    next();
  });
}, (req, res) => {
  if (!req.file) return res.status(400).json({error:'no file'});
  const url = `/uploads/${req.file.filename}`;
  audit(req.ip,'upload',{url});
  res.json({ ok:true, url, filename:req.file.filename, size:req.file.size });
});

const IMAGE_EXT_RE = /\.(jpe?g|png|webp|gif|svg|avif)$/i;
// Walks SITE_ROOT/images (game art, characters, etc. — assets that were
// deployed straight to disk rather than through the upload button) so they
// show up as pickable/browsable, even though only /uploads files can be
// deleted through this admin.
function walkStaticImages(dir, base) {
  let out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) {
      out = out.concat(walkStaticImages(full, rel));
    } else if (IMAGE_EXT_RE.test(e.name)) {
      const stat = fs.statSync(full);
      out.push({ filename: rel, url: `/images/${rel}`, size: stat.size, mtime: stat.mtimeMs, deletable: false });
    }
  }
  return out;
}
app.get('/api/admin/media', requireAuth, (_req, res) => {
  try {
    const uploaded = fs.readdirSync(UPLOADS)
      .filter(f => !f.startsWith('.') && IMAGE_EXT_RE.test(f))
      .map(f => {
        const stat = fs.statSync(path.join(UPLOADS, f));
        return { filename:f, url:`/uploads/${f}`, size:stat.size, mtime:stat.mtimeMs, deletable: true };
      });
    const staticImages = walkStaticImages(path.join(SITE_ROOT, 'images'), '');
    res.json([...uploaded, ...staticImages].sort((a,b) => b.mtime - a.mtime));
  } catch { res.json([]); }
});

app.delete('/api/admin/media/:filename', requireAuth, (req, res) => {
  const filename = path.basename(req.params.filename);
  const full = path.join(UPLOADS, filename);
  if (!fs.existsSync(full)) return res.status(404).json({error:'not_found'});
  fs.unlinkSync(full);
  audit(req.ip,'media_delete',{filename});
  res.json({ok:true});
});

// ---------- pages editor ----------
const PAGES_ROOT = SITE_ROOT;
function listPages() {
  const pages = [];
  function walk(dir, rel='') {
    let items;
    try { items = fs.readdirSync(dir); } catch { return; }
    for (const f of items) {
      if (f.startsWith('.') || f.startsWith('_next') || f==='uploads' || f==='cdn-cgi') continue;
      const full = path.join(dir,f), r2 = rel ? `${rel}/${f}` : f;
      const stat = fs.statSync(full);
      if (stat.isDirectory()) walk(full, r2);
      else if (f==='index.html') pages.push({ path: rel||'/', file: r2, mtime: stat.mtimeMs });
    }
  }
  walk(PAGES_ROOT);
  return pages.sort((a,b)=>a.path.localeCompare(b.path));
}

// ---- page block extractor ----
function decodeHtmlEnts(s){
  return s.replace(/&#x27;/g,"'").replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#(\d+);/gi,(_,n)=>String.fromCharCode(+n));
}
function encodeHtmlEnts(s){
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#x27;');
}
// Paragraph text edited in the page editor may contain a <a href="...">text</a>
// span (insert-link button) or a <strong>text</strong>/<em>text</em> span
// (bold/italic buttons). Only these exact, simple, non-nested patterns are
// allowed through as real markup — everything else (including any other
// stray angle brackets the user typed) gets HTML-encoded, so a plain
// textarea can carry a small safe set of inline HTML without becoming an
// XSS hole.
function sanitizeUserHtml(v){
  const re=/<a href="([^"<>]*)">([^<>]*)<\/a>|<(strong|em)>([^<>]*)<\/\3>/g;
  let out='', last=0, m;
  while((m=re.exec(v))!==null){
    out += encodeHtmlEnts(v.slice(last, m.index));
    if(m[3]){
      out += `<${m[3]}>${encodeHtmlEnts(m[4])}</${m[3]}>`;
    } else {
      const href=m[1];
      out += /^\s*(javascript|data):/i.test(href) ? encodeHtmlEnts(m[0]) : `<a href="${encodeHtmlEnts(href)}">${encodeHtmlEnts(m[2])}</a>`;
    }
    last = re.lastIndex;
  }
  out += encodeHtmlEnts(v.slice(last));
  return out;
}
function cleanInner(raw){
  // strip tags inserting spaces so adjacent elements don't concatenate, collapse whitespace
  return decodeHtmlEnts(raw.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim());
}
function hasNestedTag(raw){ return /<[a-z]/i.test(raw); }

function hasOnlyInlineTags(raw){
  // Returns true if nested tags are only simple inline (strong, em, a, b, i, br, span)
  const tags = raw.match(/<([a-z][a-z0-9]*)/gi);
  if(!tags) return true;
  const allowed = new Set(['strong','em','a','b','i','br','span','small','mark','u','s','sub','sup']);
  return tags.every(t => allowed.has(t.slice(1).toLowerCase()));
}

function flattenSiteContentValues(obj){
  const out=new Set();
  function rec(o){
    if(typeof o==='string'){ if(o.trim()) out.add(o.trim()); return; }
    if(Array.isArray(o)){ o.forEach(rec); return; }
    if(o&&typeof o==='object'){ for(const k of Object.keys(o)) rec(o[k]); }
  }
  rec(obj);
  return out;
}
function extractBlocks(html, managedValues){
  // strip non-content regions so their text never leaks into blocks
  const safe = html
    .replace(/<script[\s\S]*?<\/script>/gi,'')
    .replace(/<style[\s\S]*?<\/style>/gi,'')
    .replace(/<svg[\s\S]*?<\/svg>/gi,'')
    .replace(/<header[\s\S]*?<\/header>/gi,'')
    .replace(/<nav[\s\S]*?<\/nav>/gi,'')
    .replace(/<footer[\s\S]*?<\/footer>/gi,'');
  const headOnly = html.slice(0, html.indexOf('</head>')+7 || 2000);

  // Orphaned titles from the homepage's fallbackPillars/fallbackCta cards —
  // superseded by "Тексти сайту" (home.fallbackPillars[].title etc.) but the
  // old words are still sitting in the static HTML with nothing pointing at
  // them, so value-matching against managedValues can't catch them (the
  // current title text is different words entirely). Listed explicitly so
  // they stop appearing as if they were live-editable.
  const ORPHANED_TEXT = new Set(['Досліджуйте','Підтримуйте','Створюйте']);

  // Same idea as ORPHANED_TEXT/managedValues but for text that's *drifted*
  // rather than staying byte-identical (e.g. a card description that's since
  // been trimmed in site-content.json but still has its old, longer wording
  // sitting in the static HTML) — an exact-match Set can't catch that, so
  // fall back to substring containment against the live values. Normalize
  // dash variants/whitespace first since "-" vs "—" alone would otherwise
  // defeat the containment check.
  const normForMatch = s => s.replace(/[-–—]/g,'-').replace(/\s+/g,' ').trim();
  const managedList = managedValues ? [...managedValues].filter(v=>v.length>=12).map(normForMatch) : [];
  function driftedFromManaged(v){
    const nv = normForMatch(v);
    return managedList.some(m => nv.includes(m) || m.includes(nv));
  }

  const blocks=[], seenText=new Set();
  const add=(id,type,label,icon,value,orig,origVal,idx,extra)=>{
    const v=(value||'').trim();
    if(!v) return;
    // Text also present in site-content.json is live-hydrated from there and
    // overwritten on every page load — editing the static HTML copy here
    // would silently do nothing, so skip it in favor of "Тексти сайту".
    if(type!=='seo' && managedValues && managedValues.has(v)) return;
    if((type==='p'||type==='h1'||type==='h2'||type==='h3') && driftedFromManaged(v)) return;
    if(type==='h3' && ORPHANED_TEXT.has(v)) return;
    // Links with identical visible text but different hrefs must stay distinct
    // (e.g. two "Детальніше" buttons pointing at different pages) — dedup key
    // includes href for 'a' blocks, not just the visible text.
    const key=type+'|'+v+(type==='a'?'|'+(extra&&extra.href||''):'');
    if(seenText.has(key)) return; seenText.add(key);
    blocks.push({id,type,label,icon,value:v,orig,origVal,domIndex:idx,...(extra||{})});
  };

  // ── SEO (from <head>) ──
  const tm=headOnly.match(/<title>([^<]+)<\/title>/);
  if(tm) add('title','seo','Заголовок сторінки (SEO)','🔍',decodeHtmlEnts(tm[1]),tm[0],tm[1]);
  const otm=headOnly.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/);
  if(otm) add('og_title','seo','OG Title (соцмережі)','📲',decodeHtmlEnts(otm[1]),otm[0],otm[1]);
  const dm=headOnly.match(/<meta[^>]+name="description"[^>]+content="([^"]+)"/);
  if(dm) add('meta_desc','seo','Meta Description','📝',decodeHtmlEnts(dm[1]),dm[0],dm[1]);

  let m;
  // ── Headings (allow nested inline tags, clean with spaces) ──
  for(const tag of ['h1','h2','h3']){
    const re=new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`,'gi');
    let i=0;
    while((m=re.exec(safe))!==null){
      const t=cleanInner(m[1]);
      if(t && t.length>=2 && t.length<=160){
        add(`${tag}_${i}`, tag, tag==='h1'?'Заголовок H1':tag==='h2'?'Заголовок H2':'Підзаголовок',
            tag==='h1'?'H₁':tag==='h2'?'H₂':'H₃', t, m[0], m[1], i);
      }
      i++;
    }
  }

  // ── Paragraphs — allow <p> with simple inline tags (strong, em, a) ──
  // Cap raised from 14→80: pages with more real content (e.g. the homepage,
  // which has 20+ genuine paragraphs) were silently losing the tail past the
  // old cap — "editor has way fewer blocks than the page actually has" bug.
  // The lookahead after "p" is required: without it, [^>]* also matches
  // <path (SVG icon elements — this page is full of them), so the "opening
  // tag" match latches onto a <path ...> and then swallows everything up to
  // the NEXT real </p>, fusing several unrelated elements' text into one
  // garbled block. Editing/saving that block then replaces the whole
  // swallowed span, silently deleting the other elements caught in it —
  // this is the "several text blocks disappeared after editing one" bug.
  const pr=/<p(?=[\s>])[^>]*>([\s\S]*?)<\/p>/gi; let pi=0, kept=0;
  while((m=pr.exec(safe))!==null && kept<80){
    const inner=m[1];
    const t=cleanInner(inner);
    // Allow paragraphs with simple inline tags (strong, em, a, etc.). Tag-based
    // concatenation garbage (nav/footer link lists jammed together) is already
    // excluded above/here via inlineOk — a bare lowercase→Uppercase heuristic
    // was tried here previously but rejected genuinely edited paragraphs
    // outright (e.g. a proper noun typed without a leading space), making the
    // whole block silently vanish from the editor on next load.
    const inlineOk = !hasNestedTag(inner) || hasOnlyInlineTags(inner);
    if(t && inlineOk && t.includes(' ') && t.length>=20 && t.length<=900){
      add(`p_${pi}`,'p','Абзац тексту','¶',t,m[0],inner,pi);
      kept++;
    }
    pi++;
  }

  // ── Links (<a> with meaningful text) ──
  const ar=/<a[^>]*>([\s\S]*?)<\/a>/gi; let ai=0, aKept=0;
  while((m=ar.exec(safe))!==null && aKept<60){
    const inner=m[1];
    const t=cleanInner(inner);
    // Card-style anchors that wrap a whole heading+paragraph produce a huge
    // concatenated "link text" that isn't really editable link text — same
    // inline-only guard used for paragraphs.
    const inlineOk = !hasNestedTag(inner) || hasOnlyInlineTags(inner);
    const hrefM=m[0].match(/\shref="([^"]*)"/);
    const href=hrefM?decodeHtmlEnts(hrefM[1]):'';
    if(t && inlineOk && t.length>=3 && t.length<=120 && !/<img/i.test(inner) && href){
      add(`a_${ai}`,'a','Посилання / кнопка','🔗',t,m[0],inner,ai,{href});
      aKept++;
    }
    ai++;
  }

  // ── Spans with meaningful text (badges, labels) ──
  const sr=/<span[^>]*>([^<]{4,80})<\/span>/gi; let si=0, sKept=0;
  while((m=sr.exec(safe))!==null && sKept<50){
    const t=decodeHtmlEnts(m[1]).trim();
    // skip very short or numeric-only spans
    if(t && t.length>=4 && t.length<=80 && /[а-яіїєa-z]/i.test(t)){
      add(`span_${si}`,'span','Мітка / бейдж','🏷',t,m[0],m[1],si);
      sKept++;
    }
    si++;
  }

  // ── Images (<img> with src) ──
  const ir=/<img[^>]+src="([^"]+)"[^>]*>/gi; let ii=0, iKept=0;
  while((m=ir.exec(safe))!==null && iKept<50){
    const src=decodeHtmlEnts(m[1]).trim();
    // skip tiny icons, data URIs, tracking pixels
    if(src && !src.startsWith('data:') && src.length>5 && !/favicon|icon/i.test(src)){
      const alt=(m[0].match(/alt="([^"]*)"/)||[])[1]||'';
      add(`img_${ii}`,'img',decodeHtmlEnts(alt)||'Зображення','🖼',src,m[0],m[1],ii,{alt:decodeHtmlEnts(alt)});
      iKept++;
    }
    ii++;
  }

  // ── List items (<li>) ──
  const lr=/<li[^>]*>([\s\S]*?)<\/li>/gi; let li=0, lKept=0;
  while((m=lr.exec(safe))!==null && lKept<50){
    const t=cleanInner(m[1]);
    if(t && t.length>=4 && t.length<=200 && t.includes(' ')){
      add(`li_${li}`,'li','Елемент списку','📌',t,m[0],m[1],li);
      lKept++;
    }
    li++;
  }

  return blocks;
}

app.get('/api/admin/pages', requireAuth, (_req, res) => res.json(listPages()));

// ── create page ──
function slugify(s){ return s.toLowerCase().replace(/[^a-zа-яіїєґ0-9]+/gi,'-').replace(/^-|-$/g,''); }

function makePageHtml(slug, title){
  // Minimal page using the site's layout shell — inherits header/footer from hydration
  // Cloned from index.html shell but with custom title & blank main
  const tpl = fs.existsSync(path.join(PAGES_ROOT,'index.html'))
    ? fs.readFileSync(path.join(PAGES_ROOT,'index.html'),'utf8')
    : null;
  if(tpl){
    // Derive a clean page from the home page template — replace title & clear main content
    return tpl
      .replace(/<title>[^<]*<\/title>/, `<title>${encodeHtmlEnts(title)} | Blue Ferret</title>`)
      .replace(/<meta[^>]+property="og:title"[^>]+content="[^"]*"/, m=>m.replace(/content="[^"]*"/, `content="${encodeHtmlEnts(title)} | Blue Ferret"`))
      .replace(/<meta[^>]+name="description"[^>]+content="[^"]*"/, m=>m.replace(/content="[^"]*"/, 'content=""'))
      .replace(/<main[^>]*>[\s\S]*?<\/main>/, `<main class="flex-1"><div class="max-w-4xl mx-auto px-4 py-24 text-center"><h1 class="heading-1 text-4xl mb-6">${encodeHtmlEnts(title)}</h1><p class="text-slate-500">Ваш контент тут</p></div></main>`);
  }
  // Fallback — minimal standalone page
  return `<!doctype html><html lang="uk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${encodeHtmlEnts(title)} | Blue Ferret</title><meta name="description" content=""><link rel="stylesheet" href="/bf.css"></head><body><main style="max-width:800px;margin:0 auto;padding:80px 20px"><h1>${encodeHtmlEnts(title)}</h1><p>Ваш контент тут</p></main><script src="/bf.js" defer></script></body></html>`;
}

app.post('/api/admin/pages/create', requireAuth, (req,res)=>{
  const {slug:rawSlug, title, copyFrom} = req.body||{};
  if(!rawSlug&&!title) return res.status(400).json({error:'slug or title required'});
  const slug = slugify(rawSlug||title);
  if(!slug) return res.status(400).json({error:'invalid slug'});
  const dir = path.join(PAGES_ROOT, slug);
  if(fs.existsSync(dir)) return res.status(409).json({error:'page_exists', slug});
  fs.mkdirSync(dir,{recursive:true});
  let html;
  if(copyFrom && typeof copyFrom==='string'){
    const srcFull = path.join(PAGES_ROOT, copyFrom);
    if(srcFull.startsWith(PAGES_ROOT) && fs.existsSync(srcFull)){
      html = fs.readFileSync(srcFull,'utf8');
      if(title) html = html.replace(/<title>[^<]*<\/title>/,`<title>${encodeHtmlEnts(title)} | Blue Ferret</title>`);
    }
  }
  if(!html) html = makePageHtml(slug, title||slug);
  const outFile = path.join(dir,'index.html');
  writeAtomic(outFile, html);
  const publishedAt = bumpPublishedAt();
  audit(req.ip,'page_create',{slug,title,publishedAt});
  res.status(201).json({ok:true, slug, file:`${slug}/index.html`, path:`/${slug}/`, publishedAt});
});

// ── delete page ──
app.delete('/api/admin/pages/delete', requireAuth, (req,res)=>{
  const rel = req.query.path;
  if(!rel||rel.includes('..')||rel==='index.html') return res.status(400).json({error:'invalid'});
  const dir = path.join(PAGES_ROOT, path.dirname(rel));
  if(!dir.startsWith(PAGES_ROOT)||dir===PAGES_ROOT) return res.status(403).json({error:'forbidden'});
  if(!fs.existsSync(dir)) return res.status(404).json({error:'not_found'});
  // safety: only delete if it contains only index.html (+ .bak)
  const contents = fs.readdirSync(dir).filter(f=>!f.startsWith('.'));
  const safe = contents.every(f=>f==='index.html'||f.endsWith('.bak')||f.endsWith('.html'));
  if(!safe) return res.status(400).json({error:'directory has unexpected files, delete manually'});
  contents.forEach(f=>fs.unlinkSync(path.join(dir,f)));
  fs.rmdirSync(dir);
  const publishedAt = bumpPublishedAt();
  audit(req.ip,'page_delete',{path:rel,publishedAt});
  res.json({ok:true,publishedAt});
});

// ════════════════════════════════════════════════════════
//  SITE CONTENT DICTIONARY (client-rendered pages' text)
//  Content lives as a JSON object embedded in a JS chunk.
// ════════════════════════════════════════════════════════
const { execFileSync } = require('child_process');

function jsToJson(s){
  return s.replace(/\\'/g,"'").replace(/\\x([0-9a-fA-F]{2})/g,(_,h)=>String.fromCharCode(parseInt(h,16)));
}
function findContentBundle(){
  const dir = path.join(SITE_ROOT,'_next','static','chunks');
  let files=[]; try{files=fs.readdirSync(dir);}catch{return null;}
  for(const f of files){
    if(!f.endsWith('.js')) continue;
    const full=path.join(dir,f);
    let t; try{t=fs.readFileSync(full,'utf8');}catch{continue;}
    if(t.includes('"metadata":{"siteTitle"')) return {file:full, name:f, dir, content:t};
  }
  return null;
}
function locateObj(js){
  const i=js.indexOf('"metadata":'); if(i<0) return null;
  const b=js.lastIndexOf('{',i); let depth=0,k=b;
  while(k<js.length){
    const c=js[k];
    if(c==='"'){ k++; while(k<js.length&&js[k]!=='"'){ if(js[k]==='\\')k++; k++; } }
    else if(c==='{') depth++;
    else if(c==='}'){ depth--; if(depth===0) return {start:b,end:k+1}; }
    k++;
  }
  return null;
}
function readSiteContent(){
  const bundle=findContentBundle(); if(!bundle) return null;
  const loc=locateObj(bundle.content); if(!loc) return null;
  const raw=bundle.content.slice(loc.start,loc.end);
  let obj; try{ obj=JSON.parse(jsToJson(raw)); }catch(e){ return null; }
  return { bundle, loc, obj };
}
function setByPath(obj,pathStr,val){
  const parts=pathStr.split('.'); let o=obj;
  for(let i=0;i<parts.length-1;i++){
    const k=/^\d+$/.test(parts[i])?+parts[i]:parts[i];
    if(o==null) return false; o=o[k];
  }
  const last=/^\d+$/.test(parts[parts.length-1])?+parts[parts.length-1]:parts[parts.length-1];
  if(o==null||typeof o[last]==='undefined') return false;
  o[last]=val; return true;
}
// A baked getStaticProps blob mixes real prose in with structural data that
// happens to also be a string (hex colors, slugs, image paths, enum-like
// status flags, raw IDs) — none of which belong in a TEXT editor. Almost
// all real prose on this site is Ukrainian, so "contains a Cyrillic letter"
// is a strong, simple signal; the length+space fallback catches longer
// English/mixed strings without letting short technical tokens through.
function looksLikeEditableProse(v){
  const s=v.trim();
  if(!s || s.length>2000) return false;
  if(/^https?:\/\//i.test(s) || s.startsWith('/')) return false;          // URL / path
  if(/^#[0-9a-fA-F]{3,8}$/.test(s)) return false;                          // hex color
  if(/^-?\d+(\.\d+)?$/.test(s)) return false;                             // pure number
  if(/[а-яёіїєґ]/i.test(s)) return true;                                  // Cyrillic → real content
  return s.includes(' ') && s.length>=15;                                 // longer English/mixed phrase
}
function flattenContentServer(obj){
  const out=[];
  function rec(o,pathArr,section){
    if(typeof o==='string'){ if(looksLikeEditableProse(o)) out.push({path:pathArr.join('.'),value:o,section}); return; }
    if(Array.isArray(o)){ o.forEach((v,i)=>rec(v,[...pathArr,i],section)); return; }
    if(o&&typeof o==='object'){ for(const k of Object.keys(o)) rec(o[k],[...pathArr,k],section||k); }
  }
  for(const k of Object.keys(obj)) rec(obj[k],[k],k);
  return out;
}

// ════════════════════════════════════════════════════════
//  PAGE-SPECIFIC BAKED CONTENT (Next.js getStaticProps payload)
//  A static export bakes each route's own props into that route's OWN JS
//  chunk (app/**/page-*.js) — separate from, and NOT the same data as, the
//  shared "site-content" dictionary chunk above. Sections like the "about"
//  story / "values" pillar cards live ONLY here; they were previously
//  invisible to every editor (not in static HTML, not in site-content) —
//  see server.js commit history for how this was diagnosed.
// ════════════════════════════════════════════════════════
function findAllJsonParseBlobs(content){
  const blobs=[]; const marker="JSON.parse('";
  let searchFrom=0;
  while(true){
    const m=content.indexOf(marker, searchFrom);
    if(m<0) break;
    const braceStart=content.indexOf('{', m);
    if(braceStart<0 || braceStart>m+marker.length+5){ searchFrom=m+marker.length; continue; }
    let depth=0,k=braceStart;
    while(k<content.length){
      const c=content[k];
      if(c==='"'){ k++; while(k<content.length&&content[k]!=='"'){ if(content[k]==='\\')k++; k++; } }
      else if(c==='{') depth++;
      else if(c==='}'){ depth--; if(depth===0){ k++; break; } }
      k++;
    }
    const raw=content.slice(braceStart,k);
    try{ blobs.push({start:braceStart, end:k, obj:JSON.parse(jsToJson(raw))}); }catch(e){ /* not JSON, skip */ }
    searchFrom=k;
  }
  return blobs;
}
function findPageOwnChunks(pageHtml){
  // Only this route's own "page-*.js" bundle — NOT layout/error/not-found,
  // which are the shared app-shell chunks reused across every route and can
  // carry OTHER pages' baked data (e.g. a specific game's id/slug/palette)
  // that has nothing to do with the page currently being edited.
  const refs=new Set(); const re=/_next\/static\/chunks\/app\/[^"'\s]*\/?page-[^"'\s/]+\.js/g;
  let m; while((m=re.exec(pageHtml))!==null) refs.add(m[0]);
  return [...refs];
}
// Same "content-hash rename + update every HTML <script> ref" pattern as
// the site-content PUT handler, factored out so both call sites share it.
function rehashChunkAndRelink(dir, oldName, newContent){
  const prefix=oldName.split('-')[0];
  const hash=crypto.createHash('sha256').update(newContent).digest('hex').slice(0,16);
  const newName=`${prefix}-${hash}.js`;
  writeAtomic(path.join(dir,newName), newContent);
  if(newName!==oldName){
    try{ fs.unlinkSync(path.join(dir,oldName)); }catch{}
    let htmlChanged=0;
    (function walk(d){
      for(const f of fs.readdirSync(d)){
        if(f.startsWith('.')||f==='_next'||f==='uploads'||f==='cdn-cgi') continue;
        const full=path.join(d,f); let st; try{st=fs.statSync(full);}catch{continue;}
        if(st.isDirectory()) walk(full);
        else if(f.endsWith('.html')){
          let h; try{h=fs.readFileSync(full,'utf8');}catch{continue;}
          if(h.includes(oldName)){ h=h.split(oldName).join(newName); writeAtomic(full,h); htmlChanged++; }
        }
      }
    })(SITE_ROOT);
    return {newName, htmlChanged};
  }
  return {newName, htmlChanged:0};
}

app.get('/api/admin/page-chunk-content', requireAuth, (req,res)=>{
  const rel=req.query.path;
  if(!rel||rel.includes('..')) return res.status(400).json({error:'invalid'});
  const full=path.join(PAGES_ROOT,rel);
  if(!full.startsWith(PAGES_ROOT)||!fs.existsSync(full)) return res.status(404).json({error:'not_found'});
  let html; try{ html=fs.readFileSync(full,'utf8'); }catch(e){ return res.status(500).json({error:e.message}); }
  const fields=[];
  for(const ref of findPageOwnChunks(html)){
    const chunkFull=path.join(SITE_ROOT, ref);
    if(!chunkFull.startsWith(SITE_ROOT)||!fs.existsSync(chunkFull)) continue;
    let content; try{ content=fs.readFileSync(chunkFull,'utf8'); }catch{ continue; }
    findAllJsonParseBlobs(content).forEach((blob,bi)=>{
      // The shared site-content dictionary is already editable via
      // /api/admin/site-content — skip it here to avoid listing it twice.
      if(blob.obj && blob.obj.metadata && blob.obj.metadata.siteTitle) return;
      flattenContentServer(blob.obj).forEach(f=>fields.push({...f, chunk:ref, blobIndex:bi}));
    });
  }
  res.json({fields});
});

app.put('/api/admin/page-chunk-content', requireAuth, (req,res)=>{
  const rel=req.query.path;
  if(!rel||rel.includes('..')) return res.status(400).json({error:'invalid'});
  const full=path.join(PAGES_ROOT,rel);
  if(!full.startsWith(PAGES_ROOT)||!fs.existsSync(full)) return res.status(404).json({error:'not_found'});
  const { changes } = req.body||{};
  if(!Array.isArray(changes)||!changes.length) return res.status(400).json({error:'no changes'});
  let html; try{ html=fs.readFileSync(full,'utf8'); }catch(e){ return res.status(500).json({error:e.message}); }

  // group requested changes by which chunk file they belong to
  const byChunk=new Map();
  for(const c of changes){
    if(!c||typeof c.chunk!=='string'||typeof c.path!=='string'||typeof c.value!=='string') continue;
    if(!byChunk.has(c.chunk)) byChunk.set(c.chunk,[]);
    byChunk.get(c.chunk).push(c);
  }

  let applied=0, chunksRewritten=0, htmlRefsUpdated=0;
  const propagatePairs=[];
  try{
    for(const [ref, chunkChanges] of byChunk){
      const chunkFull=path.join(SITE_ROOT, ref);
      if(!chunkFull.startsWith(SITE_ROOT)||!fs.existsSync(chunkFull)) continue;
      const dir=path.dirname(chunkFull); const oldName=path.basename(chunkFull);
      let content=fs.readFileSync(chunkFull,'utf8');
      const blobs=findAllJsonParseBlobs(content);
      // apply edits to each blob's parsed object, grouped by blobIndex
      const byBlob=new Map();
      for(const c of chunkChanges){
        const bi = typeof c.blobIndex==='number' ? c.blobIndex : 0;
        if(!byBlob.has(bi)) byBlob.set(bi,[]);
        byBlob.get(bi).push(c);
      }
      // splice from the LAST blob backward so earlier offsets stay valid
      const order=[...byBlob.keys()].sort((a,b)=>b-a);
      for(const bi of order){
        const blob=blobs[bi]; if(!blob) continue;
        for(const c of byBlob.get(bi)){
          const before=getByPath(blob.obj,c.path);
          if(setByPath(blob.obj,c.path,c.value)){
            applied++;
            if(typeof before==='string' && before!==c.value) propagatePairs.push([before,c.value]);
          }
        }
        const newBlob=JSON.stringify(blob.obj).replace(/'/g,"\\'");
        content=content.slice(0,blob.start)+newBlob+content.slice(blob.end);
      }
      if(!byBlob.size) continue;
      const {newName, htmlChanged}=rehashChunkAndRelink(dir, oldName, content);
      chunksRewritten++; htmlRefsUpdated+=htmlChanged;
    }
    if(!applied) return res.json({ok:true, applied:0});
    try{ execFileSync('restorecon',['-R',SITE_ROOT],{stdio:'ignore',timeout:15000}); }catch{}
    let propagated={chunksChanged:0,htmlChanged:0};
    for(const [before,after] of propagatePairs){
      const r=propagateTextChange(before,after);
      propagated.chunksChanged+=r.chunksChanged; propagated.htmlChanged+=r.htmlChanged;
    }
    const publishedAt=bumpPublishedAt();
    audit(req.ip,'page_chunk_save',{path:rel,applied,chunksRewritten,htmlRefsUpdated,propagated,publishedAt});
    res.json({ok:true, applied, chunksRewritten, htmlRefsUpdated, propagated, publishedAt});
  }catch(e){
    res.status(500).json({error:e.message});
  }
});

function resolvePath(obj, pathStr){
  const parts=pathStr.split('.'); let o=obj;
  for(const p of parts){
    const k=/^\d+$/.test(p)?+p:p;
    if(o==null) return undefined;
    o=o[k];
  }
  return o;
}
// Order-insensitive identity for an array's contents, used to recognize "this
// is the same duplicated list" in another page's own chunk (e.g. the pillar
// cards baked separately into index/kontakty/kik/kik/pro-kik) without relying
// on array order, which is exactly what these operations are changing.
function arrayFingerprint(arr){
  return arr.map(x=>JSON.stringify(x)).sort().join('');
}
function blankStringLeaves(o){
  if(typeof o==='string') return 'Новий пункт';
  if(Array.isArray(o)) return o.map(blankStringLeaves);
  if(o&&typeof o==='object'){ const r={}; for(const k of Object.keys(o)) r[k]=blankStringLeaves(o[k]); return r; }
  return o;
}
// Find the same array (by content fingerprint, taken BEFORE the caller's own
// mutation) baked into any OTHER page's own chunk, and apply the identical
// structural change there — otherwise reordering/adding/removing a card only
// fixes the page currently being edited while its duplicates on other pages
// silently drift out of sync.
function syncArrayToDuplicates(sourceChunkFull, arrayPath, beforeFingerprint, applyFn){
  let chunksChanged=0;
  const chunksAppDir=path.join(SITE_ROOT,'_next','static','chunks','app');
  (function walk(d){
    let entries; try{ entries=fs.readdirSync(d,{withFileTypes:true}); }catch{ return; }
    for(const e of entries){
      const full=path.join(d,e.name);
      if(e.isDirectory()){ walk(full); continue; }
      if(!e.name.endsWith('.js')||full===sourceChunkFull) continue;
      let content; try{ content=fs.readFileSync(full,'utf8'); }catch{ continue; }
      if(!content.includes("JSON.parse('")) continue;
      const blobs=findAllJsonParseBlobs(content);
      const matchIdx=[];
      blobs.forEach((blob,bi)=>{
        const arr=resolvePath(blob.obj, arrayPath);
        if(Array.isArray(arr) && arrayFingerprint(arr)===beforeFingerprint) matchIdx.push(bi);
      });
      if(!matchIdx.length) continue;
      matchIdx.sort((a,b)=>b-a).forEach(bi=>{
        const blob=blobs[bi];
        applyFn(resolvePath(blob.obj, arrayPath));
        const newBlob=JSON.stringify(blob.obj).replace(/'/g,"\\'");
        content=content.slice(0,blob.start)+newBlob+content.slice(blob.end);
      });
      const dir=path.dirname(full), oldName=path.basename(full);
      rehashChunkAndRelink(dir, oldName, content);
      chunksChanged++;
    }
  })(chunksAppDir);
  return chunksChanged;
}

// Move one entry within an array baked into a page's own JS chunk (e.g. the
// "values.items" pillar list) — same edit family as page-chunk-content but a
// position swap rather than a value change, so it gets its own endpoint
// instead of overloading PUT's per-field {path,value} shape.
app.post('/api/admin/page-chunk-reorder', requireAuth, (req,res)=>{
  const rel=req.query.path;
  if(!rel||rel.includes('..')) return res.status(400).json({error:'invalid'});
  const full=path.join(PAGES_ROOT,rel);
  if(!full.startsWith(PAGES_ROOT)||!fs.existsSync(full)) return res.status(404).json({error:'not_found'});
  const { chunk, blobIndex, arrayPath, fromIndex, toIndex } = req.body||{};
  if(typeof chunk!=='string'||typeof blobIndex!=='number'||typeof arrayPath!=='string'||
     !Number.isInteger(fromIndex)||!Number.isInteger(toIndex)) return res.status(400).json({error:'invalid'});
  const chunkFull=path.join(SITE_ROOT, chunk);
  if(!chunkFull.startsWith(SITE_ROOT)||!fs.existsSync(chunkFull)) return res.status(404).json({error:'chunk_not_found'});
  try{
    let content=fs.readFileSync(chunkFull,'utf8');
    const blobs=findAllJsonParseBlobs(content);
    const blob=blobs[blobIndex];
    if(!blob) return res.status(404).json({error:'blob_not_found'});
    const arr=resolvePath(blob.obj, arrayPath);
    if(!Array.isArray(arr)) return res.status(400).json({error:'not_an_array'});
    if(fromIndex<0||fromIndex>=arr.length||toIndex<0||toIndex>=arr.length) return res.status(400).json({error:'index_out_of_range'});
    const beforeFingerprint=arrayFingerprint(arr);
    const [item]=arr.splice(fromIndex,1);
    arr.splice(toIndex,0,item);
    const newBlob=JSON.stringify(blob.obj).replace(/'/g,"\\'");
    content=content.slice(0,blob.start)+newBlob+content.slice(blob.end);
    // Sync duplicate arrays on OTHER pages before renaming this chunk — the
    // exclusion check compares full paths, so it must run while chunkFull's
    // old filename still exists on disk (a rename first would let this same
    // file, now under its new name, get matched and double-applied to).
    const dupChunksChanged=syncArrayToDuplicates(chunkFull, arrayPath, beforeFingerprint, a=>{ const [it]=a.splice(fromIndex,1); a.splice(toIndex,0,it); });
    const dir=path.dirname(chunkFull), oldName=path.basename(chunkFull);
    const {newName, htmlChanged}=rehashChunkAndRelink(dir, oldName, content);
    try{ execFileSync('restorecon',['-R',SITE_ROOT],{stdio:'ignore',timeout:15000}); }catch{}
    const publishedAt=bumpPublishedAt();
    audit(req.ip,'page_chunk_reorder',{path:rel,chunk,arrayPath,fromIndex,toIndex,newName,dupChunksChanged,publishedAt});
    res.json({ok:true, newChunk: chunk.replace(oldName,newName), htmlRefsUpdated: htmlChanged, dupChunksChanged, publishedAt});
  }catch(e){
    res.status(500).json({error:e.message});
  }
});

// Insert a new item into an array baked into a page's own JS chunk, cloning
// the shape of a sibling item with its string leaves blanked to a visible
// placeholder — the new item then edits like any other pc-content field.
app.post('/api/admin/page-chunk-array-insert', requireAuth, (req,res)=>{
  const rel=req.query.path;
  if(!rel||rel.includes('..')) return res.status(400).json({error:'invalid'});
  const full=path.join(PAGES_ROOT,rel);
  if(!full.startsWith(PAGES_ROOT)||!fs.existsSync(full)) return res.status(404).json({error:'not_found'});
  const { chunk, blobIndex, arrayPath, afterIndex } = req.body||{};
  if(typeof chunk!=='string'||typeof blobIndex!=='number'||typeof arrayPath!=='string')
    return res.status(400).json({error:'invalid'});
  const chunkFull=path.join(SITE_ROOT, chunk);
  if(!chunkFull.startsWith(SITE_ROOT)||!fs.existsSync(chunkFull)) return res.status(404).json({error:'chunk_not_found'});
  try{
    let content=fs.readFileSync(chunkFull,'utf8');
    const blobs=findAllJsonParseBlobs(content);
    const blob=blobs[blobIndex];
    if(!blob) return res.status(404).json({error:'blob_not_found'});
    const arr=resolvePath(blob.obj, arrayPath);
    if(!Array.isArray(arr)) return res.status(400).json({error:'not_an_array'});
    if(!arr.length) return res.status(400).json({error:'empty_array_no_template'});
    const insertAt=Number.isInteger(afterIndex)?Math.min(Math.max(afterIndex+1,0),arr.length):arr.length;
    const beforeFingerprint=arrayFingerprint(arr);
    const template=arr[Math.min(insertAt,arr.length-1)] ?? arr[0];
    const clone=blankStringLeaves(JSON.parse(JSON.stringify(template)));
    arr.splice(insertAt,0,clone);
    const newBlob=JSON.stringify(blob.obj).replace(/'/g,"\\'");
    content=content.slice(0,blob.start)+newBlob+content.slice(blob.end);
    const dupChunksChanged=syncArrayToDuplicates(chunkFull, arrayPath, beforeFingerprint, a=>{ a.splice(insertAt,0,JSON.parse(JSON.stringify(clone))); });
    const dir=path.dirname(chunkFull), oldName=path.basename(chunkFull);
    const {newName, htmlChanged}=rehashChunkAndRelink(dir, oldName, content);
    try{ execFileSync('restorecon',['-R',SITE_ROOT],{stdio:'ignore',timeout:15000}); }catch{}
    const publishedAt=bumpPublishedAt();
    audit(req.ip,'page_chunk_array_insert',{path:rel,chunk,arrayPath,insertAt,newName,dupChunksChanged,publishedAt});
    res.json({ok:true, newChunk: chunk.replace(oldName,newName), htmlRefsUpdated: htmlChanged, dupChunksChanged, publishedAt});
  }catch(e){
    res.status(500).json({error:e.message});
  }
});

// Remove an item from an array baked into a page's own JS chunk.
app.post('/api/admin/page-chunk-array-remove', requireAuth, (req,res)=>{
  const rel=req.query.path;
  if(!rel||rel.includes('..')) return res.status(400).json({error:'invalid'});
  const full=path.join(PAGES_ROOT,rel);
  if(!full.startsWith(PAGES_ROOT)||!fs.existsSync(full)) return res.status(404).json({error:'not_found'});
  const { chunk, blobIndex, arrayPath, index } = req.body||{};
  if(typeof chunk!=='string'||typeof blobIndex!=='number'||typeof arrayPath!=='string'||!Number.isInteger(index))
    return res.status(400).json({error:'invalid'});
  const chunkFull=path.join(SITE_ROOT, chunk);
  if(!chunkFull.startsWith(SITE_ROOT)||!fs.existsSync(chunkFull)) return res.status(404).json({error:'chunk_not_found'});
  try{
    let content=fs.readFileSync(chunkFull,'utf8');
    const blobs=findAllJsonParseBlobs(content);
    const blob=blobs[blobIndex];
    if(!blob) return res.status(404).json({error:'blob_not_found'});
    const arr=resolvePath(blob.obj, arrayPath);
    if(!Array.isArray(arr)) return res.status(400).json({error:'not_an_array'});
    if(index<0||index>=arr.length) return res.status(400).json({error:'index_out_of_range'});
    if(arr.length<=1) return res.status(400).json({error:'cannot_remove_last_item'});
    const beforeFingerprint=arrayFingerprint(arr);
    arr.splice(index,1);
    const newBlob=JSON.stringify(blob.obj).replace(/'/g,"\\'");
    content=content.slice(0,blob.start)+newBlob+content.slice(blob.end);
    const dupChunksChanged=syncArrayToDuplicates(chunkFull, arrayPath, beforeFingerprint, a=>{ if(a.length>1) a.splice(index,1); });
    const dir=path.dirname(chunkFull), oldName=path.basename(chunkFull);
    const {newName, htmlChanged}=rehashChunkAndRelink(dir, oldName, content);
    try{ execFileSync('restorecon',['-R',SITE_ROOT],{stdio:'ignore',timeout:15000}); }catch{}
    const publishedAt=bumpPublishedAt();
    audit(req.ip,'page_chunk_array_remove',{path:rel,chunk,arrayPath,index,newName,dupChunksChanged,publishedAt});
    res.json({ok:true, newChunk: chunk.replace(oldName,newName), htmlRefsUpdated: htmlChanged, dupChunksChanged, publishedAt});
  }catch(e){
    res.status(500).json({error:e.message});
  }
});

// ── Cross-chunk text propagation ──────────────────────────────────────────
// Next.js's static export bakes page content into a SEPARATE, per-route JS
// chunk at build time (getStaticProps/RSC payload), in addition to the one
// shared "site-content" dictionary chunk the admin edits directly. Since
// there's no Next.js source project to rebuild from, those page-specific
// copies never picked up a site-content edit — this is *the* cause behind
// "saved, but the live page still shows the old text": the value really did
// change in one chunk, just not the one that page actually renders from.
//
// Fix: whenever ANY editor here changes a text value, also find-and-replace
// that exact value across every other chunk/page that independently embeds
// it, so every copy stays in lockstep instead of just one.
function replaceInJsChunk(content, oldValue, newValue) {
  let changed = false;
  // Plain JSON string literal — {"title":"Атмосфера",...} and the JSON body
  // *inside* JSON.parse('...') both use standard JSON escaping for this.
  const jsonForm = JSON.stringify(oldValue);
  const jsonNew = JSON.stringify(newValue);
  if (content.includes(jsonForm)) {
    content = content.split(jsonForm).join(jsonNew);
    changed = true;
  }
  // JSON.parse('...') wraps that JSON text in a single-quoted JS string
  // literal, so any apostrophe inside the value gets a SECOND layer of
  // escaping ( ' → \' ) on top of the JSON encoding above — only differs
  // when the value actually contains an apostrophe.
  const jsEscapedForm = jsonForm.replace(/'/g, "\\'");
  const jsEscapedNew = jsonNew.replace(/'/g, "\\'");
  if (jsEscapedForm !== jsonForm && content.includes(jsEscapedForm)) {
    content = content.split(jsEscapedForm).join(jsEscapedNew);
    changed = true;
  }
  return { content, changed };
}
// Safety floor before propagating a value site-wide: a lone short word
// ("Так", "Купити") is exactly the kind of string likely to also appear as
// an unrelated button/label elsewhere, so a pure length cutoff would need
// to sit high enough to exclude those — but real short HEADINGS (Ukrainian
// titles run shorter than English, e.g. "Йти до кінця" is 12 chars/3 words)
// would then get excluded too. Multi-word phrases are specific enough to be
// safe even when short; single words need to actually be long to qualify.
function isSafeToPropagate(value){
  const v=value.trim();
  if(v.includes(' ')) return v.length>=8;
  if(/[а-яёіїєґ]/i.test(v)) return v.length>=6; // Cyrillic single words are distinctive, low collision risk
  return v.length>=15;
}
function propagateTextChange(oldValue, newValue) {
  if (!oldValue || !newValue || oldValue === newValue) return { chunksChanged: 0, htmlChanged: 0 };
  if (!isSafeToPropagate(oldValue)) return { chunksChanged: 0, htmlChanged: 0 };

  const chunksDir = path.join(SITE_ROOT, '_next', 'static', 'chunks');
  const jsFiles = [];
  (function walk(d) {
    let entries; try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.js') && !e.name.includes('.bak')) jsFiles.push(full);
    }
  })(chunksDir);

  const renamedChunks = new Map(); // oldName -> newName
  let chunksChanged = 0;
  for (const file of jsFiles) {
    let content; try { content = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const patched = replaceInJsChunk(content, oldValue, newValue);
    if (!patched.changed) continue;
    const oldName = path.basename(file);
    const dir = path.dirname(file);
    const prefix = oldName.split('-')[0];
    const hash = crypto.createHash('sha256').update(patched.content).digest('hex').slice(0, 16);
    const newName = `${prefix}-${hash}.js`;
    writeAtomic(path.join(dir, newName), patched.content);
    if (newName !== oldName) { try { fs.unlinkSync(file); } catch {} renamedChunks.set(oldName, newName); }
    chunksChanged++;
  }

  const oldEnc = encodeHtmlEnts(oldValue);
  const newEnc = encodeHtmlEnts(newValue);
  let htmlChanged = 0;
  (function walk(d) {
    let entries; try { entries = fs.readdirSync(d); } catch { return; }
    for (const f of entries) {
      if (f.startsWith('.') || f === '_next' || f === 'uploads' || f === 'cdn-cgi') continue;
      const full = path.join(d, f);
      let st; try { st = fs.statSync(full); } catch { continue; }
      if (st.isDirectory()) { walk(full); continue; }
      if (!f.endsWith('.html')) continue;
      let h; try { h = fs.readFileSync(full, 'utf8'); } catch { continue; }
      let changed = false;
      for (const [oldName, newName] of renamedChunks) {
        if (h.includes(oldName)) { h = h.split(oldName).join(newName); changed = true; }
      }
      if (h.includes(oldEnc)) { h = h.split(oldEnc).join(newEnc); changed = true; }
      if (changed) { writeAtomic(full, h); htmlChanged++; }
    }
  })(SITE_ROOT);

  if (chunksChanged || htmlChanged) {
    try { execFileSync('restorecon', ['-R', SITE_ROOT], { stdio: 'ignore', timeout: 15000 }); } catch {}
  }
  return { chunksChanged, htmlChanged };
}

// Scans the live site for leftover literal occurrences of a value we just
// tried to change. propagateTextChange() deliberately skips short/generic
// values (isSafeToPropagate) to avoid collisions, and Next.js static export
// can bake the same string into HTML that isn't caught by that pass either
// — both cases leave stale content live while the save reports "success".
// This surfaces that gap instead of hiding it.
function findStaleOccurrences(value, limit = 8) {
  const v = (value || '').trim();
  if (!v || v.length < 3) return [];
  const found = [];
  (function walk(d) {
    if (found.length >= limit) return;
    let entries; try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (found.length >= limit) return;
      if (e.name.startsWith('.') || e.name === 'uploads' || e.name === 'cdn-cgi') continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!e.name.endsWith('.html') && !e.name.endsWith('.js')) continue;
      let h; try { h = fs.readFileSync(full, 'utf8'); } catch { continue; }
      if (h.includes(v) || h.includes(encodeHtmlEnts(v))) found.push(path.relative(SITE_ROOT, full));
    }
  })(SITE_ROOT);
  return found;
}

app.get('/api/admin/site-content', requireAuth, (_req,res)=>{
  const sc=readSiteContent();
  if(!sc) return res.status(404).json({error:'content bundle not found'});
  res.json({ content: sc.obj, bundle: sc.bundle.name });
});

function getByPath(obj,pathStr){
  const parts=pathStr.split('.'); let o=obj;
  for(const p of parts){
    const k=/^\d+$/.test(p)?+p:p;
    if(o==null) return undefined; o=o[k];
  }
  return o;
}

app.put('/api/admin/site-content', requireAuth, (req,res)=>{
  const { changes } = req.body||{};
  if(!Array.isArray(changes)||!changes.length) return res.status(400).json({error:'no changes'});
  const sc=readSiteContent();
  if(!sc) return res.status(404).json({error:'content bundle not found'});
  let applied=0;
  const propagatePairs=[]; // [oldValue, newValue] — synced to other chunks/pages AFTER the primary write
  for(const c of changes){
    if(c && typeof c.path==='string' && typeof c.value==='string'){
      const before=getByPath(sc.obj,c.path);
      if(setByPath(sc.obj,c.path,c.value)){
        applied++;
        if(typeof before==='string' && before!==c.value) propagatePairs.push([before,c.value]);
      }
    }
  }
  if(!applied) return res.json({ok:true, applied:0});
  // Re-serialize. The blob sits inside a JS single-quoted string literal
  // (JSON.parse('...')), so a bare apostrophe in any field (very common in
  // Ukrainian text, e.g. "Зв'яжіться") would terminate that string early and
  // corrupt the whole chunk — escape it the same way jsToJson() un-escapes
  // it on read.
  const newBlob=JSON.stringify(sc.obj).replace(/'/g,"\\'");
  const oldContent=sc.bundle.content;
  const newContent=oldContent.slice(0,sc.loc.start)+newBlob+oldContent.slice(sc.loc.end);
  // cache-bust: rename bundle with fresh hash, update all HTML refs
  const oldName=sc.bundle.name;                    // e.g. 6398-abc.js
  const prefix=oldName.split('-')[0];              // 6398
  const hash=crypto.createHash('sha256').update(newContent).digest('hex').slice(0,16);
  const newName=`${prefix}-${hash}.js`;
  const newPath=path.join(sc.bundle.dir,newName);
  try{
    writeAtomic(newPath,newContent);
    if(newName!==oldName) fs.unlinkSync(sc.bundle.file);
    // update references across all HTML
    let htmlChanged=0;
    (function walk(d){
      for(const f of fs.readdirSync(d)){
        if(f.startsWith('.')||f==='_next'||f==='uploads'||f==='cdn-cgi') continue;
        const full=path.join(d,f), st=fs.statSync(full);
        if(st.isDirectory()) walk(full);
        else if(f==='index.html'){
          let h=fs.readFileSync(full,'utf8');
          if(h.includes(oldName)){ h=h.split(oldName).join(newName); writeAtomic(full,h); htmlChanged++; }
        }
      }
    })(SITE_ROOT);
    // best-effort SELinux restore
    try{ execFileSync('restorecon',['-R',SITE_ROOT],{stdio:'ignore',timeout:15000}); }catch{}
    // Sync any OTHER page-specific chunk / static HTML that independently
    // baked in the OLD wording — see propagateTextChange() for why this is
    // necessary (Next.js static export duplicates content per route).
    let propagated={chunksChanged:0,htmlChanged:0};
    for(const [before,after] of propagatePairs){
      const r=propagateTextChange(before,after);
      propagated.chunksChanged+=r.chunksChanged;
      propagated.htmlChanged+=r.htmlChanged;
    }
    // Verify the change actually took everywhere — propagateTextChange skips
    // short/generic values on purpose, so a "successful" save can still
    // leave the old value live on the site with no indication to the admin.
    const staleWarnings=[];
    for(const [before,after] of propagatePairs){
      const files=findStaleOccurrences(before);
      if(files.length) staleWarnings.push({value:before, files});
    }
    const publishedAt = bumpPublishedAt();
    audit(req.ip,'content_save',{applied,bundle:newName,htmlChanged,propagated,staleWarnings,publishedAt});
    res.json({ok:true, applied, bundle:newName, htmlChanged, propagated, staleWarnings, publishedAt});
  }catch(e){
    res.status(500).json({error:e.message});
  }
});

// ── duplicate page ──
app.post('/api/admin/pages/duplicate', requireAuth, (req,res)=>{
  const {from, slug:rawSlug} = req.body||{};
  if(!from||!rawSlug) return res.status(400).json({error:'from and slug required'});
  const slug=slugify(rawSlug);
  const srcFull=path.join(PAGES_ROOT,from.replace(/\.\./g,''));
  if(!srcFull.startsWith(PAGES_ROOT)||!fs.existsSync(srcFull)) return res.status(404).json({error:'source not found'});
  const dir=path.join(PAGES_ROOT,slug);
  if(fs.existsSync(dir)) return res.status(409).json({error:'page_exists'});
  fs.mkdirSync(dir,{recursive:true});
  writeAtomic(path.join(dir,'index.html'), fs.readFileSync(srcFull, 'utf8'));
  const publishedAt = bumpPublishedAt();
  audit(req.ip,'page_duplicate',{from,slug,publishedAt});
  res.status(201).json({ok:true,slug,file:`${slug}/index.html`,path:`/${slug}/`,publishedAt});
});
// extract editable blocks from a page
app.get('/api/admin/page-extract', requireAuth, (req, res) => {
  const rel = req.query.path;
  if (!rel || rel.includes('..')) return res.status(400).json({error:'invalid'});
  const full = path.join(PAGES_ROOT, rel);
  if (!full.startsWith(PAGES_ROOT) || !fs.existsSync(full)) return res.status(404).json({error:'not_found'});
  try {
    const html = fs.readFileSync(full, 'utf8');
    const sc = readSiteContent();
    const managedValues = sc ? flattenSiteContentValues(sc.obj) : null;
    res.json({ blocks: extractBlocks(html, managedValues) });
  } catch(e) { res.status(500).json({error:e.message}); }
});

// patch specific blocks (no full HTML needed)
app.patch('/api/admin/page-patch', requireAuth, (req, res) => {
  const rel = req.query.path;
  if (!rel || rel.includes('..') || !rel.endsWith('.html')) return res.status(400).json({error:'invalid'});
  const full = path.join(PAGES_ROOT, rel);
  if (!full.startsWith(PAGES_ROOT) || !fs.existsSync(full)) return res.status(404).json({error:'not_found'});
  const {blocks} = req.body || {};
  if (!Array.isArray(blocks)) return res.status(400).json({error:'blocks required'});
  let html = fs.readFileSync(full, 'utf8');
  // backup
  writeBackup(full);
  let changed = 0;
  const propagatePairs = []; // [oldValue, newValue] — plain text blocks only, not img src / href
  for (const b of blocks) {
    if (!b.orig) continue;
    const textChanged = b.newVal != null && b.origVal !== b.newVal;
    const hrefChanged = typeof b.newHref === 'string' && b.newHref !== (b.origHref || '');
    const altChanged = typeof b.newAlt === 'string' && b.newAlt !== (b.origAlt || '');
    if (!textChanged && !hrefChanged && !altChanged) continue;
    // img blocks: replace src/alt attribute values, not text content
    if (b.orig.match(/^<img\s/i)) {
      let newOrig = b.orig, didChange = false;
      if (textChanged) {
        const replaced = newOrig.replace(`src="${b.origVal}"`, `src="${encodeHtmlEnts(b.newVal)}"`);
        if (replaced !== newOrig) { newOrig = replaced; didChange = true; }
      }
      if (altChanged) {
        const altAttr = `alt="${encodeHtmlEnts(b.origAlt || '')}"`;
        const replaced = newOrig.includes(altAttr)
          ? newOrig.replace(altAttr, `alt="${encodeHtmlEnts(b.newAlt)}"`)
          : newOrig.replace(/^<img\s/i, `<img alt="${encodeHtmlEnts(b.newAlt)}" `);
        if (replaced !== newOrig) { newOrig = replaced; didChange = true; }
      }
      if (didChange) { html = html.split(b.orig).join(newOrig); changed++; }
      continue;
    }
    let newOrig = b.orig, didChange = false;
    if (hrefChanged) {
      const hrefAttr = `href="${encodeHtmlEnts(b.origHref || '')}"`;
      if (newOrig.includes(hrefAttr)) {
        newOrig = newOrig.replace(hrefAttr, `href="${encodeHtmlEnts(b.newHref)}"`);
        didChange = true;
      }
    }
    if (textChanged) {
      // p/span/li edits may contain a simple <a href="...">/<strong>/<em> span
      // inserted via the editor's formatting buttons — sanitize so only those
      // exact, safe patterns survive as real markup and any other stray angle
      // brackets are encoded.
      const encoded = (b.type === 'p' || b.type === 'span' || b.type === 'li') ? sanitizeUserHtml(b.newVal) : encodeHtmlEnts(b.newVal);
      const replaced = newOrig.replace(b.origVal, encoded);
      if (replaced !== newOrig) {
        newOrig = replaced; didChange = true;
        if (!/<a href=|<strong>|<em>/i.test(b.newVal)) propagatePairs.push([b.origVal, b.newVal]);
      }
    }
    if (didChange) { html = html.split(b.orig).join(newOrig); changed++; }
  }
  writeAtomic(full, html);
  // Sync any OTHER page/chunk that independently baked in this same text —
  // see propagateTextChange() for why a single-page HTML edit alone can
  // leave the change invisible (or only half-applied) on a Next.js static
  // export. Runs against the WHOLE site, so this also fixes duplicate
  // wording that appears verbatim on more than one page.
  let propagated = {chunksChanged:0, htmlChanged:0};
  for (const [before, after] of propagatePairs) {
    const r = propagateTextChange(before, after);
    propagated.chunksChanged += r.chunksChanged;
    propagated.htmlChanged += r.htmlChanged;
  }
  const publishedAt = bumpPublishedAt();
  audit(req.ip, 'page_patch', {path: rel, changed, propagated, publishedAt});
  res.json({ok: true, changed, propagated, publishedAt});
});

app.get('/api/admin/pages/*', requireAuth, (req, res) => {
  const rel = req.params[0];
  if (!rel || rel.includes('..')) return res.status(400).json({error:'invalid'});
  const full = path.join(PAGES_ROOT, rel);
  if (!full.startsWith(PAGES_ROOT)) return res.status(403).json({error:'forbidden'});
  if (!fs.existsSync(full)) return res.status(404).json({error:'not_found'});
  res.json({ content: fs.readFileSync(full,'utf8') });
});
app.put('/api/admin/pages/*', requireAuth, (req, res) => {
  const rel = req.params[0];
  if (!rel || rel.includes('..') || !rel.endsWith('.html')) return res.status(400).json({error:'invalid'});
  const full = path.join(PAGES_ROOT, rel);
  if (!full.startsWith(PAGES_ROOT)) return res.status(403).json({error:'forbidden'});
  const { content } = req.body || {};
  if (typeof content !== 'string') return res.status(400).json({error:'no content'});
  // backup
  writeBackup(full);
  writeAtomic(full, content);
  const publishedAt = bumpPublishedAt();
  audit(req.ip,'page_edit',{path:rel,publishedAt});
  res.json({ok:true,publishedAt});
});

// ---------- public ----------
app.get('/api/public/site.json', (_req, res) => {
  const s=fullSettings(), pub={};
  for(const k of PUBLIC_KEYS) pub[k]=s[k];
  res.setHeader('Cache-Control','no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma','no-cache');
  res.setHeader('Expires','0');
  res.json(pub);
});
app.get('/api/public/games', (_req, res) => {
  res.setHeader('Cache-Control','no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma','no-cache');
  res.setHeader('Expires','0');
  res.json(publicGames());
});
app.get('/api/public/kik', (_req, res) => {
  res.setHeader('Cache-Control','no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma','no-cache');
  res.setHeader('Expires','0');
  res.json(kAll.all());
});

const RUNTIME_JS = `(function(){
  function apply(s){try{
    if(!s)return;
    var a=s.appearance||{},b=s.banner||{},m=s.maintenance||{},ig=s.integrations||{},g=s.general||{};
    if(g.primaryColor)document.documentElement.style.setProperty('--bf-primary',g.primaryColor);
    if(a.customCss){var st=document.getElementById('bf-css')||Object.assign(document.createElement('style'),{id:'bf-css'});st.textContent=a.customCss;if(!st.parentNode)document.head.appendChild(st);}
    if(ig.headScripts&&!window.__bfH){window.__bfH=1;var d=document.createElement('div');d.innerHTML=ig.headScripts;d.childNodes.forEach(function(n){if(n.tagName==='SCRIPT'){var sc=document.createElement('script');for(var i=0;i<n.attributes.length;i++)sc.setAttribute(n.attributes[i].name,n.attributes[i].value);sc.text=n.textContent;document.head.appendChild(sc);}else document.head.appendChild(n.cloneNode(true));});}
    if(ig.bodyScripts&&!window.__bfB){window.__bfB=1;var bd=document.createElement('div');bd.innerHTML=ig.bodyScripts;bd.childNodes.forEach(function(n){if(n.tagName==='SCRIPT'){var sc=document.createElement('script');for(var i=0;i<n.attributes.length;i++)sc.setAttribute(n.attributes[i].name,n.attributes[i].value);sc.text=n.textContent;document.body.appendChild(sc);}else document.body.appendChild(n.cloneNode(true));});}
    var ex=document.getElementById('bf-banner');
    if(b.enabled&&b.text){var el=ex||document.createElement('div');el.id='bf-banner';el.style.cssText='position:relative;z-index:9998;width:100%;padding:10px 16px;text-align:center;font:600 14px/1.4 Comfortaa,system-ui,sans-serif;background:'+(b.bg||'#2E9BE6')+';color:'+(b.fg||'#fff')+';';el.innerHTML=b.link?'<a href="'+b.link+'" style="color:inherit;text-decoration:underline">'+esc(b.text)+'</a>':esc(b.text);if(!ex)document.body.insertBefore(el,document.body.firstChild);}else if(ex)ex.remove();
    var mo=document.getElementById('bf-maintenance');
    if(m.enabled){if(!mo){mo=document.createElement('div');mo.id='bf-maintenance';mo.style.cssText='position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;text-align:center;padding:24px;background:#0b1f33;color:#fff;font:500 20px/1.6 Comfortaa,system-ui,sans-serif;';mo.innerHTML='<div style="max-width:560px"><div style="font-size:40px;margin-bottom:16px">🦦</div><div>'+esc(m.message||'')+'</div></div>';document.body.appendChild(mo);document.documentElement.style.overflow='hidden';}}else if(mo){mo.remove();document.documentElement.style.overflow='';}
  }catch(e){}}
  function esc(x){return String(x).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
  function getJson(url,ms){var c=window.AbortController?new AbortController():null;var t=c?setTimeout(function(){try{c.abort();}catch(e){}},ms||8000):0;return fetch(url,{cache:'no-store',signal:c&&c.signal}).then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.json();}).finally(function(){if(t)clearTimeout(t);});}
  function load(){getJson('/api/public/site.json',8000).then(function(s){apply(s);startLiveRefresh(s);}).catch(function(){});}
  function showUpdateNotice(ts){
    if(document.getElementById('bf-update-notice'))return;
    var el=document.createElement('button');
    el.id='bf-update-notice';
    el.type='button';
    el.textContent='Сайт оновлено · Оновити';
    el.style.cssText='position:fixed;left:50%;bottom:calc(18px + env(safe-area-inset-bottom));transform:translateX(-50%);z-index:9997;border:0;border-radius:999px;padding:11px 16px;background:#0a0f1a;color:#fff;font:700 13px/1.2 Comfortaa,system-ui,sans-serif;box-shadow:0 14px 36px rgba(2,6,23,.24);cursor:pointer;';
    el.onclick=function(){var u=new URL(location.href);u.searchParams.set('v',ts||Date.now());location.href=u.toString();};
    document.body.appendChild(el);
  }
  // ── Live freshness check: never interrupt a visible visitor with forced reload. ──
  var lastPub=0;
  function startLiveRefresh(s){
    try{lastPub=(s&&s.general&&s.general.publishedAt)||0;}catch(e){}
    if(!lastPub)return;
    setInterval(function(){
      getJson('/api/public/site.json',4000).then(function(ns){
        var newPub=(ns&&ns.general&&ns.general.publishedAt)||0;
        if(newPub&&lastPub&&newPub!==lastPub){
          lastPub=newPub;
          try{window.dispatchEvent(new CustomEvent('blueferret:published',{detail:{publishedAt:newPub}}));}catch(e){}
          if(document.visibilityState==='hidden'){
            var u=new URL(location.href);
            u.searchParams.set('v',newPub);
            location.href=u.toString();
          }else{
            showUpdateNotice(newPub);
          }
        }
      }).catch(function(){});
    },30000);
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',function(){load();});else{load();}
  try {
    var su=new URL(location.href);
    if(su.searchParams.has('v')) {
      su.searchParams.delete('v');
      history.replaceState(null, '', su.toString());
    }
  }catch(e){}
})();`;

app.get('/api/public/runtime.js', (_req, res) => {
  res.type('application/javascript').setHeader('Cache-Control','no-store, no-cache, must-revalidate, proxy-revalidate');
  res.send(RUNTIME_JS);
});

app.use((err, _req, res, next) => {
  if (!err) return next();
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({error:'file_too_large'});
  if (err.statusCode) return res.status(err.statusCode).json({error:err.message || 'upload_error'});
  res.status(500).json({error:'server_error'});
});

// ---------- SPA ----------
app.get(['/admin','/admin/','/admin/*'], (_req, res) =>
  res.sendFile(path.join(__dirname,'public','index.html')));
app.get('/api/health', (_req, res) => {
  let dbOk = false, uploadsOk = false;
  try { db.prepare('SELECT 1').get(); dbOk = true; } catch {}
  try { fs.accessSync(UPLOADS, fs.constants.R_OK | fs.constants.W_OK); uploadsOk = true; } catch {}
  const counts = {
    games: db.prepare('SELECT COUNT(*) as n FROM games').get().n,
    publishedGames: db.prepare("SELECT COUNT(*) as n FROM games WHERE status='published'").get().n,
    kik: db.prepare('SELECT COUNT(*) as n FROM kik_projects').get().n,
    media: (() => { try { return fs.readdirSync(UPLOADS).filter(f => !f.startsWith('.')).length; } catch { return 0; } })(),
  };
  res.json({ ok: dbOk && uploadsOk, ts: Date.now(), uptime: Math.round(process.uptime()), dbOk, uploadsOk, counts });
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'not_found' }));
app.use((err, req, res, _next) => {
  console.error('[blueferret-admin]', req.method, req.url, err);
  if (res.headersSent) return;
  res.status(err.status || 500).json({ error: err.message || 'server_error' });
});

setImmediate(() => {
  try {
    syncPublicGames();
    console.log('[blueferret-admin] public games synced on boot');
  } catch (err) {
    console.error('[blueferret-admin] boot sync failed', err);
  }
});

const server = app.listen(PORT, HOST, () =>
  console.log(`[blueferret-admin] http://${HOST}:${PORT}`));

function shutdown(signal) {
  console.log(`[blueferret-admin] ${signal}: graceful shutdown`);
  server.close(() => {
    try { db.close(); } catch {}
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 8000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('unhandledRejection', err => console.error('[blueferret-admin] unhandledRejection', err));
process.on('uncaughtException', err => console.error('[blueferret-admin] uncaughtException', err));
