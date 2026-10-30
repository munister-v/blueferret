// HTTP glue for preorders: a public request form endpoint and the admin list / export.
// PREORDER_PROJECTS (comma-separated project ids) switches preorders on per project; empty = off.
const INVOICE_DATE = process.env.PREORDER_INVOICE_DATE || '5 грудня';
const ENABLED = (process.env.PREORDER_PROJECTS || '').split(',').map(x => x.trim()).filter(Boolean);

function mount(app, { preorders, requireAuth, readKikProjects, audit }) {
  const noStore = res => res.setHeader('Cache-Control', 'no-store');
  const open = id => ENABLED.includes(String(id));
  const find = id => { const b = readKikProjects(); return (b && b.arr.find(x => x.id === String(id) && x.status === 'active')) || null; };

  const hits = new Map();
  function limited(ip) {
    const t = Date.now(), arr = (hits.get(ip) || []).filter(x => t - x < 10 * 60 * 1000);
    arr.push(t); hits.set(ip, arr);
    if (hits.size > 5000) hits.clear();
    return arr.length > 6;
  }

  // What the form needs: whether preorders are on and the sets to choose from.
  app.get('/api/preorder/info', (req, res) => {
    noStore(res);
    const id = String(req.query.project || '');
    const p = open(id) && find(id);
    if (!p) return res.json({ enabled: false });
    res.json({
      enabled: true, project: p.id, name: p.name, invoiceDate: INVOICE_DATE,
      tiers: ((p.support && p.support.tiers) || []).map(t => ({ id: t.id, title: t.title, amount: t.amount })),
    });
  });

  app.post('/api/preorder', (req, res) => {
    noStore(res);
    const body = req.body || {};
    if (body.website) return res.json({ ok: true }); // honeypot: bots fill every field
    if (limited(req.ip)) return res.status(429).json({ error: 'Забагато спроб. Спробуйте за кілька хвилин.' });
    const p = open(body.projectId) && find(body.projectId);
    if (!p) return res.status(404).json({ error: 'Передзамовлення для цього проєкту не приймаються.' });
    const r = preorders.create(p, body);
    if (!r.ok) return res.status(r.duplicate ? 409 : 400).json({ error: r.error, field: r.field });
    audit(req.ip, 'preorder_created', { id: r.id, project: p.id });
    res.json({ ok: true, id: r.id, tier: r.tier, total: r.total });
  });

  app.get('/api/admin/preorders', requireAuth, (req, res) => {
    const id = String(req.query.project || '');
    if (!id) return res.status(400).json({ error: 'project required' });
    res.json(preorders.summary(id));
  });
  app.get('/api/admin/preorders.csv', requireAuth, (req, res) => {
    const id = String(req.query.project || '');
    if (!id) return res.status(400).json({ error: 'project required' });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="preorders-${id.replace(/[^\w-]/g, '')}.csv"`);
    res.send(preorders.csv(id));
  });
  app.post('/api/admin/preorders/:id/status', requireAuth, (req, res) => {
    const r = preorders.setStatus(Number(req.params.id), String((req.body || {}).status || ''));
    if (r.ok) audit(req.ip, 'preorder_status', { id: req.params.id, status: req.body.status });
    res.status(r.ok ? 200 : r.error === 'not_found' ? 404 : 400).json(r);
  });
  app.post('/api/admin/preorders/:id/note', requireAuth, (req, res) => {
    const r = preorders.setNote(Number(req.params.id), (req.body || {}).note);
    res.status(r.ok ? 200 : 404).json(r);
  });
}

module.exports = { mount };
