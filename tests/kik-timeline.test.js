const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { syncTimeline } = require('../src/kik-timeline');

const SITE = path.join(__dirname, '..', 'site', 'kik', 'proekty');
const page = n => fs.readFileSync(path.join(SITE, String(n), fs.existsSync(path.join(SITE, String(n), 'index.bf-hidden.html')) ? 'index.bf-hidden.html' : 'index.html'), 'utf8');
const rows = h => [...h.matchAll(/<div class="flex items-center justify-between rounded-xl border px-4 py-3 ([^"]*)"><span[^>]*>([^<]*)<\/span><svg[^>]*lucide-([\w-]+)/g)]
  .map(m => [m[2], m[3]]);

test('a page already in its status comes back byte for byte (DOM and flight match the real markup)', () => {
  assert.equal(syncTimeline(page(2), 'active'), page(2));
  assert.equal(syncTimeline(page(6), 'preparing'), page(6));
});

test('preparing -> active: Підготовка done, Збір коштів current, DOM and flight agree', () => {
  const h = syncTimeline(page(6), 'active');
  assert.deepEqual(rows(h), [['Підготовка', 'shield-check'], ['Збір коштів', 'timer-reset'], ['Виробництво', 'calendar-days']]);
  // the new page is exactly what an "active" page looks like (same block as project 2)
  const block = s => s.slice(s.indexOf('<div class="space-y-3 mb-7">'), s.indexOf('</div></div>', s.indexOf('<div class="space-y-3 mb-7">') + 2000));
  assert.equal(block(h).replace(/data-bf-id="[^"]*"/g, ''), block(page(2)).replace(/data-bf-id="[^"]*"/g, ''));
  const fl = s => s.slice(s.indexOf('[\\"$\\",\\"div\\",null,{\\"className\\":\\"space-y-3 mb-7'), s.indexOf('\\n"])</script>', s.indexOf('space-y-3 mb-7') + 10));
  assert.ok(h.includes(fl(page(2))));
});

test('complete moves to Виробництво; going back works; idempotent', () => {
  const done = syncTimeline(page(2), 'complete');
  assert.deepEqual(rows(done).map(r => r[1]), ['shield-check', 'shield-check', 'timer-reset']);
  assert.equal(syncTimeline(done, 'complete'), done);
  assert.equal(syncTimeline(done, 'active'), page(2));
  assert.deepEqual(rows(syncTimeline(done, 'preparing')).map(r => r[1]), ['timer-reset', 'calendar-days', 'calendar-days']);
});

test('unknown status or foreign markup is left alone', () => {
  assert.equal(syncTimeline(page(6), 'draft'), page(6));
  assert.equal(syncTimeline('<main>нічого</main>', 'active'), '<main>нічого</main>');
});
