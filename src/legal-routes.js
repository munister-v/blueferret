// HTTP glue for the admin's "Документи" tab: read and save the legal pages'
// Markdown; saving rebuilds the public page at once. The Markdown lives in
// data/legal/<slug>.md; a page with no Markdown yet (it was filled in by hand
// on the server) is read back from its live HTML the first time.
const fs = require('fs');
const path = require('path');
const legal = require('./legal');

const MAX_MD = 200 * 1024;
const KEEP = 20;

function mount(app, { requireAuth, audit, siteRoot, dataDir }) {
  const dir = path.join(dataDir, 'legal');
  const mdFile = slug => path.join(dir, `${slug}.md`);
  const pageFile = slug => path.join(siteRoot, slug, 'index.html');
  const known = slug => legal.PAGES.find(p => p.slug === slug);

  const writeAtomic = (f, s) => { const tmp = `${f}.tmp-${process.pid}`; fs.writeFileSync(tmp, s); fs.renameSync(tmp, f); };
  // Old versions next to the file, newest KEEP kept.
  function backup(f, tag) {
    if (!fs.existsSync(f)) return;
    fs.copyFileSync(f, `${f}.bak-${tag}-${Date.now()}`);
    const base = path.basename(f), d = path.dirname(f);
    const old = fs.readdirSync(d).filter(x => x.startsWith(`${base}.bak-${tag}-`)).sort().reverse().slice(KEEP);
    for (const x of old) { try { fs.unlinkSync(path.join(d, x)); } catch {} }
  }

  function readMd(slug) {
    try { return { md: fs.readFileSync(mdFile(slug), 'utf8'), updatedAt: fs.statSync(mdFile(slug)).mtimeMs }; } catch {}
    try {
      const md = legal.htmlToMd(fs.readFileSync(pageFile(slug), 'utf8'));
      if (md) return { md, updatedAt: fs.statSync(pageFile(slug)).mtimeMs };
    } catch {}
    return { md: `# ${known(slug).title}\n\n`, updatedAt: null };
  }

  app.get('/api/admin/legal', requireAuth, (_req, res) => {
    res.json(legal.PAGES.map(p => {
      const { md, updatedAt } = readMd(p.slug);
      return { slug: p.slug, title: p.title, url: `/${p.slug}/`, updatedAt, placeholders: legal.placeholders(legal.render(md)) };
    }));
  });

  app.get('/api/admin/legal/:slug', requireAuth, (req, res) => {
    const p = known(req.params.slug);
    if (!p) return res.status(404).json({ error: 'not_found' });
    res.json({ slug: p.slug, title: p.title, url: `/${p.slug}/`, ...readMd(p.slug) });
  });

  // Preview without saving: the rendered article body only.
  app.post('/api/admin/legal/:slug/preview', requireAuth, (req, res) => {
    if (!known(req.params.slug)) return res.status(404).json({ error: 'not_found' });
    const md = String((req.body && req.body.md) || '');
    if (md.length > MAX_MD) return res.status(400).json({ error: 'text_too_long' });
    const body = legal.render(md);
    res.json({ body, placeholders: legal.placeholders(body) });
  });

  app.put('/api/admin/legal/:slug', requireAuth, (req, res) => {
    const p = known(req.params.slug);
    if (!p) return res.status(404).json({ error: 'not_found' });
    const md = String((req.body && req.body.md) || '').replace(/\r\n?/g, '\n');
    if (!md.trim()) return res.status(400).json({ error: 'empty' });
    if (md.length > MAX_MD) return res.status(400).json({ error: 'text_too_long' });
    let built;
    try { built = legal.build(siteRoot, p.slug, md); }
    catch (e) { return res.status(500).json({ error: 'build_failed', detail: e.message }); }
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.mkdirSync(path.dirname(pageFile(p.slug)), { recursive: true });
      backup(mdFile(p.slug), 'legal');
      backup(pageFile(p.slug), 'legal');
      writeAtomic(mdFile(p.slug), md);
      writeAtomic(pageFile(p.slug), built.html);
    } catch (e) { return res.status(500).json({ error: 'write_failed', detail: e.message }); }
    audit(req.ip, 'legal_save', { page: p.slug, placeholders: built.placeholders });
    res.json({ ok: true, url: `/${p.slug}/`, placeholders: built.placeholders, updatedAt: Date.now() });
  });
}

module.exports = { mount };
