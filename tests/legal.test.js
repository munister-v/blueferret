const test = require('node:test');
const assert = require('node:assert/strict');
const { render, htmlToMd, placeholders } = require('../src/legal');

const MD = `# Політика

Редакція від 02.11.2026

## Дані

- **При оплаті:** сума & дата
- Пишіть на [пошту](mailto:a@b.c)

1. Перше
2. Друге

Використовуємо [Сервіс] для аналітики.
`;

test('renders headings, lists, bold, links and marks placeholders', () => {
  const html = render(MD);
  assert.ok(html.includes('<h1>Політика</h1>'));
  assert.ok(html.includes('<li><strong>При оплаті:</strong> сума &amp; дата</li>'));
  assert.ok(html.includes('<a href="mailto:a@b.c">пошту</a>'));
  assert.ok(html.includes('<ol>\n<li>Перше</li>\n<li>Друге</li>\n</ol>'));
  assert.equal(placeholders(html), 1);
});

test('drops unsafe link targets and escapes html', () => {
  const html = render('[x](javascript:alert(1)) <script>');
  assert.ok(!html.includes('javascript:'));
  assert.ok(html.includes('&lt;script&gt;'));
});

test('htmlToMd takes a rendered page back to the same markdown', () => {
  const page = `<html><body><article>\n${render(MD)}\n</article></body></html>`;
  assert.equal(render(htmlToMd(page)), render(MD));
});

test('numbered clauses, the edition pill, bare addresses and a contents list', () => {
  const md = `# Оферта\n\nРедакція від 02.11.2026\n\n## 1. Один\n\n1.1. Пишіть на a@b.ua або https://x.ua/p.\n\n## 2. Два\n\n## 3. Три\n\n## 4. Чотири\n\n## 5. П'ять\n\n## 6. Шість\n\n## 7. Сім\n\n## 8. Вісім\n`;
  const html = render(md);
  assert.ok(html.includes('<p class="ed">Редакція від 02.11.2026</p>'));
  assert.ok(html.includes('<span class="no">1.1.</span> <span class="tx">'));
  assert.ok(html.includes('<a href="mailto:a@b.ua">a@b.ua</a>'));
  assert.ok(html.includes('<a href="https://x.ua/p">https://x.ua/p</a>.'));
  assert.ok(html.indexOf('class="toc"') < html.indexOf('<h2 id="s1">'));
  assert.equal((html.match(/<h2 id="s\d">/g) || []).length, 8);
  const page = `<html><body><article>\n${html}\n</article></body></html>`;
  assert.equal(render(htmlToMd(page)), html);
});
