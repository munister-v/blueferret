const test = require('node:test');
const assert = require('node:assert');
const { syncStagesBlock } = require('../src/hydration');

const article = (open, title, text) =>
  `<article tabindex="0" aria-disabled="${!open}"><h3 class="t">${title}</h3>` +
  (open ? `<div class="overflow-hidden"><p class="mt-4 x">${text}</p></div>` : `<div class="mt-3">Секція ще не заповнена</div>`) + '</article>';
const page = (arts) => `<main><!-- BF_STAGES_START --><section><div class="space-y-5">${arts.join('')}</div></section><!-- BF_STAGES_END --></main>`;

test('stage titles and the open stage text follow the data', () => {
  const html = page([article(true, 'Анонс', 'old'), article(false, 'Виробництво', '')]);
  const out = syncStagesBlock(html, [
    { title: 'Анонс 2', description: 'a < b & "c"' }, { title: 'Виробництво' },
  ]);
  assert.ok(out.includes('>Анонс 2</h3>'));
  assert.ok(out.includes('a &lt; b &amp; &quot;c&quot;</p>'));
  assert.ok(out.includes('Секція ще не заповнена'));
});

test('a different number of stages leaves the page alone; running twice is a no-op', () => {
  const html = page([article(true, 'Анонс', 'old'), article(false, 'Виробництво', '')]);
  assert.strictEqual(syncStagesBlock(html, [{ title: 'Анонс', description: 'x' }]), html);
  const once = syncStagesBlock(html, [{ title: 'Анонс', description: 'x' }, { title: 'Виробництво' }]);
  assert.strictEqual(syncStagesBlock(once, [{ title: 'Анонс', description: 'x' }, { title: 'Виробництво' }]), once);
});
