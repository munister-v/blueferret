// KIK pledges: one row per monobank invoice. All money is in kopecks here.
//
// Model: pay immediately (paymentType=debit); if a campaign does not reach its
// goal, every paid pledge is refunded with invoice/cancel, minus the acquiring
// commission (monobank keeps its fee on a refund and the offer says we do not
// pass it back: `paymentInfo.fee` of the invoice is remembered per pledge and
// the cancel is sent for the rest only). A pledge counts
// toward the catalog's `raised` exactly once — `counted` says whether it is
// already included, so syncing the catalog is idempotent and a pledge that is
// paid and refunded before the next sync nets out to nothing.
const crypto = require('crypto');

const PAID_FINAL = new Set(['paid', 'refunded']);

// feePct: fallback commission (percent of the amount) for a pledge whose fee
// monobank never reported; without it such a pledge is NOT refunded (fee_unknown).
function createPledges({ db, mono, now = () => Date.now(), sleep = ms => new Promise(r => setTimeout(r, ms)), feePct = Number(process.env.MONO_FEE_PCT) || 0 }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS kik_pledges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      tier_label TEXT DEFAULT '',
      amount INTEGER NOT NULL,
      reference TEXT UNIQUE NOT NULL,
      invoice_id TEXT UNIQUE,
      status TEXT NOT NULL DEFAULT 'created',
      mono_status TEXT DEFAULT '',
      mono_modified INTEGER DEFAULT 0,
      counted INTEGER DEFAULT 0,
      masked_pan TEXT DEFAULT '',
      rrn TEXT DEFAULT '',
      refund_status TEXT DEFAULT '',
      refund_error TEXT DEFAULT '',
      refund_ext_ref TEXT DEFAULT '',
      created_at INTEGER,
      paid_at INTEGER,
      refunded_at INTEGER,
      updated_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS kik_pledges_project ON kik_pledges(project_id, status);
  `);
  const have = db.prepare('PRAGMA table_info(kik_pledges)').all().map(c => c.name);
  for (const col of ['fee', 'refund_amount']) // kopecks; NULL = not known / not refunded yet
    if (!have.includes(col)) db.exec(`ALTER TABLE kik_pledges ADD COLUMN ${col} INTEGER`);

  const q = {
    insert: db.prepare(`INSERT INTO kik_pledges(project_id,tier_label,amount,reference,status,created_at,updated_at)
      VALUES(@project_id,@tier_label,@amount,@reference,'created',@t,@t)`),
    setInvoice: db.prepare('UPDATE kik_pledges SET invoice_id=?, updated_at=? WHERE id=?'),
    drop: db.prepare('DELETE FROM kik_pledges WHERE id=?'),
    byId: db.prepare('SELECT * FROM kik_pledges WHERE id=?'),
    byInvoice: db.prepare('SELECT * FROM kik_pledges WHERE invoice_id=?'),
    update: db.prepare(`UPDATE kik_pledges SET status=@status, mono_status=@mono_status, mono_modified=@mono_modified,
      masked_pan=@masked_pan, rrn=@rrn, fee=@fee, paid_at=@paid_at, refunded_at=@refunded_at, refund_status=@refund_status,
      updated_at=@updated_at WHERE id=@id`),
    setRefund: db.prepare('UPDATE kik_pledges SET refund_status=?, refund_error=?, refund_ext_ref=?, updated_at=? WHERE id=?'),
    setRefundAmount: db.prepare('UPDATE kik_pledges SET refund_amount=? WHERE id=?'),
    setFee: db.prepare('UPDATE kik_pledges SET fee=? WHERE id=?'),
    forProject: db.prepare('SELECT * FROM kik_pledges WHERE project_id=? ORDER BY id'),
    refundable: db.prepare(`SELECT * FROM kik_pledges WHERE project_id=? AND status='paid' ORDER BY id`),
    toCount: db.prepare(`SELECT * FROM kik_pledges WHERE (status='paid' AND counted=0) OR (status='refunded' AND counted=1)`),
    setCounted: db.prepare('UPDATE kik_pledges SET counted=? WHERE id=?'),
    stale: db.prepare(`SELECT * FROM kik_pledges WHERE invoice_id IS NOT NULL AND updated_at<? AND created_at>?
      AND (status IN ('created','processing','hold') OR (status='paid' AND refund_status='processing'))`),
  };

  function createPledge({ projectId, tierLabel = '', amountKop }) {
    const reference = 'bf-' + crypto.randomBytes(8).toString('hex');
    const info = q.insert.run({ project_id: projectId, tier_label: tierLabel, amount: amountKop, reference, t: now() });
    return q.byId.get(info.lastInsertRowid);
  }
  const attachInvoice = (id, invoiceId) => q.setInvoice.run(invoiceId, now(), id);
  const discard = id => q.drop.run(id);
  const get = id => q.byId.get(id);

  // Apply a monobank invoice state (webhook body or status response).
  // Idempotent, ignores stale deliveries (webhooks are not ordered), never
  // downgrades a settled pledge. Returns { pledge, changed, note }.
  function applyMonoState(p) {
    const row = p && p.invoiceId && q.byInvoice.get(p.invoiceId);
    if (!row) return { pledge: null, changed: false, note: 'unknown_invoice' };
    const ts = Date.parse(p.modifiedDate) || 0;
    if (ts && ts < row.mono_modified) return { pledge: row, changed: false, note: 'stale' };

    const next = {
      id: row.id, status: row.status, mono_status: String(p.status || ''), mono_modified: Math.max(ts, row.mono_modified),
      masked_pan: (p.paymentInfo && p.paymentInfo.maskedPan) || row.masked_pan,
      rrn: (p.paymentInfo && p.paymentInfo.rrn) || row.rrn,
      fee: p.paymentInfo && Number.isInteger(Number(p.paymentInfo.fee)) && p.paymentInfo.fee !== null && p.paymentInfo.fee !== '' ? Number(p.paymentInfo.fee) : row.fee,
      paid_at: row.paid_at, refunded_at: row.refunded_at, refund_status: row.refund_status, updated_at: now(),
    };
    let note = '';
    switch (p.status) {
      case 'success':
        if (Number(p.amount) !== row.amount || (p.ccy !== undefined && Number(p.ccy) !== 980)) {
          // Never count a payment whose amount we did not ask for.
          next.status = PAID_FINAL.has(row.status) ? row.status : 'mismatch';
          note = 'amount_mismatch';
        } else if (row.status !== 'refunded') {
          next.status = 'paid';
          next.paid_at = row.paid_at || now();
        }
        break;
      case 'processing':
      case 'hold':
        if (!PAID_FINAL.has(row.status)) next.status = 'processing';
        break;
      case 'failure':
        if (!PAID_FINAL.has(row.status)) next.status = 'failed';
        break;
      case 'expired':
        if (!PAID_FINAL.has(row.status)) next.status = 'expired';
        break;
      case 'reversed': {
        const left = p.finalAmount === undefined ? 0 : Number(p.finalAmount);
        // what we deliberately keep (the commission) stays on the invoice after our own refund
        const kept = row.refund_amount ? row.amount - row.refund_amount : 0;
        if (left <= kept) {
          next.status = 'refunded';
          next.refunded_at = row.refunded_at || now();
          next.refund_status = 'success';
        } else {
          note = 'partial_reversal'; // refunded by hand in the cabinet: needs a human
        }
        break;
      }
      default:
        note = 'unknown_status';
    }
    q.update.run(next);
    return { pledge: q.byId.get(row.id), changed: next.status !== row.status || next.refund_status !== row.refund_status, note };
  }

  // Poll monobank for pledges whose webhook never arrived (and for refunds still
  // processing). `expired` never comes by webhook, so this is how it is noticed.
  async function reconcile({ minAgeMs = 2 * 60 * 1000, maxAgeMs = 3 * 24 * 3600 * 1000 } = {}) {
    const t = now();
    const rows = q.stale.all(t - minAgeMs, t - maxAgeMs);
    let touched = 0;
    for (const row of rows) {
      try {
        const s = await mono.invoiceStatus(row.invoice_id);
        const r = applyMonoState({ ...s, invoiceId: row.invoice_id });
        if (r.changed) touched++;
        else db.prepare('UPDATE kik_pledges SET updated_at=? WHERE id=?').run(now(), row.id);
      } catch (e) {
        db.prepare('UPDATE kik_pledges SET updated_at=? WHERE id=?').run(now(), row.id);
      }
      await sleep(150);
    }
    return { checked: rows.length, touched };
  }

  // Deltas (in whole hryvnias) the catalog still has to receive, plus the
  // pledge rows they come from so markCounted can acknowledge them.
  function pendingDeltas() {
    const byProject = {}, rows = [];
    for (const r of q.toCount.all()) {
      const sign = r.status === 'paid' ? 1 : -1;
      byProject[r.project_id] = (byProject[r.project_id] || 0) + sign * (r.amount / 100);
      rows.push(r);
    }
    return { byProject, rows };
  }
  function markCounted(rows) {
    db.transaction(() => { for (const r of rows) q.setCounted.run(r.status === 'paid' ? 1 : 0, r.id); })();
  }

  function summary(projectId) {
    const all = q.forProject.all(projectId);
    const sum = st => all.filter(r => r.status === st).reduce((n, r) => n + r.amount, 0);
    return {
      pledges: all,
      paidKop: sum('paid'), paidCount: all.filter(r => r.status === 'paid').length,
      refundedKop: sum('refunded'), refundedCount: all.filter(r => r.status === 'refunded').length,
      pendingRefund: all.filter(r => r.refund_status === 'processing').length,
    };
  }

  // The commission monobank kept for this pledge, in kopecks: as reported, else
  // asked from monobank, else the configured percentage, else unknown (null).
  async function feeOf(row) {
    if (Number.isInteger(row.fee)) return row.fee;
    try {
      const s = await mono.invoiceStatus(row.invoice_id);
      const f = s && s.paymentInfo && s.paymentInfo.fee;
      if (f !== undefined && f !== null && f !== '' && Number.isInteger(Number(f))) { q.setFee.run(Number(f), row.id); return Number(f); }
    } catch (e) { /* fall through to the percentage */ }
    if (feePct > 0) return Math.round(row.amount * feePct / 100);
    return null;
  }

  // Refund one pledge: the amount paid minus the acquiring commission. Safe to
  // retry: a pledge already refunded is skipped, and extRef is stable per pledge
  // so monobank can recognise a repeat.
  async function refundPledge(id) {
    const row = q.byId.get(id);
    if (!row) return { id, ok: false, error: 'not_found' };
    if (row.status === 'refunded') return { id, ok: true, skipped: true };
    if (row.status !== 'paid') return { id, ok: false, error: 'not_paid' };
    const extRef = 'refund-' + row.id;
    const fee = await feeOf(row);
    if (fee === null) { q.setRefund.run('failure', 'fee_unknown', extRef, now(), row.id); return { id, ok: false, error: 'fee_unknown' }; }
    const refundKop = row.amount - fee;
    if (refundKop <= 0) { q.setRefund.run('failure', 'fee_exceeds_amount', extRef, now(), row.id); return { id, ok: false, error: 'fee_exceeds_amount' }; }
    q.setRefundAmount.run(refundKop, row.id);
    q.setRefund.run('requested', '', extRef, now(), row.id);
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const r = await mono.cancelInvoice({ invoiceId: row.invoice_id, extRef, amount: refundKop });
        if (r.status === 'success') {
          q.setRefund.run('success', '', extRef, now(), row.id);
          // Order the state change after everything already seen for this invoice,
          // whatever the clocks say.
          const ts = Math.max(Date.parse(r.modifiedDate) || now(), row.mono_modified + 1);
          applyMonoState({ invoiceId: row.invoice_id, status: 'reversed', finalAmount: fee, modifiedDate: new Date(ts).toISOString() });
          return { id, ok: true, status: 'success', refundKop, feeKop: fee };
        }
        if (r.status === 'processing') {
          q.setRefund.run('processing', '', extRef, now(), row.id);
          return { id, ok: true, status: 'processing', refundKop, feeKop: fee };
        }
        q.setRefund.run('failure', 'status:' + r.status, extRef, now(), row.id);
        return { id, ok: false, status: r.status };
      } catch (e) {
        if (e.status === 429 && attempt < 3) { await sleep(2000 * (attempt + 1)); continue; }
        q.setRefund.run('failure', String(e.message).slice(0, 200), extRef, now(), row.id);
        return { id, ok: false, error: e.message };
      }
    }
    return { id, ok: false, error: 'rate_limited' };
  }

  // Refund every paid pledge of a campaign. dryRun just reports what would happen
  // (fees not yet known are asked from monobank, so a dry run needs the token).
  async function refundProject(projectId, { dryRun = false, gapMs = 300 } = {}) {
    const rows = q.refundable.all(projectId);
    const totalKop = rows.reduce((n, r) => n + r.amount, 0);
    if (dryRun) {
      let feeKop = 0, unknownFee = 0;
      for (const r of rows) { const f = await feeOf(r); if (f === null) unknownFee++; else feeKop += f; }
      return { dryRun: true, count: rows.length, totalKop, feeKop, refundKop: totalKop - feeKop, unknownFee };
    }
    const results = [];
    for (const r of rows) { results.push(await refundPledge(r.id)); await sleep(gapMs); }
    return {
      dryRun: false, count: rows.length, totalKop, results,
      refundedKop: results.reduce((n, x) => n + (x.ok && x.refundKop ? x.refundKop : 0), 0),
      ok: results.filter(x => x.ok).length, failed: results.filter(x => !x.ok).length,
    };
  }

  return { createPledge, attachInvoice, discard, get, applyMonoState, reconcile, pendingDeltas, markCounted, summary, refundPledge, refundProject };
}

module.exports = { createPledges };
