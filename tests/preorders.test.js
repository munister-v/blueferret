const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { createPreorders, normalizePhone } = require('../src/preorders');

const project = { id: '6', name: 'Нічка', support: { tiers: [{ id: 'basic', title: 'Базовий', amount: 900 }, { id: 'full', title: 'Повний', amount: 1500 }] } };
const good = { tierId: 'basic', name: 'Олена Іваненко', phone: '067 123 45 67', city: 'Київ', address: 'Нова пошта, відділення 5', qty: 2 };
const mk = () => createPreorders({ db: new Database(':memory:') });

test('phone numbers are normalised, junk is refused', () => {
  assert.equal(normalizePhone('067 123-45-67'), '+380671234567');
  assert.equal(normalizePhone('+38 (050) 111 22 33'), '+380501112233');
  assert.equal(normalizePhone('380931234567'), '+380931234567');
  assert.equal(normalizePhone('12345'), null);
  assert.equal(normalizePhone('+1 202 555 0143'), null);
});

test('a valid request is stored with the tier price taken from the server, not the client', () => {
  const p = mk();
  const r = p.create(project, { ...good, amount: 1 });
  assert.equal(r.ok, true);
  assert.equal(r.total, 1800);
  const row = p.list('6')[0];
  assert.equal(row.amount, 900); assert.equal(row.qty, 2); assert.equal(row.phone, '+380671234567'); assert.equal(row.status, 'new');
});

test('validation: tier, qty, name, phone, address, email', () => {
  const p = mk();
  assert.equal(p.create(project, { ...good, tierId: 'nope' }).field, 'tier');
  assert.equal(p.create(project, { ...good, qty: 0 }).field, 'qty');
  assert.equal(p.create(project, { ...good, qty: 11 }).field, 'qty');
  assert.equal(p.create(project, { ...good, name: '1' }).field, 'name');
  assert.equal(p.create(project, { ...good, phone: '123' }).field, 'phone');
  assert.equal(p.create(project, { ...good, address: 'ab' }).field, 'address');
  assert.equal(p.create(project, { ...good, email: 'x@y' }).field, 'email');
  assert.equal(p.list('6').length, 0);
});

test('the same phone and set within a day is a duplicate; a cancelled one may be redone', () => {
  const p = mk();
  const first = p.create(project, good);
  assert.equal(p.create(project, good).duplicate, true);
  assert.equal(p.create(project, { ...good, tierId: 'full' }).ok, true);
  p.setStatus(first.id, 'cancelled');
  assert.equal(p.create(project, good).ok, true);
});

test('summary skips cancelled; csv neutralises formulas and quotes commas', () => {
  const p = mk();
  p.create(project, good);
  const evil = p.create(project, { ...good, phone: '050 111 22 33', name: '=HYPERLINK("x")', address: 'вул. Лесі, 5, кв. 2' });
  const s = p.summary('6');
  assert.equal(s.count, 4); assert.equal(s.totalUah, 3600);
  p.setStatus(evil.id, 'cancelled');
  assert.equal(p.summary('6').count, 2);
  const csv = p.csv('6');
  assert.ok(csv.includes("'=HYPERLINK"));
  assert.ok(csv.includes(',+380671234567,'), 'a normalised phone is not prefixed');
  assert.ok(csv.includes('"вул. Лесі, 5, кв. 2"'));
  assert.equal(p.setStatus(999, 'paid').error, 'not_found');
  assert.equal(p.setStatus(1, 'weird').error, 'bad_status');
});
