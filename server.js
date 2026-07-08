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
  if (validToken(req.cookies.bf_session)) return next();
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
  const g = Object.assign({}, DEFAULTS.general, getSetting('general', {}));
  g.publishedAt = Date.now();
  setSetting('general', g);
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

const gAll  = db.prepare('SELECT * FROM games ORDER BY sort_order,id');
const gOne  = db.prepare('SELECT * FROM games WHERE id=?');
const gSlug = db.prepare('SELECT * FROM games WHERE slug=?');
const gIns  = db.prepare(`INSERT INTO games(slug,title,subtitle,description,status,cover_url,gallery,players,age,duration,buy_url,sort_order,created_at,updated_at)
  VALUES(@slug,@title,@subtitle,@description,@status,@cover_url,@gallery,@players,@age,@duration,@buy_url,@sort_order,@t,@t)`);
const gUpd  = db.prepare(`UPDATE games SET slug=@slug,title=@title,subtitle=@subtitle,description=@description,status=@status,cover_url=@cover_url,gallery=@gallery,players=@players,age=@age,duration=@duration,buy_url=@buy_url,sort_order=@sort_order,updated_at=@t WHERE id=@id`);
const gDel  = db.prepare('DELETE FROM games WHERE id=?');

function gameBody(b, ex={}) {
  const slug = (b.slug||ex.slug||b.title||'').toLowerCase().replace(/[^a-zа-яіїєґ0-9]+/gi,'-').replace(/^-|-$/g,'');
  return { slug, title:b.title??ex.title, subtitle:b.subtitle??ex.subtitle??'', description:b.description??ex.description??'',
    status:b.status||ex.status||'published', cover_url:b.cover_url??ex.cover_url??'',
    gallery:JSON.stringify(b.gallery||parseGallery(ex.gallery)), players:b.players??ex.players??'',
    age:b.age??ex.age??'', duration:b.duration??ex.duration??'', buy_url:b.buy_url??ex.buy_url??'',
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
  audit(req.ip,'game_create',{id:info.lastInsertRowid,slug:data.slug});
  res.status(201).json(gameRow(gOne.get(info.lastInsertRowid)));
});
app.put('/api/admin/games/:id', requireAuth, (req, res) => {
  const id=+req.params.id, ex=gOne.get(id);
  if (!ex) return res.status(404).json({error:'not_found'});
  const data = gameBody(req.body||{}, ex);
  const c = gSlug.get(data.slug);
  if (c && c.id!==id) return res.status(409).json({error:'slug_exists'});
  gUpd.run({...data,id});
  audit(req.ip,'game_update',{id});
  res.json(gameRow(gOne.get(id)));
});
app.delete('/api/admin/games/:id', requireAuth, (req, res) => {
  const id=+req.params.id;
  if (!gOne.get(id)) return res.status(404).json({error:'not_found'});
  gDel.run(id); audit(req.ip,'game_delete',{id}); res.json({ok:true});
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

app.get('/api/admin/kik', requireAuth, (_r, res) => res.json(kAll.all()));
app.get('/api/admin/kik/:id', requireAuth, (req, res) => {
  const r=kOne.get(+req.params.id); if(!r) return res.status(404).json({error:'not_found'}); res.json(r);
});
app.post('/api/admin/kik', requireAuth, (req, res) => {
  const b=req.body||{}; if(!b.title) return res.status(400).json({error:'title required'});
  const data=kikBody(b); const info=kIns.run(data);
  audit(req.ip,'kik_create',{id:info.lastInsertRowid,title:data.title});
  res.status(201).json(kOne.get(info.lastInsertRowid));
});
app.put('/api/admin/kik/:id', requireAuth, (req, res) => {
  const id=+req.params.id, ex=kOne.get(id);
  if(!ex) return res.status(404).json({error:'not_found'});
  const data=kikBody(req.body||{},ex); kUpd.run({...data,id});
  audit(req.ip,'kik_update',{id}); res.json(kOne.get(id));
});
app.delete('/api/admin/kik/:id', requireAuth, (req, res) => {
  const id=+req.params.id;
  if(!kOne.get(id)) return res.status(404).json({error:'not_found'});
  kDel.run(id); audit(req.ip,'kik_delete',{id}); res.json({ok:true});
});

// ---------- media upload ----------
const storage = multer.diskStorage({
  destination: (_req, _f, cb) => cb(null, UPLOADS),
  filename: (_req, file, cb) => {
    const ext  = path.extname(file.originalname).toLowerCase();
    const base = path.basename(file.originalname, ext).replace(/[^a-z0-9а-яіїєґ]/gi,'-').slice(0,40);
    cb(null, `${base}-${Date.now()}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 10*1024*1024 },
  fileFilter: (_r, f, cb) => cb(null, /\.(jpe?g|png|webp|gif|svg|avif)$/i.test(f.originalname)),
});

app.post('/api/admin/upload', requireAuth, upload.single('file'), (req, res) => {
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
      // skip garbage: empty, too long, or concatenated nav (many words, no sentence)
      if(t && t.length>=2 && t.length<=160){
        add(`${tag}_${i}`, tag, tag==='h1'?'Заголовок H1':tag==='h2'?'Заголовок H2':'Підзаголовок',
            tag==='h1'?'H₁':tag==='h2'?'H₂':'H₃', t, m[0], m[1], i);
      }
      i++;
    }
  }

  // ── Paragraphs — ONLY pure-text <p> (nested tags = likely concatenated UI) ──
  const pr=/<p[^>]*>([\s\S]*?)<\/p>/gi; let pi=0, kept=0;
  while((m=pr.exec(safe))!==null && kept<14){
    const inner=m[1];
    const t=cleanInner(inner);
    // require: real sentence-length text, no nested tags (avoids nav/footer concatenation),
    // must contain a space (single jammed word = bad), reasonable length
    const looksConcat=/[а-яёіїєa-z][A-ZА-ЯЁІЇЄ]/.test(t); // lowercase→Uppercase with no space
    if(t && !hasNestedTag(inner) && !looksConcat && t.includes(' ') && t.length>=25 && t.length<=900){
      add(`p_${pi}`,'p','Абзац текст','¶',t,m[0],inner,pi);
      kept++;
    }
    pi++;
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
  fs.writeFileSync(outFile, html, 'utf8');
  audit(req.ip,'page_create',{slug,title});
  res.status(201).json({ok:true, slug, file:`${slug}/index.html`, path:`/${slug}/`});
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
  audit(req.ip,'page_delete',{path:rel});
  res.json({ok:true});
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
    fs.writeFileSync(newPath,newContent,'utf8');
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
          if(h.includes(oldName)){ h=h.split(oldName).join(newName); fs.writeFileSync(full,h,'utf8'); htmlChanged++; }
        }
      }
    })(SITE_ROOT);
    // best-effort SELinux restore
    try{ execFileSync('restorecon',['-R',SITE_ROOT],{stdio:'ignore',timeout:15000}); }catch{}
    audit(req.ip,'content_save',{applied,bundle:newName,htmlChanged});
    res.json({ok:true, applied, bundle:newName, htmlChanged});
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
  fs.copyFileSync(srcFull,path.join(dir,'index.html'));
  audit(req.ip,'page_duplicate',{from,slug});
  res.status(201).json({ok:true,slug,file:`${slug}/index.html`,path:`/${slug}/`});
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
  fs.writeFileSync(full + '.bak', html);
  let changed = 0;
  for (const b of blocks) {
    if (!b.orig || b.origVal === b.newVal || b.newVal == null) continue;
    const encoded = encodeHtmlEnts(b.newVal);
    // replace origVal inside the orig element context
    const newOrig = b.orig.replace(b.origVal, encoded);
    if (newOrig !== b.orig) { html = html.split(b.orig).join(newOrig); changed++; }
  }
  fs.writeFileSync(full, html, 'utf8');
  audit(req.ip, 'page_patch', {path: rel, changed});
  res.json({ok: true, changed});
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
  fs.writeFileSync(full+'.bak', fs.existsSync(full)?fs.readFileSync(full):'');
  fs.writeFileSync(full, content, 'utf8');
  audit(req.ip,'page_edit',{path:rel});
  res.json({ok:true});
});

// ---------- public ----------
app.get('/api/public/site.json', (_req, res) => {
  const s=fullSettings(), pub={};
  for(const k of PUBLIC_KEYS) pub[k]=s[k];
  res.setHeader('Cache-Control','public, max-age=30');
  res.json(pub);
});
app.get('/api/public/games', (_req, res) => {
  res.setHeader('Cache-Control','public, max-age=30');
  res.json(gAll.all().filter(g=>g.status==='published').map(gameRow));
});
app.get('/api/public/kik', (_req, res) => {
  res.setHeader('Cache-Control','public, max-age=30');
  res.json(kAll.all());
});

const RUNTIME_JS = `(function(){
  function apply(s){try{
    if(!s)return;
    var a=s.appearance||{},b=s.banner||{},m=s.maintenance||{},ig=s.integrations||{},g=s.general||{};
    if(g.primaryColor)document.documentElement.style.setProperty('--bf-primary',g.primaryColor);
    if(a.customCss){var st=document.getElementById('bf-css')||Object.assign(document.createElement('style'),{id:'bf-css'});st.textContent=a.customCss;if(!st.parentNode)document.head.appendChild(st);}
    if(ig.headScripts&&!window.__bfH){window.__bfH=1;var d=document.createElement('div');d.innerHTML=ig.headScripts;d.childNodes.forEach(function(n){if(n.tagName==='SCRIPT'){var sc=document.createElement('script');for(var i=0;i<n.attributes.length;i++)sc.setAttribute(n.attributes[i].name,n.attributes[i].value);sc.text=n.textContent;document.head.appendChild(sc);}else document.head.appendChild(n.cloneNode(true));});}
    var ex=document.getElementById('bf-banner');
    if(b.enabled&&b.text){var el=ex||document.createElement('div');el.id='bf-banner';el.style.cssText='position:relative;z-index:9998;width:100%;padding:10px 16px;text-align:center;font:600 14px/1.4 Comfortaa,system-ui,sans-serif;background:'+(b.bg||'#2E9BE6')+';color:'+(b.fg||'#fff')+';';el.innerHTML=b.link?'<a href="'+b.link+'" style="color:inherit;text-decoration:underline">'+esc(b.text)+'</a>':esc(b.text);if(!ex)document.body.insertBefore(el,document.body.firstChild);}else if(ex)ex.remove();
    var mo=document.getElementById('bf-maintenance');
    if(m.enabled){if(!mo){mo=document.createElement('div');mo.id='bf-maintenance';mo.style.cssText='position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;text-align:center;padding:24px;background:#0b1f33;color:#fff;font:500 20px/1.6 Comfortaa,system-ui,sans-serif;';mo.innerHTML='<div style="max-width:560px"><div style="font-size:40px;margin-bottom:16px">🦦</div><div>'+esc(m.message||'')+'</div></div>';document.body.appendChild(mo);document.documentElement.style.overflow='hidden';}}else if(mo){mo.remove();document.documentElement.style.overflow='';}
  }catch(e){}}
  function esc(x){return String(x).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
  function load(){fetch('/api/public/site.json',{cache:'no-store'}).then(function(r){return r.json();}).then(apply).catch(function(){});}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',load);else load();
})();`;

app.get('/api/public/runtime.js', (_req, res) => {
  res.type('application/javascript').setHeader('Cache-Control','public, max-age=60');
  res.send(RUNTIME_JS);
});

// ---------- SPA ----------
app.get(['/admin','/admin/','/admin/*'], (_req, res) =>
  res.sendFile(path.join(__dirname,'public','index.html')));
app.get('/api/health', (_req, res) => res.json({ok:true,ts:Date.now()}));

app.listen(PORT, HOST, () =>
  console.log(`[blueferret-admin] http://${HOST}:${PORT}`));
