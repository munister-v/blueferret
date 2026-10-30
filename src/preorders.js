// KIK preorders: a request to buy a reward set without any payment. We keep the
// contact and delivery data and send the monobank invoice later by hand.
// Money is whole hryvnias here (unlike kik_pledges, which counts kopecks).
const STATUSES = ['new', 'invoiced', 'paid', 'cancelled'];

function clean(v, max) { return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max); }

// 380XXXXXXXXX from 0XXXXXXXXX, 380XXXXXXXXX, +380XXXXXXXXX, with any spaces/brackets/dashes
function normalizePhone(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  let n = null;
  if (d.length === 12 && d.startsWith('380')) n = d;
  else if (d.length === 10 && d.startsWith('0')) n = '38' + d;
  else if (d.length === 9) n = '380' + d;
  return n && /^380(39|50|63|66|67|68|73|91|92|93|94|95|96|97|98|99)\d{7}$|^380[3-6]\d{8}$/.test(n) ? '+' + n : null;
}

function createPreorders({ db, now = () => Date.now() }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS kik_preorders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      tier_id TEXT DEFAULT '',
      tier_label TEXT DEFAULT '',
      amount INTEGER NOT NULL,
      qty INTEGER NOT NULL DEFAULT 1,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      email TEXT DEFAULT '',
      city TEXT DEFAULT '',
      address TEXT NOT NULL,
      comment TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'new',
      note TEXT DEFAULT '',
      created_at INTEGER,
      updated_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS kik_preorders_project ON kik_preorders(project_id, status);
    CREATE INDEX IF NOT EXISTS kik_preorders_phone ON kik_preorders(project_id, phone, tier_id);
  `);
  const q = {
    insert: db.prepare(`INSERT INTO kik_preorders(project_id,tier_id,tier_label,amount,qty,name,phone,email,city,address,comment,status,created_at,updated_at)
      VALUES(@project_id,@tier_id,@tier_label,@amount,@qty,@name,@phone,@email,@city,@address,@comment,'new',@t,@t)`),
    dup: db.prepare(`SELECT id FROM kik_preorders WHERE project_id=? AND phone=? AND tier_id=? AND status!='cancelled' AND created_at>?`),
    byId: db.prepare('SELECT * FROM kik_preorders WHERE id=?'),
    forProject: db.prepare('SELECT * FROM kik_preorders WHERE project_id=? ORDER BY id'),
    setStatus: db.prepare('UPDATE kik_preorders SET status=?, updated_at=? WHERE id=?'),
    setNote: db.prepare('UPDATE kik_preorders SET note=?, updated_at=? WHERE id=?'),
  };

  // Returns { ok:true, id } or { ok:false, error, field? }
  function create(project, body) {
    const tiers = (project.support && project.support.tiers) || [];
    const tier = tiers.find(t => t.id === String(body.tierId || '')) ||
      (body.amount != null ? tiers.find(t => Number(t.amount) === Number(body.amount)) : null);
    if (!tier) return { ok: false, error: 'Оберіть набір.', field: 'tier' };
    const qty = Number(body.qty == null ? 1 : body.qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > 10) return { ok: false, error: 'Кількість: від 1 до 10.', field: 'qty' };
    const name = clean(body.name, 80);
    if (name.length < 2 || !/\p{L}/u.test(name)) return { ok: false, error: 'Вкажіть ім’я.', field: 'name' };
    const phone = normalizePhone(body.phone);
    if (!phone) return { ok: false, error: 'Перевірте номер телефону: 0XX XXX XX XX.', field: 'phone' };
    const email = clean(body.email, 120);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return { ok: false, error: 'Перевірте пошту.', field: 'email' };
    const city = clean(body.city, 80);
    const address = clean(body.address, 240);
    if (address.length < 5) return { ok: false, error: 'Вкажіть адресу доставки: місто та відділення або вулицю.', field: 'address' };
    const t = now();
    // the same person pressing twice in a day is one request
    if (q.dup.get(project.id, phone, tier.id, t - 24 * 3600 * 1000))
      return { ok: false, error: 'Заявка на цей набір з таким номером уже є. Ми напишемо вам.', field: 'phone', duplicate: true };
    const r = q.insert.run({
      project_id: project.id, tier_id: tier.id, tier_label: clean(tier.title, 80), amount: Number(tier.amount), qty,
      name, phone, email, city, address, comment: clean(body.comment, 300), t,
    });
    return { ok: true, id: Number(r.lastInsertRowid), tier: tier.title, total: Number(tier.amount) * qty, phone };
  }

  function list(projectId) { return q.forProject.all(String(projectId)); }

  function summary(projectId) {
    const rows = list(projectId), by = {};
    let total = 0, count = 0;
    for (const r of rows) {
      if (r.status === 'cancelled') continue;
      count += r.qty; total += r.amount * r.qty;
      const k = r.tier_label || r.tier_id;
      by[k] = (by[k] || 0) + r.qty;
    }
    return { count, totalUah: total, byTier: by, rows };
  }

  function setStatus(id, status) {
    if (!STATUSES.includes(status)) return { ok: false, error: 'bad_status' };
    if (!q.byId.get(id)) return { ok: false, error: 'not_found' };
    q.setStatus.run(status, now(), id);
    return { ok: true };
  }
  function setNote(id, note) {
    if (!q.byId.get(id)) return { ok: false, error: 'not_found' };
    q.setNote.run(clean(note, 300), now(), id);
    return { ok: true };
  }

  // Spreadsheet-ready; cells starting with = + - @ are neutralised (CSV injection).
  function csv(projectId) {
    const cell = (v, trusted) => {
      let s = String(v == null ? '' : v);
      if (!trusted && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
      return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const head = ['id', 'дата', 'набір', 'к-сть', 'сума ₴', 'ім’я', 'телефон', 'пошта', 'місто', 'адреса', 'коментар', 'статус', 'нотатка'];
    const lines = [head.join(',')];
    for (const r of list(projectId))
      lines.push([r.id, new Date(r.created_at).toISOString(), r.tier_label, r.qty, r.amount * r.qty, r.name, r.phone, r.email, r.city, r.address, r.comment, r.status, r.note].map((v, i) => cell(v, i === 6)).join(','));  // 6 = phone, already normalised to +380…
    return '﻿' + lines.join('\r\n') + '\r\n';
  }

  return { create, list, summary, setStatus, setNote, csv, STATUSES };
}

module.exports = { createPreorders, normalizePhone };
