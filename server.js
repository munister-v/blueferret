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
function writeBackup(file) {
  if (!fs.existsSync(file)) return;
  const ts = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  fs.copyFileSync(file, `${file}.bak-${ts}`);
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
function gameRow(r) { return r ? { ...r, gallery: parseGallery(r.gallery) } : null; }

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
  const aMatch = gridOuterHTML.match(/<a [^>]*href="\/igry\/[^"]+"[^>]*>[\s\S]*?<\/a>/i);
  if (!aMatch) return;
  const template = aMatch[0];
  
  function getStatusName(s) { return s==='draft'?'Чернетка':s==='archived'?'Архів':s==='preorder'?'Передзамовлення':s==='onsale'?'У продажі':'Анонс'; }
  const games = gAll.all().filter(g => g.status !== 'archived').map(gameRow);

  // Extract the first card's title and description text for replacement
  // In minified HTML, text may sit directly in divs without h2/p wrappers
  const firstGame = games[0] || {};
  const firstTitle = escapeHtml(firstGame.title || 'Тримайся');
  const firstDesc = escapeHtml(firstGame.description || firstGame.subtitle || '');
  
  const newCards = games.map(g => {
    let card = template;
    // Replace href
    card = card.replace(/href="\/igry\/[^"]+"\/?/, `href="${g.buy_url || '/igry/'+g.slug+'/'}"`);
    // Replace image src
    card = card.replace(/src="[^"]+"/, `src="${g.cover_url || '/images/placeholder-game.svg'}"`);
    // Replace alt
    card = card.replace(/alt="[^"]*"/, `alt="${escapeHtml(g.title||'')}"`);
    // Replace title: try h2 first, then find raw text in the card body
    const h2re = /(<h2[^>]*>)[\s\S]*?(<\/h2>)/i;
    if (h2re.test(card)) {
      card = card.replace(h2re, `$1${escapeHtml(g.title||'')}$2`);
    } else if (firstTitle && card.includes(firstTitle)) {
      card = card.replace(firstTitle, escapeHtml(g.title||''));
    }
    // Replace description: try p first, then find raw text
    const pre = /(<p[^>]*>)[\s\S]*?(<\/p>)/i;
    if (pre.test(card)) {
      card = card.replace(pre, `$1${escapeHtml(g.description||g.subtitle||'')}$2`);
    } else if (firstDesc && firstDesc.length > 20 && card.includes(firstDesc)) {
      card = card.replace(firstDesc, escapeHtml(g.description||g.subtitle||''));
    }
    // Replace status badge
    const badgeRe = /(<span[^>]*board-game-badge[^>]*>)[\s\S]*?(<\/span>)/i;
    if (badgeRe.test(card)) {
      card = card.replace(badgeRe, `$1${getStatusName(g.status)}$2`);
    }
    return card;
  });
  
  const firstCloseBracket = gridOuterHTML.indexOf('>');
  const newGridHTML = gridOuterHTML.slice(0, firstCloseBracket + 1) + newCards.join('') + '</div>';
  
  let newHtml = html.slice(0, divStart) + newGridHTML + html.slice(gridEnd);
  
  const countRegex = /(<span[^>]*>)\s*\d+\s*(ігри|гра|ігор)\s+в\s+каталозі\s*(<\/span>)/i;
  newHtml = newHtml.replace(countRegex, `$1${games.length} ${games.length===1?'гра':'ігри'} в каталозі$3`);
  
  newHtml = newHtml.replace(/<script>window\.__BF_IGRY_HTML=[\s\S]*?<\/script>/i, '');
  
  writeAtomic(p, newHtml);
}

function cleanText(v) { return String(v ?? '').trim(); }
function escapeHtml(s) {
  return cleanText(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#x27;'}[c]));
}
function generatedGameHtml(g) {
  const title = escapeHtml(g.title || g.slug);
  const subtitle = escapeHtml(g.subtitle || g.players || 'Настільна гра Blue Ferret');
  const cover = escapeHtml(g.cover_url || '/images/placeholder-game.svg');
  const coverAbs = cover.startsWith('http') ? cover : 'https://blueferret.com.ua' + cover;
  const statusRaw = (g.status || 'published');
  const statusLabel = {draft:'Чернетка',archived:'Архів',preorder:'Передзамовлення',onsale:'У продажі'}[statusRaw] || 'Анонс';
  const players = escapeHtml(g.players || '');
  const age = escapeHtml(g.age || '');
  const duration = escapeHtml(g.duration || '');
  const buy = escapeHtml(g.buy_url || '');
  const rawDesc = (g.description || '').trim() || 'Опис гри скоро з\'явиться.';
  const metaDesc = escapeHtml(rawDesc.replace(/\n/g,' ').slice(0, 155));
  const descHtml = rawDesc.split('\n').filter(p => p.trim()).map(p => `<p>${escapeHtml(p)}</p>`).join('');
  const year = new Date().getFullYear();
  const passportCards = [
    players && `<div class="pp-card"><div class="pp-ico">👥</div><div class="pp-label">Гравці</div><div class="pp-val">${players}</div></div>`,
    duration && `<div class="pp-card"><div class="pp-ico">⏱</div><div class="pp-label">Тривалість</div><div class="pp-val">${duration}</div></div>`,
    age && `<div class="pp-card"><div class="pp-ico">🎂</div><div class="pp-label">Від якого віку</div><div class="pp-val">${age}</div></div>`,
    `<div class="pp-card"><div class="pp-ico">🎲</div><div class="pp-label">Видавець</div><div class="pp-val">Blue Ferret</div></div>`,
  ].filter(Boolean).join('');
  return `<!doctype html>
<html lang="uk">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${title} | Blue Ferret</title>
<meta name="description" content="${metaDesc}">
<link rel="canonical" href="https://blueferret.com.ua/igry/${escapeHtml(g.slug)}/">
<meta property="og:title" content="${title} | Blue Ferret">
<meta property="og:description" content="${metaDesc}">
<meta property="og:url" content="https://blueferret.com.ua/igry/${escapeHtml(g.slug)}/">
<meta property="og:type" content="article">
<meta property="og:image" content="${coverAbs}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${title} | Blue Ferret">
<meta name="twitter:image" content="${coverAbs}">
<link rel="shortcut icon" href="/favicon.ico">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:ital,wght@0,400;0,500;0,600;0,700;0,800;0,900&display=swap">
<link rel="stylesheet" href="/bf.css?v=8">
<style>
*{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth}
body{font-family:'Inter',system-ui,sans-serif;background:rgb(7,11,16);color:#fff;-webkit-font-smoothing:antialiased;overflow-x:hidden}
/* ── HEADER ── */
.gp-header{height:64px;display:flex;align-items:center;justify-content:space-between;padding:0 24px;position:sticky;top:0;z-index:100;background:rgba(10,15,26,.96);border-bottom:1px solid rgba(255,255,255,.05);backdrop-filter:blur(14px)}
.gp-logo{display:flex;align-items:center;gap:12px;text-decoration:none}
.gp-logo img{width:40px;height:40px;object-fit:contain}
.gp-logo-name{font-weight:800;font-size:15px;color:#fff;letter-spacing:-.01em}
.gp-logo-sub{font-size:10px;text-transform:uppercase;letter-spacing:.18em;color:#94a3b8}
.gp-nav{display:flex;align-items:center;gap:4px}
.gp-nav a{color:#94a3b8;text-decoration:none;font-weight:500;font-size:14px;padding:8px 14px;border-radius:10px;transition:color .2s,background .2s}
.gp-nav a:hover{color:#fff;background:rgba(255,255,255,.09)}
.gp-nav a.active{color:#fff;font-weight:700;background:rgba(255,255,255,.12)}
@media(max-width:768px){.gp-nav{display:none}}
/* ── HERO ── */
.gp-hero{position:relative;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;overflow:hidden}
.gp-hero-bg{position:absolute;inset:0}
.gp-hero-bg img{width:100%;height:100%;object-fit:cover;object-position:center top}
.gp-hero-overlay{position:absolute;inset:0;background:linear-gradient(180deg,rgba(7,11,16,.5) 0%,rgba(7,11,16,.05) 35%,rgba(7,11,16,.82) 100%)}
.gp-hero-body{position:relative;z-index:10;text-align:center;padding:40px 24px;max-width:820px}
.gp-kicker{display:inline-flex;align-items:center;gap:8px;background:rgba(0,159,227,.12);border:1px solid rgba(0,159,227,.3);border-radius:99px;padding:8px 20px;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.15em;color:#6ed0f7;margin-bottom:24px}
.gp-hero-title{font-size:clamp(52px,10vw,110px);font-weight:900;line-height:.88;letter-spacing:-.04em;color:#fff;text-shadow:0 4px 48px rgba(0,0,0,.65);margin-bottom:18px}
.gp-hero-sub{font-size:clamp(16px,2.5vw,21px);color:rgba(255,255,255,.65);max-width:560px;margin:0 auto 32px;line-height:1.5}
.gp-hero-scroll{position:absolute;bottom:28px;left:50%;transform:translateX(-50%);display:flex;flex-direction:column;align-items:center;gap:6px;color:rgba(255,255,255,.35);font-size:10px;font-weight:700;letter-spacing:.22em;text-transform:uppercase;animation:gpBounce 2.2s ease-in-out infinite}
.gp-hero-scroll::after{content:'';width:1px;height:38px;background:linear-gradient(to bottom,rgba(255,255,255,.28),transparent)}
@keyframes gpBounce{0%,100%{transform:translateX(-50%) translateY(0)}50%{transform:translateX(-50%) translateY(-9px)}}
/* ── BUTTONS ── */
.gp-btn-p{display:inline-flex;align-items:center;justify-content:center;height:52px;padding:0 28px;border-radius:14px;background:#009fe3;color:#fff;font-weight:700;font-size:15px;text-decoration:none;box-shadow:0 10px 28px -10px rgba(0,159,227,.65);transition:all .2s}
.gp-btn-p:hover{background:#0088c4;transform:translateY(-2px);box-shadow:0 16px 36px -10px rgba(0,159,227,.8)}
.gp-btn-s{display:inline-flex;align-items:center;justify-content:center;height:52px;padding:0 24px;border-radius:14px;background:rgba(255,255,255,.06);color:rgba(255,255,255,.7);font-weight:600;font-size:15px;text-decoration:none;border:1px solid rgba(255,255,255,.1);transition:all .2s}
.gp-btn-s:hover{background:rgba(255,255,255,.1);color:#fff;border-color:rgba(255,255,255,.2)}
.gp-actions{display:flex;flex-wrap:wrap;gap:12px;margin-top:28px}
/* ── PASSPORT ── */
.gp-section{padding:72px 24px}
.gp-inner{max-width:960px;margin:0 auto}
.gp-eyebrow{font-size:11px;font-weight:700;letter-spacing:.22em;text-transform:uppercase;color:rgba(255,255,255,.28);margin-bottom:12px}
.gp-stitle{font-size:clamp(24px,4vw,36px);font-weight:900;color:rgba(255,255,255,.9);margin-bottom:36px;letter-spacing:-.025em}
.pp-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:14px;margin-bottom:32px}
.pp-card{background:rgb(11,17,24);border:1px solid rgb(16,24,35);border-radius:16px;padding:22px;transition:border-color .25s}
.pp-card:hover{border-color:rgba(0,159,227,.22)}
.pp-ico{font-size:20px;margin-bottom:10px}
.pp-label{font-size:10px;font-weight:700;letter-spacing:.15em;text-transform:uppercase;color:rgba(255,255,255,.28);margin-bottom:6px}
.pp-val{font-size:15px;font-weight:600;color:rgba(255,255,255,.85)}
.gp-status{display:inline-flex;align-items:center;gap:8px;padding:10px 20px;border-radius:99px;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;background:rgba(0,159,227,.1);border:1px solid rgba(0,159,227,.28);color:#6ed0f7}
.gp-status-dot{width:7px;height:7px;border-radius:50%;background:#009fe3;box-shadow:0 0 10px #009fe3;flex-shrink:0}
/* ── ABOUT ── */
.gp-about{padding:72px 24px;background:rgb(9,13,19)}
.gp-about-inner{max-width:960px;margin:0 auto;display:grid;grid-template-columns:1fr 1.15fr;gap:52px;align-items:center}
.gp-cover{border-radius:24px;overflow:hidden;box-shadow:0 40px 80px -24px rgba(0,0,0,.8),0 0 0 1px rgba(255,255,255,.06);aspect-ratio:3/4;background:rgb(11,17,24)}
.gp-cover img{width:100%;height:100%;object-fit:cover;display:block}
.gp-about-body h2{font-size:clamp(22px,3vw,30px);font-weight:900;color:rgba(255,255,255,.9);margin-bottom:6px;letter-spacing:-.02em}
.gp-divider{width:100%;height:1px;background:rgba(255,255,255,.07);margin:20px 0}
.gp-desc{font-size:15.5px;line-height:1.85;color:rgba(255,255,255,.58)}
.gp-desc p{margin-bottom:14px}
.gp-desc p:last-child{margin-bottom:0}
/* ── FOOTER ── */
.gp-footer{background:linear-gradient(180deg,rgb(9,13,19),rgb(7,11,16));padding:56px 24px 40px;border-top:1px solid rgba(255,255,255,.06)}
.gp-footer-inner{max-width:960px;margin:0 auto;display:flex;flex-direction:column;align-items:center;gap:14px;text-align:center}
.gp-footer-logo{display:flex;align-items:center;gap:10px}
.gp-footer-logo img{width:30px;height:30px;object-fit:contain;opacity:.65}
.gp-footer-brand{font-weight:800;font-size:14px;color:rgba(255,255,255,.45)}
.gp-footer-desc{color:rgba(255,255,255,.25);font-size:13px}
.gp-footer-copy{color:rgba(255,255,255,.2);font-size:12px}
.gp-footer-copy a{color:rgba(0,159,227,.6);text-decoration:none}
.gp-footer-copy a:hover{color:#009fe3}
/* ── SCROLL REVEAL ── */
.rv{opacity:0;transform:translateY(26px);transition:opacity .6s ease,transform .6s ease}
.rv.vis{opacity:1;transform:none}
.rv-l{opacity:0;transform:translateX(-28px);transition:opacity .65s ease,transform .65s ease}
.rv-l.vis{opacity:1;transform:none}
.rv-r{opacity:0;transform:translateX(28px);transition:opacity .65s ease,transform .65s ease}
.rv-r.vis{opacity:1;transform:none}
/* ── RESPONSIVE ── */
@media(max-width:768px){
  .gp-about-inner{grid-template-columns:1fr;gap:28px}
  .gp-cover{aspect-ratio:16/9;order:-1}
  .pp-grid{grid-template-columns:repeat(2,1fr)}
  .gp-hero-title{letter-spacing:-.03em}
}
</style>
</head>
<body>
<div data-bf-generated-game="true">

<header class="gp-header">
  <a class="gp-logo" href="/">
    <img src="/logo-blue-ferret.png" alt="Blue Ferret">
    <div>
      <div class="gp-logo-name">BLUE FERRET</div>
      <div class="gp-logo-sub">видавництво</div>
    </div>
  </a>
  <nav class="gp-nav">
    <a href="/">Головна</a>
    <a href="/igry/" class="active">Наші ігри</a>
    <a href="/kontakty/">Контакти</a>
  </nav>
</header>

<section class="gp-hero">
  <div class="gp-hero-bg">
    <img src="${coverAbs}" alt="${title}" loading="eager">
  </div>
  <div class="gp-hero-overlay"></div>
  <div class="gp-hero-body">
    <div class="gp-kicker">${statusLabel}</div>
    <h1 class="gp-hero-title">${title}</h1>
    <p class="gp-hero-sub">${subtitle}</p>
    ${buy
      ? `<a class="gp-btn-p" href="${buy}">Придбати →</a>`
      : `<a class="gp-btn-s" href="#pro-gru">Дізнатися більше ↓</a>`
    }
  </div>
  <div class="gp-hero-scroll">Scroll</div>
</section>

<section class="gp-section" id="pro-gru" style="background:rgb(9,13,19)">
  <div class="gp-inner">
    <div class="rv">
      <p class="gp-eyebrow">Про гру</p>
      <h2 class="gp-stitle">Паспорт гри</h2>
    </div>
    <div class="pp-grid">${passportCards}</div>
    <div class="rv">
      <span class="gp-status"><span class="gp-status-dot"></span>${statusLabel}</span>
    </div>
  </div>
</section>

<section class="gp-about">
  <div class="gp-about-inner">
    <figure class="gp-cover rv-l">
      <img src="${cover}" alt="${title}" loading="lazy">
    </figure>
    <div class="gp-about-body rv-r">
      <p class="gp-eyebrow">Опис</p>
      <h2>Що за гра?</h2>
      <div class="gp-divider"></div>
      <div class="gp-desc">${descHtml}</div>
      <div class="gp-actions">
        ${buy ? `<a class="gp-btn-p" href="${buy}">Придбати →</a>` : ''}
        <a class="gp-btn-s" href="/igry/">← Усі ігри</a>
      </div>
    </div>
  </div>
</section>

<footer class="gp-footer">
  <div class="gp-footer-inner">
    <div class="gp-footer-logo">
      <img src="/logo-blue-ferret.png" alt="Blue Ferret">
      <span class="gp-footer-brand">Blue Ferret</span>
    </div>
    <p class="gp-footer-desc">Незалежне видавництво настільних ігор</p>
    <p class="gp-footer-copy">© ${year} <a href="/">Blue Ferret</a>. Всі права захищені.</p>
  </div>
</footer>

</div>
<script>
(function(){
  var io=new IntersectionObserver(function(es){
    es.forEach(function(e){
      if(e.isIntersecting){e.target.classList.add('vis');io.unobserve(e.target);}
    });
  },{threshold:.1,rootMargin:'0px 0px -36px 0px'});
  document.querySelectorAll('.rv,.rv-l,.rv-r').forEach(function(el){io.observe(el);});
})();
</script>
<script src="/api/public/runtime.js" defer></script>
</body>
</html>`;
}
function writeGeneratedGamePage(row) {
  const g = gameRow(row);
  if (!g || !g.slug) return;
  const dir = path.join(SITE_ROOT, 'igry', g.slug);
  const file = path.join(dir, 'index.html');
  if (fs.existsSync(file)) {
    // Only overwrite if the file was itself generated by this function
    const existing = fs.readFileSync(file, 'utf8');
    if (!existing.includes('data-bf-generated-game="true"')) return;
  }
  writeAtomic(file, generatedGameHtml(g));
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
const gIns  = db.prepare(`INSERT INTO games(slug,title,subtitle,description,status,cover_url,gallery,players,age,duration,buy_url,sort_order,created_at,updated_at)
  VALUES(@slug,@title,@subtitle,@description,@status,@cover_url,@gallery,@players,@age,@duration,@buy_url,@sort_order,@t,@t)`);
const gUpd  = db.prepare(`UPDATE games SET slug=@slug,title=@title,subtitle=@subtitle,description=@description,status=@status,cover_url=@cover_url,gallery=@gallery,players=@players,age=@age,duration=@duration,buy_url=@buy_url,sort_order=@sort_order,updated_at=@t WHERE id=@id`);
const gDel  = db.prepare('DELETE FROM games WHERE id=?');

function gameBody(b, ex={}) {
  const rawSlug = (b.slug||ex.slug||b.title||'').toLowerCase().replace(/[^a-zа-яіїєґ0-9]+/gi,'-').replace(/^-|-$/g,'');
  const slug = rawSlug || `game-${Date.now()}`;
  const gallery = Array.isArray(b.gallery) ? b.gallery : parseGallery(ex.gallery);
  return { slug, title:cleanText(b.title??ex.title), subtitle:cleanText(b.subtitle??ex.subtitle??''), description:cleanText(b.description??ex.description??''),
    status:b.status||ex.status||'published', cover_url:cleanText(b.cover_url??ex.cover_url??''),
    gallery:JSON.stringify(gallery), players:cleanText(b.players??ex.players??''),
    age:cleanText(b.age??ex.age??''), duration:cleanText(b.duration??ex.duration??''), buy_url:cleanText(b.buy_url??ex.buy_url??''),
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
  writeGeneratedGamePage(gOne.get(info.lastInsertRowid));
  regenGamesCatalog();
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
  writeGeneratedGamePage(gOne.get(id));
  regenGamesCatalog();
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
  regenGamesCatalog();
  const publishedAt = bumpPublishedAt();
  audit(req.ip,'game_delete',{id,publishedAt});
  res.json({ok:true,publishedAt});
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

app.get('/api/admin/media', requireAuth, (_req, res) => {
  try {
    const files = fs.readdirSync(UPLOADS)
      .filter(f => !f.startsWith('.') && /\.(jpe?g|png|webp|gif|svg|avif)$/i.test(f))
      .map(f => {
        const stat = fs.statSync(path.join(UPLOADS, f));
        return { filename:f, url:`/uploads/${f}`, size:stat.size, mtime:stat.mtimeMs };
      }).sort((a,b) => b.mtime - a.mtime);
    res.json(files);
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

function extractBlocks(html){
  // strip non-content regions so their text never leaks into blocks
  const safe = html
    .replace(/<script[\s\S]*?<\/script>/gi,'')
    .replace(/<style[\s\S]*?<\/style>/gi,'')
    .replace(/<svg[\s\S]*?<\/svg>/gi,'')
    .replace(/<header[\s\S]*?<\/header>/gi,'')
    .replace(/<nav[\s\S]*?<\/nav>/gi,'')
    .replace(/<footer[\s\S]*?<\/footer>/gi,'');
  const headOnly = html.slice(0, html.indexOf('</head>')+7 || 2000);

  const blocks=[], seenText=new Set();
  const add=(id,type,label,icon,value,orig,origVal,idx)=>{
    const v=(value||'').trim();
    if(!v) return;
    const key=type+'|'+v;
    if(seenText.has(key)) return; seenText.add(key);
    blocks.push({id,type,label,icon,value:v,orig,origVal,domIndex:idx});
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
  const pr=/<p[^>]*>([\s\S]*?)<\/p>/gi; let pi=0, kept=0;
  while((m=pr.exec(safe))!==null && kept<14){
    const inner=m[1];
    const t=cleanInner(inner);
    const looksConcat=/[а-яёіїєa-z][A-ZА-ЯЁІЇЄ]/.test(t);
    // Allow paragraphs with simple inline tags (strong, em, a, etc.)
    const inlineOk = !hasNestedTag(inner) || hasOnlyInlineTags(inner);
    if(t && inlineOk && !looksConcat && t.includes(' ') && t.length>=20 && t.length<=900){
      add(`p_${pi}`,'p','Абзац тексту','¶',t,m[0],inner,pi);
      kept++;
    }
    pi++;
  }

  // ── Links (<a> with meaningful text) ──
  const ar=/<a[^>]*>([\s\S]*?)<\/a>/gi; let ai=0, aKept=0;
  while((m=ar.exec(safe))!==null && aKept<10){
    const inner=m[1];
    const t=cleanInner(inner);
    if(t && t.length>=3 && t.length<=120 && !/<img/i.test(inner)){
      add(`a_${ai}`,'a','Посилання / кнопка','🔗',t,m[0],inner,ai);
      aKept++;
    }
    ai++;
  }

  // ── Spans with meaningful text (badges, labels) ──
  const sr=/<span[^>]*>([^<]{4,80})<\/span>/gi; let si=0, sKept=0;
  while((m=sr.exec(safe))!==null && sKept<8){
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
  while((m=ir.exec(safe))!==null && iKept<8){
    const src=decodeHtmlEnts(m[1]).trim();
    // skip tiny icons, data URIs, tracking pixels
    if(src && !src.startsWith('data:') && src.length>5 && !/favicon|icon/i.test(src)){
      const alt=(m[0].match(/alt="([^"]*)"/)||[])[1]||'';
      add(`img_${ii}`,'img',decodeHtmlEnts(alt)||'Зображення','🖼',src,m[0],m[1],ii);
      iKept++;
    }
    ii++;
  }

  // ── List items (<li>) ──
  const lr=/<li[^>]*>([\s\S]*?)<\/li>/gi; let li=0, lKept=0;
  while((m=lr.exec(safe))!==null && lKept<6){
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
  if(copyFrom){
    const srcFull = path.join(PAGES_ROOT, copyFrom.replace(/\.\./g,''));
    if(fs.existsSync(srcFull)){
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

app.get('/api/admin/site-content', requireAuth, (_req,res)=>{
  const sc=readSiteContent();
  if(!sc) return res.status(404).json({error:'content bundle not found'});
  res.json({ content: sc.obj, bundle: sc.bundle.name });
});

app.put('/api/admin/site-content', requireAuth, (req,res)=>{
  const { changes } = req.body||{};
  if(!Array.isArray(changes)||!changes.length) return res.status(400).json({error:'no changes'});
  const sc=readSiteContent();
  if(!sc) return res.status(404).json({error:'content bundle not found'});
  let applied=0;
  for(const c of changes){
    if(c && typeof c.path==='string' && typeof c.value==='string'){
      if(setByPath(sc.obj,c.path,c.value)) applied++;
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
    const publishedAt = bumpPublishedAt();
    audit(req.ip,'content_save',{applied,bundle:newName,htmlChanged,publishedAt});
    res.json({ok:true, applied, bundle:newName, htmlChanged, publishedAt});
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
    res.json({ blocks: extractBlocks(html) });
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
  for (const b of blocks) {
    if (!b.orig || b.origVal === b.newVal || b.newVal == null) continue;
    // img blocks: replace src attribute value, not text content
    if (b.orig.match(/^<img\s/i)) {
      const newOrig = b.orig.replace(`src="${b.origVal}"`, `src="${encodeHtmlEnts(b.newVal)}"`);
      if (newOrig !== b.orig) { html = html.split(b.orig).join(newOrig); changed++; }
    } else {
      const encoded = encodeHtmlEnts(b.newVal);
      const newOrig = b.orig.replace(b.origVal, encoded);
      if (newOrig !== b.orig) { html = html.split(b.orig).join(newOrig); changed++; }
    }
  }
  writeAtomic(full, html);
  const publishedAt = bumpPublishedAt();
  audit(req.ip, 'page_patch', {path: rel, changed, publishedAt});
  res.json({ok: true, changed, publishedAt});
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
  res.json(gAll.all().filter(g=>g.status==='published').map(gameRow));
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
  // ── Live auto-refresh: poll publishedAt every 5s, reload if changed ──
  var lastPub=0;
  function startLiveRefresh(s){
    try{lastPub=(s&&s.general&&s.general.publishedAt)||0;}catch(e){}
    if(!lastPub)return;
    setInterval(function(){
      getJson('/api/public/site.json',4000).then(function(ns){
        var newPub=(ns&&ns.general&&ns.general.publishedAt)||0;
        if(newPub&&lastPub&&newPub!==lastPub){
          lastPub=newPub;
          var u=new URL(location.href);
          u.searchParams.set('v',newPub);
          location.href=u.toString();
        }
      }).catch(function(){});
    },5000);
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
