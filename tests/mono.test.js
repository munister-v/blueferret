const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const { createMono, verifySignature } = require('../src/mono');
const { createPledges } = require('../src/pledges');

// ---- helpers ----
function keypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pem = publicKey.export({ type: 'spki', format: 'pem' });
  return { privateKey, pubB64: Buffer.from(pem).toString('base64') };
}
const sign = (priv, body) => crypto.sign('sha256', body, { key: priv, dsaEncoding: 'der' }).toString('base64');

function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, opts = {}) => {
    const path = url.replace('https://api.monobank.ua', '');
    calls.push({ path, method: opts.method, body: opts.body && JSON.parse(opts.body), token: opts.headers['X-Token'] });
    const r = routes(path, opts, calls.length);
    return { ok: r.status === undefined || r.status < 400, status: r.status || 200, text: async () => JSON.stringify(r.body ?? {}) };
  };
  impl.calls = calls;
  return impl;
}

function setup(monoStub) {
  const db = new Database(':memory:');
  let t = 1_000_000;
  const p = createPledges({ db, mono: monoStub, now: () => (t += 1000), sleep: async () => {} });
  return { db, p };
}
const iso = ms => new Date(ms).toISOString();

// ---- signature ----
test('webhook signature: valid, tampered body, wrong key', () => {
  const k = keypair(), other = keypair();
  const body = Buffer.from('{"invoiceId":"x","status":"success"}');
  const sig = sign(k.privateKey, body);
  assert.equal(verifySignature(k.pubB64, sig, body), true);
  assert.equal(verifySignature(k.pubB64, sig, Buffer.from('{"invoiceId":"x","status":"failure"}')), false);
  assert.equal(verifySignature(other.pubB64, sig, body), false);
  assert.equal(verifySignature('not-a-key', sig, body), false);
});

test('verifyWebhook caches the key and refetches once after a failure (key rotation)', async () => {
  const oldK = keypair(), newK = keypair();
  let current = oldK;
  const f = fakeFetch(path => ({ body: { key: current.pubB64 } }));
  const mono = createMono({ token: 't', fetchImpl: f });
  const body = Buffer.from('{"a":1}');

  assert.equal(await mono.verifyWebhook(body, sign(oldK.privateKey, body)), true);
  assert.equal(await mono.verifyWebhook(body, sign(oldK.privateKey, body)), true);
  assert.equal(f.calls.filter(c => c.path === '/api/merchant/pubkey').length, 1, 'key must be cached');

  current = newK; // monobank rotated the key
  assert.equal(await mono.verifyWebhook(body, sign(newK.privateKey, body)), true);
  assert.equal(f.calls.filter(c => c.path === '/api/merchant/pubkey').length, 2, 'refetched once');

  assert.equal(await mono.verifyWebhook(body, sign(oldK.privateKey, body)), false, 'forged signature rejected');
  assert.equal(await mono.verifyWebhook(body, ''), false);
});

test('client sends token, kopecks, debit and never leaks the token in errors', async () => {
  const f = fakeFetch(() => ({ body: { invoiceId: 'inv1', pageUrl: 'https://pay/x' } }));
  const mono = createMono({ token: 'SECRET-TOKEN', fetchImpl: f });
  const r = await mono.createInvoice({ amount: 50000, reference: 'bf-1', destination: 'd', redirectUrl: 'r', webHookUrl: 'w' });
  assert.equal(r.pageUrl, 'https://pay/x');
  const c = f.calls[0];
  assert.equal(c.token, 'SECRET-TOKEN');
  assert.equal(c.body.amount, 50000);
  assert.equal(c.body.ccy, 980);
  assert.equal(c.body.paymentType, 'debit');

  const bad = createMono({ token: 'SECRET-TOKEN', fetchImpl: fakeFetch(() => ({ status: 403, body: { errText: 'forbidden' } })) });
  await assert.rejects(() => bad.invoiceStatus('i'), e => !String(e.message).includes('SECRET-TOKEN') && e.status === 403);
  assert.equal(createMono({ token: '' }).enabled(), false);
});

// ---- pledges ----
test('success webhook marks paid once; duplicate and stale deliveries change nothing', () => {
  const { p } = setup({});
  const a = p.createPledge({ projectId: 'nichka', amountKop: 50000 });
  p.attachInvoice(a.id, 'inv-a');

  const ok = { invoiceId: 'inv-a', status: 'success', amount: 50000, ccy: 980, modifiedDate: iso(5_000_000) };
  let r = p.applyMonoState(ok);
  assert.equal(r.pledge.status, 'paid');
  assert.equal(r.changed, true);

  r = p.applyMonoState(ok); // retry from monobank
  assert.equal(r.pledge.status, 'paid');
  assert.equal(r.changed, false);

  // "processing" arrives late, with an older timestamp: must not downgrade
  r = p.applyMonoState({ invoiceId: 'inv-a', status: 'processing', amount: 50000, modifiedDate: iso(4_000_000) });
  assert.equal(r.note, 'stale');
  assert.equal(p.get(a.id).status, 'paid');

  // even a newer non-final status never downgrades a paid pledge
  p.applyMonoState({ invoiceId: 'inv-a', status: 'processing', modifiedDate: iso(6_000_000) });
  assert.equal(p.get(a.id).status, 'paid');
});

test('success arriving before processing still ends paid', () => {
  const { p } = setup({});
  const a = p.createPledge({ projectId: 'n', amountKop: 10000 });
  p.attachInvoice(a.id, 'inv');
  p.applyMonoState({ invoiceId: 'inv', status: 'success', amount: 10000, modifiedDate: iso(9_000_000) });
  p.applyMonoState({ invoiceId: 'inv', status: 'processing', modifiedDate: iso(8_000_000) });
  assert.equal(p.get(a.id).status, 'paid');
});

test('a payment with a different amount is never counted', () => {
  const { p } = setup({});
  const a = p.createPledge({ projectId: 'n', amountKop: 50000 });
  p.attachInvoice(a.id, 'inv');
  const r = p.applyMonoState({ invoiceId: 'inv', status: 'success', amount: 100, ccy: 980, modifiedDate: iso(5_000_000) });
  assert.equal(r.note, 'amount_mismatch');
  assert.equal(r.pledge.status, 'mismatch');
  assert.deepEqual(p.pendingDeltas().rows, []);
});

test('unknown invoice is ignored, failure and expired are recorded', () => {
  const { p } = setup({});
  assert.equal(p.applyMonoState({ invoiceId: 'nope', status: 'success' }).note, 'unknown_invoice');
  const a = p.createPledge({ projectId: 'n', amountKop: 10000 }); p.attachInvoice(a.id, 'f');
  const b = p.createPledge({ projectId: 'n', amountKop: 10000 }); p.attachInvoice(b.id, 'e');
  p.applyMonoState({ invoiceId: 'f', status: 'failure', modifiedDate: iso(5_000_000) });
  p.applyMonoState({ invoiceId: 'e', status: 'expired', modifiedDate: iso(5_000_000) });
  assert.equal(p.get(a.id).status, 'failed');
  assert.equal(p.get(b.id).status, 'expired');
});

test('catalog deltas: counted once, refund takes it back, paid+refunded before sync nets to zero', () => {
  const { p } = setup({});
  const mk = (inv, kop) => { const x = p.createPledge({ projectId: 'n', amountKop: kop }); p.attachInvoice(x.id, inv); return x; };
  const a = mk('a', 30000), b = mk('b', 20000);
  p.applyMonoState({ invoiceId: 'a', status: 'success', amount: 30000, modifiedDate: iso(5_000_000) });
  p.applyMonoState({ invoiceId: 'b', status: 'success', amount: 20000, modifiedDate: iso(5_000_000) });

  let d = p.pendingDeltas();
  assert.equal(d.byProject.n, 500);
  p.markCounted(d.rows);
  assert.equal(p.pendingDeltas().rows.length, 0, 'second sync has nothing to add');

  p.applyMonoState({ invoiceId: 'b', status: 'reversed', finalAmount: 0, modifiedDate: iso(7_000_000) });
  d = p.pendingDeltas();
  assert.equal(d.byProject.n, -200);
  p.markCounted(d.rows);
  assert.equal(p.pendingDeltas().rows.length, 0);

  // paid and refunded before the catalog was ever updated
  const c = mk('c', 70000);
  p.applyMonoState({ invoiceId: 'c', status: 'success', amount: 70000, modifiedDate: iso(8_000_000) });
  p.applyMonoState({ invoiceId: 'c', status: 'reversed', finalAmount: 0, modifiedDate: iso(9_000_000) });
  assert.equal(p.pendingDeltas().rows.length, 0);
  assert.equal(p.get(c.id).status, 'refunded');
  assert.equal(p.get(a.id).status, 'paid');
});

test('partial reversal is flagged, not silently treated as a full refund', () => {
  const { p } = setup({});
  const a = p.createPledge({ projectId: 'n', amountKop: 10000 }); p.attachInvoice(a.id, 'a');
  p.applyMonoState({ invoiceId: 'a', status: 'success', amount: 10000, modifiedDate: iso(5_000_000) });
  const r = p.applyMonoState({ invoiceId: 'a', status: 'reversed', finalAmount: 4000, modifiedDate: iso(6_000_000) });
  assert.equal(r.note, 'partial_reversal');
  assert.equal(r.pledge.status, 'paid');
});

// ---- refunds ----
test('refundProject: dry run touches nothing; real run refunds paid pledges only, with stable extRef', async () => {
  const calls = [];
  const monoStub = {
    cancelInvoice: async args => { calls.push(args); return { status: 'success' }; },
  };
  const { p } = setup(monoStub);
  const mk = (inv, kop, project = 'n') => { const x = p.createPledge({ projectId: project, amountKop: kop }); p.attachInvoice(x.id, inv); return x; };
  const a = mk('a', 30000), b = mk('b', 20000), pending = mk('p', 10000), other = mk('o', 99900, 'other');
  for (const [inv, kop] of [['a', 30000], ['b', 20000], ['o', 99900]])
    p.applyMonoState({ invoiceId: inv, status: 'success', amount: kop, modifiedDate: iso(5_000_000) });

  const dry = await p.refundProject('n', { dryRun: true });
  assert.deepEqual([dry.count, dry.totalKop], [2, 50000]);
  assert.equal(calls.length, 0);

  const r = await p.refundProject('n');
  assert.equal(r.ok, 2); assert.equal(r.failed, 0);
  assert.deepEqual(calls.map(c => c.extRef).sort(), [`refund-${a.id}`, `refund-${b.id}`]);
  assert.equal(p.get(a.id).status, 'refunded');
  assert.equal(p.get(pending.id).status, 'created', 'unpaid pledge untouched');
  assert.equal(p.get(other.id).status, 'paid', 'other project untouched');

  const again = await p.refundProject('n');
  assert.equal(again.count, 0, 'idempotent: nothing left to refund');
  assert.equal(calls.length, 2);
});

test('refund: processing is kept and finished by the later reversed webhook; failure is recorded and retryable', async () => {
  let mode = 'processing';
  const monoStub = { cancelInvoice: async () => (mode === 'throw' ? Promise.reject(Object.assign(new Error('monobank: boom'), { status: 500 })) : { status: mode }) };
  const { p } = setup(monoStub);
  const a = p.createPledge({ projectId: 'n', amountKop: 10000 }); p.attachInvoice(a.id, 'a');
  p.applyMonoState({ invoiceId: 'a', status: 'success', amount: 10000, modifiedDate: iso(5_000_000) });

  let r = await p.refundPledge(a.id);
  assert.equal(r.status, 'processing');
  assert.equal(p.get(a.id).status, 'paid');
  assert.equal(p.get(a.id).refund_status, 'processing');

  p.applyMonoState({ invoiceId: 'a', status: 'reversed', finalAmount: 0, modifiedDate: iso(6_000_000) });
  assert.equal(p.get(a.id).status, 'refunded');

  const b = p.createPledge({ projectId: 'n', amountKop: 10000 }); p.attachInvoice(b.id, 'b');
  p.applyMonoState({ invoiceId: 'b', status: 'success', amount: 10000, modifiedDate: iso(5_000_000) });
  mode = 'throw';
  r = await p.refundPledge(b.id);
  assert.equal(r.ok, false);
  assert.equal(p.get(b.id).refund_status, 'failure');
  assert.equal(p.get(b.id).status, 'paid', 'still paid, so it will be retried');
  mode = 'success';
  r = await p.refundPledge(b.id);
  assert.equal(r.ok, true);
  assert.equal(p.get(b.id).status, 'refunded');
});

test('refund retries on 429', async () => {
  let n = 0;
  const monoStub = { cancelInvoice: async () => { if (n++ < 2) throw Object.assign(new Error('rate'), { status: 429 }); return { status: 'success' }; } };
  const { p } = setup(monoStub);
  const a = p.createPledge({ projectId: 'n', amountKop: 10000 }); p.attachInvoice(a.id, 'a');
  p.applyMonoState({ invoiceId: 'a', status: 'success', amount: 10000, modifiedDate: iso(5_000_000) });
  const r = await p.refundPledge(a.id);
  assert.equal(r.ok, true);
  assert.equal(n, 3);
});

// ---- reconcile ----
test('reconcile finds paid / expired pledges whose webhook never came', async () => {
  const statuses = {
    a: { status: 'success', amount: 10000, ccy: 980, modifiedDate: iso(50_000_000) },
    b: { status: 'expired', modifiedDate: iso(50_000_000) },
  };
  const monoStub = { invoiceStatus: async id => statuses[id] };
  const { p } = setup(monoStub);
  const a = p.createPledge({ projectId: 'n', amountKop: 10000 }); p.attachInvoice(a.id, 'a');
  const b = p.createPledge({ projectId: 'n', amountKop: 10000 }); p.attachInvoice(b.id, 'b');
  const r = await p.reconcile({ minAgeMs: 0, maxAgeMs: 10 ** 12 });
  assert.equal(r.checked, 2);
  assert.equal(p.get(a.id).status, 'paid');
  assert.equal(p.get(b.id).status, 'expired');
});
