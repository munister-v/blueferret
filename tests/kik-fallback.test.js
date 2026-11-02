const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { render, apply } = require('../src/kik-fallback');

const P = [
  { id: '6', name: 'Ничка <b>', shortDescription: 'Гра "про тхора"', status: 'active', statusLabel: 'Анонс', raised: 1699, goal: 674000, link: '/kik/proekty/6', coverImage: '/uploads/a.webp' },
  { id: '7', name: 'Чернетка', status: 'draft', statusLabel: 'x', raised: 0, goal: 1, link: '/kik/proekty/7' },
  { id: '8', name: 'Злий', status: 'active', statusLabel: 'y', raised: 0, goal: 0, link: 'javascript:alert(1)' },
];

test('cards for every project but drafts, escaped, safe links', () => {
  const h = render(P);
  assert.ok(h.includes('Ничка &lt;b&gt;'));
  assert.ok(h.includes('Гра &quot;про тхора&quot;'));
  assert.ok(h.includes('href="/kik/proekty/6"'));
  assert.ok(!h.includes('Чернетка'));
  assert.ok(!h.includes('javascript:'));
  assert.match(h, /1\s699 ₴/u);
});

test('the bail-out fallback is replaced, nothing else; idempotent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-'));
  fs.mkdirSync(path.join(dir, 'kik', 'proekty'), { recursive: true });
  const f = path.join(dir, 'kik', 'proekty', 'index.html');
  const before = '<main><!--$!--><template data-dgst="BAILOUT_TO_CLIENT_SIDE_RENDERING"></template><div class="min-h-screen">Завантаження...</div><!--/$--><!--$--><!--/$--></main>';
  fs.writeFileSync(f, before);
  assert.equal(apply(dir, P), true);
  const once = fs.readFileSync(f, 'utf8');
  assert.ok(!once.includes('Завантаження'));
  assert.ok(once.startsWith('<main><!--$!--><template data-dgst="BAILOUT_TO_CLIENT_SIDE_RENDERING"></template><div class="min-h-screen" data-bf-kik-fallback="1">'));
  assert.ok(once.endsWith('<!--/$--><!--$--><!--/$--></main>'));
  assert.equal(apply(dir, P), false);
});
