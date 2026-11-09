const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { syncProgress } = require('../src/kik-progress');

const SITE = path.join(__dirname, 'fixtures', 'kik', 'proekty');
const page = n => {
  const d = path.join(SITE, String(n));
  return fs.readFileSync(path.join(d, fs.existsSync(path.join(d, 'index.bf-hidden.html')) ? 'index.bf-hidden.html' : 'index.html'), 'utf8');
};
// what the page currently holds, read back from its own markup
function held(h) {
  const m = h.match(/font-extrabold text-lg"[^>]*>([^<]*)<!-- --> \/ <!-- -->([^<]*)</);
  const num = s => Number(s.replace(/&nbsp;|\u00a0|\s|₴/g, ''));
  const d = h.match(/Оновлення<!-- --> · <!-- -->(\d\d)\.(\d\d)\.(\d{4})/);
  return { raised: num(m[1]), goal: num(m[2]), lastUpdate: `${d[3]}-${d[2]}-${d[1]}` };
}

for (const n of [2, 3, 5, 6]) {
  test(`project ${n}: a page already holding the catalog's values comes back byte for byte`, () => {
    const h = page(n);
    assert.equal(syncProgress(h, held(h)), h);
  });
}

test('new raised/goal/date land everywhere (DOM and flight) and the round trip restores the page', () => {
  const h = page(6), was = held(h);
  const h2 = syncProgress(h, { raised: 1699, goal: was.goal, lastUpdate: '2026-12-31' });
  assert.notEqual(h2, h);
  assert.ok(h2.includes('1&nbsp;699 ₴<!-- --> / <!-- -->'));           // DOM
  assert.ok(h2.includes('[\\"1\u00a0699 ₴\\",\\" / \\"'));             // flight
  assert.ok(h2.includes('31.12.2026</p>') && h2.includes('\\"31.12.2026\\"'));
  assert.deepEqual(held(h2), { raised: 1699, goal: was.goal, lastUpdate: '2026-12-31' });
  assert.equal(syncProgress(h2, was), h);
});

test('percentages: rounded on the cover and text, exact on the bar, capped at 100', () => {
  const h = page(6), g = held(h).goal;
  const half = syncProgress(h, { raised: g / 2, goal: g, lastUpdate: '2026-11-05' });
  assert.ok(half.includes('>50<!-- -->%') && half.includes('width:50%') && half.includes('\\"width\\":\\"50%\\"'));
  assert.ok(half.includes(',50,\\"%\\"'));
  const odd = syncProgress(h, { raised: 1699, goal: 724000, lastUpdate: '2026-11-05' });
  assert.ok(odd.includes('width:0.2346685082872928%'));
  assert.ok(odd.includes('>0<!-- -->%'));
});

test('a page that has drifted (DOM and flight disagree, wrong goal) is pulled to the catalog', () => {
  const h = page(6), was = held(h);
  const drifted = h.replace('\\"0 ₴\\",\\" / \\"', '\\"999 ₴\\",\\" / \\"').replace(/Поточний прогрес<!-- -->: <!-- -->0/, 'Поточний прогрес<!-- -->: <!-- -->77');
  assert.notEqual(drifted, h);
  assert.equal(syncProgress(drifted, was), h);
});

test('bad input or foreign markup is left alone', () => {
  const h = page(6);
  assert.equal(syncProgress(h, { raised: -1, goal: 10, lastUpdate: '2026-11-05' }), h);
  assert.equal(syncProgress(h, { raised: 1, goal: 0, lastUpdate: '2026-11-05' }), h);
  assert.equal(syncProgress(h, { raised: 1, goal: 10, lastUpdate: 'вчора' }), h);
  assert.equal(syncProgress('<main>x</main>', { raised: 1, goal: 10, lastUpdate: '2026-11-05' }), '<main>x</main>');
  assert.equal(syncProgress(h.replace('Поточний прогрес', 'Інше'), { raised: 5, goal: 10, lastUpdate: '2026-11-05' }), h.replace('Поточний прогрес', 'Інше'));
});
