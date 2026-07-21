const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'blueferret.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

function backupDatabase() {
  try {
    const backupDir = path.join(__dirname, '..', 'backups');
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, {recursive: true});
    const date = new Date().toISOString().split('T')[0];
    const backupFile = path.join(backupDir, `blueferret-${date}.db`);
    if (!fs.existsSync(backupFile)) {
      db.backup(backupFile).then(() => {
        console.log(`Database backed up to ${backupFile}`);
        const files = fs.readdirSync(backupDir).sort();
        if (files.length > 7) {
          for (let i = 0; i < files.length - 7; i++) {
            fs.unlinkSync(path.join(backupDir, files[i]));
          }
        }
      }).catch(err => console.error('Backup failed:', err));
    }
  } catch(e) { console.error('Backup error:', e); }
}
setInterval(backupDatabase, 1000 * 60 * 60);
backupDatabase();

// Table setups
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

try { db.exec("ALTER TABLE games ADD COLUMN gallery TEXT DEFAULT '[]'"); } catch(e){}
try { db.exec("ALTER TABLE games ADD COLUMN stages TEXT DEFAULT '[]'"); } catch(e){}
try { db.exec("ALTER TABLE games ADD COLUMN author TEXT DEFAULT ''"); } catch(e){}
try { db.exec("ALTER TABLE games ADD COLUMN bg_color TEXT DEFAULT ''"); } catch(e){}
try { db.exec("ALTER TABLE games ADD COLUMN accent_color TEXT DEFAULT ''"); } catch(e){}
try { db.exec("ALTER TABLE games ADD COLUMN hero_bg_url TEXT DEFAULT ''"); } catch(e){}
try { db.exec("ALTER TABLE games ADD COLUMN hero_logo_url TEXT DEFAULT ''"); } catch(e){}
try { db.exec("ALTER TABLE games ADD COLUMN links TEXT DEFAULT '[]'"); } catch(e){}
try { db.exec("ALTER TABLE games ADD COLUMN always_visible INTEGER DEFAULT 1"); } catch(e){}

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

module.exports = {
  db,
  getSetting,
  setSetting,
  audit
};
