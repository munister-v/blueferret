// HTTP glue for monobank acquiring: public invoice + webhook endpoints, admin
// pledge list / refund endpoints, and the background catalog sync. The money
// logic itself lives in ./pledges and ./mono so it can be tested without HTTP.
const MAX_UAH = Number(process.env.MONO_MAX_UAH) || 50000;
// Comma-separated project ids that may take payments. Empty = every visible active project.
// Set it for the launch so a demo project can never accept real money by accident.
const ALLOWED = (process.env.MONO_ALLOWED_PROJECTS || '').split(',').map(x => x.trim()).filter(Boolean);
const PUBLIC_BASE = (process.env.PUBLIC_BASE_URL || 'https://blueferret.com.ua').replace(/\/+$/, '');

function mount(app, { mono, pledges, requireAuth, readKikProjects, applyRaisedDeltas, isPublishBusy, audit }) {
  const noStore = res => res.setHeader('Cache-Control', 'no-store');

  // ---- background: push confirmed money into the catalog ----
  let syncTimer = null;
  function scheduleSync(ms = 3000) {
    if (syncTimer) return;
    syncTimer = setTimeout(() => { syncTimer = null; flush(); }, ms);
    syncTimer.unref && syncTimer.unref();
  }
  function flush() {
    const { byProject, rows } = pledges.pendingDeltas();
    if (!rows.length) return;
    if (isPublishBusy()) return scheduleSync(5000);
    try {
      applyRaisedDeltas(byProject);
      pledges.markCounted(rows);
    } catch (e) {
      audit('system', 'mono_catalog_sync_failed', { error: String(e.message).slice(0, 200) });
      scheduleSync(30000);
    }
  }
  const every = (ms, fn) => { const t = setInterval(fn, ms); t.unref && t.unref(); };
  every(60 * 1000, flush);
  every(5 * 60 * 1000, async () => {
    if (!mono.enabled()) return;
    try { const r = await pledges.reconcile(); if (r.touched) scheduleSync(); }
    catch (e) { audit('system', 'mono_reconcile_failed', { error: String(e.message).slice(0, 200) }); }
  });

  // ---- public ----
  app.get('/api/mono/status', (_req, res) => { noStore(res); res.json({ enabled: mono.enabled() }); });

  const hits = new Map();
  function limited(ip) {
    const t = Date.now(), arr = (hits.get(ip) || []).filter(x => t - x < 10 * 60 * 1000);
    arr.push(t); hits.set(ip, arr);
    if (hits.size > 5000) hits.clear();
    return arr.length > 10;
  }

  function findProject(body) {
    const b = readKikProjects();
    if (!b) return null;
    if (body.projectId) return b.arr.find(x => x.id === String(body.projectId)) || null;
    // The current page sends no project id, only `kik-<id>-<tier>-<ts>`.
    const ref = String(body.reference || '');
    return b.arr.filter(x => ref.startsWith(`kik-${x.id}-`)).sort((a, c) => c.id.length - a.id.length)[0] || null;
  }

  app.post('/api/mono/invoice', async (req, res) => {
    noStore(res);
    if (!mono.enabled()) return res.status(503).json({ error: 'Онлайн-оплата тимчасово вимкнена.' });
    if (limited(req.ip)) return res.status(429).json({ error: 'Забагато спроб. Спробуйте за кілька хвилин.' });
    const body = req.body || {};
    const project = findProject(body);
    if (project && ALLOWED.length && !ALLOWED.includes(project.id)) return res.status(404).json({ error: 'Проєкт недоступний для підтримки.' });
    if (!project || project.status !== 'active') return res.status(404).json({ error: 'Проєкт недоступний для підтримки.' });

    const amountKop = Number(body.amount);
    const minUah = Math.max(1, Number(project.support && project.support.minDonation) || 1);
    if (!Number.isInteger(amountKop) || amountKop % 100 !== 0)
      return res.status(400).json({ error: 'Вкажіть суму в цілих гривнях.' });
    if (amountKop < minUah * 100)
      return res.status(400).json({ error: `Мінімальна сума підтримки — ${minUah} ₴.` });
    if (amountKop > MAX_UAH * 100)
      return res.status(400).json({ error: `Максимальна сума одним платежем — ${MAX_UAH} ₴.` });

    const tierLabel = String(body.tierLabel || String(body.gameName || '').split(' – ').slice(1).join(' – ')).slice(0, 80);
    const pledge = pledges.createPledge({ projectId: project.id, tierLabel, amountKop });
    try {
      const inv = await mono.createInvoice({
        amount: amountKop,
        reference: pledge.reference,
        destination: `Підтримка проєкту «${project.name}»` + (tierLabel ? ` — ${tierLabel}` : ''),
        redirectUrl: `${PUBLIC_BASE}/kik/proekty/?payment=return`,
        webHookUrl: `${PUBLIC_BASE}/api/mono/webhook`,
      });
      if (!inv.invoiceId || !inv.pageUrl) throw new Error('no invoice in response');
      pledges.attachInvoice(pledge.id, inv.invoiceId);
      audit(req.ip, 'mono_invoice_created', { pledge: pledge.id, project: project.id, amountKop });
      res.json({ pageUrl: inv.pageUrl });
    } catch (e) {
      pledges.discard(pledge.id);
      audit(req.ip, 'mono_invoice_failed', { project: project.id, error: String(e.message).slice(0, 200) });
      res.status(502).json({ error: 'Не вдалося створити рахунок. Спробуйте пізніше.' });
    }
  });

  app.post('/api/mono/webhook', async (req, res) => {
    if (!mono.enabled()) return res.status(503).end();
    let ok = false;
    try { ok = await mono.verifyWebhook(req.rawBody, req.get('x-sign')); }
    catch (e) {
      // Could not fetch the key: answer 5xx so monobank retries later.
      audit('mono', 'mono_webhook_verify_error', { error: String(e.message).slice(0, 200) });
      return res.status(503).end();
    }
    if (!ok) { audit(req.ip, 'mono_webhook_bad_signature', {}); return res.status(401).json({ error: 'bad_signature' }); }
    let r;
    try { r = pledges.applyMonoState(req.body); }
    catch (e) { audit('mono', 'mono_webhook_apply_error', { error: String(e.message).slice(0, 200) }); return res.status(500).end(); }
    if (r.note && r.note !== 'stale') audit('mono', 'mono_webhook_note', { note: r.note, invoice: req.body && req.body.invoiceId });
    if (r.changed) scheduleSync();
    res.json({ ok: true });
  });

  // ---- admin ----
  app.get('/api/admin/pledges/status', requireAuth, (_req, res) => res.json({ enabled: mono.enabled() }));

  app.get('/api/admin/pledges', requireAuth, (req, res) => {
    const id = String(req.query.project || '');
    if (!id) return res.status(400).json({ error: 'project required' });
    res.json(pledges.summary(id));
  });

  let refunding = false;
  // Without confirm:true this only reports what would be refunded.
  app.post('/api/admin/pledges/refund', requireAuth, async (req, res) => {
    const { projectId, confirm } = req.body || {};
    if (!projectId) return res.status(400).json({ error: 'projectId required' });
    if (!mono.enabled()) return res.status(503).json({ error: 'Mono не налаштовано' });
    if (refunding) return res.status(409).json({ error: 'refund_in_progress' });
    refunding = true;
    try {
      const r = await pledges.refundProject(String(projectId), { dryRun: confirm !== true });
      if (!r.dryRun) {
        audit(req.ip, 'mono_refund_project', { project: projectId, count: r.count, ok: r.ok, failed: r.failed, totalKop: r.totalKop });
        scheduleSync();
      }
      res.json(r);
    } catch (e) {
      res.status(500).json({ error: e.message });
    } finally {
      refunding = false;
    }
  });

  app.post('/api/admin/pledges/:id/refund', requireAuth, async (req, res) => {
    if (!mono.enabled()) return res.status(503).json({ error: 'Mono не налаштовано' });
    const r = await pledges.refundPledge(Number(req.params.id));
    audit(req.ip, 'mono_refund_pledge', { pledge: req.params.id, ok: r.ok, status: r.status, error: r.error });
    if (r.ok) scheduleSync();
    res.status(r.ok ? 200 : (r.error === 'not_found' ? 404 : 409)).json(r);
  });
}

module.exports = { mount };
