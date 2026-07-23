const fs = require('fs');
const path = require('path');

function writeAtomic(file, content) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}

const KEEP_BACKUPS = 10;

function writeBackup(file) {
  if (!fs.existsSync(file)) return;
  const ts = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 17); // to milliseconds — same-second saves must not collide
  fs.copyFileSync(file, `${file}.bak-${ts}`);
  // rotate: keep only the newest KEEP_BACKUPS timestamped copies per file
  try {
    const dir = path.dirname(file), base = path.basename(file);
    const re = new RegExp('^' + base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\.bak-\\d{14,17}$');
    const baks = fs.readdirSync(dir).filter(f => re.test(f)).sort(); // ts sorts lexicographically
    for (const old of baks.slice(0, Math.max(0, baks.length - KEEP_BACKUPS))) {
      fs.unlinkSync(path.join(dir, old));
    }
  } catch {}
}

// list timestamped backups for a file, newest first
function listBackups(file) {
  try {
    const dir = path.dirname(file), base = path.basename(file);
    const re = new RegExp('^' + base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\.bak-(\\d{14,17})$');
    return fs.readdirSync(dir)
      .map(f => { const m = f.match(re); return m ? { name: f, ts: m[1], size: fs.statSync(path.join(dir, f)).size } : null; })
      .filter(Boolean)
      .sort((a, b) => b.ts.localeCompare(a.ts));
  } catch { return []; }
}

module.exports = {
  writeAtomic,
  writeBackup,
  listBackups
};
