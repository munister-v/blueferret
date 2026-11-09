const test = require('node:test');
const assert = require('node:assert/strict');
const { repairHtml, testimonialQuoteHtml, testimonialAuthorHtml, compactWhitespace } = require('../src/hydration');

const NEXT = '<script>self.__next_f.push([0])</script>';
const page = body => `<html><body>${body}${NEXT}</body></html>`;

test('puts back Suspense markers and text separators on a stripped Next page', () => {
  const { html, changes } = repairHtml(page('<div hidden=""></div><main><p>x</p></main><footer><p>© 2026 Blue Ferret. Всі права захищені.</p></footer>'), 'index.html');
  assert.ok(html.includes('<div hidden=""><!--$--><!--/$--></div>'));
  assert.ok(html.includes('<!--$--><!--/$--></main><footer'));
  assert.ok(html.includes('>© <!-- -->2026<!-- --> Blue Ferret. <!-- -->Всі права захищені.<'));
  assert.deepEqual(changes, ['suspense:metadata', 'suspense:main', 'text:copyright']);
});

test('a healthy page and a non-Next page are left alone', () => {
  const healthy = page('<div hidden=""><!--$--><!--/$--></div><main></main><footer><p>© <!-- -->2026<!-- --> Blue Ferret. <!-- -->Всі права захищені.</p></footer>');
  assert.equal(repairHtml(healthy, 'kontakty/index.html').html, healthy);
  const plain = '<html><body><div hidden=""></div><p>© 2026 Blue Ferret. Всі права захищені.</p></body></html>';
  assert.equal(repairHtml(plain, 'oferta/index.html').html, plain);
});

test('old KIK spelling is fixed on game pages only', () => {
  const body = '<div hidden=""><!--$--><!--/$--></div><a href="/kik/">Кік-вдома</a>';
  assert.ok(repairHtml(page(body), 'igry/trymaysia/index.html').html.includes('>KIK вдома<'));
  assert.ok(repairHtml(page(body), 'index.html').html.includes('>Кік-вдома<'));
});

test('stages block whitespace is compacted between the markers', () => {
  const body = '<div hidden=""><!--$--><!--/$--></div></section>\n<!-- BF_STAGES_START -->\n<section>\n  <h2>Етапи</h2>\n  <p>\n    Текст\n  </p>\n</section>\n<!-- BF_STAGES_END -->\n</div>';
  const { html } = repairHtml(page(body), 'igry/x/index.html');
  assert.ok(html.includes('</section><!-- BF_STAGES_START --><section><h2>Етапи</h2><p>Текст</p></section><!-- BF_STAGES_END --></div>'));
  assert.equal(compactWhitespace(' <a>\n b \n</a> '), '<a>b</a>');
});

test('testimonial markup matches the client component and escapes text', () => {
  assert.equal(testimonialQuoteHtml('a < b'), '“<!-- -->a &lt; b<!-- -->”');
  assert.equal(testimonialAuthorHtml('Віра', 'авторка'), '– <!-- -->Віра<span class="text-slate-600">, <!-- -->авторка</span>');
  assert.equal(testimonialAuthorHtml('Віра', ''), '– <!-- -->Віра');
});
