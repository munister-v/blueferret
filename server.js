'use strict';
const express = require('express');
const crypto  = require('crypto');
const path    = require('path');
const fs      = require('fs');
const Database = require('better-sqlite3');

const PORT      = parseInt(process.env.PORT || '4100', 10);
const HOST      = process.env.HOST || '127.0.0.1';
const PASS_HASH = (process.env.ADMIN_PASS_HASH ||
  'cf1f40037282725a43a2968b3b7509db30ffceaa33039ae1b6dc7a7a3927c5ac').toLowerCase();
const DB_PATH   = process.env.DB_PATH || path.join(__dirname, 'data', 'blueferret.db');
const STATIC_ROOT = process.env.STATIC_ROOT || '/var/www/blueferret';

// ---------- DB ----------
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER);
  CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, ip TEXT, action TEXT, detail TEXT);
  CREATE TABLE IF NOT EXISTS games (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    subtitle TEXT,
    description TEXT,
    status TEXT DEFAULT 'published',
    cover_url TEXT,
    gallery TEXT DEFAULT '[]',
    players TEXT,
    age TEXT,
    duration TEXT,
    buy_url TEXT,
    sort_order INTEGER DEFAULT 0,
    created_at INTEGER,
    updated_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS kik_projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    subtitle TEXT,
    description TEXT,
    status TEXT DEFAULT 'active',
    goal INTEGER DEFAULT 0,
    raised INTEGER DEFAULT 0,
    backers INTEGER DEFAULT 0,
    cover_url TEXT,
    campaign_url TEXT,
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

function getSetting(key, fallback){
  const r = getRow.get(key);
  if (!r) return fallback;
  try { return JSON.parse(r.value); } catch { return fallback; }
}
function setSetting(key, val){ upsert.run(key, JSON.stringify(val), Date.now()); }
function audit(ip, action, detail){
  try { insAudit.run(Date.now(), ip||'', action, detail ? JSON.stringify(detail).slice(0,2000) : null); } catch {}
}

let SECRET = getSetting('__secret', null);
if (!SECRET){ SECRET = crypto.randomBytes(32).toString('hex'); setSetting('__secret', SECRET); }

// ---------- setting schema ----------
const DEFAULTS = {
  general:      { siteTitle:'Blue Ferret', tagline:'Незалежне видавництво настільних ігор', primaryColor:'#009fe3', publishedAt:0 },
  homepage:     { heroTitle:'', heroSubtitle:'', heroCta:'', heroCtaLink:'', aboutText:'', featureTitle:'', featureText:'', featureLink:'' },
  maintenance:  { enabled:false, message:'Сайт тимчасово на технічному обслуговуванні. Скоро повернемось!' },
  banner:       { enabled:false, text:'', link:'', bg:'#009fe3', fg:'#ffffff' },
  contacts:     { email:'rogachovanika@gmail.com', telegram:'https://t.me/blueferret_game', instagram:'https://www.instagram.com/blueferret_game', facebook:'https://facebook.com/blueferret_game', x:'' },
  seo:          { defaultTitle:'', defaultDescription:'', ogImage:'', noindex:false },
  integrations: { headScripts:'', bodyScripts:'' },
  appearance:   { customCss:'' },
};
const PUBLIC_KEYS   = ['general','maintenance','banner','appearance','integrations','contacts','homepage'];
const EDITABLE_KEYS = Object.keys(DEFAULTS);

function fullSettings(){
  const out = {};
  for (const k of EDITABLE_KEYS) out[k] = Object.assign({}, DEFAULTS[k], getSetting(k, {}));
  return out;
}

// ---------- app ----------
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '10mb' }));

app.use((req, _res, next) => {
  req.cookies = {};
  const h = req.headers.cookie;
  if (h) for (const part of h.split(';')){
    const i = part.indexOf('=');
    if (i > -1) req.cookies[part.slice(0,i).trim()] = decodeURIComponent(part.slice(i+1).trim());
  }
  next();
});

// ---------- auth ----------
const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');
function makeToken(){
  const payload = `${Date.now()}.${crypto.randomBytes(8).toString('hex')}`;
  const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
  return `${payload}.${sig}`;
}
function validToken(tok){
  if (!tok) return false;
  const i = tok.lastIndexOf('.');
  if (i < 0) return false;
  const payload = tok.slice(0,i), sig = tok.slice(i+1);
  const exp = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
  if (sig.length !== exp.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(exp))) return false;
  const ts = parseInt(payload.split('.')[0], 10);
  return ts && (Date.now() - ts) < 7 * 24 * 3600 * 1000;
}
function requireAuth(req, res, next){
  if (validToken(req.cookies.bf_session)) return next();
  res.status(401).json({ error:'unauthorized' });
}

const attempts = new Map();
function throttled(ip){ const a = attempts.get(ip); return a && a.until > Date.now(); }
function bump(ip, ok){
  if (ok){ attempts.delete(ip); return; }
  const a = attempts.get(ip) || { n:0, until:0 };
  a.n += 1;
  if (a.n >= 5){ a.until = Date.now() + 10*60*1000; a.n = 0; }
  attempts.set(ip, a);
}

app.post('/api/admin/login', (req, res) => {
  const ip = req.ip;
  if (throttled(ip)) return res.status(429).json({ error:'too_many_attempts' });
  const ok = sha256(req.body?.password || '') === PASS_HASH;
  bump(ip, ok); audit(ip, ok?'login_ok':'login_fail', null);
  if (!ok) return res.status(401).json({ error:'invalid_password' });
  res.setHeader('Set-Cookie', `bf_session=${makeToken()}; HttpOnly; Path=/; Max-Age=${7*24*3600}; SameSite=Lax`);
  res.json({ ok:true });
});
app.post('/api/admin/logout', (_req, res) => {
  res.setHeader('Set-Cookie', 'bf_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax');
  res.json({ ok:true });
});
app.get('/api/admin/me', (req, res) => res.json({ authenticated:validToken(req.cookies.bf_session) }));

// ---------- settings ----------
app.get('/api/admin/settings', requireAuth, (_req, res) => res.json(fullSettings()));
app.put('/api/admin/settings', requireAuth, (req, res) => {
  const body = req.body || {};
  const changed = [];
  for (const k of EDITABLE_KEYS){
    if (body[k] && typeof body[k] === 'object'){
      setSetting(k, Object.assign({}, DEFAULTS[k], getSetting(k, {}), body[k]));
      changed.push(k);
    }
  }
  const g = Object.assign({}, DEFAULTS.general, getSetting('general', {}));
  g.publishedAt = Date.now();
  setSetting('general', g);
  audit(req.ip, 'settings_save', { changed });
  res.json({ ok:true, changed, settings:fullSettings() });
});
app.get('/api/admin/audit', requireAuth, (_req, res) => {
  res.json(db.prepare('SELECT ts,ip,action,detail FROM audit ORDER BY id DESC LIMIT 100').all());
});

// ---------- image upload ----------
const ALLOWED_EXT = new Set(['jpg','jpeg','png','gif','webp','avif','svg']);
app.post('/api/admin/upload', requireAuth, (req, res) => {
  try {
    const { filename, data } = req.body || {};
    if (!data || !filename) return res.status(400).json({ error:'missing data or filename' });
    const ext = (filename.split('.').pop()||'').toLowerCase();
    if (!ALLOWED_EXT.has(ext)) return res.status(400).json({ error:'unsupported file type' });
    const safe = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
    const dir  = path.join(STATIC_ROOT, 'uploads');
    fs.mkdirSync(dir, { recursive:true });
    const buf = Buffer.from(data.replace(/^data:[^;]+;base64,/, ''), 'base64');
    fs.writeFileSync(path.join(dir, safe), buf);
    audit(req.ip, 'upload', { filename:safe, bytes:buf.length });
    res.json({ url:`/uploads/${safe}` });
  } catch(e){ res.status(500).json({ error:'upload failed', detail:e.message }); }
});

// ---------- PUBLIC endpoints ----------
app.get('/api/public/site.json', (_req, res) => {
  const s = fullSettings(), pub = {};
  for (const k of PUBLIC_KEYS) pub[k] = s[k];
  res.setHeader('Cache-Control','public, max-age=30');
  res.json(pub);
});

app.get('/api/public/runtime.js', (_req, res) => {
  res.type('application/javascript').setHeader('Cache-Control','public, max-age=60');
  res.send(RUNTIME_JS);
});

// ---------- GAMES CRUD ----------
const gamesAll  = db.prepare('SELECT * FROM games ORDER BY sort_order ASC, id ASC');
const gamesOne  = db.prepare('SELECT * FROM games WHERE id=?');
const gamesSlug = db.prepare('SELECT * FROM games WHERE slug=?');
const gamesIns  = db.prepare(`INSERT INTO games(slug,title,subtitle,description,status,cover_url,gallery,players,age,duration,buy_url,sort_order,created_at,updated_at)
  VALUES(@slug,@title,@subtitle,@description,@status,@cover_url,@gallery,@players,@age,@duration,@buy_url,@sort_order,@created_at,@updated_at)`);
const gamesUpd  = db.prepare(`UPDATE games SET slug=@slug,title=@title,subtitle=@subtitle,description=@description,status=@status,cover_url=@cover_url,gallery=@gallery,players=@players,age=@age,duration=@duration,buy_url=@buy_url,sort_order=@sort_order,updated_at=@updated_at WHERE id=@id`);
const gamesDel  = db.prepare('DELETE FROM games WHERE id=?');
const parseGallery = v => { try { return JSON.parse(v||'[]'); } catch { return []; } };
const gameRow   = r => r ? { ...r, gallery:parseGallery(r.gallery) } : null;

app.get('/api/admin/games', requireAuth, (_req, res) => res.json(gamesAll.all().map(gameRow)));
app.get('/api/admin/games/:id', requireAuth, (req, res) => {
  const r = gamesOne.get(Number(req.params.id));
  if (!r) return res.status(404).json({ error:'not_found' });
  res.json(gameRow(r));
});
app.post('/api/admin/games', requireAuth, (req, res) => {
  const b = req.body || {};
  if (!b.title) return res.status(400).json({ error:'title required' });
  const slug = (b.slug||b.title).toLowerCase().replace(/[^a-zа-яіїєґ0-9]+/gi,'-').replace(/^-|-$/g,'');
  if (gamesSlug.get(slug)) return res.status(409).json({ error:'slug_exists' });
  const t = Date.now();
  const info = gamesIns.run({ slug, title:b.title, subtitle:b.subtitle||'', description:b.description||'',
    status:b.status||'published', cover_url:b.cover_url||'', gallery:JSON.stringify(b.gallery||[]),
    players:b.players||'', age:b.age||'', duration:b.duration||'', buy_url:b.buy_url||'',
    sort_order:b.sort_order||0, created_at:t, updated_at:t });
  audit(req.ip,'game_create',{ id:info.lastInsertRowid, slug });
  res.status(201).json(gameRow(gamesOne.get(info.lastInsertRowid)));
});
app.put('/api/admin/games/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const ex = gamesOne.get(id);
  if (!ex) return res.status(404).json({ error:'not_found' });
  const b = req.body || {};
  const slug = (b.slug||ex.slug).toLowerCase().replace(/[^a-zа-яіїєґ0-9]+/gi,'-').replace(/^-|-$/g,'');
  const conflict = gamesSlug.get(slug);
  if (conflict && conflict.id !== id) return res.status(409).json({ error:'slug_exists' });
  gamesUpd.run({ id, slug, title:b.title||ex.title, subtitle:b.subtitle??ex.subtitle,
    description:b.description??ex.description, status:b.status||ex.status,
    cover_url:b.cover_url??ex.cover_url, gallery:JSON.stringify(b.gallery||parseGallery(ex.gallery)),
    players:b.players??ex.players, age:b.age??ex.age, duration:b.duration??ex.duration,
    buy_url:b.buy_url??ex.buy_url, sort_order:b.sort_order??ex.sort_order, updated_at:Date.now() });
  audit(req.ip,'game_update',{ id, slug });
  res.json(gameRow(gamesOne.get(id)));
});
app.delete('/api/admin/games/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!gamesOne.get(id)) return res.status(404).json({ error:'not_found' });
  gamesDel.run(id);
  audit(req.ip,'game_delete',{ id });
  res.json({ ok:true });
});
app.get('/api/public/games', (_req, res) => {
  res.setHeader('Cache-Control','public, max-age=30');
  res.json(gamesAll.all().filter(g=>g.status==='published').map(gameRow));
});

// ---------- KIK CRUD ----------
const kikAll = db.prepare('SELECT * FROM kik_projects ORDER BY sort_order ASC, id ASC');
const kikOne = db.prepare('SELECT * FROM kik_projects WHERE id=?');
const kikIns = db.prepare(`INSERT INTO kik_projects(title,subtitle,description,status,goal,raised,backers,cover_url,campaign_url,ends_at,sort_order,created_at,updated_at)
  VALUES(@title,@subtitle,@description,@status,@goal,@raised,@backers,@cover_url,@campaign_url,@ends_at,@sort_order,@created_at,@updated_at)`);
const kikUpd = db.prepare(`UPDATE kik_projects SET title=@title,subtitle=@subtitle,description=@description,status=@status,goal=@goal,raised=@raised,backers=@backers,cover_url=@cover_url,campaign_url=@campaign_url,ends_at=@ends_at,sort_order=@sort_order,updated_at=@updated_at WHERE id=@id`);
const kikDel = db.prepare('DELETE FROM kik_projects WHERE id=?');

app.get('/api/admin/kik', requireAuth, (_req, res) => res.json(kikAll.all()));
app.get('/api/admin/kik/:id', requireAuth, (req, res) => {
  const r = kikOne.get(Number(req.params.id)); if (!r) return res.status(404).json({ error:'not_found' }); res.json(r);
});
app.post('/api/admin/kik', requireAuth, (req, res) => {
  const b = req.body || {};
  if (!b.title) return res.status(400).json({ error:'title required' });
  const t = Date.now();
  const info = kikIns.run({ title:b.title, subtitle:b.subtitle||'', description:b.description||'',
    status:b.status||'active', goal:b.goal||0, raised:b.raised||0, backers:b.backers||0,
    cover_url:b.cover_url||'', campaign_url:b.campaign_url||'', ends_at:b.ends_at||null,
    sort_order:b.sort_order||0, created_at:t, updated_at:t });
  audit(req.ip,'kik_create',{ id:info.lastInsertRowid, title:b.title });
  res.status(201).json(kikOne.get(info.lastInsertRowid));
});
app.put('/api/admin/kik/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const ex = kikOne.get(id); if (!ex) return res.status(404).json({ error:'not_found' });
  const b = req.body || {};
  kikUpd.run({ id, title:b.title||ex.title, subtitle:b.subtitle??ex.subtitle,
    description:b.description??ex.description, status:b.status||ex.status,
    goal:b.goal??ex.goal, raised:b.raised??ex.raised, backers:b.backers??ex.backers,
    cover_url:b.cover_url??ex.cover_url, campaign_url:b.campaign_url??ex.campaign_url,
    ends_at:b.ends_at??ex.ends_at, sort_order:b.sort_order??ex.sort_order, updated_at:Date.now() });
  audit(req.ip,'kik_update',{ id });
  res.json(kikOne.get(id));
});
app.delete('/api/admin/kik/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!kikOne.get(id)) return res.status(404).json({ error:'not_found' });
  kikDel.run(id);
  audit(req.ip,'kik_delete',{ id });
  res.json({ ok:true });
});
app.get('/api/public/kik', (_req, res) => {
  res.setHeader('Cache-Control','public, max-age=30');
  res.json(kikAll.all());
});

// ---------- admin SPA ----------
app.use('/uploads', express.static(path.join(STATIC_ROOT,'uploads')));
app.get(['/admin','/admin/','/admin/*'], (_req, res) =>
  res.sendFile(path.join(__dirname,'public','index.html')));
app.get('/api/health', (_req, res) => res.json({ ok:true, ts:Date.now() }));

// ---------- runtime.js ----------
const RUNTIME_JS = `/* Blue Ferret CMS runtime v2 */
(function(){
'use strict';
var ESC={};
function escHtml(x){return String(x||'').replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}

function applySettings(s){
  if(!s) return;
  var g=s.general||{}, b=s.banner||{}, m=s.maintenance||{}, ig=s.integrations||{}, ap=s.appearance||{}, hp=s.homepage||{};

  // Theme color
  if(g.primaryColor) document.documentElement.style.setProperty('--bf-accent',g.primaryColor);

  // Custom CSS
  if(ap.customCss){
    var st=document.getElementById('bf-css')||document.createElement('style');
    st.id='bf-css'; st.textContent=ap.customCss;
    if(!st.parentNode) document.head.appendChild(st);
  }

  // Head scripts
  if(ig.headScripts && !window.__bfHead){
    window.__bfHead=1;
    var d=document.createElement('div'); d.innerHTML=ig.headScripts;
    Array.from(d.childNodes).forEach(function(n){
      if(n.tagName==='SCRIPT'){var sc=document.createElement('script');
        for(var i=0;i<n.attributes.length;i++) sc.setAttribute(n.attributes[i].name,n.attributes[i].value);
        sc.text=n.textContent; document.head.appendChild(sc);
      } else { document.head.appendChild(n.cloneNode(true)); }
    });
  }

  // Body scripts
  if(ig.bodyScripts && !window.__bfBody){
    window.__bfBody=1;
    var bd=document.createElement('div'); bd.innerHTML=ig.bodyScripts;
    Array.from(bd.childNodes).forEach(function(n){
      if(n.tagName==='SCRIPT'){var sc=document.createElement('script');
        for(var i=0;i<n.attributes.length;i++) sc.setAttribute(n.attributes[i].name,n.attributes[i].value);
        sc.text=n.textContent; document.body.appendChild(sc);
      } else { document.body.appendChild(n.cloneNode(true)); }
    });
  }

  // Banner
  var bEl=document.getElementById('bf-banner');
  if(b.enabled && b.text){
    var el=bEl||document.createElement('div'); el.id='bf-banner';
    el.style.cssText='position:relative;z-index:9998;width:100%;padding:10px 16px;text-align:center;font:600 14px/1.4 Comfortaa,system-ui,sans-serif;background:'+(b.bg||'#009fe3')+';color:'+(b.fg||'#fff')+';';
    el.innerHTML=b.link?'<a href="'+escHtml(b.link)+'" style="color:inherit;text-decoration:underline">'+escHtml(b.text)+'</a>':escHtml(b.text);
    if(!bEl) document.body.insertBefore(el,document.body.firstChild);
  } else if(bEl){ bEl.remove(); }

  // Maintenance overlay
  var mo=document.getElementById('bf-maintenance');
  if(m.enabled){
    if(!mo){
      mo=document.createElement('div'); mo.id='bf-maintenance';
      mo.style.cssText='position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;text-align:center;padding:24px;background:#0b1f33;color:#fff;font:500 20px/1.6 Comfortaa,system-ui,sans-serif;';
      mo.innerHTML='<div style="max-width:560px"><div style="font-size:48px;margin-bottom:20px">🦦</div><div>'+escHtml(m.message||'')+'</div></div>';
      document.body.appendChild(mo); document.documentElement.style.overflow='hidden';
    }
  } else if(mo){ mo.remove(); document.documentElement.style.overflow=''; }

  // Homepage content injection
  var pth=location.pathname.replace(/\\/+$/,'');
  if(pth===''||pth==='/index.html'||pth.endsWith('/index.html')){
    injectHomepage(hp, g);
  }

  // Games page — replace with live data
  if(pth.endsWith('/igry')||pth.endsWith('/igry/index.html')){
    injectGames();
  }

  // KIK page — replace with live data
  if(pth.endsWith('/kik')||pth.endsWith('/kik/index.html')){
    injectKik();
  }
}

function injectHomepage(hp, g){
  if(!hp) return;
  // Override h1 if set
  if(hp.heroTitle){
    var h1=document.querySelector('h1');
    if(h1) h1.textContent=hp.heroTitle;
    document.title=hp.heroTitle+(g.tagline?' | '+g.tagline:'');
  }
  // Inject feature block if set
  if(hp.featureTitle||hp.featureText){
    if(!document.getElementById('bf-feature')){
      var el=document.createElement('section');
      el.id='bf-feature';
      el.style.cssText='padding:32px;background:rgba(0,159,227,.07);border-radius:16px;margin:32px auto;max-width:860px;font-family:Comfortaa,sans-serif;';
      el.innerHTML=(hp.featureTitle?'<h2 style="font-family:Libre Baskerville,serif;font-size:22px;color:#1e293b;margin-bottom:10px">'+escHtml(hp.featureTitle)+'</h2>':'')+
        (hp.featureText?'<p style="color:#334155;font-size:15px;line-height:1.7">'+escHtml(hp.featureText)+'</p>':'')+
        (hp.featureLink?'<a href="'+escHtml(hp.featureLink)+'" style="display:inline-block;margin-top:14px;background:#009fe3;color:#fff;padding:10px 22px;border-radius:10px;font-weight:700;text-decoration:none;font-size:14px">Детальніше →</a>':'');
      var main=document.querySelector('main')||document.body;
      main.insertBefore(el, main.firstChild);
    }
  }
}

function injectGames(){
  fetch('/api/public/games',{cache:'no-store'})
    .then(function(r){return r.json();})
    .then(function(games){
      if(!games||!games.length) return;
      var existing=document.getElementById('bf-live-games');
      if(existing) existing.remove();
      var sec=document.createElement('section');
      sec.id='bf-live-games';
      sec.style.cssText='padding:32px 24px;max-width:1100px;margin:0 auto;font-family:Comfortaa,sans-serif;';
      sec.innerHTML='<h2 style="font-family:Libre Baskerville,serif;font-size:26px;color:#1e293b;margin-bottom:24px">Наші ігри</h2>'+
        '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:20px">'+
        games.map(function(g){
          return '<article style="background:#fff;border:1px solid rgba(15,23,42,.1);border-radius:16px;overflow:hidden;box-shadow:0 2px 8px rgba(15,23,42,.06)">' +
            (g.cover_url?'<img src="'+escHtml(g.cover_url)+'" style="width:100%;height:180px;object-fit:cover" loading="lazy">':'<div style="height:90px;background:rgba(0,159,227,.08);display:flex;align-items:center;justify-content:center;font-size:36px">🎲</div>')+
            '<div style="padding:16px">'+
            '<h3 style="font-family:Libre Baskerville,serif;font-size:17px;margin-bottom:6px;color:#1e293b">'+escHtml(g.title)+'</h3>'+
            (g.subtitle?'<p style="font-size:13px;color:#64748b;margin-bottom:8px">'+escHtml(g.subtitle)+'</p>':'')+
            '<div style="font-size:12px;color:#94a3b8;margin-bottom:12px">'+[g.players,g.age,g.duration].filter(Boolean).join(' · ')+'</div>'+
            (g.buy_url?'<a href="'+escHtml(g.buy_url)+'" style="display:inline-block;background:#009fe3;color:#fff;padding:8px 18px;border-radius:8px;font-size:13px;font-weight:700;text-decoration:none">Купити</a>':'')+
            '</div></article>';
        }).join('')+'</div>';
      var main=document.querySelector('main')||document.body;
      main.insertBefore(sec, main.firstChild);
    }).catch(function(){});
}

function injectKik(){
  fetch('/api/public/kik',{cache:'no-store'})
    .then(function(r){return r.json();})
    .then(function(projects){
      if(!projects||!projects.length) return;
      var existing=document.getElementById('bf-live-kik');
      if(existing) existing.remove();
      var sec=document.createElement('section');
      sec.id='bf-live-kik';
      sec.style.cssText='padding:32px 24px;max-width:1100px;margin:0 auto;font-family:Comfortaa,sans-serif;';
      sec.innerHTML='<h2 style="font-family:Libre Baskerville,serif;font-size:26px;color:#1e293b;margin-bottom:24px">КІК-проекти</h2>'+
        '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:20px">'+
        projects.map(function(k){
          var pct=k.goal?Math.min(100,Math.round(k.raised/k.goal*100)):0;
          return '<article style="background:#fff;border:1px solid rgba(75,178,114,.2);border-radius:16px;overflow:hidden;box-shadow:0 2px 8px rgba(15,23,42,.06)">'+
            (k.cover_url?'<img src="'+escHtml(k.cover_url)+'" style="width:100%;height:160px;object-fit:cover" loading="lazy">':'')+
            '<div style="padding:18px">'+
            '<h3 style="font-family:Libre Baskerville,serif;font-size:17px;margin-bottom:6px;color:#1e293b">'+escHtml(k.title)+'</h3>'+
            (k.subtitle?'<p style="font-size:13px;color:#64748b;margin-bottom:10px">'+escHtml(k.subtitle)+'</p>':'')+
            '<div style="font-size:13px;color:#334155;margin-bottom:6px">'+k.raised.toLocaleString('uk')+'<span style="color:#94a3b8"> / '+k.goal.toLocaleString('uk')+' ₴ · '+k.backers+' бекерів</span></div>'+
            '<div style="height:6px;background:rgba(15,23,42,.08);border-radius:99px;overflow:hidden;margin-bottom:14px"><div style="height:100%;width:'+pct+'%;background:#4bb272;border-radius:99px"></div></div>'+
            (k.campaign_url?'<a href="'+escHtml(k.campaign_url)+'" style="display:inline-block;background:#4bb272;color:#fff;padding:8px 18px;border-radius:8px;font-size:13px;font-weight:700;text-decoration:none">Підтримати</a>':'')+
            '</div></article>';
        }).join('')+'</div>';
      var main=document.querySelector('main')||document.body;
      main.insertBefore(sec, main.firstChild);
    }).catch(function(){});
}

function load(){
  fetch('/api/public/site.json',{cache:'no-store'})
    .then(function(r){return r.json();})
    .then(applySettings)
    .catch(function(){});
}
if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',load); else load();
})();
`;

app.listen(PORT, HOST, () => console.log(`[blueferret-admin] http://${HOST}:${PORT}`));
