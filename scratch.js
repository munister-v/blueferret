const fs = require('fs');
const path = require('path');
const PAGES_ROOT = path.join(__dirname, 'site');

function listPages() {
  const pages = [];
  function walk(dir, rel='') {
    let items;
    try { items = fs.readdirSync(dir); } catch { return; }
    for (const f of items) {
      if (f.startsWith('.') || f.startsWith('_next') || f==='uploads' || f==='cdn-cgi') continue;
      
      const full = path.join(dir,f), r2 = rel ? `${rel}/${f}` : f;
      const stat = fs.statSync(full);
      
      if (stat.isDirectory()) {
        if (rel === 'igry') continue; 
        if (rel === 'kik/proekty') continue;
        walk(full, r2);
      }
      else if (f==='index.html') pages.push({ path: rel||'/', file: r2, mtime: stat.mtimeMs });
    }
  }
  walk(PAGES_ROOT);
  return pages.sort((a,b)=>a.path.localeCompare(b.path));
}

console.log(listPages().map(p => p.path));
